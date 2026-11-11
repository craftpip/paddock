/**
 * Dev container support: reading a workspace's devcontainer.json, turning it
 * into a plan, and writing the mirror file back (through the PAD when the
 * workspace is not on the webui's host).
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  readDevContainerPlan, resolveDevContainerPlan, generateWorkspaceDevContainer,
  readWorkspaceDevContainer, syncDevContainer, padsOnSameWorkspace, devContainerStatus,
  regenerateDevContainer, _setPadWriteRunner, defaultPadWriteRunner,
});

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ensureOwned, USER_UID, USER_GID } = require('../ownership');
const devcontainer = require('../devcontainer');
const { readMeta, INSTANCES_DIR, getDriver, HOST_WORKSPACE } = require('./internal');
const {
  containerViewOf, validateExtraVolume, readExtraVolumes, readWorkspaceMount,
} = require('./workspace-mount');
const { readPostCreate, readPostStart, readPostAttach } = require('./build-files');
const { collectPublishedHostPorts, readExtraPorts } = require('./compose');

/** Read the persisted devcontainer plan (meta.env DC_PLAN JSON) or null when
 *  absent/corrupt. Never throws. */
function readDevContainerPlan(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.DC_PLAN) return null;
  try {
    const plan = JSON.parse(meta.DC_PLAN);
    return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : null;
  } catch {
    return null;
  }
}

/** Other pads mounted on the same workspace host. A shared workspace means
 *  ONE `.devcontainer/devcontainer.json` for N pads — knowing the others is
 *  what tells a reader the file is not this pad's alone. */
function padsOnSameWorkspace(name, workspaceHost) {
  if (!workspaceHost) return [];
  const target = path.normalize(String(workspaceHost));
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const other = e.name;
    if (other === name || other.endsWith('-door') || other.endsWith('-web')) continue;
    const meta = readMeta(path.join(INSTANCES_DIR, other)) || {};
    if (!meta.WORKSPACE_HOST) continue;
    let norm = null;
    try { norm = path.normalize(String(meta.WORKSPACE_HOST)); } catch { continue; }
    if (norm === target) out.push(other);
  }
  return out;
}

/** The workspace's .devcontainer as a workspace-scoped, explicitly labelled
 *  block. It is NOT the pad's own devcontainer: it lives in the workspace, is
 *  shared by every pad mounted there, and its port plan is a plan — the live
 *  bindings are the pad's `actualPorts` (in the published-web state). Blank
 *  `userMode`/`containerUser` inherit the pad's effective values rather than
 *  reporting an empty string next to a `userMode: 'user'` pad. */
function readWorkspaceDevContainer(name, workspaceMount) {
  const plan = readDevContainerPlan(name);
  if (!plan) return null;
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  const padUserMode = meta.USER_MODE === 'user' ? 'user' : 'root';
  const sharedWith = padsOnSameWorkspace(name, workspaceMount && workspaceMount.host);
  const out = { ...plan };
  // Inherit the pad's user model instead of echoing back a blank plan field.
  if (!out.userMode) out.userMode = padUserMode;
  if (!out.containerUser) out.containerUser = padUserMode === 'user' ? 'pad (PUID:PGID)' : 'root';
  out.scope = 'workspace';
  out.shared = sharedWith.length > 0;
  if (sharedWith.length) out.sharedWith = sharedWith;
  out.note = sharedWith.length
    ? `This .devcontainer lives in the WORKSPACE at ${plan.filePath || 'the workspace root'} and is shared with ${sharedWith.join(', ')} — it is not ${name}'s own config, and editing it affects every pad listed. Its ports are a PLAN; this pad's live bindings are the actualPorts in the web state above.`
    : `This .devcontainer lives in the WORKSPACE at ${plan.filePath || 'the workspace root'}, not in ${name}'s instance directory. Its ports are a PLAN; this pad's live bindings are the actualPorts in the web state above.`;
  return out;
}

