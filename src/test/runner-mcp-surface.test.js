// Plan 117: the runner MCP surface (/mcp/runner) — pad tokens only, the two
// worker tools only, and only for runners whose project lives on that pad.
const { after, before, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-mcp-surface-'));
process.env.WORKSPACE_ROOT = root;
process.env.PAD_DB_PATH = path.join(root, 'surface.db');
const MINE = 'pad-surface-a';
const OTHER = 'pad-surface-b';
for (const p of [MINE, OTHER]) {
  fs.mkdirSync(path.join(root, 'instances', p), { recursive: true });
  fs.writeFileSync(path.join(root, 'instances', p, 'meta.env'), 'AGENT=opencode\n');
}

const express = require('express');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { getDb } = require('../services/db');
const mission = require('../services/mission');
const tokens = require('../services/runner-mcp-token');
const apiKeys = require('../services/api-keys');
const { mountMcp } = require('../mcp');

let server;
let base;
let mineRunner;
let otherRunner;
let token;

before(async () => {
  for (const p of [MINE, OTHER]) {
    getDb().prepare("INSERT INTO agents (id, name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, 'opencode', 'docker', ?, 'running')").run(p, p, p);
  }
  const a = mission.createProject({ name: 'a', agent: MINE, folder: '/root/.opencode/workspace', plansFolder: 'plans' });
  const b = mission.createProject({ name: 'b', agent: OTHER, folder: '/root/.opencode/workspace', plansFolder: 'plans' });
  mineRunner = await mission.createRunner({ projectId: a.id, name: 'a', sessionId: mission.createSession(a.id, { agentSessionId: 'ses_a' }).id });
  otherRunner = await mission.createRunner({ projectId: b.id, name: 'b', sessionId: mission.createSession(b.id, { agentSessionId: 'ses_b' }).id });
  await mission.addRunnerQueueItems(mineRunner.id, ['one.md'], 0);
  token = tokens.mint(MINE);
  const app = express();
  app.use(express.json());
  mountMcp(app);
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server?.closeAllConnections?.(); server?.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function connect(bearer) {
  const client = new Client({ name: 't', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/runner`), {
    requestInit: { headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} },
  }));
  return client;
}
const raw = (bearer) => fetch(`${base}/mcp/runner`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});

it('refuses no token, a bogus token, and a USER API key with a JSON 401', async () => {
  getDb().prepare("INSERT OR IGNORE INTO users (id, username, display_name, role, password_hash) VALUES ('u_surface', 'surface', 'S', 'admin', 'x')").run();
  const userKey = apiKeys.create('u_surface', 'surfaceuser', 'default').key;
  for (const bearer of [null, 'prk_nope', userKey]) {
    const r = await raw(bearer);
    assert.equal(r.status, 401, `bearer=${String(bearer).slice(0, 6)}`);
    assert.match(r.headers.get('content-type'), /json/);
  }
});

it('a pad token sees exactly the two worker tools', async () => {
  const client = await connect(token);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agent_queue_read', 'agent_queue_update_item']);
  await client.close();
});

it('reads and updates its OWN runner, recorded as the pad', async () => {
  const client = await connect(token);
  const read = await client.callTool({ name: 'agent_queue_read', arguments: { runner_id: mineRunner.id } });
  assert.ok(!read.isError, read.content?.[0]?.text);
  const snap = JSON.parse(read.content[0].text);
  const item = snap.queue.items[0];
  // A worker may only update the item its current operation is assigned.
  const now = new Date().toISOString();
  getDb().prepare("INSERT OR REPLACE INTO runner_runtime (runner_id, state, generation, operation_id, updated_at) VALUES (?, 'running', 1, 'op-s', ?)").run(mineRunner.id, now);
  getDb().prepare("INSERT OR REPLACE INTO runner_operations (id, runner_id, generation, item_id, status, created_at, updated_at) VALUES ('op-s', ?, 1, ?, 'running', ?, ?)").run(mineRunner.id, item.id, now, now);
  const upd = await client.callTool({ name: 'agent_queue_update_item', arguments: { runner_id: mineRunner.id, item_id: item.id, status: 'in_progress', revision: snap.queue.revision } });
  assert.ok(!upd.isError, upd.content?.[0]?.text);
  const ev = getDb().prepare('SELECT actor FROM runner_queue_events WHERE item_id = ? ORDER BY rowid DESC LIMIT 1').get(item.id);
  assert.equal(ev.actor, `runner-mcp:${MINE}`);
  await client.close();
});

it("refuses ANOTHER pad's runner and returns none of its data", async () => {
  const client = await connect(token);
  const r = await client.callTool({ name: 'agent_queue_read', arguments: { runner_id: otherRunner.id } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /runner_not_on_this_pad/);
  assert.doesNotMatch(r.content[0].text, /"items"/);
  await client.close();
});

it('re-minting a pad token revokes the old one', async () => {
  const old = token;
  token = tokens.mint(MINE);
  assert.equal((await raw(old)).status, 401);
  assert.notEqual((await raw(token)).status, 401);
});
