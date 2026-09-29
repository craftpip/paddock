const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

// This suite DELETEs every row from `tasks` in beforeEach/afterEach, so it ran
// against the live dev database and destroyed the user's real task history on
// every run. Same fix as mission.test.js: a throwaway database, real code path,
// real migrations. Set BEFORE requiring anything that loads db.js, which reads
// the path at module load.
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-tasks-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'tasks.test.db');
process.on('exit', () => fs.rmSync(DB_DIR, { recursive: true, force: true }));

const { getDb } = require('../services/db');
const tasks = require('../services/task-runner');

const AGENTS = {
  'pad-task-a': { name: 'pad-task-a', agent_type: 'opencode', runtime_ref: 'pad-task-a', status: 'running' },
  'pad-task-b': { name: 'pad-task-b', agent_type: 'opencode', runtime_ref: 'pad-task-b', status: 'running' },
  'pad-task-off': { name: 'pad-task-off', agent_type: 'opencode', runtime_ref: 'pad-task-off', status: 'exited' },
  'pad-task-codex': { name: 'pad-task-codex', agent_type: 'codex', runtime_ref: 'pad-task-codex', status: 'running' },
  'pad-task-openclaw': { name: 'pad-task-openclaw', agent_type: 'openclaw', runtime_ref: 'pad-task-openclaw', status: 'running' },
  // A PAD carrying a custom workspace mount (plan 24): its effective workspace is
  // the mount, never the opencode driver default — which is the 1k bug.
  'pad-task-mount': {
    name: 'pad-task-mount', agent_type: 'opencode', runtime_ref: 'pad-task-mount',
    status: 'running', workspace_dir: '/mnt/real',
    workspace_mount: { host: '/www2/paddock', container: '/mnt/real' },
  },
};

const RUNNING = {
  'pad-task-a': true, 'pad-task-b': true, 'pad-task-codex': true,
  'pad-task-openclaw': true, 'pad-task-mount': true,
};

function makeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { end() { return this; } };
  child.killed = false;
  child.killSignals = [];
  child.kill = (sig) => {
    child.killed = true;
    child.killSignals.push(sig || 'SIGTERM');
    return true;
  };
  child.exit = (code, signal) => { child.emit('exit', code, signal); };
  return child;
}

function harness() {
  const children = [];
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push({ cmd, args });
    const child = makeChild(4000 + children.length);
    children.push(child);
    return child;
  };
  return { children, calls, spawn };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  getDb().prepare('DELETE FROM tasks').run();
  tasks._setForTests({
    resetSeams: true,
    getAgent: (name) => AGENTS[name] || null,
    isRunning: (ref) => !!RUNNING[ref],
    // Every pad's workspace folder exists unless a test says otherwise. Without
    // this seam the 1k gate would shell out to a real `docker exec` per submit.
    folderExists: async () => true,
  });
});

afterEach(() => {
  tasks._setForTests({ resetRunning: true });
  getDb().prepare('DELETE FROM tasks').run();
});

describe('Task queue - schema', () => {
  it('creates the tasks table with the documented columns', async () => {
    const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    assert.ok(tables.includes('tasks'), 'tasks table exists');
    const cols = getDb().prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    for (const col of [
      'id', 'agent_name', 'prompt', 'model', 'agent_type', 'status', 'priority',
      'pid', 'claimed_by', 'exit_code', 'stdout', 'stderr', 'result_summary',
      'created_by', 'created_at', 'started_at', 'finished_at', 'last_output_at',
      // Plan 63: the FACTS the agent-facing vocabulary is derived from. Only
      // these are columns — `route`, `outcome` and `timedOut` are not, and a
      // test that let one of them become a column would be the defect returning.
      'enqueue', 'timeout_ms', 'timed_out', 'attempt', 'superseded_by',
    ]) {
      assert.ok(cols.includes(col), `tasks has ${col}`);
    }
    for (const derived of ['route', 'outcome', 'timedOut', 'claimedBy']) {
      assert.ok(!cols.includes(derived), `tasks does NOT store ${derived} — it is derived`);
    }
  });

  it('has no foreign key on agent_name so history survives PAD deletion', async () => {
    const db = getDb();
    assert.doesNotThrow(() => {
      db.prepare('INSERT INTO tasks (id, agent_name, prompt, created_at) VALUES (?,?,?,datetime(\'now\'))')
        .run('t-nofk', 'pad-deleted-long-ago', 'x');
    }, 'a task may reference a PAD that no longer exists');
    db.prepare('DELETE FROM tasks WHERE id = ?').run('t-nofk');
  });

  it('writes datetime(\'now\') timestamps, never ISO strings', () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, prompt, created_at) VALUES ('t-ts','x',datetime('now'))").run();
    const row = db.prepare('SELECT created_at FROM tasks WHERE id = ?').get('t-ts');
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'SQL datetime format');
  });
});

