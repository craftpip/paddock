const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

// The migrations are the only schema code that ever touches a POPULATED database:
// every boot runs them against real rows, and `CREATE TABLE IF NOT EXISTS` skips a
// table that already exists — so a pre-existing table gets its new columns from
// the ALTERs alone. That path had no test, and its failure mode is quiet: a column
// that never gets added does not error at boot, it errors later as an INSERT
// against a missing column, on whatever request happened to be next.
//
// The fixture is DERIVED from the real schema rather than hand-written. A guessed
// "old" schema is not a weaker test, it is a wrong one: an early attempt omitted
// `tasks.agent_name`, so the migration blew up on `CREATE INDEX idx_tasks_agent`
// for a reason that had nothing to do with what it was meant to prove. So: let
// db.js build today's schema, populate it, then delete exactly the columns the
// ALTERs are responsible for. Everything else stays byte-for-byte real.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-mig-'));
const seedPath = path.join(dir, 'seed.db');
const oldPath = path.join(dir, 'old.db');

const dbModule = () => require.resolve('../services/db');

/** Strip a column from a table, keeping every other column and every row. */
function dropColumn(path_, table, column) {
  const db = new Database(path_);
  db.pragma('foreign_keys = OFF');
  const keep = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
    .filter((n) => n !== column);
  assert.ok(keep.length, `${table} would be left with no columns`);
  db.exec(`CREATE TABLE ${table}_stripped AS SELECT ${keep.join(', ')} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_stripped RENAME TO ${table}`);
  db.close();
}

describe('Database - migrations onto a populated pre-67 database', () => {
  let db;

  before(() => {
    // 1. today's schema, built by the real code, with real rows in it
    process.env.PAD_DB_PATH = seedPath;
    delete require.cache[dbModule()];
    db = require('../services/db').getDb();
    // mission_projects.agent_name is a real FK to agents(name), so the fixture
    // needs the agent the project points at — a shortcut here (disabling FKs)
    // would make the fixture less like a real database, not more.
    db.prepare("INSERT INTO agents (id, name, runtime_ref) VALUES ('ag_1','pad-oc','container:pad-oc')").run();
    db.prepare("INSERT INTO mission_projects (id, name, agent_name, agent_type, folder) VALUES ('prj_1','paddock','pad-oc','opencode','/www2/paddock')").run();
    const addSession = db.prepare("INSERT INTO mission_sessions (id, project_id, tmux_id, origin, created_by) VALUES (?, 'prj_1', ?, ?, ?)");
    addSession.run('msn_1', 'msn-abc', 'human', null);
    addSession.run('msn_2', 'msn-def', 'agent', 'key:key_old');
    db.prepare("INSERT INTO tasks (id, prompt, status) VALUES ('task_1','do the thing','pending')").run();
    db.close();

    // 2. rewind it to before the ALTERs
    fs.copyFileSync(seedPath, oldPath);
    dropColumn(oldPath, 'mission_sessions', 'created_by');
    // Plan 62 1f: the probe/output split lives in two new columns, and a
    // pre-62 database has neither. `noteOutput`'s UPDATE would throw
    // SQLITE_MISMATCH on the very first capture — the same class of death as
    // the tasks column below, reached from a request instead of a timer.
    dropColumn(oldPath, 'mission_sessions', 'last_output_at');
    dropColumn(oldPath, 'mission_sessions', 'last_output_hash');
    dropColumn(oldPath, 'tasks', 'last_output_at');

    // 3. boot for real
    process.env.PAD_DB_PATH = oldPath;
    delete require.cache[dbModule()];
    db = require('../services/db').getDb();
  });

  after(() => {
    db.close();
    delete process.env.PAD_DB_PATH;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

  it('adds created_by to a mission_sessions table that predates it', () => {
    // The assertion that matters: CREATE TABLE IF NOT EXISTS skipped this table,
    // so the ALTER is the ONLY thing that could have added the column.
    assert.ok(cols('mission_sessions').includes('created_by'), 'created_by was added by the migration');
  });

  it('adds the output clock and its hash to a mission_sessions table that predates them', () => {
    // Both, or the pair is useless: `last_output_at` with no hash advances on
    // every read, which is the lie 1f is fixing, so a half-migration would look
    // like the fix and behave like the bug.
    assert.ok(cols('mission_sessions').includes('last_output_at'), 'last_output_at was added by the migration');
    assert.ok(cols('mission_sessions').includes('last_output_hash'), 'and the hash that makes "changed" answerable');
    const row = db.prepare("SELECT last_output_at, last_output_hash FROM mission_sessions WHERE id='msn_1'").get();
    assert.strictEqual(row.last_output_at, null, 'a session from before the migration claims no output');
    assert.strictEqual(row.last_output_hash, null, 'and no content to compare against');
  });

  it('adds last_output_at to a tasks table that predates it', () => {
    // The column whose absence once threw SQLITE_ERROR out of a timer callback
    // and took the whole webui down.
    assert.ok(cols('tasks').includes('last_output_at'));
  });

  it('keeps every pre-existing row', () => {
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM mission_sessions').get().c, 2);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM mission_projects').get().c, 1);
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM tasks').get().c, 1);
  });

  it('leaves a pre-existing session NULL rather than inventing a provenance', () => {
    // Why it is not back-filled: an invented `createdBy` would be believed by
    // every later reader and is indistinguishable from a real one. NULL is the
    // only value we can assert honestly.
    const row = db.prepare("SELECT created_by FROM mission_sessions WHERE id='msn_1'").get();
    assert.strictEqual(row.created_by, null, 'a session from before the migration says nothing about who created it');
  });

  it('accepts a provenance value for a session created after the migration', () => {
    db.prepare("INSERT INTO mission_sessions (id, project_id, tmux_id, origin, created_by) VALUES ('msn_3','prj_1','msn-ghi','agent','key:key_abc')").run();
    assert.strictEqual(db.prepare("SELECT created_by FROM mission_sessions WHERE id='msn_3'").get().created_by, 'key:key_abc');
  });

  it('is idempotent, and a later boot does not clobber a recorded provenance', () => {
    // Every restart re-runs all of this against the same file, so "already
    // migrated" is the COMMON case, not an edge case. A migration that threw on
    // the second boot would break every restart after an upgrade.
    //
    // This is also the ONLY place "do not overwrite existing values" can be
    // tested. A pre-67 database has no created_by values at all — the column did
    // not exist to hold them — so "preserve a provenance that was already
    // recorded" is not a scenario an old database can produce, and a test for it
    // is measuring the fixture's own construction rather than the migration.
    db.close();
    delete require.cache[dbModule()];
    db = require('../services/db').getDb();
    assert.ok(cols('mission_sessions').includes('created_by'));
    assert.strictEqual(db.prepare('SELECT COUNT(*) c FROM mission_sessions').get().c, 3, 'and it touched no data');
    assert.strictEqual(
      db.prepare("SELECT created_by FROM mission_sessions WHERE id='msn_3'").get().created_by,
      'key:key_abc',
      'a value written after the first migration survives the next boot'
    );
  });
});
