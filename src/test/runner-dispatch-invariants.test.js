const { after, afterEach, beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-dispatch-invariants-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'dispatch.db');
const PAD = 'pad-dispatch-invariants';
const FOLDER = '/root/.opencode/workspace';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const runnerTransition = require('../services/runner-transition');
const runnerQueue = require('../services/runner-queue');
const runnerPublication = require('../services/runner-publication');
const plans = require('../services/plans');
const registry = require('../services/agent-registry');
const tmux = require('../services/pad-tmux');
const store = require('../services/agent-store');

let saved;
let project;
let session;
let runner;
let turn;
let sends;
let screenCalls;

after(() => fs.rmSync(root, { recursive: true, force: true }));

afterEach(() => {
  if (!saved) return;
  tmux.hasSession = saved.hasSession;
  tmux.paneState = saved.paneState;
  tmux.captureScreen = saved.captureScreen;
  tmux.sendText = saved.sendText;
  tmux.killSession = saved.killSession;
  store.readTurn = saved.readTurn;
  store.readActivity = saved.readActivity;
  saved = null;
});

beforeEach(async () => {
  getDb().exec(`
    DELETE FROM runner_quota_recoveries;
    DELETE FROM runner_operations;
    DELETE FROM runner_transitions;
    DELETE FROM runner_publications;
    DELETE FROM runner_publication_leases;
    DELETE FROM runner_projection_owners;
    DELETE FROM runner_runtime;
    DELETE FROM runner_queue_events;
    DELETE FROM runner_queue_items;
    DELETE FROM runner_queues;
    DELETE FROM runner_history;
    DELETE FROM runner_queue_observations;
    DELETE FROM infinite_runners;
    DELETE FROM mission_sessions;
    DELETE FROM mission_projects;
    DELETE FROM activity_events;
    DELETE FROM agents;
  `);
  getDb().prepare("INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')")
    .run(PAD, PAD, PAD);
  fs.rmSync(path.join(root, 'instances', PAD, 'opencode', 'workspace'), { recursive: true, force: true });

  saved = {
    hasSession: tmux.hasSession,
    paneState: tmux.paneState,
    captureScreen: tmux.captureScreen,
    sendText: tmux.sendText,
    killSession: tmux.killSession,
    readTurn: store.readTurn,
    readActivity: store.readActivity,
  };
  turn = { state: 'idle', userId: 'baseline', inputHash: 'baseline', completedAt: new Date(Date.now() - 60000).toISOString(), progressAt: new Date(Date.now() - 60000).toISOString() };
  sends = [];
  screenCalls = 0;
  tmux.hasSession = async () => true;
  tmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', cwd: FOLDER });
  tmux.captureScreen = async () => ({ live: true, text: `screen ${screenCalls++}` });
  store.readActivity = () => ({ store: { available: false }, lastActivityAt: null });
  store.readTurn = () => turn;
  tmux.sendText = async (_pad, _tmux, text) => {
    sends.push(text);
    turn = {
      state: 'working', userId: `input-${sends.length}`,
      inputHash: require('node:crypto').createHash('sha256').update(text.trimEnd()).digest('hex'),
      progressAt: new Date().toISOString(),
    };
    return { lines: 1 };
  };

  project = mission.createProject({ name: 'dispatch-invariants', agent: PAD, folder: FOLDER, plansFolder: 'plans' });
  session = mission.createSession(project.id, { agentSessionId: 'ses_dispatch_invariants' });
  runner = await mission.createRunner({ projectId: project.id, name: 'dispatch-invariants', sessionId: session.id });
  await mission.updateRunner(runner.id, { idleGraceMs: 0, minNudgeIntervalMs: 0 });
  const detail = await mission.addRunnerQueueItems(runner.id, ['first.md', 'second.md'], 0);
  await mission.updateRunnerQueueItem(runner.id, detail.queue.items[0].id, { status: 'in_progress' }, detail.queue.revision, { actor: 'review', source: 'review' });
  const started = await mission.startRunner(runner.id);
  assert.equal(started.started, true);
  assert.equal(sends.length, 1, 'the positive control establishes one confirmed startup instruction');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'running');
});

it('active work suppresses every revision-driven send, with an identical idle positive control', async () => {
  turn = { ...turn, state: 'working' };
  let detail = await mission.readRunnerQueue(runner.id);
  detail = await mission.updateRunnerQueueItem(runner.id, detail.queue.items[0].id, { status: 'done' }, detail.queue.revision, { actor: 'worker', source: 'worker' });
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1);
  assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_turn_end');

  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 2, 'the same changed queue dispatches after its owned turn completes');
});

