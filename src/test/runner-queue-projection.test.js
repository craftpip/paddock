const { after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-queue-projection-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'test.db');
const PAD = 'pad-projection';

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const runnerQueue = require('../services/runner-queue');
const plans = require('../services/plans');
const registry = require('../services/agent-registry');

after(() => fs.rmSync(root, { recursive: true, force: true }));

function seedPad() {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status)
     VALUES (?, ?, 'opencode', 'docker', ?, 'running')`
  ).run(PAD, PAD, PAD);
  const dir = path.join(root, 'instances', PAD, 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');
}

beforeEach(() => {
  const db = getDb();
  // FKs off for the wipe: several tables reference infinite_runners with
  // different ON DELETE rules, and a per-table DELETE order that satisfies
  // all of them is a puzzle with no payoff. The wipe is total by design.
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DELETE FROM runner_queue_observations;
    DELETE FROM runner_resolutions;
    DELETE FROM runner_transitions;
    DELETE FROM runner_queue_events;
    DELETE FROM runner_queue_items;
    DELETE FROM runner_queues;
    DELETE FROM runner_callback_outbox;
    DELETE FROM runner_callback_history;
    DELETE FROM runner_callbacks;
    DELETE FROM runner_history;
    DELETE FROM runner_usage_state;
    DELETE FROM runner_quota_recoveries;
    DELETE FROM infinite_runners;
    DELETE FROM mission_sessions;
    DELETE FROM mission_projects;
    DELETE FROM agents;
  `);
  db.pragma('foreign_keys = ON');
  seedPad();
});

describe('plan 113 — the worker projection is not queue authority', () => {
  it('the generated projection hash and the canonical revision are DIFFERENT kinds of value', async () => {
    // This is the bug the fix removes: `beforeWrite` compared these two, so the
    // comparison was ALWAYS unequal and every dispatch was refused.
    const project = mission.createProject({ name: 'proj', agent: PAD, folder: '/root/.opencode/workspace', plansFolder: 'plans' });
    const session = mission.createSession(project.id, { agentSessionId: 'ses_proj' });
    const runner = await mission.createRunner({ projectId: project.id, sessionId: session.id, name: 'proj-runner' });
    await mission.setupRunnerQueue(runner.id);
    const detail = await mission.addRunnerQueueItems(runner.id, ['one.md'], 0);

    const agent = registry.getAgent(PAD);
    const file = plans.queuePath(agent, project, 'QUEUE.md');
    const parsed = plans.parseQueue(fs.readFileSync(file, 'utf8'));
    const snapshot = runnerQueue.snapshot(runner.id);

    // The canonical revision is a COUNTER; the projection hash is a sha256.
    assert.equal(detail.queue.revision, 1);
    assert.equal(snapshot.revision, 1);
    assert.notEqual(parsed.hash, snapshot.revision);
    assert.match(parsed.hash, /^[0-9a-f]{64}$/);
  });

  it('the canonical revision is what the dispatch guard compares', async () => {
    // The guard must compare the canonical revision to itself (has it moved?)
    // and detect PROJECTION DRIFT separately. A sha256-vs-counter comparison
    // can never pass, so it is not a guard at all — it is a permanent refusal.
    //
    // Anchor on the DISPATCH function, not on the first `beforeWrite` in the
    // file: the quota-recovery path has one too, and slicing from the first
    // match asserts about the wrong function (a source-text pin on a NAME).
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'mission.js'), 'utf8');
    const fnStart = src.indexOf('async function deliverRunnerInstruction(');
    assert.ok(fnStart > 0, 'found deliverRunnerInstruction');
    const start = src.indexOf('const beforeWrite = () => {', fnStart);
    assert.ok(start > fnStart, 'found the dispatch guard inside it');
    const end = src.indexOf('\n  };', start);
    const beforeWrite = src.slice(start, end);
    assert.ok(beforeWrite.length > 100, 'the guard body is non-trivial');
    // The old broken comparison is gone.
    assert.ok(!beforeWrite.includes('parsed.hash !== queue.hash'), 'no content-hash vs revision comparison');
    // The revision check reads the CANONICAL snapshot.
    assert.ok(beforeWrite.includes('current.revision !== queue.hash'), 'compares the canonical revision');
    // Drift is detected via the canonical projection, not a file hash.
    assert.ok(beforeWrite.includes('drifted.condition'), 'detects projection drift');
  });
});
