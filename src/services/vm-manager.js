const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { runCmdStream } = require('./cmd');
const { getDriver, drivers } = require('./drivers');
const { imageFor, legacySharedImage, buildDir, buildEnvPath, readBuildEnv, setBuildEnv, argsFromDockerfile } = require('./instance-image');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const HOST_WORKSPACE = process.env.HOST_WORKSPACE_ROOT || WORKSPACE;
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const PREFIX = process.env.CONTAINER_PREFIX || 'vm';
const PREFIX_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-');
const VM_NAME_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-zA-Z0-9][a-zA-Z0-9_-]*$');

// Shared build-template root (`src/vm-builds/<type>/`). Read-only template
// source: copied into `instances/<name>/build/` at create/clone/migrate time.
const BUILD_TEMPLATES_DIR = path.join(__dirname, '..', 'vm-builds');

function runCmd(cmd, args, options = {}) {
  const { timeout = 120000 } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/** Sync probe whether a named Docker volume exists (cheap metadata call).
 *  Used by the compose generator to decide between attaching an existing
 *  volume (`external: true`) and letting compose create a fresh one so
 *  never-started projects still work (plan 40 D5). Never throws. */
function dockerVolumeExists(name) {
  try {
    const r = execFileSync('docker', ['volume', 'inspect', name], { stdio: 'pipe', timeout: 10000 });
    return !!(r && r.length);
  } catch {
    return false;
  }
}

/** Sync probe whether a Docker network with the given name exists (cheap
 *  metadata call). Never throws. */
function dockerNetworkExists(name) {
  try {
    const r = execFileSync('docker', ['network', 'inspect', name, '--format', '{{.Name}}'], { stdio: 'pipe', timeout: 10000 });
    return !!(r && r.toString().trim());
  } catch {
    return false;
  }
}

/** Pad `default`-network subnet pool: 10.200.0.0/16 carved into /24s (256
 *  pads). Deliberately disjoint from the daemon's default address pools
 *  (172.16.0.0/12, 192.168.0.0/16) and the office LAN (10.69.0.0/16). The
 *  daemon only hands out subnets from its pools when a compose leaves the
 *  subnet unspecified — once a pool is fully subnetted, creating ANY new
 *  bridge network fails with `all predefined address pools have been fully
 *  subnetted`. Declaring an explicit subnet in each generated compose
 *  sidesteps the pools entirely. */
const PAD_SUBNET_POOL = '10.200.0.0/16';
const PAD_SUBNET_PREFIX = 24;

/** Third octets of 10.200.x.0/24 already claimed by existing Docker networks,
 *  so a fresh pad never collides with another pad or an unrelated project. */
function usedPadSubnetOctets() {
  const used = new Set();
  let ids = [];
  try {
    const r = execFileSync('docker', ['network', 'ls', '-q'], { stdio: 'pipe', timeout: 15000 });
    ids = r.toString().trim().split('\n').filter(Boolean);
  } catch {
    return used;
  }
  const re = /(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)/g;
  for (const id of ids) {
    try {
      const r = execFileSync('docker', ['network', 'inspect', id, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'], { stdio: 'pipe', timeout: 10000 });
      let m;
      while ((m = re.exec(r.toString())) !== null) {
        const a = +m[1], b = +m[2], c = +m[3], prefix = +m[5];
        if (a === 10 && b === 200 && prefix === PAD_SUBNET_PREFIX) used.add(c);
      }
    } catch {}
  }
  return used;
}

/** The lowest free /24 in the pad pool, or '' when the pool is full. */
function pickFreePadSubnet() {
  const used = usedPadSubnetOctets();
  for (let oct = 0; oct < 256; oct++) {
    if (!used.has(oct)) return `10.200.${oct}.0/${PAD_SUBNET_PREFIX}`;
  }
  return '';
}

/** Ensure this pad's compose declares a concrete subnet for its `default`
 *  bridge network. Existing networks (older pads) are left untouched —
 *  declaring a different subnet would force a disruptive network recreate.
 *  For a network that doesn't exist yet, carve a fresh /24 out of the pad pool
 *  and persist it (meta SUBNET) so every later regen keeps the same subnet.
 *  Returns the subnet, or '' when the compose should stay subnet-less. */
function ensurePadSubnet(name) {
  const instDir = path.join(INSTANCES_DIR, name);
  if (!fs.existsSync(instDir)) return '';
  const meta = readMeta(instDir);
  if (meta.SUBNET) return meta.SUBNET;
  if (dockerNetworkExists(`${name}_default`)) return '';
  const subnet = pickFreePadSubnet();
  if (!subnet) {
    throw new Error(`The pad subnet pool (${PAD_SUBNET_POOL}) is exhausted — every /24 is taken. Delete a pad to free one, or extend the pool.`);
  }
  setMetaFlag(name, 'SUBNET', subnet);
  return subnet;
}

function readMeta(vmDir) {
  const meta = {};
  const metaFile = path.join(vmDir, 'meta.env');
  if (fs.existsSync(metaFile)) {
    for (const line of fs.readFileSync(metaFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && t.includes('=')) {
        const i = t.indexOf('=');
        meta[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
    }
  }
  return meta;
}

function instanceComposePath(name) {
  return path.join(INSTANCES_DIR, name, 'docker-compose.yml');
}

// ─── Custom workspace mount (plan 24) ────────────────────────

// Host dirs that must never be bound as a workspace source.
const HOST_SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/home', '/root', '/opt', '/tmp', '/var/run'];
// Container paths (and descendants) that must never be bound as a workspace
// destination. NOTE: /root and /opt are intentionally NOT here — every
// supported driver keeps its data dir below one of them.
const CONTAINER_PROTECTED = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp'];

/** Whether a workspace-mount safety guard is active. Every guard is ON by
 *  default; set `GUARD_<NAME>` to `0`/`false`/`no`/`off` to disable that
 *  single check (e.g. `GUARD_PROJECT_ROOT=0` to allow mounting the project
 *  root as a workspace source). Set in `.env` — the webui loads it via
 *  `env_file`, then `docker compose up -d --force-recreate paddock`. */
function guard(name) {
  const v = String(process.env[`GUARD_${name}`] || '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off', 'disabled', 'disable'].includes(v);
}

/** Recompute the visibility flags for a stored workspace mount. hostBrowsable
 *  means the source lives inside this agent's data directory on the host
 *  (`instances/<name>/<agent>`), the only source the host-scope file browser
 *  clamp can safely reach. webuiVisible means the source is under the project
 *  root (HOST_WORKSPACE). Shared by create/settings/registry so every consumer
 *  derives the same flags from the same stored metadata. */
function workspaceMountInfo(name, agent, host, container) {
  const hostNorm = path.normalize(String(host));
  const agentDataHost = path.join(HOST_WORKSPACE, 'instances', name, agent);
  return {
    host: hostNorm,
    container: path.normalize(String(container)),
    webuiVisible: hostNorm === HOST_WORKSPACE || hostNorm.startsWith(HOST_WORKSPACE + path.sep),
    hostBrowsable: hostNorm === agentDataHost || hostNorm.startsWith(agentDataHost + path.sep),
  };
}

function isParentOrSelf(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

/** Map a HOST-side absolute path onto the webui container's own filesystem
 *  view (host HOST_WORKSPACE ↔ container WORKSPACE, since the project is
 *  bind-mounted at /workspace). Returns null for host-only paths the webui
 *  cannot see (e.g. an external drive) — those are only resolvable by the
 *  Docker daemon on the host and are never touched from the container. */
function containerViewOf(hostPath) {
  const p = path.normalize(String(hostPath));
  if (p === HOST_WORKSPACE) return WORKSPACE;
  if (p.startsWith(HOST_WORKSPACE + path.sep)) return WORKSPACE + p.slice(HOST_WORKSPACE.length);
  return null;
}

/** Validate a user-requested workspace mount `{ workspaceHost, workspaceDir }`
 *  against the server rules. Returns the normalized
 *  `{ host, container, webuiVisible, hostBrowsable }` for storage, or throws
 *  with a clear message. Empty BOTH values → returns null (no mount). */
function validateWorkspaceMount(name, agent, workspaceHost, workspaceDir) {
  const driver = getDriver(agent);
  const cap = driver.workspaceCapability || 'fixed';

  if (!workspaceHost && !workspaceDir) return null;

  if (cap === 'none') {
    throw new Error('This agent type does not support a custom workspace — its data directory IS the workspace');
  }
  if (!workspaceHost || !workspaceDir) {
    throw new Error('Both the host workspace source and the container workspace path are required');
  }

  const hostRaw = String(workspaceHost).trim();
  const dirRaw = String(workspaceDir).trim();
  if (/[\u0000-\u001f\u007f]/.test(hostRaw) || /[\u0000-\u001f\u007f]/.test(dirRaw)) {
    throw new Error('Control characters are not allowed in workspace paths');
  }
  if (/['"\\]/.test(hostRaw) || /['"\\]/.test(dirRaw)) {
    throw new Error('Quotes and backslashes are not allowed in workspace paths');
  }

  // ── Host source ──
  if (hostRaw === '/') throw new Error('The workspace source cannot be the host root');
  if (hostRaw.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('"." and ".." path segments are not allowed in the workspace source');
  }
  if (hostRaw.includes(':')) {
    throw new Error('The workspace source cannot contain ":"');
  }
  let host;
  if (hostRaw.startsWith('/')) {
    host = path.normalize(hostRaw.replace(/\/{2,}/g, '/').replace(/\/+$/, ''));
  } else {
    if (!hostRaw.startsWith('instances/')) {
      throw new Error('Host workspace source must be an absolute path or start with "instances/"');
    }
    host = path.normalize(path.join(HOST_WORKSPACE, hostRaw));
  }

  for (const sd of HOST_SYSTEM_DIRS) {
    if (guard('SYSTEM_DIRS') && (host === sd || host.startsWith(sd + path.sep))) {
      throw new Error(`The workspace source cannot be a system directory (${sd})`);
    }
  }
  if (guard('PROJECT_ROOT') && host === HOST_WORKSPACE) {
    throw new Error('The project root cannot be the workspace source');
  }
  if (guard('APP_DIR') && (host === '/app' || host.startsWith('/app/'))) {
    throw new Error('The webui code folder (/app) cannot be a workspace source');
  }
  const webuiSrc = path.join(HOST_WORKSPACE, 'src');
  if (guard('SRC_DIR') && (host === webuiSrc || host.startsWith(webuiSrc + path.sep))) {
    throw new Error('The webui source folder (src) cannot be a workspace source');
  }

  const instancesHost = path.join(HOST_WORKSPACE, 'instances');
  const ownInstDir = path.join(instancesHost, name);
  const agentDataHost = path.join(ownInstDir, agent);
  if (guard('INSTANCES_PARENT') && (isParentOrSelf(host, instancesHost) || host === instancesHost)) {
    throw new Error('The workspace source cannot be the instances folder or a parent of it');
  }
  if (guard('INSTANCE_DIR') && host === ownInstDir) {
    throw new Error('The workspace source cannot be the agent instance folder itself');
  }
  if (guard('AGENT_DATA') && (host === agentDataHost || isParentOrSelf(host, agentDataHost))) {
    throw new Error('The workspace source would swallow the agent data folder');
  }
  if (host.startsWith(instancesHost + path.sep)) {
    const first = path.relative(instancesHost, host).split(path.sep)[0];
    if (guard('OTHER_AGENT') && first !== name) {
      throw new Error(`The workspace source cannot be inside another agent's folder (instances/${first})`);
    }
  }

  // Symlink escape: for sources the webui can see, resolve the nearest
  // existing ancestor and require it stays under the project root. Missing
  // suffixes are fine (the dir will be created) — the real path must never
  // walk out of the webui's own /workspace bind. Host-only paths (outside
  // HOST_WORKSPACE) are skipped: the container has no view of them to resolve,
  // and only the Docker daemon on the host mounts them.
  const webuiVisible = host === HOST_WORKSPACE || host.startsWith(HOST_WORKSPACE + path.sep);
  if (webuiVisible) {
    let probe = containerViewOf(host);
    while (probe && !fs.existsSync(probe)) probe = path.dirname(probe);
    const real = probe ? fs.realpathSync(probe) : '';
    if (guard('SYMLINK_ESCAPE') && real && real !== WORKSPACE && !real.startsWith(WORKSPACE + path.sep)) {
      throw new Error('The workspace source must stay under the project root');
    }
  }
  if (fs.existsSync(host) && !fs.statSync(host).isDirectory()) {
    throw new Error('The host workspace source already exists and is not a directory');
  }

  // ── Container destination ──
  const dir = path.normalize(dirRaw.replace(/\/{2,}/g, '/').replace(/\/+$/, ''));
  if (!dir.startsWith('/')) throw new Error('Container workspace path must be absolute');
  if (dir === '/') throw new Error('Container workspace path cannot be the host root');
  for (const p of CONTAINER_PROTECTED) {
    if (guard('CONTAINER_PROTECTED') && (dir === p || dir.startsWith(p + '/'))) {
      throw new Error(`Cannot mount a workspace at the system path ${p}`);
    }
  }
  const dataDir = driver.dataDir;
  if (guard('DATA_DIR_SWALLOW') && (dir === dataDir || isParentOrSelf(dir, dataDir))) {
    throw new Error('Container workspace path would swallow the agent data directory');
  }
  const wsDir = driver.workspaceDir;
  if (isParentOrSelf(dataDir, dir)) {
    // Descendant of dataDir: only the driver's own workspace path is allowed —
    // anything else (…/config, …/sessions, …/agents) shadows critical state.
    if (guard('CRITICAL_STATE') && dir !== wsDir && !isParentOrSelf(wsDir, dir)) {
      throw new Error('Container workspace path shadows critical agent state');
    }
  }
  if (guard('FIXED_WORKSPACE') && cap === 'fixed' && dir !== wsDir) {
    throw new Error(`${driver.type} requires its workspace at ${wsDir}`);
  }

  return workspaceMountInfo(name, agent, host, dir);
}

/** YAML-safe scalar for user-provided paths (compose values). Always quoted so
 *  spaces/colons in a path can never break the generated YAML. */
function yamlScalar(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Shared build-template dir for an agent type (`src/vm-builds/<type>`). */
function buildTemplateDir(agent) {
  return path.join(BUILD_TEMPLATES_DIR, agent);
}

/** Seed (or top up) an instance's build dir from the shared template:
 *  `instances/<name>/build/{Dockerfile,start.sh,build.env,extras/}`. Idempotent
 *  — never overwrites an existing build file. `extras/` must exist because the
 *  Dockerfile template `COPY`s it (an empty dir breaks the build), and
 *  `build.env` is written with INSTALL_DOCKER when the agent has docker on. */
function seedBuildDir(name, agent, opts = {}) {
  const { installDocker = false } = opts;
  const dir = buildDir(name);
  const tpl = buildTemplateDir(agent);
  if (fs.existsSync(dir)) {
    // Already seeded (create/clone/migrate) — just ensure the invariants.
    fs.mkdirSync(path.join(dir, 'extras'), { recursive: true });
    const keep = path.join(dir, 'extras', '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
    if (!fs.existsSync(buildEnvPath(name))) {
      setBuildEnv(name, installDocker ? { INSTALL_DOCKER: '1' } : {});
    }
    return dir;
  }
  if (fs.existsSync(tpl)) {
    fs.cpSync(tpl, dir, { recursive: true });
  } else {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'extras'), { recursive: true });
  const keep = path.join(dir, 'extras', '.gitkeep');
  if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  if (!fs.existsSync(buildEnvPath(name))) {
    setBuildEnv(name, installDocker ? { INSTALL_DOCKER: '1' } : {});
  }
  return dir;
}

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
  const full = composeCommand(name, ...args);
  if (opts.stream) {
    return runCmdStream('docker', full, { onLog: opts.onLog, timeout: opts.timeout });
  }
  return runCmd('docker', full, { timeout: opts.timeout });
}

/** Health of an agent's network_mode. When an agent routes through another
 *  container (e.g. gluetun) via `network_mode: container:<peer>`, Docker
 *  records the peer as a container ID at create time. If that peer is later
 *  recreated (gluetun rebuild/restart), the recorded ID dies and `docker
 *  start` fails with "cannot join network namespace ... No such container".
 *  Returns:
 *    { state: 'none' }                 — container doesn't exist yet
 *    { state: 'ok', networkMode }      — default network or live peer
 *    { state: 'stale', ... }           — peer container is gone (needs recreate)
 *    { state: 'peer-stopped', ... }    — peer exists but is not running
 */
async function getNetworkHealth(name) {
  let mode = '';
  try {
    const r = await runCmd('docker', ['inspect', name, '--format', '{{.HostConfig.NetworkMode}}'], { timeout: 15000 });
    mode = (r.stdout || '').trim();
  } catch {
    return { state: 'none', networkMode: '' };
  }

  if (!mode.startsWith('container:')) {
    return { state: 'ok', networkMode: mode };
  }

  const peerId = mode.slice('container:'.length).trim();
  let peerName = '';
  let peerState = '';
  try {
    const r = await runCmd('docker', ['inspect', peerId, '--format', '{{.Name}}|{{.State.Status}}'], { timeout: 15000 });
    const [n, s] = (r.stdout || '').split('|');
    peerName = (n || '').replace(/^\//, '');
    peerState = (s || '').trim().toLowerCase();
  } catch {
    return { state: 'stale', networkMode: mode, peerId, peerName: '', peerState: '' };
  }

  if (peerState !== 'running') {
    return { state: 'peer-stopped', networkMode: mode, peerId, peerName, peerState };
  }
  return { state: 'ok', networkMode: mode, peerId, peerName, peerState };
}

/** Read the persisted custom workspace mount (meta.env WORKSPACE_HOST/WORKSPACE_DIR)
 *  and return its normalized info, or null when not configured. Never throws:
 *  a corrupt/stale pair is ignored by compose generation (the Settings tab
 *  validates before writing, and writeInstanceCompose uses the already-validated
 *  value). */
function readWorkspaceMount(name, agent) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.WORKSPACE_HOST || !meta.WORKSPACE_DIR) return null;
  try {
    return validateWorkspaceMount(name, agent, meta.WORKSPACE_HOST, meta.WORKSPACE_DIR);
  } catch {
    return null;
  }
}

/** Read the persisted extra volumes from meta (EXTRA_VOLUMES JSON) or [] when
 *  absent/corrupt. Never throws. Entries are normalized (strings, no bools).
 *  Bind entries keep the legacy `{ host, container, readonly }` shape; named
 *  volumes carry `type: 'volume'` (host = volume name) + optional `external`
 *  (the full Docker volume name to attach). */
function readExtraVolumes(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.EXTRA_VOLUMES) return [];
  try {
    const arr = JSON.parse(meta.EXTRA_VOLUMES);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((v) => v && v.host && v.container)
      .map((v) => {
        const type = v.type === 'volume' ? 'volume' : 'bind';
        const entry = {
          host: path.normalize(String(v.host)),
          container: path.normalize(String(v.container)),
          readonly: !!v.readonly,
        };
        if (type === 'volume') {
          entry.type = 'volume';
          if (v.external) entry.external = String(v.external);
        }
        return entry;
      });
  } catch {
    return [];
  }
}

/** The SSH daemon's port INSIDE the container (default 22). Stored in meta as
 *  SSH_CPORT when it differs — an explicit field because agents that share a
 *  network namespace (peer mode) can't ALL bind 22; each must pick a distinct
 *  one. Falls back to 22 whenever unset/corrupt. */
const DEFAULT_SSH_CPORT = '22';
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

/** Validate ONE extra volume mount (plan 28). Returns the normalized
 *  `{ host, container, readonly }` (bind) or `{ type: 'volume', host, container,
 *  readonly, external? }` (named volume) or throws. For binds this mirrors the
 *  workspace-mount guards: host must not be a system dir / project root / src /
 *  instances / another agent's folder / a parent-or-self of this agent's data
 *  dir; the container path must not be a protected system path or a
 *  parent-or-self of the driver data dir (descendant subfolders ARE allowed).
 *  Named volumes (type 'volume', plan 40 D5) skip the host-path guards — their
 *  source is a Docker volume name, not a filesystem path — but keep the
 *  container-destination guards. */
function validateExtraVolume(name, agent, hostPath, container, readonly, type, external) {
  const hostRaw = String(hostPath || '').trim();
  const dirRaw = String(container || '').trim();
  if (!hostRaw || !dirRaw) {
    throw new Error('Both the host source and the container path are required for an extra volume');
  }
  if (/[\u0000-\u001f\u007f]/.test(hostRaw) || /[\u0000-\u001f\u007f]/.test(dirRaw)) {
    throw new Error('Control characters are not allowed in extra volume paths');
  }
  if (/['"\\]/.test(hostRaw) || /['"\\]/.test(dirRaw)) {
    throw new Error('Quotes and backslashes are not allowed in extra volume paths');
  }

  const volType = type === 'volume' ? 'volume' : 'bind';
  let host = '';
  if (volType === 'volume') {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(hostRaw)) {
      throw new Error('A named volume source must be a plain volume name (letters, digits, dots, dashes, underscores — no slashes)');
    }
    host = hostRaw;
  } else {
  // ── Host source ──
  if (hostRaw === '/') throw new Error('An extra volume host source cannot be the host root');
  if (hostRaw.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('"." and ".." path segments are not allowed in the host source');
  }
  if (hostRaw.includes(':')) {
    throw new Error('The host source cannot contain ":"');
  }
  if (hostRaw.startsWith('/')) {
    host = path.normalize(hostRaw.replace(/\/{2,}/g, '/').replace(/\/+$/, ''));
  } else {
    if (!hostRaw.startsWith('instances/')) {
      throw new Error('Host source must be an absolute path or start with "instances/"');
    }
    host = path.normalize(path.join(HOST_WORKSPACE, hostRaw));
  }

  for (const sd of HOST_SYSTEM_DIRS) {
    if (guard('SYSTEM_DIRS') && (host === sd || host.startsWith(sd + path.sep))) {
      throw new Error(`The host source cannot be a system directory (${sd})`);
    }
  }
  if (guard('PROJECT_ROOT') && host === HOST_WORKSPACE) {
    throw new Error('The project root cannot be an extra volume host source');
  }
  const webuiSrc = path.join(HOST_WORKSPACE, 'src');
  if (guard('SRC_DIR') && (host === webuiSrc || host.startsWith(webuiSrc + path.sep))) {
    throw new Error('The webui source folder (src) cannot be an extra volume host source');
  }
  const instancesHost = path.join(HOST_WORKSPACE, 'instances');
  const ownInstDir = path.join(instancesHost, name);
  const agentDataHost = path.join(ownInstDir, agent);
  if (guard('INSTANCES_PARENT') && (host === instancesHost || isParentOrSelf(host, instancesHost))) {
    throw new Error('The host source cannot be the instances folder or a parent of it');
  }
  if (guard('INSTANCE_DIR') && host === ownInstDir) {
    throw new Error('The host source cannot be the agent instance folder itself');
  }
  if (guard('AGENT_DATA') && (host === agentDataHost || isParentOrSelf(host, agentDataHost))) {
    throw new Error('The host source would swallow the agent data folder');
  }
  if (host.startsWith(instancesHost + path.sep)) {
    const first = path.relative(instancesHost, host).split(path.sep)[0];
    if (guard('OTHER_AGENT') && first !== name) {
      throw new Error(`The host source cannot be inside another agent's folder (instances/${first})`);
    }
  }
  const webuiVisible = host === HOST_WORKSPACE || host.startsWith(HOST_WORKSPACE + path.sep);
  if (webuiVisible) {
    let probe = containerViewOf(host);
    while (probe && !fs.existsSync(probe)) probe = path.dirname(probe);
    const real = probe ? fs.realpathSync(probe) : '';
    if (guard('SYMLINK_ESCAPE') && real && real !== WORKSPACE && !real.startsWith(WORKSPACE + path.sep)) {
      throw new Error('The host source must stay under the project root');
    }
  }
  if (fs.existsSync(host) && !fs.statSync(host).isDirectory()) {
    throw new Error('The host source already exists and is not a directory');
  }
  }

  // ── Container destination ──
  const dir = path.normalize(dirRaw.replace(/\/{2,}/g, '/').replace(/\/+$/, ''));
  if (!dir.startsWith('/')) throw new Error('Container path must be absolute');
  if (dir === '/') throw new Error('Container path cannot be the host root');
  for (const p of CONTAINER_PROTECTED) {
    if (guard('CONTAINER_PROTECTED') && (dir === p || dir.startsWith(p + '/'))) {
      throw new Error(`Cannot mount an extra volume at the system path ${p}`);
    }
  }
  const dataDir = getDriver(agent).dataDir;
  if (guard('DATA_DIR_SWALLOW') && (dir === dataDir || isParentOrSelf(dir, dataDir))) {
    throw new Error('Extra volume container path would swallow the agent data directory');
  }

  const vol = { host, container: dir, readonly: !!readonly };
  if (volType === 'volume') {
    vol.type = 'volume';
    if (external) vol.external = String(external);
  }
  return vol;
}

/** Validate a list of extra volumes; returns the normalized array or throws.
 *  `null`/`undefined`/empty → `[]`. */
function validateExtraVolumes(name, agent, list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('Extra volumes must be a list');
  const out = [];
  const seen = new Set();
  for (const v of list) {
    if (!v || (v.host === undefined && v.container === undefined)) continue;
    const vol = validateExtraVolume(name, agent, v.host, v.container, v.readonly, v.type, v.external);
    const key = `${vol.type || 'bind'}\u0000${vol.host}\u0000${vol.container}`;
    if (seen.has(key)) throw new Error(`Duplicate extra volume mount ${vol.host} → ${vol.container}`);
    seen.add(key);
    out.push(vol);
  }
  return out;
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

/** Smallest unused SSH host port starting at 43817 (the same scan createVm
 *  uses to auto-allocate an SSH port when "Expose SSH" is on without a port).
 *  Collects every published host port across all instances — SSH (host:container
 *  where container can vary now), extra ports, and the web app — from the
 *  generated compose files. */
function autoSshPort() {
  const used = new Set();
  if (fs.existsSync(INSTANCES_DIR)) {
    for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const composeFile = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
      if (fs.existsSync(composeFile)) {
        for (const m of fs.readFileSync(composeFile, 'utf8').matchAll(/"(\d+):(\d+)"/g)) {
          used.add(parseInt(m[1]));
        }
      }
    }
  }
  let p = 43817;
  while (used.has(p)) p++;
  return String(p);
}

function generateInstanceCompose(name, agent, password, port, opts = {}) {
  const { allowDocker = false, network = '', webService = null, webPeerNetwork = '' } = opts;
  const driver = getDriver(agent);
  const wsMount = readWorkspaceMount(name, agent);
  const peerMode = !!network;
  const args = argsFromDockerfile(path.join(INSTANCES_DIR, name, 'build', 'Dockerfile'));
  const buildArgs = Object.fromEntries(args.map((a) => [
    a.name,
    a.default ? `\${${a.name}:-${a.default}}` : `\${${a.name}}`,
  ]));
  const volumes = [`${HOST_WORKSPACE}/instances/${name}/${agent}:${driver.dataDir}`];
  const sshCport = readSshCport(name);
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
  if (!peerMode) {
    if (port) ports.push(`${port}:${sshCport}`);
    if (webService?.hostPort) ports.push(`${webService.hostPort}:${webService.containerPort}`);
    for (const p of readExtraPorts(name)) ports.push(`${p.host}:${p.container}`);
  }
  if (ports.length) service.ports = ports;
  if (wsMount) {
    volumes.push(`${wsMount.host}:${wsMount.container}`);
    service.working_dir = wsMount.container;
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
  if (network) service.network_mode = `container:${network}`;
  service.environment = {
    TZ: 'Asia/Kolkata',
    ROOT_PASSWORD: password || '',
    // Only relevant while SSH is exposed: tells the baked start.sh which port
    // sshd should LISTEN on inside the container (default 22). Agents sharing a
    // network namespace need distinct container ports, not just distinct host
    // ports — the host → container mapping alone can't fix that.
    ...(port ? { SSH_PORT: sshCport } : {}),
  };

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

  // The persisted SUBNET (written by ensurePadSubnet on first write) anchors
  // the pad's `default` network to a fixed /24 in the pad pool — see the pool
  // constants above. Without it, compose leaves the subnet unspecified and the
  // daemon allocates from its finite default-address-pools, which exhaust.
  let allNetworks = networks;
  const subnet = (readMeta(path.join(INSTANCES_DIR, name)).SUBNET || '').trim();
  if (subnet) {
    allNetworks = { default: { ipam: { config: [{ subnet }] } }, ...(networks || {}) };
  }

  // JSON is valid YAML. Serializing the structured compose model avoids fragile
  // hand-built YAML where a Compose interpolation such as `${VAR:-default}`
  // can be parsed as YAML syntax.
  return JSON.stringify({
    services,
    ...(allNetworks ? { networks: allNetworks } : {}),
    ...(Object.keys(namedVolumes).length ? { volumes: namedVolumes } : {}),
  }, null, 2) + '\n';
}

function writeInstanceCompose(name, agent, password, port, opts = {}) {
  ensurePadSubnet(name);
  const yaml = generateInstanceCompose(name, agent, password, port, opts);
  const composePath = instanceComposePath(name);
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(composePath, yaml);
}

/** Set or clear one KEY=VALUE line in an instance's meta.env (preserves the
 *  rest). An empty value removes the line entirely — the readers treat a
 *  missing key the same as an empty one. */
function setMetaFlag(name, key, value) {
  const metaPath = path.join(INSTANCES_DIR, name, 'meta.env');
  let content = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (value === '') {
    if (re.test(content)) {
      content = content.replace(re, '').replace(/\n{3,}/g, '\n\n').trim() + '\n';
      fs.writeFileSync(metaPath, content);
    }
    return;
  }
  const line = `${key}=${value}`;
  if (re.test(content)) {
    content = content.replace(re, line);
  } else {
    content = content.replace(/\s*$/, '') + '\n' + line + '\n';
  }
  fs.writeFileSync(metaPath, content);
}

/** Apply settings (docker socket mount, network join) to an instance's compose
 *  file + meta.env. Compose files are machine-generated here, so regeneration
 *  is the source of truth. The route handles stop/start + validation around it.
 *  An active web binding (web.json) is carried through the regeneration, so
 *  switching networks (or toggling docker) never silently drops the published
 *  web app — the compose picks up the door/ports for the NEW network and the
 *  settings route re-verifies the server afterwards. */
async function applySettings(name, opts = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';
  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  // Effective SSH host port for the regenerated compose: the caller's new
  // value when supplied (even empty = unexpose), else the stored one.
  const sshPort = opts.sshPort !== undefined ? String(opts.sshPort || '') : port;
  // "Change ONLY what is specified" (plan 30): an omitted allowDocker/network
  // preserves the STORED value instead of defaulting to off/cleared. The
  // Settings UI always passes both; the MCP recreate tool may pass neither.
  const allowDocker = opts.allowDocker !== undefined ? !!opts.allowDocker : meta.DOCKER === '1';
  const network = opts.network !== undefined ? (opts.network || '') : (meta.NETWORK || '');
  const webService = readWebService(name);

  seedBuildDir(name, agent, { installDocker: allowDocker });

  // Custom workspace bind (plan 24). `opts.workspaceHost`/`opts.workspaceDir`
  // are the NEW values from the settings form; the stored pair is the
  // fallback when the form only sends one side. Flags MUST be written before
  // writeInstanceCompose — the compose generator reads them from meta to emit
  // the extra bind.
  const oldMount = readWorkspaceMount(name, agent);
  const newHost = opts.workspaceHost !== undefined ? opts.workspaceHost : (oldMount ? oldMount.host : '');
  const newDir = opts.workspaceDir !== undefined ? opts.workspaceDir : (oldMount ? oldMount.container : '');
  const wsMount = (newHost || newDir)
    ? validateWorkspaceMount(name, agent, newHost, newDir)
    : null;

  if (wsMount && wsMount.webuiVisible) {
    const view = containerViewOf(wsMount.host);
    if (view && !fs.existsSync(view)) fs.mkdirSync(view, { recursive: true });
  }
  if (wsMount) {
    setMetaFlag(name, 'WORKSPACE_HOST', wsMount.host);
    setMetaFlag(name, 'WORKSPACE_DIR', wsMount.container);
  } else {
    setMetaFlag(name, 'WORKSPACE_HOST', '');
    setMetaFlag(name, 'WORKSPACE_DIR', '');
  }

  // Extra volumes / ports (plan 28): written BEFORE the compose regen so the
  // generator (which reads them from meta) picks them up. Each is only written
  // when the caller passes it — existing regen paths (web, settings, migration)
  // preserve the stored value for free.
  if (opts.extraVolumes !== undefined) {
    const vols = validateExtraVolumes(name, agent, opts.extraVolumes);
    setMetaFlag(name, 'EXTRA_VOLUMES', vols.length ? JSON.stringify(vols) : '');
  }
  if (opts.extraPorts !== undefined) {
    const ports = validateExtraPorts(opts.extraPorts, {
      sshPort,
      network,
    });
    setMetaFlag(name, 'EXTRA_PORTS', ports.length ? JSON.stringify(ports) : '');
  }

  let webPeerNetwork = '';
  if (network) {
    // Peer mode — the compose needs the peer's bridge network for any socat
    // door (web app and/or SSH), even when only the SSH port is published.
    webPeerNetwork = await getPeerNetworkName(network);
  }

  // SSH container port + root/SSH password (2026-08-09): written BEFORE the
  // compose regen. The container port is read back from meta by the generator;
  // the password feeds the `ROOT_PASSWORD` env that start.sh chpasswd's into
  // the root user for sshd logins. Empty/missing opts leave both untouched.
  if (opts.sshCport !== undefined) {
    setMetaFlag(name, 'SSH_CPORT', String(opts.sshCport));
  }
  let sshPw = pw;
  if (opts.sshPassword !== undefined) {
    sshPw = String(opts.sshPassword).replace(/[\r\n]/g, '');
    setMetaFlag(name, 'ROOT_PASSWORD', sshPw);
  }

  writeInstanceCompose(name, agent, sshPw, sshPort, { allowDocker, network, webService, webPeerNetwork });
  setMetaFlag(name, 'PORT', sshPort);
  setMetaFlag(name, 'DOCKER', allowDocker ? '1' : '0');
  setMetaFlag(name, 'NETWORK', network);

  return {
    allowDocker,
    network,
    sshPort,
    sshCport: opts.sshCport !== undefined ? String(opts.sshCport) : (readSshCport(name)),
    image: imageFor(name),
    agent,
    workspace: wsMount,
  };
}

// ─── Web publishing (published built-in web app) ─────────────

function webServicePath(name) {
  return path.join(INSTANCES_DIR, name, 'web.json');
}

/** Read the single web binding for an agent, or null when not published.
 *  Shape: { containerPort, hostPort } */
function readWebService(name) {
  const p = webServicePath(name);
  if (!fs.existsSync(p)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || !d.hostPort) return null;
    return { containerPort: d.containerPort || 8080, hostPort: String(d.hostPort) };
  } catch {
    return null;
  }
}

/** Set (webService truthy) or clear (null/undefined) the published web app.
 *  Persists the binding in web.json and regenerates the compose file (the
 *  machine-generated compose remains the source of truth for the ports block,
 *  which also carries the SSH port). When the agent routes through a network
 *  peer, the compose gains the socat door service on the peer's network. */
async function applyWebServices(name, webService) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';
  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  const allowDocker = meta.DOCKER === '1';
  const network = meta.NETWORK || '';

  seedBuildDir(name, agent, { installDocker: allowDocker });

  const p = webServicePath(name);
  if (webService) {
    fs.writeFileSync(p, JSON.stringify({
      containerPort: webService.containerPort,
      hostPort: webService.hostPort,
      authToken: webService.authToken || '',
    }, null, 2));
  } else if (fs.existsSync(p)) {
    fs.rmSync(p);
  }

  let webPeerNetwork = '';
  if (network) {
    webPeerNetwork = await getPeerNetworkName(network);
  }

  writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });
  return { agent, webService: webService || null };
}

/** Container name of the single socat "door" that publishes a peer-networked
 *  agent's web app, SSH port, and additional ports on host ports. One container
 *  runs one socat process per published port. */
function doorName(name) {
  return `${name}-door`;
}

/** All host→container TCP ports a peer-networked agent needs forwarded through
 *  its door: the published web app, the SSH port (container 22), and each
 *  additional port. Empty when the agent is on the default network. */
function doorPorts(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  const ports = [];
  const webService = readWebService(name);
  if (webService?.hostPort) {
    ports.push({ hostPort: String(webService.hostPort), containerPort: String(webService.containerPort || 8080) });
  }
  if (meta.PORT) {
    ports.push({ hostPort: String(meta.PORT), containerPort: readSshCport(name) });
  }
  for (const p of readExtraPorts(name)) {
    ports.push({ hostPort: String(p.host), containerPort: String(p.container) });
  }
  return ports;
}

/** Socat "door" services the agent currently requires (peer mode only). There
 *  is exactly one door service per agent — it carries every published port.
 *  Shape: [{ service, ports: [{ hostPort, containerPort }] }], empty in
 *  default network mode. A port inside the peer's namespace belongs to this
 *  agent because it shares the peer's network stack. */
function desiredDoors(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.NETWORK) return [];
  const ports = doorPorts(name);
  if (!ports.length) return [];
  return [{ service: doorName(name), ports }];
}

/** Name of the docker network a peer container lives on (the door joins it so
 *  it can reach the peer by name). Empty when the peer is host-networked. */
async function getPeerNetworkName(peer) {
  try {
    const r = await runCmd('docker', ['inspect', peer, '--format', '{{json .NetworkSettings.Networks}}'], { timeout: 15000 });
    const nets = JSON.parse(r.stdout || '{}');
    return Object.keys(nets).find((k) => k !== 'host' && k !== 'none') || '';
  } catch {
    return '';
  }
}

/** Host path of the per-instance web start hook. It lives inside the agent's
 *  data dir bind mount (instances/<name>/<agent>/), so the container sees it
 *  at <dataDir>/start-web.sh — start.sh sources it on boot when present. */
function webHookPath(name, agent) {
  return path.join(INSTANCES_DIR, name, agent, 'start-web.sh');
}

/** Write (or remove) the web start hook for an agent. */
function writeWebStartHook(name, agent, content) {
  const p = webHookPath(name, agent);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, { mode: 0o755 });
}

