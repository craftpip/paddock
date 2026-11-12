// The Mission file viewer's plan file: read raw with a content revision, save
// only against that revision, and never leave the project's plans folder.
const { it, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-planfile-'));
process.env.WORKSPACE_ROOT = WS;
process.env.PAD_DB_PATH = path.join(WS, 'planfile.test.db');
process.env.RUNNER_CALLBACKS_DIR = path.join(WS, 'callbacks');

const PAD = 'pad-planfile';
fs.mkdirSync(path.join(WS, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(WS, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');
mission._setFastWatch({ enabled: false });

after(() => fs.rmSync(WS, { recursive: true, force: true }));

const FOLDER = '/root/.opencode/workspace';
const PLANS = path.join(WS, 'instances', PAD, 'opencode', 'workspace', 'plans');
let runner;

before(async () => {
  getDb().prepare(
    `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
     VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'u1')`
  ).run(PAD, PAD, PAD);
  const project = mission.createProject({ name: 'pf', agent: PAD, folder: FOLDER, plansFolder: 'plans' });
  const sid = 'msn_' + Math.random().toString(16).slice(2, 12);
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, locked, agent_session_id, created_at, last_seen_at)
     VALUES (?, ?, ?, 'w', 'agent', 0, 'ses_pf', ?, ?)`
  ).run(sid, project.id, 'tmux-' + sid, now, now);
  runner = await mission.createRunner({ projectId: project.id, name: 'pf', sessionId: sid, queueFile: 'QUEUE.md' });
  fs.mkdirSync(PLANS, { recursive: true });
  fs.writeFileSync(path.join(PLANS, 'hello.md'), '---\ncreated: x\n---\n# Hello\n\n## Status: Proposed\n');
});

it('reads the raw file, frontmatter included, with a revision', () => {
  const f = mission.readRunnerPlanFile(runner.id, 'hello.md');
  assert.equal(f.name, 'hello.md');
  assert.match(f.content, /^---\ncreated: x/);
  assert.match(f.revision, /^[0-9a-f]{64}$/);
});

it('saves against the revision it read, and the next save needs the new one', () => {
  const f = mission.readRunnerPlanFile(runner.id, 'hello.md');
  const saved = mission.writeRunnerPlanFile(runner.id, 'hello.md', f.content + '\n- [ ] edited by a human\n', f.revision);
  assert.equal(fs.readFileSync(path.join(PLANS, 'hello.md'), 'utf8').endsWith('- [ ] edited by a human\n'), true);
  assert.notEqual(saved.revision, f.revision);
  assert.throws(() => mission.writeRunnerPlanFile(runner.id, 'hello.md', 'stale', f.revision), (e) => e.code === 'plan_revision_conflict');
});

it('refuses to overwrite an edit the agent made after the file was opened', () => {
  const f = mission.readRunnerPlanFile(runner.id, 'hello.md');
  fs.appendFileSync(path.join(PLANS, 'hello.md'), '- [x] ticked by the agent\n');
  assert.throws(() => mission.writeRunnerPlanFile(runner.id, 'hello.md', 'human text', f.revision), (e) => e.code === 'plan_revision_conflict');
  assert.match(fs.readFileSync(path.join(PLANS, 'hello.md'), 'utf8'), /ticked by the agent/, 'the agent edit survives');
});

it('never leaves the plans folder, never writes a reserved file, never creates one', () => {
  fs.writeFileSync(path.join(WS, 'instances', PAD, 'opencode', 'workspace', 'secret.md'), 'x');
  assert.throws(() => mission.readRunnerPlanFile(runner.id, '../secret.md'), (e) => e.code === 'plan_path_invalid');
  assert.throws(() => mission.readRunnerPlanFile(runner.id, '/etc/passwd'), (e) => e.code === 'plan_path_invalid');
  assert.throws(() => mission.readRunnerPlanFile(runner.id, 'QUEUE.md'), (e) => e.code === 'plan_reserved_name');
  assert.throws(() => mission.readRunnerPlanFile(runner.id, 'notes.txt'), (e) => e.code === 'plan_path_invalid');
  assert.throws(() => mission.writeRunnerPlanFile(runner.id, 'new.md', 'x', 'r'), (e) => e.code === 'plan_not_found');
  assert.equal(fs.existsSync(path.join(PLANS, 'new.md')), false);
  assert.throws(() => mission.writeRunnerPlanFile(runner.id, 'hello.md', 'x', ''), (e) => e.code === 'plan_revision_required');
});

it('records the shape of a save in the audit log, never the text', () => {
  const f = mission.readRunnerPlanFile(runner.id, 'hello.md');
  mission.writeRunnerPlanFile(runner.id, 'hello.md', 'TOPSECRET body', f.revision, { actor: 'user:u1' });
  const row = getDb().prepare("SELECT * FROM activity_events WHERE action = 'plan_file_saved' ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(row, 'an audit row exists');
  assert.doesNotMatch(JSON.stringify(row), /TOPSECRET/);
  assert.match(JSON.stringify(row), /hello\.md/);
});
