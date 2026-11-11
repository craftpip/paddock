/**
 * Infinite runner rows: create, read, update, the runtime projection and the
 * queue's file projection.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  syncQueuePausedMarker,
  getRunner,
  publicRunner,
  runnerContainerPaths,
  canonicalQueueProjection,
  queueMissionError,
  writeCanonicalQueueProjection,
  getRunnerForSupervision,
  setRunnerReason,
  setRunnerEnabled,
  recordStopProvenance,
  newRunnerId,
  createRunner,
  getActiveRunnerForProject,
  listRunnersForProject,
  listAllRunners,
  updateRunner,
  setRunnerControlState,
});

const crypto = require('crypto');
const fs = require('fs');
const { getDb } = require('../db');
const plans = require('../plans');
const runnerHistory = require('../runner-history');
const runnerQueue = require('../runner-queue');
const runnerTransition = require('../runner-transition');
const runnerPublication = require('../runner-publication');
const { requireAgent, PROMPT_TEMPLATES_PRESERVE } = require('./internal');
const { MissionError } = require('./errors');
const { getProject, listProjects, projectTag } = require('./projects');
const { getSession } = require('./sessions');
const { startSession, closeSession } = require('./session-lifecycle');
const { parsePromptTemplatesInput, withPromptTemplates } = require('./runner-prompts');

/* ---------------------------------------------------------------- */
/*  INFINITE RUNNER SERVICE (plan 83)                               */
/* ---------------------------------------------------------------- */

const RUNNER_CONTROL_STATES = Object.freeze(['enabled', 'paused', 'waiting', 'need_input', 'finished']);
// Plan 86 §Phase 4b: the two explicit Pause modes. `before_next_task` lets the
// worker finish the plan it is on and only blocks the NEXT item; `current_task`
// also asks the worker to stop the plan it is on at the earliest safe
// checkpoint. An omitted mode is backward-compatible with the old single
// finish-current-plan behavior.
const RUNNER_PAUSE_MODES = Object.freeze(['before_next_task', 'current_task']);
const RUNNER_HEALTH_STATES = Object.freeze([
  'working', 'waiting_for_tool', 'compacting', 'recovering',
  'suspected_stuck', 'usage_exhausted', 'auth_expired',
  'rate_limited', 'observation_unavailable', 'invalid_queue'
]);

function queueMissionError(error) {
  if (error instanceof runnerQueue.RunnerQueueError) throw new MissionError(error.code, error.message);
  throw error;
}

function canonicalQueueProjection(runner, project, agent, snapshot) {
  const file = runner.queue_file || 'QUEUE.md';
  const pathOnHost = plans.queuePath(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, file);
  const expected = plans.queueProjection(snapshot.items, snapshot.customInstructions);
  let condition = 'ok';
  let error = null;
  const publication = runnerPublication.read(runner.id);
  try {
    if (!fs.existsSync(pathOnHost) || fs.readFileSync(pathOnHost, 'utf8') !== expected) {
      condition = 'projection_error';
      error = 'Generated QUEUE.md differs from the canonical queue. Regenerate the projection before running work.';
    }
  } catch (e) {
    condition = 'projection_error';
    error = `Could not verify generated QUEUE.md: ${e.message}`;
  }
  const expectedPublicationHash = runnerQueue.publicationHash(snapshot);
  if (!publication) {
    condition = 'setup_required';
    error = 'This existing runner needs explicit canonical runtime and publication setup.';
  } else if (publication.desired_revision !== snapshot.revision || publication.desired_hash !== expectedPublicationHash ||
      publication.acknowledged_revision !== snapshot.revision || publication.acknowledged_hash !== expectedPublicationHash ||
      publication.error) {
    condition = 'projection_error';
    error = publication?.error || 'The canonical queue revision has not been acknowledged by its worker projection publisher.';
  }
  if (publication && condition === 'ok') {
    const runtime = runnerTransition.getRuntime(runner.id);
    const markerRequired = !runtime || runnerTransition.markerRequired(runtime.state);
    const markerPath = plans.queuePausedPath(agent, { ...project, plans_folder: project.plans_folder || 'plans' });
    if (publication.desired_marker !== Number(markerRequired) || fs.existsSync(markerPath) !== markerRequired) {
      condition = 'projection_error';
      error = 'The queue execution marker does not match the canonical runner state.';
    }
  }
  const items = snapshot.items.map((item) => ({ ...item, status: item.status.replace('_', ' ') }));
  const parsed = { version: plans.QUEUE_VERSION, items, customInstructions: snapshot.customInstructions };
  const aggregate = plans.queueAggregateState(parsed);
  return {
    parsed,
    aggregate,
    condition,
    summary: plans.queueSummary(parsed),
    path: pathOnHost,
    hash: snapshot.revision,
    error,
  };
}

