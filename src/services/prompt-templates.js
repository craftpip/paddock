/** Prompt templates for infinite-runner-to-LLM messages (plan 91 §Phase 2).
 *
 * One shared validation/rendering module for preview AND delivery, so the two
 * can never accept different shapes. Deliberately limited plain-text
 * interpolation — `{{ variable_name }}` only. No sections, partials, helpers,
 * triple braces, comments or evaluation: neither ad-hoc string replacement
 * (which cannot locate a bad token) nor JavaScript evaluation (which runs
 * caller text) is acceptable for prompts that become worker instructions.
 *
 * No template engine is vendored in `src/` or `src/client/` (checked: no
 * mustache/handlebars; server `ejs` evaluates JavaScript), so the small
 * single-pass parser below IS the engine's parser, paired with an allowlisted
 * token walk. It is pure — no filesystem, no database — so the isolated suite
 * covers it without a container.
 *
 * Brace-literal rule, decided once here: a lone `{` or `}` and a stray `}}`
 * are LITERAL text (a JSON `{"a": {}}` inside a prompt must survive), while an
 * UNCLOSED `{{` is malformed. Mustache agrees on the stray-`}}` half; the
 * failure mode of literal-`}}` is a visible typo, while rejecting it breaks
 * real JSON — a visible wart beats a broken literal.
 */

class PromptTemplateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

/** The five dispatch kinds. `resume` is a FULL template, never an invisible
 *  hardcoded suffix — what is sent for a current-task resume is exactly what
 *  the user edited. */
const TEMPLATE_KEYS = Object.freeze(['start', 'resume', 'continue', 'recovery', 'pause']);

/** Engine catalogue. `required: true` means dispatch with that variable absent
 *  or empty is an actionable error, never an `undefined` in a sent prompt;
 *  `required: false` documents the empty-string fallback (no current item, no
 *  blocker). Paths are worker-container paths from the existing project/path
 *  resolvers, never host paths. */
const VARIABLE_CATALOGUE = Object.freeze({
  runner_name: { description: 'The infinite runner name.', required: true },
  project_name: { description: 'The Mission project name.', required: true },
  project_path: { description: 'Worker-container path of the project folder.', required: true },
  plans_path: { description: 'Worker-container path of the plans folder.', required: true },
  queue_path: { description: 'Worker-container path of QUEUE.md.', required: true },
  index_path: { description: 'Worker-container path of INDEX.md (plan rules).', required: true },
  paused_path: { description: 'Worker-container path of QUEUE.paused.', required: true },
  current_plan: { description: 'Plan path of the in-progress item. Required wherever referenced: a pause/resume that names no plan is a degraded instruction.', required: true },
  current_item_status: { description: 'Status word of the current item, if any.', required: false },
  blocker_reason: { description: 'The need-input reason, if any.', required: false },
});

/** Byte budgets (UTF-8): per-source, per-rendered-prompt, whole-set. */
const TEMPLATE_LIMITS = Object.freeze({
  maxSourceBytes: 16 * 1024,
  maxRenderedBytes: 16 * 1024,
  maxSetBytes: 80 * 1024,
});

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** First character that marks a Mustache section/partial/comment/unescaped/
 *  delimiter tag — all unsupported here. Checked on the trimmed tag body. */
