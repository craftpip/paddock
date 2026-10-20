const { describe, it, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

register('./helpers/client-store-resolve.mjs', pathToFileURL(__filename));

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-plan97-'));
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-plan97-db-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'plan97.test.db');
process.on('exit', () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
});

const { getDb } = require('../services/db');
const registry = require('../services/agent-registry');
const plans = require('../services/plans');
const agentStore = require('../services/agent-store');
const mission = require('../services/mission');
const Database = require('better-sqlite3');

const PAD = 'pad-plan97';
const OUTSIDE = 'pad-plan97-out';
const NOT_OPTED = 'pad-plan97-refused';
const { HOST_WORKSPACE: PROJECT } = require('../services/vm-manager');

const padRow = (n) => {
  if (n === PAD) {
    return {
      id: PAD, name: PAD, display_name: 'Plan97', agent_type: 'opencode',
      runtime_type: 'docker', runtime_ref: PAD, status: 'running',
      workspace_root: path.join(WS, 'a-data'),
      workspace_mount: null,
      workspace_dir: '/root/.opencode/workspace',
    };
  }
  if (n === OUTSIDE) {
    return {
      id: OUTSIDE, name: OUTSIDE, display_name: 'Outside', agent_type: 'opencode',
      runtime_type: 'docker', runtime_ref: OUTSIDE, status: 'running',
      workspace_root: path.join(WS, 'o-data'),
      workspace_mount: { host: '/mnt/nowhere', container: '/mnt/x', hostBrowsable: false, hostBrowseReason: 'outside' },
      workspace_dir: '/mnt/x',
    };
  }
  return null;
};

const NOT_OPTED_ROW = () => ({
  id: NOT_OPTED, name: NOT_OPTED, display_name: 'Refused', agent_type: 'opencode',
  runtime_type: 'docker', runtime_ref: NOT_OPTED, status: 'running',
  workspace_root: path.join(WS, 'refused-data'),
  workspace_mount: {
    host: PROJECT, container: '/workspace', webuiVisible: true, hostBrowsable: false,
    hostBrowseReason: 'host browsing is not enabled for this pad (meta HOST_BROWSE=1).',
  },
  workspace_dir: '/workspace',
});

let realDiscover;
let realGetAgent;

before(async () => {
  realDiscover = registry.discoverAgents;
  realGetAgent = registry.getAgent;
  const refused = NOT_OPTED_ROW();
  registry.discoverAgents = () => [padRow(PAD), padRow(OUTSIDE), refused];
  registry.getAgent = (n) => (n === NOT_OPTED ? refused : padRow(n));
});

after(async () => {
  registry.discoverAgents = realDiscover;
  registry.getAgent = realGetAgent;
});

beforeEach(() => {
  fs.rmSync(path.join(WS, 'a-data'), { recursive: true, force: true });
  fs.rmSync(path.join(WS, 'o-data'), { recursive: true, force: true });
  fs.rmSync(path.join(WS, 'refused-data'), { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, 'a-data', 'workspace', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'o-data', 'workspace', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'refused-data', 'workspace', 'plans'), { recursive: true });

  const db = getDb();
  for (const name of [PAD, OUTSIDE, NOT_OPTED]) {
    db.prepare(
      `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
       VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'user-1')`
    ).run(name, name, name);
  }
});

describe('Plan 97: canDispatch refuses when worker is busy (resolution race core)', () => {
  it('canDispatch returns runner_worker_not_idle when turn.state is not idle', async () => {
    const db = getDb();
    // Create a project
    const projectResult = await mission.createProject({
      name: 'Test Project',
      agent: PAD,
      folder: '/root/.opencode/workspace',
      plans_folder: 'plans',
    });
    const projectId = projectResult.id;
    assert.ok(projectId);

    // Insert a session
    const sessionId = 'ses_' + Date.now().toString(36);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, created_by, agent_session_id, created_at, last_seen_at, last_screen, last_screen_at, last_screen_truncated, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess1', projectId, 'tmux_sess1', 'Test session', 'human', 'user:user-1', 'agent-sess-1', now, now, '', now, 0, 0);

    // Create a runner bound to the session
    const runnerResult = await mission.createRunner({
      projectId,
      name: 'test-runner',
      sessionId: 'sess1',
    });
    const runnerId = runnerResult.id;
    console.log('Created runner:', runnerId);

    // Enable the runner
    db.prepare(`
      UPDATE infinite_runners
      SET enabled = 1, control_state = 'enabled', run_generation = 1
      WHERE id = ?
    `).run(runnerId);

    // Create a valid queue file
    const queueContent = `# Queue\n\n- id: test-item-1\n  plan: plans/test-plan.md\n  status: new\n  reason: \n`;
    fs.writeFileSync(path.join(WS, 'a-data', 'workspace', 'plans', 'QUEUE.md'), queueContent, 'utf8');
    fs.writeFileSync(path.join(WS, 'a-data', 'workspace', 'plans', 'test-plan.md'), `---\nsession: null\ncreated: '2026-10-15T00:00:00Z'\nlast_activity: '2026-10-15T00:00:00Z'\nstarted: '2026-10-15T00:00:00Z'\ndone: false\n---\n\n## Status: new\n\nTest plan content.\n`, 'utf8');
    fs.writeFileSync(path.join(WS, 'a-data', 'workspace', 'plans', 'INDEX.md'), `# Plans\n\nThis folder holds plans for this project.\n`, 'utf8');

    // Get the runner to verify setup
    const runner = mission.getRunner(runnerId);
    assert.ok(runner);
    assert.equal(runner.enabled, 1);
    assert.equal(runner.control_state, 'enabled');
    assert.equal(runner.session_id, 'sess1');

    // Now test canDispatch with a BUSY turn (simulating the resolution race)
    // We need to mock agentStore.readTurn to return a busy turn
    const originalReadTurn = agentStore.readTurn;
    agentStore.readTurn = () => ({
      state: 'running', // Worker is busy - this simulates the resolution answer starting a turn
      outcome: null,
      at: new Date().toISOString(),
      userId: 'user-1',
    });

    try {
      // canDispatch should refuse because the worker is busy
      const result = await mission.canDispatch(runnerId, {
        session: { id: 'sess1', agent_session_id: 'agent-sess-1' },
        project: { agent_name: PAD },
        agent: { name: PAD, agent_type: 'opencode' },
        queue: { aggregate: { state: 'running' }, parsed: { items: [] }, hash: 'abc' },
        kind: 'start',
        gen: 1,
      });

      console.log('canDispatch result:', result);
      assert.equal(result.allowed, false);
      assert.ok(result.reason.includes('worker not idle') || result.code === 'runner_worker_not_idle');
      console.log('Test passed: canDispatch correctly refuses busy worker');
    } finally {
      // Restore original function
      agentStore.readTurn = originalReadTurn;
    }
  });
});