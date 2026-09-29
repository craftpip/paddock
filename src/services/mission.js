const crypto = require('crypto');
const path = require('path');

const { getDb } = require('./db');
const drivers = require('./drivers');
const padTmux = require('./pad-tmux');
const registry = require('./agent-registry');
const workspace = require('./workspace');

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
  // `rowid ASC` is the tiebreaker for rows created in the same millisecond, and
  // it is not cosmetic: `created_at` alone leaves tied rows in whatever order
  // the query plan happens to produce, which is a function of the table's
  // physical layout. Any UPDATE (including the `last_seen_at` touch below) can
  // move a row and reshuffle its neighbours, so a session list that a user was
  // reading can reorder itself on a poll. Insertion order is the tie order the
  // listings have always shown, so state it rather than inherit it.
  const sessions = db.prepare('SELECT * FROM mission_sessions ORDER BY created_at DESC, rowid ASC').all();
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
 *  the source of truth and tmux is the runtime. `origin` records the KIND of
 *  starter (human / agent) and `createdBy` the WHO — `key:<id>` for an MCP key,
 *  `user:<id>` for the web UI (plan 67, 67.3). */
function createSession(projectId, { label = '', origin = 'human', tmuxId = '', agentSessionId = '', createdBy = null } = {}) {
  const project = getProject(projectId);
  const who = origin === 'agent' ? 'agent' : 'human';
  const tid = tmuxId || newTmuxId();
  if (!TMUX_RE.test(tid)) throw new MissionError('mission_bad_session', 'Bad session name');
  const id = newId('msn');
  getDb()
    .prepare(
      `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, created_by, agent_session_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      project.id,
      tid,
      String(label || '').slice(0, 200),
      who,
      createdBy ? String(createdBy).slice(0, 120) : null,
      String(agentSessionId || '') || null,
      new Date().toISOString(),
      new Date().toISOString()
    );
  return getSession(id);
}

function getSession(id) {
  const row = getDb().prepare('SELECT * FROM mission_sessions WHERE id = ?').get(String(id || ''));
  if (!row) throw new MissionError('mission_session_not_found', 'No such session', 404);
  return row;
}

function listSessions({ projectId = '', isLive = null } = {}) {
  const db = getDb();
  // See the tiebreaker note in listProjects — same-millisecond rows need rowid
  // so an UPDATE cannot reorder the listing under the user.
  const rows = projectId
    ? db.prepare('SELECT * FROM mission_sessions WHERE project_id = ? ORDER BY created_at DESC, rowid ASC').all(String(projectId))
    : db.prepare('SELECT * FROM mission_sessions ORDER BY created_at DESC, rowid ASC').all();
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

/** Find a live mission session by its tmux id, or null.
 *
 *  The terminal WebSocket identifies a mission session by tmux id, not by row
 *  id, and it is allowed to lazily (re)create a missing tmux session. That
 *  resurrection is right for an agent session and wrong for a closed mission
 *  session: an attached client reconnects, the server re-creates the tmux
 *  session, and "Close" silently un-closes the session as a bare shell. The WS
 *  asks this first and refuses to attach to a row that no longer exists. */
function getSessionByTmux(tmuxId) {
  if (!/^msn-[A-Za-z0-9._-]+$/.test(String(tmuxId || ''))) return null;
  return (
    getDb()
      .prepare('SELECT * FROM mission_sessions WHERE tmux_id = ?')
      .get(String(tmuxId)) || null
  );
}

function touchSession(id) {
  getDb().prepare("UPDATE mission_sessions SET last_seen_at = ? WHERE id = ?").run(new Date().toISOString(), String(id));
}

/** Record pane OUTPUT, not the fact that we looked (plan 62 1f).
 *
 *  `last_seen_at` is a probe clock and is refreshed by every read; a caller who
 *  wants to know whether the agent is still producing anything has to be able to
 *  ask a different question. So the content is hashed and the timestamp advances
 *  ONLY when the hash moves. Re-reading an unchanged pane therefore leaves
 *  `last_output_at` alone — which is the whole point, because a field that moved
 *  on every read would be the same lie under a better name.
 *
 *  The hash is what makes "changed" answerable across requests: there is no
 *  in-memory cache that survives a restart, and a column does. */
function noteOutput(id, text) {
  const hash = crypto.createHash('sha1').update(String(text || '')).digest('hex');
  const db = getDb();
  const row = db.prepare('SELECT last_output_hash FROM mission_sessions WHERE id = ?').get(String(id));
  if (!row) return null;
  if (row.last_output_hash === hash) return null;
  // The timestamp is computed ONCE and both stored and returned. Computing it
  // again for the response would let the two differ by a millisecond, and a
  // caller that compared the row it was handed against a later read would see a
  // change nobody made.
  const at = new Date().toISOString();
  db.prepare('UPDATE mission_sessions SET last_output_at = ?, last_output_hash = ? WHERE id = ?').run(at, hash, String(id));
  return at;
}

/** Single-quote a value for the shell inside the PAD: wrap in `'…'` and turn
 *  any `'` into `'\''`, so a folder with a space or a quote in it cannot break
 *  out of the `cd`. Folder paths come from the user, so this matters. */
function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
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

/** What the create/edit dialog needs to know about a folder INSIDE the PAD.
 *
 *  This is the honest answer for a host path that simply is not mounted in the
 *  agent's container: the path can look perfectly valid from the webui and
 *  still be unusable, so the dialog probes the container itself (via the
 *  workspace service's container helper — one `docker exec`, no new one) and
 *  returns the sibling folders so the user can pick something that works. */
async function projectFolders(agentName, folderPath) {
  const row = agentRow(agentName); // throws mission_agent_not_found (404)
  assertMissionAgent(row.agent_type);
  assertPadRunning(agentName);
  const folder = normalizeFolder(folderPath || ''); // throws mission_bad_folder
  const listing = await workspace.listFolders(agentName, folder);
  return {
    path: folder,
    exists: !!listing.exists,
    isDir: !!listing.isDir,
    entries: Array.isArray(listing.entries) ? listing.entries : [],
  };
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
/**
 * The conversations that ALREADY happened in this project's folder, read from
 * the agent's own store (opencode.db / codex rollouts / claude jsonl) rather
 * than from `mission_sessions`.
 *
 * This is the difference between "Mission has no sessions" and "this agent has
 * 9 conversations in this folder": the agent keeps its history whether or not
 * Mission was ever used, so a project that points at a folder you have worked
 * in shows that work on arrival. Rows are the agent's own — resuming one opens
 * it in a tmux session and the conversation continues where it stopped.
 *
 * A PAD whose agent has never run a conversation reports `available: false`
 * with a reason instead of an error: "no history" is a normal state, not a
 * failure.
 */
async function agentHistory(projectId, { limit = 50, includeSubfolders = false } = {}) {
  const project = getProject(projectId);
  assertMissionAgent(project.agent_type);
  assertPadRunning(project.agent_name);
  const r = await workspace.listAgentSessions(project.agent_name, project.agent_type, project.folder, limit);
  if (r && r.error) throw new MissionError('mission_history_failed', r.error, 500);
  const exact = await withHistoryActivity(r.exact || [], project);
  return {
    projectId: project.id,
    agent: project.agent_name,
    agentType: project.agent_type,
    folder: project.folder,
    source: r.source,
    available: !!r.available,
    reason: r.reason || '',
    error: r.error || '',
    total: r.total || 0,
    exactCount: r.exactCount || 0,
    subfolderCount: r.subfolderCount || 0,
    exact,
    subfolders: includeSubfolders ? await withHistoryActivity(r.subfolders || [], project) : [],
  };
}

async function startSession(projectId, { label = '', origin = 'human', cols = 0, rows = 0, agentSessionId = '', createdBy = null } = {}) {
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
  // Resuming a conversation that already happened in this folder (the agent's own
  // history) vs. starting a fresh one. The id is kept on the row so a relaunch
  // after the TUI dies comes back to the SAME conversation instead of silently
  // dropping the user into an empty one.
  const resumeId = String(agentSessionId || '').trim();
  const launch = resumeId
    ? driver.tuiLaunch.resume({ sessionId: resumeId, cwd: project.folder })
    : driver.tuiLaunch.fresh({ cwd: project.folder });
  const session = createSession(project.id, { label, origin, agentSessionId: resumeId, createdBy });
  try {
    await padTmux.createSession(project.agent_name, session.tmux_id, { cwd: project.folder, cols, rows });
    await padTmux.sendCommand(project.agent_name, session.tmux_id, launch);
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
  // Back to the SAME conversation when the row remembers one — relaunching a
  // resumed session into a fresh TUI would quietly orphan the history.
  const launch = session.agent_session_id
    ? driver.tuiLaunch.resume({ sessionId: session.agent_session_id, cwd: project.folder })
    : driver.tuiLaunch.fresh({ cwd: project.folder });
  // The pane is not always rooted at the project folder: a tmux session that
  // was killed and then recreated (a terminal attaching to it re-creates it)
  // comes up in the PAD's default directory, and the agent would quietly work
  // in the wrong folder. The launch commands stay bare on purpose — the
  // CommandsPane pastes them into whatever pane the user is in — so the cd
  // belongs here, in the machine path, and only when the pane is off-target.
  const cmd = state.cwd && state.cwd !== project.folder ? `cd ${shq(project.folder)} && ${launch}` : launch;
  await padTmux.sendCommand(vmName, session.tmux_id, cmd);
  return { session: getSession(session.id), state: await padTmux.paneState(vmName, session.tmux_id) };
}

/** Bring a session whose pane is GONE back — same row, same tmux name, same
 *  agent conversation. A restart, not a new session: it keeps the mission
 *  session id (so bookmarks, the MCP and the agent's own message history all
 *  still point at it) and it recreates the pane rooted at the project folder,
 *  because a fresh tmux session otherwise inherits the PAD's default
 *  directory. Relaunch is for "the TUI exited"; this is for "the tmux session
 *  died", and the two are not interchangeable — relaunch refuses a dead
 *  session on purpose rather than resurrecting it in the wrong folder. */
async function restartSession(sessionId) {
  const { session, project, driver, vmName } = sessionTarget(sessionId);
  assertPadRunning(project.agent_name);
  const state = await padTmux.paneState(vmName, session.tmux_id);
  if (state.tuiAlive) {
    throw new MissionError('mission_tui_already_running', 'That session is already running its agent', 409);
  }
  // Check the folder before creating anything: the whole point of rooting the
  // pane here is that the agent works in this folder, and a folder deleted
  // since the project was made should say so instead of half-restarting.
  if (!(await padTmux.folderExists(vmName, project.folder))) {
    throw new MissionError(
      'mission_folder_missing',
      `The folder ${project.folder} no longer exists inside ${vmName} — fix the project's folder before restarting`,
      409
    );
  }
  if (state.live) await padTmux.killSession(vmName, session.tmux_id);
  await padTmux.createSession(vmName, session.tmux_id, { cwd: project.folder });
  const launch = session.agent_session_id
    ? driver.tuiLaunch.resume({ sessionId: session.agent_session_id, cwd: project.folder })
    : driver.tuiLaunch.fresh({ cwd: project.folder });
  await padTmux.sendCommand(vmName, session.tmux_id, launch);
  touchSession(session.id);
  return { session: getSession(session.id), state: await padTmux.paneState(vmName, session.tmux_id) };
}

