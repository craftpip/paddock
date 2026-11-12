// Plan 128: run Paddock through MCP alone. The runner tools are driven through
// the real MCP registration (the error-catching wrapper included) as an
// orchestrator key would call them, with tmux and the agent store stubbed.
const { after, before, beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-runners-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'mcp-runners.db');
const PAD = 'pad-mcp-runners';
const OTHER = 'pad-mcp-other';
const FOLDER = '/root/.opencode/workspace';
for (const p of [PAD, OTHER]) {
  fs.mkdirSync(path.join(root, 'instances', p), { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', p, 'meta.env'), 'AGENT=opencode\n');
}

const crypto = require('node:crypto');
const { getDb } = require('../services/db');
const mission = require('../services/mission');
mission._setFastWatch({ enabled: false });
const runnerQueue = require('../services/runner-queue');
const tmux = require('../services/pad-tmux');
const store = require('../services/agent-store');
const opencode = require('../services/drivers/opencode');
const { registerTools, mcpContext } = require('../mcp');
const registry = require('../services/agent-registry');
// The name resolver discovers the fleet from docker, where these pads do not
// exist (and would be marked stopped). Pin the fleet, as mcp.test.js does.
const realDiscover = registry.discoverAgents;
registry.discoverAgents = () => [PAD, OTHER].map((name) => ({ name, display_name: name, agent_type: 'opencode', runtime_ref: name, status: 'running' }));
after(() => { registry.discoverAgents = realDiscover; });

after(() => fs.rmSync(root, { recursive: true, force: true }));

const saved = { tmux: { ...tmux }, readTurn: store.readTurn, readActivity: store.readActivity, status: opencode.mcpServerStatus, connect: opencode.connectMcpServer, createConversation: opencode.createConversation };
after(() => {
  Object.assign(tmux, saved.tmux);
  store.readTurn = saved.readTurn;
  store.readActivity = saved.readActivity;
  opencode.mcpServerStatus = saved.status;
  opencode.connectMcpServer = saved.connect;
  opencode.createConversation = saved.createConversation;
});

let turn = { state: 'idle', userId: 'baseline', inputHash: 'baseline', completedAt: new Date(Date.now() - 60000).toISOString() };
const sends = [];
const ORCH = { userId: 'u1', role: 'user', keyId: 'key_orch', scopes: ['tools:create', 'tools:exec', `target:agent:${PAD}`] };
const READER = { userId: 'u1', role: 'user', keyId: 'key_read', scopes: ['read'] };
const handlers = {};
// A refusal reaches the caller either as an `isError` result or as a thrown
// McpError, depending on the path; both are a failed call to the LLM.
const call = async (user, name, args) => {
  let r;
  try {
    r = await mcpContext.run({ user }, () => handlers[name](args));
  } catch (e) {
    return { isError: true, text: e.message, json: null };
  }
  const text = r.content?.[0]?.text || '';
  let json = null;
  try { json = JSON.parse(text); } catch { /* an error text */ }
  return { isError: !!r.isError, text, json };
};

let project;

// The fake pads are re-seeded as running before every step: discovery may
// re-read them from docker (where they do not exist) between calls.
function seedPads() {
  for (const name of [PAD, OTHER]) {
    // An UPSERT, not INSERT OR REPLACE: REPLACE deletes the row first, and the
    // projects' foreign key cascades that delete onto every project.
    getDb().prepare(`INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
      VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'u1')
      ON CONFLICT(id) DO UPDATE SET status = 'running', owner_id = 'u1'`).run(name, name, name);
  }
}
beforeEach(seedPads);

before(async () => {
  seedPads();
  tmux.hasSession = async () => true;
  tmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', cwd: FOLDER });
  let shot = 0;
  // Each capture differs, as a live TUI's does after a keystroke.
  tmux.captureScreen = async () => ({ live: true, text: `screen ${shot++} ctrl+p commands` });
  tmux.createSession = async () => {};
  tmux.sendCommand = async () => true;
  tmux.folderExists = async () => true;
  tmux.killSession = async () => {};
  tmux.sendText = async (_p, _t, text) => {
    sends.push(text);
    turn = { state: 'working', userId: `input-${sends.length}`, inputHash: crypto.createHash('sha256').update(text.trimEnd()).digest('hex'), progressAt: new Date().toISOString() };
    return { lines: 1 };
  };
  store.readTurn = () => turn;
  store.readActivity = () => ({ store: { available: false }, lastActivityAt: null });
  opencode.mcpServerStatus = async () => ({ state: 'connected', detail: '' });
  opencode.connectMcpServer = async () => ({ ok: true, output: 'added' });
  // A real opencode mints its conversation through its server; here, a fixed id.
  let conv = 0;
  opencode.createConversation = async () => `ses_mcp_runner_${++conv}`;
  registerTools({ registerTool: (name, cfg, handler) => { handlers[name] = handler; } });
  project = mission.createProject({ name: 'self', agent: PAD, folder: FOLDER, plansFolder: 'plans' });
});

let runnerId;

it('runner_list with nothing yet says how to start', async () => {
  const r = await call(ORCH, 'runner_list', { project_id: project.id });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.count, 0);
  assert.match(r.json.next, /runner_create/);
});

it('runner_create: one call makes the runner, its session, its queue and queues the plans', async () => {
  const r = await call(ORCH, 'runner_create', { project_id: project.id, name: 'web fixes', plans: ['01-a.md', '02-b.md'] });
  assert.equal(r.isError, false, r.text);
  runnerId = r.json.runner_id;
  assert.match(runnerId, /^run_/);
  assert.ok(r.json.session?.id, 'a worker session was started for it');
  assert.deepEqual(r.json.items.map((i) => [i.plan, i.status]), [['01-a.md', 'new'], ['02-b.md', 'new']]);
  assert.equal(r.json.can.run, true);
  assert.match(r.json.next, /runner_start/);
  assert.equal(sends.length, 0, 'nothing is typed into the agent before runner_start');
});

it('runner_start sends the first plan and the brief says the worker is on it', async () => {
  const r = await call(ORCH, 'runner_start', { runner_id: runnerId });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.started, true);
  assert.equal(sends.length, 1);
  assert.ok(['dispatching', 'awaiting_receipt', 'running'].includes(r.json.state), r.json.state);
});

