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
const { getGuide, getCommandCatalog, listCatalogTypes } = require('./services/llm-guide');
const { getDb } = require('./services/db');
const taskRunner = require('./services/task-runner');
const jobLog = require('./services/job-log');
const mission = require('./services/mission');
const taskPipeline = require('./services/task-pipeline');
const plans = require('./services/plans');
const agentStore = require('./services/agent-store');
const { termUserArgs } = require('./services/pad-tmux');
const { registerAgentQueueTools, WORKER_QUEUE_TOOLS } = require('./services/agent-queue-mcp');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const PREFIX = process.env.CONTAINER_PREFIX || 'pad';
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
  const { timeout = 30000, check = false, input } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args || [], { timeout }, (err, stdout, stderr) => {
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
    // Optional stdin payload (secrets, script bodies). Written verbatim; never
    // included in any error/result text (plan 35a — the exec secret channel).
    if (input !== undefined && input !== null) {
      child.stdin.end(String(input));
    } else {
      child.stdin.end();
    }
  });
}

async function dockerExec(vmName, cmd, timeout = 30000, input) {
  // In a user-mode pad the agent daemon + terminal run as the pad user
  // (PUID:PGID) and its HOME (/root) is owned by that user. Running a command
  // here as root would let it create root-owned files inside the pad's HOME —
  // e.g. opencode's /root/.local/state/opencode/locks — and the real agent
  // (uid 1000) then fails its next start with PermissionDenied on that lock.
  // So the MCP exec path drops to the pad user exactly like the terminal and
  // Mission TUIs do. `termUserArgs` returns [] for root-mode pads, so those are
  // unchanged and keep full root access.
  return runCmd('docker', execDockerArgs(vmName, cmd), { timeout, input });
}

/** The `docker exec` argv the MCP `exec` tool runs. Split out so a unit test
 *  can pin the command SHAPE (the user-mode drop) without a container — the
 *  same reason pad-tmux exposes its argv through a runner seam. */
