/** Plan 69 P2 — the single-step MCP tools: `task_step_report`,
 *  `task_step_bug`, `task_step_commit`, plus the session binding task_submit
 *  gained in the same plan (D2/D3/D4/D6).
 *
 *  Why these live in their own file rather than in `task-mcp.test.js`: every
 *  case here needs a Mission SESSION and a stubbed tmux (the refusal matrix is
 *  four different pane states), which is mission.test.js's vocabulary grafted
 *  onto the task suite. Kept apart so neither suite has to carry the other's
 *  fixtures.
 *
 *  Like task-mcp: `PADDOCK_TASK_QUEUE=1` BEFORE requiring `../mcp` (the gate is
 *  the only way these tools exist), and its own throwaway database so the
 *  task/task_steps/mission rows of the dev DB are never touched.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-tasksteps-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'task-steps.test.db');
process.env.PADDOCK_TASK_QUEUE = '1';
process.on('exit', () => fs.rmSync(DB_DIR, { recursive: true, force: true }));

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, SERVER_NAME, SERVER_VERSION, mcpContext } = require('../mcp');
const { getDb } = require('../services/db');
const taskRunner = require('../services/task-runner');
const mission = require('../services/mission');
const registry = require('../services/agent-registry');
const padTmux = require('../services/pad-tmux');

// Two identities that both PASS the pad grant (one owns it, one is admin) so
// the actor-claim test measures the CLAIM rule and not the access rule.
const OWNER = { userId: 'user-1', role: 'user', scopes: ['default'] };
const OTHER = { userId: 'user-2', role: 'admin', scopes: ['default'] };

const FLEET = [
  { name: 'pad-st-a', display_name: 'ST A', agent_type: 'opencode', runtime_ref: 'pad-st-a', status: 'running' },
  { name: 'pad-st-b', display_name: 'ST B', agent_type: 'opencode', runtime_ref: 'pad-st-b', status: 'running' },
];
const padRow = (n) => {
  const hit = FLEET.find((a) => a.name === n);
  if (!hit) return null;
  return {
    ...hit,
    workspace_dir: '/mnt/real',
    workspace_mount: { host: '/w', container: '/mnt/real' },
  };
};

/** Pane states the four D2 refusals are built from. `dead` never reaches
 *  paneState (hasSession says no), the rest are read from the pane. */