function removeWebStartHook(name, agent) {
  const p = webHookPath(name, agent);
  if (fs.existsSync(p)) fs.rmSync(p);
}

/** The sshd-listen-port block the start.sh templates now ship. start.sh reads
 *  the SSH_PORT env (set by the compose while SSH is exposed) and, when it's not
 *  22, rewrites sshd_config's Port before launching sshd — agents that share a
 *  network namespace can't ALL bind 22. */
const SSH_START_MARKER = 'SSH_PORT';
const SSH_START_BLOCK = `# SSH_PORT (set by the Paddock compose when SSH is exposed) picks a custom
# sshd listen port — multiple agents sharing a network namespace can't ALL bind
# 22, so each gets its own.
if [ -n "$SSH_PORT" ] && [ "$SSH_PORT" != "22" ]; then
    sed -i "s/^#\\?[[:space:]]*Port .*/Port $SSH_PORT/" /etc/ssh/sshd_config
fi
`;

/** Marker + block for the web start-hook, backfilled into an instance's OWN
 *  build/start.sh (PADs created before the template change don't have it). The
 *  block must sit BEFORE the driver's foreground process (the openclaw gateway
 *  line in particular — a published config patch must be in place before the
 *  gateway binds). The baked `/usr/local/bin/start.sh` only changes after a
 *  rebuild, so callers must rebuild the image when ensureWebStartBlock returns
 *  true. */
