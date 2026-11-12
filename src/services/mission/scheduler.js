/**
 * The runner watcher: observes worker turns, decides when the next plan may be
 * sent, and delivers it.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  computeSchedulerState,
  ensureRunnerIndex,
  canDispatch,
  acquireDispatchOwnership,
  deliverRunnerInstruction,
  observeRunnerTurn,
  reconcileRunnerOperation,
  runnerWatchTick,
  runnerWatchOnce,
  kickRunnerWatch,
  _setFastWatch,
  observeRunnerQueues,
  observeRunnerUsage,
  observeQuotaStops,
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
const { requireAgent, RUNNER_NO_RESPONSE_TIMEOUT_MS } = require('./internal');
const { MissionError } = require('./errors');
const { getProject } = require('./projects');
const { getSession, tryAdoptConversation } = require('./sessions');
const { restartSession } = require('./session-lifecycle');
const { detectPermission, sendVerdict, sendText, awaitExactReceipt } = require('./session-io');
const { busyForSessions } = require('./liveness');
const { getRunnerForSupervision, syncQueuePausedMarker, getRunner, setRunnerReason, canonicalQueueProjection } = require('./runners');
const { renderRunnerPrompt, effectivePromptTemplates } = require('./runner-prompts');
const { updateRunnerQueueItem } = require('./runner-queue-api');
const { reconcileQuotaReceipt } = require('./runner-control');

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
      const explicit = require('../provider-limit').screenUsageEvidence(screen);
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
/** A provider quota stop must not outlive the quota. The stop is set from a
 *  definitive screen notice, but nothing re-checked it, so a runner stayed
 *  "Usage limit" for days after opencode was answering again (a human typing
 *  into the same session got replies). Lift it when the provider has
 *  DEMONSTRABLY answered since the stop: the notice is gone from the worker's
 *  screen AND the worker's store shows a turn that finished after the stop.
 *  A notice that is merely hidden (a dismissed modal) is not enough on its own.
 *  The lift is an ordinary explicit-style Run (`startRunner`), so every gate
 *  of that path applies; a runner with a recovery script already in flight is
 *  left to that script. */
async function observeQuotaStops() {
  const rows = getDb().prepare(`SELECT r.id, rt.updated_at AS stopped_at, rt.reason_code FROM infinite_runners r JOIN runner_runtime rt ON rt.runner_id = r.id
    WHERE rt.state = 'waiting_input' AND rt.reason_code IN ('usage_exhausted', 'permission_dialog')`).all();
  let lifted = 0;
  for (const row of rows) {
    try {
      if (row.reason_code === 'permission_dialog') {
        // Older builds stopped the runner on a permission dialog. Once the
        // dialog is gone (answered in the page or over MCP) that stop is stale.
        const sup = await getRunnerForSupervision(row.id);
        if (!sup?.session) continue;
        const shot = await padTmux.captureScreen(sup.project.agent_name, sup.session.tmux_id, 20).catch(() => null);
        if (!shot?.live || detectPermission(shot.text)) continue;
        await require('./runner-control').startRunner(row.id, { actor: 'permission-observer' });
        lifted++;
        continue;
      }
      const busy = getDb().prepare(`SELECT 1 FROM runner_callback_outbox WHERE runner_id = ? AND event = 'usage_exhausted' AND status IN ('pending','running')
        UNION SELECT 1 FROM runner_quota_recoveries WHERE runner_id = ? AND status IN ('script_running','restoring') LIMIT 1`).get(row.id, row.id);
      if (busy) continue;
      const sup = await getRunnerForSupervision(row.id);
      if (!sup?.session?.agent_session_id) continue;
      const screen = await padTmux.captureScreen(sup.project.agent_name, sup.session.tmux_id, 80).catch(() => null);
      if (!screen?.live || require('../provider-limit').screenUsageEvidence(screen)) continue;
      const turn = agentStore.readTurn(sup.agent, sup.session.agent_session_id);
      const answeredAt = Date.parse(turn.completedAt || '');
      if (turn.state !== 'idle' || turn.outcome === 'error' || !(answeredAt > Date.parse(row.stopped_at))) continue;
      // startRunner records `usage_recovered` when it leaves the quota stop.
      await require('./runner-control').startRunner(row.id, { actor: 'quota-observer' });
      lifted++;
    } catch (e) {
      // A refused lift leaves the stop as it was; the next pass looks again.
      console.error(`[runner] could not lift the ${row.reason_code} stop of ${row.id}: ${e.message}`);
    }
  }
  return lifted;
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
  // `awaiting_receipt` is watched too. Nothing used to look at it, so an
  // instruction whose receipt landed just after the dispatch stopped waiting
  // left the runner on "Waiting for worker" until a human pressed Reconcile,
  // with the worker's own queue updates refused in the meantime.
  const runners = getDb().prepare("SELECT runner_id AS id FROM runner_runtime WHERE state IN ('running', 'awaiting_receipt')").all();
  for (const r of runners) {
    try {
      await watchRunner(r.id);
    } catch (e) {
      console.error(`[runner watch] Runner ${r.id} tick error:`, e.message);
    }
  }
}

