/** Task queue engine (plan 47).
 *
 *  FROZEN (plan 52 G2, 2026-10-07): kept for the code it carries and for plan
 *  69's foundation (it wires its per-task steps onto the existing `tasks`
 *  table), but NOT a supported work path. Mission sessions supersede the queue
 *  as the only way the agent works (plan 53 §1b / §11 Q7: nothing runs outside
 *  the human's vision — the queue's headless `opencode run` spawns are exactly
 *  what that rule retired). The `task_*` MCP family and the `task-mcp` suite
 *  (28/28) stay green against it; do not build new features on this module
 *  without un-freezing it in plan 52.
 *
 *  Push: `submitTask` spawns `opencode run` inside an opencode PAD through a
 *  detached `docker exec -i … sh -lc 'exec opencode run …'`, streams the output
 *  into the `tasks` table (byte-capped), and kills on timeout or cancel. The
 *  `exec` shim matters: SIGTERM has to reach opencode, not just the local
 *  `docker exec` CLI.
 *
 *  Pull (TaskPeace loop): a task with a NULL `agent_name` sits in the shared
 *  pool. A worker PAD claims the highest-priority pending one with an atomic
 *  `UPDATE … RETURNING`, does the work itself — it *is* opencode — and reports
 *  via `completeTask`. No spawn happens in this mode; the webui is bookkeeping.
 *
 *  Timestamps are always SQL `datetime('now')` so they match every other table
 *  in this DB ('YYYY-MM-DD HH:MM:SS') and stay sortable as strings.
 */

const crypto = require('crypto');
const realSpawn = require('child_process').spawn;
const { execFile } = require('child_process');

const { getDb } = require('./db');
const registry = require('./agent-registry');
const { getDriver } = require('./drivers');

const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const SIGKILL_AFTER_MS = 5000;
const FLUSH_INTERVAL_MS = 1000;
const ORPHAN_SUMMARY = 'orphaned by webui restart';

let spawnFn = realSpawn;
let lookupAgent = defaultLookupAgent;
let containerIsRunning = defaultIsRunning;
let containerExecFn = defaultContainerExec;
// The in-PAD `test -d` behind the 1k workspace gate. A seam rather than a
// direct require of pad-tmux: task-runner is a service that must not drag the
// docker/tmux layer into every test that touches bookkeeping, and the seam is
// how the tests make a folder exist or not.
let folderExistsFn = require('./pad-tmux').folderExists;

function defaultLookupAgent(name) {
  return registry.getAgent(name);
}

function defaultIsRunning(ref) {
  return (registry.dockerPsList()[ref] || '').toString().toLowerCase() === 'running';
}

function defaultContainerExec(ref, script, cb) {
  execFile('docker', ['exec', '-i', ref, 'sh', '-lc', script], { timeout: 15000 }, (err) => cb && cb(err));
}

const running = new Map();

/** Task capability for an agent type (plan 48). The driver's `task` block
 *  exists only for types that can run queued tasks headlessly. Returns null
 *  for unsupported types. */
/** Resolve a driver's task capability from whatever the caller has: a type
 *  string, a driver object, a pad-like `{agent_type}`, or an already-resolved
 *  capability. Each of these reaches this function on a live path, so each one
 *  has to resolve — a capability object is what the submit path has in hand by
 *  the time it builds the exec script, and looking that up as a driver type
 *  always misses.
 *
 *  The `(x || {})` that used to trail both `getDriver` calls is gone: the
 *  fallback meant `getDriver` could never return falsy, so it guarded nothing.
 *  It also hid the real shape of this function — `getDriver` THROWS for a type
 *  that is not a driver, which is what a `{agent_type: 'opencodee'}` pad-like
 *  object should now get instead of openclaw's capability. */