const WEB_START_MARKER = 'start-web.sh';

function webStartBlock(agent) {
  const hookPath = `${getDriver(agent).dataDir}/start-web.sh`;
  return `# Paddock web publishing: if the webui wrote a start-web.sh hook (bound via
# the data-dir bind mount), run it so the published web server survives
# recreates. The hook is idempotent and backgrounds itself.
if [ -f ${hookPath} ]; then
    bash ${hookPath} || true
fi
`;
}

/** Backfill the web start-hook block into an instance's OWN build/start.sh
 *  (PADs created before the template change don't have it). Inserted before the
 *  driver's gateway line (openclaw `openclaw gateway run`, picoclaw `picoclaw
 *  gateway -E`, hermes `hermes gateway run`). Returns whether the build/start.sh
 *  will produce an image that runs the hook (true when the marker is already
 *  present — e.g. freshly seeded from the updated template — OR after patching);
 *  false when un-patchable. Callers rebuild the image on true. */
function ensureWebStartBlock(name, agent) {
  const dir = buildDir(name);
  const p = path.join(dir, 'start.sh');
  if (!fs.existsSync(p)) return false;
  let content = fs.readFileSync(p, 'utf8');
  if (content.includes(WEB_START_MARKER)) return true;
  const re = new RegExp('^(\\s*' + agent + ' gateway.*)$', 'm');
  if (!re.test(content)) return false;
  content = content.replace(re, webStartBlock(agent) + '$1');
  fs.writeFileSync(p, content, { mode: 0o755 });
  return true;
}

/** Backfill the SSH_PORT block into an instance's OWN build/start.sh (PADs
 *  created before the template change don't have it). The baked `/usr/local/
 *  bin/start.sh` only changes after a rebuild, so callers must rebuild the image
 *  when this returns true. Idempotent: already-patched (or un-patchable) return
 *  false. */
function ensureSshStartBlock(name) {
  const dir = buildDir(name);
  const p = path.join(dir, 'start.sh');
  if (!fs.existsSync(p)) return false;
  let content = fs.readFileSync(p, 'utf8');
  if (content.includes(SSH_START_MARKER)) return false;
  const re = /^(\s*\/usr\/sbin\/sshd &.*)$/m;
  if (!re.test(content)) return false;
  content = content.replace(re, SSH_START_BLOCK + '$1');
  fs.writeFileSync(p, content, { mode: 0o755 });
  return true;
}

/** Rebuild the image (--pull to redownload the base) and recreate the
 *  container. The recreate restarts it automatically when it's done.
 *  `buildArgs` are passed as `--build-arg K=V` (ad-hoc overrides; the instance
 *  build.env is the preferred place for ARG values). Set `pull: false` to skip
 *  redownloading the base image. */
async function updateAgent(name, { onLog = () => {}, onStep = () => {}, buildArgs = [], pull = true } = {}) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  const agent = meta.AGENT || 'openclaw';
  // Each PAD owns its build dir + image tag — no shared-image bookkeeping, so
  // nothing is force-appended to the build args anymore. The rebuild reads the
  // instance Dockerfile + build.env (via the compose env-file) directly.
  seedBuildDir(name, agent, { installDocker: meta.DOCKER === '1' });
  const args = ['build'];
  if (pull) args.push('--pull');
  for (const ba of buildArgs) args.push('--build-arg', ba);
  args.push(name);
  onStep('build', 'start');
  try {
    await runCompose(name, args, { stream: true, onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    throw e;
  }
  onStep('build', 'end');

  onStep('recreate', 'start');
  try {
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 300000 });
  } catch (e) {
    onStep('recreate', 'error');
    throw e;
  }
  onStep('recreate', 'end');
  await pruneDanglingImages(onLog);
}

/** Recreate a container with optional extras (the Settings "Recreate Container"
 *  card). `pull` re-downloads the base image + rebuilds before recreating;
 *  `reset` wipes the ENTIRE user data dir (instances/<name>/<agent> — config,
 *  sessions, sqlite, workspace) so the container starts completely fresh.
 *  Bindings are preserved: docker socket, network peer, published web app +
 *  door, custom workspace, extra volumes/ports (all re-read from meta). */
