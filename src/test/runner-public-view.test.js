// Plan 114 §2: the outward runner view (`publicRunner`, served by
// /api/mission/runners) must not contradict the canonical runtime with legacy
// observation columns that outlived their transition.
const { after, beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-public-view-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'view.db');
const PAD = 'pad-public-view';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');

after(() => fs.rmSync(root, { recursive: true, force: true }));

let runner;
let session;
beforeEach(async () => {
  getDb().exec(`DELETE FROM runner_quota_recoveries; DELETE FROM runner_operations; DELETE FROM runner_transitions;
    DELETE FROM runner_publications; DELETE FROM runner_publication_leases; DELETE FROM runner_projection_owners;
    DELETE FROM runner_runtime; DELETE FROM runner_queue_events; DELETE FROM runner_queue_items; DELETE FROM runner_queues;
    DELETE FROM runner_history; DELETE FROM runner_queue_observations; DELETE FROM infinite_runners;
    DELETE FROM mission_sessions; DELETE FROM mission_projects; DELETE FROM activity_events; DELETE FROM agents;`);
  getDb().prepare("INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')").run(PAD, PAD, PAD);
  const project = mission.createProject({ name: 'view', agent: PAD, folder: '/root/.opencode/workspace', plansFolder: 'plans' });
  session = mission.createSession(project.id, { agentSessionId: 'ses_view' });
  runner = await mission.createRunner({ projectId: project.id, name: 'view', sessionId: session.id });
  // The exact stale shape seen live: an old idle-grace decision and a working worker.
  getDb().prepare("UPDATE infinite_runners SET worker_state = 'working', worker_turn_id = 'msg_old', idle_since = '2026-10-23T20:01:41Z', scheduler_decision = 'wait_idle_grace', scheduler_reason = 'Worker idle — grace 118s remaining' WHERE id = ?").run(runner.id);
});

const setRuntime = (state) => getDb().prepare('INSERT OR REPLACE INTO runner_runtime (runner_id, state, generation, updated_at) VALUES (?, ?, 1, ?)').run(runner.id, state, new Date().toISOString());

it('a paused runner reports a paused scheduler decision, not a stale idle-grace countdown', () => {
  setRuntime('paused');
  const v = mission.publicRunner(mission.getRunner(runner.id));
  assert.equal(v.execution.state, 'paused');
  assert.equal(v.scheduler_decision, 'paused');
  assert.doesNotMatch(String(v.scheduler_reason), /grace/);
});

it('a runner with no bound session reports an unknown worker, not a stale working turn', () => {
  setRuntime('paused');
  getDb().prepare('UPDATE infinite_runners SET session_id = NULL WHERE id = ?').run(runner.id);
  const v = mission.publicRunner(mission.getRunner(runner.id));
  assert.equal(v.worker_state, 'unknown');
  assert.equal(v.worker_turn_id, null);
  assert.equal(v.idle_since, null);
});

it('positive twin: a RUNNING runner keeps its live scheduler and worker fields', () => {
  setRuntime('running');
  const v = mission.publicRunner(mission.getRunner(runner.id));
  assert.equal(v.scheduler_decision, 'wait_idle_grace');
  assert.equal(v.worker_state, 'working');
  assert.equal(v.worker_turn_id, 'msg_old');
});

it('internals still see the raw columns (grace timing reads idle_since)', () => {
  setRuntime('paused');
  assert.equal(mission.getRunner(runner.id).idle_since, '2026-10-23T20:01:41Z');
});