function writeCanonicalQueueProjection(runner, project, agent, snapshot) {
  const latest = runnerQueue.snapshot(runner.id);
  if (latest.revision !== snapshot.revision || runnerQueue.publicationHash(latest) !== runnerQueue.publicationHash(snapshot)) {
    throw new MissionError('queue_revision_conflict', 'The queue changed before its projection could be published. Reload and retry.');
  }
  return runnerPublication.publish(runner, project, agent);
}

/** Generate a runner id. */
function newRunnerId() {
  return 'run_' + crypto.randomBytes(8).toString('hex');
}

/** Create a runner configuration.
 *  When `sessionId` is given (plan 83: "set up an existing session as a
 *  runner"), it is validated before persist: the session must exist, must
 *  belong to THIS project (a runner row lives in exactly one project, and a
 *  session elsewhere would be started / no-progressed by a runner that has no
 *  right to it), and must not already be bound to another runner (the runner
 *  row IS that session; two rows pinned for one session would both drive it).
 *  The FK does not enforce any of these — it only keeps the id from dangling —
 *  so the checks are explicit and each asks a different question.
 *
 *  Plan 85: when NO `sessionId` is given, the worker session is created HERE —
 *  an infinite runner IS a session, and the row must open a real terminal
 *  immediately, independently of whether its queue is running. A stopped PAD or
 *  a missing folder fails the whole create (ordinary session errors), never a
 *  half-created configuration row. */
async function createRunner({ projectId, name, sessionId, queueFile = 'QUEUE.md',
  idleGraceMs = 120000, minNudgeIntervalMs = 120000, noProgressBudget = 3,
  compactionGraceMs = 300000, longCommandThresholdMs = 1800000,
  recoverExited = true, recoveryBudget = 3, promptTemplates = undefined, actor = null } = {}) {
  const project = getProject(projectId);
  let normalizedQueueFile;
  try {
    normalizedQueueFile = plans.normalizeQueueFile(requireAgent(project.agent_name), project, queueFile);
  } catch (e) {
    if (e instanceof plans.PlansError) throw new MissionError(e.code, e.message);
    throw e;
  }
  // Plan 91 §Phase 2: prompt templates are validated BEFORE anything is
  // persisted or any session minted — a bad set must not leave a runner behind.
  // Omitted input stores NULL (shipped defaults), never the preserve sentinel.
  const promptInput = parsePromptTemplatesInput(promptTemplates);
  const promptTemplatesJson = promptInput === PROMPT_TEMPLATES_PRESERVE ? null : promptInput;
  const id = newRunnerId();
  const db = getDb();
  const projectAgent = requireAgent(project.agent_name);
  try {
    runnerPublication.assertPathAvailable(id, project, projectAgent, normalizedQueueFile);
  } catch (error) {
    if (error instanceof runnerPublication.RunnerPublicationError) {
      throw new MissionError(error.code, error.message);
    }
    throw error;
  }
  let boundSessionId = null;
  if (sessionId) {
    let session;
    try {
      session = getSession(sessionId);
    } catch (e) {
      throw new MissionError('runner_session_not_found', `Session ${sessionId} does not exist`);
    }
    if (String(session.project_id) !== String(projectId)) {
      throw new MissionError('runner_session_wrong_project', `Session ${sessionId} belongs to another project`);
    }
    const taken = db.prepare('SELECT id FROM infinite_runners WHERE session_id = ? AND id != ?').get(sessionId, id);
    if (taken) {
      throw new MissionError('runner_session_in_use', `Session ${sessionId} is already the worker of runner ${taken.id}`);
    }
    boundSessionId = session.id;
  } else {
    const created = await startSession(projectId, {
      label: `Runner: ${name}`,
      origin: 'human',
      createdBy: actor,
    });
    boundSessionId = created.session.id;
  }
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT INTO infinite_runners (id, name, project_id, session_id, queue_file,
        idle_grace_ms, min_nudge_interval_ms, no_progress_budget,
        compaction_grace_ms, long_command_threshold_ms, recover_exited, recovery_budget,
        prompt_templates_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, name, projectId, boundSessionId, normalizedQueueFile,
      idleGraceMs, minNudgeIntervalMs, noProgressBudget,
      compactionGraceMs, longCommandThresholdMs,
      recoverExited ? 1 : 0, recoveryBudget,
      promptTemplatesJson,
      now, now
    );
  } catch (e) {
    // The session was just created for this runner — do not leave it orphaned
    // when the row cannot be persisted. Best effort: a failed create must not
    // plant a stray TUI the user never asked to keep.
    if (!sessionId && boundSessionId) {
      try { await closeSession(boundSessionId, { actor }); } catch { /* best effort */ }
    }
    throw e;
  }
  // Create one canonical queue immediately. The generated worker file is a
  // projection; no runner starts with a file that the worker may author.
  try {
    runnerTransition.createRuntime(id);
    const createdQueue = runnerQueue.ensure(id, { actor });
    writeCanonicalQueueProjection(getRunner(id), project, projectAgent, createdQueue);
  } catch (e) {
    // Keep the durable queue/runtime row on publication failure; the UI must
    // expose a recoverable Projection error rather than lose the new authority.
    queueMissionError(e);
  }
  // New runner starts paused (enabled=0) — create the pause marker.
  syncQueuePausedMarker(id, true);
  runnerHistory.record(getRunner(id), 'runner_created', { actor: actor || 'user', key: 'created' });
  return withPromptTemplates(getRunner(id));
}

