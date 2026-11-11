const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plan 92 §Phase 2: callback script storage, migration and owner-scoped
// settings/result APIs. Storage is pointed at a throwaway dir BEFORE the
// service loads, so no test ever writes into the real worktree; the database
// is throwaway too. There is NO executor yet — several tests pin that saving
// and reading cause zero execution records.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-callbacks-'));
const CBDIR = path.join(WS, 'callbacks');
process.env.WORKSPACE_ROOT = WS;
process.env.PAD_DB_PATH = path.join(WS, 'callbacks.test.db');
process.env.RUNNER_CALLBACKS_DIR = CBDIR;

const PAD = 'pad-callbacks';
fs.mkdirSync(path.join(WS, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(WS, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb, close } = require('../services/db');
const mission = require('../services/mission');
const callbacks = require('../services/runner-callbacks');
const runnerTransition = require('../services/runner-transition');

after(() => fs.rmSync(WS, { recursive: true, force: true }));

function seedPad() {
  getDb().prepare(
    `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
     VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'u1')`
  ).run(PAD, PAD, PAD);
}

const FOLDER = '/root/.opencode/workspace';
function makeProject(name = 'proj') {
  return mission.createProject({ name, agent: PAD, folder: FOLDER, plansFolder: `plans-${name}` });
}

function insertSession(projectId) {
  const id = 'msn_' + Math.random().toString(16).slice(2, 12);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, locked, agent_session_id, created_at, last_seen_at)
     VALUES (?, ?, ?, 'test', 'agent', 0, ?, ?, ?)`
  ).run(id, projectId, 'tmux-' + id, 'ses_' + id, now, now);
  return id;
}

async function makeRunner(projectId, name = 'r') {
  const sid = insertSession(projectId);
  return mission.createRunner({ projectId, name, sessionId: sid, queueFile: `queues/${name}.md` });
}

function makeQuotaWaiting(runnerId) {
  runnerTransition.applyRun(runnerId);
  let runtime = runnerTransition.getRuntime(runnerId);
  runnerTransition.applyDeliveryUnknown(runnerId, { details: { operationId: runtime.operation_id } });
  runtime = runnerTransition.getRuntime(runnerId);
  runnerTransition.applyReceipt(runnerId, { details: { operationId: runtime.operation_id, receiptInputId: 'quota-fixture-receipt' } });
  runnerTransition.applyNeedInput(runnerId, { details: { cause: 'usage_exhausted', reason: 'fixture quota exhaustion' } });
}

beforeEach(() => {
  seedPad();
  const db = getDb();
  db.prepare('DELETE FROM runner_callback_outbox').run();
  db.prepare('DELETE FROM runner_callback_history').run();
  db.prepare('DELETE FROM runner_callbacks').run();
  db.prepare('DELETE FROM runner_queue_observations').run();
  db.prepare('DELETE FROM runner_usage_state').run();
  db.prepare('DELETE FROM infinite_runners').run();
  db.prepare('DELETE FROM mission_sessions').run();
  db.prepare('DELETE FROM mission_projects').run();
  fs.rmSync(CBDIR, { recursive: true, force: true });
});

describe('plan 92 — callback storage and settings', () => {
  it('opt-in quota recovery restores only after successful container replacement and never twice', async () => {
    const recovery = require('../services/quota-recovery');
    const p = makeProject();
    const r = await makeRunner(p.id);
    makeQuotaWaiting(r.id);
    const row = { id: 'recover-one', runner_id: r.id, agent_name: PAD, event: 'usage_exhausted', script_body: 'true\n', recreate_resume: 1 };
    const context = await recovery.begin(row, { inspect: async () => 'old-container' });
    let resumes = 0;
    const deps = { recreate: async (name) => assert.equal(name, PAD), inspect: async () => 'new-container', resume: async (saved) => {
      assert.equal(saved.session_id, r.session_id);
      assert.equal(saved.conversation_id, mission.getSession(r.session_id).agent_session_id);
      resumes++;
    } };
    await recovery.complete(row, context, { status: 'ok', exit_code: 0 }, deps);
    await recovery.complete(row, context, { status: 'ok', exit_code: 0 }, deps);
    assert.equal(resumes, 1);
    assert.equal(getDb().prepare('SELECT status FROM runner_quota_recoveries WHERE event_id = ?').get(row.id).status, 'resumed');
  });

  it('quota recovery holds on exit 75, failure, and unchanged container', async () => {
    const recovery = require('../services/quota-recovery');
    for (const [id, outcome, expected] of [
      ['held', { status: 'error', exit_code: 75 }, 'held'],
      ['failed', { status: 'error', exit_code: 1 }, 'failed'],
      ['unchanged', { status: 'ok', exit_code: 0 }, 'failed'],
    ]) {
      const p = makeProject(id);
      const r = await makeRunner(p.id, id);
      makeQuotaWaiting(r.id);
      const row = { id, runner_id: r.id, agent_name: PAD, event: 'usage_exhausted', script_body: 'true', recreate_resume: 1 };
      const context = await recovery.begin(row, { inspect: async () => 'same-container' });
      await recovery.complete(row, context, outcome, { recreate: async () => {}, inspect: async () => 'same-container', resume: async () => assert.fail('must not resume') });
      assert.equal(getDb().prepare('SELECT status FROM runner_quota_recoveries WHERE event_id = ?').get(id).status, expected);
    }
  });

  it('ordinary callbacks never authorize recovery', async () => {
    const recovery = require('../services/quota-recovery');
    assert.equal(await recovery.begin({ event: 'usage_exhausted', script_body: 'echo notification' }), null);
    assert.equal(await recovery.begin({ event: 'plan_started', recreate_resume: 1 }), null);
  });

  it('recreate/resume preference round-trips and snapshots separately from script text', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    mission.saveRunnerCallbacks(r.id, { usage_exhausted: { script: '/www1/test/log-arguments.sh --rotate testing\n', enabled: true, recreateResume: true } });
    const saved = callbacks.getCallback(r.id, 'usage_exhausted');
    assert.equal(saved.recreateResume, true);
    assert.equal(saved.script, '/www1/test/log-arguments.sh --rotate testing\n');
    const row = callbacks.recordCallbackEvent(mission.getRunner(r.id), p, 'usage_exhausted', { episodeKey: 1 });
    assert.equal(row.recreate_resume, 1);
    assert.throws(() => mission.saveRunnerCallbacks(r.id, { plan_started: { script: 'true', enabled: true, recreateResume: true } }), /only available/);
  });
  it('a fresh runner reads all five events as disabled with no scripts', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const list = mission.getRunnerCallbacks(r.id);
    assert.equal(list.callbacks.length, 5);
    for (const c of list.callbacks) {
      assert.equal(c.enabled, false, `${c.event} starts disabled`);
      assert.equal(c.script, null, `${c.event} starts with no script`);
      assert.equal(c.revision, null);
    }
    assert.equal(list.catalogue.events.length, 5, 'meanings ship with the read');
    assert.ok(list.catalogue.envVars.includes('PADDOCK_EVENT'), 'env contract ships with the read');
  });

  it('saves and reopens all five scripts with flags and revisions', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const bodies = {};
    for (const key of callbacks.CALLBACK_KEYS) bodies[key] = { script: `#!/bin/sh\necho ${key} "$PADDOCK_RUNNER_ID"\n`, enabled: key !== 'destroy' };
    const res = mission.saveRunnerCallbacks(r.id, bodies);
    assert.equal(res.saved.length, 5);
    const reopened = mission.getRunnerCallbacks(r.id);
    for (const c of reopened.callbacks) {
      assert.equal(c.script, bodies[c.event].script, `${c.event} round-trips byte for byte`);
      assert.equal(c.enabled, bodies[c.event].enabled);
      assert.match(c.revision, /^[0-9a-f]{64}$/, 'revision is a content hash');
    }
    // Files live outside tracked code, one per event.
    for (const key of callbacks.CALLBACK_KEYS) {
      const abs = path.join(CBDIR, r.id, `${key}.sh`);
      assert.equal(fs.readFileSync(abs, 'utf8'), bodies[key].script, `${key} file matches`);
    }
    assert.ok(!fs.existsSync(path.join(CBDIR, r.id, 'bogus.sh')), 'no stray files');
  });

  it('partial saves preserve omitted events', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, { init: { script: 'echo hi\n', enabled: true } });
    await mission.saveRunnerCallbacks(r.id, { destroy: { script: 'echo bye\n', enabled: false } });
    const list = mission.getRunnerCallbacks(r.id);
    const byKey = Object.fromEntries(list.callbacks.map((c) => [c.event, c]));
    assert.equal(byKey.init.script, 'echo hi\n');
    assert.equal(byKey.init.enabled, true);
    assert.equal(byKey.destroy.script, 'echo bye\n');
    assert.equal(byKey.plan_started.script, null, 'untouched event stays absent');
  });

  it('disabled scripts retain their text; enabling an empty script fails', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const saved = mission.saveRunnerCallbacks(r.id, { init: { script: 'echo kept\n', enabled: false } });
    assert.equal(saved.callbacks.find((c) => c.event === 'init').script, 'echo kept\n');
    assert.throws(
      () => mission.saveRunnerCallbacks(r.id, { init: { script: '   \n', enabled: true } }),
      (e) => e.code === 'callback_script_empty'
    );
    // The rejected write left the retained text untouched.
    assert.equal(mission.getRunnerCallbacks(r.id).callbacks.find((c) => c.event === 'init').script, 'echo kept\n');
  });

  it('rejects unknown events, bad shapes, oversize scripts and missing runners', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    assert.throws(
      () => mission.saveRunnerCallbacks(r.id, { '../../etc': { script: 'x', enabled: true } }),
      (e) => e.code === 'callback_unknown_event'
    );
    assert.throws(
      () => mission.saveRunnerCallbacks(r.id, { init: 'just a string' }),
      (e) => e.code === 'callback_entry_invalid'
    );
    assert.throws(
      () => mission.saveRunnerCallbacks(r.id, { init: { script: 'x'.repeat(64 * 1024 + 1), enabled: true } }),
      (e) => e.code === 'callback_script_too_large'
    );
    assert.throws(
      () => mission.saveRunnerCallbacks(r.id, { init: { script: 'x', enabled: 'yes' } }),
      (e) => e.code === 'callback_enabled_invalid'
    );
    assert.throws(
      () => mission.saveRunnerCallbacks('run_nope', { init: { script: 'x', enabled: true } }),
      (e) => e.code === 'runner_not_found'
    );
    assert.throws(
      () => mission.saveRunnerCallbacks(r.id, {}),
      (e) => e.code === 'callback_map_missing'
    );
    // A traversal-shaped key never touched the filesystem.
    assert.ok(!fs.existsSync(path.join(CBDIR, 'etc')), 'no escape from the callbacks dir');
    assert.ok(!fs.existsSync(CBDIR) || fs.readdirSync(CBDIR).every((d) => d === r.id), 'only the runner dir exists');
  });

  it('data survives a database restart: files and rows reopen intact', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, { init: { script: 'echo persist\n', enabled: true } });
    close();
    getDb();
    const reopened = mission.getRunnerCallbacks(r.id);
    const init = reopened.callbacks.find((c) => c.event === 'init');
    assert.equal(init.script, 'echo persist\n', 'file survived the restart');
    assert.equal(init.enabled, true, 'flag survived the restart');
    assert.match(init.revision, /^[0-9a-f]{64}$/);
  });

  it('saving and reading create zero execution records (no executor exists yet)', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, { init: { script: 'echo hi\n', enabled: true } });
    mission.getRunnerCallbacks(r.id);
    mission.runnerCallbackHistory({ runnerId: r.id });
    assert.equal(mission.runnerCallbackHistory({ runnerId: r.id }).length, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM runner_callback_history').get().n, 0);
  });
});

