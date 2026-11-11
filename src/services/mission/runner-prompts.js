/**
 * Runner prompt templates and lifecycle callback configuration: catalogue,
 * effective set, preview and render.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  withPromptTemplates,
  parsePromptTemplatesInput,
  effectivePromptTemplates,
  renderRunnerPrompt,
  runnerPromptConfig,
  previewRunnerPrompts,
  previewProjectPrompts,
  promptCatalogue,
  getRunnerCallbacks,
  saveRunnerCallbacks,
  runnerCallbackHistory,
  callbackCatalogue,
});

const crypto = require('crypto');
const promptTemplates = require('../prompt-templates');
const runnerCallbacks = require('../runner-callbacks');
const runnerQueue = require('../runner-queue');
const { PROMPT_TEMPLATES_PRESERVE, requireAgent } = require('./internal');
const { MissionError } = require('./errors');
const { getProject } = require('./projects');
const { getRunner, runnerContainerPaths, canonicalQueueProjection } = require('./runners');

function parsePromptTemplatesInput(value) {
  if (value === undefined) return PROMPT_TEMPLATES_PRESERVE;
  if (value === null) return null;
  const v = promptTemplates.validateTemplateSet(value);
  if (!v.ok) {
    const first = v.errors[0];
    throw new MissionError(first.code, `promptTemplates: ${first.message}`);
  }
  return JSON.stringify(value);
}

/** Content hash identifying an effective template set (the "version" the
 *  configuration surface and, later, operation metadata carry). */
function promptTemplateVersion(templatesObj) {
  return crypto.createHash('sha256').update(JSON.stringify(templatesObj), 'utf8').digest('hex');
}

/** Effective templates for a runner row: stored custom set, or the shipped
 *  defaults when the column is NULL (existing rows are never rewritten).
 *  Corrupt stored JSON is an explicit failure (`error`), never a silent
 *  default fallback — a misconfigured runner withholds sends (Phase 4) while
 *  editing/repair stays available. */
function effectivePromptTemplates(row) {
  const raw = row ? row.prompt_templates_json : null;
  if (raw === null || raw === undefined) {
    return {
      templates: { ...promptTemplates.DEFAULT_TEMPLATES },
      version: promptTemplateVersion(promptTemplates.DEFAULT_TEMPLATES),
      custom: false,
      error: null,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { templates: null, version: null, custom: true, error: { code: 'prompt_templates_corrupt', message: `Saved prompt templates are not valid JSON: ${e.message}` } };
  }
  const v = promptTemplates.validateTemplateSet(parsed);
  if (!v.ok) {
    return { templates: null, version: null, custom: true, error: { code: v.errors[0].code, message: `Saved prompt templates are invalid: ${v.errors[0].message}` } };
  }
  return { templates: parsed, version: promptTemplateVersion(parsed), custom: true, error: null };
}

/** Enrich a runner row for configuration responses: effective templates, its
 *  content-hash version, default/custom status, and any corruption failure.
 *  The raw row (and its stored column) pass through untouched. */
function withPromptTemplates(row) {
  if (!row) return row;
  const eff = effectivePromptTemplates(row);
  return {
    ...row,
    promptTemplates: eff.templates,
    promptTemplateVersion: eff.version,
    promptTemplatesCustom: eff.custom,
    promptTemplatesError: eff.error,
  };
}

/** Static callback-engine catalogue for surfaces with no runner yet (the
 *  create dialog). No database, no session — just the contract. */
function callbackCatalogue() {
  return runnerCallbacks.callbackCatalogue();
}

/** Plan 92 §Phase 2 — lifecycle callback settings surface. Reads the five
 *  events' scripts + flags plus the catalogue (meanings, env vars, limits).
 *  Reads never execute. CallbackError surfaces as a MissionError code. */
function getRunnerCallbacks(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  try {
    return {
      runner: { id: runner.id, name: runner.name },
      callbacks: runnerCallbacks.listCallbacks(id),
      catalogue: runnerCallbacks.callbackCatalogue(),
    };
  } catch (e) {
    if (e instanceof runnerCallbacks.CallbackError) throw new MissionError(e.code, e.message);
    throw e;
  }
}

/** Save a PARTIAL callback map: `{ event: { script, enabled } }`. Omitted
 *  events preserve their saved values; every supplied event validates fully
 *  before anything is written, then saves per event (file + row atomically).
 *  Saving never executes. */
function saveRunnerCallbacks(id, map) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  if (!map || typeof map !== 'object' || Array.isArray(map) || !Object.keys(map).length) {
    throw new MissionError('callback_map_missing', 'Callback update needs a callbacks object with at least one event.');
  }
  try {
    for (const event of Object.keys(map)) {
      const entry = map[event];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new runnerCallbacks.CallbackError('callback_entry_invalid', `Callback \`${event}\` must be an object with script and enabled.`);
      }
      runnerCallbacks.validateEventKey(event);
      if (typeof entry.script !== 'string') {
        throw new runnerCallbacks.CallbackError('callback_script_missing', `Callback \`${event}\` needs a script string.`);
      }
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        throw new runnerCallbacks.CallbackError('callback_enabled_invalid', `Callback \`${event}\` enabled must be a boolean.`);
      }
      if (entry.recreateResume !== undefined && (typeof entry.recreateResume !== 'boolean' || (entry.recreateResume && event !== 'usage_exhausted'))) {
        throw new runnerCallbacks.CallbackError('callback_recovery_invalid', 'Recreate and resume is only available for usage_exhausted.');
      }
    }
    const saved = [];
    for (const event of Object.keys(map)) {
      saved.push(runnerCallbacks.saveCallback(id, event, { script: map[event].script, enabled: map[event].enabled, recreateResume: map[event].recreateResume }));
    }
    return { runner: { id: runner.id, name: runner.name }, saved, callbacks: runnerCallbacks.listCallbacks(id) };
  } catch (e) {
    if (e instanceof runnerCallbacks.CallbackError) throw new MissionError(e.code, e.message);
    throw e;
  }
}