async function recreateAgent(name, { pull = false, reset = false, onLog = () => {}, onStep = () => {} } = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';
  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  const allowDocker = meta.DOCKER === '1';
  const network = meta.NETWORK || '';

  if (pull) {
    seedBuildDir(name, agent, { installDocker: allowDocker });
    onStep('build', 'start');
    try {
      await runCompose(name, ['build', '--pull', name], { stream: true, onLog, timeout: 900000 });
    } catch (e) {
      onStep('build', 'error');
      throw e;
    }
    onStep('build', 'end');
  }

  if (reset) {
    onStep('reset', 'start');
    try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
    const agentDir = path.join(instDir, agent);
    if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true, force: true });
    fs.mkdirSync(agentDir, { recursive: true });
    seedBuildDir(name, agent, { installDocker: allowDocker });
    // Preserve the COMPLETE persisted binding set (mirrors resetVm).
    const webService = readWebService(name);
    let webPeerNetwork = '';
    if (network) webPeerNetwork = await getPeerNetworkName(network);
    writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });
    onStep('reset', 'end');
  }

  onStep('recreate', 'start');
  try {
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 300000 });
  } catch (e) {
    onStep('recreate', 'error');
    throw e;
  }
  onStep('recreate', 'end');
  await pruneDanglingImages(onLog);
}

function existingServices() {
  const names = new Set();
  if (!fs.existsSync(INSTANCES_DIR)) return names;
  for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const composeFile = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
      if (fs.existsSync(composeFile)) names.add(entry.name);
    }
  }
  return names;
}

async function createVm(name, options = {}) {
  const {
    agent = 'openclaw', mode = 'fresh', cloneSource = '',
    sshEnabled = false, port = '', password = '', sshCport = '',
    onLog = () => {}, onStep = () => {}, skipSetup = false,
    workspaceHost = '', workspaceDir = '',
    allowDocker = false, network = '',
    extraVolumes = null, extraPorts = null,
  } = options;

  if (existingServices().has(name)) {
    throw new Error(`Agent '${name}' already exists`);
  }
  const instDir = path.join(INSTANCES_DIR, name);
  if (fs.existsSync(path.join(instDir, 'meta.env'))) {
    throw new Error(`Agent '${name}' already exists`);
  }

  const pw = password || name.replace(PREFIX_RE, '');
  let finalPort = '';
  if (sshEnabled) {
    finalPort = port || autoSshPort();
  }
  const sshCportRaw = String(sshCport || '').trim();
  const finalCport = /^\d+$/.test(sshCportRaw) && +sshCportRaw >= 1 && +sshCportRaw <= 65535
    ? sshCportRaw
    : DEFAULT_SSH_CPORT;

  // Validate EVERYTHING up front (plan 28) so a bad request aborts with a
  // clear error and leaves nothing behind: network peer must exist and run,
  // extra volumes/ports must pass the guards, and the custom workspace mount
  // must be valid. The route already checked host-port availability against
  // other agents before returning 202; here we re-check the pure constraints.
  if (network) {
    if (network === name) throw new Error('Cannot route an agent through itself');
    let running = false;
    try {
      const r = await runCmd('docker', ['inspect', network, '--format', '{{.State.Status}}'], { timeout: 15000 });
      running = (r.stdout || '').trim() === 'running';
    } catch {}
    if (!running) throw new Error(`Container '${network}' is not running`);
  }
  const extraVols = validateExtraVolumes(name, agent, extraVolumes);
  const extraPs = validateExtraPorts(extraPorts, { sshPort: finalPort });

  // Custom workspace bind (plan 24): validate BEFORE writing meta/compose so a
  // bad request aborts with a clear error and leaves nothing behind. `wsMount`
  // is `{ host, container, webuiVisible, hostBrowsable }` or null.
  const wsMount = workspaceHost || workspaceDir
    ? validateWorkspaceMount(name, agent, workspaceHost, workspaceDir)
    : null;

  const agentDataDir = path.join(instDir, agent);
  fs.mkdirSync(agentDataDir, { recursive: true });
  onLog('system', `Created instance directory: ${instDir}`);

  // Create the host workspace source up front so a fresh mount has somewhere to
  // land. Only when the source is under the project root — the webui is the
  // only thing that can create dirs there (host sources outside HOST_WORKSPACE
  // are expected to already exist, e.g. a shared data drive).
  if (wsMount && wsMount.webuiVisible) {
    const view = containerViewOf(wsMount.host);
    if (view && !fs.existsSync(view)) {
      fs.mkdirSync(view, { recursive: true });
      onLog('system', `Created workspace source: ${wsMount.host}`);
    }
  }

  if (mode === 'clone') {
    // Clone is type-locked: a clone inherits the source's build files + data
    // dir, so it must be the SAME agent type. When no source is given, pick the
    // most recent same-type instance instead of blindly taking the latest.
    const candidates = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .filter(n => n.startsWith(PREFIX + '-'))
      .sort().reverse();
    let src = cloneSource || '';
    if (!src) {
      src = candidates.find((n) => (readMeta(path.join(INSTANCES_DIR, n)).AGENT || 'openclaw') === agent) || '';
    }
    if (!src) throw new Error(`No '${agent}' source VM available to clone`);
    const srcMeta = readMeta(path.join(INSTANCES_DIR, src));
    const srcAgent = srcMeta.AGENT || 'openclaw';
    if (srcAgent !== agent) {
      throw new Error(`Cannot clone '${src}' (type=${srcAgent}) into '${name}' (type=${agent}) — clones must share the same agent type`);
    }
    const srcDir = path.join(INSTANCES_DIR, src, srcAgent);
    if (fs.existsSync(srcDir)) {
      onLog('system', `Cloning workspace from ${src}…`);
      for (const entry of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, entry);
        const dstPath = path.join(agentDataDir, entry);
        if (fs.statSync(srcPath).isDirectory()) {
          fs.cpSync(srcPath, dstPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, dstPath);
        }
      }
      onLog('system', `Cloned workspace from ${src}`);
    } else {
      throw new Error(`Source workspace for '${src}' not found`);
    }
    // Same-type clones inherit the source's build files (customizations too) —
    // they still get their OWN image tag via imageFor(name).
    const srcBuildDir = buildDir(src);
    if (fs.existsSync(srcBuildDir)) {
      fs.cpSync(srcBuildDir, buildDir(name), { recursive: true });
      onLog('system', `Cloned build files from ${src}`);
    }
    // The clone inherits the source's build.env; the docker toggle still needs
    // to reflect the requested state for THIS clone.
    setBuildEnv(name, { INSTALL_DOCKER: allowDocker ? '1' : '0' });
  } else {
    seedBuildDir(name, agent, { installDocker: allowDocker });
  }

  let metaTxt = `ROOT_PASSWORD=${pw}\nAGENT=${agent}\n`;
  if (finalPort) metaTxt += `PORT=${finalPort}\n`;
  if (finalCport !== DEFAULT_SSH_CPORT) metaTxt += `SSH_CPORT=${finalCport}\n`;
  metaTxt += `DOCKER=${allowDocker ? '1' : '0'}\n`;
  if (network) metaTxt += `NETWORK=${network}\n`;
  // Workspace mount flags MUST be written before writeInstanceCompose — the
  // compose generator reads them from meta to emit the extra bind.
  if (wsMount) metaTxt += `WORKSPACE_HOST=${wsMount.host}\nWORKSPACE_DIR=${wsMount.container}\n`;
  // Extra volumes / ports (plan 28): single-line JSON, read back by the
  // compose generator (readExtraVolumes/readExtraPorts) on every regen path.
  if (extraVols.length) metaTxt += `EXTRA_VOLUMES=${JSON.stringify(extraVols)}\n`;
  if (extraPs.length) metaTxt += `EXTRA_PORTS=${JSON.stringify(extraPs)}\n`;
  fs.writeFileSync(path.join(instDir, 'meta.env'), metaTxt);

  // Peer mode: resolve the peer's bridge network so the socat door (SSH + extra
  // ports) is emitted on the right network — the host-mode door fallback would
  // forward to 127.0.0.1 and reach nothing for a bridge-networked peer.
  let webPeerNetwork = '';
  if (network) {
    webPeerNetwork = await getPeerNetworkName(network);
  }

  writeInstanceCompose(name, agent, pw, finalPort, { allowDocker, network, webPeerNetwork });

  const composePath = instanceComposePath(name);

  onStep('build', 'start');
  try {
    await runCompose(name, ['build'], { stream: true, onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    await pruneDanglingImages(onLog);
    throw e;
  }
  onStep('build', 'end');

  onStep('up', 'start');
  try {
    await runCompose(name, ['up', '-d'], { stream: true, onLog, timeout: 300000 });
  } catch (e) {
    onStep('up', 'error');
    await pruneDanglingImages(onLog);
    throw e;
  }
  onStep('up', 'end');
  await pruneDanglingImages(onLog);

  const driver = getDriver(agent);
  const setupSteps = driver.setupSteps || [];
  if (setupSteps.length && !skipSetup) {
    onStep('setup', 'start');
    let allReady = true;
    for (const step of setupSteps) {
      let ready = false;
      for (let i = 0; i < 15; i++) {
        try {
          await runCmdStream('docker', ['exec', name, step.cmd, ...(step.args || [])], { onLog, timeout: 60000 });
          ready = true;
          break;
        } catch {
          if (i === 14) break;
          onLog('system', `Container not ready yet (attempt ${i + 1}/15), waiting…`);
          await new Promise(r => setTimeout(r, 1000));
        }
      }
      if (!ready) { allReady = false; break; }
    }
    if (!allReady) {
      onStep('setup', 'error');
      throw new Error(`Container '${name}' did not become ready for setup`);
    }
    onStep('setup', 'end');
  }

  if (setupSteps.length && !skipSetup) {
    await runCmdStream('docker', ['restart', name], { onLog, timeout: 30000 });
  }

  return name;
}

/** Pre-flight validation for a create request — the shared gate behind both
 *  `POST /api/agents/create` and the MCP `create_agent` tool (plan 30 rule #1:
 *  business logic lives here, REST + MCP are thin adapters). Runs the same
 *  checks the route used to do inline so both callers abort with identical
 *  errors BEFORE any 202/job is emitted. `createVm` re-checks everything
 *  internally too (it must — clone uses it), so this is a clean early abort,
 *  not the only line of defense. Throws with a user-facing message.
 *  Returns the normalized `{ sshHostPort, sshCport, wsMount }` that `createVm`
 *  expects (auto-allocated SSH host port, validated container port, validated
 *  workspace mount). */
async function validateAgentCreate(name, opts = {}) {
  const {
    agent = 'openclaw', sshEnabled = false, port = '', sshContainerPort = '',
    workspaceHost = '', workspaceDir = '', network = '',
    extraVolumes = null, extraPorts = null,
  } = opts;

  if (!VM_NAME_RE.test(name)) throw new Error('Invalid agent name');
  if (!drivers[agent]) throw new Error(`Unknown agent type '${agent}'`);

  if (network) {
    if (network === name) throw new Error('Cannot route an agent through itself');
    let running = false;
    try {
      const r = await runCmd('docker', ['inspect', network, '--format', '{{.State.Status}}'], { timeout: 15000 });
      running = (r.stdout || '').trim() === 'running';
    } catch {}
    if (!running) throw new Error(`Container '${network}' is not running`);
  }

  let sshHostPort = '';
  if (sshEnabled) sshHostPort = port || autoSshPort();
  const sshCportRaw = String(sshContainerPort || '').trim();
  const sshCportValid = /^\d+$/.test(sshCportRaw) && +sshCportRaw >= 1 && +sshCportRaw <= 65535;
  if (sshEnabled && sshCportRaw && !sshCportValid) {
    throw new Error('SSH container port must be an integer between 1 and 65535');
  }

  // Pure constraints first (these throw synchronously inside createVm too).
  validateExtraVolumes(name, agent, extraVolumes);
  const extraPs = validateExtraPorts(extraPorts, { sshPort: sshHostPort });
  const wsMount = workspaceHost || workspaceDir
    ? validateWorkspaceMount(name, agent, workspaceHost, workspaceDir)
    : null;

  // Async cross-agent host-port availability across the whole request: the
  // optional SSH port and every extra port together, before anything is made.
  for (const hp of [...extraPs.map((p) => p.host), sshHostPort].filter(Boolean)) {
    if (await hostPortInUse(hp, name)) {
      throw new Error(`Host port ${hp} is already in use by another agent`);
    }
  }

  return { sshHostPort, sshCport: sshCportValid ? sshCportRaw : '', wsMount };
}

/** Create a PAD — validate, then `createVm` (seed build dir → write meta +
 *  compose → build per-instance image → compose up → run driver setup steps →
 *  restart). The shared path behind both the REST create route and the MCP
 *  `create_agent` tool. Accepts the same `createVm` options plus the raw
 *  request fields (sshEnabled/port/sshContainerPort/workspaceHost/
 *  workspaceDir); normalizes them exactly like the route used to before
 *  delegating. Returns the created PAD name. */
async function createAgent(name, opts = {}) {
  const v = await validateAgentCreate(name, opts);
  return createVm(name, {
    ...opts,
    mode: 'fresh',
    sshEnabled: !!opts.sshEnabled,
    port: v.sshHostPort,
    sshCport: v.sshCport,
    workspaceHost: v.wsMount ? v.wsMount.host : '',
    workspaceDir: v.wsMount ? v.wsMount.container : '',
  });
}

/** Remove an instance directory even when its data is root-owned. Agent
 *  containers run as root and write their data dir as root; the webui runs as
 *  uid 1000 and cannot unlink files inside root-owned directories, so a plain
 *  `fs.rmSync` throws EACCES. On EACCES/EPERM the deletion finishes through a
 *  one-shot root helper container built from our own webui image — the daemon
 *  resolves the bind by HOST path (`HOST_WORKSPACE`), not the webui's
 *  `/workspace` namespace. Falls back to a clear, actionable error. */
async function removeInstanceDir(name, instDir) {
  if (!fs.existsSync(instDir)) return;
  try {
    fs.rmSync(instDir, { recursive: true, force: true });
    return;
  } catch (e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw e;
  }
  const hostInstDir = path.join(HOST_WORKSPACE, 'instances', name);
  try {
    // Delete the MOUNT'S CONTENTS, not the mountpoint itself — `rm -rf /d`
    // fails with EACCES "Device or resource busy" because /d is the bind
    // target. `find -delete` clears the root-owned files; the empty dir is
    // then rmdir'd by the webui (the parent is uid-1000-owned).
    await runCmd('docker', ['run', '--rm', '-v', `${hostInstDir}:/d`, '--entrypoint', 'find', 'paddock-webui:latest', '/d', '-mindepth', '1', '-delete'], { timeout: 120000 });
  } catch {
    throw new Error(
      `Deleting '${name}' failed: the instance data is root-owned and the privileged cleanup could not remove it. Run this on the host: chown -R 1000:1000 ${hostInstDir}`
    );
  }
  if (fs.existsSync(instDir)) fs.rmSync(instDir, { recursive: true, force: true });
}

async function removeVm(name) {
  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
  // The socat door container (<name>-door, or the legacy <name>-web) survives
  // `docker rm` of the agent and would keep holding its host ports forever —
  // drop both forms.
  for (const suffix of ['-door', '-web']) {
    try { await runCmd('docker', ['rm', '-f', name + suffix], { timeout: 30000 }); } catch {}
  }
  try { await runCmd('docker', ['network', 'rm', `${name}_default`], { timeout: 30000 }); } catch {}
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir) || {};
  const agent = meta.AGENT || 'openclaw';
  // Custom workspace source (plan 24): when the mount lives OUTSIDE the agent's
  // data dir but still under the project root, remove it so the delete leaves
  // no orphan folder. Sources inside the data dir are deleted with it; sources
  // outside HOST_WORKSPACE are never touched.
  if (meta.WORKSPACE_HOST) {
    try {
      const info = workspaceMountInfo(name, agent, meta.WORKSPACE_HOST, meta.WORKSPACE_DIR || '');
      const dataHost = path.join(HOST_WORKSPACE, 'instances', name, agent);
      if (info.webuiVisible && info.host !== dataHost && !info.host.startsWith(dataHost + path.sep)) {
        const view = containerViewOf(info.host);
        if (view && fs.existsSync(view)) fs.rmSync(view, { recursive: true, force: true });
      }
    } catch {}
  }
  await removeInstanceDir(name, instDir);
  // The per-instance image is this PAD's own tag — drop it too, otherwise every
  // create/delete cycle leaks a paddock-vm-<name>:latest image.
  try { await runCmd('docker', ['rmi', imageFor(name)], { timeout: 30000 }); } catch {}
  // ...and sweep any dangling layers the tag shared or left behind.
  await pruneDanglingImages();
}

