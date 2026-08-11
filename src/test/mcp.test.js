const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { registerTools, authenticateRequest, SERVER_NAME, SERVER_VERSION } = require('../mcp');

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
