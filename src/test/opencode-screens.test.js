// What every screen detector must say about REAL opencode screens (captured by
// the live suite). The detectors decide whether Paddock may type into a pane,
// whether a turn is running, and whether the provider's limit was hit — so they
// are pinned against the genuine TUI, not hand-written strings.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const opencode = require('../services/drivers/opencode');
const { screenUsageEvidence } = require('../services/provider-limit');
const { detectPermission } = require('../services/mission/session-io');

const DIR = path.join(__dirname, 'fixtures', 'opencode-screens');
const read = (name) => fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8');

const EXPECT = {
  ready:              { ready: true,  busy: false },
  busy:               { ready: true,  busy: true },
  'plain-done':       { ready: true,  busy: false },
  'shell-after-exit': { ready: false, busy: false },
  // Captured from a runner's worker on 2026-11-13 (plan 127): an access
  // request, drawn with `←` and a Patterns list instead of `→ tool` / `Path:`.
  'permission-external-dir': { ready: false, busy: false, permission: { tool: 'Access external directory /proc/self', path: '/proc/self/*' } },
};

for (const [name, want] of Object.entries(EXPECT)) {
  it(`real screen "${name}": ready=${want.ready} busy=${want.busy}, no usage limit, permission=${want.permission ? 'yes' : 'none'}`, () => {
    const text = read(name);
    assert.equal(opencode.tuiReadyPattern.test(text), want.ready, 'tuiReadyPattern (sendText waits for it before typing)');
    assert.equal(opencode.tuiBusyPattern.test(text), want.busy, 'tuiBusyPattern (a stalled turn is one the pane does not show running)');
    assert.equal(screenUsageEvidence({ live: true, text }), null, 'a healthy screen is not a usage limit');
    assert.deepEqual(detectPermission(text), want.permission || null, 'the permission dialog, parsed (what is asked, and for which path)');
  });
}

it('every capture in the folder has an expectation (a new fixture must be classified)', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).map((f) => f.replace(/\.txt$/, ''));
  assert.deepEqual(files.sort(), Object.keys(EXPECT).sort());
});