// One watch pass per runner at a time. The periodic tick and the fast watch
// below both come through here; a pass already running makes the other a no-op
// instead of a second observer racing the first.
const watchInflight = new Set();
async function watchRunner(runnerId) {
  if (watchInflight.has(runnerId)) return false;
  watchInflight.add(runnerId);
  try {
    await runnerWatchOnce(runnerId);
    return true;
  } finally {
    watchInflight.delete(runnerId);
  }
}

// Fast watch: when the worker reports a plan done, do not wait for the 20 s
// tick. Poll the worker's own turn (a cheap store read) and run an ordinary
// watch pass the moment the turn has ended. Everything that decides and sends
// is still runnerWatchOnce, so the gates, the ownership compare-and-swap and
// the completion rule are the tick's own; this only changes WHEN a pass runs.
const fastWatch = new Map();
let FAST_WATCH = { enabled: true, intervalMs: 750, budgetMs: 90000 };
function _setFastWatch(patch) { FAST_WATCH = { ...FAST_WATCH, ...patch }; }

function kickRunnerWatch(runnerId) {
  if (!FAST_WATCH.enabled) return false;
  const started = runnerTransition.getRuntime(runnerId);
  if (!started || started.state !== 'running') return false;
  // One loop per runner GENERATION. A loop left over from the previous plan
  // is about to stop itself (its generation no longer owns the runner), so a
  // report for the new plan must replace it, not be dropped behind it.
  const existing = fastWatch.get(runnerId);
  if (existing) {
    if (existing.generation === started.generation) return false;
    clearTimeout(existing.timer);
  }
  const until = Date.now() + FAST_WATCH.budgetMs;
  const mine = (entry) => fastWatch.get(runnerId) === entry;
  const entry = { generation: started.generation, timer: null };
  const stop = () => { if (mine(entry)) fastWatch.delete(runnerId); };
  const step = async () => {
    try {
      const runtime = runnerTransition.getRuntime(runnerId);
      // A pause, a new Run, a dispatch or completion all end the fast watch:
      // only the generation that saw the report may act on it.
      if (!runtime || runtime.state !== 'running' || runtime.generation !== started.generation || Date.now() > until) return stop();
      const { agent, session } = await getRunnerForSupervision(runnerId);
      if (!session?.agent_session_id) return stop();
      if (agentStore.readTurn(agent, session.agent_session_id).state === 'idle') await watchRunner(runnerId);
    } catch (e) {
      console.error(`[runner fast watch] ${runnerId}:`, e.message);
      return stop();
    }
    if (!mine(entry)) return;
    entry.timer = setTimeout(step, FAST_WATCH.intervalMs);
    entry.timer.unref?.();
  };
  entry.timer = setTimeout(step, FAST_WATCH.intervalMs);
  entry.timer.unref?.();
  fastWatch.set(runnerId, entry);
  return true;
}

/** Single watch tick for one runner.
 *  Uses the canonical runner transition service for state changes. */
