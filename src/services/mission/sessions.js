/**
 * Mission session rows: create, read, update, end and the audit trail.
 * No tmux here; panes are driven from session-lifecycle and session-io.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  audit,
  getSession,
  getSessionByIdempotencyKey,
  insertSession,
  deleteSession,
  touchSession,
  clearEnded,
  noteOutput,
  assertNotLocked,
  endSessions,
  listSessions,
  createSession,
  endSessionsForPad,
  listSessionsForAgent,
  updateSession,
  getSessionByTmux,
});

const crypto = require('crypto');
const { getDb } = require('../db');
const registry = require('../agent-registry');
const runnerTransition = require('../runner-transition');
const { newTmuxId, TMUX_RE, newId } = require('./internal');
const { MissionError } = require('./errors');
const { getProject, listProjects } = require('./projects');
const { withLiveSessionsByAgent } = require('./liveness');
const { syncQueuePausedMarker } = require('./runners');

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