/** Get a runner by id. */
function getRunner(id) {
  const row = getDb().prepare('SELECT * FROM infinite_runners WHERE id = ?').get(id);
  return withRunnerRuntime(row);
}

function withRunnerRuntime(row) {
  if (!row) return row;
  const runtime = runnerTransition.getRuntime(row.id);
  if (!runtime) return {
    ...row,
    execution: { state: 'setup_required', generation: null, reasonCode: null, reason: null, allowedActions: [], markerRequired: true, operation: null },
    canonicalState: 'setup_required', allowedActions: [], run_generation: 0,
    enabled: 0, control_state: 'paused', operation_id: null, operation_generation: 0,
    operation_status: 'none', operation_started_at: null, operation_confirmed_at: null,
    operation_session_id: null, operation_prompt_hash: null,
    operation_baseline_user_id: null, operation_receipt_user_id: null,
  };
  const operation = runtime.operation_id
    ? getDb().prepare('SELECT * FROM runner_operations WHERE id = ? AND runner_id = ?').get(runtime.operation_id, row.id)
    : getDb().prepare('SELECT * FROM runner_operations WHERE runner_id = ? ORDER BY generation DESC LIMIT 1').get(row.id);
  const legacyControl = {
    paused: 'paused', dispatching: 'enabled', awaiting_receipt: 'enabled', running: 'enabled',
    waiting_input: 'need_input', held: 'need_input', complete: 'finished', projection_error: 'need_input',
  }[runtime.state];
  const operationStatus = operation ? ({
    dispatching: 'pending', awaiting_receipt: 'unconfirmed', running: 'confirmed',
    held: 'held', invalidated: 'invalidated', completed: 'ended',
  }[operation.status] || 'none') : 'none';
  return {
    ...row,
    execution: {
      state: runtime.state,
      generation: runtime.generation,
      reasonCode: runtime.reason_code,
      reason: runtime.reason,
      allowedActions: runnerTransition.allowedActions(runtime.state),
      markerRequired: runnerTransition.markerRequired(runtime.state),
      operation: operation ? {
        id: operation.id,
        generation: operation.generation,
        kind: operation.operation_kind,
        status: operation.status,
        conversationId: operation.conversation_id,
        itemId: operation.item_id,
        queueRevision: operation.queue_revision,
        promptHash: operation.prompt_hash,
        baselineInputId: operation.baseline_input_id,
        receiptInputId: operation.receipt_input_id,
        deadlineAt: operation.deadline_at,
        createdAt: operation.created_at,
        updatedAt: operation.updated_at,
      } : null,
    },
    canonicalState: runtime.state,
    runtimeGeneration: runtime.generation,
    run_generation: runtime.generation,
    runtimeReasonCode: runtime.reason_code,
    runtimeReason: runtime.reason,
    allowedActions: runnerTransition.allowedActions(runtime.state),
    markerRequired: runnerTransition.markerRequired(runtime.state),
    control_state: legacyControl,
    enabled: ['dispatching', 'awaiting_receipt', 'running'].includes(runtime.state) ? 1 : 0,
    operation_id: runtime.operation_id || operation?.id || null,
    activeOperationId: runtime.operation_id,
    operation_status: operationStatus,
    operation_started_at: operation?.created_at || null,
    operation_confirmed_at: operation?.status === 'running' ? operation.updated_at : null,
    operation_deadline_at: operation?.deadline_at || null,
    operation_kind: operation?.operation_kind || null,
    operation_item_id: operation?.item_id || null,
    operation_queue_revision: operation?.queue_revision ?? null,
    operation_session_id: operation?.conversation_id || null,
    operation_prompt_hash: operation?.prompt_hash || null,
    operation_baseline_user_id: operation?.baseline_input_id || null,
    operation_receipt_user_id: operation?.receipt_input_id || null,
    last_reason: runtime.reason,
    stop_cause: runtime.reason_code,
  };
}