/** Execution history reads (writes arrive with the Phase 3 executor).
 *  Runner-scoped for live runners; project-scoped (`projectId` + `runnerId`)
 *  is the post-destroy owner path, since destroy deletes the runner row the
 *  runner-scoped gate reads through. */
function runnerCallbackHistory({ runnerId = null, projectId = null, limit = 50 } = {}) {
  // Project scope is the post-destroy owner path: it must NOT require the
  // runner row destroy deleted. Runner-only scope keeps requiring it (nothing
  // to gate a removed runner through).
  if (projectId) getProject(projectId);
  if (runnerId && !projectId) {
    const runner = getRunner(runnerId);
    if (!runner) throw new MissionError('runner_not_found', `Runner ${runnerId} not found`);
  }
  if (!runnerId && !projectId) {
    throw new MissionError('callback_history_unscoped', 'History needs a runnerId, a projectId, or both.');
  }
  return runnerCallbacks.listCallbackHistory({ runnerId, projectId, limit });
}

/** Static prompt-engine catalogue for surfaces with no runner yet (the create
 *  dialog). No database, no session, no queue — just the contract. */
function promptCatalogue() {  return {
    keys: [...promptTemplates.TEMPLATE_KEYS],
    catalogue: promptTemplates.VARIABLE_CATALOGUE,
    limits: promptTemplates.TEMPLATE_LIMITS,
    defaults: { ...promptTemplates.DEFAULT_TEMPLATES },
  };
}

/** Read-only prompt configuration surface: catalogue, shipped defaults,
 *  budgets and this runner's effective set. Creates no session, touches no
 *  queue file, enables nothing. */
function runnerPromptConfig(id) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const eff = effectivePromptTemplates(runner);
  return {
    runner: { id: runner.id, name: runner.name },
    keys: [...promptTemplates.TEMPLATE_KEYS],
    catalogue: promptTemplates.VARIABLE_CATALOGUE,
    limits: promptTemplates.TEMPLATE_LIMITS,
    defaults: { ...promptTemplates.DEFAULT_TEMPLATES },
    effective: eff.templates,
    version: eff.version,
    custom: eff.custom,
    error: eff.error,
  };
}