function execDockerArgs(vmName, cmd) {
  return ['exec', '-i', ...termUserArgs(vmName), vmName, 'sh', '-lc', cmd];
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
  // A call with no request context (a script driving the handlers directly, a
  // future call site that forgot `mcpContext.run`) has no identity to check, and
  // the honest answer to "may this identity reach this pad" is NO. Dereferencing
  // the null instead turned a refusal into a TypeError the caller reads as a
  // broken tool.
  if (!user) return false;
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

// ─── API-key grants (plan 35b) ──────────────────────────────────
// Fine-grained keys restrict the fleet an agent can reach (target grant) and
// the tools it may invoke (tool grant). Both are enforced HERE, before the
// owner/admin checks, so a restricted admin key stays restricted.

const READ_TOOLS = new Set([
  'list_agents', 'get_agent', 'agent_logs', 'config_get', 'settings_get',
  'health', 'help', 'agent_commands',
  'task_status', 'task_result', 'task_list',
  // The pipeline's own reader: watching a driver is watching work, not doing
  // it — a read-only key may poll where the loop is while it may not steer it.
  'task_pipeline_status',
  // Job readers are pure reads on the in-memory job store, so a read-only key
  // may poll the progress of a create/recreate it is not allowed to start.
  'job_status', 'job_log',
  // Mission reads (plan 55): the agent can WATCH the human work without being
  // able to type into it — that separation is the point of the read bucket.
  'mission_projects', 'mission_sessions',
  // Plans reads (plan 64). `plan_write` is NOT here — see TOOL_GRANT_FOR.
  'plan_list', 'plan_activity',
  // Queue reads (plan 83): the queue is the runner's instruction file.
  'queue_read', 'agent_queue_read',
  // Runner reads (plan 83): inspect runner config, queue, and session state.
  'runner_list', 'runner_get',
]);

const TOOL_GRANT_FOR = {
  start_agent: 'lifecycle',
  stop_agent: 'lifecycle',
  restart_agent: 'lifecycle',
  create_agent: 'create',
  delete_agent: 'delete',
  update: 'recreate',
  recreate: 'recreate',
  reset: 'reset', // recreate with reset:true only
  // Task tools ride the `exec` bucket: they run or steer real work inside a PAD,
  // so they share `exec`'s base grant rather than inventing a new scope.
  task_submit: 'exec',
  task_get_next: 'exec',
  task_complete: 'exec',
  // Re-filing a task starts real work, so a retry rides `exec` with the submit
  // and claim tools — never the read bucket, however harmless "submit the same
  // prompt again" sounds.
  task_retry: 'exec',
  task_priority: 'exec',
  task_cancel: 'exec',
  // Step reporting (plan 69 D2/D4/D6) is work in a PAD like the other task
  // verbs: a step report steers the lifecycle, a bug records a defect against
  // it, and a commit RUNS git inside the task's PAD — none is a read.
  task_step_report: 'exec',
  task_step_bug: 'exec',
  task_step_commit: 'exec',
  // The server-side driver (plan 69 D7) steers a live session through a whole
  // loop and runs git at the end — starting it and stopping it are the most
  // consequential exec verbs on the surface. Its STATUS is a read and is in
  // READ_TOOLS, never here.
  task_pipeline_start: 'exec',
  task_pipeline_stop: 'exec',
  // Mission writers (plan 55). A project is a row, so it rides the same `create`
  // bucket as create_agent. Starting a session spawns a real TUI that burns
  // tokens, and mission_send types into a live conversation — both are work in
  // a PAD, so both ride `exec` (52 F2's "the verbs that do work" bucket).
  mission_project_create: 'create',
  mission_session_start: 'exec',
  mission_send: 'exec',
  // The session lifecycle verbs (plan 65 1e) are work in a PAD like the others:
  // relaunch runs the agent's TUI, restart re-creates its tmux session and a
  // close kills one. None of them is a read, so none of them rides the read
  // bucket — an agent that can watch a session must not be able to end it.
  mission_session_close: 'exec',
  mission_session_relaunch: 'exec',
  mission_session_restart: 'exec',
  // Answering a permission dialog is a WRITE into a live conversation, and the
  // most consequential answer available to an agent — so it rides `exec` with
  // mission_send rather than the read bucket, and `always` is refused in the
  // handler regardless of what the key may do.
  mission_permission_answer: 'exec',
  // plan_write puts a file into a real workspace, so it rides `exec` with the
  // other verbs that do work — never the read bucket, however harmless "write
  // my own plan down" sounds next to plan_list.
  plan_write: 'exec',
  // Queue writers (plan 83): the queue steers real work inside a PAD, so both
  // write and ensure ride the `exec` bucket.
  queue_write: 'exec',
  queue_ensure: 'exec',
  agent_queue_update_item: 'exec',
  agent_queue_add_custom_instructions: 'exec',
  agent_queue_reorder: 'exec',
  agent_queue_resolve_need_input: 'exec',
  // Runner verbs (plan 83): runner lifecycle verbs steer real work in a PAD.
  runner_create: 'create',
  runner_start: 'exec',
  runner_pause: 'exec',
  runner_resume: 'exec',
  runner_remove: 'exec',
  runner_update: 'exec',
  runner_reconcile: 'exec',
  agent_queue_remove_item: 'exec',
};

function keyGrants(user) {
  const scopes = (user && user.scopes) || [];
  return {
    full: scopes.includes('default') || scopes.includes('control'),
    readOnly: scopes.includes('read'),
    tools: new Set(scopes.filter((s) => s.startsWith('tools:')).map((s) => s.slice('tools:'.length))),
    target: scopes.find((s) => s.startsWith('target:agent:')), // undefined = all owned
  };
}

/** The target grant admits this agent name? Restricted keys see only their
 *  target PAD; unrestricted keys (or target:owned) see all owned agents. */
function targetAllowed(user, agentName) {
  if (!agentName || !user) return true;
  const { target } = keyGrants(user);
  if (!target) return true;
  return target === `target:agent:${agentName}`;
}

/** Tool grant admits this tool for this agent? The base for fine-grained keys
 *  is read + workspace; `exec` and the session-driving verbs are opt-in
 *  (`tools:exec`), mutating tools need their own opt-in grant. */
function toolAllowed(user, tool, agentName) {
  if (!user) return true;
  const g = keyGrants(user);
  if (g.full) return targetAllowed(user, agentName);
  if (g.readOnly) return READ_TOOLS.has(tool) && targetAllowed(user, agentName);
  if (READ_TOOLS.has(tool) || tool === 'workspace_write') {
    return targetAllowed(user, agentName);
  }
  const grant = tool === 'exec' ? 'exec' : TOOL_GRANT_FOR[tool];
  // Fail CLOSED on a tool that is in neither the read bucket nor the map. It
  // used to `return targetAllowed(...)` here, which made forgetting a map
  // entry silently ALLOW the tool for every fine-grained key — that is how
  // `task_steer` shipped ungated, and nothing in a diff of the new tool's
  // registration would have shown it. Denying is the safe direction for a
  // mistake of this shape: it refuses exactly one tool until someone
  // classifies it, where allowing quietly widens a key's power. An
  // unclassified tool is a bug in TOOL_GRANT_FOR, not a reason to trust the
  // caller.
  if (!grant) return false;
  return g.tools.has(grant) && targetAllowed(user, agentName);
}

/** Gate every tool: target grant, then owner/admin, then tool grant.
 *  create_agent has no pre-existing row to owner-check, so it only runs the
 *  grant checks (the key's owner becomes the new agent's owner).
 *
 *  The name is RESOLVED first (plan 61) and every grant is then checked
 *  against the resolved name, never the raw string the caller typed. That
 *  ordering is the security half of the resolver: a key scoped to
 *  `target:agent:pad-proj2` must still be refused when someone passes the
 *  `display_name`, because a grant checked on the unresolved string would
 *  compare `Proj2` against the target and could be talked past. A name that
 *  resolves to nothing is refused before any grant runs, so a scoped key
 *  cannot use the resolver to probe for names outside its target. */
function requireTool(user, tool, agentName) {
  const raw = agentName || '';
  const resolved = raw ? resolveAgentName(raw).name : '';
  const name = resolved || raw;
  if (!targetAllowed(user, name)) {
    throw new McpError(ErrorCode.InvalidRequest, `Not permitted by API key target grant: ${name || 'this action'}`);
  }
  if (tool !== 'create_agent') requireAccess(user, name);
  if (!toolAllowed(user, tool, name)) {
    throw new McpError(ErrorCode.InvalidRequest, `Not permitted by API key tool grant: ${tool}`);
  }
}

/** Single-quote a caller-supplied string for `sh -lc`. The `cwd` argument is
 *  caller-controlled, so interpolating it raw would let a name like
 *  `/www1; rm -rf /` become two commands. Closes the quote first, which is the
 *  only way a single-quoted string can be escaped out of. */
function shellQuote(s) {
  return `'${String(s == null ? '' : s).replace(/'/g, `'\\''`)}'`;
}

/** Which pad did the caller mean? (plan 61, findings 1e/1f/1b)
 *
 *  The surface handed out three different names for the same agent — the
 *  container name, the bare name `create_agent` accepts, and the
 *  `display_name` it *lists* — and accepted only one of them. So a caller who
 *  reads a name off `list_agents` and passes it straight back used to get
 *  "Agent not found", and the cheapest way to be wrong was `pad-proj` (not a
 *  pad) vs `pad-proj2` (is).
 *
 *  Resolution order, cheapest first:
 *    1. exact container name            — `pad-proj2`
 *    2. bare name + prefix              — `proj2` → `pad-proj2`, mirroring
 *                                         `create_agent`'s own naming rule.
 *                                         Checked BEFORE substring, so a
 *                                         prefixed exact match wins even when
 *                                         it is a substring of another pad
 *                                         (`proj` → `pad-opencode-proj`, not
 *                                         refused as ambiguous vs `pad-proj2`).
 *    3. exact `display_name`            — `Proj2` → `pad-proj2`
 *    4. exactly one container containing it — `glm` → `pad-proj2`. This
 *                                         RESOLVES, rather than only hinting:
 *                                         uniqueness is the proof, so the
 *                                         caller is not left to guess. The
 *                                         resolved name is echoed back in the
 *                                         response so a caller can see which
 *                                         pad it really got.
 *
 *  Returns `{ name, agent, candidates }`. An ambiguous name resolves to no name
 *  at all (`name: ''`) and carries every candidate in `candidates`, so a caller
 *  is told which ones exist rather than handed a plausible wrong one; the read
 *  tools surface that list in the error instead of refusing outright, because
 *  the whole finding is that the caller was left with nowhere to go.
 *
 *  IMPORTANT: this runs BEFORE `requireTool`, never after. A grant must be
 *  checked against the RESOLVED name — resolving first and granting on the
 *  raw string is how a target-restricted key gets talked into another pad. */
function resolveAgentName(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { name: '', agent: null, candidates: [] };

  const fleet = registry.discoverAgents();
  const exact = fleet.find((a) => a.name === raw);
  if (exact) return { name: exact.name, agent: registry.getAgent(exact.name), candidates: [] };

  // The prefix create_agent itself applies, so a name it would have produced
  // resolves back to the same pad.
  const prefixed = raw.startsWith(registry.PREFIX || 'pad-') ? null : `${registry.PREFIX || 'pad-'}${raw}`;
  if (prefixed) {
    const hit = fleet.find((a) => a.name === prefixed);
    if (hit) return { name: hit.name, agent: registry.getAgent(hit.name), candidates: [] };
  }

  const byDisplay = fleet.find((a) => a.display_name && String(a.display_name).toLowerCase() === raw.toLowerCase());
  if (byDisplay) return { name: byDisplay.name, agent: registry.getAgent(byDisplay.name), candidates: [] };

  // A substring hit is only acted on when it is UNIQUE. Two matches means the
  // caller's name is genuinely ambiguous and guessing would be the exact
  // "command on the wrong agent" failure this exists to prevent.
  const needle = raw.toLowerCase();
  const partial = fleet.filter((a) =>
    a.name.toLowerCase().includes(needle) ||
    (a.display_name && String(a.display_name).toLowerCase().includes(needle))
  );
  if (partial.length === 1) {
    return { name: partial[0].name, agent: registry.getAgent(partial[0].name), candidates: [partial[0].name] };
  }
  return { name: '', agent: null, candidates: partial.map((a) => a.name) };
}

/** True when `name` is a real container on the host that Paddock does not
 *  manage (plan 61, finding 1b). Without this, "Agent not found" is
 *  indistinguishable between "no such pad" and "you are looking at a container
 *  that is not a pad" — the caller's next move (go and make a pad for it) is
 *  completely different in each case. */
async function foreignContainerName(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return '';
  try {
    // `runCmd` returns a PROMISE. Reading `out.stdout` off it without awaiting
    // yields undefined, so this probe silently reported "not a container" for
    // every input — a dead check that looks like a working one.
    const out = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 15000 });
    const names = String(out.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return names.includes(raw) ? raw : '';
  } catch {
    return '';
  }
}

/** The not-found message a caller can act on: say what was wrong with the name
 *  AND, when the name is a host container, that it exists but is not a pad. */
async function notFoundMessage(input, candidates) {
  const raw = String(input == null ? '' : input).trim();
  const parts = [`Agent not found: ${raw}`];
  if (candidates && candidates.length === 1) {
    parts.push(`Did you mean "${candidates[0]}"?`);
  } else if (candidates && candidates.length > 1) {
    parts.push(`Ambiguous — it matches ${candidates.length} pads: ${candidates.join(', ')}. Pass an exact name.`);
  } else {
    // Only on the miss path, so the docker probe costs nothing on a hit.
    const foreign = await foreignContainerName(raw);
    if (foreign) {
      parts.push(`"${foreign}" IS a container on this host, but it is not a Paddock-managed PAD (no instances/${foreign}/meta.env). Paddock cannot open it — create a PAD for it if you want to work in it.`);
    }
  }
  return parts.join(' ');
}

async function requireAgent(agentName) {
  const r = resolveAgentName(agentName);
  if (r.agent) return r.agent;
  throw new McpError(ErrorCode.InvalidRequest, await notFoundMessage(agentName, r.candidates));
}

/** Gate the call AND hand back the agent, so a tool cannot gate on the raw
 *  string and then act on it. Every `name`-taking tool should start with this
 *  and use `agent.name` from there on — a tool that calls `requireTool` and
 *  then passes the caller's own `name` to `vm.startAgent` is doing the work on
 *  whatever it was handed, not on whatever it authorized. */
async function requirePad(tool, agentName) {
  requireTool(currentUser(), tool, agentName);
  return await requireAgent(agentName);
}

/** The registry's agent object carries `web.token` — the bearer credential for a
 *  published openclaw Control UI, used by the dashboard to build the
 *  tokenized `#token=…` console link. It must NOT cross the MCP boundary: a
 *  caller sweeping the fleet with `get_agent` would collect every published pad's
 *  credential into one output, and the guide promises read tools never return web
 *  secrets. So every agent object the tools return goes through here first.
 *  `tokenConfigured` is the honest answer ("there is one"), matching what
 *  `health` / `settings_get` already do for other write-only fields. */
function publicAgent(agent) {
  if (!agent) return agent;
  if (!agent.web || agent.web.token === undefined) return agent;
  const { token, ...rest } = agent.web;
  return { ...agent, web: { ...rest, tokenConfigured: !!token } };
}

/** Task-tool gate (plan 47). A task that names a PAD — assigned at submit, or
 *  claimed by a worker — resolves that PAD and goes through the normal
 *  owner + grant flow. An unclaimed pool task has no owning PAD, and
 *  `requireAccess('')` would reject it, so the shared pool is grant-scoped. */
function requireTaskGrant(user, tool, task) {
  if (!task) throw new McpError(ErrorCode.InvalidRequest, 'Task not found');
  const pad = task.claimed_by || task.agent_name || '';
  if (pad) {
    requireTool(user, tool, pad);
    return;
  }
  if (user && !toolAllowed(user, tool, '')) {
    throw new McpError(ErrorCode.InvalidRequest, `Not permitted by API key tool grant: ${tool}`);
  }
}

/** Runner errors are plain Errors; surface them as clean tool errors so the
 *  calling LLM reads the message instead of an internal-error envelope. */
function taskError(fn) {
  try {
    return fn();
  } catch (e) {
    throw new McpError(ErrorCode.InvalidRequest, e.message);
  }
}

/** The task-surface equivalent, for the one call that is async: `submitTask`
 *  verifies the PAD's workspace inside the container before it files the task
 *  (plan 63 1k), so its failures are promises. Wrapping it in the sync
 *  `taskError` would hand the caller a bare Promise as if it were a task id. */
async function taskErrorAsync(fn) {
  try {
    return await fn();
  } catch (e) {
    throw new McpError(ErrorCode.InvalidRequest, e.message);
  }
}

const TASK_PROMPT_CLIP = 200;

/** One projection for every task tool (plan 63). `route` / `outcome` /
 * `timedOut` are DERIVED in the service and returned by all of them, because a
 * field one tool emits and another drops is a caller inferring the difference
 * from something else — the parity bug the Mission tools had. `claimedBy` is
 * deliberately NOT added alongside `claimed_by`: the row already says who
 * claimed it, and a second spelling of the same value is the ambiguity this
 * plan exists to remove. */
function taskRow(t, { full = false } = {}) {
  if (!t) return null;
  const prompt = String(t.prompt || '');
  const clipped = prompt.length > TASK_PROMPT_CLIP;
  const row = {
    id: t.id,
    status: t.status,
    outcome: taskRunner.taskOutcome(t),
    timedOut: !!t.timed_out,
    route: taskRunner.taskRoute(t),
    agent_name: t.agent_name,
    claimed_by: t.claimed_by,
    priority: t.priority,
    prompt: full ? prompt : (clipped ? prompt.slice(0, TASK_PROMPT_CLIP) + '…[truncated]' : prompt),
    prompt_truncated: full ? false : clipped,
    exit_code: t.exit_code,
    attempt: Number(t.attempt) || 1,
    superseded_by: t.superseded_by,
    created_by: t.created_by,
    created_at: t.created_at,
    finished_at: t.finished_at,
  };
  if (full) {
    row.model = t.model;
    row.agent = t.agent_type;
    row.result_summary = t.result_summary;
    row.started_at = t.started_at;
    row.last_output_at = t.last_output_at;
    row.timeout_ms = t.timeout_ms;
  }
  return row;
}

/** One task_steps row, agent-facing. `state` is where the step is in its own
 *  lifecycle (pending / running / needs_review / failed / done / aborted),
 *  `status` is the verdict it was reported with, and `artifact` is where the
 *  commit SHA (or a bug's file:line) is recorded — never the step's location. */
function stepRow(s) {
  if (!s) return null;
  return {
    task_id: s.task_id,
    step: s.step,
    attempt: Number(s.attempt) || 1,
    state: s.state,
    status: s.status || null,
    session_id: s.session_id || null,
    reported_by: s.reported_by || null,
    notes: s.notes || '',
    artifact: s.artifact || '',
    occurred_at: s.occurred_at,
  };
}

// ─── Mission (plan 55) ─────────────────────────────────────────────
// The agent-visible half of the Mission page: it can see the human's projects
// and sessions, read what a session's TUI is showing, open a session, and type
// into one. Every tool is a thin adapter over `src/services/mission/` — the
// same functions `/api/mission/*` uses, so the two surfaces cannot drift.
//
// `/mcp` has no caller-PAD identity (it sees an API key and nothing else), so
// the gate is per call: resolve the row → read the PAD name off it → requireTool.

/** A PlansError's machine code is what an LLM branches on
 *  (`plan_path_invalid` → fix the argument, `plan_workspace_not_host_visible` →
 *  a different PAD, `plan_session_unknown` → the id is stale). Same reason as
 *  missionFail: errorResult prints only err.message, so the code goes in the
 *  text explicitly. */
function plansFail(err) {
  if (err instanceof plans.PlansError) {
    throw new McpError(ErrorCode.InvalidRequest, `${err.code}: ${err.message}`);
  }
  if (err instanceof McpError) throw err;
  console.error('[mcp] plans tool failed:', err?.message || err);
  throw new McpError(ErrorCode.InvalidRequest, String(err?.message || err));
}

/** Run a service call with its PlansError turned into a clean tool error. */
async function plansCall(fn) {
  try {
    return await fn();
  } catch (e) {
    plansFail(e);
  }
}

/** A MissionError's machine code is what an LLM branches on
 *  (`mission_session_locked` → do not retry, `mission_folder_missing` → fix the
 *  project first). errorResult only prints err.message, so the code would be
 *  lost — put it in the text explicitly. */
function missionFail(err) {
  if (err instanceof mission.MissionError) {
    // Plan 88 §Phase 2: carry the structured delivery outcome so the LLM can
    // branch on "written but unobserved" (attempted + acceptance:unknown) vs a
    // pre-write refusal, without parsing prose. Only appended when present.
    const meta = err.acceptance ? ` [attempted=${!!err.attempted} acceptance=${err.acceptance}]` : '';
    throw new McpError(ErrorCode.InvalidRequest, `${err.code}: ${err.message}${meta}`);
  }
  if (err instanceof McpError) throw err;
  console.error('[mcp] mission tool failed:', err?.message || err);
  throw new McpError(ErrorCode.InvalidRequest, String(err?.message || err));
}

/** Run a service call with its MissionError turned into a clean tool error. */
async function missionCall(fn) {
  try {
    return await fn();
  } catch (e) {
    missionFail(e);
  }
}

/** The pipeline surface's errors are either the driver's own `PipelineError`
 *  or a MissionError from the session gate — both carry a machine `code`, and
 *  the SDK's error path prints only `message`, so the code goes in front. An
 *  McpError (a grant refusal) already has the shape the caller expects. */
function pipelineFail(e) {
  if (e instanceof McpError) throw e;
  if (e && typeof e.code === 'string'
      && (e instanceof taskPipeline.PipelineError || e instanceof mission.MissionError)) {
    throw new McpError(ErrorCode.InvalidRequest, `${e.code}: ${e.message}`);
  }
  console.error('[mcp] pipeline tool failed:', e?.message || e);
  throw new McpError(ErrorCode.InvalidRequest, String(e?.message || e));
}

async function pipelineCall(fn) {
  try {
    return await fn();
  } catch (e) {
    pipelineFail(e);
  }
}

/** PAD names this caller may see Mission rows for: owner-scoped like every other
 *  read, then narrowed by the key's target grant. Returns [] for a user who owns
 *  nothing, which the store already treats as "no projects" (`listProjects`
 *  short-circuits on an empty agents array) rather than as an error. */
function missionVisibleAgents(user) {
  if (!user) return null; // no identity = no filter (same as an unauthenticated read)
  let rows = [];
  try {
    rows = getDb().prepare('SELECT name FROM agents').all();
  } catch {
    return [];
  }
  return rows.map((r) => r.name).filter((n) => canAccess(user, n) && targetAllowed(user, n));
}

/** May this caller see Mission rows for this PAD? */
function missionMaySee(user, agentName) {
  const names = missionVisibleAgents(user);
  return !names || names.includes(agentName);
}

/** What a container-killing operation is about to take (plan 65 1d).
 *
 *  Two jobs, and the second is the one that is easy to skip: a recreate on a pad
 *  that is NOT the caller's target would otherwise print the session ids of
 *  somebody else's conversations. So the rows are filtered to what the key may
 *  see, and — because a *filtered* count sitting next to a phrase like "every
 *  session" is a lie the caller cannot detect — `sessionsEndedHidden` says how
 *  many were withheld. Same rule as `task_list`'s `total` and the plans listing
 *  that dropped its unattributable rows.
 *
 *  Best effort by design. A mission store that cannot be read, or a pad with no
 *  projects, must not stop a settings change: the caller then gets
 *  `sessionsEndedKnown: false` and the rows are dated `gone` by the next
 *  liveness pass, which is a weaker but still true answer. */
async function missionSessionsEnded(agentName, by = 'recreate') {
  const user = currentUser();
  let ended;
  try {
    ended = await missionCall(() => mission.endSessionsForPad(agentName, by));
  } catch {
    return { sessionsEndedKnown: false };
  }
  const maySee = (r) => {
    const name = r && r.project && r.agentName ? r.agentName : agentName;
    return missionMaySee(user, name);
  };
  const visible = ended.filter(maySee);
  const hidden = ended.length - visible.length;
  // Strip the internal agentName the service rides for scoping.
  const rows = visible.map(({ agentName: _drop, ...r }) => r);
  return {
    sessionsEnded: rows,
    sessionsEndedCount: rows.length,
    ...(hidden ? { sessionsEndedHidden: hidden } : {}),
    sessionsEndedKnown: true,
  };
}

/** A project the caller may touch. A project on someone else's PAD is reported
 *  as "no project you can access" rather than 403 — a read that confirms the row
 *  exists leaks the other user's naming. */
function missionRequireProject(user, tool, projectId) {
  const project = missionCallSync(() => mission.getProject(projectId));
  if (!missionMaySee(user, project.agent_name)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `mission_project_forbidden: no Mission project ${projectId} that your key can access`
    );
  }
  requireTool(user, tool, project.agent_name);
  return project;
}

/** Narrow a project list to the one a caller meant, by id, name or folder
 *  (plan 67, 67.2).
 *
 *  A project's `name` is not its `folder` (`paddock` → `/www2/paddock`), and
 *  without this the only way to resolve "the paddock project" was to fetch every
 *  project and match client-side — paying the whole fleet to answer a question
 *  about one of them. Both spellings are accepted because a caller reaching for
 *  a project usually holds the directory, and a caller reading a board holds
 *  the name.
 *
 *  A miss and a collision are BOTH reported, with the candidates, instead of
 *  falling back to the unfiltered list: an unfiltered answer to a narrow
 *  question is the one response a caller cannot tell apart from success. The
 *  candidate list is drawn from what the caller may already see, so this never
 *  confirms that a project on someone else's pad exists. */
function missionSelectProjects(projects, { projectId = '', name = '', folder = '' } = {}) {
  const wantId = String(projectId || '').trim();
  const wantName = String(name || '').trim();
  const wantFolder = String(folder || '').trim();
  if (!wantId && !wantName && !wantFolder) return projects;
  const describe = (p) => `${p.id} (${p.name}, ${p.folder}, on ${p.agent_name})`;

  if (wantId) {
    const hit = projects.filter((p) => p.id === wantId);
    if (hit.length === 1) return hit;
    // A caller who has the id wants THAT project; anything else is a mistake
    // worth naming, not a reason to hand back the fleet.
    throw new McpError(
      ErrorCode.InvalidRequest,
      `mission_project_not_found: no Mission project with id ${wantId} that your key can access` +
        (hit.length ? '' : ` — projects you can see: ${projects.slice(0, 12).map(describe).join('; ')}`)
    );
  }

  const exact = projects.filter((p) => p.name.toLowerCase() === wantName.toLowerCase());
  const byFolder = projects.filter((p) => p.folder === wantFolder);
  const hits = wantName ? exact : byFolder;
  const via = wantName ? 'name' : 'folder';
  if (hits.length === 1) return hits;
  if (hits.length > 1) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `mission_project_ambiguous: ${via} "${wantName || wantFolder}" matches ${hits.length} projects — ` +
        `${hits.map(describe).join('; ')} — pass project_id instead`
    );
  }
  // Nothing matched: offer the nearest names so the caller can correct itself
  // instead of re-listing everything. Containment is tested BOTH ways on
  // purpose — the common miss is a typo ("paddockk") and a one-way substring
  // test is blind to exactly that, since "paddock" does not contain "paddockk".
  const q = wantName.toLowerCase();
  const near = wantName
    ? projects.filter((p) => {
        const n = p.name.toLowerCase();
        return n.includes(q) || q.includes(n);
      })
    : projects;
  throw new McpError(
    ErrorCode.InvalidRequest,
    `mission_project_not_found: no Mission project with ${via} "${wantName || wantFolder}" that your key can access` +
      (near.length ? ` — close: ${near.slice(0, 8).map(describe).join('; ')}` : ` — projects you can see: ${projects.slice(0, 12).map(describe).join('; ')}`)
  );
}

