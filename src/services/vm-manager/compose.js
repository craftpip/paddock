/**
 * The PAD's docker-compose file: ports, the generated services and running compose.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  collectPublishedHostPorts, readExtraPorts, validateExtraPorts, writeInstanceCompose,
  readSshCport, runCompose, autoSshPort, validateInstanceCompose, generateInstanceCompose,
  buildInstanceCompose, usesProjectDefaultNetwork, composeCommand,
});

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { runCmdStream } = require('../cmd');
const { imageFor, buildEnvPath, argsFromDockerfile } = require('../instance-image');
const { mkdirOwned, writeFileOwned } = require('../ownership');
const {
  instanceComposePath, runCmd, readMeta, INSTANCES_DIR, DEFAULT_SSH_CPORT, getDriver,
  HOST_WORKSPACE, WORKSPACE, dockerVolumeExists,
} = require('./internal');
const { ensurePadSubnet, releasePadSubnet } = require('./subnets');
const { readWorkspaceMount, readExtraVolumes } = require('./workspace-mount');
const { hasLifecycleScripts } = require('./build-files');
const { recreateServices, doorName } = require('./doors-network');
const { readDevContainerPlan } = require('./devcontainer');

/** Compose command prefix for an instance. Every per-instance `docker compose`
 *  invocation passes its `build.env` as an env-file so compose resolves the
 *  generated `build.args:` interpolation consistently. Skips the env-file when
 *  the instance has no build dir yet (e.g. an un-migrated legacy agent). */
function composeCommand(name, ...args) {
  const cmd = ['compose'];
  if (fs.existsSync(buildEnvPath(name))) cmd.push('--env-file', buildEnvPath(name));
  cmd.push('-f', instanceComposePath(name), ...args);
  return cmd;
}

/** Pre-flight validation of an instance's compose document (plan 29). Runs
 *  `docker compose --env-file <build.env> -f <compose> config --quiet` — a
 *  pure parse + schema + interpolation-resolution pass with NO side effects.
 *  Throws with the parser output on failure. Call BEFORE stopping or
 *  recreating a PAD so a malformed document aborts the flow with the existing
 *  container still running. */
async function validateInstanceCompose(name) {
  const composePath = instanceComposePath(name);
  if (!fs.existsSync(composePath)) {
    throw new Error(`Compose file not found for '${name}': ${composePath}`);
  }
  return new Promise((resolve, reject) => {
    execFile('docker', composeCommand(name, 'config', '--quiet'), { timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || stdout || err.message || '').trim();
        reject(new Error(`Compose validation failed for '${name}': ${detail}`));
      } else {
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      }
    });
  });
}

/** Run a per-instance `docker compose` command, validating the document first
 *  (config --quiet). A malformed compose aborts BEFORE any build/up — compose
 *  can otherwise partially recreate services and leave the PAD stopped.
 *  `opts.stream` streams output via onLog (build/up); otherwise runCmd. */
async function runCompose(name, args, opts = {}) {
  await validateInstanceCompose(name);
  // Some lifecycle callers invoke Compose directly. Ensure a peer-networked
  // forwarding door is never skipped when force-recreating its agent.
  const services = args[0] === 'up' && args.includes('--force-recreate') && args.includes(name)
    ? recreateServices(name).filter((service) => !args.includes(service))
    : [];
  const full = composeCommand(name, ...args, ...services);
  if (opts.stream) {
    return runCmdStream('docker', full, { onLog: opts.onLog, timeout: opts.timeout });
  }
  return runCmd('docker', full, { timeout: opts.timeout });
}
function readSshCport(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  const raw = String(meta.SSH_CPORT || '').trim();
  if (/^\d+$/.test(raw) && +raw >= 1 && +raw <= 65535) return raw;
  return DEFAULT_SSH_CPORT;
}

/** Read the persisted extra ports from meta (EXTRA_PORTS JSON) or [] when
 *  absent/corrupt. Never throws. */
function readExtraPorts(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.EXTRA_PORTS) return [];
  try {
    const arr = JSON.parse(meta.EXTRA_PORTS);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => p && p.host && p.container)
      .map((p) => ({ host: String(p.host), container: String(p.container) }));
  } catch {
    return [];
  }
}

/** Validate a list of extra host→container port mappings. Returns the
 *  normalized `[{ host, container }]` array or throws. Pure checks only: int
 *  bounds, self-duplicates, and SSH/web-port conflicts. Peer mode is fine —
 *  ports are published through the agent's socat door, not on the agent. The
 *  async cross-agent `hostPortInUse` check lives in the route layer. */
