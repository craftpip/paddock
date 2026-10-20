const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-prompts-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'test.db');
const PAD = 'pad-prompts-dispatch';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');
const { getDb } = require('../services/db');
const mission = require('../services/mission');
const plans = require('../services/plans');
const registry = require('../services/agent-registry');
const tmux = require('../services/pad-tmux');
const store = require('../services/agent-store');
let project, runner, turn, sent, original, reads;
const old = new Date(Date.now() - 3600000).toISOString();
// Container paths resolve from the project folder, so the expected renders
// below are exact strings, not substrings.
const QP = '/root/.opencode/workspace/plans/QUEUE.md';
const IP = '/root/.opencode/workspace/plans/INDEX.md';
const PP = '/root/.opencode/workspace/plans/QUEUE.paused';
const CUSTOM = {
  start: '[T-START] {{runner_name}} {{queue_path}}',
  resume: '[T-RESUME] {{runner_name}} {{current_plan}}',
  continue: '[T-CONTINUE] {{runner_name}} {{index_path}}',
  recovery: '[T-RECOVERY] {{runner_name}} {{paused_path}}',
  pause: '[T-PAUSE] {{runner_name}} {{current_plan}}',
};
function queue(status = 'in progress', queueFile = runner?.queue_file) {
  const file = plans.queuePath(registry.getAgent(PAD), project, queueFile);
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
  project = mission.createProject({ name: 'prompts', agent: PAD, folder: '/root/.opencode/workspace' });
  const session = mission.createSession(project.id, { agentSessionId: 'conversation' });
  runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'controlled', promptTemplates: CUSTOM });
  queue();
  patch({ enabled: 1, control_state: 'enabled', idle_grace_ms: 1000, min_nudge_interval_ms: 1000, last_dispatch_at: old, last_progress_at: old });
  plans.setQueuePausedMarker(registry.getAgent(PAD), project, false);
  idle(); sent = []; reads = 0;
  original = { ...Object.fromEntries(['hasSession', 'paneState', 'captureScreen', 'sendText', 'folderExists', 'createSession', 'sendCommand', 'killSession'].map((key) => [key, tmux[key]])), readTurn: store.readTurn, readActivity: store.readActivity };
  tmux.hasSession = async () => true;
  tmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', cwd: project.folder });
  tmux.captureScreen = async () => ({ live: true, text: `screen ${reads++}` });
  tmux.folderExists = async () => true;
  tmux.createSession = async () => {};
  tmux.sendCommand = async () => {};
  tmux.killSession = async () => {};
  store.readActivity = () => ({ store: { available: false }, lastActivityAt: null });
  store.readTurn = () => turn;
  tmux.sendText = async (_pad, _tmux, text) => {
    sent.push(text);
    turn = { state: 'working', userId: `u${sent.length}`, inputHash: require('crypto').createHash('sha256').update(text).digest('hex'), progressAt: new Date().toISOString() };
    return { lines: 1 };
  };
});
afterEach(() => { for (const key of Object.keys(original)) { if (key === 'readTurn' || key === 'readActivity') store[key] = original[key]; else tmux[key] = original[key]; } });
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe('plan 91 — every dispatch sends the exact rendered saved text', () => {
  it('continue sends the saved template rendered, with no hardcoded fragment', async () => {
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], `[T-CONTINUE] controlled ${IP}`);
  });
  it('start sends the saved start template exactly', async () => {
    patch({ enabled: 0, control_state: 'paused' });
    queue('new');
    const res = await mission.startRunner(runner.id);
    assert.equal(res.started, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], `[T-START] controlled ${QP}`);
  });
  it('dispatches from the runner-selected queue and names that path in the prompt', async () => {
    patch({ enabled: 0, control_state: 'paused', operation_status: 'ended' });
    await mission.updateRunner(runner.id, { queueFile: 'queues/release.md' });
    queue('new', 'queues/release.md');
    const res = await mission.startRunner(runner.id);
    assert.equal(res.started, true);
    assert.equal(sent[0], '[T-START] controlled /root/.opencode/workspace/plans/queues/release.md');
  });
  it('resume after a current-task pause sends the full resume template, not start+suffix', async () => {
    patch({ enabled: 0, control_state: 'paused', pause_mode: 'current_task', pause_state: 'requested', pause_target_item: 'a' });
    queue('in progress');
    const res = await mission.startRunner(runner.id);
    assert.equal(res.started, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], '[T-RESUME] controlled a.md');
  });
  it('pause sends the saved pause template naming the target plan, and keeps the pane', async () => {
    queue('in progress');
    const after = await mission.pauseRunner(runner.id, { mode: 'current_task' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0], '[T-PAUSE] controlled a.md');
    assert.match(after.last_reason, /Pausing current task/);
  });
  it('recovery sends the saved recovery template', async () => {
    // The pane is dead until restartSession recreates it: paneState follows
    // createSession, exactly like a real restart. A permanently-dead stub
    // would fail the send's own liveness gate after a good restart.
    let paneAlive = false;
    tmux.paneState = async () => (paneAlive
      ? { live: true, tuiAlive: true, command: 'opencode', cwd: project.folder }
      : { live: false, tuiAlive: false });
    tmux.createSession = async () => { paneAlive = true; };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], `[T-RECOVERY] controlled ${PP}`);
  });
  it('multiline custom source arrives as one logical submission', async () => {
    await mission.updateRunner(runner.id, { promptTemplates: { ...CUSTOM, continue: 'Line one\nLine two {{runner_name}}\n\nLine three.' } });
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0], 'Line one Line two controlled Line three.');
    assert.ok(!sent[0].includes('\n'), 'no raw line break reaches the line-by-line writer');
    assert.equal(mission.getRunner(runner.id).operation_status, 'confirmed');
  });
});