describe('Task queue - command construction', () => {
  it('always passes --format json and the driver workspace dir', async () => {
    const cmd = tasks.buildCommand('opencode', 'do the thing', { workspaceDir: '/root/.opencode/workspace' });
    assert.ok(cmd.includes('--format json'), 'json format');
    assert.ok(cmd.includes("--dir '/root/.opencode/workspace'"), 'workspace dir');
    assert.ok(cmd.includes('opencode run'), 'opencode run');
  });

  it('adds --model, --agent and --auto only when asked', async () => {
    const bare = tasks.buildCommand('opencode', 'x', { workspaceDir: '/ws' });
    assert.ok(!bare.includes('--model'), 'no model');
    assert.ok(!bare.includes('--agent'), 'no agent');
    assert.ok(!bare.includes('--auto'), 'no auto');
    const full = tasks.buildCommand('opencode', 'x', { workspaceDir: '/ws', model: 'anthropic/claude', agent: 'build', autoApprove: true });
    assert.ok(full.includes("--model 'anthropic/claude'"), 'model');
    assert.ok(full.includes("--agent 'build'"), 'agent');
    assert.ok(full.includes('--auto'), 'auto');
  });

  it('shell-quotes single quotes in the prompt', async () => {
    const cmd = tasks.buildCommand('opencode', "don't break it", { workspaceDir: '/ws' });
    assert.ok(cmd.includes(`'don'\\''t break it'`), `escaped single quote in: ${cmd}`);
  });

  it('keeps a dash-leading prompt after the -- separator', async () => {
    const cmd = tasks.buildCommand('opencode', '-rf /', { workspaceDir: '/ws' });
    assert.ok(cmd.includes("-- '-rf /'"), `separator in: ${cmd}`);
  });
});

describe('Task queue - submit pre-checks', () => {
  it('rejects an unknown PAD', async () => {
    await assert.rejects(tasks.submitTask({ name: 'pad-nope', prompt: 'x' }), /Agent not found/);
  });

  it('rejects a stopped PAD', async () => {
    await assert.rejects(tasks.submitTask({ name: 'pad-task-off', prompt: 'x' }), /not running/);
  });

  it('rejects a PAD whose type has no task capability', async () => {
    // Task submission is an opencode/codex capability; openclaw cannot run one.
    await assert.rejects(tasks.submitTask({ name: 'pad-task-openclaw', prompt: 'x' }), /openclaw/);
  });

  it('accepts codex, which gained task support', async () => {
    await assert.doesNotReject(tasks.submitTask({ name: 'pad-task-codex', prompt: 'x', enqueue: true }), 'codex is a task-capable type');
  });

  it('rejects an empty prompt and inserts nothing', async () => {
    await assert.rejects(tasks.submitTask({ name: 'pad-task-a', prompt: '   ' }), /prompt/);
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) c FROM tasks').get().c, 0);
  });

  it('accepts a pool task with no PAD and no spawn', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ prompt: 'pool work', priority: 3 });
    const row = tasks.getTask(id);
    assert.strictEqual(row.agent_name, null, 'unassigned pool row');
    assert.strictEqual(row.priority, 3, 'rank kept');
    assert.strictEqual(row.status, 'pending', 'pending');
    assert.strictEqual(h.calls.length, 0, 'no spawn for a pool task');
  });
});

