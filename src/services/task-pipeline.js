'use strict';

// ── Plan 69 P3 / D7 — the server-side pipeline driver ──────────────────────
//
// `task_pipeline_start` hands a bound task to a driver that ADVANCES it: it
// drives the bound session through the same path `mission_send` uses, waits for
// each step's report, and writes every stage into `task_steps`. Four hard walls
// (D7), each of which parks rather than guessing or dying:
//
//   1. No advance without a report. The verdict is the report (D4) — the driver
//      never infers "tests are green" from a quiet pane.
//   2. Per-step timeout from `tasks.timeout_ms`: an overrun is stamped
//      `failed`/`error` and the pipeline parks for a human.
//   3. `task_pipeline_stop` lands on the driver's next tick; a dead/locked/
//      permission-parked session or a removed task PARKS (a readable reason in
//      `task_pipeline_status`) instead of aborting silently.
//   4. One active pipeline step per task: a newest row already `running`, or a
//      driver already alive, refuses with `task_pipeline_busy`.
//
// The driver lives IN MEMORY on purpose (a job loop is not a fact about a
// task), so a webui restart drops it and leaves the newest step where it was.
// `task_pipeline_status` says so in words when no driver is present — "no
// driver" is not "nothing is happening".
//
// `tasks` stays frozen (plan 52 G2): every fact this writes is a `task_steps`
// row, and the task's own status remains `task_complete`'s to set.

const taskRunner = require('./task-runner');
const mission = require('./mission');
const registry = require('./agent-registry');

/** A refusal the caller can branch on. `code` is surfaced as `code: message`
 *  by the MCP layer (the SDK's error path prints only `message`). */
class PipelineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
  }
}

const POLL_MS = 1000;
const LIVENESS_EVERY = 5; // probe the session gates every Nth poll
const MAX_HOTFIX = 3;

let sendFn = (sessionId, text, opts) => mission.sendText(sessionId, text, opts);
let lookupAgent = (name) => registry.getAgent(name);
let pollMs = POLL_MS;
let livenessEvery = LIVENESS_EVERY;
let timeoutFn = (task) => Number(task.timeout_ms) || taskRunner.DEFAULT_TIMEOUT_MS;

// Unref'd: a parked driver must never be the reason a process stays up.
const sleep = (ms) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (t && typeof t.unref === 'function') t.unref();
});

/** task_id -> record. A finished record is KEPT (so `status` can still say why
 *  the last run parked) and is replaced by the next `start`; `active` is what
 *  says whether a driver is alive right now. */
const pipelines = new Map();

const ACTIVE = new Set(['starting', 'running']);
const now = () => new Date().toISOString();
const clip = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));

function snapshot(rec) {
  return {
    task_id: rec.task_id,
    active: ACTIVE.has(rec.state),
    state: rec.state,
    step: rec.step,
    reason: rec.reason,
    detail: rec.detail,
    actor: rec.actor,
    session_id: rec.session_id,
    started_at: rec.started_at,
    updated_at: rec.updated_at,
    ended_at: rec.ended_at,
    stop_requested: !!rec.stop,
    hotfix_runs: rec.hotfix,
  };
}

/** A task's next step from its OWN history (D1): the newest row per step says
 *  what is done, what failed, and whether a hotfix is owed. `hotfix` is routed,
 *  never scheduled — a failed `test` earns one, a failed anything-else parks. */
function nextStepToRun(taskId) {
  const rows = taskRunner.listTaskSteps(taskId, 200);
  const last = {};
  for (const r of rows) last[r.step] = r; // ascending → the last row wins
  const review = last.review;
  const build = last.build;
  const test = last.test;
  const hotfix = last.hotfix;
  if (!review || review.state !== 'done') return 'review';
  if (!build || build.state !== 'done') return 'build';
  if (!test || test.state !== 'done') {
    if (test && test.state === 'failed' && test.status === 'failed') {
      const hotfixAfter = hotfix && rows.indexOf(hotfix) > rows.indexOf(test);
      if (!hotfixAfter) return 'hotfix';
    }
    return 'test';
  }
  // A loop that already committed is FINISHED, not parked at 'commit' — else a
  // status read after success sends the caller to commit a second time.
  if (last.commit && last.commit.state === 'done') return 'done';
  return 'commit';
}

