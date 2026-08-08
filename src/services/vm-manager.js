const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { runCmdStream } = require('./cmd');
const { getDriver } = require('./drivers');
const { imageFor, legacySharedImage, buildDir, buildEnvPath, readBuildEnv, setBuildEnv, argsFromDockerfile } = require('./instance-image');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const HOST_WORKSPACE = process.env.HOST_WORKSPACE_ROOT || WORKSPACE;
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const PREFIX = process.env.CONTAINER_PREFIX || 'vm';
const PREFIX_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-');

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

function generateInstanceCompose(name, agent, password, port, opts = {}) {
  const { allowDocker = false, network = '', webService = null, webPeerNetwork = '' } = opts;
  const driver = getDriver(agent);
  const image = imageFor(name);
  const dataDir = driver.dataDir;

  let yaml = 'services:\n';
  yaml += `  ${name}:\n`;
  yaml += `    build:\n`;
  // Build context must be resolvable by the docker CLI, which runs INSIDE the
  // webui container → use WORKSPACE (the container's /workspace view). Each
  // PAD builds from its OWN build dir — nothing is shared between PADs.
  yaml += `      context: ${path.resolve(WORKSPACE, 'instances', name, 'build')}\n`;
  // The compose `build.args:` block is generated from the instance Dockerfile's
  // `ARG` lines so build-file edits are self-describing: add/remove an ARG in
  // the Dockerfile → next compose regen picks it up; change its value in
  // build.env → next build applies it with zero compose regeneration.
  const args = argsFromDockerfile(path.join(INSTANCES_DIR, name, 'build', 'Dockerfile'));
  if (args.length) {
    yaml += `      args:\n`;
    for (const a of args) {
      yaml += `        ${a.name}: ${a.default ? `\${${a.name}:-${a.default}}` : `\${${a.name}}`}\n`;
    }
  }
  yaml += `    image: ${image}\n`;
  yaml += `    container_name: ${name}\n`;
  yaml += `    restart: unless-stopped\n`;
  // Published ports: SSH (hostPort:22) + optional published web app. Docker
  // CANNOT publish ports while the container shares another container's network
  // stack (network_mode: container:) — in that case the agent gets no ports:
  // block and any web app is exposed via the socat "door" service below.
  const portLines = [];
  const peerMode = !!network;
  if (!peerMode) {
    if (port) portLines.push(`      - "${port}:22"`);
    if (webService && webService.hostPort) {
      portLines.push(`      - "${webService.hostPort}:${webService.containerPort}"`);
    }
  }
  if (portLines.length) yaml += `    ports:\n${portLines.join('\n')}\n`;
  // Volume sources are resolved by the Docker DAEMON → use HOST_WORKSPACE
  // (the daemon's host view, e.g. /www2/paddock).
  yaml += `    volumes:\n      - ${HOST_WORKSPACE}/instances/${name}/${agent}:${dataDir}\n`;
  if (allowDocker) yaml += `      - /var/run/docker.sock:/var/run/docker.sock\n`;
  if (network) yaml += `    network_mode: container:${network}\n`;
  yaml += `    environment:\n      TZ: Asia/Kolkata\n      ROOT_PASSWORD: ${password || ''}\n`;

  // Web door: when the agent shares a peer's network stack, published ports are
  // impossible on the agent itself. A tiny socat "door" container joins the
  // peer's docker network, publishes the host port, and forwards to the peer by
  // name — the agent's web server binds inside the peer's namespace, so it's
  // reachable at <peer>:<containerPort>. Resolving by name per connection means
  // the door survives peer recreates without any change of its own.
  if (peerMode && webService && webService.hostPort) {
    const door = webDoorName(name);
    yaml += `  ${door}:\n`;
    yaml += `    image: alpine/socat\n`;
    yaml += `    container_name: ${door}\n`;
    yaml += `    restart: unless-stopped\n`;
    if (webPeerNetwork) {
      yaml += `    networks:\n      - webbridge\n`;
      yaml += `    ports:\n      - "${webService.hostPort}:${webService.containerPort}"\n`;
      yaml += `    command: TCP-LISTEN:${webService.containerPort},fork,reuseaddr TCP:${network}:${webService.containerPort}\n`;
      yaml += `networks:\n  webbridge:\n    external: true\n    name: ${webPeerNetwork}\n`;
    } else {
      // Peer shares the host network (no docker network to join) → the door
      // runs on the host network and forwards to localhost instead.
      yaml += `    network_mode: host\n`;
      yaml += `    command: TCP-LISTEN:${webService.hostPort},fork,reuseaddr TCP:127.0.0.1:${webService.containerPort}\n`;
    }
  }
  return yaml;
}

function writeInstanceCompose(name, agent, password, port, opts = {}) {
  const yaml = generateInstanceCompose(name, agent, password, port, opts);
  const composePath = instanceComposePath(name);
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(composePath, yaml);
}

