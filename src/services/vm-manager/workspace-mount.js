/**
 * Workspace and extra-volume mounts: where they point, what may be mounted, and
 * the guards that refuse a dangerous one.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  containerViewOf, validateExtraVolume, readExtraVolumes, readWorkspaceMount,
  validateWorkspaceMount, validateExtraVolumes, workspaceMountInfo, webuiMountViewOf,
});

const fs = require('fs');
const path = require('path');
const { guard, hostSourceIssue } = require('../workspace-guards');
const { HOST_WORKSPACE, WORKSPACE, getDriver, readMeta, INSTANCES_DIR } = require('./internal');

// ─── Custom workspace mount (plan 24) ────────────────────────

// Host dirs that must never be bound as a workspace source, and the home /
// scratch dirs whose BARE root is refused but whose subdirectories are fine,
// both live in ./workspace-guards (plan 72) so the create path, the
// settings-apply path, the probe and the form cannot disagree about them.
// Container paths (and descendants) that must never be bound as a workspace
// destination. NOTE: /root and /opt are intentionally NOT here — every
// supported driver keeps its data dir below one of them.
const CONTAINER_PROTECTED = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp'];

/** Recompute the visibility flags for a stored workspace mount. hostBrowsable
 *  means the source lives inside this agent's data directory on the host
 *  (`instances/<name>/<agent>`), the only source the host-scope file browser
 *  clamp can safely reach. webuiVisible means the source is under the project
 *  root (HOST_WORKSPACE). Shared by create/settings/registry so every consumer
 *  derives the same flags from the same stored metadata.
 *
 *  `hostBrowseReason` exists because the flag itself was unexplainable: three
 *  pads sampled, three `hostBrowsable: false`, including one that IS the paddock
 *  repo and has a read-write bind mount. A caller could not tell a POLICY
 *  decision from a CAPABILITY limit, and those need different next moves.
 *  Two distinct refusals, therefore two distinct sentences.
 *
 *  `allowHostBrowse` is the explicit per-pad opt-in (meta HOST_BROWSE=1, the
 *  user's decision for the paddock repo pad). It is deliberately NOT implied by
 *  `webuiVisible`: the webui can reach the whole project root, but a pad pointed
 *  at a subfolder of it should not silently gain host-browse over the mount's
 *  parent. Opt in per pad, and the clamp root follows (see agent-registry
 *  `host_browse_root`) — otherwise the flag would clear and the write would
 *  still be rejected as a traversal. */
function workspaceMountInfo(name, agent, host, container, { allowHostBrowse = false } = {}) {
  const hostNorm = path.normalize(String(host));
  const agentDataHost = path.join(HOST_WORKSPACE, 'instances', name, agent);
  const insideDataDir = hostNorm === agentDataHost || hostNorm.startsWith(agentDataHost + path.sep);
  const insideProject = hostNorm === HOST_WORKSPACE || hostNorm.startsWith(HOST_WORKSPACE + path.sep);
  // The opt-in may only grant what is GRANTABLE. `HOST_BROWSE=1` on a mount the
  // webui cannot see on the host used to clear `hostBrowsable` and then leave
  // `host_browse_root` falling back to the data dir — the gate said yes and the
  // action silently browsed somewhere else, which is the gate-then-act split one
  // level down. An opt-in is permission, not capability, and only ever adds to
  // what the platform can already do.
  const grantable = insideProject;
  let hostBrowsable = insideDataDir || (allowHostBrowse && grantable);
  let hostBrowseReason = null;
  if (!hostBrowsable) {
    hostBrowseReason = !insideProject
      ? 'workspace is mounted from a folder outside both this PAD\'s folder and the project root, so the webui cannot reach it on the host. Use the container workspace while the agent is running.'
      : 'workspace mounted from a folder inside the project root but outside this PAD\'s own folder — host browsing is off for this PAD. Set HOST_BROWSE=1 in its meta.env to allow it.';
  }
  return {
    host: hostNorm,
    container: path.normalize(String(container)),
    webuiVisible: insideProject,
    hostBrowsable,
    // Always emitted, including when null, so a caller can distinguish "no
    // reason recorded" from "reason not implemented" — and so the field's
    // presence is a contract rather than an accident of truthiness.
    hostBrowseReason: hostBrowseReason,
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

/** Resolve a PAD container path against the webui's ACTUAL bind mounts.
 *  Returns { view, readonly } where `view` is the webui container path for the
 *  given pad path, and `readonly` is true if the covering mount is ro.
 *  Uses the webui's own /proc/self/mountinfo — sources there are daemon-resolved
 *  and unreliable for matching, so we match on MOUNTPOINTS (the webui's own
 *  container paths). A pad whose WORKSPACE_DIR spells the same folder the webui
 *  mounts (e.g. both /www1) will match directly. Longest mountpoint prefix wins. */
function webuiMountViewOf(padContainerPath) {
  const p = path.normalize(String(padContainerPath));
  let best = null;
  try {
    const mountinfo = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    for (const line of mountinfo.split('\n')) {
      if (!line.trim()) continue;
      const dash = line.indexOf(' - ');
      if (dash === -1) continue;
      const head = line.slice(0, dash).split(/\s+/);
      const tail = line.slice(dash + 3).split(/\s+/);
      if (head.length < 6 || tail.length < 2) continue;
      const mountpoint = head[4];
      const options = head[5];
      const fstype = tail[0];
      const source = tail[1];
      if (!source.startsWith('/')) continue;
      const excluded = new Set(['overlay', 'proc', 'sysfs', 'devpts', 'cgroup', 'cgroup2', 'mqueue', 'tmpfs', 'shm', 'hugetlbfs', 'autofs', 'fuse']);
      if (excluded.has(fstype)) continue;
      if (p === mountpoint || p.startsWith(mountpoint + '/')) {
        if (!best || mountpoint.length > best.mountpoint.length) {
          best = { mountpoint, readonly: options.split(',').includes('ro') };
        }
      }
    }
  } catch {
    return null;
  }
  if (!best) return null;
  const rel = p === best.mountpoint ? '' : p.slice(best.mountpoint.length + 1);
  return { view: path.join(best.mountpoint, rel), readonly: best.readonly };
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

  const srcIssue = hostSourceIssue(host);
  if (srcIssue) throw new Error(srcIssue.message);
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

/** Read the persisted custom workspace mount (meta.env WORKSPACE_HOST/WORKSPACE_DIR)
 *  and return its normalized info, or null when not configured. A corrupt/stale
 *  stored PAIR is ignored by compose generation (the Settings tab validates
 *  before writing, and writeInstanceCompose uses the already-validated value).
 *
 *  The agent TYPE is resolved OUTSIDE that tolerance on purpose. It is the
 *  function's input contract, not part of the stored pair: swallowing an
 *  unresolvable type here would answer null — "this pad has no workspace mount"
 *  — and the pad would come up on the driver's default workspace, which is
 *  exactly the silent substitution this resolution is meant to prevent. */
function readWorkspaceMount(name, agent) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.WORKSPACE_HOST || !meta.WORKSPACE_DIR) return null;
  getDriver(agent);
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

  const volIssue = hostSourceIssue(host, { noun: 'host source' });
  if (volIssue) throw new Error(volIssue.message);
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