function countSteps(taskId, step) {
  return taskRunner.listTaskSteps(taskId, 200).filter((r) => r.step === step).length;
}

/** Park: record WHY, and resolve any step left `running` so the newest row never
 *  claims work that stopped. An unreported running row is the driver's own
 *  claim, so it can be settled without touching anyone else's report. */
function park(rec, code, detail) {
  if (!ACTIVE.has(rec.state)) return; // already parked / done / stopped: first reason stands
  rec.state = 'parked';
  rec.reason = code;
  rec.detail = detail;
  rec.updated_at = now();
  rec.ended_at = rec.updated_at;
  settleRunning(rec, 'failed', 'error', `pipeline parked: ${code} — ${clip(detail, 400)}`);
}

function finish(rec, state, code, detail) {
  // A run that was stopped (or parked) while its last await was in flight keeps
  // that ending. The commit step awaits git; a stop that landed meanwhile used
  // to be overwritten with `done`.
  if (!ACTIVE.has(rec.state)) return;
  rec.state = state;
  rec.reason = code;
  rec.detail = detail;
  rec.updated_at = now();
  rec.ended_at = rec.updated_at;
}

function settleRunning(rec, state, status, notes) {
  if (!rec.step_row_id) return null;
  const row = taskRunner.getTaskStep(rec.step_row_id);
  if (!row || row.state !== 'running' || row.reported_by) return null;
  return taskRunner.updateTaskStep(row.id, { state, status, notes });
}

function settleAborted(rec) {
  settleRunning(rec, 'aborted', null, `pipeline stopped${rec.stopped_by ? ` by ${rec.stopped_by}` : ''}`);
}

/** Reuse the attempt already in flight (a binding row nobody has reported) or
 *  open the NEXT attempt. A held row is never reused: the actor-claim rule
 *  would then refuse whoever the driver sent in, which is the wall working
 *  against the driver instead of for it. */
function ensureStep(rec, step) {
  const open = taskRunner.openStepRow(rec.task_id, step);
  if (open && !open.reported_by) {
    if (open.state !== 'running') taskRunner.updateTaskStep(open.id, { state: 'running' });
    rec.step_row_id = open.id;
    return taskRunner.getTaskStep(open.id) || open;
  }
  const row = taskRunner.insertTaskStep({
    task_id: rec.task_id,
    step,
    attempt: taskRunner.nextStepAttempt(rec.task_id, step),
    state: 'running',
    session_id: rec.session_id,
    notes: '',
  });
  rec.step_row_id = row.id;
  return row;
}

function bugsFor(taskId) {
  const rows = taskRunner.listTaskSteps(taskId, 200)
    .filter((r) => r.step === 'test' && r.state === 'failed' && r.artifact);
  return rows.map((r) => {
    try {
      const a = JSON.parse(r.artifact);
      return `- ${a.file}${a.line != null ? `:${a.line}` : ''} — ${a.summary}${a.repro ? ` (repro: ${a.repro})` : ''}`;
    } catch {
      return `- ${clip(r.notes, 200)}`;
    }
  });
}

/** What the driver types into the session. It says HOW to report, because the
 *  wall is real: nothing advances until a `task_step_report` lands. */
