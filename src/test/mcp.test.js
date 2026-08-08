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
    assert.ok(names.includes('exec'));
    assert.ok(names.includes('workspace_list'));
    assert.ok(names.includes('workspace_read'));
    assert.ok(names.includes('workspace_write'));
    assert.ok(names.includes('agent_logs'));
    assert.ok(names.includes('config_get'));
  });

  it('tool schemas carry name params', async () => {
    const result = await client.listTools();
    const exec = result.tools.find((t) => t.name === 'exec');
    assert.ok(exec.inputSchema.properties.command, 'exec has command param');
    assert.ok(exec.inputSchema.properties.name, 'exec has name param');
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