describe('Task queue - push execution', () => {
  it('spawns docker exec with the tagged opencode run command', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'write hello.txt', model: 'anthropic/claude' });
    assert.strictEqual(h.calls.length, 1);
    const { cmd, args } = h.calls[0];
    assert.strictEqual(cmd, 'docker');
    assert.deepStrictEqual(args.slice(0, 4), ['exec', '-i', 'pad-task-a', 'sh']);
    assert.strictEqual(args[4], '-lc');
    assert.ok(args[5].includes('exec opencode run'), `exec shim in: ${args[5]}`);
    assert.ok(args[5].includes("--dir '/root/.opencode/workspace'"), 'runs in the agent workspace');
    assert.ok(args[5].includes(`PADDOCK_TASK_ID=${id}`), 'process carries its task tag');
    assert.ok(args[5].includes(`/tmp/paddock-task-${id}.pid`), 'pidfile for the kill path');
    assert.strictEqual(tasks.getTask(id).agent_name, 'pad-task-a');
  });

  it('is running with a pid while in flight', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'running');
    assert.strictEqual(row.pid, 4000);
    assert.ok(row.started_at, 'started_at set at spawn');
  });

  it('marks done and captures stdout on exit 0', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write('all done\n');
    h.children[0].exit(0);
    await sleep(20);
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(row.exit_code, 0);
    assert.strictEqual(row.stdout, 'all done\n');
    assert.ok(row.finished_at, 'finished_at set');
  });

  it('marks error and captures stderr on non-zero exit', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stderr.write('boom\n');
    h.children[0].exit(1);
    await sleep(20);
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.exit_code, 1);
    assert.strictEqual(row.stderr, 'boom\n');
  });

  it('extracts the final assistant text into result_summary', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write(JSON.stringify({ type: 'text', text: 'partial' }) + '\n');
    h.children[0].stdout.write(JSON.stringify({ type: 'text', text: 'the answer' }) + '\n');
    h.children[0].exit(0);
    await sleep(20);
    const row = tasks.getTask(id);
    assert.strictEqual(row.result_summary, 'the answer', 'last text event wins');
    assert.ok(row.stdout.includes('partial'), 'raw stream kept');
  });

  it('extracts the live nested part.text shape', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }) + '\n');
    h.children[0].stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'Done.' } }) + '\n');
    h.children[0].exit(0);
    await sleep(20);
    assert.strictEqual(tasks.getTask(id).result_summary, 'Done.');
  });

  it('falls back to raw output when the json stream cannot be parsed', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write('not json at all\n');
    h.children[0].exit(0);
    await sleep(20);
    const row = tasks.getTask(id);
    assert.strictEqual(row.result_summary, 'not json at all');
  });

  it('caps stdout at the byte limit with a truncation marker', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write('x'.repeat(600 * 1024));
    h.children[0].exit(0);
    await sleep(40);
    const row = tasks.getTask(id);
    assert.ok(Buffer.byteLength(row.stdout, 'utf8') <= tasks.MAX_OUTPUT_BYTES, 'within the cap');
    assert.ok(row.stdout.includes('truncated'), 'marker present');
  });
});

