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
 *  absent/corrupt. Never throws. Entries are normalized (strings, no bools). */
function readExtraVolumes(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.EXTRA_VOLUMES) return [];
  try {
    const arr = JSON.parse(meta.EXTRA_VOLUMES);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((v) => v && v.host && v.container)
      .map((v) => ({
        host: path.normalize(String(v.host)),
        container: path.normalize(String(v.container)),
        readonly: !!v.readonly,
      }));
  } catch {
    return [];
  }
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

/** Validate ONE extra host→container bind (plan 28). Returns the normalized
 *  `{ host, container, readonly }` or throws. Mirrors the workspace-mount
 *  guards: host must not be a system dir / project root / src / instances /
 *  another agent's folder / a parent-or-self of this agent's data dir; the
 *  container path must not be a protected system path or a parent-or-self of
 *  the driver data dir (descendant subfolders ARE allowed). */
function validateExtraVolume(name, agent, hostPath, container, readonly) {
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

  // ── Host source ──
  if (hostRaw === '/') throw new Error('An extra volume host source cannot be the host root');
  if (hostRaw.split('/').some((s) => s === '.' || s === '..')) {
    throw new Error('"." and ".." path segments are not allowed in the host source');
  }
  if (hostRaw.includes(':')) {
    throw new Error('The host source cannot contain ":"');
  }
  let host;
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

  return { host, container: dir, readonly: !!readonly };
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
    const vol = validateExtraVolume(name, agent, v.host, v.container, v.readonly);
    const key = `${vol.host}\u0000${vol.container}`;
    if (seen.has(key)) throw new Error(`Duplicate extra volume mount ${vol.host} → ${vol.container}`);
    seen.add(key);
    out.push(vol);
  }
  return out;
}

/** Validate a list of extra host→container port mappings. Returns the
 *  normalized `[{ host, container }]` array or throws. Pure checks only: int
 *  bounds, self-duplicates, SSH/web-port conflicts, and the peer-mode ban. The
 *  async cross-agent `hostPortInUse` check lives in the route layer. */
function validateExtraPorts(ports, opts = {}) {
  const { sshPort = '', webHostPort = '', network = '' } = opts;
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
  if (network && out.length) {
    throw new Error(`Docker cannot publish ports while this agent joins ${network}'s network — clear the network override or remove the extra ports`);
  }
  return out;
}

/** Smallest unused SSH host port starting at 43817 (the same scan createVm
 *  uses to auto-allocate an SSH port when "Expose SSH" is on without a port). */
function autoSshPort() {
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
    if (port) ports.push(`${port}:22`);
    if (webService?.hostPort) ports.push(`${webService.hostPort}:${webService.containerPort}`);
    for (const p of readExtraPorts(name)) ports.push(`${p.host}:${p.container}`);
  }
  if (ports.length) service.ports = ports;
  if (wsMount) {
    volumes.push(`${wsMount.host}:${wsMount.container}`);
    service.working_dir = wsMount.container;
  }
  if (allowDocker) volumes.push('/var/run/docker.sock:/var/run/docker.sock');
  for (const v of readExtraVolumes(name)) {
    volumes.push(`${v.host}:${v.container}${v.readonly ? ':ro' : ''}`);
  }
  if (network) service.network_mode = `container:${network}`;
  service.environment = { TZ: 'Asia/Kolkata', ROOT_PASSWORD: password || '' };

  const services = { [name]: service };
  let networks;
  if (peerMode && webService?.hostPort) {
    const door = webDoorName(name);
    if (webPeerNetwork) {
      services[door] = {
        image: 'alpine/socat',
        container_name: door,
        restart: 'unless-stopped',
        networks: ['webbridge'],
        ports: [`${webService.hostPort}:${webService.containerPort}`],
        command: `TCP-LISTEN:${webService.containerPort},fork,reuseaddr TCP:${network}:${webService.containerPort}`,
      };
      networks = { webbridge: { external: true, name: webPeerNetwork } };
    } else {
      services[door] = {
        image: 'alpine/socat',
        container_name: door,
        restart: 'unless-stopped',
        network_mode: 'host',
        command: `TCP-LISTEN:${webService.hostPort},fork,reuseaddr TCP:127.0.0.1:${webService.containerPort}`,
      };
    }
  }

  // JSON is valid YAML. Serializing the structured compose model avoids fragile
  // hand-built YAML where a Compose interpolation such as `${VAR:-default}`
  // can be parsed as YAML syntax.
  return JSON.stringify({ services, ...(networks ? { networks } : {}) }, null, 2) + '\n';
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
      sshPort: meta.PORT || '',
      network,
    });
    setMetaFlag(name, 'EXTRA_PORTS', ports.length ? JSON.stringify(ports) : '');
  }

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
  const extraPs = validateExtraPorts(extraPorts, { sshPort: finalPort, network });

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

  writeInstanceCompose(name, agent, pw, finalPort, { allowDocker, network });

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
  const allowDocker = meta.DOCKER === '1';
  const network = meta.NETWORK || '';
  seedBuildDir(name, agent, { installDocker: allowDocker });
  // Preserve the COMPLETE persisted binding set (plan 28 fix): docker, network
  // peer, published web app (+ its door), custom workspace, and the extra
  // volumes/ports in meta — the compose generator reads them all from meta, so
  // resetting the data dir must never silently drop a bind.
  const webService = readWebService(name);
  let webPeerNetwork = '';
  if (webService && network) webPeerNetwork = await getPeerNetworkName(network);
  writeInstanceCompose(name, agent, pw, port, { allowDocker, network, webService, webPeerNetwork });

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
  validateWorkspaceMount, workspaceMountInfo, readWorkspaceMount,
  validateExtraVolume, validateExtraVolumes, validateExtraPorts,
  readExtraVolumes, readExtraPorts, autoSshPort,
  imageFor, seedBuildDir, buildDir, buildEnvPath,
  readBuildEnv, setBuildEnv,
  argsFromDockerfile,
  composeCommand, ensureInstanceBuilds,
  INSTANCES_DIR, PREFIX, PREFIX_RE,
  HOST_WORKSPACE, WORKSPACE,
};
