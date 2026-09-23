/**
 * Development Container Specification support (plan 41).
 *
 * A workspace's `.devcontainer/devcontainer.json` (per the spec's file
 * precedence) is the portable, version-controllable mirror of a pad: its
 * lifecycle commands, workspace folder, environment, mounts, run args, ports
 * and user. This module is the single source of truth for:
 *   - finding + parsing a workspace devcontainer.json (spec precedence),
 *   - joining the spec's command forms (string | array | object) into a shell
 *     script body,
 *   - generating a `.devcontainer/devcontainer.json` from a pad's effective
 *     config (marked `x-paddock.generated`),
 *   - write-back sync of the 1:1 mapped fields into an existing file (project-
 *     authored files keep every non-mapped field).
 *
 * It must stay dependency-free (fs/path only) so vm-manager, the create form
 * and the Settings UI can require it without circular imports.
 */

const fs = require('fs');
const path = require('path');

const DEV_CONTAINER = '.devcontainer';
const DEV_CONTAINER_JSON = 'devcontainer.json';
const ROOT_DEV_CONTAINER_JSON = '.devcontainer.json';

/** Spec file precedence (lowest → highest): `devcontainer.json` beside a
 *  `devcontainer.json`-containing subfolder of `.devcontainer/`, then the
 *  `.devcontainer/devcontainer.json`, then the repo-root `.devcontainer.json`.
 *  Per the spec, `.devcontainer.json` at the root wins over `.devcontainer/`. */
function findDevContainerFile(dir) {
  if (!dir) return null;
  const candidates = [];
  const devDir = path.join(dir, DEV_CONTAINER);
  try {
    for (const entry of fs.readdirSync(devDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const nested = path.join(devDir, entry.name, DEV_CONTAINER_JSON);
        if (fs.existsSync(nested)) candidates.push(nested);
      }
    }
  } catch {}
  const main = path.join(devDir, DEV_CONTAINER_JSON);
  if (fs.existsSync(main)) candidates.push(main);
  const root = path.join(dir, ROOT_DEV_CONTAINER_JSON);
  if (fs.existsSync(root)) candidates.push(root);
  return candidates.length ? candidates[candidates.length - 1] : null;
}

/** True when a directory contains any devcontainer file (for UI badges). */
function hasDevContainer(dir) {
  return !!findDevContainerFile(dir);
}

/** Join a spec command value (string | array of strings | object of
 *  label→command) into a shell script body. Unknown shapes fall back to ''. */
function joinCommand(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim())
      .join('\n');
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .filter((v) => typeof v === 'string' && v.trim())
      .map((v) => v.trim())
      .join('\n');
  }
  return '';
}

/** Parse a devcontainer.json file into a normalized field set. Returns null
 *  when the file doesn't exist or isn't valid JSON. */