it('a worker question shows up as `blocked` with the question, and `next` names the answer call', async () => {
  // What the worker does through its own queue tool (agent_queue_update_item)
  // when it needs a decision: the same service call, so the projection follows.
  const first = (await mission.readRunnerQueue(runnerId)).queue.items[0];
  const rev1 = (await mission.readRunnerQueue(runnerId)).queue.revision;
  await mission.updateRunnerQueueItem(runnerId, first.id, { status: 'in_progress', reason: '' }, rev1, { actor: 'worker', source: 'worker' });
  const rev2 = (await mission.readRunnerQueue(runnerId)).queue.revision;
  await mission.updateRunnerQueueItem(runnerId, first.id, { status: 'need_input', reason: 'Show the package.json version or the git sha?' }, rev2, { actor: 'worker', source: 'worker' });
  turn = { state: 'idle', userId: 'input-1', inputHash: turn.inputHash, completedAt: new Date().toISOString(), progressAt: new Date().toISOString() };
  await mission.observeRunnerQueues();
  const r = await call(ORCH, 'runner_get', { runner_id: runnerId });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.json.blocked.length, 1);
  assert.equal(r.json.blocked[0].question, 'Show the package.json version or the git sha?');
  assert.equal(r.json.blocked[0].item_id, first.id);
  assert.match(r.json.next, /agent_queue_resolve_need_input/);
  assert.match(r.json.next, new RegExp(first.id));
});