const PANE = { state: 'ok' };
function stubPane(state) {
  PANE.state = state;
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

describe('MCP task step tools (plan 69 P2)', () => {
  let client;
  let server;
  let realDiscover;
  let realGetAgent;
  const realPane = {};

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
  });

  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM task_steps').run();
    db.prepare('DELETE FROM tasks').run();
    db.prepare('DELETE FROM mission_sessions').run();
    db.prepare('DELETE FROM mission_projects').run();
    for (const name of ['pad-st-a', 'pad-st-b']) {
      db.prepare(
        `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
         VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'user-1')`
      ).run(name, name, name);
    }
    taskRunner._setForTests({
      resetSeams: true,
      getAgent: padRow,
      isRunning: (ref) => ref === 'pad-st-a' || ref === 'pad-st-b',
      folderExists: async () => true,
    });
    stubPane('ok');
  });

  afterEach(() => { PANE.state = 'ok'; });

  /** A project + session on pad-st-a (and optionally pad-st-b for the
   *  cross-pad refusal), both real rows so every FK is satisfied. */
  function seedSessions() {
    const a = mission.createProject({ name: 'steps-a', agent: 'pad-st-a', folder: '/www2/paddock' });
    const b = mission.createProject({ name: 'steps-b', agent: 'pad-st-b', folder: '/www1' });
    const sa = mission.createSession(a.id);
    const sb = mission.createSession(b.id);
    return { projectA: a, projectB: b, sessionA: sa, sessionB: sb };
  }

  // ── D2/D3: the binding written at submit ────────────────────────────────
  describe('task_submit session binding', () => {
    it('binds the session and opens a `review` step that task_status reads back', async () => {
      const { sessionA } = seedSessions();
      const r = await call('task_submit', { prompt: 'do the thing', session_id: sessionA.id, enqueue: true });
      assert.ok(!r.isError, r.text);
      assert.strictEqual(r.data.binding.session_id, sessionA.id, 'the response says which session now gates the steps');
      assert.strictEqual(r.data.binding.reviewer, null);

      const st = await call('task_status', { task_id: r.data.task_id });
      assert.strictEqual(st.data.current_step.step, 'review');
      assert.strictEqual(st.data.current_step.state, 'pending');
      assert.strictEqual(st.data.current_step.session_id, sessionA.id);
      // reported_by is NULL on purpose: nobody has CLAIMED the review step yet,
      // and the first report claims it (the actor-claim rule).
      assert.strictEqual(st.data.current_step.reported_by, null);
      assert.strictEqual(st.data.binding.session_id, sessionA.id);
    });

    it('surfaces the current step on task_list too (one batched read)', async () => {
      const { sessionA } = seedSessions();
      const s = await call('task_submit', { prompt: 'listed', session_id: sessionA.id, enqueue: true });
      const l = await call('task_list', {});
      const row = l.data.tasks.find((t) => t.id === s.data.task_id);
      assert.ok(row, 'the task is in the list');
      assert.strictEqual(row.current_step.step, 'review');
      assert.strictEqual(row.current_step.session_id, sessionA.id);
    });

    it('records the reviewer when one is given (D3)', async () => {
      const { sessionA, sessionB } = seedSessions();
      const r = await call('task_submit', {
        prompt: 'x', session_id: sessionA.id, reviewer: sessionA.id, enqueue: true,
      });
      assert.ok(!r.isError, r.text);
      assert.strictEqual(r.data.binding.reviewer, sessionA.id);
      // A reviewer on ANOTHER pad is refused: one task, one pad.
      const cross = await call('task_submit', {
        prompt: 'x', session_id: sessionA.id, reviewer: sessionB.id, enqueue: true,
      });
      assert.ok(cross.isError, 'a reviewer on a different pad must be refused');
      assert.match(cross.text, /task_reviewer_pad_mismatch/);
    });

    it('refuses a reviewer with no session to review from, and a name that contradicts the session', async () => {
      const { sessionA } = seedSessions();
      const noSession = await call('task_submit', { prompt: 'x', reviewer: sessionA.id });
      assert.ok(noSession.isError);
      assert.match(noSession.text, /reviewer requires session_id/);

      const db = getDb();
      const before = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
      const wrongPad = await call('task_submit', {
        prompt: 'x', session_id: sessionA.id, name: 'pad-st-b', enqueue: true,
      });
      assert.ok(wrongPad.isError);
      assert.match(wrongPad.text, /task_session_pad_mismatch/);
      assert.strictEqual(
        db.prepare('SELECT COUNT(*) c FROM tasks').get().c, before,
        'and nothing was filed — the contradiction is caught before the INSERT'
      );
    });
  });

  // ── D2: the refusal matrix ─────────────────────────────────────────────
  describe('session gates (D2 refusal matrix)', () => {
    const cases = [
      ['dead', /mission_session_dead/],
      ['shell', /mission_not_an_agent/],
      ['locked', /task_session_locked/],
      ['permission', /mission_permission_pending/],
    ];

    for (const [state, re] of cases) {
      it(`a ${state} session refuses the step with ${re.source}`, async () => {
        const { sessionA } = seedSessions();
        if (state === 'locked') getDb().prepare('UPDATE mission_sessions SET locked = 1 WHERE id = ?').run(sessionA.id);
        const s = await call('task_submit', { prompt: 'x', session_id: sessionA.id, enqueue: true });
        const taskId = s.data.task_id;
        const before = stepsOf(taskId).length;

        stubPane(state === 'locked' ? 'ok' : state);
        const r = await call('task_step_report', {
          task_id: taskId, step: 'test', state: 'running',
        });
        assert.ok(r.isError, `${state} must refuse`);
        assert.match(r.text, re);

        const after = stepsOf(taskId).length;
        assert.strictEqual(after, before, 'a refused step writes NOTHING — a log that credits a rejected write is evidence against itself');
        // …and the derived current step is untouched: the refusal did not
        // advance the loop either.
        const st = await call('task_status', { task_id: taskId });
        assert.strictEqual(st.data.current_step.step, 'review');
        assert.strictEqual(st.data.current_step.state, 'pending');
      });
    }

    it('an open session reports the step fine (the positive twin)', async () => {
      const { sessionA } = seedSessions();
      const s = await call('task_submit', { prompt: 'x', session_id: sessionA.id, enqueue: true });
      stubPane('ok');
      const r = await call('task_step_report', {
        task_id: s.data.task_id, step: 'test', state: 'running', notes: 'started',
      });
      assert.ok(!r.isError, r.text);
      assert.strictEqual(r.data.step.state, 'running');
      assert.strictEqual(r.data.step.reported_by, 'user:user-1');
      assert.strictEqual(r.data.current_step.step, 'test');
    });

    it('refuses a session the task is not bound to', async () => {
      const { sessionA, sessionB } = seedSessions();
      const s = await call('task_submit', { prompt: 'x', session_id: sessionA.id, enqueue: true });
      stubPane('ok');
      const r = await call('task_step_report', {
        task_id: s.data.task_id, step: 'test', state: 'running', session_id: sessionB.id,
      });
      assert.ok(r.isError, 'a step may only be reported against the task\'s own session (or its reviewer)');
      assert.match(r.text, /task_session_mismatch/);
      assert.strictEqual(stepsOf(s.data.task_id).length, 1, 'only the binding row exists');
    });
  });

  // ── D4/D5: reports, attempts, actor-claim, bugs ────────────────────────
  describe('step reports and actor-claim (D4)', () => {
    it('amends the open attempt, then opens the NEXT attempt after a terminal one', async () => {
      const { sessionA } = seedSessions();
      const s = await call('task_submit', { prompt: 'x', session_id: sessionA.id, enqueue: true });
      const taskId = s.data.task_id;
      stubPane('ok');

      // The binding row IS the open review attempt, so the first report amends
      // it rather than adding a competing row for the same attempt.
      const a = await call('task_step_report', { task_id: taskId, step: 'review', state: 'running' });
      assert.strictEqual(a.data.step.attempt, 1);
      assert.strictEqual(a.data.step.reported_by, 'user:user-1');
      assert.strictEqual(stepsOf(taskId).length, 1, 'one row, amended');

      const b = await call('task_step_report', { task_id: taskId, step: 'review', state: 'done', status: 'passed' });
      assert.strictEqual(b.data.step.attempt, 1);
      assert.strictEqual(b.data.step.state, 'done');
      assert.strictEqual(b.data.step.status, 'passed');
      assert.strictEqual(stepsOf(taskId).length, 1);

      // A terminal attempt is finished: the next report starts attempt 2.
      const c = await call('task_step_report', { task_id: taskId, step: 'test', state: 'running' });
      assert.strictEqual(c.data.step.attempt, 1, 'a DIFFERENT step starts at 1');
      const d = await call('task_step_report', { task_id: taskId, step: 'test', state: 'done', status: 'passed' });
      assert.strictEqual(d.data.step.attempt, 1, 'the test attempt is still open, so this amends it');
      const e = await call('task_step_report', { task_id: taskId, step: 'test', state: 'failed', status: 'failed' });
      assert.strictEqual(e.data.step.attempt, 2, 'failed is terminal — the re-run is a new attempt');
      assert.strictEqual(e.data.step.state, 'failed');
    });

    it('a second identity is refused with task_step_claimed, not silently allowed', async () => {
      const { sessionA } = seedSessions();
      const s = await call('task_submit', { prompt: 'x', session_id: sessionA.id, enqueue: true });
      const taskId = s.data.task_id;
      stubPane('ok');

      const first = await call('task_step_report', {
        task_id: taskId, step: 'test', state: 'running',
      }, OWNER);
      assert.ok(!first.isError, first.text);

      const second = await call('task_step_report', {
        task_id: taskId, step: 'test', state: 'done', status: 'passed',
      }, OTHER);
      assert.ok(second.isError, 'an attempt is ONE identity\'s to report');
      assert.match(second.text, /task_step_claimed/);
      assert.match(second.text, /user:user-1/, 'and it names the holder, so the caller knows who to talk to');

      const row = taskRunner.getCurrentTaskStep(taskId);
      assert.strictEqual(row.state, 'running', 'the holder\'s report was not overwritten');
      assert.strictEqual(row.reported_by, 'user:user-1');
    });

    it('task_step_bug records file:line as JSON on the same attempt', async () => {
      const { sessionA } = seedSessions();
      const s = await call('task_submit', { prompt: 'x', session_id: sessionA.id, enqueue: true });
      const taskId = s.data.task_id;
      stubPane('ok');

      await call('task_step_report', { task_id: taskId, step: 'test', state: 'running' });
      const cur = taskRunner.getCurrentTaskStep(taskId);
      const r = await call('task_step_bug', {
        task_id: taskId, file: 'src/a.js', line: 42,
        summary: 'off by one', repro: 'run the suite',
      });
      assert.ok(!r.isError, r.text);
      assert.strictEqual(r.data.step.step, 'test', 'a bug without a step belongs to `test`');
      assert.strictEqual(r.data.step.attempt, cur.attempt, 'EXTRA row on the same attempt (D5)');
      assert.strictEqual(r.data.step.state, 'failed');
      assert.strictEqual(r.data.step.notes, 'off by one', 'the one line a human reads');
      const art = JSON.parse(r.data.step.artifact);
      assert.deepStrictEqual(
        { file: art.file, line: art.line, repro: art.repro },
        { file: 'src/a.js', line: 42, repro: 'run the suite' },
        'the machine-readable half survives as JSON'
      );
      assert.strictEqual(r.data.current_step.step, 'test', 'the bug is what the task now sits on');
      // …and it does NOT touch the task itself: a bug is evidence, not a
      // verdict on the whole task.
      assert.strictEqual(taskRunner.getTask(taskId).status, 'pending');
    });
  });

  // ── D6: the commit ─────────────────────────────────────────────────────
  describe('task_step_commit (D6)', () => {
    const SHA = '0123456789abcdef0123456789abcdef01234567';

    it('records the commit SHA on the `commit` step', async () => {
      const { sessionA } = seedSessions();
      const s = await call('task_submit', { prompt: 'ship it', session_id: sessionA.id, enqueue: true });
      const taskId = s.data.task_id;
      stubPane('ok');

      const seen = [];
      taskRunner._setForTests({
        gitExec: async (ref, script) => {
          seen.push({ ref, script });
          return { stdout: `[main ${SHA.slice(0, 7)}] ship it\n 1 file changed\n\n__EC__=0\n__SHA__=${SHA}\n`, stderr: '', code: 0 };
        },
      });

      const r = await call('task_step_commit', { task_id: taskId, message: 'ship it' });
      assert.ok(!r.isError, r.text);
      assert.strictEqual(r.data.ok, true);
      assert.strictEqual(r.data.sha, SHA);
      assert.strictEqual(r.data.step.step, 'commit');
      assert.strictEqual(r.data.step.state, 'done');
      assert.strictEqual(r.data.step.status, 'passed');
      assert.strictEqual(r.data.step.artifact, SHA, 'the SHA lives in `artifact`, not in a field named for where it ran');
      assert.strictEqual(r.data.current_step.step, 'commit');

      assert.strictEqual(seen.length, 1, 'exactly one container exec');
      assert.strictEqual(seen[0].ref, 'pad-st-a');
      // The folder is the SESSION's project folder (D6) — quoted, so a path
      // with a space or a quote cannot break out of the `cd`.
      assert.match(seen[0].script, /^cd '/);
      assert.ok(seen[0].script.includes('/www2/paddock'), 'commits in the session folder');
      assert.ok(seen[0].script.includes('git add -A'), 'stages everything in it');
      assert.ok(seen[0].script.includes('git commit -m'), 'and commits');
    });

    it('a clean tree is NOT a commit: ok false, no SHA claimed, code task_commit_nothing', async () => {
      const { sessionA } = seedSessions();
      const s = await call('task_submit', { prompt: 'x', session_id: sessionA.id, enqueue: true });
      const taskId = s.data.task_id;
      stubPane('ok');
      taskRunner._setForTests({
        gitExec: async () => ({
          stdout: `nothing to commit, working tree clean\n\n__EC__=1\n__SHA__=${SHA}\n`,
          stderr: '',
          code: 1,
        }),
      });

      const r = await call('task_step_commit', { task_id: taskId });
      assert.ok(!r.isError, 'the refusal is data, not an exception: the STEP still has to be recorded');
      assert.strictEqual(r.data.ok, false);
      assert.strictEqual(r.data.error.code, 'task_commit_nothing');
      assert.strictEqual(r.data.step.state, 'failed');
      assert.strictEqual(r.data.step.artifact, '', 'it claims no SHA — the clean tree\'s HEAD is not THIS task\'s commit');
      assert.match(r.data.step.notes, /nothing to commit/);
      // A stale HEAD from an earlier commit must not be read as ours.
      assert.notStrictEqual(r.data.step.artifact, SHA);
    });

    it('refuses a pool task that has no PAD to commit in', async () => {
      const s = await call('task_submit', { prompt: 'x' });
      assert.ok(!s.isError, s.text);
      assert.strictEqual(s.data.task.agent_name, null, 'a pool task names no PAD');
      const r = await call('task_step_commit', { task_id: s.data.task_id });
      assert.ok(r.isError);
      assert.match(r.text, /task_commit_no_pad/);
      assert.strictEqual(stepsOf(s.data.task_id).length, 0, 'no binding row, and no commit row either');
    });
  });
});
