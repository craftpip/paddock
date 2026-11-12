/**
 * Talking to a live session: the send gate and send, permission prompts, and
 * reading the screen.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  sendText,
  awaitExactReceipt,
  detectPermission,
  sendVerdict,
  assertStepSession,
  answerPermission,
  screen,
  _setReceiptPollBudget,
  _setTuiReadyBudget,
});

const { getDb } = require('../db');
const drivers = require('../drivers');
const padTmux = require('../pad-tmux');
const agentStore = require('../agent-store');
const { MissionError } = require('./errors');
const { touchSession, noteOutput, audit, getSession, assertNotLocked } = require('./sessions');
const { sessionTarget } = require('./session-lifecycle');
const { stampTruth, busyForSessions, syncEnded } = require('./liveness');
const { getRunner, publicRunner } = require('./runners');
const { withPromptTemplates } = require('./runner-prompts');

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
  // The request line. opencode draws a tool call as `→ <tool …>`, and an
  // access request (an external directory, a command) as `← <request>`, e.g.
  // `← Access external directory /proc/self` (measured on 1.19.5).
  const arrow = t.match(/[→←]\s*([^\n]+)/);
  if (arrow) tool = arrow[1].replace(/\s*[┃│]\s*$/, '').trim().slice(0, 120);
  const pathM = t.match(/Path:\s*([^\n]+)/i);
  if (pathM) p = pathM[1].trim().slice(0, 200);
  // Otherwise the first entry of a `Patterns` list (`- /proc/self/*`).
  if (!p) {
    const pat = t.match(/Patterns[\s┃│]*\n(?:[\s┃│]*\n)*[\s┃│]*-\s*([^\n]+)/);
    if (pat) p = pat[1].replace(/\s*[┃│]\s*$/, '').trim().slice(0, 200);
  }
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
