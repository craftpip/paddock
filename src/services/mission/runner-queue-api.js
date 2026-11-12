/**
 * The runner queue as the page and the worker see it: the read (with the
 * execution view), every mutation, and blocker resolution.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  readRunnerPlanFile,
  writeRunnerPlanFile,
  updateRunnerQueueItem,
  pauseConfirmation,
  resolveRunnerQueue,
  readRunnerQueue,
  setupRunnerQueue,
  updateRunnerQueue,
  addRunnerQueueItems,
  reorderRunnerQueue,
  removeRunnerQueueItem,
  updateRunnerQueueCustomInstructions,
  listRunnerPlans,
});

const crypto = require('crypto');
const fs = require('fs');
const { getDb } = require('../db');
const agentStore = require('../agent-store');
const plans = require('../plans');
const runnerHistory = require('../runner-history');
const runnerQueue = require('../runner-queue');
const runnerTransition = require('../runner-transition');
const runnerView = require('../runner-view');
const { REVIEWABLE_STATES } = require('../runner-state');
const runnerPublication = require('../runner-publication');
const { requireAgent, RUNNER_NO_RESPONSE_TIMEOUT_MS } = require('./internal');
const { MissionError } = require('./errors');
const { getProject, projectTag } = require('./projects');
const { getSession, audit } = require('./sessions');
const { sendText, awaitExactReceipt } = require('./session-io');
const { getRunner, canonicalQueueProjection, queueMissionError, syncQueuePausedMarker, runnerContainerPaths, writeCanonicalQueueProjection, getRunnerForSupervision } = require('./runners');
const { effectivePromptTemplates } = require('./runner-prompts');
const { computeSchedulerState, kickRunnerWatch } = require('./scheduler');

/** A queue item with the plan's own display metadata attached (plan 86 §Phase 1).
 *  The queue file names a plan path; the panel shows its TITLE and plan Status,
 *  so a named plan that no longer exists is visible as such (`exists: false`)
 *  rather than a bare path nobody can read. One failing plan must never blank
 *  the whole queue list. */
function enrichRunnerQueueItem(item, agent, project) {
  const out = {
    id: item.id,
    plan: item.plan,
    status: item.status,
    reason: item.reason || '',
  };
  try {
    const plan = plans.readPlan(agent, item.plan, { project });
    if (plan) {
      out.exists = true;
      out.title = plan.title;
      out.planStatus = plan.status;
      out.planStatusRaw = plan.statusRaw;
    } else {
      out.exists = false;
    }
  } catch (e) {
    out.exists = false;
  }
  return out;
}

/** Plan 86 §Phase 4b: decide a pending pause's next state from OBSERVATION,
 *  never from the enabled flag or a conversational claim. Purely:
 *   - `before_next_task`: confirmed once the target item is no longer
 *     `in progress` (the worker finished it), or there was no target at all.
 *     While the target is still `in progress`, the pause is still being applied.
 *   - `current_task`: confirmed ONLY once the worker is observed IDLE
 *     (`workerBusyKnown && !workerBusy`) — it stopped its turn mid-plan and kept
 *     the item `in progress` (its checkpoint). Without a KNOWN-idle observation
 *     we stay `requested` and never claim a stop we did not see.
 *  Returns 'confirmed' | 'requested' | null (null = no pending pause). */
function pauseConfirmation(runner, { targetStatus = null, workerBusy = null, workerBusyKnown = false } = {}) {
  if (!runner || runner.pause_state !== 'requested' || !runner.pause_mode) return null;
  if (runner.pause_mode === 'before_next_task') {
    return (!runner.pause_target_item || targetStatus !== 'in progress') ? 'confirmed' : 'requested';
  }
  return (workerBusyKnown && workerBusy === false) ? 'confirmed' : 'requested';
}

/** Apply pauseConfirmation to a runner using an already-read queue: a
 *  `before_next_task` need only the queue file; a `current_task` reads the
 *  worker conversation's own store for a known-idle observation. The update is
 *  guarded on `pause_state = 'requested'` so a concurrent Resume/Remove wins.
 *  Returns the (possibly refreshed) runner row. */