function validateExtraPorts(ports, opts = {}) {
  const { sshPort = '', webHostPort = '' } = opts;
  if (ports === undefined || ports === null) return [];
  if (!Array.isArray(ports)) throw new Error('Extra ports must be a list');
  const out = [];
  const seen = new Set();
  for (const p of ports) {
    if (!p || (p.host === undefined && p.container === undefined)) continue;
    const h = Number(p.host);
    const c = Number(p.container);
    if (!Number.isInteger(h) || h < 1 || h > 65535) {
      throw new Error('Extra port host must be an integer between 1 and 65535');
    }
    if (!Number.isInteger(c) || c < 1 || c > 65535) {
      throw new Error('Extra port container must be an integer between 1 and 65535');
    }
    if (seen.has(h)) throw new Error(`Duplicate host port ${h} in extra ports`);
    seen.add(h);
    if (sshPort && String(h) === String(sshPort)) {
      throw new Error(`Host port ${h} is already the SSH port of this agent`);
    }
    if (webHostPort && String(h) === String(webHostPort)) {
      throw new Error(`Host port ${h} is already the web app host port of this agent`);
    }
    out.push({ host: String(h), container: String(c) });
  }
  return out;
}

/** Every published host port across all instances — SSH (host:container where
 *  container can vary), extra ports, the web app, and devcontainer forwardPorts
 *  — collected from the generated compose files. Shared by the SSH auto-port
 *  and the devcontainer forwardPorts allocator. */
function collectPublishedHostPorts(name) {
  const used = new Set();
  if (fs.existsSync(INSTANCES_DIR)) {
    for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === name) continue;
      const composeFile = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
      if (fs.existsSync(composeFile)) {
        for (const m of fs.readFileSync(composeFile, 'utf8').matchAll(/"(\d+):(\d+)(?:\/(?:tcp|udp))?"/g)) {
          used.add(parseInt(m[1]));
        }
      }
    }
  }
  // Live published ports (incl. containers from other projects): a forwardPort
  // must not collide with what the daemon has already bound. Same net effect as
  // hostPortInUse's docker ps scan, but synchronous for the port allocators.
  try {
    const r = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { stdio: 'pipe', timeout: 15000 });
    for (const line of (r.toString() || '').split('\n')) {
      const [cn, ports] = line.split('\t');
      if (!ports || cn === name) continue;
      for (const m of (ports || '').matchAll(/(?:0\.0\.0\.0:|\[::\]:)?(\d+)->/g)) {
        used.add(parseInt(m[1]));
      }
    }
  } catch {}
  return used;
}

/** Smallest unused SSH host port starting at 43817 (the same scan createVm
 *  uses to auto-allocate an SSH port when "Expose SSH" is on without a port). */
function autoSshPort() {
  const used = collectPublishedHostPorts();
  let p = 43817;
  while (used.has(p)) p++;
  return String(p);
}

/** Whether any service in a GENERATED compose rides the project default
 *  network — i.e. it declares neither `network_mode` (a peer-networked pad's
 *  service is `network_mode: container:<peer>`, a host-network door is
 *  `network_mode: host`) nor an explicit `networks` list (a socat door joins
 *  the peer's external `webbridge`).
 *
 *  This is the gate for the pad subnet pool (plan 59): a project `default`
 *  network — and therefore a reserved /24 — exists only when something joins
 *  it. Gating on the generated services rather than on `NETWORK` being unset
 *  means a peer pad with no ports at all (no door service) is judged the same
 *  way, and a future service that does join `default` is picked up for free. */
function usesProjectDefaultNetwork(services) {
  for (const s of Object.values(services || {})) {
    if (!s || typeof s !== 'object') continue;
    if (s.network_mode) continue;
    if (Array.isArray(s.networks) && s.networks.length) continue;
    return true;
  }
  return false;
}

/** The compose model (plain object) for an instance — the single source both
 *  `generateInstanceCompose` (read-only, for previews/tests) and
 *  `writeInstanceCompose` (which then resolves the pad subnet) build on. */