describe('Task queue - cancellation and timeout', () => {
  it('builds the kill script around the task tag, verified before signalling', async () => {
    const script = tasks.buildKillScript('abc-123', 'TERM');
    assert.ok(script.includes('/tmp/paddock-task-abc-123.pid'), 'pidfile path');
    assert.ok(script.includes('PADDOCK_TASK_ID=abc-123'), 'env tag');
    assert.ok(script.includes('/proc/$PID/environ'), 'verifies identity, safe against PID reuse');
    assert.ok(script.includes('kill -TERM'), 'TERM signal');
    assert.ok(!script.includes('KILL'), 'no KILL in the TERM pass');
    assert.ok(tasks.buildKillScript('abc-123', 'KILL').includes('kill -KILL'), 'KILL fallback');
  });

  it('cancel marks cancelled and signals the process', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    tasks.cancelTask(id);
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'cancelled');
    assert.ok(h.children[0].killSignals.includes('SIGTERM'), `signals: ${h.children[0].killSignals}`);
  });

  it('cancel also sweeps the container-side process', async () => {
    const h = harness();
    const kills = [];
    tasks._setForTests({ spawn: h.spawn, containerExec: (ref, script, cb) => { kills.push({ ref, script }); if (cb) cb(null); } });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    tasks.cancelTask(id);
    assert.strictEqual(kills.length, 1, 'one container sweep fired');
    assert.strictEqual(kills[0].ref, 'pad-task-a', 'sweeps the right container');
    assert.ok(kills[0].script.includes(id), 'sweep is scoped to this task id');
    assert.ok(kills[0].script.includes('kill -TERM'), 'TERM first');
  });

  it('a late exit cannot regress a cancelled task', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    tasks.cancelTask(id);
    h.children[0].exit(0);
    await sleep(20);
    assert.strictEqual(tasks.getTask(id).status, 'cancelled');
  });

  it('kills a task that overruns its timeout', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x', timeout: 40 });
    await sleep(120);
    const row = tasks.getTask(id);
    // A timeout is an error with a named cause, not a cancel (plan 63 1f): the
    // two used to land on the same status, so the only way to tell them apart
    // was to read stderr for a summary that never mentioned one.
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.timed_out, 1, 'timed_out flags the cause');
    assert.match(row.result_summary, /timed out after 40ms/, 'the summary says how long it was given');
    assert.strictEqual(tasks.taskOutcome(row), 'failed', 'a timeout is a failure, not an unknown');
    assert.ok(h.children[0].killed, 'process was signalled');
  });

  it('a user cancel is NOT a timeout', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    tasks.cancelTask(id);
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'cancelled');
    assert.strictEqual(row.timed_out, 0, 'the two causes must not read the same');
    assert.strictEqual(tasks.taskOutcome(row), 'unknown', 'cancelled is neither ok nor failed');
  });
});

