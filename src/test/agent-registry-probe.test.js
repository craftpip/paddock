// Plan 124 #9 and #11: a docker listing that FAILED must not be read as "no
// containers", and a deleted PAD's runner token must not outlive it.
const { it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-probe-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'probe.db');
for (const pad of ['pad-up', 'pad-down']) {
  fs.mkdirSync(path.join(root, 'instances', pad), { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', pad, 'meta.env'), 'AGENT=opencode\n');
}

const { getDb } = require('../services/db');
const registry = require('../services/agent-registry');
const runnerToken = require('../services/runner-mcp-token');

const LISTING = 'pad-up\trunning\npad-down\texited\n';
const statusOf = (list) => Object.fromEntries(list.map((a) => [a.name, a.status]));
const dbStatus = () => Object.fromEntries(getDb().prepare('SELECT name, status FROM agents').all().map((r) => [r.name, r.status]));
const fail = () => { throw new Error('Cannot connect to the Docker daemon'); };

before(() => { getDb(); });
beforeEach(() => { registry._setPsRunner(() => LISTING); registry.discoverAgents(); });
after(() => { registry._setPsRunner(null); try { getDb().close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });

it('the fixture reads real states when docker answers', () => {
  assert.deepEqual(statusOf(registry.discoverAgents()), { 'pad-up': 'running', 'pad-down': 'exited' });
  assert.deepEqual(dbStatus(), { 'pad-up': 'running', 'pad-down': 'exited' });
});

it('a failed listing with no recent answer reports unknown, never missing', () => {
  registry._setPsRunner(fail); // also drops the cache: there is no last good answer
  assert.deepEqual(statusOf(registry.discoverAgents()), { 'pad-up': 'unknown', 'pad-down': 'unknown' });
});

it('and it does not overwrite what the database knew', () => {
  registry._setPsRunner(fail);
  registry.discoverAgents();
  assert.deepEqual(dbStatus(), { 'pad-up': 'running', 'pad-down': 'exited' },
    'a guess must not replace a recorded running/exited, or the fleet counts go to zero');
  assert.equal(registry.getAgentStats().running, 1);
});

it('a container docker really has no record of is still missing', () => {
  registry._setPsRunner(() => 'pad-up\trunning\n');
  assert.equal(statusOf(registry.discoverAgents())['pad-down'], 'missing');
});

it('fleet counts are of the PADs that exist, not of rows left in the database', () => {
  getDb().prepare("INSERT INTO agents (id, name, display_name, agent_type, runtime_type, runtime_ref, status) VALUES ('pad-ghost', 'pad-ghost', 'Ghost', 'opencode', 'docker', 'pad-ghost', 'missing')").run();
  try {
    const agents = registry.discoverAgents();
    assert.deepEqual(registry.getAgentStats(null, agents), { total: 2, running: 1, stopped: 1, unknown: 0 });
    assert.equal(registry.getAgentStats().total, 3, 'the fixture really has the stale row: the row count is what used to be shown');
    assert.equal(registry.getOrphanCount(agents.map((a) => a.name)), 2, 'two real unowned PADs, and the ghost is not one');
  } finally {
    getDb().prepare("DELETE FROM agents WHERE name = 'pad-ghost'").run();
  }
});

it('deleting a PAD revokes its runner MCP token', () => {
  const raw = runnerToken.mint('pad-down');
  const other = runnerToken.mint('pad-up');
  assert.equal(runnerToken.authenticate(raw), 'pad-down');

  registry.removeAgentFromDb('pad-down');

  assert.equal(runnerToken.authenticate(raw), null, 'the token of a deleted PAD must stop working');
  assert.equal(runnerToken.authenticate(other), 'pad-up', 'and only that PAD\'s token');
});
