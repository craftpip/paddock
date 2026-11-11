/**
 * PAD tools: list, inspect, configure, start, stop, create, recreate, update, delete.
 */
const registry = require('../services/agent-registry');
const hostPowers = require('../services/host-powers');
const { getDb } = require('../services/db');
const { z } = require('zod');
const logStore = require('../services/log-store');
const vm = require('../services/vm-manager');
const containerHealth = require('../services/container-health');
const workspace = require('../services/workspace');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const jobLog = require('../services/job-log');

/** Register this area's tools. `registerToolBound` is mcp.js's error-catching wrapper;
 *  `ctx` carries the helpers mcp.js owns. */
module.exports = function register(registerToolBound, ctx) {
  const {
    currentUser, canAccess, targetAllowed, textResult, publicAgent, requirePad, createNameFor,
    requireTool, missionSessionsEnded,
  } = ctx;

  // ─── Read / inspect ─────────────────────────────────────────

  registerToolBound(
    'list_agents',
    {
      title: 'List PADs',
      description: 'List all PAD agents managed by paddock. Returns name, status, display_name, agent type, container ref, and owner. Every row here is OPENABLE — a row is only listed when the pad resolves, so a name from this list always works with get_agent / exec / settings_get, in any of the three spellings. Admins see the full fleet; regular users see only the agents they own. `scope` says which of the two you got ("all" or "owned") and `agentsTotal` is how many rows you were given, so a short list is never mistaken for a whole fleet.',
      inputSchema: {},
    },
    async (args) => {
      const user = currentUser();
      const all = registry.discoverAgents();
      const visible = all
        .filter((a) => !user || (canAccess(user, a.name) && targetAllowed(user, a.name)))
        // A row must be openable. `discoverAgents` is directory-derived today,
        // so this is belt-and-braces — but the listing is the one place a
        // caller forms their belief about what exists, and an unopenable row
        // there poisons every later call (plan 61, finding 1a).
        .filter((a) => !!registry.getAgent(a.name));
      // `buildAgent` is disk-derived and carries no owner, so read it once
      // rather than per row — an owned-scope caller should be able to see
      // WHICH owner each row belongs to without a query per pad.
      const owners = new Map();
      try {
        for (const r of getDb().prepare('SELECT name, owner_id FROM agents').all()) owners.set(r.name, r.owner_id);
      } catch {}
      const agents = visible.map((a) => ({
        name: a.name,
        status: a.status,
        display_name: a.display_name,
        agent_type: a.agent_type,
        runtime_ref: a.runtime_ref,
        owner: owners.get(a.name) || null,
      }));
      return textResult({
        agents,
        scope: user && user.role !== 'admin' ? 'owned' : 'all',
        agentsTotal: visible.length,
      });
    }
  );

  registerToolBound(
    'get_agent',
    {
      title: 'Get PAD details',
      description: 'Get full details about a single PAD agent. Pass `logs` (number of tail lines, max 500) to also include recent container logs. The published-web row reports `tokenConfigured: true|false` and never the token itself — see the write-only-secrets rule in `help`.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        logs: z.number().int().min(1).max(500).optional().describe('Include the last N container log lines (max 500)'),
      },
    },
    async ({ name, logs }) => {
      const agent = publicAgent(await requirePad('get_agent', name));
      if (!logs) return textResult(agent);
      await logStore.capture(agent.name);
      return textResult({ ...agent, logs: logStore.readLogs(agent.name, logs) });
    }
  );

  registerToolBound(
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
      const agent = await requirePad('agent_logs', name);
      await logStore.capture(agent.name);
      const logs = logStore.readLogs(agent.name, Math.min(tail || 100, 5000));
      // Echo the RESOLVED name, not the caller's spelling: the whole point of
      // the resolver is that a response tells the caller which pad it really
      // read, so `Proj` in the request must not come back as `Proj`.
      return textResult({ name: agent.name, logs });
    }
  );

  registerToolBound(
    'config_get',
    {
      title: 'Read PAD config',
      description: 'Read a PAD\'s driver config file (openclaw.json, opencode.json, config.json, config.yaml, config.toml). REDACTED: every credential is replaced with "[REDACTED]" in BOTH `config` and `configRaw` — anything under a `headers` map, and any authorization/api_key/token/secret/password/*-key key at any depth. A redacted value is not recoverable here: to USE a secret, run the agent\'s own command through `exec` with the secret on `stdin`, never through this tool.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      const agent = await requirePad('config_get', name);
      return textResult({ name: agent.name, ...vm.readAgentConfig(agent, { redact: true }) });
    }
  );

  registerToolBound(
    'settings_get',
    {
      title: 'Get PAD settings + published-web state',
      description: 'The single read tool for a PAD — the full picture before a `recreate`. Returns allowDocker, network peer, SSH (host + container port), custom workspace mount, extra volumes/ports, image/version, networkHealth, the available network-peer containers, AND the published-web state (active, webService, networkMode, passwordConfigured, tokenConfigured, actualPorts). The web password itself is never returned — `web.authToken` and `web.startCommand` come back empty/redacted because both embed it. `availableNetworks` is FILTERED to running containers that make sense as a peer (the whole host\'s container list is not useful here) and capped at 10 — read `availableNetworksTotal` / `availableNetworksTruncated` to know if you are seeing all of them. `workspaceDevcontainer` describes the .devcontainer in the WORKSPACE (shared by every pad on that workspace, NOT this pad\'s own config) — `sharedWith` lists the other pads using it.\n\n**READ `networkHealth` BEFORE deciding a pad is broken (plan 66).** The states are distinct problems, and only one of them needs the peer touched: `ok` (default network, or a live peer — `peerName`/`peerState` say which), `staleBinding` (the peer named in `network` is RUNNING and needs nothing; only this pad is bound to an older, deleted peer container — recreate to rebind), `peer-stopped` (the named peer exists but is not running — start IT first), and `stale` (no peer we can name exists at all). `checked: false` means the answer could not be computed (`reason` says why) and is NOT a healthy pad. `reason` is always present when the state is not `ok`, so no state is ever a shrug. `peerId` is the id this pad is bound to and `peerCurrentId` the peer\'s id now — the two differing IS the stale binding.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        networkFilter: z.string().optional().describe('Search `availableNetworks` for one named container instead of taking the first 10. Use this to CONFIRM a specific peer before you set `network` on a recreate — without it a valid peer past the cap is simply absent, which reads exactly like "not a valid peer".'),
      },
    },
    async ({ name, networkFilter }) => {
      const agent = await requirePad('settings_get', name);
      const settings = await vm.readSettings(agent.name, { redact: true });
      const currentPeer = (settings && settings.network) || '';
      const nets = await vm.listNetworkPeers({ currentPeer, filter: networkFilter });
      return textResult({
        name: agent.name,
        ...settings,
        availableNetworks: nets.peers,
        availableNetworksTotal: nets.total,
        availableNetworksTruncated: nets.truncated,
        // Only set when `networkFilter` was used. An empty `availableNetworks`
        // is ambiguous on its own — "no such peer" and "past the cap" look
        // identical — so a searched answer says it was exhaustive.
        ...(networkFilter ? { availableNetworksSearchedAll: true } : {}),
      });
    }
  );

  registerToolBound(
    'health',
    {
      title: 'Run PAD health checkup',
      description: 'Run the same Docker-level health checkup as the Settings tab. Diffs the declared compose file against the live container and reports each check — container status, docker /healthz probe, restart policy, image, network mode/peer, bind mounts, docker socket, published ports, env keys — as { key, label, status, expected, actual, hint }, plus an overall status and ok/warn/error counts. Works on stopped containers (reports why they are down). The `network` check carries `peerName` + `peerState` and its `hint` STATES ITS OWN CONDITION rather than saying only "recreate": when the peer is running and this pad is bound to a different one, the hint says so, because in that case the peer needs nothing and recreating the pad is the whole fix — a hint that does not say which is stale sends the caller off to restart a peer that is already fine.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      const agent = await requirePad('health', name);
      const report = await containerHealth.checkContainerHealth(agent.name);
      return textResult(report);
    }
  );

  registerToolBound(
    'workspace_write',
    {
      title: 'Write PAD workspace file',
      description: 'Write text content to a file in a PAD\'s workspace. Creates or overwrites the file. Refused with a clear reason when the PAD is not host-browsable (settings_get.workspaceMount.hostBrowseReason says why); the container workspace via `exec` is the path in that case.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        path: z.string().describe('Relative workspace file path'),
        content: z.string().describe('Full file content to write'),
      },
    },
    // The `await` is load-bearing (plan 64 3a). `workspace.writeFile` is async,
    // so without it the `requireHostBrowsable` refusal became an unhandled
    // rejection — it escaped BEFORE the registerTool wrapper could convert it —
    // and the handler went on to return a bare `{name}` as if it had written the
    // file. A tool that reports success while writing nothing is worse than one
    // that is simply missing, because the caller believes the file is there.
    async ({ name, path: relPath, content }) => {
      const agent = await requirePad('workspace_write', name);
      const result = await workspace.writeFile(agent.name, relPath, content);
      return textResult({ ok: true, name: agent.name, path: relPath, ...result });
    }
  );

  registerToolBound(
    'start_agent',
    {
      title: 'Start PAD',
      description: 'Start a PAD container and its socat forwarding door (if any). Falls back to a compose recreate when the plain docker start fails (e.g. stale network peer).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      const agent = await requirePad('start_agent', name);
      await vm.startAgent(agent.name);
      registry.dockerPsList(true);
      const fresh = registry.getAgent(agent.name);
      return textResult({ ok: true, name: agent.name, status: fresh ? fresh.status : 'running' });
    }
  );

  registerToolBound(
    'stop_agent',
    {
      title: 'Stop PAD',
      description: 'Stop a PAD container together with its socat forwarding door (so it is not a dead open listener).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      const agent = await requirePad('stop_agent', name);
      await vm.stopAgent(agent.name);
      registry.dockerPsList(true);
      const fresh = registry.getAgent(agent.name);
      return textResult({ ok: true, name: agent.name, status: fresh ? fresh.status : 'exited' });
    }
  );

  registerToolBound(
    'restart_agent',
    {
      title: 'Restart PAD',
      description: 'Restart a PAD container and bring its socat forwarding door back up.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      const agent = await requirePad('restart_agent', name);
      await vm.restartAgent(agent.name);
      registry.dockerPsList(true);
      const fresh = registry.getAgent(agent.name);
      return textResult({ ok: true, name: agent.name, status: fresh ? fresh.status : 'running' });
    }
  );

  registerToolBound(
    'create_agent',
    {
      title: 'Create a PAD agent',
      description: 'Create a new PAD: validate, seed the per-instance build, write meta + compose, build the per-instance image, start the container, and run the driver\'s setup steps — the full create flow from the web UI. NAMING: `name` is the FINAL container name — Paddock prepends CONTAINER_PREFIX (`pad-` by default) ONLY if you left it off, and never inserts the agent type. So `name: "blog-bot"` becomes the pad `pad-blog-bot`, and `name: "opencode-tester"` becomes `pad-opencode-tester` (NOT `pad-opencode-opencode-tester`). The resolved name is returned as `resolvedName` — use it for every later call. Agent type defaults to openclaw. Requires `confirm: true` — it is heavy (image build) and adds a new agent to the fleet. The API key user becomes the agent owner. Returns the created agent + a log of what happened. LONG-RUNNING: an image build can outlive an MCP call timeout — the create keeps going in the background, so after a timeout call `job_status` with the resolved name (or `job_log`) to watch it instead of retrying the create.',
      inputSchema: {
        name: z.string().describe('The pad name WITHOUT the container prefix (e.g. "blog-bot" → pad-blog-bot). The agent type is NOT woven in — pass "tester" for pad-tester, or "opencode-tester" for pad-opencode-tester.'),
        agent: z.enum(['openclaw', 'opencode', 'picoclaw', 'hermes', 'codex']).optional().describe('Agent type (default openclaw)'),
        confirm: z.boolean().describe('Must be true to create — heavy and adds a new agent to the fleet'),
        userMode: z.enum(['root', 'user']).optional().describe('Container user: "root" (default) or "user" — user runs the agent daemon + terminal as the pad user (PUID:PGID) so agent-written files are user-owned. Not applicable to hermes (it already runs as its own user).'),
        generateDevContainer: z.boolean().optional().describe('Generate .devcontainer/devcontainer.json in the workspace when it has none (default true) — the portable mirror of the pad, marked x-paddock.generated'),
        allowDocker: z.boolean().optional().describe('Mount the host docker socket + CLI into the container'),
        network: z.string().optional().describe('Network peer container to route through'),
        sshEnabled: z.boolean().optional().describe('Expose OpenSSH'),
        sshPort: z.number().int().min(1).max(65535).optional().describe('SSH host port (empty auto-allocates)'),
        sshContainerPort: z.number().int().min(1).max(65535).optional().describe('SSH container port — the port sshd listens on inside the container (default 22; unique per peer-shared agent)'),
        sshPassword: z.string().optional().describe('Root/SSH password (defaults to the name)'),
        workspaceHost: z.string().optional().describe('Custom workspace host source — both-or-neither with workspaceDir'),
        workspaceDir: z.string().optional().describe('Custom workspace container path — both-or-neither with workspaceHost'),
        buildCommands: z.string().optional().describe('Dockerfile build commands baked into the image (injected into the pad\'s build/Dockerfile — cannot open a FROM stage)'),
        postCreate: z.string().optional().describe('Shell script run after every container create/recreate (/build/post-create.sh)'),
        postStart: z.string().optional().describe('Shell script run on every container start (/build/post-start.sh)'),
        postAttach: z.string().optional().describe('Shell script run when the terminal attaches (/build/post-attach.sh)'),
        web: z.object({
          active: z.boolean().describe('Publish (true) or unpublish (false) the web app'),
          hostPort: z.number().int().min(1).max(65535).optional().describe('Host port'),
          containerPort: z.number().int().min(1).max(65535).optional().describe('Container port the app listens on (unique per agent when peers share a network namespace)'),
          password: z.string().optional().describe('Web app password (write-only; empty = keep current)'),
        }).optional().describe('Publish the web app as part of the create (no second recreate needed)'),
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
      requireTool(user, 'create_agent', fullName);
      try {
        hostPowers.assertAllowed(user && user.role, hostPowers.requestedAtCreate(args));
      } catch (e) {
        throw new McpError(ErrorCode.InvalidRequest, `${e.code}: ${e.message}`);
      }
      // Register the job up front so a create that outlives the MCP call
      // timeout is still observable via job_status / job_log. The key matches
      // the REST create route's, so both surfaces read the same job.
      const job = jobLog.getOrCreateJob(fullName);
      const log = [];
      const onLog = (type, msg) => {
        const entry = `[${type}] ${msg}`;
        log.push(entry);
        jobLog.line(job, type, msg);
      };
      const onStep = (step, state, cmd) => jobLog.setStep(job, step, state, cmd);
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
          userMode: args.userMode,
          generateDevContainer: args.generateDevContainer !== false,
          buildCommands: args.buildCommands,
          postCreate: args.postCreate,
          postStart: args.postStart,
          postAttach: args.postAttach,
          web: args.web,
          onLog,
          onStep,
        });
      } catch (e) {
        registry.dockerPsList(true);
        registry.discoverAgents();
        jobLog.fail(job, e.message);
        throw new McpError(ErrorCode.InvalidRequest, `Create failed: ${e.message}`);
      }
      registry.dockerPsList(true);
      registry.discoverAgents();
      const ownerId = user ? user.userId : null;
      registry.assignOwner(fullName, ownerId);
      registry.recordActivity(fullName, 'lifecycle', 'create', 'ok', `Agent created via MCP (type=${args.agent || 'openclaw'})`);
      const agent = registry.getAgent(fullName);
      jobLog.finish(job, true, { name: fullName });
      return textResult({ ok: true, name: fullName, resolvedName: fullName, status: agent ? agent.status : 'created', ownerId, log });
    }
  );

  registerToolBound(
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
      const agent = await requirePad('delete_agent', name);
      if (confirm !== true) {
        throw new McpError(ErrorCode.InvalidRequest, 'Refusing to delete without confirm: true (destructive, no undo).');
      }
      await vm.removeVm(agent.name);
      registry.removeAgentFromDb(agent.name);
      registry.dockerPsList(true);
      return textResult({ ok: true, name: agent.name, deleted: true });
    }
  );

  registerToolBound(
    'recreate',
    {
      title: 'Recreate PAD container — single mutation tool',
      description: 'The one "gun" for every change that recreates the container: Settings-tab options (allowDocker, network peer, extraVolumes, custom workspace) AND Web-tab options (web publish, SSH expose, extraPorts). Only the options you SPECIFY change; everything unspecified is left untouched. Pass `[]` / `\'\'` / `false` to explicitly clear something. `pull: true` updates to the latest base image (rebuild + recreate). `reset: true` wipes the ENTIRE data dir before recreating (requires confirm: true).\n\n**A recreate ends every Mission session on that PAD.** The tmux sessions live inside the container, so they die with it — including live conversations the human is watching. The response reports exactly what it took in `sessionsEnded` ([{id, tmux_id, label, project, lastScreen, lastScreenAt}]), and those rows are stamped `endedBy: \"recreate\"` with the moment it happened, so the cost of the change is askable afterwards in one `mission_sessions` call. `sessionsEndedHidden` appears when the pad had sessions your key may not see — the count you are given is only ever the rows you can see. Recover one with `mission_session_restart` (same row, same conversation).',
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
      const agent = await requirePad('recreate', name);
      if (args.reset && args.confirm !== true) {
        throw new McpError(ErrorCode.InvalidRequest, 'Refusing to reset without confirm: true (wipes the data dir).');
      }
      if (args.reset) {
        requireTool(currentUser(), 'reset', agent.name);
      }
      // Same job key the REST apply route uses, so a recreate that outlives the
      // MCP call timeout stays observable via job_status / job_log.
      const job = jobLog.getOrCreateJob(`update:${agent.name}`);
      const log = [];
      const onLog = (type, msg) => {
        log.push(`[${type}] ${msg}`);
        jobLog.line(job, type, msg);
      };
      const onStep = (step, state, cmd) => jobLog.setStep(job, step, state, cmd);
      // BEFORE the recreate, because afterwards the sessions are gone and there
      // is nothing left to report (plan 65 1d). Best effort: a pad with no
      // Mission rows, or a mission store that cannot be read, must not stop a
      // settings change — the cost is then simply not reported here, and the
      // rows are dated `gone` by the next liveness pass instead.
      const ended = await missionSessionsEnded(agent.name, 'recreate');
      let result;
      try {
        result = await vm.applyAgentChanges(agent.name, { ...args, force: true, actorRole: currentUser() && currentUser().role }, { onLog, onStep });
      } catch (e) {
        jobLog.fail(job, e.message);
        throw new McpError(ErrorCode.InvalidRequest, `Recreate failed: ${e.message}`);
      }
      registry.dockerPsList(true);
      registry.discoverAgents();
      jobLog.finish(job, true, { name: agent.name });
      return textResult({ ...result, log, ...ended });
    }
  );

  registerToolBound(
    'update',
    {
      title: 'Update PAD to latest image',
      description: 'Convenience alias for `recreate {pull: true}` — pull the base image, rebuild and force-recreate the container (same as the Settings tab "Update" flow). Config/data live in bind mounts, so they survive. The old container stays up through the build and is only swapped at recreate. LONG-RUNNING: the build can outlive an MCP call timeout and keeps going — poll `job_status` with the pad name after a timeout.',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      const agent = await requirePad('update', name);
      const job = jobLog.getOrCreateJob(`update:${agent.name}`);
      const onLog = (type, msg) => jobLog.line(job, type, msg);
      const onStep = (step, state, cmd) => jobLog.setStep(job, step, state, cmd);
      const ended = await missionSessionsEnded(agent.name, 'recreate');
      try {
        await vm.updateAgent(agent.name, { pull: true, onLog, onStep });
      } catch (e) {
        jobLog.fail(job, e.message);
        throw new McpError(ErrorCode.InvalidRequest, `Update failed: ${e.message}`);
      }
      registry.dockerPsList(true);
      registry.discoverAgents();
      jobLog.finish(job, true, { name: agent.name });
      return textResult({ ok: true, name: agent.name, action: 'updated', ...ended });
    }
  );
};
