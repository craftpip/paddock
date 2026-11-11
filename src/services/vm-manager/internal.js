/**
 * Paths, naming rules and small helpers every vm-manager module shares.
 * Nothing here requires a sibling module, so every sibling can load it first.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  readMeta, dockerNetworkExists, setMetaFlag, runCmd, instanceComposePath, dockerVolumeExists,
});

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const drivers = require('../drivers');
const { ensureOwned } = require('../ownership');

const { getDriver, getDriverOr, hasDriver } = drivers;
// The agent-type REGISTRY (type → driver module). `drivers` above is the
// module (resolvers + helpers), NOT the registry, so `Object.keys(drivers)`
// names the module's exports — which silently made every "is this an agent
// type?" check built on it match nothing. The door-sweep's "holds agent data
// dir" guard was one of them: it looked for a dir named after an agent type
// and found none, so a legacy door dir that still held an agent's data was
// quarantined instead of skipped.
const AGENT_TYPES = Object.keys(drivers.drivers);

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const HOST_WORKSPACE = process.env.HOST_WORKSPACE_ROOT || WORKSPACE;
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const PREFIX = process.env.CONTAINER_PREFIX || 'pad';
const PREFIX_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-');
const VM_NAME_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-zA-Z0-9][a-zA-Z0-9_-]*$');
// The control-plane container itself (docker-compose.yml `container_name`) —
// never a network peer for a pad.
const WEBUI_CONTAINER = process.env.WEBUI_CONTAINER_NAME || 'paddock';

// Shared build-template root (`src/vm-builds/<type>/`). Read-only template
// source: copied into `instances/<name>/build/` at create/clone/migrate time.
const BUILD_TEMPLATES_DIR = path.join(__dirname, '..', '..', 'vm-builds');

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

/** YAML-safe scalar for user-provided paths (compose values). Always quoted so
 *  spaces/colons in a path can never break the generated YAML. */
function yamlScalar(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The SSH daemon's port INSIDE the container (default 22). Stored in meta as
 *  SSH_CPORT when it differs — an explicit field because agents that share a
 *  network namespace (peer mode) can't ALL bind 22; each must pick a distinct
 *  one. Falls back to 22 whenever unset/corrupt. */
const DEFAULT_SSH_CPORT = '22';

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
      ensureOwned(metaPath);
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
  ensureOwned(metaPath);
}

/** Marker that a web hook carries the plan-89 user-mode drop. Used by the
 *  backfill (`ensureWebHookUserDrop`) to detect a hook generated before it. */
const WEB_USER_DROP_MARKER = 'PAD WEB USER DROP (plan 89)';

Object.assign(exports, { INSTANCES_DIR, HOST_WORKSPACE, WORKSPACE, getDriver, BUILD_TEMPLATES_DIR, DEFAULT_SSH_CPORT, PREFIX_RE, getDriverOr, WEB_USER_DROP_MARKER, PREFIX, VM_NAME_RE, hasDriver, AGENT_TYPES, WEBUI_CONTAINER });