function parseDevContainer(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const build = raw.build;
  const resolvedBuild = typeof build === 'string'
    ? { dockerfile: build }
    : (build && typeof build === 'object' ? build : null);
  const dockerFile = resolvedBuild
    ? String(resolvedBuild.dockerfile || '')
    : '';
  // `build.context` defaults to the directory containing the Dockerfile per
  // the spec; resolve a bare filename against the devcontainer file's dir.
  const context = resolvedBuild && resolvedBuild.context
    ? String(resolvedBuild.context)
    : (dockerFile && !dockerFile.startsWith('/')
      ? path.dirname(filePath)
      : '');
  const image = raw.image
    ? String(raw.image)
    : (resolvedBuild && !dockerFile ? String(resolvedBuild.image || '') : '');
  const buildContext = context
    ? (context.startsWith('/') ? context : path.join(path.dirname(filePath), context))
    : '';

  const mountArray = [];
  if (Array.isArray(raw.mounts)) {
    for (const m of raw.mounts) {
      if (typeof m === 'string') {
        const parts = m.split(':');
        if (parts.length >= 2) {
          mountArray.push({
            host: parts[0],
            container: parts[1],
            readonly: parts[2] === 'ro',
          });
        }
      } else if (m && typeof m === 'object') {
        mountArray.push({
          host: String(m.source ?? m.src ?? ''),
          container: String(m.target ?? m.dst ?? ''),
          readonly: !!(m.readOnly || m.readonly),
        });
      }
    }
  }

  const runArgs = Array.isArray(raw.runArgs)
    ? raw.runArgs.map(String)
    : (typeof raw.runArgs === 'string' ? [raw.runArgs] : []);
  const forwardPorts = Array.isArray(raw.forwardPorts)
    ? raw.forwardPorts.map(String)
    : [];

  const parsed = {
    filePath,
    name: raw.name ? String(raw.name) : '',
    raw,
    generated: !!(raw['x-paddock'] && raw['x-paddock'].generated),
    postCreateCommand: joinCommand(raw.postCreateCommand),
    onCreateCommand: joinCommand(raw.onCreateCommand),
    updateContentCommand: joinCommand(raw.updateContentCommand),
    postStartCommand: joinCommand(raw.postStartCommand),
    postAttachCommand: joinCommand(raw.postAttachCommand),
    workspaceFolder: raw.workspaceFolder ? String(raw.workspaceFolder) : '',
    image,
    dockerFile,
    buildContext,
    features: raw.features && typeof raw.features === 'object' ? raw.features : {},
    environment: raw.environment && typeof raw.environment === 'object' ? raw.environment : {},
    mounts: mountArray,
    runArgs,
    forwardPorts,
    portsAttributes: raw.portsAttributes && typeof raw.portsAttributes === 'object' ? raw.portsAttributes : {},
    remoteUser: raw.remoteUser ? String(raw.remoteUser) : '',
    containerUser: raw.containerUser ? String(raw.containerUser) : '',
    // Effective user the devcontainer wants to run as (containerUser wins over
    // remoteUser per spec). Maps onto the pad's USER_MODE: a non-root user →
    // 'user' (run as the pad user, PUID/PGID), explicit root/0 → 'root',
    // absent → '' (no preference — the pad's own toggle stays authoritative).
    preferredUser: String(raw.containerUser || raw.remoteUser || '').trim(),
  };
  parsed.preferredUserMode = parsed.preferredUser && parsed.preferredUser !== 'root' && parsed.preferredUser !== '0'
    ? 'user'
    : (parsed.preferredUser ? 'root' : '');
  return parsed;
}

/** Find + parse the devcontainer.json in a workspace dir (spec precedence). */
function readDevContainer(dir) {
  const f = findDevContainerFile(dir);
  return f ? parseDevContainer(f) : null;
}

/** Generate a devcontainer.json for a pad from its effective config. Returns
 *  the file content. Marked `x-paddock.generated` so it can be recognized and
 *  regenerated. */
