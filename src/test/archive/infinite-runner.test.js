const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plan 83 (phases 1-5) shipped the runner feature with NO tests. This suite
// covers the parts that need no container: the configuration store (create /
// remove) and the queue-validation ordering in startRunner. Both come from
// Phase 6 verification, and each pins a defect that a green parser suite could
// not see. Plan 85 re-pinned the lifecycle: create binds a real session,
// pause keeps the pane, refusals stay re-Runnable (never `finished`).
//
// WORKSPACE_ROOT must be set BEFORE agent-registry/pad-tmux read it (they
// compute INSTANCES_DIR at require time), and PAD_DB_PATH before db.js loads.
// Same shape as mcp-exec-usermode.test.js / mission.test.js.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-runner-'));
process.env.WORKSPACE_ROOT = WS;
process.env.PAD_DB_PATH = path.join(WS, 'runner.test.db');
process.env.RUNNER_CALLBACKS_DIR = path.join(WS, 'callbacks');

const PAD = 'pad-runner';
fs.mkdirSync(path.join(WS, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(WS, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const plans = require('../services/plans');
const registry = require('../services/agent-registry');
const padTmux = require('../services/pad-tmux');

after(() => fs.rmSync(WS, { recursive: true, force: true }));

function seedPad() {
  getDb().prepare(
    `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
     VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'u1')`
  ).run(PAD, PAD, PAD);
}

// A project folder must sit INSIDE the driver's container workspace, or
// projectPlansRoot refuses it (`plan_project_folder_outside_workspace`). The
// opencode workspace is `/root/.opencode/workspace`; the registry maps it to a
// host folder under our throwaway INSTANCES_DIR, so the queue file we write
// lands inside WS and never touches a real path.
const FOLDER = '/root/.opencode/workspace';
function makeProject(name = 'proj') {
  return mission.createProject({ name, agent: PAD, folder: FOLDER, plansFolder: 'plans' });
}

/** The HOST path readQueue will resolve for a project's QUEUE.md. */
function hostQueuePath(projectRow) {
  return plans.queuePath(registry.getAgent(PAD), projectRow);
}
function writeQueueFile(projectRow, content) {
  const qp = hostQueuePath(projectRow);
  fs.mkdirSync(path.dirname(qp), { recursive: true });
  fs.writeFileSync(qp, content);
  return qp;
}

/** Write a queue file holding exactly `items` (plan 86 §Phase 1 shape). */
function writeQueueItems(projectRow, items) {
  return writeQueueFile(projectRow, [
    plans.QUEUE_MARKERS.start, '```json',
    JSON.stringify({ version: 1, items }, null, 2),
    '```', plans.QUEUE_MARKERS.end,
  ].join('\n'));
}

function insertSession(projectId) {
  const id = 'msn_' + Math.random().toString(16).slice(2, 12);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, locked, agent_session_id, created_at, last_seen_at)
     VALUES (?, ?, ?, 'test', 'agent', 0, ?, ?, ?)`
  ).run(id, projectId, 'tmux-' + id, 'ses_' + id, now, now);
  return id;
}

function setPadStatus(status) {
  getDb().prepare('UPDATE agents SET status = ? WHERE name = ?').run(status, PAD);
}

/** Create a runner without touching a container: bind a test-inserted session.
 *  Plan 85's createRunner mints a REAL session when no sessionId is given, so
 *  the no-session path needs a live pad and is covered by browser verification;
 *  every no-container test here binds explicitly. */
async function makeRunner(projectId, name = 'r') {
  const sid = insertSession(projectId);
  return mission.createRunner({ projectId, name, sessionId: sid });
}

beforeEach(() => {
  seedPad();
  const db = getDb();
  db.prepare('DELETE FROM infinite_runners').run();
  db.prepare('DELETE FROM mission_sessions').run();
  db.prepare('DELETE FROM mission_projects').run();
});

describe('plan 83 — runner configuration: create', () => {
  it('rejects a session that does not exist (runner_session_not_found)', async () => {
    const p = makeProject();
    await assert.rejects(
      mission.createRunner({ projectId: p.id, name: 'r', sessionId: 'msn_nope' }),
      (e) => e.code === 'runner_session_not_found'
    );
  });

  it('rejects a session that belongs to another project (runner_session_wrong_project)', async () => {
    const p1 = makeProject('p1');
    const p2 = makeProject('p2');
    const sid = insertSession(p2.id);
    await assert.rejects(
      mission.createRunner({ projectId: p1.id, name: 'r', sessionId: sid }),
      (e) => e.code === 'runner_session_wrong_project'
    );
  });

  it('rejects a session already bound to another runner (runner_session_in_use)', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    await mission.createRunner({ projectId: p.id, name: 'first', sessionId: sid });
    await assert.rejects(
      mission.createRunner({ projectId: p.id, name: 'second', sessionId: sid }),
      (e) => e.code === 'runner_session_in_use'
    );
  });

  it('binds an existing session and starts paused/disabled', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'r', sessionId: sid });
    assert.equal(r.session_id, sid);
    assert.equal(Number(r.enabled), 0);
    assert.equal(r.control_state, 'paused');
  });

  it('stores a custom queue file for runner operations', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'r', sessionId: sid, queueFile: 'OTHER.md' });
    assert.equal(r.queue_file, 'OTHER.md');
  });

  it('create without a session fails cleanly on a stopped pad — no half-created row', async () => {
    const p = makeProject();
    setPadStatus('stopped');
    try {
      await assert.rejects(
        mission.createRunner({ projectId: p.id, name: 'r' }),
        (e) => e.code === 'mission_agent_stopped'
      );
      assert.equal(mission.listRunnersForProject(p.id).length, 0, 'no runner row left behind');
    } finally {
      setPadStatus('running');
    }
  });
});

describe('plan 83 — runner configuration: remove', () => {
  it('REMOVES the configuration row so the pin cannot survive', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    assert.ok(mission.getRunner(r.id), 'runner exists before removal');

    await mission.removeRunner(r.id);

    // The defect: removeRunner used to UPDATE (session_id = NULL, enabled = 0,
    // 'paused'), which is indistinguishable from a created-but-never-started
    // runner — and the pinned list renders every row, so "Remove" left the pin
    // in place forever. Spec: "remove the runner configuration/designation."
    assert.equal(mission.getRunner(r.id), undefined, 'row is gone');
    assert.ok(
      !mission.listRunnersForProject(p.id).some((x) => x.id === r.id),
      'the project listing no longer offers the removed runner'
    );
  });

  it('keeps the bound Mission session/conversation', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'r', sessionId: sid });
    await mission.removeRunner(r.id);
    assert.ok(mission.getSession(sid), 'the session row survives removal');
  });

  it('removes a paused runner without touching tmux (no restart)', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    // enabled = 0, control_state = 'paused' → removeRunner must not pause/start.
    await mission.removeRunner(r.id);
    assert.equal(mission.getRunner(r.id), undefined);
  });

  it('is idempotent-safe: a second remove reports runner_not_found', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.removeRunner(r.id);
    await assert.rejects(
      mission.removeRunner(r.id),
      (e) => e.code === 'runner_not_found'
    );
  });

  it('plan 85: pause keeps the pane — the session row is NOT ended', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'r', sessionId: sid });
    await mission.pauseRunner(r.id);
    const after = mission.getRunner(r.id);
    assert.equal(Number(after.enabled), 0);
    assert.equal(after.control_state, 'paused');
    // The defect plan 85 corrects: pauseRunner used to call endSession, killing
    // the terminal the user was watching. Pause controls the queue only.
    const sess = mission.getSession(sid);
    assert.equal(sess.ended_at, null, 'session row is not ended by Pause');
    assert.equal(sess.ended_by, null);
  });
});

describe('plan 85 — startRunner queue gates stay re-Runnable', () => {
  it('clears an invalid-queue stop after the file is repaired, without auto-running it', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'work', plan: 'work.md', status: 'new', reason: '' }]);
    getDb().prepare(
      "UPDATE infinite_runners SET enabled = 0, control_state = 'need_input', stop_cause = 'invalid_queue', stop_origin = 'automatic', last_reason = 'Queue is invalid: Duplicate item id: old', scheduler_decision = 'need_input' WHERE id = ?"
    ).run(r.id);

    const detail = await mission.readRunnerQueue(r.id);
    const after = mission.getRunner(r.id);
    assert.equal(detail.queue.condition, 'ok');
    assert.equal(after.control_state, 'paused');
    assert.equal(Number(after.enabled), 0, 'repairing a file never starts work');
    assert.equal(after.stop_cause, null);
    assert.match(after.last_reason, /Queue repaired/);
    assert.ok(fs.existsSync(plans.queuePausedPath(registry.getAgent(PAD), p)), 'the worker remains paused until Run');
  });

  it('a MISSING queue throws runner_invalid_queue, stays paused, records a reason', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    // No QUEUE.md written. readQueue reports this as `invalid` (a missing
    // queue is an error, never "nothing to do"), and startRunner must check
    // invalid BEFORE the empty-items branch or it would answer `empty_queue` for
    // a queue it could not read at all.
    fs.rmSync(hostQueuePath(p), { force: true });
    await assert.rejects(
      mission.startRunner(r.id),
      (e) => e.code === 'runner_invalid_queue'
    );
    // Plan 85 corrects the old `finished` stamp: a fixed file must be
    // re-Runnable on the SAME runner, so the refusal leaves it paused.
    const after = mission.getRunner(r.id);
    assert.equal(after.control_state, 'paused');
    assert.equal(Number(after.enabled), 0);
    assert.match(after.last_reason || '', /invalid/i);
    // Still re-Runnable: a second attempt refuses the same way, not with a
    // `runner_finished` dead end.
    await assert.rejects(
      mission.startRunner(r.id),
      (e) => e.code === 'runner_invalid_queue'
    );
  });

  it('an EMPTY valid queue reports empty_queue without starting a worker, stays paused', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const agent = registry.getAgent(PAD);
    writeQueueFile(p, plans.queueTemplate(agent, p));
    const res = await mission.startRunner(r.id);
    assert.equal(res.started, false);
    assert.equal(res.reason, 'empty_queue');
    const after = mission.getRunner(r.id);
    assert.equal(after.control_state, 'paused');
    assert.equal(Number(after.enabled), 0);
  });

  it('need-input queue refuses with runner_need_input and stays paused', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const agent = registry.getAgent(PAD);
    const tpl = plans.queueTemplate(agent, p);
    const blocked = tpl.replace('"items": []', '"items": [{ "id": "q1", "plan": "a.md", "status": "need input", "reason": "which color?" }]');
    writeQueueFile(p, blocked);
    await assert.rejects(
      mission.startRunner(r.id),
      (e) => e.code === 'runner_need_input'
    );
    assert.equal(mission.getRunner(r.id).control_state, 'paused');
  });

  it('Run adopts a verified active worker without sending a duplicate startup prompt', async () => {
    const p = makeProject('adopt');
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'active', plan: 'active.md', status: 'in progress', reason: '' }]);
    const agentStore = require('../services/agent-store');
    const originalTurn = agentStore.readTurn;
    const originalSend = padTmux.sendText;
    agentStore.readTurn = () => ({ state: 'working', userId: 'turn-active', progressAt: new Date().toISOString() });
    padTmux.sendText = async () => { throw new Error('must not send'); };
    try {
      const result = await mission.startRunner(r.id);
      assert.equal(result.reason, 'adopted_active_turn');
      assert.equal(Number(mission.getRunner(r.id).enabled), 1);
      assert.equal(mission.getRunner(r.id).control_state, 'enabled');
    } finally {
      agentStore.readTurn = originalTurn;
      padTmux.sendText = originalSend;
    }
  });
});

describe('plan 85 — execution-state transitions', () => {
  it('a late exact quota recovery receipt reconciles without resending while a real quota notice still holds dispatch', async () => {
    const p = makeProject('late-quota-receipt');
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'active', plan: 'active.md', status: 'in progress', reason: '' }]);
    const sid = mission.getSession(r.session_id).agent_session_id;
    getDb().prepare("UPDATE infinite_runners SET enabled = 0, run_generation = 2, stop_cause = 'usage_exhausted', control_state = 'need_input', operation_id = 'late-op', operation_status = 'unconfirmed', operation_prompt_hash = 'matching', operation_baseline_user_id = 'old' WHERE id = ?").run(r.id);
    getDb().prepare("INSERT INTO runner_quota_recoveries (event_id,runner_id,session_id,conversation_id,generation,container_id,status,error,updated_at) VALUES ('late-event',?,?,?,?,?,'failed',?,?)")
      .run(r.id, r.session_id, sid, 1, 'old-container', 'Restored conversation has not acknowledged the continuation; no resend made', new Date().toISOString());
    const agentStore = require('../services/agent-store');
    const originalTurn = agentStore.readTurn;
    const originalCapture = padTmux.captureScreen;
    const originalSend = padTmux.sendText;
    agentStore.readTurn = () => ({ state: 'working', userId: 'new', inputHash: 'matching' });
    padTmux.captureScreen = async () => ({ live: true, text: 'Free usage exceeded, subscribe to Go [retrying in 6h attempt #1]' });
    padTmux.sendText = async () => assert.fail('must not resend');
    try {
      await mission.observeRunnerUsage();
      assert.equal(mission.getRunner(r.id).enabled, 0);
      assert.equal(mission.getRunner(r.id).operation_receipt_user_id, 'new');
      assert.equal(getDb().prepare("SELECT status FROM runner_quota_recoveries WHERE event_id = 'late-event'").get().status, 'exhausted_again');
    } finally {
      agentStore.readTurn = originalTurn;
      padTmux.captureScreen = originalCapture;
      padTmux.sendText = originalSend;
    }
  });
  it('explicit Run retries quota recovery once, coalesces concurrent clicks, and sends no startup', async () => {
    const p = makeProject('quota-retry');
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'active', plan: 'active.md', status: 'in progress', reason: '' }]);
    getDb().prepare("UPDATE infinite_runners SET enabled = 0, control_state = 'need_input', stop_cause = 'usage_exhausted' WHERE id = ?").run(r.id);
    mission.saveRunnerCallbacks(r.id, { usage_exhausted: { script: 'echo recovery', enabled: true, recreateResume: true } });
    const callbacks = require('../services/runner-callbacks');
    const originalPump = callbacks.pumpCallbackOutbox;
    callbacks.pumpCallbackOutbox = async () => 0;
    try {
      const results = await Promise.all([mission.startRunner(r.id), mission.startRunner(r.id)]);
      assert.ok(results.every((value) => value.recovering));
      assert.equal(results[0].eventId, results[1].eventId);
      const rows = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE runner_id = ?').all(r.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].recreate_resume, 1);
      assert.equal(mission.getRunner(r.id).enabled, 0);
      assert.equal(mission.getRunner(r.id).operation_id, null);
    } finally {
      callbacks.pumpCallbackOutbox = originalPump;
    }
  });

  it('quota recovery continues the original conversation once and rejects replay or a superseded generation', async () => {
    const p = makeProject('quota-resume');
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'active', plan: 'active.md', status: 'in progress', reason: '' }]);
    getDb().prepare("UPDATE infinite_runners SET enabled = 0, control_state = 'need_input', stop_cause = 'usage_exhausted' WHERE id = ?").run(r.id);
    const context = { runner_id: r.id, session_id: r.session_id, conversation_id: mission.getSession(r.session_id).agent_session_id, generation: r.run_generation };
    const agentStore = require('../services/agent-store');
    const original = { hasSession: padTmux.hasSession, paneState: padTmux.paneState, captureScreen: padTmux.captureScreen, sendText: padTmux.sendText };
    const originalTurn = agentStore.readTurn;
    let receivedText = '';
    agentStore.readTurn = () => ({ state: 'working', userId: receivedText ? 'quota-new-input' : 'quota-old-input', inputHash: receivedText ? require('crypto').createHash('sha256').update(receivedText).digest('hex') : null, progressAt: null });
    let sent = 0;
    let captures = 0;
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode' });
    padTmux.captureScreen = async () => ({ live: true, text: `screen ${captures++}\nctrl+p commands` });
    padTmux.sendText = async (_pad, _session, text) => { sent++; receivedText = text; return { lines: 1 }; };
    try {
      await assert.rejects(mission.resumeQuotaRecovery({ ...context, generation: context.generation + 1 }), (e) => e.code === 'quota_recovery_superseded');
      assert.equal(sent, 0);
      await mission.resumeQuotaRecovery(context);
      assert.equal(sent, 1);
      assert.equal(mission.getRunner(r.id).enabled, 1);
      assert.equal(mission.getSession(r.session_id).agent_session_id, context.conversation_id);
      await assert.rejects(mission.resumeQuotaRecovery(context), (e) => e.code === 'quota_recovery_superseded');
      assert.equal(sent, 1);
    } finally {
      Object.assign(padTmux, original);
      agentStore.readTurn = originalTurn;
    }
  });

  it('setRunnerEnabled moves enabled + control_state atomically', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const on = await mission.setRunnerEnabled(r.id, true);
    assert.equal(Number(on.enabled), 1);
    assert.equal(on.control_state, 'enabled');
    const off = await mission.setRunnerEnabled(r.id, false);
    assert.equal(Number(off.enabled), 0);
    assert.equal(off.control_state, 'paused');
  });

  it('setRunnerControlState never touches enabled (watcher sub-states keep the watch)', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await mission.setRunnerEnabled(r.id, true);
    const w = await mission.setRunnerControlState(r.id, 'waiting');
    assert.equal(w.control_state, 'waiting');
    assert.equal(Number(w.enabled), 1, 'a waiting runner stays watched');
  });

  it('runnerContainerPaths resolves in the container namespace', () => {
    const paths = mission.runnerContainerPaths(
      { folder: '/www1/xdl', plans_folder: 'plans' },
      'QUEUE.md'
    );
    assert.equal(paths.queue, '/www1/xdl/plans/QUEUE.md');
    assert.equal(paths.index, '/www1/xdl/plans/INDEX.md');
  });

  it('disableRunnerForSession stops supervision so Close cannot be resurrected', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'r', sessionId: sid });
    await mission.setRunnerEnabled(r.id, true);
    mission.disableRunnerForSession(sid);
    const after = mission.getRunner(r.id);
    assert.equal(Number(after.enabled), 0);
    assert.equal(after.control_state, 'paused');
    assert.match(after.last_reason || '', /closed/i);
    // The binding itself is untouched here — the FK nulls it when the row is
    // deleted by closeSession. Supervision is what must stop first.
    assert.equal(after.session_id, sid);
  });

  it('listAllRunners tags project and honors the allow filter', async () => {
    const p1 = makeProject('pa');
    const p2 = makeProject('pb');
    await makeRunner(p1.id, 'ra');
    await makeRunner(p2.id, 'rb');
    const all = mission.listAllRunners({});
    assert.equal(all.filter((r) => ['ra', 'rb'].includes(r.name)).length, 2);
    const one = all.find((r) => r.name === 'ra');
    assert.equal(one.project.id, p1.id, 'row carries its own project');
    const filtered = mission.listAllRunners({ allow: (agent) => agent !== PAD });
    assert.ok(
      !filtered.some((r) => ['ra', 'rb'].includes(r.name)),
      'a denied agent hides its runners'
    );
  });

  // ─── Plan 86 §Phase 1 — the runner-scoped QUEUE surface ──────────────────

  it('readRunnerQueue returns the full enriched queue (items, summary, workerPath)', async () => {
    const p = makeProject();
    fs.rmSync(hostQueuePath(p), { force: true });
    const r = await makeRunner(p.id, 'q');
    const d = await mission.readRunnerQueue(r.id);
    assert.equal(d.runner.id, r.id);
    assert.equal(d.project.id, p.id);
    assert.equal(d.queue.condition, 'missing', 'no file yet → missing, NOT a shrug');
    assert.equal(d.queue.state, 'invalid');
    assert.deepEqual(d.queue.items, []);
    assert.equal(d.queue.revision, null);
    assert.equal(d.queue.workerPath, '/root/.opencode/workspace/plans/QUEUE.md');
    assert.equal(d.queue.summary.total, 0);
    // A need-input item surfaces with its blocked item and reason.
    writeQueueFile(p, [
      plans.QUEUE_MARKERS.start, '```json',
      JSON.stringify({ version: 1, items: [{ id: 'b', plan: 'nope.md', status: 'need input', reason: 'waiting on the human' }] }, null, 2),
      '```', plans.QUEUE_MARKERS.end,
    ].join('\n'));
    const d2 = await mission.readRunnerQueue(r.id);
    assert.equal(d2.queue.condition, 'ok');
    assert.equal(d2.queue.state, 'need input');
    assert.equal(d2.queue.summary.blocked.plan, 'nope.md');
    assert.equal(d2.queue.summary.blocked.reason, 'waiting on the human');
    assert.equal(d2.queue.items[0].exists, false, 'a plan that is not a real file is visible as missing, not dropped');
    assert.equal(d2.queue.items[0].reason, 'waiting on the human');
  });

  it('setupRunnerQueue creates the queue once and stays idempotent', async () => {
    const p = makeProject();
    fs.rmSync(hostQueuePath(p), { force: true });
    const r = await makeRunner(p.id, 'q2');
    const first = await mission.setupRunnerQueue(r.id);
    assert.equal(first.queue.condition, 'ok');
    assert.equal(first.queue.state, 'done', 'a fresh template is an EMPTY queue');
    assert.match(first.queue.revision, /^[0-9a-f]{64}$/);
    const again = await mission.setupRunnerQueue(r.id);
    assert.equal(again.queue.revision, first.queue.revision, 'setup never recreates an existing queue');
  });

  it('updateRunnerQueue writes items with CAS and surfaces the conflict as a MissionError', async () => {
    const p = makeProject();
    fs.rmSync(hostQueuePath(p), { force: true });
    const r = await makeRunner(p.id, 'q3');
    const afterSetup = await mission.setupRunnerQueue(r.id);
    const updated = await mission.updateRunnerQueue(r.id, [
      { id: 'a', plan: 'a.md', status: 'new', reason: '' },
      { id: 'b', plan: 'b.md', status: 'in progress', reason: '' },
    ], afterSetup.queue.revision);
    assert.equal(updated.queue.condition, 'ok');
    assert.equal(updated.queue.state, 'in progress');
    assert.equal(updated.queue.summary.current.plan, 'b.md');
    assert.equal(updated.queue.summary.next.plan, 'a.md');
    assert.equal(updated.queue.items.length, 2);
    // A STALE revision is refused, and it surfaces as a mission code the UI
    // branches on — NOT a ReferenceError from a free variable (the exact defect
    // a live REST call caught: `PlansError is not defined`).
    await assert.rejects(
      () => mission.updateRunnerQueue(r.id, [], 'stalehash000'),
      (e) => e && e.code === 'queue_revision_conflict'
    );
    const after = await mission.readRunnerQueue(r.id);
    assert.equal(after.queue.revision, updated.queue.revision, 'the winner content survives the loser');
  });

  it('resolveRunnerQueue accepts the revision returned by readRunnerQueue', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'resolve', sessionId: sid });
    getDb().prepare("UPDATE infinite_runners SET enabled = 0, control_state = 'need_input' WHERE id = ?").run(r.id);
    writeQueueItems(p, [{ id: 'blocked', plan: 'blocked.md', status: 'need input', reason: 'Need confirmation' }]);
    const revision = (await mission.readRunnerQueue(r.id)).queue.revision;

    const original = {
      hasSession: padTmux.hasSession,
      paneState: padTmux.paneState,
      captureScreen: padTmux.captureScreen,
      sendText: padTmux.sendText,
    };
    let captures = 0;
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode' });
    padTmux.captureScreen = async () => ({ live: true, text: captures++ ? 'answer appeared' : 'before answer' });
    padTmux.sendText = async () => ({ lines: 1 });
    try {
      const result = await mission.resolveRunnerQueue(r.id, 'blocked', 'confirmed', revision);
      assert.ok(result.delivered);
    } finally {
      Object.assign(padTmux, original);
    }

    const after = await mission.readRunnerQueue(r.id);
    assert.equal(after.queue.items[0].status, 'new');
    assert.equal(after.runner.control_state, 'enabled');
  });

  it('reconciles an unconfirmed write only after the same blocker advances', async () => {
    const p = makeProject('reconcile');
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'reconcile', sessionId: sid });
    getDb().prepare("UPDATE infinite_runners SET enabled = 0, control_state = 'need_input' WHERE id = ?").run(r.id);
    const initial = [{ id: 'blocked', plan: 'blocked.md', status: 'need input', reason: 'Need confirmation' }];
    writeQueueItems(p, initial);
    const revision = (await mission.readRunnerQueue(r.id)).queue.revision;

    const original = {
      hasSession: padTmux.hasSession,
      paneState: padTmux.paneState,
      captureScreen: padTmux.captureScreen,
      sendText: padTmux.sendText,
    };
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode' });
    padTmux.captureScreen = async () => ({ live: true, text: 'unchanged pane' });
    padTmux.sendText = async () => {
      writeQueueItems(p, [{ id: 'blocked', plan: 'blocked.md', status: 'in progress', reason: '' }]);
      return { lines: 1 };
    };
    try {
      const result = await mission.resolveRunnerQueue(r.id, 'blocked', 'confirmed', revision);
      assert.equal(result.reconciled, true);
    } finally {
      Object.assign(padTmux, original);
    }

    const after = await mission.readRunnerQueue(r.id);
    assert.equal(after.queue.items[0].status, 'in progress');
    assert.equal(after.runner.control_state, 'enabled');
  });
});

