// Plan 117: Run wires the pad-scoped runner MCP surface automatically, restarts an
// idle worker TUI so it loads the tools, and refuses only when wiring fails.
const { after, afterEach, beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mcp-preflight-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'preflight.db');
const PAD = 'pad-mcp-preflight';
const FOLDER = '/root/.opencode/workspace';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const runnerTransition = require('../services/runner-transition');
const registry = require('../services/agent-registry');
const tmux = require('../services/pad-tmux');
const store = require('../services/agent-store');
const opencode = require('../services/drivers/opencode');
const realStatus = opencode.mcpServerStatus;
const realConnect = opencode.connectMcpServer;
const tokens = require('../services/runner-mcp-token');
let mcpState;      // what the probe reports BEFORE any wiring
let connectWorks;  // whether connectMcpServer makes the probe report connected
let connects;      // recorded connectMcpServer calls
let paneAlive;     // fake pane: kill -> dead, createSession -> alive
let kills;

let saved;
let project;
let session;
let runner;
let turn;
let sends;
let screenCalls;

const idle = () => ({ state: 'idle', userId: 'baseline', inputHash: 'baseline', completedAt: new Date(Date.now() - 60000).toISOString(), progressAt: new Date(Date.now() - 60000).toISOString() });
const busy = () => ({ state: 'working', userId: 'human-answer', inputHash: 'human-answer', progressAt: new Date().toISOString() });

after(() => fs.rmSync(root, { recursive: true, force: true }));

afterEach(() => {
  opencode.mcpServerStatus = realStatus;
  opencode.connectMcpServer = realConnect;
  if (!saved) return;
  Object.assign(tmux, saved.tmux);
  Object.assign(store, saved.store);
  saved = null;
});

beforeEach(async () => {
  getDb().exec(`
    DELETE FROM runner_quota_recoveries; DELETE FROM runner_operations; DELETE FROM runner_transitions;
    DELETE FROM runner_publications; DELETE FROM runner_publication_leases; DELETE FROM runner_projection_owners;
    DELETE FROM runner_runtime; DELETE FROM runner_queue_events; DELETE FROM runner_queue_items; DELETE FROM runner_queues;
    DELETE FROM runner_history; DELETE FROM runner_queue_observations; DELETE FROM infinite_runners;
    DELETE FROM mission_sessions; DELETE FROM mission_projects; DELETE FROM activity_events; DELETE FROM agents;
  `);
  getDb().prepare("INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')")
    .run(PAD, PAD, PAD);
  fs.rmSync(path.join(root, 'instances', PAD, 'opencode', 'workspace'), { recursive: true, force: true });

  saved = {
    tmux: { hasSession: tmux.hasSession, paneState: tmux.paneState, captureScreen: tmux.captureScreen, sendText: tmux.sendText, killSession: tmux.killSession, createSession: tmux.createSession, sendCommand: tmux.sendCommand, folderExists: tmux.folderExists },
    store: { readTurn: store.readTurn, readActivity: store.readActivity },
  };
  turn = idle();
  mcpState = { state: 'connected', detail: '' };
  connectWorks = true;
  connects = [];
  paneAlive = true;
  kills = 0;
  opencode.mcpServerStatus = async () => mcpState;
  opencode.connectMcpServer = async (name, opts) => {
    connects.push({ name, ...opts });
    if (connectWorks) mcpState = { state: 'connected', detail: '' };
    return { ok: connectWorks, output: connectWorks ? 'added' : 'Error: connect ECONNREFUSED' };
  };
  tmux.killSession = async () => { kills++; paneAlive = false; };
  tmux.createSession = async () => { paneAlive = true; };
  tmux.sendCommand = async () => true;
  tmux.folderExists = async () => true;
  sends = [];
  screenCalls = 0;
  tmux.hasSession = async () => paneAlive;
  tmux.paneState = async () => (paneAlive ? { live: true, tuiAlive: true, command: 'opencode', cwd: FOLDER } : { live: false, tuiAlive: false, command: '', cwd: '' });
  tmux.captureScreen = async () => ({ live: true, text: `screen ${screenCalls++} ctrl+p commands` });
  store.readActivity = () => ({ store: { available: false }, lastActivityAt: null });
  store.readTurn = () => turn;
  tmux.sendText = async (_pad, _tmux, text) => {
    sends.push(text);
    turn = { state: 'working', userId: `input-${sends.length}`, inputHash: require('node:crypto').createHash('sha256').update(text.trimEnd()).digest('hex'), progressAt: new Date().toISOString() };
    return { lines: 1 };
  };

  project = mission.createProject({ name: 'preflight', agent: PAD, folder: FOLDER, plansFolder: 'plans' });
  session = mission.createSession(project.id, { agentSessionId: 'ses_preflight' });
  runner = await mission.createRunner({ projectId: project.id, name: 'preflight', sessionId: session.id });
  await mission.updateRunner(runner.id, { idleGraceMs: 0, minNudgeIntervalMs: 0 });
  await mission.addRunnerQueueItems(runner.id, ['first.md', 'second.md'], 0);
});


