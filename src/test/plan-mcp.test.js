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
      workspace_mount: { host: '/mnt/nowhere', container: '/mnt/x', hostBrowsable: false, hostBrowseReason: 'outside' },
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
    // Plan 82: `status` is the canonical lifecycle word, `statusRaw` keeps the
    // header verbatim. Both are asserted, because the pair is the whole point —
    // the canonical value is what a caller branches on, and the raw one is what
    // proves nothing was lost folding a dated/commented header onto it.
    assert.equal(after.data.plans[0].status, 'in progress', 'the ## Status: header folds onto a canonical value');
    assert.equal(after.data.plans[0].statusRaw, 'In progress (2026-09-29) — 1/2 done', 'the raw header is preserved verbatim');
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

  it('the folder explains itself: an INDEX.md is written on the first plan, and once only', async () => {
    const w = await call('plan_write', { agent: PAD, path: '88-readme.md', content: '# first\n' });
    assert.ok(!w.isError, 'the write succeeded');
    const index = path.join(PAD_PLANS, 'plans', 'INDEX.md');
    assert.ok(fs.existsSync(index), 'the entry file exists in plans/');
    const text = fs.readFileSync(index, 'utf8');
    assert.match(text, /plan_write/, 'it names the tool that writes here');
    assert.match(text, /plan_list/, 'and the one that reads them');
    assert.match(text, /archive/i, 'and how a plan is ended');
    // The five lifecycle rules and the stop rule are the LLM's instructions.
    assert.match(text, /blocked/i, 'the blocked state is stated');
    assert.match(text, /need clarification/i, 'and need clarification');
    assert.match(text, /STOP/, 'and that they are STOP states, the core behavioural rule');
    assert.match(text, /QUEUE\.md/, 'and it points at the queue file rather than restating queue rules');
    // Written ONCE: a second plan must not rewrite instructions a caller may be
    // reading right now.
    const before = fs.statSync(index).mtimeMs;
    await call('plan_write', { agent: PAD, path: '89-second.md', content: '# second\n' });
    assert.equal(fs.statSync(index).mtimeMs, before, 'the INDEX is never overwritten');
    // And it is NOT a plan: a row with no created and no Status would read as
    // work nobody started.
    const l = await call('plan_list', { agent: PAD });
    const paths = (l.data.plans || []).map((p) => p.path);
    assert.ok(!paths.includes('INDEX.md'), 'the INDEX is not listed as a plan');
  });

  it('plan_list narrowed by path returns THAT plan with its body, and says so when there is none', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', content: '# First\n\n## Status: In progress\n\nThe body.\n' });
    const one = await call('plan_list', { agent: PAD, path: '10-first.md' });
    assert.ok(!one.isError, 'narrowing is not an error');
    assert.equal(one.data.count, 1, 'exactly one row');
    assert.equal(one.data.plans[0].path, '10-first.md');
    assert.match(one.data.plans[0].body, /The body\./, 'and the BODY — a one-row title list would send the caller to exec cat');
    assert.equal(one.data.plans[0].status, 'in progress', 'the ## Status: header came through');

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
    assert.match(out.text, /may not leave the plans folder/, 'with the same clamping message');
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

  it('3f: a TRACKED session is stamped with its state AND its project', async () => {
    // The untracked test above proves "not in the page" != "dead". This one proves
    // the other half: a session the page DOES know comes back with real liveness
    // and, crucially, the project it belongs to — that link is what makes a
    // Mission project's progress answerable (plan 64 §3f), and it exists only
    // because the stamp reads the session's own project rather than a folder.
    // (Folder-scoped listing is now FILESYSTEM scope, plan 82 — see the
    // project-rooted test below.)
    const mission = require('../services/mission');
    const project = mission.createProject({ name: 'zz-progress', agent: PAD, folder: '/root/www2/paddock' });
    const session = mission.createSession(project.id, { label: 'progress pad', agentSessionId: 'ses_stamp' });

    await call('plan_write', { agent: PAD, path: 'zz-tracked.md', content: 'A tracked plan', session: 'ses_stamp' });

    const row = (await call('plan_list', { agent: PAD })).data.plans.find((p) => p.path === 'zz-tracked.md');
    assert.equal(row.sessionTracked, true, 'the page knows this conversation');
    assert.equal(typeof row.sessionLive, 'boolean', 'liveness is a real answer now, not a null');
    assert.equal(row.sessionLabel, 'progress pad', 'the label comes from the Mission row');
    assert.deepEqual(row.sessionProject, { id: project.id, name: 'zz-progress', folder: '/root/www2/paddock' },
      'the plan carries the project of its bound session');

    mission.deleteSession(session.id);
    mission.deleteProject(project.id);
  });

  it('plan_list/plan_write in PROJECT mode land in <project.folder>/<plans_folder>', async () => {
    const mission = require('../services/mission');
    // A folder inside the opencode driver workspace, so it maps to a real host
    // dir. A SUBfolder, so the project-scoped plans do not coincide with the
    // PAD-wide `plans/` (which a project rooted at the workspace top would).
    const project = mission.createProject({ name: 'zz-project', agent: PAD, folder: '/root/.opencode/workspace/proj' });
    const r = await call('plan_write', { agent: PAD, project_id: project.id, path: 'pr-first.md', content: '# P\n\n## Status: new\n' });
    assert.ok(!r.isError, `write succeeds: ${r.text}`);
    assert.equal(r.data.project_id, project.id, 'the write echoes the project it resolved');
    assert.ok(fs.existsSync(path.join(PAD_PLANS, 'proj', 'plans', 'pr-first.md')), 'the plan lands under the project folder');
    assert.ok(!fs.existsSync(path.join(PAD_PLANS, 'plans', 'pr-first.md')), 'and NOT in the PAD-wide plans/');

    // The project-scoped listing sees it…
    const scoped = await call('plan_list', { agent: PAD, project_id: project.id });
    assert.deepEqual(scoped.data.plans.map((p) => p.path), ['pr-first.md']);
    // …and it is INVISIBLE to the legacy PAD-wide listing (different directory).
    const legacy = await call('plan_list', { agent: PAD });
    assert.ok(!(legacy.data.plans || []).some((p) => p.path === 'pr-first.md'), 'legacy scope does not see project plans');
    // …and a `path` inside the project scope reads ONE file's body (they combine
    // in project mode — the directory is the scope, so path is a file in it).
    const one = await call('plan_list', { agent: PAD, project_id: project.id, path: 'pr-first.md' });
    assert.equal(one.data.found, true);
    assert.match(one.data.plans[0].body, /# P/);

    // Another project on the SAME pad does not see it.
    const other = mission.createProject({ name: 'zz-other', agent: PAD, folder: '/root/.opencode/workspace/sub' });
    const otherList = await call('plan_list', { agent: PAD, project_id: other.id });
    assert.equal(otherList.data.count, 0, 'a sibling project sees none of the first project\'s plans');

    // A custom plans folder moves the directory.
    const custom = mission.createProject({ name: 'zz-custom', agent: PAD, folder: '/root/.opencode/workspace/sub', plansFolder: 'pplans' });
    await call('plan_write', { agent: PAD, project_id: custom.id, path: 'c.md', content: '# C\n' });
    assert.ok(fs.existsSync(path.join(PAD_PLANS, 'sub', 'pplans', 'c.md')), 'the custom plans folder is honoured');

    mission.deleteProject(project.id);
    mission.deleteProject(other.id);
    mission.deleteProject(custom.id);
  });

  it('an explicit bad project is REFUSED, never a fallback to the PAD folder', async () => {
    // The one response a caller cannot tell apart from success: asked for a
    // project, handed the PAD-wide list. Both a miss and an ambiguous folder
    // refuse with candidates.
    const miss = await call('plan_list', { agent: PAD, project_id: 'prj_nope' });
    assert.equal(miss.isError, true, 'an unknown project id is an error');
    assert.ok(/mission_project_not_found/.test(miss.text), `with the code (got: ${miss.text})`);
    // An agent that disagrees with the project is refused, not silently picked.
    const mission = require('../services/mission');
    const project = mission.createProject({ name: 'zz-mismatch', agent: PAD, folder: '/root/.opencode/workspace' });
    const bad = await call('plan_list', { agent: OUTSIDE, project_id: project.id });
    assert.equal(bad.isError, true, 'agent/project disagreement is an error');
    assert.ok(/plan_agent_mismatch/.test(bad.text), `with the mismatch code (got: ${bad.text})`);
    mission.deleteProject(project.id);
  });

  it('3d: scope is required at call time — agent for legacy, or a project (plan 82)', async () => {
    const tools = (await client.listTools()).tools;
    // plan_activity is a session read, not a folder read: it still names a PAD.
    const activity = tools.find((x) => x.name === 'plan_activity');
    assert.ok(activity.inputSchema.required.includes('agent'), 'plan_activity still requires agent');
    // plan_list/plan_write may be scoped by agent OR a project, so `agent` is no
    // longer individually required — the requirement moved to call time.
    for (const name of ['plan_list', 'plan_write']) {
      const t = tools.find((x) => x.name === name);
      const req = t.inputSchema.required || [];
      assert.ok(!req.includes('agent'), `${name} does not require agent (project scope is an alternative)`);
      assert.ok(t.inputSchema.properties.project_id && t.inputSchema.properties.folder, `${name} accepts a project scope`);
      assert.ok(!req.includes('project_id') && !req.includes('folder'),
        `${name} does not REQUIRE a project either — legacy mode is a real mode`);
    }
    const write = tools.find((x) => x.name === 'plan_write');
    const wreq = write.inputSchema.required || [];
    assert.ok(wreq.includes('path') && wreq.includes('content'), 'path and content stay required');
    assert.ok(!wreq.includes('session'), 'session is optional — a plan can be filed before it is worked in');

    // And a call with NO scope at all is refused with its own code, not an
    // unbound crash.
    const r = await call('plan_list', {});
    assert.equal(r.isError, true, 'no scope is an error');
    assert.ok(/plan_scope_required/.test(r.text), `refused with the scope code (got: ${r.text})`);
  });

  it('the archive is a separate listing, not a second copy of the same plans', async () => {
    await call('plan_write', { agent: PAD, path: '10-first.md', content: '# x\n' });
    fs.mkdirSync(path.join(PAD_PLANS, 'plans', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(PAD_PLANS, 'plans', 'archive', '01-old.md'), '# old\n\n## Status: Complete (2026-01-01)\n');
    const live = await call('plan_list', { agent: PAD });
    const arch = await call('plan_list', { agent: PAD, archive: true });
    assert.equal(live.data.count, 1, 'the live folder does not include the archive');
    assert.equal(arch.data.count, 1, 'the archive lists on its own');
    assert.equal(arch.data.plans[0].status, 'done', 'a dated "Complete" header folds onto the canonical done');
    assert.equal(arch.data.plans[0].statusRaw, 'Complete (2026-01-01)', 'and the raw header is preserved');
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

describe('plan status mapping (plan 82)', () => {
  const canon = (body) => plans.describe({}, body, {}).status;
  const raw = (body) => plans.describe({}, body, {}).statusRaw;

  it('folds every header this repo actually uses onto one of the five, case-insensitively', () => {
    const cases = [
      ['## Status: Proposed', 'new'],
      ['## Status: Draft', 'new'],
      ['## Status: new', 'new'],
      ['## Status: In progress', 'in progress'],
      ['## Status: In Progress', 'in progress'],
      ['## Status: Blocked', 'blocked'],
      ['## Status: need clarification', 'need clarification'],
      ['## Status: Needs clarification', 'need clarification'],
      ['## Status: Complete', 'done'],
      ['## Status: done', 'done'],
      ['## Status: finished', 'done'],
      ['## Status: review', 'done'],
    ];
    for (const [line, want] of cases) {
      assert.equal(canon(`# x\n\n${line}\n`), want, `${line} → ${want}`);
    }
  });

  it('keeps a dated/commented header\'s raw text and only maps the canonical value', () => {
    const body = '# x\n\n## Status: In progress (2026-09-29) — 1/2 done\n';
    assert.equal(canon(body), 'in progress', 'the prefix maps');
    assert.equal(raw(body), 'In progress (2026-09-29) — 1/2 done', 'the whole header is preserved verbatim');
  });

  it('never coerces an UNKNOWN header into an actionable state', () => {
    const body = '# x\n\n## Status: wibble\n';
    assert.equal(canon(body), 'wibble', 'an unknown status passes through as itself');
    assert.equal(raw(body), 'wibble');
    assert.notEqual(canon(body), 'new', 'unknown is never silently "new"');
    assert.notEqual(canon(body), 'done', 'unknown is never silently "done"');
  });

  it('reads a header with no Status line as null, not as a state', () => {
    assert.equal(canon('# x\n\nno status here\n'), null);
    assert.equal(raw('# x\n\nno status here\n'), null);
  });

  it('does not read a status from the NEXT line (this plan\'s own two-line header)', () => {
    // "## Status:\nProposed" is a real shape. The old regex required the value
    // on the same line, so it read null; keep that so a reformatted file does
    // not silently change a row's meaning.
    const body = '# x\n\n## Status:\nProposed (2026-01-01)\n';
    assert.equal(raw(body), null, 'no value on the Status line → unknown, not a guess');
    assert.equal(canon(body), null);
  });
});

describe('project-rooted plans folder (plan 82)', () => {
  const agent = () => ({
    ...padRow(PAD),
  });
  const project = (over = {}) => ({
    id: 'prj_1', name: 'paddock', agent_name: PAD, agent_type: 'opencode',
    folder: '/root/.opencode/workspace', plans_folder: 'plans', ...over,
  });

  it('maps the default layout: <workspace_root>/workspace/<rel>/<plans_folder>', () => {
    const a = agent();
    assert.equal(
      plans.projectPlansRoot(a, project()),
      path.join(WS, 'a-data', 'workspace', 'plans')
    );
    assert.equal(
      plans.projectPlansRoot(a, project({ folder: '/root/.opencode/workspace/sub' })),
      path.join(WS, 'a-data', 'workspace', 'sub', 'plans')
    );
    assert.equal(
      plans.projectPlansRoot(a, project({ plans_folder: 'pplans' })),
      path.join(WS, 'a-data', 'workspace', 'pplans')
    );
  });

  it('refuses a folder OUTSIDE the driver workspace rather than inventing a path', () => {
    assert.throws(
      () => plans.projectPlansRoot(agent(), project({ folder: '/root/elsewhere' })),
      (e) => e.code === 'plan_project_folder_outside_workspace'
    );
  });

  it('maps a custom workspace mount through containerViewOf, exactly like plansRoot', () => {
    const a = {
      ...padRow(PAD),
      workspace_root: path.join(WS, 'm-data'),
      workspace_dir: '/workspace',
      workspace_mount: { host: PROJECT, container: '/workspace', webuiVisible: true, hostBrowsable: true },
    };
    // containerViewOf(PROJECT) is the webui's own view of the project root.
    const view = require('../services/vm-manager').containerViewOf(PROJECT);
    assert.ok(view, 'the project root has a webui view in-container');
    assert.equal(plans.projectPlansRoot(a, project({ folder: '/workspace' })), path.join(view, 'plans'));
    assert.equal(
      plans.projectPlansRoot(a, project({ folder: '/workspace/sub' })),
      path.join(view, 'sub', 'plans')
    );
  });

  it('refuses a mount the webui cannot see, with the workspace surface\'s own reason', () => {
    const a = {
      ...padRow(OUTSIDE),
    };
    assert.throws(
      () => plans.projectPlansRoot(a, project({ folder: '/mnt/x' })),
      (e) => e.code === 'plan_workspace_not_host_visible'
    );
  });

  it('resolves a project folder OUTSIDE the pad workspace mount (no phantom /www1/www2 tree)', () => {
    // The production bug (plan 86): pad-opencode-proj's workspace is /www1, but
    // the `paddock` project's folder is /www2/paddock (= PROJECT). The old
    // fallback joined the raw folder onto the mount view, producing the phantom
    // `/www1/www2/paddock/plans` — a path the webui never had. The folder must be
    // resolved in the WEBUI's OWN view: the project-root mapping HOST_WORKSPACE →
    // WORKSPACE, i.e. `/workspace/plans`, which is rw.
    const a = {
      ...padRow(PAD),
      workspace_mount: { host: '/www1', container: '/www1', webuiVisible: true, hostBrowsable: true },
    };
    const view = require('../services/vm-manager').containerViewOf(PROJECT);
    assert.ok(view, 'the project root has a webui view in-container');
    const got = plans.projectPlansRoot(a, project({ folder: PROJECT }));
    assert.equal(got, path.join(view, 'plans'));
    assert.ok(!got.includes('/www1/www2'), 'never the phantom /www1/www2 path');
    assert.equal(
      plans.projectPlansRoot(a, project({ folder: path.join(PROJECT, 'sub') })),
      path.join(view, 'sub', 'plans')
    );
  });

  // Host-dependent: needs /www2 mounted read-only into the webui. Skip, with the
  // reason, rather than fail on a host that simply has no such mount.
  const roWww2 = require('../services/vm-manager').webuiMountViewOf('/www2');
  it('reports a folder the webui sees read-only as plan_workspace_read_only', { skip: !(roWww2 && roWww2.readonly) && 'this host has no read-only /www2 mount' }, () => {
    // /www2 itself is mounted `:ro` into the webui and is NOT under the
    // project-root mapping, so a project pointed at it must fail LOUDLY with the
    // read-only code — not silently write a phantom path, and not a generic error.
    const a = {
      ...padRow(PAD),
      workspace_mount: { host: '/www1', container: '/www1', webuiVisible: true, hostBrowsable: true },
    };
    const ro = require('../services/vm-manager').webuiMountViewOf('/www2');
    assert.ok(ro && ro.readonly, 'the test host mounts /www2 read-only into the webui');
    assert.throws(
      () => plans.projectPlansRoot(a, project({ folder: '/www2' })),
      (e) => e.code === 'plan_workspace_read_only' && /read-only/.test(e.message)
    );
  });

  it('reserved entry files are refused as plan paths, on read and on write', () => {
    for (const name of ['INDEX.md', 'index.md', 'README.md', 'QUEUE.md']) {
      assert.throws(
        () => plans.planPath(agent(), name, { project: project() }),
        (e) => e.code === 'plan_reserved_name',
        `${name} is reserved`
      );
    }
  });

  it('plan_write + listPlans round-trip inside one project folder, and INDEX lands there', async () => {
    const a = agent();
    const p = project({ folder: '/root/.opencode/workspace', plans_folder: 'pplans' });
    const base = plans.projectPlansRoot(a, p);
    // writePlan writes through the workspace service, which re-resolves the pad
    // by name — so the registry must answer for it here too.
    const realGet = registry.getAgent;
    registry.getAgent = (n) => (n === PAD ? a : realGet(n));
    try {
      const r = await plans.writePlan(a, '10-first.md', '# First\n\n## Status: new\n', { project: p });
      assert.equal(r.path, '10-first.md');
      assert.ok(fs.existsSync(path.join(base, '10-first.md')), 'the plan lands under the project plans folder');
      assert.ok(fs.existsSync(path.join(base, 'INDEX.md')), 'INDEX.md is created alongside it');
      const rows = plans.listPlans(a, { project: p });
      assert.equal(rows.length, 1, 'the listing sees exactly the plan, not INDEX');
      assert.equal(rows[0].path, '10-first.md');
      assert.equal(rows[0].status, 'new');
    } finally {
      registry.getAgent = realGet;
    }
  });

  it('initProjectPlans writes INDEX.md once and never overwrites it (plan 82 phase 5)', async () => {
    const a = agent();
    const p = project({ folder: '/root/.opencode/workspace', plans_folder: 'initp' });
    const realGet = registry.getAgent;
    registry.getAgent = (n) => (n === PAD ? a : realGet(n));
    try {
      const base = plans.projectPlansRoot(a, p);
      const first = await plans.initProjectPlans(PAD, p);
      assert.equal(first.created, true, 'the first init creates the entry file');
      assert.ok(fs.existsSync(path.join(base, 'INDEX.md')), 'INDEX.md exists after init');
      // Preserve-existing is the contract: instructions that change under a
      // mid-work caller are worse than none. A sentinel an init must NOT clobber.
      const mine = '# my own entry file\n';
      fs.writeFileSync(path.join(base, 'INDEX.md'), mine);
      const second = await plans.initProjectPlans(PAD, p);
      assert.equal(second.created, false, 'the second init reports it did not create');
      assert.equal(fs.readFileSync(path.join(base, 'INDEX.md'), 'utf8'), mine, 'and the existing file is untouched');
    } finally {
      registry.getAgent = realGet;
    }
  });

  it('a project with no plans_folder defaults to `plans` (the migration default)', async () => {
    const a = agent();
    const p = project({ folder: '/root/.opencode/workspace', plans_folder: undefined });
    const realGet = registry.getAgent;
    registry.getAgent = (n) => (n === PAD ? a : realGet(n));
    try {
      const r = await plans.writePlan(a, 'd.md', '# D\n', { project: p });
      assert.equal(r.path, 'd.md');
      assert.ok(fs.existsSync(path.join(WS, 'a-data', 'workspace', 'plans', 'd.md')), 'a missing plans_folder resolves to plans/');
    } finally {
      registry.getAgent = realGet;
    }
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
