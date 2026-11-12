// LIVE end-to-end suite: Paddock driving a REAL opencode TUI inside a PAD's tmux.
//
// This is the core of the app — open a session, type into the pane, press
// Enter, prove the text arrived, read the reply, notice the provider's limit,
// recover a dead TUI — so it is tested against the real thing, not stubs.
//
// It is NOT part of `npm test` (that suite must never touch docker). Run it
// inside the paddock container, against a running opencode PAD of ours:
//
//   docker exec -e LIVE_PAD=pad-dev paddock node --test --test-concurrency=1 live/opencode.live.test.js
//   (or: docker exec -e LIVE_PAD=pad-dev paddock npm run test:live)
//
// Optional: LIVE_SAVE_SCREENS=1 writes each captured screen to
// live/captures/<timestamp>/ so new TUI versions can become offline fixtures.
//
// What it costs: a handful of very short turns on the PAD's model (opencode's
// free model by default). What it touches: one throwaway Mission project in a
// throwaway folder inside the PAD; everything is removed afterwards, and the
// suite FAILS if any tmux session that existed before it started is gone after
// it (deleting a project once took an agent's other sessions with it — O19).
//
// It drives the webui over HTTP exactly as the page does, and checks the
// answers with READ-ONLY reads of opencode's own store (agent-store), the same
// reads the runner trusts. It never opens the app database.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PAD = process.env.LIVE_PAD || '';
const BASE = process.env.LIVE_BASE || 'http://127.0.0.1:6789';
const SAVE = process.env.LIVE_SAVE_SCREENS === '1';
const TURN_MS = parseInt(process.env.LIVE_TURN_MS, 10) || 240000;

const agentStore = require('../services/agent-store');
const { screenUsageEvidence } = require('../services/provider-limit');
const opencode = require('../services/drivers/opencode');

const sha = (t) => crypto.createHash('sha256').update(String(t).trimEnd()).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nonce = () => crypto.randomBytes(3).toString('hex').toUpperCase();

