const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-queue-file-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'runner-queue-file.db');

const PAD = 'pad-runner-queue-file';
const FOLDER = '/root/.opencode/workspace';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const plans = require('../services/plans');
const registry = require('../services/agent-registry');

after(() => fs.rmSync(root, { recursive: true, force: true }));

function project() {
  return mission.createProject({ name: 'queue files', agent: PAD, folder: FOLDER, plansFolder: 'plans' });
}

function session(projectId) {
  return mission.createSession(projectId, { agentSessionId: `ses_${Math.random().toString(16).slice(2)}` });
}

async function runner(projectId, queueFile) {
  return mission.createRunner({ projectId, name: 'queue runner', sessionId: session(projectId).id, queueFile });
}

function items() {
  return [{ id: 'one', plan: 'one.md', status: 'new', reason: '' }];
}

beforeEach(() => {
  getDb().exec('DELETE FROM infinite_runners; DELETE FROM mission_sessions; DELETE FROM mission_projects;');
  getDb().prepare("INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')")
    .run(PAD, PAD, PAD);
  fs.rmSync(path.join(root, 'instances', PAD, 'opencode', 'workspace'), { recursive: true, force: true });
});

describe('plan 102 — configurable runner queue file', () => {
  it('defaults legacy and blank values to QUEUE.md, and persists a normalized nested filename', async () => {
    const p = project();
    const legacy = await runner(p.id);
    const blank = await runner(p.id, '   ');
    const custom = await runner(p.id, ' queues/release.md ');

    assert.equal(legacy.queue_file, 'QUEUE.md');
    assert.equal(blank.queue_file, 'QUEUE.md');
    assert.equal(custom.queue_file, 'queues/release.md');
    assert.equal(mission.getRunner(custom.id).queue_file, 'queues/release.md');
  });

  it('sets up, reads, and updates only the selected file', async () => {
    const p = project();
    const r = await runner(p.id, 'queues/release.md');
    const agent = registry.getAgent(PAD);
    const defaultPath = plans.queuePath(agent, p);
    const selectedPath = plans.queuePath(agent, p, 'queues/release.md');

    fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
    fs.writeFileSync(defaultPath, 'keep this queue untouched');
    await mission.setupRunnerQueue(r.id);
    const before = await mission.readRunnerQueue(r.id);
    assert.equal(before.queue.path, selectedPath);
    assert.equal(before.queue.workerPath, `${FOLDER}/plans/queues/release.md`);
    assert.equal(fs.readFileSync(defaultPath, 'utf8'), 'keep this queue untouched');

    await mission.updateRunnerQueue(r.id, items(), before.queue.revision);
    assert.equal((await mission.readRunnerQueue(r.id)).queue.items[0].id, 'one');
    assert.equal(fs.readFileSync(defaultPath, 'utf8'), 'keep this queue untouched');
  });

  it('shares revision protection when two runners select the same queue', async () => {
    const p = project();
    const first = await runner(p.id, 'shared.md');
    const second = await runner(p.id, 'shared.md');
    await mission.setupRunnerQueue(first.id);
    const initial = await mission.readRunnerQueue(first.id);

    await mission.updateRunnerQueue(second.id, items(), initial.queue.revision);
    await assert.rejects(
      mission.updateRunnerQueue(first.id, [{ id: 'two', plan: 'two.md', status: 'new', reason: '' }], initial.queue.revision),
      (e) => e.code === 'queue_revision_conflict'
    );
  });

  it('rejects absolute, traversal, non-Markdown, and symlink-escape queue paths', async () => {
    const p = project();
    const base = path.dirname(plans.queuePath(registry.getAgent(PAD), p));
    fs.mkdirSync(base, { recursive: true });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-queue-outside-'));
    fs.symlinkSync(outside, path.join(base, 'escape'));
    try {
      for (const queueFile of ['/tmp/queue.md', '../queue.md', 'queue.txt', 'escape/queue.md']) {
        await assert.rejects(
          runner(p.id, queueFile),
          (e) => e.code === 'runner_queue_file_invalid',
          queueFile
        );
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses switching files while supervision or an instruction is active, without changing the saved path', async () => {
    const p = project();
    const r = await runner(p.id);
    getDb().prepare("UPDATE infinite_runners SET enabled = 1, operation_status = 'pending' WHERE id = ?").run(r.id);

    await assert.rejects(
      mission.updateRunner(r.id, { queueFile: 'other.md' }),
      (e) => e.code === 'runner_queue_file_busy'
    );
    assert.equal(mission.getRunner(r.id).queue_file, 'QUEUE.md');
  });

  it('switches a paused idle runner without moving the old queue', async () => {
    const p = project();
    const r = await runner(p.id);
    const agent = registry.getAgent(PAD);
    await mission.setupRunnerQueue(r.id);
    const oldPath = plans.queuePath(agent, p);
    const oldText = fs.readFileSync(oldPath, 'utf8');

    const updated = await mission.updateRunner(r.id, { queueFile: 'release.md' });
    assert.equal(updated.queue_file, 'release.md');
    const detail = await mission.readRunnerQueue(r.id);
    assert.equal(detail.queue.condition, 'missing');
    assert.equal(detail.queue.path, plans.queuePath(agent, p, 'release.md'));
    assert.equal(fs.readFileSync(oldPath, 'utf8'), oldText);
  });

  it('reports malformed content from the selected file without falling back to QUEUE.md', async () => {
    const p = project();
    const r = await runner(p.id, 'broken.md');
    const selected = plans.queuePath(registry.getAgent(PAD), p, 'broken.md');
    fs.mkdirSync(path.dirname(selected), { recursive: true });
    fs.writeFileSync(selected, 'not a queue');

    const detail = await mission.readRunnerQueue(r.id);
    assert.equal(detail.queue.condition, 'malformed');
    assert.equal(detail.queue.path, selected);
  });

  it('stores custom instructions in only the selected queue and preserves them across item writes', async () => {
    const p = project();
    const r = await runner(p.id, 'release.md');
    const custom = 'Follow the release checklist.\n```md\n{{literal}}\n```';
    const created = await mission.updateRunnerQueueCustomInstructions(r.id, custom, null);
    assert.equal(created.queue.customInstructions, custom);
    assert.equal(created.queue.items.length, 0);

    const updated = await mission.updateRunnerQueue(r.id, items(), created.queue.revision);
    assert.equal(updated.queue.customInstructions, custom);

    const cleared = await mission.updateRunnerQueueCustomInstructions(r.id, '', updated.queue.revision);
    assert.equal(cleared.queue.customInstructions, '');
    assert.deepEqual(cleared.queue.items.map((item) => item.id), ['one']);
  });

  it('refuses a stale custom-instructions draft without replacing newer queue work', async () => {
    const p = project();
    const r = await runner(p.id);
    await mission.setupRunnerQueue(r.id);
    const initial = await mission.readRunnerQueue(r.id);
    await mission.updateRunnerQueue(r.id, items(), initial.queue.revision);
    await assert.rejects(
      mission.updateRunnerQueueCustomInstructions(r.id, 'stale guidance', initial.queue.revision),
      (e) => e.code === 'queue_revision_conflict'
    );
    assert.equal((await mission.readRunnerQueue(r.id)).queue.customInstructions, '');
  });

  it('adds saved guidance literally once to subsequent worker instructions', async () => {
    const p = project();
    const r = await runner(p.id);
    const queue = await mission.updateRunnerQueueCustomInstructions(r.id, 'Use {{literal}} text.\n```json\n{"x": 1}\n```', null);
    const rendered = mission.renderRunnerPrompt(
      r,
      p,
      { parsed: { customInstructions: queue.queue.customInstructions }, summary: queue.queue.summary },
      'continue'
    ).text;
    assert.match(rendered, /=== QUEUE CUSTOM INSTRUCTIONS ===/);
    assert.match(rendered, /Use \{\{literal\}\} text\./);
    assert.equal(rendered.split('=== QUEUE CUSTOM INSTRUCTIONS ===').length - 1, 1);
    const without = mission.renderRunnerPrompt(r, p, { parsed: { customInstructions: '' }, summary: queue.queue.summary }, 'continue').text;
    assert.ok(!without.includes('=== QUEUE CUSTOM INSTRUCTIONS ==='));
  });
});
