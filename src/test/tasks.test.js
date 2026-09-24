const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { getDb } = require('../services/db');
const tasks = require('../services/task-runner');

const AGENTS = {
  'pad-task-a': { name: 'pad-task-a', agent_type: 'opencode', runtime_ref: 'pad-task-a', status: 'running' },
  'pad-task-b': { name: 'pad-task-b', agent_type: 'opencode', runtime_ref: 'pad-task-b', status: 'running' },
  'pad-task-off': { name: 'pad-task-off', agent_type: 'opencode', runtime_ref: 'pad-task-off', status: 'exited' },
  'pad-task-codex': { name: 'pad-task-codex', agent_type: 'codex', runtime_ref: 'pad-task-codex', status: 'running' },
};

const RUNNING = { 'pad-task-a': true, 'pad-task-b': true, 'pad-task-codex': true };

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
  });
});

afterEach(() => {
  tasks._setForTests({ resetRunning: true });
  getDb().prepare('DELETE FROM tasks').run();
});

describe('Task queue - schema', () => {
  it('creates the tasks table with the documented columns', () => {
    const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    assert.ok(tables.includes('tasks'), 'tasks table exists');
    const cols = getDb().prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
    for (const col of [
      'id', 'agent_name', 'prompt', 'model', 'agent_type', 'status', 'priority',
      'pid', 'claimed_by', 'exit_code', 'stdout', 'stderr', 'result_summary',
      'created_by', 'created_at', 'started_at', 'finished_at',
    ]) {
      assert.ok(cols.includes(col), `tasks has ${col}`);
    }
  });

  it('has no foreign key on agent_name so history survives PAD deletion', () => {
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
  it('always passes --format json and the driver workspace dir', () => {
    const cmd = tasks.buildCommand('do the thing', { workspaceDir: '/root/.opencode/workspace' });
    assert.ok(cmd.includes('--format json'), 'json format');
    assert.ok(cmd.includes("--dir '/root/.opencode/workspace'"), 'workspace dir');
    assert.ok(cmd.includes('opencode run'), 'opencode run');
  });

  it('adds --model, --agent and --auto only when asked', () => {
    const bare = tasks.buildCommand('x', { workspaceDir: '/ws' });
    assert.ok(!bare.includes('--model'), 'no model');
    assert.ok(!bare.includes('--agent'), 'no agent');
    assert.ok(!bare.includes('--auto'), 'no auto');
    const full = tasks.buildCommand('x', { workspaceDir: '/ws', model: 'anthropic/claude', agent: 'build', autoApprove: true });
    assert.ok(full.includes("--model 'anthropic/claude'"), 'model');
    assert.ok(full.includes("--agent 'build'"), 'agent');
    assert.ok(full.includes('--auto'), 'auto');
  });

  it('shell-quotes single quotes in the prompt', () => {
    const cmd = tasks.buildCommand("don't break it", { workspaceDir: '/ws' });
    assert.ok(cmd.includes(`'don'\\''t break it'`), `escaped single quote in: ${cmd}`);
  });

  it('keeps a dash-leading prompt after the -- separator', () => {
    const cmd = tasks.buildCommand('-rf /', { workspaceDir: '/ws' });
    assert.ok(cmd.includes("-- '-rf /'"), `separator in: ${cmd}`);
  });
});

describe('Task queue - submit pre-checks', () => {
  it('rejects an unknown PAD', () => {
    assert.throws(() => tasks.submitTask({ name: 'pad-nope', prompt: 'x' }), /Agent not found/);
  });

  it('rejects a stopped PAD', () => {
    assert.throws(() => tasks.submitTask({ name: 'pad-task-off', prompt: 'x' }), /not running/);
  });

  it('rejects a non-opencode PAD', () => {
    assert.throws(() => tasks.submitTask({ name: 'pad-task-codex', prompt: 'x' }), /opencode/);
  });

  it('rejects an empty prompt and inserts nothing', () => {
    assert.throws(() => tasks.submitTask({ name: 'pad-task-a', prompt: '   ' }), /prompt/);
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) c FROM tasks').get().c, 0);
  });

  it('accepts a pool task with no PAD and no spawn', () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ prompt: 'pool work', priority: 3 });
    const row = tasks.getTask(id);
    assert.strictEqual(row.agent_name, null, 'unassigned pool row');
    assert.strictEqual(row.priority, 3, 'rank kept');
    assert.strictEqual(row.status, 'pending', 'pending');
    assert.strictEqual(h.calls.length, 0, 'no spawn for a pool task');
  });
});