async function reconcileRunnerPause(runner, project, queue) {
  if (!runner || runner.pause_state !== 'requested' || !runner.pause_mode) return runner;
  const target = ((queue && queue.parsed && queue.parsed.items) || [])
    .find((it) => it.id === runner.pause_target_item) || null;
  let workerBusy = null;
  let workerBusyKnown = false;
  if (runner.pause_mode === 'current_task' && runner.session_id) {
    try {
      const session = getSession(runner.session_id);
      if (session && session.agent_session_id) {
        const turn = agentStore.readTurn(project.agent_name, session.agent_session_id);
        workerBusy = turn.state === 'working';
        workerBusyKnown = turn.state !== 'unknown';
      }
    } catch { /* session gone — cannot observe idle; stay requested */ }
  }
  const next = pauseConfirmation(runner, { targetStatus: target ? target.status : null, workerBusy, workerBusyKnown });
  if (next !== 'confirmed') return runner;
  const reason = runner.pause_mode === 'current_task'
    ? `Paused current task — ${target ? target.plan : 'the plan'} stopped at its checkpoint.`
    : 'Paused — next task will not start.';
  const changed = getDb().prepare(
    "UPDATE infinite_runners SET pause_state = 'confirmed', updated_at = ? WHERE id = ? AND pause_state = 'requested' AND EXISTS (SELECT 1 FROM runner_runtime rt WHERE rt.runner_id = infinite_runners.id AND rt.generation = ?)"
  ).run(new Date().toISOString(), runner.id, runner.run_generation);
  if (changed.changes) runnerTransition.setReason(runner.id, 'pause_confirmed', reason);
  return getRunner(runner.id);
}

/** The full queue picture for one runner (plan 86 §Phase 1): the parsed items
 *  (not just validator facts), each enriched with its plan's title/status, the
 *  one shared `summary` projection, the physical + worker-visible paths, the
 *  revision hash the panel must echo back when it edits, and a `condition`
 *  ('ok' | 'missing' | 'unreadable' | 'malformed') so "not set up yet" and
 *  "your queue file is broken" are different states instead of one `invalid`. */
async function readRunnerQueue(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  return readRunnerQueueFor(runner);
}

async function readRunnerQueueFor(runner) {
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  let q;
  try {
    q = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(runner.id));
  } catch (e) {
    if (e instanceof runnerQueue.RunnerQueueError && e.code === 'queue_not_found') {
      q = {
        parsed: { version: plans.QUEUE_VERSION, items: [], customInstructions: '' },
        aggregate: { state: 'invalid', reason: 'Canonical queue has not been set up.' },
        condition: 'missing', summary: plans.queueSummary({ items: [] }), path: plans.queuePath(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, runner.queue_file), hash: null, error: 'Canonical queue has not been set up.',
      };
    } else queueMissionError(e);
  }
  if (q.condition === 'projection_error') {
    const runtime = runnerTransition.getRuntime(runner.id);
    if (runtime && runtime.state !== 'projection_error') {
      const result = runnerTransition.applyProjectionMismatch(runner.id, {
        actor: 'projection-integrity', details: { reason: q.error, revision: runtime.generation },
      });
      syncQueuePausedMarker(runner.id, result.markerRequired);
    }
  }
  // Plan 86 §Phase 4b: a pending pause is confirmed from observation here — the
  // panel polls this read, so "Pausing…" becomes a truthful "Paused" once the
  // worker is seen to have stopped, and never before.
  // Invalid projection state is handled by the canonical runtime transition,
  // never by clearing legacy stop fields during a read.
  const repaired = runner;
  const current = await reconcileRunnerPause(repaired, project, q);
  const worker = current.session_id ? getSession(current.session_id) : null;
  const turn = agentStore.readTurn(agent, worker?.agent_session_id);
  const now = Date.now();
  const idleSince = turn.state === 'idle'
    ? (current.worker_state === 'idle' && current.worker_turn_id === turn.userId ? current.idle_since : turn.completedAt || new Date(now).toISOString())
    : null;
  let scheduler = computeSchedulerState({ ...current, idle_since: idleSince }, q, turn, now);
  // The watcher saw a permission dialog in the worker's pane and sent nothing.
  // That is pane state this read does not capture, so carry the watcher's own
  // observation (it is replaced by the next pass once the dialog is answered).
  if (current.worker_state === 'waiting_for_permission' && current.scheduler_decision === 'blocked') {
    scheduler = { ...scheduler, workerState: 'waiting_for_permission', schedulerDecision: 'blocked', reason: current.scheduler_reason || 'Waiting for permission', nextCheckMs: null };
  }
  const items = (q.parsed.items || []).map((it) => enrichRunnerQueueItem(it, agent, project));
  const execution = runnerQueueExecution(current, q, scheduler, { items, workerBusy: turn.state === 'working' });
  // Plan 91 §Phase 2: the Configure dialog reads saved prompts from this same
  // detail read, so the subset carries the effective set (never the raw column).
  const eff = effectivePromptTemplates(current);
  return {
    runner: {
      id: current.id, name: current.name, queue_file: current.queue_file,
      session_id: current.session_id, pause_mode: current.pause_mode, pause_state: current.pause_state,
      promptTemplates: eff.templates, promptTemplateVersion: eff.version,
      promptTemplatesCustom: eff.custom, promptTemplatesError: eff.error,
    },
    project: projectTag(project),
    queue: {
      state: execution.state === 'projection_error' ? 'projection_error' : q.aggregate.state,
      reason: q.error || (execution.state === 'projection_error' ? execution.reason : q.aggregate.reason),
      condition: q.condition,
      revision: q.hash,
      path: q.path,
      workerPath: runnerContainerPaths(project, current.queue_file).queue,
      items,
      repairItems: q.repairItems || [],
      repairDuplicateIds: q.repairDuplicateIds || [],
      customInstructions: q.parsed.customInstructions || '',
      summary: q.summary,
      error: q.condition === 'ok' && execution.state !== 'projection_error' ? null : (q.error || execution.reason || q.aggregate.reason),
      execution,
      scheduler: {
        ...scheduler,
        ...(q.condition !== 'ok' || execution.state === 'projection_error' ? { schedulerDecision: 'blocked', reason: q.error || execution.reason || q.aggregate.reason, nextCheckMs: null } : {}),
        deadline: scheduler.nextCheckMs === null ? null : new Date(now + scheduler.nextCheckMs).toISOString(),
        countdownLabel: { wait_idle_grace: 'Idle grace', wait_nudge_interval: 'Nudge interval' }[scheduler.schedulerDecision] || null,
        observedAt: new Date(now).toISOString(),
      },
    },
    updatedAt: current.updated_at,
  };
}