/** Detect an opencode permission dialog in pane text (plan 62 1c).
 *  Observed shape: `△ Permission required / → Read .env / Path: .env /
 *  Allow once   Allow always   Reject   ⇆ select  enter confirm`.
 *  Returns null when no dialog, else { tool, path }. */
function detectPermission(text) {
  const t = String(text || '');
  if (!/permission required/i.test(t)) return null;
  if (!/allow\s+once/i.test(t)) return null;
  if (!/reject/i.test(t)) return null;
  let tool = '';
  let p = '';
  const arrow = t.match(/→\s*([^\n]+)/);
  if (arrow) tool = arrow[1].trim().slice(0, 120);
  const pathM = t.match(/Path:\s*([^\n]+)/i);
  if (pathM) p = pathM[1].trim().slice(0, 200);
  return { tool, path: p };
}

/** What a send would do to this session RIGHT NOW — the ONE place that answers
 *  it, so the refusal a caller is warned about and the refusal the write path
 *  throws cannot drift apart (plan 62 1a/1b/1c).
 *
 *  It exists because the two were computed separately: the detail view derived
 *  `canSend` from `open`, which only means "a TUI is attached", so a solo-locked
 *  row and a pane parked on a permission dialog both reported `canSend: true` —
 *  and then the write refused them. A verdict computed anywhere but the gate is
 *  a guess (the same shape as the gate-then-act split in the name resolver).
 *
 *  `open` deliberately does NOT absorb `locked` or a permission block. A locked
 *  session is very much OPEN — the human is driving it alone — and unlighting
 *  its dot would be a new lie pointed the other way. Those are facts about
 *  whether the AGENT may type, so they get their own field.
 *
 *  `perm` is optional because list mode cannot know it without a capture per
 *  row: the permission verdict exists only where a screen was already captured
 *  (detail mode). */
