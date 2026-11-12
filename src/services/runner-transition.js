const crypto = require('crypto');
const { getDb } = require('./db');
const { transition, STATES, EVENTS, markerRequired, allowedActions } = require('./runner-state');

class RunnerTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerTransitionError';
    this.code = code;
  }
}

const transitionId = () => `rqt_${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

function getRunner(runnerId) {
  return getDb().prepare('SELECT * FROM infinite_runners WHERE id = ?').get(runnerId);
}

function getRuntime(runnerId) {
  return getDb().prepare('SELECT * FROM runner_runtime WHERE runner_id = ?').get(runnerId) || null;
}

function createRuntime(runnerId) {
  const db = getDb();
  const createdAt = now();
  const insert = db.prepare(`INSERT OR IGNORE INTO runner_runtime
    (runner_id, state, generation, operation_id, reason_code, reason, updated_at)
    SELECT id, 'paused', 0, NULL, NULL, NULL, ? FROM infinite_runners WHERE id = ?`);
  insert.run(createdAt, runnerId);
  const runtime = getRuntime(runnerId);
  if (!runtime) throw new RunnerTransitionError('runner_not_found', `Runner ${runnerId} not found`);
  return runtime;
}

/** The runtime row is the only authority. Missing rows mean setup is required;
 * never reconstruct authorization from legacy control/operation columns. */
function getRunnerCanonicalState(runner) {
  if (!runner) return null;
  const runtime = getRuntime(runner.id);
  return runtime ? runtime.state : 'setup_required';
}

function runtimeView(runnerId) {
  const runner = getRunner(runnerId);
  if (!runner) return null;
  const runtime = getRuntime(runnerId);
  if (!runtime) return { runner, canonicalState: 'setup_required', markerRequired: true, allowedActions: [], runtime: null };
  return {
    runner,
    runtime,
    canonicalState: runtime.state,
    markerRequired: markerRequired(runtime.state),
    allowedActions: allowedActions(runtime.state),
  };
}

function setReason(runnerId, reasonCode, reason) {
  const result = getDb().prepare(`UPDATE runner_runtime SET reason_code = ?, reason = ?, updated_at = ?
    WHERE runner_id = ?`).run(reasonCode || null, reason || null, now(), runnerId);
  if (!result.changes) throw new RunnerTransitionError('runner_setup_required', `Runner ${runnerId} has no canonical runtime.`);
  return getRuntime(runnerId);
}

function persistTransition(runnerId, fromRuntime, toState, event, actor, details = {}) {
  const db = getDb();
  const stamp = now();
  const id = transitionId();
  const runGeneration = fromRuntime.generation + (['run', 'adopt_active_turn', 'dispatch_next', 'resolve_begin', 'quota_recovery', 'pause', 'close', 'projection_mismatch', 'hold', 'queue_blocked', 'review_complete'].includes(event) ? 1 : 0);
  const nextOperationId = ['pause', 'close', 'hold', 'projection_mismatch', 'complete', 'need_input', 'resolve', 'turn_completed'].includes(event)
    ? null
    : (details.operationId === undefined ? fromRuntime.operation_id : details.operationId);
  const reasonCode = details.reasonCode || (toState === 'paused' ? null : (details.cause || event));
  const reason = details.reason || (toState === 'paused' ? null : null);
  const changed = db.prepare(`UPDATE runner_runtime
      SET state = ?, generation = ?, operation_id = ?, reason_code = ?, reason = ?, updated_at = ?
      WHERE runner_id = ? AND state = ? AND generation = ? AND operation_id IS ?`)
      .run(toState, runGeneration, nextOperationId, reasonCode, reason, stamp,
        runnerId, fromRuntime.state, fromRuntime.generation, fromRuntime.operation_id);
  if (!changed.changes) {
    throw new RunnerTransitionError('runner_transition_conflict', 'Runner state changed concurrently; reload and retry.');
  }
  // Kept only as a compatibility/telemetry projection for existing non-state
  // queries during this replacement. Authorization and ownership always read
  // runner_runtime.generation; no caller writes or branches on this copy.
  db.prepare('UPDATE infinite_runners SET run_generation = ?, updated_at = ? WHERE id = ?')
    .run(runGeneration, stamp, runnerId);
  db.prepare(`INSERT INTO runner_transitions
      (id, runner_id, from_state, to_state, event, actor, details, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, runnerId, fromRuntime.state, toState, event, actor || null, JSON.stringify(details), stamp);
  return { id, runnerId, fromState: fromRuntime.state, toState, event,
    actor: actor || null, details, createdAt: stamp, generation: runGeneration };
}

