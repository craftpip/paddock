const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Plan 91 §Phase 2: the shared prompt-template engine is pure (no filesystem,
// no database), so this suite needs no container, no throwaway DB and no seam
// stubbing — requiring the module is the whole fixture.
const templates = require('../services/prompt-templates');
const {
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
} = templates;

const SAMPLE = {
  runner_name: 'demo',
  project_name: 'proj',
  project_path: '/www1/my proj',
  plans_path: '/www1/my proj/plans',
  queue_path: '/www1/my proj/plans/QUEUE.md',
  index_path: '/www1/my proj/plans/INDEX.md',
  paused_path: '/www1/my proj/plans/QUEUE.paused',
  current_plan: '12-thing.md',
  current_item_status: 'in progress',
  blocker_reason: 'which color?',
};

describe('plan 91 — template interpolation contract', () => {
  it('renders repeated and arbitrarily spaced variables', () => {
    assert.equal(renderTemplate('{{runner_name}}:{{runner_name}}:{{ runner_name }}:{{  runner_name\t}}', SAMPLE), 'demo:demo:demo:demo');
  });

  it('passes Unicode, quotes, ampersands and path spaces through unchanged (plain text, never HTML)', () => {
    assert.equal(renderTemplate('Go {{project_path}} & "tell" <me> — αβ', SAMPLE), 'Go /www1/my proj & "tell" <me> — αβ');
  });

  it('leaves lone braces and JSON-shaped literals alone', () => {
    assert.equal(renderTemplate('{"a": {}} and {x} and } stray', SAMPLE), '{"a": {}} and {x} and } stray');
  });

  it('never re-scans substituted values (no recursive interpolation)', () => {
    const ctx = { ...SAMPLE, runner_name: '{{queue_path}}' };
    assert.equal(renderTemplate('[{{runner_name}}]', ctx), '[{{queue_path}}]');
  });

  it('renders optional variables as empty strings when absent', () => {
    const ctx = { ...SAMPLE };
    delete ctx.current_item_status;
    delete ctx.blocker_reason;
    assert.equal(renderTemplate('status=[{{current_item_status}}] blocker=[{{blocker_reason}}]', ctx), 'status=[] blocker=[]');
  });
});

describe('plan 91 — validation failures are useful and located', () => {
  it('rejects unknown variables by name with a line/column', () => {
    const v = validateTemplate('Read {{queue_path}} and {{indx_path}}');
    assert.equal(v.ok, false);
    assert.equal(v.errors.length, 1);
    assert.match(v.errors[0].message, /indx_path/);
    assert.equal(v.errors[0].code, 'prompt_unknown_variable');
    assert.equal(typeof v.errors[0].line, 'number');
    assert.equal(typeof v.errors[0].column, 'number');
  });

  it('rejects an unclosed opener', () => {
    const v = validateTemplate('Read {{queue_path');
    assert.equal(v.ok, false);
    assert.equal(v.errors[0].code, 'prompt_unclosed_variable');
  });

  it('rejects empty and malformed tag bodies', () => {
    for (const src of ['{{}}', '{{ }}', '{{foo bar}}', '{{123}}', '{{runner-name}}']) {
      const v = validateTemplate(`x ${src} y`);
      assert.equal(v.ok, false, `${src} must fail`);
      assert.equal(v.errors[0].code, 'prompt_malformed_variable');
    }
  });

  it('rejects sections, closers, partials, comments, unescaped and triple braces', () => {
    for (const src of ['{{#x}}', '{{/x}}', '{{^x}}', '{{>p}}', '{{!note}}', '{{&x}}', '{{{x}}}', '{{=<% %>=}}']) {
      const v = validateTemplate(`x ${src} y`);
      assert.equal(v.ok, false, `${src} must fail`);
      assert.equal(v.errors[0].code, 'prompt_unsupported_syntax');
    }
  });

  it('rejects empty and whitespace-only templates', () => {
    for (const src of ['', '   ', '\n\t ']) {
      const v = validateTemplate(src);
      assert.equal(v.ok, false);
      assert.equal(v.errors[0].code, 'prompt_empty');
    }
  });

  it('missing REQUIRED context is an actionable render error naming the variable', () => {
    const ctx = { ...SAMPLE };
    delete ctx.queue_path;
    assert.throws(
      () => renderTemplate('Read {{queue_path}}', ctx),
      (e) => e instanceof PromptTemplateError && e.code === 'prompt_missing_context' && /queue_path/.test(e.message)
    );
  });

  it('an empty-string required value is also missing (never a silent hole)', () => {
    assert.throws(
      () => renderTemplate('Read {{queue_path}}', { ...SAMPLE, queue_path: '' }),
      (e) => e.code === 'prompt_missing_context'
    );
  });
});

describe('plan 91 — byte budgets', () => {
  it('rejects a source over 16KiB', () => {
    const v = validateTemplate(`ok {{runner_name}} ${'x'.repeat(TEMPLATE_LIMITS.maxSourceBytes)}`);
    assert.equal(v.ok, false);
    assert.equal(v.errors[0].code, 'prompt_source_too_large');
  });

  it('rejects a render over 16KiB even from a small source', () => {
    assert.throws(
      () => renderTemplate('{{runner_name}}', { runner_name: 'y'.repeat(TEMPLATE_LIMITS.maxRenderedBytes + 1) }),
      (e) => e.code === 'prompt_render_too_large'
    );
  });

  it('rejects a set over 80KiB', () => {
    const big = {};
    for (const k of TEMPLATE_KEYS) big[k] = `template {{runner_name}} ${'z'.repeat(17 * 1024)}`;
    const v = validateTemplateSet(big);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.code === 'prompt_set_too_large' || e.code === 'prompt_source_too_large'));
  });
});