describe('plan 92 — history survives runner removal (no FK to the deleted row)', () => {  it('history rows and script files outlive removeRunner and stay readable by project scope', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, { destroy: { script: 'echo gone\n', enabled: true } });
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO runner_callback_history (id, runner_id, project_id, runner_name, event, script_revision, status, exit_code, stdout, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('ev-1', r.id, p.id, 'r', 'plan_completed', 'abc123', 'ok', 0, 'did it', now);
    await mission.removeRunner(r.id);
    assert.equal(mission.getRunner(r.id), undefined, 'runner row is gone');
    assert.equal(fs.readFileSync(path.join(CBDIR, r.id, 'destroy.sh'), 'utf8'), 'echo gone\n', 'script file survives removal');
    // Runner-scoped reads refuse (nothing to gate through), project-scoped reads serve.
    assert.throws(
      () => mission.runnerCallbackHistory({ runnerId: r.id }),
      (e) => e.code === 'runner_not_found'
    );
    const rows = mission.runnerCallbackHistory({ runnerId: r.id, projectId: p.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].stdout, 'did it');
    assert.equal(rows[0].script_revision, 'abc123', 'revision snapshot survives edits and removal');
  });

  it('history needs a scope: neither runner nor project is a refusal', async () => {
    assert.throws(
      () => mission.runnerCallbackHistory({}),
      (e) => e.code === 'callback_history_unscoped'
    );
  });
});

