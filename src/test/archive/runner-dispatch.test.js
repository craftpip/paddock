const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-dispatch-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'test.db');
const PAD = 'pad-dispatch';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');
const { getDb } = require('../services/db');
const mission = require('../services/mission');
const plans = require('../services/plans');
const registry = require('../services/agent-registry');
const tmux = require('../services/pad-tmux');
const store = require('../services/agent-store');
let project, runner, turn, sent, original, reads, createCount;
const old = new Date(Date.now() - 3600000).toISOString();
function queue(status = 'in progress') {
  const file = plans.queuePath(registry.getAgent(PAD), project);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${plans.QUEUE_MARKERS.start}\n\`\`\`json\n${JSON.stringify({ version: 1, items: [{ id: 'a', plan: 'a.md', status, reason: '' }, { id: 'b', plan: 'b.md', status: 'new', reason: '' }] })}\n\`\`\`\n${plans.QUEUE_MARKERS.end}`);
}
function patch(values) {
  getDb().prepare(`UPDATE infinite_runners SET ${Object.keys(values).map((k) => `${k} = ?`).join(',')} WHERE id = ?`).run(...Object.values(values), runner.id);
}
function idle() { turn = { state: 'idle', userId: 'u0', inputHash: 'old-input', progressAt: old, completedAt: old }; }
beforeEach(async () => {
  getDb().exec('DELETE FROM infinite_runners; DELETE FROM activity_events; DELETE FROM mission_sessions; DELETE FROM mission_projects;');
  getDb().prepare("INSERT OR REPLACE INTO agents (id,name,agent_type,runtime_type,runtime_ref,status) VALUES (?,?,'opencode','docker',?,'running')").run(PAD, PAD, PAD);
  project = mission.createProject({ name: 'dispatch', agent: PAD, folder: '/root/.opencode/workspace' });
  const session = mission.createSession(project.id, { agentSessionId: 'conversation' });
  runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'controlled' });
  queue();
  patch({ enabled: 1, control_state: 'enabled', idle_grace_ms: 1000, min_nudge_interval_ms: 1000, last_dispatch_at: old, last_progress_at: old });
  plans.setQueuePausedMarker(registry.getAgent(PAD), project, false);
  idle(); sent = []; reads = 0; createCount = 0;
  original = { ...Object.fromEntries(['hasSession', 'paneState', 'captureScreen', 'sendText', 'folderExists', 'createSession', 'sendCommand', 'killSession'].map((key) => [key, tmux[key]])), readTurn: store.readTurn, readActivity: store.readActivity };
  tmux.hasSession = async () => true;
  tmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', cwd: project.folder });
  tmux.captureScreen = async () => ({ live: true, text: `screen ${reads++}` });
  tmux.folderExists = async () => true;
  tmux.createSession = async () => { createCount++; };
  tmux.sendCommand = async () => {};
  tmux.killSession = async () => {};
  store.readActivity = () => ({ store: { available: false }, lastActivityAt: null });
  store.readTurn = () => turn;
  tmux.sendText = async (_pad, _tmux, text) => {
    sent.push(text);
    turn = { state: 'working', userId: `u${sent.length}`, inputHash: crypto.createHash('sha256').update(text).digest('hex'), progressAt: new Date().toISOString() };
    return { lines: 1 };
  };
});
afterEach(() => { for (const key of Object.keys(original)) { if (key === 'readTurn' || key === 'readActivity') store[key] = original[key]; else tmux[key] = original[key]; } });
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('runner dispatch lifecycle — real watcher and writer', () => {
  it('thinking, streaming and between-tool work with queue revisions sends zero prompts; positive idle twin sends once', async () => {
    turn = { ...turn, state: 'working' };
    for (let i = 0; i < 4; i++) { queue(i % 2 ? 'new' : 'in progress'); await mission.runnerWatchOnce(runner.id); }
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_turn_end');
    idle(); await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 1, 'identical fixture reaches the send path when idle');
    assert.match(sent[0], /resume the 'in progress' item/);
  });
  it('unreadable/unsupported observations never dispatch, even on revision change', async () => {
    turn = { state: 'unknown', reason: 'Unreadable', userId: null };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).scheduler_decision, 'observation_unavailable');
  });
  it('accepted instruction remains outstanding throughout tools and reasoning; a matching stop releases it', async () => {
    await mission.runnerWatchOnce(runner.id);
    const op = mission.getRunner(runner.id).operation_id;
    for (let i = 0; i < 4; i++) { queue(i % 2 ? 'new' : 'in progress'); await mission.runnerWatchOnce(runner.id); }
    assert.equal(sent.length, 1);
    assert.equal(mission.getRunner(runner.id).operation_id, op);
    assert.equal(mission.getRunner(runner.id).operation_status, 'confirmed');
    turn = { ...turn, state: 'idle', completedAt: old };
    patch({ last_nudge_at: old });
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 2, 'verified completed turn continues pending work once');
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 2);
  });
  it('pending/unconfirmed/confirmed operations with no exact receipt cannot be replaced, including after restart observation', async () => {
    for (const status of ['pending', 'unconfirmed', 'confirmed']) {
      patch({ operation_status: status, operation_generation: 4, operation_id: 'existing', operation_session_id: 'conversation', operation_prompt_hash: 'not-this-input' });
      await mission.runnerWatchOnce(runner.id);
      assert.equal(sent.length, 0);
      assert.equal(mission.getRunner(runner.id).operation_id, 'existing');
      assert.equal(mission.getRunner(runner.id).operation_generation, 4);
    }
  });
  it('concurrent ticks acquire a single operation and send exactly one message', async () => {
    await Promise.all([mission.runnerWatchOnce(runner.id), mission.runnerWatchOnce(runner.id), mission.runnerWatchOnce(runner.id)]);
    assert.equal(sent.length, 1);
    assert.equal(mission.getRunner(runner.id).operation_generation, 1);
  });
  it('a recent dispatch suppresses ALL revision-change sends', async () => {
    patch({ last_nudge_at: new Date().toISOString() });
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_nudge_interval');
  });
  it('idle grace starts at the completed turn, not from old progress while reasoning', async () => {
    turn = { ...turn, state: 'working' };
    await mission.runnerWatchOnce(runner.id);
    turn = { ...turn, state: 'idle', completedAt: new Date().toISOString() };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_idle_grace');
  });
  it('repeated observations do not replenish retry budget or advance the progress clock', async () => {
    patch({ retry_count: 2 }); turn = { ...turn, state: 'working' };
    await mission.runnerWatchOnce(runner.id); await mission.runnerWatchOnce(runner.id);
    assert.equal(mission.getRunner(runner.id).retry_count, 2);
    assert.equal(mission.getRunner(runner.id).last_progress_at, old);
    turn = { ...turn, progressAt: new Date().toISOString() };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(mission.getRunner(runner.id).retry_count, 0);
  });
  it('a human turn landing during asynchronous send preflight withholds the nudge', async () => {
    tmux.hasSession = async () => { turn = { ...turn, userId: 'human', state: 'working' }; return true; };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).operation_status, 'ended');
  });
  it('Pause during preflight wins and no late result can re-enable/confirm it', async () => {
    tmux.hasSession = async () => { await mission.pauseRunner(runner.id); return true; };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).operation_status, 'invalidated');
    assert.equal(mission.getRunner(runner.id).enabled, 0);
  });
  it('Pause during a slow accepted send preserves invalidation', async () => {
    const send = tmux.sendText;
    tmux.sendText = async (...args) => { const result = await send(...args); await mission.pauseRunner(runner.id); return result; };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 1);
    assert.equal(mission.getRunner(runner.id).operation_status, 'invalidated');
    assert.equal(mission.getRunner(runner.id).enabled, 0);
  });
  it('a changed queue at the final write boundary cancels the reserved send', async () => {
    tmux.hasSession = async () => { queue('done'); return true; };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
  });
  it('an interrupted/error turn exposes explicit recovery, never auto-nudges, and replaces its completed outstanding operation once', async () => {
    patch({ operation_status: 'confirmed', operation_id: 'interrupted-op', operation_generation: 4, operation_session_id: 'conversation', operation_prompt_hash: 'old-input' });
    turn = { ...turn, outcome: 'error', reason: 'Interrupted' };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    const detail = await mission.readRunnerQueue(runner.id);
    assert.equal(detail.queue.scheduler.recoveryRequired, true);
    assert.equal(detail.queue.scheduler.schedulerDecision, 'observation_unavailable');

    const result = await mission.startRunner(runner.id);
    assert.equal(result.started, true);
    assert.equal(sent.length, 1);
    assert.equal(mission.getRunner(runner.id).operation_status, 'confirmed');
  });
  it('concurrent Run requests send one startup and preserve missing-index repair', async () => {
    patch({ enabled: 0, control_state: 'paused' });
    fs.rmSync(path.join(path.dirname(plans.queuePath(registry.getAgent(PAD), project)), 'INDEX.md'), { force: true });
    const results = await Promise.allSettled([mission.startRunner(runner.id), mission.startRunner(runner.id)]);
    assert.equal(sent.length, 1);
    assert.ok(results.some((r) => r.status === 'fulfilled' && r.value.started));
    assert.ok(fs.existsSync(path.join(path.dirname(plans.queuePath(registry.getAgent(PAD), project)), 'INDEX.md')));
    assert.equal(mission.getRunner(runner.id).enabled, 1);
  });
  it('recovery with unknown/active external work never restarts or sends', async () => {
    tmux.paneState = async () => ({ live: false, tuiAlive: false });
    turn = { ...turn, state: 'working' };
    await mission.runnerWatchOnce(runner.id);
    turn = { state: 'unknown' };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(createCount, 0); assert.equal(sent.length, 0);
  });
  it('an identical older input cannot reconcile a new pending operation', async () => {
    patch({ operation_status: 'pending', operation_id: 'old', operation_session_id: 'conversation', operation_prompt_hash: turn.inputHash, operation_baseline_user_id: turn.userId });
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).operation_status, 'pending');
  });
  it('an unconfirmed write reconciles only its matching input and never gets resent mid-turn', async () => {
    const send = tmux.sendText;
    tmux.sendText = async (...args) => {
      await send(...args);
      throw Object.assign(new Error('Unconfirmed receipt'), { code: 'mission_send_unconfirmed', acceptance: 'unknown', attempted: true });
    };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(mission.getRunner(runner.id).operation_status, 'unconfirmed');
    await mission.runnerWatchOnce(runner.id);
    assert.equal(mission.getRunner(runner.id).operation_status, 'confirmed');
    assert.equal(sent.length, 1);
    assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_turn_end');
  });
  it('known-idle recovery uses the same row/conversation once, with the active-work negative as its twin', async () => {
    const sid = runner.session_id;
    tmux.paneState = async () => ({ live: createCount > 0, tuiAlive: createCount > 0, command: 'opencode', cwd: project.folder });
    await mission.runnerWatchOnce(runner.id);
    await mission.runnerWatchOnce(runner.id);
    assert.equal(createCount, 1);
    assert.equal(sent.length, 1);
    assert.equal(mission.getRunner(runner.id).session_id, sid);
    assert.equal(mission.getSession(sid).agent_session_id, 'conversation');
  });
  it('Close during preflight invalidates the lease and sends nothing', async () => {
    tmux.hasSession = async () => { mission.disableRunnerForSession(runner.session_id); return true; };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).enabled, 0);
    assert.equal(mission.getRunner(runner.id).operation_status, 'invalidated');
  });
  it('solo lock and permission dialog prevent dispatch', async () => {
    getDb().prepare('UPDATE mission_sessions SET locked = 1 WHERE id = ?').run(runner.session_id);
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    getDb().prepare('UPDATE mission_sessions SET locked = 0 WHERE id = ?').run(runner.session_id);
    tmux.captureScreen = async () => ({ live: true, text: 'Permission required\nAllow once\nAllow always\nReject' });
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).control_state, 'need_input');
  });
  it('an unreadable index setup reports its repair action and emits zero prompts', async () => {
    patch({ enabled: 0, control_state: 'paused' });
    const originalIndex = plans.initProjectPlans;
    plans.initProjectPlans = async () => { throw new Error('Read-only filesystem'); };
    try {
      await assert.rejects(mission.startRunner(runner.id), (e) => e.code === 'runner_index_unavailable' && /Repair/.test(e.message));
      assert.equal(sent.length, 0);
    } finally { plans.initProjectPlans = originalIndex; }
  });
  it('queue reads expose fresh worker state and a stable server deadline for the countdown', async () => {
    turn = { ...turn, completedAt: new Date().toISOString() };
    await mission.runnerWatchOnce(runner.id);
    const first = await mission.readRunnerQueue(runner.id);
    const second = await mission.readRunnerQueue(runner.id);
    assert.equal(first.queue.scheduler.schedulerDecision, 'wait_idle_grace');
    assert.equal(first.queue.scheduler.deadline, second.queue.scheduler.deadline);
    assert.equal(Date.parse(first.queue.scheduler.deadline), Date.parse(turn.completedAt) + 1000);
    turn = { ...turn, state: 'working' };
    const active = await mission.readRunnerQueue(runner.id);
    assert.equal(active.queue.scheduler.workerState, 'working');
    assert.equal(active.queue.scheduler.deadline, null);
  });
});