describe('Task queue - pull loop', () => {
  it('serves the highest priority first and breaks ties FIFO', async () => {
    await tasks.submitTask({ prompt: 'low', priority: 9 });
    await tasks.submitTask({ prompt: 'first', priority: 1 });
    await tasks.submitTask({ prompt: 'second', priority: 1 });
    assert.strictEqual(tasks.claimNextTask('pad-task-a').prompt, 'first');
    assert.strictEqual(tasks.claimNextTask('pad-task-b').prompt, 'second');
    assert.strictEqual(tasks.claimNextTask('pad-task-a').prompt, 'low');
  });

  it('never hands the same task to two workers', async () => {
    await tasks.submitTask({ prompt: 'only one' });
    const first = tasks.claimNextTask('pad-task-a');
    const second = tasks.claimNextTask('pad-task-b');
    assert.ok(first, 'first worker got it');
    assert.strictEqual(second, null, 'second worker gets nothing');
  });

  it('claims a task as running for the claiming pad', async () => {
    const id = await tasks.submitTask({ prompt: 'work' });
    const claimed = tasks.claimNextTask('pad-task-b');
    assert.strictEqual(claimed.id, id);
    assert.strictEqual(claimed.status, 'running');
    assert.strictEqual(claimed.claimed_by, 'pad-task-b');
    assert.ok(claimed.started_at, 'started_at set on claim');
  });

  it('keeps a pre-assigned task away from other pads', async () => {
    await tasks.submitTask({ name: 'pad-task-a', prompt: 'for a only', enqueue: true });
    assert.strictEqual(tasks.claimNextTask('pad-task-b'), null);
    assert.strictEqual(tasks.claimNextTask('pad-task-a').prompt, 'for a only');
  });

  it('enqueue files an addressed task without spawning', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'later', enqueue: true });
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.agent_name, 'pad-task-a');
    assert.strictEqual(h.calls.length, 0, 'no spawn in enqueue mode');
  });

  it('completes a claimed task and records the summary', async () => {
    const id = await tasks.submitTask({ prompt: 'work' });
    tasks.claimNextTask('pad-task-a');
    const row = tasks.completeTask(id, { status: 'done', summary: 'shipped it' });
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(row.result_summary, 'shipped it');
    assert.ok(row.finished_at, 'finished_at set');
  });

  it('maps a failed completion onto the error status', async () => {
    const id = await tasks.submitTask({ prompt: 'work' });
    tasks.claimNextTask('pad-task-a');
    assert.strictEqual(tasks.completeTask(id, { status: 'failed', summary: 'nope' }).status, 'error');
  });

  it('refuses to complete a task that is already terminal', async () => {
    const id = await tasks.submitTask({ prompt: 'work' });
    tasks.claimNextTask('pad-task-a');
    tasks.completeTask(id, { status: 'done' });
    assert.throws(() => tasks.completeTask(id, { status: 'done' }), /not in a claimable state/);
  });

  it('refuses an unknown task', async () => {
    assert.throws(() => tasks.completeTask('nope', { status: 'done' }), /Task not found/);
  });

  it('re-ranks only pending tasks', async () => {
    const id = await tasks.submitTask({ prompt: 'work', priority: 5 });
    assert.strictEqual(tasks.setPriority(id, 1).priority, 1);
    tasks.claimNextTask('pad-task-a');
    assert.throws(() => tasks.setPriority(id, 0), /Only pending tasks/);
  });

  it('lists tasks for one pad and honours the limit', async () => {
    await tasks.submitTask({ name: 'pad-task-a', prompt: 'a1' });
    await tasks.submitTask({ name: 'pad-task-b', prompt: 'b1' });
    await tasks.submitTask({ name: 'pad-task-b', prompt: 'b2' });
    const forA = tasks.listTasks({ pad: 'pad-task-a' });
    assert.strictEqual(forA.length, 1);
    assert.strictEqual(forA[0].prompt, 'a1');
    assert.strictEqual(tasks.listTasks({ pad: 'pad-task-b', limit: 1 }).length, 1);
    assert.strictEqual(tasks.listTasks({}).length, 3);
  });
});

describe('Task queue - boot reconciliation', () => {
  it('flips orphaned running tasks to error', async () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, prompt, status, created_at) VALUES ('t-orphan','x','running',datetime('now'))").run();
    tasks.reconcileOrphanedTasks();
    const row = tasks.getTask('t-orphan');
    assert.strictEqual(row.status, 'error');
    assert.ok(row.finished_at, 'finished_at set');
    assert.match(row.result_summary, /restart/);
  });

  it('leaves finished tasks alone', async () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, prompt, status, created_at) VALUES ('t-done','x','done',datetime('now'))").run();
    tasks.reconcileOrphanedTasks();
    assert.strictEqual(tasks.getTask('t-done').status, 'done');
  });
});

describe('Task queue - output capping', () => {
  it('leaves short output untouched', async () => {
    assert.strictEqual(tasks.capOutput('short'), 'short');
  });

  it('never splits a multibyte character at the boundary', async () => {
    const out = tasks.capOutput('é'.repeat(400 * 1024));
    assert.ok(Buffer.byteLength(out, 'utf8') <= tasks.MAX_OUTPUT_BYTES);
    assert.ok(!/[\uD800-\uDFFF]/.test(out), 'no lone surrogate left behind');
  });
});

// ─── Plan 63: the queue's own vocabulary ────────────────────────────────

