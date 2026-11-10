const { after, beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-queue-authority-'));
process.env.PAD_DB_PATH = path.join(root, 'queue.db');

const { getDb } = require('../services/db');
const queue = require('../services/runner-queue');

after(() => fs.rmSync(root, { recursive: true, force: true }));

function seedRunner(id = 'run_test') {
  const db = getDb();
  db.prepare("INSERT INTO agents (id, name, runtime_ref) VALUES ('pad_test', 'pad_test', 'pad_test')").run();
  db.prepare("INSERT INTO mission_projects (id, name, agent_name, agent_type, folder) VALUES ('prj_test', 'test', 'pad_test', 'opencode', '/workspace')").run();
  db.prepare("INSERT INTO infinite_runners (id, name, project_id) VALUES (?, 'test', 'prj_test')").run(id);
  return id;
}

beforeEach(() => {
  const db = getDb();
  db.exec('DELETE FROM runner_queue_events; DELETE FROM runner_queue_items; DELETE FROM runner_queues; DELETE FROM infinite_runners; DELETE FROM mission_projects; DELETE FROM agents;');
});

describe('plan 113 canonical runner queue', () => {
  it('allocates server item ids, records events, and rejects stale writes', () => {
    const runnerId = seedRunner();
    const initial = queue.ensure(runnerId, { actor: 'tester' });
    assert.equal(initial.revision, 0);
    const added = queue.add(runnerId, '113-authority.md', initial.revision, { actor: 'tester' });
    assert.match(added.items[0].id, /^rqi_/);
    assert.equal(added.items[0].position, 0);
    assert.equal(added.summary.next.plan, '113-authority.md');
    assert.throws(() => queue.add(runnerId, 'other.md', initial.revision), { code: 'queue_revision_conflict' });
    assert.deepEqual(queue.events(runnerId).map((event) => event.action), ['queue_created', 'item_added']);
  });

  it('normalizes path aliases before duplicate checks and queue storage', () => {
    const runnerId = seedRunner();
    let current = queue.ensure(runnerId);
    current = queue.add(runnerId, 'plans/./release.md', current.revision);
    assert.equal(current.items[0].plan, 'plans/release.md');
    assert.throws(() => queue.add(runnerId, 'plans/release.md', current.revision), { code: 'queue_plan_duplicate' });
    assert.throws(() => queue.add(runnerId, 'plans/../outside.md', current.revision), { code: 'queue_plan_invalid' });
  });

  it('keeps need-input validation and queue facts inside one transaction', () => {
    const runnerId = seedRunner();
    const initial = queue.ensure(runnerId);
    const added = queue.add(runnerId, '113-authority.md', initial.revision);
    const item = added.items[0];
    assert.throws(
      () => queue.updateItem(runnerId, item.id, { status: 'need_input', reason: '' }, added.revision),
      { code: 'queue_reason_required' }
    );
    const unchanged = queue.snapshot(runnerId);
    assert.equal(unchanged.revision, added.revision, 'a rejected item update must not advance revision');
    const blocked = queue.updateItem(runnerId, item.id, { status: 'need_input', reason: 'Need a decision.' }, added.revision);
    assert.equal(blocked.summary.blocked.id, item.id);
    assert.equal(blocked.items[0].reason, 'Need a decision.');
  });

  it('reorders, removes, and records queue-level instructions without duplicate positions', () => {
    const runnerId = seedRunner();
    let current = queue.ensure(runnerId);
    current = queue.add(runnerId, 'first.md', current.revision);
    current = queue.add(runnerId, 'second.md', current.revision);
    current = queue.reorder(runnerId, current.items.map((item) => item.id).reverse(), current.revision);
    assert.deepEqual(current.items.map((item) => item.plan), ['second.md', 'first.md']);
    current = queue.remove(runnerId, current.items[0].id, current.revision);
    assert.deepEqual(current.items.map((item) => item.position), [0]);
    current = queue.setCustomInstructions(runnerId, 'Read the release notes.', current.revision);
    assert.equal(current.customInstructions, 'Read the release notes.');
    assert.deepEqual(
      queue.events(runnerId).map((event) => event.action),
      ['queue_created', 'item_added', 'item_added', 'items_reordered', 'item_removed', 'instructions_updated']
    );
  });
});
