const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getDb } = require('./db');
const drivers = require('./drivers');
const padTmux = require('./pad-tmux');
const registry = require('./agent-registry');
const workspace = require('./workspace');
const agentStore = require('./agent-store');
const plans = require('./plans');
const promptTemplates = require('./prompt-templates');
const runnerCallbacks = require('./runner-callbacks');
const runnerHistory = require('./runner-history');
const runnerQueue = require('./runner-queue');
const runnerTransition = require('./runner-transition');
const runnerView = require('./runner-view');
const { REVIEWABLE_STATES } = require('./runner-state');
const runnerPublication = require('./runner-publication');

/** Look up a PAD by name, throwing if not found (shared with plans.js). */
function requireAgent(name) {
  const agent = registry.getAgent(name);
  if (!agent) {
    throw new MissionError('mission_agent_not_found', `Agent not found: ${name}`);
  }
  return agent;
}

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
  constructor(code, message, status = 400, meta = null) {
    super(message || code);
    this.code = code;
    this.status = status;
    // Plan 88 §Phase 2: a delivery outcome is not a boolean. `attempted` says
    // whether input was written to the pane; `acceptance` says whether we could
    // CONFIRM receipt ('confirmed' | 'unknown' | 'refused'). Serialized verbatim
    // by the REST and MCP error paths so a caller can offer recovery without
    // guessing from the message text.
    if (meta && typeof meta === 'object') Object.assign(this, meta);
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

/** The project's own plans directory, RELATIVE to its folder (plan 82). Unlike
 *  the folder it must NOT be absolute: it is the agent's working subfolder, so
 *  an absolute value or a `..` escape would point plans somewhere outside the
 *  project — the one thing the resolution code treats as a refusal. An empty
 *  value means "the default", never an error: every project in the database
 *  predates the choice, and the documented default IS what they all use. */
function normalizePlansFolder(plansFolder) {
  let p = String(plansFolder ?? '').trim();
  if (!p) return 'plans';
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (path.isAbsolute(p)) {
    throw new MissionError('mission_bad_plans_folder', 'The plans folder must be relative to the project folder');
  }
  if (p.split('/').some((s) => s === '.' || s === '..')) {
    throw new MissionError('mission_bad_plans_folder', '". " and ".." are not allowed in the plans folder');
  }
  if (p.includes('\n') || p.includes('\0')) {
    throw new MissionError('mission_bad_plans_folder', 'The plans folder contains illegal characters');
  }
  if (p.length > 120) throw new MissionError('mission_bad_plans_folder', 'The plans folder is too long');
  return p;
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
function createProject({ name, agent, folder, plansFolder, createdBy = null, defaultFolder = '' }) {
  const projectName = String(name || '').trim();
  if (!projectName) throw new MissionError('mission_bad_name', 'A project needs a name');
  if (projectName.length > 120) throw new MissionError('mission_bad_name', 'Project name is too long');

  const agentName = String(agent || '').trim();
  const row = agentRow(agentName);
  const driver = assertMissionAgent(row.agent_type);

  const dir = normalizeFolder(folder || defaultFolder || driver.workspaceDir || '');
  const plansDir = normalizePlansFolder(plansFolder);

  const id = newId('prj');
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mission_projects (id, name, agent_name, agent_type, folder, plans_folder, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectName, row.name, row.agent_type, dir, plansDir, createdBy, now, now);
  const project = getProject(id);
  audit(project, 'project_create', { actor: createdBy, details: dir });
  return project;
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
function updateProject(id, { name, folder, plansFolder } = {}) {
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
  if (plansFolder !== undefined) {
    sets.push('plans_folder = ?');
    params.push(normalizePlansFolder(plansFolder));
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
function createSession(projectId, opts = {}) {
  return insertSession(projectId, opts).session;
}

/** The insert, told whether it actually made the row.
 *
 *  A caller that can be retried (plan 65 1f) must not learn "your key already
 *  existed" as a bare row: it has a row either way, and the difference decides
 *  whether it goes on to create a tmux session. Handing back only the row made
 *  the concurrent path a silent SECOND launch into the winner's pane — the exact
 *  duplicate the key exists to prevent, reached through the race rather than the
 *  retry. `createSession` keeps the row-only shape for every other caller. */
/** One audit row per Mission action that acts ON a conversation (plan 52 E1).
 *  `activity_events` already had a table, a writer and a reader, but its `actor`
 *  column had never been set by anything — so all 702 rows said `system` and the
 *  log could not answer the only question an audit log exists for: was that the
 *  human, or a key? This is the record that makes law 2 ("only the orchestrator
 *  holds the exec bucket") checkable after the fact rather than merely asserted.
 *
 *  The content of a `send` is deliberately NOT recorded: the text is the human's
 *  conversation, it can hold secrets they pasted, and an audit trail is not a
 *  second copy of it. What is recorded is that a typed line happened, who typed
 *  it, and which session. A `send` also records its length, so "one line, 4
 *  characters" is auditable without the text being readable. */
function audit(project, action, { actor = null, session = null, details = '' } = {}) {
  try {
    registry.recordActivity(
      project.agent_name,
      'mission',
      action,
      'ok',
      details || null,
      session ? session.id : project.id,
      actor || 'system'
    );
  } catch (e) {
    // An audit row must never be the reason a conversation is not worked. The
    // action already happened; failing the call here would report a refusal for
    // something that was typed.
  }
}

function insertSession(projectId, { label = '', origin = 'human', tmuxId = '', agentSessionId = '', createdBy = null, idempotencyKey = null } = {}) {
  const project = getProject(projectId);
  const who = origin === 'agent' ? 'agent' : 'human';
  const tid = tmuxId || newTmuxId();
  if (!TMUX_RE.test(tid)) throw new MissionError('mission_bad_session', 'Bad session name');
  const id = newId('msn');
  try {
    getDb()
      .prepare(
        `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, created_by, agent_session_id, created_at, last_seen_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        new Date().toISOString(),
        idempotencyKey ? String(idempotencyKey).slice(0, 200) : null
      );
  } catch (e) {
    // The unique index is the authority, and this is the race two CONCURRENT
    // calls with one key hit — the check-before-insert above cannot see a
    // sibling that has not committed yet. A duplicate here is the retry the key
    // was invented for, not a failure, so the caller's own row comes back rather
    // than a SQLITE_CONSTRAINT the caller cannot interpret.
    if (idempotencyKey && /UNIQUE|constraint/i.test(String(e && e.message))) {
      const prior = getSessionByIdempotencyKey(project.id, String(idempotencyKey));
      if (prior) return { session: prior, deduped: true };
    }
    throw e;
  }
  return { session: getSession(id), deduped: false };
}

/** The row a retry token already made (plan 65 1f). `live` is deliberately NOT
 *  checked: a session whose pane has not come up yet is precisely the one a
 *  timed-out caller is trying to find, and treating it as absent would hand back
 *  the duplicate this exists to prevent. */
function getSessionByIdempotencyKey(projectId, key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return getDb()
    .prepare('SELECT * FROM mission_sessions WHERE project_id = ? AND idempotency_key = ?')
    .get(String(projectId), k) || null;
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

/** Every session on ONE pad, each carrying its project (so the busy probe can be
 *  scoped to the right FOLDER and the caller never has to re-derive either).
 *
 *  This exists because "the sessions of this pad" is a question other surfaces
 *  ask without going through a project id — the plans facility, whose plans bind
 *  to an agent conversation id and have no project of their own. Building it
 *  here rather than in the caller keeps the agent→project mapping in ONE place:
 *  a caller that filtered `listSessions()` by hand would have to re-derive the
 *  project join, and the miss is a session marked dead because it belongs to a
 *  project the caller did not recognise. */
function listSessionsForAgent(agentName) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.* FROM mission_sessions s
        JOIN mission_projects p ON p.id = s.project_id
       WHERE p.agent_name = ?
       ORDER BY s.created_at DESC, s.rowid ASC`
    )
    .all(String(agentName));
  const projects = new Map(
    db.prepare('SELECT * FROM mission_projects WHERE agent_name = ?').all(String(agentName)).map((p) => [p.id, p])
  );
  return rows.map((s) => ({ ...s, project: projects.get(s.project_id) || null, live: null }));
}

/** Label and/or the solo lock. `locked` is the one privacy control in the
 *  feature: the agent may still READ a locked session, it just may not type
 *  into it (mission.js's send path is the only writer, and it checks here). */
function updateSession(id, { label, locked } = {}) {
  const session = getSession(id);
  if (locked === true) {
    const bound = getDb().prepare('SELECT id FROM infinite_runners WHERE session_id = ?').get(session.id);
    const runtime = bound && runnerTransition.getRuntime(bound.id);
    if (bound && runtime && !['paused', 'waiting_input', 'held', 'complete', 'projection_error'].includes(runtime.state)) {
      runnerTransition.applyPause(bound.id, { actor: 'session-lock', details: { reason: 'Worker session solo-locked.' } });
      runnerTransition.setReason(bound.id, 'session_locked', 'Session solo-locked; Run again after unlocking.');
      syncQueuePausedMarker(bound.id, true);
    }
  }
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
  const body = String(text || '');
  const hash = crypto.createHash('sha1').update(body).digest('hex');
  const db = getDb();
  const row = db.prepare('SELECT last_output_hash FROM mission_sessions WHERE id = ?').get(String(id));
  if (!row) return null;
  if (row.last_output_hash === hash) return null;
  // The timestamp is computed ONCE and both stored and returned. Computing it
  // again for the response would let the two differ by a millisecond, and a
  // caller that compared the row it was handed against a later read would see a
  // change nobody made.
  const at = new Date().toISOString();
  // The screen travels with its clock (plan 65 1a). Storing it HERE rather than
  // in a teardown path is the whole design: `noteOutput` is called by the reads
  // that have already captured a pane (the detail screen, the post-write
  // confirmation), so this is the last thing the agent was seen saying — with no
  // hook to lose and nothing extra to probe. It rides the hash check for free,
  // because the content is only written when the content actually changed.
  //
  // Clamped, because a pane is a fixed size but a row is forever: an unbounded
  // capture would put a few KB of terminal scrollback into every listing read.
  // Whether we cut it is STORED, not implied: a screen that ended where we cut it
  // and a screen we trimmed to fit read identically otherwise, and the difference
  // decides whether the top line is a real message or half of one.
  const cap = SCREEN_STORE_LIMIT;
  const truncated = body.length > cap ? 1 : 0;
  const keep = truncated ? body.slice(body.length - cap) : body;
  db.prepare(`UPDATE mission_sessions SET last_output_at = ?, last_output_hash = ?,
      last_screen = ?, last_screen_at = ?, last_screen_truncated = ? WHERE id = ?`)
    .run(at, hash, keep, at, truncated, String(id));
  return at;
}

/** How much of the last pane a row keeps. A pane is a fixed size, so a full
 *  capture is bounded already; this is the belt-and-braces cap for a driver that
 *  hands back more than a screen (scrollback, or a very wide terminal), because
 *  every session row carries this text into every listing. */
const SCREEN_STORE_LIMIT = 8000;

/** Record how a session's LIFE ended, and stamp the moment we first saw it gone
 *  (plan 65 1b). Two writers, one function, so the two can never disagree:
 *
 *  - `endSessionsForPad` (below) names `recreate` — a death we CAUSED, dated
 *    exactly, before the container goes.
 *  - `stampEnded` runs from the liveness pass and names `gone` — the first
 *    observation, which is an upper bound on when it actually happened. A caller
 *    must not read `endedAt` as the instant of death, and the tool description
 *    says so; a value we can defend beats a value we would have to invent.
 *
 *  A row that comes back (the pane was recreated, the tmux server restarted)
 *  has its stamps CLEARED, because "ended" and "live" must never both be true on
 *  the same row — that pair is a contradiction a caller cannot resolve. */
function endSessions(ids, by, { at = null, reason = null } = {}) {
  const list = (ids || []).filter(Boolean).map(String);
  if (!list.length) return 0;
  const stamp = at || new Date().toISOString();
  const db = getDb();
  const stmt = db.prepare('UPDATE mission_sessions SET ended_at = ?, ended_by = ? WHERE id = ? AND ended_at IS NULL');
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const id of rows) n += stmt.run(stamp, by, id).changes;
    return n;
  });
  try {
    return tx(list);
  } catch {
    return 0;
  }
}

/** Un-end the rows that are demonstrably alive again. Called from the liveness
 *  pass with the same `live` flag that produced the row the caller is about to
 *  read, so the row in hand and the row in the table cannot disagree. */
/** Date the sessions a `recreate` is about to take, and hand back what it took
 *  (plan 65 1d).
 *
 *  Every tmux session on a PAD dies with its container, including live
 *  conversations the human is looking at — and until this existed nothing said
 *  so, in the tool description or the response. So the response names the field,
 *  the rows are dated (`ended_by: 'recreate'`, the ONE death we can date
 *  exactly), and the caller can read the cost of the change it just made in the
 *  same call that made it.
 *
 *  Called BEFORE the recreate, because afterwards there is nothing left to ask.
 *
 *  A recreate that then FAILS leaves rows stamped as ended that are still alive
 *  — and that heals itself: the liveness pass clears the stamps of every row it
 *  finds live, so the next read is right. Stamping early is still the better
 *  trade, because the opposite order (kill, then ask) has no rows left at all.
 *
 *  Only LIVE rows are stamped. A row that was already dead carries its own death
 *  — `gone`, or `closed` — and re-dating it `recreate` would overwrite a real
 *  event with a later, unrelated one. */
async function endSessionsForPad(vmName, by = 'recreate') {
  const projects = listProjects({ agent: vmName });
  const rows = [];
  for (const p of projects) {
    for (const s of listSessions({ projectId: p.id })) rows.push({ ...s, projectName: p.name, agentName: p.agent_name });
  }
  if (!rows.length) return [];
  const live = await withLiveSessionsByAgent(rows, (s) => s.agentName);
  const dying = live.filter((s) => s.live === true);
  if (!dying.length) return [];
  endSessions(dying.map((s) => s.id), by);
  return dying.map((s) => ({
    id: s.id,
    tmux_id: s.tmux_id,
    label: s.label || '',
    project: { id: s.project_id, name: s.projectName },
    // The service rides the agent name so a caller can scope the report to what
    // its own key may see — a recreate on a pad it does not own must not print
    // somebody else's session ids. The MCP layer drops it again.
    agentName: s.agentName,
    // The screen is NOT captured here on purpose: it would cost one tmux exec
    // per session inside an operation that is already long, and the stored tail
    // plus its clock is the honest answer — `lastScreen: null` says "we never
    // captured this one" rather than inventing a screen for a corpse.
    lastScreen: s.last_screen || null,
    lastScreenAt: s.last_screen_at || null,
  }));
}

function clearEnded(liveIds) {
  const list = (liveIds || []).filter(Boolean).map(String);
  if (!list.length) return 0;
  const db = getDb();
  const stmt = db.prepare('UPDATE mission_sessions SET ended_at = NULL, ended_by = NULL WHERE id = ? AND ended_at IS NOT NULL');
  const tx = db.transaction((rows) => {
    let n = 0;
    for (const id of rows) n += stmt.run(id).changes;
    return n;
  });
  try {
    return tx(list);
  } catch {
    return 0;
  }
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

async function startSession(projectId, { label = '', origin = 'human', cols = 0, rows = 0, agentSessionId = '', createdBy = null, idempotencyKey = '' } = {}) {
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
  // Plan 65 1f — the retry token. A client-side timeout cannot be shortened from
  // here, and a timed-out call has NO response to help the caller, so the only
  // place the duplicate can be prevented is the retry itself: the caller sends
  // the same key and gets its existing row back instead of a second tmux session
  // burning a second conversation's tokens.
  //
  // The window this closes is not hypothetical and not small: the row and the
  // tmux session exist well before the pane is up, so the slow part (the TUI
  // coming up) is exactly what a client is most likely to time out on.
  const key = String(idempotencyKey || '').trim() || null;
  if (key) {
    const prior = getSessionByIdempotencyKey(project.id, key);
    if (prior) {
      // Report it as the SAME session with the facts a caller needs to decide
      // whether to keep waiting or to look at it — `resumed: false` is what
      // separates "you already had this" from a fresh start.
      return {
        session: getSession(prior.id),
        state: await padTmux.paneState(project.agent_name, prior.tmux_id),
        deduped: true,
      };
    }
  }
  // Plan 52 C1-F1 — mint the conversation BEFORE the pane exists, so the row
  // carries its id from the first read.
  //
  // `opencode` invents a conversation id when its TUI starts and never reports
  // it, so a fresh start used to leave `agent_session_id` NULL forever. Nothing
  // downstream could then intersect the agent's live-work map, so every later
  // read of that row answered `busy: false, busyKnown: true` — a confident
  // "I looked, it is idle" for a pane that was visibly mid-turn — and the title
  // and relaunch-resume were lost with it.
  //
  // Ordering matters and is the point: the conversation is created only AFTER
  // the dedup check, so a retry never mints a second one, and it is created
  // BEFORE the TUI launches, so the TUI is launched INTO it (`-s <id>`) rather
  // than being asked afterwards which of several new conversations in this
  // folder it meant. Best effort by design — a failure here leaves the old
  // behaviour (a start with no id) rather than failing the start itself.
  let startId = resumeId;
  if (!startId && typeof driver.createConversation === 'function') {
    let port = 0;
    try {
      port = parseInt(registry.getAgent(project.agent_name)?.web?.containerPort, 10) || 0;
    } catch {
      /* no published port — fall back to a start without an id */
    }
    startId = (await driver.createConversation(project.agent_name, project.folder, port)) || '';
  }
  const launch = startId
    ? driver.tuiLaunch.resume({ sessionId: startId, cwd: project.folder })
    : driver.tuiLaunch.fresh({ cwd: project.folder });
  const { session, deduped } = insertSession(project.id, { label, origin, agentSessionId: startId, createdBy, idempotencyKey: key });
  // The sibling committed between the check above and this insert. Its pane is
  // already being brought up, so this call must not bring up a second one in the
  // same tmux id — report the winner's row and the state as it stands.
  if (deduped) {
    return { session: getSession(session.id), state: await padTmux.paneState(project.agent_name, session.tmux_id), deduped: true };
  }
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
  audit(project, 'session_start', { actor: createdBy, session, details: origin });
  return { session: getSession(session.id), state };
}

/** Re-launch the TUI in a session whose TUI exited (the pane dropped back to
 *  the shell). Refuses when a TUI is already running — retyping the command
 *  would start a second conversation in the same pane. */
async function relaunchTui(sessionId, { actor = null, beforeLaunch = null } = {}) {
  const { session, project, driver, vmName } = sessionTarget(sessionId);
  const state = await padTmux.paneState(vmName, session.tmux_id);
  if (!state.live) {
    throw new MissionError('mission_session_dead', 'This session is gone — mission_session_restart brings it back (this tool needs a LIVE pane)', 409);
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
  if (beforeLaunch) beforeLaunch();
  await padTmux.sendCommand(vmName, session.tmux_id, cmd);
  audit(project, 'session_relaunch', { actor, session });
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
async function restartSession(sessionId, { actor = null, beforeLaunch = null } = {}) {
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
  if (beforeLaunch) beforeLaunch();
  if (state.live) await padTmux.killSession(vmName, session.tmux_id);
  await padTmux.createSession(vmName, session.tmux_id, { cwd: project.folder });
  const launch = session.agent_session_id
    ? driver.tuiLaunch.resume({ sessionId: session.agent_session_id, cwd: project.folder })
    : driver.tuiLaunch.fresh({ cwd: project.folder });
  if (beforeLaunch) beforeLaunch();
  await padTmux.sendCommand(vmName, session.tmux_id, launch);
  touchSession(session.id);
  // The resurrection clears the death (plan 65 1b). The liveness pass would do
  // this on the next read, but the row handed back HERE is read immediately —
  // and a row that says `endedAt` and `live: true` at the same time is a
  // contradiction the caller cannot resolve.
  clearEnded([session.id]);
  audit(project, 'session_restart', { actor, session, details: session.agent_session_id ? 'resumed conversation' : 'new conversation (row has no agent session id)' });
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
    return { canSend: false, refusal: 'mission_session_dead: the tmux session is gone — bring it back with mission_session_restart (same row, same conversation)' };
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

/**
 * Poll the agent's store for new activity after a baseline timestamp.
 * Returns true if new activity (user message, assistant message, or tool call)
 * is detected within the deadline. This correlates acceptance to the EXACT
 * conversation, avoiding false positives from unrelated pane repaints.
 *
 * Plan 91 §Phase 5: the poll gets its own budget, granted at poll time — the
 * repaint wait consumed time meant for repainting, and a leftover deadline
 * would false-negative a message whose store write lagged the repaint.
 */
const STORE_CONFIRM_BUDGET_MS = 15000;

/** Plan 114 §1: the EXACT input receipt (a new user message whose text hashes to
 *  what we sent) can land in the store a moment after `sendText` returns —
 *  `sendText` confirms on "some new activity", which the TUI writes before the
 *  user message's parts are readable. A single read there reported a delivered
 *  instruction as `mission_send_unconfirmed` on every live dispatch, and only a
 *  later reconcile matched the same hash. Poll briefly instead. `stillOwned`
 *  stops the wait the moment Pause/Close or a newer operation takes over.
 *  Returns the matching turn, or null when the budget ran out. */
let RECEIPT_POLL_BUDGET_MS = 5000;
let TUI_READY_BUDGET_MS = 15000;
function _setTuiReadyBudget(ms) { TUI_READY_BUDGET_MS = ms; }
const RECEIPT_POLL_INTERVAL_MS = 250;
async function awaitExactReceipt(agent, conversationId, baselineUserId, expectedHash, { stillOwned = () => true } = {}) {
  const deadline = Date.now() + RECEIPT_POLL_BUDGET_MS;
  for (;;) {
    const turn = agentStore.readTurn(agent, conversationId);
    if (turn.userId && turn.userId !== baselineUserId && turn.inputHash === expectedHash) return turn;
    if (Date.now() >= deadline || !stillOwned()) return null;
    await new Promise((r) => setTimeout(r, RECEIPT_POLL_INTERVAL_MS));
  }
}
function _setReceiptPollBudget(ms) { RECEIPT_POLL_BUDGET_MS = ms; }

/** Plan 117: make sure the project's pad has the runner MCP surface
 *  (`paddock_runner` → `/mcp/runner`, a per-pad token) connected. No user step.
 *  Returns `{ state: 'connected', changed }`, `{ state: 'failed', detail }`, or
 *  `{ state: 'unknown', detail }` (probe could not run — never blocks Run).
 *  Drivers without the hooks are reported unknown. */
async function ensureRunnerMcp(project) {
  const driver = assertMissionAgent(project.agent_type);
  if (typeof driver.mcpServerStatus !== 'function' || typeof driver.connectMcpServer !== 'function') {
    return { state: 'unknown', detail: `${project.agent_type} cannot be wired automatically` };
  }
  const { getRunnerMcpUrl, RUNNER_MCP_SERVER } = require('./paddock-mcp');
  const before = await driver.mcpServerStatus(project.agent_name, project.folder, RUNNER_MCP_SERVER);
  if (before.state === 'connected') return { state: 'connected', changed: false };
  if (before.state === 'unknown') return before;
  const token = require('./runner-mcp-token').mint(project.agent_name);
  const wired = await driver.connectMcpServer(project.agent_name, { server: RUNNER_MCP_SERVER, url: getRunnerMcpUrl(), token, folder: project.folder });
  const after = await driver.mcpServerStatus(project.agent_name, project.folder, RUNNER_MCP_SERVER);
  if (after.state === 'connected') return { state: 'connected', changed: true };
  const tail = String(wired.output || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
  return {
    state: 'failed',
    detail: `installing the runner MCP server (${getRunnerMcpUrl()}) in ${project.agent_name} did not connect: ${after.detail}${tail ? ` (${tail})` : ''}. Check that the pad can reach this Paddock host (HOST_NAME in .env), then press Run again.`,
  };
}

async function confirmDeliveryViaStore(agentName, agentSessionId, baselineActivityAt, deadline) {
  if (!agentSessionId) return false;
  while (Date.now() < deadline) {
    try {
      const activity = await agentStore.readActivity(agentName, agentSessionId);
      if (activity?.store?.available && activity.lastActivityAt) {
        const latest = Date.parse(activity.lastActivityAt);
        const baseline = baselineActivityAt ? Date.parse(baselineActivityAt) : 0;
        if (Number.isFinite(latest) && latest > baseline) {
          return true;
        }
      }
    } catch {
      // Store read failed; treat as unknown (caller decides)
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Type into a live session. The one writer path for the agent (mission_send)
 *  AND the API, so the solo lock is honoured in exactly one place.
 *  Plan 62: refuses a shell pane (1b, `mission_not_an_agent`), refuses a
 *  permission dialog (1c, `mission_permission_pending`), and confirms the pane
 *  took the text instead of a bare ok (1h, `mission_tui_not_ready`).
 *  Plan 88 §Phase 2: the outcome is a three-state, not a boolean. A pre-write
 *  refusal throws a refusal code; a write we OBSERVED throws nothing and returns
 *  `acceptance: 'confirmed'`; a write we could not observe throws
 *  `mission_send_unconfirmed` with `{ attempted: true, acceptance: 'unknown' }`.
 *  Absence of a repaint is NOT non-delivery, so the last case must never be
 *  phrased as "the TUI did not receive it" and must never invite a blind resend.
 *  Acceptance is confirmed ONLY when the agent's store shows new activity for
 *  this exact conversation after the write — pane repaint alone is not enough,
 *  and a repaint with no transcript for the conversation is unconfirmed (a
 *  booting TUI repaints for itself). The single exception is a store layout
 *  the webui cannot see at all, where repaint is the only signal available. */
async function sendText(sessionId, text, { actor = null, beforeWrite = null, paste = false } = {}) {
  const { session, project, driver, vmName } = sessionTarget(sessionId);
  const where = ` [project:${project.name} (${project.id}) session:${session.id}]`;
  const body = String(text || '');
  if (!body.trim()) throw new MissionError('mission_empty_message', `Nothing to send${where}`);
  if (!(await padTmux.hasSession(vmName, session.tmux_id))) {
    throw new MissionError('mission_session_dead', `This session is gone — mission_session_restart brings it back with the same conversation id${where}`, 409);
  }
  const pre = await padTmux.paneState(vmName, session.tmux_id);
  if (!pre.live) {
    throw new MissionError('mission_session_dead', `This session is gone — mission_session_restart brings it back with the same conversation id${where}`, 409);
  }
  // ONE verdict, both surfaces. `pre` carries the live pane facts this gate has
  // already paid for, so folding them in costs no extra tmux call, and the
  // screen read below feeds the permission arm of the same check.
  let before = await padTmux.captureScreen(vmName, session.tmux_id, 20);
  const perm = detectPermission(before.text);
  const verdict = sendVerdict({ ...session, live: pre.live, tuiAlive: pre.tuiAlive, command: pre.command }, perm);
  if (!verdict.canSend) {
    const cut = verdict.refusal.indexOf(': ');
    throw new MissionError(verdict.refusal.slice(0, cut), `${verdict.refusal.slice(cut + 2)}${where}`, 409);
  }
  // Plan 116: a freshly launched TUI drops input until it has painted (opencode:
  // ~5s after launch). The startup instruction of EVERY new runner worker was
  // typed into that window and silently lost — the boot repaint then read as
  // "the pane changed". Wait for the driver's ready marker BEFORE writing; if it
  // never shows, refuse with nothing written, so a retry is always safe.
  const readyRe = driver?.tuiReadyPattern;
  // Only a READABLE screen can say "still booting"; an unreadable capture keeps
  // the old write-then-verify path (it reports the dead pane after the write).
  if (readyRe && before.live && !readyRe.test(before.text)) {
    const readyBy = Date.now() + TUI_READY_BUDGET_MS;
    while (!readyRe.test(before.text) && Date.now() < readyBy) {
      await new Promise((r) => setTimeout(r, 250));
      before = await padTmux.captureScreen(vmName, session.tmux_id, 20);
    }
    if (!readyRe.test(before.text)) {
      throw new MissionError('mission_tui_not_ready', `The agent TUI has not finished starting — nothing was sent; retry in a few seconds${where}`, 409, { attempted: false });
    }
  }
  // Capture baseline store activity for store-correlated acceptance (Plan 88 §Phase 2).
  // We record the store's lastActivityAt BEFORE the write, then poll for new
  // activity after. This correlates acceptance to the EXACT conversation,
  // avoiding false positives from unrelated pane repaints or another client's turn.
  // `known` tracks whether the store LAYOUT is visible (a path was located),
  // independently of whether THIS conversation has activity yet — the two
  // answers decide what a repaint is allowed to prove (see below).
  let storeBaseline = null;
  if (session.agent_session_id) {
    try {
      const baselineActivity = await agentStore.readActivity(project.agent_name, session.agent_session_id);
      storeBaseline = {
        at: baselineActivity?.lastActivityAt || null,
        known: !!(baselineActivity?.store?.path),
      };
    } catch {
      storeBaseline = null;
    }
  }
  // Runner generation/turn checks belong at the actual write boundary, after
  // the asynchronous pane probes. Pause or a human turn may have landed meanwhile.
  if (beforeWrite) beforeWrite();
  const sent = await padTmux.sendText(vmName, session.tmux_id, body, { paste });
  // Post-write confirmation (1h): prove the PANE CHANGED. Checking only that it
  // still exists is what produced `ok: true` for text that went nowhere — a live
  // pane is not an acknowledgement, and a TUI that is mid-turn repaints for its
  // own reasons, so the wait is bounded and the answer is honest either way.
  // This doubles as the post-send repaint wait (1g): the new content IS the
  // evidence, so there is no separate "force a repaint" step to get wrong.
  const baseline = before.text;
  // The pane-change confirmation must outlast the TUI's repaint, which is slow
  // for a long line: measured ~3-5s for a ~1200-char message on the opencode
  // TUI (the composer fills, then Enter submits and the turn paints). A fixed
  // 1.5s window false-negatives on a message we DID deliver — and a false "did
  // not receive it" is as wrong as a false "received". Scale the wait with the
  // text and cap it so a genuinely dead TUI still fails in bounded time. The
  // loop returns the instant the pane changes, so a live TUI stays fast; only
  // the dead-pane case pays the full budget.
  const deadline = Date.now() + Math.min(12000, 2000 + body.length * 4);
  let after = await padTmux.captureScreen(vmName, session.tmux_id, 20);
  while (!after.live && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    after = await padTmux.captureScreen(vmName, session.tmux_id, 20);
  }
  if (!after.live) {
    throw new MissionError('mission_tui_not_ready', `The pane did not take the text (session gone after write)${where}`, 409, { attempted: true, acceptance: 'unknown' });
  }
  while (after.text === baseline && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    after = await padTmux.captureScreen(vmName, session.tmux_id, 20);
    if (!after.live) {
      throw new MissionError('mission_tui_not_ready', `The pane did not take the text (session gone after write)${where}`, 409, { attempted: true, acceptance: 'unknown' });
    }
  }
  const storeKnown = !!storeBaseline?.known;
  let storeConfirmed = false;
  // A quiet pane does not prove non-delivery. The exact conversation's own
  // store is stronger evidence when it is readable: a TUI may accept and
  // complete an input without repainting the attached pane (observed on a live
  // Mission session), so check that receipt before reporting unknown.
  if (after.text === baseline && storeKnown && session.agent_session_id) {
    storeConfirmed = await confirmDeliveryViaStore(
      project.agent_name, session.agent_session_id, storeBaseline.at, Date.now() + STORE_CONFIRM_BUDGET_MS
    );
  }
  if (after.text === baseline && !storeConfirmed) {
    // Plan 88 §Phase 2: a WRITTEN message we could not OBSERVE is UNKNOWN, not a
    // refusal. Absence of a pane change is not proof of non-delivery — a slow or
    // quiet TUI may still have taken it — so this must never read "the TUI did
    // not receive it". The write already happened (`sent`), the pane is still
    // live, and the honest answer is "unconfirmed": the caller reconciles or
    // offers recovery, and no consumer may blindly resend on it.
    throw new MissionError(
      'mission_send_unconfirmed',
      `The message was written but the pane showed no change, so delivery is unconfirmed — the session is live; reconcile or retry${where}`,
      409,
      { attempted: true, acceptance: 'unknown' }
    );
  }
  // Pane repaint observed. The store decides whenever its layout is known —
  // a repaint on a fresh conversation is most often the TUI booting, not our
  // input landing (proven live 2026-10-12: a "confirmed" startup whose prompt
  // never reached the conversation's store, followed by 12 idle minutes).
  // Only a store the webui cannot see at all (unknown layout: unsupported
  // driver, missing base) still falls back to repaint = confirmed, because
  // there is nothing to correlate against. A known-but-unreadable store polls
  // and fails honestly instead of confirming blind.
  // The store poll gets its own budget: the repaint wait above consumed time
  // meant for repainting, and a leftover deadline would false-negative a
  // message whose store write lagged the repaint by a second.
  if (!storeKnown) storeConfirmed = true;
  if (storeKnown && session.agent_session_id) {
    if (!storeConfirmed) {
      storeConfirmed = await confirmDeliveryViaStore(project.agent_name, session.agent_session_id, storeBaseline.at, Date.now() + STORE_CONFIRM_BUDGET_MS);
    }
  }
  const acceptance = storeConfirmed ? 'confirmed' : 'unknown';
  if (!storeConfirmed) {
    // Pane changed but store shows no new activity for this conversation.
    // Delivery is unconfirmed — the caller must reconcile or retry.
    throw new MissionError(
      'mission_send_unconfirmed',
      `The message was written and the pane changed, but the agent's store shows no new activity for this conversation, so delivery is unconfirmed — reconcile or retry${where}`,
      409,
      { attempted: true, acceptance: 'unknown' }
    );
  }
  touchSession(session.id);
  noteOutput(session.id, after.text);
  // AFTER the write is confirmed, and never on a refusal: an audit trail records
  // what was DONE, so a row here would claim a line was typed into a
  // conversation that refused it. Same rule as a refused `close` stamping
  // nothing — the evidence must not be writable by the failed request.
  audit(project, 'send', { actor, session, details: `${sent.lines} line(s), ${body.length} chars` });
  const fresh = getSession(session.id);
  // Plan 88 §Phase 3: include runner operation status for caller reconciliation.
  const boundRunner = getDb().prepare('SELECT id FROM infinite_runners WHERE session_id = ?').get(session.id) || null;
  const runner = boundRunner ? getRunner(boundRunner.id) : null;
  return {
    session: { ...fresh, title: await sessionTitle(project, session) },
    project: { id: project.id, name: project.name },
    session_id: fresh.id,
    sent,
    confirmed: true,
    acceptance: 'confirmed',
    screen: after.text,
    operation: runner ? {
      id: runner.operation_id,
      generation: runner.operation_generation,
      status: runner.operation_status,
      started_at: runner.operation_started_at,
      confirmed_at: runner.operation_confirmed_at,
    } : null,
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
    await busyForSessions([{ agent_name: project.agent_name, agent_session_id: session.agent_session_id }])
  );
  if (advanced) row.last_output_at = advanced;
  // The detail read PROBED the pane, so it is a liveness observation exactly
  // like a listing — and it is the call a caller makes precisely to find out
  // that a session died. Stamping only on the listing pass meant a caller who
  // only ever read detail got `endedAt: absent` for a corpse, and the
  // description said an absent `endedAt` means "never observed dead" — which the
  // read had just observed. It also dates resurrection, so a live detail read
  // cannot leave a stale death claim behind. Both directions are one call to the
  // function the listings use, so the two paths cannot disagree.
  syncEnded([row]);
  // The SAME `sendVerdict` the write path gates on, fed the same permission
  // detection — so `canSend` cannot promise a send that would then be refused.
  // Computed here because this is the one place a screen was already captured;
  // list mode has no capture, so it carries no such claim.
  const verdict = sendVerdict(row, perm);
  // Plan 65 1a — a dead session's chat, with its age. The surface could resume a
  // conversation but never READ one: this returned `screen: ""` for a corpse, and
  // an empty string is ambiguous (an agent that said nothing? a broken capture?),
  // so the caller could not tell "no output" from "we cannot see it any more".
  // The stored tail answers for the case we can answer and says so out loud:
  // `screenFrom: 'live-pane'` vs `'last-captured'`, plus the clock that dates it.
  // Absent (`screenFrom: 'none'`) when nothing was ever captured — never a
  // silently empty string standing in for a screen.
  const stored = session.last_screen;
  // Plan 85 §Phase 3: the terminal header needs the OPEN session's runner
  // metadata (Run/Pause, queue state) from the session ITSELF, never from
  // whichever project col 1 happens to have selected. One cheap indexed read
  // on the detail path both the page and the MCP already take.
  const bound = getDb().prepare('SELECT id FROM infinite_runners WHERE session_id = ?').get(session.id) || null;
  const boundRunner = bound ? getRunner(bound.id) : null;
  // Plan 114: expose one canonical execution object, not the old flat status fields.
  // Plan 91 §Phase 2: include effective prompt templates for the Configure dialog.
  const runnerOut = boundRunner ? publicRunner(withPromptTemplates(boundRunner)) : null;
  const out = {
    session: { ...row, title: await sessionTitle(project, session) },
    state,
    runner: runnerOut,
    screen: captured.live ? captured.text : (stored || ''),
    live: captured.live,
    ...verdict,
    ...(perm ? { blockedOn: 'permission', permission: perm } : {}),
  };
  if (captured.live) {
    out.screenFrom = 'live-pane';
    out.lastScreenAt = advanced || session.last_screen_at || null;
  } else if (stored) {
    out.screenFrom = 'last-captured';
    out.lastScreenAt = session.last_screen_at || null;
    out.lastScreenTruncated = !!session.last_screen_truncated;
  } else {
    out.screenFrom = 'none';
  }
  return out;
}

/** The title the AGENT gives this conversation, distinct from the operator's
 *  `label` (plan 62 1i). A label is often empty or hand-typed and goes stale
 *  while the agent's own title changes, so a caller that only has a label is
 *  reading a name with no guarantee behind it. `''` when the driver cannot
 *  answer — never a fabricated one. */
async function sessionTitle(project, session) {
  if (!session.agent_session_id) return '';
  const d = drivers.getDriver(project.agent_type);
  // `!d` was dead: it was written against the old `getDriver` fallback, which
  // made a falsy return impossible. getDriver THROWS for an unknown type, so a
  // project whose agent_type does not resolve now says so instead of quietly
  // answering with openclaw's title lookup. Only the capability check is left.
  if (typeof d.sessionTitle !== 'function') return '';
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

/** One truth for (live, busy, busyKnown, open) — plan 62 1a+1e, as amended by
 *  plan 52 R8. The `busy` half is now answered by each conversation's OWN store
 *  (see busyForSessions) rather than the opencode web server's `?directory=`
 *  probe, so the probe is per conversation: `probe.busyOf` / `probe.knownOf` map
 *  an `agent_session_id` to whether its newest tool part is running and whether
 *  the store could be read at all. That retires plan 62 1e's cwd-vs-folder
 *  UNKNOWN branch — it existed because a folder-scoped probe could not answer
 *  for a pane running elsewhere, and an id-keyed store read has no such blind
 *  spot.
 *
 *  The plan 62 guarantees all survive: `busy` requires `live` (a dead row never
 *  reports busy, and `open` never counts a row `mission_send` will refuse);
 *  `wasBusy` preserves the forensics (the store's last claim) without lying on
 *  `busy`; `state: "dead"` makes the corpse explicit; and a row that was never
 *  looked at is UNKNOWN (busyKnown false), never idle (C1-F1). A row with no
 *  `agent_session_id` CANNOT be intersected with anything, so it is UNKNOWN no
 *  matter how healthy the probe was. */
function stampTruth(s, probe) {
  const live = s.live === true;
  const id = s.agent_session_id;
  const looked = !!(id && probe.knownOf && probe.knownOf.get(id));
  // The agent's OWN title for this conversation, taken from the store read the
  // busy probe already made (never a second `sqlite3` exec per row — that is
  // what `sessionTitle` does on the send/detail paths). `titleOf` only holds ids
  // whose store was actually read, so a row we could not look at stays
  // title-less rather than being handed a fabricated name; a store that read
  // cleanly but has no title yet is also empty, and the row falls back to its
  // label/tmux id exactly as before.
  const title = id && probe.titleOf && probe.titleOf.get(id);
  const named = title ? { title } : {};
  if (!live) {
    const wasBusy = !!(id && probe.busyOf && probe.busyOf.get(id));
    return { ...s, busy: false, busyKnown: looked, open: false, state: 'dead', ...named, ...(wasBusy ? { wasBusy: true } : {}) };
  }
  // Live: a shell pane is reachable as a shell but `mission_send` refuses it,
  // so it is not `open` as an agent session.
  if (s.tuiAlive === false) {
    return { ...s, busy: false, busyKnown: looked, open: false, ...named };
  }
  const busy = !!(id && probe.busyOf && probe.busyOf.get(id));
  return { ...s, busy, busyKnown: looked, open: s.tuiAlive !== false, ...named };
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

/** The liveness pass is the ONLY place a death is noticed, so it is the only
 *  place a row is stamped `ended_at: 'gone'` — and the only place a resurrected
 *  one is un-stamped (plan 65 1b).
 *
 *  It rides the same `withLive*` calls that already produce the `live` flag on
 *  each row, so there is no extra probe, and it is fed the very rows the caller
 *  is about to be handed: a row can therefore never read `live: true` in the
 *  response while `endedAt` sits on it in the table. Best effort by design — a
 *  failure here loses a timestamp, never a listing. */
function syncEnded(sessions) {
  try {
    const live = [];
    const gone = [];
    for (const s of sessions || []) {
      if (!s || !s.id) continue;
      if (s.live === true) live.push(s.id);
      else if (s.ended_at === null || s.ended_at === undefined) gone.push(s.id);
    }
    if (live.length) {
      clearEnded(live);
      for (const s of sessions) if (s.live === true && s.id) { s.ended_at = null; s.ended_by = null; }
    }
    if (gone.length) {
      const stamp = new Date().toISOString();
      const db = getDb();
      const stmt = db.prepare("UPDATE mission_sessions SET ended_at = ?, ended_by = 'gone' WHERE id = ? AND ended_at IS NULL");
      const tx = db.transaction((list) => {
        for (const id of list) stmt.run(stamp, id);
      });
      tx(gone);
      for (const s of sessions) {
        if (s.id && s.live !== true && (s.ended_at === null || s.ended_at === undefined)) {
          s.ended_at = stamp;
          s.ended_by = 'gone';
        }
      }
    }
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
    syncEnded(p.sessions);
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
  syncEnded(out);
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
  syncEnded(out);
  return out;
}

/* What "busy" means, and where it comes from — plan 52 R8(a).
 *
 *  Busy used to be answered by the opencode web server's `GET /session/status`
 *  `?directory=` probe — and that probe answered a DIFFERENT PROCESS than the
 *  one being described. The web server publishes only the conversations its OWN
 *  process drives, while a Mission pane is a separate `opencode` TUI with no
 *  sockets of its own: measured, a visible `esc interrupt` across 42 seconds
 *  with our id absent from the map while the user's web-UI session was reported
 *  busy throughout. The shared sqlite made the read LOOK wired up (same id
 *  resolved) exactly while it answered the wrong question.
 *
 *  The store is the SHARED truth: the TUI's sqlite and the web UI's sqlite are
 *  the same file, so a conversation's own newest tool part carrying
 *  `state.status: 'running'` is a turn happening in WHICHEVER client drives it.
 *  That is decision (a): a session is busy iff its own newest tool part is
 *  running. Two consequences, both intended:
 *
 *  - Busy now reads per conversation, not per (PAD, folder). Plan 62 1e's
 *    cwd-vs-folder UNKNOWN branch existed because the folder probe could not
 *    answer for a pane elsewhere; an id-keyed store read has no such blind
 *    spot, so the branch is gone (see stampTruth).
 *  - A frozen `running` (a process killed mid-call never writes `completed`)
 *    is the honest upper-bound note on a DEAD row (`wasBusy`), the same
 *    "endedAt is an upper bound" precedent as plan 65. It can never lie about
 *    `busy`, because busy requires `live`, and a killed process does not hold
 *    a live pane.
 *
 *  Cost: one store read per id. opencode is one indexed sqlite walk (~2 ms) —
 *  the same read plan_activity uses; codex and claude parse that one
 *  conversation's rollout file, so the cost scales with transcript length, the
 *  same model plan_activity documents (mission pads are mostly opencode). A
 *  short TTL coalesces the list + detail + projects passes of one poll and
 *  stops repeated jsonl parses. A failed read is `known: false`, never
 *  `busy: false`-as-a-claim (C1-F1).
 */
const BUSY_TTL = 5000;
const BUSY_CACHE = new Map();

/** Probe `rows` (flat session rows carrying `agent_name` and
 *  `agent_session_id`) through each conversation's own store. Returns
 *  `{ busyOf, knownOf, titleOf }`: `busyOf` maps an id whose store says its
 *  newest tool part is running; `knownOf` maps an id whose store could actually
 *  be read; `titleOf` maps an id to the agent's OWN title for that conversation
 *  — the SAME `readActivity` read, so a listing gets the name the agent gave a
 *  chat for free instead of one `sqlite3` exec per row. An id we were not asked
 *  about is absent from all three — stampTruth turns that into UNKNOWN, and that
 *  absence is exactly what stops "the probe worked" from reading as "this row is
 *  idle" (C1-F1). `titleOf` likewise only holds ids whose store was READ, so an
 *  unreadable conversation never gets an invented name. */
async function busyForSessions(rows) {
  const busyOf = new Map();
  const knownOf = new Map();
  const titleOf = new Map();
  await Promise.all((rows || []).map(async (s) => {
    const id = s && s.agent_session_id;
    const vm = s && s.agent_name;
    if (!id || !vm) return;
    const key = `${vm}::${id}`;
    const hit = BUSY_CACHE.get(key);
    if (hit && Date.now() - hit.at < BUSY_TTL) {
      busyOf.set(id, hit.value.busy);
      knownOf.set(id, hit.value.known);
      if (hit.value.known) titleOf.set(id, hit.value.title || '');
      return;
    }
    let value = { busy: false, known: false, title: '' };
    try {
      const row = await agentStore.readActivity(vm, id);
      const ok = !!(row && row.store && row.store.available);
      value = {
        busy: !!(ok && row.lastToolCall && row.lastToolCall.status === 'running'),
        known: ok,
        title: ok ? (row.title || '') : '',
      };
    } catch {
      value = { busy: false, known: false, title: '' };
    }
    BUSY_CACHE.set(key, { at: Date.now(), value });
    busyOf.set(id, value.busy);
    knownOf.set(id, value.known);
    if (value.known) titleOf.set(id, value.title);
  }));
  return { busyOf, knownOf, titleOf };
}

/** Stamp each row from its OWN conversation's store: `busy` = its newest tool
 *  part is running, `busyKnown` = we could read that store (plan 52 R8(a)). One
 *  store read per row instead of one web probe per (PAD, folder), so several
 *  projects sharing one PAD each get the truth for their own conversation — and
 *  a folder-scoping mistake is impossible, because there is no folder in the
 *  key. `folderOf` was the web probe's scoping input and no longer exists.
 *
 *  `open` is the marker the user actually asked for, but it is deliberately not
 *  a rename of `live`: `live` still means "we have a tmux session on this", and
 *  it still drives the terminal's Relaunch-vs-Restart and "session is gone"
 *  states. `open` is `live OR busy` — the dot — so nothing downstream changes
 *  meaning when a store cannot be read. */
async function withAgentBusy(sessions, agentOf) {
  if (!sessions || !sessions.length) return sessions || [];
  const rows = sessions.map((s, i) => ({ ...s, agent_name: agentOf(s, i) }));
  const probe = await busyForSessions(rows);
  return rows.map((s, i) => stampTruth(s, probe));
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
    busyForSessions(rows.map((r) => ({ agent_name: vm, agent_session_id: r.id }))),
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
    const busy = probe.busyOf.get(r.id) === true;
    return { ...r, busy, busyKnown: probe.knownOf.get(r.id) === true, open: busy || resumedOpen.has(r.id) };
  });
}

/** The same, for the nested project shape (`listProjects`). Projects own the PAD
 *  name AND the folder, but under plan 52 R8 busy is keyed by the conversation's
 *  own id — a project row never re-scopes anything, so only the PAD is carried
 *  on for the flat call. */
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
      (r) => r.agent_name
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
/** Disable any runner bound to a session before the session is closed.
 *  Plan 85 §Phase 1: an explicit Close disables supervision FIRST — the row is
 *  deleted, the FK nulls the binding, and without this the watcher would see a
 *  dead pane on the next tick and resurrect a session the human just closed.
 *  The runner CONFIGURATION survives (unbound); Run on it binds a new session. */
function disableRunnerForSession(sessionId) {
  const bound = getDb().prepare('SELECT id FROM infinite_runners WHERE session_id = ?').get(sessionId);
  if (!bound) return;
  const runtime = runnerTransition.getRuntime(bound.id);
  if (!runtime) throw new MissionError('runner_setup_required', 'Runner must be explicitly initialized before closing its session.');
  runnerTransition.applyClose(bound.id, { actor: 'mission', details: { reason: 'Session closed; supervision stopped.' } });
  runnerTransition.setReason(bound.id, 'session_closed', 'Session closed — supervision stopped. Press Run to bind a new session.');
  syncQueuePausedMarker(bound.id, true);
}

async function closeSession(sessionId, { actor = null } = {}) {
  const { session, project, vmName } = sessionTarget(sessionId);
  disableRunnerForSession(session.id);
  await padTmux.killSession(vmName, session.tmux_id);
  // Audited even though the row is about to be deleted: the DELETION is the
  // thing that cannot be reconstructed afterwards, so it is the one action here
  // that most needs a record. `resource_ref` keeps the session id, which is the
  // only handle left once the row is gone.
  audit(project, 'session_delete', { actor, session, details: 'row deleted (page Close)' });
  return deleteSession(session.id);
}

/** End a session's LIFE without erasing the record of it (plan 65 1e).
 *
 *  `closeSession` above is the page's Close button: kill the pane and DELETE the
 *  row, because that is what "remove this from my list" means to a human. An
 *  agent ending a session is a different act — "we are done with this
 *  conversation" — and deleting the row would throw away the very thing plan
 *  exists to answer (when did it end, what was it doing, what conversation was
 *  it). So the pane dies, the row is stamped `ended_by: 'closed'`, and it stays.
 *
 *  The screen is captured FIRST, deliberately. A close is the one death we get to
 *  witness, and skipping it would mean the closest thing to a real teardown in
 *  the whole system is also the one death whose last words we throw away.
 *
 *  Not locked-session aware on purpose: closing is the human's escape hatch from
 *  a solo-locked session, and refusing to close the one kind of session that most
 *  needs closing would be a bug shaped like a rule. `locked` describes who may
 *  TYPE, not who may end it. */
async function endSession(sessionId, { actor = null } = {}) {
  const { session, project, vmName } = sessionTarget(sessionId);
  // Refuse a session that is ALREADY gone, and the check comes before the
  // capture on purpose: the tool description promises `mission_session_dead`
  // here, and an unconditional stamp would quietly re-date a session whose death
  // was `gone` (or `recreate`) — overwriting a fact we can still read. "Already
  // dead" is answered from the row's own `ended_at`, not from a probe, so the
  // refusal costs no tmux call.
  if (session.ended_at) {
    throw new MissionError('mission_session_dead', `Session ${sessionId} already ended (endedBy: ${session.ended_by}) — there is nothing to close.`, 409);
  }
  const captured = await padTmux.captureScreen(vmName, session.tmux_id, 40);
  // The row is undated but the pane is gone: the session died between passes.
  // Refuse WITHOUT stamping — the next liveness pass dates it `gone`, which is
  // the true cause. Stamping `closed` here would credit a deliberate end to a
  // death nobody asked for, and the row is the only record of which it was.
  if (!captured.live) {
    throw new MissionError('mission_session_dead', `Session ${sessionId} has no live pane — it already ended (its row is dated by the next listing). There is nothing to close.`, 409);
  }
  noteOutput(session.id, captured.text);
  if (await padTmux.hasSession(vmName, session.tmux_id)) {
    await padTmux.killSession(vmName, session.tmux_id);
  }
  endSessions([session.id], 'closed');
  audit(project, 'session_close', { actor, session });
  return { session: getSession(session.id), project, screen: captured.text };
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


/** The gate every in-session TASK step honors (plan 69 D2). Same facts as
 *  `sendText`'s gate — live pane, an agent (not a shell), not solo-locked, not
 *  parked on a permission dialog — read WITHOUT typing anything, so a step
 *  report/commit refuses exactly where a send would and before any step row is
 *  written. Read-only: one pane-state probe plus one screen capture for the
 *  permission arm, the same costs sendText pays up front.
 *
 *  The locked refusal is spelled `task_session_locked` here rather than
 *  `mission_session_locked`: the caller is being refused by the TASK surface and
 *  D2 names that code, while the other three refusals keep their send-side
 *  spelling so one vocabulary covers both. */
async function assertStepSession(sessionId) {
  const { session, project, vmName } = sessionTarget(sessionId);
  const where = ` [project:${project.name} (${project.id}) session:${session.id}]`;
  if (!(await padTmux.hasSession(vmName, session.tmux_id))) {
    throw new MissionError('mission_session_dead',
      `This session is gone — mission_session_restart brings it back (this step needs a LIVE pane)${where}`, 409);
  }
  const pre = await padTmux.paneState(vmName, session.tmux_id);
  if (!pre.live) {
    throw new MissionError('mission_session_dead',
      `This session is gone — mission_session_restart brings it back (this step needs a LIVE pane)${where}`, 409);
  }
  const before = await padTmux.captureScreen(vmName, session.tmux_id, 20);
  const perm = detectPermission(before.text);
  const verdict = sendVerdict({ ...session, live: pre.live, tuiAlive: pre.tuiAlive, command: pre.command }, perm);
  if (!verdict.canSend) {
    const cut = verdict.refusal.indexOf(': ');
    let code = verdict.refusal.slice(0, cut);
    if (code === 'mission_session_locked') code = 'task_session_locked';
    throw new MissionError(code, `${verdict.refusal.slice(cut + 2)}${where}`, 409);
  }
  return { session, project, vmName, pane: pre };
}

/* ---------------------------------------------------------------- */
/*  INFINITE RUNNER SERVICE (plan 83)                               */
/* ---------------------------------------------------------------- */

const RUNNER_CONTROL_STATES = Object.freeze(['enabled', 'paused', 'waiting', 'need_input', 'finished']);
// Plan 86 §Phase 4b: the two explicit Pause modes. `before_next_task` lets the
// worker finish the plan it is on and only blocks the NEXT item; `current_task`
// also asks the worker to stop the plan it is on at the earliest safe
// checkpoint. An omitted mode is backward-compatible with the old single
// finish-current-plan behavior.
const RUNNER_PAUSE_MODES = Object.freeze(['before_next_task', 'current_task']);
const RUNNER_HEALTH_STATES = Object.freeze([
  'working', 'waiting_for_tool', 'compacting', 'recovering',
  'suspected_stuck', 'usage_exhausted', 'auth_expired',
  'rate_limited', 'observation_unavailable', 'invalid_queue'
]);

function queueMissionError(error) {
  if (error instanceof runnerQueue.RunnerQueueError) throw new MissionError(error.code, error.message);
  throw error;
}

function canonicalQueueProjection(runner, project, agent, snapshot) {
  const file = runner.queue_file || 'QUEUE.md';
  const pathOnHost = plans.queuePath(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, file);
  const expected = plans.queueProjection(snapshot.items, snapshot.customInstructions);
  let condition = 'ok';
  let error = null;
  const publication = runnerPublication.read(runner.id);
  try {
    if (!fs.existsSync(pathOnHost) || fs.readFileSync(pathOnHost, 'utf8') !== expected) {
      condition = 'projection_error';
      error = 'Generated QUEUE.md differs from the canonical queue. Regenerate the projection before running work.';
    }
  } catch (e) {
    condition = 'projection_error';
    error = `Could not verify generated QUEUE.md: ${e.message}`;
  }
  const expectedPublicationHash = runnerQueue.publicationHash(snapshot);
  if (!publication) {
    condition = 'setup_required';
    error = 'This existing runner needs explicit canonical runtime and publication setup.';
  } else if (publication.desired_revision !== snapshot.revision || publication.desired_hash !== expectedPublicationHash ||
      publication.acknowledged_revision !== snapshot.revision || publication.acknowledged_hash !== expectedPublicationHash ||
      publication.error) {
    condition = 'projection_error';
    error = publication?.error || 'The canonical queue revision has not been acknowledged by its worker projection publisher.';
  }
  if (publication && condition === 'ok') {
    const runtime = runnerTransition.getRuntime(runner.id);
    const markerRequired = !runtime || runnerTransition.markerRequired(runtime.state);
    const markerPath = plans.queuePausedPath(agent, { ...project, plans_folder: project.plans_folder || 'plans' });
    if (publication.desired_marker !== Number(markerRequired) || fs.existsSync(markerPath) !== markerRequired) {
      condition = 'projection_error';
      error = 'The queue execution marker does not match the canonical runner state.';
    }
  }
  const items = snapshot.items.map((item) => ({ ...item, status: item.status.replace('_', ' ') }));
  const parsed = { version: plans.QUEUE_VERSION, items, customInstructions: snapshot.customInstructions };
  const aggregate = plans.queueAggregateState(parsed);
  return {
    parsed,
    aggregate,
    condition,
    summary: plans.queueSummary(parsed),
    path: pathOnHost,
    hash: snapshot.revision,
    error,
  };
}

function writeCanonicalQueueProjection(runner, project, agent, snapshot) {
  const latest = runnerQueue.snapshot(runner.id);
  if (latest.revision !== snapshot.revision || runnerQueue.publicationHash(latest) !== runnerQueue.publicationHash(snapshot)) {
    throw new MissionError('queue_revision_conflict', 'The queue changed before its projection could be published. Reload and retry.');
  }
  return runnerPublication.publish(runner, project, agent);
}

/** Generate a runner id. */
function newRunnerId() {
  return 'run_' + crypto.randomBytes(8).toString('hex');
}

/** Create a runner configuration.
 *  When `sessionId` is given (plan 83: "set up an existing session as a
 *  runner"), it is validated before persist: the session must exist, must
 *  belong to THIS project (a runner row lives in exactly one project, and a
 *  session elsewhere would be started / no-progressed by a runner that has no
 *  right to it), and must not already be bound to another runner (the runner
 *  row IS that session; two rows pinned for one session would both drive it).
 *  The FK does not enforce any of these — it only keeps the id from dangling —
 *  so the checks are explicit and each asks a different question.
 *
 *  Plan 85: when NO `sessionId` is given, the worker session is created HERE —
 *  an infinite runner IS a session, and the row must open a real terminal
 *  immediately, independently of whether its queue is running. A stopped PAD or
 *  a missing folder fails the whole create (ordinary session errors), never a
 *  half-created configuration row. */
async function createRunner({ projectId, name, sessionId, queueFile = 'QUEUE.md',
  idleGraceMs = 120000, minNudgeIntervalMs = 120000, noProgressBudget = 3,
  compactionGraceMs = 300000, longCommandThresholdMs = 1800000,
  recoverExited = true, recoveryBudget = 3, promptTemplates = undefined, actor = null } = {}) {
  const project = getProject(projectId);
  let normalizedQueueFile;
  try {
    normalizedQueueFile = plans.normalizeQueueFile(requireAgent(project.agent_name), project, queueFile);
  } catch (e) {
    if (e instanceof plans.PlansError) throw new MissionError(e.code, e.message);
    throw e;
  }
  // Plan 91 §Phase 2: prompt templates are validated BEFORE anything is
  // persisted or any session minted — a bad set must not leave a runner behind.
  // Omitted input stores NULL (shipped defaults), never the preserve sentinel.
  const promptInput = parsePromptTemplatesInput(promptTemplates);
  const promptTemplatesJson = promptInput === PROMPT_TEMPLATES_PRESERVE ? null : promptInput;
  const id = newRunnerId();
  const db = getDb();
  const projectAgent = requireAgent(project.agent_name);
  try {
    runnerPublication.assertPathAvailable(id, project, projectAgent, normalizedQueueFile);
  } catch (error) {
    if (error instanceof runnerPublication.RunnerPublicationError) {
      throw new MissionError(error.code, error.message);
    }
    throw error;
  }
  let boundSessionId = null;
  if (sessionId) {
    let session;
    try {
      session = getSession(sessionId);
    } catch (e) {
      throw new MissionError('runner_session_not_found', `Session ${sessionId} does not exist`);
    }
    if (String(session.project_id) !== String(projectId)) {
      throw new MissionError('runner_session_wrong_project', `Session ${sessionId} belongs to another project`);
    }
    const taken = db.prepare('SELECT id FROM infinite_runners WHERE session_id = ? AND id != ?').get(sessionId, id);
    if (taken) {
      throw new MissionError('runner_session_in_use', `Session ${sessionId} is already the worker of runner ${taken.id}`);
    }
    boundSessionId = session.id;
  } else {
    const created = await startSession(projectId, {
      label: `Runner: ${name}`,
      origin: 'human',
      createdBy: actor,
    });
    boundSessionId = created.session.id;
  }
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO infinite_runners (id, name, project_id, session_id, queue_file,
        idle_grace_ms, min_nudge_interval_ms, no_progress_budget,
        compaction_grace_ms, long_command_threshold_ms, recover_exited, recovery_budget,
        prompt_templates_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, projectId, boundSessionId, normalizedQueueFile,
      idleGraceMs, minNudgeIntervalMs, noProgressBudget,
      compactionGraceMs, longCommandThresholdMs,
      recoverExited ? 1 : 0, recoveryBudget,
      promptTemplatesJson,
      now, now
    );
  } catch (e) {
    // The session was just created for this runner — do not leave it orphaned
    // when the row cannot be persisted. Best effort: a failed create must not
    // plant a stray TUI the user never asked to keep.
    if (!sessionId && boundSessionId) {
      try { await closeSession(boundSessionId, { actor }); } catch { /* best effort */ }
    }
    throw e;
  }
  // Create one canonical queue immediately. The generated worker file is a
  // projection; no runner starts with a file that the worker may author.
  try {
    runnerTransition.createRuntime(id);
    const createdQueue = runnerQueue.ensure(id, { actor });
    writeCanonicalQueueProjection(getRunner(id), project, projectAgent, createdQueue);
  } catch (e) {
    // Keep the durable queue/runtime row on publication failure; the UI must
    // expose a recoverable Projection error rather than lose the new authority.
    queueMissionError(e);
  }
  // New runner starts paused (enabled=0) — create the pause marker.
  syncQueuePausedMarker(id, true);
  runnerHistory.record(getRunner(id), 'runner_created', { actor: actor || 'user', key: 'created' });
  return withPromptTemplates(getRunner(id));
}

/** Plan 91 §Phase 2 — prompt-template persistence contract.
 *
 * Input (`promptTemplates` on create/update) is a COMPLETE five-key object or
 * nothing: `undefined` preserves current values (omitted on update, defaults
 * on create), explicit `null` resets the whole saved set to defaults, and any
 * other shape is a field-specific 400. Returns the TEXT to store (`JSON` or
 * `null` for defaults) or the sentinel `PRESERVE` when the caller omitted it.
 * Validated before any session is minted or row written. */
const PROMPT_TEMPLATES_PRESERVE = Symbol('preserve');
function parsePromptTemplatesInput(value) {
  if (value === undefined) return PROMPT_TEMPLATES_PRESERVE;
  if (value === null) return null;
  const v = promptTemplates.validateTemplateSet(value);
  if (!v.ok) {
    const first = v.errors[0];
    throw new MissionError(first.code, `promptTemplates: ${first.message}`);
  }
  return JSON.stringify(value);
}

/** Content hash identifying an effective template set (the "version" the
 *  configuration surface and, later, operation metadata carry). */
function promptTemplateVersion(templatesObj) {
  return crypto.createHash('sha256').update(JSON.stringify(templatesObj), 'utf8').digest('hex');
}

/** Effective templates for a runner row: stored custom set, or the shipped
 *  defaults when the column is NULL (existing rows are never rewritten).
 *  Corrupt stored JSON is an explicit failure (`error`), never a silent
 *  default fallback — a misconfigured runner withholds sends (Phase 4) while
 *  editing/repair stays available. */
function effectivePromptTemplates(row) {
  const raw = row ? row.prompt_templates_json : null;
  if (raw === null || raw === undefined) {
    return {
      templates: { ...promptTemplates.DEFAULT_TEMPLATES },
      version: promptTemplateVersion(promptTemplates.DEFAULT_TEMPLATES),
      custom: false,
      error: null,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { templates: null, version: null, custom: true, error: { code: 'prompt_templates_corrupt', message: `Saved prompt templates are not valid JSON: ${e.message}` } };
  }
  const v = promptTemplates.validateTemplateSet(parsed);
  if (!v.ok) {
    return { templates: null, version: null, custom: true, error: { code: v.errors[0].code, message: `Saved prompt templates are invalid: ${v.errors[0].message}` } };
  }
  return { templates: parsed, version: promptTemplateVersion(parsed), custom: true, error: null };
}

/** Enrich a runner row for configuration responses: effective templates, its
 *  content-hash version, default/custom status, and any corruption failure.
 *  The raw row (and its stored column) pass through untouched. */
function withPromptTemplates(row) {
  if (!row) return row;
  const eff = effectivePromptTemplates(row);
  return {
    ...row,
    promptTemplates: eff.templates,
    promptTemplateVersion: eff.version,
    promptTemplatesCustom: eff.custom,
    promptTemplatesError: eff.error,
  };
}

/** Static callback-engine catalogue for surfaces with no runner yet (the
 *  create dialog). No database, no session — just the contract. */
function callbackCatalogue() {
  return runnerCallbacks.callbackCatalogue();
}

/** Plan 92 §Phase 2 — lifecycle callback settings surface. Reads the five
 *  events' scripts + flags plus the catalogue (meanings, env vars, limits).
 *  Reads never execute. CallbackError surfaces as a MissionError code. */
function getRunnerCallbacks(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  try {
    return {
      runner: { id: runner.id, name: runner.name },
      callbacks: runnerCallbacks.listCallbacks(id),
      catalogue: runnerCallbacks.callbackCatalogue(),
    };
  } catch (e) {
    if (e instanceof runnerCallbacks.CallbackError) throw new MissionError(e.code, e.message);
    throw e;
  }
}

/** Save a PARTIAL callback map: `{ event: { script, enabled } }`. Omitted
 *  events preserve their saved values; every supplied event validates fully
 *  before anything is written, then saves per event (file + row atomically).
 *  Saving never executes. */
function saveRunnerCallbacks(id, map) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) {
    throw new MissionError('callback_map_missing', 'Callback update needs a callbacks object with at least one event.');
  }
  try {
    for (const event of Object.keys(map)) {
      const entry = map[event];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new runnerCallbacks.CallbackError('callback_entry_invalid', `Callback \`${event}\` must be an object with script and enabled.`);
      }
      runnerCallbacks.validateEventKey(event);
      if (typeof entry.script !== 'string') {
        throw new runnerCallbacks.CallbackError('callback_script_missing', `Callback \`${event}\` needs a script string.`);
      }
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        throw new runnerCallbacks.CallbackError('callback_enabled_invalid', `Callback \`${event}\` enabled must be a boolean.`);
      }
      if (entry.recreateResume !== undefined && (typeof entry.recreateResume !== 'boolean' || (entry.recreateResume && event !== 'usage_exhausted'))) {
        throw new runnerCallbacks.CallbackError('callback_recovery_invalid', 'Recreate and resume is only available for usage_exhausted.');
      }
    }
    const saved = [];
    for (const event of Object.keys(map)) {
      saved.push(runnerCallbacks.saveCallback(id, event, { script: map[event].script, enabled: map[event].enabled, recreateResume: map[event].recreateResume }));
    }
    return { runner: { id: runner.id, name: runner.name }, saved, callbacks: runnerCallbacks.listCallbacks(id) };
  } catch (e) {
    if (e instanceof runnerCallbacks.CallbackError) throw new MissionError(e.code, e.message);
    throw e;
  }
}

/** Execution history reads (writes arrive with the Phase 3 executor).
 *  Runner-scoped for live runners; project-scoped (`projectId` + `runnerId`)
 *  is the post-destroy owner path, since destroy deletes the runner row the
 *  runner-scoped gate reads through. */
function runnerCallbackHistory({ runnerId = null, projectId = null, limit = 50 } = {}) {
  // Project scope is the post-destroy owner path: it must NOT require the
  // runner row destroy deleted. Runner-only scope keeps requiring it (nothing
  // to gate a removed runner through).
  if (projectId) getProject(projectId);
  if (runnerId && !projectId) {
    const runner = getRunner(runnerId);
    if (!runner) throw new MissionError('runner_not_found', `Runner ${runnerId} not found`);
  }
  if (!runnerId && !projectId) {
    throw new MissionError('callback_history_unscoped', 'History needs a runnerId, a projectId, or both.');
  }
  return runnerCallbacks.listCallbackHistory({ runnerId, projectId, limit });
}

/** Static prompt-engine catalogue for surfaces with no runner yet (the create
 *  dialog). No database, no session, no queue — just the contract. */
function promptCatalogue() {  return {
    keys: [...promptTemplates.TEMPLATE_KEYS],
    catalogue: promptTemplates.VARIABLE_CATALOGUE,
    limits: promptTemplates.TEMPLATE_LIMITS,
    defaults: { ...promptTemplates.DEFAULT_TEMPLATES },
  };
}

/** Read-only prompt configuration surface: catalogue, shipped defaults,
 *  budgets and this runner's effective set. Creates no session, touches no
 *  queue file, enables nothing. */
function runnerPromptConfig(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const eff = effectivePromptTemplates(runner);
  return {
    runner: { id: runner.id, name: runner.name },
    keys: [...promptTemplates.TEMPLATE_KEYS],
    catalogue: promptTemplates.VARIABLE_CATALOGUE,
    limits: promptTemplates.TEMPLATE_LIMITS,
    defaults: { ...promptTemplates.DEFAULT_TEMPLATES },
    effective: eff.templates,
    version: eff.version,
    custom: eff.custom,
    error: eff.error,
  };
}

/** Build the render context for prompt preview/dispatch from REAL project data:
 *  container paths from the existing resolver, current/blocker from the live
 *  queue summary when one is readable. Caller overrides win per key, so the
 *  dialog can preview hypothetical values; every key records its provenance
 *  (`real` | `sample` | `empty`) so the UI labels sample values honestly.
 *  Read-only: a queue read failure degrades item context to absent, never to a
 *  throw that would take preview offline. */
function buildPromptContext(project, { queueFile = 'QUEUE.md', queue = null, runnerName = undefined, overrides = {} } = {}) {
  const paths = runnerContainerPaths(project, queueFile);
  const clean = {};
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined) clean[k] = v;
  }
  const summary = (queue && queue.summary) || {};
  const base = {
    runner_name: runnerName,
    project_name: project.name,
    project_path: project.folder,
    plans_path: paths.queue.slice(0, paths.queue.lastIndexOf('/')),
    queue_path: paths.queue,
    index_path: paths.index,
    paused_path: paths.paused,
    current_plan: summary.current ? summary.current.plan : undefined,
    current_item_status: summary.current ? summary.current.status : undefined,
    blocker_reason: summary.blocked ? summary.blocked.reason : undefined,
  };
  const context = {};
  const sources = {};
  for (const key of Object.keys(promptTemplates.VARIABLE_CATALOGUE)) {
    if (Object.prototype.hasOwnProperty.call(clean, key)) {
      context[key] = clean[key];
      sources[key] = 'sample';
    } else if (base[key] !== undefined && base[key] !== null && base[key] !== '') {
      context[key] = base[key];
      sources[key] = 'real';
    } else {
      sources[key] = 'empty';
    }
  }
  return { context, sources };
}

/** Shared draft validate+render core for both preview routes. Preview shows the
 *  EXACT submitted text: drafts render, then normalize to one logical terminal
 *  submission, and `normalizedKeys` names every kind whose text changed so the
 *  dialog explains the normalization instead of hiding it. */
function renderPromptDrafts(drafts, context) {
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts) || !Object.keys(drafts).length) {
    throw new MissionError('prompt_drafts_missing', 'Preview needs a drafts object with at least one template key.');
  }
  const errors = [];
  const rendered = {};
  const normalizedKeys = [];
  for (const key of Object.keys(drafts)) {
    if (!promptTemplates.TEMPLATE_KEYS.includes(key)) {
      errors.push({ key, code: 'prompt_unknown_key', message: `Unknown template key \`${key}\`.` });
      continue;
    }
    if (typeof drafts[key] !== 'string') {
      errors.push({ key, code: 'prompt_not_string', message: `Template \`${key}\` must be a string.` });
      continue;
    }
    const v = promptTemplates.validateTemplate(drafts[key]);
    if (!v.ok) {
      for (const e of v.errors) errors.push({ key, code: e.code, message: e.message, line: e.line, column: e.column });
      continue;
    }
    try {
      const raw = promptTemplates.renderTemplate(drafts[key], context);
      const normalized = promptTemplates.normalizePromptForSend(raw);
      rendered[key] = normalized;
      if (normalized !== raw) normalizedKeys.push(key);
    } catch (e) {
      errors.push({ key, code: e.code || 'prompt_render_failed', message: e.message });
    }
  }
  return { ok: errors.length === 0, rendered, errors, normalizedKeys };
}

/** Plan 91 §Phase 4 — the ONE way a runner-to-LLM message is produced. Renders
 *  the saved template for `kind` against real dispatch context, then
 *  normalizes to one logical terminal submission. A misconfigured set or a
 *  missing required value is an actionable MissionError naming the repair —
 *  never `undefined` in a sent prompt and never a silent default fallback.
 *  `extra` overrides context per key (e.g. the pause target's plan). Returns
 *  `{ text, version }`: the version (content hash) travels with the operation
 *  via the existing `operation_prompt_hash`, so an outstanding send stays
 *  identifiable across edits and restarts without new columns. */
function renderRunnerPrompt(runner, project, queue, kind, extra = {}) {
  const eff = effectivePromptTemplates(runner);
  if (eff.error) {
    throw new MissionError('runner_prompts_misconfigured', `Prompt templates misconfigured: ${eff.error.message} Repair them in Configure → Prompts, then retry.`);
  }
  const { context } = buildPromptContext(project, { queueFile: runner.queue_file, queue, runnerName: runner.name, overrides: extra });
  let rendered;
  try {
    rendered = promptTemplates.renderTemplate(eff.templates[kind], context);
  } catch (e) {
    throw new MissionError(e.code || 'prompt_render_failed', `Cannot render the ${kind} prompt: ${e.message}`);
  }
  const guidance = queue?.parsed?.customInstructions || '';
  const text = guidance
    ? `${rendered}\n\n=== QUEUE CUSTOM INSTRUCTIONS ===\n${guidance}\n=== END QUEUE CUSTOM INSTRUCTIONS ===`
    : rendered;
  // This protocol is not an editable template: even older saved prompts must
  // never send a worker back to editing the generated projection.
  // `withRunnerRuntime` also exposes the last completed operation for display.
  // It is not the next dispatch assignment: only a runtime-owned active
  // operation may supply operation_item_id. New dispatches use the canonical
  // current/next queue item so a completed item's ID cannot leak into the next
  // worker prompt.
  const assignedItem = runner.activeOperationId
    ? runner.operation_item_id
    : (queue?.summary?.current?.id || queue?.summary?.next?.id);
  const assignment = assignedItem
    ? (runner.activeOperationId
      ? ` Current owned operation ${runner.activeOperationId} is assigned to item ${assignedItem}.`
      : ` This dispatch is assigned to item ${assignedItem}.`)
    : '';
  const protocol = `Queue authority: runner_id=${runner.id}.${assignment} QUEUE.md is read-only generated output; NEVER edit it. Call paddock_runner_agent_queue_read with this exact runner_id. Its result contains queue.items and queue.revision. Call paddock_runner_agent_queue_update_item with the item's id as item_id, queue.revision as the numeric revision, and an accepted status: new, in_progress, need_input, done. Re-read after every accepted mutation and on a revision conflict. Only update the item assigned to the current operation; do not take a second item. Queue changes must go through these tools, including marking work started, done, or blocked; never choose a runner by PAD name. If the tools are unavailable, stop and report that instead of editing the file.`;
  return { text: promptTemplates.normalizePromptForSend(`${text}\n\n${protocol}`), version: eff.version };
}

/** Read-only preview for an existing runner: real container paths and live
 *  queue item context, caller overrides labeled as samples. Validates supplied
 *  drafts and renders them WITHOUT persisting anything. Never sends, starts,
 *  enables or touches the queue file. */
async function previewRunnerPrompts(id, drafts, overrides = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  let queue = null;
  try {
    const agent = requireAgent(project.agent_name);
    queue = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(runner.id));
  } catch { /* item context degrades to absent; paths still preview */ }
  const { context, sources } = buildPromptContext(project, { queueFile: runner.queue_file, queue, runnerName: runner.name, overrides });
  return { ...renderPromptDrafts(drafts, context), contextSources: sources };
}

/** Read-only preview for a project with no runner yet (the create dialog):
 *  same engine, same real paths; the runner name and item context come from
 *  caller overrides and are labeled samples. */
async function previewProjectPrompts(projectId, drafts, overrides = {}) {
  const project = getProject(projectId);
  // A project with no runner has no canonical queue yet. Preview remains useful
  // with empty item context; it must not fall back to a worker projection.
  const queue = null;
  const { context, sources } = buildPromptContext(project, { queue, overrides });
  return { ...renderPromptDrafts(drafts, context), contextSources: sources };
}

/** Get a runner by id. */
function getRunner(id) {
  const row = getDb().prepare('SELECT * FROM infinite_runners WHERE id = ?').get(id);
  return withRunnerRuntime(row);
}

function withRunnerRuntime(row) {
  if (!row) return row;
  const runtime = runnerTransition.getRuntime(row.id);
  if (!runtime) return {
    ...row,
    execution: { state: 'setup_required', generation: null, reasonCode: null, reason: null, allowedActions: [], markerRequired: true, operation: null },
    canonicalState: 'setup_required', allowedActions: [], run_generation: 0,
    enabled: 0, control_state: 'paused', operation_id: null, operation_generation: 0,
    operation_status: 'none', operation_started_at: null, operation_confirmed_at: null,
    operation_session_id: null, operation_prompt_hash: null,
    operation_baseline_user_id: null, operation_receipt_user_id: null,
  };
  const operation = runtime.operation_id
    ? getDb().prepare('SELECT * FROM runner_operations WHERE id = ? AND runner_id = ?').get(runtime.operation_id, row.id)
    : getDb().prepare('SELECT * FROM runner_operations WHERE runner_id = ? ORDER BY generation DESC LIMIT 1').get(row.id);
  const legacyControl = {
    paused: 'paused', dispatching: 'enabled', awaiting_receipt: 'enabled', running: 'enabled',
    waiting_input: 'need_input', held: 'need_input', complete: 'finished', projection_error: 'need_input',
  }[runtime.state];
  const operationStatus = operation ? ({
    dispatching: 'pending', awaiting_receipt: 'unconfirmed', running: 'confirmed',
    held: 'held', invalidated: 'invalidated', completed: 'ended',
  }[operation.status] || 'none') : 'none';
  return {
    ...row,
    execution: {
      state: runtime.state,
      generation: runtime.generation,
      reasonCode: runtime.reason_code,
      reason: runtime.reason,
      allowedActions: runnerTransition.allowedActions(runtime.state),
      markerRequired: runnerTransition.markerRequired(runtime.state),
      operation: operation ? {
        id: operation.id,
        generation: operation.generation,
        kind: operation.operation_kind,
        status: operation.status,
        conversationId: operation.conversation_id,
        itemId: operation.item_id,
        queueRevision: operation.queue_revision,
        promptHash: operation.prompt_hash,
        baselineInputId: operation.baseline_input_id,
        receiptInputId: operation.receipt_input_id,
        deadlineAt: operation.deadline_at,
        createdAt: operation.created_at,
        updatedAt: operation.updated_at,
      } : null,
    },
    canonicalState: runtime.state,
    runtimeGeneration: runtime.generation,
    run_generation: runtime.generation,
    runtimeReasonCode: runtime.reason_code,
    runtimeReason: runtime.reason,
    allowedActions: runnerTransition.allowedActions(runtime.state),
    markerRequired: runnerTransition.markerRequired(runtime.state),
    control_state: legacyControl,
    enabled: ['dispatching', 'awaiting_receipt', 'running'].includes(runtime.state) ? 1 : 0,
    operation_id: runtime.operation_id || operation?.id || null,
    activeOperationId: runtime.operation_id,
    operation_status: operationStatus,
    operation_started_at: operation?.created_at || null,
    operation_confirmed_at: operation?.status === 'running' ? operation.updated_at : null,
    operation_deadline_at: operation?.deadline_at || null,
    operation_kind: operation?.operation_kind || null,
    operation_item_id: operation?.item_id || null,
    operation_queue_revision: operation?.queue_revision ?? null,
    operation_session_id: operation?.conversation_id || null,
    operation_prompt_hash: operation?.prompt_hash || null,
    operation_baseline_user_id: operation?.baseline_input_id || null,
    operation_receipt_user_id: operation?.receipt_input_id || null,
    last_reason: runtime.reason,
    stop_cause: runtime.reason_code,
  };
}

const TRANSITION_PAYLOAD_FIELDS = [
  'enabled', 'control_state', 'run_generation', 'operation_id', 'operation_generation',
  'operation_status', 'operation_started_at', 'operation_confirmed_at', 'operation_deadline_at',
  'operation_kind', 'operation_item_id', 'operation_queue_revision', 'operation_session_id',
  'operation_prompt_hash', 'operation_baseline_user_id', 'operation_receipt_user_id',
  'canonicalState', 'runtimeGeneration', 'runtimeReasonCode', 'runtimeReason',
  'allowedActions', 'markerRequired', 'activeOperationId', 'stop_cause', 'last_reason',
];

/** Public Mission runner metadata exposes one canonical execution object, never
 * the transition-era flat columns that used to look like independent authorities. */
function publicRunner(runner) {
  if (!runner) return runner;
  const out = { ...runner };
  for (const field of TRANSITION_PAYLOAD_FIELDS) delete out[field];
  // Plan 114 §2: the legacy observation columns outlive the transition that made
  // them false — a closed session still read `worker_state: working`, a paused
  // runner still read "Worker idle — grace 118s remaining" weeks later. The
  // canonical runtime is the authority, so the outward view must not contradict
  // it. (Internals keep the raw columns: grace timing reads idle_since.)
  if (!out.session_id) {
    out.worker_state = 'unknown';
    out.worker_turn_id = null;
    out.idle_since = null;
  }
  const state = out.execution?.state;
  if (state && !['dispatching', 'awaiting_receipt', 'running'].includes(state)) {
    out.scheduler_decision = ({ paused: 'paused', complete: 'finished', waiting_input: 'need_input', held: 'need_input' })[state] || 'blocked';
    out.scheduler_reason = out.execution.reason || null;
  }
  return out;
}

/** Get the enabled runner for a project (at most one). */
function getActiveRunnerForProject(projectId) {
  return getDb().prepare(`
    SELECT r.* FROM infinite_runners r JOIN runner_runtime rt ON rt.runner_id = r.id
    WHERE r.project_id = ? AND rt.state IN ('dispatching','awaiting_receipt','running')
    ORDER BY rt.updated_at DESC LIMIT 1
  `).get(projectId);
}

/** List runners for a project. */
function listRunnersForProject(projectId) {
  return getDb().prepare('SELECT * FROM infinite_runners WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
    .map((row) => withPromptTemplates(withRunnerRuntime(row)));
}

/** Every runner across every project the caller may see, each tagged with its
 *  project (plan 85 §Phase 2: the all-projects view merges infinite sessions
 *  into the same list, so it needs runners from every project, not just the
 *  selected one). Same `allow` contract as `listAllSessions`. */
function listAllRunners({ allow = null } = {}) {
  const projects = listProjects();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const visible = (p) => p && (!allow || allow(p.agent_name));
  return getDb().prepare('SELECT * FROM infinite_runners ORDER BY created_at DESC').all()
    .filter((r) => visible(byId.get(r.project_id)))
    .map((r) => withPromptTemplates({ ...withRunnerRuntime(r), project: projectTag(byId.get(r.project_id)) }));
}

/** Update runner settings (not state). `promptTemplates` follows the create
 *  contract: omitted preserves, explicit null resets to defaults, a complete
 *  object replaces after validation. */
async function updateRunner(id, { name, idleGraceMs, minNudgeIntervalMs, noProgressBudget,
  queueFile = undefined, compactionGraceMs, longCommandThresholdMs, recoverExited, recoveryBudget, promptTemplates = undefined }) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  if (queueFile !== undefined) {
    const project = getProject(runner.project_id);
    let normalized;
    try {
      normalized = plans.normalizeQueueFile(requireAgent(project.agent_name), project, queueFile);
    } catch (e) {
      if (e instanceof plans.PlansError) throw new MissionError(e.code, e.message);
      throw e;
    }
    if (normalized !== (runner.queue_file || 'QUEUE.md')) {
      const runtime = runnerTransition.getRuntime(id);
      if (!runtime || runtime.state !== 'paused' || runtime.operation_id) {
        throw new MissionError('runner_queue_file_busy', 'Pause supervision and wait for the active instruction to finish before changing the queue file.');
      }
      const projectAgent = requireAgent(project.agent_name);
      try { runnerPublication.assertPathAvailable(id, project, projectAgent, normalized); }
      catch (error) { if (error instanceof runnerPublication.RunnerPublicationError) throw new MissionError(error.code, error.message); throw error; }
      getDb().prepare('UPDATE infinite_runners SET queue_file = ?, updated_at = ? WHERE id = ?')
        .run(normalized, new Date().toISOString(), id);
      const publication = runnerPublication.read(id);
      if (publication) runnerPublication.invalidateAcknowledgement(id);
    }
  }
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (idleGraceMs !== undefined) { updates.push('idle_grace_ms = ?'); params.push(idleGraceMs); }
  if (minNudgeIntervalMs !== undefined) { updates.push('min_nudge_interval_ms = ?'); params.push(minNudgeIntervalMs); }
  if (noProgressBudget !== undefined) { updates.push('no_progress_budget = ?'); params.push(noProgressBudget); }
  if (compactionGraceMs !== undefined) { updates.push('compaction_grace_ms = ?'); params.push(compactionGraceMs); }
  if (longCommandThresholdMs !== undefined) { updates.push('long_command_threshold_ms = ?'); params.push(longCommandThresholdMs); }
  if (recoverExited !== undefined) { updates.push('recover_exited = ?'); params.push(recoverExited ? 1 : 0); }
  if (recoveryBudget !== undefined) { updates.push('recovery_budget = ?'); params.push(recoveryBudget); }
  const promptJson = parsePromptTemplatesInput(promptTemplates);
  if (promptJson !== PROMPT_TEMPLATES_PRESERVE) { updates.push('prompt_templates_json = ?'); params.push(promptJson); }
  if (!updates.length) return withPromptTemplates(getRunner(id));
  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  getDb().prepare(`UPDATE infinite_runners SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return withPromptTemplates(getRunner(id));
}

/** Set runner control state (enabled/paused/waiting/need_input/finished).
 *  Now uses the canonical runner transition service. */
async function setRunnerControlState(id, controlState) {
  if (!RUNNER_CONTROL_STATES.includes(controlState)) {
    throw new MissionError('runner_invalid_state', `Invalid control state: ${controlState}`);
  }
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  if (controlState === 'enabled') throw new MissionError('runner_operation_required', 'Use startRunner to authorize a specific durable operation.');

  const canonical = runnerTransition.getRunnerCanonicalState(runner);
  let result = null;

  switch (controlState) {
    case 'paused':
      if (canonical !== 'paused') {
        result = await runnerTransition.applyPause(id);
      }
      break;
    case 'waiting':
      if (canonical !== 'paused') {
        result = await runnerTransition.applyPause(id);
      }
      break;
    case 'need_input':
      if (['dispatching', 'awaiting_receipt', 'running'].includes(canonical)) {
        result = await runnerTransition.applyNeedInput(id);
      }
      break;
    case 'finished':
      if (['dispatching', 'awaiting_receipt', 'running'].includes(canonical)) {
        result = await runnerTransition.applyComplete(id);
      }
      break;
    case 'enabled':
      if (['paused', 'held', 'complete'].includes(canonical)) {
        result = await runnerTransition.applyRun(id);
      }
      break;
  }
  if (result?.markerRequired !== undefined) {
    syncQueuePausedMarker(id, result.markerRequired);
  }
  return result?.runner || getRunner(id);
}

/** Enable or disable queue dispatch — the ONE place `enabled` is written
 *  (plan 85 §Phase 4). Now uses the canonical runner transition service. */
async function setRunnerEnabled(id, on) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);

  if (on) throw new MissionError('runner_operation_required', 'Use startRunner to authorize a specific durable operation.');
  const result = await runnerTransition.applyPause(id);
  if (result?.markerRequired !== undefined) {
    syncQueuePausedMarker(id, result.markerRequired);
  }
  return result?.runner || getRunner(id);
}

/** Record the actionable reason a runner stopped or is waiting (shown in the
 *  terminal header). A refusal to Run writes this, never the runner's content. */
function setRunnerReason(id, reason) {
  runnerTransition.setReason(id, reason ? 'runner_notice' : null, reason || null);
}

/** Container-visible queue/index/paused paths for the worker (plan 85 §Phase 4 gap 7).
 *  `project.folder` IS the container path (checked inside the PAD at session
 *  start), and `plans_folder` is the subfolder beneath it — so the worker
 *  reaches its queue at `<folder>/<plans_folder>/<queue_file>`. The
 *  host-resolved `plans.queuePath` is for the webui's own reads; putting it in
 *  a prompt tells the worker a path that does not exist in its namespace. */
function runnerContainerPaths(project, queueFile) {
  const pf = String(project.plans_folder || 'plans').replace(/\/+$/, '') || 'plans';
  const qf = String(queueFile || 'QUEUE.md');
  const base = `${String(project.folder || '').replace(/\/+$/, '')}/${pf}`;
  return {
    queue: `${base}/${qf}`,
    index: `${base}/INDEX.md`,
    paused: `${base}/QUEUE.paused`,
  };
}

/** Sync the QUEUE.paused marker to match runner.enabled (best-effort). */
function syncQueuePausedMarker(runnerId, paused) {
  try {
    const runner = getRunner(runnerId);
    if (!runner) return;
    const project = getProject(runner.project_id);
    if (!project) return;
    const agent = requireAgent(project.agent_name);
    runnerPublication.publishMarker(runner, project, agent);
    // Clear any previous marker sync error on success
    getDb().prepare('UPDATE infinite_runners SET marker_sync_error = NULL WHERE id = ?').run(runnerId);
  } catch (e) {
    console.warn(`[runner] queue pause marker sync ${runnerId}:`, e.message);
    // Record the sync error for UI visibility
    getDb().prepare('UPDATE infinite_runners SET marker_sync_error = ? WHERE id = ?').run(e.message, runnerId);
  }
}

/** Record stop provenance: cause, origin (automatic/explicit), and timestamp. */
function recordStopProvenance(id, cause, origin, details = null) {
  runnerTransition.setReason(id, cause, JSON.stringify({ origin, details }));
}

/** Get runner with project and session details for supervision. */
async function getRunnerForSupervision(id) {
  const runner = getRunner(id);
  if (!runner) return null;
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  let session = null;
  if (runner.session_id) session = getSession(runner.session_id);
  let queue;
  try {
    queue = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(runner.id));
  } catch (e) {
    queueMissionError(e);
  }
  return { runner, project, agent, session, queue };
}

/** A queue item with the plan's own display metadata attached (plan 86 §Phase 1).
 *  The queue file names a plan path; the panel shows its TITLE and plan Status,
 *  so a named plan that no longer exists is visible as such (`exists: false`)
 *  rather than a bare path nobody can read. One failing plan must never blank
 *  the whole queue list. */
function enrichRunnerQueueItem(item, agent, project) {
  const out = {
    id: item.id,
    plan: item.plan,
    status: item.status,
    reason: item.reason || '',
  };
  try {
    const plan = plans.readPlan(agent, item.plan, { project });
    if (plan) {
      out.exists = true;
      out.title = plan.title;
      out.planStatus = plan.status;
      out.planStatusRaw = plan.statusRaw;
    } else {
      out.exists = false;
    }
  } catch (e) {
    out.exists = false;
  }
  return out;
}

/** Plan 86 §Phase 4b: decide a pending pause's next state from OBSERVATION,
 *  never from the enabled flag or a conversational claim. Purely:
 *   - `before_next_task`: confirmed once the target item is no longer
 *     `in progress` (the worker finished it), or there was no target at all.
 *     While the target is still `in progress`, the pause is still being applied.
 *   - `current_task`: confirmed ONLY once the worker is observed IDLE
 *     (`workerBusyKnown && !workerBusy`) — it stopped its turn mid-plan and kept
 *     the item `in progress` (its checkpoint). Without a KNOWN-idle observation
 *     we stay `requested` and never claim a stop we did not see.
 *  Returns 'confirmed' | 'requested' | null (null = no pending pause). */
function pauseConfirmation(runner, { targetStatus = null, workerBusy = null, workerBusyKnown = false } = {}) {
  if (!runner || runner.pause_state !== 'requested' || !runner.pause_mode) return null;
  if (runner.pause_mode === 'before_next_task') {
    return (!runner.pause_target_item || targetStatus !== 'in progress') ? 'confirmed' : 'requested';
  }
  return (workerBusyKnown && workerBusy === false) ? 'confirmed' : 'requested';
}

/** Apply pauseConfirmation to a runner using an already-read queue: a
 *  `before_next_task` need only the queue file; a `current_task` reads the
 *  worker conversation's own store for a known-idle observation. The update is
 *  guarded on `pause_state = 'requested'` so a concurrent Resume/Remove wins.
 *  Returns the (possibly refreshed) runner row. */
async function reconcileRunnerPause(runner, project, queue) {
  if (!runner || runner.pause_state !== 'requested' || !runner.pause_mode) return runner;
  const target = ((queue && queue.parsed && queue.parsed.items) || [])
    .find((it) => it.id === runner.pause_target_item) || null;
  let workerBusy = null;
  let workerBusyKnown = false;
  if (runner.pause_mode === 'current_task' && runner.session_id) {
    try {
      const session = getSession(runner.session_id);
      if (session && session.agent_session_id) {
        const turn = agentStore.readTurn(project.agent_name, session.agent_session_id);
        workerBusy = turn.state === 'working';
        workerBusyKnown = turn.state !== 'unknown';
      }
    } catch { /* session gone — cannot observe idle; stay requested */ }
  }
  const next = pauseConfirmation(runner, { targetStatus: target ? target.status : null, workerBusy, workerBusyKnown });
  if (next !== 'confirmed') return runner;
  const reason = runner.pause_mode === 'current_task'
    ? `Paused current task — ${target ? target.plan : 'the plan'} stopped at its checkpoint.`
    : 'Paused — next task will not start.';
  const changed = getDb().prepare(
    "UPDATE infinite_runners SET pause_state = 'confirmed', updated_at = ? WHERE id = ? AND pause_state = 'requested' AND EXISTS (SELECT 1 FROM runner_runtime rt WHERE rt.runner_id = infinite_runners.id AND rt.generation = ?)"
  ).run(new Date().toISOString(), runner.id, runner.run_generation);
  if (changed.changes) runnerTransition.setReason(runner.id, 'pause_confirmed', reason);
  return getRunner(runner.id);
}

/** The full queue picture for one runner (plan 86 §Phase 1): the parsed items
 *  (not just validator facts), each enriched with its plan's title/status, the
 *  one shared `summary` projection, the physical + worker-visible paths, the
 *  revision hash the panel must echo back when it edits, and a `condition`
 *  ('ok' | 'missing' | 'unreadable' | 'malformed') so "not set up yet" and
 *  "your queue file is broken" are different states instead of one `invalid`. */
async function readRunnerQueue(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  return readRunnerQueueFor(runner);
}

async function readRunnerQueueFor(runner) {
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  let q;
  try {
    q = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(runner.id));
  } catch (e) {
    if (e instanceof runnerQueue.RunnerQueueError && e.code === 'queue_not_found') {
      q = {
        parsed: { version: plans.QUEUE_VERSION, items: [], customInstructions: '' },
        aggregate: { state: 'invalid', reason: 'Canonical queue has not been set up.' },
        condition: 'missing', summary: plans.queueSummary({ items: [] }), path: plans.queuePath(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, runner.queue_file), hash: null, error: 'Canonical queue has not been set up.',
      };
    } else queueMissionError(e);
  }
  if (q.condition === 'projection_error') {
    const runtime = runnerTransition.getRuntime(runner.id);
    if (runtime && runtime.state !== 'projection_error') {
      const result = runnerTransition.applyProjectionMismatch(runner.id, {
        actor: 'projection-integrity', details: { reason: q.error, revision: runtime.generation },
      });
      syncQueuePausedMarker(runner.id, result.markerRequired);
    }
  }
  // Plan 86 §Phase 4b: a pending pause is confirmed from observation here — the
  // panel polls this read, so "Pausing…" becomes a truthful "Paused" once the
  // worker is seen to have stopped, and never before.
  // Invalid projection state is handled by the canonical runtime transition,
  // never by clearing legacy stop fields during a read.
  const repaired = runner;
  const current = await reconcileRunnerPause(repaired, project, q);
  const worker = current.session_id ? getSession(current.session_id) : null;
  const turn = agentStore.readTurn(agent, worker?.agent_session_id);
  const now = Date.now();
  const idleSince = turn.state === 'idle'
    ? (current.worker_state === 'idle' && current.worker_turn_id === turn.userId ? current.idle_since : turn.completedAt || new Date(now).toISOString())
    : null;
  const scheduler = computeSchedulerState({ ...current, idle_since: idleSince }, q, turn, now);
  const items = (q.parsed.items || []).map((it) => enrichRunnerQueueItem(it, agent, project));
  const execution = runnerQueueExecution(current, q, scheduler, { items, workerBusy: turn.state === 'working' });
  // Plan 91 §Phase 2: the Configure dialog reads saved prompts from this same
  // detail read, so the subset carries the effective set (never the raw column).
  const eff = effectivePromptTemplates(current);
  return {
    runner: {
      id: current.id, name: current.name, queue_file: current.queue_file,
      session_id: current.session_id, pause_mode: current.pause_mode, pause_state: current.pause_state,
      promptTemplates: eff.templates, promptTemplateVersion: eff.version,
      promptTemplatesCustom: eff.custom, promptTemplatesError: eff.error,
    },
    project: projectTag(project),
    queue: {
      state: execution.state === 'projection_error' ? 'projection_error' : q.aggregate.state,
      reason: q.error || (execution.state === 'projection_error' ? execution.reason : q.aggregate.reason),
      condition: q.condition,
      revision: q.hash,
      path: q.path,
      workerPath: runnerContainerPaths(project, current.queue_file).queue,
      items,
      repairItems: q.repairItems || [],
      repairDuplicateIds: q.repairDuplicateIds || [],
      customInstructions: q.parsed.customInstructions || '',
      summary: q.summary,
      error: q.condition === 'ok' && execution.state !== 'projection_error' ? null : (q.error || execution.reason || q.aggregate.reason),
      execution,
      scheduler: {
        ...scheduler,
        ...(q.condition !== 'ok' || execution.state === 'projection_error' ? { schedulerDecision: 'blocked', reason: q.error || execution.reason || q.aggregate.reason, nextCheckMs: null } : {}),
        deadline: scheduler.nextCheckMs === null ? null : new Date(now + scheduler.nextCheckMs).toISOString(),
        countdownLabel: { wait_idle_grace: 'Idle grace', wait_nudge_interval: 'Nudge interval' }[scheduler.schedulerDecision] || null,
        observedAt: new Date(now).toISOString(),
      },
    },
    updatedAt: current.updated_at,
  };
}

/** Gather the facts the pure view needs (services/runner-view.js builds the
 * verdict). Item progress is not runner authorization; projection repair wins
 * over stale operation and stop fields. */
function runnerQueueExecution(runner, queue, scheduler, { items = null, workerBusy = false } = {}) {
  const runtime = runnerTransition.getRuntime(runner.id);
  return runnerView.buildExecution({
    runtimeState: runtime ? runtime.state : null,
    queueCondition: queue.condition,
    queueError: queue.error || null,
    items: items || queue.parsed.items,
    summary: queue.summary,
    scheduler,
    operation: runner.activeOperationId ? {
      id: runner.activeOperationId,
      kind: runner.operation_kind,
      status: runner.operation_status,
      itemId: runner.operation_item_id,
      queueRevision: runner.operation_queue_revision,
      deadlineAt: runner.operation_deadline_at,
    } : null,
    outstanding: !!runtime?.operation_id,
    pauseMode: runner.pause_mode || null,
    workerBusy,
  });
}

/** Set a runner's queue up: create QUEUE.md from the template if it does not
 *  exist, then refuse if the file still will not validate. Concurrent creates
 *  are race-safe (`ensureQueue` writes with `wx` and re-reads a loser). */
async function setupRunnerQueue(id, { actor = null, confirmProjectionReset = false } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  const plansProject = { ...project, plans_folder: project.plans_folder || 'plans' };
  let existingSnapshot = null;
  try { existingSnapshot = runnerQueue.snapshot(id); }
  catch (error) { if (error.code !== 'queue_not_found') queueMissionError(error); }
  const currentPath = plans.queuePath(agent, plansProject, runner.queue_file);
  const fileExists = fs.existsSync(currentPath);
  let projectionDiffers = fileExists && !existingSnapshot;
  if (fileExists && existingSnapshot) {
    try {
      projectionDiffers = fs.readFileSync(currentPath, 'utf8') !== plans.queueProjection(existingSnapshot.items, existingSnapshot.customInstructions);
    } catch { projectionDiffers = true; }
  }
  if (projectionDiffers && !confirmProjectionReset) {
    throw new MissionError('runner_projection_confirmation_required',
      'The server will replace an existing QUEUE.md projection with the canonical database queue. Review the rows, then confirm Regenerate; no queue item status will be imported from the file.');
  }
  const existingRuntime = runnerTransition.getRuntime(id);
  let needsRepair = projectionDiffers || existingRuntime?.state === 'projection_error';
  try {
    const condition = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(id)).condition;
    needsRepair ||= condition === 'projection_error';
  } catch (e) {
    if (e.code !== 'queue_not_found') throw e;
    needsRepair ||= fileExists;
  }
  if (existingRuntime && ['dispatching', 'awaiting_receipt', 'running'].includes(existingRuntime.state) && !needsRepair) {
    throw new MissionError('runner_queue_setup_running', 'Pause/stop the runner before explicitly setting up its queue projection.');
  }
  if (!runnerTransition.getRuntime(id)) {
    // Explicit setup is the only initializer for old development runner rows.
    runnerTransition.createRuntime(id);
  }
  let currentRuntime = runnerTransition.getRuntime(id);
  if (needsRepair && currentRuntime.state !== 'projection_error') {
    runnerTransition.applyProjectionMismatch(id, { actor, details: { reason: 'Explicit projection regeneration' } });
    if (runnerPublication.read(id)) syncQueuePausedMarker(id, true);
  }
  let queue;
  try {
    queue = runnerQueue.ensure(id, { actor });
    writeCanonicalQueueProjection(runner, project, agent, queue);
  } catch (e) {
    queueMissionError(e);
  }
  audit(project, 'runner_queue_setup', { actor: actor ? (actor.name || actor) : null });
  if (needsRepair) {
    // A repaired projection never resumes work. Consume stale instruction and
    // stop fields together, so a late receipt cannot undo explicit repair.
    currentRuntime = runnerTransition.getRuntime(id);
    if (currentRuntime.state === 'projection_error') {
      runnerTransition.applyProjectionRegenerated(id, { actor, details: { reason: 'Explicit projection regeneration' } });
    }
  }
  // Sync marker to current enabled state (enabled=0 → paused marker exists).
  const current = getRunner(id);
  syncQueuePausedMarker(id, !current.enabled);
  return readRunnerQueueFor(current);
}

/** The plans available in a runner's project folder (plan 86 §Phase 3) —
 *  candidate rows for "Add plans". Scoped to the runner's OWN project folder
 *  (never another project's), with the folder's entry files (README/INDEX/
 *  QUEUE) and archived plans already excluded by `plans.listPlans`. The panel
 *  filters out plans already in the queue; this read just answers "what plans
 *  exist here". */
async function listRunnerPlans(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  const plansProject = { ...project, plans_folder: project.plans_folder || 'plans' };
  const rows = plans.listPlans(agent, { project: plansProject }) || [];
  return {
    runner: { id: runner.id, name: runner.name },
    project: projectTag(project),
    plans: rows.map((r) => ({
      path: r.path,
      title: r.title || null,
      status: r.status || null,
      statusRaw: r.statusRaw || null,
      done: !!r.done,
      session: r.session || null,
      created: r.created || null,
      lastActivity: r.last_activity || null,
      unreadable: r.unreadable || null,
    })),
  };
}

/** Legacy whole-array writes were the path that accepted browser-generated IDs.
 * Queue mutation is now explicit so the authority allocates and preserves IDs. */
async function updateRunnerQueue(id, _items, _revision, { actor = null } = {}) {
  throw new MissionError('queue_operation_required', 'Use add, reorder, remove, or item update operations; whole-queue writes are no longer supported.');
}

async function updateRunnerQueueItem(id, itemId, patch, revision, { actor = null, source = 'review' } = {}) {
  // The page only offers a hand correction in these states (runner-view's
  // reviewStatus verdict reads the same list); the write must refuse the rest
  // or a status flipped under a working worker races its own report.
  if (source === 'review') {
    const state = runnerTransition.getRuntime(id)?.state;
    if (state && !REVIEWABLE_STATES.includes(state)) {
      throw new MissionError('runner_invalid_state', `Pause the queue before changing a plan's status (current: ${state}).`, 409);
    }
  }
  const detail = await mutateCanonicalQueue(id, revision, actor, () => runnerQueue.updateItem(id, itemId, patch, revision, { actor, source }));
  if (source !== 'review') return detail;
  let runtime = runnerTransition.getRuntime(id);
  if (runtime?.state === 'projection_error') {
    runnerTransition.applyProjectionRegenerated(id, { actor: actor || 'user', details: { reason: 'Reviewed item status correction' } });
    runtime = runnerTransition.getRuntime(id);
  }
  const current = runnerQueue.snapshot(id);
  const hasBlocker = current.items.some((item) => item.status === 'need_input');
  const allDone = current.items.length > 0 && current.items.every((item) => item.status === 'done');
  if (runtime?.state === 'waiting_input' && !hasBlocker) {
    runnerTransition.applyResolve(id, { actor: actor || 'user', details: { reason: 'Human-reviewed status correction cleared the blocker.' } });
  } else if (runtime?.state === 'paused' && hasBlocker) {
    runnerTransition.applyQueueBlocked(id, { actor: actor || 'user', details: { reason: 'Human-reviewed queue status requires input.' } });
  } else if (runtime?.state === 'complete' && !allDone) {
    runnerTransition.applyEvent(id, 'work_added', { actor: actor || 'user', details: { reason: 'Human-reviewed status correction reopened queue work.' } });
    // Reopening a finished queue straight into a blocked item is a blocker, not
    // a plain pause: without this the header read Paused beside a blocker card.
    if (hasBlocker) runnerTransition.applyQueueBlocked(id, { actor: actor || 'user', details: { reason: 'Human-reviewed queue status requires input.' } });
  } else if (runtime?.state === 'paused' && allDone) {
    runnerTransition.applyReviewComplete(id, { actor: actor || 'user', details: { reason: 'Human reviewed all queue items complete.' } });
  }
  const latest = getRunner(id);
  syncQueuePausedMarker(id, runnerTransition.markerRequired(runnerTransition.getRuntime(id).state));
  return readRunnerQueueFor(latest);
}

async function mutateCanonicalQueue(id, revision, actor, mutate) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  let queue;
  const before = runnerQueue.snapshot(runner.id);
  try {
    queue = mutate();
    writeCanonicalQueueProjection(runner, project, agent, queue);
  } catch (e) {
    queueMissionError(e);
  }
  const oldItems = new Map(before.items.map((item) => [item.id, item]));
  const newItems = new Map(queue.items.map((item) => [item.id, item]));
  const key = `queue-mutation:${crypto.randomUUID()}`;
  for (const item of queue.items) if (!oldItems.has(item.id)) {
    runnerHistory.record(runner, 'plan_added', { actor: actor || 'user', key: `${key}:add:${item.id}`, plan: item.plan, itemId: item.id });
  }
  for (const item of before.items) if (!newItems.has(item.id)) {
    runnerHistory.record(runner, 'plan_removed', { actor: actor || 'user', key: `${key}:remove:${item.id}`, plan: item.plan, itemId: item.id });
  }
  if (oldItems.size === newItems.size && before.items.some((item, index) => queue.items[index]?.id !== item.id)) {
    runnerHistory.record(runner, 'queue_reordered', { actor: actor || 'user', key: `${key}:reordered`, reason: `${queue.items.length} queued item positions updated` });
  }
  audit(project, 'runner_queue_update', { actor: actor ? (actor.name || actor) : null });
  // Re-read: the mutation can change the runtime (adding work to a finished
  // queue moves complete -> paused), and the row read above still said
  // `complete`, so the response claimed "Queue is done" beside a Paused queue.
  return readRunnerQueueFor(getRunner(id));
}

async function addRunnerQueueItems(id, plansToAdd, revision, { actor = null } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  try {
    for (const plan of plansToAdd || []) plans.planPath(agent, plan, { project });
  } catch (error) {
    if (error instanceof plans.PlansError) throw new MissionError(error.code, error.message);
    throw error;
  }
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.addPlans(id, plansToAdd, revision, { actor }));
}

async function reorderRunnerQueue(id, itemIds, revision, { actor = null } = {}) {
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.reorder(id, itemIds, revision, { actor }));
}