function promptFor(step, rec, task) {
  const id = rec.task_id;
  const report = (state, status) =>
    `When you are done, REPORT IT YOURSELF with task_step_report { task_id: "${id}", step: "${step}", state: "${state}", status: "${status}", notes: "…" }.`
    + ' The pipeline does not advance until a report lands, and it parks at this task\'s timeout.';
  const what = clip(task.prompt, 1500);
  switch (step) {
    case 'review':
      return `[paddock] STEP review — task ${id}\n`
        + `Decide whether this task is actionable as written:\n${what}\n`
        + `${report('done', 'passed')} Report state "failed" / status "failed" with the reason if it is NOT actionable — do not guess a plan.`;
    case 'build':
      return `[paddock] STEP build — task ${id}\n`
        + `Implement this task in the session's folder now:\n${what}\n`
        + `${report('done', 'passed')} Report state "failed" / status "failed" with what blocked you.`;
    case 'test':
      return `[paddock] STEP test — task ${id}\n`
        + `Verify the work: run the project's checks for this change.\nTask: ${what}\n`
        + `Found a defect? File it FIRST with task_step_bug { task_id: "${id}", file, line, summary, repro }, then report this step`
        + ` state "failed" / status "failed". ${report('done', 'passed')} — passed only when the checks are green.`;
    case 'hotfix': {
      const bugs = bugsFor(rec.task_id);
      return `[paddock] STEP hotfix — task ${id}\n`
        + (bugs.length ? `Fix these recorded defects:\n${bugs.join('\n')}\n` : 'Fix the defects recorded against this task.\n')
        + `${report('done', 'passed')} Report state "failed" / status "failed" if a defect is not fixable as recorded.`;
    }
    default:
      return `[paddock] STEP ${step} — task ${id}\n${report('done', 'passed')}`;
  }
}

async function sendPrompt(rec, step, task) {
  try {
    await sendFn(rec.session_id, promptFor(step, rec, task), { actor: rec.actor });
    return null;
  } catch (e) {
    return e;
  }
}

/** Wait for THIS attempt's report. Poll cost is one indexed DB read; the tmux
 *  gates only run every Nth tick (they are a docker exec each), and a failure
 *  there is an answer the driver parks on rather than a crash. */
async function waitForReport(rec, rowId) {
  const started = Date.now();
  const timeout = rec.timeout_ms;
  let ticks = 0;
  for (;;) {
    await sleep(pollMs);
    if (rec.stop) return { kind: 'stop' };
    if (!taskRunner.getTask(rec.task_id)) return { kind: 'gone' };
    const row = taskRunner.getTaskStep(rowId);
    if (!row) return { kind: 'gone' };
    if (row.reported_by && row.state !== 'pending' && row.state !== 'running') {
      return { kind: 'report', row };
    }
    if (row.state === 'aborted' && !row.reported_by) return { kind: 'stop' };
    const elapsed = Date.now() - started;
    if (elapsed >= timeout) return { kind: 'timeout', row, elapsed };
    ticks += 1;
    if (livenessEvery > 0 && ticks % livenessEvery === 0) {
      try {
        await mission.assertStepSession(rec.session_id);
      } catch (e) {
        return { kind: 'session', error: e };
      }
    }
  }
}

function parkSession(rec, err) {
  const code = (err && err.code) || 'session_unavailable';
  park(rec, code, String((err && err.message) || err));
}

/** The commit stage is SERVER-RUN (D6): no report, no agent cooperation — git
 *  runs in the session's folder and the SHA is the artifact. A clean tree is
 *  parked rather than called done: there is then no task commit to name. */