/** Build the render context for prompt preview/dispatch from REAL project data:
 *  container paths from the existing resolver, current/blocker from the live
 *  queue summary when one is readable. Caller overrides win per key, so the
 *  dialog can preview hypothetical values; every key records its provenance
 *  (`real` | `sample` | `empty`) so the UI labels sample values honestly.
 *  Read-only: a queue read failure degrades item context to absent, never to a
 *  throw that would take preview offline. */
function buildPromptContext(project, { queueFile = 'QUEUE.md', queue = null, runnerName = undefined, overrides = {} } = {}) {
  const paths = runnerContainerPaths(project, queueFile);
  const clean = {};
  for (const [k, v] of Object.entries(overrides || {})) {
    if (v !== undefined) clean[k] = v;
  }
  const summary = (queue && queue.summary) || {};
  const base = {
    runner_name: runnerName,
    project_name: project.name,
    project_path: project.folder,
    plans_path: paths.queue.slice(0, paths.queue.lastIndexOf('/')),
    queue_path: paths.queue,
    index_path: paths.index,
    paused_path: paths.paused,
    current_plan: summary.current ? summary.current.plan : undefined,
    current_item_status: summary.current ? summary.current.status : undefined,
    blocker_reason: summary.blocked ? summary.blocked.reason : undefined,
  };
  const context = {};
  const sources = {};
  for (const key of Object.keys(promptTemplates.VARIABLE_CATALOGUE)) {
    if (Object.prototype.hasOwnProperty.call(clean, key)) {
      context[key] = clean[key];
      sources[key] = 'sample';
    } else if (base[key] !== undefined && base[key] !== null && base[key] !== '') {
      context[key] = base[key];
      sources[key] = 'real';
    } else {
      sources[key] = 'empty';
    }
  }
  return { context, sources };
}

/** Shared draft validate+render core for both preview routes. Preview shows the
 *  EXACT submitted text: drafts render, then normalize to one logical terminal
 *  submission, and `normalizedKeys` names every kind whose text changed so the
 *  dialog explains the normalization instead of hiding it. */
function renderPromptDrafts(drafts, context) {
  if (!drafts || typeof drafts !== 'object' || Array.isArray(drafts) || !Object.keys(drafts).length) {
    throw new MissionError('prompt_drafts_missing', 'Preview needs a drafts object with at least one template key.');
  }
  const errors = [];
  const rendered = {};
  const normalizedKeys = [];
  for (const key of Object.keys(drafts)) {
    if (!promptTemplates.TEMPLATE_KEYS.includes(key)) {
      errors.push({ key, code: 'prompt_unknown_key', message: `Unknown template key \`${key}\`.` });
      continue;
    }
    if (typeof drafts[key] !== 'string') {
      errors.push({ key, code: 'prompt_not_string', message: `Template \`${key}\` must be a string.` });
      continue;
    }
    const v = promptTemplates.validateTemplate(drafts[key]);
    if (!v.ok) {
      for (const e of v.errors) errors.push({ key, code: e.code, message: e.message, line: e.line, column: e.column });
      continue;
    }
    try {
      const raw = promptTemplates.renderTemplate(drafts[key], context);
      const normalized = promptTemplates.normalizePromptForSend(raw);
      rendered[key] = normalized;
      if (normalized !== raw) normalizedKeys.push(key);
    } catch (e) {
      errors.push({ key, code: e.code || 'prompt_render_failed', message: e.message });
    }
  }
  return { ok: errors.length === 0, rendered, errors, normalizedKeys };
}

/** Plan 91 §Phase 4 — the ONE way a runner-to-LLM message is produced. Renders
 *  the saved template for `kind` against real dispatch context, then
 *  normalizes to one logical terminal submission. A misconfigured set or a
 *  missing required value is an actionable MissionError naming the repair —
 *  never `undefined` in a sent prompt and never a silent default fallback.
 *  `extra` overrides context per key (e.g. the pause target's plan). Returns
 *  `{ text, version }`: the version (content hash) travels with the operation
 *  via the existing `operation_prompt_hash`, so an outstanding send stays
 *  identifiable across edits and restarts without new columns. */