describe('Task queue - 1a: route says who is doing the work', () => {
  it('a push task is the PAD running it itself', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    assert.strictEqual(tasks.taskRoute(tasks.getTask(id)), 'push');
  });

  it('a task filed for claiming is enqueued, not pushed', async () => {
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x', enqueue: true });
    assert.strictEqual(tasks.taskRoute(tasks.getTask(id)), 'enqueued');
  });

  it('a pool task is pull, and a CLAIMED task is pull whatever it was filed as', async () => {
    // The pool task is filed LAST on priority so the addressed one is served
    // first — the claim takes one task, and this is about the addressed one.
    await tasks.submitTask({ prompt: 'x', priority: 9 });
    const addressed = await tasks.submitTask({ name: 'pad-task-a', prompt: 'y', enqueue: true });
    assert.strictEqual(tasks.taskRoute(tasks.getTask(addressed)), 'enqueued');
    tasks.claimNextTask('pad-task-a');
    assert.strictEqual(tasks.taskRoute(tasks.getTask(addressed)), 'pull');
  });

  it('a claimed row already says who claimed it — no second spelling', async () => {
    const id = await tasks.submitTask({ prompt: 'x' });
    tasks.claimNextTask('pad-task-b');
    const row = tasks.getTask(id);
    assert.strictEqual(row.claimed_by, 'pad-task-b');
    // The projection adds nothing called claimedBy: two names for one value is
    // the ambiguity this plan exists to remove.
    assert.ok(!('claimedBy' in row), 'no duplicate claimedBy field on the row');
  });
});

describe('Task queue - 1b: the list is the work order', () => {
  it('serves pending first by priority, then history newest-first', async () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id,prompt,status,priority,created_at) VALUES ('f1','old done','done',0,datetime('now','-2 hours'))").run();
    db.prepare("INSERT INTO tasks (id,prompt,status,priority,created_at) VALUES ('f2','new done','done',0,datetime('now','-1 hour'))").run();
    await tasks.submitTask({ prompt: 'pending high', priority: 9 });
    await tasks.submitTask({ prompt: 'pending low', priority: 1 });
    assert.deepStrictEqual(
      tasks.listTasks({}).map((t) => t.prompt),
      ['pending low', 'pending high', 'new done', 'old done'],
      'the queue comes first in service order, history stays newest-first'
    );
  });

  it('nextUp names the task the claim actually serves', async () => {
    await tasks.submitTask({ prompt: 'low', priority: 9 });
    await tasks.submitTask({ prompt: 'first', priority: 1 });
    const preview = tasks.nextUpTask('pad-task-a');
    assert.strictEqual(preview.prompt, 'first', 'the preview picks the same row');
    assert.strictEqual(preview.status, 'pending', 'and the preview does not claim it');
    assert.strictEqual(tasks.claimNextTask('pad-task-a').id, preview.id, 'the claim agrees with the preview');
  });

  it('a PAD-filtered nextUp includes tasks addressed to that PAD', async () => {
    await tasks.submitTask({ name: 'pad-task-b', prompt: 'for b only', enqueue: true });
    assert.strictEqual(tasks.nextUpTask('pad-task-a'), null, 'not claimable by a');
    assert.strictEqual(tasks.nextUpTask('pad-task-b').prompt, 'for b only');
  });

  it('an unfiltered nextUp names a POOL task, never one addressed to a PAD', async () => {
    await tasks.submitTask({ name: 'pad-task-b', prompt: 'addressed', enqueue: true });
    assert.strictEqual(tasks.nextUpTask(null), null,
      'an arbitrary worker cannot take a task addressed to one PAD — naming it would be a lie');
  });
});

describe('Task queue - 1c: the queue is readable without claiming', () => {
  it('status filters and total count every match, not just the page', async () => {
    await tasks.submitTask({ prompt: 'p1' });
    await tasks.submitTask({ prompt: 'p2' });
    const db = getDb();
    db.prepare("UPDATE tasks SET status='done' WHERE prompt='p2'").run();
    assert.strictEqual(tasks.countTasks({}), 2, 'everything');
    assert.strictEqual(tasks.countTasks({ status: 'pending' }), 1, 'pending only');
    assert.strictEqual(tasks.listTasks({ status: 'pending' }).length, 1);
  });

  it('a capped list still reports the true total', async () => {
    for (const p of ['a', 'b', 'c']) await tasks.submitTask({ prompt: p });
    const rows = tasks.listTasks({ limit: 2 });
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(tasks.countTasks({}), 3, 'the caller can tell a cap from an empty queue');
  });
});

