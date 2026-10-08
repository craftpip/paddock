/** Plan 69 P3 / D7 — the server-side pipeline driver behind
 *  `task_pipeline_start`, `task_pipeline_status` and `task_pipeline_stop`.
 *
 *  The driver is the only thing in this codebase that ADVANCES a task without a
 *  caller driving each step, so what is pinned here is its restraint: it never
 *  leaves a step unreported, never guesses a verdict, and parks — with a code a
 *  caller can branch on — at each of D7's four walls.
 *
 *  Why these live apart from `task-steps.test.js` (which owns the single-step
 *  tools): every test here runs an ASYNC loop in the background and needs
 *  seams for time (poll/timeout) and for what the session "says" (send). Those
 *  seams do not exist for the step tools, and the step tools' refusal matrix
 *  does not need a loop.
 *
 *  Like task-steps: `PADDOCK_TASK_QUEUE=1` BEFORE requiring `../mcp` (the gate
 *  is the only way these tools exist), and its own throwaway database so the
 *  task/task_steps/mission rows of the dev DB are never touched.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-pipeline-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'task-pipeline.test.db');
process.env.PADDOCK_TASK_QUEUE = '1';
process.on('exit', () => fs.rmSync(DB_DIR, { recursive: true, force: true }));

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, SERVER_NAME, SERVER_VERSION, mcpContext } = require('../mcp');
const { getDb } = require('../services/db');
const taskRunner = require('../services/task-runner');
const taskPipeline = require('../services/task-pipeline');
const mission = require('../services/mission');
const registry = require('../services/agent-registry');
const padTmux = require('../services/pad-tmux');

// Both identities PASS the pad grant, so nothing here measures the access rule.
const OWNER = { userId: 'user-1', role: 'user', scopes: ['default'] };
const ACTOR = 'user:user-1';

const FLEET = [
  { name: 'pad-pipe', display_name: 'PIPE', agent_type: 'opencode', runtime_ref: 'pad-pipe', status: 'running' },
];
const padRow = (n) => {
  const hit = FLEET.find((a) => a.name === n);
  if (!hit) return null;
  return { ...hit, workspace_dir: '/mnt/real', workspace_mount: { host: '/w', container: '/mnt/real' } };
};

const SHA = '0123456789abcdef0123456789abcdef01234567';

/** Pane state the session gates read. `stubPane('dead')` is what a session whose
 *  tmux is gone looks like to `mission.assertStepSession`. */
