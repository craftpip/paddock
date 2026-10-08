const crypto = require('crypto');
const path = require('path');

const { getDb } = require('./db');
const drivers = require('./drivers');
const padTmux = require('./pad-tmux');
const registry = require('./agent-registry');
const workspace = require('./workspace');
const agentStore = require('./agent-store');

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
async function relaunchTui(sessionId, { actor = null } = {}) {
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
async function restartSession(sessionId, { actor = null } = {}) {
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

/** Type into a live session. The one writer path for the agent (mission_send)
 *  AND the API, so the solo lock is honoured in exactly one place.
 *  Plan 62: refuses a shell pane (1b, `mission_not_an_agent`), refuses a
 *  permission dialog (1c, `mission_permission_pending`), and confirms the pane
 *  took the text instead of a bare ok (1h, `mission_tui_not_ready`). */
async function sendText(sessionId, text, { actor = null } = {}) {
  const { session, project, vmName } = sessionTarget(sessionId);
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
  // AFTER the write is confirmed, and never on a refusal: an audit trail records
  // what was DONE, so a row here would claim a line was typed into a
  // conversation that refused it. Same rule as a refused `close` stamping
  // nothing — the evidence must not be writable by the failed request.
  audit(project, 'send', { actor, session, details: `${sent.lines} line(s), ${body.length} chars` });
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
  const out = {
    session: { ...row, title: await sessionTitle(project, session) },
    state,
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
  if (!live) {
    const wasBusy = !!(id && probe.busyOf && probe.busyOf.get(id));
    return { ...s, busy: false, busyKnown: looked, open: false, state: 'dead', ...(wasBusy ? { wasBusy: true } : {}) };
  }
  // Live: a shell pane is reachable as a shell but `mission_send` refuses it,
  // so it is not `open` as an agent session.
  if (s.tuiAlive === false) {
    return { ...s, busy: false, busyKnown: looked, open: false };
  }
  const busy = !!(id && probe.busyOf && probe.busyOf.get(id));
  return { ...s, busy, busyKnown: looked, open: s.tuiAlive !== false };
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
 *  `{ busyOf, knownOf }`: `busyOf` maps an id whose store says its newest tool
 *  part is running; `knownOf` maps an id whose store could actually be read.
 *  An id we were not asked about is absent from both — stampTruth turns that
 *  into UNKNOWN, and that absence is exactly what stops "the probe worked"
 *  from reading as "this row is idle" (C1-F1). */
async function busyForSessions(rows) {
  const busyOf = new Map();
  const knownOf = new Map();
  await Promise.all((rows || []).map(async (s) => {
    const id = s && s.agent_session_id;
    const vm = s && s.agent_name;
    if (!id || !vm) return;
    const key = `${vm}::${id}`;
    const hit = BUSY_CACHE.get(key);
    if (hit && Date.now() - hit.at < BUSY_TTL) {
      busyOf.set(id, hit.value.busy);
      knownOf.set(id, hit.value.known);
      return;
    }
    let value = { busy: false, known: false };
    try {
      const row = await agentStore.readActivity(vm, id);
      const ok = !!(row && row.store && row.store.available);
      value = {
        busy: !!(ok && row.lastToolCall && row.lastToolCall.status === 'running'),
        known: ok,
      };
    } catch {
      value = { busy: false, known: false };
    }
    BUSY_CACHE.set(key, { at: Date.now(), value });
    busyOf.set(id, value.busy);
    knownOf.set(id, value.known);
  }));
  return { busyOf, knownOf };
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
async function closeSession(sessionId, { actor = null } = {}) {
  const { session, project, vmName } = sessionTarget(sessionId);
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
  withLive,
  withLiveSessions,
  withLiveSessionsByAgent,
  busyForSessions,
  withAgentBusy,
  withAgentBusyProjects,
  closeSession,
  endSession,
};