function buildInstanceCompose(name, agent, password, port, opts = {}) {
  const { allowDocker = false, network = '', webService = null, webPeerNetwork = '' } = opts;
  const driver = getDriver(agent);
  const wsMount = readWorkspaceMount(name, agent);
  const dcPlan = readDevContainerPlan(name);
  const peerMode = !!network;
  const args = argsFromDockerfile(path.join(INSTANCES_DIR, name, 'build', 'Dockerfile'));
  const buildArgs = Object.fromEntries(args.map((a) => [
    a.name,
    a.default ? `\${${a.name}:-${a.default}}` : `\${${a.name}}`,
  ]));
  const volumes = [`${HOST_WORKSPACE}/instances/${name}/${agent}:${driver.dataDir}`];
  const sshCport = readSshCport(name);
  // Plan-41 lifecycle scripts (post-create/post-start/post-attach) live in the
  // build dir on the host — bind it at /build so the create job (and a later
  // Re-run) can exec the script inside the running container. Only when the
  // instance HAS one, so legacy agents' compose never gains a mount.
  if (hasLifecycleScripts(name)) {
    volumes.push(`${HOST_WORKSPACE}/instances/${name}/build:/build`);
  }
  const service = {
    build: {
      // The compose CLI runs in the webui, so the build context uses its view.
      context: path.resolve(WORKSPACE, 'instances', name, 'build'),
      ...(args.length ? { args: buildArgs } : {}),
    },
    image: imageFor(name),
    container_name: name,
    restart: 'unless-stopped',
    volumes,
  };

  const ports = [];
  const dcPorts = (dcPlan && dcPlan.ports) || [];
  if (!peerMode) {
    if (port) ports.push(`${port}:${sshCport}`);
    if (webService?.hostPort) ports.push(`${webService.hostPort}:${webService.containerPort}`);
    for (const p of readExtraPorts(name)) ports.push(`${p.host}:${p.container}`);
    // Devcontainer forwardPorts (item 14) — persisted host mapping. The host
    // side must be a plain numeric port; the protocol belongs on the container
    // side only (`43817:4200/tcp`), or compose config rejects it.
    for (const p of dcPorts) ports.push(`${p.host}:${p.container}/${p.protocol}`);
  }
  if (ports.length) service.ports = ports;
  if (wsMount) {
    // Devcontainer workspaceFolder (item 13) overrides the mount target for
    // editable drivers when the stored WORKSPACE_DIR is still the driver
    // default — re-verified here so a stale plan can never override a custom
    // target the user chose. The host source never changes.
    const effTarget = dcPlan && dcPlan.workspaceFolder && driver.workspaceCapability === 'editable' && wsMount.container === driver.workspaceDir
      ? dcPlan.workspaceFolder
      : wsMount.container;
    volumes.push(`${wsMount.host}:${effTarget}`);
    service.working_dir = effTarget;
  }
  if (allowDocker) volumes.push('/var/run/docker.sock:/var/run/docker.sock');
  const namedVolumes = {};
  for (const v of readExtraVolumes(name)) {
    volumes.push(`${v.host}:${v.container}${v.readonly ? ':ro' : ''}`);
    if (v.type === 'volume') {
      // Named volume (plan 40 D5): attach the pre-existing Docker volume when
      // it exists (shares the project's real data); otherwise let compose
      // create a fresh volume so never-started projects still work.
      const external = v.external && dockerVolumeExists(v.external) ? v.external : '';
      namedVolumes[v.host] = external ? { external: true, name: external } : {};
    }
  }
  // Devcontainer mounts (item 15) — validated binds, emitted like extra volumes.
  for (const v of (dcPlan && dcPlan.volumes) || []) {
    volumes.push(`${v.host}:${v.container}${v.readonly ? ':ro' : ''}`);
  }
  if (network) service.network_mode = `container:${network}`;
  // USER_MODE=user (plan 43 Phase 7) tells the baked start.sh to drop the
  // foreground daemon to the `pad` user (PUID:PGID) via setpriv/su. The
  // container still boots as root (chpasswd/sshd/start-web hooks need it); only
  // the daemon runs user-level. Absent/empty = root mode (legacy default).
  const userMode = (readMeta(path.join(INSTANCES_DIR, name)).USER_MODE || '').trim();
  service.environment = {
    TZ: 'Asia/Kolkata',
    ROOT_PASSWORD: password || '',
    ...(userMode === 'user' ? { USER_MODE: 'user' } : {}),
    // Only relevant while SSH is exposed: tells the baked start.sh which port
    // sshd should LISTEN on inside the container (default 22). Agents sharing a
    // network namespace need distinct container ports, not just distinct host
    // ports — the host → container mapping alone can't fix that.
    ...(port ? { SSH_PORT: sshCport } : {}),
  };
  if (dcPlan) {
    // Devcontainer environment (item 12) merges over the defaults; protected
    // keys were dropped at resolve time so start.sh keeps control.
    Object.assign(service.environment, dcPlan.environment || {});
    // runArgs (item 16): allow-listed keys map onto compose fields.
    if (dcPlan.runArgs) {
      if (dcPlan.runArgs.caps.length) service.cap_add = dcPlan.runArgs.caps;
      if (Object.keys(dcPlan.runArgs.ulimits).length) service.ulimits = dcPlan.runArgs.ulimits;
      if (Object.keys(dcPlan.runArgs.sysctls).length) service.sysctls = dcPlan.runArgs.sysctls;
      if (dcPlan.runArgs.envFiles.length) service.env_file = dcPlan.runArgs.envFiles;
    }
  }

  const services = { [name]: service };
  let networks;
  if (peerMode) {
    // Peer-networked agents can't publish ports on themselves (Docker rejects
    // port publishing with `network_mode: container:`). Publish through ONE
    // socat "door" service on the peer's network that runs a socat process per
    // published port (web app, SSH, each additional port) and forwards TCP to
    // the peer by name — a port inside the peer's namespace is the agent's
    // own, since it shares the peer's network stack. The door listens on the
    // host port inside the container (host ports are unique per agent), so the
    // compose port mapping is the identity `host:host`.
    const doorPorts = [];
    if (webService?.hostPort) doorPorts.push({ hostPort: String(webService.hostPort), containerPort: String(webService.containerPort) });
    if (port) doorPorts.push({ hostPort: String(port), containerPort: sshCport });
    for (const p of readExtraPorts(name)) doorPorts.push({ hostPort: String(p.host), containerPort: String(p.container) });
    // Devcontainer forwardPorts (item 14) — TCP only; the socat door cannot
    // forward UDP.
    for (const p of dcPorts.filter((x) => x.protocol !== 'udp')) {
      doorPorts.push({ hostPort: String(p.host), containerPort: String(p.container) });
    }
    if (doorPorts.length) {
      const door = doorName(name);
      const socats = doorPorts
        .map((d) => `socat TCP-LISTEN:${d.hostPort},fork,reuseaddr TCP:${network}:${d.containerPort}`)
        .join(' & ') + ' & wait';
      if (webPeerNetwork) {
        services[door] = {
          image: 'alpine/socat',
          container_name: door,
          restart: 'unless-stopped',
          networks: ['webbridge'],
          ports: doorPorts.map((d) => `${d.hostPort}:${d.hostPort}`),
          entrypoint: ['sh', '-c', socats],
        };
        networks = { webbridge: { external: true, name: webPeerNetwork } };
      } else {
        services[door] = {
          image: 'alpine/socat',
          container_name: door,
          restart: 'unless-stopped',
          network_mode: 'host',
          entrypoint: ['sh', '-c', doorPorts.map((d) => `socat TCP-LISTEN:${d.hostPort},fork,reuseaddr TCP:127.0.0.1:${d.containerPort}`).join(' & ') + ' & wait'],
        };
      }
    }
  }

  // JSON is valid YAML. Serializing the structured compose model avoids fragile
  // hand-built YAML where a Compose interpolation such as `${VAR:-default}`
  // can be parsed as YAML syntax.
  return {
    services,
    ...(networks ? { networks } : {}),
    ...(Object.keys(namedVolumes).length ? { volumes: namedVolumes } : {}),
  };
}

