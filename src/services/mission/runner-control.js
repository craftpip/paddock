/**
 * Run, pause, resume and remove a runner, and the boot-time reconciliation of
 * runtimes, publications and callbacks.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  removeProjectRunners,
  reconcileQuotaReceipt,
  resumeQuotaRecovery,
  ensureRunnerSession,
  startRunner,
  pauseRunner,
  resumeRunner,
  removeRunner,
  reconcileRunners,
  reconcileQueuePublications,
  baselineRunnerCallbacks,
  pumpCallbackOutbox,
  reconcileCallbackOutbox,
});

const crypto = require('crypto');
const fs = require('fs');
const { getDb } = require('../db');
const padTmux = require('../pad-tmux');
const agentStore = require('../agent-store');
const plans = require('../plans');
const runnerCallbacks = require('../runner-callbacks');
const runnerHistory = require('../runner-history');
const runnerQueue = require('../runner-queue');
const runnerTransition = require('../runner-transition');
const runnerPublication = require('../runner-publication');
const { requireAgent } = require('./internal');
const { MissionError } = require('./errors');
const { getProject } = require('./projects');
const { getSession } = require('./sessions');
const { startSession, restartSession, relaunchTui, ensureRunnerMcp } = require('./session-lifecycle');
const { sendText } = require('./session-io');
const { getRunner, listRunnersForProject, getRunnerForSupervision, setRunnerReason, syncQueuePausedMarker, RUNNER_PAUSE_MODES, setRunnerEnabled, recordStopProvenance } = require('./runners');
const { effectivePromptTemplates, renderRunnerPrompt } = require('./runner-prompts');
const { ensureRunnerIndex, canDispatch, acquireDispatchOwnership, deliverRunnerInstruction } = require('./scheduler');

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
  let runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  let runtime = runnerTransition.getRuntime(id);
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
  const quotaStop = runtime.state === 'waiting_input'
    && (runner.stop_cause === 'usage_exhausted' || runtime.reason_code === 'usage_exhausted');
  const recoveryScript = quotaStop ? runnerCallbacks.getCallback(id, 'usage_exhausted') : null;
  if (quotaStop && !(recoveryScript.enabled && recoveryScript.recreateResume)) {
    // No recovery script: an explicit Run after the provider's quota has reset
    // is a plain resume. The worker's own screen is the evidence — opencode
    // shows its limit notice for as long as the limit holds, and the same
    // detector that stopped the runner (provider-limit.js) must now find
    // nothing. Still limited → refuse and say exactly what to do. Cleared →
    // leave the quota stop through Pause (allowed from every state) and fall
    // through to the ordinary Run path, which re-checks the worker's turn and
    // adopts a turn the worker already started on its own.
    const screen = session ? await padTmux.captureScreen(project.agent_name, session.tmux_id, 80).catch(() => null) : null;
    const still = require('../provider-limit').screenUsageEvidence(screen);
    if (still) {
      throw new MissionError('runner_quota_still_exhausted',
        `${still.reason}. The limit notice is still on the worker's screen, so nothing was sent. Press Run again once it resets, or set up a usage_exhausted recovery script in Configure → Callbacks.`, 409);
    }
    runnerTransition.applyPause(id, { actor: actor || 'user', details: { reason: 'Usage limit cleared; resuming on explicit Run.' } });
    runnerHistory.record(getRunner(id), 'usage_recovered', { actor: actor || 'user', reason: 'The usage limit notice is gone from the worker\'s screen; Run resumes the queue.' });
    // The Pause moved the generation on: everything below must read the
    // runner as it is NOW, or the dispatch gate rejects a stale generation.
    runtime = runnerTransition.getRuntime(id);
    runner = getRunner(id);
  }
  if (quotaStop && runtime.state === 'waiting_input') {
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
  // Was the worker's pane already gone when Run was pressed? Then whatever
  // turn the store still calls "working" died with it: it must not be adopted
  // as a live worker, and it must not make Run refuse "worker not idle".
  let workerWasGone = false;
  if (session) {
    try {
      const paneAtStart = await padTmux.paneState(project.agent_name, session.tmux_id);
      workerWasGone = !paneAtStart.live || paneAtStart.tuiAlive === false;
    } catch { /* unreadable: assume it is there, the gates below still apply */ }
  }
  if (runtime.state === 'paused' && queue.aggregate.state === 'in progress' && session?.agent_session_id && !workerWasGone) {
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
  const can = await canDispatch(id, { session, project, agent, queue, kind: 'start', gen: runner.run_generation, paneDead: workerWasGone });
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
  // Rows and script files that no foreign key removes with the runner.
  runnerCallbacks.purgeRunnerState(id);
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

/** Remove every runner of a project, one at a time, through `removeRunner`.
 *  Deleting a project is an explicit removal of each runner configuration in
 *  it, so each records its `destroy` callback — a bare foreign-key cascade
 *  dropped the rows and no destroy ever ran. Called BEFORE the project row is
 *  deleted, so the snapshot can still name the project and its folder. */
async function removeProjectRunners(projectId, { actor = null } = {}) {
  const removed = [];
  for (const runner of listRunnersForProject(projectId)) {
    await removeRunner(runner.id, { actor });
    removed.push(runner.id);
  }
  return removed;
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
