const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getDriverOr } = require('./drivers');
const { workspaceMountInfo, containerViewOf, readWebService, readWebAuth, isManagedDoorContainer } = require('./vm-manager');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const PREFIX = process.env.CONTAINER_PREFIX || 'pad';
const VM_NAME_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-zA-Z0-9][a-zA-Z0-9_-]*$');

let _dockerCache = { data: null, ts: 0 };
const DOCKER_CACHE_TTL = 3000;

// Server-side lifecycle flags. `docker stop -t 30` keeps a container in
// `running` until it finally exits, and `docker start`/`restart` move through
// transient states the Docker API never exposes — so without this the UI keeps
// showing the stale docker state, and a page refresh wipes any client-side
// transition. While a start/stop/restart (or settings update/recreate)
// command runs, the registry reports the matching transition status instead.
const _lifecycle = {};

function setLifecycle(name, status) {
  if (status) _lifecycle[name] = status;
  else delete _lifecycle[name];
}

/** Boolean in-flight marker used by the settings/update/recreate flows. */
function setRestarting(name, val) {
  setLifecycle(name, val ? 'restarting' : null);
}

function dockerPsList(force) {
  const now = Date.now();
  if (!force && _dockerCache.data && (now - _dockerCache.ts) < DOCKER_CACHE_TTL) {
    return _dockerCache.data;
  }
  const { execSync } = require('child_process');
  try {
    const out = execSync('docker ps -a --format "{{.Names}}\\t{{.State}}"', { timeout: 5000 }).toString().trim();
    const map = {};
    if (out) {
      for (const line of out.split('\n')) {
        const [name, state] = line.split('\t');
        if (name) map[name] = state;
      }
    }
    _dockerCache = { data: map, ts: now };
    return map;
  } catch {
    return _dockerCache.data || {};
  }
}

function readMeta(vmDir) {
  const metaPath = path.join(vmDir, 'meta.env');
  const meta = {};
  if (fs.existsSync(metaPath)) {
    const content = fs.readFileSync(metaPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        meta[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
      }
    }
  }
  return meta;
}

function findAgentDir(vmDir, agentType) {
  const candidate = path.join(vmDir, agentType);
  if (fs.existsSync(candidate)) return candidate;
  // fallback: check for openclaw subdirectory under any name
  const entries = fs.readdirSync(vmDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory() && e.name !== 'meta.env' && fs.existsSync(path.join(vmDir, e.name, 'openclaw.json'))) {
      return path.join(vmDir, e.name);
    }
  }
  return candidate;
}

function getAgentType(vmName) {
  return readMeta(path.join(INSTANCES_DIR, vmName)).AGENT || 'openclaw';
}

function getWorkspaceRoot(vmName) {
  const agentDir = findAgentDir(path.join(INSTANCES_DIR, vmName), getAgentType(vmName));
  const ws = path.join(agentDir, 'workspace');
  if (fs.existsSync(ws)) return ws;
  return agentDir;
}

function getConfigRoot(vmName) {
  return findAgentDir(path.join(INSTANCES_DIR, vmName), getAgentType(vmName));
}

