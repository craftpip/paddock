/** Plan 63 — the task-queue MCP SURFACE, called for real.
 *
 *  The 8 task tools are hidden from the production surface by user decision
 *  (2026-09-29): Mission sessions + plans are the workflow and the headless
 *  queue only caused conflicts. So this suite sets `PADDOCK_TASK_QUEUE=1`
 *  BEFORE requiring `../mcp` — that is the flag the comment in mcp.js promises
 *  re-enables them with, and it is the only way to exercise the schemas,
 *  descriptions and handlers the plan is actually about. A vocabulary fix that
 *  is only ever tested against the service would pass while the surface kept
 *  saying `name` for two different things.
 *
 *  Its own throwaway database: the task suite DELETEs every row from `tasks`.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-taskmcp-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'task-mcp.test.db');
process.env.PADDOCK_TASK_QUEUE = '1';
process.on('exit', () => fs.rmSync(DB_DIR, { recursive: true, force: true }));

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, SERVER_NAME, SERVER_VERSION, mcpContext, toolAllowed } = require('../mcp');
const { getDb } = require('../services/db');
const taskRunner = require('../services/task-runner');
const registry = require('../services/agent-registry');

const OWNER = { userId: 'user-1', role: 'user', scopes: ['default'] };

// The name resolver reads the REAL fleet off disk, so the two pads under test
// have to be in it — otherwise every gated call dies at "Agent not found" and
// the tests would pass on the grant path without ever reaching it.
const FLEET = [
  { name: 'pad-tq-a', display_name: 'TQ A', agent_type: 'opencode', runtime_ref: 'pad-tq-a', status: 'running' },
  { name: 'pad-tq-b', display_name: 'TQ B', agent_type: 'opencode', runtime_ref: 'pad-tq-b', status: 'running' },
];
const padRow = (n) => (n === 'pad-tq-a' || n === 'pad-tq-b'
  ? {
    ...FLEET.find((a) => a.name === n),
    workspace_dir: '/mnt/real',
    workspace_mount: { host: '/w', container: '/mnt/real' },
  }
  : null);

function buildServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  registerTools(server);
  return server;
}

describe('MCP task surface (plan 63)', () => {
  let client;
  let server;
  let realDiscover;
  let realGetAgent;

  // Every call runs with an identity: canAccess() reads user.role, and
  // mountMcp always supplies one in production.
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

  const toolByName = async (n) => (await client.listTools()).tools.find((t) => t.name === n);

  before(async () => {
    realDiscover = registry.discoverAgents;
    realGetAgent = registry.getAgent;
    registry.discoverAgents = () => FLEET;
    registry.getAgent = (n) => padRow(n);
    server = buildServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test-client', version: '0' });
    await client.connect(ct);
  });

  after(async () => {
    if (client) await client.close();
    if (server) await server.close();
    registry.discoverAgents = realDiscover;
    registry.getAgent = realGetAgent;
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM tasks').run();
    // canAccess() resolves ownership from the `agents` table, so the pads have
    // to exist there for the grant path to be the real one.
    const db = getDb();
    for (const name of ['pad-tq-a', 'pad-tq-b']) {
      db.prepare(
        `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
         VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'user-1')`
      ).run(name, name, name);
    }
    taskRunner._setForTests({
      resetSeams: true,
      getAgent: padRow,
      isRunning: (ref) => ref === 'pad-tq-a' || ref === 'pad-tq-b',
      folderExists: async () => true,
    });
  });

  it('the flag brings the queue back, plus the new retry tool', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const t of ['task_submit', 'task_get_next', 'task_complete', 'task_retry', 'task_priority', 'task_status', 'task_result', 'task_list', 'task_cancel']) {
      assert.ok(names.includes(t), `has ${t}`);
    }
  });

  // 1a — one parameter, two meanings, was the defect.
  it('1a: task_get_next takes `worker`, and `name` is a hard error not an alias', async () => {
    const t = await toolByName('task_get_next');
    assert.ok(t.inputSchema.properties.worker, 'has worker');
    assert.match(t.inputSchema.properties.worker.description, /claiming/i);

    const bad = await call('task_get_next', { name: 'pad-tq-a' });
    assert.ok(bad.isError || /worker/.test(bad.text), 'passing name is refused, not silently honoured');
    assert.match(bad.text, /PAD a task runs IN|runs IN/, 'and the error says what the two mean');
  });

  it('1a: the two tools document the two meanings of a PAD', async () => {
    const submit = await toolByName('task_submit');
    const get = await toolByName('task_get_next');
    assert.match(submit.inputSchema.properties.name.description, /RUNS IN|opposite/);
    assert.match(get.description, /not a way to look at the queue|task_list/);
  });

  it('1a: every task row carries `route`, and only one spelling of the claimer', async () => {
    const r = await call('task_submit', { name: 'pad-tq-a', prompt: 'x', enqueue: true });
    assert.strictEqual(r.data.task.route, 'enqueued');
    assert.ok(!('claimedBy' in r.data.task), 'no second spelling of claimed_by');
    assert.ok('claimed_by' in r.data.task, 'the row says who claimed it');

    const listed = await call('task_list', {});
    assert.strictEqual(listed.data.tasks[0].route, 'enqueued', 'the list derives it too');
  });

  // 1b + 1c
  it('1b/1c: task_list is in service order and names nextUp without claiming', async () => {
    await call('task_submit', { prompt: 'high', priority: 9 });
    await call('task_submit', { prompt: 'low', priority: 1 });
    const r = await call('task_list', {});
    assert.deepStrictEqual(r.data.tasks.map((t) => t.prompt), ['low', 'high']);
    assert.strictEqual(r.data.nextUp.task_id, r.data.tasks[0].id, 'nextUp is the first row');
    assert.ok(r.data.nextUp.for, 'and says who it is for');
    // The preview must not have claimed anything.
    const stillPending = getDb().prepare("SELECT status FROM tasks WHERE prompt='low'").get();
    assert.strictEqual(stillPending.status, 'pending', 'reading the queue did not consume it');
  });

  it('1c: status + total answer "is the queue complete?" in one read', async () => {
    await call('task_submit', { prompt: 'a' });
    const r = await call('task_list', { status: 'pending' });
    assert.strictEqual(r.data.total, 1);
    assert.strictEqual(r.data.truncated, false);
    assert.ok(r.data.order, 'the order is stated, not implied');

    const empty = await call('task_list', { status: 'pending', limit: 1 });
    assert.strictEqual(empty.data.total, 1);
  });

  it('1c: a cap is distinguishable from an empty queue', async () => {
    for (const p of ['a', 'b', 'c']) await call('task_submit', { prompt: p });
    const r = await call('task_list', { limit: 2 });
    assert.strictEqual(r.data.tasks.length, 2);
    assert.strictEqual(r.data.total, 3);
    assert.strictEqual(r.data.truncated, true);
  });

  // total/truncated were computed from an UNSCOPED count and then compared with
  // the length of the rows this key may see, so they described a different set
  // than the one in `tasks` — a short list read as "that is all of them" and a
  // key that could not see four rows was told the answer was truncated.
  it('1c: total counts what THIS key may see, and truncated compares like with like', async () => {
    await call('task_submit', { name: 'pad-tq-a', prompt: 'mine' });
    await call('task_submit', { name: 'pad-tq-b', prompt: 'theirs' });
    const r = await call('task_list', {});
    assert.strictEqual(r.data.tasks.length, 2, 'both pads belong to user-1');
    assert.strictEqual(r.data.total, 2);
    assert.strictEqual(r.data.truncated, false, 'nothing was hidden, so nothing is truncated');
  });

  it('1c: a stranger sees neither the rows nor the count', async () => {
    await call('task_submit', { name: 'pad-tq-a', prompt: 'mine' });
    await call('task_submit', { prompt: 'shared pool' });
    const stranger = { userId: 'user-9', role: 'user', scopes: ['default'] };
    const r = await call('task_list', {}, stranger);
    assert.deepStrictEqual(r.data.tasks.map((t) => t.prompt), ['shared pool'], 'pool work is shared, owned work is not');
    assert.strictEqual(r.data.total, 1, 'and the total does not leak the row they cannot see');
    assert.strictEqual(r.data.truncated, false);
  });

  // 1d
  it('1d: a pool submit reports the queue and that nobody has claimed work', async () => {
    const r = await call('task_submit', { prompt: 'work' });
    // `route` is the vocabulary: an unclaimed pool task is `pull` — a worker does
    // it itself. The old top-level `mode: 'pool'` and the row's `pull` were two
    // words for the same state, which is the thing this file keeps catching.
    assert.strictEqual(r.data.mode, 'pull');
    assert.strictEqual(r.data.queue.queueLength, 1);
    assert.strictEqual(r.data.queue.position, 1);
    assert.deepStrictEqual(r.data.queue.recentClaimers, [], 'the case that matters is reported');
    assert.match(r.data.note, /inert|nothing runs/i, 'and the response says a pool task does not start itself');
  });

  // The top-level `mode` and the row's `route` must be ONE answer. They were
  // computed from different things (`pad ? push : pool` vs the row), so an
  // addressed enqueue submit said `push` at the top and `enqueued` inside the
  // same response.
  it('1d: mode and route never contradict each other', async () => {
    for (const args of [
      { prompt: 'pool' },
      { name: 'pad-tq-a', prompt: 'push' },
      { name: 'pad-tq-a', prompt: 'enq', enqueue: true },
    ]) {
      const r = await call('task_submit', args);
      assert.strictEqual(r.data.mode, r.data.task.route, `mode === route for ${JSON.stringify(args)}`);
    }
  });

  it('1d: an addressed enqueue submit says it did not start', async () => {
    const r = await call('task_submit', { name: 'pad-tq-a', prompt: 'x', enqueue: true });
    assert.strictEqual(r.data.mode, 'enqueued');
    assert.ok(!r.data.task.pid, 'and nothing is attached to it');
    assert.match(r.data.note, /enqueue was set|did not start/i);
  });

  // 1e — the retry that carried the original's enqueue flag left a row labelled
  // `push` with no child process: a lie written by copying a column.
  it('1e: retrying a push gives a CLAIMABLE task, not an inert "push"', async () => {
    const first = await call('task_submit', { name: 'pad-tq-a', prompt: 'push work' });
    const id = first.data.task_id;
    assert.strictEqual(first.data.task.route, 'push');
    getDb().prepare("UPDATE tasks SET status='error' WHERE id=?").run(id);
    const r = await call('task_retry', { task_id: id });
    assert.strictEqual(r.data.task.route, 'enqueued', 'the label matches what will actually run');
    assert.strictEqual(r.data.task.agent_name, 'pad-tq-a', 'still its own PAD to claim from');
    assert.ok(!r.data.task.pid, 'no process is attached to a re-filed task');
    // And it really is claimable — the route is not just relabelled.
    const claimed = await call('task_get_next', { worker: 'pad-tq-a' });
    assert.strictEqual(claimed.data.task.id, r.data.task_id);
  });

  it('1e: the description says a retry never starts work on its own', async () => {
    const t = await toolByName('task_retry');
    assert.match(t.description, /not a run|never silently starts/i);
    assert.match(t.description, /supersededBy/);
    assert.match(t.description, /attempt/);
  });

  // 1e
  it('1e: task_retry re-files the prompt and links the chain', async () => {
    const first = await call('task_submit', { prompt: 'do it', priority: 4, enqueue: true });
    const id = first.data.task_id;
    getDb().prepare("UPDATE tasks SET status='error' WHERE id=?").run(id);
    const r = await call('task_retry', { task_id: id });
    assert.strictEqual(r.data.task.prompt, 'do it');
    assert.strictEqual(r.data.task.priority, 4);
    assert.strictEqual(r.data.task.attempt, 2);
    assert.strictEqual(r.data.superseded.superseded_by, r.data.task_id);
    assert.strictEqual(r.data.superseded.status, 'error', 'the old row still says how it ended');
  });

  it('1e: a read-only key cannot retry — re-filing starts real work', async () => {
    const reader = { userId: 'user-1', role: 'user', scopes: ['read'] };
    const first = await call('task_submit', { prompt: 'x' });
    getDb().prepare("UPDATE tasks SET status='error' WHERE id=?").run(first.data.task_id);
    const r = await call('task_retry', { task_id: first.data.task_id }, reader);
    assert.ok(r.isError, 'refused');
    assert.strictEqual(toolAllowed(reader, 'task_retry', 'pad-tq-a'), false, 'rides the exec bucket');
  });

  // 1f + 1i
  it('1f/1i: task_status reports outcome, timedOut, exit_code and created_by', async () => {
    const r = await call('task_submit', { name: 'pad-tq-a', prompt: 'x', enqueue: true }, OWNER);
    const s = await call('task_status', { task_id: r.data.task_id });
    assert.strictEqual(s.data.outcome, 'unknown', 'a queued task has no verdict yet');
    assert.strictEqual(s.data.timedOut, false);
    assert.strictEqual(s.data.created_by, 'user-1', 'who filed it is answerable');
    assert.ok('exit_code' in s.data);
    assert.ok('last_output_at' in s.data, 'the heartbeat is visible');
  });

  it('1f: the description says a timeout is an error with a named cause', async () => {
    const t = await toolByName('task_submit');
    assert.match(t.description, /timed out|timeout/i);
    assert.match(t.description, /1 hour/, 'the cap is documented');
  });

  // 1g
  it('1g: created_by is in the list too, not just on submit', async () => {
    await call('task_submit', { prompt: 'x' }, OWNER);
    const r = await call('task_list', {});
    assert.strictEqual(r.data.tasks[0].created_by, 'user-1');
  });

  // 1h
  it('1h: task_complete needs the worker that claimed it', async () => {
    const r = await call('task_submit', { prompt: 'work' });
    const id = r.data.task_id;
    await call('task_get_next', { worker: 'pad-tq-a' });
    // A different PAD reporting on work it never claimed is the case that
    // matters; without a real claim in front of it the refusal would be the
    // weaker `task_not_claimed` and this test would prove nothing.
    const wrong = await call('task_complete', { task_id: id, worker: 'pad-tq-b' });
    assert.ok(wrong.isError, 'a pad that never claimed it is refused');
    assert.match(wrong.text, /task_not_yours|claimed by/);
  });

  it('1h: a task nobody claimed cannot be closed at all', async () => {
    const r = await call('task_submit', { prompt: 'work' });
    const out = await call('task_complete', { task_id: r.data.task_id, worker: 'pad-tq-a' });
    assert.ok(out.isError, 'refused');
    assert.match(out.text, /task_not_claimed|never claimed/);
  });

  it('1h: the claiming worker can finish it', async () => {
    const r = await call('task_submit', { prompt: 'work' });
    await call('task_get_next', { worker: 'pad-tq-a' });
    const done = await call('task_complete', { task_id: r.data.task_id, worker: 'pad-tq-a', summary: 'shipped' });
    assert.strictEqual(done.data.task.status, 'done');
    assert.strictEqual(done.data.task.outcome, 'ok');
  });

  it('1h: the worker name goes through the shared resolver, not a raw string', async () => {
    const r = await call('task_submit', { prompt: 'work' });
    await call('task_get_next', { worker: 'pad-tq-a' });
    // `tq-a` is the display_name spelling of the same PAD; the check must not be
    // dodged by re-spelling it.
    const out = await call('task_complete', { task_id: r.data.task_id, worker: 'tq-a' });
    assert.strictEqual(out.data.task.status, 'done', 'resolved, not refused as a typo');
  });

  // 1i
  it('1i: a clipped prompt carries a marker', async () => {
    await call('task_submit', { prompt: 'z'.repeat(400) });
    const r = await call('task_list', {});
    assert.match(r.data.tasks[0].prompt, /…\[truncated\]$/);
    assert.strictEqual(r.data.tasks[0].prompt_truncated, true);
  });

  it('1i: the description says unknown is not failure', async () => {
    const t = await toolByName('task_status');
    assert.match(t.description, /unknown/i);
    assert.match(t.description, /created_by/);
  });

  // 1j
  it('1j: task_result strips ANSI from captured output', async () => {
    const r = await call('task_submit', { prompt: 'x' });
    const id = r.data.task_id;
    getDb().prepare("UPDATE tasks SET stdout=?, stderr=? WHERE id=?")
      .run('\u001b[32mgreen\u001b[0m text', '\u001b[31mred\u001b[0m', id);
    const res = await call('task_result', { task_id: id });
    assert.strictEqual(res.data.stdout, 'green text');
    assert.strictEqual(res.data.stderr, 'red');
    // The database keeps the raw bytes — stripping is a presentation choice.
    assert.strictEqual(getDb().prepare('SELECT stdout FROM tasks WHERE id=?').get(id).stdout,
      '\u001b[32mgreen\u001b[0m text');
  });

  // 1k
  it('1k: a missing workspace folder refuses the submit with a code', async () => {
    taskRunner._setForTests({ folderExists: async () => false });
    const r = await call('task_submit', { name: 'pad-tq-a', prompt: 'x' });
    assert.ok(r.isError, 'refused rather than launched into a directory that is not there');
    assert.match(r.text, /task_workspace_missing/);
    assert.match(r.text, /\/mnt\/real/, 'and it names the mount that was meant');
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) c FROM tasks').get().c, 0, 'nothing was filed');
  });

  it('1k: the resolved directory is the PAD\'s mount, not the driver default', async () => {
    const seen = [];
    taskRunner._setForTests({ folderExists: async (ref, dir) => { seen.push(dir); return true; } });
    await call('task_submit', { name: 'pad-tq-a', prompt: 'x', enqueue: true });
    assert.deepStrictEqual(seen, ['/mnt/real']);
  });
});