async function removeRunnerQueueItem(id, itemId, revision, { actor = null } = {}) {
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.remove(id, itemId, revision, { actor }));
}

/** Revision-protected queue-level guidance edit. The queue file, rather than a
 * runner/database column, remains the sole editable source of truth. */
async function updateRunnerQueueCustomInstructions(id, customInstructions, revision, { actor = null } = {}) {
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.setCustomInstructions(id, customInstructions, revision, { actor }));
}

/** Resolve a need-input blocker: deliver the answer, requeue the item, and enable supervision.
 *  This is a SINGLE server-owned operation that replaces the client's send->requeue->start
 *  sequence, which fails because the answer makes the worker busy and startRunner then
 *  refuses with "worker not idle".
 *  Plan 97: atomic resolution with marker lift and supervision enable.
 */
async function resolveRunnerQueue(id, itemId, answer, revision, idempotencyKey, { actor = null } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const runtime = runnerTransition.getRuntime(id);
  if (!runtime || runtime.state !== 'waiting_input') {
    throw new MissionError('runner_invalid_state', `Runner must be waiting_input to resolve (current: ${runtime?.state || 'setup_required'})`);
  }
  const { project, agent, session, queue } = await getRunnerForSupervision(id);
  if (queue.condition !== 'ok') {
    throw new MissionError('runner_invalid_queue', queue.error || 'Regenerate the queue projection before resolving input.');
  }
  if (!session) throw new MissionError('runner_no_session', 'Runner has no bound session');
  if (queue.aggregate.state !== 'need input') {
    throw new MissionError('runner_no_need_input', 'Queue is not blocked on input');
  }
  const item = (queue.parsed.items || []).find((it) => it.id === itemId);
  if (!item) throw new MissionError('runner_item_not_found', `Item ${itemId} not found in queue`);
  if (item.status !== 'need input') {
    throw new MissionError('runner_item_not_blocked', `Item ${itemId} is not a need-input blocker`);
  }
  if (queue.hash !== revision) {
    throw new MissionError('queue_revision_conflict', 'Queue was modified since you loaded it — reload and retry');
  }

  // Idempotency check: if this exact key was used before, return the existing result
  if (idempotencyKey) {
    const existing = getDb().prepare('SELECT * FROM runner_resolutions WHERE runner_id = ? AND idempotency_key = ?').get(id, idempotencyKey);
    if (existing) return {
      delivered: existing.delivered_at,
      requeued: existing.requeued_at,
      resumed: existing.resumed_at,
      awaitingReceipt: ['pending', 'awaiting_receipt'].includes(existing.status),
      status: existing.status,
      resolutionId: existing.id,
    };
  }

  const agentObj = requireAgent(project.agent_name);

  // Reserve resolution ownership - prevent concurrent resolutions
  const resolutionId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  try {
    getDb().prepare(
      `INSERT INTO runner_resolutions (id, runner_id, item_id, answer, idempotency_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(resolutionId, id, itemId, answer, idempotencyKey || null, nowIso);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new MissionError('resolution_already_pending', 'Another resolution is in progress for this item');
    }
    throw e;
  }

  try {
    // Reserve the answer as its own durable operation before typing. It may
    // resume only after the exact answer receipt is observed.
    const baseline = agentStore.readTurn(agent, session.agent_session_id);
    const answerText = `Resolution for "${item.plan}": ${answer}`;
    const operationId = `rop_${crypto.randomUUID()}`;
    const resolveOperation = runnerTransition.applyResolveBegin(id, { actor: actor || 'user', details: {
      operationId, kind: 'resolution', conversationId: session.agent_session_id,
      itemId, queueRevision: revision,
      promptHash: crypto.createHash('sha256').update(answerText.trimEnd()).digest('hex'),
      baselineInputId: baseline.userId || null,
      deadlineAt: new Date(Date.now() + RUNNER_NO_RESPONSE_TIMEOUT_MS).toISOString(),
    } });
    syncQueuePausedMarker(id, false);
    runnerHistory.record(runner, 'answer_submitted', { actor: actor || 'user', groupId: `answer:${resolutionId}`, key: `${resolutionId}:submitted`, itemId, plan: item.plan, characters: String(answer).length });
    const beforeWrite = () => {
      const current = runnerTransition.getRuntime(id);
      const currentSession = getSession(session.id);
      if (!current || current.state !== 'dispatching' || current.operation_id !== operationId ||
          current.generation !== resolveOperation.runtime.generation || currentSession.locked ||
          currentSession.agent_session_id !== session.agent_session_id) {
        throw new MissionError('runner_resolution_superseded', 'Answer delivery was cancelled by Pause, Close, lock or conversation change.', 409);
      }
      const freshQueue = runnerQueue.snapshot(id);
      if (freshQueue.revision !== revision || freshQueue.items.find((entry) => entry.id === itemId)?.status !== 'need_input') {
        throw new MissionError('queue_revision_conflict', 'The blocked item changed before the answer was sent. Reload and review it.', 409);
      }
    };
    try {
      await sendText(session.id, answerText, { actor: actor || 'runner', beforeWrite });
    } catch (error) {
      if (error?.attempted && error?.acceptance === 'unknown') {
        runnerTransition.applyDeliveryUnknown(id, { actor: actor || 'user', details: { operationId, reason: 'resolution receipt not observed' } });
        getDb().prepare('UPDATE runner_resolutions SET status = ?, error = ? WHERE id = ?')
          .run('awaiting_receipt', 'Answer delivery is unconfirmed; no resend made.', resolutionId);
        syncQueuePausedMarker(id, false);
        return { delivered: null, requeued: null, resumed: null, awaitingReceipt: true, operationId };
      }
      throw error;
    }
    const expectedHash = crypto.createHash('sha256').update(answerText.trimEnd()).digest('hex');
    const receipt = await awaitExactReceipt(agent, session.agent_session_id, baseline.userId, expectedHash);
    if (!receipt) {
      runnerTransition.applyDeliveryUnknown(id, { actor: actor || 'user', details: { operationId, reason: 'resolution exact receipt not observed' } });
      getDb().prepare('UPDATE runner_resolutions SET status = ?, error = ? WHERE id = ?')
        .run('awaiting_receipt', 'Answer delivery is unconfirmed; no resend made.', resolutionId);
      syncQueuePausedMarker(id, false);
      return { delivered: null, requeued: null, resumed: null, awaitingReceipt: true, operationId };
    }
    runnerTransition.applyReceipt(id, { actor: actor || 'user', details: { operationId, receiptInputId: receipt.userId } });
    const currentQueue = runnerQueue.snapshot(id);
    const updatedQueue = runnerQueue.updateItem(id, itemId, { status: 'new', reason: '' }, currentQueue.revision, { actor, source: 'resolution' });
    writeCanonicalQueueProjection(getRunner(id), project, agentObj, updatedQueue);
    syncQueuePausedMarker(id, false);

    // Mark resolution as complete
    getDb().prepare('UPDATE runner_resolutions SET status = ?, delivered_at = ?, requeued_at = ?, resumed_at = ? WHERE id = ?')
      .run('completed', nowIso, nowIso, nowIso, resolutionId);
    runnerHistory.record(runner, 'answer_accepted', { actor: actor || 'user', groupId: `answer:${resolutionId}`, key: `${resolutionId}:accepted`, itemId, plan: item.plan });

    return { delivered: nowIso, requeued: nowIso, resumed: nowIso, operationId, receiptInputId: receipt.userId };
  } catch (e) {
    const currentRuntime = runnerTransition.getRuntime(id);
    if (currentRuntime?.state === 'dispatching') {
      runnerTransition.applyPause(id, { actor: actor || 'user', details: { reason: 'Resolution did not reach a confirmed receipt.' } });
      runnerTransition.setReason(id, 'resolution_failed', e.message);
      syncQueuePausedMarker(id, true);
    }
    getDb().prepare('UPDATE runner_resolutions SET status = ?, error = ? WHERE id = ?')
      .run('failed', e.message, resolutionId);
    runnerHistory.record(runner, 'answer_failed', { actor: actor || 'user', groupId: `answer:${resolutionId}`, key: `${resolutionId}:failed`, itemId, plan: item.plan, severity: 'warning', code: e.code || 'resolution_failed' });
    throw e;
  }
}

/** In-flight session ensures, one per runner. Concurrent opens of the same
 *  unbound runner must not mint two sessions (two TUIs, two conversations). */
const runnerEnsureInflight = new Map();

/** Idempotent worker-session ensure (plan 85 §Phase 1). Binds or resolves
 *  exactly one Mission session WITHOUT enabling queue execution or sending
 *  queue instructions. Unbound → create and bind; dead pane → restart the same
 *  conversation; bare shell → relaunch the TUI. The binding is retained even
 *  if a later step fails (a half-opened session is still the runner's session).
 *  Called only from explicit user actions (open, create, Run) — never from
 *  list reads or polling. */
async function ensureRunnerSession(id, { actor = null, origin = 'human', createdBy = null, beforeLaunch = null } = {}) {
  const prior = runnerEnsureInflight.get(id);
  if (prior) return prior;
  const run = (async () => {
    const runner = getRunner(id);
    if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
    let bound = null;
    if (runner.session_id) {
      try {
        bound = getSession(runner.session_id);
      } catch {
        bound = null; // row gone despite the FK — treat as unbound, rebind below
      }
    }
    if (!bound) {
      const created = await startSession(runner.project_id, {
        label: `Runner: ${runner.name}`,
        origin,
        createdBy: createdBy || actor,
        idempotencyKey: `runner-bind:${id}:${runner.run_generation}`,
      });
      bound = created.session;
      getDb().prepare('UPDATE infinite_runners SET session_id = ?, updated_at = ? WHERE id = ?')
        .run(bound.id, new Date().toISOString(), id);
      return getSession(bound.id);
    }
    const pre = await padTmux.paneState((getProject(runner.project_id)).agent_name, bound.tmux_id);
    if (!pre.live) {
      await restartSession(bound.id, { actor, beforeLaunch });
      return getSession(bound.id);
    }
    if (pre.tuiAlive === false) {
      await relaunchTui(bound.id, { actor, beforeLaunch });
      return getSession(bound.id);
    }
    return bound;
  })();
  runnerEnsureInflight.set(id, run);
  try {
    return await run;
  } finally {
    if (runnerEnsureInflight.get(id) === run) runnerEnsureInflight.delete(id);
  }
}

/** Start (or resume) a runner. Validates queue, binds/creates worker session, sends startup message.
 *  Plan 85: a runner that stopped for a fixable reason stays re-Runnable on the
 *  SAME session — `invalid`, `need input` and empty/all-done queues refuse with
 *  an actionable reason and leave the runner paused, never `finished`. Fixing
 *  the file and pressing Run again must work without creating another
 *  runner/session. */
async function startRunner(id, { actor = null } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const runtime = runnerTransition.getRuntime(id);
  if (!runtime) throw new MissionError('runner_setup_required', 'This runner has no canonical runtime. Explicitly set it up before running.');
  runnerHistory.record(runner, 'run_requested', { actor: actor || 'user' });
  try {
  if (!runnerTransition.STATES.includes(runtime.state)) throw new MissionError('runner_invalid_state', `Runner in invalid canonical state: ${runtime.state}`);
  let { project, agent, session, queue } = await getRunnerForSupervision(id);
  const refuse = async (code, reason) => {
    setRunnerReason(id, reason);
    throw new MissionError(code, reason);
  };
  // Validate queue. Check `invalid` BEFORE the empty check: readQueue returns
  // items:[] for a missing/malformed file too, so the empty branch would report
  // "nothing to do" for a queue that could not be read at all — the same silent
  // maybe, one layer up. A missing queue is an error the user must fix (create
  // it), an EMPTY queue is a valid "nothing left to do".
  if (!queue || queue.condition !== 'ok' || queue.aggregate.state === 'invalid') {
    await refuse('runner_invalid_queue', `Queue is invalid: ${queue?.error || (queue && queue.aggregate ? queue.aggregate.reason : 'unavailable')}`);
  }
  if (queue.aggregate.state === 'need input') {
    await refuse('runner_need_input', `Queue is blocked on input: ${queue.aggregate.reason || 'see the need-input item'}`);
  }
  if (queue.aggregate.state === 'done') {
    // Nothing to do — report it, stay paused. New work added later Runs again
    // on this same runner and session.
    setRunnerReason(id, queue.aggregate.reason || 'Queue is done.');
    return { started: false, reason: 'empty_queue', runner: getRunner(id) };
  }
  // Plan 116/117: the worker can only read/update the queue through the runner
  // MCP tools. Without them it (correctly) stops and reports, which the
  // supervisor cannot see. Wire them automatically; refuse only if that fails.
  const wiring = await ensureRunnerMcp(project);
  if (wiring.state === 'failed') {
    await refuse('runner_worker_tools_missing', `The worker cannot reach the queue: ${wiring.detail}`);
  }
  if (wiring.changed) {
    runnerHistory.record(getRunner(id), 'runner_tools_wired', { actor: actor || 'user', reason: `Installed the ${project.agent_name} runner MCP server (paddock_runner).` });
  }
  // MCP servers load when the TUI starts, so a worker TUI that was already
  // running when the tools were (re)wired does not have them. Restart it into the
  // SAME conversation — but never under a live turn.
  if (wiring.changed && session) {
    const pane = await padTmux.paneState(project.agent_name, session.tmux_id);
    if (pane.live) {
      const turn = session.agent_session_id ? agentStore.readTurn(agent, session.agent_session_id) : null;
      if (turn && turn.state !== 'idle') {
        await refuse('runner_worker_not_idle', 'The runner tools were just installed in this pad, and the worker must restart to load them, but it is mid-turn. Press Run again when its turn ends.');
      }
      await padTmux.killSession(project.agent_name, session.tmux_id);
      await restartSession(session.id, { actor });
      session = getSession(session.id);
      runnerHistory.record(getRunner(id), 'worker_restarted', { actor: actor || 'user', reason: 'Restarted the worker TUI into the same conversation so it loads the runner MCP tools.' });
    }
  }
  if (runtime.state === 'projection_error') {
    await refuse('runner_invalid_queue', 'Regenerate the queue projection before Run.');
  }
  if (['dispatching', 'awaiting_receipt'].includes(runtime.state)) {
    return { started: false, reason: runtime.state, runner: getRunner(id), operationId: runtime.operation_id };
  }
  if (runtime.state === 'waiting_input' && runner.stop_cause === 'usage_exhausted') {
    const callback = runnerCallbacks.getCallback(id, 'usage_exhausted');
    if (!callback.enabled || !callback.recreateResume) {
      throw new MissionError('quota_recovery_not_configured', 'Quota is exhausted. Enable the usage_exhausted callback and resume-after-success option before retrying recovery.');
    }
    const event = getDb().transaction(() => {
      const active = getDb().prepare(`SELECT id FROM runner_callback_outbox WHERE runner_id = ? AND event = 'usage_exhausted' AND status IN ('pending', 'running')
        UNION SELECT event_id AS id FROM runner_quota_recoveries WHERE runner_id = ? AND status IN ('script_running', 'restoring') LIMIT 1`).get(id, id);
      if (active) return { id: active.id, existing: true };
      const fresh = getRunner(id);
      const currentRuntime = runnerTransition.getRuntime(id);
      if (!fresh || currentRuntime?.state !== 'waiting_input' || currentRuntime.reason_code !== 'usage_exhausted' ||
          currentRuntime.generation !== runtime.generation) {
        throw new MissionError('quota_recovery_superseded', 'Runner state changed before recovery could be queued');
      }
      const updated = getRunner(id);
      const episode = getDb().prepare('SELECT episode_seq FROM runner_usage_state WHERE runner_id = ?').get(id);
      const recorded = runnerCallbacks.recordCallbackEvent(updated, project, 'usage_exhausted', {
        episodeKey: `${episode?.episode_seq || 0}:explicit:${updated.run_generation}`,
        cwd: project.folder,
        usageReason: 'Explicit Run requested quota recovery',
        actor: actor || 'user',
      });
      if (!recorded) throw new MissionError('quota_recovery_not_configured', 'Quota recovery callback could not be queued');
      return { id: recorded.id, existing: false };
    }).immediate();
    runnerHistory.record(runner, 'recovery_requested', { actor: actor || 'user', groupId: event.id, key: `${event.id}:requested`, reason: 'Explicit Run requested quota recovery' });
    runnerCallbacks.pumpCallbackOutbox().catch((e) => console.error('[quota recovery]', e.message));
    return { started: false, recovering: true, reason: 'quota_recovery_started', eventId: event.id, runner: getRunner(id) };
  }
  // A resolution can write successfully but lack a pane/store confirmation. If
  // its worker already moved the same queue forward, an explicit Run adopts that
  // verified active turn instead of sending a duplicate startup instruction.
  if (runtime.state === 'paused' && queue.aggregate.state === 'in progress' && session?.agent_session_id) {
    const activeTurn = agentStore.readTurn(agent, session.agent_session_id);
    if (activeTurn.state === 'working') {
      runnerTransition.applyAdoptActiveTurn(id, { actor: actor || 'user', details: { conversationId: session.agent_session_id, reason: 'adopting verified active turn' } });
      syncQueuePausedMarker(id, false);
      runnerHistory.record(runner, 'runner_started', { actor: actor || 'user', key: `started:${runner.run_generation}`, reason: 'Supervision resumed around the active worker' });
      return { started: true, reason: 'adopted_active_turn', runner: getRunner(id), session, queue: queue.aggregate };
    }
  }
  // An interrupted turn leaves supervision enabled so no other mutation can
  // race its observation, but automatic dispatch is deliberately withheld.
  // Run is the one explicit recovery path: it must re-observe below before it
  // can acquire a new delivery lease.
  const startTurn = runtime.state === 'running' && session?.agent_session_id
    ? agentStore.readTurn(agent, session.agent_session_id)
    : null;
  const interruptedTurn = startTurn?.state === 'idle' && startTurn.outcome === 'error';
  if (runtime.state === 'running' && !interruptedTurn) return { started: false, reason: 'already_running', runner: getRunner(id) };
  await ensureRunnerIndex(agent, project);
  // Plan 91 §Phase 4: check template health explicitly BEFORE the eligibility
  // gate, so a corrupt set refuses with its own code — the worker may be
  // perfectly idle, and `runner_worker_not_idle` would blame the wrong half.
  // canDispatch re-checks anyway for the paths that share it.
  const promptHealth = effectivePromptTemplates(getRunner(id));
  if (promptHealth.error) {
    await refuse('runner_prompts_misconfigured', `Prompt templates misconfigured: ${promptHealth.error.message} Repair them in Configure → Prompts, then retry.`);
  }
  if (!session) session = await ensureRunnerSession(id, { actor, origin: 'agent', createdBy: actor || 'runner' });
  if (interruptedTurn && runner.operation_id && ['pending', 'unconfirmed', 'confirmed'].includes(runner.operation_status)) {
    // This exact, completed error turn conclusively ends the old instruction.
    // Bind the update to its observed operation id so a second recovery click
    // cannot release the new operation another caller has already acquired.
    const interruptedRuntime = runnerTransition.getRuntime(id);
    if (interruptedRuntime?.state === 'running' && interruptedRuntime.operation_id === runner.operation_id) {
      runnerTransition.applyTurnCompleted(id, { actor: actor || 'user', details: { operationId: runner.operation_id, reason: 'interrupted turn explicitly recovered' } });
    }
  }
  const can = await canDispatch(id, { session, project, agent, queue, kind: 'start', gen: runner.run_generation });
  if (!can.allowed) await refuse(can.code || 'runner_worker_not_idle', can.reason);
  // Send the startup message FIRST, enable dispatch only after it lands. It is
  // ONE logical submission: Mission types line by line with an Enter each, so
  // a multiline banner would land as a dozen separate user messages. Paths are
  // container-visible (project.folder IS the container path); the host-resolved
  // path the webui reads does not exist in the worker's namespace.
  //
  // Order is the point: enabling first and sending second leaves an ENABLED
  // runner whose startup never arrived (a fresh TUI still booting refuses the
  // write while the pane looks live) — "Running" with an error, and no startup
  // to work from. A failed send stays paused with the reason recorded, and Run
  // again retries cleanly.
  //
  // Plan 91 §Phase 4: the message is the rendered `start` template — or the
  // full `resume` template after a CURRENT-TASK pause (the checkpoint lives in
  // the plan file the worker wrote when it stopped; a second Run must not
  // re-append anything). No hardcoded prompt fragments remain here.
  const resumingCurrentTask = runner.pause_mode === 'current_task' && !!runner.pause_target_item;
  const resumeTarget = resumingCurrentTask
    ? ((queue.parsed && queue.parsed.items) || []).find((it) => it.id === runner.pause_target_item) || null
    : null;
  let startup;
  try {
    startup = renderRunnerPrompt(runner, project, queue, resumingCurrentTask ? 'resume' : 'start',
      resumeTarget ? { current_plan: resumeTarget.plan } : {});
  } catch (e) {
    await refuse(e.code || 'prompt_render_failed', e.message);
  }
  const fullMsg = startup.text;
  // Plan 86 §Phase 4b fix (live-proven): the worker's FIRST action is queue rule
  // 7 — check that `QUEUE.paused` does not exist. A startup/continuation sent
  // while the marker is still present therefore makes the worker refuse its own
  // instruction and stop (a current-task RESUME immediately re-stopped). Lift
  // the marker BEFORE the message lands. Dispatch (`enabled`) stays 0 until the
  // send is confirmed below, so the supervisor dispatches nothing in the gap; a
  // failed send restores the marker so `disabled ⟺ marker present` still holds.
  const lease = acquireDispatchOwnership(id, runner.run_generation, 'start', can.queue.hash, session, fullMsg, can.turn.userId);
  if (!lease) await refuse('runner_dispatch_pending', 'Another instruction already owns this runner — no duplicate startup sent');
  syncQueuePausedMarker(id, false);
  let workerSession;
  try {
    const beforeLaunch = () => {
      const fresh = getRunner(id);
      if (!fresh || fresh.run_generation !== lease.gen || fresh.operation_id !== lease.operationId || fresh.operation_status !== 'pending') throw new MissionError('runner_dispatch_superseded', 'Startup cancelled by Pause/Close', 409);
    };
    beforeLaunch();
    workerSession = await ensureRunnerSession(id, { actor, origin: 'agent', createdBy: actor || 'runner', beforeLaunch });
    if (workerSession.agent_session_id !== session.agent_session_id) throw new MissionError('runner_identity_changed', 'Worker conversation changed during startup', 409);
    const result = await deliverRunnerInstruction(id, workerSession, project, agent, can.queue, fullMsg, lease, can.turn, 'start', actor);
    if (!result) return { started: false, reason: 'superseded', runner: getRunner(id) };
  } catch (e) {
    const currentRuntime = runnerTransition.getRuntime(id);
    if (currentRuntime?.operation_id === lease.operationId && currentRuntime.state === 'dispatching') {
      runnerTransition.applyPause(id, { actor: actor || 'user', details: { reason: e.message } });
      runnerTransition.setReason(id, e.code || 'dispatch_failed', e.message);
      syncQueuePausedMarker(id, true);
    }
    throw e;
  }
  // Any successful Run/Resume consumes the pause record — a Resume continues and
  // a fresh Run has nothing to pause. Clearing only for `current_task` left a
  // `before_next_task` record behind, so the dropdown badge read a false
  // "Paused" while the queue was visibly running (found live, 2026-10-11).
  // The `current_task` branch still needs its continuation sentence above; the
  // record itself is cleared in both cases here.
  getDb().prepare(
    "UPDATE infinite_runners SET pause_mode = NULL, pause_state = 'none', pause_target_item = NULL, pause_requested_at = NULL, scheduler_reason = 'Waiting for current turn', scheduler_decision = 'wait_turn_end', updated_at = ? WHERE id = ? AND run_generation = ?"
  ).run(new Date().toISOString(), id, lease.gen);
  const updated = getRunner(id);
  runnerHistory.record(updated, 'runner_started', { actor: actor || 'user', key: `started:${updated.run_generation}` });
  return { started: true, runner: updated, session: workerSession, queue: queue.aggregate };
  } catch (e) {
    runnerHistory.record(runner, 'run_failed', { actor: actor || 'user', severity: 'warning', code: e.code || 'run_failed' });
    throw e;
  }
}

/** Pause a runner: disable queue dispatch, keep the conversation.
 *  Plan 85: Pause controls the QUEUE, not the terminal. It invalidates the run
 *  generation first (any in-flight nudge/recovery aborts) and disables dispatch,
 *  but leaves the tmux pane and the conversation alone — the user may be
 *  watching it in column 3. An already-running turn may finish; Pause claims
 *  nothing about killing that turn or its background commands.
 *
 *  Plan 86 §Phase 4b adds two explicit modes. Both stop dispatch immediately and
 *  rely on the `QUEUE.paused` marker to stop the worker taking the NEXT item;
 *  they differ only in whether the worker is ALSO asked to stop mid-turn:
 *   - `before_next_task` (default; omitted mode is backward-compatible): finish
 *     the plan in flight, then wait. Resume continues the remaining queue in the
 *     same conversation.
 *   - `current_task`: send ONE logical message asking the worker to stop the plan
 *     it is on at the earliest safe checkpoint, saving progress, remaining work
 *     and resume instructions in that plan file and keeping its queue item
 *     `in progress`. Recorded as REQUESTED, never a confirmed pause — a false
 *     "Paused" claim would hide a worker still developing. If nothing is
 *     `in progress` (between items, or an unreadable queue) it degrades to
 *     `before_next_task`, because there is nothing to interrupt.
 *  Unknown modes are rejected. */
async function pauseRunner(id, { mode = 'before_next_task', actor = null } = {}) {
  if (!RUNNER_PAUSE_MODES.includes(mode)) {
    throw new MissionError('runner_invalid_pause_mode', `Invalid pause mode: ${mode}`);
  }
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  runnerHistory.record(runner, 'pause_requested', { actor: actor || 'user', mode });
  // Stop dispatch first, for BOTH modes: no nudge/recovery may fire from here on,
  // and the QUEUE.paused marker stops the worker from taking the next plan.
  await setRunnerEnabled(id, false);
  runnerHistory.record(runner, 'pause_applied', { actor: actor || 'user', mode, reason: 'Future dispatch stopped; an active task may still be finishing' });

  // Record explicit pause provenance
  recordStopProvenance(id, 'explicit_pause', 'explicit', { mode });

  // Resolve the in-progress item so a current-task pause can name its target.
  // A queue/session read failure is not fatal to Pause — it just means there is
  // no target, which degrades current_task to before_next_task.
  let sup = null;
  let targetItem = null;
  try {
    sup = await getRunnerForSupervision(id);
    targetItem = ((sup.queue && sup.queue.parsed && sup.queue.parsed.items) || []).find((it) => it.status === 'in progress') || null;
  } catch { /* queue/session unavailable — treat as no target */ }

  const nowIso = new Date().toISOString();
  // The canonical transition already invalidated the owned operation. Only
  // cooperative pause-request metadata is stored below.

  const writePause = (pauseMode, pauseState, targetId) => {
    getDb().prepare(
      'UPDATE infinite_runners SET pause_mode = ?, pause_state = ?, pause_target_item = ?, pause_requested_at = ?, updated_at = ? WHERE id = ?'
    ).run(pauseMode, pauseState, targetId, nowIso, nowIso, id);
  };

  if (mode === 'current_task' && targetItem) {
    let reason;
    if (sup && sup.session) {
      // Plan 91 §Phase 4: the stop request is the rendered `pause` template
      // naming the actual target plan. Dispatch was already disabled and the
      // operation invalidated above, so a template failure here must not undo
      // the Pause — it only withholds the cooperative message with a repair
      // reason, and the QUEUE.paused marker still stops the next item.
      let msg;
      try {
        msg = renderRunnerPrompt(runner, sup.project, sup.queue, 'pause', { current_plan: targetItem.plan }).text;
      } catch (e) {
        reason = `Pause requested — stop message not sent: ${e.message}`;
      }
      if (msg) {
        try {
          await sendText(sup.session.id, msg, { actor });
          reason = `Pausing current task — ${targetItem.plan}`;
        } catch (e) {
          // Plan 88 §Phase 2: an unobserved write is unconfirmed, not a failure.
          reason = e.acceptance === 'unknown'
            ? 'Pause requested — delivery unconfirmed: the stop message was written but the pane showed no change'
            : `Pause requested — not confirmed: ${e.message}`;
        }
      }
    } else {
      reason = 'Pause requested — not confirmed: no worker session';
    }
    writePause('current_task', 'requested', targetItem.id);
    setRunnerReason(id, reason);
    return getRunner(id);
  }

  // before_next_task, or a current_task request with nothing to interrupt.
  const targetPlan = targetItem ? targetItem.plan : null;
  writePause('before_next_task', 'requested', targetItem ? targetItem.id : null);
  setRunnerReason(id, targetPlan
    ? `Pausing after current task — ${targetPlan}`
    : 'Paused — next task will not start.');
  return getRunner(id);
}

/** Resume a paused runner. */
async function resumeRunner(id, { actor = null } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  if (runnerTransition.getRuntime(id)?.state !== 'paused') {
    throw new MissionError('runner_not_paused', 'Runner is not paused');
  }
  return startRunner(id, { actor });
}

// A receipt can arrive after the callback's bounded confirmation window. Resolve
// that exact persisted attempt without rerunning either the script or the send.
function reconcileQuotaReceipt(runner, session, agent, stillExhausted) {
  const recovery = getDb().prepare("SELECT * FROM runner_quota_recoveries WHERE runner_id = ? AND status = 'failed' AND error = 'Restored conversation has not acknowledged the continuation; no resend made' ORDER BY updated_at DESC LIMIT 1").get(runner.id);
  if (!recovery || runner.run_generation !== recovery.generation + 1 ||
      session.id !== recovery.session_id || session.agent_session_id !== recovery.conversation_id ||
      runner.operation_status !== 'unconfirmed') return;
  const turn = agentStore.readTurn(agent, session.agent_session_id);
  if (!turn.userId || turn.userId === runner.operation_baseline_user_id || turn.inputHash !== runner.operation_prompt_hash) return;
  const runtime = runnerTransition.getRuntime(runner.id);
  if (!runtime || runtime.operation_id !== runner.operation_id || runtime.state !== 'awaiting_receipt') return;
  if (stillExhausted) {
    runnerTransition.applyNeedInput(runner.id, { actor: 'quota-observer', details: { operationId: runner.operation_id, cause: 'usage_exhausted', reason: 'Recovery continuation accepted, but provider quota remains exhausted.' } });
  } else {
    runnerTransition.applyReceipt(runner.id, { actor: 'quota-observer', details: { operationId: runner.operation_id, receiptInputId: turn.userId } });
  }
  getDb().prepare('UPDATE runner_quota_recoveries SET status = ?, error = NULL, updated_at = ? WHERE event_id = ?')
    .run(stillExhausted ? 'exhausted_again' : 'resumed', new Date().toISOString(), recovery.event_id);
  runnerHistory.record(runner, 'continuation_accepted', { groupId: recovery.event_id, key: `${recovery.event_id}:receipt` });
  runnerHistory.record(runner, stillExhausted ? 'quota_remains' : 'recovery_resumed', { groupId: recovery.event_id, key: `${recovery.event_id}:late-result`, severity: stillExhausted ? 'warning' : 'info' });
  syncQueuePausedMarker(runner.id, runnerTransition.markerRequired(runnerTransition.getRuntime(runner.id).state));
}

/** Explicit quota-recovery scripts may recreate a PAD and authorize one new
 * instruction in the SAME conversation. Old store liveness belongs to the killed
 * process, so it cannot gate the first continuation in the replacement process. */
async function resumeQuotaRecovery(context) {
  const owns = () => {
    const r = getRunner(context.runner_id);
    const s = r && getSession(r.session_id);
    const runtime = r && runnerTransition.getRuntime(context.runner_id);
    if (!r || !runtime || runtime.state !== 'waiting_input' || r.run_generation !== context.generation || runtime.reason_code !== 'usage_exhausted' ||
        r.session_id !== context.session_id || s?.agent_session_id !== context.conversation_id || s.locked) {
      throw new MissionError('quota_recovery_superseded', 'Recovery cancelled by Pause, Close, lock, or changed conversation');
    }
    return r;
  };
  const runner = owns();
  let sup = await getRunnerForSupervision(runner.id);
  if (sup.queue.condition !== 'ok' || ['need input', 'done'].includes(sup.queue.aggregate.state)) {
    throw new MissionError('quota_recovery_queue_blocked', 'Queue is blocked or complete; no continuation sent');
  }
  // The script already proved container replacement. Clear only the dead
  // process's outstanding operation, then restore its saved TUI identity.
  owns();
  const deadline = Date.now() + 60000;
  let session;
  while (!session) {
    owns();
    try {
      session = await ensureRunnerSession(runner.id, { actor: 'quota-recovery', beforeLaunch: owns });
    } catch (e) {
      if (e.code === 'quota_recovery_superseded' || Date.now() >= deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  while (true) {
    owns();
    const pane = await padTmux.paneState(sup.project.agent_name, session.tmux_id);
    const screen = pane.live && pane.tuiAlive
      ? await padTmux.captureScreen(sup.project.agent_name, session.tmux_id, 12) : null;
    // Foreground process existence precedes OpenCode's input handlers. Its
    // bottom command footer establishes that the interactive UI has mounted.
    const inputReady = sup.agent.agent_type !== 'opencode' || /ctrl\+p\s+commands/.test(screen?.text || '');
    if (pane.live && pane.tuiAlive && inputReady) break;
    if (Date.now() >= deadline) throw new MissionError('quota_recovery_not_ready', 'Restored TUI did not become ready within 60 seconds');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  owns();
  sup = await getRunnerForSupervision(runner.id);
  runnerHistory.record(runner, 'session_restored', { groupId: context.event_id, key: `${context.event_id}:restored` });
  const message = renderRunnerPrompt(runner, sup.project, sup.queue, 'recovery').text;
  const baseline = agentStore.readTurn(sup.agent, session.agent_session_id);
  const lease = acquireDispatchOwnership(runner.id, context.generation, 'quota-recovery', sup.queue.hash, session, message, baseline.userId);
  if (!lease) throw new MissionError('quota_recovery_owned', 'Another operation already owns recovery');
  const beforeWrite = () => {
    const current = getRunner(runner.id);
      const currentRuntime = runnerTransition.getRuntime(runner.id);
    if (!current || !currentRuntime || currentRuntime.state !== 'dispatching' || currentRuntime.operation_id !== lease.operationId ||
        currentRuntime.generation !== lease.runtimeGeneration || current.run_generation !== lease.gen || getSession(session.id).locked) {
      throw new MissionError('quota_recovery_superseded', 'Recovery continuation cancelled by newer control action');
    }
    const turn = agentStore.readTurn(sup.agent, session.agent_session_id);
    if (turn.userId !== baseline.userId) throw new MissionError('quota_recovery_superseded', 'A new human turn arrived during recovery');
  };
  syncQueuePausedMarker(runner.id, false);
  try {
    await sendText(session.id, message, { actor: 'quota-recovery', beforeWrite, paste: true });
  } catch (e) {
    if (!e.attempted || e.acceptance !== 'unknown') {
      const currentRuntime = runnerTransition.getRuntime(runner.id);
      if (currentRuntime?.state === 'dispatching' && currentRuntime.operation_id === lease.operationId) {
        runnerTransition.applyPause(runner.id, { actor: 'quota-recovery', details: { reason: e.message } });
        runnerTransition.setReason(runner.id, 'quota_recovery_failed', e.message);
      }
      syncQueuePausedMarker(runner.id, true);
      throw e;
    }
    // A missing repaint is not non-delivery. Check the exact input below.
  }
  runnerHistory.record(runner, 'continuation_sent', { groupId: context.event_id, key: `${context.event_id}:sent` });
  const expectedInput = crypto.createHash('sha256').update(message.trimEnd()).digest('hex');
  const receiptDeadline = Date.now() + 20000;
  let receipt = null;
  do {
    const turn = agentStore.readTurn(sup.agent, session.agent_session_id);
    if (turn.userId && turn.userId !== baseline.userId && turn.inputHash === expectedInput) {
      receipt = turn.userId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < receiptDeadline);
  if (!receipt) {
    runnerTransition.applyDeliveryUnknown(runner.id, { actor: 'quota-recovery', details: { operationId: lease.operationId, reason: 'quota receipt not observed' } });
    syncQueuePausedMarker(runner.id, false);
    throw new MissionError('quota_recovery_unconfirmed', 'Restored conversation has not acknowledged the continuation; no resend made');
  }
  runnerTransition.applyReceipt(runner.id, { actor: 'quota-recovery', details: { operationId: lease.operationId, receiptInputId: receipt } });
  getDb().prepare("UPDATE infinite_runners SET scheduler_decision = 'wait_turn_end', scheduler_reason = 'Quota recovery continuation sent' WHERE id = ?")
    .run(runner.id);
  runnerHistory.record(runner, 'continuation_accepted', { groupId: context.event_id, key: `${context.event_id}:receipt` });
}

/** Remove runner (disable supervision, release binding, keep session/queue).
 *  Plan 85: Remove unpins the row and stops supervision IN PLACE. The Mission
 *  session row and QUEUE.md are separate and untouched — the session stays open
 *  with its live pane, and simply returns to the ordinary listing. Deleting the
 *  row drops supervision with it (the watcher selects `enabled = 1`, so a gone
 *  row is unwatched), and the bumped generation aborts any in-flight send. */
async function removeRunner(id, { actor = null } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  runnerTransition.applyClose(id, { actor: actor || 'user', details: { reason: 'Runner removed; execution revoked.' } });
  syncQueuePausedMarker(id, true);
  const detachedQueue = runnerQueue.detach(id, { actor: actor || 'user' });
  // Plan 92 §Phase 3: capture the destroy snapshot BEFORE the row goes away —
  // the outbox carries the script body, so later edits or the deletion itself
  // cannot change a recorded event. A misconfigured/absent destroy callback
  // records nothing (or an error row) and never blocks the removal.
  let destroyEventId = null;
  try {
    const project = getProject(runner.project_id);
    const recorded = runnerCallbacks.recordCallbackEvent(runner, project, 'destroy', { cwd: project.folder });
    destroyEventId = recorded && recorded.status === 'pending' ? recorded.id : null;
  } catch (e) {
    if (!(e instanceof runnerCallbacks.CallbackError)) throw e;
  }
  try {
    getDb().prepare('DELETE FROM infinite_runners WHERE id = ?').run(id);
  } catch (e) {
    // The destroy did not happen — withdraw its pending outbox row, if any.
    if (destroyEventId) getDb().prepare("DELETE FROM runner_callback_outbox WHERE id = ? AND status = 'pending'").run(destroyEventId);
    throw e;
  }
  runnerHistory.record(runner, 'runner_removed', { actor: actor || 'user', key: `removed:${runner.run_generation}` });
  // "remove the runner configuration/designation. Keep any existing Mission
  // session/conversation and queue file. The row loses runner controls and
  // pinning." The Mission session row and QUEUE.md are separate and untouched,
  // so the session simply returns to the ordinary listing. A soft delete was
  // wrong: the pinned list renders every row, and a kept row with
  // session_id = NULL / enabled = 0 / 'paused' is indistinguishable from a
  // created-but-never-started runner — so "remove" left the pin in place
  // forever (there is no column that could say "this runner was removed").
  // (The DELETE itself ran above, before the marker sync, so a recorded
  // destroy event can be withdrawn if the delete fails.)
  // The worker file remains a read-only projection, but the marker is left
  // present so a detached worker cannot silently take another item.
  // Plan 92 §Phase 3: a recorded destroy script launches in the background —
  // removal never waits for it (it may run up to the script timeout).
  if (destroyEventId) {
    runnerCallbacks.pumpCallbackOutbox().catch((e) => console.error(`[callbacks] pump after destroy failed:`, e.message));
  }
  return { removed: true, queuePreserved: !!detachedQueue, queueRevision: detachedQueue?.revision ?? null };
}

/** Reconcile durable desired publications before the watcher starts. A crash
 * after DB commit but before filesystem acknowledgement is retried. A file that
 * differs from an already-acknowledged revision is treated as an external edit
 * and is never overwritten on boot. */
function reconcileQueuePublications() {
  const runners = getDb().prepare('SELECT * FROM infinite_runners').all();
  let published = 0;
  let blocked = 0;
  for (const row of runners) {
    try {
      const runner = getRunner(row.id);
      const publication = runnerPublication.read(row.id);
      if (!publication) continue; // explicit setup is the only initializer
      const project = getProject(row.project_id);
      if (!project) continue;
      const agent = requireAgent(project.agent_name);
      const snapshot = runnerQueue.snapshot(row.id);
      const projectionPath = plans.queuePath(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, runner.queue_file);
      const expected = plans.queueProjection(snapshot.items, snapshot.customInstructions);
      const exists = fs.existsSync(projectionPath);
      const actual = exists ? fs.readFileSync(projectionPath, 'utf8') : null;
      if (actual !== expected && publication.acknowledged_revision === snapshot.revision &&
          publication.acknowledged_hash === runnerQueue.publicationHash(snapshot)) {
        const runtime = runnerTransition.getRuntime(row.id);
        if (runtime && runtime.state !== 'projection_error') {
          runnerTransition.applyProjectionMismatch(row.id, {
            actor: 'boot-integrity', details: { reason: 'Acknowledged worker projection changed outside Paddock.' },
          });
        }
        syncQueuePausedMarker(row.id, true);
        blocked++;
        continue;
      }
      if (publication.desired_revision !== snapshot.revision || publication.desired_hash !== runnerQueue.publicationHash(snapshot) ||
          publication.acknowledged_revision !== snapshot.revision || publication.acknowledged_hash !== runnerQueue.publicationHash(snapshot) || publication.error) {
        runnerPublication.publish(runner, project, agent);
        published++;
      }
      const currentRuntime = runnerTransition.getRuntime(row.id);
      syncQueuePausedMarker(row.id, !currentRuntime || runnerTransition.markerRequired(currentRuntime.state));
    } catch (error) {
      console.error(`[runner publication reconcile] ${row.id}:`, error.message);
    }
  }
  return { published, blocked };
}

/** Report active canonical runtimes after restart; never auto-resume uncertain work. */async function reconcileRunners() {
  const runners = getDb().prepare("SELECT runner_id AS id FROM runner_runtime WHERE state IN ('dispatching','awaiting_receipt','running')").all();
  for (const r of runners) {
    const runner = getRunner(r.id);
    // The run generation was incremented on pause/remove, so a restarted webui
    // sees run_generation > 0 but control_state = 'paused'.
    // We do NOT auto-resume — the human must explicitly Resume.
    // Just ensure the generation is respected (it already is).
    console.log(`[runner reconcile] Runner ${runner.id} (${runner.name}) was enabled at shutdown; control_state=${runner.control_state}, run_generation=${runner.run_generation}. Awaiting explicit Resume.`);
  }
}

/** Plan 92 §Phase 3: first-observation baseline for init callbacks. For every
 *  runner row, an enabled init script with no prior init event records exactly
 *  once (dedup-guarded). Runs for ALL runners — paused ones included — because
 *  init is about configuration existing, not supervision running. Never sends
 *  LLM input, never touches the queue, never blocks on execution (pump is
 *  fire-and-forget). */
async function baselineRunnerCallbacks() {
  const runners = getDb().prepare('SELECT * FROM infinite_runners').all();
  let recorded = 0;
  for (const runner of runners) {
    try {
      const project = getProject(runner.project_id);
      const row = runnerCallbacks.recordCallbackEvent(runner, project, 'init', { cwd: project.folder });
      if (row && row.status === 'pending') recorded++;
    } catch { /* a bad row must not stop the baseline pass */ }
  }
  if (recorded) {
    runnerCallbacks.pumpCallbackOutbox().catch((e) => console.error('[callbacks] pump failed:', e.message));
  }
  return recorded;
}

/** Thin wrappers so routes and the supervisor tick go through mission. */
function pumpCallbackOutbox(opts) {
  return runnerCallbacks.pumpCallbackOutbox(opts);
}
function reconcileCallbackOutbox() {
  return runnerCallbacks.reconcileCallbackOutbox();
}

/** Replay canonical queue events in order, including transitions that begin and
 * finish between observer polls. */
async function observeRunnerQueues() {
  const runners = getDb().prepare('SELECT * FROM infinite_runners').all();
  let recorded = 0;
  for (const runner of runners) {
    try {
      const project = getProject(runner.project_id);
      if (!project) continue;
      const agent = requireAgent(project.agent_name);
      runnerQueue.snapshot(runner.id); // fail closed on runners without canonical setup
      const queuePath = plans.queuePath(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, runner.queue_file);
      recorded += runnerCallbacks.observeCanonicalEvents(runner, project, { queuePath });
    } catch { /* one bad runner must not stop the observation pass */ }
  }
  if (recorded) {
    runnerCallbacks.pumpCallbackOutbox().catch((e) => console.error('[callbacks] pump failed:', e.message));
  }
  return recorded;
}

/** Plan 92 §Phase 3: run the usage-exhaustion observer for every runner bound
 *  to a supervisor session. The measured signature (plan 75 row 8) is read from
 *  the worker conversation's OWN store and disambiguated with the SAME busy
 *  probe the Mission lists use, so a live turn (which also ends in a user
 *  message) is never mistaken for exhaustion. An unreadable store — or a busy
 *  probe that could not answer — WITHHOLDS the event and never clears an armed
 *  episode, so an operational failure cannot end one. One bad runner never
 *  stops the pass; recording pumps are fire-and-forget. */
async function observeRunnerUsage() {
  const runners = getDb().prepare(`SELECT r.* FROM infinite_runners r JOIN runner_runtime rt ON rt.runner_id = r.id
    WHERE rt.state IN ('dispatching','awaiting_receipt','running')`).all();
  let recorded = 0;
  for (const runner of runners) {
    try {
      const sup = await getRunnerForSupervision(runner.id);
      if (!sup || !sup.session || !sup.session.agent_session_id) continue;
      const { project, agent, session } = sup;
      const probe = await busyForSessions([{ agent_name: project.agent_name, agent_session_id: session.agent_session_id }]);
      const busyKnown = probe.knownOf.get(session.agent_session_id) === true;
      const busy = probe.busyOf.get(session.agent_session_id) === true;
      const screen = await padTmux.captureScreen(project.agent_name, session.tmux_id, 80);
      const explicit = require('./provider-limit').screenUsageEvidence(screen);
      const evidence = explicit || agentStore.readUsageEvidence(agent, session.agent_session_id);
      if (explicit) {
        const runtime = runnerTransition.getRuntime(runner.id);
        if (runtime && ['dispatching', 'awaiting_receipt', 'running'].includes(runtime.state)) {
          const stopped = runnerTransition.applyNeedInput(runner.id, { actor: 'usage-observer', details: { cause: 'usage_exhausted', reason: explicit.reason } });
          syncQueuePausedMarker(runner.id, stopped.markerRequired);
        }
      }
      recorded += runnerCallbacks.observeUsage(runner, project, evidence, { busy, busyKnown });
      if (explicit || evidence.state === 'ok') reconcileQuotaReceipt(getRunner(runner.id), session, agent, !!explicit);
    } catch { /* one bad runner must not stop the observation pass */ }
  }
  if (recorded) {
    runnerCallbacks.pumpCallbackOutbox().catch((e) => console.error('[callbacks] pump failed:', e.message));
  }
  return recorded;
}
async function dispatchNext(runnerId, session, project, agent, queue, kind, gen = getRunner(runnerId)?.run_generation) {
  const runner = getRunner(runnerId);
  if (!runner) return;

  // Phase 2: Unified scheduler predicate — gate ALL dispatch paths.
  const can = await canDispatch(runnerId, { session, project, agent, queue, kind, gen });
  if (!can.allowed) {
    if (can.reason) setRunnerReason(runnerId, can.reason);
    return;
  }

  try {
    await ensureRunnerIndex(agent, project);
    // Plan 91 §Phase 4: the continuation is the rendered `continue` template —
    // no hardcoded prompt fragments. A misconfigured set or missing context
    // throws here and lands in the reason below with no send, same as any
    // other dispatch failure.
    const msg = renderRunnerPrompt(runner, project, can.queue, 'continue').text;
    const ownership = acquireDispatchOwnership(runnerId, gen, kind, can.queue.hash, session, msg, can.turn.userId);
    if (ownership) await deliverRunnerInstruction(runnerId, session, project, agent, can.queue, msg, ownership, can.turn, kind, 'runner');
  } catch (e) {
    if (getRunner(runnerId)?.run_generation === gen) setRunnerReason(runnerId, e.message);
  }
}

/** The supervisor watch loop — called periodically for enabled runners. */
async function runnerWatchTick() {
  const runners = getDb().prepare("SELECT runner_id AS id FROM runner_runtime WHERE state = 'running'").all();
  for (const r of runners) {
    try {
      await runnerWatchOnce(r.id);
    } catch (e) {
      console.error(`[runner watch] Runner ${r.id} tick error:`, e.message);
    }
  }
}

/** Single watch tick for one runner.
 *  Uses the canonical runner transition service for state changes. */
async function runnerWatchOnce(runnerId) {
  const runner = getRunner(runnerId);
  const runtime = runnerTransition.getRuntime(runnerId);
  if (!runner || !runtime || runtime.state !== 'running') return;
  const gen = runner.run_generation;

  const stopWith = async (event, reason, cause, details = {}) => {
    try {
      const result = await runnerTransition.applyEvent(runnerId, event, { actor: 'watcher', details: { reason, cause, ...details } });
      if (result?.markerRequired !== undefined) {
        syncQueuePausedMarker(runnerId, result.markerRequired);
      }
    } catch (e) {
      if (e.code === 'runner_transition_invalid') {
        console.log(`[runner watch] ${runnerId}: invalid transition ${event} from ${e.message}`);
      } else {
        throw e;
      }
    }
    runnerHistory.record(runner, cause === 'finished' ? 'queue_completed' : 'queue_stopped', { key: `stop:${gen}:${cause}`, severity: cause === 'finished' ? 'info' : 'warning', reason });
  };

  const { project, agent, session, queue } = await getRunnerForSupervision(runnerId);
  if (!session) {
    console.log(`[runner watch] ${runnerId}: no worker session bound`);
    return;
  }
  // Verify this run generation still owns the lease
  const fresh = getRunner(runnerId);
  if (!fresh || fresh.run_generation !== gen || runnerTransition.getRuntime(runnerId)?.state !== 'running') return; // superseded by new Start/Pause/Remove
  // Read and validate queue
  if (!queue || queue.condition !== 'ok' || queue.aggregate.state === 'invalid') {
    await stopWith('projection_mismatch', `Queue is invalid: ${queue?.error || (queue && queue.aggregate ? queue.aggregate.reason : 'unavailable')}`, 'invalid_queue');
    return;
  }
  if (queue.aggregate.state === 'done') {
    const completedTurn = agentStore.readTurn(agent, session.agent_session_id);
    observeRunnerTurn(fresh, session, completedTurn);
    if (completedTurn.state !== 'idle') {
      recordSchedulerDecision(runnerId, gen, { workerState: completedTurn.state || 'unknown', schedulerDecision: 'wait_turn_end', reason: 'All items are marked done; waiting for the owned worker turn to finish.', nextCheckMs: 1000, recoveryRequired: false });
      return;
    }
    await stopWith('complete', queue.aggregate.reason || 'Queue is done.', 'finished');
    return;
  }
  if (queue.aggregate.state === 'need input') {
    await stopWith('need_input', `Queue is blocked on input: ${queue.aggregate.reason || 'see the need-input item'}`, 'need_input');
    return;
  }
  // Plan 91 §Phase 4: corrupt stored templates withhold automatic sends. This
  // is a configuration failure the user repairs in Configure → Prompts — so
  // the tick stops with an actionable reason (re-Runnable after repair, like
  // an invalid queue) rather than dispatching a broken prompt or dying quiet.
  const promptEff = effectivePromptTemplates(fresh);
  if (promptEff.error) {
    await stopWith('projection_mismatch', `Prompt templates misconfigured: ${promptEff.error.message} Repair them in Configure → Prompts, then Run again.`, 'prompts_misconfigured');
    return;
  }
  // Observe pane/turn state
  const paneState = await padTmux.paneState(project.agent_name, session.tmux_id);
  if (!paneState.live || paneState.tuiAlive === false) {
    runnerHistory.record(runner, 'worker_exited', { key: `worker-exited:${gen}:${runner.recovery_count}`, severity: 'warning' });
    console.log(`[runner watch] ${runnerId}: pane dead`);
    if (runner.recover_exited && runner.recovery_count < runner.recovery_budget) {
      await recoverWorkerSession(runnerId, gen, project, session);
    } else {
      await stopWith('hold', `Worker pane is gone and the recovery budget is exhausted (health: suspected_stuck). Reopen the session or press Run.`, 'recovery_exhausted');
    }
    return;
  }
  // Check permission/solo lock
  const screen = await padTmux.captureScreen(project.agent_name, session.tmux_id, 20);
  const perm = detectPermission(screen.text);
  const verdict = sendVerdict({ ...session, live: paneState.live, tuiAlive: paneState.tuiAlive, command: paneState.command }, perm);
  if (!verdict.canSend) {
    if (verdict.refusal.startsWith('mission_permission_pending')) {
      await stopWith('need_input', `Worker is waiting on a permission dialog: ${verdict.refusal}`, 'permission_dialog');
    }
    recordSchedulerDecision(runnerId, gen, { workerState: 'unknown', schedulerDecision: 'blocked', reason: verdict.refusal });
    return;
  }
  const turn = agentStore.readTurn(agent, session.agent_session_id);
  const observed = observeRunnerTurn(runner, session, turn);
  const decision = computeSchedulerState(observed, queue, turn, Date.now());
  recordSchedulerDecision(runnerId, gen, decision);
  if (decision.schedulerDecision === 'dispatch') {
    const kind = observed.last_dispatch_revision !== queue.hash ? 'rev' : 'retry';
    await dispatchNext(runnerId, session, project, agent, queue, kind, gen);
  } else if (decision.schedulerDecision === 'need_input') {
    await stopWith('need_input', decision.reason, 'scheduler_need_input');
  }
}

/**
 * Phase 3 Plan 90: Compute truthful scheduler state for UI feedback.
 * Returns { workerState, schedulerDecision, reason, nextCheckMs }.
 * workerState: 'working' | 'idle' | 'unknown'
 * schedulerDecision: 'dispatch' | 'wait_idle_grace' | 'wait_nudge_interval' | 'wait_turn_end' | 'paused' | 'observation_unavailable' | 'no_work' | 'finished'
 *
 * Plan 91 §Phase 5: a confirmed send the worker never takes must not wait
 * forever. The retry budget never exhausts while an operation is outstanding,
 * so `wait_turn_end` once persisted 12+ minutes on a startup whose repaint
 * confirmation was the TUI boot banner, not the input landing (proven live:
 * the prompt never reached the conversation's store). Bound it: an
 * outstanding instruction with a VERIFIED-IDLE worker, no exact receipt, and
 * a send older than RUNNER_NO_RESPONSE_TIMEOUT_MS escalates to need_input.
 * Never a resend, never a silent release — the human re-Runs. A working
 * worker is exempt (long tasks must not trip it), and anything but verified
 * idle stays suppressed rather than escalating on a guess.
 */
const RUNNER_NO_RESPONSE_TIMEOUT_MS = 10 * 60 * 1000;
function computeSchedulerState(runner, queue, turn, now = Date.now(), { explicit = false } = {}) {
  const state = turn?.state || 'unknown';
  const decision = (schedulerDecision, reason, nextCheckMs = null, recoveryRequired = false) => ({ workerState: state, schedulerDecision, reason, nextCheckMs, recoveryRequired });
  const executionState = runner.canonicalState || 'setup_required';
  if (!explicit && executionState !== 'running') {
    if (executionState === 'complete') return decision('finished', 'Queue is done');
    if (executionState === 'waiting_input') return decision('need_input', runner.runtimeReason || 'Queue needs input');
    if (executionState === 'held') return decision('need_input', runner.runtimeReason || 'Operation is held');
    if (executionState === 'projection_error') return decision('blocked', runner.runtimeReason || 'Queue projection needs repair');
    if (executionState === 'setup_required') return decision('no_work', 'Set up the canonical runner runtime');
    // A send in flight is not a pause: these two states said "Queue paused"
    // under a Dispatching header.
    if (executionState === 'dispatching') return decision('dispatching', 'Sending the next plan to the worker');
    if (executionState === 'awaiting_receipt') return decision('dispatching', runner.runtimeReason || 'Waiting for the worker to acknowledge the plan');
    return decision('paused', 'Queue paused');
  }
  if (!queue || queue.aggregate.state === 'invalid') return decision('no_work', 'Queue unavailable or invalid');
  if (queue.aggregate.state === 'done') return decision('finished', 'Queue is done');
  if (queue.aggregate.state === 'need input') return decision('need_input', queue.aggregate.reason || 'Queue needs input');
  if (state === 'working') return decision('wait_turn_end', 'Waiting for current turn');
  if (state !== 'idle') return decision('observation_unavailable', turn?.reason || 'Turn observation unavailable — automatic sends withheld');
  // This is intentionally narrower than observation_unavailable: only a
  // verified completed error turn needs an explicit Run recovery.
  if (turn?.outcome === 'error' && !explicit) return decision('observation_unavailable', turn.reason, null, true);
  if (['pending', 'unconfirmed', 'confirmed'].includes(runner.operation_status)) {
    const deadline = Date.parse(runner.operation_deadline_at);
    const unanswered = state === 'idle' && !runner.operation_receipt_user_id
      && Number.isFinite(deadline) && now >= deadline;
    if (unanswered) {
      return decision('need_input', `No worker response within ${Math.round(RUNNER_NO_RESPONSE_TIMEOUT_MS / 60000)} minutes of the sent instruction — it may never have arrived. No resend was made; check the conversation and Run again.`);
    }
    return decision('wait_turn_end', 'Previous instruction outstanding — waiting for its completed turn');
  }
  if (explicit) return decision('dispatch', 'Worker idle — ready to start');
  const idleSince = Date.parse(runner.idle_since);
  if (!Number.isFinite(idleSince)) return decision('observation_unavailable', 'Idle transition not yet observed');
  const graceRemaining = runner.idle_grace_ms - (now - idleSince);
  if (graceRemaining > 0) return decision('wait_idle_grace', `Worker idle — grace ${Math.ceil(graceRemaining / 1000)}s remaining`, graceRemaining);
  const lastDispatch = Date.parse(runner.last_nudge_at || runner.last_dispatch_at);
  const intervalRemaining = runner.min_nudge_interval_ms - (now - lastDispatch);
  if (Number.isFinite(lastDispatch) && intervalRemaining > 0) return decision('wait_nudge_interval', `Waiting for nudge interval (${Math.ceil(intervalRemaining / 1000)}s)`, intervalRemaining);
  const changed = runner.last_dispatch_revision !== queue.hash;
  if (!changed && runner.retry_count >= runner.no_progress_budget) return decision('need_input', `No progress after ${runner.no_progress_budget} dispatches — the queue needs a human`);
  return decision('dispatch', changed ? 'Worker idle — ready for next queued item' : 'Worker idle — ready to continue current item');
}

function recordSchedulerDecision(id, gen, decision) {
  getDb().prepare('UPDATE infinite_runners SET worker_state = ?, scheduler_decision = ?, scheduler_reason = ? WHERE id = ? AND run_generation = ?')
    .run(decision.workerState, decision.schedulerDecision, decision.reason, id, gen);
}

/** Observe progress, not the polling clock. Keep accepted instructions outstanding
 * across every step until a stop message for their input has actually completed. */
function observeRunnerTurn(runner, session, turn) {
  const progress = Date.parse(turn.progressAt);
  const prior = Date.parse(runner.last_progress_at);
  const advanced = Number.isFinite(progress) && (!Number.isFinite(prior) || progress > prior);
  const sameIdle = runner.worker_state === 'idle' && runner.worker_turn_id === turn.userId;
  const idleSince = turn.state === 'idle' ? (sameIdle ? runner.idle_since : (turn.completedAt || new Date().toISOString())) : null;
  getDb().prepare('UPDATE infinite_runners SET worker_state = ?, worker_turn_id = ?, idle_since = ?, last_progress_at = ?, retry_count = ? WHERE id = ? AND run_generation = ? AND operation_generation = ?')
    .run(turn.state, turn.userId || null, idleSince, advanced ? turn.progressAt : runner.last_progress_at, advanced ? 0 : runner.retry_count, runner.id, runner.run_generation, runner.operation_generation);
  if (runner.operation_session_id === session.agent_session_id && runner.operation_id) {
    const accepted = turn.userId && turn.userId !== runner.operation_baseline_user_id && turn.inputHash === runner.operation_prompt_hash;
    const received = runner.operation_receipt_user_id || (accepted ? turn.userId : null);
    if (received) {
      const runtime = runnerTransition.getRuntime(runner.id);
      const op = runtime?.operation_id && getDb().prepare('SELECT status FROM runner_operations WHERE id = ? AND runner_id = ?').get(runtime.operation_id, runner.id);
      if (runtime?.operation_id === runner.operation_id && ['dispatching', 'awaiting_receipt'].includes(runtime.state) &&
          ['dispatching', 'awaiting_receipt'].includes(op?.status)) {
        try {
          runnerTransition.applyReceipt(runner.id, { actor: 'worker-observer', details: { operationId: runtime.operation_id, receiptInputId: received } });
        } catch (error) {
          if (error.code !== 'runner_transition_invalid' && error.code !== 'runner_operation_superseded') throw error;
        }
      }
      const afterReceipt = runnerTransition.getRuntime(runner.id);
      const activeOp = afterReceipt?.operation_id && getDb().prepare('SELECT status FROM runner_operations WHERE id = ? AND runner_id = ?').get(afterReceipt.operation_id, runner.id);
      if (turn.state === 'idle' && afterReceipt?.state === 'running' && afterReceipt.operation_id === runner.operation_id && activeOp?.status === 'running') {
        try {
          runnerTransition.applyTurnCompleted(runner.id, { actor: 'worker-observer', details: { operationId: afterReceipt.operation_id, receiptInputId: received } });
        } catch (error) {
          if (error.code !== 'runner_transition_invalid' && error.code !== 'runner_operation_superseded') throw error;
        }
      }
    }
  }
  return getRunner(runner.id);
}

/**
 * Unified scheduler predicate — Phase 2 Plan 90.
 * Single gate for ALL dispatch paths (revChanged, retry, nudge, recovery, startRunner).
 * Returns { allowed: boolean, reason: string, freshRunner: object }.
 * Uses atomic DB check-and-set for ownership to prevent duplicate dispatches
 * from overlapping ticks or concurrent requests.
 */
async function canDispatch(runnerId, { session, project, agent, queue, kind, gen }) {
  let fresh = getRunner(runnerId);
  const explicit = kind === 'start';
  const quotaRecovery = kind === 'quota-recovery';
  const runtime = runnerTransition.getRuntime(runnerId);
  const runtimeEligible = runtime && (runtime.state === 'running' ||
    (explicit && ['paused', 'held', 'complete'].includes(runtime.state)) ||
    (quotaRecovery && runtime.state === 'waiting_input'));
  if (!fresh || !runtimeEligible || fresh.run_generation !== gen) {
    return { allowed: false, reason: 'runner disabled or generation stale', freshRunner: fresh };
  }
  // Plan 91 §Phase 4: a custom prompt cannot bypass eligibility, and a broken
  // one cannot send at all. Corrupt stored templates withhold EVERY dispatch
  // reason here — the same gate the watcher, retry, recovery and start paths
  // all share — with the repair named in the reason.
  const promptEff = effectivePromptTemplates(fresh);
  if (promptEff.error) {
    return { allowed: false, reason: `prompt templates misconfigured: ${promptEff.error.message} Repair them in Configure → Prompts, then retry.`, freshRunner: fresh };
  }
  // Three different refusals that used to share one string (and, via
  // startRunner, the code `runner_worker_not_idle` — wrong for all three).
  if (!session?.agent_session_id) return { allowed: false, code: 'runner_worker_identity_unavailable', reason: 'The worker session has no conversation id, so its turns cannot be observed. Close the worker session and press Run to start a fresh one.', freshRunner: fresh };
  if (fresh.session_id !== session.id) return { allowed: false, code: 'runner_worker_identity_unavailable', reason: 'The runner is bound to a different worker session than this one.', freshRunner: fresh };
  if (getSession(session.id)?.locked) return { allowed: false, code: 'runner_worker_locked', reason: 'The worker session is solo-locked by a human; unlock it to let the runner send.', freshRunner: fresh };
  const turn = agentStore.readTurn(agent, session.agent_session_id);
  fresh = observeRunnerTurn(fresh, session, turn);
  const currentQueue = canonicalQueueProjection(fresh, project, agent, runnerQueue.snapshot(fresh.id));
  if (currentQueue.condition !== 'ok') {
    return { allowed: false, reason: currentQueue.error || 'Queue projection needs repair.', freshRunner: fresh, turn, queue: currentQueue };
  }
  const decision = computeSchedulerState(fresh, currentQueue, turn, Date.now(), { explicit });
  recordSchedulerDecision(runnerId, gen, decision);
  return { allowed: decision.schedulerDecision === 'dispatch', reason: decision.reason, freshRunner: fresh, turn, queue: currentQueue };
}

/**
 * Atomic ownership acquisition for a dispatch.
 * The canonical runtime CAS is the only operation-owner constraint. Legacy
 * operation columns are not written; runner_operations owns attempt facts.
 * Returns the new operationId if acquired, null if another tick won.
 */
function acquireDispatchOwnership(runnerId, gen, kind, queueHash, session, message, baselineUserId) {
  const fresh = getRunner(runnerId);
  const explicit = kind === 'start';
  const quotaRecovery = kind === 'quota-recovery';
  if (!fresh || fresh.run_generation !== gen) return null;
  const runtime = runnerTransition.getRuntime(runnerId);
  const transitionEvent = quotaRecovery ? 'quota_recovery' : runtime?.state === 'running' ? 'dispatch_next' : 'run';
  if (!runtime || (explicit ? !['paused', 'held', 'complete', 'running'].includes(runtime.state)
      : quotaRecovery ? runtime.state !== 'waiting_input' : runtime.state !== 'running')) return null;
  const operationId = `rop_${crypto.randomUUID()}`;
  let transitionResult;
  const nowIso = new Date().toISOString();
  const db = getDb();
  const operationGeneration = runtime.generation + 1;
  const tx = db.transaction(() => {
    transitionResult = runnerTransition.applyEvent(runnerId, transitionEvent, {
      actor: 'mission', details: {
        operationId, conversationId: session.agent_session_id,
        itemId: queueHash && runnerQueue.snapshot(runnerId).summary.current?.id || runnerQueue.snapshot(runnerId).summary.next?.id,
        promptHash: crypto.createHash('sha256').update(message.trimEnd()).digest('hex'),
        baselineInputId: baselineUserId || null,
        deadlineAt: new Date(Date.now() + RUNNER_NO_RESPONSE_TIMEOUT_MS).toISOString(),
      },
    });
    const result = db.prepare(`UPDATE infinite_runners SET last_dispatch_at = ?, last_nudge_at = ?,
      last_dispatch_revision = ?, retry_count = ?, updated_at = ? WHERE id = ?`)
      .run(nowIso, nowIso, queueHash || null, kind === 'retry' ? fresh.retry_count + 1 : fresh.retry_count,
        nowIso, runnerId);
    if (!result.changes) throw new MissionError('runner_dispatch_owned', 'Another instruction owns this runner.', 409);
    return { operationId, operationGeneration, gen: transitionResult.runtime.generation, runtimeGeneration: transitionResult.runtime.generation };
  });
  try { return tx.immediate(); }
  catch (e) {
    if (e.code === 'runner_dispatch_owned') return null;
    throw e;
  }
}

async function ensureRunnerIndex(agent, project) {
  try {
    await plans.initProjectPlans(agent.name, project);
  } catch (e) {
    throw new MissionError('runner_index_unavailable', `Plan rules INDEX.md could not be prepared: ${e.message}. Repair the project's plans folder and press Run.`, 409);
  }
}

/** Every runner send owns one durable operation. A late receipt may update ONLY
 * that operation/generation; it can never undo Pause/Close or enable a newer run. */
async function deliverRunnerInstruction(id, session, project, agent, queue, message, lease, baselineTurn, kind, actor) {
  const owns = () => {
    const r = getRunner(id);
    const runtime = runnerTransition.getRuntime(id);
    return r && runtime && runtime.state === 'dispatching' && runtime.operation_id === lease.operationId
      && runtime.generation === lease.runtimeGeneration
      && r.run_generation === lease.gen && r.session_id === session.id
      && r.operation_session_id === session.agent_session_id;
  };
  const beforeWrite = () => {
    if (!owns() || getSession(session.id)?.locked) throw new MissionError('runner_dispatch_superseded', 'Dispatch cancelled by Pause/Close, lock or newer operation', 409);
    const turn = agentStore.readTurn(agent, session.agent_session_id);
    if (turn.state !== 'idle' || (turn.outcome === 'error' && kind !== 'start') || turn.userId !== baselineTurn.userId) throw new MissionError('runner_worker_not_idle', 'Worker started another turn — instruction withheld', 409);
    // Plan 113: the DB is the authority and `QUEUE.md` is a GENERATED projection.
    // The old check compared the file's content hash against the queue revision
    // — two different kinds of value (a sha256 vs a counter), so it was ALWAYS
    // true and every dispatch was refused. What must be re-checked here is the
    // CANONICAL state: the revision must not have moved, and the projection must
    // not have drifted from it (a drift is an external edit, not a transition).
    const current = runnerQueue.snapshot(id);
    if (current.revision !== queue.hash) {
      throw new MissionError('runner_dispatch_superseded', 'Queue changed before delivery — instruction withheld', 409);
    }
    const drifted = canonicalQueueProjection(getRunner(id), project, agent, current);
    if (drifted.condition !== 'ok') {
      throw new MissionError('runner_dispatch_superseded', 'Queue projection changed before delivery — instruction withheld', 409);
    }
    if (fs.existsSync(plans.queuePausedPath(agent, project))) {
      throw new MissionError('runner_dispatch_superseded', 'Queue is paused before delivery — instruction withheld', 409);
    }
  };
  try {
    const result = await sendText(session.id, message, { actor, beforeWrite });
    if (!owns()) return null;
    const expectedHash = crypto.createHash('sha256').update(message.trimEnd()).digest('hex');
    const observed = await awaitExactReceipt(agent, session.agent_session_id, baselineTurn.userId, expectedHash, { stillOwned: owns });
    if (!owns()) return null;
    if (!observed) {
      throw new MissionError('mission_send_unconfirmed', 'Instruction written, but its exact input receipt has not been observed; no resend made.', 409, { attempted: true, acceptance: 'unknown' });
    }
    // Confirm the exact owned row once. A state helper that sets confirmed
    // before this pending-only CAS makes a successful delivery look superseded.
    const commitReceipt = getDb().transaction(() => {
      runnerTransition.applyReceipt(id, { actor, details: { operationId: lease.operationId, receiptInputId: observed.userId } });
      const changed = getDb().prepare("UPDATE infinite_runners SET worker_state = ?, scheduler_decision = 'wait_turn_end', scheduler_reason = 'Waiting for current turn', updated_at = ? WHERE id = ? AND run_generation = ?")
        .run(observed.state, new Date().toISOString(), id, lease.gen);
      if (!changed.changes) throw new MissionError('runner_dispatch_superseded', 'Receipt lost operation ownership.', 409);
    });
    commitReceipt.immediate();
    return result;
  } catch (e) {
    if (!owns()) return null;
    const status = e.acceptance === 'unknown' || e.attempted || !e.code ? 'unconfirmed' : 'ended';
    runnerHistory.record(getRunner(id), status === 'unconfirmed' ? 'delivery_unconfirmed' : 'dispatch_failed', { key: `${lease.operationId}:delivery-error`, severity: 'warning', code: e.code || 'delivery_unknown', reason: status === 'unconfirmed' ? 'A write was attempted; automatic resend withheld while waiting for receipt.' : 'Instruction was withheld before acceptance.' });
    // Transition from dispatching (pending) to awaiting_receipt (unconfirmed) via delivery_unknown event
    if (status === 'unconfirmed') {
      // Keep supervision observing the outstanding attempt, including startup.
      // This authorizes receipt reconciliation, never another send.
      runnerTransition.applyDeliveryUnknown(id, { actor, details: { operationId: lease.operationId, reason: 'exact receipt not observed' } });
    } else {
      const currentRuntime = runnerTransition.getRuntime(id);
      if (currentRuntime?.state === 'dispatching' && currentRuntime.operation_id === lease.operationId) {
        runnerTransition.applyPause(id, { actor, details: { reason: e.message } });
        runnerTransition.setReason(id, e.code || 'dispatch_failed', e.message);
      }
    }
    syncQueuePausedMarker(id, runnerTransition.markerRequired(runnerTransition.getRuntime(id).state));
    throw e;
  }
}
async function reconcileRunnerOperation(runnerId, { actor = null } = {}) {
  const runner = getRunner(runnerId);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${runnerId} not found`);
  const { project, agent, session, queue } = await getRunnerForSupervision(runnerId);
  if (queue.condition !== 'ok') {
    throw new MissionError('runner_invalid_queue', queue.error || 'Regenerate the queue projection before reconciling.');
  }
  const runtime = runnerTransition.getRuntime(runnerId);
  if (runtime?.state === 'held') {
    const heldOperation = runner.operation_id && getDb().prepare('SELECT * FROM runner_operations WHERE id = ? AND runner_id = ? AND status = \'held\'').get(runner.operation_id, runnerId);
    if (!heldOperation || !session || session.agent_session_id !== heldOperation.conversation_id) {
      throw new MissionError('runner_held_operation_missing', 'Held operation evidence is unavailable; Run will create a fresh operation.');
    }
    const heldTurn = agentStore.readTurn(agent, session.agent_session_id);
    const receiptObserved = !!(heldTurn.userId && heldTurn.userId !== heldOperation.baseline_input_id && heldTurn.inputHash === heldOperation.prompt_hash);
    runnerHistory.record(runner, 'reconciled_held', { actor: actor || 'user', key: `${heldOperation.id}:held-inspected`, reason: receiptObserved ? 'Late exact receipt observed after Hold; authorization remains revoked.' : 'No exact receipt found; operation remains held.' });
    return { reconciled: true, held: true, receiptObserved, resumed: false, reason: 'Hold remains in force. Use Run fresh to authorize a new operation.' };
  }
  if (!['pending', 'unconfirmed', 'confirmed'].includes(runner.operation_status)) {
    throw new MissionError('runner_no_pending_operation', `No pending operation to reconcile (status: ${runner.operation_status})`);
  }
  if (!runner.session_id) throw new MissionError('runner_no_session', 'Runner has no bound session');
  if (!runner.operation_session_id) throw new MissionError('runner_no_operation_session', 'Operation has no bound conversation');
  if (!session) throw new MissionError('runner_no_session', 'Runner session not found');
  if (session.agent_session_id !== runner.operation_session_id) {
    throw new MissionError('runner_identity_changed', 'Worker conversation changed — operation invalidated');
  }

  // Read the worker's store for the exact operation receipt
  const turn = agentStore.readTurn(agent, session.agent_session_id);
  const matched = turn.userId
    && turn.userId !== runner.operation_baseline_user_id
    && turn.inputHash === runner.operation_prompt_hash;

  const nowIso = new Date().toISOString();

  if (matched) {
    const operation = getDb().prepare('SELECT * FROM runner_operations WHERE id = ? AND runner_id = ?').get(runner.operation_id, runnerId);
    if (operation?.operation_kind === 'resolution') {
      const queueSnapshot = runnerQueue.snapshot(runnerId);
      const target = queueSnapshot.items.find((item) => item.id === operation.item_id);
      if (target?.status === 'need_input') {
        if (queueSnapshot.revision !== operation.queue_revision) {
          throw new MissionError('queue_revision_conflict', 'The queue changed after the answer was delivered; review the blocked item before continuing.');
        }
        await updateRunnerQueueItem(runnerId, target.id, { status: 'new', reason: '' }, queueSnapshot.revision, { actor, source: 'resolution' });
      }
    }
    const receiptResult = runnerTransition.applyReceipt(runnerId, { actor, details: { operationId: runner.operation_id, receiptInputId: turn.userId } });
    if (turn.state === 'idle') {
      runnerTransition.applyTurnCompleted(runnerId, { actor, details: { operationId: runner.operation_id, receiptInputId: turn.userId } });
    }
    syncQueuePausedMarker(runnerId, receiptResult.markerRequired);
    getDb().prepare(`UPDATE infinite_runners SET pause_mode = NULL, pause_state = 'none',
      pause_target_item = NULL, pause_requested_at = NULL, scheduler_decision = 'wait_turn_end',
      scheduler_reason = 'Reconciled — instruction confirmed', updated_at = ? WHERE id = ?`)
      .run(nowIso, runnerId);
    runnerHistory.record(runner, 'reconciled_confirmed', { actor: actor || 'user', key: `${runner.operation_id}:receipt`, receiptUserId: turn.userId });
    if (operation?.operation_kind === 'resolution') {
      getDb().prepare(`UPDATE runner_resolutions SET status = 'completed', delivered_at = COALESCE(delivered_at, ?),
        requeued_at = COALESCE(requeued_at, ?), resumed_at = ? WHERE runner_id = ? AND item_id = ? AND status IN ('pending','awaiting_receipt')`)
        .run(nowIso, nowIso, nowIso, runnerId, operation.item_id);
    }
    return { reconciled: true, confirmed: true, receiptUserId: turn.userId, workerState: turn.state };
  }

  // No exact receipt yet — check if we should hold the operation
  const deadline = Date.parse(runner.operation_deadline_at);
  const noResponseTimeout = 10 * 60 * 1000; // RUNNER_NO_RESPONSE_TIMEOUT_MS
  const unanswered = turn.state === 'idle'
    && !runner.operation_receipt_user_id
    && Number.isFinite(deadline)
    && Date.now() >= deadline;

  if (unanswered) {
    // Terminal expiry without a receipt — hold the operation via hold transition
    try {
      const holdResult = await runnerTransition.applyHold(runnerId, { actor, details: { operationId: runner.operation_id, reason: 'timeout' } });
      if (holdResult?.markerRequired !== undefined) {
        syncQueuePausedMarker(runnerId, holdResult.markerRequired);
      }
    } catch (e) {
      if (e.code !== 'runner_transition_invalid') throw e;
    }
    runnerTransition.setReason(runnerId, 'operation_timeout',
      `No worker response within ${Math.round(noResponseTimeout / 60000)} minutes of the sent instruction — no resend was made.`);
    runnerHistory.record(runner, 'reconciled_held', { actor: actor || 'user', key: `${runner.operation_id}:held`, reason: 'timeout' });
    syncQueuePausedMarker(runnerId, true);
    return { reconciled: true, confirmed: false, held: true, reason: 'timeout' };
  }

  // Still awaiting receipt — leave operation as-is, marker absent
  runnerHistory.record(runner, 'reconciled_awaiting', { actor: actor || 'user', key: `${runner.operation_id}:awaiting`, workerState: turn.state });
  return { reconciled: false, confirmed: false, awaiting: true, workerState: turn.state };
}
async function recoverWorkerSession(runnerId, gen, project, deadSession) {
  const sup = await getRunnerForSupervision(runnerId);
  const can = await canDispatch(runnerId, { ...sup, session: deadSession, kind: 'recovery', gen });
  if (!can.allowed) return;
  await ensureRunnerIndex(sup.agent, project);
  // Plan 91 §Phase 4: recovery speaks the rendered `recovery` template. A
  // template failure withholds the recovery send with a reason — it must never
  // recreate a worker it cannot instruct.
  let recoveryMsg;
  try {
    recoveryMsg = renderRunnerPrompt(sup.runner, project, can.queue, 'recovery').text;
  } catch (e) {
    setRunnerReason(runnerId, `Recovery withheld: ${e.message}`);
    return;
  }
  const lease = acquireDispatchOwnership(runnerId, gen, 'recovery', can.queue.hash, deadSession, recoveryMsg, can.turn.userId);
  if (!lease) return;
  const beforeLaunch = () => {
    const fresh = getRunner(runnerId);
    const currentRuntime = runnerTransition.getRuntime(runnerId);
    if (!fresh || !currentRuntime || currentRuntime.state !== 'dispatching' || currentRuntime.operation_id !== lease.operationId ||
        fresh.run_generation !== lease.gen || currentRuntime.generation !== lease.runtimeGeneration) {
      throw new MissionError('runner_dispatch_superseded', 'Recovery cancelled by Pause/Close', 409);
    }
  };
  try {
    beforeLaunch();
    getDb().prepare('UPDATE infinite_runners SET recovery_count = recovery_count + 1 WHERE id = ? AND run_generation = ?').run(runnerId, lease.gen);
    await restartSession(deadSession.id, { actor: 'runner', beforeLaunch });
    runnerHistory.record(getRunner(runnerId), 'worker_restored', { key: `worker-restored:${lease.gen}:${getRunner(runnerId).recovery_count}` });
    await deliverRunnerInstruction(runnerId, getSession(deadSession.id), project, sup.agent, can.queue, recoveryMsg, lease, can.turn, 'recovery', 'runner');
  } catch (e) {
    const runtime = runnerTransition.getRuntime(runnerId);
    if (runtime?.state === 'dispatching' && runtime.operation_id === lease.operationId) {
      runnerTransition.applyPause(runnerId, { actor: 'worker-recovery', details: { reason: e.message } });
      runnerTransition.setReason(runnerId, 'worker_recovery_failed', e.message);
      syncQueuePausedMarker(runnerId, true);
    }
  }
}

module.exports = {
  resumeQuotaRecovery,
  MissionError,
  supportedTypes,
  assertMissionAgent,
  newTmuxId,
  normalizeFolder,
  normalizePlansFolder,
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  createSession,
  getSession,
  getSessionByIdempotencyKey,
  endSessions,
  endSessionsForPad,
  listSessions,
  listSessionsForAgent,
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
  assertStepSession,
  answerPermission,
  detectPermission,
  screen,
  state,
  statesFor,
  stampTruth,
  // Test-only exports
  canDispatch,
  _setReceiptPollBudget,
  _setTuiReadyBudget,
  ensureRunnerMcp,
  computeSchedulerState,
  observeRunnerTurn,
  withLive,
  withLiveSessions,
  withLiveSessionsByAgent,
  busyForSessions,
  withAgentBusy,
  withAgentBusyProjects,
  closeSession,
  disableRunnerForSession,
  endSession,
  // Runner (plan 83)
  newRunnerId,
  createRunner,
  getRunner,
  publicRunner,
  getActiveRunnerForProject,
  listRunnersForProject,
  listAllRunners,
  updateRunner,
  ensureRunnerSession,
  setRunnerControlState,
  setRunnerEnabled,
  setRunnerReason,
  runnerContainerPaths,
  pauseConfirmation,
  getRunnerForSupervision,
  startRunner,
  pauseRunner,
  resumeRunner,
  removeRunner,
  resolveRunnerQueue,
  reconcileRunnerOperation,
  reconcileRunners,
  reconcileQueuePublications,
  runnerWatchTick,
  runnerWatchOnce,
  readRunnerQueue,
  setupRunnerQueue,
  updateRunnerQueue,
  updateRunnerQueueItem,
  addRunnerQueueItems,
  reorderRunnerQueue,
  removeRunnerQueueItem,
  updateRunnerQueueCustomInstructions,
  listRunnerPlans,
  // Runner prompt templates (plan 91)
  effectivePromptTemplates,
  withPromptTemplates,
  runnerPromptConfig,
  previewRunnerPrompts,
  previewProjectPrompts,
  renderRunnerPrompt,
  promptCatalogue,
  getRunnerCallbacks,
  saveRunnerCallbacks,
  runnerCallbackHistory,
  callbackCatalogue,
  baselineRunnerCallbacks,
  pumpCallbackOutbox,
  reconcileCallbackOutbox,
  observeRunnerQueues,
  observeRunnerUsage,
  RUNNER_CONTROL_STATES,
  RUNNER_HEALTH_STATES,
};
