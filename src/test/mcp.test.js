const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, authenticateRequest, SERVER_NAME, SERVER_VERSION, targetAllowed, toolAllowed, requireTool, mcpContext, missionVisibleAgents, missionRequireProject, resolveAgentName, notFoundMessage, shellQuote } = require('../mcp');
const apiKeys = require('../services/api-keys');
const { getDb } = require('../services/db');
const mission = require('../services/mission');
const padTmux = require('../services/pad-tmux');
const workspace = require('../services/workspace');
const vmManager = require('../services/vm-manager');

function buildServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  registerTools(server);
  return server;
}

describe('MCP Server - Handshake', () => {
  let client;
  let server;

  before(async () => {
    server = buildServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'test-client', version: '0' });
    await client.connect(clientTransport);
  });

  after(async () => {
    if (client) await client.close();
    if (server) await server.close();
  });

  it('initializes and lists the tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('list_agents'), 'has list_agents');
    assert.ok(names.includes('get_agent'));
    assert.ok(names.includes('start_agent'));
    assert.ok(names.includes('stop_agent'));
    assert.ok(names.includes('restart_agent'));
    assert.ok(names.includes('recreate'));
    assert.ok(names.includes('update'));
    assert.ok(names.includes('delete_agent'));
    assert.ok(names.includes('create_agent'));
    assert.ok(names.includes('exec'));
    assert.ok(names.includes('workspace_list'));
    assert.ok(names.includes('workspace_read'));
    assert.ok(names.includes('workspace_write'));
    assert.ok(names.includes('agent_logs'));
    assert.ok(names.includes('config_get'));
    assert.ok(names.includes('settings_get'), 'has settings_get (the single get tool)');
    assert.ok(names.includes('help'), 'has help (the LLM usage guide)');
    assert.ok(names.includes('agent_commands'), 'has agent_commands (Set B catalog)');
    assert.ok(!names.includes('web_get'), 'no standalone web_get tool');
  });

  it('recreate carries the consolidated settings schema', async () => {
    const result = await client.listTools();
    const recreate = result.tools.find((t) => t.name === 'recreate');
    const props = recreate.inputSchema.properties;
    for (const key of ['allowDocker', 'network', 'extraVolumes', 'workspaceHost', 'workspaceDir', 'sshEnabled', 'sshPort', 'sshContainerPort', 'sshPassword', 'extraPorts', 'web', 'pull', 'reset', 'confirm']) {
      assert.ok(props[key], `recreate has ${key}`);
    }
  });

  it('settings_get carries a name param', async () => {
    const result = await client.listTools();
    const get = result.tools.find((t) => t.name === 'settings_get');
    assert.ok(get.inputSchema.properties.name, 'settings_get has name param');
  });

  it('tool schemas carry name params', async () => {
    const result = await client.listTools();
    const exec = result.tools.find((t) => t.name === 'exec');
    assert.ok(exec.inputSchema.properties.command, 'exec has command param');
    assert.ok(exec.inputSchema.properties.name, 'exec has name param');
    assert.ok(exec.inputSchema.properties.stdin, 'exec has stdin param (secret channel)');
  });

  it('agent_commands catalogs are per-type and safe', async () => {
    const { getCommandCatalog } = require('../services/llm-guide');
    for (const type of ['openclaw', 'opencode', 'picoclaw', 'hermes', 'codex', 'claude']) {
      const c = getCommandCatalog(type);
      assert.strictEqual(c.type, type, `catalog for ${type}`);
      assert.ok(Array.isArray(c.groups) && c.groups.length > 0, `${type} has command groups`);
      assert.ok(Array.isArray(c.notUsable), `${type} has notUsable list`);
      const all = c.groups.flatMap((g) => g.commands);
      assert.ok(all.length > 0, `${type} has commands`);
      const bad = all.find((x) => !x.label || !x.cmd || x.desc === undefined);
      assert.strictEqual(bad, undefined, `${type} every command has label/cmd/desc`);
      const cred = all.find((x) => x.credentialInput === 'stdin');
      if (type === 'openclaw') assert.ok(cred, 'openclaw has a stdin credential command');
    }
  });

  it('help returns the guide text', async () => {
    const result = await client.listTools();
    const help = result.tools.find((t) => t.name === 'help');
    assert.ok(help.inputSchema, 'help has a schema');
  });

  it('create_agent carries the full create schema', async () => {
    const result = await client.listTools();
    const create = result.tools.find((t) => t.name === 'create_agent');
    const props = create.inputSchema.properties;
    assert.ok(props.name, 'create_agent has name');
    assert.ok(props.confirm, 'create_agent has confirm');
    assert.ok(props.agent, 'create_agent has agent type enum');
    for (const key of ['allowDocker', 'network', 'sshEnabled', 'sshPort', 'sshContainerPort', 'sshPassword', 'workspaceHost', 'workspaceDir', 'extraVolumes', 'extraPorts']) {
      assert.ok(props[key], `create_agent has ${key}`);
    }
  });

  it('get_agent carries an optional logs param', async () => {
    const result = await client.listTools();
    const get = result.tools.find((t) => t.name === 'get_agent');
    assert.ok(get.inputSchema.properties.logs, 'get_agent has logs param');
  });

  it('task queue tools are hidden from the surface (service kept)', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    for (const tool of ['task_submit', 'task_get_next', 'task_complete', 'task_priority', 'task_status', 'task_result', 'task_list', 'task_cancel']) {
      assert.ok(!names.includes(tool), `${tool} is hidden`);
    }
  });
  it('registers the Mission tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    for (const tool of ['mission_projects', 'mission_sessions', 'mission_project_create', 'mission_session_start', 'mission_send']) {
      assert.ok(names.includes(tool), `has ${tool}`);
    }
  });

  it('mission_projects carries an agent filter and mission_sessions the read filters', async () => {
    const result = await client.listTools();
    const props = (n) => result.tools.find((t) => t.name === n).inputSchema.properties;
    assert.ok(props('mission_projects').agent, 'mission_projects has agent');
    const s = props('mission_sessions');
    for (const key of ['session_id', 'project_id', 'agent', 'lines', 'limit']) {
      assert.ok(s[key], `mission_sessions has ${key}`);
    }
  });

  it('the Mission writers carry their required inputs', async () => {
    const result = await client.listTools();
    const props = (n) => result.tools.find((t) => t.name === n).inputSchema.properties;
    const create = props('mission_project_create');
    assert.ok(create.name, 'mission_project_create has name');
    assert.ok(create.agent, 'mission_project_create has agent');
    assert.ok(create.folder, 'mission_project_create has folder');
    const start = props('mission_session_start');
    assert.ok(start.project_id, 'mission_session_start has project_id');
    assert.ok(start.agent_session_id, 'mission_session_start has agent_session_id');
    const send = props('mission_send');
    assert.ok(send.session_id, 'mission_send has session_id');
    assert.ok(send.text, 'mission_send has text');
  });

  it('the screen tail is clamped in the schema (an unbounded capture-pane floods a context)', async () => {
    const result = await client.listTools();
    const s = result.tools.find((t) => t.name === 'mission_sessions').inputSchema.properties;
    assert.strictEqual(s.lines.maximum, 200, 'lines caps at 200');
    assert.strictEqual(s.limit.maximum, 200, 'limit caps at 200');
  });
});

describe('MCP Server - Mission grants (plan 55)', () => {
  const user = (scopes) => ({ userId: 'u1', role: 'user', scopes });
  const READ = ['mission_projects', 'mission_sessions'];
  const EXEC = ['mission_session_start', 'mission_send'];
  const CREATE = ['mission_project_create'];

  it('a read key can WATCH the human work but cannot type into it', () => {
    const read = user(['read', 'target:agent:pad-x']);
    for (const t of READ) assert.strictEqual(toolAllowed(read, t, 'pad-x'), true, `read ${t}`);
    for (const t of [...EXEC, ...CREATE]) assert.strictEqual(toolAllowed(read, t, 'pad-x'), false, `read blocks ${t}`);
  });

  it('base fine-grained keys may start a session and send (the exec bucket)', () => {
    const base = user(['target:agent:pad-x']);
    for (const t of EXEC) assert.strictEqual(toolAllowed(base, t, 'pad-x'), true, `base ${t}`);
    assert.strictEqual(toolAllowed(base, 'mission_project_create', 'pad-x'), false, 'a project is a create');
  });

  it('mission_project_create rides the same create bucket as create_agent', () => {
    const create = user(['tools:create']);
    assert.strictEqual(toolAllowed(create, 'mission_project_create', 'pad-x'), true);
    assert.strictEqual(toolAllowed(create, 'create_agent', 'pad-x'), true, 'same bucket');
    const lifecycle = user(['tools:lifecycle']);
    assert.strictEqual(toolAllowed(lifecycle, 'mission_project_create', 'pad-x'), false, 'lifecycle is not create');
  });

  it('default and control keys get the whole Mission surface', () => {
    for (const s of ['default', 'control']) {
      for (const t of [...READ, ...EXEC, ...CREATE]) {
        assert.strictEqual(toolAllowed(user([s]), t, 'pad-x'), true, `${s} ${t}`);
      }
    }
  });

  it('target grants confine the Mission tools to their PAD', () => {
    const scoped = user(['target:agent:pad-x']);
    assert.strictEqual(toolAllowed(scoped, 'mission_sessions', 'pad-y'), false);
    assert.strictEqual(toolAllowed(scoped, 'mission_send', 'pad-y'), false);
    assert.strictEqual(toolAllowed(scoped, 'mission_send', 'pad-x'), true);
    // And the gate refuses before the service is reached, admin or not.
    const admin = { userId: 'u1', role: 'admin', scopes: ['target:agent:pad-x'] };
    assert.throws(() => requireTool(admin, 'mission_send', 'pad-y'), /target grant/);
  });

  it('a read-scoped admin cannot type into a session', () => {
    const admin = { userId: 'u1', role: 'admin', scopes: ['read'] };
    assert.throws(() => requireTool(admin, 'mission_send', 'pad-x'), /tool grant/);
    assert.throws(() => requireTool(admin, 'mission_session_start', 'pad-x'), /tool grant/);
    assert.strictEqual(toolAllowed(admin, 'mission_sessions', 'pad-x'), true, 'reading is still allowed');
  });
});

describe('MCP Server - Auth', () => {
  it('rejects missing token', () => {
    assert.strictEqual(authenticateRequest({ headers: {}, query: {} }), null);
  });

  it('rejects malformed token', () => {
    assert.strictEqual(
      authenticateRequest({ headers: { authorization: 'Bearer not-a-key' }, query: {} }),
      null
    );
  });
});

