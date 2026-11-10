const { it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paddock-history-'));
process.env.PAD_DB_PATH = path.join(root, 'history.db');
process.env.WORKSPACE_ROOT = root;
process.env.RUNNER_CALLBACKS_DIR = path.join(root, 'callbacks');
const { getDb, close } = require('../services/db');
const history = require('../services/runner-history');
const callbacks = require('../services/runner-callbacks');
const mission = require('../services/mission');

beforeEach(() => getDb().prepare('DELETE FROM runner_history').run());
after(() => { close(); fs.rmSync(root, { recursive: true, force: true }); });
const a = { id: 'run-a', session_id: 'msn-a' };
const b = { id: 'run-b', session_id: 'msn-b' };

it('journal survives reopening, preserves actors and dates, and excludes other runners', () => {
  history.record(a, 'run_requested', { actor: 'user:alice' });
  history.record(b, 'run_requested', { actor: 'user:bob' });
  close();
  const page = history.read(a.id);
  assert.equal(page.groups.length, 1);
  assert.equal(page.groups[0].events[0].actor, 'user:alice');
  assert.ok(Number.isFinite(Date.parse(page.groups[0].events[0].createdAt)));
  assert.equal(page.groups[0].events[0].title, 'Run requested');
});

it('an empty runner has a truthful first-use state without invented earlier events', () => {
  const page = history.read('runner-never-observed');
  assert.deepEqual(page.groups, []);
  assert.equal(page.since, null);
  assert.equal(page.nextCursor, null);
});

it('recovery steps stay together, event keys deduplicate, and cursor pages do not overlap', () => {
  history.record(a, 'recovery_requested', { groupId: 'cb-one', key: 'request-one' });
  history.record(a, 'script_started', { groupId: 'cb-one', key: 'start-one' });
  history.record(a, 'script_started', { groupId: 'cb-one', key: 'start-one' });
  history.record(a, 'plan_started', { plan: 'next.md' });
  history.record(a, 'script_completed', { groupId: 'cb-one', key: 'end-one', exitCode: 0 });
  const first = history.read(a.id, { limit: 1 });
  assert.equal(first.groups[0].events[0].type, 'plan_started');
  const second = history.read(a.id, { limit: 1, before: first.nextCursor });
  assert.equal(second.groups[0].groupId, 'cb-one');
  assert.deepEqual(second.groups[0].events.map((e) => e.type), ['recovery_requested', 'script_started', 'script_completed']);
  assert.equal(second.nextCursor, null);
  assert.notEqual(first.groups[0].id, second.groups[0].id);
});

it('problem filters include the complete failed attempt and category filters are scoped before pagination', () => {
  history.record(a, 'script_started', { groupId: 'cb-failed' });
  history.record(a, 'script_failed', { groupId: 'cb-failed', severity: 'error', exitCode: 1 });
  history.record(a, 'plan_completed', { plan: 'complete.md' });
  const problems = history.read(a.id, { category: 'problems' });
  assert.equal(problems.groups.length, 1);
  assert.equal(problems.groups[0].events.length, 2);
  assert.equal(history.read(a.id, { category: 'plans', limit: 1 }).groups[0].events[0].type, 'plan_completed');
  assert.throws(() => history.read(a.id, { before: 'not-an-id' }), /cursor/);
  assert.throws(() => history.read(a.id, { category: 'secret' }), /filter/);
});

it('answers and script/transcript contents never enter journal metadata', () => {
  history.record(a, 'answer_submitted', { characters: 26, answer: 'test-secret-credential', text: 'test-secret-credential', script: 'test-secret-credential' });
  const serialized = JSON.stringify(history.read(a.id));
  assert.ok(!serialized.includes('test-secret-credential'));
  assert.ok(serialized.includes('characters'));
});

it('plan and input transitions are recorded even when all callback scripts are disabled', () => {
  const project = { id: 'project-a', folder: '/tmp' };
  const items = [{ id: 'item', plan: 'work.md', status: 'new', reason: '' }];
  callbacks.observeQueue(a, project, items);
  callbacks.observeQueue(a, project, [{ ...items[0], status: 'in progress' }]);
  callbacks.observeQueue(a, project, [{ ...items[0], status: 'need input', reason: 'Choose the deployment target' }]);
  callbacks.observeQueue(a, project, [{ ...items[0], status: 'need input', reason: 'Choose the deployment target' }]);
  callbacks.observeQueue(a, project, [{ ...items[0], status: 'done' }]);
  const types = history.read(a.id).groups.flatMap((g) => g.events.map((e) => e.type));
  assert.deepEqual(types.sort(), ['history_started', 'plan_started', 'input_needed', 'plan_completed'].sort());
  assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM runner_callback_outbox').get().n, 0);
});

it('quota polling produces one exhaustion event and one measured recovery event', () => {
  const p = { id: 'p', folder: '/tmp' };
  const evidence = { state: 'exhausted', definitive: true, reason: 'Free limit reached' };
  callbacks.observeUsage(a, p, evidence);
  callbacks.observeUsage(a, p, evidence);
  callbacks.observeUsage(a, p, { state: 'unknown' });
  callbacks.observeUsage(a, p, { state: 'ok' });
  assert.deepEqual(history.read(a.id).groups.map((g) => g.events[0].type), ['usage_recovered', 'usage_exhausted']);
});

it('a real pause action emits ordered request and dispatch-stop facts', async () => {
  const pad = 'pad-history';
  fs.mkdirSync(path.join(root, 'instances', pad), { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', pad, 'meta.env'), 'AGENT=opencode\n');
  getDb().prepare("INSERT INTO agents (id,name,agent_type,runtime_type,runtime_ref,status,owner_id) VALUES (?,?,'opencode','docker',?,'running','u1')").run(pad, pad, pad);
  const p = mission.createProject({ name: 'history', agent: pad, folder: '/root/.opencode/workspace' });
  const now = new Date().toISOString();
  getDb().prepare("INSERT INTO mission_sessions (id,project_id,tmux_id,label,origin,locked,agent_session_id,created_at,last_seen_at) VALUES ('msn-history',?,'msn-history','History','human',0,'conversation',?,?)").run(p.id, now, now);
  const runner = await mission.createRunner({ projectId: p.id, sessionId: 'msn-history', name: 'History runner' });
  await mission.pauseRunner(runner.id, { actor: 'user:alice' });
  const events = history.read(runner.id).groups.flatMap((g) => g.events).reverse();
  assert.deepEqual(events.map((e) => e.type), ['runner_created', 'pause_requested', 'pause_applied']);
  assert.ok(events.filter((e) => e.type !== 'runner_created').every((e) => e.actor === 'user:alice'));
});