function applyEvent(runnerId, event, { actor = null, details = {} } = {}) {
  const db = getDb();
  const tx = db.transaction(() => {
    const runner = getRunner(runnerId);
    if (!runner) throw new RunnerTransitionError('runner_not_found', `Runner ${runnerId} not found`);
    const runtime = getRuntime(runnerId);
    if (!runtime) throw new RunnerTransitionError('runner_setup_required', `Runner ${runnerId} has no canonical runtime; initialize it explicitly before running.`);
    if (!STATES.includes(runtime.state)) {
      throw new RunnerTransitionError('runner_state_invalid', `Runner ${runnerId} has invalid canonical state: ${runtime.state}`);
    }
    if (!Object.hasOwn(EVENTS, event)) throw new RunnerTransitionError('runner_event_invalid', `Unknown runner event: ${event}`);
    if (!EVENTS[event].includes(runtime.state)) {
      throw new RunnerTransitionError('runner_transition_invalid', `Cannot ${event} while ${runtime.state}. Allowed actions: ${allowedActions(runtime.state).join(', ') || 'none'}.`);
    }
    // An adopted turn needs an operation of its own: without one the worker
    // could not close its item (queue_item_not_assigned, operation=none) and
    // the turn's completion had no owner — measured on plan 127's run.
    if (['run', 'dispatch_next', 'resolve_begin', 'quota_recovery', 'adopt_active_turn'].includes(event) && !details.operationId) details = { ...details, operationId: `rop_${crypto.randomUUID()}` };
    if (['receipt', 'delivery_unknown'].includes(event) &&
        (!details.operationId || !runtime.operation_id || details.operationId !== runtime.operation_id)) {
      throw new RunnerTransitionError('runner_operation_superseded', 'The operation no longer owns this runner.');
    }
    if (event === 'turn_completed' &&
        (!runtime.operation_id || (details.operationId && details.operationId !== runtime.operation_id))) {
      throw new RunnerTransitionError('runner_operation_superseded', 'No running operation owns this completed turn.');
    }
    const result = transition(runtime.state, event);
    const transitionRecord = persistTransition(runnerId, runtime, result.state, event, actor, details);
    const stamp = now();
    db.prepare(`UPDATE runner_publications SET desired_marker = ?, error = NULL, updated_at = ? WHERE runner_id = ?`)
      .run(markerRequired(result.state) ? 1 : 0, stamp, runnerId);
    if (event === 'dispatch_next' && runtime.operation_id) {
      db.prepare(`UPDATE runner_operations SET status = 'completed', updated_at = ?
        WHERE id = ? AND runner_id = ? AND generation = ? AND status = 'running'`)
        .run(stamp, runtime.operation_id, runnerId, runtime.generation);
    }
    if (['run', 'dispatch_next', 'resolve_begin', 'quota_recovery', 'adopt_active_turn'].includes(event)) {
      db.prepare(`INSERT INTO runner_operations
        (id, runner_id, generation, operation_kind, conversation_id, item_id, queue_revision, prompt_hash, baseline_input_id,
         receipt_input_id, status, deadline_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'dispatching', ?, ?, ?)`)
        .run(details.operationId, runnerId, transitionRecord.generation, details.kind || (event === 'resolve_begin' ? 'resolve' : event === 'quota_recovery' ? 'quota_recovery' : event === 'adopt_active_turn' ? 'adopted' : 'queue'),
          details.conversationId || runner.session_id, details.itemId || null, details.queueRevision ?? null,
          details.promptHash || null, details.baselineInputId || null,
          details.deadlineAt || null, stamp, stamp);
      // Adopting a turn already running: nothing was sent, so there is no
      // receipt to wait for — the operation is running from the start.
      if (event === 'adopt_active_turn') {
        db.prepare(`UPDATE runner_operations SET status = 'running', updated_at = ? WHERE id = ? AND runner_id = ?`)
          .run(stamp, details.operationId, runnerId);
      }
    } else if (['receipt', 'delivery_unknown', 'hold', 'complete', 'pause', 'close', 'projection_mismatch', 'need_input', 'resolve', 'turn_completed'].includes(event)) {
      const operationStatus = event === 'receipt' ? 'running'
        : event === 'delivery_unknown' ? 'awaiting_receipt'
        : event === 'hold' ? 'held'
        : ['complete', 'need_input', 'resolve', 'turn_completed'].includes(event) ? 'completed' : 'invalidated';
      const updated = db.prepare(`UPDATE runner_operations SET status = ?, receipt_input_id = COALESCE(?, receipt_input_id), updated_at = ?
        WHERE id = ? AND runner_id = ? AND generation = ? AND status IN ('dispatching','awaiting_receipt','running')`)
        .run(operationStatus, details.receiptInputId || null, stamp,
          details.operationId || runtime.operation_id, runnerId, runtime.generation);
      if (details.operationId && !updated.changes) {
        throw new RunnerTransitionError('runner_operation_superseded', 'The operation no longer owns this runner.');
      }
    }
    const updated = getRuntime(runnerId);
    return {
      runner: getRunner(runnerId), runtime: updated, canonicalState: updated.state,
      markerRequired: result.markerRequired, allowedActions: result.allowedActions,
      transition: transitionRecord,
    };
  });
  return tx.immediate();
}