async function runCommit(rec, task) {
  let ref = '';
  let folder = '';
  try {
    const session = mission.getSession(rec.session_id);
    const project = mission.getProject(session.project_id);
    folder = project.folder || '';
    const agent = project.agent_name ? lookupAgent(project.agent_name) : null;
    if (!agent) {
      throw new PipelineError('task_commit_no_pad',
        `task ${rec.task_id} has no PAD to commit in (project ${project.name} resolves to no agent)`);
    }
    ref = agent.runtime_ref || agent.name;
    if (!folder) folder = await taskRunner.resolveTaskWorkspace(agent);
  } catch (e) {
    if (e instanceof PipelineError) return park(rec, e.code, e.message);
    return parkSession(rec, e);
  }

  const res = await taskRunner.runGitCommit(ref, folder,
    `task ${rec.task_id}: ${clip(task.prompt, 500)}`);
  const ok = res.code === 0 && !!res.sha;
  const row = taskRunner.insertTaskStep({
    task_id: rec.task_id,
    step: 'commit',
    attempt: taskRunner.nextStepAttempt(rec.task_id, 'commit'),
    state: ok ? 'done' : 'failed',
    status: ok ? 'passed' : (res.clean ? 'error' : 'failed'),
    session_id: rec.session_id,
    reported_by: rec.actor,
    notes: res.clean
      ? 'nothing to commit — the working tree was already clean, so no new SHA exists'
      : clip(res.output, 2000),
    artifact: ok ? res.sha : '',
  });
  rec.step_row_id = row.id;
  if (ok) return finish(rec, 'done', null, `committed ${res.sha}`);
  if (res.clean) {
    return park(rec, 'commit_nothing',
      'the working tree was already clean — there is no task commit to record');
  }
  return park(rec, 'commit_failed', `git exited ${res.code} — see the commit step's notes`);
}

async function run(rec) {
  try {
    for (;;) {
      if (rec.stop) { settleAborted(rec); return; }
      const task = taskRunner.getTask(rec.task_id);
      if (!task) {
        return park(rec, 'task_gone',
          'the task row was removed while the pipeline ran — parking instead of driving something nobody can read');
      }
      const step = nextStepToRun(rec.task_id);
      rec.step = step;
      rec.updated_at = now();
      if (step === 'done') return finish(rec, 'done', null, 'every step is reported done — nothing left to run');
      if (step === 'commit') return runCommit(rec, task);
      if (step === 'hotfix' && countSteps(rec.task_id, 'hotfix') >= MAX_HOTFIX) {
        return park(rec, 'max_hotfix',
          `${MAX_HOTFIX} hotfix runs already recorded for this task — a human should decide rather than loop`);
      }

      ensureStep(rec, step);
      const sendErr = await sendPrompt(rec, step, task);
      if (sendErr) return parkSession(rec, sendErr);

      const out = await waitForReport(rec, rec.step_row_id);
      if (out.kind === 'stop') { settleAborted(rec); return; }
      if (out.kind === 'gone') {
        return park(rec, 'task_gone', 'the task or its step row disappeared while the pipeline waited for a report');
      }
      if (out.kind === 'timeout') {
        return park(rec, 'timeout',
          `step '${step}' reported nothing within ${out.elapsed}ms (tasks.timeout_ms = ${rec.timeout_ms})`);
      }
      if (out.kind === 'session') return parkSession(rec, out.error);

      const row = out.row;
      if (row.state === 'needs_review') {
        return park(rec, 'needs_review',
          `step '${step}' was reported needs_review — a human decides the next move`);
      }
      if (row.state !== 'done') {
        // The one failure the driver ROUTES rather than parks: a failed `test`
        // earns a hotfix (D5's structured bugs are what the prompt carries),
        // and the re-run of `test` comes out of nextStepToRun.
        if (step === 'test' && row.state === 'failed' && row.status === 'failed') {
          rec.hotfix += 1;
          rec.updated_at = now();
          continue;
        }
        return park(rec, 'report_failed',
          `step '${step}' reported ${row.state}${row.status ? `/${row.status}` : ''} — the driver does not advance past a failed step`
          + (row.notes ? ` (${clip(row.notes, 300)})` : ''));
      }
      if (row.status && row.status !== 'passed') {
        return park(rec, 'report_error',
          `step '${step}' finished with status '${row.status}' — parked for a human rather than guessed at`);
      }
      rec.updated_at = now();
    }
  } catch (e) {
    return park(rec, 'driver_error', String((e && e.message) || e));
  }
}