describe('plan 91 — broken templates withhold sends with a repair reason', () => {
  it('start refuses with runner_prompts_misconfigured and stays paused', async () => {
    patch({ enabled: 0, control_state: 'paused', prompt_templates_json: '{corrupt' });
    queue('new');
    await assert.rejects(
      mission.startRunner(runner.id),
      (e) => e.code === 'runner_prompts_misconfigured'
    );
    assert.equal(sent.length, 0);
    const after = mission.getRunner(runner.id);
    assert.equal(Number(after.enabled), 0);
    assert.match(after.last_reason, /Configure → Prompts/);
  });
  it('the watcher withholds automatic sends and parks on need_input with the repair', async () => {
    patch({ prompt_templates_json: JSON.stringify({ ...CUSTOM, continue: 'go {{bogus}}' }) });
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    const after = mission.getRunner(runner.id);
    assert.equal(after.control_state, 'need_input');
    assert.match(after.last_reason, /Prompt templates misconfigured/);
    assert.match(after.last_reason, /Configure → Prompts/);
  });
  it('a template referencing absent required context refuses without sending', async () => {
    await mission.updateRunner(runner.id, { promptTemplates: { ...CUSTOM, start: 'Begin {{current_plan}}.' } });
    patch({ enabled: 0, control_state: 'paused' });
    queue('new'); // no in-progress item, so current_plan is absent
    await assert.rejects(
      mission.startRunner(runner.id),
      (e) => e.code === 'prompt_missing_context'
    );
    assert.equal(sent.length, 0);
    assert.equal(Number(mission.getRunner(runner.id).enabled), 0);
  });
  it('a pause with broken templates still disables dispatch but withholds the message', async () => {
    patch({ prompt_templates_json: '{corrupt' });
    queue('in progress');
    const after = await mission.pauseRunner(runner.id, { mode: 'current_task' });
    assert.equal(sent.length, 0, 'no cooperative message rendered from corrupt templates');
    assert.equal(Number(after.enabled), 0, 'dispatch still off');
    assert.match(after.last_reason, /stop message not sent/);
  });
  it('editing templates during an outstanding operation never resends', async () => {
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 1);
    const op = mission.getRunner(runner.id).operation_id;
    await mission.updateRunner(runner.id, { promptTemplates: { ...CUSTOM, continue: '[T-CONTINUE-v2] {{runner_name}}' } });
    turn = { ...turn, state: 'working' };
    for (let i = 0; i < 3; i++) { queue(i % 2 ? 'new' : 'in progress'); await mission.runnerWatchOnce(runner.id); }
    assert.equal(sent.length, 1, 'no resend after an edit mid-turn');
    assert.equal(mission.getRunner(runner.id).operation_id, op);
  });
});

describe('plan 91 — an unanswered instruction escalates instead of waiting forever', () => {
  // Live-found 2026-10-12: a startup "confirmed" by a boot-banner repaint sat
  // in wait_turn_end 12+ minutes with an idle worker — the retry budget never
  // exhausts while an operation is outstanding, so nothing bounded the wait.
  // The user asked how long it would keep running: 10 minutes, then need_input
  // with no resend.
  function staleOutstanding() {
    patch({
      operation_status: 'confirmed', operation_generation: 1, operation_id: 'op-stale',
      operation_started_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(),
      operation_session_id: 'conversation', operation_prompt_hash: 'not-this-input',
      operation_baseline_user_id: 'u0', operation_receipt_user_id: null,
    });
    idle();
  }
  it('outstanding + verified-idle + stale send + no receipt parks on need_input with no resend', async () => {
    staleOutstanding();
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    const after = mission.getRunner(runner.id);
    assert.equal(after.control_state, 'need_input');
    assert.equal(Number(after.enabled), 0);
    assert.match(after.last_reason, /No worker response within 10 minutes/);
    assert.match(after.last_reason, /No resend was made/);
    assert.equal(after.scheduler_decision, 'need_input');
  });
  it('a working worker never trips the watchdog, however stale the send', async () => {
    staleOutstanding();
    turn = { ...turn, state: 'working' };
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    const after = mission.getRunner(runner.id);
    assert.equal(after.control_state, 'enabled', 'a long task keeps its outstanding instruction');
    assert.equal(after.scheduler_decision, 'wait_turn_end');
  });
  it('a fresh outstanding send stays waiting inside the timeout', async () => {
    patch({
      operation_status: 'confirmed', operation_generation: 1, operation_id: 'op-fresh',
      operation_started_at: new Date().toISOString(),
      operation_session_id: 'conversation', operation_prompt_hash: 'not-this-input',
      operation_baseline_user_id: 'u0', operation_receipt_user_id: null,
    });
    idle();
    await mission.runnerWatchOnce(runner.id);
    assert.equal(sent.length, 0);
    assert.equal(mission.getRunner(runner.id).control_state, 'enabled');
    assert.equal(mission.getRunner(runner.id).scheduler_decision, 'wait_turn_end');
  });
});