/** Set or clear one KEY=VALUE line in an instance's meta.env (preserves the rest). */
function setMetaFlag(name, key, value) {
  const metaPath = path.join(INSTANCES_DIR, name, 'meta.env');
  let content = fs.existsSync(metaPath) ? fs.readFileSync(metaPath, 'utf8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
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
  const allowDocker = !!opts.allowDocker;
  const network = opts.network || '';
  const webService = readWebService(name);

  seedBuildDir(name, agent, { installDocker: allowDocker });

  let webPeerNetwork = '';
  if (webService && network) {
    webPeerNetwork = await getPeerNetworkName(network);
  }

  writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });
  setMetaFlag(name, 'DOCKER', allowDocker ? '1' : '0');
  setMetaFlag(name, 'NETWORK', network);

  return {
    allowDocker,
    network,
    image: imageFor(name),
    agent,
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
    fs.writeFileSync(p, JSON.stringify({ containerPort: webService.containerPort, hostPort: webService.hostPort }, null, 2));
  } else if (fs.existsSync(p)) {
    fs.rmSync(p);
  }

  let webPeerNetwork = '';
  if (webService && network) {
    webPeerNetwork = await getPeerNetworkName(network);
  }

  writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });
  return { agent, webService: webService || null };
}

/** Container name of the socat "door" that publishes a peer-networked agent's
 *  web app on a host port. */
function webDoorName(name) {
  return `${name}-web`;
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
  const args = composeCommand(name, 'build');
  if (pull) args.push('--pull');
  for (const ba of buildArgs) args.push('--build-arg', ba);
  args.push(name);
  onStep('build', 'start');
  try {
    await runCmdStream('docker', args, { onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    throw e;
  }
  onStep('build', 'end');

  onStep('recreate', 'start');
  try {
    await runCmdStream('docker', composeCommand(name, 'up', '-d', '--no-deps', '--force-recreate', name), { onLog, timeout: 300000 });
  } catch (e) {
    onStep('recreate', 'error');
    throw e;
  }
  onStep('recreate', 'end');
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
    sshEnabled = false, port = '', password = '',
    onLog = () => {}, onStep = () => {}, skipSetup = false,
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
    if (port) {
      finalPort = port;
    } else {
      const used = new Set();
      if (fs.existsSync(INSTANCES_DIR)) {
        for (const entry of fs.readdirSync(INSTANCES_DIR, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const composeFile = path.join(INSTANCES_DIR, entry.name, 'docker-compose.yml');
          if (fs.existsSync(composeFile)) {
            for (const m of fs.readFileSync(composeFile, 'utf8').matchAll(/"(\d+):22"/g)) {
              used.add(parseInt(m[1]));
            }
          }
        }
      }
      let p = 43817;
      while (used.has(p)) p++;
      finalPort = String(p);
    }
  }

  const workspaceDir = path.join(instDir, agent);
  fs.mkdirSync(workspaceDir, { recursive: true });
  onLog('system', `Created instance directory: ${instDir}`);

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
        const dstPath = path.join(workspaceDir, entry);
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
  } else {
    seedBuildDir(name, agent);
  }

  let metaTxt = `ROOT_PASSWORD=${pw}\nAGENT=${agent}\n`;
  if (finalPort) metaTxt += `PORT=${finalPort}\n`;
  fs.writeFileSync(path.join(instDir, 'meta.env'), metaTxt);

  writeInstanceCompose(name, agent, pw, finalPort);

  const composePath = instanceComposePath(name);

  onStep('build', 'start');
  try {
    await runCmdStream('docker', composeCommand(name, 'build'), { onLog, timeout: 900000 });
  } catch (e) {
    onStep('build', 'error');
    throw e;
  }
  onStep('build', 'end');

  onStep('up', 'start');
  try {
    await runCmdStream('docker', composeCommand(name, 'up', '-d'), { onLog, timeout: 300000 });
  } catch (e) {
    onStep('up', 'error');
    throw e;
  }
  onStep('up', 'end');

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

async function removeVm(name) {
  try { await runCmd('docker', ['rm', '-f', name], { timeout: 30000 }); } catch {}
  try { await runCmd('docker', ['network', 'rm', `${name}_default`], { timeout: 30000 }); } catch {}
  const instDir = path.join(INSTANCES_DIR, name);
  if (fs.existsSync(instDir)) fs.rmSync(instDir, { recursive: true, force: true });
  // The per-instance image is this PAD's own tag — drop it too, otherwise every
  // create/delete cycle leaks a paddock-vm-<name>:latest image.
  try { await runCmd('docker', ['rmi', imageFor(name)], { timeout: 30000 }); } catch {}
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
  seedBuildDir(name, agent, { installDocker: meta.DOCKER === '1' });
  writeInstanceCompose(name, agent, pw, port);

  const composePath = instanceComposePath(name);
  await runCmd('docker', composeCommand(name, 'up', '-d'), { timeout: 120000 });
}

function getComposePath(name) {
  return instanceComposePath(name);
}

async function startAgent(name) {
  const composePath = getComposePath(name);
  try {
    await runCmd('docker', ['start', name], { timeout: 30000 });
  } catch {
    await runCmd('docker', composeCommand(name, 'up', '-d'), { timeout: 180000 });
  }
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
        await runCmdStream('docker', composeCommand(name, 'up', '-d', '--no-deps', '--force-recreate', name), { onLog, timeout: 180000 });
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
  applySettings, updateAgent, setMetaFlag,
  instanceComposePath, getComposePath,
  getNetworkHealth,
  existingServices, startAgent,
  readWebService, applyWebServices, webHookPath,
  writeWebStartHook, removeWebStartHook, webDoorName,
  imageFor, seedBuildDir, buildDir, buildEnvPath,
  readBuildEnv, setBuildEnv,
  argsFromDockerfile,
  composeCommand, ensureInstanceBuilds,
  INSTANCES_DIR, PREFIX, PREFIX_RE,
};