/** Serialize an instance compose to disk-ready text. Read-only: it declares the
 *  pad's persisted `SUBNET` when one is on file and a service actually rides
 *  the project default network, but never reserves one. `writeInstanceCompose`
 *  is the path that carves a subnet. */
function generateInstanceCompose(name, agent, password, port, opts = {}) {
  const model = buildInstanceCompose(name, agent, password, port, opts);
  if (usesProjectDefaultNetwork(model.services)) {
    const subnet = (readMeta(path.join(INSTANCES_DIR, name)).SUBNET || '').trim();
    if (subnet) {
      model.networks = { default: { ipam: { config: [{ subnet }] } }, ...(model.networks || {}) };
    }
  }
  return JSON.stringify(model, null, 2) + '\n';
}

/** Generate + write an instance compose file.
 *
 *  The pad subnet pool (see `ensurePadSubnet`) is resolved HERE, once the
 *  services are known, because only a pad with a service on the project
 *  `default` network needs a /24: a peer-networked pad's service shares the
 *  peer's network namespace and its socat door rides the peer's own network,
 *  so nothing joins `default` — reserving for it just parked a /24 on the pad's
 *  books that collided the moment such a pad was switched TO the default
 *  network (`Pool overlaps with other one on this address space`). Such a pad
 *  releases a stale reservation instead. */
function writeInstanceCompose(name, agent, password, port, opts = {}) {
  const model = buildInstanceCompose(name, agent, password, port, opts);
  if (usesProjectDefaultNetwork(model.services)) {
    // Carves a fresh /24 (or re-picks a colliding one) on first write; a pad
    // whose default network is already live keeps whatever it has.
    const subnet = ensurePadSubnet(name);
    if (subnet) {
      model.networks = { default: { ipam: { config: [{ subnet }] } }, ...(model.networks || {}) };
    }
  } else {
    releasePadSubnet(name);
  }
  const yaml = JSON.stringify(model, null, 2) + '\n';
  const composePath = instanceComposePath(name);
  const dir = path.dirname(composePath);
  mkdirOwned(dir, { boundary: INSTANCES_DIR });
  writeFileOwned(composePath, yaml, { boundary: dir });
}