// Plan 86 §Phase 4b — two explicit pause modes. These cover the no-container
// half: mode validation, persistence, truthful reason text, and the degrade
// rule. The live half (message delivery to a running worker, checkpoint save
// and same-plan Resume) is exercised by plan 87's browser cases.
describe('plan 86 — two pause modes (service contract)', () => {
  it('rejects an unknown pause mode (runner_invalid_pause_mode) and changes nothing', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    await assert.rejects(
      mission.pauseRunner(r.id, { mode: 'whenever' }),
      (e) => e.code === 'runner_invalid_pause_mode'
    );
    const after = mission.getRunner(r.id);
    assert.equal(after.pause_mode, null);
    assert.equal(Number(after.enabled), 0);
  });

  it('omitted mode is backward-compatible: before_next_task, paused, pane kept', async () => {
    const p = makeProject();
    const sid = insertSession(p.id);
    const r = await mission.createRunner({ projectId: p.id, name: 'r', sessionId: sid });
    await mission.setRunnerEnabled(r.id, true);
    const after = await mission.pauseRunner(r.id);
    assert.equal(after.pause_mode, 'before_next_task');
    assert.equal(after.control_state, 'paused');
    assert.equal(Number(after.enabled), 0);
    assert.equal(mission.getSession(sid).ended_at, null, 'Pause keeps the pane');
  });

  it('before_next_task names the in-progress plan and stays unconfirmed (requested)', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    writeQueueItems(p, [
      { id: 'a', plan: 'a.md', status: 'done', reason: '' },
      { id: 'b', plan: 'b.md', status: 'in progress', reason: '' },
    ]);
    const after = await mission.pauseRunner(r.id, { mode: 'before_next_task' });
    assert.equal(after.pause_mode, 'before_next_task');
    assert.equal(after.pause_target_item, 'b');
    assert.match(after.last_reason, /after current task/i);
    assert.match(after.last_reason, /b\.md/);
    // Not a confirmed pause: the worker may still be finishing that plan.
    assert.equal(after.pause_state, 'requested');
  });

  it('before_next_task with no in-progress item states the plain paused fact', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'a', plan: 'a.md', status: 'new', reason: '' }]);
    const after = await mission.pauseRunner(r.id, { mode: 'before_next_task' });
    assert.equal(after.pause_target_item, null);
    assert.match(after.last_reason, /next task will not start/i);
  });

  it('current_task with no worker session never claims Paused — records requested only', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    // Drop the session binding: there is nobody to receive the stop request, so
    // the honest answer is "requested — not confirmed", never a Paused claim.
    getDb().prepare('UPDATE infinite_runners SET session_id = NULL WHERE id = ?').run(r.id);
    writeQueueItems(p, [{ id: 'a', plan: 'a.md', status: 'in progress', reason: '' }]);
    const after = await mission.pauseRunner(r.id, { mode: 'current_task' });
    assert.equal(after.pause_mode, 'current_task');
    assert.equal(after.pause_state, 'requested');
    assert.equal(after.pause_target_item, 'a');
    assert.match(after.last_reason, /not confirmed/i);
    // Dispatch is still off, so the worker cannot take the next item regardless.
    assert.equal(Number(after.enabled), 0);
  });

  it('current_task with nothing in progress degrades to before_next_task', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'a', plan: 'a.md', status: 'new', reason: '' }]);
    const after = await mission.pauseRunner(r.id, { mode: 'current_task' });
    assert.equal(after.pause_mode, 'before_next_task');
    assert.equal(after.pause_target_item, null);
  });
});

