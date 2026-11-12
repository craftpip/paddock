/**
 * What is true of a session right now: pane liveness, pane kind and whether the
 * agent is mid-turn. Listings chain these stamps; nothing here writes to a pane.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  withLiveSessionsByAgent,
  withHistoryActivity,
  stampTruth,
  busyForSessions,
  syncEnded,
  state,
  statesFor,
  withLive,
  withLiveSessions,
  withAgentBusy,
  withAgentBusyProjects,
  withFolderState,
});

const { getDb } = require('../db');
const padTmux = require('../pad-tmux');
const agentStore = require('../agent-store');
const { clearEnded } = require('./sessions');
const { sessionTarget } = require('./session-lifecycle');

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
  // `unread` says the listing itself FAILED (docker error, timeout). The rows
  // are still shown as not live, because nothing proves they are, but they are
  // not dated as dead: "I could not look" is not "it is gone", and one failed
  // probe used to stamp every session on the PAD `ended_by: gone`.
  let unread = false;
  try {
    names = new Set((await padTmux.listSessions(vmName)).map((r) => r.name));
  } catch {
    unread = true;
  }
  try {
    if (typeof padTmux.listPanes === 'function') panes = await padTmux.listPanes(vmName);
  } catch {}
  return { names, panes, unread };
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
      else if (s.liveUnread) continue; // the probe failed: no death was observed
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

// Folder answers per PAD, cached briefly: the Mission list polls, and a
// folder vanishing is rare enough that a 15s-old answer is still the truth.
const FOLDER_TTL_MS = 15000;
const folderCache = new Map(); // vmName -> { at, key, map }

/** Stamp `folderExists` on every project: `true`/`false` when the PAD answered,
 *  and LEFT OFF when it could not be asked (stopped PAD, exec error). Absent
 *  means unknown, so the page must not draw a "missing" badge for it — a
 *  stopped PAD is not a deleted folder. One exec per PAD, not per project. */
async function withFolderState(projects) {
  const byPad = new Map();
  for (const p of projects) {
    if (!p.folder) continue;
    if (!byPad.has(p.agent_name)) byPad.set(p.agent_name, new Set());
    byPad.get(p.agent_name).add(p.folder);
  }
  const answers = new Map();
  await Promise.all([...byPad].map(async ([vmName, folders]) => {
    const key = [...folders].sort().join('\0');
    const hit = folderCache.get(vmName);
    if (hit && hit.key === key && Date.now() - hit.at < FOLDER_TTL_MS) { answers.set(vmName, hit.map); return; }
    try {
      if (typeof padTmux.foldersExist !== 'function') return;
      const map = await padTmux.foldersExist(vmName, [...folders]);
      folderCache.set(vmName, { at: Date.now(), key, map });
      answers.set(vmName, map);
    } catch {
      folderCache.delete(vmName);
    }
  }));
  for (const p of projects) {
    const map = answers.get(p.agent_name);
    if (map && map.has(p.folder)) p.folderExists = map.get(p.folder);
    else delete p.folderExists;
  }
  return projects;
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
    const { names, panes, unread } = byPad.get(p.agent_name) || { names: new Set(), panes: new Map() };
    p.sessions = (p.sessions || []).map((s) => stampPaneKind({ ...s, live: names.has(s.tmux_id), ...(unread ? { liveUnread: true } : {}) }, panes));
    touchLiveRows(p.sessions);
    syncEnded(p.sessions);
    p.liveCount = p.sessions.filter((s) => s.live).length;
  }
  return projects;
}

/** Stamp `live` (+ kind/cwd) on a plain session list (same O(PADs) budget). */
async function withLiveSessions(sessions, agentName) {
  if (!sessions.length) return sessions;
  const { names, panes, unread } = await liveAndPanes(agentName);
  const out = sessions.map((s) => stampPaneKind({ ...s, live: names.has(s.tmux_id), ...(unread ? { liveUnread: true } : {}) }, panes));
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
    return stampPaneKind({ ...s, live: entry.names.has(s.tmux_id), ...(entry.unread ? { liveUnread: true } : {}) }, entry.panes);
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
const BUSY_CACHE_MAX = 2000;

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
    // Bounded: every conversation ever probed used to stay here for the life
    // of the process. Expired entries go first; past the cap, the oldest.
    if (BUSY_CACHE.size >= BUSY_CACHE_MAX) {
      const cutoff = Date.now() - BUSY_TTL;
      for (const [k, v] of BUSY_CACHE) if (v.at < cutoff) BUSY_CACHE.delete(k);
      while (BUSY_CACHE.size >= BUSY_CACHE_MAX) BUSY_CACHE.delete(BUSY_CACHE.keys().next().value);
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
    // null = the listing FAILED. That is not "no live sessions": the rows below
    // then say `openKnown: false` instead of a confident `open: false`.
    padTmux.listSessions(vm).catch(() => null),
  ]);
  const listed = Array.isArray(liveRows);
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
    return { ...r, busy, busyKnown: probe.knownOf.get(r.id) === true, open: busy || resumedOpen.has(r.id), openKnown: busy || listed };
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