/** Gather the facts the pure view needs (services/runner-view.js builds the
 * verdict). Item progress is not runner authorization; projection repair wins
 * over stale operation and stop fields. */
function runnerQueueExecution(runner, queue, scheduler, { items = null, workerBusy = false } = {}) {
  const runtime = runnerTransition.getRuntime(runner.id);
  return runnerView.buildExecution({
    runtimeState: runtime ? runtime.state : null,
    queueCondition: queue.condition,
    queueError: queue.error || null,
    items: items || queue.parsed.items,
    summary: queue.summary,
    scheduler,
    operation: runner.activeOperationId ? {
      id: runner.activeOperationId,
      kind: runner.operation_kind,
      status: runner.operation_status,
      itemId: runner.operation_item_id,
      queueRevision: runner.operation_queue_revision,
      deadlineAt: runner.operation_deadline_at,
    } : null,
    outstanding: !!runtime?.operation_id,
    pauseMode: runner.pause_mode || null,
    workerBusy,
    stopCode: runtime?.reason_code || null,
  });
}

/** Set a runner's queue up: create QUEUE.md from the template if it does not
 *  exist, then refuse if the file still will not validate. Concurrent creates
 *  are race-safe (`ensureQueue` writes with `wx` and re-reads a loser). */
async function setupRunnerQueue(id, { actor = null, confirmProjectionReset = false } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  const plansProject = { ...project, plans_folder: project.plans_folder || 'plans' };
  let existingSnapshot = null;
  try { existingSnapshot = runnerQueue.snapshot(id); }
  catch (error) { if (error.code !== 'queue_not_found') queueMissionError(error); }
  const currentPath = plans.queuePath(agent, plansProject, runner.queue_file);
  const fileExists = fs.existsSync(currentPath);
  let projectionDiffers = fileExists && !existingSnapshot;
  if (fileExists && existingSnapshot) {
    try {
      projectionDiffers = fs.readFileSync(currentPath, 'utf8') !== plans.queueProjection(existingSnapshot.items, existingSnapshot.customInstructions);
    } catch { projectionDiffers = true; }
  }
  if (projectionDiffers && !confirmProjectionReset) {
    throw new MissionError('runner_projection_confirmation_required',
      'The server will replace an existing QUEUE.md projection with the canonical database queue. Review the rows, then confirm Regenerate; no queue item status will be imported from the file.');
  }
  const existingRuntime = runnerTransition.getRuntime(id);
  let needsRepair = projectionDiffers || existingRuntime?.state === 'projection_error';
  try {
    const condition = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(id)).condition;
    needsRepair ||= condition === 'projection_error';
  } catch (e) {
    if (e.code !== 'queue_not_found') throw e;
    needsRepair ||= fileExists;
  }
  if (existingRuntime && ['dispatching', 'awaiting_receipt', 'running'].includes(existingRuntime.state) && !needsRepair) {
    throw new MissionError('runner_queue_setup_running', 'Pause/stop the runner before explicitly setting up its queue projection.');
  }
  if (!runnerTransition.getRuntime(id)) {
    // Explicit setup is the only initializer for old development runner rows.
    runnerTransition.createRuntime(id);
  }
  let currentRuntime = runnerTransition.getRuntime(id);
  if (needsRepair && currentRuntime.state !== 'projection_error') {
    runnerTransition.applyProjectionMismatch(id, { actor, details: { reason: 'Explicit projection regeneration' } });
    if (runnerPublication.read(id)) syncQueuePausedMarker(id, true);
  }
  let queue;
  try {
    queue = runnerQueue.ensure(id, { actor });
    writeCanonicalQueueProjection(runner, project, agent, queue);
  } catch (e) {
    queueMissionError(e);
  }
  audit(project, 'runner_queue_setup', { actor: actor ? (actor.name || actor) : null });
  if (needsRepair) {
    // A repaired projection never resumes work. Consume stale instruction and
    // stop fields together, so a late receipt cannot undo explicit repair.
    currentRuntime = runnerTransition.getRuntime(id);
    if (currentRuntime.state === 'projection_error') {
      runnerTransition.applyProjectionRegenerated(id, { actor, details: { reason: 'Explicit projection regeneration' } });
    }
  }
  // Sync marker to current enabled state (enabled=0 → paused marker exists).
  const current = getRunner(id);
  syncQueuePausedMarker(id, !current.enabled);
  return readRunnerQueueFor(current);
}