describe('plan 92 — init baseline and destroy recording (mission wiring)', () => {
  it('baseline records an enabled init exactly once, and nothing when disabled', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    assert.equal(await mission.baselineRunnerCallbacks(), 0, 'no scripts saved: nothing to record');
    await mission.saveRunnerCallbacks(r.id, { init: { script: 'echo baseline\n', enabled: true } });
    assert.equal(await mission.baselineRunnerCallbacks(), 1, 'first observation records init');
    assert.equal(await mission.baselineRunnerCallbacks(), 0, 'second observation is a dedup no-op');
    const rows = getDb().prepare("SELECT * FROM runner_callback_outbox WHERE runner_id = ? AND event = 'init'").all(r.id);
    assert.equal(rows.length, 1, 'exactly one init row ever');
    assert.equal(rows[0].script_body, 'echo baseline\n', 'body snapshotted at record time');
  });

  it('removeRunner records a destroy snapshot and the file outlives the row', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, { destroy: { script: 'echo destroy-snap\n', enabled: true } });
    await mission.removeRunner(r.id);
    assert.equal(mission.getRunner(r.id), undefined, 'runner row is gone');
    const rows = getDb().prepare("SELECT * FROM runner_callback_outbox WHERE runner_id = ? AND event = 'destroy'").all(r.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].script_body, 'echo destroy-snap\n', 'snapshot survives later file edits and the deletion');
    assert.equal(fs.readFileSync(path.join(CBDIR, r.id, 'destroy.sh'), 'utf8'), 'echo destroy-snap\n', 'script file survives removal');
  });

  it('removeRunner without a destroy script records nothing and stays quiet', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.removeRunner(r.id);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM runner_callback_outbox').get().n, 0);
  });
});