const TRANSITION_PAYLOAD_FIELDS = [
  'enabled', 'control_state', 'run_generation', 'operation_id', 'operation_generation',
  'operation_status', 'operation_started_at', 'operation_confirmed_at', 'operation_deadline_at',
  'operation_kind', 'operation_item_id', 'operation_queue_revision', 'operation_session_id',
  'operation_prompt_hash', 'operation_baseline_user_id', 'operation_receipt_user_id',
  'canonicalState', 'runtimeGeneration', 'runtimeReasonCode', 'runtimeReason',
  'allowedActions', 'markerRequired', 'activeOperationId', 'stop_cause', 'last_reason',
];

/** Public Mission runner metadata exposes one canonical execution object, never
 * the transition-era flat columns that used to look like independent authorities. */
function publicRunner(runner) {
  if (!runner) return runner;
  const out = { ...runner };
  for (const field of TRANSITION_PAYLOAD_FIELDS) delete out[field];
  // Plan 114 §2: the legacy observation columns outlive the transition that made
  // them false — a closed session still read `worker_state: working`, a paused
  // runner still read "Worker idle — grace 118s remaining" weeks later. The
  // canonical runtime is the authority, so the outward view must not contradict
  // it. (Internals keep the raw columns: grace timing reads idle_since.)
  if (!out.session_id) {
    out.worker_state = 'unknown';
    out.worker_turn_id = null;
    out.idle_since = null;
  }
  const state = out.execution?.state;
  if (state && !['dispatching', 'awaiting_receipt', 'running'].includes(state)) {
    out.scheduler_decision = ({ paused: 'paused', complete: 'finished', waiting_input: 'need_input', held: 'need_input' })[state] || 'blocked';
    out.scheduler_reason = out.execution.reason || null;
  }
  return out;
}

/** Get the enabled runner for a project (at most one). */
function getActiveRunnerForProject(projectId) {
  return getDb().prepare(`
    SELECT r.* FROM infinite_runners r JOIN runner_runtime rt ON rt.runner_id = r.id
    WHERE r.project_id = ? AND rt.state IN ('dispatching','awaiting_receipt','running')
    ORDER BY rt.updated_at DESC LIMIT 1
  `).get(projectId);
}

/** List runners for a project. */
function listRunnersForProject(projectId) {
  return getDb().prepare('SELECT * FROM infinite_runners WHERE project_id = ? ORDER BY created_at DESC').all(projectId)
    .map((row) => withPromptTemplates(withRunnerRuntime(row)));
}

/** Every runner across every project the caller may see, each tagged with its
 *  project (plan 85 §Phase 2: the all-projects view merges infinite sessions
 *  into the same list, so it needs runners from every project, not just the
 *  selected one). Same `allow` contract as `listAllSessions`. */
