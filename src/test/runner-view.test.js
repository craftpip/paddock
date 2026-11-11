// The runner view is the one verdict the page renders (plan 118 Phase 1).
// Two claims are pinned here: the table of what each state offers, and that a
// control the view offers is a write the server accepts (parity with the gate).
const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-view-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'view.db');
const PAD = 'pad-runner-view';
const FOLDER = '/root/.opencode/workspace';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { buildExecution } = require('../services/runner-view');
const { STATES, EVENTS, REVIEWABLE_STATES, queueEditVerdict } = require('../services/runner-state');
const { getDb } = require('../services/db');
const mission = require('../services/mission');
const runnerQueue = require('../services/runner-queue');

const ITEMS = {
  empty: [],
  queued: [{ id: 'a', plan: 'a.md', status: 'new' }],
  working: [{ id: 'a', plan: 'a.md', title: 'Plan A', status: 'in progress' }, { id: 'b', plan: 'b.md', status: 'new' }],
  blocked: [{ id: 'a', plan: 'a.md', status: 'need input' }],
  done: [{ id: 'a', plan: 'a.md', status: 'done' }],
};
const summaryOf = (items) => ({
  current: items.find((i) => i.status === 'in progress') || null,
  next: items.find((i) => i.status === 'new') || null,
  blocked: items.find((i) => i.status === 'need input') ? { ...items.find((i) => i.status === 'need input'), reason: 'which colour?' } : null,
});
const view = (runtimeState, items, extra = {}) => buildExecution({
  runtimeState, items, summary: summaryOf(items), scheduler: { reason: 'sched' },
  operation: ['dispatching', 'awaiting_receipt', 'running'].includes(runtimeState) ? { id: 'op', kind: 'queue' } : null,
  outstanding: ['dispatching', 'awaiting_receipt', 'running', 'held'].includes(runtimeState),
  ...extra,
});

it('gives every state a label, a tone and a full set of action verdicts', () => {
  const names = ['setup', 'run', 'pause', 'regenerate', 'reconcile', 'reviewStatus', 'resolve', 'addItems', 'reorder', 'removeItem'];
  for (const state of [...STATES, null]) {
    const v = view(state, ITEMS.queued);
    assert.ok(v.label, `label for ${state}`);
    assert.ok(['active', 'success', 'danger', 'idle'].includes(v.tone), `tone for ${state}`);
    assert.deepEqual(Object.keys(v.actions).sort(), [...names].sort());
    for (const name of names) {
      const a = v.actions[name];
      assert.equal(typeof a.allowed, 'boolean');
      // A disabled control always says why; an enabled one carries no excuse.
      assert.equal(a.allowed ? a.reason : typeof a.reason, a.allowed ? null : 'string', `${state}.${name}`);
    }
  }
});

it('offers Run exactly when the state machine accepts run and there is unblocked work', () => {
  for (const state of STATES) {
    for (const [name, items] of Object.entries(ITEMS)) {
      const expected = EVENTS.run.includes(state) && ['queued', 'working'].includes(name) && state !== 'held';
      const v = view(state, items);
      // `held` keeps its operation outstanding, so Run stays withdrawn there.
      assert.equal(v.actions.run.allowed, expected, `${state}/${name}`);
    }
  }
  assert.equal(view('held', ITEMS.queued, { outstanding: false }).actions.run.allowed, true);
  assert.match(view('paused', ITEMS.blocked).actions.run.reason, /Resolve the blocked plan/);
  assert.match(view('paused', ITEMS.empty).actions.run.reason, /Add plans/);
});

it('withdraws Pause and offers Run when the server says recovery is required', () => {
  const v = view('running', ITEMS.working, { scheduler: { recoveryRequired: true, reason: 'turn failed' } });
  assert.equal(v.actions.run.allowed, true);
  assert.equal(v.actions.pause.allowed, false);
  assert.equal(view('running', ITEMS.working).actions.pause.allowed, true);
});

it('words the paused banner from what the worker is doing', () => {
  assert.match(view('paused', ITEMS.working, { workerBusy: true, pauseMode: 'current_task' }).banner.text, /stop at a safe point/);
  assert.match(view('paused', ITEMS.working, { workerBusy: true, pauseMode: 'before_next_task' }).banner.text, /finishing; no new plan/);
  assert.match(view('paused', ITEMS.working).banner.text, /Plan A is part-way through/);
  assert.equal(view('paused', ITEMS.queued).banner.kind, 'paused');
  assert.equal(view('running', ITEMS.working).banner, null);
  assert.equal(view('complete', ITEMS.done).reason, 'Queue is done');
});

it('explains a locked edit by what actually unlocks it', () => {
  assert.match(view('running', ITEMS.queued).actions.reorder.reason, /Pause the queue first/);
  assert.match(view('waiting_input', ITEMS.blocked).actions.reorder.reason, /Answer the blocked plan first/);
  // Stopped with nothing to answer (provider quota): quote the stop reason.
  const quota = view('waiting_input', ITEMS.queued, { scheduler: { reason: 'OpenCode free usage limit reached' } });
  assert.match(quota.actions.reorder.reason, /stopped: OpenCode free usage limit reached/);
  assert.doesNotMatch(quota.actions.reorder.reason, /blocked plan/);
});

