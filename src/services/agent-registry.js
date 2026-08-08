const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const { getDriver } = require('./drivers');
const { workspaceMountInfo, readWebService } = require('./vm-manager');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const PREFIX = process.env.CONTAINER_PREFIX || 'vm';
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
  const driver = getDriver(agentType);
  // Custom workspace bind (plan 24): meta may carry WORKSPACE_HOST/WORKSPACE_DIR
  // pointing the agent's workspace at an independent host source + container
  // path. `workspace_mount` carries the normalized info for the frontend
  // (workspace tab + settings), and `workspace_dir`/`workspace_root` reflect the
  // EFFECTIVE workspace (the mount's container path / host source) instead of
  // the driver default. When no mount is configured the driver defaults stand.
  let wsMount = null;
  try {
    wsMount = (meta.WORKSPACE_HOST && meta.WORKSPACE_DIR)
      ? workspaceMountInfo(vmName, agentType, meta.WORKSPACE_HOST, meta.WORKSPACE_DIR)
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
    config_root: configRoot,
    data_dir: driver.dataDir,
    workspace_dir: effectiveWsDir,
    workspace_mount: wsMount,
    workspace_capability: driver.workspaceCapability || 'fixed',
    default_model: defaultModel,
    default_provider: defaultProvider,
    web,
    tags: [],
    created_at: null,
    updated_at: null,
    last_activity_at: null,
  };
}

function discoverAgents() {
  const dockerState = dockerPsList(true);
  const agents = [];

  if (!fs.existsSync(INSTANCES_DIR)) return agents;

  const entries = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !VM_NAME_RE.test(e.name)) continue;
    const vmDir = path.join(INSTANCES_DIR, e.name);
    const metaPath = path.join(vmDir, 'meta.env');
    if (!fs.existsSync(metaPath)) continue;

    const agent = buildAgent(e.name, dockerState);
    agents.push(agent);

    // sync to SQLite
    try {
      const db = getDb();
      const existing = db.prepare('SELECT created_at, last_activity_at FROM agents WHERE name = ?').get(agent.name);
      if (existing) {
        agent.created_at = existing.created_at;
        agent.last_activity_at = existing.last_activity_at;
      }
      syncAgentToDb(agent);
    } catch {}
  }

  return agents;
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

function recordActivity(agentId, category, action, status, details, resourceRef) {
  const db = getDb();
  db.prepare(`
    INSERT INTO activity_events (agent_id, category, action, status, details, resource_ref)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agentId, category, action, status || 'ok', details || null, resourceRef || null);
  db.prepare("UPDATE agents SET last_activity_at = datetime('now'), updated_at = datetime('now') WHERE name = ?").run(agentId);
}

function getActivity(agentId, limit = 50) {
  const db = getDb();
  if (agentId) {
    return db.prepare('SELECT * FROM activity_events WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?').all(agentId, limit);
  }
  return db.prepare('SELECT * FROM activity_events ORDER BY timestamp DESC LIMIT ?').all(limit);
}

function getAgentStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM agents').get().count;
  const running = db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'running'").get().count;
  const stopped = db.prepare("SELECT COUNT(*) as count FROM agents WHERE status = 'exited'").get().count;
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
  assignOwner,
  INSTANCES_DIR, PREFIX,
  VM_NAME_RE,
};
