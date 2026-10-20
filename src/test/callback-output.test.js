const { it } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = () => import(pathToFileURL(path.join(__dirname, '../client/src/lib/callback-output.js')).href);

it('successful Compose progress is readable, not an error, including old wrapper prefixes', async () => {
  const { callbackOutput } = await load();
  const original = { status: 'ok', exit_code: 0, stdout: 'stderr  Container pad-one Recreated\n\n\nsystem Reclaimed 10MB\n', stderr: 'Container pad-one Started\n' };
  const result = callbackOutput(original);
  assert.equal(result.label, 'Completed');
  assert.equal(result.failed, false);
  assert.equal(result.output, 'Container pad-one Recreated\n\nReclaimed 10MB');
  assert.equal(result.diagnostics, 'Container pad-one Started');
  assert.match(original.stdout, /^stderr/, 'stored history is not modified');
});

it('actual failures retain their messages and unknown outcomes do not claim success', async () => {
  const { callbackOutput } = await load();
  const failure = callbackOutput({ status: 'error', exit_code: 1, stderr: 'permission denied' });
  assert.equal(failure.label, 'Failed');
  assert.equal(failure.failed, true);
  assert.equal(failure.diagnostics, 'permission denied');
  assert.equal(callbackOutput({ status: 'unknown' }).label, 'Outcome unknown');
});
