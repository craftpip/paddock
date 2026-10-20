const { after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
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

function resetDb() {
  const db = getDb();
  // Disable FK checks temporarily to allow clean slate
  db.pragma('foreign_keys = OFF');
  db.exec('DELETE FROM runner_transitions; DELETE FROM runner_queue_events; DELETE FROM runner_queue_items; DELETE FROM runner_queues; DELETE FROM infinite_runners; DELETE FROM mission_sessions; DELETE FROM mission_projects; DELETE FROM agents;');
  db.pragma('foreign_keys = ON');
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
    assert.deepEqual(withCanonical.allowedActions.sort(), ['pause', 'close', 'run', 'projection_mismatch'].sort());
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
    const result = runnerTransition.applyDeliveryUnknown(runner.id);
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
    runnerTransition.applyDeliveryUnknown(runner.id);
    const result = runnerTransition.applyReceipt(runner.id);
    assert.equal(result.canonicalState, 'running');
    assert.equal(result.markerRequired, false);
    assert.deepEqual(result.allowedActions.sort(), ['hold', 'pause', 'close', 'need_input', 'complete', 'projection_mismatch'].sort());
  });

  it('hold transitions awaiting_receipt/running -> held', async () => {
    resetDb();
    const project = seedProject();
    const session = mission.createSession(project.id, { agentSessionId: 'ses_seq' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner.id);
    runnerTransition.applyDeliveryUnknown(runner.id);
    let result = runnerTransition.applyHold(runner.id);
    assert.equal(result.canonicalState, 'held');
    assert.equal(result.markerRequired, true);

    // from running
    resetDb();
    const project2 = seedProject();
    const session2 = mission.createSession(project2.id, { agentSessionId: 'ses_seq' });
    const runner2 = await mission.createRunner({ projectId: project2.id, sessionId: session2.id, name: 'seq-runner-' + crypto.randomBytes(4).toString('hex') });

    runnerTransition.applyRun(runner2.id);
    runnerTransition.applyDeliveryUnknown(runner2.id);
    runnerTransition.applyReceipt(runner2.id);
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
    runnerTransition.applyDeliveryUnknown(runner.id);
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
    runnerTransition.applyDeliveryUnknown(runner.id);
    runnerTransition.applyReceipt(runner.id);
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
    runnerTransition.applyDeliveryUnknown(runner.id);
    runnerTransition.applyReceipt(runner.id);
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
    runnerTransition.applyDeliveryUnknown(runner.id);
    runnerTransition.applyReceipt(runner.id);
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
      if (from === 'awaiting_receipt') runnerTransition.applyDeliveryUnknown(runner.id);
      else if (from === 'running') {
        runnerTransition.applyDeliveryUnknown(runner.id);
        runnerTransition.applyReceipt(runner.id);
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
    runnerTransition.applyDeliveryUnknown(runner.id);
    runnerTransition.applyReceipt(runner.id);
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
      if (from === 'awaiting_receipt') runnerTransition.applyDeliveryUnknown(runner.id);
      else if (from === 'running') {
        runnerTransition.applyDeliveryUnknown(runner.id);
        runnerTransition.applyReceipt(runner.id);
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
    runnerTransition.applyDeliveryUnknown(runner.id);
    runnerTransition.applyReceipt(runner.id);
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
      () => runnerTransition.applyReceipt(runner.id),
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
    runnerTransition.applyDeliveryUnknown(runner.id);
    runnerTransition.applyReceipt(runner.id);
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