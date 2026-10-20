const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-migration-'));
const file = path.join(root, 'old.db');
const dbModule = path.resolve(__dirname, '../services/db.js');
const fields = ['operation_session_id', 'operation_prompt_hash', 'operation_baseline_user_id', 'operation_receipt_user_id', 'worker_state', 'worker_turn_id', 'idle_since', 'scheduler_decision', 'scheduler_reason', 'recovery_count'];
function boot() {
  const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(dbModule)}).getDb().close()`], { env: { ...process.env, WORKSPACE_ROOT: root, PAD_DB_PATH: file }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
after(() => fs.rmSync(root, { recursive: true, force: true }));
it('adds plan-90 columns to a populated real old schema, preserves data, and reboots idempotently', () => {
  boot();
  let db = new Database(file);
  // Derive the old fixture from production schema rather than guessing its FKs.
  db.pragma('foreign_keys = ON');
  db.prepare("INSERT INTO agents (id,name,agent_type,runtime_type,runtime_ref,status) VALUES ('pad-old','pad-old','opencode','docker','pad-old','running')").run();
  db.prepare("INSERT INTO mission_projects (id,name,agent_name,agent_type,folder) VALUES ('p','Old project','pad-old','opencode','/workspace')").run();
  db.prepare("INSERT INTO infinite_runners (id,name,project_id,operation_id,operation_status,run_generation) VALUES ('existing','Keep me','p','receipt','unconfirmed',7)").run();
  for (const field of fields) db.exec(`ALTER TABLE infinite_runners DROP COLUMN ${field}`);
  const absent = new Set(db.prepare('PRAGMA table_info(infinite_runners)').all().map((c) => c.name));
  for (const field of fields) assert.equal(absent.has(field), false, `${field} must really be absent before migration`);
  db.close();
  boot(); boot();
  db = new Database(file);
  const columns = new Set(db.prepare('PRAGMA table_info(infinite_runners)').all().map((c) => c.name));
  for (const field of fields) assert.ok(columns.has(field), field);
  const row = db.prepare("SELECT * FROM infinite_runners WHERE id = 'existing'").get();
  assert.equal(row.name, 'Keep me'); assert.equal(row.run_generation, 7);
  assert.equal(row.operation_id, 'receipt'); assert.equal(row.operation_status, 'unconfirmed');
  assert.equal(row.worker_state, 'unknown'); assert.equal(row.recovery_count, 0);
  assert.equal(row.operation_receipt_user_id, null, 'no fabricated receipt during migration');
  db.close();
});
