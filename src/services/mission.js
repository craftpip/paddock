const crypto = require('crypto');
const path = require('path');

const { getDb } = require('./db');
const drivers = require('./drivers');

// Mission (plan 53): projects are (agent, folder) pairs, and a session is the
// only unit of work — one live tmux session per row, running the agent's TUI in
// the project's folder, typed into by the human and the agent alike.
//
// This module is the STORE plus the validation rules. The tmux/docker half
// (start a session, send keys, capture the screen) lives in tmux.js and is wired
// in Phase 1, so the CRUD surface can be built and tested on its own.

/** An error with a machine-readable code, so routes and MCP tools can answer
 *  with the same shape the UI and the LLM both branch on. */
class MissionError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

// The three coding models are the only agents that get Mission projects. The
// personal agents (openclaw, picoclaw, hermes) are deliberately excluded: the
// gate lives here, in the service, so an MCP client cannot walk around a UI
// filter. Adding a type later is one `mission: { supported: true }` flag on its
// driver — nothing else changes.
function assertMissionAgent(agentType) {
  const d = drivers.getDriver(agentType);
  if (!(d.mission && d.mission.supported)) {
    throw new MissionError(
      'mission_unsupported_agent',
      `${d.type} does not support Mission workspaces (supported: ${supportedTypes().join(', ')})`
    );
  }
  return d;
}

function supportedTypes() {
  return Object.values(drivers.drivers)
    .filter((d) => d.mission && d.mission.supported)
    .map((d) => d.type);
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

/** A tmux session name for a mission row: `msn-` + 8 hex chars. Matches
 *  app.js's SESSION_NAME_RE ([a-zA-Z0-9][a-zA-Z0-9._-]{0,63}) so the row id and
 *  the tmux name are both safe to pass to tmux unquoted. */
function newTmuxId() {
  return `msn-${crypto.randomBytes(4).toString('hex')}`;
}

const TMUX_RE = /^msn-[0-9a-f]{8}$/;

function normalizeFolder(folder) {
  let f = String(folder || '').trim();
  if (!f) throw new MissionError('mission_bad_folder', 'A project needs a folder');
  if (f.length > 1) f = f.replace(/\/+$/, '');
  if (!path.isAbsolute(f)) {
    throw new MissionError('mission_bad_folder', 'The folder must be an absolute path inside the agent');
  }
  if (f.includes('\n') || f.includes('\0')) {
    throw new MissionError('mission_bad_folder', 'The folder contains illegal characters');
  }
  return f;
}

function agentRow(agentName) {
  const row = getDb().prepare('SELECT name, agent_type, status, owner_id FROM agents WHERE name = ?').get(agentName);
  if (!row) throw new MissionError('mission_agent_not_found', `No agent named ${agentName}`, 404);
  return row;
}

// ─── Projects ────────────────────────────────────────────────────────────────

/** Create a project. A project IS an (agent, folder) pair; many projects per
 *  agent is the normal case, so there is no uniqueness constraint — the caller
 *  may warn about an exact duplicate, we never block it. */
function createProject({ name, agent, folder, createdBy = null, defaultFolder = '' }) {
  const projectName = String(name || '').trim();
  if (!projectName) throw new MissionError('mission_bad_name', 'A project needs a name');
  if (projectName.length > 120) throw new MissionError('mission_bad_name', 'Project name is too long');

  const agentName = String(agent || '').trim();
  const row = agentRow(agentName);
  const driver = assertMissionAgent(row.agent_type);

  const dir = normalizeFolder(folder || defaultFolder || driver.workspaceDir || '');

  const id = newId('prj');
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mission_projects (id, name, agent_name, agent_type, folder, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectName, row.name, row.agent_type, dir, createdBy, now, now);
  return getProject(id);
}

function getProject(id) {
  const row = getDb().prepare('SELECT * FROM mission_projects WHERE id = ?').get(String(id || ''));
  if (!row) throw new MissionError('mission_project_not_found', 'No such project', 404);
  return row;
}

/** Every project, with its sessions nested and a live flag per session when the
 *  caller supplies `isLive(sessionRow)`. The store never talks to docker; the
 *  route layer passes the liveness probe in. */
function listProjects({ agent = '', agents = null, createdBy = null, isLive = null } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (agent) { where.push('p.agent_name = ?'); params.push(String(agent)); }
  // Ownership scoping: a non-admin only ever sees projects on PADs they own, so
  // the route passes the allowed agent names in rather than the service knowing
  // anything about users.
  if (Array.isArray(agents)) {
    if (!agents.length) return [];
    where.push(`p.agent_name IN (${agents.map(() => '?').join(',')})`);
    params.push(...agents);
  }
  const rows = db
    .prepare(`SELECT p.* FROM mission_projects p${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY p.created_at DESC, p.name COLLATE NOCASE`)
    .all(...params);
  const sessions = db.prepare('SELECT * FROM mission_sessions ORDER BY created_at DESC').all();
  return rows.map((p) => withSessions(p, sessions.filter((s) => s.project_id === p.id), isLive));
}

function withSessions(project, sessions, isLive) {
  return {
    ...project,
    sessions: sessions.map((s) => ({ ...s, live: isLive ? !!isLive(s, project) : null })),
    sessionCount: sessions.length,
    liveCount: isLive ? sessions.filter((s) => isLive(s, project)).length : null,
  };
}

/** Rename and/or repoint the folder. Repointing deliberately does NOT touch
 *  live sessions (open question 1) — it applies to sessions created after the
 *  change. */
function updateProject(id, { name, folder } = {}) {
  const project = getProject(id);
  const sets = [];
  const params = [];
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) throw new MissionError('mission_bad_name', 'A project needs a name');
    sets.push('name = ?');
    params.push(n);
  }
  if (folder !== undefined) {
    sets.push('folder = ?');
    params.push(normalizeFolder(folder));
  }
  if (!sets.length) return project;
  sets.push("updated_at = ?");
  params.push(new Date().toISOString(), project.id);
  getDb().prepare(`UPDATE mission_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProject(id);
}

/** Delete a project. Its tmux sessions are the caller's business (the route
 *  kills them first, so a delete never leaves an orphan TUI running). */
function deleteProject(id) {
  const project = getProject(id);
  getDb().prepare('DELETE FROM mission_sessions WHERE project_id = ?').run(project.id);
  getDb().prepare('DELETE FROM mission_projects WHERE id = ?').run(project.id);
  return project;
}

// ─── Sessions ────────────────────────────────────────────────────────────────

/** Create a session row. The tmux session + TUI launch is Phase 1; the row is
 *  the source of truth and tmux is the runtime. `origin` records who opened it
 *  so the page can badge agent-started sessions. */
function createSession(projectId, { label = '', origin = 'human', tmuxId = '' } = {}) {
  const project = getProject(projectId);
  const who = origin === 'agent' ? 'agent' : 'human';
  const tid = tmuxId || newTmuxId();
  if (!TMUX_RE.test(tid)) throw new MissionError('mission_bad_session', 'Bad session name');
  const id = newId('msn');
  getDb()
    .prepare(
      `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, project.id, tid, String(label || '').slice(0, 200), who, new Date().toISOString(), new Date().toISOString());
  return getSession(id);
}