function sendVerdict(session, perm) {
  const label = session.label || session.tmux_id;
  if (session.live === false) {
    return { canSend: false, refusal: 'mission_session_dead: the tmux session is gone — restart it to get a fresh TUI' };
  }
  if (session.tuiAlive === false) {
    return {
      canSend: false,
      refusal: `mission_not_an_agent: ${label} is a shell (pane command: ${session.command || 'sh'}) — relaunch the TUI instead of typing shell commands`,
    };
  }
  if (session.locked) {
    return {
      canSend: false,
      refusal: 'mission_session_locked: solo-locked — the human is driving alone; they can unlock it on the Mission page',
    };
  }
  if (perm) {
    return {
      canSend: false,
      refusal: `mission_permission_pending: blocked on a permission prompt${perm.tool ? ` (${perm.tool}${perm.path ? ` ${perm.path}` : ''})` : ''} — use mission_permission_answer {choice: "once"|"reject"}`,
    };
  }
  return { canSend: true };
}

/** Type into a live session. The one writer path for the agent (mission_send)
 *  AND the API, so the solo lock is honoured in exactly one place.
 *  Plan 62: refuses a shell pane (1b, `mission_not_an_agent`), refuses a
 *  permission dialog (1c, `mission_permission_pending`), and confirms the pane
 *  took the text instead of a bare ok (1h, `mission_tui_not_ready`). */
async function sendText(sessionId, text) {
  const { session, project, vmName } = sessionTarget(sessionId);
  const where = ` [project:${project.name} (${project.id}) session:${session.id}]`;
  const body = String(text || '');
  if (!body.trim()) throw new MissionError('mission_empty_message', `Nothing to send${where}`);
  if (!(await padTmux.hasSession(vmName, session.tmux_id))) {
    throw new MissionError('mission_session_dead', `This session is gone — restart it to get a fresh TUI${where}`, 409);
  }
  const pre = await padTmux.paneState(vmName, session.tmux_id);
  if (!pre.live) {
    throw new MissionError('mission_session_dead', `This session is gone — restart it to get a fresh TUI${where}`, 409);
  }
  // ONE verdict, both surfaces. `pre` carries the live pane facts this gate has
  // already paid for, so folding them in costs no extra tmux call, and the
  // screen read below feeds the permission arm of the same check.
  const before = await padTmux.captureScreen(vmName, session.tmux_id, 20);
  const perm = detectPermission(before.text);
  const verdict = sendVerdict({ ...session, live: pre.live, tuiAlive: pre.tuiAlive, command: pre.command }, perm);
  if (!verdict.canSend) {
    const cut = verdict.refusal.indexOf(': ');
    throw new MissionError(verdict.refusal.slice(0, cut), `${verdict.refusal.slice(cut + 2)}${where}`, 409);
  }
  const sent = await padTmux.sendText(vmName, session.tmux_id, body);
  // Post-write confirmation (1h): prove the PANE CHANGED. Checking only that it
  // still exists is what produced `ok: true` for text that went nowhere — a live
  // pane is not an acknowledgement, and a TUI that is mid-turn repaints for its
  // own reasons, so the wait is bounded and the answer is honest either way.
  // This doubles as the post-send repaint wait (1g): the new content IS the
  // evidence, so there is no separate "force a repaint" step to get wrong.
  const baseline = before.text;
  const deadline = Date.now() + 1500;
  let after = await padTmux.captureScreen(vmName, session.tmux_id, 20);
  while (!after.live && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    after = await padTmux.captureScreen(vmName, session.tmux_id, 20);
  }
  if (!after.live) {
    throw new MissionError('mission_tui_not_ready', `The pane did not take the text (session gone after write)${where}`, 409);
  }
  while (after.text === baseline && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    after = await padTmux.captureScreen(vmName, session.tmux_id, 20);
    if (!after.live) {
      throw new MissionError('mission_tui_not_ready', `The pane did not take the text (session gone after write)${where}`, 409);
    }
  }
  if (after.text === baseline) {
    throw new MissionError(
      'mission_tui_not_ready',
      `The pane never changed after the write, so the TUI did not receive it — the session is live but not reading input${where}`,
      409
    );
  }
  touchSession(session.id);
  noteOutput(session.id, after.text);
  const fresh = getSession(session.id);
  return {
    session: { ...fresh, title: await sessionTitle(project, session) },
    project: { id: project.id, name: project.name },
    session_id: fresh.id,
    sent,
    confirmed: true,
    screen: after.text,
  };
}