describe('plan 86 — pause confirmation is from observation, not the flag', () => {
  it('no pending pause → null', () => {
    assert.equal(mission.pauseConfirmation(null), null);
    assert.equal(mission.pauseConfirmation({ pause_state: 'none', pause_mode: 'current_task' }), null);
    assert.equal(mission.pauseConfirmation({ pause_state: 'confirmed', pause_mode: 'current_task' }), null);
    assert.equal(mission.pauseConfirmation({ pause_state: 'requested', pause_mode: null }), null);
  });

  it('before_next_task confirms once the target item is no longer in progress', () => {
    const base = { pause_state: 'requested', pause_mode: 'before_next_task', pause_target_item: 'a' };
    assert.equal(mission.pauseConfirmation(base, { targetStatus: 'in progress' }), 'requested');
    assert.equal(mission.pauseConfirmation(base, { targetStatus: 'done' }), 'confirmed');
    assert.equal(mission.pauseConfirmation(base, { targetStatus: 'need input' }), 'confirmed');
    // No target at all: nothing is being worked, so the pause already holds.
    assert.equal(mission.pauseConfirmation({ ...base, pause_target_item: null }, {}), 'confirmed');
  });

  it('current_task confirms ONLY on a known-idle worker — never on unknown or busy', () => {
    const cur = { pause_state: 'requested', pause_mode: 'current_task', pause_target_item: 'a' };
    // Unknown idle (store unreadable) must NOT confirm — that is a "could not look".
    assert.equal(mission.pauseConfirmation(cur, { workerBusy: false, workerBusyKnown: false }), 'requested');
    assert.equal(mission.pauseConfirmation(cur, { workerBusy: null, workerBusyKnown: false }), 'requested');
    assert.equal(mission.pauseConfirmation(cur, { workerBusy: true, workerBusyKnown: true }), 'requested');
    assert.equal(mission.pauseConfirmation(cur, { workerBusy: false, workerBusyKnown: true }), 'confirmed');
  });
});