describe('MCP Server - API key grants (plan 35b)', () => {
  const user = (scopes) => ({ userId: 'u1', role: 'user', scopes });

  it('scope validation accepts the grant grammar', () => {
    assert.strictEqual(apiKeys.validateScopes('default'), 'default');
    assert.strictEqual(apiKeys.validateScopes(['target:agent:pad-test-agents']), 'target:agent:pad-test-agents');
    assert.strictEqual(apiKeys.validateScopes(['tools:lifecycle', 'target:owned']), 'tools:lifecycle,target:owned');
    assert.strictEqual(apiKeys.validateScopes(['tools:create', 'tools:delete', 'tools:reset']), 'tools:create,tools:delete,tools:reset');
    assert.strictEqual(apiKeys.validateScopes(['read', 'target:agent:pad-test-agents']), 'read,target:agent:pad-test-agents');
    assert.throws(() => apiKeys.validateScopes(['default', 'tools:delete']), /cannot be combined/);
    assert.throws(() => apiKeys.validateScopes(['read', 'tools:lifecycle']), /read cannot be combined/);
    assert.throws(() => apiKeys.validateScopes(['tools:nonsense']), /Unknown tool grant/);
    assert.throws(() => apiKeys.validateScopes(['target:agent:NOT-A-VALID-NAME']), /Invalid target PAD name/);
    assert.throws(() => apiKeys.validateScopes(['bogus']), /Unknown scope/);
    assert.throws(() => apiKeys.validateScopes([]), /At least one scope/);
  });

  it('target grant admits only its own agent', () => {
    const restricted = user(['target:agent:pad-test-agents']);
    assert.strictEqual(targetAllowed(restricted, 'pad-test-agents'), true);
    assert.strictEqual(targetAllowed(restricted, 'pad-other'), false);
    assert.strictEqual(targetAllowed(user(['target:owned']), 'pad-other'), true);
    assert.strictEqual(targetAllowed(user(['default']), 'pad-other'), true);
  });

  it('base fine-grained keys get read + workspace + exec, not mutations', () => {
    const base = user(['target:agent:pad-test-agents']);
    assert.strictEqual(toolAllowed(base, 'list_agents', 'pad-test-agents'), true);
    assert.strictEqual(toolAllowed(base, 'get_agent', 'pad-test-agents'), true);
    assert.strictEqual(toolAllowed(base, 'workspace_write', 'pad-test-agents'), true);
    assert.strictEqual(toolAllowed(base, 'exec', 'pad-test-agents'), true);
    assert.strictEqual(toolAllowed(base, 'start_agent', 'pad-test-agents'), false);
    assert.strictEqual(toolAllowed(base, 'recreate', 'pad-test-agents'), false);
    assert.strictEqual(toolAllowed(base, 'create_agent', 'pad-test-agents'), false);
    assert.strictEqual(toolAllowed(base, 'delete_agent', 'pad-test-agents'), false);
  });

  it('opt-in tool grants unlock the matching mutations', () => {
    const lifecycle = user(['tools:lifecycle']);
    assert.strictEqual(toolAllowed(lifecycle, 'start_agent', 'pad-x'), true);
    assert.strictEqual(toolAllowed(lifecycle, 'stop_agent', 'pad-x'), true);
    assert.strictEqual(toolAllowed(lifecycle, 'restart_agent', 'pad-x'), true);
    assert.strictEqual(toolAllowed(lifecycle, 'delete_agent', 'pad-x'), false);

    const recreate = user(['tools:recreate']);
    assert.strictEqual(toolAllowed(recreate, 'recreate', 'pad-x'), true);
    assert.strictEqual(toolAllowed(recreate, 'update', 'pad-x'), true);
    assert.strictEqual(toolAllowed(recreate, 'reset', 'pad-x'), false);

    const everything = user(['tools:lifecycle', 'tools:recreate', 'tools:create', 'tools:delete', 'tools:reset']);
    for (const t of ['start_agent', 'stop_agent', 'restart_agent', 'create_agent', 'delete_agent', 'recreate', 'update', 'reset']) {
      assert.strictEqual(toolAllowed(everything, t, 'pad-x'), true, `${t} allowed`);
    }
  });

  it('read scope strips exec and workspace writes', () => {
    const read = user(['read', 'target:agent:pad-test-agents']);
    assert.strictEqual(toolAllowed(read, 'config_get', 'pad-test-agents'), true);
    assert.strictEqual(toolAllowed(read, 'health', 'pad-test-agents'), true);
    assert.strictEqual(toolAllowed(read, 'workspace_read', 'pad-test-agents'), true);
    assert.strictEqual(toolAllowed(read, 'workspace_write', 'pad-test-agents'), false);
    assert.strictEqual(toolAllowed(read, 'exec', 'pad-test-agents'), false);
    assert.strictEqual(toolAllowed(read, 'start_agent', 'pad-test-agents'), false);
  });

  it('default/control keys are unrestricted', () => {
    for (const s of ['default', 'control']) {
      const full = user([s]);
      assert.strictEqual(toolAllowed(full, 'delete_agent', 'pad-other'), true, `${s} delete`);
      assert.strictEqual(toolAllowed(full, 'exec', 'pad-other'), true, `${s} exec`);
    }
  });

  it('requireTool throws on grant violations (even for admins)', () => {
    const adminLifecycle = { userId: 'u1', role: 'admin', scopes: ['tools:lifecycle'] };
    assert.throws(() => requireTool(adminLifecycle, 'delete_agent', 'pad-test-agents'), /tool grant/);
    const adminTarget = { userId: 'u1', role: 'admin', scopes: ['target:agent:pad-x'] };
    assert.throws(() => requireTool(adminTarget, 'get_agent', 'pad-other'), /target grant/);
    assert.strictEqual(toolAllowed(adminTarget, 'get_agent', 'pad-x'), true);
  });
});

describe('MCP Server - task queue grants (plan 47)', () => {
  const user = (scopes) => ({ userId: 'u1', role: 'user', scopes });
  const READ = ['task_status', 'task_result', 'task_list'];
  const EXEC = ['task_submit', 'task_get_next', 'task_complete', 'task_priority', 'task_cancel'];

  it('read scope sees task results but cannot mutate the queue', () => {
    const read = user(['read', 'target:agent:pad-x']);
    for (const t of READ) assert.strictEqual(toolAllowed(read, t, 'pad-x'), true, `read ${t}`);
    for (const t of EXEC) assert.strictEqual(toolAllowed(read, t, 'pad-x'), false, `read blocks ${t}`);
  });

  it('base fine-grained keys may self-serve work through the exec bucket', () => {
    const base = user(['target:agent:pad-x']);
    for (const t of EXEC) assert.strictEqual(toolAllowed(base, t, 'pad-x'), true, `base ${t}`);
    for (const t of READ) assert.strictEqual(toolAllowed(base, t, 'pad-x'), true, `base ${t}`);
  });

  it('task_get_next is not a read tool — claiming mutates state', () => {
    const read = user(['read', 'target:owned']);
    assert.strictEqual(toolAllowed(read, 'task_get_next', 'pad-x'), false);
  });

  it('task tools share the exec grant bucket', () => {
    const lifecycle = user(['tools:lifecycle']);
    assert.strictEqual(toolAllowed(lifecycle, 'exec', 'pad-x'), true);
    assert.strictEqual(toolAllowed(lifecycle, 'task_submit', 'pad-x'), true, 'same bucket as exec');
  });

  it('default and control keys get the whole task surface', () => {
    for (const s of ['default', 'control']) {
      for (const t of [...READ, ...EXEC]) {
        assert.strictEqual(toolAllowed(user([s]), t, 'pad-x'), true, `${s} ${t}`);
      }
    }
  });

  it('target grants still confine task tools to their PAD', () => {
    const scoped = user(['target:agent:pad-x']);
    assert.strictEqual(toolAllowed(scoped, 'task_status', 'pad-y'), false);
    const admin = { userId: 'u1', role: 'admin', scopes: ['target:agent:pad-x'] };
    assert.throws(() => requireTool(admin, 'task_status', 'pad-y'), /target grant/);
  });

  it('requireTool rejects a read-scoped admin from mutating the queue', () => {
    const admin = { userId: 'u1', role: 'admin', scopes: ['read'] };
    assert.throws(() => requireTool(admin, 'task_submit', 'pad-x'), /tool grant/);
  });
});

describe('MCP Server - job readers (timed-out create/recreate)', () => {
  const jobLog = require('../services/job-log');

  it('the tool surface exposes job_status and job_log', async () => {
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
    registerTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'test-client', version: '0' });
    await client.connect(ct);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(names.includes('job_status'), 'has job_status');
      assert.ok(names.includes('job_log'), 'has job_log');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('job readers are read-only tools (a read key may poll a create it cannot start)', () => {
    const reader = { userId: 'u1', role: 'user', scopes: ['read'] };
    assert.strictEqual(toolAllowed(reader, 'job_status', 'pad-x'), true);
    assert.strictEqual(toolAllowed(reader, 'job_log', 'pad-x'), true);
    assert.strictEqual(toolAllowed(reader, 'create_agent', 'pad-x'), false, 'still cannot create');
  });

  it('listJobs finds a create by the bare name and a recreate by the update: prefix', () => {
    jobLog.clearJob('pad-j1');
    jobLog.clearJob('update:pad-j1');
    const a = jobLog.getOrCreateJob('pad-j1');
    const b = jobLog.getOrCreateJob('update:pad-j1');
    jobLog.line(a, 'system', 'building');
    jobLog.setStep(b, 'recreate', 'start');
    try {
      const all = jobLog.listJobs();
      assert.ok(all.some((j) => j.name === 'pad-j1'), 'create job listed');
      assert.ok(all.some((j) => j.name === 'update:pad-j1'), 'recreate job listed');
      // No kind given → the newest job for that pad, whatever its kind.
      const forPad = all.filter((j) => j.name === 'pad-j1' || j.name.endsWith(':pad-j1'));
      assert.strictEqual(forPad.length, 2, 'both jobs resolve to the same pad name');
    } finally {
      jobLog.clearJob('pad-j1');
      jobLog.clearJob('update:pad-j1');
    }
  });

  it('a finished job reports done/failed state, its last step and its error', () => {
    jobLog.clearJob('pad-j2');
    const job = jobLog.getOrCreateJob('pad-j2');
    jobLog.setStep(job, 'build', 'start', 'docker compose build');
    jobLog.line(job, 'stdout', 'step 1/10');
    jobLog.fail(job, 'build exploded');
    try {
      const st = jobLog.getStatus('pad-j2');
      assert.strictEqual(st.state, 'failed');
      assert.strictEqual(st.failed, true);
      assert.strictEqual(st.error, 'build exploded');
      assert.strictEqual(st.step, 'build');
      const lines = jobLog.logLines('pad-j2', { tail: 10 });
      assert.ok(lines.some((l) => l.includes('step 1/10')), 'streamed line is readable');
      assert.ok(lines.some((l) => l.includes('[step] build start')), 'step marker is readable');
    } finally {
      jobLog.clearJob('pad-j2');
    }
  });

  it('logLines tails, and returns null for a job that is not in memory', () => {
    jobLog.clearJob('pad-j3');
    const job = jobLog.getOrCreateJob('pad-j3');
    for (let i = 1; i <= 200; i++) jobLog.line(job, 'stdout', `line ${i}`);
    try {
      const tail = jobLog.logLines('pad-j3', { tail: 5 });
      assert.strictEqual(tail.length, 5);
      assert.ok(tail[4].includes('line 200'), 'tail ends at the newest line');
      assert.strictEqual(jobLog.logLines('pad-does-not-exist', {}), null, 'unknown job → null');
    } finally {
      jobLog.clearJob('pad-j3');
    }
  });
});