/** Answer a permission dialog explicitly (plan 62 1c). Only "once" and
 *  "reject" are allowed from an agent caller — "always" is a durable policy
 *  change made by a machine and is refused. Targets by position: Home+Enter
 *  (first option, Allow once) or End+Enter (last option, Reject). */
/** Answer a permission dialog the pane is parked on (plan 62 1c) by KEY, never
 *  by typing text — text sent at a dialog lands in whatever it was waiting for
 *  and the TUI submits it.
 *
 *  `allowAlways` is the human's privilege. "Allow always" is a DURABLE policy
 *  change to a machine's permissions, so it is refused to an agent caller no
 *  matter what its key may do; the web UI route passes `allowAlways: true`
 *  because a person pressed the button. The default is the safe direction. */
async function answerPermission(sessionId, choice, { allowAlways = false } = {}) {
  const { session, project, vmName } = sessionTarget(sessionId);
  const where = ` [project:${project.name} (${project.id}) session:${session.id}]`;
  assertNotLocked(session);
  const want = String(choice || '').trim().toLowerCase();
  if (want !== 'once' && want !== 'reject' && !(allowAlways && want === 'always')) {
    throw new MissionError(
      'mission_permission_refused',
      `Refusing "${choice}": only "once" or "reject" may be answered by an agent — "Allow always" is a durable policy change${where}`
    );
  }
  const st = await padTmux.paneState(vmName, session.tmux_id);
  if (!st.live || !st.tuiAlive) {
    throw new MissionError('mission_session_dead', `No live agent pane to answer in${where}`, 409);
  }
  const cur = await padTmux.captureScreen(vmName, session.tmux_id, 40);
  if (!detectPermission(cur.text)) {
    throw new MissionError('mission_no_permission_pending', `No permission prompt is showing in ${session.id}${where}`, 409);
  }
  if (want === 'reject') {
    await padTmux.sendKeys(vmName, session.tmux_id, ['End', 'Enter']);
  } else if (want === 'always') {
    // Second of the three, not the last: once / always / reject.
    await padTmux.sendKeys(vmName, session.tmux_id, ['Down', 'Enter']);
  } else {
    await padTmux.sendKeys(vmName, session.tmux_id, ['Home', 'Enter']);
  }
  await new Promise((r) => setTimeout(r, 500));
  const after = await padTmux.captureScreen(vmName, session.tmux_id, 40);
  touchSession(session.id);
  return {
    session: getSession(session.id),
    project: { id: project.id, name: project.name },
    session_id: session.id,
    choice: want,
    screen: after.text,
    stillPending: !!detectPermission(after.text),
  };
}

/** One session in full: the pane's visible text, its live/tuiAlive/cwd state, and
 *  the SAME liveness truth the list paths stamp. Plan 62 1d: detail used to hand
 *  back a RAW row, so the list said `open: true` for a session the detail view
 *  said `open: false` — and worse, once `busy` started requiring `live`, a row
 *  with no `live` at all read as `state: 'dead'`, i.e. the detail view would have
 *  called every live session a corpse. Both panes are already probed here, so the
 *  row is stamped from `state` rather than paying for a second probe.
 *
 *  A permission dialog is reported as its own state (plan 62 1c) so a blocked
 *  session stops looking like idle capacity. */