function renderRunnerPrompt(runner, project, queue, kind, extra = {}) {
  const eff = effectivePromptTemplates(runner);
  if (eff.error) {
    throw new MissionError('runner_prompts_misconfigured', `Prompt templates misconfigured: ${eff.error.message} Repair them in Configure → Prompts, then retry.`);
  }
  const { context } = buildPromptContext(project, { queueFile: runner.queue_file, queue, runnerName: runner.name, overrides: extra });
  let rendered;
  try {
    rendered = promptTemplates.renderTemplate(eff.templates[kind], context);
  } catch (e) {
    throw new MissionError(e.code || 'prompt_render_failed', `Cannot render the ${kind} prompt: ${e.message}`);
  }
  const guidance = queue?.parsed?.customInstructions || '';
  const text = guidance
    ? `${rendered}\n\n=== QUEUE CUSTOM INSTRUCTIONS ===\n${guidance}\n=== END QUEUE CUSTOM INSTRUCTIONS ===`
    : rendered;
  // This protocol is not an editable template: even older saved prompts must
  // never send a worker back to editing the generated projection.
  // `withRunnerRuntime` also exposes the last completed operation for display.
  // It is not the next dispatch assignment: only a runtime-owned active
  // operation may supply operation_item_id. New dispatches use the canonical
  // current/next queue item so a completed item's ID cannot leak into the next
  // worker prompt.
  const assignedItem = runner.activeOperationId
    ? runner.operation_item_id
    : (queue?.summary?.current?.id || queue?.summary?.next?.id);
  const assignment = assignedItem
    ? (runner.activeOperationId
      ? ` Current owned operation ${runner.activeOperationId} is assigned to item ${assignedItem}.`
      : ` This dispatch is assigned to item ${assignedItem}.`)
    : '';
  const protocol = `Queue authority: runner_id=${runner.id}.${assignment} QUEUE.md is read-only generated output; NEVER edit it. Call paddock_runner_agent_queue_read with this exact runner_id. Its result contains queue.items and queue.revision. Call paddock_runner_agent_queue_update_item with the item's id as item_id, queue.revision as the numeric revision, and an accepted status: new, in_progress, need_input, done. Re-read after every accepted mutation and on a revision conflict. Only update the item assigned to the current operation; do not take a second item. Queue changes must go through these tools, including marking work started, done, or blocked; never choose a runner by PAD name. If the tools are unavailable, stop and report that instead of editing the file.`;
  return { text: promptTemplates.normalizePromptForSend(`${text}\n\n${protocol}`), version: eff.version };
}

/** Read-only preview for an existing runner: real container paths and live
 *  queue item context, caller overrides labeled as samples. Validates supplied
 *  drafts and renders them WITHOUT persisting anything. Never sends, starts,
 *  enables or touches the queue file. */
async function previewRunnerPrompts(id, drafts, overrides = {}) {
  const runner = getRunner(id);
  if (!runner) throw new MissionError('runner_not_found', `Runner ${id} not found`);
  const project = getProject(runner.project_id);
  let queue = null;
  try {
    const agent = requireAgent(project.agent_name);
    queue = canonicalQueueProjection(runner, project, agent, runnerQueue.snapshot(runner.id));
  } catch { /* item context degrades to absent; paths still preview */ }
  const { context, sources } = buildPromptContext(project, { queueFile: runner.queue_file, queue, runnerName: runner.name, overrides });
  return { ...renderPromptDrafts(drafts, context), contextSources: sources };
}

/** Read-only preview for a project with no runner yet (the create dialog):
 *  same engine, same real paths; the runner name and item context come from
 *  caller overrides and are labeled samples. */
async function previewProjectPrompts(projectId, drafts, overrides = {}) {
  const project = getProject(projectId);
  // A project with no runner has no canonical queue yet. Preview remains useful
  // with empty item context; it must not fall back to a worker projection.
  const queue = null;
  const { context, sources } = buildPromptContext(project, { queue, overrides });
  return { ...renderPromptDrafts(drafts, context), contextSources: sources };
}