function taskCapability(type) {
  if (!type) return null;
  const fromCap = (c) => (c && c.supported ? c : null);
  if (typeof type.buildCommand === 'function') return fromCap(type); // resolved capability
  if (typeof type === 'object') {
    if (type.task) return fromCap(type.task);                       // driver object
    return fromCap(getDriver(type.agent_type).task);                // pad-like
  }
  return fromCap(getDriver(type).task);                              // type string
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** A machine code the caller can branch on. The SDK's error path only prints
 *  `message`, so the code is part of the message (the Mission tools' rule). */
function taskFail(code, msg) {
  return new Error(`${code}: ${msg}`);
}

const SGR_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

/** Strip SGR escape sequences from captured process output. `opencode run
 *  --format json` colours its own logs, so a raw tail handed to an LLM arrives
 *  as escape soup wrapped around the one line the caller wanted. Only SGR (plus
 *  OSC strings and the two-char Fe escapes) — a bare ESC left in place would
 *  still reach the reader. */
function stripAnsi(s) {
  if (s == null) return '';
  return String(s).replace(SGR_RE, '');
}

/** How the work will actually happen (plan 63 1a). One field, because "who runs
 *  this and is it already running?" is a single question — a claimed task is a
 *  worker doing it itself no matter which PAD it was addressed to, and a
 *  running push task is the PAD's own `opencode run`. Derived, never stored. */
function taskRoute(row) {
  if (!row) return null;
  if (row.claimed_by) return 'pull';
  if (!row.agent_name) return 'pull';
  if (Number(row.enqueue) === 1) return 'enqueued';
  return 'push';
}

/** Did it work? (plan 63 1i). `unknown` is not a failure — a task that has not
 *  finished, or was cancelled, has no verdict, and saying so is the difference
 *  between "failed" and "still going". `timedOut` is the separate axis: a
 *  timeout is an `error` with a cause, not a crash you have to infer. */
function taskOutcome(row) {
  if (!row) return 'unknown';
  if (row.status === 'done') return 'ok';
  if (row.status === 'error') return 'failed';
  return 'unknown';
}

function capOutput(s, limit = MAX_OUTPUT_BYTES) {
  const marker = '\n...[output truncated]';
  const markerLen = Buffer.byteLength(marker, 'utf8');
  const text = String(s == null ? '' : s);
  if (Buffer.byteLength(text, 'utf8') <= limit) return text;
  const cut = Buffer.from(text, 'utf8').slice(0, Math.max(0, limit - markerLen)).toString('utf8');
  return cut.replace(/[\uD800-\uDFFF]$/, '') + marker;
}

/** Wrap a driver's inner task command in the machine plumbing: the pidfile
 *  names the exact PID (the shell `exec`s, so the PID survives into the agent
 *  CLI), the env tag lets the kill script verify it before signalling — safe
 *  against PID reuse. */
function buildExecCommand(type, prompt, opts, taskId) {
  const cap = taskCapability(type);
  if (!cap) throw new Error(`Task submission is not supported by ${type.agent_type || type} agents`);
  const inner = cap.buildCommand(prompt, opts);
  return `echo $$ > /tmp/paddock-task-${taskId}.pid; PADDOCK_TASK_ID=${taskId} exec ${inner}`;
}

/** Best-effort in-container kill. Signalling the local `docker exec` CLI does
 *  not reliably reach the container-side process, so cancel/timeout also sweep
 *  inside the container. Verifies the env tag before signalling. */
function buildKillScript(taskId, signal = 'TERM') {
  const tag = `PADDOCK_TASK_ID=${taskId}`;
  return [
    `P=/tmp/paddock-task-${taskId}.pid`,
    '[ -f "$P" ] || exit 0',
    'PID=$(cat "$P"); rm -f "$P"',
    'case "$PID" in ""|*[!0-9]*) exit 0;; esac',
    `if tr '\\0' '\\n' < /proc/$PID/environ 2>/dev/null | grep -qxF ${shq(tag)}; then`,
    `  kill -${signal} "$PID" 2>/dev/null`,
    'fi',
  ].join('\n');
}

function killContainerProcess(runtimeRef, taskId, signal) {
  try {
    containerExecFn(runtimeRef, buildKillScript(taskId, signal), () => {});
  } catch {}
}

function getTask(id) {
  return getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

/** The task a worker would be handed next, WITHOUT claiming it (plan 63 1b/1c).
 *  Deliberately the same WHERE + ORDER BY as `claimNextTask`, so a list can
 *  name the next task and the claim can never disagree about which one that is
 *  — a preview that is computed separately is a preview of a different queue.
 *  `pad` null = "any worker", which means pool tasks only: a task addressed to
 *  one PAD is not claimable by an arbitrary worker, and naming it as the next
 *  up would hand out a task the reader cannot take. */
function nextUpTask(pad) {
  const db = getDb();
  const row = pad
    ? db.prepare(
        `SELECT * FROM tasks
         WHERE status = 'pending' AND (agent_name IS NULL OR agent_name = ?)
         ORDER BY priority ASC, rowid ASC LIMIT 1`
      ).get(pad)
    : db.prepare(
        `SELECT * FROM tasks
         WHERE status = 'pending' AND agent_name IS NULL
         ORDER BY priority ASC, rowid ASC LIMIT 1`
      ).get();
  return row || null;
}

/** Pending tasks first in SERVICE order, then history newest-first (plan 63
 *  1b). The old single `rowid DESC` was the exact reverse of the order the
 *  queue is served in, so a caller read the listing as the work order and got it
 *  backwards. The two halves cannot be one sort: history has no service order,
 *  and pretending newest-first is a queue is what caused the bug. */
function listTasks({ pad, status, limit = 50 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  const db = getDb();
  const where = [];
  const args = [];
  if (pad) {
    where.push('(agent_name = ? OR claimed_by = ?)');
    args.push(pad, pad);
  }
  if (status) {
    where.push('status = ?');
    args.push(String(status));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT * FROM tasks ${clause}
     ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END ASC,
              CASE WHEN status = 'pending' THEN priority END ASC,
              CASE WHEN status = 'pending' THEN rowid END ASC,
              rowid DESC
     LIMIT ?`
  ).all(...args, max);
}

/** How many rows match a list's filters, ignoring `limit` (plan 63 1c). Without
 *  it a capped list and an exhausted queue look identical — the same defect as a
 *  filtered list that falls back to the unfiltered one. */
function countTasks({ pad, status } = {}) {
  const db = getDb();
  const where = [];
  const args = [];
  if (pad) {
    where.push('(agent_name = ? OR claimed_by = ?)');
    args.push(pad, pad);
  }
  if (status) {
    where.push('status = ?');
    args.push(String(status));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT COUNT(*) AS c FROM tasks ${clause}`).get(...args).c;
}

/** Queue state returned with a filed pool task (plan 63 1d). A pool task does
 *  not start itself: nothing runs until a worker calls `task_get_next`, and
 *  there may be no worker at all. The webui has no presence registry for a
 *  worker *polling* (the same gap that makes opencode `busyKnown: false` mean
 *  unknown), so this does not invent a number for it — it reports the pads that
 *  have actually CLAIMED work in the window, which is the real signal, and is
 *  empty in exactly the case the caller needs to hear about. */
const RECENT_CLAIMER_WINDOW_MIN = 30;

function queueState() {
  const db = getDb();
  const pending = db.prepare(
    "SELECT COUNT(*) AS c FROM tasks WHERE status = 'pending' AND agent_name IS NULL"
  ).get().c;
  const claimers = db.prepare(
    `SELECT DISTINCT claimed_by AS pad FROM tasks
     WHERE claimed_by IS NOT NULL
       AND started_at IS NOT NULL
       AND started_at >= datetime('now', ?)
     ORDER BY pad`
  ).all(`-${RECENT_CLAIMER_WINDOW_MIN} minutes`).map((r) => r.pad);
  return {
    queueLength: pending,
    recentClaimers: claimers,
    recentClaimerWindowMin: RECENT_CLAIMER_WINDOW_MIN,
  };
}

/** Where a just-filed task sits in the pool: 1 = next up. */
function queuePosition(id) {
  const db = getDb();
  const row = db.prepare(
    "SELECT priority, rowid FROM tasks WHERE id = ? AND status = 'pending' AND agent_name IS NULL"
  ).get(id);
  if (!row) return null;
  const ahead = db.prepare(
    `SELECT COUNT(*) AS c FROM tasks
     WHERE status = 'pending' AND agent_name IS NULL
       AND (priority < ? OR (priority = ? AND rowid < ?))`
  ).get(row.priority, row.priority, row.rowid).c;
  return ahead + 1;
}

function reconcileOrphanedTasks() {
  return getDb().prepare(
    "UPDATE tasks SET status = 'error', finished_at = datetime('now'), result_summary = ? WHERE status = 'running'"
  ).run(ORPHAN_SUMMARY).changes;
}

function attachProcess(id, child, timeoutMs, runtimeRef, cap) {
  const extract = (cap && cap.extractSummary) || ((raw) => String(raw || '').trim());
  const state = {
    out: '', err: '', timer: null, sigkillTimer: null, flushTimer: null,
    pid: child.pid || null, sinceFlush: false,
  };

  child.stdout.on('data', (d) => { state.out += d.toString('utf8'); state.sinceFlush = true; });
  child.stderr.on('data', (d) => { state.err += d.toString('utf8'); state.sinceFlush = true; });

  const flushLive = () => {
    // Throttled live flush (plan 48): while running, persist capped output +
    // a progressive result_summary so task_status { tail } shows real-time
    // progress. last_output_at is the heartbeat — only bumped when new bytes
    // arrived since the previous flush, so a silent-but-alive agent (stuck,
    // spinning) reads as a stale heartbeat, exactly the signal an orchestrator
    // wants.
    //
    // This runs from a setInterval: an exception here is an uncaught exception
    // in a timer callback, which kills the whole webui — a heartbeat must never
    // be able to take the control plane down over a DB hiccup.
    const dirty = state.sinceFlush;
    state.sinceFlush = false;
    try {
      getDb().prepare(
        `UPDATE tasks SET stdout = ?, stderr = ?, result_summary = ?${dirty ? ", last_output_at = datetime('now')" : ''}
         WHERE id = ? AND status IN ('pending','running')`
      ).run(capOutput(state.out), capOutput(state.err), extract(state.out), id);
    } catch (err) {
      console.error(`[tasks] live flush failed for ${id}: ${err.message}`);
    }
  };

  child.on('error', (err) => {
    if (state.timer) clearTimeout(state.timer);
    if (state.sigkillTimer) clearTimeout(state.sigkillTimer);
    if (state.flushTimer) clearInterval(state.flushTimer);
    getDb().prepare(
      "UPDATE tasks SET status = 'error', finished_at = datetime('now'), result_summary = ? WHERE id = ? AND status IN ('pending','running')"
    ).run(`spawn error: ${err.message}`, id);
    running.delete(id);
  });

  child.on('exit', (code) => {
    if (state.timer) clearTimeout(state.timer);
    if (state.sigkillTimer) clearTimeout(state.sigkillTimer);
    if (state.flushTimer) clearInterval(state.flushTimer);
    getDb().prepare(
      `UPDATE tasks SET exit_code = ?, stdout = ?, stderr = ?, result_summary = ?, status = ?, finished_at = datetime('now')
       WHERE id = ? AND status IN ('pending','running')`
    ).run(
      code == null ? null : code,
      capOutput(state.out),
      capOutput(state.err),
      extract(state.out),
      code === 0 ? 'done' : 'error',
      id
    );
    running.delete(id);
  });

  try { child.stdin.end(); } catch {}

  getDb().prepare("UPDATE tasks SET pid = ?, started_at = datetime('now'), status = 'running' WHERE id = ?").run(state.pid, id);

  state.flushTimer = setInterval(flushLive, FLUSH_INTERVAL_MS);
  if (state.flushTimer.unref) state.flushTimer.unref();

  if (timeoutMs > 0) {
    state.timer = setTimeout(() => timeoutTask(id, timeoutMs), timeoutMs);
    if (state.timer.unref) state.timer.unref();
  }

  running.set(id, { child, state, runtimeRef });
}

/** The cwd a task should run in, resolved the way the agent list does (plan 63
 *  1k). `driver.workspaceDir` is the TYPE default, which is wrong for every PAD
 *  carrying a custom workspace mount (plan 24) — the observed failure was a task
 *  launched into `/root/.opencode/workspace`, a directory that pad does not have.
 *  `pad.workspace_dir` is the effective one: the mount's container path when a
 *  mount is configured, the driver default otherwise.
 *
 *  Async because the second half is a `docker exec test -d` INSIDE the pad. That
 *  probe lives next to the value it checks and the value it returns is the one
 *  `submitTask` then uses, so the two cannot disagree about where the task ran —
 *  the failure mode where a probe reports one directory and the command runs in
 *  another, which is worse than reporting no cwd at all. A missing folder fails
 *  the submit with a code naming the mount that was meant, exactly like
 *  `mission_folder_missing`, rather than leaving opencode to fail generically
 *  one layer down. */
async function resolveTaskWorkspace(pad) {
  // A missing pad has to be refused HERE. It used to read
  // `getDriver(pad && pad.agent_type)` → openclaw → a non-empty workspaceDir, so
  // the `!workspaceDir` guard below passed and the next line TypeError'd on
  // `undefined.runtime_ref` — a crash in the submit path with a TypeError
  // instead of a refusal naming the pad that was not found.
  if (!pad) {
    throw taskFail('task_pad_not_found', 'No agent pad was resolved for this task, so its workspace is unknown');
  }
  const driver = getDriver(pad.agent_type);
  const workspaceDir = pad.workspace_dir || driver.workspaceDir || '';
  if (!workspaceDir) {
    throw taskFail('task_workspace_missing',
      `${pad.name} has no workspace directory configured`);
  }
  const ref = pad.runtime_ref || pad.name;
  if (typeof folderExistsFn !== 'function') return workspaceDir;
  const ok = await folderExistsFn(ref, workspaceDir);
  if (!ok) {
    throw taskFail('task_workspace_missing',
      `${pad.name}: ${workspaceDir} does not exist inside ${ref}`
      + (pad.workspace_mount ? ` (workspace mount ${pad.workspace_mount.host} → ${pad.workspace_mount.container})` : ' (driver default)'));
  }
  return workspaceDir;
}

async function submitTask({ name, prompt, model, agent, priority = 0, timeout, autoApprove = false, enqueue = false, user } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('task prompt is required');
  const isPool = !name || !String(name).trim();

  let runtimeRef = null;
  let workspaceDir = null;
  let cap = null;
  if (!isPool) {
    const pad = lookupAgent(String(name).trim());
    if (!pad) throw new Error(`Agent not found: ${name}`);
    const driver = getDriver(pad.agent_type);
    cap = taskCapability(driver);
    if (!cap) {
      throw new Error(`Task submission is not supported by ${pad.agent_type} agents (${pad.name})`);
    }
    if (!containerIsRunning(pad.runtime_ref)) {
      throw new Error(`Container is not running: ${pad.name}`);
    }
    runtimeRef = pad.runtime_ref;
    // The gate and the value are one call, so a task can never be spawned into a
    // directory nobody verified.
    workspaceDir = await resolveTaskWorkspace(pad);
  }

  const limit = Math.min(Number(timeout) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const id = crypto.randomUUID();
  getDb().prepare(
    `INSERT INTO tasks (id, agent_name, prompt, model, agent_type, status, priority, created_by, enqueue, timeout_ms, created_at)
     VALUES (?,?,?,?,?,'pending',?,?,?,?,datetime('now'))`
  ).run(
    id,
    isPool ? null : String(name).trim(),
    String(prompt),
    model || null,
    agent || null,
    Math.max(0, Math.floor(Number(priority) || 0)),
    (user && user.userId) || 'mcp',
    isPool ? 0 : (enqueue ? 1 : 0),
    limit
  );

  if (!isPool && !enqueue) {
    const script = buildExecCommand(cap, prompt, { workspaceDir, model, agent, autoApprove }, id);
    const child = spawnFn(
      'docker',
      ['exec', '-i', runtimeRef, 'sh', '-lc', script],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    attachProcess(id, child, limit, runtimeRef, cap);
  }
  return id;
}

function claimNextTask(pad) {
  if (!pad) throw new Error('pad is required to claim a task');
  const db = getDb();
  const claimed = db.prepare(
    `UPDATE tasks SET status = 'running', claimed_by = ?, started_at = datetime('now')
     WHERE id IN (
       SELECT id FROM tasks
       WHERE status = 'pending' AND (agent_name IS NULL OR agent_name = ?)
       ORDER BY priority ASC, rowid ASC
       LIMIT 1
     )
     RETURNING id`
  ).get(pad, pad);
  return claimed ? getTask(claimed.id) : null;
}

function completeTask(id, { status = 'done', summary = '', worker } = {}) {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  // Terminal states are refused before anything else — re-closing a finished
  // task is the case with an unambiguous answer.
  if (task.status !== 'running' && task.status !== 'pending') {
    throw new Error(`Task ${id} is not in a claimable state (${task.status})`);
  }
  // Only the worker that claimed it may close it out (plan 63 1h). Without the
  // check any worker holding a task id could mark somebody else's work done, and
  // `claimed_by` on the row would be a record of an event that was never
  // authorised. A task nobody claimed is refused rather than adopted: "complete"
  // means "the worker I am finished this", and a pool task still sitting pending
  // has had no worker at all.
  //
  // This runs BEFORE the pending-state check below, deliberately: a task with no
  // claimer is refused as unclaimed rather than as "not claimable", because the
  // first is the thing the caller has to fix and the second is an accident of
  // ordering. "not in a claimable state (pending)" on a task nobody claimed is a
  // true sentence that tells the caller nothing.
  if (!task.claimed_by) {
    throw taskFail('task_not_claimed',
      `Task ${id} was never claimed (claimed_by is empty) — nothing has worked on it to report`);
  }
  // A claim sets `claimed_by` and the status in one write, so a pending row with
  // a claimer cannot arise through the real flow — and if it ever did, "complete"
  // is still the wrong verb for it. The MCP layer additionally REQUIRES `worker`;
  // the parameter stays optional here so internal callers are not forced to name
  // themselves, but the claimer check below runs either way.
  if (task.status !== 'running') {
    throw taskFail('task_not_running',
      `Task ${id} is ${task.status} but was claimed by ${task.claimed_by} — only a running task can be completed`);
  }
  if (worker && String(worker) !== task.claimed_by) {
    throw taskFail('task_not_yours',
      `Task ${id} was claimed by ${task.claimed_by}, not ${worker}`);
  }
  const next = (status === 'failed' || status === 'error') ? 'error' : 'done';
  getDb().prepare(
    "UPDATE tasks SET status = ?, result_summary = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(next, String(summary == null ? '' : summary), id);
  return getTask(id);
}

/** Re-file a finished task's prompt as a new task (plan 63 1e). The old row is
 *  left exactly as it ended and gains `supersededBy` + the new row's `attempt`,
 *  so a task that failed three times reads as one chain with three attempts
 *  rather than three unrelated rows — the silent-duplicate shape this replaces.
 *  The filing mode is carried over, so retrying an enqueued or pool task does
 *  not quietly start a fresh spawn on somebody's PAD. */
function retryTask(id) {
  const old = getTask(id);
  if (!old) throw new Error(`Task not found: ${id}`);
  if (old.status === 'pending' || old.status === 'running') {
    throw taskFail('task_still_active',
      `Task ${id} is ${old.status} — retry applies to a task that has finished`);
  }
  const db = getDb();
  const newId = crypto.randomUUID();
  const attempt = (Number(old.attempt) || 1) + 1;
  // The replacement is ALWAYS filed as a claimable queue entry, whatever the
  // original was. A retry is a re-file, not a run: starting work the caller did
  // not ask to start is the thing this whole surface exists to stop. Copying the
  // original's `enqueue` flag instead left a retried PUSH task carrying
  // enqueue=0 with no child process attached — `task_route` derived `push` from
  // the same flag, so the row claimed a PAD was running it and nothing was. A
  // push that failed now becomes an `enqueued` task its own PAD can claim, which
  // is both true and useful (it is how a caller retries a task whose PAD has
  // since been restarted).
  db.prepare(
    `INSERT INTO tasks (id, agent_name, prompt, model, agent_type, status, priority, created_by, enqueue, timeout_ms, attempt, created_at)
     VALUES (?,?,?,?,?,'pending',?,?,1,?,?,datetime('now'))`
  ).run(
    newId,
    old.agent_name,
    old.prompt,
    old.model,
    old.agent_type,
    Number(old.priority) || 0,
    old.created_by || 'mcp',
    old.timeout_ms,
    attempt
  );
  db.prepare('UPDATE tasks SET superseded_by = ? WHERE id = ?').run(newId, id);
  return { task: getTask(newId), superseded: getTask(id) };
}

function setPriority(id, rank) {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status !== 'pending') {
    throw new Error(`Only pending tasks can be re-ranked: ${id} is ${task.status}`);
  }
  getDb().prepare('UPDATE tasks SET priority = ? WHERE id = ?')
    .run(Math.max(0, Math.floor(Number(rank) || 0)), id);
  return getTask(id);
}

/** A task that overran its timeout is an `error` with a named cause, not a
 *  `cancelled` row (plan 63 1f). Both used to end on status `cancelled`, so a
 *  task the runner killed at 10 minutes was indistinguishable from one the user
 *  stopped — and the caller's only way to tell them apart was to read stderr for
 *  a timeout the summary never mentioned. `timed_out` makes the axis queryable,
 *  and the summary says how long it was given. */
function timeoutTask(id, timeoutMs) {
  getDb().prepare(
    `UPDATE tasks SET status = 'error', timed_out = 1, finished_at = datetime('now'), result_summary = ?
     WHERE id = ? AND status IN ('pending','running')`
  ).run(`timed out after ${timeoutMs}ms`, id);
  const entry = running.get(id);
  if (!entry) return;
  if (entry.state.timer) clearTimeout(entry.state.timer);
  if (entry.state.sigkillTimer) clearTimeout(entry.state.sigkillTimer);
  if (entry.child && entry.child.killed === false) entry.child.kill('SIGTERM');
  if (entry.runtimeRef) killContainerProcess(entry.runtimeRef, id, 'TERM');
  entry.state.sigkillTimer = setTimeout(() => {
    if (entry.child && entry.child.killed === false) entry.child.kill('SIGKILL');
    if (entry.runtimeRef) killContainerProcess(entry.runtimeRef, id, 'KILL');
  }, SIGKILL_AFTER_MS);
  if (entry.state.sigkillTimer.unref) entry.state.sigkillTimer.unref();
}

function killTask(id) {
  getDb().prepare(
    "UPDATE tasks SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status IN ('pending','running')"
  ).run(id);
  const entry = running.get(id);
  if (!entry) return;
  if (entry.state.timer) clearTimeout(entry.state.timer);
  if (entry.state.sigkillTimer) clearTimeout(entry.state.sigkillTimer);
  if (entry.child && entry.child.killed === false) entry.child.kill('SIGTERM');
  if (entry.runtimeRef) killContainerProcess(entry.runtimeRef, id, 'TERM');
  entry.state.sigkillTimer = setTimeout(() => {
    if (entry.child && entry.child.killed === false) entry.child.kill('SIGKILL');
    if (entry.runtimeRef) killContainerProcess(entry.runtimeRef, id, 'KILL');
  }, SIGKILL_AFTER_MS);
  if (entry.state.sigkillTimer.unref) entry.state.sigkillTimer.unref();
}

function cancelTask(id) {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status !== 'pending' && task.status !== 'running') {
    throw new Error(`Task ${id} is not cancellable (${task.status})`);
  }
  killTask(id);
  return getTask(id);
}

function _setForTests({ spawn, getAgent, isRunning, containerExec, folderExists, resetRunning, resetSeams } = {}) {
  if (resetSeams) {
    spawnFn = realSpawn;
    lookupAgent = defaultLookupAgent;
    containerIsRunning = defaultIsRunning;
    containerExecFn = defaultContainerExec;
    folderExistsFn = require('./pad-tmux').folderExists;
  }
  if (spawn) spawnFn = spawn;
  if (getAgent) lookupAgent = getAgent;
  if (isRunning) containerIsRunning = isRunning;
  if (containerExec) containerExecFn = containerExec;
  if (folderExists) folderExistsFn = folderExists;
  if (resetRunning) {
    for (const entry of running.values()) {
      if (entry.state.timer) clearTimeout(entry.state.timer);
      if (entry.state.sigkillTimer) clearTimeout(entry.state.sigkillTimer);
    }
    running.clear();
  }
}

reconcileOrphanedTasks();

module.exports = {
  submitTask,
  claimNextTask,
  completeTask,
  retryTask,
  setPriority,
  getTask,
  listTasks,
  countTasks,
  nextUpTask,
  queueState,
  queuePosition,
  cancelTask,
  reconcileOrphanedTasks,
  resolveTaskWorkspace,
  taskRoute,
  taskOutcome,
  stripAnsi,
  taskFail,
  buildCommand: buildExecCommand,
  buildKillScript,
  capOutput,
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  _setForTests,
};
