// Plan 97, ported to the plan-113 canonical queue (plan 115). The two original
// files seeded "enabled" through legacy columns and a hand-written QUEUE.md, and
// one called the real sendText against a pad that never existed — neither could
// pass after plan 113. The claims are unchanged:
//   1. canDispatch refuses while the worker's turn is running (idle twin allows).
//   2. The resolution race: an answer typed into a paused runner's worker starts a
//      turn; Run must then refuse and send NOTHING (idle twin starts and sends one).
const { after, afterEach, beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plan97-busy-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'plan97.db');
const PAD = 'pad-plan97-busy';
const FOLDER = '/root/.opencode/workspace';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const runnerTransition = require('../services/runner-transition');
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

const idle = () => ({ state: 'idle', userId: 'baseline', inputHash: 'baseline', completedAt: new Date(Date.now() - 60000).toISOString(), progressAt: new Date(Date.now() - 60000).toISOString() });
const busy = () => ({ state: 'working', userId: 'human-answer', inputHash: 'human-answer', progressAt: new Date().toISOString() });

after(() => fs.rmSync(root, { recursive: true, force: true }));

afterEach(() => {
  if (!saved) return;
  Object.assign(tmux, saved.tmux);
  Object.assign(store, saved.store);
  saved = null;
});

beforeEach(async () => {
  getDb().exec(`
    DELETE FROM runner_quota_recoveries; DELETE FROM runner_operations; DELETE FROM runner_transitions;
    DELETE FROM runner_publications; DELETE FROM runner_publication_leases; DELETE FROM runner_projection_owners;
    DELETE FROM runner_runtime; DELETE FROM runner_queue_events; DELETE FROM runner_queue_items; DELETE FROM runner_queues;
    DELETE FROM runner_history; DELETE FROM runner_queue_observations; DELETE FROM infinite_runners;
    DELETE FROM mission_sessions; DELETE FROM mission_projects; DELETE FROM activity_events; DELETE FROM agents;
  `);
  getDb().prepare("INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')")
    .run(PAD, PAD, PAD);
  fs.rmSync(path.join(root, 'instances', PAD, 'opencode', 'workspace'), { recursive: true, force: true });

  saved = {
    tmux: { hasSession: tmux.hasSession, paneState: tmux.paneState, captureScreen: tmux.captureScreen, sendText: tmux.sendText, killSession: tmux.killSession },
    store: { readTurn: store.readTurn, readActivity: store.readActivity },
  };
  turn = idle();
  sends = [];
  screenCalls = 0;
  tmux.hasSession = async () => true;
  tmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', cwd: FOLDER });
  tmux.captureScreen = async () => ({ live: true, text: `screen ${screenCalls++} ctrl+p commands` });
  store.readActivity = () => ({ store: { available: false }, lastActivityAt: null });
  store.readTurn = () => turn;
  tmux.sendText = async (_pad, _tmux, text) => {
    sends.push(text);
    turn = { state: 'working', userId: `input-${sends.length}`, inputHash: require('node:crypto').createHash('sha256').update(text.trimEnd()).digest('hex'), progressAt: new Date().toISOString() };
    return { lines: 1 };
  };

  project = mission.createProject({ name: 'plan97', agent: PAD, folder: FOLDER, plansFolder: 'plans' });
  session = mission.createSession(project.id, { agentSessionId: 'ses_plan97' });
  runner = await mission.createRunner({ projectId: project.id, name: 'plan97', sessionId: session.id });
  await mission.updateRunner(runner.id, { idleGraceMs: 0, minNudgeIntervalMs: 0 });
  await mission.addRunnerQueueItems(runner.id, ['first.md', 'second.md'], 0);
});

async function startRunning() {
  const started = await mission.startRunner(runner.id);
  assert.equal(started.started, true);
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'running');
}

async function dispatchCheck() {
  const fresh = mission.getRunner(runner.id);
  return mission.canDispatch(runner.id, {
    session: mission.getSession(session.id), project, agent: registry.getAgent(PAD),
    queue: null, kind: 'continue', gen: fresh.run_generation,
  });
}

it('canDispatch refuses while the worker turn is running', async () => {
  await startRunning();
  turn = busy();
  const r = await dispatchCheck();
  assert.equal(r.allowed, false);
  assert.equal(r.turn.state, 'working', 'refused because of the BUSY turn, not some other gate');
});

it('positive twin: the same runner with an idle worker is allowed to dispatch', async () => {
  await startRunning();
  turn = { ...idle(), userId: `input-${sends.length}` };
  const r = await dispatchCheck();
  assert.equal(r.allowed, true, r.reason);
});

it('resolution race: Run on a paused runner whose worker just took an answer sends nothing', async () => {
  turn = busy();
  let refused = null;
  try {
    const r = await mission.startRunner(runner.id);
    refused = r.started === false ? r : null;
  } catch (e) { refused = e; }
  assert.ok(refused, 'Run must not start while the worker is mid-turn');
  assert.equal(sends.length, 0, 'no instruction may be typed over the live turn');
  assert.notEqual(runnerTransition.getRuntime(runner.id)?.state, 'running');
});

it('positive twin: Run with an idle worker starts and sends exactly one instruction', async () => {
  await startRunning();
  assert.equal(sends.length, 1);
});