describe('Task queue - 1d: a filed pool task is inert, and says so', () => {
  it('reports the queue it landed in and who has actually claimed work', async () => {
    const id = await tasks.submitTask({ prompt: 'work', priority: 4 });
    const st = tasks.queueState();
    assert.strictEqual(st.queueLength, 1);
    assert.strictEqual(tasks.queuePosition(id), 1);
    assert.deepStrictEqual(st.recentClaimers, [], 'nobody has claimed work — the case that matters');
    assert.ok(st.recentClaimerWindowMin > 0, 'the window is stated, not implied');
  });

  it('position counts only what is ahead of it, in service order', async () => {
    await tasks.submitTask({ prompt: 'first', priority: 1 });
    const second = await tasks.submitTask({ prompt: 'second', priority: 5 });
    const third = await tasks.submitTask({ prompt: 'third', priority: 5 });
    assert.strictEqual(tasks.queuePosition(second), 2);
    assert.strictEqual(tasks.queuePosition(third), 3, 'a tie is broken FIFO, and the position says so');
  });

  it('a PAD-addressed task is not counted as pool depth', async () => {
    await tasks.submitTask({ name: 'pad-task-a', prompt: 'x', enqueue: true });
    assert.strictEqual(tasks.queueState().queueLength, 0, 'only pool tasks are the shared queue');
  });

  it('a pad that claimed inside the window shows up', async () => {
    await tasks.submitTask({ prompt: 'work' });
    tasks.claimNextTask('pad-task-worker');
    assert.deepStrictEqual(tasks.queueState().recentClaimers, ['pad-task-worker']);
  });
});

describe('Task queue - 1e: an errored task has a retry', () => {
  it('re-files the identical prompt as a new task and links the chain', async () => {
    const first = await tasks.submitTask({ prompt: 'do the thing', priority: 3, enqueue: true });
    getDb().prepare("UPDATE tasks SET status='error' WHERE id=?").run(first);
    const { task: fresh, superseded } = tasks.retryTask(first);
    assert.strictEqual(fresh.prompt, 'do the thing', 'the same prompt');
    assert.strictEqual(fresh.priority, 3, 'the same rank');
    assert.strictEqual(fresh.status, 'pending', 'the retry is a real queued task');
    assert.strictEqual(fresh.attempt, 2, 'attempt counts the chain');
    assert.strictEqual(superseded.superseded_by, fresh.id, 'the old row points at its retry');
    assert.strictEqual(superseded.status, 'error', 'the old row still says how it ended');
  });

  it('keeps counting attempts across repeated failures', async () => {
    let id = await tasks.submitTask({ prompt: 'flaky' });
    for (let i = 0; i < 3; i++) {
      getDb().prepare("UPDATE tasks SET status='error' WHERE id=?").run(id);
      id = tasks.retryTask(id).task.id;
    }
    assert.strictEqual(tasks.getTask(id).attempt, 4);
  });

  it('a retry preserves the filing mode, so it cannot silently start a spawn', async () => {
    const pool = await tasks.submitTask({ prompt: 'x' });
    getDb().prepare("UPDATE tasks SET status='error' WHERE id=?").run(pool);
    const { task } = tasks.retryTask(pool);
    assert.strictEqual(task.agent_name, null, 'still a pool task');
    assert.strictEqual(tasks.taskRoute(task), 'pull');
  });

  it('refuses to retry a task that is still pending or running', async () => {
    const id = await tasks.submitTask({ prompt: 'x' });
    await assert.rejects(async () => tasks.retryTask(id), /task_still_active/);
  });
});