it('unknown worker observations withhold dispatch even when the canonical queue changes', async () => {
  turn = { state: 'unknown', reason: 'Conversation store unreadable', userId: null };
  const detail = await mission.readRunnerQueue(runner.id);
  await mission.updateRunnerQueueItem(runner.id, detail.queue.items[0].id, { status: 'done' }, detail.queue.revision, { actor: 'worker', source: 'worker' });
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1);
  assert.equal(mission.getRunner(runner.id).scheduler_decision, 'observation_unavailable');
});

it('a recent confirmed dispatch suppresses queue-revision nudges until its interval elapses', async () => {
  await mission.updateRunner(runner.id, { minNudgeIntervalMs: 60000 });
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  const detail = await mission.readRunnerQueue(runner.id);
  await mission.updateRunnerQueueItem(runner.id, detail.queue.items[0].id, { status: 'done' }, detail.queue.revision, { actor: 'worker', source: 'worker' });
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1);
  assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_nudge_interval');
});

it('concurrent watcher ticks acquire one next-item operation and send once', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  await Promise.all([
    mission.runnerWatchOnce(runner.id),
    mission.runnerWatchOnce(runner.id),
    mission.runnerWatchOnce(runner.id),
  ]);
  assert.equal(sends.length, 2, 'one startup and one next-item instruction');
  const operations = getDb().prepare('SELECT operation_kind, status FROM runner_operations WHERE runner_id = ? ORDER BY generation').all(runner.id);
  assert.equal(operations.length, 2);
  assert.deepEqual(operations.map((row) => row.status), ['completed', 'running']);
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'running');
});

it('an interrupted idle turn exposes the explicit recovery Run verdict, not an active Pause control', async () => {
  turn = { ...turn, state: 'idle', outcome: 'error', reason: 'worker turn interrupted', completedAt: new Date().toISOString() };
  const detail = await mission.readRunnerQueue(runner.id);
  assert.equal(detail.queue.scheduler.recoveryRequired, true);
  assert.equal(detail.queue.execution.state, 'running');
  assert.equal(detail.queue.execution.active, true, 'canonical runtime remains running until explicit recovery');
  assert.equal(detail.queue.execution.canRun, true, 'Run is the explicit recovery action');
  assert.equal(detail.queue.execution.canPause, false, 'verified idle recovery is not presented as active work to pause');
});

it('a fresh process observes an unconfirmed operation without replaying its instruction', async () => {
  runnerTransition.applyPause(runner.id, { actor: 'test' });
  runnerPublication.publishMarker(mission.getRunner(runner.id), project, registry.getAgent(PAD));
  const item = runnerQueue.snapshot(runner.id).items[0];
  runnerTransition.applyRun(runner.id, { details: { itemId: item.id, conversationId: session.agent_session_id } });
  runnerPublication.publishMarker(mission.getRunner(runner.id), project, registry.getAgent(PAD));
  const dispatching = runnerTransition.getRuntime(runner.id);
  runnerTransition.applyDeliveryUnknown(runner.id, { details: { operationId: dispatching.operation_id, reason: 'receipt not observed' } });
  runnerPublication.publishMarker(mission.getRunner(runner.id), project, registry.getAgent(PAD));
  const operationId = runnerTransition.getRuntime(runner.id).operation_id;

  const missionPath = path.resolve(__dirname, '../services/mission');
  const script = `const mission=require(${JSON.stringify(missionPath)}); mission.reconcileRunners().then(()=>{const transition=require(${JSON.stringify(path.resolve(__dirname, '../services/runner-transition'))});const runtime=transition.getRuntime(${JSON.stringify(runner.id)});console.log(JSON.stringify({state:runtime.state,operationId:runtime.operation_id,operationStatus:require(${JSON.stringify(path.resolve(__dirname, '../services/db'))}).getDb().prepare('SELECT status FROM runner_operations WHERE id = ?').get(runtime.operation_id)?.status}))}).catch(e=>{console.error(e);process.exitCode=1})`;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, WORKSPACE_ROOT: root, PAD_DB_PATH: path.join(root, 'dispatch.db') },
  });
  const result = JSON.parse(output.trim().split('\n').at(-1));
  assert.deepEqual(result, { state: 'awaiting_receipt', operationId, operationStatus: 'awaiting_receipt' });
  assert.equal(sends.length, 1, 'boot reconciliation does not retry the unknown instruction');
});

