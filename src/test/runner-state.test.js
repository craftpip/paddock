const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const state = require('../services/runner-state');

describe('plan 113 runner state machine', () => {
  it('owns the legal run, receipt, hold, and pause transitions', () => {
    let current = state.transition('paused', 'run');
    assert.deepEqual(current, { state: 'dispatching', markerRequired: false, allowedActions: ['delivery_unknown', 'receipt', 'hold', 'pause', 'close', 'need_input', 'complete', 'projection_mismatch'] });
    current = state.transition(current.state, 'delivery_unknown');
    assert.equal(current.state, 'awaiting_receipt');
    assert.equal(current.markerRequired, false);
    current = state.transition(current.state, 'hold');
    assert.equal(current.state, 'held');
    assert.equal(current.markerRequired, true);
  });

  it('rejects impossible transitions with the current state and allowed actions', () => {
    assert.throws(
      () => state.transition('paused', 'receipt'),
      (error) => error.code === 'runner_transition_invalid' && error.message.includes('paused') && error.message.includes('run')
    );
    assert.throws(() => state.transition('not-a-state', 'run'), { code: 'runner_state_invalid' });
  });

  it('keeps the marker entirely derived from canonical state', () => {
    for (const name of state.STATES) {
      assert.equal(state.markerRequired(name), ['paused', 'waiting_input', 'held', 'complete', 'projection_error'].includes(name));
    }
  });
});