/** Resolve the plans FOLDER a `plan_list` / `plan_write` call targets (plan 82).
 *
 *  Two modes, and what the caller passes chooses which:
 *
 *   - PROJECT mode (`project_id` or `folder` present): the plans folder is
 *     `<project.folder>/<project.plans_folder>`, inside one Mission project's
 *     own directory. Resolution goes through what the KEY may see, then the
 *     project's PAD is authorized — resolve-then-gate, like every mission tool,
 *     so a target-restricted key is never gated on a name it did not name.
 *   - LEGACY mode (`agent` alone): the PAD-root `plans/`, unchanged.
 *
 *  A supplied `agent` alongside a project must AGREE with the project's pad.
 *  Picking one of the two silently is the failure this exists to prevent: the
 *  caller named two pads' worth of context and one of them is wrong.
 *
 *  An explicit bad/ambiguous project NEVER falls back to legacy `plans/` —
 *  `missionSelectProjects` throws with the candidates, and that is the answer. */
async function resolvePlansScope(user, tool, { agent, project_id, folder } = {}) {
  const wantId = String(project_id || '').trim();
  const wantFolder = String(folder || '').trim();
  if (!wantId && !wantFolder) {
    if (!agent) {
      throw new McpError(
        ErrorCode.InvalidParams,
        'plan_scope_required: pass `agent` for the PAD-wide plans folder, or `project_id`/`folder` for one Mission project\'s plans folder.'
      );
    }
    const pad = await requirePad(tool, agent);
    return { padName: pad.name, project: null };
  }
  const visible = missionCallSync(() => mission.listProjects({ agents: missionVisibleAgents(user) }));
  const [project] = missionSelectProjects(visible, { projectId: wantId, folder: wantFolder });
  const padName = project.agent_name;
  if (agent && agent !== padName) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `plan_agent_mismatch: project ${project.id} (${project.name}) is on ${padName}, not ${agent} — pass its own PAD or drop \`agent\`.`
    );
  }
  requireTool(user, tool, padName);
  return { padName, project };
}

