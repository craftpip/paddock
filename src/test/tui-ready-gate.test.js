// Plan 116: input typed into a freshly launched opencode TUI is dropped until the
// TUI has painted its footer. sendText must wait for the driver's ready marker
// before writing, and refuse with NOTHING written when it never appears.
const { after, afterEach, beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tui-ready-gate-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'gate.db');
const PAD = 'pad-tui-gate';
fs.mkdirSync(path.join(root, 'instances', PAD), { recursive: true });
fs.writeFileSync(path.join(root, 'instances', PAD, 'meta.env'), 'AGENT=opencode\n');

const { getDb } = require('../services/db');
const mission = require('../services/mission');
const tmux = require('../services/pad-tmux');
const store = require('../services/agent-store');
const opencode = require('../services/drivers/opencode');

const BOOT = '█▀▀█ █▀▀█ opencode\n  Ask anything…';
const READY = '  ┃  Build · Big Pickle\n  /root/.opencode/workspace   ctrl+p commands';

let saved;
let session;
let reads;
let readyAfter; // capture count at which the footer appears (Infinity = never)
let writes;

after(() => fs.rmSync(root, { recursive: true, force: true }));
afterEach(() => { Object.assign(tmux, saved.tmux); Object.assign(store, saved.store); });

beforeEach(() => {
  getDb().exec('DELETE FROM mission_sessions; DELETE FROM mission_projects; DELETE FROM activity_events; DELETE FROM agents;');
  getDb().prepare("INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')").run(PAD, PAD, PAD);
  saved = {
    tmux: { hasSession: tmux.hasSession, paneState: tmux.paneState, captureScreen: tmux.captureScreen, sendText: tmux.sendText },
    store: { readActivity: store.readActivity },
  };
  reads = 0;
  writes = [];
  tmux.hasSession = async () => true;
  tmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'opencode', cwd: '/root/.opencode/workspace' });
  tmux.captureScreen = async () => {
    reads++;
    const ready = reads > readyAfter;
    return { live: true, text: ready ? `${READY}\n${writes.join('\n')}` : BOOT };
  };
  tmux.sendText = async (_vm, _t, text) => {
    writes.push({ text, readyWhenWritten: reads > readyAfter });
    return { lines: 1 };
  };
  store.readActivity = () => ({ store: { available: false }, lastActivityAt: null });
  const project = mission.createProject({ name: 'gate', agent: PAD, folder: '/root/.opencode/workspace' });
  session = mission.createSession(project.id, { tmuxId: 'msn-0a0b0c0d' });
  mission._setTuiReadyBudget(2000);
});

it('the opencode driver declares a ready marker that matches its idle and mid-turn footer', () => {
  assert.ok(opencode.tuiReadyPattern.test('/root/.opencode/workspace   8.2K (4%)  ctrl+p commands'));
  assert.ok(opencode.tuiReadyPattern.test('■■■⬝⬝ esc interrupt 8.2K (4%) ctrl+p commands'));
  assert.ok(!opencode.tuiReadyPattern.test(BOOT));
});

it('a booting TUI is waited for: the write happens once, after the footer appears', async () => {
  readyAfter = 3;
  await mission.sendText(session.id, 'hello');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].readyWhenWritten, true, 'the text was typed only after the TUI was ready');
});

it('a TUI that never becomes ready is refused with nothing written (safe to retry)', async () => {
  readyAfter = Infinity;
  await assert.rejects(() => mission.sendText(session.id, 'hello'),
    (e) => e.code === 'mission_tui_not_ready' && e.attempted === false);
  assert.equal(writes.length, 0);
});

it('positive twin: an already-ready TUI is written to immediately', async () => {
  readyAfter = 0;
  await mission.sendText(session.id, 'hello');
  assert.equal(writes.length, 1);
  assert.equal(reads <= 3, true, `no readiness polling on a ready pane (reads=${reads})`);
});