it('lets a repair state win over the runtime state', () => {
  assert.equal(view('running', ITEMS.queued, { queueCondition: 'projection_error' }).state, 'projection_error');
  assert.equal(view('paused', ITEMS.queued, { queueCondition: 'missing' }).state, 'setup_required');
  const v = view('paused', ITEMS.queued, { queueCondition: 'projection_error' });
  assert.equal(v.actions.regenerate.allowed, true);
  for (const name of ['addItems', 'reorder', 'removeItem', 'run']) assert.equal(v.actions[name].allowed, false, name);
  // A runtime projection error outlives matching files until regeneration.
  assert.equal(view('projection_error', ITEMS.queued).actions.regenerate.allowed, true);
});

it('reads its edit and review verdicts from the predicates the write path uses', () => {
  for (const state of STATES) {
    const v = view(state, ITEMS.queued);
    const kind = v.operation?.kind || null;
    assert.equal(v.actions.addItems.allowed, queueEditVerdict(state, 'append', { activeKind: kind }).allowed, `${state} append`);
    assert.equal(v.actions.reorder.allowed, queueEditVerdict(state, 'reorder', { activeKind: kind }).allowed, `${state} reorder`);
    assert.equal(v.actions.removeItem.allowed, queueEditVerdict(state, 'remove', { activeKind: kind }).allowed, `${state} remove`);
    assert.equal(v.actions.reviewStatus.allowed, REVIEWABLE_STATES.includes(state), `${state} review`);
  }
});

// ---- parity against the real write path, on a throwaway database ----
// The runner is built by the real service; only the runtime STATE is forced,
// because that is the one input both the gate and the view judge.
let seq = 0;
async function runnerIn(state) {
  const db = getDb();
  const n = ++seq;
  const project = mission.createProject({ name: `view-${n}`, agent: PAD, folder: FOLDER, plansFolder: `plans${n}` });
  const session = mission.createSession(project.id, { agentSessionId: `ses_view_${n}` });
  const runner = await mission.createRunner({ projectId: project.id, name: `view-${n}`, sessionId: session.id });
  await mission.addRunnerQueueItems(runner.id, ['one.md', 'two.md'], 0);
  const active = ['dispatching', 'awaiting_receipt', 'running'].includes(state);
  const stamp = new Date().toISOString();
  const opId = `rop_view_${n}`;
  if (active) {
    db.prepare(`INSERT INTO runner_operations (id, runner_id, generation, operation_kind, conversation_id, item_id, status, created_at, updated_at)
      VALUES (?, ?, 1, 'queue', ?, ?, 'running', ?, ?)`).run(opId, runner.id, `ses_view_${n}`, runnerQueue.snapshot(runner.id).items[0].id, stamp, stamp);
  }
  db.prepare('UPDATE runner_runtime SET state = ?, generation = 1, operation_id = ? WHERE runner_id = ?').run(state, active ? opId : null, runner.id);
  return runner.id;
}
const attempt = (fn) => { try { fn(); return true; } catch (e) { if (e.code === 'queue_runtime_busy') return false; throw e; } };

it('a queue edit the view offers is a queue edit the server accepts, in every state', async () => {
  getDb().prepare("INSERT OR IGNORE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')").run(PAD, PAD, PAD);
  for (const state of STATES) {
    const v = view(state, ITEMS.queued);
    const id = await runnerIn(state);
    let snap = runnerQueue.snapshot(id);
    assert.equal(attempt(() => runnerQueue.addPlans(id, ['three.md'], snap.revision)), v.actions.addItems.allowed, `${state} add`);
    snap = runnerQueue.snapshot(id);
    const ids = snap.items.map((i) => i.id).reverse();
    assert.equal(attempt(() => runnerQueue.reorder(id, ids, snap.revision)), v.actions.reorder.allowed, `${state} reorder`);
    snap = runnerQueue.snapshot(id);
    assert.equal(attempt(() => runnerQueue.remove(id, snap.items.at(-1).id, snap.revision)), v.actions.removeItem.allowed, `${state} remove`);
  }
});

it('lets a plan be appended between two plans, when the queue runs with no operation outstanding', async () => {
  const id = await runnerIn('running');
  getDb().prepare('UPDATE runner_runtime SET operation_id = NULL WHERE runner_id = ?').run(id);
  const snap = runnerQueue.snapshot(id);
  assert.equal(attempt(() => runnerQueue.addPlans(id, ['between.md'], snap.revision)), true);
  assert.equal(view('running', ITEMS.queued, { operation: null, outstanding: false }).actions.addItems.allowed, true);
  // A resolution in flight still refuses it.
  assert.equal(view('running', ITEMS.queued, { operation: { id: 'op', kind: 'resolution' } }).actions.addItems.allowed, false);
});

it('refuses a hand status correction in exactly the states the view withdraws it', async () => {
  for (const state of STATES) {
    const id = await runnerIn(state);
    const snap = runnerQueue.snapshot(id);
    let accepted = true;
    try { await mission.updateRunnerQueueItem(id, snap.items[1].id, { status: 'new', reason: '' }, snap.revision); }
    catch (e) { if (e.code !== 'runner_invalid_state') throw e; accepted = false; }
    assert.equal(accepted, view(state, ITEMS.queued).actions.reviewStatus.allowed, state);
  }
});

after(() => { try { getDb().close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