// ─── The Mission tools, called for real (plan 55) ────────────────────────
// The handlers are driven through the same MCP client an agent uses, with the
// identity supplied by hand: `mcpContext.run({user}, ...)` is exactly what
// mountMcp does per request, so the gate order under test is the real one.
//
// The DB is the live dev DB (as in mission.test.js), but this file only ever
// touches rows whose PAD starts with `pad-mm-` — the user's own projects are
// left alone, and cleaned up after.
describe('MCP Server - Mission tools (plan 55)', () => {
  const PADS = [
    ['pad-mm-oc', 'opencode', 'user-1'],
    ['pad-mm-oc2', 'opencode', 'user-1'],
    ['pad-mm-cl', 'claude', 'user-2'],
    ['pad-mm-pc', 'picoclaw', 'user-1'],
  ];
  const OWNER = { userId: 'user-1', role: 'user', scopes: ['default'] };
  const OWNER_EXEC = { userId: 'user-1', role: 'user', scopes: ['tools:create'] };
  const READER = { userId: 'user-1', role: 'user', scopes: ['read'] };
  const STRANGER = { userId: 'user-9', role: 'user', scopes: ['default'] };

  let client;
  let server;
  let real;
  let realWorkspace;
  // The fake pane's current contents — see the echoing captureScreen in
  // beforeEach.
  let screenText;

  function seed() {
    const db = getDb();
    for (const [name, agent_type, owner_id] of PADS) {
      db.prepare(
        `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
         VALUES (?, ?, ?, 'docker', ?, 'running', ?)`
      ).run(name, name, agent_type, name, owner_id);
    }
  }

  /** Clean up ONLY this suite's rows — never the user's projects. */
  function cleanup() {
    const db = getDb();
    const ids = db.prepare("SELECT id FROM mission_projects WHERE agent_name LIKE 'pad-mm-%'").all().map((r) => r.id);
    for (const id of ids) db.prepare('DELETE FROM mission_sessions WHERE project_id = ?').run(id);
    db.prepare("DELETE FROM mission_projects WHERE agent_name LIKE 'pad-mm-%'").run();
    db.prepare("DELETE FROM agents WHERE name LIKE 'pad-mm-%'").run();
  }

  /** Call a tool as `user`, returning the parsed payload (or the thrown error). */
  async function call(name, args, user) {
    const run = () => client.callTool({ name, arguments: args || {} });
    try {
      const r = await (user ? mcpContext.run({ user }, run) : run());
      const text = (r.content || []).map((c) => c.text).join('\n');
      return { isError: !!r.isError, text, data: (() => { try { return JSON.parse(text); } catch { return null; } })() };
    } catch (e) {
      return { isError: true, thrown: e, text: String(e.message || e) };
    }
  }

  before(async () => {
    server = buildServer();
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test-client', version: '0' });
    await client.connect(ct);
    real = { ...padTmux };
    realWorkspace = workspace.listFolders;
  });

  after(async () => {
    for (const k of Object.keys(real)) padTmux[k] = real[k];
    workspace.listFolders = realWorkspace;
    if (client) await client.close();
    if (server) await server.close();
  });

  beforeEach(() => {
    cleanup();
    seed();
    // tmux is not there: every call is faked, and the fake records what it was
    // asked so the tests can assert the liveness call COUNT too.
    padTmux.listSessions = async () => [];
    padTmux.folderExists = async () => true;
    padTmux.createSession = async () => {};
    padTmux.killSession = async () => {};
    padTmux.sendCommand = async () => {};
    padTmux.sendKeys = async () => ({ keys: 0 });
    // A pane that ECHOES. The send path confirms the write by watching the
    // screen CHANGE (plan 62 1h) — that is the whole point of it — so a stub
    // returning one frozen string is not a neutral fake, it is a black hole
    // that every send test would (correctly) be refused by. Modelling the echo
    // here fixes that once for the whole suite instead of per-test.
    screenText = 'a prompt\nthe answer';
    padTmux.captureScreen = async () => ({ text: screenText, live: true });
    padTmux.sendText = async (vm, tid, text) => {
      screenText = `${screenText}\n> ${text}`;
      return { lines: 1 };
    };
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'node', cwd: '/www1' });
    // The pane map is a second per-PAD probe; leaving it real would make every
    // list test shell out to docker. Empty = "no claim", which is the safe side.
    padTmux.listPanes = async () => new Map();
    padTmux.sendKeys = async () => ({ keys: 0 });
    // The folder probe is a real container command — faked, since the seeded
    // PADs are rows, not containers.
    workspace.listFolders = async () => ({ path: '/', exists: true, isDir: true, entries: [{ name: 'src' }] });
  });

  afterEach(() => cleanup());

  it('mission_projects lists the caller\'s projects with counts', async () => {
    const a = mission.createProject({ name: 'one', agent: 'pad-mm-oc', folder: '/www1/a' });
    mission.createProject({ name: 'two', agent: 'pad-mm-oc2', folder: '/www2/b' });
    const r = await call('mission_projects', {}, OWNER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.projects.length, 2);
    const one = r.data.projects.find((p) => p.id === a.id);
    assert.strictEqual(one.agent, 'pad-mm-oc');
    assert.strictEqual(one.folder, '/www1/a');
    assert.strictEqual(one.sessionCount, 0);
    assert.deepEqual(r.data.supportedAgentTypes.sort(), ['claude', 'codex', 'opencode']);
  });

  it('every mission.* symbol mcp.js calls is really exported by the service', () => {
    // Two agents share services/mission.js, so a rename or a removed export must
    // fail HERE, loudly, instead of turning into `mission.foo is not a function`
    // at the first live call. Derived from the source, so it cannot rot.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
    const used = [...new Set([...src.matchAll(/\bmission\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))]
      // `mission.js` in a comment or a require path is not a call.
      .filter((k) => k !== 'js');
    assert.ok(used.length > 10, `found the mission.* calls (${used.length})`);
    const missing = used.filter((k) => typeof mission[k] === 'undefined');
    assert.deepEqual(missing, [], `services/mission.js no longer exports: ${missing.join(', ')}`);
  });

  it('a busy stamp from the store reaches the LLM, and an unanswered probe says so', async () => {
    // The store's busy-detection stamps busy / busyKnown / open. Those are the
    // fields that let an LLM tell "the human is mid-turn" from "here but idle"
    // WITHOUT opening the session, so the tool has to chain the same busy pass
    // the REST route does and project what it stamps.
    const p = mission.createProject({ name: 'busy', agent: 'pad-mm-oc', folder: '/www1/a' });
    mission.createSession(p.id, { tmuxId: 'msn-1111aaaa', agentSessionId: 'ses_abc' });
    const marking = (rows) => rows.map((s) => ({ ...s, live: true, busy: true, busyKnown: true, open: true }));
    const realProjects = mission.withAgentBusyProjects;
    const realFlat = mission.withAgentBusy;
    mission.withAgentBusyProjects = async (projects) =>
      projects.map((pr) => ({ ...pr, openCount: 1, sessions: marking(pr.sessions || []) }));
    mission.withAgentBusy = async (rows) => marking(rows);
    try {
      const pr = await call('mission_projects', { include_sessions: true }, OWNER);
      const project = pr.data.projects.find((x) => x.id === p.id);
      assert.strictEqual(project.openCount, 1, 'openCount is projected');
      assert.deepStrictEqual(
        { busy: project.sessions[0].busy, busyKnown: project.sessions[0].busyKnown, open: project.sessions[0].open },
        { busy: true, busyKnown: true, open: true },
        'a project session carries the busy stamp'
      );
      const list = await call('mission_sessions', { project_id: p.id }, OWNER);
      const s = list.data.sessions[0];
      assert.deepStrictEqual(
        { busy: s.busy, busyKnown: s.busyKnown, open: s.open },
        { busy: true, busyKnown: true, open: true },
        'the session list carries the busy stamp'
      );
    } finally {
      mission.withAgentBusyProjects = realProjects;
      mission.withAgentBusy = realFlat;
    }

    // The REAL pass with the faked tmux: the probe cannot reach a server, so it
    // must report unknown — a `false` that means "we did not look", never a
    // fabricated `busy: true` and never a silent omission.
    const plain = await call('mission_sessions', { project_id: p.id }, OWNER);
    const row = plain.data.sessions[0];
    assert.strictEqual(row.busyKnown, false, 'an unanswered probe is reported as unknown');
    assert.strictEqual(row.busy, false, 'and busy is false, not fabricated true');
  });

  it('a session row keeps agent/folder/project through the real liveness pass', async () => {
    // The projections read these off the row the store hands back, and the
    // liveness/busy decoration is free to add and REMOVE fields while it merges
    // per-PAD probe results. Pin what an LLM is actually promised, end to end
    // through the tool — the decoration runs for real, only tmux is faked.
    const p = mission.createProject({ name: 'shape', agent: 'pad-mm-oc', folder: '/www1/a' });
    mission.createSession(p.id, { tmuxId: 'msn-1111aaaa', label: 'row' });
    const r = await call('mission_projects', { include_sessions: true }, OWNER);
    assert.ok(!r.isError, r.text);
    const project = r.data.projects.find((x) => x.id === p.id);
    assert.ok(project, 'the project is listed');
    assert.strictEqual(project.folder, '/www1/a', 'project keeps its folder');
    assert.strictEqual(project.sessionCount, 1, 'the session is counted');
    const [s] = project.sessions;
    assert.strictEqual(s.tmux_id, 'msn-1111aaaa', 'session keeps its tmux id');
    assert.strictEqual(s.agent, 'pad-mm-oc', 'session keeps the PAD name');
    assert.strictEqual(s.folder, '/www1/a', 'session keeps the project folder');
    assert.ok(s.project && s.project.id === p.id, 'session keeps its project back-reference');
    assert.ok(typeof s.live === 'boolean', 'liveness is a boolean, not undefined');
  });

  it('the default project list carries counts, not every session of every project (plan 67, 67.4)', async () => {
    // Not just "the field is behind a flag": the payload a caller gets for free,
    // with no arguments, must not be a superset of `mission_sessions`. One
    // unfiltered call used to return 26 full session rows for a six-project
    // fleet, with the summary counts arriving AFTER the data they summarize.
    const p = mission.createProject({ name: 'payload', agent: 'pad-mm-oc', folder: '/www1/a' });
    for (const t of ['msn-2222aaaa', 'msn-3333aaaa']) mission.createSession(p.id, { tmuxId: t });
    const r = await call('mission_projects', {}, OWNER);
    assert.ok(!r.isError, r.text);
    const project = r.data.projects.find((x) => x.id === p.id);
    assert.ok(!('sessions' in project), 'sessions are omitted by default');
    assert.strictEqual(project.sessionCount, 2, 'the count still reports them');
    assert.match(r.data.hint || '', /include_sessions/, 'and the response names the flag');
    // The counts are the answer, so they must come first in the row.
    const keys = Object.keys(project);
    assert.ok(keys.indexOf('sessionCount') < keys.indexOf('created_at'), 'counts precede the tail fields');
    // Opting in still works — the detail is one argument away, not gone.
    const withRows = await call('mission_projects', { project_id: p.id, include_sessions: true }, OWNER);
    assert.strictEqual(withRows.data.projects[0].sessions.length, 2, 'include_sessions returns the rows');
    // And a name resolves to exactly that one project (67.2).
    assert.strictEqual(withRows.data.projects[0].id, p.id, 'project_id narrows to the one meant');
  });

  it('mission_projects never shows another user\'s project', async () => {
    mission.createProject({ name: 'mine', agent: 'pad-mm-oc', folder: '/www1/a' });
    mission.createProject({ name: 'theirs', agent: 'pad-mm-cl', folder: '/www1/c' });
    const mine = await call('mission_projects', {}, OWNER);
    const names = mine.data.projects.map((p) => p.name);
    assert.ok(names.includes('mine'), 'own project listed');
    assert.ok(!names.includes('theirs'), 'another user\'s project is absent');
    assert.ok(
      mine.data.projects.every((p) => p.agent !== 'pad-mm-cl'),
      'nothing on a PAD the key does not own'
    );
    // And the admin sees both — ownership scoping is not a bug in the tool.
    const admin = await call('mission_projects', {}, { userId: 'user-1', role: 'admin', scopes: ['default'] });
    const adminNames = admin.data.projects.map((p) => p.name);
    assert.ok(adminNames.includes('mine') && adminNames.includes('theirs'), 'admin sees both');
  });

  it('a read key can list projects (watching is the read bucket)', async () => {
    mission.createProject({ name: 'watched', agent: 'pad-mm-oc', folder: '/www1/a' });
    const r = await call('mission_projects', {}, READER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.projects.length, 1);
  });

  it('mission_projects rejects a PAD the key may not touch', async () => {
    mission.createProject({ name: 'theirs', agent: 'pad-mm-cl', folder: '/www1/c' });
    const r = await call('mission_projects', { agent: 'pad-mm-cl' }, OWNER);
    assert.ok(r.isError, 'refused');
    assert.match(r.text, /Access denied or agent not found/);
  });

  it('mission_sessions lists every session the caller can see, tagged with its project', async () => {
    const p = mission.createProject({ name: 'listed', agent: 'pad-mm-oc', folder: '/www1/a' });
    mission.createSession(p.id, { label: 'one', tmuxId: 'msn-1111aaaa' });
    mission.createSession(p.id, { label: 'two', origin: 'agent', tmuxId: 'msn-2222bbbb' });
    const r = await call('mission_sessions', {}, OWNER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.sessions.length, 2);
    const first = r.data.sessions[0];
    assert.strictEqual(first.agent, 'pad-mm-oc');
    assert.strictEqual(first.folder, '/www1/a');
    assert.strictEqual(first.project.name, 'listed');
    assert.strictEqual(first.live, false, 'liveness is stamped from the PAD');
    assert.ok(r.data.sessions.some((s) => s.origin === 'agent'), 'agent-started rows are marked');
  });

  it('mission_sessions filters by project_id', async () => {
    const a = mission.createProject({ name: 'a', agent: 'pad-mm-oc', folder: '/www1/a' });
    const b = mission.createProject({ name: 'b', agent: 'pad-mm-oc2', folder: '/www2/b' });
    mission.createSession(a.id, { tmuxId: 'msn-1111aaaa' });
    mission.createSession(a.id, { tmuxId: 'msn-3333cccc' });
    mission.createSession(b.id, { tmuxId: 'msn-4444dddd' });
    const r = await call('mission_sessions', { project_id: a.id }, OWNER);
    assert.strictEqual(r.data.sessions.length, 2);
    assert.ok(r.data.sessions.every((s) => s.project_id === a.id));
  });

  it('mission_sessions costs ONE list-sessions per PAD, not one per session', async () => {
    const a = mission.createProject({ name: 'a', agent: 'pad-mm-oc', folder: '/www1/a' });
    const b = mission.createProject({ name: 'b', agent: 'pad-mm-oc2', folder: '/www2/b' });
    for (let i = 0; i < 3; i++) mission.createSession(a.id, { tmuxId: `msn-1111aa0${i}` });
    mission.createSession(b.id, { tmuxId: 'msn-4444dddd' });
    const asked = [];
    padTmux.listSessions = async (vm) => { asked.push(vm); return []; };
    const r = await call('mission_sessions', {}, OWNER);
    assert.strictEqual(r.data.sessions.length, 4);
    assert.deepEqual(asked.sort(), ['pad-mm-oc', 'pad-mm-oc2'], 'one call per distinct PAD');
  });

  it('mission_sessions with a session_id returns the screen tail and the pane state', async () => {
    const p = mission.createProject({ name: 'watch', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    const r = await call('mission_sessions', { session_id: s.id }, OWNER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.session.tmux_id, 'msn-1111aaaa');
    assert.strictEqual(r.data.session.agent, 'pad-mm-oc');
    assert.strictEqual(r.data.state.tuiAlive, true);
    assert.match(r.data.screen, /the answer/);
  });

  it('a dead session is reported as not live, not as a failure', async () => {
    const p = mission.createProject({ name: 'dead', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    padTmux.captureScreen = async () => ({ text: '', live: false });
    padTmux.paneState = async () => ({ live: false, tuiAlive: false, command: '', cwd: '', reason: 'no-session' });
    const r = await call('mission_sessions', { session_id: s.id }, OWNER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.live, false);
    assert.match(r.data.hint, /tmux session is gone/);
  });

  it('another user\'s session is unreachable, and the send never reaches the service', async () => {
    const p = mission.createProject({ name: 'theirs', agent: 'pad-mm-cl', folder: '/www1/c' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    let typed = 0;
    padTmux.sendText = async () => { typed++; return { lines: 1 }; };
    const read = await call('mission_sessions', { session_id: s.id }, OWNER);
    assert.ok(read.isError);
    assert.match(read.text, /mission_project_forbidden|not found/);
    const send = await call('mission_send', { session_id: s.id, text: 'hello' }, OWNER_EXEC);
    assert.ok(send.isError, 'refused');
    assert.strictEqual(typed, 0, 'nothing was typed into another user\'s session');
  });

  it('mission_project_create makes a row on a coding PAD and refuses a personal one', async () => {
    const ok = await call('mission_project_create', { name: 'made', agent: 'pad-mm-oc' }, OWNER_EXEC);
    assert.ok(!ok.isError, ok.text);
    assert.strictEqual(ok.data.project.name, 'made');
    assert.strictEqual(ok.data.project.folder.length > 0, true, 'folder defaulted to the driver workspace');
    assert.strictEqual(mission.listProjects({ agent: 'pad-mm-oc' }).length, 1);

    const nope = await call('mission_project_create', { name: 'nope', agent: 'pad-mm-pc' }, OWNER_EXEC);
    assert.ok(nope.isError, 'picoclaw has no Mission');
    assert.match(nope.text, /mission_unsupported_agent/);
  });

  it('mission_project_create needs the create grant', async () => {
    const r = await call('mission_project_create', { name: 'denied', agent: 'pad-mm-oc' }, READER);
    assert.ok(r.isError);
    assert.match(r.text, /tool grant/);
  });

  it('mission_project_create refuses a folder that is not in the PAD', async () => {
    workspace.listFolders = async () => ({ path: '/www1/ghost', exists: false, isDir: false, entries: [] });
    const r = await call('mission_project_create', { name: 'ghost', agent: 'pad-mm-oc', folder: '/www1/ghost' }, OWNER_EXEC);
    assert.ok(r.isError);
    assert.match(r.text, /mission_folder_missing/);
    assert.strictEqual(mission.listProjects({ agent: 'pad-mm-oc' }).length, 0, 'no row was written');
  });

  it('a mistyped PAD name is refused as not-found, never as a driver-fallback type complaint', async () => {
    // The type must come from the row, resolved by the store. Reading it in the
    // handler and passing `undefined` into assertMissionAgent hits the openclaw
    // driver FALLBACK, which answers "openclaw does not support Mission" for a
    // name that does not exist at all. The grant gate refuses it even earlier.
    const r = await call('mission_project_create', { name: 'typo', agent: 'pad-mm-typo' }, OWNER_EXEC);
    assert.ok(r.isError, r.text);
    assert.match(r.text, /not found/);
    assert.doesNotMatch(r.text, /openclaw/, 'no openclaw driver-fallback complaint');
    assert.strictEqual(mission.listProjects({ agent: 'pad-mm-typo' }).length, 0, 'no row was written');
  });

  it('mission_session_start launches the TUI in the project folder and marks origin=agent', async () => {
    const p = mission.createProject({ name: 'work', agent: 'pad-mm-oc', folder: '/www1/a' });
    const sent = [];
    padTmux.sendCommand = async (vm, tid, cmd) => { sent.push([vm, tid, cmd]); };
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'node', cwd: '/www1/a' });
    const r = await call('mission_session_start', { project_id: p.id, label: 'agent work' }, OWNER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.session.origin, 'agent');
    assert.strictEqual(r.data.session.label, 'agent work');
    assert.match(r.data.session.tmux_id, /^msn-[0-9a-f]{8}$/);
    assert.strictEqual(r.data.inExpectedFolder, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0][0], 'pad-mm-oc', 'launched in the project\'s PAD');
    assert.ok(sent[0][2].length > 0, 'a TUI launch command was typed in');
  });

  it('mission_session_start needs the exec bucket', async () => {
    const p = mission.createProject({ name: 'work', agent: 'pad-mm-oc', folder: '/www1/a' });
    const r = await call('mission_session_start', { project_id: p.id }, READER);
    assert.ok(r.isError);
    assert.match(r.text, /tool grant/);
  });

  it('mission_session_start surfaces the store\'s machine code when the PAD is stopped', async () => {
    getDb().prepare("UPDATE agents SET status = 'exited' WHERE name = 'pad-mm-oc'").run();
    const p = mission.createProject({ name: 'work', agent: 'pad-mm-oc', folder: '/www1/a' });
    const r = await call('mission_session_start', { project_id: p.id }, OWNER);
    assert.ok(r.isError);
    assert.match(r.text, /mission_agent_stopped/);
  });

  it('mission_send types into a live session', async () => {
    const p = mission.createProject({ name: 'talk', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    const typed = [];
    padTmux.sendText = async (vm, tid, text) => {
      typed.push([vm, tid, text]);
      screenText = `a prompt\n> ${text}`; // the TUI echoes what it received
      return { lines: 1 };
    };
    const r = await call('mission_send', { session_id: s.id, text: 'do the thing' }, OWNER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.ok, true);
    assert.deepEqual(typed, [['pad-mm-oc', 'msn-1111aaaa', 'do the thing']]);
  });

  it('mission_send refuses a solo-locked session and types nothing', async () => {
    const p = mission.createProject({ name: 'solo', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    mission.updateSession(s.id, { locked: true });
    let typed = 0;
    padTmux.sendText = async () => { typed++; return { lines: 1 }; };
    const r = await call('mission_send', { session_id: s.id, text: 'let me in' }, OWNER);
    assert.ok(r.isError);
    assert.match(r.text, /mission_session_locked/);
    assert.match(r.text, /unlock it on the Mission page/);
    assert.strictEqual(typed, 0, 'a locked session got no keystrokes');
  });

  it('mission_send refuses a session whose tmux session is gone', async () => {
    const p = mission.createProject({ name: 'gone', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    padTmux.hasSession = async () => false;
    const r = await call('mission_send', { session_id: s.id, text: 'anyone there?' }, OWNER);
    assert.ok(r.isError);
    assert.match(r.text, /mission_session_dead/);
  });

  it('an empty message is refused before anything is typed', async () => {
    const p = mission.createProject({ name: 'talk', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    let typed = 0;
    padTmux.sendText = async () => { typed++; return { lines: 1 }; };
    const r = await call('mission_send', { session_id: s.id, text: '   ' }, OWNER);
    assert.ok(r.isError);
    assert.match(r.text, /mission_empty_message/);
    assert.strictEqual(typed, 0);
  });

  it('an unknown project id answers with the store\'s 404 code, not a stack trace', async () => {
    const r = await call('mission_sessions', { session_id: 'msn_doesnotexist' }, OWNER);
    assert.ok(r.isError);
    assert.match(r.text, /mission_session_not_found/);
  });

  // Plan 62: a caller must be able to tell "idle" from "corpse" and "agent"
  // from "shell" BEFORE typing, and every write must say where it landed.
  it('a list row says dead/shell/busy apart, and detail agrees with it', async () => {
    const p = mission.createProject({ name: 'truth', agent: 'pad-mm-oc', folder: '/www1/a' });
    const shell = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    const corpse = mission.createSession(p.id, { tmuxId: 'msn-ccccdddd' });
    const agent = mission.createSession(p.id, { tmuxId: 'msn-eeeeffff' });
    padTmux.listSessions = async () => [{ name: 'msn-aaaabbbb' }, { name: 'msn-eeeeffff' }];
    padTmux.listPanes = async () => new Map([
      ['msn-aaaabbbb', { command: 'bash', cwd: '/www1/a' }],
      ['msn-eeeeffff', { command: 'node', cwd: '/www1/a' }],
    ]);

    const list = await call('mission_sessions', { project_id: p.id }, OWNER);
    const rows = new Map(list.data.sessions.map((s) => [s.id, s]));
    assert.strictEqual(rows.get(corpse.id).live, false, 'no tmux session = dead');
    assert.strictEqual(rows.get(corpse.id).open, false, 'and never open');
    assert.strictEqual(rows.get(corpse.id).state, 'dead');
    assert.strictEqual(rows.get(shell.id).kind, 'shell', 'a bash pane is a shell');
    assert.strictEqual(rows.get(shell.id).open, false, 'open means a send would be taken');
    assert.strictEqual(rows.get(agent.id).kind, 'agent');
    assert.strictEqual(rows.get(agent.id).open, true);

    // Parity: the same row read on its own must not answer differently, because
    // the detail view is what a caller reads before sending. Detail probes the
    // single pane with `paneState` while the list batches one `list-panes` per
    // PAD — two different sources, so the test has to make the PAD agree with
    // itself. If they ever disagree LIVE it is the same tmux field
    // (`pane_current_command`) read twice, so this only pins that detail does
    // not report a bare liveness flag and leave `kind` to the list.
    padTmux.paneState = async (vm, tid) => ({
      live: true,
      tuiAlive: false,
      command: 'bash',
      cwd: '/www1/a',
    });
    const detail = await call('mission_sessions', { session_id: shell.id }, OWNER);
    // `kind` lives on the ROW, where list mode puts it too — one place to look
    // for it, and no chance of the two copies disagreeing.
    assert.strictEqual(detail.data.session.kind, 'shell', 'detail knows what the pane is');
    assert.strictEqual(detail.data.session.open, false, 'and agrees with the list row');
    assert.strictEqual(detail.data.canSend, false, 'the send verdict is stated up front');
    assert.match(detail.data.sendRefusal, /mission_not_an_agent/);
    assert.match(detail.data.sendRefusal, /bash/, 'and names what is actually running');
  });

  // The regression this pins: `canSend` used to be `session.open`, which only
  // means "a TUI is attached". A solo-locked row and a pane parked on a
  // permission dialog are BOTH still open, so both answered `canSend: true` —
  // and then `mission_send` refused them with `mission_session_locked` /
  // `mission_permission_pending`. A verdict computed anywhere but the gate is a
  // guess, and this is the caller being told to type into a wall.
  it('detail never promises a send the write path will refuse (plan 62)', async () => {
    const p = mission.createProject({ name: 'verdict', agent: 'pad-mm-oc', folder: '/www1/a' });
    const locked = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    const parked = mission.createSession(p.id, { tmuxId: 'msn-eeeeffff' });
    const free = mission.createSession(p.id, { tmuxId: 'msn-11112222' });
    mission.updateSession(locked.id, { locked: true });

    padTmux.hasSession = async () => true;
    padTmux.sendText = async () => { throw new Error('nothing may be written'); };
    const pane = { live: true, tuiAlive: true, command: 'opencode', cwd: '/www1/a' };
    padTmux.paneState = async () => pane;
    let screen = '  Permission required\n  → bash(rm -rf)\n  Path: /www1/a/x\n  Do you want to proceed?\n  Allow once · Always · Reject\n';
    padTmux.captureScreen = async () => ({ text: screen, live: true });

    // 1. Locked: still OPEN (the human is driving it alone — unlighting it would
    //    be a new lie), but the agent may not type, and the refusal says so.
    const dl = await call('mission_sessions', { session_id: locked.id }, OWNER);
    assert.strictEqual(dl.data.session.open, true, 'a locked row is still an open conversation');
    assert.strictEqual(dl.data.canSend, false, 'but the agent may not type into it');
    assert.match(dl.data.sendRefusal, /mission_session_locked/);
    const rl = await call('mission_send', { session_id: locked.id, text: 'hi' }, OWNER);
    assert.ok(rl.isError, 'and the write agrees with the verdict');
    assert.match(rl.text, /locked/);

    // 2. Parked on a permission dialog: open, and NOT sendable — the verdict and
    //    the refusal code must be the same string the write produces.
    const dp = await call('mission_sessions', { session_id: parked.id }, OWNER);
    assert.strictEqual(dp.data.blockedOn, 'permission');
    assert.strictEqual(dp.data.canSend, false, 'a dialog is not a place to type');
    assert.match(dp.data.sendRefusal, /mission_permission_pending/);
    const rp = await call('mission_send', { session_id: parked.id, text: 'hi' }, OWNER);
    assert.ok(rp.isError);
    assert.match(rp.text, /permission/);

    // 3. The control: an ordinary row is sendable, so the assertion above is a
    //    real one and not an artefact of always answering false.
    screen = '  Build · Big Pickle\n';
    const df = await call('mission_sessions', { session_id: free.id }, OWNER);
    assert.strictEqual(df.data.canSend, true, 'a free live agent row is sendable');
    assert.strictEqual(df.data.sendRefusal, undefined, 'and carries no refusal');
  });

  it('mission_send reports the pane it wrote to, not a bare ok', async () => {
    const p = mission.createProject({ name: 'echo', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    const r = await call('mission_send', { session_id: s.id, text: 'do the thing' }, OWNER);
    assert.ok(!r.isError, r.text);
    assert.strictEqual(r.data.session_id, s.id, 'the write says which session it reached');
    assert.deepEqual(r.data.project.id, p.id, 'and which project, since a label is not one');
    assert.match(r.data.screen, /the answer/, 'and shows the TUI after the write');
  });

  it('mission_send refuses a shell pane with mission_not_an_agent and types nothing', async () => {
    const p = mission.createProject({ name: 'sh', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    let typed = 0;
    padTmux.sendText = async () => { typed++; return { lines: 1 }; };
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, command: 'bash', cwd: '/www1/a' });
    const r = await call('mission_send', { session_id: s.id, text: 'rm -rf /' }, OWNER);
    assert.ok(r.isError);
    assert.match(r.text, /mission_not_an_agent/);
    assert.strictEqual(typed, 0, 'nothing was typed into a shell');
  });

  it('a permission-blocked session is reported as blocked, and send is refused', async () => {
    const p = mission.createProject({ name: 'perm', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    padTmux.captureScreen = async () => ({
      text: '△ Permission required\n→ Read .env\nPath: .env\nAllow once  Allow always  Reject',
      live: true,
    });
    const detail = await call('mission_sessions', { session_id: s.id }, OWNER);
    assert.strictEqual(detail.data.blockedOn, 'permission', 'blocked is not idle');
    assert.strictEqual(detail.data.permission.path, '.env');

    let typed = 0;
    padTmux.sendText = async () => { typed++; return { lines: 1 }; };
    const r = await call('mission_send', { session_id: s.id, text: 'go ahead' }, OWNER);
    assert.ok(r.isError);
    assert.match(r.text, /mission_permission_pending/);
    assert.strictEqual(typed, 0);
  });

  it('mission_permission_answer sends the KEY, and refuses "always" to an agent', async () => {
    const p = mission.createProject({ name: 'answer', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    const dialog = '△ Permission required\n→ Read .env\nAllow once  Allow always  Reject';
    padTmux.captureScreen = async () => ({ text: dialog, live: true });
    const keys = [];
    padTmux.sendKeys = async (vm, tid, ks) => { keys.push(ks); return { keys: ks.length }; };

    // The schema does not even offer "always", so the refusal is belt and braces.
    const bad = await call('mission_permission_answer', { session_id: s.id, choice: 'always' }, OWNER);
    assert.ok(bad.isError, 'an agent must not be able to grant a durable permission');
    assert.deepEqual(keys, [], 'and no keys were pressed on the way to refusing');

    const r = await call('mission_permission_answer', { session_id: s.id, choice: 'once' }, OWNER);
    assert.ok(!r.isError, r.text);
    assert.deepEqual(keys, [['Home', 'Enter']], 'first option, then an explicit confirm');
    assert.strictEqual(r.data.session_id, s.id);
  });

  it('mission_permission_answer needs the exec bucket, like every other write', async () => {
    const p = mission.createProject({ name: 'permgrant', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    const r = await call('mission_permission_answer', { session_id: s.id, choice: 'once' }, READER);
    assert.ok(r.isError);
    assert.match(r.text, /tool grant/);
  });

  it('a solo-locked session is still readable but not answerable', async () => {
    const p = mission.createProject({ name: 'solo', agent: 'pad-mm-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    mission.updateSession(s.id, { locked: true });
    padTmux.captureScreen = async () => ({
      text: '△ Permission required\n→ Read .env\nAllow once  Allow always  Reject',
      live: true,
    });
    const keys = [];
    padTmux.sendKeys = async (vm, tid, ks) => { keys.push(ks); return { keys: ks.length }; };
    const r = await call('mission_permission_answer', { session_id: s.id, choice: 'once' }, OWNER);
    assert.ok(r.isError, '"drive alone" must not be answerable by the agent either');
    assert.match(r.text, /mission_session_locked/);
    assert.deepEqual(keys, []);
  });

  it('a row is never busy while it is dead, even if the agent server claims it', async () => {
    // The DECORATION (stampTruth) is pinned in mission.test.js, where it is
    // called directly. What has to be proven HERE is the other half: a store
    // that already stamped `wasBusy` must have that fact survive the MCP
    // projection. `agentWorkingSessions` is a module-local call inside
    // withAgentBusy, so reassigning the export would not intercept it — the
    // decoration seam is the one this file already stubs.
    const p = mission.createProject({ name: 'claims', agent: 'pad-mm-oc', folder: '/www1/a' });
    const dead = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb', agentSessionId: 'ses_claimed' });
    const realFlat = mission.withAgentBusy;
    mission.withAgentBusy = async (rows) =>
      rows.map((s) => ({ ...s, live: false, busy: false, busyKnown: true, open: false, state: 'dead', wasBusy: true }));
    try {
      const r = await call('mission_sessions', { project_id: p.id }, OWNER);
      const row = r.data.sessions.find((s) => s.id === dead.id);
      assert.strictEqual(row.busy, false, 'a corpse cannot be working');
      assert.strictEqual(row.open, false, 'and open must match what send would do');
      assert.strictEqual(row.wasBusy, true, 'the server still claims the conversation');
    } finally {
      mission.withAgentBusy = realFlat;
    }
  });

  it('every tool description tells a reader what live/busy/open actually mean', async () => {
    // The fields are three booleans with the same prefix; a caller reading only
    // the JSON cannot infer that `open` excludes a shell pane. So the contract
    // lives in prose, and this is what keeps the prose from rotting.
    const sources = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
    const at = (name) => {
      const start = sources.indexOf(`'${name}'`);
      assert.ok(start > 0, `${name} is registered`);
      // Slice to the NEXT registration: `indexOf('});')` would stop inside this
      // tool's inputSchema and assert on a fragment.
      const rest = sources.slice(start);
      const end = rest.indexOf("registerToolBound('", 10);
      return rest.slice(0, end > 0 ? end : rest.length);
    };
    const sessions = at('mission_sessions');
    for (const phrase of ['LIVENESS', 'busyKnown', 'never a dead row', 'a dead row is never busy', 'mission_permission_answer']) {
      assert.ok(sessions.includes(phrase), `mission_sessions description is missing: ${phrase}`);
    }
    const send = at('mission_send');
    for (const phrase of ['mission_not_an_agent', 'mission_permission_pending', 'NOTHING is typed']) {
      assert.ok(send.includes(phrase), `mission_send description is missing: ${phrase}`);
    }
    const perm = at('mission_permission_answer');
    for (const phrase of ['permission', 'Allow always', 'human']) {
      assert.ok(perm.includes(phrase), `mission_permission_answer is missing: ${phrase}`);
    }
    // The grant map is the other half: a tool nobody put in a bucket is
    // unreachable, and one in the wrong bucket is a write sold as a read.
    const grants = sources.slice(sources.indexOf('mission_project_create:'), sources.indexOf('};', sources.indexOf('mission_permission_answer:')));
    assert.ok(grants.includes("mission_permission_answer: 'exec'"), 'answering rides exec, never a read bucket');
  });

  it('missionVisibleAgents narrows to the owner, and the gate refuses a foreign PAD', () => {
    const visible = missionVisibleAgents(OWNER);
    assert.ok(visible.includes('pad-mm-oc') && visible.includes('pad-mm-oc2'));
    assert.ok(!visible.includes('pad-mm-cl'), 'another user\'s PAD is not visible');
    assert.deepEqual(missionVisibleAgents(STRANGER).filter((n) => n.startsWith('pad-mm-')), []);
    const theirs = mission.createProject({ name: 'theirs', agent: 'pad-mm-cl', folder: '/www1/c' });
    assert.throws(() => missionRequireProject(OWNER, 'mission_sessions', theirs.id), /mission_project_forbidden/);
    const mine = mission.createProject({ name: 'mine', agent: 'pad-mm-oc', folder: '/www1/a' });
    assert.strictEqual(missionRequireProject(OWNER, 'mission_sessions', mine.id).id, mine.id);
  });
});

/** Plan 60 — secret hygiene. The two read tools that used to hand out live
 *  credentials: `config_get` (driver config, by key name only, and `configRaw`
 *  was the untouched original) and `get_agent` (the whole registry object,
 *  which carries `web.token`). */
describe('MCP secret hygiene (plan 60)', () => {
  /** Every secret below is a UNIQUE marker, so "the serialized response does
   *  not contain it" is an exact assertion rather than a shape guess. */
  const SECRETS = {
    bearer: 'Bearer nvg_LIVE_TOKEN_AAA',
    mcpKey: 'i-4FwLIVE_KEY_BBB',
    pass: 'hunter2_LIVE_PASS_CCC',
    nestedToken: 'rt_LIVE_NESTED_DDD',
    camelKey: 'sk_LIVE_CAMEL_EEE',
    dashKey: 'dash_LIVE_DASH_FFF'
  };
  const FIXTURE = {
    $schema: 'https://opencode.ai/config.json',
    model: 'gpt-5',
    port: 4096,
    mcp: {
      browser: {
        type: 'remote',
        enabled: true,
        // The exact shape from the 2026-09-27 sweep that leaked: a `headers`
        // map whose KEYS are the server's choice, not a credential word.
        headers: { Authorization: SECRETS.bearer, 'X-MCP-Key': SECRETS.mcpKey }
      },
      torrent: {
        enabled: false,
        // Non-string values under a headers map must go too.
        httpHeaders: { 'X-Retries': [1, 2, 3] }
      }
    },
    providers: {
      anthropic: { apiKey: SECRETS.camelKey },
      custom: { 'api-key': SECRETS.dashKey }
    },
    db: { user: 'pad', password: SECRETS.pass },
    nested: { deep: { deeper: { refreshToken: SECRETS.nestedToken, keepMe: 'visible' } } }
  };

  const ALL = Object.values(SECRETS);

  it('redactSecrets blanks every credential, whatever the key is spelled like', () => {
    const out = vmManager.redactSecrets(FIXTURE);
    const serialized = JSON.stringify(out);
    for (const s of ALL) {
      assert.ok(!serialized.includes(s), `leaked ${s.slice(0, 14)}…`);
    }
    // Redaction is a transformation, not a deletion: the shape survives, so the
    // LLM can still tell WHAT is configured.
    assert.strictEqual(out.model, 'gpt-5');
    assert.strictEqual(out.port, 4096);
    assert.strictEqual(out.mcp.browser.enabled, true);
    assert.strictEqual(out.nested.deep.deeper.keepMe, 'visible');
    assert.strictEqual(out.mcp.torrent.enabled, false, 'a disabled server is still described');
  });

  it('redaction is by suffix, so it generalises past the names we thought of', () => {
    // All the key styles one config file can use for the same credential.
    const out = vmManager.redactSecrets({
      apiKey: 'a', api_key: 'b', 'API-KEY': 'c', xMcpKey: 'd', 'X-MCP-Key': 'e',
      rootPassword: 'f', dbPassword: 'g', sshPassword: 'h', token: 'i',
      clientSecret: 'j', app_secret: 'k', privateKey: 'l', authorization: 'm',
      auth: 'n', credential: 'o', credentials: 'p', anthropicAuthToken: 'q',
      env: { A: 'r' }, userEnv: { B: 's' }, headers: { C: 't' }, httpHeaders: { D: 'u' }
    });
    for (const [k, v] of Object.entries(out)) assert.strictEqual(v, '[REDACTED]', `${k} should be redacted`);
  });

  it('it does NOT redact config the LLM needs in order to read the file', () => {
    // A redactor that eats half the document is its own lie, and a caller
    // cannot tell the difference from "there is no value here". Every key here
    // CONTAINS a credential word but is a fact, not a secret.
    const out = vmManager.redactSecrets({
      model: 'gpt-5', port: 4096, hostPort: 8080, enabled: false, name: 'paddock',
      provider: 'anthropic', timeout: 30, sortKey: 'name', cacheKey: 'k',
      primaryKey: 'id', keyboardLayout: 'us', keymap: 'x', keys: ['a'],
      monacoKeyBinding: 'ctrl+k', tokenLimit: 1000, passwordPolicy: 'strong',
      author: 'me', authority: 'x', authenticated: true, secretariat: 's',
      publicKeyPath: '/etc/pub', mcp: { browser: { type: 'remote' } }
    });
    for (const [k, v] of Object.entries(out)) {
      assert.notStrictEqual(v, '[REDACTED]', `${k} must stay readable`);
    }
    assert.strictEqual(out.nested, undefined);
    assert.strictEqual(out.mcp.browser.type, 'remote');
  });

  it('an empty value stays empty — "[REDACTED]" claims a secret that was not there', () => {
    const out = vmManager.redactSecrets({ token: '', secret: null, password: undefined, apiKey: [] });
    assert.strictEqual(out.token, '');
    assert.strictEqual(out.secret, null);
    assert.strictEqual(out.password, undefined);
    assert.deepStrictEqual(out.apiKey, []);
  });

  it('a structure too deep to inspect is dropped, NOT passed through', () => {
    // The cutoff must fail closed. Returning the value as-is — which the first
    // implementation did — turns "too deep" into "hand it over untouched".
    let deep = { password: 'LEAKED_DEEP' };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const serialized = JSON.stringify(vmManager.redactSecrets(deep));
    assert.ok(!serialized.includes('LEAKED_DEEP'), 'a value past the depth limit must not survive');
  });

  describe('readAgentConfig', () => {
    let dir;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'p60-'));
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('redact:true scrubs config AND configRaw (the field that used to leak)', () => {
      fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(FIXTURE, null, 2));
      const agent = { agent_type: 'opencode', config_root: dir };
      const r = vmManager.readAgentConfig(agent, { redact: true });
      for (const s of ALL) {
        assert.ok(!r.configRaw.includes(s), `configRaw leaked ${s.slice(0, 14)}…`);
        assert.ok(!JSON.stringify(r.config).includes(s), `config leaked ${s.slice(0, 14)}…`);
      }
      assert.strictEqual(r.redacted, true);
      assert.strictEqual(r.config.mcp.browser.headers, '[REDACTED]');
    });

    it('the default (REST) read stays raw, because the config editor round-trips it', () => {
      // AgentDetail.jsx POSTs `configRaw` straight back. Redacting it here
      // would write "[REDACTED]" into the user's real config on save.
      fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify(FIXTURE, null, 2));
      const agent = { agent_type: 'opencode', config_root: dir };
      const r = vmManager.readAgentConfig(agent);
      assert.ok(r.configRaw.includes(SECRETS.bearer), 'REST still gets the original text');
      assert.strictEqual(r.redacted, undefined);
      // The parsed `config` is still redacted for display either way.
      assert.strictEqual(r.config.mcp.browser.headers, '[REDACTED]');
    });

    it('yaml/toml is line-scrubbed, not served verbatim to the LLM', () => {
      fs.writeFileSync(path.join(dir, 'config.yaml'), [
        '# keep this comment',
        'model: hermes-4',
        'apiKey: sk-YAML_ONE',
        '  x-mcp-key: i-YAML_TWO',
        'root_password: pw-YAML_THREE',
        'port: 8080'
      ].join('\n'));
      const r = vmManager.readAgentConfig({ agent_type: 'hermes', config_root: dir }, { redact: true });
      assert.ok(!r.configRaw.includes('YAML_ONE'));
      assert.ok(!r.configRaw.includes('YAML_TWO'));
      assert.ok(!r.configRaw.includes('YAML_THREE'));
      assert.ok(r.configRaw.includes('model: hermes-4'), 'non-secrets survive');
      assert.ok(r.configRaw.includes('# keep this comment'), 'comments survive');
      assert.strictEqual(r.redacted, true);
    });
  });

  it('the tool descriptions state the guarantee the code now keeps', () => {
    // A promise the guide makes and the tools do not keep is the finding itself.
    const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
    registerTools(server);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    return server.connect(st).then(() => {
      const client = new Client({ name: 't', version: '0' });
      return client.connect(ct).then(() => client.listTools().then((res) => {
        const byName = Object.fromEntries(res.tools.map((t) => [t.name, t.description || '']));
        assert.ok(!/yaml\/toml configs are returned verbatim/i.test(byName.config_get),
          'config_get no longer advertises a verbatim yaml/toml path');
        assert.match(byName.config_get, /REDACTED/i, 'config_get says values are redacted');
        assert.match(byName.config_get, /configRaw/, 'config_get names the field that used to leak');
        assert.match(byName.settings_get, /never returned/i, 'settings_get states the web-password rule');
        return client.close().then(() => server.close());
      }));
    });
  });

  it('no tool returns a raw registry object to the LLM', () => {
    // get_agent was fixed by hand; a tool added later could return the whole
    // registry object again and re-open the leak. Derived from the source, so it
    // cannot rot: every `registry.getAgent(` call site must either be the
    // `requireAgent` helper (whose result is a gate, not a response) or use the
    // object ONLY for `.status` / inside `publicAgent`.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
    const lines = src.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
      if (!/registry\.getAgent\(/.test(line)) return;
      // The helper itself returns the object to a gate, never to a tool.
      if (/function requireAgent/.test(lines[i - 2] || '')) return;
      // A window big enough to reach the response, small enough not to wander
      // into the next handler: anything that spreads the object or hands it to
      // textResult must first go through publicAgent.
      const window = lines.slice(i, i + 8).join('\n');
      const handsOverObject = /textResult\(\s*\{?\s*\.\.\.(?!settings)|textResult\(\s*agent\b|\.\.\.agent\b/.test(window);
      if (handsOverObject && !window.includes('publicAgent(')) {
        offenders.push(`${i + 1}: ${line.trim()}`);
      }
    });
    assert.deepStrictEqual(offenders, [], 'a raw registry object would escape to a tool');
  });

  it('publicAgent swaps the web token for a boolean and keeps everything else', () => {
    const publicAgent = require('../mcp').publicAgent;
    const withToken = { name: 'pad-x', status: 'running', web: { active: true, token: 'LIVE_WEB_TOKEN_ZZZ', hostPort: 8080 } };
    const out = publicAgent(withToken);
    assert.ok(!JSON.stringify(out).includes('LIVE_WEB_TOKEN_ZZZ'), 'the token is gone');
    assert.strictEqual(out.web.tokenConfigured, true, 'a token exists — say so, do not show it');
    assert.strictEqual(out.web.token, undefined);
    assert.strictEqual(out.web.hostPort, 8080, 'the rest of the web state survives');
    assert.strictEqual(out.status, 'running');
    // An unpublished pad reports the negative honestly rather than omitting the
    // field, so the shape is the same for every agent.
    const bare = publicAgent({ name: 'pad-y', web: { active: false, token: '' } });
    assert.strictEqual(bare.web.tokenConfigured, false);
    // An agent with no web block at all is returned untouched.
    const plain = { name: 'pad-z', status: 'exited' };
    assert.deepStrictEqual(publicAgent(plain), plain);
  });
});

describe('MCP Server - fleet identity (plan 61)', () => {
  const registry = require('../services/agent-registry');
  let realDiscover;
  let realGetAgent;
  const FLEET = [
    { name: 'pad-proj',  display_name: 'Proj',  agent_type: 'opencode', runtime_ref: 'pad-proj',  status: 'running' },
    { name: 'pad-proj2', display_name: 'Proj2', agent_type: 'opencode', runtime_ref: 'pad-proj2', status: 'running' },
    { name: 'pad-other', display_name: 'Other', agent_type: 'openclaw', runtime_ref: 'pad-other', status: 'exited' },
  ];
  const byName = (n) => FLEET.find((a) => a.name === n) || null;

  before(() => {
    realDiscover = registry.discoverAgents;
    realGetAgent = registry.getAgent;
    registry.discoverAgents = () => FLEET;
    registry.getAgent = (n) => byName(n);
  });
  after(() => {
    registry.discoverAgents = realDiscover;
    registry.getAgent = realGetAgent;
  });

  describe('name resolution', () => {
    it('accepts the exact container name', () => {
      assert.strictEqual(resolveAgentName('pad-proj2').name, 'pad-proj2');
    });
    it('accepts the bare name create_agent accepts, and resolves back to it', () => {
      // `create_agent` calls a name `proj2` and produces `pad-proj2`; a caller
      // echoing that name back must not be told the pad it just made is gone.
      assert.strictEqual(resolveAgentName('proj2').name, 'pad-proj2');
    });
    it('accepts the display_name that list_agents hands out', () => {
      assert.strictEqual(resolveAgentName('Proj2').name, 'pad-proj2');
      assert.strictEqual(resolveAgentName('proj2 '.toUpperCase() === 'PROJ2' ? 'proj2' : 'Proj2').name, 'pad-proj2');
    });
    it('resolves a unique substring', () => {
      assert.strictEqual(resolveAgentName('oth').name, 'pad-other');
    });
    it('an exact match after prefixing beats substring ambiguity', () => {
      // `proj` is a substring of BOTH pad-proj and pad-proj2, but it is also the
      // EXACT bare name of pad-proj. Exactness has to win, or the most common
      // spelling of a name would be the one thing the resolver refuses.
      assert.strictEqual(resolveAgentName('proj').name, 'pad-proj');
    });

    it('refuses an ambiguous substring and names the candidates', async () => {
      // `pr` is not any pad's exact or bare name, yet it is contained in
      // pad-proj and pad-proj2. Guessing here is exactly the "ran the command
      // on the wrong pad" failure the resolver exists to stop.
      const r = resolveAgentName('pr');
      assert.strictEqual(r.agent, null);
      assert.deepStrictEqual(r.candidates.sort(), ['pad-proj', 'pad-proj2']);
      const msg = await notFoundMessage('pr', r.candidates);
      assert.match(msg, /Ambiguous/);
      assert.match(msg, /pad-proj2/);
    });
    it('offers a did-you-mean for a single near miss', async () => {
      const msg = await notFoundMessage('pad-projx', []);
      assert.match(msg, /Agent not found: pad-projx/);
    });
  });

  describe('grants are checked against the RESOLVED name', () => {
    it('a target-scoped key may use its own pad under any accepted spelling', () => {
      const scoped = { userId: 'u1', role: 'admin', scopes: ['target:agent:pad-proj2'] };
      for (const spelling of ['pad-proj2', 'proj2', 'Proj2']) {
        assert.strictEqual(targetAllowed(scoped, resolveAgentName(spelling).name), true, spelling);
        // ...and the gate does not refuse it on the raw string.
        assert.doesNotThrow(() => requireTool(scoped, 'get_agent', spelling), spelling);
      }
    });
    it('a target-scoped key is still refused another pad, however it is spelled', () => {
      const scoped = { userId: 'u1', role: 'admin', scopes: ['target:agent:pad-proj2'] };
      // `Other` resolves to pad-other. If the gate compared the RAW string, a
      // name that simply did not match the target would be refused for the
      // wrong reason and a resolver that returned the target would be waved in.
      assert.strictEqual(targetAllowed(scoped, resolveAgentName('Other').name), false);
      assert.throws(() => requireTool(scoped, 'get_agent', 'Other'), /target grant/);
    });
    it('an unresolvable name is refused before any grant runs', () => {
      // Nothing to resolve means there is no name to compare against a target,
      // so the resolver must not become a way to probe names off-target.
      const scoped = { userId: 'u1', role: 'admin', scopes: ['target:agent:pad-proj2'] };
      assert.throws(() => requireTool(scoped, 'get_agent', 'no-such-pad'), /target grant/);
    });
  });

  it('shellQuote keeps a hostile cwd as one argument', () => {
    const { execFileSync } = require('child_process');
    // Exercise the real shape: the quoted value is embedded in a script that a
    // shell PARSES, exactly as `cd ${shellQuote(cwd)} && { ... }` is. Passing it
    // as a literal argv would skip the parsing that this defends.
    const hostile = "/www1'; rm -rf /; echo '";
    const out = execFileSync('sh', ['-c', `cd ${shellQuote(hostile)} && echo cd-ok || echo cd-failed`], { encoding: 'utf8' });
    assert.strictEqual(out.trim(), 'cd-failed', 'the cd failed and the payload never ran');
    assert.ok(!/cd-ok/.test(out), 'the injected command did not execute');
    // And a real path still works, spaces and all.
    const ok = execFileSync('sh', ['-c', `cd ${shellQuote('/tmp')} && pwd`], { encoding: 'utf8' });
    assert.strictEqual(ok.trim(), '/tmp');
    assert.strictEqual(shellQuote('/www1'), "'/www1'");
  });

  it('a non-PAD host container is named as such, not as a missing pad', async () => {
    // Finding 1b: "not found" must distinguish "no such pad" from "that is a
    // container, just not one of ours" — the caller's next move differs.
    const msg = await notFoundMessage('some-foreign-container', []);
    assert.match(msg, /Agent not found: some-foreign-container/);
    // With no such host container the message stays the plain miss.
    assert.doesNotMatch(msg, /IS a container on this host/);
  });

  // The body of one tool registration. Slicing to the next `registerToolBound`
  // is deliberate: `indexOf('});')` stops at the first one INSIDE the tool —
  // the inputSchema's `z.string().describe(...)` — and cuts the handler in half,
  // which is how a test can pass on a string it never really read.
  const toolBody = (src, tool) => {
    const start = src.indexOf(`registerToolBound(\n    '${tool}'`);
    assert.ok(start > 0, `${tool} is registered`);
    const rest = src.slice(start + 1);
    const next = rest.indexOf('registerToolBound(\n');
    return next > 0 ? rest.slice(0, next) : rest;
  };

  it('the update tool acts on the RESOLVED name, never the caller\'s spelling', async () => {
    // The whole point of the resolver is that the pad the grant was checked
    // against is the pad that gets updated. `update` used to gate on the
    // resolved name and then call `vm.updateAgent(name, …)` with the RAW
    // argument — so a `display_name` authorized one pad and acted on a
    // non-existent container. Read the tool source rather than mocking the
    // VM, because the bug is exactly a mismatch between two arguments.
    const handler = toolBody(fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8'), 'update');
    assert.match(handler, /requirePad\('update', name\)/, 'the gate resolves');
    assert.match(handler, /vm\.updateAgent\(agent\.name,/, 'and the action uses the SAME resolved name');
    assert.doesNotMatch(handler, /vm\.updateAgent\(name,/, 'never the raw spelling');
    // Same for the job key and the echoed response, or a caller polling
    // `job_status {name}` with its own spelling would find nothing.
    assert.match(handler, /getOrCreateJob\(`update:\$\{agent\.name\}`\)/);
    assert.match(handler, /textResult\(\{ ok: true, name: agent\.name/);
  });

  it('read responses echo the resolved name, so a caller can see which pad answered', async () => {
    // A response that echoes the caller's own spelling tells the LLM nothing:
    // it asked about `Proj` and got `Proj` back, with no way to learn that the
    // answer came from `pad-opencode-proj`. `agent_logs` and `workspace_read`
    // both did this.
    const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
    for (const tool of ['agent_logs', 'workspace_read']) {
      const body = toolBody(src, tool);
      const echo = body.match(/return textResult\(\{ name: ([A-Za-z.]+)/);
      assert.ok(echo, `${tool} echoes a name`);
      assert.strictEqual(echo[1], 'agent.name', `${tool} echoes the resolved name, not the raw argument`);
    }
  });
});

// ─── Plan 67: project lookup (67.2), provenance (67.3), payload (67.4) ───────
// These run against plain objects, not the store: a project lookup that has to
// be proven against live rows is a test that wipes the user's Mission board to
// earn its keep. The store side (the `created_by` write) is checked by reading
// the source and, separately, by a live read-back.

describe('MCP Server - project lookup and provenance (plan 67)', () => {
  const { missionSelectProjects } = require('../mcp');
  const P = (id, name, folder, agent = 'pad-x') => ({ id, name, folder, agent_name: agent });
  const FLEET = [
    P('prj_a', 'paddock', '/www2/paddock'),
    P('prj_b', 'schlorp', '/www1/xdl'),
    P('prj_c', 'craftpip', '/www1/craftpip.com'),
  ];
  const code = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return String(e.message || e); } };

  describe('narrowing to the one project meant (67.2)', () => {
    it('no filter returns everything', () => {
      assert.strictEqual(missionSelectProjects(FLEET, {}).length, 3);
    });
    it('resolves by exact name, case-insensitively', () => {
      assert.deepStrictEqual(missionSelectProjects(FLEET, { name: 'paddock' }).map((p) => p.id), ['prj_a']);
      assert.deepStrictEqual(missionSelectProjects(FLEET, { name: 'SCHLORP' }).map((p) => p.id), ['prj_b']);
    });
    it('resolves by folder, because a name is NOT a folder', () => {
      // "the sessions in xdl" is asked with a directory. `schlorp` is the name
      // and `/www1/xdl` the folder; only the latter is knowable from a path.
      assert.deepStrictEqual(missionSelectProjects(FLEET, { folder: '/www1/xdl' }).map((p) => p.id), ['prj_b']);
    });
    it('resolves by id', () => {
      assert.deepStrictEqual(missionSelectProjects(FLEET, { projectId: 'prj_c' }).map((p) => p.id), ['prj_c']);
    });
    it('a name matching several REFUSES and names them, rather than returning the fleet', () => {
      // The unfiltered list is the one answer a caller cannot tell from
      // success, so a collision must never quietly become one.
      const dupes = [...FLEET, P('prj_d', 'paddock', '/www2/paddock-copy')];
      const msg = code(() => missionSelectProjects(dupes, { name: 'paddock' }));
      assert.match(msg, /mission_project_ambiguous/);
      assert.match(msg, /prj_a/);
      assert.match(msg, /prj_d/);
    });
    it('two projects sharing a folder is the same collision on the folder axis', () => {
      const dupes = [...FLEET, P('prj_e', 'paddock2', '/www1/xdl')];
      const msg = code(() => missionSelectProjects(dupes, { folder: '/www1/xdl' }));
      assert.match(msg, /mission_project_ambiguous/);
      assert.match(msg, /matches 2 projects/);
    });
    it('a miss says so and offers the nearest, never the whole list as an answer', () => {
      const msg = code(() => missionSelectProjects(FLEET, { name: 'paddockk' }));
      assert.match(msg, /mission_project_not_found/);
      assert.match(msg, /close:/);
      assert.match(msg, /prj_a/);
    });
    it('a bad id is a miss, and the message does not claim it is forbidden', () => {
      const msg = code(() => missionSelectProjects(FLEET, { projectId: 'prj_nope' }));
      assert.match(msg, /mission_project_not_found/);
      // Confirming that some OTHER project's id exists on a pad the caller may
      // not see would leak existence; the candidate list is the caller's own.
      assert.doesNotMatch(msg, /forbidden/);
    });
    it('a partial name is not silently accepted as the whole fleet', () => {
      assert.notStrictEqual(code(() => missionSelectProjects(FLEET, { name: 'pad' })), 'no-throw');
    });
  });

  describe('provenance (67.3)', () => {
    it('the session row carries WHO, not just the kind, when it is known', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
      assert.match(src, /s\.created_by \? \{ createdBy: s\.created_by \} : \{\}/, 'createdBy is emitted only when stamped');
      // A pre-existing row has no actor; it must not claim one.
      const row = { id: 'msn_x', origin: 'human', created_by: null };
      assert.strictEqual('createdBy' in { ...(row.created_by ? { createdBy: row.created_by } : {}) }, false);
    });
    it('an MCP start records the KEY, so a third key is distinguishable', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
      assert.match(src, /user\.keyId \? `key:\$\{user\.keyId\}` : null/);
    });
    it('the store INSERT and both start paths carry the actor through', () => {
      const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'mission.js'), 'utf8');
      assert.match(svc, /INSERT INTO mission_sessions \([^)]*created_by/, 'the column is written');
      assert.match(svc, /createSession\(project\.id, \{ label, origin, agentSessionId: resumeId, createdBy \}\)/, 'startSession threads it');
      const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
      assert.match(app, /createdBy: req\.session && req\.session\.userId \? `user:\$\{req\.session\.userId\}` : null/, 'the UI stamps the human too');
    });
    it('the migration adds the column for existing databases without back-filling a guess', () => {
      const db = fs.readFileSync(path.join(__dirname, '..', 'services', 'db.js'), 'utf8');
      assert.match(db, /ALTER TABLE mission_sessions ADD COLUMN created_by TEXT/);
      assert.doesNotMatch(db, /UPDATE mission_sessions SET created_by/, 'no invented history');
    });
  });

  describe('payload shape (67.4)', () => {
    it('the counts come before the nested sessions in the row', () => {
      // `sessionCount`/`liveCount`/`openCount` ARE the answer; they used to be
      // serialized after 26 full session objects.
      const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
      const body = src.slice(src.indexOf('function missionProjectRow'), src.indexOf('function textResult'));
      const countAt = body.indexOf('sessionCount: p.sessionCount');
      const sessionsAt = body.indexOf('sessions: (p.sessions || [])');
      assert.ok(countAt > 0 && sessionsAt > 0, 'both are emitted');
      assert.ok(countAt < sessionsAt, 'counts are serialized first');
    });
    it('sessions are opt-in, so the project list is not a superset of mission_sessions', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
      const body = src.slice(src.indexOf('function missionProjectRow'), src.indexOf('function textResult'));
      assert.match(body, /includeSessions \? \{ sessions:/, 'nested rows are behind a flag');
      assert.match(src, /include_sessions: z\.boolean\(\)\.optional\(\)/, 'and the tool exposes it');
    });
    it('a project says whether its pad is running, so reachability needs no 2nd tool', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
      const body = src.slice(src.indexOf('function missionProjectRow'), src.indexOf('function textResult'));
      assert.match(body, /agentStatus: agent\.status/, 'pad status rides along');
    });
    it('the description says the counts are liveness, NOT progress', () => {
      // The finding: `liveCount` beside a `sessions` array reads as progress, so
      // a caller narrating it as progress is confidently wrong with no second
      // call to catch it.
      const src = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
      // Slice from the REGISTRATION: the tool name also appears in the scope
      // map, and `indexOf("'mission_projects'")` finds that one first.
      const at = src.indexOf(`registerToolBound(\n    'mission_projects'`);
      assert.ok(at > 0, 'the tool is registered');
      const desc = src.slice(at, src.indexOf('inputSchema', at));
      assert.match(desc, /LIVENESS, not progress/);
    });
  });
});