/** Devcontainer runArgs allow-list (plan 41 item 16): only these keys map onto
 *  compose; anything else is rejected with a clear error. */
const DC_RUNARG_KEYS = new Set(['--cap-add', '--ulimit', '--sysctl', '--env-file']);
/** Internal env keys a devcontainer may not override — start.sh owns them. */
const DC_PROTECTED_ENV = new Set(['ROOT_PASSWORD', 'SSH_PORT', 'USER_MODE', 'TZ']);

/** Resolve a workspace devcontainer.json into the effective per-pad plan the
 *  compose generator consumes (plan 41 items 12–16):
 *    workspaceFolder → effective mount target (editable drivers only, and only
 *      when the stored WORKSPACE_DIR is still the driver default — a custom
 *      mount target the user chose wins),
 *    environment    → merged over the defaults (protected keys kept),
 *    mounts         → validated binds (sources resolved against the workspace
 *      host dir; anything under HOST_WORKSPACE but outside the workspace is
 *      rejected so a devcontainer can't reach project internals),
 *    runArgs        → allow-listed cap_add/ulimits/sysctls/env_file,
 *    forwardPorts   → host-port allocation, persisted so re-generates stay
 *      stable. Skip allocation (opts.allocatePorts=false) for the pre-create
 *      validation pass — runArgs/mounts/ports still throw there.
 * Returns null when the workspace has no devcontainer.json. Throws a clear
 * error on invalid mounts/runArgs so create/settings abort early. */