/** The plans available in a runner's project folder (plan 86 §Phase 3) —
 *  candidate rows for "Add plans". Scoped to the runner's OWN project folder
 *  (never another project's), with the folder's entry files (README/INDEX/
 *  QUEUE) and archived plans already excluded by `plans.listPlans`. The panel
 *  filters out plans already in the queue; this read just answers "what plans
 *  exist here". */
async function listRunnerPlans(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  const plansProject = { ...project, plans_folder: project.plans_folder || 'plans' };
  const rows = plans.listPlans(agent, { project: plansProject }) || [];
  return {
    runner: { id: runner.id, name: runner.name },
    project: projectTag(project),
    plans: rows.map((r) => ({
      path: r.path,
      title: r.title || null,
      status: r.status || null,
      statusRaw: r.statusRaw || null,
      done: !!r.done,
      session: r.session || null,
      created: r.created || null,
      lastActivity: r.last_activity || null,
      unreadable: r.unreadable || null,
    })),
  };
}

// ─── One plan file, for the Mission file viewer ─────────────────────────────
// The queue names a plan by its path relative to the project's plans folder;
// `plans.planPath` resolves it (on the host, through the webui's bind mounts,
// so it works while the PAD is stopped) and refuses anything that leaves the
// folder, is not a .md, or is a reserved name (QUEUE.md, INDEX.md, README.md).
// The viewer edits the RAW file, frontmatter included — it is a file viewer.
// `revision` is the sha256 of the content read, and a save must present it:
// the worker agent edits its plan while it runs, and a save over an edit the
// human never saw would silently throw the agent's work away.
const PLAN_FILE_MAX_BYTES = 2 * 1024 * 1024;
const planRevision = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function runnerPlanAbs(id, relPath) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  const plansProject = { ...project, plans_folder: project.plans_folder || 'plans' };
  let abs;
  try {
    abs = plans.planPath(agent, relPath, { project: plansProject });
  } catch (e) {
    throw new MissionError(e.code || 'plan_path_invalid', e.message, 400);
  }
  return { abs, base: plans.plansDir(agent, { project: plansProject }), project };
}