const UNSUPPORTED_LEAD_RE = /^[#^/>=!&{]/;

function lineCol(source, index) {
  const upTo = source.slice(0, index);
  const line = (upTo.match(/\n/g) || []).length + 1;
  const column = index - (upTo.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}

function err(code, message, source, index) {
  const { line, column } = lineCol(source, index);
  return new PromptTemplateError(code, `${message} (line ${line}, column ${column})`, { index, line, column });
}

/** Single-pass parse into `{ type: 'text', value }` / `{ type: 'var', name }`
 *  tokens. Throws PromptTemplateError on the first malformed token. */
function parseTemplate(source) {
  if (typeof source !== 'string') {
    throw new PromptTemplateError('prompt_not_string', 'A prompt template must be a string.');
  }
  const tokens = [];
  let i = 0;
  let text = '';
  const flush = () => {
    if (text) { tokens.push({ type: 'text', value: text }); text = ''; }
  };
  while (i < source.length) {
    const open = source.indexOf('{{', i);
    if (open === -1) { text += source.slice(i); break; }
    text += source.slice(i, open);
    const close = source.indexOf('}}', open + 2);
    if (close === -1) {
      throw err('prompt_unclosed_variable', 'Unclosed `{{`: no matching `}}`', source, open);
    }
    const body = source.slice(open + 2, close).trim();
    if (!body) {
      throw err('prompt_malformed_variable', 'Empty `{{}}` carries no variable name', source, open);
    }
    if (UNSUPPORTED_LEAD_RE.test(body)) {
      throw err('prompt_unsupported_syntax', `Unsupported tag \`{{${body}}}\`: sections, partials, comments, unescaped output and delimiter changes are not prompt syntax`, source, open);
    }
    if (!NAME_RE.test(body)) {
      throw err('prompt_malformed_variable', `Malformed variable \`{{${body}}}\`: use {{ variable_name }}`, source, open);
    }
    if (!Object.prototype.hasOwnProperty.call(VARIABLE_CATALOGUE, body)) {
      throw err('prompt_unknown_variable', `Unknown variable \`{{${body}}}\`: not in the engine catalogue`, source, open);
    }
    flush();
    tokens.push({ type: 'var', name: body, index: open });
    i = close + 2;
  }
  flush();
  return tokens;
}

/** Validate one template source. Returns `{ ok, errors }`; errors carry
 *  `code`, `message`, `index`, `line`, `column`. Empty/whitespace-only and
 *  over-budget sources fail here so Save can disable with a location. */
function validateTemplate(source) {
  if (typeof source !== 'string') {
    return { ok: false, errors: [new PromptTemplateError('prompt_not_string', 'A prompt template must be a string.')] };
  }
  if (!source.trim()) {
    return { ok: false, errors: [new PromptTemplateError('prompt_empty', 'A prompt template must not be empty or whitespace-only.')] };
  }
  if (bytes(source) > TEMPLATE_LIMITS.maxSourceBytes) {
    return { ok: false, errors: [new PromptTemplateError('prompt_source_too_large', `Template source is ${bytes(source)} bytes; the limit is ${TEMPLATE_LIMITS.maxSourceBytes}.`)] };
  }
  try {
    parseTemplate(source);
    return { ok: true, errors: [] };
  } catch (e) {
    if (e instanceof PromptTemplateError) return { ok: false, errors: [e] };
    throw e;
  }
}

/** Validate a COMPLETE template set: exactly the five keys, string values,
 *  each one valid, whole set within budget. Omitted-field preservation and
 *  reset semantics belong to the API layer; this answers only "is this set
 *  well-formed". */
function validateTemplateSet(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: [new PromptTemplateError('prompt_set_invalid', 'Prompt templates must be an object keyed by dispatch kind.')] };
  }
  for (const key of Object.keys(obj)) {
    if (!TEMPLATE_KEYS.includes(key)) {
      errors.push(new PromptTemplateError('prompt_unknown_key', `Unknown template key \`${key}\`: expected ${TEMPLATE_KEYS.join(', ')}.`));
    } else if (typeof obj[key] !== 'string') {
      errors.push(new PromptTemplateError('prompt_not_string', `Template \`${key}\` must be a string.`));
    }
  }
  for (const key of TEMPLATE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      errors.push(new PromptTemplateError('prompt_missing_key', `Missing template \`${key}\`: a set carries all five dispatch kinds.`));
    }
  }
  if (errors.length) return { ok: false, errors };
  for (const key of TEMPLATE_KEYS) {
    const v = validateTemplate(obj[key]);
    if (!v.ok) {
      for (const e of v.errors) {
        errors.push(new PromptTemplateError(e.code, `Template \`${key}\`: ${e.message}`, { key, index: e.index, line: e.line, column: e.column }));
      }
    }
  }
  if (bytes(JSON.stringify(obj)) > TEMPLATE_LIMITS.maxSetBytes) {
    errors.push(new PromptTemplateError('prompt_set_too_large', `Template set exceeds ${TEMPLATE_LIMITS.maxSetBytes} bytes.`));
  }
  return { ok: errors.length === 0, errors };
}

/** Render a template against `context`. Required catalogue variables absent or
 *  empty are an actionable error naming the variable — never `undefined` in a
 *  sent prompt. Substituted values are appended, never re-scanned, so a value
 *  containing `{{...}}` renders literally (no recursive interpolation). Output
 *  is plain text: `&`, quotes, `<` and spaces pass through unchanged. */
function renderTemplate(source, context = {}) {
  const tokens = parseTemplate(source);
  const out = [];
  for (const tok of tokens) {
    if (tok.type === 'text') { out.push(tok.value); continue; }
    const spec = VARIABLE_CATALOGUE[tok.name];
    const value = context ? context[tok.name] : undefined;
    if (value === undefined || value === null || (spec.required && String(value) === '')) {
      if (!spec.required) { out.push(''); continue; }
      throw new PromptTemplateError(
        'prompt_missing_context',
        `Cannot render: required variable \`{{${tok.name}}}\` (${spec.description}) has no value for this dispatch.`
      );
    }
    out.push(String(value));
  }
  const rendered = out.join('');
  if (bytes(rendered) > TEMPLATE_LIMITS.maxRenderedBytes) {
    throw new PromptTemplateError('prompt_render_too_large', `Rendered prompt is ${bytes(rendered)} bytes; the limit is ${TEMPLATE_LIMITS.maxRenderedBytes}.`);
  }
  return rendered;
}