async function screen(sessionId, lines = 40) {
  const { session, project, vmName } = sessionTarget(sessionId);
  const captured = await padTmux.captureScreen(vmName, session.tmux_id, lines);
  const state = await padTmux.paneState(vmName, session.tmux_id);
  const perm = detectPermission(captured.text);
  // A read that captured a pane has seen the agent's output, so it is a probe
  // AND an observation. `noteOutput` only moves `last_output_at` if the content
  // actually changed, so polling the detail view does not fake activity (1f).
  // The row was read BEFORE these writes, so returning it untouched would
  // report the clock this very call just moved as if it had not moved — stamp it
  // from the write's own result rather than re-reading.
  const advanced = captured.live ? noteOutput(session.id, captured.text) : null;
  if (captured.live) touchSession(session.id);
  // The probe is scoped to the PROJECT folder, so carry it on the row for the
  // cwd-vs-folder check inside stampTruth (1e).
  const row = stampTruth(
    {
      ...session,
      live: state.live === true,
      tuiAlive: state.tuiAlive,
      kind: state.tuiAlive === false ? 'shell' : 'agent',
      command: state.command,
      cwd: state.cwd,
      folder: project.folder,
    },
    await agentWorkingSessions(project.agent_name, project.folder)
  );
  if (advanced) row.last_output_at = advanced;
  // The SAME `sendVerdict` the write path gates on, fed the same permission
  // detection — so `canSend` cannot promise a send that would then be refused.
  // Computed here because this is the one place a screen was already captured;
  // list mode has no capture, so it carries no such claim.
  const verdict = sendVerdict(row, perm);
  return {
    session: { ...row, title: await sessionTitle(project, session) },
    state,
    screen: captured.text,
    live: captured.live,
    ...verdict,
    ...(perm ? { blockedOn: 'permission', permission: perm } : {}),
  };
}

/** The title the AGENT gives this conversation, distinct from the operator's
 *  `label` (plan 62 1i). A label is often empty or hand-typed and goes stale
 *  while the agent's own title changes, so a caller that only has a label is
 *  reading a name with no guarantee behind it. `''` when the driver cannot
 *  answer — never a fabricated one. */
