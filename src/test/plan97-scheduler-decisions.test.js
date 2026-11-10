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

describe('Plan 97: computeSchedulerState - core dispatch decision logic', () => {
  it('returns wait_turn_end when worker turn is running (resolution race)', () => {
    const runner = {
      id: 'runner-test',
      canonicalState: 'running',
      run_generation: 1,
      idle_grace_ms: 120000,
      min_nudge_interval_ms: 120000,
      no_progress_budget: 3,
      compaction_grace_ms: 300000,
      long_command_threshold_ms: 1800000,
      recover_exited: 1,
      recovery_budget: 3,
      operation_status: 'none',
      retry_count: 0,
      last_dispatch_at: null,
      last_nudge_at: null,
      last_dispatch_revision: null,
    };

    const queue = {
      aggregate: { state: 'running' },
      parsed: { items: [{ id: 'item1', plan: 'plans/test-plan.md', status: 'new', reason: '' }] },
      hash: 'abc123',
    };

    const turn = {
      state: 'working',
      outcome: null,
      at: new Date().toISOString(),
      userId: 'user-1',
    };

    const now = Date.now();
    const decision = mission.computeSchedulerState(runner, queue, turn, now, { explicit: false });

    console.log('Decision:', decision);

    assert.equal(decision.schedulerDecision, 'wait_turn_end');
    assert.ok(decision.reason.includes('Waiting for current turn') || decision.reason.includes('wait_turn_end'));
    assert.equal(decision.workerState, 'working');

    console.log('Test passed: computeSchedulerState correctly returns wait_turn_end for busy worker');
  });

  it('returns dispatch when worker turn is idle and queue has work', () => {
    const runner = {
      id: 'runner-test',
      canonicalState: 'running',
      run_generation: 1,
      idle_grace_ms: 120000,
      min_nudge_interval_ms: 120000,
      no_progress_budget: 3,
      compaction_grace_ms: 300000,
      long_command_threshold_ms: 1800000,
      recover_exited: 1,
      recovery_budget: 3,
      operation_status: 'none',
      retry_count: 0,
      last_dispatch_at: null,
      last_nudge_at: null,
      last_dispatch_revision: null,
      idle_since: new Date(Date.now() - 180000).toISOString(),
    };

    const queue = {
      aggregate: { state: 'running' },
      parsed: { items: [{ id: 'item1', plan: 'plans/test-plan.md', status: 'new', reason: '' }] },
      hash: 'abc123',
    };

    const turn = {
      state: 'idle',
      outcome: 'completed',
      at: new Date(Date.now() - 60000).toISOString(),
      userId: 'user-1',
    };

    const now = Date.now();
    const decision = mission.computeSchedulerState(runner, queue, turn, now, { explicit: false });

    console.log('Decision (idle):', decision);

    assert.equal(decision.schedulerDecision, 'dispatch');
    assert.equal(decision.workerState, 'idle');

    console.log('Test passed: computeSchedulerState correctly returns dispatch for idle worker');
  });

it('returns wait_idle_grace when worker just finished and idle grace has not elapsed', () => {
    const runner = {
      id: 'runner-test',
      canonicalState: 'running',
      run_generation: 1,
      idle_grace_ms: 120000,
      min_nudge_interval_ms: 120000,
      no_progress_budget: 3,
      compaction_grace_ms: 300000,
      long_command_threshold_ms: 1800000,
      recover_exited: 1,
      recovery_budget: 3,
      operation_status: 'none',
      retry_count: 0,
      last_dispatch_at: new Date(Date.now() - 30000).toISOString(),
      last_nudge_at: null,
      last_dispatch_revision: null,
      idle_since: new Date(Date.now() - 30000).toISOString(),
    };

    const queue = {
      aggregate: { state: 'running' },
      parsed: { items: [{ id: 'item1', plan: 'plans/test-plan.md', status: 'new', reason: '' }] },
      hash: 'abc123',
    };

    const turn = {
      state: 'idle',
      outcome: 'completed',
      at: new Date(Date.now() - 30000).toISOString(),
      userId: 'user-1',
    };

    const now = Date.now();
    const decision = mission.computeSchedulerState(runner, queue, turn, now, { explicit: false });

    console.log('Decision (idle grace):', decision);

    assert.equal(decision.schedulerDecision, 'wait_idle_grace');
    assert.ok(decision.nextCheckMs > 0 && decision.nextCheckMs <= 120000);

    console.log('Test passed: computeSchedulerState correctly returns wait_idle_grace');
  });
});