async function runnerWatchOnce(runnerId) {
  const runner = getRunner(runnerId);
  const runtime = runnerTransition.getRuntime(runnerId);
  if (runner && runtime && runtime.state === 'awaiting_receipt') {
    // The same reconciliation the Reconcile button runs: confirm the exact
    // receipt if the worker's store now shows it, hold once the deadline has
    // passed with the worker idle, otherwise keep waiting. Never a resend.
    try {
      await reconcileRunnerOperation(runnerId, { actor: 'watcher' });
    } catch (e) {
      console.log(`[runner watch] ${runnerId}: awaiting receipt, not reconciled: ${e.code || e.message}`);
    }
    return;
  }
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
    await stopWith('projection_mismatch', `Prompt templates misconfigured: ${promptEff.error.message} Repair them in Configure → Prompts, then press Regenerate projection and Run again.`, 'prompts_misconfigured');
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
    // A permission dialog is NOT a stop: the worker's turn is still open, only
    // parked on a question to a human. Moving the runner to waiting_input used
    // to strand it — after the dialog was answered nothing moved it back, and
    // Run refused with the stale reason. Stay running, send nothing, and say
    // what is waiting; the next pass after the answer carries on by itself.
    const waiting = verdict.refusal.startsWith('mission_permission_pending');
    recordSchedulerDecision(runnerId, gen, {
      workerState: waiting ? 'waiting_for_permission' : 'unknown',
      schedulerDecision: 'blocked',
      reason: waiting ? `Waiting for permission: ${perm?.tool || 'the worker asked for permission'}${perm?.path ? ` (${perm.path})` : ''}` : verdict.refusal,
    });
    return;
  }
  const turn = agentStore.readTurn(agent, session.agent_session_id);
  const observed = observeRunnerTurn(runner, session, turn);
  const decision = computeSchedulerState(observed, queue, turn, Date.now());
  recordSchedulerDecision(runnerId, gen, decision);
  if (decision.schedulerDecision === 'dispatch') {
    const kind = sameRevision(observed.last_dispatch_revision, queue.hash) ? 'retry' : 'rev';
    await dispatchNext(runnerId, session, project, agent, queue, kind, gen);
  } else if (decision.schedulerDecision === 'need_input') {
    await stopWith('need_input', decision.reason, 'scheduler_need_input');
  }
}
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
  // The idle grace and the nudge interval exist for a worker that went quiet
  // WITHOUT finishing: they delay a nudge. When the plan the last instruction
  // assigned is now done, the worker said so itself and its turn has ended, so
  // the next send starts a new plan, not a nudge, and neither timer applies.
  const assigned = runner.operation_item_id && queue.parsed?.items?.find((item) => item.id === runner.operation_item_id);
  if (assigned?.status === 'done') return decision('dispatch', 'Previous plan reported done — starting the next one');
  const graceRemaining = runner.idle_grace_ms - (now - idleSince);
  if (graceRemaining > 0) return decision('wait_idle_grace', `Worker idle — grace ${Math.ceil(graceRemaining / 1000)}s remaining`, graceRemaining);
  const lastDispatch = Date.parse(runner.last_nudge_at || runner.last_dispatch_at);
  const intervalRemaining = runner.min_nudge_interval_ms - (now - lastDispatch);
  if (Number.isFinite(lastDispatch) && intervalRemaining > 0) return decision('wait_nudge_interval', `Waiting for nudge interval (${Math.ceil(intervalRemaining / 1000)}s)`, intervalRemaining);
  const changed = !sameRevision(runner.last_dispatch_revision, queue.hash);
  if (!changed && runner.retry_count >= runner.no_progress_budget) return decision('need_input', `No progress after ${runner.no_progress_budget} dispatches — the queue needs a human`);
  return decision('dispatch', changed ? 'Worker idle — ready for next queued item' : 'Worker idle — ready to continue current item');
}

/** Is the queue at the revision the last instruction was sent for? The column
 *  is TEXT and a JS number is bound as a float, so revision 2 is stored and
 *  read back as the string "2.0" while the live revision is the number 2.
 *  Compared with `!==` the two were never equal: every send counted as "the
 *  queue changed" and the no-progress budget could never run out. */