describe('plan 86 — a successful Run/Resume consumes the pause record', () => {
  // Live-found (2026-10-11): startRunner only cleared the pause record when the
  // mode was `current_task`, so a `before_next_task` record survived the Resume
  // and the dropdown badge read a false "Paused" while the queue was running.
  // The tmux seam is stubbed because this is a store/state assertion; the real
  // send path is browser-verified.
  it('clears pause_mode/pause_state for before_next_task (no false Paused after Resume)', async () => {
    const padTmux = require('../services/pad-tmux');
    const p = makeProject();
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'a', plan: 'a.md', status: 'new', reason: '' }]);
    await mission.pauseRunner(r.id, { mode: 'before_next_task' });
    assert.equal(mission.getRunner(r.id).pause_mode, 'before_next_task');

    const orig = { hasSession: padTmux.hasSession, paneState: padTmux.paneState, captureScreen: padTmux.captureScreen, sendText: padTmux.sendText };
    const agentStore = require('../services/agent-store');
    const originalTurn = agentStore.readTurn;
    agentStore.readTurn = () => ({ state: 'idle', userId: null, progressAt: null });
    let n = 0;
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', tui: true });
    // A changing screen satisfies the pane-took-the-text confirmation.
    padTmux.captureScreen = async () => ({ text: `screen ${n++}`, live: true });
    padTmux.sendText = async () => ({ lines: 1 });
    try {
      const res = await mission.startRunner(r.id);
      assert.equal(res.started, true);
      const after = mission.getRunner(r.id);
      assert.equal(after.control_state, 'enabled');
      assert.equal(after.pause_mode, null, 'pause_mode cleared');
      assert.equal(after.pause_state, 'none', 'pause_state cleared');
      assert.equal(after.pause_target_item, null);
    } finally {
      padTmux.hasSession = orig.hasSession;
      padTmux.paneState = orig.paneState;
      padTmux.captureScreen = orig.captureScreen;
      padTmux.sendText = orig.sendText;
      agentStore.readTurn = originalTurn;
    }
  });

  // Plan 88 §Phase 2: startRunner must NOT enable the runner when the startup
  // message delivery is UNCONFIRMED. An unconfirmed send leaves the runner
  // disabled/paused with a truthful reason — no automatic resend, no stuck
  // "Running" claim. The tmux seam is stubbed to force `mission_send_unconfirmed`.
  it('keeps runner disabled/paused when startup delivery is unconfirmed (mission_send_unconfirmed)', async () => {
    const padTmux = require('../services/pad-tmux');
    const missionSvc = require('../services/mission');
    const p = makeProject();
    const r = await makeRunner(p.id);
    writeQueueItems(p, [{ id: 'a', plan: 'a.md', status: 'new', reason: '' }]);

    const orig = { hasSession: padTmux.hasSession, paneState: padTmux.paneState, captureScreen: padTmux.captureScreen, sendText: padTmux.sendText };
    const agentStore = require('../services/agent-store');
    const originalTurn = agentStore.readTurn;
    agentStore.readTurn = () => ({ state: 'idle', userId: null, progressAt: null });
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', tui: true });
    // Pane changes (repaints) but agent store shows NO new activity → unconfirmed
    let n = 0;
    padTmux.captureScreen = async () => ({ text: `screen ${n++}`, live: true });
    // Throw mission_send_unconfirmed to simulate store-correlated unconfirmed delivery
    padTmux.sendText = async () => {
      const e = new Error('The message was written and the pane changed, but the agent\'s store shows no new activity for this conversation, so delivery is unconfirmed — reconcile or retry');
      e.code = 'mission_send_unconfirmed';
      e.acceptance = 'unknown';
      e.attempted = true;
      throw e;
    };
    try {
      await assert.rejects(
        missionSvc.startRunner(r.id),
        (e) => e.code === 'mission_send_unconfirmed'
      );
      // Runner must stay disabled and paused with a truthful reason
      const after = missionSvc.getRunner(r.id);
      assert.equal(Number(after.enabled), 0, 'runner must stay disabled on unconfirmed delivery');
      assert.equal(after.control_state, 'paused', 'runner must stay paused on unconfirmed delivery');
      assert.match(after.last_reason || '', /unconfirmed/i, 'reason must mention unconfirmed delivery');
      // Must NOT have been enabled — the defect Plan 88 fixes
      assert.equal(after.pause_mode, null, 'pause_mode should be cleared (success path clears it)');
      assert.equal(after.pause_state, 'none', 'pause_state should be cleared');
    } finally {
      padTmux.hasSession = orig.hasSession;
      padTmux.paneState = orig.paneState;
      padTmux.captureScreen = orig.captureScreen;
      padTmux.sendText = orig.sendText;
      agentStore.readTurn = originalTurn;
    }
  });

  // Plan 90's real watcher/send/race guards are exercised in runner-dispatch.test.js.
  // The old "mutation test" here never enabled its runner and replaced an export
  // rather than the lexical dispatch function, so it proved nothing about dispatch.
});
