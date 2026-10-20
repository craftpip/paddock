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

    -- Plan 92 §Phase 2: lifecycle callback scripts. Settings keyed by
    -- (runner, event); absent row (or absent file) is a DISABLED callback, so
    -- existing runners need no data migration. History carries plain-text
    -- runner/project identity with deliberately NO foreign key to
    -- infinite_runners: destroy deletes that row, and history plus script
    -- files must survive it.
    CREATE TABLE IF NOT EXISTS runner_callbacks (
      runner_id TEXT NOT NULL,
      event TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      revision TEXT,
      updated_at TEXT,
      PRIMARY KEY (runner_id, event)
    );
    CREATE TABLE IF NOT EXISTS runner_callback_history (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      runner_name TEXT NOT NULL,
      event TEXT NOT NULL,
      script_revision TEXT,
      status TEXT NOT NULL,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      truncated INTEGER NOT NULL DEFAULT 0,
      cwd TEXT,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL
    );
    -- Plan 92 §Phase 3: durable callback outbox. Rows are NEVER deleted (they
    -- are the dedup record and the audit trail); finished rows mirror into
    -- history for owner-scoped reads. dedup_key is the one uniqueness guard:
    -- runner:event for init/destroy, runner:event:item:attempt for plan
    -- events, runner:event:episode for usage exhaustion.
    CREATE TABLE IF NOT EXISTS runner_callback_outbox (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      runner_name TEXT NOT NULL,
      project_name TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      session_id TEXT,
      event TEXT NOT NULL,
      item_id TEXT,
      item_attempt TEXT,
      plan_path TEXT,
      queue_path TEXT,
      usage_reason TEXT,
      cwd TEXT NOT NULL,
      script_revision TEXT NOT NULL,
      script_body TEXT NOT NULL,
      operation_id TEXT,
      dedup_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      truncated INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL
    );
    -- Plan 92 §Phase 3: durable per-item queue observation. A worker edits
    -- QUEUE.md with its own tools, bypassing every Paddock gate, so
    -- plan_started / plan_completed fire on OBSERVED transitions (by stable
    -- item id) rather than on a privileged write. attempt counts observed
    -- entries into "in progress": a first/next item earns a new attempt and a
    -- fresh event, a resume/restart of the SAME in-progress item is no
    -- transition, and an explicit requeue (in progress -> new -> in progress)
    -- earns attempt+1. Rows are never deleted (they are the event identity).
    CREATE TABLE IF NOT EXISTS runner_queue_observations (
      runner_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      plan_path TEXT,
      last_status TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      last_seen_at TEXT,
      started_at TEXT,
      PRIMARY KEY (runner_id, item_id)
    );
    -- Plan 92 §Phase 3: per-runner usage-exhaustion episode state. The measured
    -- rule (plan 75 row 8) is "newest message is user AND not busy AND
    -- tokens_output == 0". episode_seq counts CONFIRMED exhaustion episodes:
    -- it increments only when the signature is read AND the conversation is not
    -- busy, so a transient limit or a live turn never arms an episode, and an
    -- unreadable probe never clears one. Only measured recovery (the last input
    -- getting a real reply) resets state to clear, which re-arms the counter so
    -- a later exhaustion is a NEW episode with a new dedup key.
    CREATE TABLE IF NOT EXISTS runner_usage_state (
      runner_id TEXT PRIMARY KEY,
      episode_seq INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'clear',
      reason TEXT,
      evidence TEXT,
      observed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS runner_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      runner_id TEXT NOT NULL,
      session_id TEXT,
      type TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      actor TEXT NOT NULL,
      group_id TEXT,
      event_key TEXT UNIQUE,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runner_history_runner_id ON runner_history(runner_id, id);

    CREATE TABLE IF NOT EXISTS runner_quota_recoveries (
      event_id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      container_id TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runner_resolutions (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      answer TEXT NOT NULL,
      idempotency_key TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      requeued_at TEXT,
      resumed_at TEXT,
      FOREIGN KEY (runner_id) REFERENCES infinite_runners(id) ON DELETE CASCADE,
      UNIQUE (runner_id, idempotency_key)
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
      plans_folder TEXT NOT NULL DEFAULT 'plans',
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
      last_screen TEXT,
      last_screen_at TEXT,
      last_screen_truncated INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT,
      ended_by TEXT,
      idempotency_key TEXT,
      FOREIGN KEY (project_id) REFERENCES mission_projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS infinite_runners (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_id TEXT NOT NULL,
      session_id TEXT,
      queue_file TEXT NOT NULL DEFAULT 'QUEUE.md',
      enabled INTEGER NOT NULL DEFAULT 0,
      control_state TEXT NOT NULL DEFAULT 'paused',
      idle_grace_ms INTEGER NOT NULL DEFAULT 120000,
      min_nudge_interval_ms INTEGER NOT NULL DEFAULT 120000,
      no_progress_budget INTEGER NOT NULL DEFAULT 3,
      compaction_grace_ms INTEGER NOT NULL DEFAULT 300000,
      long_command_threshold_ms INTEGER NOT NULL DEFAULT 1800000,
      recover_exited INTEGER NOT NULL DEFAULT 1,
      recovery_budget INTEGER NOT NULL DEFAULT 3,
      run_generation INTEGER NOT NULL DEFAULT 0,
      last_progress_at TEXT,
      last_nudge_at TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_dispatch_at TEXT,
      last_dispatch_revision TEXT,
      last_reason TEXT,
      pause_mode TEXT,
      pause_state TEXT NOT NULL DEFAULT 'none',
      pause_target_item TEXT,
      pause_requested_at TEXT,
      stop_cause TEXT,
      stop_origin TEXT,
      stop_at TEXT,
      marker_sync_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES mission_projects(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES mission_sessions(id) ON DELETE SET NULL
    );

    -- Plan 113: Mission queues are server-owned rows. QUEUE.md is generated
    -- from these tables and is never read back as queue authority.
    CREATE TABLE IF NOT EXISTS runner_queues (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 0,
      custom_instructions TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (runner_id) REFERENCES infinite_runners(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS runner_queue_items (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (queue_id, position),
      FOREIGN KEY (queue_id) REFERENCES runner_queues(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runner_queue_items_queue_item
      ON runner_queue_items(queue_id, id);
    CREATE TABLE IF NOT EXISTS runner_queue_events (
      id TEXT PRIMARY KEY,
      queue_id TEXT NOT NULL,
      item_id TEXT,
      actor TEXT,
      action TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (queue_id) REFERENCES runner_queues(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS runner_transitions (
      id TEXT PRIMARY KEY,
      runner_id TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      event TEXT NOT NULL,
      actor TEXT,
      details TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (runner_id) REFERENCES infinite_runners(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_runner_transitions_runner_created
      ON runner_transitions(runner_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_mission_projects_agent ON mission_projects(agent_name);
    CREATE INDEX IF NOT EXISTS idx_mission_sessions_project ON mission_sessions(project_id);
    CREATE INDEX IF NOT EXISTS idx_infinite_runners_project ON infinite_runners(project_id);
    CREATE INDEX IF NOT EXISTS idx_runner_queue_items_queue_position ON runner_queue_items(queue_id, position);
    CREATE INDEX IF NOT EXISTS idx_runner_queue_events_queue_created ON runner_queue_events(queue_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_activity_agent ON activity_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_runner_callbacks_runner ON runner_callbacks(runner_id);
    CREATE INDEX IF NOT EXISTS idx_runner_callback_history_runner ON runner_callback_history(runner_id);
    CREATE INDEX IF NOT EXISTS idx_runner_callback_history_project ON runner_callback_history(project_id);
    CREATE INDEX IF NOT EXISTS idx_runner_callback_outbox_status ON runner_callback_outbox(status);
    CREATE INDEX IF NOT EXISTS idx_runner_callback_outbox_runner ON runner_callback_outbox(runner_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_name ON vault_items(name);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE TABLE IF NOT EXISTS task_steps (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      step TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'pending',
      status TEXT,
      session_id TEXT,
      reported_by TEXT,
      notes TEXT DEFAULT '',
      artifact TEXT DEFAULT '',
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES mission_sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_steps_task ON task_steps(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_steps_session ON task_steps(session_id);

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

  // Plan 82: a project's plans live in its own `plans/<plans_folder>/` inside the
  // project folder. Fresh DBs get it from the CREATE above; pre-existing ones
  // need the ALTER, and their rows must NOT stay empty — every existing project
  // is by definition one that never chose otherwise, so the documented default
  // is the true answer for all of them (same reasoning as `enqueue`'s default).
  const projectCols = db.prepare("PRAGMA table_info(mission_projects)").all().map(c => c.name);
  if (!projectCols.includes('plans_folder')) {
    db.exec("ALTER TABLE mission_projects ADD COLUMN plans_folder TEXT NOT NULL DEFAULT 'plans'");
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

  // Plan 65 — the session's LIFE, which `live` alone cannot answer. The surface
  // could resume a conversation but never read one (a dead session's chat was
  // unreachable: `screen: ""`), and nothing dated a death, so a caller
  // reconstructed it by diffing rows.
  //
  // `last_screen` / `last_screen_at` are stamped from the reads that ALREADY
  // capture a pane, because there is no teardown hook: tmux does not tell the
  // webui a session died, and the container that owned it may be gone before we
  // could look. The pair is a screen AND its clock — "the last thing it said" and
  // "the last thing it said three hours ago" are different answers, and a screen
  // with no age is a lie. Existing rows stay NULL, which is honest: nothing
  // captured them, and back-filling a guess would be worse than an empty one.
  //
  // `ended_at` / `ended_by` mean FIRST OBSERVED GONE, never "the moment it
  // died" — the only deaths we can date exactly are the ones we cause
  // (`ended_by: 'recreate'`), and those say so. NULL means no observation, so a
  // row that was never probed reads "unknown", not "still running".
  //
  // `idempotency_key` is the caller's own retry token (plan 65 1f). A timeout is
  // the CLIENT's to raise and a timed-out call has no response to help with, so
  // the recovery has to live in the retry: a repeat call carrying the same key
  // finds the row it already made. Uniqueness is per project and scoped to
  // non-NULL keys, so a project with many un-keyed sessions is unaffected.
  for (const [col, decl] of [
    ['last_screen', 'TEXT'],
    ['last_screen_at', 'TEXT'],
    ['last_screen_truncated', 'INTEGER NOT NULL DEFAULT 0'],
    ['ended_at', 'TEXT'],
    ['ended_by', 'TEXT'],
    ['idempotency_key', 'TEXT'],
  ]) {
    if (!sessionCols.includes(col)) db.exec(`ALTER TABLE mission_sessions ADD COLUMN ${col} ${decl}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_sessions_idem
    ON mission_sessions(project_id, idempotency_key) WHERE idempotency_key IS NOT NULL`);

  // Plan 86: dispatch lease columns for the supervisor's one-task-per-turn design.
  // Plan 88 §Phase 3: durable per-run operation tracking (idempotency, pending/unconfirmed state).
  for (const table of ['runner_callbacks', 'runner_callback_outbox']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes('recreate_resume')) db.exec(`ALTER TABLE ${table} ADD COLUMN recreate_resume INTEGER NOT NULL DEFAULT 0`);
  }
  const runnerCols = db.prepare("PRAGMA table_info(infinite_runners)").all().map(c => c.name);
  for (const [col, decl] of [
    ['queue_file', "TEXT NOT NULL DEFAULT 'QUEUE.md'"],
    ['last_dispatch_at', 'TEXT'],
    ['last_dispatch_revision', 'TEXT'],
    // Plan 86 §Phase 4b: two pause modes need to persist which mode was
    // requested, whether the worker has confirmed it, which item was targeted,
    // and when — so a refresh/restart mid-pause does not lose the pending
    // request and never shows a false "Paused" for a request still in flight.
    ['pause_mode', 'TEXT'],
    ['pause_state', "TEXT NOT NULL DEFAULT 'none'"],
    ['pause_target_item', 'TEXT'],
    ['pause_requested_at', 'TEXT'],
    // Plan 88 §Phase 3: durable operation identity for idempotency and
    // send/ack reconciliation. An operation is created BEFORE dispatch,
    // tracked through pending → unconfirmed/confirmed/ended/invalidated.
    ['operation_id', 'TEXT'],
    ['operation_generation', 'INTEGER NOT NULL DEFAULT 0'],
    ['operation_status', "TEXT NOT NULL DEFAULT 'none'"],
    ['operation_started_at', 'TEXT'],
    ['operation_confirmed_at', 'TEXT'],
    ['operation_session_id', 'TEXT'],
    ['operation_prompt_hash', 'TEXT'],
    ['operation_baseline_user_id', 'TEXT'],
    ['operation_receipt_user_id', 'TEXT'],
    ['worker_state', "TEXT NOT NULL DEFAULT 'unknown'"],
    ['worker_turn_id', 'TEXT'],
    ['idle_since', 'TEXT'],
    ['scheduler_decision', 'TEXT'],
    ['scheduler_reason', 'TEXT'],
    ['recovery_count', 'INTEGER NOT NULL DEFAULT 0'],
    // Plan 91 §Phase 2: editable runner-to-LLM prompt templates. Nullable TEXT
    // holding the validated set as JSON; NULL means the shipped default set, so
    // existing rows are never rewritten by the migration.
    ['prompt_templates_json', 'TEXT'],
    // Plan 97: stop provenance and marker sync tracking
    ['stop_cause', 'TEXT'],
    ['stop_origin', 'TEXT'],
    ['stop_at', 'TEXT'],
    ['marker_sync_error', 'TEXT'],
  ]) {
    if (!runnerCols.includes(col)) db.exec(`ALTER TABLE infinite_runners ADD COLUMN ${col} ${decl}`);
  }
  // Plan 92 §Phase 3: past-run cwd display on history rows predating the column.
  const histCols = db.prepare('PRAGMA table_info(runner_callback_history)').all().map((c) => c.name);
  if (!histCols.includes('cwd')) db.exec('ALTER TABLE runner_callback_history ADD COLUMN cwd TEXT');
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = { getDb, close };