async function sessionTitle(project, session) {
  if (!session.agent_session_id) return '';
  const d = drivers.getDriver(project.agent_type);
  if (!d || typeof d.sessionTitle !== 'function') return '';
  try {
    return await d.sessionTitle(project.agent_name, session.agent_session_id);
  } catch {
    return '';
  }
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

/** One truth for (live, busy, busyKnown, open) — plan 62 1a+1e.
 *  `busy` requires `live`: a dead row never reports busy, and `open` never
 *  counts a row `mission_send` will refuse (dead, or a live shell pane).
 *  `wasBusy` preserves the forensics (the server still claims the conversation)
 *  without lying on `busy`. `state: "dead"` makes the corpse explicit. */
function stampTruth(s, probe) {
  const live = s.live === true;
  if (!live) {
    const wasBusy = !!(s.agent_session_id && probe.ids.has(s.agent_session_id));
    return { ...s, busy: false, busyKnown: probe.known, open: false, state: 'dead', ...(wasBusy ? { wasBusy: true } : {}) };
  }
  // Live: a shell pane is reachable as a shell but `mission_send` refuses it,
  // so it is not `open` as an agent session. Unknown kind (no pane map, e.g. a
  // mocked PAD in tests) keeps the old `open = live` behaviour.
  if (s.tuiAlive === false) {
    return { ...s, busy: false, busyKnown: probe.known, open: false };
  }
  // Pane cwd is ground truth for the folder-scoped probe: when the pane runs
  // elsewhere, the probe scoped to the project folder cannot answer, so stamp
  // UNKNOWN, never idle (plan 62 1e).
  const folder = s.folder;
  if (probe.known && folder && s.cwd && s.cwd !== folder) {
    return { ...s, busy: false, busyKnown: false, open: s.tuiAlive !== false };
  }
  const busy = !!(s.agent_session_id && probe.ids.has(s.agent_session_id));
  return { ...s, busy, busyKnown: probe.known, open: s.tuiAlive !== false };
}

/** Live + pane map for one PAD in two execs (still O(PADs), never O(sessions)).
 *  `list-sessions` is authoritative for existence; `list-panes -a` adds the
 *  foreground command + cwd so list mode can carry kind without a per-row
 *  `paneState`. Either half failing leaves the other standing. */
async function liveAndPanes(vmName) {
  let names = new Set();
  let panes = new Map();
  try {
    names = new Set((await padTmux.listSessions(vmName)).map((r) => r.name));
  } catch {}
  try {
    if (typeof padTmux.listPanes === 'function') panes = await padTmux.listPanes(vmName);
  } catch {}
  return { names, panes };
}

function stampPaneKind(s, panes) {
  const info = panes.get(s.tmux_id);
  if (!info) return s;
  const tuiAlive = !padTmux.isShellCommand(info.command);
  const kind = tuiAlive ? 'agent' : 'shell';
  return { ...s, tuiAlive, kind, command: info.command, cwd: info.cwd };
}

/** Advance `last_seen_at` on every probe of a live pane (plan 62 1f): a field
 *  that looks like a heartbeat must move while the pane is alive. Batched to
 *  one UPDATE; failures never fail the list. */
function touchLiveRows(sessions) {
  try {
    const ids = (sessions || []).filter((s) => s.live === true && s.id).map((s) => s.id);
    if (!ids.length) return;
    const now = new Date().toISOString();
    const db = getDb();
    const stmt = db.prepare('UPDATE mission_sessions SET last_seen_at = ? WHERE id = ?');
    const tx = db.transaction((list) => {
      for (const id of list) stmt.run(now, id);
    });
    tx(ids);
    for (const s of sessions) if (s.live === true) s.last_seen_at = now;
  } catch {}
}

/** Stamp `live` (+ kind/cwd, plan 62 1b/1e) on every session of every project,
 *  at two tmux calls per PAD (`list-sessions` + `list-panes -a`) rather than
 *  two per session (`paneState`). A list page with 20 sessions across 4 PADs
 *  is 8 execs, not 40. */
async function withLive(projects) {
  const byPad = new Map();
  for (const p of projects) {
    if (!byPad.has(p.agent_name)) byPad.set(p.agent_name, { names: new Set(), panes: new Map() });
  }
  await Promise.all(
    [...byPad.keys()].map(async (vmName) => {
      byPad.set(vmName, await liveAndPanes(vmName));
    })
  );
  for (const p of projects) {
    const { names, panes } = byPad.get(p.agent_name) || { names: new Set(), panes: new Map() };
    p.sessions = (p.sessions || []).map((s) => stampPaneKind({ ...s, live: names.has(s.tmux_id) }, panes));
    touchLiveRows(p.sessions);
    p.liveCount = p.sessions.filter((s) => s.live).length;
  }
  return projects;
}

/** Stamp `live` (+ kind/cwd) on a plain session list (same O(PADs) budget). */
async function withLiveSessions(sessions, agentName) {
  if (!sessions.length) return sessions;
  const { names, panes } = await liveAndPanes(agentName);
  const out = sessions.map((s) => stampPaneKind({ ...s, live: names.has(s.tmux_id) }, panes));
  touchLiveRows(out);
  return out;
}

/** The same, for a list that spans SEVERAL PADs (the "All projects" scope).
 *  `agentOf` resolves a row to its agent — passing the agent list to
 *  `withLiveSessions` instead would ask one PAD about another PAD's sessions and
 *  mark every one of them dead. One `list-sessions` per distinct agent, so the
 *  cost is the number of PADs, not the number of sessions. */
async function withLiveSessionsByAgent(sessions, agentOf) {
  if (!sessions.length) return sessions;
  const byPad = new Map();
  for (const s of sessions) {
    const name = agentOf(s);
    if (name && !byPad.has(name)) byPad.set(name, null);
  }
  await Promise.all(
    [...byPad.keys()].map(async (vmName) => {
      byPad.set(vmName, await liveAndPanes(vmName));
    })
  );
  const out = sessions.map((s) => {
    const entry = byPad.get(agentOf(s)) || { names: new Set(), panes: new Map() };
    return stampPaneKind({ ...s, live: entry.names.has(s.tmux_id) }, entry.panes);
  });
  touchLiveRows(out);
  return out;
}

/* Which of a PAD's own opencode conversations are WORKING right now, keyed by
 * the agent's session id (`ses_…`) rather than by our tmux id.
 *
 *  `live` can only see our own terminal: it is a tmux session id, so a
 *  conversation the user is driving from the opencode **web UI** — chatting,
 *  thinking — has no tmux session at all and reads as closed. The opencode
 *  server already knows the truth for every client at once and publishes it at
 *  `GET /session/status` as `{ [sessionID]: { type: 'busy' | 'idle' | 'retry' } }`
 *  (schema `components.schemas.SessionStatus`, verified live). `retry` counts as
 *  working: the agent is still on that session, waiting to retry a provider
 *  call, so the dot belongs on.
 *
 *  Best effort BY DESIGN. No server, an unknown port, auth we cannot satisfy, a
 *  timeout, unparseable output — every one of those yields an empty set and
 *  `known: false`, and the listing renders exactly as it did before. This page
 *  is the one people keep open all day; it must never fail because a probe did.
 *  `known` is what lets the row's tooltip say "could not ask" instead of
 *  implying "idle", which is a lie the probe has no way to express.
 *
 *  The port is the PAD's own published `web.containerPort`, NEVER the driver
 *  default: the driver says 8080 while the server actually running in this PAD
 *  is on 7890, and the wrong port answers `{}` — "nothing is working" — forever,
 *  which looks exactly like the bug this was written to fix.
 *
 *  The call is scoped with `?directory=`, and that is not a filter we added for
 *  tidiness — it is the whole mechanism. Unscoped, the server answers `{}` even
 *  while a turn is streaming (verified: a 8.2s turn, 25 polls, `{}` throughout);
 *  scoped to the folder the turn is running in, the same poll returns
 *  `{"ses_…":{"type":"busy"}}` on the first try. A project row is scoped to a
 *  folder anyway, so this also keeps the probe at one call per project.
 *
 *  What the map does NOT contain: a session that is merely OPEN somewhere and
 *  idle. It is a live-work registry, not a presence list — it empties the moment
 *  the turn completes — and the server exposes no client/connection registry to
 *  ask instead. So the dot means "working now, or live in our own terminal",
 *  and an idle tab open in the web UI is not something the server can tell us.
 *
 *  The web password is read from INSIDE the container (`$OPENCODE_SERVER_PASSWORD`,
 *  the Web tab's "Server password", username always `opencode`) so the secret
 *  never appears on the host command line. Cached for a few seconds because the
 *  sessions and history endpoints are separate requests over the same 15s poll.
 */
const WORKING_TTL = 5000;
const WORKING_CACHE = new Map();

async function agentWorkingSessions(vmName, folder) {
  const none = { ids: new Set(), known: false };
  if (!vmName || !folder) return none;
  const key = `${vmName}::${folder}`;
  const hit = WORKING_CACHE.get(key);
  if (hit && Date.now() - hit.at < WORKING_TTL) return hit.value;

  let port = 0;
  let type = '';
  try {
    const agent = registry.getAgent(vmName);
    type = String(agent?.agent_type || agent?.type || '');
    port = parseInt(agent?.web?.containerPort, 10) || 0;
  } catch {
    /* fall through to the soft failure below */
  }
  // Only opencode publishes this. Every other agent type keeps mission liveness
  // alone, which is a real gap rather than a bug — hence `known: false`, never
  // a guess that the conversation is idle.
  if (!port || type !== 'opencode') {
    WORKING_CACHE.set(key, { at: Date.now(), value: none });
    return none;
  }

  // Percent-encoded in JS so a folder with a space or an `&` cannot smuggle
  // itself into the query string, and so the value that reaches the container's
  // shell is inert (only %XX, alphanumerics and . - _ ~ survive).
  const dir = encodeURIComponent(folder);
  let body = '';
  try {
    const r = await padTmux.padExec(
      vmName,
      [
        `p=${port}`,
        'u="http://127.0.0.1:$p/session/status?directory=' + dir + '"',
        'out=$(curl -s -m 5 "$u" 2>/dev/null)',
        'case "$out" in',
        `  '{'*) printf '%s' "$out" ;;`,
        '  *) if [ -n "$OPENCODE_SERVER_PASSWORD" ]; then',
        '       curl -s -m 5 -u "opencode:$OPENCODE_SERVER_PASSWORD" "$u" 2>/dev/null',
        '     fi ;;',
        'esac',
      ].join('\n'),
      { timeout: 9000, check: false }
    );
    body = String(r?.stdout || '');
  } catch {
    /* soft: the listing is not worth failing over a probe */
  }

  let parsed = null;
  try {
    parsed = JSON.parse(body || 'null');
  } catch {
    parsed = null;
  }
  const value =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? {
          ids: new Set(
            Object.entries(parsed)
              .filter(([, v]) => v && (v.type === 'busy' || v.type === 'retry'))
              .map(([k]) => k)
          ),
          known: true,
        }
      : none;
  WORKING_CACHE.set(key, { at: Date.now(), value });
  return value;
}

/** Stamp the agent's own view of "is this conversation working" onto a flat
 *  list of rows, keyed by `agent_session_id`. One probe per (PAD, folder) pair.
 *
 *  `open` is the marker the user actually asked for, and it is deliberately not
 *  a rename of `live`: `live` still means "we have a tmux session on this", and
 *  it still drives the terminal's Relaunch-vs-Restart and "session is gone"
 *  states. `open` is `live OR busy` — the dot — so nothing downstream changes
 *  meaning when the server is unreachable. */
async function withAgentBusy(sessions, agentOf, folderOf) {
  if (!sessions || !sessions.length) return sessions || [];
  // Grouped by (PAD, folder), NOT by PAD: several projects routinely share one
  // PAD — `paddock`, `schlorp` and `craftpip` all ran on `pad-opencode-proj` —
  // and the probe is scoped to a directory, so keying on the PAD alone would ask
  // about the first folder and stamp that answer on rows belonging to the
  // others. That failure is silent and reads as "nothing is working anywhere".
  const groups = new Map();
  const keyOf = sessions.map((s) => {
    const vm = agentOf(s);
    const folder = folderOf ? folderOf(s) : s.folder;
    if (!vm || !folder) return null;
    const key = JSON.stringify([vm, folder]);
    if (!groups.has(key)) groups.set(key, { vm, folder, value: null });
    return key;
  });
  await Promise.all(
    [...groups.values()].map(async (g) => {
      g.value = await agentWorkingSessions(g.vm, g.folder);
    })
  );
  return sessions.map((s, i) => {
    const g = groups.get(keyOf[i]);
    const p = (g && g.value) || { ids: new Set(), known: false };
    // Plan 62 1a+1e: one truth — busy requires live, cwd mismatch is unknown.
    // Carry the project folder on the row when the caller resolved it via
    // folderOf, so the cwd-vs-folder check has both sides.
    const folder = folderOf ? folderOf(s) : s.folder;
    return stampTruth({ ...s, folder: folder || s.folder }, p);
  });
}

/** The agent's OWN conversations (`agentHistory` rows) get the same dot, from the
 *  same probe — a history row is exactly the row a web UI chat shows up as, since
 *  the web UI never creates a tmux session for us.
 *
 *  Two ways such a row is open: the agent is working on it right now (`busy`),
 *  or it has already been resumed into one of THIS project's live sessions —
 *  which is the same `agent_session_id`, so the row and its resumed twin are one
 *  conversation, not two, and must not disagree about being open. */
async function withHistoryActivity(rows, project) {
  if (!rows || !rows.length) return rows || [];
  const vm = project.agent_name;
  const [probe, liveRows] = await Promise.all([
    agentWorkingSessions(vm, project.folder),
    padTmux.listSessions(vm).catch(() => []),
  ]);
  const liveNames = new Set((liveRows || []).map((r) => r.name));
  const resumedOpen = new Set(
    getDb()
      .prepare('SELECT tmux_id, agent_session_id FROM mission_sessions WHERE project_id = ?')
      .all(project.id)
      .filter((r) => r.agent_session_id && liveNames.has(r.tmux_id))
      .map((r) => r.agent_session_id)
  );
  return rows.map((r) => {
    const busy = probe.ids.has(r.id);
    return { ...r, busy, busyKnown: probe.known, open: busy || resumedOpen.has(r.id) };
  });
}

/** The same, for the nested project shape (`listProjects`). Projects own the PAD
 *  name AND the folder, so both are carried on for the flat call — the probe is
 *  scoped to a folder, and asking the wrong one answers `{}`. */
async function withAgentBusyProjects(projects) {
  if (!projects || !projects.length) return projects || [];
  const rows = [];
  projects.forEach((p, pi) => (p.sessions || []).forEach((s, si) => rows.push({ pi, si, s, vm: p.agent_name })));
  // Probe only when there is something to probe. The early `return projects` this
  // replaced short-circuited the COUNTING too, so a fleet where no project had
  // sessions came back with no `openCount` on any row — and a count that is
  // present for one project and absent for the next reads as "unknown".
  const at = new Map();
  if (rows.length) {
    const stamped = await withAgentBusy(
      rows.map((r) => ({ ...r.s, agent_name: r.vm, folder: projects[r.pi].folder })),
      (r) => r.agent_name,
      (r) => r.folder
    );
    rows.forEach((r, i) => at.set(`${r.pi}:${r.si}`, stamped[i]));
  }
  return projects.map((p, pi) => {
    // A caller that handed us no sessions at all gets no opinion (we did not
    // look), but a project that HAS zero sessions has, definitively, zero open —
    // so say `0` rather than omitting the field.
    if (!p.sessions) return p;
    if (!p.sessions.length) return { ...p, openCount: 0 };
    const sessions = p.sessions.map((s, si) => {
      const extra = at.get(`${pi}:${si}`) || {};
      const { agent_name, folder, ...rest } = extra;
      return { ...s, ...rest };
    });
    return { ...p, sessions, openCount: sessions.filter((s) => s.open).length };
  });
}

/** Stop a session for good: kill the tmux session first, then drop the row, so
 *  a delete never leaves a TUI running in a PAD. */
async function closeSession(sessionId) {
  const { session, vmName } = sessionTarget(sessionId);
  await padTmux.killSession(vmName, session.tmux_id);
  return deleteSession(session.id);
}

/** Every live session across every project, each row tagged with the project it
 *  belongs to. The Mission page's "All projects" scope: same rows as the
 *  per-project list, so a session started anywhere shows up in one place
 *  instead of only under the project you happen to have selected.
 *
 *  `allow` is the access filter (see app.js `canTouchAgent`) — a user must never
 *  see another user's sessions, so the join is done here in the service rather
 *  than in the client, which has no idea what it is allowed to see. */
function listAllSessions({ allow = null } = {}) {
  const projects = listProjects();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const visible = (p) => p && (!allow || allow(p.agent_name));
  const rows = listSessions({}).filter((s) => visible(byId.get(s.project_id)));
  return {
    projects: projects.filter(visible).map(projectTag),
    sessions: rows.map((s) => ({
      ...s,
      project: projectTag(byId.get(s.project_id)),
    })),
  };
}

function projectTag(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    agent_name: p.agent_name,
    agent_type: p.agent_type,
    folder: p.folder,
  };
}