describe('plan 91 — one logical submission', () => {
  it('folds multiline source to one line, preserving intra-line spacing', () => {
    assert.equal(
      normalizePromptForSend('First line  with  spaces\n\n  Second line\n\tThird  \n'),
      'First line  with  spaces Second line Third'
    );
  });

  it('leaves single-line text untouched', () => {
    assert.equal(normalizePromptForSend('Just one line.'), 'Just one line.');
  });
});

describe('plan 91 — template sets', () => {
  const goodSet = () => Object.fromEntries(TEMPLATE_KEYS.map((k) => [k, `Template {{runner_name}} ${k}`]));

  it('accepts a complete five-key set', () => {
    const v = validateTemplateSet(goodSet());
    assert.equal(v.ok, true);
    assert.deepEqual(v.errors, []);
  });

  it('rejects unknown keys, missing keys and non-string values with field-specific codes', () => {
    const extra = { ...goodSet(), bogus: 'x' };
    assert.equal(validateTemplateSet(extra).errors[0].code, 'prompt_unknown_key');
    const { start, ...missing } = goodSet();
    assert.equal(validateTemplateSet(missing).errors[0].code, 'prompt_missing_key');
    const nonString = { ...goodSet(), pause: 42 };
    assert.equal(validateTemplateSet(nonString).errors[0].code, 'prompt_not_string');
  });

  it('prefixes per-template errors with the affected key', () => {
    const bad = { ...goodSet(), continue: 'go {{nope}}' };
    const v = validateTemplateSet(bad);
    assert.equal(v.ok, false);
    assert.match(v.errors[0].message, /`continue`/);
    assert.equal(v.errors[0].code, 'prompt_unknown_variable');
  });
});

describe('plan 91 — shipped defaults', () => {
  it('covers exactly the five dispatch kinds and validates clean', () => {
    assert.deepEqual([...Object.keys(DEFAULT_TEMPLATES)].sort(), [...TEMPLATE_KEYS].sort());
    const v = validateTemplateSet({ ...DEFAULT_TEMPLATES });
    assert.equal(v.ok, true, JSON.stringify(v.errors.map((e) => e.message)));
  });

  it('each default renders fully with sample context — no tag survives', () => {
    for (const key of TEMPLATE_KEYS) {
      const rendered = renderTemplate(DEFAULT_TEMPLATES[key], SAMPLE);
      assert.ok(!rendered.includes('{{'), `${key} left a tag behind`);
      assert.ok(!rendered.includes('undefined'), `${key} leaked undefined`);
      assert.ok(rendered.length > 50, `${key} rendered suspiciously short`);
    }
  });

  it('defaults preserve the current behavioral rules', () => {
    assert.match(renderTemplate(DEFAULT_TEMPLATES.start, SAMPLE), /exactly ONE item per turn/);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.resume, SAMPLE), /PAUSED mid-task/);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.resume, SAMPLE), /exactly ONE item per turn/);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.continue, SAMPLE), /QUEUE\.paused.*does not exist/);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.recovery, SAMPLE), /resumes the same conversation/);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.pause, SAMPLE), /12-thing\.md/);
    // Preserve the checkpoint, now using the server API's canonical enum.
    assert.match(renderTemplate(DEFAULT_TEMPLATES.pause, SAMPLE), /keep its server queue item in_progress/);
    assert.match(renderTemplate(DEFAULT_TEMPLATES.pause, SAMPLE), /Never edit .*QUEUE\.md/);
  });

  it('names queue tools with the Paddock MCP namespace exposed to OpenCode', () => {
    for (const key of ['start', 'resume', 'continue', 'recovery']) {
      assert.match(DEFAULT_TEMPLATES[key], /paddock_runner_agent_queue_read/);
      assert.match(DEFAULT_TEMPLATES[key], /paddock_runner_agent_queue_update_item/);
    }
  });

  it('the catalogue documents every variable the defaults use', () => {
    const used = new Set();
    for (const key of TEMPLATE_KEYS) {
      for (const t of parseTemplate(DEFAULT_TEMPLATES[key])) {
        if (t.type === 'var') used.add(t.name);
      }
    }
    for (const name of used) {
      assert.ok(VARIABLE_CATALOGUE[name], `${name} used by a default but not catalogued`);
      assert.ok(VARIABLE_CATALOGUE[name].description, `${name} has no description`);
    }
  });
});