function sameRevision(stored, live) {
  if (stored === null || stored === undefined || stored === '' || live === null || live === undefined) return false;
  const a = Number(stored);
  const b = Number(live);
  return Number.isFinite(a) && Number.isFinite(b) ? a === b : String(stored) === String(live);
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
    .run(turn.state, turn.userId || null, idleSince, advanced ? turn.progressAt : runner.last_progress_at, runner.retry_count, runner.id, runner.run_generation, runner.operation_generation);
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
/** The turn as it really stands once its pane is known to be gone: over. */
function interruptedByDeadPane(turn) {
  return { ...turn, state: 'idle', completedAt: turn.completedAt || turn.progressAt || new Date().toISOString(), interruptedBy: 'pane_gone' };
}

async function canDispatch(runnerId, { session, project, agent, queue, kind, gen, paneDead = false }) {
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
  // Plan 126: a fresh codex session gets its id only once codex has written
  // the rollout (on the first message), so adopt it here when exactly one fits.
  // Adoption updates `session` in place, so the rest of this pass — and the
  // caller's delivery — uses the id.
  let adoption = null;
  if (session && !session.agent_session_id) adoption = tryAdoptConversation(session, project);
  if (!session?.agent_session_id) {
    const reason = adoption?.state === 'none'
      ? 'This codex session has no conversation yet: codex creates one only when the first message is typed. Type anything into the session (or open one from History), then press Run again.'
      : adoption?.state === 'many'
        ? 'Several new codex conversations started in this folder at about the same time, so the runner cannot tell which one is this session. Close the extra sessions, then press Run again.'
        : 'The worker session has no conversation id, so its turns cannot be observed. Close the worker session and press Run to start a fresh one.';
    return { allowed: false, code: 'runner_worker_identity_unavailable', reason, freshRunner: fresh };
  }
  if (fresh.session_id !== session.id) return { allowed: false, code: 'runner_worker_identity_unavailable', reason: 'The runner is bound to a different worker session than this one.', freshRunner: fresh };
  if (getSession(session.id)?.locked) return { allowed: false, code: 'runner_worker_locked', reason: 'The worker session is solo-locked by a human; unlock it to let the runner send.', freshRunner: fresh };
  let turn = agentStore.readTurn(agent, session.agent_session_id);
  // A turn the store calls "working" cannot be real when the pane that was
  // running it is gone: nothing is left to finish it, so the store says
  // "working" for ever and the idle gate below would refuse every recovery.
  if (turn.state === 'working' && paneDead) turn = interruptedByDeadPane(turn);
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
      // The count is of consecutive nudges for an UNCHANGED queue. A send for a
      // changed queue starts it over; conversation activity alone does not (a
      // worker that answers every nudge without touching its plan is exactly
      // the stuck worker this budget exists to stop, and each answer used to
      // reset the count).
      .run(nowIso, nowIso, queueHash || null, kind === 'retry' ? fresh.retry_count + 1 : 0,
        nowIso, runnerId);
    if (!result.changes) throw new MissionError('runner_dispatch_owned', 'Another instruction owns this runner.', 409);
    return { operationId, operationGeneration, gen: transitionResult.runtime.generation, runtimeGeneration: transitionResult.runtime.generation };
  });
  try { return tx.immediate(); }
  catch (e) {
    // Losing the race to another pass (the tick and the fast watch can both
    // decide to dispatch) is not an error: the winner owns the send.
    if (['runner_dispatch_owned', 'runner_transition_conflict', 'runner_transition_invalid'].includes(e.code)) return null;
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
    // The gate accepted an ABANDONED turn (pane gone, or stalled: "working" in
    // the store with nothing running it) as interrupted. At the write boundary
    // that same turn still reads "working" — accept it only while it is
    // exactly the one the gate judged (same input, not moved since). Any
    // progress or a new input means something is running after all: withhold.
    const sameAbandoned = !!baselineTurn.interruptedBy && turn.state === 'working'
      && turn.userId === baselineTurn.userId && turn.progressAt === baselineTurn.progressAt;
    if (!sameAbandoned && (turn.state !== 'idle' || (turn.outcome === 'error' && kind !== 'start') || turn.userId !== baselineTurn.userId)) throw new MissionError('runner_worker_not_idle', 'Worker started another turn — instruction withheld', 409);
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
  // Already confirmed (the watcher got there first, or a second click): there
  // is nothing to reconcile, and saying so beats an invalid-transition error.
  if (runnerTransition.getRuntime(runnerId)?.state === 'running') {
    return { reconciled: true, confirmed: true, alreadyConfirmed: true };
  }
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
  const noResponseTimeout = RUNNER_NO_RESPONSE_TIMEOUT_MS;
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
  // This function is only reached after the watch pass saw the pane dead.
  const can = await canDispatch(runnerId, { ...sup, session: deadSession, kind: 'recovery', gen, paneDead: true });
  if (!can.allowed) {
    // Say why, where the page shows it. Returning silently left the runner
    // "running" with no worker and no explanation.
    setRunnerReason(runnerId, `Worker pane is gone; recovery is waiting: ${can.reason || 'not ready yet'}`);
    return;
  }
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