describe('Task queue - push execution', () => {
  it('spawns docker exec with the tagged opencode run command', () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'write hello.txt', model: 'anthropic/claude' });
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

  it('is running with a pid while in flight', () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'running');
    assert.strictEqual(row.pid, 4000);
    assert.ok(row.started_at, 'started_at set at spawn');
  });

  it('marks done and captures stdout on exit 0', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
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
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
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
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
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
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write(JSON.stringify({ type: 'step_start', part: { type: 'step-start' } }) + '\n');
    h.children[0].stdout.write(JSON.stringify({ type: 'text', part: { type: 'text', text: 'Done.' } }) + '\n');
    h.children[0].exit(0);
    await sleep(20);
    assert.strictEqual(tasks.getTask(id).result_summary, 'Done.');
  });

  it('falls back to raw output when the json stream cannot be parsed', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write('not json at all\n');
    h.children[0].exit(0);
    await sleep(20);
    const row = tasks.getTask(id);
    assert.strictEqual(row.result_summary, 'not json at all');
  });

  it('caps stdout at the byte limit with a truncation marker', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    h.children[0].stdout.write('x'.repeat(600 * 1024));
    h.children[0].exit(0);
    await sleep(40);
    const row = tasks.getTask(id);
    assert.ok(Buffer.byteLength(row.stdout, 'utf8') <= tasks.MAX_OUTPUT_BYTES, 'within the cap');
    assert.ok(row.stdout.includes('truncated'), 'marker present');
  });
});

describe('Task queue - cancellation and timeout', () => {
  it('builds the kill script around the task tag, verified before signalling', () => {
    const script = tasks.buildKillScript('abc-123', 'TERM');
    assert.ok(script.includes('/tmp/paddock-task-abc-123.pid'), 'pidfile path');
    assert.ok(script.includes('PADDOCK_TASK_ID=abc-123'), 'env tag');
    assert.ok(script.includes('/proc/$PID/environ'), 'verifies identity, safe against PID reuse');
    assert.ok(script.includes('kill -TERM'), 'TERM signal');
    assert.ok(!script.includes('KILL'), 'no KILL in the TERM pass');
    assert.ok(tasks.buildKillScript('abc-123', 'KILL').includes('kill -KILL'), 'KILL fallback');
  });

  it('cancel marks cancelled and signals the process', () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    tasks.cancelTask(id);
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'cancelled');
    assert.ok(h.children[0].killSignals.includes('SIGTERM'), `signals: ${h.children[0].killSignals}`);
  });

  it('cancel also sweeps the container-side process', () => {
    const h = harness();
    const kills = [];
    tasks._setForTests({ spawn: h.spawn, containerExec: (ref, script, cb) => { kills.push({ ref, script }); if (cb) cb(null); } });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    tasks.cancelTask(id);
    assert.strictEqual(kills.length, 1, 'one container sweep fired');
    assert.strictEqual(kills[0].ref, 'pad-task-a', 'sweeps the right container');
    assert.ok(kills[0].script.includes(id), 'sweep is scoped to this task id');
    assert.ok(kills[0].script.includes('kill -TERM'), 'TERM first');
  });

  it('a late exit cannot regress a cancelled task', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x' });
    tasks.cancelTask(id);
    h.children[0].exit(0);
    await sleep(20);
    assert.strictEqual(tasks.getTask(id).status, 'cancelled');
  });

  it('kills a task that overruns its timeout', async () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'x', timeout: 40 });
    await sleep(120);
    assert.strictEqual(tasks.getTask(id).status, 'cancelled');
    assert.ok(h.children[0].killed, 'process was signalled');
  });
});