function assertIdle(taskId) {
  const prev = pipelines.get(taskId);
  if (prev && ACTIVE.has(prev.state)) {
    throw new PipelineError('task_pipeline_busy',
      `a pipeline is already ${prev.state} for task ${taskId} (on step '${prev.step}') — one active pipeline step per task`);
  }
  const cur = taskRunner.getCurrentTaskStep(taskId);
  if (cur && cur.state === 'running') {
    // No driver in this process is driving that step (the check above would
    // have caught one), so it was left behind — by a webui restart, or by a
    // step started by hand. The refusal stands; what it must do is say which
    // call clears it, because `task_pipeline_status` sends the caller here.
    throw new PipelineError('task_pipeline_busy',
      `task ${taskId} already has a running step ('${cur.step}' attempt ${cur.attempt}) — one active pipeline step per task.`
      + (cur.reported_by ? '' : ' No driver is running it in this webui process, so it will not finish on its own: call task_pipeline_stop to mark it aborted, then task_pipeline_start.'));
  }
}

/** Start the driver. Everything that can be refused AT THE DOOR is refused
 *  there (no session, a finished task, a busy task, a session that is dead,
 *  locked or permission-parked) — starting a driver that parks one tick later
 *  is a worse answer than a refusal the caller can act on now. */
async function start(taskId, { actor = 'system' } = {}) {
  const task = taskRunner.getTask(taskId);
  if (!task) throw new PipelineError('task_not_found', `no task ${taskId}`);
  if (task.status === 'done' || task.status === 'cancelled') {
    throw new PipelineError('task_pipeline_closed',
      `task ${taskId} is ${task.status} — there is nothing left to run`);
  }
  const binding = taskRunner.taskBinding(taskId);
  if (!binding.session_id) {
    throw new PipelineError('task_pipeline_no_session',
      `task ${taskId} is not bound to a Mission session. Submit it with task_submit { session_id }`
      + ' — the driver only drives a session it can address (D2).');
  }
  assertIdle(taskId);

  const rec = {
    task_id: taskId,
    state: 'starting',
    step: null,
    reason: null,
    detail: null,
    actor,
    session_id: binding.session_id,
    timeout_ms: timeoutFn(task),
    started_at: now(),
    updated_at: now(),
    ended_at: null,
    stop: false,
    stopped_by: null,
    hotfix: 0,
    step_row_id: null,
  };
  // Reserved BEFORE the only await in this function: two concurrent starts must
  // not both pass the busy check (the same guard shape as the idempotency key).
  pipelines.set(taskId, rec);
  try {
    await mission.assertStepSession(binding.session_id);
  } catch (e) {
    pipelines.delete(taskId);
    throw e;
  }
  if (rec.stop) { settleAborted(rec); return rec; } // stopped while starting
  rec.state = 'running';
  rec.promise = run(rec).catch((e) => {
    try { park(rec, 'driver_error', String((e && e.message) || e)); } catch { /* already parked */ }
  });
  return rec;
}

/** Stop: sets the flag (the driver settles on its next tick) and resolves the
 *  running row NOW, so the caller's own read shows the stop instead of a step
 *  that still claims to be running. A run that already ended with a running row
 *  left behind (a stale row) is cleaned up too — but only then: with neither a
 *  driver nor a running step, `stop` refuses rather than pretending it stopped
 *  something. */
