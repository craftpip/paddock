const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

const apiKeys = require('./services/api-keys');
const registry = require('./services/agent-registry');
const workspace = require('./services/workspace');
const logStore = require('./services/log-store');
const { getDb } = require('./services/db');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const PREFIX = process.env.CONTAINER_PREFIX || 'vm';
const VM_NAME_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-zA-Z0-9][a-zA-Z0-9_-]*$');
const MAX_READ_BYTES = 256 * 1024;
const SERVER_NAME = 'paddock';
const SERVER_VERSION = '1.0.0';

const mcpContext = new AsyncLocalStorage();

function currentUser() {
  const store = mcpContext.getStore();
  return store ? store.user : null;
}

function safeVmName(name) {
  return name && VM_NAME_RE.test(name) ? name : null;
}

function runCmd(cmd, args, options = {}) {
  const { timeout = 30000, check = false } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args || [], { timeout }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          reject(new Error(`Command timed out after ${timeout}s: ${cmd} ${(args || []).join(' ')}`));
        } else if (err.code === 'ENOENT') {
          reject(new Error(`Command not found: ${cmd}`));
        } else if (check && err.code !== 0) {
          reject(new Error(`Command failed: ${cmd} ${(args || []).join(' ')}\n${stderr}`));
        } else {
          resolve({ stdout: stdout || '', stderr: stderr || '', code: err.code });
        }
      } else {
        resolve({ stdout, stderr, code: 0 });
      }
    });
  });
}

async function dockerExec(vmName, cmd, timeout = 30000) {
  return runCmd('docker', ['exec', '-i', vmName, 'sh', '-lc', cmd], { timeout });
}

function getUserRole(userId) {
  try {
    const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId);
    return row ? row.role : 'user';
  } catch {
    return 'user';
  }
}

function canAccess(user, agentName) {
  if (user.role === 'admin') return true;
  if (!user.userId) return false;
  try {
    const row = getDb().prepare('SELECT owner_id FROM agents WHERE name = ?').get(agentName);
    return !!row && row.owner_id === user.userId;
  } catch {
    return false;
  }
}

function requireAccess(user, agentName) {
  if (!canAccess(user, agentName)) {
    throw new McpError(ErrorCode.InvalidRequest, `Access denied or agent not found: ${agentName}`);
  }
}

function requireAgent(agentName) {
  const agent = registry.getAgent(agentName);
  if (!agent) throw new McpError(ErrorCode.InvalidRequest, `Agent not found: ${agentName}`);
  return agent;
}

