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

// Real panes, captured 2026-11-11 on OpenCode 1.19.5 from one stuck worker,
// first at 40x12 (queue panel open) and then at 117x51. The narrow one is the
// pane the status-line-only detector missed for three minutes.
const fs = require('node:fs');
const path = require('node:path');
const pane = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

it('detects the notice in a pane too narrow to draw the status line', () => {
  const narrow = pane('opencode-quota-40x12.txt');
  assert.equal(/Free usage exceeded/.test(narrow), false, 'the status line really is absent at this width');
  const result = screenUsageEvidence({ live: true, text: narrow });
  assert.equal(result?.state, 'exhausted');
  assert.equal(result.evidence.via, 'modal');
});

it('still prefers the status line when the pane is wide enough to show it', () => {
  const result = screenUsageEvidence({ live: true, text: pane('opencode-quota-117x51.txt') });
  assert.equal(result?.state, 'exhausted');
  assert.equal(result.evidence.via, 'status-line');
  assert.match(result.evidence.notice, /retrying in \d+h \d+m attempt #1/);
});

it('does not take a quoted or partial modal for the modal', () => {
  for (const text of [
    'The dialog said Free limit reached and I pressed esc',
    'Free limit reached',
    '    Free limit reached           esc\n\n    some other dialog body\n',
    'Subscribe to OpenCode Go for reliable access to the best open-source models for $10/month.',
    '    Free limit reached           esc\n' + '\n'.repeat(12) + 'Subscribe to OpenCode Go',
  ]) assert.equal(screenUsageEvidence({ live: true, text }), null, JSON.stringify(text.slice(0, 50)));
  assert.equal(screenUsageEvidence({ live: false, text: pane('opencode-quota-40x12.txt') }), null);
});
