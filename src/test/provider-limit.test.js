const { it } = require('node:test');
const assert = require('node:assert/strict');
const { screenUsageEvidence } = require('../services/provider-limit');

it('detects the captured quota retry notice on the live worker pane', () => {
  const result = screenUsageEvidence({ live: true, text: '   ⬝⬝■■■■■■ Free usage exceeded, subscribe to Go [retrying in 8h 58m attempt #1]   esc interrupt' });
  assert.equal(result.state, 'exhausted');
  assert.equal(result.definitive, true);
});

it('does not infer exhaustion from transient limits, empty steps, or quoted notices', () => {
  for (const text of ['429 Rate limit exceeded', 'FreeUsageLimitError', '', 'assistant output: 0', 'The error says Free usage exceeded, subscribe to Go [retrying in 8h attempt #1]']) {
    assert.equal(screenUsageEvidence({ live: true, text }), null);
  }
  assert.equal(screenUsageEvidence({ live: false, text: 'Free usage exceeded, subscribe to Go [retrying in 8h attempt #1]' }), null);
});