/** WHO is acting, in the one spelling the audit log stores: `key:<id>` for an MCP
 *  key, `user:<id>` for the web UI, `system` when there is no caller to name.
 *  This is deliberately the SAME convention as a session's `created_by` and a
 *  task's `created_by`, so "who started it" and "who typed into it" are two
 *  fields of one vocabulary — an audit log that spells its actor differently
 *  from the row it sits beside is a log nobody queries twice. */
function missionActor(user) {
  if (user && user.keyId) return `key:${user.keyId}`;
  if (user && user.userId) return `user:${user.userId}`;
  return 'system';
}

/** The same, for a session: a session is reachable only through its project, so
 *  the PAD name (and therefore the grant check) always comes from there. */
function missionRequireSession(user, tool, sessionId) {
  const session = missionCallSync(() => mission.getSession(sessionId));
  const project = missionRequireProject(user, tool, session.project_id);
  return { session, project };
}

/** The sync half of missionCall (the store throws, the tmux half returns a
 *  promise). Same conversion, no async. */
function missionCallSync(fn) {
  try {
    return fn();
  } catch (e) {
    missionFail(e);
  }
}

/** Liveness is decoration: one `list-sessions` per PAD, and a PAD that cannot
 *  be listed leaves every one of its sessions marked dead rather than failing
 *  the whole read. Same rule as the REST list routes. */