let PANE = 'ok';
function stubPane(state) {
  PANE = state;
  padTmux.hasSession = async () => state !== 'dead';
  padTmux.paneState = async () => ({
    live: state !== 'dead',
    tuiAlive: state !== 'shell',
    command: state === 'shell' ? 'bash' : 'opencode',
    cwd: '/www2/paddock',
  });
  padTmux.captureScreen = async () => ({
    text: state === 'permission'
      ? 'Permission required\n→ Bash\nPath: /tmp\nAllow once\nReject'
      : 'ready',
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('MCP task pipeline driver (plan 69 P3 / D7)', () => {
  let client;
  let server;
  let realDiscover;
  let realGetAgent;
  const realPane = {};

  /** Everything the driver "said" into the session, in order. */
  const sent = [];
  /** Every git exec the commit stage ran, in order. */
  const git = [];

  async function call(name, args, user) {
    const run = () => client.callTool({ name, arguments: args || {} });
    try {
      const r = await mcpContext.run({ user: user || OWNER }, run);
      const text = (r.content || []).map((c) => c.text).join('\n');
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return { isError: !!r.isError, text, data };
    } catch (e) {
      return { isError: true, text: String(e.message || e), data: null };
    }
  }

  const stepsOf = (taskId) => taskRunner.listTaskSteps(taskId, 200);
  const stepNames = (taskId) => stepsOf(taskId).map((r) => `${r.step}:${r.state}`);

  async function waitFor(pred, what, ms = 3000) {
    const t0 = Date.now();
    for (;;) {
      const v = pred();
      if (v) return v;
      if (Date.now() - t0 > ms) throw new Error(`waitFor(${what}) timed out`);
      await sleep(5);
    }
  }

  /** A terminal report for one step — the ONLY thing that advances the driver
   *  (wall 1). Returns the MCP result so a caller can assert on it. */
  async function report(taskId, step, state, status, extra) {
    const args = { task_id: taskId, step, state, ...(extra || {}) };
    if (status != null) args.status = status; // `status` is optional (a step in flight has no verdict)
    const r = await call('task_step_report', args);
    if (r.isError) throw new Error(`task_step_report ${step}/${state} refused: ${r.text}`);
    return r;
  }

  before(async () => {
    realDiscover = registry.discoverAgents;
    realGetAgent = registry.getAgent;
    for (const k of ['hasSession', 'paneState', 'captureScreen']) realPane[k] = padTmux[k];
    registry.discoverAgents = () => FLEET;
    registry.getAgent = (n) => padRow(n);
    server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } }
    );
    registerTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test-client', version: '0' });
    await client.connect(ct);
    stubPane('ok');
  });

  after(async () => {
    if (client) await client.close();
    if (server) await server.close();
    registry.discoverAgents = realDiscover;
    registry.getAgent = realGetAgent;
    for (const k of ['hasSession', 'paneState', 'captureScreen']) padTmux[k] = realPane[k];
    taskPipeline._setForTests({ resetSeams: true });
    taskRunner._setForTests({ resetSeams: true });
  });

  beforeEach(async () => {
    // Stop anything the previous test left running BEFORE its rows vanish, so a
    // late tick cannot write into the next test's task.
    taskPipeline.resetForTests();
    await sleep(15);

    sent.length = 0;
    git.length = 0;
    taskPipeline._setForTests({
      resetSeams: true,
      send: async (session_id, text) => { sent.push({ session_id, text }); },
      agent: (n) => padRow(n),
      poll: 5,
      liveness: 0,          // tmux probes only where a test turns them on
      timeout: () => 4000,
    });
    taskRunner._setForTests({
      resetSeams: true,
      gitExec: async (ref, script) => {
        git.push({ ref, script });
        return { stdout: `x\n\n__EC__=0\n__SHA__=${SHA}\n`, stderr: '', code: 0 };
      },
      getAgent: (n) => padRow(n),
      isRunning: () => true,
      folderExists: async () => true,
    });

    const db = getDb();
    db.prepare('DELETE FROM task_steps').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM mission_sessions').run();
    db.prepare('DELETE FROM mission_projects').run();
    for (const f of FLEET) {
      db.prepare(
        `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
         VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'user-1')`
      ).run(f.name, f.name, f.name);
    }
    stubPane('ok');
  });

  /** A bound task on pad-pipe: a real project + session row, submitted through
   *  the tool so the binding step is the one `task_submit` writes. */
  async function seed(prompt = 'make the thing work') {
    const project = mission.createProject({ name: 'pipe', agent: 'pad-pipe', folder: '/www2/paddock' });
    const session = mission.createSession(project.id);
    const s = await call('task_submit', { prompt, session_id: session.id, enqueue: true });
    assert.ok(!s.isError, s.text);
    return { taskId: s.data.task_id, session, project };
  }

  async function start(taskId) {
    return taskPipeline.start(taskId, { actor: ACTOR });
  }

  /** Start, wait for the driver to type the first prompt, then hand it back. */
  async function startAndPrompt(taskId) {
    const rec = await start(taskId);
    await waitFor(() => sent.length >= 1, 'first prompt');
    return rec;
  }

  /** Await a driver's run promise WITH a ref'd timer held meanwhile: the driver's
   *  own `sleep` is unref'd on purpose (a parked driver must never be what keeps
   *  the webui process alive), so a test awaiting that promise alone lets the
   *  event loop drain before the next tick can fire. */
  function awaitDriver(rec, ms = 5000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`driver did not finish within ${ms}ms`)), ms);
      const done = (fn, v) => { clearTimeout(t); fn(v); };
      Promise.resolve(rec && rec.promise).then(
        (v) => done(resolve, v),
        (e) => done(reject, e)
      );
    });
  }

  async function stopAndWait(rec) {
    try { taskPipeline.stop(rec.task_id, { actor: ACTOR }); } catch { /* already stopped */ }
    if (rec && rec.promise) await awaitDriver(rec);
  }

  // ── D7 wall 4 / D2: refused at the door ────────────────────────────────
  describe('start refusals', () => {
    it('refuses an unbound task with task_pipeline_no_session', async () => {
      const s = await call('task_submit', { prompt: 'pool work', enqueue: true });
      const r = await call('task_pipeline_start', { task_id: s.data.task_id });
      assert.ok(r.isError, 'a driver needs a session it can address');
      assert.match(r.text, /task_pipeline_no_session/);
      assert.match(r.text, /session_id/, 'and it says how to bind one');
      assert.strictEqual(stepsOf(s.data.task_id).length, 0, 'no step was written for a refusal');
    });

    it('refuses a finished task with task_pipeline_closed', async () => {
      const { taskId } = await seed();
      getDb().prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
      const r = await call('task_pipeline_start', { task_id: taskId });
      assert.ok(r.isError);
      assert.match(r.text, /task_pipeline_closed/);
      assert.match(r.text, /done/);
      assert.strictEqual(taskPipeline.isActive(taskId), false);
    });

    it('refuses an unknown task with task_not_found', async () => {
      const r = await call('task_pipeline_start', { task_id: 'nope' });
      assert.ok(r.isError);
      assert.match(r.text, /Task not found/, 'the same message every other task tool gives for an unknown id');
    });

    it('refuses when the newest step is already running (one active step per task)', async () => {
      const { taskId } = await seed();
      taskRunner.insertTaskStep({ task_id: taskId, step: 'review', state: 'running' });
      const r = await call('task_pipeline_start', { task_id: taskId });
      assert.ok(r.isError, 'a step already in flight is the answer — not a second driver');
      assert.match(r.text, /task_pipeline_busy/);
      assert.match(r.text, /review/);
      assert.strictEqual(sent.length, 0, 'nothing was sent to the session');
    });

    it('refuses a second start while the driver is alive', async () => {
      const { taskId } = await seed();
      const rec = await startAndPrompt(taskId);
      const again = await call('task_pipeline_start', { task_id: taskId });
      assert.ok(again.isError, 'one driver per task');
      assert.match(again.text, /task_pipeline_busy/);
      assert.match(again.text, /review/, 'and it names the step the live driver sits on');
      await stopAndWait(rec);
    });

    it('refuses a LOCKED session at the door, and leaves no driver behind', async () => {
      const { taskId, session } = await seed();
      getDb().prepare('UPDATE mission_sessions SET locked = 1 WHERE id = ?').run(session.id);
      const r = await call('task_pipeline_start', { task_id: taskId });
      assert.ok(r.isError, 'a locked session must be refused BEFORE a driver starts');
      assert.match(r.text, /task_session_locked/);

      assert.strictEqual(taskPipeline.isActive(taskId), false, 'and nothing was reserved');
      const st = await call('task_pipeline_status', { task_id: taskId });
      assert.ok(!st.isError, st.text);
      assert.strictEqual(st.data.active, false);
      assert.strictEqual(st.data.pipeline, null, 'a refusal is not a run that later parked');
      assert.match(st.data.note, /No pipeline has been started/);
      assert.strictEqual(sent.length, 0);
    });
  });

  // ── D7 wall 1: no advance without a report ─────────────────────────────
  describe('the no-report wall', () => {
    it('sends the step and then WAITS — the loop never advances on its own', async () => {
      const { taskId } = await seed();
      const rec = await startAndPrompt(taskId);

      assert.match(sent[0].text, /\[paddock\] STEP review/);
      assert.match(sent[0].text, new RegExp(`task_step_report \\{ task_id: "${taskId}"`));
      assert.match(sent[0].text, /does not advance until a report lands/);

      await sleep(80); // ~16 driver ticks with poll = 5ms
      assert.strictEqual(taskPipeline.nextStepToRun(taskId), 'review',
        'still on review: a quiet pane is NOT a green step');
      assert.deepStrictEqual(stepNames(taskId), ['review:running'],
        'the binding row was reused and nothing new was written');
      assert.strictEqual(rec.state, 'running', 'and the driver is still alive, waiting');

      await stopAndWait(rec);
      assert.strictEqual(taskPipeline.isActive(taskId), false);
    });

    it('advances exactly when a report lands (the positive twin)', async () => {
      const { taskId } = await seed();
      const rec = await startAndPrompt(taskId);
      await report(taskId, 'review', 'done', 'passed');
      await waitFor(() => sent.length >= 2, 'build prompt');
      assert.match(sent[1].text, /\[paddock\] STEP build/);
      assert.strictEqual(taskPipeline.nextStepToRun(taskId), 'build');
      await stopAndWait(rec);
    });
  });

  // ── the happy path ─────────────────────────────────────────────────────
  describe('review → build → test → commit', () => {
    it('walks the whole loop, runs git itself, and finishes with the SHA as the artifact', async () => {
      const { taskId } = await seed('add a widget');
      const rec = await startAndPrompt(taskId);

      await report(taskId, 'review', 'done', 'passed');
      await waitFor(() => sent.length >= 2, 'build prompt');
      await report(taskId, 'build', 'done', 'passed');
      await waitFor(() => sent.length >= 3, 'test prompt');
      assert.match(sent[2].text, /\[paddock\] STEP test/);
      assert.match(sent[2].text, /task_step_bug/, 'the test prompt says where a defect goes (D5)');
      await report(taskId, 'test', 'done', 'passed');

      await awaitDriver(rec);
      assert.strictEqual(rec.state, 'done');
      assert.strictEqual(rec.reason, null);
      assert.match(rec.detail, /committed 0123456789abcdef0123456789abcdef01234567/);

      assert.strictEqual(sent.length, 3, 'the commit stage sends NOTHING — the driver runs git itself (D6)');
      assert.strictEqual(git.length, 1, 'exactly one commit');
      assert.strictEqual(git[0].ref, 'pad-pipe', 'in the session\'s PAD');
      assert.ok(git[0].script.includes('/www2/paddock'), 'in the session\'s folder');

      assert.deepStrictEqual(stepNames(taskId),
        ['review:done', 'build:done', 'test:done', 'commit:done']);
      const commit = stepsOf(taskId).find((r) => r.step === 'commit');
      assert.strictEqual(commit.artifact, SHA, 'the SHA lives in `artifact` (D6)');
      assert.strictEqual(commit.reported_by, ACTOR, 'and it is attributed to whoever started the run');

      const st = await call('task_pipeline_status', { task_id: taskId });
      assert.ok(!st.isError, st.text);
      assert.strictEqual(st.data.active, false);
      assert.strictEqual(st.data.next_step, 'done', 'a finished loop does not offer to commit twice');
      assert.strictEqual(st.data.pipeline.state, 'done');
      assert.match(st.data.note, /ended done/);
      assert.strictEqual(st.data.task_status, 'pending',
        'the driver never sets the task\'s own status — that is task_complete\'s');
    });

    it('routes a FAILED test into a hotfix carrying the recorded defect, then re-runs the test', async () => {
      const { taskId } = await seed('fix the widget');
      const rec = await startAndPrompt(taskId);

      await report(taskId, 'review', 'done', 'passed');
      await waitFor(() => sent.length >= 2, 'build prompt');
      await report(taskId, 'build', 'done', 'passed');
      await waitFor(() => sent.length >= 3, 'test prompt');

      // D5: the defect is recorded FIRST, as its own row with JSON evidence.
      const bug = await call('task_step_bug', {
        task_id: taskId, file: 'src/widget.js', line: 42,
        summary: 'widget is off by one', repro: 'run the suite',
      });
      assert.ok(!bug.isError, bug.text);
      await report(taskId, 'test', 'failed', 'failed', { notes: 'suite red' });

      await waitFor(() => sent.length >= 4, 'hotfix prompt');
      assert.match(sent[3].text, /\[paddock\] STEP hotfix/);
      assert.match(sent[3].text, /src\/widget\.js:42/, 'the prompt carries the defect it owes (D5)');
      assert.match(sent[3].text, /widget is off by one/);

      await report(taskId, 'hotfix', 'done', 'passed');
      await waitFor(() => sent.length >= 5, 'the re-run of test');
      assert.match(sent[4].text, /\[paddock\] STEP test/);
      const attempts = stepsOf(taskId).filter((r) => r.step === 'test');
      assert.ok(attempts.some((r) => r.attempt === 2), 'the re-run is attempt 2, not a second row at attempt 1');

      await report(taskId, 'test', 'done', 'passed');
      await awaitDriver(rec);
      assert.strictEqual(rec.state, 'done');
      assert.strictEqual(rec.hotfix, 1, 'one routed hotfix, counted');
      assert.strictEqual(git.length, 1, 'and the commit still happened once');
    });
  });

  // ── the other three parks ──────────────────────────────────────────────
  describe('parks instead of guessing', () => {
    it('park report_failed when a step reports failure (only `test` earns a hotfix)', async () => {
      const { taskId } = await seed();
      const rec = await startAndPrompt(taskId);
      await report(taskId, 'review', 'failed', 'failed', { notes: 'not actionable' });
      await awaitDriver(rec);

      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'report_failed');
      assert.match(rec.detail, /review/);
      assert.deepStrictEqual(stepNames(taskId), ['review:failed'], 'and it went no further');

      const st = await call('task_pipeline_status', { task_id: taskId });
      assert.strictEqual(st.data.active, false);
      assert.strictEqual(st.data.pipeline.reason, 'report_failed');
      assert.match(st.data.note, /ended parked/);
    });

    it('park needs_review when a step reports needs_review', async () => {
      const { taskId } = await seed();
      const rec = await startAndPrompt(taskId);
      await report(taskId, 'review', 'needs_review', null, { notes: 'ask a human first' });
      await awaitDriver(rec);

      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'needs_review');
      assert.strictEqual(sent.length, 1, 'the next step was never sent');
    });

    it('park timeout when a step overruns tasks.timeout_ms, stamping the row failed/error', async () => {
      const { taskId } = await seed();
      taskPipeline._setForTests({ timeout: () => 80 });
      const rec = await start(taskId);
      await waitFor(() => sent.length >= 1, 'review prompt');
      await awaitDriver(rec);

      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'timeout');
      assert.match(rec.detail, /reported nothing within \d+ms/);
      assert.match(rec.detail, /tasks.timeout_ms = 80/, "and it names the task's own budget");
      const row = taskRunner.getCurrentTaskStep(taskId);
      assert.strictEqual(row.state, 'failed', 'the row stops claiming work the moment the wall hits');
      assert.strictEqual(row.status, 'error');
      assert.match(row.notes, /pipeline parked: timeout/);
    });

    it('park mission_session_dead when the session dies mid-run', async () => {
      const { taskId } = await seed();
      taskPipeline._setForTests({ liveness: 1 }); // probe every tick
      const rec = await startAndPrompt(taskId);

      stubPane('dead');
      await awaitDriver(rec);

      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'mission_session_dead');
      const row = taskRunner.getCurrentTaskStep(taskId);
      assert.strictEqual(row.state, 'failed', 'the in-flight row is settled, not left running');
      assert.strictEqual(sent.length, 1, 'no further steps were sent to a dead session');
    });

    it('park task_gone when the task row disappears, and status then refuses', async () => {
      const { taskId } = await seed();
      const rec = await startAndPrompt(taskId);
      getDb().prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
      await awaitDriver(rec);

      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'task_gone');

      const st = await call('task_pipeline_status', { task_id: taskId });
      assert.ok(st.isError, 'a removed task is not a status answer either');
      assert.match(st.text, /Task not found/, 'the gate refuses before any status is read');
    });

    it('park max_hotfix rather than loop forever', async () => {
      const { taskId, session } = await seed();
      // A history that has already used its three hotfixes: the planner routes
      // to `hotfix` (the newest test failed with no hotfix after it), and the
      // wall stops it before a prompt is ever sent.
      const row = (step, attempt, state, status) => taskRunner.insertTaskStep({
        task_id: taskId, step, attempt, state, status, session_id: session.id,
        reported_by: state === 'pending' ? null : ACTOR,
      });
      row('review', 1, 'done', 'passed');
      row('build', 1, 'done', 'passed');
      row('test', 1, 'failed', 'failed');
      row('hotfix', 1, 'done', 'passed');
      row('test', 2, 'failed', 'failed');
      row('hotfix', 2, 'done', 'passed');
      row('test', 3, 'failed', 'failed');
      row('hotfix', 3, 'done', 'passed');
      row('test', 4, 'failed', 'failed');

      const rec = await start(taskId);
      await awaitDriver(rec);
      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'max_hotfix');
      assert.strictEqual(sent.length, 0, 'the wall hit before anything was typed');
      assert.strictEqual(taskPipeline.nextStepToRun(taskId), 'hotfix',
        'the planner still WANTS a hotfix — the park is the count, not the plan');
    });

    it('park commit_nothing on a clean tree instead of claiming a commit', async () => {
      const { taskId } = await seed();
      taskRunner._setForTests({
        gitExec: async (ref, script) => {
          git.push({ ref, script });
          return { stdout: 'nothing to commit, working tree clean\n\n__EC__=1\n__SHA__=' + SHA + '\n', stderr: '', code: 1 };
        },
      });
      const rec = await startAndPrompt(taskId);
      await report(taskId, 'review', 'done', 'passed');
      await waitFor(() => sent.length >= 2, 'build prompt');
      await report(taskId, 'build', 'done', 'passed');
      await waitFor(() => sent.length >= 3, 'test prompt');
      await report(taskId, 'test', 'done', 'passed');
      await awaitDriver(rec);

      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'commit_nothing');
      const commit = stepsOf(taskId).find((r) => r.step === 'commit');
      assert.strictEqual(commit.state, 'failed');
      assert.strictEqual(commit.artifact, '', 'a clean tree claims no SHA — HEAD is not THIS task\'s commit');
    });

    it('park task_commit_no_pad when the project resolves to no PAD', async () => {
      const { taskId } = await seed();
      taskPipeline._setForTests({ agent: () => null });
      const rec = await startAndPrompt(taskId);
      await report(taskId, 'review', 'done', 'passed');
      await waitFor(() => sent.length >= 2, 'build prompt');
      await report(taskId, 'build', 'done', 'passed');
      await waitFor(() => sent.length >= 3, 'test prompt');
      await report(taskId, 'test', 'done', 'passed');
      await awaitDriver(rec);

      assert.strictEqual(rec.state, 'parked');
      assert.strictEqual(rec.reason, 'task_commit_no_pad');
      assert.strictEqual(git.length, 0, 'and git never ran');
    });
  });

  // ── D7 wall 3: stop ────────────────────────────────────────────────────
  describe('task_pipeline_stop', () => {
    it('aborts the run: the running row is stamped immediately, the loop ends', async () => {
      const { taskId } = await seed();
      const rec = await startAndPrompt(taskId);

      const r = await call('task_pipeline_stop', { task_id: taskId });
      assert.ok(!r.isError, r.text);
      assert.strictEqual(r.data.aborted_step.state, 'aborted',
        'the caller\'s own read shows the stop, not a step still claiming work');
      assert.match(r.data.aborted_step.notes, /pipeline stopped by user:user-1/);
      assert.strictEqual(r.data.pipeline.state, 'stopped');

      // Wall 3, measured: the flag lands on the NEXT TICK (poll = 5ms), not on
      // the step's timeout (4000ms) — a stop the driver only honours eventually
      // is a stop that may never be seen at all.
      const t0 = Date.now();
      await awaitDriver(rec);
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 1000, `the driver should exit on its next tick, not its timeout (took ${elapsed}ms)`);
      assert.strictEqual(taskPipeline.isActive(taskId), false);
      assert.strictEqual(sent.length, 1, 'nothing after the current step was started');

      const st = await call('task_pipeline_status', { task_id: taskId });
      assert.strictEqual(st.data.active, false);
      assert.strictEqual(st.data.pipeline.reason, 'stopped');
      assert.match(st.data.note, /ended stopped/);
    });

    it('refuses with task_pipeline_idle when there is nothing to stop', async () => {
      const { taskId } = await seed();
      const r = await call('task_pipeline_stop', { task_id: taskId });
      assert.ok(r.isError, 'a stop that pretended to stop something would be worse than no stop');
      assert.match(r.text, /task_pipeline_idle/);
    });
  });

  // ── status: the read half ──────────────────────────────────────────────
  describe('task_pipeline_status', () => {
    it('reads a task that was never started, and says so in words', async () => {
      const { taskId } = await seed('just checking');
      const st = await call('task_pipeline_status', { task_id: taskId });
      assert.ok(!st.isError, st.text);
      assert.strictEqual(st.data.active, false);
      assert.strictEqual(st.data.pipeline, null);
      assert.strictEqual(st.data.next_step, 'review', 'D1: derived from the task\'s own step history');
      assert.strictEqual(st.data.binding.session_id, st.data.steps[0].session_id);
      assert.match(st.data.note, /memory/i, '"no driver" is not "nothing is happening"');
    });

    it('shows a driver while it is alive (one indexed read per poll)', async () => {
      const { taskId, session } = await seed();
      const rec = await startAndPrompt(taskId);
      const st = await call('task_pipeline_status', { task_id: taskId });
      assert.ok(!st.isError, st.text);
      assert.strictEqual(st.data.active, true, 'alive, not "last run ended"');
      assert.strictEqual(st.data.pipeline.state, 'running');
      assert.strictEqual(st.data.pipeline.step, 'review');
      assert.strictEqual(st.data.pipeline.session_id, session.id);
      assert.strictEqual(st.data.pipeline.actor, ACTOR);
      assert.strictEqual(st.data.current_step.state, 'running');
      assert.strictEqual(st.data.next_step, 'review');
      assert.strictEqual(st.data.note, undefined, 'an active run needs no explanatory note');
      await stopAndWait(rec);
    });
  });
});
