/**
 * Starting, relaunching, restarting, closing and ending a session's tmux pane,
 * plus the listings that span projects.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  sessionTarget,
  startSession,
  closeSession,
  restartSession,
  relaunchTui,
  ensureRunnerMcp,
  listAllSessions,
  projectFolders,
  agentHistory,
  allAgentHistory,
  disableRunnerForSession,
  endSession,
});

const { getDb } = require('../db');
const padTmux = require('../pad-tmux');
const registry = require('../agent-registry');
const workspace = require('../workspace');
const runnerTransition = require('../runner-transition');
const { agentRow, assertMissionAgent, normalizeFolder } = require('./internal');
const { MissionError } = require('./errors');
const { getProject, listProjects, projectTag } = require('./projects');
const { getSession, getSessionByIdempotencyKey, insertSession, deleteSession, audit, touchSession, clearEnded, noteOutput, endSessions, listSessions } = require('./sessions');
const { withHistoryActivity } = require('./liveness');
const { syncQueuePausedMarker } = require('./runners');

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

/** What an agent conversation id may look like (opencode `ses_…`, codex and
 *  claude UUIDs). It ends up in a shell command line. */
const AGENT_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

async function startSession(projectId, { label = '', origin = 'human', cols = 0, rows = 0, agentSessionId = '', createdBy = null, idempotencyKey = '' } = {}) {
  // Checked before the PAD is touched at all. The id is typed into the pane's
  // shell as part of the launch command, and typed again on every relaunch.
  // Every agent's conversation ids are plain tokens, so anything else is
  // refused rather than quoted and hoped for.
  if (String(agentSessionId || '').trim() && !AGENT_SESSION_ID_RE.test(String(agentSessionId).trim())) {
    throw new MissionError('mission_bad_agent_session_id', 'agent_session_id must be 1 to 128 letters, digits, "_" or "-" (the id the agent itself printed).', 400);
  }
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
  const { getRunnerMcpUrl, RUNNER_MCP_SERVER } = require('../paddock-mcp');
  const before = await driver.mcpServerStatus(project.agent_name, project.folder, RUNNER_MCP_SERVER);
  if (before.state === 'connected') return { state: 'connected', changed: false };
  if (before.state === 'unknown') return before;
  const token = require('../runner-mcp-token').mint(project.agent_name);
  const wired = await driver.connectMcpServer(project.agent_name, { server: RUNNER_MCP_SERVER, url: getRunnerMcpUrl(), token, folder: project.folder });
  const after = await driver.mcpServerStatus(project.agent_name, project.folder, RUNNER_MCP_SERVER);
  if (after.state === 'connected') return { state: 'connected', changed: true };
  const tail = String(wired.output || '').trim().split('\n').slice(-2).join(' ').slice(0, 300);
  return {
    state: 'failed',
    detail: `installing the runner MCP server (${getRunnerMcpUrl()}) in ${project.agent_name} did not connect: ${after.detail}${tail ? ` (${tail})` : ''}. Check that the pad can reach this Paddock host (HOST_NAME in .env), then press Run again.`,
  };
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
  // Same order as the page's Close: a runner bound to this session is stopped
  // FIRST. Otherwise the watcher sees a dead pane on its next pass and
  // restarts the TUI in the session that was just closed on purpose.
  disableRunnerForSession(session.id);
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