function resolveDevContainerPlan(name, agent, wsMount, opts = {}) {
  if (!wsMount) return null;
  // Container view of the workspace host dir: project paths map to /workspace;
  // host-only paths (e.g. /www1/...) are one-to-one mounts, read as-is.
  const view = containerViewOf(wsMount.host) || path.normalize(wsMount.host);
  const dc = view ? devcontainer.readDevContainer(view) : null;
  if (!dc) return null;
  const driver = getDriver(agent);
  const plan = {
    filePath: dc.filePath,
    hasDevContainer: true,
    workspaceFolder: '',
    environment: {},
    volumes: [],
    runArgs: { caps: [], ulimits: {}, sysctls: {}, envFiles: [] },
    ports: [],
    // 17 — remoteUser/containerUser: the devcontainer's declared user maps onto
    // the pad's USER_MODE (plan 43 Phase 7). `containerUser` wins over
    // `remoteUser` per spec; a non-root user (anything but ''/root/0) means the
    // pad should run as the pad user (PUID/PGID) → 'user'. Explicit root → 'root'.
    // Absent → '' (no preference). The raw strings are kept for generation +
    // the UI; the preference only seeds the DEFAULT — an explicit pad-level
    // Container user toggle always wins.
    remoteUser: dc.remoteUser,
    containerUser: dc.containerUser,
    userMode: dc.preferredUserMode || '',
  };

  // 13 — workspaceFolder: only editable drivers, and only when the user has
  // not pinned their own container target (stored WORKSPACE_DIR still the
  // driver default).
  if (dc.workspaceFolder && driver.workspaceCapability === 'editable' && wsMount.container === driver.workspaceDir) {
    plan.workspaceFolder = dc.workspaceFolder;
  }

  // 12 — environment: coerce to strings, drop protected keys.
  for (const [k, v] of Object.entries(dc.environment)) {
    if (DC_PROTECTED_ENV.has(k)) continue;
    plan.environment[k] = String(v);
  }

  // 15 — mounts: resolve relative sources against the workspace host dir and
  // validate each bind through the extra-volume machinery (rejects system
  // dirs, project internals, agent-data swallow, protected container paths).
  for (const m of dc.mounts) {
    if (!m || !m.host || !m.container) continue;
    const hostPath = m.host.startsWith('/')
      ? m.host
      : path.join(wsMount.host, m.host);
    if (hostPath === HOST_WORKSPACE || hostPath.startsWith(HOST_WORKSPACE + path.sep)) {
      if (!(hostPath === wsMount.host || hostPath.startsWith(wsMount.host + path.sep))) {
        throw new Error(`Devcontainer mount '${m.host}' would reach project internals — only paths inside the workspace or outside the project root are allowed`);
      }
    }
    plan.volumes.push(validateExtraVolume(name, agent, hostPath, m.container, !!m.readonly, 'bind', ''));
  }

  // 16 — runArgs: parse the allow-listed keys only (`--key=value` or `--key value`).
  const args = [...dc.runArgs];
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    const eq = raw.indexOf('=');
    const key = eq > 0 ? raw.slice(0, eq) : raw;
    let value = eq > 0 ? raw.slice(eq + 1) : '';
    if (!DC_RUNARG_KEYS.has(key)) {
      throw new Error(`Unsupported devcontainer runArg '${raw}' — only ${[...DC_RUNARG_KEYS].join(', ')} are supported`);
    }
    if (!value && key !== '--cap-add') {
      value = args[++i];
      if (value === undefined) throw new Error(`Missing value for devcontainer runArg '${key}'`);
    }
    if (key === '--cap-add') {
      if (value && !plan.runArgs.caps.includes(value)) plan.runArgs.caps.push(value);
    } else if (key === '--ulimit') {
      const um = /^([a-z_]+)=(\d+)(?::(\d+))?$/.exec(value);
      if (!um) throw new Error(`Invalid devcontainer --ulimit '${value}' — expected name=soft[:hard]`);
      plan.runArgs.ulimits[um[1]] = { soft: +um[2], hard: um[3] ? +um[3] : +um[2] };
    } else if (key === '--sysctl') {
      const sm = /^([^=]+)=(.+)$/.exec(value);
      if (!sm) throw new Error(`Invalid devcontainer --sysctl '${value}' — expected key=value`);
      plan.runArgs.sysctls[sm[1]] = sm[2];
    } else if (key === '--env-file') {
      plan.runArgs.envFiles.push(value.startsWith('/') ? value : path.join(wsMount.host, value));
    }
  }

  // 14 — forwardPorts: allocate a stable host port per container port (reuse
  // the container port when free, else a fresh 43817-range port; previously
  // persisted mappings are kept across settings applies). Validation passes
  // skip allocation entirely.
  const used = opts.allocatePorts !== false ? collectPublishedHostPorts(name) : null;
  const excluded = new Set((opts.excludeHostPorts || []).filter(Boolean).map(String));
  const prev = readDevContainerPlan(name);
  const prevHosts = new Map((prev && prev.ports ? prev.ports : []).map((p) => [`${p.container}/${p.protocol}`, String(p.host)]));
  for (const entry of dc.forwardPorts) {
    const pm = /^(\d+)(?:\/(tcp|udp))?$/.exec(String(entry).trim());
    if (!pm) continue;
    const container = pm[1];
    const protocol = pm[2] || 'tcp';
    let host = container;
    if (used) {
      const prevHost = prevHosts.get(`${container}/${protocol}`);
      let p = prevHost && !used.has(parseInt(prevHost, 10)) && !excluded.has(prevHost)
        ? parseInt(prevHost, 10)
        : parseInt(host, 10);
      while (used.has(p) || excluded.has(String(p)) || plan.ports.some((x) => x.host === String(p))) p++;
      host = String(p);
      used.add(p);
    }
    const attr = dc.portsAttributes && dc.portsAttributes[container] ? dc.portsAttributes[container] : {};
    plan.ports.push({
      container,
      host,
      protocol,
      label: attr.label ? String(attr.label) : '',
    });
  }

  return plan;
}

/** Convert a resolved runArgs plan back into `--key value` strings for the
 *  devcontainer mirror (plan 41 items 18–19). */