/** Reclaim disk from orphaned image layers. `docker compose build` retags the
 *  per-PAD image, orphaning every previous build as a dangling `<none>` image;
 *  failed creates and interrupted jobs leak whole images. A dangling prune is
 *  safe (only touches `<none>` layers no container references) and a cheap
 *  no-op when there's nothing to reclaim. Never throws; reports freed space. */
async function pruneDanglingImages(onLog = () => {}) {
  try {
    const r = await runCmd('docker', ['image', 'prune', '-f'], { timeout: 120000 });
    const m = /Total reclaimed space:\s*([0-9.]+[kMGT]?B)/i.exec(r.stderr || r.stdout || '');
    if (m) onLog('system', `Reclaimed ${m[1]} from dangling image layers`);
  } catch (e) {
    onLog('system', `Image prune skipped: ${e.message || e}`);
  }
}

async function resetVm(name) {
  const instDir = path.join(INSTANCES_DIR, name);
  const metaPath = path.join(instDir, 'meta.env');
  if (!fs.existsSync(metaPath)) throw new Error(`VM '${name}' does not exist`);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';

  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
  const agentDir = path.join(instDir, agent);
  if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  const allowDocker = meta.DOCKER === '1';
  const network = meta.NETWORK || '';
  seedBuildDir(name, agent, { installDocker: allowDocker });
  // Preserve the COMPLETE persisted binding set (plan 28 fix): docker, network
  // peer, published web app (+ its door), custom workspace, and the extra
  // volumes/ports in meta — the compose generator reads them all from meta, so
  // resetting the data dir must never silently drop a bind.
  const webService = readWebService(name);
  let webPeerNetwork = '';
  if (network) webPeerNetwork = await getPeerNetworkName(network);
  writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });

  const composePath = instanceComposePath(name);
  await runCompose(name, ['up', '-d'], { timeout: 120000 });
}

function getComposePath(name) {
  return instanceComposePath(name);
}

async function startAgent(name) {
  try {
    await runCmd('docker', ['start', name], { timeout: 30000 });
  } catch {
    // Stale network peer (e.g. gluetun was rebuilt) — `docker start` can't
    // rejoin the old `container:<id>` namespace. Recreate via compose so the
    // peer re-resolves by name to the current container.
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { timeout: 180000 });
  }
  await startDoors(name);
}

/** Stop the agent container and its socat door(s) together. The door only
 *  forwards to the agent's ports inside the peer namespace, so it is useless
 *  while the agent is down — stop it so it isn't a stray open listener. No-op
 *  for already-stopped containers (errors swallowed). */
async function stopAgent(name) {
  await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 }).catch(() => {});
  await stopDoors(name);
}

/** Restart the agent and bring its socat door(s) back up. */
async function restartAgent(name) {
  await runCmd('docker', ['restart', '-t', '30', name], { timeout: 60000 }).catch(() => {});
  await startDoors(name);
}

/** Regex matching the socat door container name(s) of an agent — the current
 *  `<name>-door` plus the legacy `<name>-web` (renamed in the multi-port door
 *  refactor; old doors must be treated as this agent's too). */