it('agent_queue_resolve_need_input works with just runner, item and answer; a retry does not answer twice', async () => {
  const brief = (await call(ORCH, 'runner_get', { runner_id: runnerId })).json;
  // The runner stopped on the question by itself (observeRunnerQueues above):
  // nothing here forces the state.
  assert.equal(brief.state, 'waiting_input', `the runner must be waiting for the answer, is ${brief.state}`);
  assert.equal(brief.can.resolve, true);
  const itemId = brief.blocked[0].item_id;
  const before = sends.length;
  const r = await call(ORCH, 'agent_queue_resolve_need_input', { runner_id: runnerId, item_id: itemId, answer: 'Use the package.json version.' });
  assert.equal(r.isError, false, r.text);
  assert.equal(sends.length, before + 1, 'the answer was typed into the worker');
  assert.match(sends.at(-1), /package\.json version/);
  // A retry after success is refused with the reason (the item is no longer
  // waiting), and nothing is typed a second time.
  const again = await call(ORCH, 'agent_queue_resolve_need_input', { runner_id: runnerId, item_id: itemId, answer: 'Use the package.json version.' });
  assert.equal(again.isError, true);
  assert.match(again.text, /queue_item_not_blocked/);
  assert.equal(sends.length, before + 1, 'a retried answer is never typed twice');
  const after = (await call(ORCH, 'runner_get', { runner_id: runnerId })).json;
  assert.equal(after.blocked.length, 0);
});

it('resolve names the problem when the item is not blocked', async () => {
  const items = (await call(ORCH, 'runner_get', { runner_id: runnerId })).json.items;
  const r = await call(ORCH, 'agent_queue_resolve_need_input', { runner_id: runnerId, item_id: items[1].item_id, answer: 'x' });
  assert.equal(r.isError, true);
  assert.match(r.text, /queue_item_not_blocked|not waiting for input|runner_invalid_state/);
});

it('runner_pause, then agent_queue_remove_item without a revision, then runner_remove keeps the session', async () => {
  const p = await call(ORCH, 'runner_pause', { runner_id: runnerId });
  assert.equal(p.isError, false, p.text);
  assert.equal(p.json.state, 'paused');
  const items = p.json.items.filter((i) => i.status === 'new');
  const rm = await call(ORCH, 'agent_queue_remove_item', { runner_id: runnerId, item_id: items.at(-1).item_id });
  assert.equal(rm.isError, false, rm.text);
  assert.equal(rm.json.items.some((i) => i.item_id === items.at(-1).item_id), false);
  const sessionId = rm.json.session.id;
  const gone = await call(ORCH, 'runner_remove', { runner_id: runnerId });
  assert.equal(gone.isError, false, gone.text);
  assert.equal(gone.json.session_kept, sessionId);
  assert.ok(mission.getSession(sessionId), 'the worker session survives its runner');
});

it('grants: a read key can list and read but not create or start; the target grant hides other pads', async () => {
  const created = await call(ORCH, 'runner_create', { project_id: project.id, name: 'second' });
  assert.equal(created.isError, false, created.text);
  const id = created.json.runner_id;
  assert.equal((await call(READER, 'runner_get', { runner_id: id })).isError, false);
  assert.equal((await call(READER, 'runner_list', {})).json.count >= 1, true);
  const start = await call(READER, 'runner_start', { runner_id: id });
  assert.equal(start.isError, true);
  assert.match(start.text, /tool grant: runner_start/);
  assert.equal((await call(READER, 'runner_create', { project_id: project.id, name: 'nope' })).isError, true);
  const other = mission.createProject({ name: 'other', agent: OTHER, folder: FOLDER, plansFolder: 'plans-other' });
  const there = await call(ORCH, 'runner_create', { project_id: other.id, name: 'x' });
  assert.equal(there.isError, true, 'the orchestrator key is limited to its target pad');
  const listed = await call(ORCH, 'runner_list', {});
  assert.ok(listed.json.runners.every((r) => r.project.id !== other.id));
});

it('an unknown runner id says where ids come from', async () => {
  const r = await call(ORCH, 'runner_get', { runner_id: 'run_nope' });
  assert.equal(r.isError, true);
  assert.match(r.text, /runner_list/);
});

it('help teaches the runner loop', async () => {
  const r = await mcpContext.run({ user: ORCH }, () => handlers.help({}));
  const text = r.content[0].text;
  for (const name of ['runner_create', 'runner_start', 'runner_get', 'agent_queue_resolve_need_input']) assert.match(text, new RegExp(name));
});