const applyRun = (id, options = {}) => applyEvent(id, 'run', options);
const applyAdoptActiveTurn = (id, options = {}) => applyEvent(id, 'adopt_active_turn', options);
const applyDispatchNext = (id, options = {}) => applyEvent(id, 'dispatch_next', options);
const applyDeliveryUnknown = (id, options = {}) => applyEvent(id, 'delivery_unknown', options);
const applyReceipt = (id, options = {}) => applyEvent(id, 'receipt', options);
const applyTurnCompleted = (id, options = {}) => applyEvent(id, 'turn_completed', options);
const applyHold = (id, options = {}) => applyEvent(id, 'hold', options);
const applyPause = (id, options = {}) => applyEvent(id, 'pause', options);
const applyClose = (id, options = {}) => applyEvent(id, 'close', options);
const applyNeedInput = (id, options = {}) => applyEvent(id, 'need_input', options);
const applyResolveBegin = (id, options = {}) => applyEvent(id, 'resolve_begin', options);
const applyQuotaRecovery = (id, options = {}) => applyEvent(id, 'quota_recovery', options);
const applyResolve = (id, options = {}) => applyEvent(id, 'resolve', options);
const applyComplete = (id, options = {}) => applyEvent(id, 'complete', options);
const applyQueueBlocked = (id, options = {}) => applyEvent(id, 'queue_blocked', options);
const applyReviewComplete = (id, options = {}) => applyEvent(id, 'review_complete', options);
const applyProjectionMismatch = (id, options = {}) => applyEvent(id, 'projection_mismatch', options);
const applyProjectionRegenerated = (id, options = {}) => applyEvent(id, 'projection_regenerated', options);

function getTransitions(runnerId) {
  return getDb().prepare('SELECT * FROM runner_transitions WHERE runner_id = ? ORDER BY created_at, rowid').all(runnerId);
}

function getRunnerWithCanonical(runnerId) {
  return runtimeView(runnerId);
}

module.exports = {
  RunnerTransitionError, STATES, EVENTS, markerRequired, allowedActions, transition,
  getRunnerCanonicalState, getRuntime, createRuntime, runtimeView, applyEvent,
  setReason,
  applyRun, applyAdoptActiveTurn, applyDispatchNext, applyDeliveryUnknown, applyReceipt, applyTurnCompleted, applyHold, applyPause, applyClose,
  applyNeedInput, applyResolveBegin, applyQuotaRecovery, applyResolve, applyComplete, applyQueueBlocked, applyReviewComplete, applyProjectionMismatch,
  applyProjectionRegenerated, getTransitions, getRunnerWithCanonical,
};