function listAllRunners({ allow = null } = {}) {
  const projects = listProjects();
  const byId = new Map(projects.map((p) => [p.id, p]));
  const visible = (p) => p && (!allow || allow(p.agent_name));
  return getDb().prepare('SELECT * FROM infinite_runners ORDER BY created_at DESC').all()
    .filter((r) => visible(byId.get(r.project_id)))
    .map((r) => withPromptTemplates({ ...withRunnerRuntime(r), project: projectTag(byId.get(r.project_id)) }));
}

/** Update runner settings (not state). `promptTemplates` follows the create
 *  contract: omitted preserves, explicit null resets to defaults, a complete
 *  object replaces after validation. */
async function updateRunner(id, { name, idleGraceMs, minNudgeIntervalMs, noProgressBudget,
  queueFile = undefined, compactionGraceMs, longCommandThresholdMs, recoverExited, recoveryBudget, promptTemplates = undefined }) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  if (queueFile !== undefined) {
    const project = getProject(runner.project_id);
    let normalized;
    try {
      normalized = plans.normalizeQueueFile(requireAgent(project.agent_name), project, queueFile);
    } catch (e) {
      if (e instanceof plans.PlansError) throw new MissionError(e.code, e.message);
      throw e;
    }
    if (normalized !== (runner.queue_file || 'QUEUE.md')) {
      const runtime = runnerTransition.getRuntime(id);
      if (!runtime || runtime.state !== 'paused' || runtime.operation_id) {
        throw new MissionError('runner_queue_file_busy', 'Pause supervision and wait for the active instruction to finish before changing the queue file.');
      }
      const projectAgent = requireAgent(project.agent_name);
      try { runnerPublication.assertPathAvailable(id, project, projectAgent, normalized); }
      catch (error) { if (error instanceof runnerPublication.RunnerPublicationError) throw new MissionError(error.code, error.message); throw error; }
      getDb().prepare('UPDATE infinite_runners SET queue_file = ?, updated_at = ? WHERE id = ?')
        .run(normalized, new Date().toISOString(), id);
      const publication = runnerPublication.read(id);
      if (publication) runnerPublication.invalidateAcknowledgement(id);
    }
  }
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (idleGraceMs !== undefined) { updates.push('idle_grace_ms = ?'); params.push(idleGraceMs); }
  if (minNudgeIntervalMs !== undefined) { updates.push('min_nudge_interval_ms = ?'); params.push(minNudgeIntervalMs); }
  if (noProgressBudget !== undefined) { updates.push('no_progress_budget = ?'); params.push(noProgressBudget); }
  if (compactionGraceMs !== undefined) { updates.push('compaction_grace_ms = ?'); params.push(compactionGraceMs); }
  if (longCommandThresholdMs !== undefined) { updates.push('long_command_threshold_ms = ?'); params.push(longCommandThresholdMs); }
  if (recoverExited !== undefined) { updates.push('recover_exited = ?'); params.push(recoverExited ? 1 : 0); }
  if (recoveryBudget !== undefined) { updates.push('recovery_budget = ?'); params.push(recoveryBudget); }
  const promptJson = parsePromptTemplatesInput(promptTemplates);
  if (promptJson !== PROMPT_TEMPLATES_PRESERVE) { updates.push('prompt_templates_json = ?'); params.push(promptJson); }
  if (!updates.length) return withPromptTemplates(getRunner(id));
  updates.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  getDb().prepare(`UPDATE infinite_runners SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return withPromptTemplates(getRunner(id));
}

/** Set runner control state (enabled/paused/waiting/need_input/finished).
 *  Now uses the canonical runner transition service. */
async function setRunnerControlState(id, controlState) {
  if (!RUNNER_CONTROL_STATES.includes(controlState)) {
    throw new MissionError('runner_invalid_state', `Invalid control state: ${controlState}`);
  }
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  if (controlState === 'enabled') throw new MissionError('runner_operation_required', 'Use startRunner to authorize a specific durable operation.');

  const canonical = runnerTransition.getRunnerCanonicalState(runner);
  let result = null;

  switch (controlState) {
    case 'paused':
      if (canonical !== 'paused') {
        result = await runnerTransition.applyPause(id);
      }
      break;
    case 'waiting':
      if (canonical !== 'paused') {
        result = await runnerTransition.applyPause(id);
      }
      break;
    case 'need_input':
      if (['dispatching', 'awaiting_receipt', 'running'].includes(canonical)) {
        result = await runnerTransition.applyNeedInput(id);
      }
      break;
    case 'finished':
      if (['dispatching', 'awaiting_receipt', 'running'].includes(canonical)) {
        result = await runnerTransition.applyComplete(id);
      }
      break;
    case 'enabled':
      if (['paused', 'held', 'complete'].includes(canonical)) {
        result = await runnerTransition.applyRun(id);
      }
      break;
  }
  if (result?.markerRequired !== undefined) {
    syncQueuePausedMarker(id, result.markerRequired);
  }
  return result?.runner || getRunner(id);
}

/** Enable or disable queue dispatch — the ONE place `enabled` is written
 *  (plan 85 §Phase 4). Now uses the canonical runner transition service. */
async function setRunnerEnabled(id, on) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);

  if (on) throw new MissionError('runner_operation_required', 'Use startRunner to authorize a specific durable operation.');
  const result = await runnerTransition.applyPause(id);
  if (result?.markerRequired !== undefined) {
    syncQueuePausedMarker(id, result.markerRequired);
  }
  return result?.runner || getRunner(id);
}

/** Record the actionable reason a runner stopped or is waiting (shown in the
 *  terminal header). A refusal to Run writes this, never the runner's content. */
function setRunnerReason(id, reason) {
  runnerTransition.setReason(id, reason ? 'runner_notice' : null, reason || null);
}

/** Container-visible queue/index/paused paths for the worker (plan 85 §Phase 4 gap 7).
 *  `project.folder` IS the container path (checked inside the PAD at session
 *  start), and `plans_folder` is the subfolder beneath it — so the worker
 *  reaches its queue at `<folder>/<plans_folder>/<queue_file>`. The
 *  host-resolved `plans.queuePath` is for the webui's own reads; putting it in
 *  a prompt tells the worker a path that does not exist in its namespace. */
function runnerContainerPaths(project, queueFile) {
  const pf = String(project.plans_folder || 'plans').replace(/\/+$/, '') || 'plans';
  const qf = String(queueFile || 'QUEUE.md');
  const base = `${String(project.folder || '').replace(/\/+$/, '')}/${pf}`;
  return {
    queue: `${base}/${qf}`,
    index: `${base}/INDEX.md`,
    paused: `${base}/QUEUE.paused`,
  };
}

/** Sync the QUEUE.paused marker to match runner.enabled (best-effort). */
function syncQueuePausedMarker(runnerId, paused) {
  try {
    const runner = getRunner(runnerId);
    if (!runner) return;
    const project = getProject(runner.project_id);
    if (!project) return;
    const agent = requireAgent(project.agent_name);
    runnerPublication.publishMarker(runner, project, agent);
    // Clear any previous marker sync error on success
    getDb().prepare('UPDATE infinite_runners SET marker_sync_error = NULL WHERE id = ?').run(runnerId);
  } catch (e) {
    console.warn(`[runner] queue pause marker sync ${runnerId}:`, e.message);
    // Record the sync error for UI visibility
    getDb().prepare('UPDATE infinite_runners SET marker_sync_error = ? WHERE id = ?').run(e.message, runnerId);
  }
}

/** Record stop provenance: cause, origin (automatic/explicit), and timestamp. */
function recordStopProvenance(id, cause, origin, details = null) {
  runnerTransition.setReason(id, cause, JSON.stringify({ origin, details }));
}

/** Get runner with project and session details for supervision. */
async function getRunnerForSupervision(id) {
  const runner = getRunner(id);
  if (!runner) return null;
  const project = getProject(runner.project_id);
  const agent = requireAgent(project.agent_name);
  let session = null;
  if (runner.session_id) session = getSession(runner.session_id);
  let queue;
  try {
    queue = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(runner.id));
  } catch (e) {
    queueMissionError(e);
  }
  return { runner, project, agent, session, queue };
}

Object.assign(exports, { RUNNER_PAUSE_MODES, RUNNER_CONTROL_STATES, RUNNER_HEALTH_STATES });
