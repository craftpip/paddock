// Plan 114 §1: a delivered instruction whose exact receipt lands in the store a
// moment after sendText returns must be CONFIRMED, not reported unconfirmed.
const { after, afterEach, beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-receipt-poll-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'receipt.db');
const PAD = 'pad-receipt-poll';
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
let lagReads; // reads of the turn that still show the OLD input after a send

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
  lagReads = 0;
  let pending = null;
  store.readTurn = () => {
    if (pending && lagReads > 0) { lagReads--; return idle(); }
    if (pending) { turn = pending; pending = null; }
    return turn;
  };
  tmux.sendText = async (_pad, _tmux, text) => {
    sends.push(text);
    pending = { state: 'working', userId: `input-${sends.length}`, inputHash: require('node:crypto').createHash('sha256').update(text.trimEnd()).digest('hex'), progressAt: new Date().toISOString() };
    if (lagReads === Infinity) pending = null;
    return { lines: 1 };
  };

  project = mission.createProject({ name: 'receipt', agent: PAD, folder: FOLDER, plansFolder: 'plans' });
  session = mission.createSession(project.id, { agentSessionId: 'ses_receipt' });
  runner = await mission.createRunner({ projectId: project.id, name: 'receipt', sessionId: session.id });
  await mission.updateRunner(runner.id, { idleGraceMs: 0, minNudgeIntervalMs: 0 });
  await mission.addRunnerQueueItems(runner.id, ['first.md', 'second.md'], 0);
});


mission._setReceiptPollBudget(1500);

it('a receipt that lands on the third read after the write is confirmed, with one send', async () => {
  lagReads = 2;
  const started = await mission.startRunner(runner.id);
  assert.equal(started.started, true);
  assert.equal(runnerTransition.getRuntime(runner.id).state, 'running');
  assert.equal(sends.length, 1);
});

it('twin: a receipt that never lands stays unconfirmed and is never resent', async () => {
  lagReads = Infinity;
  let err = null;
  try { await mission.startRunner(runner.id); } catch (e) { err = e; }
  assert.equal(sends.length, 1, 'no resend');
  assert.notEqual(runnerTransition.getRuntime(runner.id).state, 'running');
  assert.ok(!err || /unconfirmed|receipt/i.test(err.code + err.message), String(err && err.message));
});
