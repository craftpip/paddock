/** Lifecycle callback scripts for infinite runners (plan 92 §Phase 2).
 *
 * Optional user-configured system-shell scripts fired on runner lifecycle
 * events. This module owns STORAGE and settings/result reads only: script
 * files under the persistent Paddock data mount, enable flags + revisions in
 * the database, and history reads. There is NO executor here — saving or
 * previewing never executes a script (Phase 3 owns execution, and only after
 * the human answers where the shell runs).
 *
 * Two rules shape every path below:
 *  - Callers can never choose files. Paths are built ONLY from the allowlisted
 *    event key plus the server-minted runner id (both `basename`d anyway), so
 *    a `../../x` event key is rejected before it can touch the filesystem.
 *  - History must survive runner removal. `runner_callback_history` carries
 *    plain-text runner/project identity with NO foreign key to the
 *    `infinite_runners` row that destroy deletes, plus a runner-name snapshot.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { getDb } = require('./db');
const { ensureOwned } = require('./ownership');
const history = require('./runner-history');

class CallbackError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** The five lifecycle events. Meanings are user-facing copy for setup. */
const CALLBACK_EVENTS = Object.freeze([
  { key: 'init', meaning: 'Runs once after a runner is created with its configuration saved. Not on setup open, Run, resume or webui restart.' },
  { key: 'plan_started', meaning: 'Runs when a queued item first transitions into `in progress` — first and next items, not each continuation or resume of the same attempt.' },
  { key: 'plan_completed', meaning: 'Runs when an item is observed reaching valid `done` under the queue completion contract — not assistant turn end or delivery receipt.' },
  { key: 'usage_exhausted', meaning: 'Runs on evidence-backed provider usage exhaustion for the exact conversation — once per exhaustion episode, not every poll or transient rate limit.' },
  { key: 'destroy', meaning: 'Runs on explicit removal of the runner configuration, using the saved script and context — not Pause, worker exit, terminal Close or webui shutdown.' },
]);
const CALLBACK_KEYS = Object.freeze(CALLBACK_EVENTS.map((e) => e.key));

/** Event environment contract (values are provided at execution time). */
const CALLBACK_ENV_VARS = Object.freeze([
  'PADDOCK_EVENT_ID', 'PADDOCK_EVENT', 'PADDOCK_EVENT_AT',
  'PADDOCK_RUNNER_ID', 'PADDOCK_RUNNER_NAME', 'PADDOCK_PROJECT_ID',
  'PADDOCK_PROJECT_NAME', 'PADDOCK_AGENT_NAME', 'PADDOCK_SESSION_ID',
  'PADDOCK_ITEM_ID', 'PADDOCK_ITEM_ATTEMPT', 'PADDOCK_PLAN_PATH',
  'PADDOCK_QUEUE_PATH', 'PADDOCK_USAGE_REASON',
]);

const MAX_SCRIPT_BYTES = 64 * 1024;

function callbacksDir() {
  // Overridable for isolated tests (same convention as PAD_DB_PATH), so no
  // suite ever writes script files into the real worktree.
  return process.env.RUNNER_CALLBACKS_DIR || path.join(__dirname, '..', 'data', 'runner-callbacks');
}

function validateEventKey(event) {
  if (!CALLBACK_KEYS.includes(event)) {
    throw new CallbackError('callback_unknown_event', `Unknown callback event \`${event}\`: expected ${CALLBACK_KEYS.join(', ')}.`);
  }
  return event;
}

function requireRunnerRow(runnerId) {
  const row = getDb().prepare('SELECT id, project_id, name FROM infinite_runners WHERE id = ?').get(runnerId);
  if (!row) throw new CallbackError('runner_not_found', `Runner ${runnerId} not found`);
  return row;
}

function scriptPath(runnerId, event) {
  validateEventKey(event);
  return path.join(callbacksDir(), path.basename(runnerId), `${path.basename(event)}.sh`);
}

