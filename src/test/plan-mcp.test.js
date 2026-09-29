/** Plan 64 — the plans facility, called for real over the MCP surface.
 *
 *  The service (`services/plans.js`) is easy to get right and easy to get
 *  useless: a plan list that no tool exposes, a writer whose refusal escapes
 *  before the `isError` wrapper, a frontmatter stamp that only the tests apply.
 *  So this suite drives `plan_list` / `plan_write` / `plan_activity` through a
 *  real in-memory MCP client, the same way task-mcp.test.js does the task tools.
 *
 *  A real temporary workspace on disk, because the whole facility is files: the
 *  frontmatter is only proven by what is actually written to disk, and a
 *  read-back through the tool would pass even if the format were unparseable by
 *  anything else.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// plans land at <workspace_root>/workspace/plans — the driver's default layout, which is
// what plansRoot derives when a pad has no custom mount. Named once so the direct
// disk assertions and the tool agree on one place.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-plans-'));
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-planmcp-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'plan-mcp.test.db');
process.on('exit', () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
});

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, SERVER_NAME, SERVER_VERSION, mcpContext, toolAllowed } = require('../mcp');
const { getDb } = require('../services/db');
const registry = require('../services/agent-registry');
const plans = require('../services/plans');
const agentStore = require('../services/agent-store');
const { redactSecrets } = require('../services/vm-manager');
const Database = require('better-sqlite3');

// plans land at <workspace_root>/workspace/plans — the driver default layout, which is
// what plansRoot derives when a pad has no custom mount. Named once so the direct
// disk assertions and the tool agree on one place.
const PAD_PLANS = path.join(WS, 'a-data', 'workspace');
const OWNER = { userId: 'user-1', role: 'user', scopes: ['default'] };
const READONLY = { userId: 'user-2', role: 'user', scopes: ['default'] };
const PAD = 'pad-plans-a';
const OUTSIDE = 'pad-plans-out';
const NOT_OPTED = 'pad-plans-refused';
// The real project root as the WEBUI sees it — the same constant the mount
// mapping is built from, so containerViewOf resolves it exactly as in
// production. Deriving it from __dirname would give '/' in-container, which is
// a different mount and a different answer.
const { HOST_WORKSPACE: PROJECT } = require('../services/vm-manager');

const padRow = (n) => {
  if (n === PAD) {
    return {
      id: PAD, name: PAD, display_name: 'Plans A', agent_type: 'opencode',
      runtime_type: 'docker', runtime_ref: PAD, status: 'running',
      workspace_root: path.join(WS, 'a-data'),
      workspace_mount: null,
      workspace_dir: '/root/.opencode/workspace',
    };
  }
  if (n === OUTSIDE) {
    return {
      id: OUTSIDE, name: OUTSIDE, display_name: 'Outside', agent_type: 'opencode',
      runtime_type: 'docker', runtime_ref: OUTSIDE, status: 'running',
      // A mount from outside the project root: the webui has no host view of
      // it, which is a refusal with a CODE, not an empty listing.
      workspace_root: path.join(WS, 'o-data'),
      workspace_mount: { host: '/www1/somewhere', container: '/mnt/x', hostBrowsable: false, hostBrowseReason: 'outside' },
      workspace_dir: '/mnt/x',
    };
  }
  return null;
};

function buildServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  registerTools(server);
  return server;
}

describe('MCP plans facility (plan 64)', () => {
  let client;
  let server;
  let realDiscover;
  let realGetAgent;

  async function call(name, args, user) {
    const run = () => client.callTool({ name, arguments: args || {} });
    try {
      const r = await mcpContext.run({ user: user || OWNER }, run);
      const text = (r.content || []).map((c) => c.text).join('\n');
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return { isError: !!r.isError, text, data };
    } catch (e) {
      return { isError: true, text: String(e.message || e), data: null };
    }
  }

  before(async () => {
    realDiscover = registry.discoverAgents;
    realGetAgent = registry.getAgent;
    const refused = {
      id: NOT_OPTED, name: NOT_OPTED, display_name: 'Refused', agent_type: 'opencode',
      runtime_type: 'docker', runtime_ref: NOT_OPTED, status: 'running',
      workspace_root: path.join(WS, 'refused-data'),
      // A mount the webui CAN see, on a pad that was never opted in. Both
      // halves matter: capability true, permission false.
      workspace_mount: {
        host: PROJECT, container: '/workspace', webuiVisible: true, hostBrowsable: false,
        hostBrowseReason: 'host browsing is not enabled for this pad (meta HOST_BROWSE=1).',
      },
    };
    registry.discoverAgents = () => [padRow(PAD), padRow(OUTSIDE), refused];
    registry.getAgent = (n) => (n === NOT_OPTED ? refused : padRow(n));
    server = buildServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test-client', version: '0' });
    await client.connect(ct);
  });

  after(async () => {
    if (client) await client.close();
    if (server) await server.close();
    registry.discoverAgents = realDiscover;
    registry.getAgent = realGetAgent;
  });

  beforeEach(() => {
    fs.rmSync(PAD_PLANS, { recursive: true, force: true });
    const db = getDb();
    for (const name of [PAD, OUTSIDE, NOT_OPTED]) {
      db.prepare(
        `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
         VALUES (?, ?, 'opencode', 'docker', ?, 'running', 'user-1')`
      ).run(name, name, name);
    }
  });

  // --- 3e: the retirement -------------------------------------------------

  it('3e: workspace_list/workspace_read are GONE and workspace_write remains', async () => {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('workspace_list'), 'workspace_list retired');
    assert.ok(!names.includes('workspace_read'), 'workspace_read retired');
    assert.ok(names.includes('workspace_write'), 'workspace_write kept — plan_write is built on it');
    assert.ok(names.includes('plan_list') && names.includes('plan_write') && names.includes('plan_activity'), 'the three plan tools');
  });

  it('3e: the guide no longer points at the retired tools', () => {
    const { getGuide } = require('../services/llm-guide');
    const guide = getGuide();
    assert.ok(!guide.includes('workspace_list'), 'guide does not advertise workspace_list');
    assert.ok(!guide.includes('workspace_read'), 'guide does not advertise workspace_read');
    assert.ok(guide.includes('plan_list'), 'guide points at the real path');
  });

  // --- 3a: the writer that lied ------------------------------------------

  it('3a: workspace_write refuses cleanly on a non-browsable pad instead of reporting success', async () => {
    // The control that matters: before the `await`, this returned
    // {name, path} as if it had written a file that was never created.
    const r = await call('workspace_write', { name: OUTSIDE, path: 'x.md', content: 'y' });
    assert.ok(r.isError, 'a refusal is an error result, not a success');
    assert.ok(!/ok:\s*true/.test(r.text), 'never claims ok:true');
    assert.ok(/not available/i.test(r.text), `says why: ${r.text}`);
  });

  // --- 3c/3d/1a: list + write + frontmatter ------------------------------

  it('plan_write creates plans/ on first use and plan_list sees it', async () => {
    const before = await call('plan_list', { agent: PAD });
    assert.equal(before.data.count, 0, 'starts empty');
    assert.ok(!fs.existsSync(path.join(PAD_PLANS, 'plans')), 'no folder yet — it is created by the first write');

    const w = await call('plan_write', {
      agent: PAD, path: '10-first.md', session: 'ses_abc123',
      content: '# First plan\n\n## Status: In progress (2026-09-29) — 1/2 done\n',
    });
    assert.ok(!w.isError, `write succeeds: ${w.text}`);
    assert.equal(w.data.path, '10-first.md');
    assert.equal(w.data.session, 'ses_abc123');

    const after = await call('plan_list', { agent: PAD });
    assert.equal(after.data.count, 1, 'the list sees it');
    assert.equal(after.data.plans[0].status, 'In progress (2026-09-29) — 1/2 done', 'the ## Status: header is data, not prose to re-read');
  });

  it('1a: the frontmatter is written, is parseable, and holds what it claims', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', session: 'ses_abc123', content: '# First plan\n\nbody\n' });
    const raw = fs.readFileSync(path.join(PAD_PLANS, 'plans', '10-first.md'), 'utf8');
    const parsed = plans.parseFrontmatter(raw);
    assert.equal(parsed.data.session, 'ses_abc123');
    assert.ok(parsed.data.created, 'created stamped');
    assert.ok(parsed.data.started, 'started stamped on first session bind');
    assert.ok(parsed.data.last_activity, 'last_activity stamped');
    assert.equal(parsed.data.done, undefined, 'not done — nothing decided that');
    assert.equal(parsed.body.trim(), '# First plan\n\nbody', 'the body is untouched, frontmatter stripped');
    // A plan must stay readable with `exec cat` — the file itself, not a blob.
    assert.ok(raw.startsWith('---\n'), 'frontmatter is the first thing in the file');
  });

  it('1a: created never moves and last_activity always moves', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', content: '# v1\n' });
    const first = plans.parseFrontmatter(fs.readFileSync(path.join(PAD_PLANS, 'plans', '10-first.md'), 'utf8')).data;
    // Millisecond resolution: sleep past it or the assertion is a coin flip.
    await new Promise((r) => setTimeout(r, 5));
    await call('plan_write', { agent: PAD, path: '10-first.md', content: '# v2\n' });
    const second = plans.parseFrontmatter(fs.readFileSync(path.join(PAD_PLANS, 'plans', '10-first.md'), 'utf8')).data;
    assert.equal(second.created, first.created, 'created is set once');
    assert.notEqual(second.last_activity, first.last_activity, 'last_activity is bumped — this is what makes the list answer "what is live"');
  });

  it('1a: ageMs/idleMs/elapsedMs are derived, and idleMs is null rather than infinite for a fresh plan', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', session: 'ses_abc123', content: '# x\n' });
    const r = await call('plan_list', { agent: PAD });
    const row = r.data.plans[0];
    assert.equal(typeof row.ageMs, 'number', 'ageMs derived from created');
    assert.equal(typeof row.idleMs, 'number', 'idleMs derived from last_activity');
    assert.equal(typeof row.elapsedMs, 'number', 'elapsedMs derived from started');
    const fresh = plans.describe({}, '# x\n', { now: Date.now() });
    assert.equal(fresh.idleMs, null, 'no last_activity means "never touched", not "infinitely idle"');
  });

  it('plan_write never leaves two frontmatter blocks, even if the caller pastes the file back', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', content: '# v1\n' });
    const raw = fs.readFileSync(path.join(PAD_PLANS, 'plans', '10-first.md'), 'utf8');
    const r = await call('plan_write', { agent: PAD, path: '10-first.md', content: raw + '\nmore\n' });
    assert.ok(!r.isError, r.text);
    const after = fs.readFileSync(path.join(PAD_PLANS, 'plans', '10-first.md'), 'utf8');
    assert.equal((after.match(/^---$/gm) || []).length, 2, 'exactly one frontmatter block');
    assert.ok(after.includes('more'), 'the caller body is kept');
  });

  it('3d: a plan path may not leave plans/, and a pad with no host view refuses with a code', async () => {
    const escape = await call('plan_write', { agent: PAD, path: '../../etc/pwn.md', content: 'x' });
    assert.ok(escape.isError, 'traversal refused');
    assert.ok(/plan_path_invalid/.test(escape.text), `codes it: ${escape.text}`);
    assert.ok(!fs.existsSync('/etc/pwn.md'), 'really did not write');

    const outside = await call('plan_list', { agent: OUTSIDE });
    assert.ok(outside.isError, 'a pad mounted from outside the project root refuses');
    assert.ok(/plan_workspace_not_host_visible/.test(outside.text), `codes it: ${outside.text}`);
  });

  it('a pad whose workspace is NOT browsable refuses plan_write AND plan_list — the same gate, not a second policy', async () => {
    // The regression this pins: a private `fs.writeFileSync` inside the plans
    // service puts a file on a pad the user refused, while workspace_write on
    // the same pad says no. Two gates, two answers, one facility.
    //
    // The mount is the real project root so `containerViewOf` resolves it the
    // way it does in production — a refusal test writes nothing, and if the gate
    // is ever broken the stray file is named in the failure below.

    const w = await call('plan_write', { agent: NOT_OPTED, path: '99-refused.md', content: '# nope\n' });
    assert.ok(w.isError, 'plan_write refuses a pad that may not be browsed');
    assert.match(w.text, /host browsing is not enabled/i, `and it says the SAME reason workspace_write gives (got: ${w.text})`);
    assert.ok(!fs.existsSync(path.join(PROJECT, 'plans', '99-refused.md')), 'nothing was written into the real project');

    // A read tool must obey it too, or plan_list is the retired workspace_list
    // wearing a plan-shaped hat.
    const l = await call('plan_list', { agent: NOT_OPTED });
    assert.ok(l.isError, 'plan_list refuses the same pad');
    assert.match(l.text, /host browsing is not enabled/i, `same reason on the read side (got: ${l.text})`);
  });

  it('plan_write is BUILT ON workspace_write, not a private writer', async () => {
    // The requirement, pinned as behaviour: the file is produced by the
    // workspace service, so the write and the gate are the same code. A private
    // `fs.writeFileSync` here would be correct on every pad the tests happen to
    // have and would quietly bypass the host-browsability gate on one they do
    // not — the refusal would then depend on a different function happening to
    // run first, which is exactly the gate-then-act split.
    const workspaceSvc = require('../services/workspace');
    const real = workspaceSvc.writeFile;
    const realMk = workspaceSvc.createDirectories;
    const calls = [];
    workspaceSvc.writeFile = async (name, rel, content, scope) => {
      calls.push({ name, rel, scope });
      return real(name, rel, content, scope);
    };
    workspaceSvc.createDirectories = async (name, rel, scope) => {
      calls.push({ mkdir: rel });
      return realMk(name, rel, scope);
    };
    try {
      const w = await call('plan_write', { agent: PAD, path: '77-delegation.md', content: '# d\n' });
      assert.ok(!w.isError, `the write succeeded (${w.text})`);
      const write = calls.find((c) => c.rel && c.rel.includes('77-delegation.md'));
      assert.ok(write, 'the workspace service wrote the file, with a path relative to the browse root');
      assert.equal(write.name, PAD, 'and it was the resolved pad, not the caller\'s spelling');
      assert.ok(calls.some((c) => c.mkdir), 'the plans/ folder was created through the same service');
      // Clamping lives in the plan path, so the service is handed a path that is
      // already inside plans/ — it is not asked to second-guess the shape.
      assert.match(write.rel, /plans\/77-delegation\.md$/, `relative to the browse root (got ${write.rel})`);
    } finally {
      workspaceSvc.writeFile = real;
      workspaceSvc.createDirectories = realMk;
    }
  });

  it('the folder explains itself: a harness README is written on the first plan, and once only', async () => {
    const w = await call('plan_write', { agent: PAD, path: '88-readme.md', content: '# first\n' });
    assert.ok(!w.isError, 'the write succeeded');
    const readme = path.join(PAD_PLANS, 'plans', 'README.md');
    assert.ok(fs.existsSync(readme), 'the harness prompt exists in plans/');
    const text = fs.readFileSync(readme, 'utf8');
    assert.match(text, /plan_write/, 'it names the tool that writes here');
    assert.match(text, /plan_list/, 'and the one that reads them');
    assert.match(text, /archive/i, 'and how a plan is ended');
    // Written ONCE: a second plan must not rewrite instructions a caller may be
    // reading right now.
    const before = fs.statSync(readme).mtimeMs;
    await call('plan_write', { agent: PAD, path: '89-second.md', content: '# second\n' });
    assert.equal(fs.statSync(readme).mtimeMs, before, 'the README is never overwritten');
    // And it is NOT a plan: a row with no created and no Status would read as
    // work nobody started.
    const l = await call('plan_list', { agent: PAD });
    const paths = (l.data.plans || []).map((p) => p.path);
    assert.ok(!paths.includes('README.md'), 'the README is not listed as a plan');
  });

  it('plan_list narrowed by path returns THAT plan with its body, and says so when there is none', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', content: '# First\n\n## Status: In progress\n\nThe body.\n' });
    const one = await call('plan_list', { agent: PAD, path: '10-first.md' });
    assert.ok(!one.isError, 'narrowing is not an error');
    assert.equal(one.data.count, 1, 'exactly one row');
    assert.equal(one.data.plans[0].path, '10-first.md');
    assert.match(one.data.plans[0].body, /The body\./, 'and the BODY — a one-row title list would send the caller to exec cat');
    assert.equal(one.data.plans[0].status, 'In progress', 'the ## Status: header came through');

    // A name that is not there is NOT an empty success: "no such plan" and "here
    // are zero plans" are different facts and the caller cannot tell them apart
    // from an empty array.
    const miss = await call('plan_list', { agent: PAD, path: '99-nope.md' });
    assert.ok(!miss.isError, 'a missing plan is an answer, not a crash');
    assert.equal(miss.data.found, false, 'found:false is explicit');
    assert.match(miss.data.hint, /list/i, 'and it says how to see what is there');

    // Still clamped: a path may not leave the folder even through the read side.
    const out = await call('plan_list', { agent: PAD, path: '../../../etc/hosts.md' });
    assert.ok(out.isError, 'traversal refused on the read side too');
    assert.match(out.text, /may not leave the plans\/ folder/, 'with the same clamping message');
  });

  it('a PAD that never ran its agent says empty-store, not unreadable', () => {
    // The 0-byte db a stopped PAD leaves behind opens fine and then fails on
    // first query. "unreadable: no such table: session" is true and useless;
    // the actionable answer is that there is no schema yet.
    const at = path.join(WS, 'empty-data');
    fs.mkdirSync(path.join(at, 'data', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(at, 'data', 'opencode', 'opencode.db'), '');
    const row = { name: 'pad-plans-empty', agent_type: 'opencode', status: 'stopped', workspace_root: at, workspace_mount: null };
    const r = agentStore.readActivity(row, 'ses_x');
    assert.equal(r.store.available, false);
    assert.equal(r.store.reason, 'empty-store', 'a never-run pad is not a corrupt store');
    assert.equal(r.padRunning, null);
  });

  it('a STOPPED pad still answers, with padRunning:false and the same transcript', () => {
    // The plan's own verification item. The store lives in the agent data dir on
    // the host, so the read never touches the container: a pad being down
    // changes what we say about it, not what we can see.
    const at = path.join(WS, 'live-data');
    fs.mkdirSync(path.join(at, 'data', 'opencode'), { recursive: true });
    const db = new Database(path.join(at, 'data', 'opencode', 'opencode.db'));
    // The REAL opencode schema, trimmed to the columns the reader touches. A
    // hand-written table that omits `directory` fails with "no such column",
    // which says nothing about the behaviour under test.
    db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, workspace_id text,
      parent_id text, slug text NOT NULL, directory text NOT NULL, path text, title text NOT NULL,
      version text NOT NULL, share_url text, time_created integer, time_updated integer)`);
    db.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)');
    db.exec('CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)');
    db.prepare('INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)')
      .run('ses_stopped', 'prj', 'stopped', '/www2/paddock', 'A stopped pad', '1.0.0', 1000, 2000);
    const msgIns = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)');
    const partIns = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)');
    const addMessage = (id, role, at) => msgIns.run(id, 'ses_stopped', at, at, JSON.stringify({ role }));
    const addPart = (id, messageId, data) => partIns.run(id, messageId, 'ses_stopped', at1(), 1, JSON.stringify(data));
    const at1 = () => 1;
    addMessage('m1', 'user', 1000);
    addPart('p1', 'm1', { type: 'text', text: 'the newest user turn' });
    addMessage('m2', 'assistant', 2000);
    addPart('p2', 'm2', { type: 'tool', tool: 'bash', state: { status: 'completed' } });
    // The newest assistant STEP is prose with no tool in it — which is the
    // normal shape at the end of a turn, and the shape that made an earlier
    // version report `lastToolCall: null` on a session that had plainly just
    // run something.
    addMessage('m3', 'assistant', 3000);
    addPart('p3', 'm3', { type: 'text', text: 'and here is the answer' });
    db.close();
    const row = { name: 'pad-plans-stopped', agent_type: 'opencode', status: 'stopped', workspace_root: at, workspace_mount: null };
    const r = agentStore.readActivity(row, 'ses_stopped', { agentRunning: false });
    assert.equal(r.store.available, true, 'the transcript is readable while the pad is down');
    assert.equal(r.padRunning, false, 'and the row says the pad is not running');
    assert.equal(r.title, 'A stopped pad');
    assert.equal(r.lastMessage.user.text, 'the newest user turn');
    assert.equal(r.lastMessage.assistant.text, 'and here is the answer');
    assert.ok(r.lastToolCall, 'the tool call one step back is still found');
    assert.equal(r.lastToolCall.tool, 'bash');
    assert.equal(r.lastToolCall.status, 'completed');
  });

  it('a PAD NAME is not a PAD ROW — readActivity resolves it instead of answering no-store', () => {
    // locate() keys off agent_type, so a string argument reported "this pad
    // keeps no transcript" about a pad with hundreds of messages: a wrong
    // answer with the confidence of a real one.
    assert.throws(() => agentStore.readActivity('pad-not-a-real-pad', 'ses_x'), (e) => /not found/i.test(e.message));
  });

  describe('codex/claude rollout readers, pinned to a REAL file', () => {
    // Every row below is a verbatim shape from a real rollout on pad-test-codex
    // (2026-09-24), copied field-for-field. The reader was written against this
    // and not against the rollout format as remembered: the shapes I expected
    // (user_message / agent_message as top-level types) match NOTHING in a real
    // file, which is how a reader returns three nulls and reads as "idle".
    const REAL = [
      { timestamp: '2026-09-24T10:59:32.501Z', type: 'session_meta', payload: { session_id: '01a0d312-1363-73b1-b3e3-b31093ea7e7e', id: '01a0d312-1363-73b1-b3e3-b31093ea7e7e', cwd: '/root/.codex/workspace' } },
      { timestamp: '2026-09-24T10:59:32.646Z', type: 'response_item', payload: { type: 'message', id: 'msg_1', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>…injected…' }] } },
      { timestamp: '2026-09-24T10:59:32.646Z', type: 'response_item', payload: { type: 'message', id: 'msg_2', role: 'user', content: [{ type: 'input_text', text: '<environment_context>the machine talking to itself</environment_context>' }] } },
      { timestamp: '2026-09-24T10:59:32.647Z', type: 'turn_context', payload: { turn_id: 't1', cwd: '/root/.codex/workspace' } },
      { timestamp: '2026-09-24T10:59:32.667Z', type: 'event_msg', payload: { type: 'user_message', message: 'Say pineapple', images: [], local_images: [], audio: [], local_audio: [] } },
      { timestamp: '2026-09-24T10:59:33.000Z', type: 'response_item', payload: { type: 'message', id: 'msg_3', role: 'assistant', content: [{ type: 'output_text', text: 'first answer' }] } },
      { timestamp: '2026-09-24T10:59:40.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{\"cmd\":\"ls\"}' } },
      { timestamp: '2026-09-24T10:59:41.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' } },
      { timestamp: '2026-09-24T10:59:42.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'and now something else', images: [] } },
      { timestamp: '2026-09-24T10:59:50.000Z', type: 'response_item', payload: { type: 'message', id: 'msg_4', role: 'assistant', content: [{ type: 'output_text', text: 'second answer' }] } },
      { timestamp: '2026-09-24T10:59:55.000Z', type: 'response_item', payload: { type: 'function_call', call_id: 'call_2', name: 'shell', arguments: '{\"cmd\":\"sleep 9\"}' } },
    ];

    /** Write a codex store: sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl */
    const codexPad = (rows, uuid) => {
      const at = path.join(WS, 'codex-' + (uuid || 'u1'));
      const day = path.join(at, 'codex', 'sessions', '2026', '09', '24');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(
        path.join(day, 'rollout-2026-09-24T16-29-32-' + (uuid || '01a0d312-1363-73b1-b3e3-b31093ea7e7e') + '.jsonl'),
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
      );
      return { name: 'pad-plans-codex', agent_type: 'codex', status: 'running', workspace_root: at, workspace_mount: null };
    };

    const UUID = '01a0d312-1363-73b1-b3e3-b31093ea7e7e';

    it('reads a real rollout: the HUMAN turn, not the machine\'s injected context', () => {
      const r = agentStore.readActivity(codexPad(REAL), UUID);
      assert.equal(r.store.available, true);
      // The newest user turn. The "role: user" response_item is the environment
      // block the runtime injects — reading lastMessage from THAT is how a
      // conversation looks like it is talking to itself.
      assert.equal(r.lastMessage.user.text, 'and now something else');
      assert.equal(r.lastMessage.assistant.text, 'second answer');
      assert.equal(r.session, UUID);
      assert.equal(r.directory, '/root/.codex/workspace');
    });

    it('the NEWEST message wins, not the first one in the file', () => {
      // Control: the rows are chronological, so a reader that kept the FIRST
      // match reported the opening ask as the newest turn of a whole session.
      const r = agentStore.readActivity(codexPad(REAL), UUID);
      assert.notEqual(r.lastMessage.user.text, 'Say pineapple');
      assert.notEqual(r.lastMessage.assistant.text, 'first answer');
      // codex stores no title, so the opening ask answers "what is this".
      assert.equal(r.title, 'Say pineapple');
    });

    it('an unanswered tool call is RUNNING, not completed', () => {
      const r = agentStore.readActivity(codexPad(REAL), UUID);
      assert.equal(r.lastToolCall.tool, 'shell');
      // call_2 has no output row; call_1 does. "completed" for the in-flight one
      // is the quiet lie.
      assert.equal(r.lastToolCall.status, 'running');
      const done = agentStore.readActivity(codexPad(REAL.slice(0, 8), UUID), UUID);
      assert.equal(done.lastToolCall.status, 'completed', 'a call that answered is completed');
    });

    it('an unknown row shape costs a field, never the whole answer', () => {
      const r = agentStore.readActivity(
        codexPad([...REAL, { timestamp: '2026-09-29T09:00:00.000Z', type: 'response_item', payload: { type: 'some_new_thing', surprise: true } }], UUID),
        UUID
      );
      assert.equal(r.store.available, true);
      assert.equal(r.lastMessage.assistant.text, 'second answer');
    });

    it('a session id that matches no file is refused WITH candidates, not answered with another session', () => {
      // TWO files, so "the only one in the store" is not an unambiguous guess.
      // With one file the guess is deliberate (next test); with several it is a
      // coin flip, and the old fallback made that flip silently.
      const row = codexPad(REAL, 'aaaaaaaa-1111-2222-3333-444444444444');
      const day = path.join(row.workspace_root, 'codex', 'sessions', '2026', '09', '25');
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(
        path.join(day, 'rollout-2026-09-25T09-00-00-cccccccc-1111-2222-3333-444444444444.jsonl'),
        REAL.map((r) => JSON.stringify(r)).join('\n') + '\n'
      );
      const r = agentStore.readActivity(row, 'bbbbbbbb-9999-8888-7777-666666666666');
      assert.equal(r.store.available, false);
      assert.equal(r.store.reason, 'session-not-found');
      assert.equal(r.lastMessage, null);
      // The old fallback read the five newest files and returned the first that
      // parsed, so a wrong id returned a real transcript of a different session.
      assert.ok(r.store.candidates.some((c) => c.includes('aaaaaaaa-1111')));
      assert.equal(r.store.candidatesTotal, 2);
    });

    it('a store with exactly ONE file is the one unambiguous guess, and says so', () => {
      const r = agentStore.readActivity(codexPad(REAL), 'a-completely-different-id');
      assert.equal(r.store.available, true);
      assert.equal(r.matched, 'only-file');
    });

    it('claude: last wins, and a tool_use block is a tool call', () => {
      const at = path.join(WS, 'claude-1');
      const dir = path.join(at, 'claude', 'projects', '-root-www2-paddock');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '11111111-2222-3333-4444-555555555555.jsonl'), [
        { type: 'user', cwd: '/root/www2/paddock', message: { role: 'user', content: [{ type: 'text', text: 'the first ask' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the first answer' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'the newest ask' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the newest answer' }, { type: 'tool_use', name: 'Bash' }] } },
      ].map((r) => JSON.stringify(r)).join('\n') + '\n');
      const row = { name: 'pad-plans-claude', agent_type: 'claude', status: 'running', workspace_root: at, workspace_mount: null };
      const r = agentStore.readActivity(row, '11111111-2222-3333-4444-555555555555');
      assert.equal(r.lastMessage.user.text, 'the newest ask');
      assert.equal(r.lastMessage.assistant.text, 'the newest answer');
      assert.equal(r.lastToolCall.tool, 'Bash');
      assert.equal(r.directory, '/root/www2/paddock');
    });

    it('claude: a tool_use with no tool_result is RUNNING, not completed', () => {
      // The lie this pins: claude writes `tool_use` when it ASKS for the call and
      // `tool_result` in a later user message, so an unanswered tool_use is a call
      // in flight. It read `completed` because there was no real claude store to
      // check it against — the same verdict codex gets from its output rows.
      const at = path.join(WS, 'claude-2');
      const dir = path.join(at, 'claude', 'projects', '-root-www2-paddock');
      fs.mkdirSync(dir, { recursive: true });
      const ID = '99999999-8888-7777-6666-555555555555';
      const write = (rows) => fs.writeFileSync(path.join(dir, `${ID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const row = { name: 'pad-plans-claude', agent_type: 'claude', status: 'running', workspace_root: at, workspace_mount: null };

      write([
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'run it' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }] } },
      ]);
      assert.equal(agentStore.readActivity(row, ID).lastToolCall.status, 'running', 'unanswered tool_use is in flight');

      write([
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'run it' }] } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash' }] } },
        { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] } },
      ]);
      const done = agentStore.readActivity(row, ID).lastToolCall;
      assert.equal(done.status, 'completed', 'a tool_use with its result behind it is finished');
      assert.equal(done.tool, 'Bash', 'and the result row does not become the tool call');
    });
  });

  it('the plan_activity description states the store reasons AND the redaction boundary', async () => {
    // A tool that reads a transcript has to say what "unavailable" means and
    // what gets scrubbed, because both are guesses otherwise. The prose
    // boundary in particular is a DECISION (free text is not pattern-matched),
    // so it belongs in a test: an implementation that quietly starts scrubbing
    // sentences, or quietly stops scrubbing config, changes this contract.
    const t = (await client.listTools()).tools.find((x) => x.name === 'plan_activity');
    for (const reason of ['no-store', 'empty-store', 'unreadable', 'session-not-found']) {
      assert.ok(t.description.includes(reason), 'the description names the reason ' + reason);
    }
    assert.ok(t.description.includes('candidates'), 'a session-not-found refusal says it names candidates');
    assert.ok(/STOPPED pad/.test(t.description), 'it says a stopped pad still answers');
    assert.ok(/prose/i.test(t.description) && /not pattern-matched/i.test(t.description),
      'it states that free prose is NOT pattern-matched');
    assert.ok(/headers/.test(t.description), 'it states what IS scrubbed (shape, not a list of names)');
  });

  it('a bound plan carries its conversation state, and "untracked" is not "dead"', async () => {
    // The spec asks plan_list to answer "is the conversation behind this plan
    // still running?". Mission owns those fields, so they are stamped from
    // there — a plan whose session has no Mission row is reported UNTRACKED,
    // which is a different statement from a plan whose session is dead.
    const live = await call('plan_write', { agent: PAD, path: 'zz-stamp.md', content: 'A bound plan', session: 'ses_stamp' });
    assert.ok(!live.isError, 'the write succeeded: ' + JSON.stringify(live).slice(0, 200));
    const listed = await call('plan_list', { agent: PAD });
    const row = listed.data.plans.find((p) => p.path === 'zz-stamp.md');
    assert.ok(row, 'the plan is listed');
    assert.equal(row.session, 'ses_stamp');
    assert.equal(row.sessionTracked, false, 'no Mission row for this id in the test DB');
    assert.equal(row.sessionLive, null, 'unknown, NOT false — "not tracked" is not "dead"');
    assert.ok('sessionLive' in row, 'the field is present so a caller can tell it apart from a missing one');
  });

  it('3f: a TRACKED session is stamped with its state AND its project, and folder scopes the listing', async () => {
    // The untracked test above proves "not in the page" != "dead". This one proves
    // the other half: a session the page DOES know comes back with real liveness
    // and, crucially, the project it belongs to — that link is what makes a
    // Mission project's progress answerable (plan 64 §3f), and it exists only
    // because the stamp reads the session's own project rather than a folder.
    const mission = require('../services/mission');
    const project = mission.createProject({ name: 'zz-progress', agent: PAD, folder: '/root/www2/paddock' });
    const session = mission.createSession(project.id, { label: 'progress pad', agentSessionId: 'ses_stamp' });

    await call('plan_write', { agent: PAD, path: 'zz-tracked.md', content: 'A tracked plan', session: 'ses_stamp' });
    await call('plan_write', { agent: PAD, path: 'zz-elsewhere.md', content: 'Another project', session: 'ses_other' });
    // And one plan the page knows nothing about, to be the unattributable one.
    await call('plan_write', { agent: PAD, path: 'zz-orphan.md', content: 'Started outside the page', session: 'ses_nobody' });

    const row = (await call('plan_list', { agent: PAD })).data.plans.find((p) => p.path === 'zz-tracked.md');
    assert.equal(row.sessionTracked, true, 'the page knows this conversation');
    assert.equal(typeof row.sessionLive, 'boolean', 'liveness is a real answer now, not a null');
    assert.equal(row.sessionLabel, 'progress pad', 'the label comes from the Mission row');
    assert.deepEqual(row.sessionProject, { id: project.id, name: 'zz-progress', folder: '/root/www2/paddock' },
      'the plan carries the project of its bound session');

    const scoped = await call('plan_list', { agent: PAD, folder: '/root/www2/paddock' });
    const paths = scoped.data.plans.map((p) => p.path);
    assert.ok(paths.includes('zz-tracked.md'), 'the matching plan is kept');
    assert.ok(!paths.includes('zz-elsewhere.md'), 'a plan of another project is not');
    assert.equal(scoped.data.sessionUnattributed, 2,
      'unattributable plans are COUNTED, not dropped silently (a short answer that looks complete is the failure)');
    assert.ok(scoped.data.folder, 'the scope is echoed');

    // An unmatched folder is an empty answer, not everything.
    const none = await call('plan_list', { agent: PAD, folder: '/root/nowhere' });
    assert.equal(none.data.count, 0, 'a folder with no plans is an empty list');
    assert.equal(none.data.sessionUnattributed, 2, 'and it still says what it could not attribute');

    mission.deleteSession(session.id);
    mission.deleteProject(project.id);
  });

  it('a folder filter is refused before it can leak, and the description explains the linkage', async () => {
    const t = (await client.listTools()).tools.find((x) => x.name === 'plan_list');
    assert.ok(t.description.includes('sessionProject'), 'the tool says where a plan\'s project comes from');
    assert.ok(t.inputSchema.properties.folder, 'folder is an input');
    // It must not be REQUIRED: the whole listing is the common case.
    assert.ok(!t.inputSchema.required.includes('folder'), 'folder stays optional');
  });

  it('`path` + `folder` is REFUSED — the one-file branch returns before the scope runs', async () => {
    // The silent version of this bug is worse than a wrong answer: the caller
    // asks for one plan INSIDE a project, the handler takes the `path` branch and
    // returns that file with no indication the filter never ran, and the caller
    // concludes the plan belongs to the project. Two different questions, so the
    // combination is refused and the message names the call that answers it.
    await call('plan_write', { agent: PAD, path: 'zz-both.md', content: 'A plan', session: 'ses_both' });
    const r = await call('plan_list', { agent: PAD, path: 'zz-both.md', folder: '/root/www2/paddock' });
    assert.equal(r.isError, true, 'the combination is an error, not a scoped answer');
    assert.ok(/plan_path_and_folder/.test(r.text), `refused with a code the caller can branch on (got: ${r.text})`);
    assert.ok(/path/.test(r.text) && /folder/.test(r.text), 'and the message says which is which');
    assert.equal(r.data, null, 'nothing is returned as if it had been scoped');
  });

  it('3d: agent is REQUIRED on every plan tool', async () => {
    const tools = (await client.listTools()).tools;
    for (const name of ['plan_list', 'plan_write', 'plan_activity']) {
      const t = tools.find((x) => x.name === name);
      assert.ok(t.inputSchema.required.includes('agent'), `${name} requires agent (got ${JSON.stringify(t.inputSchema.required)})`);
    }
    // And the write's other arguments stay required — making `agent` required
    // must not have made a plan write without a path possible.
    const write = tools.find((x) => x.name === 'plan_write');
    assert.ok(write.inputSchema.required.includes('path') && write.inputSchema.required.includes('content'), 'path and content stay required');
    assert.ok(!write.inputSchema.required.includes('session'), 'session is optional — a plan can be filed before it is worked in');
  });

  it('the archive is a separate listing, not a second copy of the same plans', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', content: '# x\n' });
    fs.mkdirSync(path.join(PAD_PLANS, 'plans', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(PAD_PLANS, 'plans', 'archive', '01-old.md'), '# old\n\n## Status: Complete (2026-01-01)\n');
    const live = await call('plan_list', { agent: PAD });
    const arch = await call('plan_list', { agent: PAD, archive: true });
    assert.equal(live.data.count, 1, 'the live folder does not include the archive');
    assert.equal(arch.data.count, 1, 'the archive lists on its own');
    assert.equal(arch.data.plans[0].status, 'Complete (2026-01-01)');
  });

  it('a plan with malformed frontmatter is still LISTED, with the reason on the row', async () => {
    fs.mkdirSync(path.join(PAD_PLANS, 'plans'), { recursive: true });
    fs.writeFileSync(path.join(PAD_PLANS, 'plans', '99-broken.md'), '---\nsession: ses_x\nwhen: yesterday\n---\n# broken\n');
    const r = await call('plan_list', { agent: PAD });
    assert.ok(r.isError === false);
    const row = r.data.plans.find((p) => p.path === '99-broken.md');
    assert.ok(row, 'a malformed plan is not hidden from the listing');
    assert.ok(/when/.test(row.unreadable || ''), `carries the reason: ${row.unreadable}`);
  });

  // --- grants -------------------------------------------------------------

  it('plan_write is not in the read bucket; plan_list and plan_activity are', async () => {
    // Behaviour, not internals: a read-only key may read, and may NOT write.
    // `read` alone — adding `default` would make it a FULL key, which is a
    // different thing entirely and would answer true to everything.
    const readOnly = { userId: 'user-1', role: 'user', scopes: ['read'] };
    assert.equal(toolAllowed(readOnly, 'plan_list', PAD), true, 'a read-only key may list plans');
    assert.equal(toolAllowed(readOnly, 'plan_activity', PAD), true, 'a read-only key may read activity');
    assert.equal(toolAllowed(readOnly, 'plan_write', PAD), false, 'a read-only key may NOT write a plan');
  });

  it('an unknown pad is refused before the facility is touched', async () => {
    const r = await call('plan_list', { agent: 'pad-does-not-exist' });
    assert.ok(r.isError);
    assert.ok(/not found/i.test(r.text), r.text);
  });
});

describe('plans service (plan 64 §1a)', () => {
  it('frontmatter rejects an unknown key rather than guessing', () => {
    assert.throws(() => plans.parseFrontmatter('---\nnope: 1\n---\n# x'), /plan_frontmatter_invalid|Unknown frontmatter key/);
  });

  it('frontmatter rejects a non-ISO timestamp, so a bad stamp cannot become a bad answer', () => {
    assert.throws(() => plans.parseFrontmatter('---\ncreated: last tuesday\n---\n# x'), /ISO timestamp/);
  });

  it('a file with no frontmatter is all body, not an error', () => {
    const { data, body } = plans.parseFrontmatter('# just a plan\n');
    assert.deepEqual(data, {});
    assert.equal(body, '# just a plan\n');
  });

  it('a session id is kept verbatim — it is the agent\'s own, and the resolver must not reshape it', () => {
    const { data } = plans.parseFrontmatter('---\nsession: ses_ABC:123\n---\n# x');
    assert.equal(data.session, 'ses_ABC:123', 'a colon in a value does not truncate it');
  });
});

describe('agent-store (plan 64 §4d)', () => {
  it('an unknown session is available:false with a reason, never an empty success', () => {
    const agent = { agent_type: 'opencode', workspace_root: path.join(WS, 'nope'), name: 'x', status: 'exited' };
    const r = agentStore.readActivity(agent, 'ses_missing', { agentRunning: false });
    assert.equal(r.store.available, false);
    assert.equal(r.store.reason, 'no-store');
    assert.equal(r.padRunning, false);
    assert.equal(r.lastMessage, null);
  });

  it('a driver with no store says no-store, it does not invent an empty transcript', () => {
    const agent = { agent_type: 'hermes', workspace_root: WS, name: 'x', status: 'running' };
    const r = agentStore.readActivity(agent, 'anything', { agentRunning: true });
    assert.equal(r.store.available, false);
    assert.equal(r.store.reason, 'no-store');
  });

  it('padRunning and store.available are reported independently', () => {
    // A stopped pad with no store: the two fields must not be collapsed, because
    // a dead container and an unreadable transcript are different problems.
    const agent = { agent_type: 'opencode', workspace_root: path.join(WS, 'nope'), name: 'x', status: 'exited' };
    const r = agentStore.readActivity(agent, 'ses_x', { agentRunning: false });
    assert.equal(r.padRunning, false);
    assert.equal(r.store.available, false);
  });

  it('a secret in a DUMPED config is redacted — plan 60, in the shape a transcript actually has it', () => {
    // The realistic leak is not a key in our output object: it is the agent
    // running `cat ~/.config/.../config.json`, so the secret arrives inside a
    // single string with no key for a walker to stop at. Shape, not key name.
    const dumped = redactSecrets({
      lastToolCall: { name: 'bash', output: '{\n  "api_key": "sk-live-ABC123DEF456",\n  "model": "gpt"\n}' },
    });
    assert.ok(!JSON.stringify(dumped).includes('sk-live-ABC123DEF456'), 'the dumped secret is gone');
    assert.ok(JSON.stringify(dumped).includes('gpt'), 'and the rest of the output survives — redaction is not destruction');
    // A nested key-shaped field is still covered (headers, at any depth).
    assert.ok(!JSON.stringify(redactSecrets({ a: { b: { headers: { authorization: 'Bearer sk-x' } } } })).includes('sk-x'), 'headers.authorization');
    // Prose that merely DISCUSSES a key is left readable: mangling the very text
    // this tool exists to show would corrupt the answer to be safe. The boundary
    // is stated in the tool description, not left for a caller to discover.
    const said = redactSecrets({ lastMessage: { user: { text: 'my key is sk-live-ABC123DEF456' } } });
    assert.equal(said.lastMessage.user.text, 'my key is sk-live-ABC123DEF456', 'free prose is not pattern-scrubbed');
  });});
