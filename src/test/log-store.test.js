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
