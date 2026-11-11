// The PAD listing must honour its owner filter. It once took no parameter at
// all, so the owner every route passed for a regular user was silently dropped
// and each signed-in user was shown the whole fleet.
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-owner-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'owner.db');
for (const pad of ['pad-alpha', 'pad-beta', 'pad-nobody']) {
  fs.mkdirSync(path.join(root, 'instances', pad), { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', pad, 'meta.env'), 'AGENT=opencode\n');
}

const { getDb } = require('../services/db');
const registry = require('../services/agent-registry');

before(() => {
  const db = getDb();
  for (const id of ['user_a', 'user_b']) db.prepare("INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, 'user', 'x')").run(id, id, id);
  registry.discoverAgents(); // sync the three PADs into the database
  registry.assignOwner('pad-alpha', 'user_a');
  registry.assignOwner('pad-beta', 'user_b');
});
after(() => { try { getDb().close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });

const names = (list) => list.map((a) => a.name).sort();

it('lists the whole fleet when no owner is given (the admin view)', () => {
  assert.deepEqual(names(registry.discoverAgents()), ['pad-alpha', 'pad-beta', 'pad-nobody']);
  assert.equal(registry.getAgentStats().total, 3);
});

it('lists only the PADs a user owns, never another user\'s and never an unowned one', () => {
  assert.deepEqual(names(registry.discoverAgents('user_a')), ['pad-alpha']);
  assert.deepEqual(names(registry.discoverAgents('user_b')), ['pad-beta']);
  assert.deepEqual(names(registry.discoverAgents('user_without_pads')), []);
  assert.equal(registry.getAgentStats('user_a').total, 1);
  assert.equal(registry.getAgentStats('user_without_pads').total, 0);
});