function readRunnerPlanFile(id, relPath) {
  const { abs, project } = runnerPlanAbs(id, relPath);
  if (!fs.existsSync(abs)) throw new MissionError('plan_not_found', `Plan file not found: ${relPath}`, 404);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new MissionError('plan_not_found', `Not a file: ${relPath}`, 404);
  if (st.size > PLAN_FILE_MAX_BYTES) throw new MissionError('plan_too_large', `Plan file is larger than ${PLAN_FILE_MAX_BYTES} bytes`, 413);
  const content = fs.readFileSync(abs, 'utf8');
  return {
    name: String(relPath).split('/').pop(),
    path: String(relPath),
    content,
    size: st.size,
    modifiedAt: st.mtime.toISOString(),
    revision: planRevision(content),
    project: projectTag(project),
  };
}

function writeRunnerPlanFile(id, relPath, content, revision, { actor = null } = {}) {
  if (typeof content !== 'string') throw new MissionError('plan_content_required', 'content must be a string', 400);
  if (Buffer.byteLength(content, 'utf8') > PLAN_FILE_MAX_BYTES) throw new MissionError('plan_too_large', `Plan file is larger than ${PLAN_FILE_MAX_BYTES} bytes`, 413);
  const { abs, base, project } = runnerPlanAbs(id, relPath);
  // Edit only: this viewer opens plans that exist; creating one is the plan
  // tools' job (they stamp the frontmatter a new plan needs).
  if (!fs.existsSync(abs)) throw new MissionError('plan_not_found', `Plan file not found: ${relPath}`, 404);
  if (!revision) throw new MissionError('plan_revision_required', 'Save needs the revision you read, so a newer edit is never overwritten', 400);
  const current = fs.readFileSync(abs, 'utf8');
  if (planRevision(current) !== revision) {
    throw new MissionError('plan_revision_conflict', 'This plan changed since you opened it (the agent may have edited it). Reload to see the new version; your text is kept in the editor.', 409);
  }
  const { writeFileOwned } = require('../ownership');
  writeFileOwned(abs, content, { boundary: base });
  // Shape only, never the text (an audit row is not a second copy of a plan).
  audit(project, 'plan_file_saved', { actor, details: `${relPath} (${Buffer.byteLength(content, 'utf8')} bytes)` });
  const st = fs.statSync(abs);
  return { ok: true, path: String(relPath), size: st.size, modifiedAt: st.mtime.toISOString(), revision: planRevision(content) };
}

/** Legacy whole-array writes were the path that accepted browser-generated IDs.
 * Queue mutation is now explicit so the authority allocates and preserves IDs. */
async function updateRunnerQueue(id, _items, _revision, { actor = null } = {}) {
  throw new MissionError('queue_operation_required', 'Use add, reorder, remove, or item update operations; whole-queue writes are no longer supported.');
}

async function updateRunnerQueueItem(id, itemId, patch, revision, { actor = null, source = 'review' } = {}) {
  // The page only offers a hand correction in these states (runner-view's
  // reviewStatus verdict reads the same list); the write must refuse the rest
  // or a status flipped under a working worker races its own report.
  if (source === 'review') {
    const state = runnerTransition.getRuntime(id)?.state;
    if (state && !REVIEWABLE_STATES.includes(state)) {
      throw new MissionError('runner_invalid_state', `Pause the queue before changing a plan's status (current: ${state}).`, 409);
    }
  }
  const detail = await mutateCanonicalQueue(id, revision, actor, () => runnerQueue.updateItem(id, itemId, patch, revision, { actor, source }));
  // The worker's own "done" is the signal that its plan ended; start watching
  // for its turn to finish now rather than at the next 20 s tick.
  if (source === 'worker' && patch?.status === 'done') kickRunnerWatch(id);
  if (source !== 'review') return detail;
  let runtime = runnerTransition.getRuntime(id);
  if (runtime?.state === 'projection_error') {
    runnerTransition.applyProjectionRegenerated(id, { actor: actor || 'user', details: { reason: 'Reviewed item status correction' } });
    runtime = runnerTransition.getRuntime(id);
  }
  const current = runnerQueue.snapshot(id);
  const hasBlocker = current.items.some((item) => item.status === 'need_input');
  const allDone = current.items.length > 0 && current.items.every((item) => item.status === 'done');
  if (runtime?.state === 'waiting_input' && !hasBlocker) {
    runnerTransition.applyResolve(id, { actor: actor || 'user', details: { reason: 'Human-reviewed status correction cleared the blocker.' } });
  } else if (runtime?.state === 'paused' && hasBlocker) {
    runnerTransition.applyQueueBlocked(id, { actor: actor || 'user', details: { reason: 'Human-reviewed queue status requires input.' } });
  } else if (runtime?.state === 'complete' && !allDone) {
    runnerTransition.applyEvent(id, 'work_added', { actor: actor || 'user', details: { reason: 'Human-reviewed status correction reopened queue work.' } });
    // Reopening a finished queue straight into a blocked item is a blocker, not
    // a plain pause: without this the header read Paused beside a blocker card.
    if (hasBlocker) runnerTransition.applyQueueBlocked(id, { actor: actor || 'user', details: { reason: 'Human-reviewed queue status requires input.' } });
  } else if (runtime?.state === 'paused' && allDone) {
    runnerTransition.applyReviewComplete(id, { actor: actor || 'user', details: { reason: 'Human reviewed all queue items complete.' } });
  }
  const latest = getRunner(id);
  syncQueuePausedMarker(id, runnerTransition.markerRequired(runnerTransition.getRuntime(id).state));
  return readRunnerQueueFor(latest);
}