/** Every project's own-store conversations, merged and date-sorted, so the
 *  "All projects" scope answers "what have I worked on" and not only "what is
 *  running right now".
 *
 *  One failing project must not blank the column: a stopped PAD, an agent with
 *  no store, or an unreadable folder comes back as an `errors` entry while the
 *  other projects' conversations are still listed. Promise.allSettled rather
 *  than a plain Promise.all for exactly that reason. */
async function allAgentHistory({ limit = 50, includeSubfolders = false, allow = null } = {}) {
  const projects = listProjects().filter((p) => !allow || allow(p.agent_name));
  const settled = await Promise.allSettled(
    projects.map((p) => agentHistory(p.id, { limit, includeSubfolders }))
  );

  const errors = [];
  const conversations = []
  let subfolderCount = 0;
  let exactCount = 0;
  let readable = 0;
  settled.forEach((r, i) => {
    const p = projects[i];
    if (r.status === 'rejected') {
      errors.push({ project: projectTag(p), error: r.reason?.message || String(r.reason || 'Could not read history') });
      return;
    }
    const h = r.value;
    if (!h.available) {
      // Not an error — an agent that has never been chatted with simply has
      // nothing. Saying so per project keeps the list honest instead of
      // implying the folder was empty because a read failed.
      if (h.reason) errors.push({ project: projectTag(p), error: h.reason });
      return;
    }
    readable++;
    const tag = projectTag(p)
    // The COUNTS are summed from what the agent reports, not from the rows that
    // came back: `agentHistory` returns no subfolder rows at all until they are
    // expanded, so counting the rows would show "0 more in subfolders" and the
    // expander — the thing that reveals them — would never appear.
    exactCount += h.exactCount || h.exact.length;
    subfolderCount += h.subfolderCount || 0;
    for (const c of h.exact || []) conversations.push({ ...c, project: tag, subfolder: false });
    for (const c of h.subfolders || []) conversations.push({ ...c, project: tag, subfolder: true });
  });

  // Newest first across every project. `updatedAt` is what the list already
  // shows, so it is what it is sorted by — the column must not jump around
  // relative to the numbers next to the rows.
  conversations.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  return {
    conversations,
    errors,
    projectCount: projects.length,
    // False only when NOTHING could be read. "No history yet" must not be the
    // message for a read that failed — the caller shows `errors` instead.
    available: readable > 0,
    // The count the column displays: what the agents say exists, across every
    // project, not the number of rows one request happened to return.
    exactCount,
    subfolderCount,
    total: exactCount + subfolderCount,
    includeSubfolders,
  };
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
  listAllSessions,
  updateSession,
  assertNotLocked,
  deleteSession,
  getSessionByTmux,
  touchSession,
  noteOutput,
  startSession,
  projectFolders,
  agentHistory,
  allAgentHistory,
  relaunchTui,
  restartSession,
  sendText,
  answerPermission,
  detectPermission,
  screen,
  state,
  statesFor,
  stampTruth,
  withLive,
  withLiveSessions,
  withLiveSessionsByAgent,
  agentWorkingSessions,
  withAgentBusy,
  withAgentBusyProjects,
  closeSession,
};