function runArgsToDevContainerArgs(runArgs = {}) {
  const out = [];
  for (const cap of runArgs.caps || []) out.push('--cap-add', cap);
  for (const [n, ul] of Object.entries(runArgs.ulimits || {})) {
    out.push('--ulimit', `${n}=${ul.soft}:${ul.hard}`);
  }
  for (const [k, v] of Object.entries(runArgs.sysctls || {})) out.push('--sysctl', `${k}=${v}`);
  for (const f of runArgs.envFiles || []) out.push('--env-file', f);
  return out;
}

/** The 1:1 devcontainer mirror fields for a pad, computed from its CURRENT
 *  effective config (meta, lifecycle scripts, persisted plan, extras). The
 *  devcontainer is the portable mirror of the pad (plan 41 items 18–19), so
 *  pad-level additions (extra volumes/ports, edited lifecycle commands) flow
 *  back into it. */
function devcontainerMirrorFields(name, agent, wsMount) {
  if (!wsMount) return null;
  const dcPlan = readDevContainerPlan(name) || {};
  const extraVols = readExtraVolumes(name);
  const extraPs = readExtraPorts(name);

  const mounts = [];
  const seen = new Set();
  for (const v of [...(dcPlan.volumes || []), ...extraVols]) {
    if (!v || !v.host || !v.container) continue;
    const m = { host: String(v.host), container: String(v.container), readonly: !!v.readonly };
    const key = `${m.host}\u0000${m.container}\u0000${m.readonly ? 'ro' : 'rw'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mounts.push(m);
  }

  const forwardPorts = [];
  for (const p of [...(dcPlan.ports || []), ...extraPs]) {
    if (p && p.container && !forwardPorts.includes(String(p.container))) forwardPorts.push(String(p.container));
  }

  const portsAttributes = {};
  for (const p of dcPlan.ports || []) {
    if (p && p.label) portsAttributes[p.container] = { label: String(p.label) };
  }

  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  // Reverse-translate lifecycle commands to the /workspace convention: the
  // pad's scripts use the agent's workspace path (e.g.
  // /root/.openclaw/workspace); the mirror stores convention paths so
  // different agent types can probe it cleanly (plan 45).
  const padWs = wsMount.container;
  const toConvention = (cmd) => {
    if (!cmd || !padWs || padWs === '/workspace') return cmd;
    const esc = padWs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return cmd.replace(new RegExp(`(^|[^/\\w.-])${esc}(?=[/\\s"';&|)$])`, 'g'), '$1/workspace');
  };
  return {
    workspaceFolder: dcPlan.workspaceFolder || wsMount.container,
    postCreate: toConvention(readPostCreate(name)),
    postStart: toConvention(readPostStart(name)),
    postAttach: toConvention(readPostAttach(name)),
    environment: dcPlan.environment || {},
    mounts,
    runArgs: runArgsToDevContainerArgs(dcPlan.runArgs),
    forwardPorts,
    portsAttributes,
    remoteUser: meta.USER_MODE === 'user' ? 'pad' : '',
  };
}

/** Generate a `.devcontainer/devcontainer.json` mirror for a pad's workspace at
 *  create time (plan 41 item 18) — only when the workspace has none and
 *  generation is enabled (default on; the create form toggle / MCP arg opts
 *  out). Returns the written file path, or null when there's nothing to
 *  generate (no workspace, workspace already has a devcontainer, workspace not
 *  visible to the webui). */
function generateWorkspaceDevContainer(name, agent, wsMount, { postCreate = '', postStart = '', postAttach = '', extraVols = [], extraPs = [], userMode = '', enabled = true } = {}) {
  if (!enabled || !wsMount) return null;
  if (devcontainer.hasDevContainer(containerViewOf(wsMount.host) || '')) return null;
  const view = containerViewOf(wsMount.host) || path.normalize(wsMount.host);
  if (!view || !fs.existsSync(view)) return null;
  // Reverse-translate lifecycle commands to /workspace convention so the
  // generated mirror is agent-type-agnostic (plan 45).
  const padWs = wsMount.container;
  const toConvention = (cmd) => {
    if (!cmd || !padWs || padWs === '/workspace') return cmd;
    const esc = padWs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return cmd.replace(new RegExp(`(^|[^/\\w.-])${esc}(?=[/\\s"';&|)$])`, 'g'), '$1/workspace');
  };
  const target = devcontainer.writeGeneratedDevContainer(view, devcontainer.generateDevContainer({
    workspaceFolder: wsMount.container,
    postCreate: toConvention(String(postCreate).trim()),
    postStart: toConvention(String(postStart).trim()),
    postAttach: toConvention(String(postAttach).trim()),
    mounts: (extraVols || [])
      .filter((v) => v.type !== 'volume')
      .map((v) => ({ host: v.host, container: v.container, readonly: v.readonly })),
    forwardPorts: (extraPs || []).map((p) => String(p.container)),
    remoteUser: userMode === 'user' ? 'pad' : '',
  }));
  ensureOwned(target);
  return target;
}

/** Write back the pad's 1:1 mapped fields into the workspace devcontainer.json
 *  in place (plan 41 item 19). Generated files (`x-paddock.generated`) are
 *  regenerated wholesale; project-authored files get only the mapped fields
 *  (runArgs/portsAttributes/remoteUser stay untouched). Skips when the pad has
 *  no workspace or the workspace devcontainer is one the pad never adopted (no
 *  generated marker, no persisted plan) — never clobbers an unknown file.
 *  Webui-visible workspaces write through this process's filesystem. Host-only
 *  workspaces (plan 70) compose the same content and write it through the pad's
 *  own container instead — the webui sees `/www2` (etc.) read-only, but the pad
 *  holds the identical bind mount read-write. Sync still requires the file to
 *  be READABLE by the webui (the adoption check), which host-only `/www2/*`
 *  mounts are; a workspace the webui cannot read at all has nothing to adopt.
 *  Returns the synced file path (host form), or null. Throws typed errors for
 *  the pad-write path ('pad_not_running' / 'devcontainer_write_failed').
 *  A throw never blocks the caller — the settings apply logs and continues. */
async function syncDevContainer(name, agent, wsMount, { onLog = () => {} } = {}) {
  if (!wsMount) return null;
  const writableView = !!containerViewOf(wsMount.host);
  const view = writableView ? containerViewOf(wsMount.host) : path.normalize(wsMount.host);
  const dc = view ? devcontainer.readDevContainer(view) : null;
  if (!dc) return null;
  const dcPlan = readDevContainerPlan(name);
  if (!dc.generated && !dcPlan) return null;
  const fields = devcontainerMirrorFields(name, agent, wsMount);
  if (!fields) return null;
  const content = dc.generated
    ? devcontainer.syncFile(dc.filePath, fields, { write: writableView })
    : devcontainer.syncFile(dc.filePath, {
        // Project-authored: only the mapped fields, and only when the pad has
        // something meaningful to say. workspaceFolder is written only when the
        // devcontainer declared one the pad honors (identity — never force the
        // pad's own target into a project file). Empty collections are omitted
        // so a devcontainer without mounts/ports/env stays uncluttered.
        workspaceFolder: dcPlan && dcPlan.workspaceFolder ? fields.workspaceFolder : undefined,
        postCreate: fields.postCreate,
        postStart: fields.postStart,
        postAttach: fields.postAttach,
        ...(Object.keys(fields.environment || {}).length ? { environment: fields.environment } : {}),
        ...(fields.mounts && fields.mounts.length ? { mounts: fields.mounts } : {}),
        ...(fields.forwardPorts && fields.forwardPorts.length ? { forwardPorts: fields.forwardPorts } : {}),
      }, { write: writableView });
  if (!writableView) {
    // Plan 70: through the running pad. Only the composed devcontainer bytes
    // travel — the shell never quotes file content (stdin does).
    await writeWorkspaceFileThroughPad(name, wsMount, path.relative(path.normalize(wsMount.host), dc.filePath), content);
    onLog('system', `Synced workspace devcontainer through the pad (${dc.generated ? 'generated' : 'project-authored'})`);
    return dc.filePath;
  }
  ensureOwned(dc.filePath);
  onLog('system', `Synced workspace devcontainer (${dc.generated ? 'generated' : 'project-authored'})`);
  return dc.filePath;
}

/** The Settings "Dev Container" card state (plan 41 item 20): where the pad's
 *  workspace devcontainer.json lives, its state badge (generated /
 *  project-authored / missing), and both sides of the diff preview — the
 *  current file content vs what Paddock would write now from the pad's
 *  effective config. `sync`/`regenerate` tell the UI which actions apply.
 *  Never throws. */
function devContainerStatus(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  if (!meta || (!meta.AGENT && !meta.ROOT_PASSWORD)) return null;
  const agentType = meta.AGENT || 'openclaw';
  let wsMount = null;
  try { wsMount = readWorkspaceMount(name, agentType); } catch {}
  if (!wsMount) {
    return { found: false, state: 'missing', filePath: '', workspacePath: '', content: '', target: '', sync: false, regenerate: true, writableVia: '', writable: false, writeNote: '' };
  }
  const writableView = !!containerViewOf(wsMount.host);
  const view = writableView ? containerViewOf(wsMount.host) : path.normalize(wsMount.host);
  let dc = null;
  try { dc = view ? devcontainer.readDevContainer(view) : null; } catch {}
  const fields = devcontainerMirrorFields(name, agentType, wsMount);
  const target = fields
    ? devcontainer.generateDevContainer(fields)
    : '';
  let content = '';
  try { content = dc ? fs.readFileSync(dc.filePath, 'utf8') : ''; } catch {}
  const generated = !!(dc && dc.generated);
  return {
    found: !!dc,
    state: !dc ? 'missing' : generated ? 'generated' : 'project-authored',
    filePath: dc ? dc.filePath : '',
    workspacePath: view || '',
    generated,
    content,
    target,
    // Sync writes the mapped fields in place — meaningful only for a file the
    // pad adopted (generated, or one with a persisted plan). Regenerate always
    // applies (it creates the file when missing).
    sync: !!dc && (generated || !!readDevContainerPlan(name)),
    regenerate: true,
    // Plan 70: where a Generate/Sync write goes. A webui-visible workspace is
    // written by this process directly; a host-only one (/www2/user1, /www1 —
    // the webui's mount is read-only) is written through the running pad, whose
    // bind mount of the same folder is read-write.
    writableVia: writableView ? 'webui' : 'pad',
    writable: !!wsMount,
    writeNote: writableView ? '' : 'This workspace is outside the webui container, so the mirror is written through the running pad — the pad must be up when you click.',
  };
}

/** Plan 70: the mirror still has to be written when the webui's own mount is
 *  read-only. This module does NOT reach through the pad via orchestrator
 *  (circular import) — it owns a small `docker exec -i` writer of its own.
 *  Spawn, never execFile: the paddock container's docker CLI keeps a piped
 *  stdin open under execFile (measured: a trivial `read` hangs; spawn +
 *  `stdin.write/end` completes). Content travels on stdin so the shell never
 *  quotes file bytes. termUserArgs drops to the pad user in user-mode pads, so
 *  the written file is PUID-owned like the rest of the workspace; a ROOT-mode
 *  pad chowns to USER_UID:USER_GID inside the container instead. */
let _padWriteRunner = null;
/** Test seam: replace the default `docker exec` runner in a suite. */
function _setPadWriteRunner(fn) { _padWriteRunner = fn; }

const dcWriteError = (code, message) => Object.assign(new Error(message), { code });

/** Local alias of pad-tmux's termUserArgs: pad-tmux requires THIS module
 *  back, so the require has to happen at call time, not module load. */
function padTermUserArgs(vmName) {
  return require('../pad-tmux').termUserArgs(vmName);
}

const DC_TARGET_REL = path.join(devcontainer.DEV_CONTAINER, devcontainer.DEV_CONTAINER_JSON);

function defaultPadWriteRunner(name, script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', ...padTermUserArgs(name), name, 'sh', '-lc', script], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const settle = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(dcWriteError('devcontainer_write_failed', `docker exec timed out writing the devcontainer into ${name}`));
    }, 30000);
    timer.unref();
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => settle(dcWriteError('devcontainer_write_failed', e.message)));
    child.on('close', (code) => {
      if (code === 0) return settle();
      const msg = String(stderr || '').trim();
      // 125/126: docker's own CLI failures (daemon can't start the container,
      // no such exec target) — an executable-input error, not a script error.
      const notRunning = /no such container|not running|isn't running/i.test(msg) || code === 125;
      settle(dcWriteError(
        notRunning ? 'pad_not_running' : 'devcontainer_write_failed',
        notRunning
          ? `pad ${name} is not running — start it first, then generate again (its workspace is only writable through the pad)`
          : (msg || `docker exec exited ${code}`)
      ));
    });
    child.stdin.write(input || '');
    child.stdin.end();
  });
}