async function mutateCanonicalQueue(id, revision, actor, mutate) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  let queue;
  const before = runnerQueue.snapshot(runner.id);
  try {
    queue = mutate();
    writeCanonicalQueueProjection(runner, project, agent, queue);
  } catch (e) {
    queueMissionError(e);
  }
  const oldItems = new Map(before.items.map((item) => [item.id, item]));
  const newItems = new Map(queue.items.map((item) => [item.id, item]));
  const key = `queue-mutation:${crypto.randomUUID()}`;
  for (const item of queue.items) if (!oldItems.has(item.id)) {
    runnerHistory.record(runner, 'plan_added', { actor: actor || 'user', key: `${key}:add:${item.id}`, plan: item.plan, itemId: item.id });
  }
  for (const item of before.items) if (!newItems.has(item.id)) {
    runnerHistory.record(runner, 'plan_removed', { actor: actor || 'user', key: `${key}:remove:${item.id}`, plan: item.plan, itemId: item.id });
  }
  if (oldItems.size === newItems.size && before.items.some((item, index) => queue.items[index]?.id !== item.id)) {
    runnerHistory.record(runner, 'queue_reordered', { actor: actor || 'user', key: `${key}:reordered`, reason: `${queue.items.length} queued item positions updated` });
  }
  audit(project, 'runner_queue_update', { actor: actor ? (actor.name || actor) : null });
  // Re-read: the mutation can change the runtime (adding work to a finished
  // queue moves complete -> paused), and the row read above still said
  // `complete`, so the response claimed "Queue is done" beside a Paused queue.
  return readRunnerQueueFor(getRunner(id));
}

async function addRunnerQueueItems(id, plansToAdd, revision, { actor = null } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  try {
    for (const plan of plansToAdd || []) plans.planPath(agent, plan, { project });
  } catch (error) {
    if (error instanceof plans.PlansError) throw new MissionError(error.code, error.message);
    throw error;
  }
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.addPlans(id, plansToAdd, revision, { actor }));
}

async function reorderRunnerQueue(id, itemIds, revision, { actor = null } = {}) {
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.reorder(id, itemIds, revision, { actor }));
}

async function removeRunnerQueueItem(id, itemId, revision, { actor = null } = {}) {
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.remove(id, itemId, revision, { actor }));
}

/** Revision-protected queue-level guidance edit. The queue file, rather than a
 * runner/database column, remains the sole editable source of truth. */
async function updateRunnerQueueCustomInstructions(id, customInstructions, revision, { actor = null } = {}) {
  return mutateCanonicalQueue(id, revision, actor, () => runnerQueue.setCustomInstructions(id, customInstructions, revision, { actor }));
}

/** Resolve a need-input blocker: deliver the answer, requeue the item, and enable supervision.
 *  This is a SINGLE server-owned operation that replaces the client's send->requeue->start
 *  sequence, which fails because the answer makes the worker busy and startRunner then
 *  refuses with "worker not idle".
 *  Plan 97: atomic resolution with marker lift and supervision enable.
 */