describe('Task queue - pull loop', () => {
  it('serves the highest priority first and breaks ties FIFO', () => {
    tasks.submitTask({ prompt: 'low', priority: 9 });
    tasks.submitTask({ prompt: 'first', priority: 1 });
    tasks.submitTask({ prompt: 'second', priority: 1 });
    assert.strictEqual(tasks.claimNextTask('pad-task-a').prompt, 'first');
    assert.strictEqual(tasks.claimNextTask('pad-task-b').prompt, 'second');
    assert.strictEqual(tasks.claimNextTask('pad-task-a').prompt, 'low');
  });

  it('never hands the same task to two workers', () => {
    tasks.submitTask({ prompt: 'only one' });
    const first = tasks.claimNextTask('pad-task-a');
    const second = tasks.claimNextTask('pad-task-b');
    assert.ok(first, 'first worker got it');
    assert.strictEqual(second, null, 'second worker gets nothing');
  });

  it('claims a task as running for the claiming pad', () => {
    const id = tasks.submitTask({ prompt: 'work' });
    const claimed = tasks.claimNextTask('pad-task-b');
    assert.strictEqual(claimed.id, id);
    assert.strictEqual(claimed.status, 'running');
    assert.strictEqual(claimed.claimed_by, 'pad-task-b');
    assert.ok(claimed.started_at, 'started_at set on claim');
  });

  it('keeps a pre-assigned task away from other pads', () => {
    tasks.submitTask({ name: 'pad-task-a', prompt: 'for a only', enqueue: true });
    assert.strictEqual(tasks.claimNextTask('pad-task-b'), null);
    assert.strictEqual(tasks.claimNextTask('pad-task-a').prompt, 'for a only');
  });

  it('enqueue files an addressed task without spawning', () => {
    const h = harness();
    tasks._setForTests({ spawn: h.spawn });
    const id = tasks.submitTask({ name: 'pad-task-a', prompt: 'later', enqueue: true });
    const row = tasks.getTask(id);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.agent_name, 'pad-task-a');
    assert.strictEqual(h.calls.length, 0, 'no spawn in enqueue mode');
  });

  it('completes a claimed task and records the summary', () => {
    const id = tasks.submitTask({ prompt: 'work' });
    tasks.claimNextTask('pad-task-a');
    const row = tasks.completeTask(id, { status: 'done', summary: 'shipped it' });
    assert.strictEqual(row.status, 'done');
    assert.strictEqual(row.result_summary, 'shipped it');
    assert.ok(row.finished_at, 'finished_at set');
  });

  it('maps a failed completion onto the error status', () => {
    const id = tasks.submitTask({ prompt: 'work' });
    tasks.claimNextTask('pad-task-a');
    assert.strictEqual(tasks.completeTask(id, { status: 'failed', summary: 'nope' }).status, 'error');
  });

  it('refuses to complete a task that is already terminal', () => {
    const id = tasks.submitTask({ prompt: 'work' });
    tasks.claimNextTask('pad-task-a');
    tasks.completeTask(id, { status: 'done' });
    assert.throws(() => tasks.completeTask(id, { status: 'done' }), /not in a claimable state/);
  });

  it('refuses an unknown task', () => {
    assert.throws(() => tasks.completeTask('nope', { status: 'done' }), /Task not found/);
  });

  it('re-ranks only pending tasks', () => {
    const id = tasks.submitTask({ prompt: 'work', priority: 5 });
    assert.strictEqual(tasks.setPriority(id, 1).priority, 1);
    tasks.claimNextTask('pad-task-a');
    assert.throws(() => tasks.setPriority(id, 0), /Only pending tasks/);
  });

  it('lists tasks for one pad and honours the limit', () => {
    tasks.submitTask({ name: 'pad-task-a', prompt: 'a1' });
    tasks.submitTask({ name: 'pad-task-b', prompt: 'b1' });
    tasks.submitTask({ name: 'pad-task-b', prompt: 'b2' });
    const forA = tasks.listTasks({ pad: 'pad-task-a' });
    assert.strictEqual(forA.length, 1);
    assert.strictEqual(forA[0].prompt, 'a1');
    assert.strictEqual(tasks.listTasks({ pad: 'pad-task-b', limit: 1 }).length, 1);
    assert.strictEqual(tasks.listTasks({}).length, 3);
  });
});

describe('Task queue - boot reconciliation', () => {
  it('flips orphaned running tasks to error', () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, prompt, status, created_at) VALUES ('t-orphan','x','running',datetime('now'))").run();
    tasks.reconcileOrphanedTasks();
    const row = tasks.getTask('t-orphan');
    assert.strictEqual(row.status, 'error');
    assert.ok(row.finished_at, 'finished_at set');
    assert.match(row.result_summary, /restart/);
  });

  it('leaves finished tasks alone', () => {
    const db = getDb();
    db.prepare("INSERT INTO tasks (id, prompt, status, created_at) VALUES ('t-done','x','done',datetime('now'))").run();
    tasks.reconcileOrphanedTasks();
    assert.strictEqual(tasks.getTask('t-done').status, 'done');
  });
});

describe('Task queue - output capping', () => {
  it('leaves short output untouched', () => {
    assert.strictEqual(tasks.capOutput('short'), 'short');
  });

  it('never splits a multibyte character at the boundary', () => {
    const out = tasks.capOutput('é'.repeat(400 * 1024));
    assert.ok(Buffer.byteLength(out, 'utf8') <= tasks.MAX_OUTPUT_BYTES);
    assert.ok(!/[\uD800-\uDFFF]/.test(out), 'no lone surrogate left behind');
  });
});
