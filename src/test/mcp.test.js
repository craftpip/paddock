const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, authenticateRequest, SERVER_NAME, SERVER_VERSION, targetAllowed, toolAllowed, requireTool } = require('../mcp');
const apiKeys = require('../services/api-keys');

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
