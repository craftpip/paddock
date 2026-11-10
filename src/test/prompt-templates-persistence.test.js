const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Plan 91 §Phase 2b: prompt-template persistence — migration, create/update
// plumbing, effective-set reads, corruption feedback and read-only preview.
// Same isolated harness shape as infinite-runner.test.js: throwaway
// WORKSPACE_ROOT + PAD_DB_PATH set before anything reads them, one fake pad,
// sessions inserted directly so no container is touched.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-prompts-'));
process.env.WORKSPACE_ROOT = WS;
process.env.PAD_DB_PATH = path.join(WS, 'prompts.test.db');

const PAD = 'pad-prompts';
fs.mkdirSync(path.join(WS, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(WS, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb, close } = require('../services/db');
const mission = require('../services/mission');
const promptEngine = require('../services/prompt-templates');

after(() => fs.rmSync(WS, { recursive: true, force: true }));

function seedPad() {
  getDb().prepare(
    `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
     VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'u1')`
  ).run(PAD, PAD, PAD);
}

const FOLDER = '/root/.opencode/workspace';
function makeProject(name = 'proj') {
  return mission.createProject({ name, agent: PAD, folder: FOLDER, plansFolder: 'plans' });
}

function insertSession(projectId) {
  const id = 'msn_' + Math.random().toString(16).slice(2, 12);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, locked, agent_session_id, created_at, last_seen_at)
     VALUES (?, ?, ?, 'test', 'agent', 0, ?, ?, ?)`
  ).run(id, projectId, 'tmux-' + id, 'ses_' + id, now, now);
  return id;
}

async function makeRunner(projectId, extra = {}) {
  const sid = insertSession(projectId);
  return mission.createRunner({ projectId, name: 'r', sessionId: sid, ...extra });
}

const VALID_SET = {
  start: 'Begin {{runner_name}} via {{queue_path}}.',
  resume: 'Resume {{runner_name}} via {{queue_path}} and {{index_path}}.',
  continue: 'Continue {{runner_name}}; marker {{paused_path}}.',
  recovery: 'Recover {{runner_name}}: {{queue_path}} {{index_path}} {{paused_path}}.',
  pause: 'Pause {{runner_name}} on {{current_plan}} in {{queue_path}}.',
};

beforeEach(() => {
  seedPad();
  const db = getDb();
  db.prepare('DELETE FROM infinite_runners').run();
  db.prepare('DELETE FROM mission_sessions').run();
  db.prepare('DELETE FROM mission_projects').run();
});

describe('plan 91 — prompt template migration and defaults', () => {
  it('the column exists and old rows read as shipped defaults, never rewritten', async () => {
    const cols = getDb().prepare('PRAGMA table_info(infinite_runners)').all().map((c) => c.name);
    assert.ok(cols.includes('prompt_templates_json'), 'migration added the column');
    const p = makeProject();
    const r = await makeRunner(p.id);
    assert.equal(r.prompt_templates_json, null, 'omitted input stores NULL, not a default copy');
    const eff = mission.effectivePromptTemplates(mission.getRunner(r.id));
    assert.equal(eff.custom, false);
    assert.equal(eff.error, null);
    assert.deepEqual(eff.templates, promptEngine.DEFAULT_TEMPLATES);
    assert.match(eff.version, /^[0-9a-f]{64}$/);
  });

  it('reopening the database re-runs the migration without touching stored values', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id, { promptTemplates: VALID_SET });
    close();
    getDb();
    const reopened = mission.getRunner(r.id);
    assert.equal(reopened.prompt_templates_json, JSON.stringify(VALID_SET), 'custom JSON survives a second migration');
    const cols = getDb().prepare('PRAGMA table_info(infinite_runners)').all().map((c) => c.name);
    assert.equal(cols.filter((c) => c === 'prompt_templates_json').length, 1, 'no duplicate column');
  });
});

describe('plan 91 — create/update plumbing', () => {
  it('create with a valid set stores it and reports custom', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id, { promptTemplates: VALID_SET });
    assert.equal(r.prompt_templates_json, JSON.stringify(VALID_SET));
    assert.deepEqual(r.promptTemplates, VALID_SET);
    assert.equal(r.promptTemplatesCustom, true);
    assert.equal(r.promptTemplatesError, null);
    assert.match(r.promptTemplateVersion, /^[0-9a-f]{64}$/);
    // Reopen reads the same set back.
    const again = mission.withPromptTemplates(mission.getRunner(r.id));
    assert.deepEqual(again.promptTemplates, VALID_SET);
  });

  it('create with an invalid set rejects before any row or session exists', async () => {
    const p = makeProject();
    const bad = { ...VALID_SET, continue: 'go {{nope}}' };
    await assert.rejects(
      mission.createRunner({ projectId: p.id, name: 'bad', sessionId: insertSession(p.id), promptTemplates: bad }),
      (e) => e.code === 'prompt_unknown_variable'
    );
    assert.equal(mission.listRunnersForProject(p.id).length, 0, 'no runner row left behind');
  });

  it('update with omitted promptTemplates preserves the stored set', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id, { promptTemplates: VALID_SET });
    const after = await mission.updateRunner(r.id, { name: 'renamed' });
    assert.equal(after.name, 'renamed');
    assert.deepEqual(after.promptTemplates, VALID_SET);
    assert.equal(after.promptTemplatesCustom, true);
  });

  it('update replaces the whole set after validation, and rejects field-specifically', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id, { promptTemplates: VALID_SET });
    const next = { ...VALID_SET, pause: 'Hold {{runner_name}}.' };
    const after = await mission.updateRunner(r.id, { promptTemplates: next });
    assert.deepEqual(after.promptTemplates, next);
    // Unknown key.
    await assert.rejects(
      mission.updateRunner(r.id, { promptTemplates: { ...next, bogus: 'x' } }),
      (e) => e.code === 'prompt_unknown_key'
    );
    // Missing key.
    const { start, ...missing } = next;
    await assert.rejects(
      mission.updateRunner(r.id, { promptTemplates: missing }),
      (e) => e.code === 'prompt_missing_key'
    );
    // Non-string value.
    await assert.rejects(
      mission.updateRunner(r.id, { promptTemplates: { ...next, pause: 42 } }),
      (e) => e.code === 'prompt_not_string'
    );
    // The rejected writes left the stored set untouched.
    assert.deepEqual(mission.withPromptTemplates(mission.getRunner(r.id)).promptTemplates, next);
  });

  it('explicit null resets the whole saved set to defaults', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id, { promptTemplates: VALID_SET });
    const after = await mission.updateRunner(r.id, { promptTemplates: null });
    assert.equal(mission.getRunner(r.id).prompt_templates_json, null);
    assert.equal(after.promptTemplatesCustom, false);
    assert.deepEqual(after.promptTemplates, promptEngine.DEFAULT_TEMPLATES);
  });

  it('saving settings never dispatches: identity, enablement and operation columns are untouched', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id, { promptTemplates: VALID_SET });
    // Plan 113 made `runner_runtime` + `runner_operations` the authority and
    // `getRunner` PROJECTS enabled/control_state/operation_* from them, so a
    // "running" fixture has to be seeded there — legacy columns alone read back
    // as paused, which made this test fail on a correct build.
    const now = new Date().toISOString();
    getDb().prepare("INSERT OR REPLACE INTO runner_runtime (runner_id, state, generation, operation_id, updated_at) VALUES (?, 'running', 1, 'op-1', ?)").run(r.id, now);
    getDb().prepare("INSERT OR REPLACE INTO runner_operations (id, runner_id, generation, status, created_at, updated_at) VALUES ('op-1', ?, 1, 'running', ?, ?)").run(r.id, now, now);
    const before = mission.getRunner(r.id);
    assert.equal(Number(before.enabled), 1, 'fixture: runner is running before the save');
    const runtimeBefore = getDb().prepare('SELECT * FROM runner_runtime WHERE runner_id = ?').get(r.id);
    const after = await mission.updateRunner(r.id, { name: 'saved-while-running', promptTemplates: { ...VALID_SET, pause: 'Hold {{runner_name}}.' } });
    assert.deepEqual(getDb().prepare('SELECT * FROM runner_runtime WHERE runner_id = ?').get(r.id), runtimeBefore, 'canonical runtime untouched');
    assert.equal(getDb().prepare("SELECT COUNT(*) AS n FROM runner_operations WHERE runner_id = ?").get(r.id).n, 1, 'no new operation minted');
    assert.equal(after.session_id, before.session_id, 'worker binding kept');
    assert.equal(Number(after.enabled), 1, 'still enabled');
    assert.equal(after.control_state, 'enabled', 'no state regression');
    assert.equal(after.operation_id, 'op-1', 'no new operation minted');
    assert.equal(after.operation_status, 'confirmed', 'outstanding instruction untouched');
    assert.deepEqual(after.promptTemplates.pause, 'Hold {{runner_name}}.');
  });
});

describe('plan 91 — corrupt stored templates are explicit failures, never silent defaults', () => {
  it('unparseable JSON surfaces prompt_templates_corrupt with no templates', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    getDb().prepare('UPDATE infinite_runners SET prompt_templates_json = ? WHERE id = ?').run('{nope', r.id);
    const eff = mission.effectivePromptTemplates(mission.getRunner(r.id));
    assert.equal(eff.templates, null, 'must not fall back to defaults silently');
    assert.equal(eff.error.code, 'prompt_templates_corrupt');
    const enriched = mission.withPromptTemplates(mission.getRunner(r.id));
    assert.equal(enriched.promptTemplates, null);
    assert.equal(enriched.promptTemplatesError.code, 'prompt_templates_corrupt');
  });

  it('parseable-but-invalid JSON surfaces the validation failure', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    getDb().prepare('UPDATE infinite_runners SET prompt_templates_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...VALID_SET, start: 'x {{bogus}}' }), r.id);
    const eff = mission.effectivePromptTemplates(mission.getRunner(r.id));
    assert.equal(eff.templates, null);
    assert.equal(eff.error.code, 'prompt_unknown_variable');
  });
});

describe('plan 91 — read-only prompt configuration and preview', () => {
  it('runnerPromptConfig exposes catalogue, defaults and the effective set without side effects', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id, { promptTemplates: VALID_SET });
    const cfg = mission.runnerPromptConfig(r.id);
    assert.deepEqual(cfg.keys, [...promptEngine.TEMPLATE_KEYS]);
    assert.deepEqual(cfg.catalogue, promptEngine.VARIABLE_CATALOGUE);
    assert.deepEqual(cfg.defaults, promptEngine.DEFAULT_TEMPLATES);
    assert.deepEqual(cfg.effective, VALID_SET);
    assert.equal(cfg.custom, true);
    assert.equal(cfg.error, null);
    // No session created, no queue touched, still paused.
    assert.equal(mission.getRunner(r.id).control_state, 'paused');
    assert.equal(Number(mission.getRunner(r.id).enabled), 0);
  });

  it('preview renders partial drafts against a context and persists nothing', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const res = await mission.previewRunnerPrompts(r.id, { continue: 'Go {{runner_name}} via {{queue_path}}.' }, { runner_name: 'w', queue_path: '/q' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.rendered, { continue: 'Go w via /q.' });
    assert.equal(mission.getRunner(r.id).prompt_templates_json, null, 'preview persists nothing');
  });

  it('preview reports unknown keys, bad variables and missing context without persisting', async () => {
    const p = makeProject();
    const r = await makeRunner(p.id);
    const res = await mission.previewRunnerPrompts(r.id, {
      continue: 'Go {{nope}}.',
      bogus: 'x',
      pause: 'Hold {{runner_name}} on {{current_plan}}.',
    }, { runner_name: 'w' });
    assert.equal(res.ok, false);
    const byKey = Object.fromEntries(res.errors.map((e) => [e.key, e]));
    assert.equal(byKey.continue.code, 'prompt_unknown_variable');
    assert.ok(typeof byKey.continue.line === 'number', 'error carries a location');
    assert.equal(byKey.bogus.code, 'prompt_unknown_key');
    assert.equal(byKey.pause.code, 'prompt_missing_context');
    assert.ok(!('pause' in res.rendered), 'failed drafts render nothing');
    assert.equal(mission.getRunner(r.id).prompt_templates_json, null);
  });

  it('preview on a missing runner reports runner_not_found', async () => {
    await assert.rejects(
      mission.previewRunnerPrompts('run_nope', { continue: 'x' }),
      (e) => e.code === 'runner_not_found'
    );
  });
});