describe('Task queue - 1h: only the claimer may close a task', () => {
  it('refuses a task nobody claimed', async () => {
    const id = await tasks.submitTask({ prompt: 'x' });
    assert.throws(() => tasks.completeTask(id, { status: 'done', worker: 'pad-task-a' }),
      /task_not_claimed/);
  });

  it('refuses a worker that did not claim it', async () => {
    const id = await tasks.submitTask({ prompt: 'x' });
    tasks.claimNextTask('pad-task-a');
    assert.throws(() => tasks.completeTask(id, { status: 'done', worker: 'pad-task-b' }),
      /task_not_yours/);
  });

  it('lets the claiming worker finish it', async () => {
    const id = await tasks.submitTask({ prompt: 'x' });
    tasks.claimNextTask('pad-task-a');
    const row = tasks.completeTask(id, { status: 'done', summary: 'shipped', worker: 'pad-task-a' });
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(tasks.taskOutcome(row), 'ok');
  });
});

describe('Task queue - 1i: a finished row carries evidence', () => {
  it('outcome settles ok / failed / unknown', async () => {
    assert.strictEqual(tasks.taskOutcome({ status: 'done' }), 'ok');
    assert.strictEqual(tasks.taskOutcome({ status: 'error' }), 'failed');
    assert.strictEqual(tasks.taskOutcome({ status: 'cancelled' }), 'unknown', 'cancelled is neither');
    assert.strictEqual(tasks.taskOutcome({ status: 'running' }), 'unknown', 'running is not a verdict');
  });

  it('a push task records the real exit code', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = await tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write('all done\n');
    h.children[0].exit(0);
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(row.exit_code, 0, 'a done row has evidence it ran');
  });

  it('a pull task has no exit code and says so through outcome', async () => {
    const id = await tasks.submitTask({ prompt: 'x' });
    tasks.claimNextTask('pad-task-a');
    const row = tasks.completeTask(id, { status: 'done', summary: 'done by hand', worker: 'pad-task-a' });
    assert.strictEqual(row.exit_code, null, 'no process ran, so there is no code to invent');
    assert.strictEqual(tasks.taskOutcome(row), 'ok', 'the verdict does not need one');
  });
});

describe('Task queue - 1j: no escape soup in a result', () => {
  it('strips SGR colour codes', async () => {
    assert.strictEqual(tasks.stripAnsi('\u001b[32mok\u001b[0m'), 'ok');
    assert.strictEqual(tasks.stripAnsi('a\u001b[1;31mb\u001b[0mc'), 'abc');
  });

  it('strips OSC strings and a bare two-char escape', async () => {
    assert.strictEqual(tasks.stripAnsi('\u001b]0;title\u0007text'), 'text');
    assert.strictEqual(tasks.stripAnsi('x\u001bMy'), 'xy');
  });

  it('leaves ordinary text and non-SGR content alone', async () => {
    assert.strictEqual(tasks.stripAnsi('plain [not] an escape'), 'plain [not] an escape');
    assert.strictEqual(tasks.stripAnsi(null), '');
  });
});

describe('Task queue - 1k: the cwd is the PAD\'s, and it must exist', () => {
  it('uses the PAD\'s effective workspace, not the driver default', async () => {
    const seen = [];
    tasks._setForTests({ folderExists: async (ref, dir) => { seen.push([ref, dir]); return true; } });
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    await tasks.submitTask({ name: 'pad-task-mount', prompt: 'x' });
    assert.deepStrictEqual(seen, [['pad-task-mount', '/mnt/real']], 'probed the mount, not /root/.opencode/workspace');
    assert.ok(h.calls[0].args.join(' ').includes("--dir '/mnt/real'"),
      'and the command was built with the same directory it probed');
  });

  it('refuses with a code naming the mount when the folder is not there', async () => {
    tasks._setForTests({ folderExists: async () => false });
    await assert.rejects(
      tasks.submitTask({ name: 'pad-task-mount', prompt: 'x' }),
      /task_workspace_missing/
    );
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) c FROM tasks').get().c, 0,
      'a refused submit files nothing');
  });

  it('a pool task needs no workspace and is not probed', async () => {
    let probed = 0;
    tasks._setForTests({ folderExists: async () => { probed++; return false; } });
    await tasks.submitTask({ prompt: 'x' });
    assert.strictEqual(probed, 0, 'there is no PAD to probe for a pool task');
  });
});
