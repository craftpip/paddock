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

  it('initializes and lists paddock_* tools', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name);
    assert.ok(names.includes('paddock_list_agents'), 'has paddock_list_agents');
    assert.ok(names.includes('paddock_get_agent'));
    assert.ok(names.includes('paddock_start_agent'));
    assert.ok(names.includes('paddock_stop_agent'));
    assert.ok(names.includes('paddock_restart_agent'));
    assert.ok(names.includes('paddock_exec'));
    assert.ok(names.includes('paddock_workspace_list'));
    assert.ok(names.includes('paddock_workspace_read'));
    assert.ok(names.includes('paddock_workspace_write'));
    assert.ok(names.includes('paddock_agent_logs'));
    assert.ok(names.includes('paddock_config_get'));
  });

  it('tool schemas carry name params', async () => {
    const result = await client.listTools();
    const exec = result.tools.find((t) => t.name === 'paddock_exec');
    assert.ok(exec.inputSchema.properties.command, 'exec has command param');
    assert.ok(exec.inputSchema.properties.name, 'exec has name param');
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