function doorNameRe(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(${esc}-door|${esc}-web)$`);
}

/** List the agent's existing door container names (running or stopped). */
async function listDoors(name) {
  const re = doorNameRe(name);
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30000 });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter((n) => n && re.test(n));
}

/** Start the agent's socat door(s) alongside the agent (Paddock Start/Restart).
 *  `docker start` is a no-op on an already-running door. Missing doors (default
 *  network) are ignored. */
async function startDoors(name) {
  for (const cname of await listDoors(name)) {
    await runCmd('docker', ['start', cname], { timeout: 30000 }).catch(() => {});
  }
}

/** Stop the agent's socat door(s) alongside the agent (Paddock Stop). */
async function stopDoors(name) {
  for (const cname of await listDoors(name)) {
    await runCmd('docker', ['stop', '-t', '10', cname], { timeout: 30000 }).catch(() => {});
  }
}

// ─── Shared orchestrator + reads (plan 30) ────────────────────────────────
// Business logic lives here so the Express routes (app.js) AND the MCP tools
// (mcp.js) are thin adapters over the SAME functions. Never duplicate a flow
// between REST and MCP.

async function psNames() {
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30000 });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

async function psStateMap() {
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.State}}'], { timeout: 15000 });
  const map = {};
  for (const line of (r.stdout || '').trim().split('\n')) {
    if (!line) continue;
    const [n, s] = line.split('\t');
    if (n) map[n] = s;
  }
  return map;
}

/** Whether the agent container is currently `running`. */
async function isContainerRunning(name) {
  try {
    const r = await runCmd('docker', ['inspect', name, '--format', '{{.State.Status}}'], { timeout: 15000 });
    return (r.stdout || '').trim() === 'running';
  } catch {
    return false;
  }
}

/** True when the given host port is published by any OTHER agent — either a
 *  declared compose port (other instances) or a live docker published port. */
async function hostPortInUse(hostPort, excludeName) {
  const h = String(hostPort);
  if (fs.existsSync(INSTANCES_DIR)) {
    for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === excludeName) continue;
      const cf = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
      if (fs.existsSync(cf)) {
        for (const m of fs.readFileSync(cf, 'utf8').matchAll(/"(\d+):\d+"/g)) {
          if (m[1] === h) return true;
        }
      }
    }
  }
  try {
    const r = await runCmd('docker', ['ps', '--format', '{{.Names}}\t{{.Ports}}'], { timeout: 15000 });
    for (const line of r.stdout.split('\n')) {
      const [cn, ports] = line.split('\t');
      if (!ports || cn === excludeName) continue;
      if (new RegExp(`(^|[,:])${h}->`).test(ports)) return true;
    }
  } catch {}
  return false;
}

/** Shell content of the per-instance web start hook (start-web.sh). The hook
 *  is written into the agent's data-dir bind mount and executed by start.sh on
 *  boot, so the published server survives recreates. Execute it with `bash`,
 *  not `source`: its early exit must not terminate start.sh. It is re-runnable:
 *  a port probe skips the launch when an instance is already listening. */
function buildWebHook(driver, agent, webService, password) {
  const dataDir = driver.dataDir;
  const pidFile = `${dataDir}/web.pid`;
  const logFile = `${dataDir}/web.log`;
  const startCmd = driver.webApp.startCommand({ password, containerPort: webService.containerPort });
  return `#!/bin/bash
# Paddock web publishing — start the published web server on boot.
# Re-runnable: skips when something is already listening on the port (a plain
# pidfile can go stale across container recreates since the data dir persists).
if ( exec 3<>/dev/tcp/127.0.0.1/${webService.containerPort} ) 2>/dev/null; then
  exec 3>&- 2>/dev/null
  exit 0
fi
${startCmd} 2>&1 | tee -a ${logFile} >/proc/1/fd/1 &
echo $! > "${pidFile}"
`;
}

/** Host path of the driver's config file (instances/<name>/<agent>/...), the
 *  same file the container sees at <dataDir>/<configFile> via the bind mount.
 *  Only meaningful for drivers that keep a real config file on disk. */
function driverConfigPath(name, driver) {
  return path.join(INSTANCES_DIR, name, driver.type, driver.configFile || 'openclaw.json');
}

/** Effective web-publish auth secret for an agent, read back the same way it
 *  was applied: an 'env'-target driver embeds the secret in the start-web.sh
 *  hook via startCommand (opencode/picoclaw/hermes); an 'openclaw.json'-target
 *  driver stores it in the config file's gateway.auth.token (openclaw). Returns
 *  '' when nothing is configured. */
function readWebAuth(driver, name) {
  const auth = driver.webApp && driver.webApp.auth;
  if (auth && auth.target === 'openclaw.json') {
    // Preferred source: the token persisted in web.json at publish time. The
    // agent container rewrites openclaw.json as root, which the webui (uid
    // 1000) often can't read back — web.json is webui-owned and stable.
    try {
      const w = JSON.parse(fs.readFileSync(webServicePath(name), 'utf8'));
      if (w && w.authToken) return String(w.authToken);
    } catch {}
    const configPath = driverConfigPath(name, driver);
    if (!fs.existsSync(configPath)) return '';
    try {
      const d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return (d.gateway && d.gateway.auth && d.gateway.auth.token) || '';
    } catch {
      return '';
    }
  }
  const hookPath = webHookPath(name, driver.type);
  if (!fs.existsSync(hookPath)) return '';
  const content = fs.readFileSync(hookPath, 'utf8');
  const m = /OPENCODE_SERVER_PASSWORD='([^']*)'/.exec(content);
  return m ? m[1] : '';
}

/** Path of the state file holding an openclaw gateway's pre-publish
 *  `bind` + `auth` (written by applyWebAuth, consumed by removeWebAuth). It
 *  lives next to the config inside the agent's data dir so the root patch
 *  helper (which sees only that bind) can read/write it; apply chowns it to
 *  node so the webui can read it directly. */
function webOpenclawStatePath(name, driver) {
  const configPath = driverConfigPath(name, driver);
  return path.join(path.dirname(configPath), 'web-openclaw.json');
}

/** Pre-publish openclaw gateway state, or null. Shape: { bind, auth,
 *  controlUi }. */
function readWebOpenclawState(name, driver) {
  const p = webOpenclawStatePath(name, driver);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** One-shot root-helper node script that patches the bind-mounted openclaw
 *  config from inside a container (agent data dirs are root-owned; the webui
 *  cannot open them). `apply` saves the pre-publish gateway bind/auth, sets
 *  bind lan + auth token, then chowns config + state to node so later native
 *  reads/writes work. `remove` restores the saved bind/auth and drops the
 *  state file. Exits non-zero on failure (2 unreadable config, 3 no state). */
const OPENCLAW_WEB_PATCH_SCRIPT = `const fs=require('fs');
const op=process.argv[1];
const cfg='/d/openclaw.json';
const st='/d/web-openclaw.json';
let d;
try { d=JSON.parse(fs.readFileSync(cfg,'utf8')); }
catch(e){ process.stderr.write('read:'+e.message); process.exit(2); }
let gw=(d.gateway&&typeof d.gateway==='object')?d.gateway:{};
if(op==='apply'){
  if(!fs.existsSync(st)){
    fs.writeFileSync(st,JSON.stringify({
      bind:gw.bind||'',
      auth:gw.auth!==undefined?gw.auth:null,
      controlUi:gw.controlUi!==undefined?gw.controlUi:null
    },null,2));
  }
  d.gateway={...gw,bind:'lan',auth:{mode:'token',token:process.argv[2]||''},
    controlUi:{dangerouslyDisableDeviceAuth:true}};
}else if(op==='remove'){
  let saved;
  try{ saved=JSON.parse(fs.readFileSync(st,'utf8')); }
  catch(e){ process.stderr.write('nostate'); process.exit(3); }
  if(saved.bind) gw.bind=saved.bind; else delete gw.bind;
  if(saved.auth) gw.auth=saved.auth; else delete gw.auth;
  if(saved.controlUi) gw.controlUi=saved.controlUi; else delete gw.controlUi;
  if(Object.keys(gw).length) d.gateway=gw; else delete d.gateway;
}else{ process.stderr.write('badop'); process.exit(4); }
fs.writeFileSync(cfg,JSON.stringify(d,null,2)+'\\n');
fs.chownSync(cfg,1000,1000);
try{ fs.chownSync(st,1000,1000); }catch{}
`;

/** Run the openclaw config patch through a one-shot root helper of our own
 *  image (host-path bind), matching the removeInstanceDir pattern for
 *  root-owned instance data. Throws with a clear, actionable message. */
async function patchOpenclawConfigViaHelper(name, driver, op, password) {
  const hostDir = path.join(HOST_WORKSPACE, 'instances', name, driver.type);
  try {
    await runCmd('docker', [
      'run', '--rm', '-v', `${hostDir}:/d`, '--entrypoint', 'node',
      'paddock-webui:latest', '-e', OPENCLAW_WEB_PATCH_SCRIPT, op, password || '',
    ], { timeout: 60000 });
    return true;
  } catch (e) {
    throw new Error(
      `Could not ${op === 'apply' ? 'patch' : 'restore'} openclaw.json for web publishing ` +
      `(the file is root-owned). Run this on the host: chown 1000:1000 ${driverConfigPath(name, driver)}`
    );
  }
}

/** Apply the web-publish auth before the container is recreated. Only
 *  'openclaw.json'-target drivers need this: the openclaw gateway reads
 *  gateway.bind / gateway.auth from the config on startup, so the config must
 *  be patched (bind → lan + auth token) before the recreate. 'env'-target
 *  drivers embed the secret in the start-web.sh hook and need nothing here.
 *  The pre-publish gateway bind + auth are saved to a state file so unpublish
 *  restores exactly those fields without reverting unrelated config edits.
 *  Idempotent. No-op when the driver needs no config patch. Root-owned configs
 *  are patched through a root helper container. */
async function applyWebAuth(name, driver, password, { preserveState = false } = {}) {
  const auth = driver.webApp && driver.webApp.auth;
  if (!auth || auth.target !== 'openclaw.json') return;
  const configPath = driverConfigPath(name, driver);
  if (!fs.existsSync(configPath)) return;
  let d;
  try {
    d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    if (e.code === 'EACCES') return patchOpenclawConfigViaHelper(name, driver, 'apply', password);
    throw new Error(`Cannot patch openclaw.json for web publish: ${e.message}`);
  }
  const gw = (d.gateway && typeof d.gateway === 'object') ? d.gateway : {};
  // Persist the pre-publish state only on the FIRST publish. Re-publishing an
  // already-published pad (password or host-port change) must NOT overwrite the
  // saved original with the current published form, or unpublish would restore
  // the published state instead of the pre-publish one.
  if (!preserveState) {
    const statePath = webOpenclawStatePath(name, driver);
    if (!fs.existsSync(statePath)) {
      fs.writeFileSync(statePath, JSON.stringify({
        bind: gw.bind || '',
        auth: gw.auth !== undefined ? gw.auth : null,
        controlUi: gw.controlUi !== undefined ? gw.controlUi : null,
      }, null, 2));
    }
  }
  // Paddock publishes over plain HTTP; the Control UI requires a device
  // identity in a secure context otherwise, so disable that check (token-only
  // auth). Restored to the pre-publish value by removeWebAuth.
  d.gateway = { ...gw, bind: 'lan', auth: { mode: 'token', token: String(password || '') }, controlUi: { dangerouslyDisableDeviceAuth: true } };
  try {
    fs.writeFileSync(configPath, JSON.stringify(d, null, 2) + '\n');
  } catch (e) {
    throw new Error(
      `Cannot write openclaw.json to publish the web app (${e.code || e.message}). ` +
      `If the file is root-owned, fix it on the host: chown 1000:1000 ${configPath}`
    );
  }
}

/** Undo a web-publish config patch: restore the saved pre-publish gateway
 *  `bind` + `auth` (preserving any unrelated config edits made while
 *  published) and drop the state file. No-op for drivers that need no patch or
 *  when nothing was patched. Root-owned configs are restored through a root
 *  helper container. */
async function removeWebAuth(name, driver) {
  const auth = driver.webApp && driver.webApp.auth;
  if (!auth || auth.target !== 'openclaw.json') return;
  const saved = readWebOpenclawState(name, driver);
  if (!saved) return;
  const configPath = driverConfigPath(name, driver);
  if (!fs.existsSync(configPath)) {
    try { fs.rmSync(webOpenclawStatePath(name, driver)); } catch {}
    return;
  }
  try {
    const d = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gw = (d.gateway && typeof d.gateway === 'object') ? { ...d.gateway } : {};
    if (saved.bind) gw.bind = saved.bind; else delete gw.bind;
    if (saved.auth) gw.auth = saved.auth; else delete gw.auth;
    if (saved.controlUi) gw.controlUi = saved.controlUi; else delete gw.controlUi;
    if (Object.keys(gw).length) d.gateway = gw; else delete d.gateway;
    fs.writeFileSync(configPath, JSON.stringify(d, null, 2) + '\n');
    try { fs.rmSync(webOpenclawStatePath(name, driver)); } catch {}
  } catch (e) {
    if (e.code === 'EACCES') {
      return patchOpenclawConfigViaHelper(name, driver, 'remove', '');
    }
    // Unreadable for another reason — keep the state file so a later attempt
    // (or manual fix) can still restore the original bind/auth.
    console.error(`removeWebAuth could not restore openclaw.json for ${name}:`, e.message);
  }
}

/** Whether the baked image's start.sh ships the docker CLI (settings toggle:
 *  enabling docker on an image without it triggers a rebuild). Checks the
 *  running container when up, else spins a throwaway container. Shared by the
 *  app.js settings route and `applyAgentChanges`. */
async function imageHasDockerCli(name, image, wasRunning) {
  try {
    const r = wasRunning
      ? await runCmd('docker', ['exec', name, 'sh', '-lc', 'command -v docker'], { timeout: 15000 })
      : await runCmd('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-lc', 'command -v docker'], { timeout: 30000 });
    return !!(r.stdout || '').trim();
  } catch {
    return false;
  }
}

/** Whether the baked /usr/local/bin/start.sh knows to honor the SSH_PORT env
 *  (i.e. the image was built from a start.sh containing the SSH_PORT block).
 *  Checks the running container when up, else spins a throwaway container.
 *  Shared by the app.js settings route and `applyAgentChanges`. */
async function imageHasSshPortSupport(name, image, wasRunning) {
  try {
    await (wasRunning
      ? runCmd('docker', ['exec', name, 'sh', '-lc', 'grep -q SSH_PORT /usr/local/bin/start.sh'], { timeout: 15000 })
      : runCmd('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-lc', 'grep -q SSH_PORT /usr/local/bin/start.sh'], { timeout: 30000 }));
    return true;
  } catch {
    return false;
  }
}

/** Whether the baked /usr/local/bin/start.sh runs the web start-hook (i.e. the
 *  image was built from a start.sh containing the web start block). Checks the
 *  running container when up, else spins a throwaway container. Used by
 *  `applyAgentChanges` to decide whether publishing web on a pre-hook PAD needs
 *  a rebuild (backfilled via ensureWebStartBlock). */
async function imageHasWebStartSupport(name, image, wasRunning) {
  try {
    await (wasRunning
      ? runCmd('docker', ['exec', name, 'sh', '-lc', 'grep -q start-web.sh /usr/local/bin/start.sh'], { timeout: 15000 })
      : runCmd('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-lc', 'grep -q start-web.sh /usr/local/bin/start.sh'], { timeout: 30000 }));
    return true;
  } catch {
    return false;
  }
}

/** Can the container reach its own published web port? Used to verify the web
 *  server actually came up after activation (bash /dev/tcp, no extra tools). */
async function webPortReachable(name, port) {
  try {
    const r = await runCmd('docker', ['exec', name, 'bash', '-lc', `exec 3<>/dev/tcp/127.0.0.1/${port} && echo UP || echo DOWN`], { timeout: 10000 });
    return (r.stdout || '').includes('UP');
  } catch {
    return false;
  }
}

/** Effective network peer name of an agent — meta.NETWORK, falling back to the
 *  compose file (legacy agents predate the meta flag). Empty = default network. */
function currentNetworkPeer(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  if (meta.NETWORK) return meta.NETWORK;
  try {
    const cf = path.join(INSTANCES_DIR, name, 'docker-compose.yml');
    const m = /network_mode:\s*container:(\S+)/.exec(fs.readFileSync(cf, 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Reconcile the socat door against what the agent currently declares (meta +
 *  web.json, peer mode only): drop an orphaned door container, then bring up
 *  the declared one with its full port set. Call AFTER the agent recreate when
 *  entering/staying in peer mode. The door is idempotent — an already-correct
 *  door is a no-op, and `forceRecreate` (network change) makes it pick up the
 *  new peer. */
async function syncDoors(name, { forceRecreate = false, log = () => {} } = {}) {
  const declared = desiredDoors(name);
  const declaredNames = new Set(declared.map((d) => d.service));
  const re = doorNameRe(name);
  const all = await psStateMap();
  for (const cname of Object.keys(all)) {
    if (re.test(cname) && !declaredNames.has(cname)) {
      log('system', `Removing orphaned ${cname} forwarding door`);
      await runCmd('docker', ['rm', '-f', cname], { timeout: 30000 }).catch(() => {});
    }
  }
  for (const d of declared) {
    const desc = d.ports.map((p) => `${p.hostPort}→${p.containerPort}`).join(', ');
    log('system', `Starting ${d.service} forwarding door (${desc})`);
    const args = ['up', '-d', '--no-deps'];
    if (forceRecreate) args.push('--force-recreate');
    args.push(d.service);
    await runCompose(name, args, { stream: true, onLog: log, timeout: 180000 });
  }
}

/** Drop the agent's socat door. Used when LEAVING peer mode: the door still
 *  holds the host ports the agent is about to publish directly, so it must be
 *  removed BEFORE the agent recreate or the port bind fails. */
async function removeDoors(name, log = () => {}) {
  const re = doorNameRe(name);
  for (const cname of await psNames()) {
    if (re.test(cname)) {
      log('system', `Removing ${cname} forwarding door`);
      await runCmd('docker', ['rm', '-f', cname], { timeout: 30000 }).catch(() => {});
    }
  }
}

/** Boot-time sweep: drop any <name>-door / <name>-web forwarding containers
 *  whose agent (instances/<name>) no longer exists. Door containers survive
 *  `removeVm` of the agent in older code, so a deleted agent's door keeps
 *  holding its host port forever and blocks other agents from reusing it. */
async function cleanOrphanDoors() {
  for (const cname of await psNames()) {
    const m = /^(.*)-(door|web)$/.exec(cname);
    if (!m) continue;
    // Never remove a real agent whose name happens to end in -door/-web.
    if (fs.existsSync(path.join(INSTANCES_DIR, cname))) continue;
    const base = m[1];
    if (fs.existsSync(path.join(INSTANCES_DIR, base))) continue;
    console.log(`[orphan-door] removing ${cname} (agent ${base} gone)`);
    await runCmd('docker', ['rm', '-f', cname], { timeout: 30000 }).catch(() => {});
  }
}

/** All containers (name, image, state) — the network-peer dropdown source
 *  (shared by `GET /api/containers` and the MCP `list_networks` tool). */
async function listContainers() {
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 15000 });
  const out = [];
  for (const line of (r.stdout || '').trim().split('\n')) {
    if (!line) continue;
    try {
      const c = JSON.parse(line);
      out.push({
        name: Array.isArray(c.Names) ? String(c.Names[0] || '').replace(/^\//, '') : String(c.Names || c.ID || '').replace(/^\//, ''),
        image: c.Image || '',
        state: (c.State || '').toLowerCase(),
      });
    } catch {}
  }
  return out;
}

/** Current settings + published-web state, shared by `GET
 *  /api/agents/:name/settings` and the MCP `settings_get` tool. The web
 *  binding rides along so a single read reconstructs the whole picture before
 *  a consolidated `recreate`. */
async function readSettings(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  const agentType = meta.AGENT || 'openclaw';
  const driver = getDriver(agentType);
  const image = imageFor(name);
  let version = meta.OPENCLAW_VERSION || '';
  try {
    version = (await driver.currentVersion(name)) || version;
  } catch {}
  let networkHealth = { state: 'ok' };
  try {
    networkHealth = await getNetworkHealth(name);
  } catch {}
  let workspaceMount = null;
  try {
    workspaceMount = readWorkspaceMount(name, agentType);
  } catch {}
  const web = await readWebState(name);
  return {
    allowDocker: meta.DOCKER === '1',
    network: meta.NETWORK || '',
    sshPort: meta.PORT || '',
    sshContainerPort: readSshCport(name),
    image,
    version,
    networkHealth,
    workspaceMount,
    extraVolumes: readExtraVolumes(name),
    extraPorts: readExtraPorts(name),
    web,
  };
}

/** Published-web state, shared by `GET /api/agents/:name/web`, `readSettings`
 *  (which embeds it) and the MCP `settings_get` tool. */
async function readWebState(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  const agentType = meta.AGENT || 'openclaw';
  const driver = getDriver(agentType);
  const extraPorts = readExtraPorts(name);
  const sshPort = meta.PORT || '';
  const sshContainerPort = readSshCport(name);
  if (!driver.webApp) return { webApp: null, extraPorts, sshPort, sshContainerPort };
  const webService = readWebService(name);
  const active = !!webService;
  let password = '';
  if (active) password = readWebAuth(driver, name);
  const netPeer = currentNetworkPeer(name);
  const portContainer = netPeer ? doorName(name) : name;
  let actualPorts = [];
  try {
    const p = await runCmd('docker', ['inspect', portContainer, '--format', '{{json .NetworkSettings.Ports}}'], { timeout: 15000 });
    const ports = JSON.parse(p.stdout || '{}');
    actualPorts = Object.keys(ports).map((k) => {
      const pub = ports[k] && ports[k][0];
      return { container: k, host: pub ? pub.HostPort : null };
    });
  } catch {}
  return {
    webApp: {
      label: driver.webApp.label,
      docs: driver.webApp.docs || '',
      containerPort: driver.webApp.containerPort,
      auth: driver.webApp.auth
        ? { label: driver.webApp.auth.label, hint: driver.webApp.auth.hint || '' }
        : null,
    },
    active,
    networkMode: netPeer,
    webService: active ? webService : null,
    passwordConfigured: active && !!password,
    authToken: active && driver.webApp.auth && driver.webApp.auth.urlToken ? password : '',
    startCommand: active ? driver.webApp.startCommand({ password, containerPort: webService.containerPort }) : '',
    actualPorts,
    extraPorts,
    sshPort,
    sshContainerPort,
  };
}

/** Summarized `docker inspect` for the Settings → Container Info popup and the
 *  MCP `settings_get` surface. Shared by `GET /api/agents/:name/container-info`. */
async function containerInfo(name) {
  let r;
  try {
    r = await runCmd('docker', ['inspect', name], { timeout: 15000 });
  } catch (e) {
    throw new Error(/no such (object|container)/i.test(e.message || '')
      ? 'Container not found'
      : (e.stderr || e.message || 'Failed to inspect container'));
  }
  const arr = JSON.parse(r.stdout);
  const c = Array.isArray(arr) ? arr[0] : null;
  if (!c) throw new Error('Container not found');

  const netMode = (c.HostConfig && c.HostConfig.NetworkMode) || '';
  let peerName = '';
  if (netMode.startsWith('container:')) {
    const peerId = netMode.slice('container:'.length);
    try {
      const p = await runCmd('docker', ['inspect', peerId, '--format', '{{.Name}}'], { timeout: 15000 });
      peerName = (p.stdout || '').replace(/^\//, '').trim();
    } catch {}
  }

  const mounts = (c.Mounts || []).map((m) => ({
    type: m.Type || '',
    source: m.Source || '',
    destination: m.Destination || '',
    rw: !!m.RW,
    mode: m.Mode || '',
    propagation: m.Propagation || '',
    name: m.Name || '',
  }));
  const counts = {
    total: mounts.length,
    binds: mounts.filter((m) => m.type === 'bind').length,
    volumes: mounts.filter((m) => m.type === 'volume').length,
    tmpfs: mounts.filter((m) => m.type === 'tmpfs').length,
    readOnly: mounts.filter((m) => !m.rw).length,
    readWrite: mounts.filter((m) => m.rw).length,
  };

  const networks = Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {}).map(([netName, n]) => ({
    name: netName,
    ipAddress: (n && n.IPAddress) || '',
    gateway: (n && n.Gateway) || '',
    aliases: ((n && n.Aliases) || []).filter((a) => a && a !== name),
  }));

  const exposed = Object.keys((c.Config && c.Config.ExposedPorts) || {});
  const published = [];
  for (const [cport, bindings] of Object.entries((c.HostConfig && c.HostConfig.PortBindings) || {})) {
    for (const b of bindings || []) {
      published.push({ container: cport, host: `${b.HostIp || '0.0.0.0'}:${b.HostPort || ''}` });
    }
  }

  const env = (c.Config && c.Config.Env) || [];
  const envKeys = env.map((line) => (line.includes('=') ? line.slice(0, line.indexOf('=')) : line));
  const SECRET_RE = /(password|token|secret|key|apikey|auth|creds?)/i;
  const redact = (arr) => (arr || []).map((line) => {
    const idx = line.indexOf('=');
    if (idx < 0) return line;
    const k = line.slice(0, idx);
    const v = line.slice(idx + 1);
    return SECRET_RE.test(k) && v ? `${k}=********` : line;
  });

  const state = c.State || {};
  return {
    name: (c.Name || '').replace(/^\//, ''),
    exists: true,
    state: {
      status: state.Status || '',
      running: !!state.Running,
      paused: !!state.Paused,
      restarting: !!state.Restarting,
      oomKilled: !!state.OOMKilled,
      exitCode: state.ExitCode,
      startedAt: state.StartedAt || '',
      finishedAt: state.FinishedAt || '',
      restartCount: c.RestartCount || 0,
    },
    created: c.Created || '',
    image: { id: c.Image || '', tag: (c.Config && c.Config.Image) || '' },
    network: { mode: netMode, peerName, networks },
    mounts,
    counts,
    ports: { exposed, published },
    restartPolicy: (c.HostConfig && c.HostConfig.RestartPolicy) || { Name: '', MaximumRetryCount: 0 },
    envCount: envKeys.length,
    envKeys: envKeys.slice(0, 200),
    raw: {
      ...c,
      Config: c.Config ? { ...c.Config, Env: redact(c.Config.Env) } : c.Config,
    },
  };
}

/** Pure validation + effective-value computation for a consolidated change set
 *  (plan 30). Reads meta, validates every provided option (port bounds,
 *  host-port conflicts, network targets, workspace/volume rules) and returns a
 *  context describing exactly which persisted bindings change. Throws on
 *  invalid input. NO side effects. Shared by the REST routes (synchronous 400
 *  responses) and the MCP `recreate` tool.
 *
 *  Rule: `undefined` for an option MUST preserve the current stored value —
 *  never default it. `[]` / `''` / `false` / `{active:false}` still count as
 *  explicit "clear this". */
async function prepareAgentChanges(name, opts = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  if (!meta.AGENT && !meta.ROOT_PASSWORD) throw new Error(`Agent not found: ${name}`);
  const agentType = meta.AGENT || 'openclaw';
  const driver = getDriver(agentType);
  const wasRunning = await isContainerRunning(name);
  const containers = await psStateMap();

  const oldAllow = meta.DOCKER === '1';
  const oldNetwork = meta.NETWORK || '';
  const oldSshPort = meta.PORT || '';
  const oldSshCport = readSshCport(name);
  const oldRootPw = meta.ROOT_PASSWORD || '';
  const oldWeb = readWebService(name);
  const oldVols = readExtraVolumes(name);
  const oldPorts = readExtraPorts(name);
  const oldMount = readWorkspaceMount(name, agentType);
  // The existing secret even when NOT yet published: openclaw's token lives in
  // openclaw.json and outlives unpublishes, so a fresh publish can reuse it
  // instead of demanding the user retype it. Env-target drivers have no hook
  // yet when unpublished and return '' — same as before.
  const oldWebPassword = readWebAuth(driver, name);

  if (opts.reset && opts.confirm === false) {
    throw new Error('Refusing to reset without confirm: true (wipes the data dir).');
  }

  // ── docker socket ──
  const newAllow = opts.allowDocker !== undefined ? !!opts.allowDocker : oldAllow;
  const dockerChanged = newAllow !== oldAllow;

  // ── network peer ──
  let newNetwork = opts.network !== undefined ? (opts.network || '') : oldNetwork;
  if (opts.network !== undefined && newNetwork) {
    if (newNetwork === name) throw new Error('Cannot route an agent through itself');
    const st = containers[newNetwork];
    if (!st) throw new Error(`Container '${newNetwork}' not found`);
    if (st !== 'running') throw new Error(`Container '${newNetwork}' is not running`);
  }
  const networkChanged = newNetwork !== oldNetwork;

  // ── SSH host port (sshEnabled toggles; sshPort alone also sets it) ──
  let newSshPort = oldSshPort;
  let sshChanged = false;
  if (opts.sshEnabled !== undefined || opts.sshPort !== undefined) {
    if (opts.sshEnabled === false) {
      newSshPort = '';
    } else {
      const raw = opts.sshPort !== undefined ? String(opts.sshPort).trim() : '';
      if (raw) {
        if (!/^\d+$/.test(raw) || +raw < 1 || +raw > 65535) {
          throw new Error('SSH host port must be an integer between 1 and 65535');
        }
        newSshPort = raw;
      } else if (!oldSshPort) {
        newSshPort = autoSshPort();
      }
    }
    sshChanged = newSshPort !== oldSshPort;
  }
  if (newSshPort && sshChanged) {
    if (await hostPortInUse(newSshPort, name)) {
      throw new Error(`Host port ${newSshPort} is already in use by another agent`);
    }
    for (const p of oldPorts) {
      if (String(p.host) === String(newSshPort)) {
        throw new Error(`Host port ${newSshPort} is already used by an additional port of this agent`);
      }
    }
    const webH = (opts.web !== undefined ? (opts.web.active ? String(opts.web.hostPort || '') : '') : (oldWeb ? String(oldWeb.hostPort) : ''));
    if (webH && String(webH) === String(newSshPort)) {
      throw new Error(`Host port ${newSshPort} is already the web app host port of this agent`);
    }
  }

  // ── SSH container port (daemon's port inside the container, default 22) ──
  let newSshCport = oldSshCport;
  let sshCportChanged = false;
  if (opts.sshContainerPort !== undefined) {
    const raw = String(opts.sshContainerPort || '').trim();
    if (!/^\d+$/.test(raw) || +raw < 1 || +raw > 65535) {
      throw new Error('SSH container port must be an integer between 1 and 65535');
    }
    newSshCport = raw;
    sshCportChanged = newSshCport !== oldSshCport;
  }

  // ── SSH/root password (empty/absent = keep current) ──
  let newRootPw = '';
  let passwordChanged = false;
  if (typeof opts.sshPassword === 'string' && opts.sshPassword.replace(/[\r\n]/g, '').trim()) {
    newRootPw = opts.sshPassword.replace(/[\r\n]/g, '');
    passwordChanged = newRootPw !== oldRootPw;
  }

  // ── custom workspace (both-or-neither; omitted side falls back to stored) ──
  const reqHost = opts.workspaceHost !== undefined ? opts.workspaceHost : (oldMount ? oldMount.host : '');
  const reqDir = opts.workspaceDir !== undefined ? opts.workspaceDir : (oldMount ? oldMount.container : '');
  let wsMount = null;
  if (reqHost || reqDir) wsMount = validateWorkspaceMount(name, agentType, reqHost, reqDir);
  const oldWsKey = oldMount ? `${oldMount.host}\u0000${oldMount.container}` : '';
  const newWsKey = wsMount ? `${wsMount.host}\u0000${wsMount.container}` : '';
  const workspaceChanged = oldWsKey !== newWsKey;

  // ── extra volumes (full-replace list) ──
  const newVols = opts.extraVolumes !== undefined
    ? validateExtraVolumes(name, agentType, opts.extraVolumes)
    : oldVols;
  const volumesChanged = JSON.stringify(newVols) !== JSON.stringify(oldVols);

  // ── web publish (single binding; omitted fields keep the current ones) ──
  let newWeb = oldWeb;
  let webChanged = false;
  let newWebPassword = oldWebPassword;
  if (opts.web !== undefined) {
    if (!driver.webApp) throw new Error('This agent type has no web app to publish');
    if (opts.web.active) {
      const oldBinding = oldWeb;
      const hPort = opts.web.hostPort !== undefined ? String(opts.web.hostPort).trim() : (oldBinding ? String(oldBinding.hostPort) : '');
      // Fixed-port drivers (openclaw gateway 18789) always publish the driver's
      // declared container port — the UI renders it read-only.
      const cPort = opts.web.containerPort !== undefined && driver.webApp.containerPortEditable !== false
        ? Number(opts.web.containerPort)
        : (oldBinding ? oldBinding.containerPort : (driver.webApp.containerPort || 8080));
      if (!/^\d+$/.test(hPort) || +hPort < 1 || +hPort > 65535) {
        throw new Error('Host port must be a number between 1 and 65535');
      }
      if (!Number.isInteger(cPort) || cPort < 1 || cPort > 65535) {
        throw new Error('Container port must be a number between 1 and 65535');
      }
      const newSshCheck = newSshPort || oldSshPort;
      if (newSshCheck && String(newSshCheck) === hPort) {
        throw new Error(`Host port ${hPort} is already the SSH port of this agent`);
      }
      if (await hostPortInUse(hPort, name)) {
        throw new Error(`Host port ${hPort} is already in use by another agent`);
      }
      newWeb = { containerPort: cPort, hostPort: hPort };
      // Effective auth: a provided password wins. Required-auth drivers
      // (openclaw — fails closed on non-loopback binds) keep their existing
      // token when none is given, and refuse to publish without one.
      if (driver.webApp.auth && driver.webApp.auth.required) {
        const given = opts.web.password !== undefined ? String(opts.web.password) : '';
        if (given) {
          newWebPassword = given;
        } else if (!newWebPassword) {
          throw new Error('A gateway token is required to publish this web app (openclaw refuses to listen outside loopback without auth)');
        }
      } else {
        newWebPassword = opts.web.password !== undefined ? String(opts.web.password) : newWebPassword;
      }
    } else {
      newWeb = null;
    }
    webChanged = (oldWeb ? `${oldWeb.hostPort}:${oldWeb.containerPort}` : '')
      !== (newWeb ? `${newWeb.hostPort}:${newWeb.containerPort}` : '')
      || newWebPassword !== oldWebPassword;
  }

  // ── extra ports (full-replace list; conflict-checked vs ssh + web) ──
  const webHostPort = (opts.web !== undefined
    ? (newWeb ? String(newWeb.hostPort) : '')
    : (oldWeb ? String(oldWeb.hostPort) : ''));
  const newPorts = opts.extraPorts !== undefined
    ? validateExtraPorts(opts.extraPorts, { sshPort: newSshPort, webHostPort })
    : oldPorts;
  const portsChanged = JSON.stringify(newPorts) !== JSON.stringify(oldPorts);
  if (opts.extraPorts !== undefined) {
    for (const p of newPorts) {
      if (await hostPortInUse(p.host, name)) {
        throw new Error(`Host port ${p.host} is already in use by another agent`);
      }
    }
  }

  const changed = dockerChanged || networkChanged || workspaceChanged || volumesChanged
    || sshChanged || sshCportChanged || passwordChanged || portsChanged || webChanged;

  const summary = [];
  if (dockerChanged) summary.push(`allowDocker=${newAllow}`);
  if (networkChanged) summary.push(`network=${newNetwork || 'default'}`);
  if (workspaceChanged) summary.push(wsMount ? `workspace=${wsMount.host} → ${wsMount.container}` : 'workspace=default');
  if (volumesChanged) summary.push(`extraVolumes=${newVols.length} mount(s)`);
  if (sshChanged) summary.push(newSshPort ? `ssh=${newSshPort}` : 'ssh=off');
  if (sshCportChanged) summary.push(`ssh container port=${newSshCport}`);
  if (passwordChanged) summary.push('ssh password set');
  if (portsChanged) summary.push(newPorts.length ? `extraPorts=${newPorts.map((p) => `${p.host}→${p.container}`).join(', ')}` : 'extraPorts=none');
  if (webChanged) summary.push(newWeb ? `web=${newWeb.hostPort}→${newWeb.containerPort}` : 'web=off');

  let reason = 'recreate';
  if (webChanged) reason = 'web';
  else if (portsChanged) reason = 'ports';
  else if (dockerChanged) reason = 'docker';
  else if (networkChanged) reason = 'network';
  else if (sshChanged || sshCportChanged || passwordChanged) reason = 'ssh';
  else if (workspaceChanged) reason = 'workspace';
  else if (volumesChanged) reason = 'volumes';

  return {
    instDir, meta, agentType, driver, wasRunning,
    oldAllow, oldNetwork, oldSshPort, oldSshCport, oldRootPw, oldWeb, oldVols, oldPorts, oldMount,
    oldWebPassword,
    newAllow, newNetwork, newSshPort, newSshCport, newRootPw, wsMount, newVols, newPorts, newWeb,
    newWebPassword,
    dockerChanged, networkChanged, sshChanged, sshCportChanged, passwordChanged,
    workspaceChanged, volumesChanged, portsChanged, webChanged,
    changed, summary, reason,
    effectiveWeb: webChanged ? newWeb : oldWeb,
  };
}

/** Apply a consolidated change set (plan 30) — the FULL flow shared by the REST
 *  settings/web/ports/recreate/update routes AND the MCP `recreate` tool:
 *  validate → persist web hook/binding → `applySettings` (regenerates the
 *  compose with ONLY the specified options) → validateInstanceCompose → stop if
 *  running → wipe data dir (reset) / rebuild (pull, docker-CLI, custom SSH
 *  cport) → force-recreate → reconcile the socat door → re-exec the start-web
 *  hook + verify (web publish) → restore the stopped state. Rolls everything
 *  back on failure. Throws with the failure message. */
async function applyAgentChanges(name, opts = {}, { onLog = () => {}, onStep = () => {} } = {}) {
  const ctx = await prepareAgentChanges(name, opts);

  const {
    instDir, agentType, driver, wasRunning,
    oldAllow, oldNetwork, oldSshPort, oldSshCport, oldRootPw,
    oldWeb, oldVols, oldPorts, oldMount,
    newAllow, newNetwork, newSshPort, newSshCport, newRootPw,
    wsMount, newVols, newPorts, newWeb,
    networkChanged, sshChanged, sshCportChanged, passwordChanged, webChanged,
  } = ctx;

  const purePull = !!opts.pull && !ctx.changed && !opts.reset;
  const keepUpThroughBuild = purePull; // pure update keeps the old container up
  let touched = false;
  let runningNow = wasRunning;

  if (!ctx.changed && !opts.pull && !opts.reset) {
    return { ok: true, name, action: 'noop', changed: false, summary: [] };
  }

  try {
    if (ctx.changed) onLog('system', `Applying changes: ${ctx.summary.join(', ')}`);
    else if (opts.reset) onLog('system', 'Resetting the data dir');
    else onLog('system', 'Updating to the latest image');

    // ── 1. persist the web binding + start hook (+ config auth for openclaw) ──
    if (webChanged) {
      const p = webServicePath(name);
      if (newWeb) {
        // Persist the auth token too (webui-owned) — the config file is often
        // root-owned and unreadable by the webui after the agent rewrites it.
        fs.writeFileSync(p, JSON.stringify({
          containerPort: newWeb.containerPort,
          hostPort: String(newWeb.hostPort),
          authToken: driver.webApp.auth && driver.webApp.auth.urlToken ? String(ctx.newWebPassword || '') : '',
        }, null, 2));
        // Patch the config before the recreate (openclaw gateway reads
        // gateway.bind/auth on startup); env-target drivers need nothing here.
        applyWebAuth(name, driver, ctx.newWebPassword);
        onStep('web-hook', 'start');
        writeWebStartHook(name, agentType, buildWebHook(driver, agentType, newWeb, ctx.newWebPassword));
        onStep('web-hook', 'end');
      } else {
        // Unpublish: restore the pre-publish gateway config, drop the hook.
        removeWebAuth(name, driver);
        removeWebStartHook(name, agentType);
        if (fs.existsSync(p)) fs.rmSync(p);
      }
    }

    // ── 2. regenerate the compose (only the specified options) + validate ──
    if (ctx.changed) {
      await applySettings(name, {
        ...(opts.allowDocker !== undefined ? { allowDocker: newAllow } : {}),
        ...(opts.network !== undefined ? { network: newNetwork } : {}),
        ...(opts.workspaceHost !== undefined || opts.workspaceDir !== undefined || ctx.workspaceChanged
          ? { workspaceHost: wsMount ? wsMount.host : '', workspaceDir: wsMount ? wsMount.container : '' }
          : {}),
        ...(opts.extraVolumes !== undefined ? { extraVolumes: newVols } : {}),
        ...(opts.extraPorts !== undefined ? { extraPorts: newPorts } : {}),
        ...(sshChanged ? { sshPort: newSshPort } : {}),
        ...(sshCportChanged ? { sshCport: newSshCport } : {}),
        ...(passwordChanged ? { sshPassword: newRootPw } : {}),
      });
    }
    await validateInstanceCompose(name);

    // ── 3. reset: wipe the data dir (kills the container first) ──
    if (opts.reset) {
      onStep('reset', 'start');
      try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
      const agentDir = path.join(instDir, agentType);
      if (fs.existsSync(agentDir)) fs.rmSync(agentDir, { recursive: true, force: true });
      fs.mkdirSync(agentDir, { recursive: true });
      onStep('reset', 'end');
      runningNow = false;
    }

    // ── 4. stop if running (pure pull/reset keep the old container as-is) ──
    if (runningNow && !keepUpThroughBuild && !opts.reset) {
      touched = true;
      onStep('stop', 'start');
      await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 });
      onStep('stop', 'end');
    }

    // ── 5. leaving peer mode: the door must go BEFORE the agent recreate ──
    if (oldNetwork && !newNetwork) {
      onLog('system', 'Network is default — removing the forwarding door');
      await removeDoors(name, onLog);
    }

    // ── 6. rebuild (pull / docker-CLI / custom SSH cport) or plain recreate ──
    const image = imageFor(name);
    let needRebuild = false;
    if (newAllow && !oldAllow && !(await imageHasDockerCli(name, image, runningNow))) {
      needRebuild = true;
    }
    let sshRebuild = false;
    if (sshCportChanged && newSshCport !== '22' && newSshPort) {
      if (!(await imageHasSshPortSupport(name, image, runningNow))) {
        sshRebuild = ensureSshStartBlock(name);
      }
    }
    let webRebuild = false;
    if (webChanged && newWeb) {
      if (!(await imageHasWebStartSupport(name, image, runningNow))) {
        seedBuildDir(name, agentType, { installDocker: newAllow });
        webRebuild = ensureWebStartBlock(name, agentType);
      }
    }
    const needRebuildFinal = !!opts.pull || needRebuild || sshRebuild || webRebuild;
    if (needRebuildFinal) {
      const why = opts.pull
        ? 'Updating to the latest base image'
        : needRebuild
          ? 'Image has no docker CLI'
          : sshRebuild
            ? 'start.sh must learn the custom SSH container port'
            : 'start.sh must learn the web start hook';
      onLog('system', `${why} — rebuilding the image, then recreating…`);
      await updateAgent(name, { pull: !!opts.pull, onLog, onStep });
    } else {
      onStep('recreate', 'start');
      await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 300000 });
      onStep('recreate', 'end');
    }

    // ── 7. door reconcile (peer mode) ──
    if (newNetwork) {
      await syncDoors(name, {
        forceRecreate: networkChanged || webChanged || ctx.portsChanged || sshChanged,
        log: onLog,
      });
    }

    // ── 8. re-exec the start-web hook + verify a published web app ──
    if (ctx.effectiveWeb && runningNow) {
      onStep('web-verify', 'start');
      const hookPath = `${driver.dataDir}/start-web.sh`;
      await runCmd('docker', ['exec', name, 'bash', hookPath], { timeout: 20000 }).catch(() => {});
      let up = false;
      for (let i = 0; i < 20 && !up; i++) {
        if (await webPortReachable(name, ctx.effectiveWeb.containerPort)) up = true;
        else await new Promise((r) => setTimeout(r, 1000));
      }
      if (up) {
        onLog('system', `Web app re-verified live at http://${process.env.HOST_NAME || 'localhost'}:${ctx.effectiveWeb.hostPort}`);
      } else if (webChanged && newWeb) {
        throw new Error(`Web server did not come up on port ${newWeb.containerPort} (see container web.log)`);
      } else {
        onLog('system', `WARNING: web app not up on port ${ctx.effectiveWeb.containerPort} after the change — re-publish from the Web tab if needed`);
      }
      onStep('web-verify', 'end');
    }

    // ── 9. restore the stopped state (settings changes; pull/reset stay up) ──
    if (!wasRunning && !opts.reset && !opts.pull) {
      try { await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 }); } catch {}
    }

    return {
      ok: true,
      name,
      action: opts.reset ? 'reset' : purePull ? 'updated' : ctx.changed ? 'changed' : 'recreated',
      changed: ctx.changed,
      summary: ctx.summary,
      allowDocker: newAllow,
      network: newNetwork,
      sshPort: newSshPort,
      sshContainerPort: newSshCport,
      workspace: wsMount,
      extraVolumes: newVols,
      extraPorts: newPorts,
      webService: webChanged ? newWeb : oldWeb,
    };
  } catch (e) {
    console.error(`applyAgentChanges failed for ${name}:`, e.message);
    try {
      await rollbackAgentChanges(name, ctx, touched, onLog);
    } catch (rbErr) {
      console.error(`rollback failed for ${name}:`, rbErr.message);
    }
    throw e;
  }
}