async function resolveRunnerQueue(id, itemId, answer, revision, idempotencyKey, { actor = null } = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  let runtime = runnerTransition.getRuntime(id);
  // Paused with a blocked plan is the same situation as waiting for input,
  // reached another way (a pause that the plan outlived, or an earlier answer
  // that could not be sent). Name it, so the answer can go through.
  if (runtime?.state === 'paused' && runnerQueue.snapshot(id).items.some((queued) => queued.id === itemId && queued.status === 'need_input')) {
    runnerTransition.applyQueueBlocked(id, { actor: actor || 'user', details: { itemId, reason: 'Answering a blocked plan while paused.' } });
    runtime = runnerTransition.getRuntime(id);
  }
  if (!runtime || runtime.state !== 'waiting_input') {
    throw new MissionError('runner_invalid_state', `Runner must be waiting_input to resolve (current: ${runtime?.state || 'setup_required'})`);
  }
  const { project, agent, session, queue } = await getRunnerForSupervision(id);
  if (queue.condition !== 'ok') {
    throw new MissionError('runner_invalid_queue', queue.error || 'Regenerate the queue projection before resolving input.');
  }
  if (!session) throw new MissionError('runner_no_session', 'Runner has no bound session');
  if (queue.aggregate.state !== 'need input') {
    throw new MissionError('runner_no_need_input', 'Queue is not blocked on input');
  }
  const item = (queue.parsed.items || []).find((it) => it.id === itemId);
  if (!item) throw new MissionError('runner_item_not_found', `Item ${itemId} not found in queue`);
  if (item.status !== 'need input') {
    throw new MissionError('runner_item_not_blocked', `Item ${itemId} is not a need-input blocker`);
  }
  if (queue.hash !== revision) {
    throw new MissionError('queue_revision_conflict', 'Queue was modified since you loaded it — reload and retry');
  }

  // Idempotency check: if this exact key was used before, return the existing result
  if (idempotencyKey) {
    const existing = getDb().prepare('SELECT * FROM runner_resolutions WHERE runner_id = ? AND idempotency_key = ?').get(id, idempotencyKey);
    if (existing) return {
      delivered: existing.delivered_at,
      requeued: existing.requeued_at,
      resumed: existing.resumed_at,
      awaitingReceipt: ['pending', 'awaiting_receipt'].includes(existing.status),
      status: existing.status,
      resolutionId: existing.id,
    };
  }

  const agentObj = requireAgent(project.agent_name);

  // Reserve resolution ownership - prevent concurrent resolutions
  const resolutionId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  try {
    getDb().prepare(
      `INSERT INTO runner_resolutions (id, runner_id, item_id, answer, idempotency_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`
    ).run(resolutionId, id, itemId, answer, idempotencyKey || null, nowIso);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new MissionError('resolution_already_pending', 'Another resolution is in progress for this item');
    }
    throw e;
  }

  try {
    // Reserve the answer as its own durable operation before typing. It may
    // resume only after the exact answer receipt is observed.
    const baseline = agentStore.readTurn(agent, session.agent_session_id);
    // One line, like every other instruction the runner sends. The pane
    // submits each line with its own Enter, so a two-line answer arrived as two
    // messages, neither of which hashed to what was recorded: the receipt could
    // never be matched and the runner stuck on "Waiting for worker".
    const answerText = require('../prompt-templates').normalizePromptForSend(`Resolution for "${item.plan}": ${answer}`);
    const operationId = `rop_${crypto.randomUUID()}`;
    const resolveOperation = runnerTransition.applyResolveBegin(id, { actor: actor || 'user', details: {
      operationId, kind: 'resolution', conversationId: session.agent_session_id,
      itemId, queueRevision: revision,
      promptHash: crypto.createHash('sha256').update(answerText.trimEnd()).digest('hex'),
      baselineInputId: baseline.userId || null,
      deadlineAt: new Date(Date.now() + RUNNER_NO_RESPONSE_TIMEOUT_MS).toISOString(),
    } });
    syncQueuePausedMarker(id, false);
    runnerHistory.record(runner, 'answer_submitted', { actor: actor || 'user', groupId: `answer:${resolutionId}`, key: `${resolutionId}:submitted`, itemId, plan: item.plan, characters: String(answer).length });
    const beforeWrite = () => {
      const current = runnerTransition.getRuntime(id);
      const currentSession = getSession(session.id);
      if (!current || current.state !== 'dispatching' || current.operation_id !== operationId ||
          current.generation !== resolveOperation.runtime.generation || currentSession.locked ||
          currentSession.agent_session_id !== session.agent_session_id) {
        throw new MissionError('runner_resolution_superseded', 'Answer delivery was cancelled by Pause, Close, lock or conversation change.', 409);
      }
      const freshQueue = runnerQueue.snapshot(id);
      if (freshQueue.revision !== revision || freshQueue.items.find((entry) => entry.id === itemId)?.status !== 'need_input') {
        throw new MissionError('queue_revision_conflict', 'The blocked item changed before the answer was sent. Reload and review it.', 409);
      }
    };
    try {
      await sendText(session.id, answerText, { actor: actor || 'runner', beforeWrite });
    } catch (error) {
      if (error?.attempted && error?.acceptance === 'unknown') {
        runnerTransition.applyDeliveryUnknown(id, { actor: actor || 'user', details: { operationId, reason: 'resolution receipt not observed' } });
        getDb().prepare('UPDATE runner_resolutions SET status = ?, error = ? WHERE id = ?')
          .run('awaiting_receipt', 'Answer delivery is unconfirmed; no resend made.', resolutionId);
        syncQueuePausedMarker(id, false);
        return { delivered: null, requeued: null, resumed: null, awaitingReceipt: true, operationId };
      }
      throw error;
    }
    const expectedHash = crypto.createHash('sha256').update(answerText.trimEnd()).digest('hex');
    const receipt = await awaitExactReceipt(agent, session.agent_session_id, baseline.userId, expectedHash);
    if (!receipt) {
      runnerTransition.applyDeliveryUnknown(id, { actor: actor || 'user', details: { operationId, reason: 'resolution exact receipt not observed' } });
      getDb().prepare('UPDATE runner_resolutions SET status = ?, error = ? WHERE id = ?')
        .run('awaiting_receipt', 'Answer delivery is unconfirmed; no resend made.', resolutionId);
      syncQueuePausedMarker(id, false);
      return { delivered: null, requeued: null, resumed: null, awaitingReceipt: true, operationId };
    }
    runnerTransition.applyReceipt(id, { actor: actor || 'user', details: { operationId, receiptInputId: receipt.userId } });
    const currentQueue = runnerQueue.snapshot(id);
    const updatedQueue = runnerQueue.updateItem(id, itemId, { status: 'new', reason: '' }, currentQueue.revision, { actor, source: 'resolution' });
    writeCanonicalQueueProjection(getRunner(id), project, agentObj, updatedQueue);
    syncQueuePausedMarker(id, false);

    // Mark resolution as complete
    getDb().prepare('UPDATE runner_resolutions SET status = ?, delivered_at = ?, requeued_at = ?, resumed_at = ? WHERE id = ?')
      .run('completed', nowIso, nowIso, nowIso, resolutionId);
    runnerHistory.record(runner, 'answer_accepted', { actor: actor || 'user', groupId: `answer:${resolutionId}`, key: `${resolutionId}:accepted`, itemId, plan: item.plan });

    return { delivered: nowIso, requeued: nowIso, resumed: nowIso, operationId, receiptInputId: receipt.userId };
  } catch (e) {
    const currentRuntime = runnerTransition.getRuntime(id);
    if (currentRuntime?.state === 'dispatching') {
      runnerTransition.applyPause(id, { actor: actor || 'user', details: { reason: 'Resolution did not reach a confirmed receipt.' } });
      // The plan is still blocked, so the runner is still waiting for input,
      // not merely paused: leave it where the answer can be sent again.
      try {
        if (runnerQueue.snapshot(id).items.some((queued) => queued.id === itemId && queued.status === 'need_input')) {
          runnerTransition.applyQueueBlocked(id, { actor: actor || 'user', details: { itemId, reason: 'The answer could not be delivered; the plan still needs it.' } });
        }
      } catch { /* stays paused, which the entry check above also accepts */ }
      runnerTransition.setReason(id, 'resolution_failed', e.message);
      syncQueuePausedMarker(id, true);
    }
    getDb().prepare('UPDATE runner_resolutions SET status = ?, error = ? WHERE id = ?')
      .run('failed', e.message, resolutionId);
    runnerHistory.record(runner, 'answer_failed', { actor: actor || 'user', groupId: `answer:${resolutionId}`, key: `${resolutionId}:failed`, itemId, plan: item.plan, severity: 'warning', code: e.code || 'resolution_failed' });
    throw e;
  }
}
