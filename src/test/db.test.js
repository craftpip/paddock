const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Database - Schema', () => {
  const { getDb } = require('../services/db');

  it('creates and initializes database', () => {
    const db = getDb();
    assert.ok(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('agents'));
    assert.ok(tableNames.includes('activity_events'));
    assert.ok(tableNames.includes('sessions'));
  });

  it('can insert and query agents', () => {
    const db = getDb();
    const testId = 'vm-test-unit';
    try {
      db.prepare(`INSERT OR REPLACE INTO agents (id, name, display_name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(testId, testId, 'Test', 'openclaw', 'docker', testId, 'running');
      const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(testId);
      assert.ok(row);
      assert.strictEqual(row.status, 'running');
    } finally {
      db.prepare('DELETE FROM agents WHERE name = ?').run(testId);
    }
  });

  it('can insert and query activity events', () => {
    const db = getDb();
    const testAgent = 'vm-test-activity';
    try {
      db.prepare(`INSERT OR REPLACE INTO agents (id, name, display_name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(testAgent, testAgent, 'Test', 'openclaw', 'docker', testAgent, 'running');
      db.prepare(`INSERT INTO activity_events (agent_id, category, action, status, details) VALUES (?, ?, ?, ?, ?)`)
        .run(testAgent, 'test', 'unit_test', 'ok', 'Test event');
      const events = db.prepare('SELECT * FROM activity_events WHERE agent_id = ?').all(testAgent);
      assert.ok(events.length > 0);
      assert.strictEqual(events[0].action, 'unit_test');
    } finally {
      db.prepare('DELETE FROM activity_events WHERE agent_id = ?').run(testAgent);
      db.prepare('DELETE FROM agents WHERE name = ?').run(testAgent);
    }
  });
});
