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

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, SERVER_NAME, SERVER_VERSION, mcpContext, toolAllowed } = require('../mcp');
const { getDb } = require('../services/db');
const registry = require('../services/agent-registry');
const plans = require('../services/plans');
const agentStore = require('../services/agent-store');
const mission = require('../services/mission');
const Database = require('better-sqlite3');

const STORE_URL = pathToFileURL(
  path.join(__dirname, '..', 'client', 'src', 'stores', 'mission.js')
).href;

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

describe('Plan 97: Resolution race - send answer then Start fails on busy worker', () => {
  it('send answer then Start fails because worker becomes busy - the resolution race', async () => {
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

    // Insert a session that the runner will use
    const sessionId = 'ses_' + Date.now().toString(36);
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, created_by, agent_session_id, created_at, last_seen_at, last_screen, last_screen_at, last_screen_truncated, locked)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('sess1', projectId, 'tmux_sess1', 'Test session', 'human', 'user:user-1', sessionId, now, now, '', now, 0, 0);

    // Create a runner using the service - let it bind to the existing session
    const runnerResult = await mission.createRunner({
      projectId,
      name: 'test-runner',
      sessionId: 'sess1',
    });
    const runnerId = runnerResult.id;
    console.log('Created runner:', runnerId);

    // Manually set the runner to need_input state with a queue
    db.prepare(`
      UPDATE infinite_runners
      SET enabled = 0, control_state = 'need_input', run_generation = 1, operation_generation = 0, operation_status = 'none'
      WHERE id = ?
    `).run(runnerId);

    const queueContent = `# Queue\n\n- id: test-item-1\n  plan: plans/test-plan.md\n  status: need input\n  reason: Need your answer to proceed\n`;
    fs.writeFileSync(path.join(WS, 'a-data', 'workspace', 'plans', 'QUEUE.md'), queueContent, 'utf8');
    fs.writeFileSync(path.join(WS, 'a-data', 'workspace', 'plans', 'test-plan.md'), `---\nsession: null\ncreated: '2026-10-15T00:00:00Z'\nlast_activity: '2026-10-15T00:00:00Z'\nstarted: '2026-10-15T00:00:00Z'\ndone: false\n---\n\n## Status: new\n\nTest plan content.\n`, 'utf8');
    fs.writeFileSync(path.join(WS, 'a-data', 'workspace', 'plans', 'INDEX.md'), `# Plans\n\nThis folder holds plans for this project.\n`, 'utf8');

    // Now test the resolution race
    // First, send the answer (this makes the worker busy)
    const sendResult = await mission.sendText('sess1', `Resolution for "plans/test-plan.md": This is the answer`, { actor: 'user:user-1' });
    console.log('Send result:', sendResult);

    // Then try to start the runner - this should fail with "Waiting for current turn"
    try {
      await mission.startRunner(runnerId);
      console.log('Start runner succeeded unexpectedly');
      assert.fail('Expected startRunner to fail with worker not idle');
    } catch (e) {
      console.log('Start runner failed as expected:', e.message, e.code);
      assert.ok(e.message.includes('Waiting for current turn') || e.message.includes('worker not idle') || e.code === 'runner_worker_not_idle');
    }
  });
});