/** Undo a failed applyAgentChanges: restore the pre-change compose + web
 *  binding, bring the container back to its original running state, and
 *  reconcile the door (same ordering rule as the happy path — the door must
 *  be gone before an agent recreate when returning to the default network). */
async function rollbackAgentChanges(name, ctx, touched, onLog) {
  const {
    agentType, wasRunning, oldAllow, oldNetwork, oldSshPort, oldSshCport, oldRootPw,
    oldWeb, oldVols, oldPorts, oldMount,
  } = ctx;
  // Restore web.json + hook + gateway config FIRST so the applySettings compose
  // regen (which reads web.json) picks the old binding back up.
  const p = webServicePath(name);
  const driver = getDriver(agentType);
  if (oldWeb) {
    fs.writeFileSync(p, JSON.stringify({ containerPort: oldWeb.containerPort, hostPort: String(oldWeb.hostPort) }, null, 2));
    // The old password is the pre-change one (ctx.oldWebPassword), not the
    // current config value — a failed apply may already have patched it. Keep
    // the saved pre-publish state so a later unpublish still restores the
    // original bind/auth.
    const oldPw = ctx.oldWebPassword || readWebAuth(driver, name);
    applyWebAuth(name, driver, oldPw, { preserveState: true });
    writeWebStartHook(name, agentType, buildWebHook(driver, agentType, oldWeb, oldPw));
  } else {
    removeWebAuth(name, driver);
    removeWebStartHook(name, agentType);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
  await applySettings(name, {
    allowDocker: oldAllow,
    network: oldNetwork,
    workspaceHost: oldMount ? oldMount.host : '',
    workspaceDir: oldMount ? oldMount.container : '',
    extraVolumes: oldVols,
    extraPorts: oldPorts,
    sshPort: oldSshPort,
    sshCport: oldSshCport,
    sshPassword: oldRootPw,
  });
  if (!oldNetwork) await removeDoors(name, onLog);
  if (wasRunning && touched) {
    await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 180000 });
  }
  if (oldNetwork) await syncDoors(name, { forceRecreate: true, log: onLog });
}