function readScriptFile(runnerId, event) {
  try {
    return fs.readFileSync(scriptPath(runnerId, event), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new CallbackError('callback_script_unreadable', `Saved script for \`${event}\` could not be read: ${e.message}`);
  }
}

function revisionOf(script) {
  return crypto.createHash('sha256').update(script, 'utf8').digest('hex');
}

/** One event's settings: file text plus enable flag and revision. An absent
 *  row (or absent file) is a DISABLED callback — existing runners get disabled
 *  callbacks with no migration of their rows. */
function getCallback(runnerId, event) {
  validateEventKey(event);
  requireRunnerRow(runnerId);
  const row = getDb().prepare('SELECT enabled, revision, updated_at, recreate_resume FROM runner_callbacks WHERE runner_id = ? AND event = ?').get(runnerId, event) || null;
  const script = readScriptFile(runnerId, event);
  return {
    runner_id: runnerId,
    event,
    enabled: row ? Number(row.enabled) === 1 : false,
    recreateResume: row ? Number(row.recreate_resume) === 1 : false,
    script,
    revision: row && row.revision ? row.revision : (script !== null ? revisionOf(script) : null),
    updated_at: row ? row.updated_at : null,
  };
}

function listCallbacks(runnerId) {
  requireRunnerRow(runnerId);
  return CALLBACK_KEYS.map((event) => getCallback(runnerId, event));
}

/** Save one event's script + flag. Validates everything before writing
 *  anything; then writes the file (tmp + rename) BEFORE the metadata row, so
 *  a revision only becomes active once both are durable. Never executes. */
function saveCallback(runnerId, event, { script, enabled, recreateResume = false } = {}) {
  validateEventKey(event);
  requireRunnerRow(runnerId);
  if (typeof recreateResume !== 'boolean' || (recreateResume && event !== 'usage_exhausted')) {
    throw new CallbackError('callback_recovery_invalid', 'Recreate and resume is only available for the usage_exhausted callback.');
  }
  if (typeof script !== 'string') {
    throw new CallbackError('callback_script_missing', `Callback \`${event}\` needs a script string.`);
  }
  if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) {
    throw new CallbackError('callback_script_too_large', `Callback \`${event}\` is ${Buffer.byteLength(script, 'utf8')} bytes; the limit is ${MAX_SCRIPT_BYTES}.`);
  }
  const on = enabled === undefined ? false : !!enabled;
  if (on && !script.trim()) {
    throw new CallbackError('callback_script_empty', `Callback \`${event}\` is enabled but its script is empty.`);
  }
  const dir = path.join(callbacksDir(), path.basename(runnerId));
  fs.mkdirSync(dir, { recursive: true });
  const abs = scriptPath(runnerId, event);
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, script, 'utf8');
  fs.renameSync(tmp, abs);
  ensureOwned(abs);
  const revision = revisionOf(script);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO runner_callbacks (runner_id, event, enabled, revision, updated_at, recreate_resume)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (runner_id, event) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision, updated_at = excluded.updated_at, recreate_resume = excluded.recreate_resume`
  ).run(runnerId, event, on ? 1 : 0, revision, now, recreateResume ? 1 : 0);
  return { runner_id: runnerId, event, enabled: on, recreateResume, script, revision, updated_at: now };
}

/** Execution history reads (writes arrive with the Phase 3 executor).
 *  Filter by runner, by project (the post-destroy owner path), or both. */
function listCallbackHistory({ runnerId = null, projectId = null, limit = 50 } = {}) {
  const conds = [];
  const params = [];
  if (runnerId) { conds.push('runner_id = ?'); params.push(runnerId); }
  if (projectId) { conds.push('project_id = ?'); params.push(projectId); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return getDb().prepare(`SELECT * FROM runner_callback_history ${where} ORDER BY created_at DESC LIMIT ${n}`).all(...params);
}

function callbackCatalogue() {
  return {
    events: CALLBACK_EVENTS.map((e) => ({ ...e })),
    envVars: [...CALLBACK_ENV_VARS],
    limits: { maxScriptBytes: MAX_SCRIPT_BYTES },
    // The resolved execution environment (plan 92 "Pending decision", RESOLVED
    // 2026-10-12): scripts run inside the Paddock control-plane container with
    // the POSIX shell. cwd is the Mission project folder (the same directory the
    // worker runs in, read from `project.folder` at launch). Stated here so the
    // editor never has to invent or hide the environment.
    environment: {
      where: 'inside the Paddock control-plane container',
      shell: 'sh',
      cwd: 'the Mission project folder',
      timeoutMs: CALLBACK_TIMEOUT_MS,
      timeoutSeconds: Math.round(CALLBACK_TIMEOUT_MS / 1000),
    },
  };
}

/* ---------------------------------------------------------------- */
/*  Phase 3 — durable outbox + bounded executor                      */
/* ---------------------------------------------------------------- */

/** Default script timeout (plan: configurable, 60s default; per-event timeout
 *  config is deferred — this constant is the contract until it lands). */
const CALLBACK_TIMEOUT_MS = 60 * 1000;
/** Fleet-wide concurrent script ceiling. Per-runner serialization is separate
 *  (one launch per runner at a time), so a chatty runner cannot starve others
 *  past this cap. */
const CALLBACK_FLEET_MAX = 4;
/** Per-stream output cap; beyond it the stream is cut and marked truncated. */
const CALLBACK_OUTPUT_MAX = 64 * 1024;

/** The one dedup guard: runner:event for init/destroy, runner:event:item:attempt
 *  for plan events, runner:event:episode for usage exhaustion. Enforced by a
 *  UNIQUE constraint, so concurrent ticks cannot double-record. */
function dedupKey({ runnerId, event, itemId = null, itemAttempt = null, episodeKey = null }) {
  validateEventKey(event);
  if (event === 'init' || event === 'destroy') return `${runnerId}:${event}`;
  if (event === 'usage_exhausted') {
    if (!episodeKey) throw new CallbackError('callback_episode_missing', 'A usage-exhaustion event needs an episode key.');
    return `${runnerId}:${event}:${episodeKey}`;
  }
  if (!itemId || itemAttempt === null || itemAttempt === undefined) {
    throw new CallbackError('callback_attempt_missing', `A ${event} event needs a stable item id and attempt.`);
  }
  return `${runnerId}:${event}:${itemId}:${itemAttempt}`;
}

/** Record an event for a runner whose callback is ENABLED, snapshotting the
 *  script body + revision at record time (later edits cannot change a recorded
 *  event). Disabled callbacks record nothing and return null. Duplicate
 *  records collapse onto the existing row via the dedup key. Never executes —
 *  callers pump separately. `snapshot` overrides the file read (destroy
 *  captures before deletion); otherwise the saved file is the snapshot. */
function recordCallbackEvent(runnerRow, project, event, details = {}, snapshot = null) {
  validateEventKey(event);
  const settings = getDb().prepare('SELECT enabled, revision, recreate_resume FROM runner_callbacks WHERE runner_id = ? AND event = ?').get(runnerRow.id, event) || null;
  if (!settings || Number(settings.enabled) !== 1) return null;
  const body = snapshot !== null && snapshot !== undefined ? String(snapshot.body || '') : readScriptFile(runnerRow.id, event);
  const revision = snapshot !== null && snapshot !== undefined ? String(snapshot.revision || revisionOf(body)) : (settings.revision || revisionOf(body || ''));
  const now = new Date().toISOString();
  const id = `cb_${crypto.randomBytes(8).toString('hex')}`;
  const row = {
    id,
    runner_id: runnerRow.id,
    project_id: project.id,
    runner_name: runnerRow.name,
    project_name: project.name,
    agent_name: project.agent_name,
    session_id: runnerRow.session_id || null,
    event,
    item_id: details.itemId || null,
    item_attempt: details.itemAttempt != null ? String(details.itemAttempt) : null,
    plan_path: details.planPath || null,
    queue_path: details.queuePath || null,
    usage_reason: details.usageReason || null,
    cwd: details.cwd || project.folder,
    script_revision: revision,
    script_body: body,
    recreate_resume: settings.recreate_resume || 0,
    operation_id: details.operationId || null,
    dedup_key: dedupKey({ runnerId: runnerRow.id, event, itemId: details.itemId, itemAttempt: details.itemAttempt, episodeKey: details.episodeKey }),
    status: 'pending',
    created_at: now,
  };
  if (body === null) {
    // Enabled but the file is gone: record the misconfiguration as a terminal
    // error row (durable evidence) rather than launching nothing silently.
    row.status = 'error';
    row.stderr = 'Enabled callback has no saved script file at record time.';
    row.started_at = now;
    row.ended_at = now;
  }
  const cols = Object.keys(row);
  try {
    getDb().prepare(`INSERT INTO runner_callback_outbox (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...cols.map((k) => row[k]));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return getDb().prepare('SELECT * FROM runner_callback_outbox WHERE dedup_key = ?').get(row.dedup_key);
    }
    throw e;
  }
  const recorded = getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(id);
  if (event === 'usage_exhausted') history.record(runnerRow, 'recovery_requested', {
    actor: details.actor || 'runner', groupId: id, key: `${id}:requested`, reason: details.usageReason || 'Provider quota recovery callback queued',
  });
  if (recorded.status !== 'pending') mirrorHistory(recorded);
  return recorded;
}

