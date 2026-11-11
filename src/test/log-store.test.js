const { describe, it } = require('node:test');
const assert = require('node:assert');
const { newLinesFromDockerOutput } = require('../services/log-store');

describe('log-store timestamp capture', () => {
  it('keeps lines that share a millisecond but differ at nanosecond precision', () => {
    const output = [
      '2026-08-09T12:36:35.060238648Z first line',
      '2026-08-09T12:36:35.062234965Z second line',
    ].join('\n');

    const first = newLinesFromDockerOutput(output, { lastTs: 0 });
    assert.deepStrictEqual(first.lines, output.split('\n'));
    assert.strictEqual(first.lastTs, '2026-08-09T12:36:35.062234965Z');

    const second = newLinesFromDockerOutput(output, first);
    assert.deepStrictEqual(second.lines, []);
  });
});

// Plan 122 #20: a log over its byte limit must come out under it even when it
// is a few very long lines (the line-count cut alone never shrank those).
const { it: itTrim } = require('node:test');
itTrim('trims an over-size log made of a few very long lines', () => {
  const fsx = require('node:fs'); const osx = require('node:os'); const px = require('node:path');
  const root = fsx.mkdtempSync(px.join(osx.tmpdir(), 'logtrim-'));
  const prev = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = root;
  require('./helpers/evict')('../services/log-store');
  const store = require('../services/log-store');
  try {
    const file = store.logFile('pad-long');
    fsx.mkdirSync(px.dirname(file), { recursive: true });
    const line = 'x'.repeat(3 * 1024 * 1024);
    fsx.writeFileSync(file, [line, line, line, 'last line'].join('\n')); // ~9 MB, 4 lines
    store.trim('pad-long');
    const after = fsx.readFileSync(file, 'utf8');
    require('node:assert/strict').ok(Buffer.byteLength(after) < 8 * 1024 * 1024, `still ${Buffer.byteLength(after)} bytes`);
    require('node:assert/strict').ok(after.endsWith('last line'), 'the newest line is kept');
  } finally {
    process.env.WORKSPACE_ROOT = prev;
    fsx.rmSync(root, { recursive: true, force: true });
    require('./helpers/evict')('../services/log-store');
  }
});