/** Recursively replace secret-looking values with '[REDACTED]' in a config
 *  object. Driver-agnostic: covers openclaw/picoclaw/opencode key styles. */
function redactSecrets(obj, depth = 0) {
  if (depth > 8) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactSecrets(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string' && v &&
          /^(api[_-]?key|token|bot[_-]?token|secret|client[_-]?secret|app[_-]?secret|private[_-]?key|access[_-]?token)$/i.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSecrets(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

/** Driver-aware config read, shared by the REST config route and the MCP
 *  `config_get` tool. JSON configs are parsed + secrets redacted;
 *  yaml/toml/text configs are served verbatim. Returns
 *  `{ config, configRaw, configFormat, configFile }`. */
function readAgentConfig(agent) {
  const driver = getDriver(agent.agent_type);
  const base = { configFormat: driver.configFormat || 'json', configFile: driver.configFile || 'openclaw.json' };
  const configPath = path.join(agent.config_root, base.configFile);
  if (!fs.existsSync(configPath)) return { ...base, config: null, configRaw: null };
  if (base.configFormat !== 'json') {
    return { ...base, config: null, configRaw: fs.readFileSync(configPath, 'utf8') };
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { ...base, config: redactSecrets(JSON.parse(JSON.stringify(raw))), configRaw: JSON.stringify(raw, null, 2) };
}

/** One-time migration for PADs created before per-instance build files. Each
 *  instance missing a `build/` dir gets: build dir seeded from the shared
 *  template, the running image retagged into its per-instance tag (no rebuild),
 *  and its compose regenerated + recreated so the container now runs under its
 *  own tag. Idempotent: instances with a build dir are skipped, and the whole
 *  thing re-runs safely (a partially-migrated PAD just continues). */
async function ensureInstanceBuilds({ onLog = () => {} } = {}) {
  const results = { seeded: [], skipped: [], errors: [] };
  if (!fs.existsSync(INSTANCES_DIR)) return results;
  for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const instDir = path.join(INSTANCES_DIR, name);
    const meta = readMeta(instDir);
    const agent = meta.AGENT || 'openclaw';
    if (!fs.existsSync(buildTemplateDir(agent))) {
      results.skipped.push(`${name} (no template for '${agent}')`);
      continue;
    }
    if (fs.existsSync(buildDir(name))) {
      results.skipped.push(name);
      continue;
    }
    try {
      const allowDocker = meta.DOCKER === '1';
      seedBuildDir(name, agent, { installDocker: allowDocker });
      onLog('system', `[migrate] seeded build dir for ${name}`);

      // Retag, don't rebuild — the running image is preserved instantly.
      try {
        await runCmd('docker', ['tag', legacySharedImage(agent), imageFor(name)], { timeout: 30000 });
        onLog('system', `[migrate] retagged ${legacySharedImage(agent)} → ${imageFor(name)}`);
      } catch (e) {
        onLog('system', `[migrate] retag skipped for ${name} (${e.message})`);
      }

      // Regenerate the compose with the per-instance context + image + args,
      // preserving the network peer, web binding and SSH port.
      const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
      const port = meta.PORT || '';
      const network = meta.NETWORK || '';
      const webService = readWebService(name);
      let webPeerNetwork = '';
      if (webService && network) webPeerNetwork = await getPeerNetworkName(network);
      writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });

      // Recreate only when the container exists; leave stopped agents stopped.
      let running = false;
      try {
        const r = await runCmd('docker', ['inspect', name, '--format', '{{.State.Status}}'], { timeout: 15000 });
        running = (r.stdout || '').trim() === 'running';
      } catch {}
      if (running) {
        await runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog, timeout: 180000 });
        onLog('system', `[migrate] recreated ${name} under ${imageFor(name)}`);
      }
      results.seeded.push(name);
    } catch (e) {
      results.errors.push({ name, error: e.message });
    }
  }
  return results;
}

module.exports = {
  createVm, removeVm, resetVm, readMeta,
  generateInstanceCompose, writeInstanceCompose,
  applySettings, updateAgent, recreateAgent, setMetaFlag,
  instanceComposePath, getComposePath,
  getNetworkHealth,
  existingServices, startAgent, stopAgent, restartAgent,
  readAgentConfig, redactSecrets, listDoors, startDoors, stopDoors,
  readWebService, applyWebServices, webHookPath, buildWebHook,
  writeWebStartHook, removeWebStartHook, doorName, doorPorts, desiredDoors,
  readWebAuth, applyWebAuth, removeWebAuth,
  validateWorkspaceMount, workspaceMountInfo, readWorkspaceMount,
  validateExtraVolume, validateExtraVolumes, validateExtraPorts,
  readExtraVolumes, readExtraPorts, readSshCport, ensureSshStartBlock, autoSshPort,
  imageHasDockerCli, imageHasSshPortSupport,
  imageFor, seedBuildDir, buildDir, buildEnvPath,
  readBuildEnv, setBuildEnv,
  argsFromDockerfile,
  composeCommand, runCompose, validateInstanceCompose, ensureInstanceBuilds,
  // plan 30 consolidated surface (shared by REST routes + MCP tools)
  readSettings, readWebState, containerInfo, listContainers,
  prepareAgentChanges, applyAgentChanges,
  validateAgentCreate, createAgent, hostPortInUse,
  INSTANCES_DIR, PREFIX, PREFIX_RE, VM_NAME_RE,
  HOST_WORKSPACE, WORKSPACE,
};