it('Pause during async preflight wins before the write boundary', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  const capture = tmux.captureScreen;
  const callsBeforeWatch = screenCalls;
  tmux.captureScreen = async (...args) => {
    const result = await capture(...args);
    if (screenCalls === callsBeforeWatch + 2) await mission.pauseRunner(runner.id, { mode: 'before_next_task', actor: 'test' });
    return result;
  };
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1, 'no next-item instruction crosses the boundary after Pause');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
  assert.equal(runnerTransition.getRuntime(runner.id).operation_id, null);
});

it('a solo lock during async preflight revokes the reserved instruction', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  const capture = tmux.captureScreen;
  const callsBeforeWatch = screenCalls;
  tmux.captureScreen = async (...args) => {
    const result = await capture(...args);
    if (screenCalls === callsBeforeWatch + 2) mission.updateSession(session.id, { locked: true });
    return result;
  };
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1, 'the reserved dispatch does not reach the locked pane');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
  assert.equal(mission.getSession(session.id).locked, 1);
});

it('a session rebind during async preflight cannot deliver the old operation to the new binding', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  const replacement = mission.createSession(project.id, { agentSessionId: 'ses_dispatch_rebound' });
  const capture = tmux.captureScreen;
  const callsBeforeWatch = screenCalls;
  tmux.captureScreen = async (...args) => {
    const result = await capture(...args);
    if (screenCalls === callsBeforeWatch + 2) {
      await mission.pauseRunner(runner.id, { mode: 'before_next_task', actor: 'test' });
      // No public API rebinds a live operation. Simulate the persisted binding
      // change that a future binding path must serialize against this lease.
      getDb().prepare('UPDATE infinite_runners SET session_id = ?, updated_at = ? WHERE id = ?')
        .run(replacement.id, new Date().toISOString(), runner.id);
    }
    return result;
  };
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1, 'the old operation never writes into the replacement session');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
  assert.equal(runnerTransition.getRuntime(runner.id).operation_id, null);
  assert.equal(mission.getRunner(runner.id).session_id, replacement.id);
});

it('a human turn arriving during async preflight withholds the nudge', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  const capture = tmux.captureScreen;
  const callsBeforeWatch = screenCalls;
  tmux.captureScreen = async (...args) => {
    const result = await capture(...args);
    if (screenCalls === callsBeforeWatch + 2) turn = { ...turn, state: 'working', userId: 'human-turn' };
    return result;
  };
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1, "the worker's fresh turn wins at the write boundary");
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
});

it('Close during async preflight invalidates the lease before the write boundary', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  const capture = tmux.captureScreen;
  const callsBeforeWatch = screenCalls;
  tmux.killSession = async () => {};
  tmux.captureScreen = async (...args) => {
    const result = await capture(...args);
    if (screenCalls === callsBeforeWatch + 2) await mission.closeSession(session.id, { actor: 'test' });
    return result;
  };
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1, 'a closed conversation receives no next-item instruction');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
  assert.equal(runnerTransition.getRuntime(runner.id).operation_id, null);
  assert.throws(() => mission.getSession(session.id), { code: 'mission_session_not_found' }, 'Close removes the session row after revoking execution');
});

it('a canonical queue revision change during async preflight cancels the reserved send', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  const capture = tmux.captureScreen;
  const callsBeforeWatch = screenCalls;
  tmux.captureScreen = async (...args) => {
    const result = await capture(...args);
    if (screenCalls === callsBeforeWatch + 2) {
      const current = runnerQueue.snapshot(runner.id);
      // Simulate a competing canonical transaction between reservation and
      // delivery; the real HTTP/MCP paths separately gate human/worker rights.
      runnerQueue.updateItem(runner.id, current.items[0].id, { status: 'done' }, current.revision, { actor: 'race', source: 'user' });
    }
    return result;
  };
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1, 'the queue revision is rechecked at the actual write boundary');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused', 'the refused operation cannot remain authorized');
  assert.deepEqual((await mission.readRunnerQueue(runner.id)).queue.items.map((item) => item.status), ['done', 'new']);
});

it('unreadable project INDEX preparation withholds the prompt and exposes a repair reason', async () => {
  const originalInit = plans.initProjectPlans;
  plans.initProjectPlans = async () => { throw new Error('injected index write failure'); };
  try {
    turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sends.length, 1);
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'running');
    assert.match(runnerTransition.getRuntime(runner.id).reason, /INDEX\.md|Plan rules INDEX/i);
  } finally {
    plans.initProjectPlans = originalInit;
  }
});