function getSession(id) {
  const row = getDb().prepare('SELECT * FROM mission_sessions WHERE id = ?').get(String(id || ''));
  if (!row) throw new MissionError('mission_session_not_found', 'No such session', 404);
  return row;
}

function listSessions({ projectId = '', isLive = null } = {}) {
  const db = getDb();
  const rows = projectId
    ? db.prepare('SELECT * FROM mission_sessions WHERE project_id = ? ORDER BY created_at DESC').all(String(projectId))
    : db.prepare('SELECT * FROM mission_sessions ORDER BY created_at DESC').all();
  return rows.map((s) => ({ ...s, live: isLive ? !!isLive(s) : null }));
}

/** Label and/or the solo lock. `locked` is the one privacy control in the
 *  feature: the agent may still READ a locked session, it just may not type
 *  into it (mission.js's send path is the only writer, and it checks here). */
function updateSession(id, { label, locked } = {}) {
  const session = getSession(id);
  const sets = [];
  const params = [];
  if (label !== undefined) {
    sets.push('label = ?');
    params.push(String(label).slice(0, 200));
  }
  if (locked !== undefined) {
    sets.push('locked = ?');
    params.push(locked ? 1 : 0);
  }
  if (!sets.length) return session;
  params.push(session.id);
  getDb().prepare(`UPDATE mission_sessions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getSession(id);
}

/** The single choke point every writer goes through. A solo-locked session is
 *  refused here, not at the route, so the MCP tool and the REST route behave
 *  identically. */
function assertNotLocked(session) {
  if (session.locked) {
    throw new MissionError(
      'mission_session_locked',
      `Session "${session.label || session.tmux_id}" is solo-locked — unlock it on the Mission page to let the agent type`,
      409
    );
  }
  return session;
}

function deleteSession(id) {
  const session = getSession(id);
  getDb().prepare('DELETE FROM mission_sessions WHERE id = ?').run(session.id);
  return session;
}

function touchSession(id) {
  getDb().prepare("UPDATE mission_sessions SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), String(id));
}

module.exports = {
  MissionError,
  supportedTypes,
  assertMissionAgent,
  newTmuxId,
  normalizeFolder,
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  createSession,
  getSession,
  listSessions,
  updateSession,
  assertNotLocked,
  deleteSession,
  touchSession,
};