function stop(taskId, { actor = 'system' } = {}) {
  const rec = pipelines.get(taskId) || null;
  const recActive = rec && ACTIVE.has(rec.state);
  const cur = taskRunner.getCurrentTaskStep(taskId);
  const staleRunning = cur && cur.state === 'running' && !cur.reported_by ? cur : null;
  if (!recActive && !staleRunning) {
    throw new PipelineError('task_pipeline_idle',
      `no pipeline is running for task ${taskId} (nothing to stop${rec ? ` — last run ended: ${rec.state}${rec.reason ? `/${rec.reason}` : ''}` : ''})`);
  }
  if (rec) {
    rec.stop = true;
    rec.stopped_by = actor;
    if (ACTIVE.has(rec.state)) {
      rec.state = 'stopped';
      rec.reason = 'stopped';
      rec.detail = `stopped by ${actor}`;
      rec.updated_at = now();
      rec.ended_at = rec.updated_at;
    }
  }
  if (staleRunning) {
    taskRunner.updateTaskStep(staleRunning.id, {
      state: 'aborted',
      notes: `pipeline stopped by ${actor}`,
    });
  }
  return { rec, aborted_step: staleRunning ? staleRunning.id : null };
}

/** Where a task is: the driver (or the last one), the derived step, and the
 *  full step history. `note` only appears when it adds something the fields do
 *  not say — a missing driver is a fact about THIS webui process, not about the
 *  task. */
function status(taskId) {
  const task = taskRunner.getTask(taskId);
  if (!task) throw new PipelineError('task_not_found', `no task ${taskId}`);
  const rec = pipelines.get(taskId) || null;
  const steps = taskRunner.listTaskSteps(taskId, 200);
  const current = taskRunner.getCurrentTaskStep(taskId);
  const binding = taskRunner.taskBinding(taskId);
  const active = !!(rec && ACTIVE.has(rec.state));
  const out = {
    task_id: taskId,
    active,
    pipeline: rec ? snapshot(rec) : null,
    binding,
    current_step: current,
    next_step: steps.length ? nextStepToRun(taskId) : 'review',
    steps,
    task_status: task.status,
  };
  const leftover = !active && current && current.state === 'running' && !current.reported_by;
  if (leftover) {
    // Said first and separately: the generic notes below end in "start it",
    // and start REFUSES while this row is running.
    out.note = `Step '${current.step}' is still marked running, but no driver is running it in this webui process (drivers live in memory and do not survive a restart). task_pipeline_start will refuse until it is cleared: call task_pipeline_stop first, then task_pipeline_start.`;
  } else if (!active) {
    out.note = rec
      ? `Last run ended ${rec.state}${rec.reason ? ` (${rec.reason})` : ''}. A driver lives in memory, so it does not survive a webui restart — restart it with task_pipeline_start if the loop should continue.`
      : 'No pipeline has been started for this task in this webui process (drivers live in memory). task_submit still recorded the binding step, so the loop can start with task_pipeline_start.';
  }
  return out;
}

function isActive(taskId) {
  const rec = pipelines.get(taskId);
  return !!(rec && ACTIVE.has(rec.state));
}

/** Drop every driver (tests, and the honest shape for "the process is going
 *  away"): flags are set and rows settled, so nothing is left claiming work. */
function resetForTests() {
  for (const rec of pipelines.values()) {
    rec.stop = true;
    if (ACTIVE.has(rec.state)) {
      rec.state = 'stopped';
      rec.reason = 'stopped';
      rec.detail = 'reset';
      settleAborted(rec);
    }
  }
  pipelines.clear();
}

function _setForTests({ send, agent, poll, liveness, timeout, resetSeams } = {}) {
  if (resetSeams) {
    sendFn = (sessionId, text, opts) => mission.sendText(sessionId, text, opts);
    lookupAgent = (name) => registry.getAgent(name);
    pollMs = POLL_MS;
    livenessEvery = LIVENESS_EVERY;
    timeoutFn = (task) => Number(task.timeout_ms) || taskRunner.DEFAULT_TIMEOUT_MS;
  }
  if (send) sendFn = send;
  if (agent) lookupAgent = agent;
  if (poll != null) pollMs = poll;
  if (liveness != null) livenessEvery = liveness;
  if (timeout) timeoutFn = timeout;
}

module.exports = {
  PipelineError,
  start,
  stop,
  status,
  isActive,
  nextStepToRun,
  snapshot,
  resetForTests,
  _setForTests,
};