const ESC = String.fromCharCode(27);
it('parses the real opencode mcp list layouts', () => {
  const ok = '┌  MCP Servers\n│\n●  ✓ paddock ' + ESC + '[90mconnected\n│      ' + ESC + '[90mhttp://h:6789/mcp\n│\n└  1 server(s)';
  const bad = '┌  MCP Servers\n│\n●  ✗ paddock ' + ESC + '[90mfailed\n│      JSON Parse error: Unrecognized token ' + "'<'" + '\n└  1 server(s)';
  const none = '┌  MCP Servers\n│\n▲  No MCP servers configured\n│\n└  Add servers with: opencode mcp add';
  const other = '●  ✓ navigator connected';
  assert.equal(opencode.parseMcpList(ok, 'paddock').state, 'connected');
  const f = opencode.parseMcpList(bad, 'paddock');
  assert.equal(f.state, 'failed');
  assert.match(f.detail, /JSON Parse error/);
  assert.equal(opencode.parseMcpList(none, 'paddock').state, 'absent');
  assert.equal(opencode.parseMcpList(other, 'paddock').state, 'absent', 'another server is not ours');
});

it('a pad without the runner MCP is wired automatically on Run, with a pad token on stdin', async () => {
  mcpState = { state: 'absent', detail: 'no "paddock_runner" MCP server is configured in this pad' };
  const r = await mission.startRunner(runner.id);
  assert.equal(r.started, true);
  assert.equal(connects.length, 1);
  assert.equal(connects[0].server, 'paddock_runner');
  assert.match(connects[0].url, /\/mcp\/runner$/);
  assert.match(connects[0].token, /^prk_[0-9a-f]{48}$/);
  assert.equal(tokens.authenticate(connects[0].token), PAD, 'the token handed to the pad authenticates as that pad');
  assert.equal(sends.length, 1);
  const wired = getDb().prepare("SELECT COUNT(*) AS n FROM runner_history WHERE runner_id = ? AND type = 'runner_tools_wired'").get(runner.id).n;
  assert.equal(wired, 1);
});

it('an idle worker TUI that predates the wiring is restarted into the same conversation', async () => {
  mcpState = { state: 'absent', detail: '' };
  const before = mission.getSession(session.id).agent_session_id;
  await mission.startRunner(runner.id);
  assert.equal(kills, 1, 'the old TUI was stopped so the new one loads the tools');
  assert.equal(mission.getSession(session.id).agent_session_id, before, 'same conversation');
  assert.equal(sends.length, 1);
});

it('a BUSY worker is never restarted: Run refuses and nothing is sent', async () => {
  mcpState = { state: 'absent', detail: '' };
  turn = busy();
  await assert.rejects(() => mission.startRunner(runner.id), (e) => e.code === 'runner_worker_not_idle' && /mid-turn/.test(e.message));
  assert.equal(kills, 0);
  assert.equal(sends.length, 0);
});

it('wiring that does not connect refuses with the reason, nothing sent', async () => {
  mcpState = { state: 'absent', detail: '' };
  connectWorks = false;
  await assert.rejects(() => mission.startRunner(runner.id),
    (e) => e.code === 'runner_worker_tools_missing' && /ECONNREFUSED/.test(e.message) && /HOST_NAME/.test(e.message));
  assert.equal(sends.length, 0);
  assert.notEqual(runnerTransition.getRuntime(runner.id).state, 'running');
});

it('an UNKNOWN probe neither wires nor blocks', async () => {
  mcpState = { state: 'unknown', detail: 'could not run' };
  const r = await mission.startRunner(runner.id);
  assert.equal(r.started, true);
  assert.equal(connects.length, 0);
});

it('positive twin: an already-connected pad is not rewired and its worker is not restarted', async () => {
  const r = await mission.startRunner(runner.id);
  assert.equal(r.started, true);
  assert.equal(connects.length, 0);
  assert.equal(kills, 0);
  assert.equal(sends.length, 1);
});

it('a worker with no conversation id is refused as identity-unavailable, not "not idle"', async () => {
  getDb().prepare('UPDATE mission_sessions SET agent_session_id = NULL WHERE id = ?').run(session.id);
  await assert.rejects(() => mission.startRunner(runner.id),
    (e) => e.code === 'runner_worker_identity_unavailable' && /conversation id/.test(e.message));
  assert.equal(sends.length, 0);
});
