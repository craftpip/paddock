const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const { ensureDbOwned } = require('./ownership');

// The env override exists so a test can point at a FIXTURE — the migrations below
// are the one part of the schema that runs against a real, populated database on
// every boot, and they had no coverage: a migration that silently does nothing
// (column missing) only surfaces much later as a failing INSERT. Unset in
// production, where the path is the one below.
const DB_PATH = process.env.PAD_DB_PATH || path.join(__dirname, '..', 'data', 'app.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  migrate(_db);
  // The webui runs as root (plan 43); a fresh db / new wal-shm would be
  // root-owned, so chown them back to PUID/PGID right after open.
  ensureDbOwned();
  return _db;
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      agent_type TEXT NOT NULL DEFAULT 'openclaw',
      runtime_type TEXT NOT NULL DEFAULT 'docker',
      runtime_ref TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unknown',
      workspace_root TEXT,
      config_root TEXT,
      default_model TEXT,
      default_provider TEXT,
      owner_id TEXT,
      tags TEXT DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_activity_at TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT DEFAULT 'system',
      status TEXT NOT NULL DEFAULT 'ok',
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      details TEXT,
      resource_ref TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'direct',
      status TEXT NOT NULL DEFAULT 'active',
      summary TEXT,
      model TEXT,
      provider TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_estimate REAL DEFAULT 0,
      source TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    CREATE TABLE IF NOT EXISTS vault_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT DEFAULT '',
      enc_value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vault_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pin_set INTEGER NOT NULL DEFAULT 0,
      pin_salt TEXT,
      master_wrapped TEXT,
      pin_set_at TEXT
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent_name TEXT,
      prompt TEXT NOT NULL,
      model TEXT,
      agent_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority INTEGER NOT NULL DEFAULT 0,
      pid INTEGER,
      claimed_by TEXT,
      exit_code INTEGER,
      stdout TEXT DEFAULT '',
      stderr TEXT DEFAULT '',
      result_summary TEXT DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT,
      last_output_at TEXT,
      -- Plan 63: facts about HOW the task was filed and how it ended. The
      -- agent-facing vocabulary (route / outcome / timedOut) is DERIVED from
      -- these, never stored as its own column — two names for one value is the
      -- defect this plan exists to remove.
      enqueue INTEGER DEFAULT 0,
      timeout_ms INTEGER,
      timed_out INTEGER DEFAULT 0,
      attempt INTEGER DEFAULT 1,
      superseded_by TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_name);
    CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(status, priority, created_at);

    -- Mission (plan 53): a project IS an (agent, folder) pair -- many projects
    -- per agent is the normal case, so no UNIQUE on that pair. A session is the
    -- only unit of work: one row per live tmux session (msn-*) running the
    -- agent's TUI in the project's folder, typed into by the human and the
    -- agent alike.
    CREATE TABLE IF NOT EXISTS mission_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      folder TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS mission_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      tmux_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      origin TEXT NOT NULL DEFAULT 'human',
      created_by TEXT,
      locked INTEGER NOT NULL DEFAULT 0,
      agent_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT,
      FOREIGN KEY (project_id) REFERENCES mission_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_mission_projects_agent ON mission_projects(agent_name);
    CREATE INDEX IF NOT EXISTS idx_mission_sessions_project ON mission_sessions(project_id);

    CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_name ON vault_items(name);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
  `);

  // Add owner_id to agents if missing (from older schema)
  const cols = db.prepare("PRAGMA table_info(agents)").all().map(c => c.name);
  if (!cols.includes('owner_id')) {
    db.exec("ALTER TABLE agents ADD COLUMN owner_id TEXT");
  }

  // The task runner stamps last_output_at as a liveness heartbeat so a stale
  // "running" row can be told from a live one. Older databases predate the
  // column, and the runner's UPDATE then threw SQLITE_ERROR from a timer
  // callback — which took the whole webui down. Fresh DBs get it from the
  // CREATE above; these need the ALTER.
  const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map(c => c.name);
  if (!taskCols.includes('last_output_at')) {
    db.exec("ALTER TABLE tasks ADD COLUMN last_output_at TEXT");
  }

  // Plan 63 1f/1e/1i — the facts the queue's vocabulary is derived from.
  // `enqueue` says the task was FILED for a worker to claim rather than pushed
  // (route); `timed_out` separates the 10-minute kill from a user cancel, which
  // both used to land on status `cancelled` and so read identically; `attempt` +
  // `superseded_by` make a retry chain visible instead of leaving repeated
  // failures as independent rows. Existing rows keep the defaults: a task filed
  // before this existed was pushed unless a worker claimed it, and a
  // `cancelled` row that predates the column was cancelled, not timed out.
  for (const [col, decl] of [
    ['enqueue', 'INTEGER DEFAULT 0'],
    ['timeout_ms', 'INTEGER'],
    ['timed_out', 'INTEGER DEFAULT 0'],
    ['attempt', 'INTEGER DEFAULT 1'],
    ['superseded_by', 'TEXT'],
  ]) {
    if (!taskCols.includes(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} ${decl}`);
  }

  // Which key (or which signed-in user) opened a Mission session (plan 67,
  // 67.3). `origin` only says the KIND of starter — human or agent — so
  // "did I start this one?" and "was that really an agent?" both had no
  // answer beyond the caller's own memory. Fresh DBs get the column from the
  // CREATE above; existing ones need the ALTER, and their rows stay NULL
  // rather than being back-filled with a guess.
  const sessionCols = db.prepare("PRAGMA table_info(mission_sessions)").all().map(c => c.name);
  if (!sessionCols.includes('created_by')) {
    db.exec("ALTER TABLE mission_sessions ADD COLUMN created_by TEXT");
  }

  // `last_seen_at` moved a long time and a caller could not tell what it meant:
  // it was a PROBE clock (something asked) sitting under a name that reads as
  // ACTIVITY (the agent did something). Plan 62 1f splits the two. `last_output_at`
  // is the one a caller actually wants — it advances only when the pane's content
  // genuinely CHANGED, so a stale one means the agent has gone quiet. The hash
  // is what makes "changed" answerable: without it every read would look like
  // output and the field would be the same lie wearing a new name. Rows stay NULL
  // until something has actually captured a pane — a guess would be worse.
  if (!sessionCols.includes('last_output_at')) {
    db.exec("ALTER TABLE mission_sessions ADD COLUMN last_output_at TEXT");
  }
  if (!sessionCols.includes('last_output_hash')) {
    db.exec("ALTER TABLE mission_sessions ADD COLUMN last_output_hash TEXT");
  }
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, close };
