const crypto = require('crypto');
const path = require('path');

const { getDb } = require('./db');
const drivers = require('./drivers');
const padTmux = require('./pad-tmux');

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

// ─── Live sessions (the tmux half) ──────────────────────────────────────────

/** A stopped PAD cannot host a session. The agents row is a cheap pre-check for
 *  a message the user can act on; the exec below is the real authority (the
 *  row can be stale). */
function assertPadRunning(agentName) {
  const row = agentRow(agentName);
  if (row.status !== 'running') {
    throw new MissionError('mission_agent_stopped', `${agentName} is not running — start it before opening a session`, 409);
  }
  return row;
}

function sessionTarget(sessionId) {
  const session = getSession(sessionId);
  const project = getProject(session.project_id);
  const driver = assertMissionAgent(project.agent_type);
  return { session, project, driver, vmName: project.agent_name };
}

/** Open a session and launch the agent's TUI into it.
 *
 *  Order matters: the tmux session is created rooted at the project's folder and
 *  only then is the TUI typed in, so the agent starts in the folder the user
 *  picked. A row whose PAD or folder turns out to be unusable is rolled back —
 *  never leave a session row that can only ever be dead.
 *
 *  There is no headless variant: the TUI is launched because the whole point is
 *  that the work is visible. */
async function startSession(projectId, { label = '', origin = 'human', cols = 0, rows = 0 } = {}) {
  const project = getProject(projectId);
  const driver = assertMissionAgent(project.agent_type);
  assertPadRunning(project.agent_name);
  if (!project.folder) {
    throw new MissionError('mission_bad_folder', 'This project has no folder to open a session in');
  }
  // The folder must exist INSIDE the PAD, checked before anything is created:
  // tmux does not fail on a missing `-c` directory, it quietly starts the pane
  // in the parent instead — so without this the agent would work in a folder
  // the user never chose, and never find out.
  if (!(await padTmux.folderExists(project.agent_name, project.folder))) {
    throw new MissionError(
      'mission_folder_missing',
      `${project.folder} does not exist inside ${project.agent_name} — pick a folder the agent can see`,
      409
    );
  }
  const session = createSession(project.id, { label, origin });
  try {
    await padTmux.createSession(project.agent_name, session.tmux_id, { cwd: project.folder, cols, rows });
    await padTmux.sendCommand(project.agent_name, session.tmux_id, driver.tuiLaunch.fresh({ cwd: project.folder }));
  } catch (e) {
    // A launch that never happened must not leave a row behind.
    try { await padTmux.killSession(project.agent_name, session.tmux_id); } catch {}
    deleteSession(session.id);
    throw e instanceof MissionError ? e : new MissionError('mission_session_start_failed', e.message, 500);
  }
  const state = await padTmux.paneState(project.agent_name, session.tmux_id);
  return { session: getSession(session.id), state };
}

/** Re-launch the TUI in a session whose TUI exited (the pane dropped back to
 *  the shell). Refuses when a TUI is already running — retyping the command
 *  would start a second conversation in the same pane. */
async function relaunchTui(sessionId) {
  const { session, project, driver, vmName } = sessionTarget(sessionId);
  const state = await padTmux.paneState(vmName, session.tmux_id);
  if (!state.live) {
    throw new MissionError('mission_session_dead', 'This session is gone — restart it to get a fresh TUI', 409);
  }
  if (state.tuiAlive) {
    throw new MissionError('mission_tui_already_running', 'That session is already running its agent', 409);
  }
  await padTmux.sendCommand(vmName, session.tmux_id, driver.tuiLaunch.fresh({ cwd: project.folder }));
  return { session: getSession(session.id), state: await padTmux.paneState(vmName, session.tmux_id) };
}

/** Type into a live session. The one writer path for the agent (mission_send)
 *  AND the API, so the solo lock is honoured in exactly one place. */
async function sendText(sessionId, text) {
  const { session, vmName } = sessionTarget(sessionId);
  assertNotLocked(session);
  const body = String(text || '');
  if (!body.trim()) throw new MissionError('mission_empty_message', 'Nothing to send');
  if (!(await padTmux.hasSession(vmName, session.tmux_id))) {
    throw new MissionError('mission_session_dead', 'This session is gone — restart it to get a fresh TUI', 409);
  }
  const sent = await padTmux.sendText(vmName, session.tmux_id, body);
  touchSession(session.id);
  return { session: getSession(session.id), sent };
}

/** The pane's visible text — what the LLM reads to see what happened. */
async function screen(sessionId, lines = 40) {
  const { session, vmName } = sessionTarget(sessionId);
  const captured = await padTmux.captureScreen(vmName, session.tmux_id, lines);
  const state = await padTmux.paneState(vmName, session.tmux_id);
  return { session, state, screen: captured.text, live: captured.live };
}

/** live / tuiAlive / command / cwd for one session, for the page's badges and
 *  its Relaunch-TUI vs Restart decision. */
async function state(sessionId) {
  const { session, vmName } = sessionTarget(sessionId);
  return { session, state: await padTmux.paneState(vmName, session.tmux_id) };
}

/** liveness for a list of sessions on one PAD, batched into a single tmux
 *  call by the route (see listProjects' isLive seam). */
async function statesFor(vmsAndSessions) {
  const out = [];
  for (const { vmName, session } of vmsAndSessions) {
    out.push({ session, state: await padTmux.paneState(vmName, session.tmux_id) });
  }
  return out;
}

/** Stamp `live` on every session of every project, at one tmux call per PAD
 *  (`list-sessions`) rather than two per session (`paneState`). A list page
 *  with 20 sessions across 4 PADs is 4 execs, not 40. Deliberately only `live`:
 *  whether a TUI is running inside a live session is one call per session and
 *  the page asks for it when it opens that session. */
async function withLive(projects) {
  const byPad = new Map();
  for (const p of projects) {
    if (!byPad.has(p.agent_name)) byPad.set(p.agent_name, new Set());
  }
  for (const [vmName] of byPad) {
    try {
      const rows = await padTmux.listSessions(vmName);
      byPad.set(vmName, new Set(rows.map((r) => r.name)));
    } catch {
      byPad.set(vmName, new Set());
    }
  }
  for (const p of projects) {
    const names = byPad.get(p.agent_name) || new Set();
    p.sessions = (p.sessions || []).map((s) => ({ ...s, live: names.has(s.tmux_id) }));
    p.liveCount = p.sessions.filter((s) => s.live).length;
  }
  return projects;
}

/** Stamp `live` on a plain session list (same one-call-per-PAD trick). */
async function withLiveSessions(sessions, agentName) {
  if (!sessions.length) return sessions;
  let names = new Set();
  try {
    names = new Set((await padTmux.listSessions(agentName)).map((r) => r.name));
  } catch {}
  return sessions.map((s) => ({ ...s, live: names.has(s.tmux_id) }));
}

/** Stop a session for good: kill the tmux session first, then drop the row, so
 *  a delete never leaves a TUI running in a PAD. */
async function closeSession(sessionId) {
  const { session, vmName } = sessionTarget(sessionId);
  await padTmux.killSession(vmName, session.tmux_id);
  return deleteSession(session.id);
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
  startSession,
  relaunchTui,
  sendText,
  screen,
  state,
  statesFor,
  withLive,
  withLiveSessions,
  closeSession,
};
