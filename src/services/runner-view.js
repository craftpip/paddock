/**
 * The one display/action verdict for a runner's queue.
 *
 * Pure: every input is passed in, nothing here reads the database. The queue
 * panel, the terminal controls and any other surface render this object and
 * never work runner state out for themselves. Each `actions.<x>.allowed` is
 * derived from the same predicate the write path enforces (`runner-state`'s
 * EVENTS table and `queueEditVerdict`), so a control the view offers is a
 * write the server accepts.
 */
const { EVENTS, queueEditVerdict, REVIEWABLE_STATES } = require('./runner-state');

const LABELS = Object.freeze({
  setup_required: 'Setup required',
  paused: 'Paused',
  dispatching: 'Sending plan',
  awaiting_receipt: 'Waiting for worker',
  running: 'Running',
  waiting_input: 'Needs input',
  held: 'Held',
  complete: 'Complete',
  projection_error: 'Queue file out of sync',
});

const TONES = Object.freeze({
  dispatching: 'active', awaiting_receipt: 'active', running: 'active',
  complete: 'success',
  waiting_input: 'danger', held: 'danger', projection_error: 'danger',
  paused: 'idle', setup_required: 'idle',
});

const ACTIVE = ['dispatching', 'awaiting_receipt', 'running'];
const verdict = (allowed, reason) => ({ allowed: !!allowed, reason: allowed ? null : reason });
const nameOf = (items, ref) => {
  if (!ref) return null;
  const item = items.find((it) => it.id === ref.id);
  return item?.title || item?.plan || ref.plan || null;
};

function buildExecution({
  runtimeState = null, queueCondition = 'ok', queueError = null, items = [], summary = null,
  scheduler = {}, operation = null, outstanding = false, pauseMode = null, workerBusy = false,
  stopCode = null,
} = {}) {
  const projectionError = queueCondition === 'projection_error';
  const state = projectionError ? 'projection_error'
    : ['setup_required', 'missing'].includes(queueCondition) ? 'setup_required'
    : (runtimeState || 'setup_required');
  const queueOk = queueCondition === 'ok';
  const active = ACTIVE.includes(state);
  const hasWork = items.some((item) => item.status !== 'done');
  const blockedItem = summary?.blocked || null;
  const blocked = items.some((item) => item.status === 'need input');
  const recovery = scheduler.recoveryRequired === true;
  // The provider's quota ran out. It stops the queue in `waiting_input`, but
  // nobody asked a question, so "Needs input" sent people looking for an
  // answer box that does not exist. Name it, and offer Run: the server checks
  // the worker's screen on Run and refuses, with the reason, while the limit
  // still shows (or runs the usage_exhausted recovery script if one is set).
  const quotaStop = state === 'waiting_input' && stopCode === 'usage_exhausted' && !blocked;

  const canRun = queueOk && hasWork && !blocked && (!outstanding || recovery || quotaStop)
    && (EVENTS.run.includes(state) || recovery || quotaStop);
  const runWhyNot = state === 'setup_required' ? 'Set up the queue first'
    : state === 'projection_error' ? 'Regenerate the queue file first'
    : blocked ? 'Resolve the blocked plan first'
    : !hasWork ? 'Add plans to the queue before running'
    : outstanding ? 'A plan was sent and has not been acknowledged; reconcile or pause before running again'
    : scheduler.reason || 'The queue cannot run right now';

  const stopReason = queueError || scheduler.reason || null;
  const edit = (action) => {
    if (!queueOk) return verdict(false, state === 'setup_required' ? 'Set up the queue first' : 'Repair the queue first');
    const v = queueEditVerdict(runtimeState, action, { activeKind: operation?.kind || null });
    // Say what actually unlocks the edit: "pause" is only true advice while
    // the queue is running.
    // A queue can also wait for input with no blocked plan (the provider's
    // quota ran out): then the stop reason itself is the honest answer.
    if (state === 'waiting_input' && !blocked) {
      return verdict(v.allowed, `Not available while the queue is stopped: ${stopReason || 'it is waiting for input'}`);
    }
    const unlock = state === 'waiting_input' ? 'Answer the blocked plan first'
      : state === 'held' ? 'Reconcile the held instruction first'
      : 'Pause the queue first';
    return verdict(v.allowed, action === 'append'
      ? `${unlock}, then add plans`
      : `${unlock} to change the order or remove plans`);
  };

  const reason = state === 'complete' ? 'Queue is done'
    : queueError || (blocked ? blockedItem?.reason : null) || scheduler.reason || null;

  let banner = null;
  if (quotaStop) {
    banner = { kind: 'usage_limit', tone: 'warning', text: `${scheduler.reason || 'The provider\'s usage limit was reached'}. Nothing needs answering: once the limit resets, press Run queue to continue (it checks the worker's screen first). To recover automatically, set up a usage_exhausted script in Configure → Callbacks.` };
  }
  if (state === 'paused') {
    const currentName = nameOf(items, summary?.current);
    banner = workerBusy
      ? { kind: 'paused', tone: 'warning', text: pauseMode === 'current_task'
        ? 'Queue paused — the worker was asked to stop at a safe point and save its progress.'
        : 'Queue paused — the plan in progress is finishing; no new plan will start.' }
      : { kind: 'paused', tone: 'info', text: currentName
        ? `Queue paused — ${currentName} is part-way through. Run queue picks it up where it stopped.`
        : reason || 'Queue paused.' };
  }

  return {
    state, label: quotaStop ? 'Usage limit' : LABELS[state], tone: quotaStop ? 'warning' : TONES[state], active, reason, banner,
    operation: operation || null,
    actions: {
      setup: verdict(state === 'setup_required', 'The runner is already set up'),
      // An interrupted/error turn still owns a persisted operation, but the
      // worker is verified idle and needs an explicit Run to replace it, so
      // recovery offers Run and withdraws Pause.
      run: verdict(canRun, runWhyNot),
      pause: verdict(active && !recovery, recovery ? 'The worker stopped; use Run queue to recover' : 'The queue is not running'),
      // The runtime can hold a projection error after the files match again;
      // it stays until an explicit regeneration, so judge the STATE.
      regenerate: verdict(state === 'projection_error', 'The queue file matches the server queue'),
      reconcile: verdict(!projectionError && ['dispatching', 'awaiting_receipt', 'held'].includes(state), 'No instruction is waiting for a receipt'),
      reviewStatus: verdict(REVIEWABLE_STATES.includes(state), 'Pause the queue before changing a plan\'s status'),
      resolve: verdict(queueOk && state === 'waiting_input' && blocked,
        blocked ? 'The queue must be waiting for input before an answer can be sent' : 'No plan is waiting for input'),
      addItems: edit('append'),
      reorder: edit('reorder'),
      removeItem: edit('remove'),
    },
  };
}

module.exports = { buildExecution, LABELS, TONES };