describe('plan 92 — bounded executor (service level)', () => {
  const CB = require('../services/runner-callbacks');

  function seedSettings(runnerId, event, script) {
    getDb().prepare(
      `INSERT INTO runner_callbacks (runner_id, event, enabled, revision, updated_at)
       VALUES (?, ?, 1, ?, ?) ON CONFLICT (runner_id, event) DO UPDATE SET enabled = 1`
    ).run(runnerId, event, 'rev', new Date().toISOString());
    const dir = path.join(CBDIR, runnerId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${event}.sh`), script);
  }

  function record(runnerId, event, script, cwd) {
    seedSettings(runnerId, event, script);
    return CB.recordCallbackEvent(
      { id: runnerId, name: 't', session_id: null },
      { id: 'prj-t', name: 'pt', agent_name: PAD, folder: cwd },
      event, { cwd }
    );
  }

  async function waitFor(id, timeoutMs = 10000) {
    const start = Date.now();
    for (;;) {
      const row = getDb().prepare('SELECT status FROM runner_callback_outbox WHERE id = ?').get(id);
      if (row && row.status !== 'pending' && row.status !== 'running') return row.status;
      if (Date.now() - start > timeoutMs) throw new Error(`outbox ${id} unsettled after ${timeoutMs}ms`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('runs a script with the event environment and mirrors ok + output to history', async () => {
    const row = record('run-exec-1', 'init', 'echo "ev=$PADDOCK_EVENT id=$PADDOCK_EVENT_ID runner=$PADDOCK_RUNNER_ID"\n', os.tmpdir());
    assert.ok(row && row.status === 'pending');
    await CB.pumpCallbackOutbox();
    assert.equal(await waitFor(row.id), 'ok');
    const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
    assert.equal(done.exit_code, 0);
    assert.match(done.stdout, /ev=init/);
    assert.match(done.stdout, new RegExp(`id=${row.id}`));
    assert.match(done.stdout, /runner=run-exec-1/);
    const hist = getDb().prepare('SELECT * FROM runner_callback_history WHERE id = ?').get(row.id);
    assert.equal(hist.status, 'ok');
    assert.equal(hist.stdout, done.stdout, 'history mirrors the settled row');
  });

  it('a nonzero exit is a visible error, not a trigger for anything else', async () => {
    const row = record('run-exec-2', 'destroy', 'echo oops >&2\nexit 3\n', os.tmpdir());
    await CB.pumpCallbackOutbox();
    assert.equal(await waitFor(row.id), 'error');
    const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
    assert.equal(done.exit_code, 3);
    assert.match(done.stderr, /oops/);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM runner_callback_outbox').get().n, 1, 'no follow-up rows');
  });

  it('a slow script is killed as a process group on timeout', async () => {
    const row = record('run-exec-3', 'init', 'sleep 30\n', os.tmpdir());
    const launched = await CB.launchCallback(getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id), { timeoutMs: 500 });
    assert.equal(launched, true);
    const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
    assert.equal(done.status, 'timeout', 'exceeded budget marks timeout');
  });

  it('oversized output is cut at the byte budget and marked truncated', async () => {
    const row = record('run-exec-4', 'init', 'yes | head -c 200000\n', os.tmpdir());
    await CB.pumpCallbackOutbox();
    assert.equal(await waitFor(row.id), 'ok');
    const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
    assert.ok(Buffer.byteLength(done.stdout, 'utf8') <= 64 * 1024 + 8, 'stored output respects the cap');
    assert.equal(done.truncated, 1);
  });

  it('the platform injects only the contract env — no inherited secrets', async () => {
    process.env.CB_CANARY_TEST = 'topsecret-canary';
    try {
      const row = record('run-exec-5', 'init', 'env\n', os.tmpdir());
      await CB.pumpCallbackOutbox();
      assert.equal(await waitFor(row.id), 'ok');
      const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
      assert.ok(!done.stdout.includes('topsecret-canary'), 'inherited environment does not leak in');
      assert.match(done.stdout, /PADDOCK_EVENT=init/);
    } finally {
      delete process.env.CB_CANARY_TEST;
    }
  });

  it('a recorded cwd that does not exist here still runs the script, and says where (plan 123 #11)', async () => {
    // The recorded cwd is the project folder INSIDE the PAD; the script runs
    // in the control plane, where that path usually is not there. It used to
    // fail before running a line and end "unknown" with empty output.
    const row = record('run-exec-nocwd', 'init', 'echo ran; pwd\n', '/root/.opencode/no/such/folder');
    await CB.pumpCallbackOutbox();
    assert.equal(await waitFor(row.id), 'ok');
    const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
    assert.equal(done.status, 'ok', `status ${done.status}, stderr: ${done.stderr}`);
    assert.match(done.stdout, /^ran\n/);
    assert.match(done.stderr, /does not exist in the control plane/);
  });

  it('the script runs with the recorded cwd', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cwd-'));
    try {
      const row = record('run-exec-6', 'init', 'pwd\n', cwd);
      await CB.pumpCallbackOutbox();
      assert.equal(await waitFor(row.id), 'ok');
      const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
      assert.equal(done.stdout.trim(), cwd);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a second launch of the same row loses the claim (no double execution)', async () => {
    const row = record('run-exec-7', 'init', 'echo once\n', os.tmpdir());
    const fresh = () => getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id);
    const [a, b] = await Promise.all([CB.launchCallback(fresh(), {}), CB.launchCallback(fresh(), {})]);
    assert.ok((a && !b) || (!a && b), 'exactly one claimant wins');
    assert.equal(await waitFor(row.id), 'ok');
  });

  it('serial per runner: a busy runner keeps its next row pending', async () => {
    // An in-flight launch (running row) plus a second pending event for the
    // same runner: the pump must leave the second row alone.
    const initRow = record('run-busy', 'init', 'echo first\n', os.tmpdir());
    seedSettings('run-busy', 'destroy', 'echo second\n');
    const second = CB.recordCallbackEvent(
      { id: 'run-busy', name: 'b', session_id: null },
      { id: 'p', name: 'p', agent_name: PAD, folder: os.tmpdir() },
      'destroy', { cwd: os.tmpdir() }
    );
    getDb().prepare("UPDATE runner_callback_outbox SET status = 'running' WHERE id = ?").run(initRow.id);
    await CB.pumpCallbackOutbox();
    assert.equal(
      getDb().prepare('SELECT status FROM runner_callback_outbox WHERE id = ?').get(second.id).status,
      'pending', 'second event waits while the runner is busy'
    );
  });

  it('fleet cap gates launches deterministically at zero', async () => {
    const row = record('run-cap', 'init', 'echo hi\n', os.tmpdir());
    assert.equal(await CB.pumpCallbackOutbox({ fleetMax: 0 }), 0);
    assert.equal(getDb().prepare('SELECT status FROM runner_callback_outbox WHERE id = ?').get(row.id).status, 'pending');
  });

  it('boot reconcile finalizes interrupted rows as unknown and never relaunches them', async () => {
    getDb().prepare(
      `INSERT INTO runner_callback_outbox (id, runner_id, project_id, runner_name, project_name, agent_name, event, cwd, script_revision, script_body, dedup_key, status, started_at, created_at)
       VALUES ('orphan-1', 'run-gone', 'p', 'g', 'pp', 'opencode', 'init', ?, 'r', 'echo x', 'run-gone:init', 'running', ?, ?)`
    ).run(os.tmpdir(), new Date().toISOString(), new Date().toISOString());
    assert.equal(CB.reconcileCallbackOutbox(), 1);
    const done = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get('orphan-1');
    assert.equal(done.status, 'unknown');
    assert.match(done.stderr, /did not survive the restart/);
    assert.equal(getDb().prepare('SELECT status FROM runner_callback_history WHERE id = ?').get('orphan-1').status, 'unknown', 'mirrored to history');
    await CB.pumpCallbackOutbox();
    assert.equal(getDb().prepare('SELECT status FROM runner_callback_outbox WHERE id = ?').get('orphan-1').status, 'unknown', 'pump does not relaunch it');
  });
});

describe('plan 92 — queue-transition observation (plan_started / plan_completed)', () => {
  const CB = require('../services/runner-callbacks');

  // A queue item in the exact shape plans.parseQueue produces.
  const item = (id, status, plan = `plans/${id}.md`) => ({ id, plan, status, reason: status === 'need input' ? 'blocked' : '' });

  async function enabledRunner() {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, {
      plan_started: { script: 'echo started "$PADDOCK_ITEM_ID" "$PADDOCK_ITEM_ATTEMPT"\n', enabled: true },
      plan_completed: { script: 'echo done "$PADDOCK_ITEM_ID" "$PADDOCK_ITEM_ATTEMPT"\n', enabled: true },
    });
    return { runner: mission.getRunner(r.id), project: mission.getProject(p.id) };
  }

  function rows(runnerId, event) {
    return getDb().prepare('SELECT * FROM runner_callback_outbox WHERE runner_id = ? AND event = ? ORDER BY created_at, rowid').all(runnerId, event);
  }

  it('first observation is a baseline: no historical event is replayed', async () => {
    const { runner, project } = await enabledRunner();
    const n = CB.observeQueue(runner, project, [item('i1', 'new'), item('i2', 'done')], { queuePath: '/q/QUEUE.md' });
    assert.equal(n, 0, 'baseline records nothing');
    assert.equal(rows(runner.id, 'plan_started').length, 0);
    assert.equal(rows(runner.id, 'plan_completed').length, 0);
  });

  it('new → in progress records plan_started once, with attempt identity', async () => {
    const { runner, project } = await enabledRunner();
    CB.observeQueue(runner, project, [item('i1', 'new')], {});
    const n = CB.observeQueue(runner, project, [item('i1', 'in progress')], { queuePath: '/q/QUEUE.md' });
    assert.equal(n, 1);
    const started = rows(runner.id, 'plan_started');
    assert.equal(started.length, 1);
    assert.equal(started[0].item_id, 'i1');
    assert.equal(started[0].item_attempt, '1');
    assert.equal(started[0].queue_path, '/q/QUEUE.md');
    assert.equal(started[0].plan_path, 'plans/i1.md');
    // A second look at the same in-progress item is no new event.
    assert.equal(CB.observeQueue(runner, project, [item('i1', 'in progress')], {}), 0);
    assert.equal(rows(runner.id, 'plan_started').length, 1, 'continuation/resume does not re-fire');
  });

  it('in progress → done records plan_completed once for the same attempt', async () => {
    const { runner, project } = await enabledRunner();
    CB.observeQueue(runner, project, [item('i1', 'new')], {});
    CB.observeQueue(runner, project, [item('i1', 'in progress')], {});
    const n = CB.observeQueue(runner, project, [item('i1', 'done')], {});
    assert.equal(n, 1);
    const done = rows(runner.id, 'plan_completed');
    assert.equal(done.length, 1);
    assert.equal(done[0].item_attempt, '1', 'completion belongs to the current attempt');
    assert.equal(CB.observeQueue(runner, project, [item('i1', 'done')], {}), 0, 'no repeat completion');
  });

  it('an explicit requeue earns a new attempt and a fresh start event', async () => {
    const { runner, project } = await enabledRunner();
    CB.observeQueue(runner, project, [item('i1', 'new')], {});
    CB.observeQueue(runner, project, [item('i1', 'in progress')], {}); // attempt 1
    CB.observeQueue(runner, project, [item('i1', 'new')], {});        // requeued, no event
    const n = CB.observeQueue(runner, project, [item('i1', 'in progress')], {}); // attempt 2
    assert.equal(n, 1);
    const started = rows(runner.id, 'plan_started');
    assert.equal(started.length, 2, 'requeue emits a second start');
    assert.equal(started[0].item_attempt, '1');
    assert.equal(started[1].item_attempt, '2');
    // Different attempt => distinct dedup keys.
    assert.notEqual(started[0].dedup_key, started[1].dedup_key);
  });

  it('a start+end between polls yields completion only — no invented start', async () => {
    const { runner, project } = await enabledRunner();
    CB.observeQueue(runner, project, [item('i1', 'new')], {});
    CB.observeQueue(runner, project, [item('i1', 'done')], {}); // start+end unseen
    const started = rows(runner.id, 'plan_started');
    const done = rows(runner.id, 'plan_completed');
    assert.equal(started.length, 0, 'no start event is fabricated for an unseen gap');
    assert.equal(done.length, 1, 'the observed completion is still recorded');
    assert.equal(done[0].item_attempt, '1');
  });

  it('observation advances while a callback is disabled (no replay on later enable)', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const runner = mission.getRunner(r.id);
    const project = mission.getProject(p.id);
    CB.observeQueue(runner, project, [item('i1', 'new')], {});
    // plan_started callback disabled: the transition is observed but not recorded.
    assert.equal(CB.observeQueue(runner, project, [item('i1', 'in progress')], {}), 0);
    assert.equal(rows(runner.id, 'plan_started').length, 0);
    // Enabled now, but the item is already in progress — no replayed start.
    await mission.saveRunnerCallbacks(r.id, { plan_started: { script: 'echo x\n', enabled: true } });
    assert.equal(CB.observeQueue(runner, project, [item('i1', 'in progress')], {}), 0);
    assert.equal(rows(runner.id, 'plan_started').length, 0, 'enabling cannot replay an old transition');
  });

  it('need input and missing items are status updates, never events', async () => {
    const { runner, project } = await enabledRunner();
    CB.observeQueue(runner, project, [item('i1', 'new'), item('i2', 'new')], {});
    assert.equal(CB.observeQueue(runner, project, [item('i1', 'in progress'), item('i2', 'new')], {}), 1, 'one start');
    const n = CB.observeQueue(runner, project, [item('i1', 'need input'), item('i3', 'new')], {});
    assert.equal(n, 0, 'need input and a new item are not events');
    assert.equal(rows(runner.id, 'plan_started').length, 1, 'only the original start');
    assert.equal(rows(runner.id, 'plan_completed').length, 0);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM runner_queue_observations WHERE runner_id = ?').get(runner.id).n, 3, 'i3 baselined, i2 kept');
  });

  it('two concurrent observe passes collapse onto one event per attempt', async () => {
    const { runner, project } = await enabledRunner();
    CB.observeQueue(runner, project, [item('i1', 'new')], {});
    const a = CB.observeQueue(runner, project, [item('i1', 'in progress')], {});
    const b = CB.observeQueue(runner, project, [item('i1', 'in progress')], {});
    assert.equal(a + b, 1, 'the dedup key makes the second pass a no-op');
    assert.equal(rows(runner.id, 'plan_started').length, 1);
  });
});

describe('plan 92 — observeRunnerQueues reads canonical queue transitions', () => {
  it('records a start when a runner\'s queue item turns in progress', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, { plan_started: { script: 'echo s\n', enabled: true } });
    // Set up canonical queue
    await mission.setupRunnerQueue(r.id);
    await mission.addRunnerQueueItems(r.id, ['plans/a.md', 'plans/b.md'], 0);
    // Baseline
    assert.equal(await mission.observeRunnerQueues(), 0, 'first pass baselines');
    // Update item to in_progress via canonical API
    const queue = await mission.readRunnerQueue(r.id);
    const itemId = queue.queue.items[0].id;
    await mission.updateRunnerQueueItem(r.id, itemId, { status: 'in_progress', reason: '' }, queue.queue.revision);
    assert.equal(await mission.observeRunnerQueues(), 1, 'the observed transition records one event');
    const started = getDb().prepare("SELECT * FROM runner_callback_outbox WHERE runner_id = ? AND event = 'plan_started'").all(r.id);
    assert.equal(started.length, 1);
    // Canonical queue uses server-generated IDs (rqi_...), not user-provided ones
    assert.equal(started[0].item_id, itemId);
    // A projection error (external edit) is not a transition
    // Corrupt the queue by writing directly to the database with invalid items
    getDb().prepare('UPDATE runner_queue_items SET status = ? WHERE id = ?').run('invalid_status', itemId);
    assert.equal(await mission.observeRunnerQueues(), 0);
  });
});

describe('plan 92 — usage-exhaustion episode observation (plan 75 row 8)', () => {
  const CB = require('../services/runner-callbacks');

  async function enabledRunner() {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.saveRunnerCallbacks(r.id, {
      usage_exhausted: { script: 'echo use "$PADDOCK_USAGE_REASON"\n', enabled: true },
    });
    return { runner: mission.getRunner(r.id), project: mission.getProject(p.id), runnerId: r.id };
  }
  const usageRows = (runnerId) => getDb().prepare("SELECT * FROM runner_callback_outbox WHERE runner_id = ? AND event = 'usage_exhausted'").all(runnerId);
  const stateOf = (runnerId) => getDb().prepare('SELECT * FROM runner_usage_state WHERE runner_id = ?').get(runnerId);
  const exhausted = (reason = 'newest is unanswered user') => ({ state: 'exhausted', reason, evidence: { newestRole: 'user' } });
  const ok = (reason = 'answered') => ({ state: 'ok', reason, evidence: null });
  const unknown = (reason = 'store unreadable') => ({ state: 'unknown', reason, evidence: null });

  it('the captured quota retry notice fires once even while the provider turn remains working', async () => {
    const { runner, project, runnerId } = await enabledRunner();
    const evidence = require('../services/provider-limit').screenUsageEvidence({
      live: true,
      text: '  ⬝⬝■■■■■■ Free usage exceeded, subscribe to Go [retrying in 8h 58m attempt #1]',
    });
    assert.equal(CB.observeUsage(runner, project, evidence, { busy: true, busyKnown: true }), 1);
    assert.equal(CB.observeUsage(runner, project, evidence, { busy: true, busyKnown: true }), 0);
    assert.equal(usageRows(runnerId).length, 1);
  });

  it('confirms once: a not-busy exhausted read records one event with the episode key', async () => {
    const { runner, project, runnerId } = await enabledRunner();
    const n = CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: true });
    assert.equal(n, 1);
    const rows = usageRows(runnerId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dedup_key, `${runnerId}:usage_exhausted:1`);
    assert.equal(rows[0].usage_reason, 'newest is unanswered user');
    assert.equal(stateOf(runnerId).state, 'exhausted');
    assert.equal(stateOf(runnerId).episode_seq, 1);
  });

  it('a repeated exhausted read is the SAME episode — no second event', async () => {
    const { runner, project, runnerId } = await enabledRunner();
    CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: true });
    assert.equal(CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: true }), 0);
    assert.equal(usageRows(runnerId).length, 1);
  });

  it('a live turn (busy) neither arms nor fires an episode', async () => {
    const { runner, project, runnerId } = await enabledRunner();
    assert.equal(CB.observeUsage(runner, project, exhausted(), { busy: true, busyKnown: true }), 0);
    assert.equal(usageRows(runnerId).length, 0);
    assert.equal(stateOf(runnerId).state, 'clear');
  });

  it('an unreadable store or unanswerable busy probe is WITHHELD, never armed', async () => {
    const { runner, project, runnerId } = await enabledRunner();
    assert.equal(CB.observeUsage(runner, project, unknown(), { busy: false, busyKnown: false }), 0);
    // exhausted signature but the busy probe could not answer -> withhold
    assert.equal(CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: false }), 0);
    assert.equal(usageRows(runnerId).length, 0);
    assert.equal(stateOf(runnerId).state, 'clear');
  });

  it('only measured recovery re-arms; a second exhaustion is a NEW episode', async () => {
    const { runner, project, runnerId } = await enabledRunner();
    CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: true }); // episode 1
    // A withheld/unknown read after an armed episode must not clear it.
    assert.equal(CB.observeUsage(runner, project, unknown(), { busy: false, busyKnown: false }), 0);
    assert.equal(stateOf(runnerId).state, 'exhausted');
    // Measured recovery: the input got a real reply.
    assert.equal(CB.observeUsage(runner, project, ok(), { busy: false, busyKnown: true }), 0);
    assert.equal(stateOf(runnerId).state, 'clear');
    assert.equal(stateOf(runnerId).episode_seq, 1, 'seq holds across recovery');
    // A later confirmed exhaustion is episode 2 with a distinct dedup key.
    assert.equal(CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: true }), 1);
    const rows = usageRows(runnerId);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].dedup_key, `${runnerId}:usage_exhausted:2`);
    assert.equal(stateOf(runnerId).episode_seq, 2);
  });

  it('observation advances while the callback is disabled (no replay on enable)', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const runner = mission.getRunner(r.id);
    const project = mission.getProject(p.id);
    // disabled: the episode is observed, not recorded
    assert.equal(CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: true }), 0);
    assert.equal(usageRows(r.id).length, 0);
    assert.equal(stateOf(r.id).state, 'exhausted');
    // enabling now cannot replay the already-armed episode
    await mission.saveRunnerCallbacks(r.id, { usage_exhausted: { script: 'echo x\n', enabled: true } });
    assert.equal(CB.observeUsage(runner, project, exhausted(), { busy: false, busyKnown: true }), 0);
    assert.equal(usageRows(r.id).length, 0, 'enabling cannot replay an old episode');
  });
});