function redactConfig(raw) {
  const redacted = JSON.parse(JSON.stringify(raw));
  if (redacted.api_keys) redacted.api_keys = '[REDACTED]';
  if (redacted.channels?.telegram?.botToken) redacted.channels.telegram.botToken = '[REDACTED]';
  if (redacted.plugins) {
    for (const key of Object.keys(redacted.plugins)) {
      if (redacted.plugins[key]?.key) redacted.plugins[key].key = '[REDACTED]';
    }
  }
  return redacted;
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function registerTools(server) {
  // ─── Read / inspect ─────────────────────────────────────────

  server.registerTool(
    'paddock_list_agents',
    {
      title: 'List PADs',
      description: 'List all PAD agents managed by paddock. Returns name, status, agent type, and default model. Admins see the full fleet; regular users see only the agents they own.',
      inputSchema: {},
    },
    async (args) => {
      const user = currentUser();
      const agents = registry.discoverAgents()
        .filter((a) => !user || canAccess(user, a.name))
        .map((a) => ({
          name: a.name,
          status: a.status,
          display_name: a.display_name,
          agent_type: a.agent_type,
          runtime_ref: a.runtime_ref,
          default_model: a.default_model,
          default_provider: a.default_provider,
        }));
      return textResult({ agents });
    }
  );

  server.registerTool(
    'paddock_get_agent',
    {
      title: 'Get PAD details',
      description: 'Get full details about a single PAD agent.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      return textResult(requireAgent(name));
    }
  );

  server.registerTool(
    'paddock_agent_logs',
    {
      title: 'PAD container logs',
      description: 'Return the last N lines of a PAD container\'s logs (docker logs).',
      inputSchema: {
        name: z.string().describe('PAD name'),
        tail: z.number().int().min(1).max(5000).optional().describe('Number of lines (default 100, max 5000)'),
      },
    },
    async ({ name, tail }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      await logStore.capture(agent.name);
      const logs = logStore.readLogs(agent.name, Math.min(tail || 100, 5000));
      return textResult({ name, logs });
    }
  );

  server.registerTool(
    'paddock_config_get',
    {
      title: 'Read PAD config',
      description: 'Read a PAD\'s openclaw.json config with secrets redacted (api_keys, telegram bot token, plugin keys).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      const configPath = path.join(agent.config_root, 'openclaw.json');
      if (!fs.existsSync(configPath)) return textResult({ name, config: null });
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return textResult({ name, config: redactConfig(raw) });
    }
  );

  server.registerTool(
    'paddock_workspace_list',
    {
      title: 'List PAD workspace directory',
      description: 'List the contents of a directory inside a PAD\'s workspace. Safe path resolution prevents traversal.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        path: z.string().optional().describe('Relative workspace path (default: root)'),
      },
    },
    async ({ name, path: relPath }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      const listing = workspace.listDir(agent.name, relPath || '/');
      return textResult({ name, ...listing });
    }
  );

  server.registerTool(
    'paddock_workspace_read',
    {
      title: 'Read PAD workspace file',
      description: 'Read a text file from a PAD\'s workspace. Text only; files larger than 256KB are rejected.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        path: z.string().describe('Relative workspace file path'),
      },
    },
    async ({ name, path: relPath }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      const stat = workspace.statFile(agent.name, relPath);
      if (!stat) throw new McpError(ErrorCode.InvalidRequest, `File not found: ${relPath}`);
      if (stat.size > MAX_READ_BYTES) {
        throw new McpError(ErrorCode.InvalidRequest, `File too large to read (${stat.size} bytes, max ${MAX_READ_BYTES}): ${relPath}`);
      }
      const file = workspace.readFile(agent.name, relPath);
      return textResult({ name, path: relPath, size: file.size, modified: file.modified, content: file.content });
    }
  );

  server.registerTool(
    'paddock_workspace_write',
    {
      title: 'Write PAD workspace file',
      description: 'Write text content to a file in a PAD\'s workspace. Creates or overwrites the file.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        path: z.string().describe('Relative workspace file path'),
        content: z.string().describe('Full file content to write'),
      },
    },
    async ({ name, path: relPath, content }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      const result = workspace.writeFile(agent.name, relPath, content);
      return textResult({ name, path: relPath, ...result });
    }
  );

  server.registerTool(
    'paddock_start_agent',
    {
      title: 'Start PAD',
      description: 'Start (docker start) a PAD container.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      await runCmd('docker', ['start', name], { timeout: 30000, check: false });
      registry.dockerPsList(true);
      const agent = registry.getAgent(name);
      return textResult({ ok: true, name, status: agent ? agent.status : 'running' });
    }
  );

  server.registerTool(
    'paddock_stop_agent',
    {
      title: 'Stop PAD',
      description: 'Stop (docker stop) a PAD container.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000, check: false });
      registry.dockerPsList(true);
      const agent = registry.getAgent(name);
      return textResult({ ok: true, name, status: agent ? agent.status : 'exited' });
    }
  );

  server.registerTool(
    'paddock_restart_agent',
    {
      title: 'Restart PAD',
      description: 'Restart (docker restart) a PAD container.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      await runCmd('docker', ['restart', '-t', '30', name], { timeout: 60000, check: false });
      registry.dockerPsList(true);
      const agent = registry.getAgent(name);
      return textResult({ ok: true, name, status: agent ? agent.status : 'running' });
    }
  );

  server.registerTool(
    'paddock_exec',
    {
      title: 'Run command in PAD',
      description: 'Run a shell command inside a PAD container (docker exec). Returns stdout and stderr. Use for `openclaw ...` and other in-container commands.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        command: z.string().describe('Shell command to run inside the PAD'),
        timeout: z.number().int().min(1000).max(600000).optional().describe('Timeout in ms (default 30000)'),
      },
    },
    async ({ name, command, timeout }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      const containers = registry.dockerPsList();
      if ((containers[agent.runtime_ref] || '').toString().toLowerCase() !== 'running') {
        throw new McpError(ErrorCode.InvalidRequest, `Container is not running: ${name}`);
      }
      const r = await dockerExec(agent.runtime_ref, command, timeout || 30000);
      return textResult({ name, stdout: r.stdout, stderr: r.stderr });
    }
  );
}

function authenticateRequest(req) {
  let token = null;
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) token = header.slice(7).trim();
  if (!token && req.headers['x-api-key']) token = String(req.headers['x-api-key']);
  if (!token && req.query.token) token = String(req.query.token);

  const auth = apiKeys.authenticate(token);
  if (!auth) return null;
  apiKeys.touchLastUsed(auth.keyId);
  return {
    keyId: auth.keyId,
    userId: auth.userId,
    keyName: auth.name,
    scopes: auth.scopes,
    role: getUserRole(auth.userId),
  };
}

function unauthorized(res) {
  res.status(401).json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32001, message: 'Unauthorized: missing or invalid API key' },
  });
}

function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  registerTools(server);
  return server;
}

function mountMcp(app) {
  const router = express.Router();

  const handle = async (req, res) => {
    const user = authenticateRequest(req);
    if (!user) return unauthorized(res);
    // Stateless: one McpServer + one transport per request (the SDK's connect()
    // throws if a server is connected to more than one transport, and a stateless
    // transport cannot be reused across requests).
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await mcpContext.run({ user }, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      console.error('[mcp] request error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCode.InternalError, message: 'Internal error' },
        });
      }
    }
  };

  router.post('/', handle);
  router.get('/', handle);
  router.delete('/', handle);

  app.use('/mcp', router);
}

module.exports = { mountMcp, authenticateRequest, registerTools, createServer, SERVER_NAME, SERVER_VERSION };
