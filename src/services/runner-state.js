const STATES = Object.freeze([
  'paused', 'dispatching', 'awaiting_receipt', 'running', 'waiting_input',
  'held', 'complete', 'projection_error',
]);

const EVENTS = Object.freeze({
  run: ['paused', 'held', 'complete'],
  adopt_active_turn: ['paused'],
  dispatch_next: ['running'],
  delivery_unknown: ['dispatching'],
  receipt: ['dispatching', 'awaiting_receipt'],
  turn_completed: ['running'],
  hold: ['awaiting_receipt', 'running', 'dispatching'],
  pause: STATES,
  close: STATES,
  need_input: ['dispatching', 'awaiting_receipt', 'running'],
  resolve_begin: ['waiting_input'],
  quota_recovery: ['waiting_input'],
  resolve: ['waiting_input'],
  complete: ['dispatching', 'awaiting_receipt', 'running'],
  work_added: ['complete'],
  queue_blocked: ['paused'],
  review_complete: ['paused'],
  projection_mismatch: STATES,
  projection_regenerated: ['projection_error'],
});

const NEXT = Object.freeze({
  run: 'dispatching',
  adopt_active_turn: 'running',
  dispatch_next: 'dispatching',
  delivery_unknown: 'awaiting_receipt',
  receipt: 'running',
  turn_completed: 'running',
  hold: 'held',
  pause: 'paused',
  close: 'paused',
  need_input: 'waiting_input',
  resolve_begin: 'dispatching',
  quota_recovery: 'dispatching',
  resolve: 'paused',
  complete: 'complete',
  work_added: 'paused',
  queue_blocked: 'waiting_input',
  review_complete: 'complete',
  projection_mismatch: 'projection_error',
  projection_regenerated: 'paused',
});

class RunnerStateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerStateError';
    this.code = code;
  }
}

function markerRequired(state) {
  return ['paused', 'waiting_input', 'held', 'complete', 'projection_error'].includes(state);
}

function allowedActions(state) {
  if (!STATES.includes(state)) return [];
  return Object.keys(EVENTS).filter((event) => EVENTS[event].includes(state));
}

function transition(state, event) {
  if (!STATES.includes(state)) throw new RunnerStateError('runner_state_invalid', `Unknown runner state: ${state}.`);
  if (!Object.hasOwn(NEXT, event)) throw new RunnerStateError('runner_event_invalid', `Unknown runner event: ${event}.`);
  if (!EVENTS[event].includes(state)) {
    throw new RunnerStateError(
      'runner_transition_invalid',
      `Cannot ${event} while ${state}. Allowed actions: ${allowedActions(state).join(', ') || 'none'}.`
    );
  }
  const next = NEXT[event];
  return { state: next, markerRequired: markerRequired(next), allowedActions: allowedActions(next) };
}

module.exports = { STATES, EVENTS, RunnerStateError, markerRequired, allowedActions, transition };