/** Normalize rendered multiline source to ONE logical terminal submission:
 *  Mission delivery types line by line with an Enter each, so a multiline
 *  prompt would land as several separate user messages. Split on line breaks,
 *  drop blank lines, join the rest with single spaces; intra-line spacing is
 *  preserved. Preview shows this exact text (with a note when it changed). */
function normalizePromptForSend(rendered) {
  return String(rendered).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '').join(' ');
}

/** The five shipped defaults, transcribed from the sends they replace
 *  (mission.js start/continue/recovery/pause). `resume` is the COMPLETE
 *  resume message — the old hardcoded suffix is gone as a concept. */
const DEFAULT_TEMPLATES = Object.freeze({
  start: '[Infinite runner {{runner_name}}] Read {{queue_path}} and {{index_path}} completely before acting. '
    + 'Work exactly ONE item per turn, then stop and end your turn — the supervisor sends the next instruction; do not continue to a second item yourself. '
    + 'Before starting ANY item, check that a file named `QUEUE.paused` does not exist here; if it does, do not start another item — stop and wait. '
    + 'Resume the "in progress" item first, otherwise take the first "new" item and use paddock_runner_agent_queue_update_item to set in_progress BEFORE doing work. Read with paddock_runner_agent_queue_read. Do not edit QUEUE.md. '
    + 'If ANY item is "need input", stop immediately and explain its reason. When blocked, set the item to "need input" with the exact question in reason, then STOP. '
    + 'Mark "done" only when work AND verification are complete. When all done, report completion and wait. Do not invent work.',
  resume: '[Infinite runner {{runner_name}}] Read {{queue_path}} and {{index_path}} completely before acting. '
    + 'Work exactly ONE item per turn, then stop and end your turn — the supervisor sends the next instruction; do not continue to a second item yourself. '
    + 'Before starting ANY item, check that a file named `QUEUE.paused` does not exist here; if it does, do not start another item — stop and wait. '
    + 'Resume the "in progress" item first, otherwise take the first "new" item and use paddock_runner_agent_queue_update_item to set in_progress BEFORE doing work. Read with paddock_runner_agent_queue_read. Do not edit QUEUE.md. '
    + 'If ANY item is "need input", stop immediately and explain its reason. When blocked, set the item to "need input" with the exact question in reason, then STOP. '
    + 'Mark "done" only when work AND verification are complete. When all done, report completion and wait. Do not invent work. '
    + 'The previous turn was PAUSED mid-task: read the saved progress and resume instructions in the "in progress" plan file, then CONTINUE that same plan from its checkpoint without repeating completed steps.',
  continue: '[Infinite runner {{runner_name}}] Continue: work exactly ONE queued item, then stop your turn. '
    + `Read the server queue with paddock_runner_agent_queue_read (and {{index_path}} for plan rules) first: resume the in_progress item, otherwise take the first new item and use paddock_runner_agent_queue_update_item to set in_progress BEFORE doing work. {{queue_path}} is read-only generated output. `
    + 'Check that {{paused_path}} does not exist before starting — if it does, stop and wait. '
    + `Mark 'done' only when work AND verification are complete, end your turn; do not take a second item. `
    + `If blocked, set the item to 'need input' with the exact question in reason and stop.`,
  recovery: '[Infinite runner {{runner_name}}] This pane resumes the same conversation. Read the server queue with paddock_runner_agent_queue_read; resume the in-progress item, otherwise take the next new item and use paddock_runner_agent_queue_update_item to set in_progress before starting. Read {{index_path}} for plan rules. Check {{paused_path}} before starting. Work exactly one item, verify it, update the queue and end your turn. If blocked, mark need input with the exact reason and stop.',
  pause: '[Infinite runner {{runner_name}}] PAUSE CURRENT TASK. Stop development on the current plan ({{current_plan}}) at the earliest safe checkpoint. Do not start another plan. '
    + 'Before stopping, save current progress, remaining work and explicit resume instructions into that plan file, and keep its server queue item in_progress (do not mark it done or requeue it). Never edit {{queue_path}}. Then stop and wait.',
});

module.exports = {
  PromptTemplateError,
  TEMPLATE_KEYS,
  VARIABLE_CATALOGUE,
  TEMPLATE_LIMITS,
  DEFAULT_TEMPLATES,
  parseTemplate,
  validateTemplate,
  validateTemplateSet,
  renderTemplate,
  normalizePromptForSend,
};
