const { after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-state-sequence-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'test.db');
const PAD = 'pad-seq';

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const runnerTransition = require('../services/runner-transition');
const runnerQueue = require('../services/runner-queue');

after(() => fs.rmSync(root, { recursive: true, force: true }));

function seedPad() {
  const db = getDb();
  db.prepare("INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')").run(PAD, PAD, PAD);
  const instanceDir = path.join(root, 'instances', PAD);
  fs.mkdirSync(path.join(instanceDir, 'opencode'), { recursive: true });
  fs.writeFileSync(path.join(instanceDir, 'meta.env'), 'AGENT=opencode\n');
}

function seedProject() {
  const project = mission.createProject({ name: 'seq-proj', agent: PAD, folder: '/root/.opencode/workspace' });
  return project;
}

function seedSession(projectId) {
  const session = mission.createSession(projectId, { agentSessionId: 'ses_seq' });
  return session;
}

function seedRunner(projectId, sessionId) {
  const runner = mission.createRunner({ projectId, sessionId, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
  return runner;
}

function applyUnknown(runnerId) {
  const runtime = runnerTransition.getRuntime(runnerId);
  return runnerTransition.applyDeliveryUnknown(runnerId, { details: { operationId: runtime.operation_id } });
}

function applyReceipt(runnerId) {
  const runtime = runnerTransition.getRuntime(runnerId);
  return runnerTransition.applyReceipt(runnerId, { details: { operationId: runtime.operation_id, receiptInputId: `receipt-${runtime.generation}` } });
}

function resetDb() {
  const db = getDb();
  // Disable FK checks temporarily to allow clean slate
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM runner_operations; DELETE FROM runner_publications; DELETE FROM runner_projection_owners; DELETE FROM runner_runtime; DELETE FROM runner_transitions; DELETE FROM runner_queue_events; DELETE FROM runner_queue_items; DELETE FROM runner_queues; DELETE FROM infinite_runners; DELETE FROM mission_sessions; DELETE FROM mission_projects; DELETE FROM agents;');
  db.pragma('foreign_keys = ON');
  fs.rmSync(path.join(root, 'instances', PAD, 'opencode', 'workspace'), { recursive: true, force: true });
  seedPad();
}

describe('plan 113 runner state machine — canonical transitions', () => {
  it('initial state is paused (canonical)', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    const withCanonical = runnerTransition.getRunnerWithCanonical(runner.id);
    assert.equal(withCanonical.canonicalState, 'paused');
    assert.equal(withCanonical.markerRequired, true);
    assert.deepEqual(withCanonical.allowedActions.sort(), ['adopt_active_turn', 'pause', 'close', 'run', 'projection_mismatch', 'queue_blocked', 'review_complete'].sort());
  });

  it('serializes concurrent Run attempts from independent database connections', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq_race' });
    const runner = await seedRunner(project.id, session.id);
    const gate = path.join(root, 'run-race.go');
    const ready = [path.join(root, 'run-race-a.ready'), path.join(root, 'run-race-b.ready')];
    const service = path.resolve(__dirname, '../services/runner-transition');
    const script = `
      const fs = require('node:fs');
      const transition = require(${JSON.stringify(service)});
      const runtime = transition.getRuntime(process.env.RUNNER_ID);
      fs.writeFileSync(process.env.READY_FILE, runtime.state);
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(process.env.GATE_FILE)) Atomics.wait(wait, 0, 0, 5);
      try { transition.applyRun(process.env.RUNNER_ID, { actor: process.env.WORKER }); console.log(JSON.stringify({ ok: true })); }
      catch (error) { console.log(JSON.stringify({ ok: false, code: error.code })); }
    `;
    const children = ready.map((readyFile, index) => spawn(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, RUNNER_ID: runner.id, READY_FILE: readyFile, GATE_FILE: gate, WORKER: `race-${index}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const outcomes = Promise.all(children.map((child) => new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0
        ? resolve(JSON.parse(stdout.trim().split('\n').at(-1)))
        : reject(new Error(`race child exited ${code}: ${stderr}`)));
    })));
    const deadline = Date.now() + 5000;
    while (!ready.every((file) => fs.existsSync(file)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(ready.every((file) => fs.existsSync(file)), 'both independent connections reached the pre-transaction barrier');
    assert.deepEqual(ready.map((file) => fs.readFileSync(file, 'utf8')), ['paused', 'paused']);
    fs.writeFileSync(gate, 'go');
    const results = await outcomes;
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === 'runner_transition_invalid' || result.code === 'runner_transition_conflict').length, 1);
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'dispatching');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM runner_transitions WHERE runner_id = ? AND event = \'run\'').get(runner.id).n, 1);
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM runner_operations WHERE runner_id = ?').get(runner.id).n, 1);
  });

  it('reads execution authorization from runner_runtime, not legacy flags or stop fields', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'runtime-source' });
    runnerTransition.applyRun(runner.id);
    runnerTransition.applyDeliveryUnknown(runner.id, { details: { operationId: runnerTransition.getRuntime(runner.id).operation_id } });
    // These fields deliberately contradict the state row. The Mission-facing
    // runner projection must still report the durable canonical state.
    getDb().prepare("UPDATE infinite_runners SET enabled = 0, control_state = 'paused', operation_status = 'ended', stop_cause = 'bad-old-value' WHERE id = ?").run(runner.id);
    const view = mission.getRunner(runner.id);
    assert.equal(view.canonicalState, 'awaiting_receipt');
    assert.equal(view.control_state, 'enabled');
    assert.equal(view.enabled, 1);
    assert.equal(view.operation_status, 'unconfirmed');
    assert.equal(view.stop_cause, 'delivery_unknown');
  });

  it('run transitions paused -> dispatching', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    const result = runnerTransition.applyRun(runner.id);
    assert.equal(result.canonicalState, 'dispatching');
    assert.equal(result.markerRequired, false);
    assert.deepEqual(result.allowedActions.sort(), ['delivery_unknown', 'receipt', 'hold', 'pause', 'close', 'need_input', 'complete', 'projection_mismatch'].sort());
  });

  it('delivery_unknown transitions dispatching -> awaiting_receipt', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    const result = applyUnknown(runner.id);
    assert.equal(result.canonicalState, 'awaiting_receipt');
    assert.equal(result.markerRequired, false);
    assert.deepEqual(result.allowedActions.sort(), ['receipt', 'hold', 'pause', 'close', 'need_input', 'complete', 'projection_mismatch'].sort());
  });

  it('receipt transitions awaiting_receipt -> running', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    const result = applyReceipt(runner.id);
    assert.equal(result.canonicalState, 'running');
    assert.equal(result.markerRequired, false);
    assert.deepEqual(result.allowedActions.sort(), ['dispatch_next', 'turn_completed', 'hold', 'pause', 'close', 'need_input', 'complete', 'projection_mismatch'].sort());
  });

  it('refuses a receipt from a different operation while leaving the owned attempt unchanged', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-wrong-receipt' });
    runnerTransition.applyRun(runner.id, { details: { conversationId: session.agent_session_id } });
    const operationId = runnerTransition.getRuntime(runner.id).operation_id;
    runnerTransition.applyDeliveryUnknown(runner.id, { details: { operationId } });
    const before = runnerTransition.getRuntime(runner.id);
    assert.throws(
      () => runnerTransition.applyReceipt(runner.id, { details: { operationId: 'rop_not_owned', receiptInputId: 'foreign-input' } }),
      { code: 'runner_operation_superseded' }
    );
    assert.deepEqual(runnerTransition.getRuntime(runner.id), before);
    assert.equal(getDb().prepare('SELECT status FROM runner_operations WHERE id = ?').get(operationId).status, 'awaiting_receipt');
  });

  it('completed turn retires its owned operation before next-item dispatch', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-turn' });
    runnerTransition.applyRun(runner.id, { details: { conversationId: session.agent_session_id, itemId: 'item-1' } });
    const first = runnerTransition.getRuntime(runner.id);
    runnerTransition.applyReceipt(runner.id, { details: { operationId: first.operation_id, receiptInputId: 'input-1' } });
    runnerTransition.applyTurnCompleted(runner.id, { details: { operationId: first.operation_id, receiptInputId: 'input-1' } });
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'running');
    assert.equal(runnerTransition.getRuntime(runner.id).operation_id, null);
    assert.equal(getDb().prepare('SELECT status FROM runner_operations WHERE id = ?').get(first.operation_id).status, 'completed');
    const next = runnerTransition.applyDispatchNext(runner.id, { details: { conversationId: session.agent_session_id, itemId: 'item-2' } });
    assert.equal(next.canonicalState, 'dispatching');
    assert.notEqual(next.runtime.operation_id, first.operation_id);
  });

  it('Pause revokes receipt ownership; a late receipt leaves runtime and operation invalidated', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-late-receipt' });
    runnerTransition.applyRun(runner.id, { details: { conversationId: session.agent_session_id } });
    const operationId = runnerTransition.getRuntime(runner.id).operation_id;
    runnerTransition.applyDeliveryUnknown(runner.id, { details: { operationId } });
    runnerTransition.applyPause(runner.id, { actor: 'test' });
    assert.throws(
      () => runnerTransition.applyReceipt(runner.id, { details: { operationId, receiptInputId: 'late-input' } }),
      { code: 'runner_transition_invalid' }
    );
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
    assert.equal(runnerTransition.getRuntime(runner.id).operation_id, null);
    assert.equal(getDb().prepare('SELECT status FROM runner_operations WHERE id = ?').get(operationId).status, 'invalidated');
  });

  it('hold transitions awaiting_receipt/running -> held', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    let result = runnerTransition.applyHold(runner.id);
    assert.equal(result.canonicalState, 'held');
    assert.equal(result.markerRequired, true);

    // from running
    resetDb();
    const project2 = seedProject();
    const session2 = mission.createSession(project2.id, { agentSessionId: 'ses_seq' });
    const runner2 = await mission.createRunner({ projectId: project2.id, sessionId: session2.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner2.id);
    applyUnknown(runner2.id);
    applyReceipt(runner2.id);
    result = runnerTransition.applyHold(runner2.id);
    assert.equal(result.canonicalState, 'held');
  });

  it('pause from paused -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('pause from dispatching -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    runnerTransition.applyRun(runner.id);
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('pause from awaiting_receipt -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('pause from running -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    applyReceipt(runner.id);
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('pause from waiting_input -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    applyReceipt(runner.id);
    runnerTransition.applyNeedInput(runner.id);
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('pause from held -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    applyReceipt(runner.id);
    runnerTransition.applyHold(runner.id);
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('pause from complete -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    runnerTransition.applyRun(runner.id);
    runnerTransition.applyComplete(runner.id);
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('pause from projection_error -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    runnerTransition.applyProjectionMismatch(runner.id);
    const result = runnerTransition.applyPause(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('close transitions any state -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    const result = runnerTransition.applyClose(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('need_input transitions dispatching/awaiting_receipt/running -> waiting_input', async () => {
    for (const from of ['dispatching', 'awaiting_receipt', 'running']) {
      resetDb();
      const project = seedProject();
      const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
      const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

      runnerTransition.applyRun(runner.id);
      if (from === 'awaiting_receipt') applyUnknown(runner.id);
      else if (from === 'running') {
        applyUnknown(runner.id);
        applyReceipt(runner.id);
      }
      const result = runnerTransition.applyNeedInput(runner.id);
      assert.equal(result.canonicalState, 'waiting_input');
      assert.equal(result.markerRequired, true);
    }
  });

  it('resolve transitions waiting_input -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    applyReceipt(runner.id);
    runnerTransition.applyNeedInput(runner.id);
    const result = runnerTransition.applyResolve(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('complete transitions dispatching/awaiting_receipt/running -> complete', async () => {
    for (const from of ['dispatching', 'awaiting_receipt', 'running']) {
      resetDb();
      const project = seedProject();
      const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
      const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

      runnerTransition.applyRun(runner.id);
      if (from === 'awaiting_receipt') applyUnknown(runner.id);
      else if (from === 'running') {
        applyUnknown(runner.id);
        applyReceipt(runner.id);
      }
      const result = runnerTransition.applyComplete(runner.id);
      assert.equal(result.canonicalState, 'complete');
      assert.equal(result.markerRequired, true);
    }
  });

  it('projection_mismatch transitions any state -> projection_error', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    const result = runnerTransition.applyProjectionMismatch(runner.id);
    assert.equal(result.canonicalState, 'projection_error');
    assert.equal(result.markerRequired, true);
    // From projection_error, allowed actions are limited (not run, delivery_unknown, etc.)
    assert.deepEqual(result.allowedActions.sort(), ['close', 'pause', 'projection_mismatch', 'projection_regenerated'].sort());
  });

  it('projection_regenerated transitions projection_error -> paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyProjectionMismatch(runner.id);
    const result = runnerTransition.applyProjectionRegenerated(runner.id);
    assert.equal(result.canonicalState, 'paused');
    assert.equal(result.markerRequired, true);
  });

  it('records every transition in runner_transitions table', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    applyReceipt(runner.id);
    runnerTransition.applyPause(runner.id);

    const transitions = runnerTransition.getTransitions(runner.id);
    assert.equal(transitions.length, 4);
    assert.deepEqual(transitions.map(t => t.event), ['run', 'delivery_unknown', 'receipt', 'pause']);
    assert.deepEqual(transitions.map(t => t.from_state), ['paused', 'dispatching', 'awaiting_receipt', 'running']);
    assert.deepEqual(transitions.map(t => t.to_state), ['dispatching', 'awaiting_receipt', 'running', 'paused']);
  });

  it('rejects invalid transitions with typed error', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    assert.throws(
      () => applyReceipt(runner.id),
      (err) => err.code === 'runner_transition_invalid' && err.message.includes('paused') && err.message.includes('run')
    );

    assert.throws(
      () => runnerTransition.applyHold(runner.id),
      (err) => err.code === 'runner_transition_invalid'
    );

    assert.throws(
      () => runnerTransition.applyNeedInput(runner.id),
      (err) => err.code === 'runner_transition_invalid'
    );
  });

  it('run from held transitions held -> dispatching', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    applyUnknown(runner.id);
    applyReceipt(runner.id);
    runnerTransition.applyHold(runner.id);
    const result = runnerTransition.applyRun(runner.id);
    assert.equal(result.canonicalState, 'dispatching');
  });

  it('run from complete transitions complete -> dispatching', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    runnerTransition.applyComplete(runner.id);
    const result = runnerTransition.applyRun(runner.id);
    assert.equal(result.canonicalState, 'dispatching');
  });

  it('adding work after complete atomically returns the persisted runtime to paused', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    await mission.setupRunnerQueue(runner.id);
    runnerTransition.applyRun(runner.id);
    runnerTransition.applyComplete(runner.id);
    const detail = await mission.readRunnerQueue(runner.id);
    const updated = await mission.addRunnerQueueItems(runner.id, ['new-work.md'], detail.queue.revision);
    assert.equal(updated.queue.execution.state, 'paused');
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
    assert.equal(runnerTransition.getRuntime(runner.id).operation_id, null);
  });

  it('run from projection_error is NOT allowed (only pause, close, projection_mismatch, projection_regenerated allowed)', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyProjectionMismatch(runner.id);
    assert.throws(
      () => runnerTransition.applyRun(runner.id),
      (err) => err.code === 'runner_transition_invalid' && err.message.includes('projection_error')
    );
  });
});

describe('plan 113 runner state machine — integration with queue', () => {
  it('queue read reflects canonical state after mutations', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });
    await mission.setupRunnerQueue(runner.id);

    // Initial state - empty queue is 'done' (no work to do)
    let queue = await mission.readRunnerQueue(runner.id);
    assert.equal(queue.queue.state, 'done');

    // Add items
    queue = await mission.addRunnerQueueItems(runner.id, ['a.md', 'b.md'], queue.queue.revision);
    assert.equal(queue.queue.state, 'new');
    assert.equal(queue.queue.items.length, 2);

    // Update first to in_progress using item update (status uses underscores)
    const itemA = queue.queue.items[0];
    queue = await mission.updateRunnerQueueItem(runner.id, itemA.id, { status: 'in_progress', reason: '' }, queue.queue.revision);
    assert.equal(queue.queue.state, 'in progress');

    // Update to need_input
    queue = await mission.updateRunnerQueueItem(runner.id, queue.queue.items[1].id, { status: 'need_input', reason: 'Need decision' }, queue.queue.revision);
    assert.equal(queue.queue.state, 'need input');
    assert.equal(queue.queue.summary.blocked.reason, 'Need decision');

    // Note: resolveRunnerQueue requires a live session to send the answer.
    // This test focuses on queue state transitions; resolve is tested separately.
  });
});

describe('plan 113 runner state machine — mutation controls', () => {
  it('execution authorization writes and marker writes have one service owner', () => {
    const services = path.join(__dirname, '..', 'services');
    const files = fs.readdirSync(services).filter((file) => file.endsWith('.js') && !['runner-transition.js', 'db.js'].includes(file));
    const stateWrite = /UPDATE\s+infinite_runners\s+SET[\s\S]{0,260}\b(?:enabled|control_state|operation_status|operation_id|stop_cause)\s*=/i;
    const markerWrite = /setQueuePausedMarker\s*\(/;
    const publicationWrite = /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+runner_publications\b/i;
    for (const file of files) {
      const src = fs.readFileSync(path.join(services, file), 'utf8');
      assert.ok(!stateWrite.test(src), `${file} must not write runner authorization fields`);
      if (!['runner-publication.js', 'plans.js'].includes(file)) assert.ok(!markerWrite.test(src), `${file} must not write the queue marker`);
      if (!['runner-publication.js', 'runner-queue.js'].includes(file)) {
        assert.ok(!publicationWrite.test(src), `${file} must not write publication state outside its owner`);
      }
    }
  });

  it('markerRequired matches canonical states', () => {
    const { markerRequired, STATES } = require('../services/runner-state');
    const expectedMarker = {
      paused: true,
      dispatching: false,
      awaiting_receipt: false,
      running: false,
      waiting_input: true,
      held: true,
      complete: true,
      projection_error: true,
    };
    for (const state of STATES) {
      assert.equal(markerRequired(state), expectedMarker[state], `markerRequired for ${state}`);
    }
  });

  it('allowedActions includes only legal edges from each state', () => {
    const { allowedActions, EVENTS } = require('../services/runner-state');
    for (const state of ['paused', 'dispatching', 'awaiting_receipt', 'running', 'waiting_input', 'held', 'complete', 'projection_error']) {
      const actions = allowedActions(state);
      assert.ok(actions.length > 0, `${state} should have allowed actions`);
      for (const action of actions) {
        assert.ok(EVENTS[action].includes(state), `${action} should allow ${state}`);
      }
    }
  });
});