function generateDevContainer({ workspaceFolder = '/workspace', postCreate = '', postStart = '', postAttach = '', environment = {}, mounts = [], runArgs = [], forwardPorts = [], portsAttributes = {}, remoteUser = '' } = {}) {
  const doc = {
    name: 'Paddock agent workspace',
    workspaceFolder: workspaceFolder || '/workspace',
    'x-paddock': { generated: true },
  };
  if (postCreate) doc.postCreateCommand = postCreate;
  if (postStart) doc.postStartCommand = postStart;
  if (postAttach) doc.postAttachCommand = postAttach;
  if (environment && Object.keys(environment).length) doc.environment = environment;
  if (mounts && mounts.length) {
    doc.mounts = mounts.map((m) => (m.readonly ? `${m.host}:${m.container}:ro` : `${m.host}:${m.container}`));
  }
  if (runArgs && runArgs.length) doc.runArgs = runArgs;
  if (forwardPorts && forwardPorts.length) doc.forwardPorts = forwardPorts;
  if (portsAttributes && Object.keys(portsAttributes).length) doc.portsAttributes = portsAttributes;
  if (remoteUser) doc.remoteUser = remoteUser;
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Write a generated devcontainer.json into a workspace dir (create-time
 *  generation, `x-paddock.generated` marker). Overwrites a previously
 *  generated file; never touches a project-authored one (guard at caller). */
function writeGeneratedDevContainer(dir, content) {
  const target = path.join(dir, DEV_CONTAINER, DEV_CONTAINER_JSON);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** Sync the 1:1 mapped fields from a pad into an existing devcontainer.json
 *  in place (write-back on pad Settings changes). Project-authored files keep
 *  every non-mapped field; generated files are rewritten wholesale. Returns
 *  the updated content. */
function syncFile(filePath, fields = {}) {
  const parsed = parseDevContainer(filePath);
  const doc = parsed ? parsed.raw : {};
  if (parsed && parsed.generated) {
    // Regenerate the whole doc from the effective config and write it in place
    // (same contract as the project-authored branch below).
    const content = generateDevContainer({
      workspaceFolder: fields.workspaceFolder || parsed.workspaceFolder,
      postCreate: fields.postCreate,
      postStart: fields.postStart,
      postAttach: fields.postAttach,
      environment: fields.environment,
      mounts: fields.mounts,
      runArgs: fields.runArgs,
      forwardPorts: fields.forwardPorts,
      portsAttributes: fields.portsAttributes,
      remoteUser: fields.remoteUser,
    });
    fs.writeFileSync(filePath, content);
    return content;
  }
  // Project-authored: update only the mapped fields, preserve everything else.
  const mapped = {
    workspaceFolder: doc.workspaceFolder,
    postCreateCommand: doc.postCreateCommand,
    postStartCommand: doc.postStartCommand,
    postAttachCommand: doc.postAttachCommand,
    environment: doc.environment,
    mounts: doc.mounts,
    runArgs: doc.runArgs,
    forwardPorts: doc.forwardPorts,
    portsAttributes: doc.portsAttributes,
    remoteUser: doc.remoteUser,
  };
  if (fields.workspaceFolder !== undefined) mapped.workspaceFolder = fields.workspaceFolder;
  if (fields.postCreate !== undefined && fields.postCreate) mapped.postCreateCommand = fields.postCreate;
  if (fields.postStart !== undefined && fields.postStart) mapped.postStartCommand = fields.postStart;
  if (fields.postAttach !== undefined && fields.postAttach) mapped.postAttachCommand = fields.postAttach;
  if (fields.environment !== undefined) mapped.environment = fields.environment;
  if (fields.mounts !== undefined) {
    // Normalize back to the spec's string form (`source:target[:ro]`) so a
    // re-parse round-trips — the parser reads source/target on objects, and
    // string mounts are what generateDevContainer emits too.
    mapped.mounts = fields.mounts.map((m) => (m.readonly ? `${m.host}:${m.container}:ro` : `${m.host}:${m.container}`));
  }
  if (fields.runArgs !== undefined) mapped.runArgs = fields.runArgs;
  if (fields.forwardPorts !== undefined) mapped.forwardPorts = fields.forwardPorts;
  if (fields.portsAttributes !== undefined) mapped.portsAttributes = fields.portsAttributes;
  if (fields.remoteUser !== undefined) mapped.remoteUser = fields.remoteUser || doc.remoteUser;
  const out = { ...doc, ...mapped };
  // A cleared lifecycle command means the mirrored field is gone — delete it
  // from the final doc (spreading over `doc` can't remove a key).
  if (fields.postCreate !== undefined && !fields.postCreate) delete out.postCreateCommand;
  if (fields.postStart !== undefined && !fields.postStart) delete out.postStartCommand;
  if (fields.postAttach !== undefined && !fields.postAttach) delete out.postAttachCommand;
  fs.writeFileSync(filePath, JSON.stringify(out, null, 2) + '\n');
  return JSON.stringify(out, null, 2) + '\n';
}

module.exports = {
  DEV_CONTAINER,
  DEV_CONTAINER_JSON,
  ROOT_DEV_CONTAINER_JSON,
  findDevContainerFile,
  hasDevContainer,
  joinCommand,
  parseDevContainer,
  readDevContainer,
  generateDevContainer,
  writeGeneratedDevContainer,
  syncFile,
};