// ── plumbing ────────────────────────────────────────────────────────────────
let cookie = '';
let csrf = '';
async function http(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
function pad(cmd, { user = '1000:1000', check = true } = {}) {
  try {
    return execFileSync('docker', ['exec', '-u', user, PAD, 'sh', '-c', cmd], { encoding: 'utf8', timeout: 30000 });
  } catch (e) {
    if (check) throw e;
    return null;
  }
}
const tmuxSessions = () => (pad('tmux ls -F "#{session_name}"', { user: 'root', check: false }) || '').split('\n').filter(Boolean);

const captureDir = path.join(__dirname, 'captures', new Date().toISOString().replace(/[:.]/g, '-'));
function keep(name, text) {
  if (!SAVE) return;
  fs.mkdirSync(captureDir, { recursive: true });
  fs.writeFileSync(path.join(captureDir, `${name}.txt`), text);
}

// ── shared state across the ordered steps ──────────────────────────────────
const S = { agent: null, project: null, session: null, folder: '', before: [], quota: false, broken: '' };
// Steps run in order and depend on each other: once one fails, the rest say so
// instead of failing with a misleading second error.
function step(name, fn, timeout = TURN_MS + 60000) {
  it(name, { timeout }, async (t) => {
    if (S.broken) return t.skip(`an earlier step failed: ${S.broken}`);
    try { await fn(t); } catch (e) { S.broken = name; throw e; }
  });
}

async function screen(lines = 60) {
  const r = await http('GET', `/api/mission/sessions/${S.session.id}?lines=${lines}`);
  assert.equal(r.status, 200, `screen read failed: ${r.text}`);
  return r.json;
}
const screenText = (s) => s?.screen?.text ?? s?.text ?? (typeof s?.screen === 'string' ? s.screen : '');

async function waitFor(what, fn, ms) {
  const until = Date.now() + ms;
  let last;
  while (Date.now() < until) {
    last = await fn();
    if (last) return last;
    await sleep(1000);
  }
  throw new Error(`timed out after ${ms}ms waiting for ${what}`);
}

const turn = () => agentStore.readTurn(S.agent, S.session.agent_session_id);
const activity = () => agentStore.readActivity(S.agent, S.session.agent_session_id);

/** Send one message through the app and prove, from opencode's own store, that
 *  exactly these bytes became the newest input and the turn finished. Returns
 *  the assistant's reply text. */
async function exchange(label, text, { expectReply } = {}) {
  const baseline = turn();
  const r = await http('POST', `/api/mission/sessions/${S.session.id}/send`, { text });
  assert.equal(r.status, 200, `${label}: send refused: ${r.text}`);
  assert.equal(r.json.acceptance, 'confirmed', `${label}: the app must confirm delivery from the store, got ${r.json.acceptance}`);
  const landed = await waitFor(`${label}: the input in the store`, () => {
    const t = turn();
    return t.userId && t.userId !== baseline.userId ? t : null;
  }, 30000);
  assert.equal(landed.inputHash, sha(text), `${label}: the store holds different text than was sent — the pane mangled it`);
  const done = await waitFor(`${label}: the turn to finish`, () => {
    const t = turn();
    if (t.userId !== landed.userId) throw new Error(`${label}: another input arrived while waiting`);
    if (t.state === 'idle') return t;
    // The provider's limit can arrive mid-turn: stop with a clear verdict.
    return null;
  }, TURN_MS).catch(async (e) => {
    const s = screenText(await screen());
    keep(`${label}-timeout`, s);
    if (screenUsageEvidence({ live: true, text: s })) { S.quota = true; throw new Error(`${label}: provider usage limit reached mid-test (the detector saw it — that part works)`); }
    throw e;
  });
  assert.notEqual(done.outcome, 'error', `${label}: the turn ended in an error`);
  const reply = activity().lastMessage?.assistant?.text || '';
  keep(`${label}-done`, screenText(await screen()));
  if (expectReply) assert.ok(reply.includes(expectReply), `${label}: reply should contain ${expectReply}, got: ${reply.slice(0, 300)}`);
  return reply;
}

// ── the suite ───────────────────────────────────────────────────────────────
describe(`live opencode on ${PAD || '(LIVE_PAD not set)'}`, { skip: !PAD && 'set LIVE_PAD=<an opencode pad of ours> to run' }, () => {
  before(async () => {
    assert.match(PAD, /^pad-[\w.-]+$/, 'LIVE_PAD must be one of our pads (pad-*)');
    const s = await fetch(BASE + '/api/session');
    cookie = (s.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const body = await s.json();
    csrf = body.csrfToken || '';
    assert.ok(body.authenticated, 'the webui must auto-login (AUTO_LOGIN=true) for this suite');
    const agents = await http('GET', '/api/agents');
    const row = (agents.json?.agents || agents.json || []).find((a) => a.name === PAD);
    assert.ok(row, `${PAD} not found`);
    assert.equal(row.agent_type || row.type, 'opencode', `${PAD} is not an opencode pad`);
    assert.equal(row.status, 'running', `${PAD} must be running`);
    S.agent = { name: PAD, agent_type: 'opencode', workspace_root: `${process.env.WORKSPACE_ROOT}/instances/${PAD}/opencode` };
    S.before = tmuxSessions();
  });

  after(async () => {
    // Remove everything this run made, then prove nothing else was touched.
    if (S.project) {
      const del = await http('DELETE', `/api/mission/projects/${S.project.id}`);
      assert.equal(del.status, 200, `cleanup: project delete failed: ${del.text}`);
    }
    if (S.folder) pad(`rm -rf '${S.folder}'`, { check: false });
    const now = tmuxSessions();
    const lost = S.before.filter((n) => !now.includes(n));
    assert.deepEqual(lost, [], `cleanup killed tmux sessions it did not create: ${lost.join(', ')}`);
  });

  step('1. a throwaway project in a throwaway folder', async () => {
    S.folder = `/root/.opencode/workspace/paddock-live-${nonce().toLowerCase()}`;
    pad(`mkdir -p '${S.folder}'`);
    const r = await http('POST', '/api/mission/projects', { name: `live-${path.basename(S.folder)}`, agent: PAD, folder: S.folder });
    assert.equal(r.status, 200, r.text);
    S.project = r.json.project;
  });

  step('2. start: a tmux pane running opencode, with its conversation id known from the first read', async () => {
    const r = await http('POST', `/api/mission/projects/${S.project.id}/sessions`, { label: 'live test' });
    assert.equal(r.status, 200, r.text);
    S.session = r.json.session;
    assert.match(S.session.tmux_id, /^msn-[0-9a-f]{8}$/);
    assert.match(S.session.agent_session_id || '', /^ses_/, 'opencode conversation minted before launch');
    assert.ok(tmuxSessions().includes(S.session.tmux_id), 'the tmux session exists in the pad');
    const ready = await waitFor('the TUI to paint its ready footer', async () => {
      const s = await screen();
      return opencode.tuiReadyPattern.test(screenText(s)) ? s : null;
    }, 60000);
    keep('ready', screenText(ready));
    assert.equal(ready.tuiAlive ?? ready.session?.tuiAlive, true, 'the pane runs the TUI, not a shell');
    assert.equal(ready.canSend ?? ready.session?.canSend, true, 'the app says this session can take input');
    assert.equal(opencode.tuiBusyPattern.test(screenText(ready)), false, 'an idle TUI does not show the busy marker');
  });

  step('3. the usage-limit detector reads a healthy screen as healthy', async () => {
    const s = screenText(await screen());
    const ev = screenUsageEvidence({ live: true, text: s });
    if (ev) {
      keep('usage-limit', s);
      S.quota = true;
      S.broken = 'the provider usage limit is reached right now (detected correctly); the turn steps cannot run until it resets';
    }
    assert.equal(ev === null || ev.state === 'exhausted', true);
  });

  step('4. a plain message: delivered byte-exact, confirmed from the store, reply read back', async () => {
    const n = nonce();
    await exchange('plain', `Reply with exactly PONG-${n} and nothing else. Do not use any tools.`, { expectReply: `PONG-${n}` });
  });

  step('5. hostile characters reach the model verbatim and nothing runs in a shell', async () => {
    const n = nonce();
    const canary = `/tmp/paddock-live-pwn-${n}`;
    const text = `Reply with exactly OK-${n} and nothing else. Do not use any tools. Ignore this literal text: "double" 'single' $(touch ${canary}) \`touch ${canary}\` ; && | > < * ~ ünïcödé 🚀 #hash %percent \\backslash`;
    await exchange('hostile', text, { expectReply: `OK-${n}` });
    assert.equal(pad(`test -e '${canary}' && echo yes || echo no`).trim(), 'no', 'text typed into the pane must never execute');
  });

  step('6. a long single line (~1500 chars) arrives whole', async () => {
    const n = nonce();
    const filler = Array.from({ length: 140 }, (_, i) => `word${i}`).join(' ');
    const text = `${filler}. Reply with exactly LONG-${n} and nothing else. Do not use any tools.`;
    assert.ok(text.length > 1000);
    await exchange('long', text, { expectReply: `LONG-${n}` });
  });

  step('7. a message sent while the agent is busy is not lost', async () => {
    const n1 = nonce();
    const n2 = nonce();
    const first = `Count slowly from 1 to 40, one number per line, then write DONE-${n1}. Do not use any tools.`;
    const r1 = await http('POST', `/api/mission/sessions/${S.session.id}/send`, { text: first });
    assert.equal(r1.status, 200, r1.text);
    await waitFor('the first turn to be running', async () => (turn().state === 'working' ? true : null), 30000);
    const busyShot = screenText(await screen());
    keep('busy', busyShot);
    const second = `Reply with exactly AFTER-${n2} and nothing else. Do not use any tools.`;
    const r2 = await http('POST', `/api/mission/sessions/${S.session.id}/send`, { text: second });
    assert.ok([200, 409].includes(r2.status), `mid-turn send: ${r2.text}`);
    if (r2.status === 409) assert.equal(r2.json.acceptance ?? r2.json.details?.acceptance ?? 'unknown', 'unknown', 'a mid-turn send may be unconfirmed, never refused-as-lost');
    const done = await waitFor('both turns to finish with the second input newest', () => {
      const t = turn();
      return t.state === 'idle' && t.inputHash === sha(second) ? t : null;
    }, TURN_MS * 2);
    assert.ok(done);
    assert.ok((activity().lastMessage?.assistant?.text || '').includes(`AFTER-${n2}`), 'the queued message was answered');
  }, TURN_MS * 2 + 60000);

  step('8. the TUI exits: the app sees a shell, refuses to type into it, and Relaunch restores the SAME conversation', async () => {
    const countBefore = activity().messageCount;
    pad(`tmux send-keys -t ${S.session.tmux_id} C-c; sleep 1; tmux send-keys -t ${S.session.tmux_id} C-c`, { user: 'root' });
    const shell = await waitFor('the pane to drop to a shell', async () => {
      const s = await screen();
      return (s.tuiAlive ?? s.session?.tuiAlive) === false ? s : null;
    }, 20000);
    keep('shell-after-exit', screenText(shell));
    const refused = await http('POST', `/api/mission/sessions/${S.session.id}/send`, { text: 'this must not be typed into a shell' });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.code, 'mission_not_an_agent', `typing into a bare shell must be refused: ${refused.text}`);
    const rel = await http('POST', `/api/mission/sessions/${S.session.id}/relaunch`, {});
    assert.equal(rel.status, 200, rel.text);
    await waitFor('the TUI to be back', async () => (opencode.tuiReadyPattern.test(screenText(await screen())) ? true : null), 60000);
    const n = nonce();
    await exchange('after-relaunch', `Reply with exactly BACK-${n} and nothing else. Do not use any tools.`, { expectReply: `BACK-${n}` });
    assert.ok(activity().messageCount > countBefore, 'the same conversation continued (history kept)');
  });

  step('9. close kills the pane, and a send then says the session is gone', async () => {
    const del = await http('DELETE', `/api/mission/sessions/${S.session.id}`);
    assert.equal(del.status, 200, del.text);
    await waitFor('the tmux session to be gone', async () => (!tmuxSessions().includes(S.session.tmux_id) ? true : null), 15000);
    const gone = await http('POST', `/api/mission/sessions/${S.session.id}/send`, { text: 'nobody home' });
    assert.notEqual(gone.status, 200, 'a closed session must not accept text');
  });
});