/** Write one file into the pad's workspace THROUGH THE PAD. `relPath` is
 *  relative to the workspace mount; the file target is the pad-normalized
 *  container path (promise-based; callers must await). Throws typed errors. */
async function writeWorkspaceFileThroughPad(name, wsMount, relPath, content) {
  // The mount validator already refuses quotes/control characters for host and
  // container paths; normalize away any `..` trick a relative suffix could add.
  const safeRel = path.normalize('/' + String(relPath || '')).slice(1);
  if (!safeRel || safeRel === '.' || safeRel.startsWith('..')) {
    throw dcWriteError('devcontainer_write_failed', `unsafe workspace write target: ${relPath}`);
  }
  const file = path.posix.join(String(wsMount.container), safeRel);
  const dir = path.posix.dirname(file);
  const rootMode = padTermUserArgs(name).length === 0;
  const ownCmd = rootMode ? ` && chown ${USER_UID}:${USER_GID} '${file}'` : '';
  const script = `mkdir -p '${dir}' && cat > '${file}'${ownCmd}`;
  const runner = _padWriteRunner || defaultPadWriteRunner;
  await runner(name, script, String(content || ''));
  return file;
}

/** Rewrite (or create) the workspace devcontainer.json as the pad's full
 *  generated mirror (plan 41 item 20 "Regenerate"). Unlike sync, this clobbers
 *  the whole file — only a user clicking Regenerate in the card should do
 *  that. Webui-visible workspaces write locally; host-only workspaces write
 *  through the pad (plan 70 fix (a) — chosen over disabling the card, so
 *  Generate works everywhere a workspace exists). Returns the written file
 *  path (host form), or null when there is nothing to write. Throws typed
 *  errors on the pad path ('pad_not_running' / 'devcontainer_write_failed'). */
async function regenerateDevContainer(name, agent) {
  if (!agent) return null;
  let wsMount = null;
  try { wsMount = readWorkspaceMount(name, agent); } catch {}
  if (!wsMount) return null;
  const view = containerViewOf(wsMount.host);
  if (view ? !fs.existsSync(view) : !fs.existsSync(wsMount.host)) return null;
  const fields = devcontainerMirrorFields(name, agent, wsMount);
  if (!fields) return null;
  const content = devcontainer.generateDevContainer(fields);
  if (view) {
    const target = devcontainer.writeGeneratedDevContainer(view, content);
    ensureOwned(target);
    return target;
  }
  const hostPath = path.join(wsMount.host, '.devcontainer', 'devcontainer.json');
  await writeWorkspaceFileThroughPad(name, wsMount, DC_TARGET_REL, content);
  return hostPath;
}
