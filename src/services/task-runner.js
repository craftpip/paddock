/** Task queue engine (plan 47).
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
function taskCapability(type) {
  const d = typeof type === 'object' && type !== null ? type : getDriver(type);
  const cap = d && d.task;
  return cap && cap.supported ? cap : null;
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
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

function listTasks({ pad, limit = 50 } = {}) {
  const max = Math.max(1, Math.min(Number(limit) || 50, 200));
  const db = getDb();
  if (pad) {
    return db.prepare(
      "SELECT * FROM tasks WHERE agent_name = ? OR claimed_by = ? ORDER BY rowid DESC LIMIT ?"
    ).all(pad, pad, max);
  }
  return db.prepare('SELECT * FROM tasks ORDER BY rowid DESC LIMIT ?').all(max);
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
    const dirty = state.sinceFlush;
    state.sinceFlush = false;
    getDb().prepare(
      `UPDATE tasks SET stdout = ?, stderr = ?, result_summary = ?${dirty ? ", last_output_at = datetime('now')" : ''}
       WHERE id = ? AND status IN ('pending','running')`
    ).run(capOutput(state.out), capOutput(state.err), extract(state.out), id);
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
    state.timer = setTimeout(() => killTask(id), timeoutMs);
    if (state.timer.unref) state.timer.unref();
  }

  running.set(id, { child, state, runtimeRef });
}

function submitTask({ name, prompt, model, agent, priority = 0, timeout, autoApprove = true, enqueue = false, user } = {}) {
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
    workspaceDir = driver.workspaceDir;
  }

  const id = crypto.randomUUID();
  getDb().prepare(
    "INSERT INTO tasks (id, agent_name, prompt, model, agent_type, status, priority, created_by, created_at) VALUES (?,?,?,?,?,'pending',?,?,datetime('now'))"
  ).run(
    id,
    isPool ? null : String(name).trim(),
    String(prompt),
    model || null,
    agent || null,
    Math.max(0, Math.floor(Number(priority) || 0)),
    (user && user.userId) || 'mcp'
  );

  if (!isPool && !enqueue) {
    const limit = Math.min(Number(timeout) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
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

function completeTask(id, { status = 'done', summary = '' } = {}) {
  const task = getTask(id);
  if (!task) throw new Error(`Task not found: ${id}`);
  if (task.status !== 'running' && task.status !== 'pending') {
    throw new Error(`Task ${id} is not in a claimable state (${task.status})`);
  }
  const next = (status === 'failed' || status === 'error') ? 'error' : 'done';
  getDb().prepare(
    "UPDATE tasks SET status = ?, result_summary = ?, finished_at = datetime('now') WHERE id = ?"
  ).run(next, String(summary == null ? '' : summary), id);
  return getTask(id);
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

function _setForTests({ spawn, getAgent, isRunning, containerExec, resetRunning, resetSeams } = {}) {
  if (resetSeams) {
    spawnFn = realSpawn;
    lookupAgent = defaultLookupAgent;
    containerIsRunning = defaultIsRunning;
    containerExecFn = defaultContainerExec;
  }
  if (spawn) spawnFn = spawn;
  if (getAgent) lookupAgent = getAgent;
  if (isRunning) containerIsRunning = isRunning;
  if (containerExec) containerExecFn = containerExec;
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
  setPriority,
  getTask,
  listTasks,
  cancelTask,
  reconcileOrphanedTasks,
  buildCommand: buildExecCommand,
  buildKillScript,
  capOutput,
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  _setForTests,
};