/** Mirror a settled outbox row into the owner-scoped history table (idempotent
 *  by shared id). */
function mirrorHistory(row) {
  getDb().prepare(
    `INSERT OR IGNORE INTO runner_callback_history
     (id, runner_id, project_id, runner_name, event, script_revision, status, exit_code, stdout, stderr, truncated, cwd, started_at, ended_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(row.id, row.runner_id, row.project_id, row.runner_name, row.event, row.script_revision, row.status,
    row.exit_code, row.stdout, row.stderr, row.truncated, row.cwd, row.started_at, row.ended_at, row.created_at);
}

/** Allowlisted base environment plus the event contract. The platform injects
 *  ONLY these — no inherited Paddock credentials, tokens or secrets. */
function callbackEnv(row) {
  const str = (v) => (v === null || v === undefined ? '' : String(v));
  return {
    PATH: '/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/home',
    LANG: 'C.UTF-8',
    // The local CLI must resolve the same deployment as the parent webui.
    // Deliberately allowlist non-secret routing/ownership settings only.
    CONTAINER_PREFIX: process.env.CONTAINER_PREFIX || 'pad',
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT || '/workspace',
    HOST_WORKSPACE_ROOT: process.env.HOST_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT || '/workspace',
    PUID: process.env.PUID || '1000',
    PGID: process.env.PGID || '1000',
    PADDOCK_EVENT_ID: row.id,
    PADDOCK_EVENT: row.event,
    PADDOCK_EVENT_AT: row.created_at,
    PADDOCK_RUNNER_ID: row.runner_id,
    PADDOCK_RUNNER_NAME: row.runner_name,
    PADDOCK_PROJECT_ID: row.project_id,
    PADDOCK_PROJECT_NAME: row.project_name,
    PADDOCK_AGENT_NAME: row.agent_name,
    PADDOCK_SESSION_ID: str(row.session_id),
    PADDOCK_ITEM_ID: str(row.item_id),
    PADDOCK_ITEM_ATTEMPT: str(row.item_attempt),
    PADDOCK_PLAN_PATH: str(row.plan_path),
    PADDOCK_QUEUE_PATH: str(row.queue_path),
    PADDOCK_USAGE_REASON: str(row.usage_reason),
  };
}

const launchingRunners = new Set();
let fleetRunning = 0;

/** Pump pending outbox rows: serial per runner, bounded fleet-wide. Launches
 *  are fire-and-forget (callers never await execution); completion finalizes
 *  rows in the background. Returns the number of launches started. */
async function pumpCallbackOutbox({ fleetMax = CALLBACK_FLEET_MAX } = {}) {
  const pending = getDb().prepare("SELECT * FROM runner_callback_outbox WHERE status = 'pending' ORDER BY created_at LIMIT 50").all();
  let started = 0;
  for (const row of pending) {
    if (fleetRunning >= fleetMax) break;
    if (launchingRunners.has(row.runner_id)) continue; // serial per runner
    const busy = getDb().prepare("SELECT 1 FROM runner_callback_outbox WHERE runner_id = ? AND status = 'running' LIMIT 1").get(row.runner_id);
    if (busy) continue;
    launchingRunners.add(row.runner_id);
    fleetRunning++;
    started++;
    launchCallback(row, {}).catch((e) => console.error(`[callbacks] launch ${row.id} failed:`, e.message))
      .finally(() => { launchingRunners.delete(row.runner_id); fleetRunning--; });
  }
  return started;
}

/** Claim one row and run its script snapshot to completion in the background.
 *  The snapshot body is written to a temp file (never the live file, which
 *  may have been edited since recording). Timeout kills the whole process
 *  group; a crash after launch finalizes as `unknown` with no replay. */
async function launchCallback(row, { timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  const claimed = getDb().prepare("UPDATE runner_callback_outbox SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'")
    .run(new Date().toISOString(), row.id);
  if (!claimed.changes) return null; // lost the race — someone else owns it
  const journalRunner = { id: row.runner_id, session_id: row.session_id };
  const recovery = require('./quota-recovery');
  let recoveryContext;
  try {
    recoveryContext = await recovery.begin(row);
  } catch (e) {
    getDb().prepare("UPDATE runner_callback_outbox SET status = 'error', stderr = ?, ended_at = ? WHERE id = ? AND status = 'running'")
      .run(e.message, new Date().toISOString(), row.id);
    mirrorHistory(getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id));
    history.record(journalRunner, 'script_failed', { actor: 'recovery-script', groupId: row.id, key: `${row.id}:script-end`, severity: 'error', code: e.code || 'recovery_precondition' });
    return false;
  }
  if (recoveryContext) timeoutMs = Math.max(timeoutMs, 300000);
  const tmp = path.join(os.tmpdir(), `paddock-cb-${row.id}.sh`);
  const finish = (patch) => {
    const done = getDb().prepare(
      `UPDATE runner_callback_outbox SET status = ?, exit_code = ?, stdout = ?, stderr = ?, truncated = ?, ended_at = ?
       WHERE id = ? AND status = 'running'`
    ).run(patch.status, patch.exit_code, patch.stdout, patch.stderr, patch.truncated ? 1 : 0, new Date().toISOString(), row.id);
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    if (done.changes) {
      mirrorHistory(getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id));
      history.record(journalRunner, patch.status === 'ok' ? 'script_completed' : patch.status === 'unknown' ? 'script_unknown' : 'script_failed', {
        actor: 'recovery-script', groupId: row.id, key: `${row.id}:script-end`, exitCode: patch.exit_code,
        severity: patch.status === 'ok' ? 'info' : patch.status === 'unknown' ? 'warning' : 'error', code: patch.status,
      });
    }
    return done.changes > 0;
  };
  let child;
  try {
    fs.writeFileSync(tmp, row.script_body, { mode: 0o700 });
  } catch (e) {
    finish({ status: 'unknown', exit_code: null, stdout: null, stderr: `Snapshot could not be staged: ${e.message}`, truncated: false });
    return false;
  }
  const out = { stdout: '', stderr: '', truncated: false };
  const feed = (key, chunk) => {
    if (out.truncated) return;
    out[key] += chunk.toString('utf8');
    if (Buffer.byteLength(out[key], 'utf8') > CALLBACK_OUTPUT_MAX) {
      // Cut at the byte budget (code points may split — mark it and move on;
      // the bound is on stored bytes, not on glyph integrity).
      const buf = Buffer.from(out[key], 'utf8').subarray(0, CALLBACK_OUTPUT_MAX);
      out[key] = buf.toString('utf8');
      out.truncated = true;
    }
  };
  await new Promise((resolve) => {
    let settled = false;
    const done = (status, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish({ status, exit_code: code, stdout: out.stdout || null, stderr: out.stderr || null, truncated: out.truncated });
      resolve();
    };
    const timer = setTimeout(() => {
      // Timeout kills the WHOLE process group (detached below), not just sh —
      // a script that backgrounded work must not outlive its verdict.
      try { if (child && child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      done('timeout', null);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    try {
      child = spawn('sh', [tmp], { cwd: row.cwd, env: callbackEnv(row), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('spawn', () => history.record(journalRunner, 'script_started', { actor: 'recovery-script', groupId: row.id, key: `${row.id}:script-start`, plan: row.plan_path || '', reason: row.event }));
    } catch (e) {
      done('unknown', null);
      return;
    }
    if (child.stdout) child.stdout.on('data', (c) => feed('stdout', c));
    if (child.stderr) child.stderr.on('data', (c) => feed('stderr', c));
    child.on('error', () => {
      const cur = getDb().prepare('SELECT status FROM runner_callback_outbox WHERE id = ?').get(row.id);
      if (cur && cur.status === 'running') {
        done('unknown', null);
      } else resolve();
    });
    child.on('close', (code) => done(code === 0 ? 'ok' : 'error', code));
    if (child.unref) child.unref();
  });
  await recovery.complete(row, recoveryContext, getDb().prepare('SELECT status, exit_code FROM runner_callback_outbox WHERE id = ?').get(row.id));
  return true;
}

/** Boot reconciliation: rows caught `running` across a restart never launched
 *  to completion — finalize them `unknown` (honest, no replay) and mirror to
 *  history. `pending` rows never launched, so they stay pending for the pump. */
function reconcileCallbackOutbox() {
  const now = new Date().toISOString();
  const orphans = getDb().prepare("SELECT * FROM runner_callback_outbox WHERE status = 'running'").all();
  for (const row of orphans) {
    const changed = getDb().prepare(
      `UPDATE runner_callback_outbox SET status = 'unknown', ended_at = ?,
       stderr = COALESCE(stderr, '') || '[reconciled at boot: the process did not survive the restart; not re-executed]'
       WHERE id = ? AND status = 'running'`
    ).run(now, row.id);
    if (changed.changes) {
      mirrorHistory(getDb().prepare('SELECT * FROM runner_callback_outbox WHERE id = ?').get(row.id));
      history.record({ id: row.runner_id, session_id: row.session_id }, 'script_unknown', { groupId: row.id, key: `${row.id}:script-end`, severity: 'warning', reason: 'Control plane restarted; script was not replayed' });
    }
  }
  return orphans.length;
}

/** Record a plan transition from the observation pass. Thin wrapper over
 *  recordCallbackEvent that carries the item/attempt identity and returns the
 *  recorded row (or null when the callback is disabled). */
function recordTransition(runner, project, event, item, attempt, queuePath) {
  history.record(runner, event, { key: `${event}:${item.id}:${attempt}`, plan: item.plan, itemId: item.id });
  return recordCallbackEvent(runner, project, event, {
    itemId: item.id,
    itemAttempt: attempt,
    planPath: item.plan || null,
    queuePath: queuePath || null,
    cwd: project.folder,
  });
}

/** Observe one runner's parsed queue and record ONLY the plan_started /
 *  plan_completed transitions this read actually shows (plan 92 §Phase 3).
 *
 *  A worker edits QUEUE.md with its own tools, bypassing every Paddock gate, so
 *  transitions are OBSERVED by diffing consecutive reads by stable item id
 *  (Phase 1 inventory). The persisted per-item observation is the attempt
 *  identity: `attempt` counts entries into `in progress`, so
 *    - a first/next item earns a new attempt → a new plan_started,
 *    - a resume/restart of the same in-progress item is no transition at all,
 *    - an explicit requeue (in progress → new → in progress) earns attempt+1.
 *  The first observation of an item is a BASELINE (no historical replay). A
 *  start+end between two polls is unobservable by construction: only
 *  `plan_completed` is emitted for it, and it is documented, never invented.
 *  Observation advances whether or not a callback is enabled, so enabling a
 *  script later cannot replay an old transition.
 *
 *  `items` is `queue.parsed.items`; returns the number of events newly
 *  recorded. One bad item never stops the pass. */
function observeQueue(runner, project, items, { queuePath = null } = {}) {
  history.baseline(runner);
  if (!Array.isArray(items) || !items.length) return 0;
  const now = new Date().toISOString();
  const getObs = getDb().prepare('SELECT * FROM runner_queue_observations WHERE runner_id = ? AND item_id = ?');
  const insObs = getDb().prepare(
    `INSERT INTO runner_queue_observations (runner_id, item_id, plan_path, last_status, attempt, last_seen_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const updObs = getDb().prepare(
    `UPDATE runner_queue_observations SET plan_path = ?, last_status = ?, attempt = ?, last_seen_at = ?, started_at = ?
     WHERE runner_id = ? AND item_id = ?`
  );
  let recorded = 0;
  for (const item of items) {
    if (!item || !item.id) continue;
    const prev = getObs.get(runner.id, item.id) || null;
    if (prev === null) {
      // Baseline: adopt the current status without replaying any event. An item
      // already `in progress` is attempt 1, so a later requeue becomes 2.
      const attempt = item.status === 'in progress' ? 1 : 0;
      insObs.run(runner.id, item.id, item.plan || null, item.status, attempt, now, item.status === 'in progress' ? now : null);
      continue;
    }
    let attempt = Number(prev.attempt) || 0;
    let startedAt = prev.started_at || null;
    if (item.status !== prev.last_status) {
      if (item.status === 'in progress') {
        attempt += 1;
        startedAt = now;
        const row = recordTransition(runner, project, 'plan_started', item, attempt, queuePath);
        if (row && row.status === 'pending') recorded += 1;
      } else if (item.status === 'done') {
        // No start observed for this attempt (e.g. start+end between polls):
        // completion is still an observed transition, dated to attempt 1 and
        // emitted WITHOUT a fabricated start event.
        const effAttempt = Math.max(attempt, 1);
        attempt = effAttempt;
        const row = recordTransition(runner, project, 'plan_completed', item, effAttempt, queuePath);
        if (row && row.status === 'pending') recorded += 1;
      } else if (item.status === 'need input') {
        history.record(runner, 'input_needed', { key: `input:${item.id}:${prev.last_seen_at}`, itemId: item.id, plan: item.plan, severity: 'warning' });
      } else if (item.status === 'new') {
        history.record(runner, 'plan_requeued', { key: `requeued:${item.id}:${prev.last_seen_at}`, itemId: item.id, plan: item.plan });
      }
      // `new` / `need input`: status update only. A requeue is not an event;
      // the next in-progress observation emits the new start.
    }
    updObs.run(item.plan || null, item.status, attempt, now, startedAt, runner.id, item.id);
  }
  return recorded;
}

/** Replay canonical queue mutations in order, not just the latest file/queue
 * snapshot. This preserves a fast in_progress -> done turn between polls. The
 * callback outbox dedup keys make replay after a process crash safe. */
function observeCanonicalEvents(runner, project, { queuePath = null } = {}) {
  const db = getDb();
  const queue = db.prepare('SELECT id FROM runner_queues WHERE runner_id = ?').get(runner.id);
  if (!queue) return 0;
  const savedCursor = db.prepare('SELECT last_event_rowid FROM runner_queue_event_cursors WHERE runner_id = ?').get(runner.id);
  if (!savedCursor) {
    // Existing canonical queues with no event cursor get a current-state
    // baseline. Their historic events are not replayed as callbacks.
    const baseline = db.prepare('SELECT id, position, plan, status, reason FROM runner_queue_items WHERE queue_id = ? ORDER BY position').all(queue.id)
      .map((item) => ({ ...item, status: item.status.replaceAll('_', ' ') }));
    observeQueue(runner, project, baseline, { queuePath });
    const max = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS rowid FROM runner_queue_events WHERE queue_id = ?').get(queue.id).rowid;
    db.prepare('INSERT OR IGNORE INTO runner_queue_event_cursors (runner_id, last_event_rowid, updated_at) VALUES (?, ?, ?)')
      .run(runner.id, max, new Date().toISOString());
    return 0;
  }
  const cursor = savedCursor.last_event_rowid;
  const rows = db.prepare('SELECT rowid AS event_rowid, * FROM runner_queue_events WHERE queue_id = ? AND rowid > ? ORDER BY rowid').all(queue.id, cursor);
  let recorded = 0;
  for (const row of rows) {
    let snapshot = null;
    try {
      snapshot = row.after_json ? JSON.parse(row.after_json) : null;
      if (!snapshot || !Array.isArray(snapshot.items)) throw new Error('Queue event has no valid after snapshot');
    } catch (error) {
      // Do not advance past an event whose durable facts cannot be decoded.
      throw new CallbackError('queue_event_corrupt', `Queue event ${row.id} cannot be replayed: ${error.message}`);
    }
    const items = snapshot.items.map((item) => ({ ...item, status: item.status.replaceAll('_', ' ') }));
    recorded += observeQueue(runner, project, items, { queuePath });
    db.prepare(`INSERT INTO runner_queue_event_cursors (runner_id, last_event_rowid, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(runner_id) DO UPDATE SET last_event_rowid = excluded.last_event_rowid, updated_at = excluded.updated_at`)
      .run(runner.id, row.event_rowid, new Date().toISOString());
  }
  return recorded;
}

/** Observe one runner's usage-exhaustion evidence and record at most ONE
 *  usage_exhausted event per episode (plan 92 §Phase 3; rule = plan 75 row 8).
 *  `evidence` is `agentStore.readUsageEvidence`'s tri-state; `busy` is the
 *  conversation's live-work probe and `busyKnown` says whether that probe could
 *  actually answer. A live turn ALSO ends in a user message, so exhaustion is
 *  CONFIRMED only when the signature is read AND we positively know the
 *  conversation is not busy — the exact disambiguation plan 75 ships.
 *
 *  An unreadable store, an unsupported driver, or an unanswerable busy probe is
 *  WITHHELD: the episode state is left exactly as it was (never cleared, never
 *  advanced) so a transient failure cannot end or start an episode. Recovery is
 *  `evidence.state === 'ok'` (the input got a real reply); only measured
 *  recovery resets to clear and re-arms `episode_seq`, so a later confirmed
 *  exhaustion is a NEW episode with a new dedup key. Returns 0 or 1 events
 *  newly recorded. */
function observeUsage(runner, project, evidence, { busy = null, busyKnown = false } = {}) {
  if (!evidence || typeof evidence.state !== 'string') return 0;
  const now = new Date().toISOString();
  const prior = getDb().prepare('SELECT * FROM runner_usage_state WHERE runner_id = ?').get(runner.id) || null;
  let seq = prior ? Number(prior.episode_seq) || 0 : 0;
  let state = prior ? prior.state : 'clear';
  const persist = () => {
    getDb().prepare(
      `INSERT INTO runner_usage_state (runner_id, episode_seq, state, reason, evidence, observed_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(runner_id) DO UPDATE SET
         episode_seq = excluded.episode_seq, state = excluded.state,
         reason = excluded.reason, evidence = excluded.evidence, observed_at = excluded.observed_at`
    ).run(runner.id, seq, state, evidence.reason || null, evidence.evidence ? JSON.stringify(evidence.evidence) : null, now);
  };

  if (evidence.state === 'unknown') {
    // Withhold: do not clear an armed episode, do not advance the counter.
    persist();
    return 0;
  }

  const confirmed = evidence.state === 'exhausted' &&
    (evidence.definitive === true || (busyKnown === true && busy === false));
  if (confirmed) {
    let recorded = 0;
    if (state !== 'exhausted') {
      seq += 1;
      state = 'exhausted';
      const row = recordCallbackEvent(runner, project, 'usage_exhausted', {
        episodeKey: seq,
        usageReason: evidence.reason || 'Provider usage exhaustion',
        cwd: project.folder,
      });
      history.record(runner, 'usage_exhausted', {
        key: `usage:${seq}`, groupId: row?.id || `${runner.id}:usage:${seq}`,
        severity: 'warning', reason: evidence.reason,
      });
      if (row && row.status === 'pending') recorded = 1;
    }
    persist();
    return recorded;
  }

  // Not confirmed. Measured recovery — the input was actually answered — resets
  // and re-arms. A busy worker mid-turn is neither exhausted nor recovered, so
  // its episode state is left untouched (and no new event can fire on it).
  if (evidence.state === 'ok' && state === 'exhausted') {
    state = 'clear';
    history.record(runner, 'usage_recovered', { key: `usage-recovered:${seq}` });
  }
  persist();
  return 0;
}

module.exports = {
  CallbackError,
  CALLBACK_KEYS,
  CALLBACK_ENV_VARS,
  MAX_SCRIPT_BYTES,
  callbacksDir,
  validateEventKey,
  getCallback,
  listCallbacks,
  saveCallback,
  listCallbackHistory,
  callbackCatalogue,
  CALLBACK_TIMEOUT_MS,
  CALLBACK_FLEET_MAX,
  CALLBACK_OUTPUT_MAX,
  dedupKey,
  recordCallbackEvent,
  callbackEnv,
  pumpCallbackOutbox,
  launchCallback,
  reconcileCallbackOutbox,
  observeQueue,
  observeCanonicalEvents,
  observeUsage,
};
