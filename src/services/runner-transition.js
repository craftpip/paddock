const crypto = require('crypto');
const { getDb } = require('./db');
const { transition, STATES, EVENTS, markerRequired, allowedActions, RunnerStateError } = require('./runner-state');

class RunnerTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerTransitionError';
    this.code = code;
  }
}

function transitionId() {
  return `rqt_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function getRunnerCanonicalState(runner) {
  const cs = runner?.control_state;
  if (!cs) return 'paused';
  switch (cs) {
    case 'enabled':
      return runner.operation_status === 'pending' ? 'dispatching'
        : runner.operation_status === 'unconfirmed' ? 'awaiting_receipt'
        : runner.operation_status === 'confirmed' ? 'running'
        : runner.operation_status === 'held' ? 'held'
        : 'paused';
    case 'waiting':
      return 'paused';
    case 'need_input':
      if (runner.stop_cause === 'invalid_queue') return 'projection_error';
      if (runner.stop_cause === 'permission_dialog') return 'waiting_input';
      if (runner.stop_cause === 'prompts_misconfigured') return 'projection_error';
      if (runner.stop_cause === 'need_input') return 'waiting_input';
      if (runner.stop_cause === 'recovery_exhausted') return 'held';
      if (runner.stop_cause === 'scheduler_need_input') return 'waiting_input';
      return 'waiting_input';
    case 'finished':
      return 'complete';
    default:
      return 'paused';
  }
}

function canonicalToControlState(canonical, runner) {
  switch (canonical) {
    case 'paused':
      return { control_state: 'paused', enabled: 0 };
    case 'dispatching':
      return { control_state: 'enabled', enabled: 1, operation_status: 'pending' };
    case 'awaiting_receipt':
      return { control_state: 'enabled', enabled: 1, operation_status: 'unconfirmed' };
    case 'running':
      return { control_state: 'enabled', enabled: 1, operation_status: 'confirmed' };
    case 'waiting_input':
      return { control_state: 'need_input', enabled: 0 };
    case 'held':
      return { control_state: 'need_input', enabled: 0 };
    case 'complete':
      return { control_state: 'finished', enabled: 0 };
    case 'projection_error':
      return { control_state: 'need_input', enabled: 0 };
    default:
      return { control_state: 'paused', enabled: 0 };
  }
}

function persistTransition(runnerId, fromState, toState, event, actor, details = {}) {
  const db = getDb();
  const stamp = now();
  const id = transitionId();
  const runner = getRunner(runnerId);
  const control = canonicalToControlState(toState, runner);
  const runGen = runner.run_generation;

  const updates = [
    `control_state = '${control.control_state}'`,
    `enabled = ${control.enabled}`,
    `updated_at = '${stamp}'`,
  ];
  if (control.operation_status !== undefined) {
    updates.push(`operation_status = '${control.operation_status}'`);
  }

  const params = [id, runnerId, fromState, toState, event, actor || null, JSON.stringify(details), stamp];
  db.prepare(`INSERT INTO runner_transitions (id, runner_id, from_state, to_state, event, actor, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...params);

  db.prepare(`UPDATE infinite_runners SET ${updates.join(', ')} WHERE id = ? AND run_generation = ?`).run(runnerId, runGen);

  return { id, fromState, toState, event, actor: actor || null, details, createdAt: stamp, markerRequired: markerRequired(toState) };
}

function ensureTransitionTable() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS runner_transitions (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      event TEXT NOT NULL,
      actor TEXT,
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (runner_id) REFERENCES infinite_runners(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runner_transitions_runner_created
      ON runner_transitions(runner_id, created_at);
  `);
}

function getRunner(runnerId) {
  return getDb().prepare('SELECT * FROM infinite_runners WHERE id = ?').get(runnerId);
}

function applyEvent(runnerId, event, { actor = null, details = {} } = {}) {
  ensureTransitionTable();
  const runner = getRunner(runnerId);
  if (!runner) throw new RunnerTransitionError('runner_not_found', `Runner ${runnerId} not found`);

  const fromState = getRunnerCanonicalState(runner);
  if (!STATES.includes(fromState)) {
    throw new RunnerTransitionError('runner_state_invalid', `Runner ${runnerId} has invalid canonical state: ${fromState}`);
  }

  if (!Object.hasOwn(EVENTS, event)) {
    throw new RunnerTransitionError('runner_event_invalid', `Unknown runner event: ${event}`);
  }

  if (!EVENTS[event].includes(fromState)) {
    throw new RunnerTransitionError(
      'runner_transition_invalid',
      `Cannot ${event} while ${fromState}. Allowed actions: ${allowedActions(fromState).join(', ') || 'none'}.`
    );
  }

  const result = transition(fromState, event);
  const toState = result.state;

  const transitionRecord = persistTransition(runnerId, fromState, toState, event, actor, details);
  const updatedRunner = getRunner(runnerId);

  return {
    runner: updatedRunner,
    canonicalState: toState,
    markerRequired: result.markerRequired,
    allowedActions: result.allowedActions,
    transition: transitionRecord,
  };
}

function applyRun(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'run', { actor, details });
}

function applyDeliveryUnknown(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'delivery_unknown', { actor, details });
}

function applyReceipt(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'receipt', { actor, details });
}

function applyHold(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'hold', { actor, details });
}

function applyPause(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'pause', { actor, details });
}

function applyClose(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'close', { actor, details });
}

function applyNeedInput(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'need_input', { actor, details });
}

function applyResolve(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'resolve', { actor, details });
}

function applyComplete(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'complete', { actor, details });
}

function applyProjectionMismatch(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'projection_mismatch', { actor, details });
}

function applyProjectionRegenerated(runnerId, { actor = null, details = {} } = {}) {
  return applyEvent(runnerId, 'projection_regenerated', { actor, details });
}

function getTransitions(runnerId) {
  ensureTransitionTable();
  return getDb().prepare('SELECT * FROM runner_transitions WHERE runner_id = ? ORDER BY created_at').all(runnerId);
}

function getRunnerWithCanonical(runnerId) {
  const runner = getRunner(runnerId);
  if (!runner) return null;
  return {
    ...runner,
    canonicalState: getRunnerCanonicalState(runner),
    markerRequired: markerRequired(getRunnerCanonicalState(runner)),
    allowedActions: allowedActions(getRunnerCanonicalState(runner)),
  };
}

module.exports = {
  RunnerTransitionError,
  STATES,
  EVENTS,
  markerRequired,
  allowedActions,
  transition,
  getRunnerCanonicalState,
  canonicalToControlState,
  applyEvent,
  applyRun,
  applyDeliveryUnknown,
  applyReceipt,
  applyHold,
  applyPause,
  applyClose,
  applyNeedInput,
  applyResolve,
  applyComplete,
  applyProjectionMismatch,
  applyProjectionRegenerated,
  getTransitions,
  getRunnerWithCanonical,
};