function syncAgentToDb(agent) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM agents WHERE name = ?').get(agent.name);
  if (existing) {
    db.prepare(`
      UPDATE agents SET
        display_name = ?, agent_type = ?, runtime_type = ?, runtime_ref = ?,
        status = ?, workspace_root = ?, config_root = ?,
        default_model = ?, default_provider = ?, tags = ?,
        updated_at = datetime('now')
      WHERE name = ?
    `).run(
      agent.display_name, agent.agent_type, agent.runtime_type, agent.runtime_ref,
      agent.status, agent.workspace_root, agent.config_root,
      agent.default_model, agent.default_provider, JSON.stringify(agent.tags),
      agent.name
    );
  } else {
    db.prepare(`
      INSERT INTO agents (id, name, display_name, agent_type, runtime_type, runtime_ref,
        status, workspace_root, config_root, default_model, default_provider, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.id, agent.name, agent.display_name, agent.agent_type, agent.runtime_type,
      agent.runtime_ref, agent.status, agent.workspace_root, agent.config_root,
      agent.default_model, agent.default_provider, JSON.stringify(agent.tags)
    );
  }
}

function removeAgentFromDb(name) {
  const db = getDb();
  db.prepare('DELETE FROM activity_events WHERE agent_id = ?').run(name);
  db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(name);
  db.prepare('DELETE FROM agents WHERE name = ? OR id = ?').run(name, name);
}

function buildAgent(vmName, dockerState) {
  const vmDir = path.join(INSTANCES_DIR, vmName);
  const meta = readMeta(vmDir);
  const agentType = meta.AGENT || 'openclaw';
  const agentDir = findAgentDir(vmDir, agentType);
  const workspaceRoot = path.join(agentDir, 'workspace');
  const configRoot = agentDir;
  const driver = getDriverOr(agentType);
  // Lenient here, and deliberately: buildAgent is called in a loop over EVERY
  // pad dir by discoverAgents, outside any try/catch, so one pad whose AGENT
  // line names an unknown type would blank the whole fleet listing — the
  // dashboard and every client that reads it. getDriverOr still throws for a
  // type that is present but unresolvable; what it forgives is an ABSENT one,
  // which is a real state on this fleet (3 pads carry no AGENT line at all).
  // Custom workspace bind (plan 24): meta may carry WORKSPACE_HOST/WORKSPACE_DIR
  // pointing the agent's workspace at an independent host source + container
  // path. `workspace_mount` carries the normalized info for the frontend
  // (workspace tab + settings), and `workspace_dir`/`workspace_root` reflect the
  // EFFECTIVE workspace (the mount's container path / host source) instead of
  // the driver default. When no mount is configured the driver defaults stand.
  let wsMount = null;
  try {
    wsMount = (meta.WORKSPACE_HOST && meta.WORKSPACE_DIR)
      ? workspaceMountInfo(vmName, agentType, meta.WORKSPACE_HOST, meta.WORKSPACE_DIR, {
          // Explicit per-pad opt-in for host browsing. Deliberately NOT derived
          // from `webuiVisible`: the webui can reach the whole project root, but
          // a pad pointed at one subfolder of it must not silently gain host
          // browsing over its parent.
          allowHostBrowse: meta.HOST_BROWSE === '1',
        })
      : null;
  } catch {}
  let effectiveWsDir = driver.workspaceDir || '';
  if (wsMount) {
    effectiveWsDir = wsMount.container;
  }
  let status = dockerState[vmName] || 'missing';
  if (_lifecycle[vmName]) status = _lifecycle[vmName];

  let displayName = vmName.replace(new RegExp('^' + PREFIX + '-'), '');
  // The container name embeds the agent type (e.g. pad-openclaw-work-pls).
  // Strip it so the display name is the name the user actually placed.
  if (agentType && displayName.startsWith(agentType + '-')) {
    displayName = displayName.slice(agentType.length + 1);
  }
  displayName = displayName.charAt(0).toUpperCase() + displayName.slice(1);

  let defaultModel = null;
  let defaultProvider = null;
  const configPath = path.join(configRoot, driver.configFile || 'openclaw.json');
  if (fs.existsSync(configPath)) {
    try {
      if (agentType === 'hermes') {
        // hermes stores the model in config.yaml as `model: { provider, default }`.
        const text = fs.readFileSync(configPath, 'utf8');
        const provider = /^\s*provider:\s*(.+)$/m.exec(text);
        const model = /^\s*default:\s*(.+)$/m.exec(text);
        if (model) {
          defaultProvider = provider ? provider[1].trim() : null;
          defaultModel = model[1].trim().replace(/^['"]|['"]$/g, '');
        }
      } else {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (agentType === 'picoclaw') {
          // picoclaw stores the model as provider + model_name (no primary/fallback).
          if (config?.agents?.defaults?.model_name) {
            defaultProvider = config.agents.defaults.provider || null;
            defaultModel = config.agents.defaults.model_name;
          }
        } else {
          const model = config?.agents?.defaults?.model;
          if (model?.primary) {
            const parts = model.primary.split('/');
            defaultProvider = parts[0] || null;
            defaultModel = parts.slice(1).join('/') || model.primary;
          }
        }
      }
    } catch {}
  }

  // Published web app summary (Web tab). null when the agent type ships no
  // built-in web app or nothing is published. The frontend uses it to render
  // the direct "open" link on the dashboard card and inside the Web tab button.
  let web = null;
  if (driver.webApp) {
    const ws = readWebService(vmName);
    if (ws) {
      web = {
        active: true,
        hostPort: ws.hostPort,
        containerPort: ws.containerPort,
        label: driver.webApp.label,
        // Token for the tokenized console URL (#token=...) — only for drivers
        // whose web console accepts it (openclaw Control UI).
        token: driver.webApp.auth && driver.webApp.auth.urlToken ? readWebAuth(driver, vmName) : '',
      };
    }
  }

  return {
    id: vmName,
    name: vmName,
    display_name: displayName,
    agent_type: agentType,
    runtime_type: 'docker',
    runtime_ref: vmName,
    status,
    workspace_root: agentDir,
    // Where host-scope file operations are clamped (plan 64 3b). Equal to
    // workspace_root unless the pad opted into host browsing, in which case it
    // is the workspace mount's own source. The workspace service reads THIS
    // rather than recomputing the rule, so clearing `hostBrowsable` cannot
    // leave the clamp pointing somewhere else.
    //
    // It must be the webui's OWN view of that source (`containerViewOf`), not
    // the host path spelled out. `/www2` is mounted `:ro` while the project root
    // is `.:/workspace:rw` — so writing to the host path's own spelling hits a
    // read-only mirror and fails EROFS, even with browsing switched on. The
    // refusal then looks like the gate failing when the gate passed: a third
    // kind of "not available" that no flag could have predicted.
    host_browse_root: wsMount && wsMount.hostBrowsable
      ? (containerViewOf(wsMount.host) || agentDir)
      : agentDir,
    config_root: configRoot,
    data_dir: driver.dataDir,
    workspace_dir: effectiveWsDir,
    workspace_mount: wsMount,
    workspace_capability: driver.workspaceCapability || 'fixed',
    default_model: defaultModel,
    default_provider: defaultProvider,
    web,
    tags: [],
    // The three clocks, from the DB row that keeps them. Spread so an absent
    // `last_activity_at` leaves the key out entirely instead of printing a null
    // that reads as a time (see `dbStamps`).
    ...(function stamps(s) {
      return {
        ...(s && s.created_at ? { created_at: s.created_at } : {}),
        ...(s && s.updated_at ? { updated_at: s.updated_at } : {}),
        ...(s && s.last_activity_at ? { last_activity_at: s.last_activity_at } : {}),
      };
    })(dbStamps(vmName)),
  };
}

/** The three activity clocks, read from the one place that keeps them.
 *
 *  `buildAgent` used to hardcode all three to `null` and only the FLEET listing
 *  copied two of them back from SQLite afterwards — so `get_agent` on a perfectly
 *  running pad answered `created_at: null, updated_at: null, last_activity_at:
 *  null`, which reads as "this pad has never existed and never done anything".
 *  Three nulls on a live pad is a bug in its own right, independent of anything
 *  a session does.
 *
 *  They are read HERE, in the one builder both paths use, so the detail read and
 *  the listing cannot answer differently about the same pad. A field with no
 *  source is OMITTED rather than emitted as null: `last_activity_at` is written
 *  only by `recordActivity`, so a pad that has genuinely never recorded an event
 *  has no answer, and "no recorded activity" is a sentence — not a null that
 *  reads as a timestamp of zero. */
function dbStamps(vmName) {
  try {
    const row = getDb().prepare('SELECT created_at, updated_at, last_activity_at FROM agents WHERE name = ?').get(vmName);
    if (!row) return null;
    return row;
  } catch {
    return null;
  }
}

/** Every PAD on disk, synced to the database. With `ownerId`, only the PADs
 *  that user owns: the routes always passed an owner for a regular user, but
 *  this function used to take no parameter at all, so the argument was dropped
 *  and every signed-in user was handed the whole fleet. */
function discoverAgents(ownerId = null) {
  const dockerState = dockerPsList(true);
  const agents = [];

  if (!fs.existsSync(INSTANCES_DIR)) return agents;

  const entries = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !VM_NAME_RE.test(e.name)) continue;
    // Forwarding doors belong to their parent PAD. Older versions could leave
    // an instance-shaped directory behind, so do not promote it into the fleet.
    if (isManagedDoorContainer(e.name)) continue;
    const vmDir = path.join(INSTANCES_DIR, e.name);
    const metaPath = path.join(vmDir, 'meta.env');
    if (!fs.existsSync(metaPath)) continue;

    const agent = buildAgent(e.name, dockerState);
    agents.push(agent);

    // sync to SQLite
    try {
      // `buildAgent` has already read `created_at` / `last_activity_at` for the
      // row (see `dbStamps`), so this block only writes. The old copy-back from
      // the row is gone: two places reading the same fact is how the detail read
      // and the listing came to disagree.
      syncAgentToDb(agent);
    } catch {}
  }

  if (!ownerId) return agents;
  const owned = new Set(getDb().prepare('SELECT name FROM agents WHERE owner_id = ?').all(ownerId).map((row) => row.name));
  return agents.filter((agent) => owned.has(agent.name));
}

function getAgent(agentId) {
  const dockerState = dockerPsList();
  const vmDir = path.join(INSTANCES_DIR, agentId);
  if (!fs.existsSync(vmDir) || !fs.existsSync(path.join(vmDir, 'meta.env'))) {
    return null;
  }
  return buildAgent(agentId, dockerState);
}

function getAgentById(agentId) {
  // try by name first, then by DB id
  let agent = getAgent(agentId);
  if (agent) return agent;
  const db = getDb();
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(agentId);
  if (row) return getAgent(row.name);
  return null;
}

/** Append one audit row. `actor` is the WHO, not the kind of thing: it is
 *  `key:<id>` for an MCP key, `user:<id>` for the web UI, `system` when the
 *  platform did it itself. It is the LAST parameter and defaults, because all
 *  ~20 existing callers pass six positional args and none of them know who they
 *  are — the column sat at its `system` default for every one of the 702 rows
 *  in the table before anything Mission-shaped wrote to it. A log that records
 *  only WHAT happened cannot answer "was that the human, or a key?", which is
 *  the whole question an audit log exists to answer. */
function recordActivity(agentId, category, action, status, details, resourceRef, actor) {
  const db = getDb();
  db.prepare(`
    INSERT INTO activity_events (agent_id, category, action, actor, status, details, resource_ref)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(agentId, category, action, actor || 'system', status || 'ok', details || null, resourceRef || null);
  db.prepare("UPDATE agents SET last_activity_at = datetime('now'), updated_at = datetime('now') WHERE name = ?").run(agentId);
}

function getActivity(agentId, limit = 50) {
  const db = getDb();
  if (agentId) {
    return db.prepare('SELECT * FROM activity_events WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?').all(agentId, limit);
  }
  return db.prepare('SELECT * FROM activity_events ORDER BY timestamp DESC LIMIT ?').all(limit);
}

/** Fleet counts; with `ownerId`, only over the PADs that user owns. */
function getAgentStats(ownerId = null) {
  const db = getDb();
  const where = ownerId ? ' WHERE owner_id = ?' : '';
  const and = ownerId ? ' AND owner_id = ?' : '';
  const args = ownerId ? [ownerId] : [];
  const total = db.prepare(`SELECT COUNT(*) as count FROM agents${where}`).get(...args).count;
  const running = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE status = 'running'${and}`).get(...args).count;
  const stopped = db.prepare(`SELECT COUNT(*) as count FROM agents WHERE status = 'exited'${and}`).get(...args).count;
  return { total, running, stopped, unknown: total - running - stopped };
}

function getOrphanCount() {
  const db = getDb();
  try {
    const row = db.prepare("SELECT COUNT(*) as count FROM agents WHERE owner_id IS NULL OR owner_id = ''").get();
    return row ? row.count : 0;
  } catch {
    return 0;
  }
}

/** Assign (or clear) an agent's owner. The create flow calls this after the
 *  registry sync so the creating user owns the new agent; admins may re-assign
 *  to any existing user. Silently no-ops on a bad userId / missing row. */
// A PAD being created has no row (or no owner) until the build finishes, so the
// ownership gate would refuse its own creator the create log, and a create
// that failed part-way left an ownerless PAD its creator could neither see nor
// delete. The intended owner is recorded the moment the create is accepted.
const pendingOwners = new Map();
function claimPendingOwner(name, userId) { if (name && userId) pendingOwners.set(name, userId); }
function pendingOwner(name) { return pendingOwners.get(name) || null; }
function releasePendingOwner(name) { pendingOwners.delete(name); }

function assignOwner(name, userId) {
  if (!userId) return;
  try {
    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (user) db.prepare('UPDATE agents SET owner_id = ? WHERE name = ?').run(userId, name);
  } catch {}
}

module.exports = {
  discoverAgents,
  getAgent,
  getAgentById,
  recordActivity,
  getActivity,
  getAgentStats,
  getOrphanCount,
  dockerPsList,
  readMeta,
  getWorkspaceRoot,
  getConfigRoot,
  buildAgent,
  syncAgentToDb,
  removeAgentFromDb,
  setRestarting,
  setLifecycle,
  assignOwner, claimPendingOwner, pendingOwner, releasePendingOwner,
  INSTANCES_DIR, PREFIX,
  VM_NAME_RE,
};
