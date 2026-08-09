const express = require('express');
const { execFile } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');

const apiKeys = require('./services/api-keys');
const registry = require('./services/agent-registry');
const vm = require('./services/vm-manager');
const workspace = require('./services/workspace');
const logStore = require('./services/log-store');
const containerHealth = require('./services/container-health');
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

/** Build the full (prefixed) container name for a create request. Accepts a
 *  bare name (`blog-bot`) or an already-prefixed one (`pad-blog-bot`); the
 *  caller-typed version is used when the two differ. Returns null if the
 *  result does not match the valid name pattern. */
function createNameFor(bare) {
  const n = String(bare || '').trim();
  if (!n) return null;
  const full = n.startsWith(PREFIX + '-') ? n : `${PREFIX}-${n}`;
  return VM_NAME_RE.test(full) ? full : null;
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

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

function registerTools(server) {
  // ─── Read / inspect ─────────────────────────────────────────

  server.registerTool(
    'list_agents',
    {
      title: 'List PADs',
      description: 'List all PAD agents managed by paddock. Returns name, status, agent type, and container ref. Admins see the full fleet; regular users see only the agents they own.',
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
        }));
      return textResult({ agents });
    }
  );

  server.registerTool(
    'get_agent',
    {
      title: 'Get PAD details',
      description: 'Get full details about a single PAD agent. Pass `logs` (number of tail lines, max 500) to also include recent container logs.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        logs: z.number().int().min(1).max(500).optional().describe('Include the last N container log lines (max 500)'),
      },
    },
    async ({ name, logs }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      if (!logs) return textResult(agent);
      await logStore.capture(agent.name);
      return textResult({ ...agent, logs: logStore.readLogs(agent.name, logs) });
    }
  );

  server.registerTool(
    'agent_logs',
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
    'config_get',
    {
      title: 'Read PAD config',
      description: 'Read a PAD\'s driver config file (openclaw.json, opencode.json, config.json, config.yaml, config.toml). JSON configs are parsed with secrets redacted; yaml/toml configs are returned verbatim.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      const agent = requireAgent(name);
      return textResult({ name, ...vm.readAgentConfig(agent) });
    }
  );

  server.registerTool(
    'settings_get',
    {
      title: 'Get PAD settings + published-web state',
      description: 'The single read tool for a PAD — the full picture before a `recreate`. Returns allowDocker, network peer, SSH (host + container port), custom workspace mount, extra volumes/ports, image/version, networkHealth, the available network-peer containers, AND the published-web state (active, webService, networkMode, passwordConfigured, startCommand, actualPorts).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      const [settings, availableNetworks] = await Promise.all([
        vm.readSettings(name),
        vm.listContainers(),
      ]);
      return textResult({ name, ...settings, availableNetworks });
    }
  );

  server.registerTool(
    'health',
    {
      title: 'Run PAD health checkup',
      description: 'Run the same Docker-level health checkup as the Settings tab. Diffs the declared compose file against the live container and reports each check — container status, docker /healthz probe, restart policy, image, network mode/peer, bind mounts, docker socket, published ports, env keys — as { key, label, status, expected, actual, hint }, plus an overall status and ok/warn/error counts. Works on stopped containers (reports why they are down).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      const report = await containerHealth.checkContainerHealth(name);
      return textResult(report);
    }
  );

  server.registerTool(
    'workspace_list',
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
    'workspace_read',
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
    'workspace_write',
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
    'start_agent',
    {
      title: 'Start PAD',
      description: 'Start a PAD container and its socat forwarding door (if any). Falls back to a compose recreate when the plain docker start fails (e.g. stale network peer).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      await vm.startAgent(name);
      registry.dockerPsList(true);
      const agent = registry.getAgent(name);
      return textResult({ ok: true, name, status: agent ? agent.status : 'running' });
    }
  );

  server.registerTool(
    'stop_agent',
    {
      title: 'Stop PAD',
      description: 'Stop a PAD container together with its socat forwarding door (so it is not a dead open listener).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      await vm.stopAgent(name);
      registry.dockerPsList(true);
      const agent = registry.getAgent(name);
      return textResult({ ok: true, name, status: agent ? agent.status : 'exited' });
    }
  );

  server.registerTool(
    'restart_agent',
    {
      title: 'Restart PAD',
      description: 'Restart a PAD container and bring its socat forwarding door back up.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      await vm.restartAgent(name);
      registry.dockerPsList(true);
      const agent = registry.getAgent(name);
      return textResult({ ok: true, name, status: agent ? agent.status : 'running' });
    }
  );

  server.registerTool(
    'create_agent',
    {
      title: 'Create a PAD agent',
      description: 'Create a new PAD: validate, seed the per-instance build, write meta + compose, build the per-instance image, start the container, and run the driver\'s setup steps — the full create flow from the web UI. The `name` is the bare agent name (the container prefix is added for you, e.g. `blog-bot` → `pad-blog-bot`). Agent type defaults to openclaw. Requires `confirm: true` — it is heavy (image build) and adds a new agent to the fleet. The API key user becomes the agent owner. Returns the created agent + a log of what happened.',
      inputSchema: {
        name: z.string().describe('Agent name without the container prefix (e.g. "blog-bot" → pad-blog-bot)'),
        agent: z.enum(['openclaw', 'opencode', 'picoclaw', 'hermes', 'codex']).optional().describe('Agent type (default openclaw)'),
        confirm: z.boolean().describe('Must be true to create — heavy and adds a new agent to the fleet'),
        allowDocker: z.boolean().optional().describe('Mount the host docker socket + CLI into the container'),
        network: z.string().optional().describe('Network peer container to route through'),
        sshEnabled: z.boolean().optional().describe('Expose OpenSSH'),
        sshPort: z.number().int().min(1).max(65535).optional().describe('SSH host port (empty auto-allocates)'),
        sshContainerPort: z.number().int().min(1).max(65535).optional().describe('SSH container port — the port sshd listens on inside the container (default 22; unique per peer-shared agent)'),
        sshPassword: z.string().optional().describe('Root/SSH password (defaults to the name)'),
        workspaceHost: z.string().optional().describe('Custom workspace host source — both-or-neither with workspaceDir'),
        workspaceDir: z.string().optional().describe('Custom workspace container path — both-or-neither with workspaceHost'),
        extraVolumes: z.array(z.object({
          type: z.enum(['bind', 'volume']).optional().describe('bind = host source path, volume = named Docker volume'),
          host: z.string().describe('Host source path (or the volume name when type is volume)'),
          container: z.string().describe('Container destination path'),
          readonly: z.boolean().optional().describe('Mount read-only'),
          external: z.string().optional().describe('Full Docker volume name to attach (volume type only)'),
        })).optional().describe('Additional volumes'),
        extraPorts: z.array(z.object({
          host: z.number().int().min(1).max(65535),
          container: z.number().int().min(1).max(65535),
        })).optional().describe('Additional published ports'),
      },
    },
    async (args) => {
      const user = currentUser();
      if (args.confirm !== true) {
        throw new McpError(ErrorCode.InvalidRequest, 'Refusing to create without confirm: true (creates a new agent and builds an image).');
      }
      const fullName = createNameFor(args.name);
      if (!fullName) {
        throw new McpError(ErrorCode.InvalidRequest, `Invalid agent name: ${args.name}`);
      }
      const log = [];
      try {
        await vm.createAgent(fullName, {
          agent: args.agent || 'openclaw',
          allowDocker: !!args.allowDocker,
          network: args.network || '',
          sshEnabled: !!args.sshEnabled,
          port: args.sshPort !== undefined ? String(args.sshPort) : '',
          sshContainerPort: args.sshContainerPort !== undefined ? String(args.sshContainerPort) : '',
          password: typeof args.sshPassword === 'string' ? args.sshPassword : '',
          workspaceHost: args.workspaceHost || '',
          workspaceDir: args.workspaceDir || '',
          extraVolumes: args.extraVolumes,
          extraPorts: args.extraPorts,
          onLog: (type, msg) => log.push(`[${type}] ${msg}`),
          onStep: () => {},
        });
      } catch (e) {
        registry.dockerPsList(true);
        registry.discoverAgents();
        throw new McpError(ErrorCode.InvalidRequest, `Create failed: ${e.message}`);
      }
      registry.dockerPsList(true);
      registry.discoverAgents();
      const ownerId = user ? user.userId : null;
      registry.assignOwner(fullName, ownerId);
      registry.recordActivity(fullName, 'lifecycle', 'create', 'ok', `Agent created via MCP (type=${args.agent || 'openclaw'})`);
      const agent = registry.getAgent(fullName);
      return textResult({ ok: true, name: fullName, status: agent ? agent.status : 'created', ownerId, log });
    }
  );

  server.registerTool(
    'delete_agent',
    {
      title: 'Delete PAD',
      description: 'Permanently delete a PAD agent: removes its container, socat door, docker network and instance directory (config, data, backups of the data dir). Requires `confirm: true` as a safety guard. There is no undo.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        confirm: z.boolean().describe('Must be true to delete — destructive and irreversible'),
      },
    },
    async ({ name, confirm }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      if (confirm !== true) {
        throw new McpError(ErrorCode.InvalidRequest, 'Refusing to delete without confirm: true (destructive, no undo).');
      }
      await vm.removeVm(name);
      registry.removeAgentFromDb(name);
      registry.dockerPsList(true);
      return textResult({ ok: true, name, deleted: true });
    }
  );

  server.registerTool(
    'recreate',
    {
      title: 'Recreate PAD container — single mutation tool',
      description: 'The one "gun" for every change that recreates the container: Settings-tab options (allowDocker, network peer, extraVolumes, custom workspace) AND Web-tab options (web publish, SSH expose, extraPorts). Only the options you SPECIFY change; everything unspecified is left untouched. Pass `[]` / `\'\'` / `false` to explicitly clear something. `pull: true` updates to the latest base image (rebuild + recreate). `reset: true` wipes the ENTIRE data dir before recreating (requires confirm: true).',
      inputSchema: {
        name: z.string().describe('PAD name'),
        pull: z.boolean().optional().describe('Pull the base image + rebuild before recreating (update to latest)'),
        reset: z.boolean().optional().describe('Wipe the data dir and start fresh (requires confirm: true)'),
        confirm: z.boolean().optional().describe('Required when reset: true — destructive, no undo'),
        allowDocker: z.boolean().optional().describe('Mount the host docker socket + CLI into the container (Settings tab)'),
        network: z.string().optional().describe('Network peer container to route through (empty string clears to the default network)'),
        extraVolumes: z.array(z.object({
          type: z.enum(['bind', 'volume']).optional().describe('bind = host source path, volume = named Docker volume'),
          host: z.string().describe('Host source path (or the volume name when type is volume)'),
          container: z.string().describe('Container destination path'),
          readonly: z.boolean().optional().describe('Mount read-only'),
          external: z.string().optional().describe('Full Docker volume name to attach (volume type only)'),
        })).optional().describe('Additional volumes (full replace list)'),
        workspaceHost: z.string().optional().describe('Custom workspace host source — both-or-neither with workspaceDir'),
        workspaceDir: z.string().optional().describe('Custom workspace container path — both-or-neither with workspaceHost'),
        sshEnabled: z.boolean().optional().describe('Enable/disable Expose OpenSSH'),
        sshPort: z.number().int().min(1).max(65535).optional().describe('SSH host port (empty auto-allocates)'),
        sshContainerPort: z.number().int().min(1).max(65535).optional().describe('SSH container port — the port sshd listens on inside the container (default 22; unique per peer-shared agent)'),
        sshPassword: z.string().optional().describe('Set the root/SSH password (write-only; empty = keep current)'),
        extraPorts: z.array(z.object({
          host: z.number().int().min(1).max(65535),
          container: z.number().int().min(1).max(65535),
        })).optional().describe('Additional published ports (full replace list)'),
        web: z.object({
          active: z.boolean().describe('Publish (true) or unpublish (false) the web app'),
          hostPort: z.number().int().min(1).max(65535).optional().describe('Host port'),
          containerPort: z.number().int().min(1).max(65535).optional().describe('Container port the app listens on (unique per agent when peers share a network namespace)'),
          password: z.string().optional().describe('Web app password (write-only; empty = keep current)'),
        }).optional().describe('Web app publish/unpublish'),
      },
    },
    async (args) => {
      const { name } = args;
      requireAccess(currentUser(), name);
      requireAgent(name);
      if (args.reset && args.confirm !== true) {
        throw new McpError(ErrorCode.InvalidRequest, 'Refusing to reset without confirm: true (wipes the data dir).');
      }
      const log = [];
      const result = await vm.applyAgentChanges(name, args, {
        onLog: (type, msg) => log.push(`[${type}] ${msg}`),
        onStep: () => {},
      });
      registry.dockerPsList(true);
      registry.discoverAgents();
      return textResult({ ...result, log });
    }
  );

  server.registerTool(
    'update',
    {
      title: 'Update PAD to latest image',
      description: 'Convenience alias for `recreate {pull: true}` — pull the base image, rebuild and force-recreate the container (same as the Settings tab "Update" flow). Config/data live in bind mounts, so they survive. The old container stays up through the build and is only swapped at recreate.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      requireAccess(currentUser(), name);
      requireAgent(name);
      await vm.updateAgent(name, { pull: true });
      registry.dockerPsList(true);
      registry.discoverAgents();
      return textResult({ ok: true, name, action: 'updated' });
    }
  );

  server.registerTool(
    'exec',
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