async function missionWithLive(fn) {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Compact session row for the LLM: the DB columns it would otherwise have to
 *  know, renamed to the field names the rest of the MCP surface uses. */
// The store's busy-detection stamps `busy` / `busyKnown` / `open` while it
// merges its per-(PAD, folder) probes. They are projected only when the store
// actually stamped them, so a row is never given a `false` that means "we did
// not look". `busyKnown: false` is NOT "idle" — it is "the probe could not
// answer" (the server exposes no idle-presence registry), and an LLM must not
// read it as licence to type into a session.
function missionActivity(s) {
  const out = {};
  if (s.busy !== undefined) out.busy = !!s.busy;
  if (s.busyKnown !== undefined) out.busyKnown = !!s.busyKnown;
  if (s.open !== undefined) out.open = !!s.open;
  if (s.state !== undefined) out.state = s.state;
  // A dead row the server STILL calls busy is the case a caller must be able to
  // see without re-deriving it: the conversation exists somewhere we cannot
  // reach. Omitted when it is absent, never defaulted to false.
  if (s.wasBusy !== undefined) out.wasBusy = !!s.wasBusy;
  // How the session's LIFE ended, and when we first saw it (plan 65 1b). Only
  // present once a death has been observed, so an unprobed row reads "we do not
  // know" rather than "it never ended". `endedAt` is the FIRST OBSERVATION of
  // the death, not the instant of it — the tool description says so, because a
  // caller reading it as the exact moment would be wrong about every `gone` row.
  if (s.ended_at) out.endedAt = s.ended_at;
  if (s.ended_by) out.endedBy = s.ended_by;
  return out;
}

/** What is IN the pane, visible before anyone types (plan 62 1b). `kind` is the
 *  word a caller can act on — "shell" means a send would run commands — and
 *  `tuiAlive` is the same fact as a boolean for older readers. Emitted only
 *  when the pane map had an answer, so a missing field stays missing. */
function missionPaneKind(s) {
  const out = {};
  if (s.tuiAlive !== undefined) out.tuiAlive = !!s.tuiAlive;
  if (s.kind !== undefined) out.kind = s.kind;
  if (s.command !== undefined) out.command = s.command;
  if (s.cwd !== undefined) out.cwd = s.cwd;
  return out;
}

function missionSessionRow(s, project) {
  return {
    id: s.id,
    tmux_id: s.tmux_id,
    label: s.label || '',
    origin: s.origin,
    // The WHO, not the kind: `key:<id>` when an MCP key opened it, `user:<id>`
    // when the web UI did, absent on rows created before this existed (plan 67,
    // 67.3). "Is a human or an agent driving this?" is the first question before
    // typing into a session, and `origin` alone cannot be audited later.
    ...(s.created_by ? { createdBy: s.created_by } : {}),
    locked: !!s.locked,
    live: s.live === undefined ? null : !!s.live,
    agent_session_id: s.agent_session_id || null,
    agent: project ? project.agent_name : undefined,
    folder: project ? project.folder : undefined,
    project_id: s.project_id,
    project: project ? { id: project.id, name: project.name } : undefined,
    ...missionActivity(s),
    ...missionPaneKind(s),
    created_at: s.created_at,
    // `last_seen_at` advances on every probe of a LIVE pane (plan 62 1f). It is a
    // probe clock, not a heartbeat of agent activity — a session that is being
    // worked on by nobody in our terminal can still be advanced by the poller.
    // It is the last time this row was looked at, and nothing more.
    last_seen_at: s.last_seen_at,
  };
}

/** One project, with its COUNTS before its nested sessions.
 *
 *  The counts are the answer; the sessions are the detail, and inlining every
 *  session of every project made this read a superset of `mission_sessions`
 *  (26 full rows for a six-project fleet, plan 67 / 67.4) with the summary
 *  arriving *after* the data it summarizes. `includeSessions` is therefore
 *  opt-in: `mission_sessions` is the tool for the rows.
 *
 *  `agentStatus` rides along because "can I reach this project?" otherwise
 *  needs a second tool — the same repo is often mounted by two pads and the
 *  one named after it is not always the one running (67.2). */
function missionProjectRow(p, { includeSessions = false } = {}) {
  const agent = registry.getAgent(p.agent_name);
  return {
    id: p.id,
    name: p.name,
    agent: p.agent_name,
    agent_type: p.agent_type,
    ...(agent && agent.status ? { agentStatus: agent.status } : {}),
    folder: p.folder,
    plans_folder: p.plans_folder || 'plans',
    sessionCount: p.sessionCount,
    liveCount: p.liveCount,
    ...(p.openCount === undefined ? {} : { openCount: p.openCount }),
    ...(includeSessions ? { sessions: (p.sessions || []).map((s) => missionSessionRow(s, p)) } : {}),
    created_at: p.created_at,
  };
}

function textResult(obj) {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/** A failed tool call, as an MCP tool result rather than a thrown exception.
 *  The caller reads the message; `isError` is what makes an LLM treat it as a
 *  failed call instead of as output to act on. */
function errorResult(err) {
  const text = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text', text }] };
}

/** Register a tool with its handler wrapped so a THROW becomes a tool error.
 *
 *  This is not cosmetic: the installed MCP SDK's request wrapper does
 *  `result = await Promise.resolve(handler(request, extra))` with no catch, so
 *  any handler that throws (every `requireTool`/`requireAgent` authorization
 *  rejection, `requireHostBrowsable` in the workspace tools, a bad argument)
 *  escapes as an unhandled rejection and takes the WHOLE webui process down.
 *  That happened for real: one agent repeatedly listing a workspace it is not
 *  host-browsable killed the control plane every ~45s, which dropped every
 *  terminal WebSocket, orphaned every `tmux attach` client and made the
 *  Mission terminal look like it was glitching on a timer. One bad tool call
 *  must never be fatal to the server that hosts the agents. */
function registerTool(server, name, config, handler) {
  server.registerTool(name, config, async (...args) => {
    try {
      return await handler(...args);
    } catch (err) {
      // McpError carries protocol-meaningful codes; let those keep their shape.
      if (err instanceof McpError) throw err;
      console.error(`[mcp] tool ${name} failed:`, err?.message || err);
      return errorResult(err);
    }
  });
}

function registerTools(server) {
  // Every tool is registered through the wrapper above so a throwing handler
  // degrades to a tool error instead of killing the webui.
  const registerToolBound = (name, config, handler) => registerTool(server, name, config, handler);

  // Each area's tools live in mcp/tools-<area>.js and register themselves here,
  // in the order they used to appear in this function.
  require('./mcp/tools-agents')(registerToolBound, {
    currentUser, canAccess, targetAllowed, textResult, publicAgent, requirePad, createNameFor,
    requireTool, missionSessionsEnded,
  });
  require('./mcp/tools-ops')(registerToolBound, {
    resolveAgentName, requireTool, currentUser, textResult, notFoundMessage, requirePad,
    shellQuote, dockerExec,
  });
  require('./mcp/tools-tasks')(registerToolBound, {
    currentUser, requireTool, requireAgent, toolAllowed, taskErrorAsync, taskRow, textResult,
    requirePad, taskError, requireTaskGrant, stepRow, canAccess, targetAllowed,
    missionRequireSession, missionCall, missionActor, pipelineCall,
  });
  require('./mcp/tools-mission')(registerToolBound, {
    currentUser, requireTool, missionCallSync, missionVisibleAgents, missionWithLive,
    missionSelectProjects, missionProjectRow, textResult, missionRequireSession, missionCall,
    missionSessionRow, missionRequireProject, missionMaySee, missionActor, resolveAgentName,
  });
  require('./mcp/tools-plans')(registerToolBound, {
    resolvePlansScope, currentUser, plansCall, textResult, requirePad, missionActor,
  });
  require('./mcp/tools-runners')(registerToolBound, {
    currentUser, missionCall, missionCallSync, missionRequireProject, missionVisibleAgents,
    missionSelectProjects, missionActor, textResult,
  });

  registerAgentQueueTools(registerToolBound, {
    authorize: (runnerId, write) => {
      const runner = mission.getRunner(runnerId);
      if (!runner) throw new Error(`runner_not_found: ${runnerId}`);
      try {
        missionRequireProject(currentUser(), write ? 'queue_write' : 'queue_read', runner.project_id);
      } catch (error) {
        // The server wrapper intentionally converts ordinary errors into tool
        // error results; rethrowing McpError escapes its catch in this SDK.
        throw new Error(error?.message || String(error));
      }
      return runner;
    },
    actor: () => missionActor(currentUser()),
  });
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

  // Mounted first: `/mcp/runner` must never be mistaken for the control surface.
  mountRunnerMcp(app);
  app.use('/mcp', router);
}

/** Plan 117: the RUNNER surface. A worker pad gets exactly the two queue tools
 *  it needs, authenticated by its own per-pad token (never a user API key), and
 *  only for runners whose project lives on that same pad. Wired into the pad
 *  automatically by `mission.ensureRunnerMcp` when Run is pressed. */
const { RUNNER_MCP_SERVER: RUNNER_SERVER_NAME } = require('./services/paddock-mcp');
function createRunnerServer(padName) {
  const server = new McpServer(
    { name: RUNNER_SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );
  const registerToolBound = (name, config, handler) => registerTool(server, name, config, handler);
  registerAgentQueueTools(registerToolBound, {
    only: WORKER_QUEUE_TOOLS,
    authorize: (runnerId) => {
      const runner = mission.getRunner(runnerId);
      if (!runner) throw new Error(`runner_not_found: ${runnerId}`);
      const project = mission.getProject(runner.project_id);
      // Same message for "not yours" as for "not found" would hide a real
      // misconfiguration; the id is the caller's own input, so naming the
      // mismatch leaks nothing it did not already send.
      if (!project || project.agent_name !== padName) {
        throw new Error(`runner_not_on_this_pad: runner ${runnerId} does not belong to ${padName}`);
      }
      return runner;
    },
    actor: () => `runner-mcp:${padName}`,
  });
  return server;
}

function mountRunnerMcp(app) {
  const runnerTokens = require('./services/runner-mcp-token');
  const handle = async (req, res) => {
    const header = req.headers.authorization || '';
    const padName = runnerTokens.authenticate(header.startsWith('Bearer ') ? header.slice(7).trim() : null);
    if (!padName) {
      return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized: missing or invalid runner token' } });
    }
    const server = createRunnerServer(padName);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    try {
      await server.connect(transport);
      await mcpContext.run({ user: null, runnerPad: padName }, () => transport.handleRequest(req, res, req.body));
    } catch (err) {
      console.error('[mcp/runner] request error:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.InternalError, message: 'Internal error' } });
      }
    }
  };
  const router = express.Router();
  router.post('/', handle);
  router.get('/', handle);
  router.delete('/', handle);
  app.use('/mcp/runner', router);
}

// The grant + Mission gate helpers are exported for the same reason the grant
// ones are: they are the policy, and `mcp.test.js` asserts on them directly.
// `mcpContext` is exported so a test can run a tool call under a synthetic
// identity (it is the same store mountMcp fills per request).
module.exports = { mountMcp, authenticateRequest, registerTools, createServer, createRunnerServer, RUNNER_SERVER_NAME, SERVER_NAME, SERVER_VERSION, keyGrants, targetAllowed, toolAllowed, requireTool, mcpContext, missionVisibleAgents, missionMaySee, missionRequireProject, missionRequireSession, missionFail, publicAgent, resolveAgentName, notFoundMessage, shellQuote, missionSelectProjects, execDockerArgs };
