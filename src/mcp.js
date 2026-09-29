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
  return runCmd('docker', ['exec', '-i', vmName, 'sh', '-lc', cmd], { timeout, input });
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

// ─── API-key grants (plan 35b) ──────────────────────────────────
// Fine-grained keys restrict the fleet an agent can reach (target grant) and
// the tools it may invoke (tool grant). Both are enforced HERE, before the
// owner/admin checks, so a restricted admin key stays restricted.

const READ_TOOLS = new Set([
  'list_agents', 'get_agent', 'agent_logs', 'config_get', 'settings_get',
  'health', 'workspace_list', 'workspace_read', 'help', 'agent_commands',
  'task_status', 'task_result', 'task_list',
  // Job readers are pure reads on the in-memory job store, so a read-only key
  // may poll the progress of a create/recreate it is not allowed to start.
  'job_status', 'job_log',
  // Mission reads (plan 55): the agent can WATCH the human work without being
  // able to type into it — that separation is the point of the read bucket.
  'mission_projects', 'mission_sessions',
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
  // Mission writers (plan 55). A project is a row, so it rides the same `create`
  // bucket as create_agent. Starting a session spawns a real TUI that burns
  // tokens, and mission_send types into a live conversation — both are work in
  // a PAD, so both ride `exec` (52 F2's "the verbs that do work" bucket).
  mission_project_create: 'create',
  mission_session_start: 'exec',
  mission_send: 'exec',
  // Answering a permission dialog is a WRITE into a live conversation, and the
  // most consequential answer available to an agent — so it rides `exec` with
  // mission_send rather than the read bucket, and `always` is refused in the
  // handler regardless of what the key may do.
  mission_permission_answer: 'exec',
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
 *  is read + workspace + exec; mutating tools need their opt-in grant. */
function toolAllowed(user, tool, agentName) {
  if (!user) return true;
  const g = keyGrants(user);
  if (g.full) return targetAllowed(user, agentName);
  if (g.readOnly) return READ_TOOLS.has(tool) && targetAllowed(user, agentName);
  if (READ_TOOLS.has(tool) || tool === 'exec' || tool === 'workspace_write'
      || TOOL_GRANT_FOR[tool] === 'exec') {
    return targetAllowed(user, agentName);
  }
  const grant = TOOL_GRANT_FOR[tool];
  if (!grant) return targetAllowed(user, agentName);
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

// ─── Mission (plan 55) ─────────────────────────────────────────────
// The agent-visible half of the Mission page: it can see the human's projects
// and sessions, read what a session's TUI is showing, open a session, and type
// into one. Every tool is a thin adapter over `src/services/mission.js` — the
// same functions `/api/mission/*` uses, so the two surfaces cannot drift.
//
// `/mcp` has no caller-PAD identity (it sees an API key and nothing else), so
// the gate is per call: resolve the row → read the PAD name off it → requireTool.

/** A MissionError's machine code is what an LLM branches on
 *  (`mission_session_locked` → do not retry, `mission_folder_missing` → fix the
 *  project first). errorResult only prints err.message, so the code would be
 *  lost — put it in the text explicitly. */
function missionFail(err) {
  if (err instanceof mission.MissionError) {
    throw new McpError(ErrorCode.InvalidRequest, `${err.code}: ${err.message}`);
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
      description: 'The single read tool for a PAD — the full picture before a `recreate`. Returns allowDocker, network peer, SSH (host + container port), custom workspace mount, extra volumes/ports, image/version, networkHealth, the available network-peer containers, AND the published-web state (active, webService, networkMode, passwordConfigured, tokenConfigured, actualPorts). The web password itself is never returned — `web.authToken` and `web.startCommand` come back empty/redacted because both embed it. `availableNetworks` is FILTERED to running containers that make sense as a peer (the whole host\'s container list is not useful here) and capped at 10 — read `availableNetworksTotal` / `availableNetworksTruncated` to know if you are seeing all of them. `workspaceDevcontainer` describes the .devcontainer in the WORKSPACE (shared by every pad on that workspace, NOT this pad\'s own config) — `sharedWith` lists the other pads using it.',
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
      description: 'Run the same Docker-level health checkup as the Settings tab. Diffs the declared compose file against the live container and reports each check — container status, docker /healthz probe, restart policy, image, network mode/peer, bind mounts, docker socket, published ports, env keys — as { key, label, status, expected, actual, hint }, plus an overall status and ok/warn/error counts. Works on stopped containers (reports why they are down).',
      inputSchema: { name: z.string().describe('PAD name') },
    },
    async ({ name }) => {
      const agent = await requirePad('health', name);
      const report = await containerHealth.checkContainerHealth(agent.name);
      return textResult(report);
    }
  );

  registerToolBound(
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
      const agent = await requirePad('workspace_list', name);
      const listing = workspace.listDir(agent.name, relPath || '/');
      return textResult({ name: agent.name, ...listing });
    }
  );

  registerToolBound(
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
      const agent = await requirePad('workspace_read', name);
      const stat = workspace.statFile(agent.name, relPath);
      if (!stat) throw new McpError(ErrorCode.InvalidRequest, `File not found: ${relPath}`);
      if (stat.size > MAX_READ_BYTES) {
        throw new McpError(ErrorCode.InvalidRequest, `File too large to read (${stat.size} bytes, max ${MAX_READ_BYTES}): ${relPath}`);
      }
      const file = workspace.readFile(agent.name, relPath);
      return textResult({ name: agent.name, path: relPath, size: file.size, modified: file.modified, content: file.content });
    }
  );

  registerToolBound(
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
      const agent = await requirePad('workspace_write', name);
      const result = workspace.writeFile(agent.name, relPath, content);
      return textResult({ name: agent.name, path: relPath, ...result });
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
      let result;
      try {
        result = await vm.applyAgentChanges(agent.name, { ...args, force: true }, { onLog, onStep });
      } catch (e) {
        jobLog.fail(job, e.message);
        throw new McpError(ErrorCode.InvalidRequest, `Recreate failed: ${e.message}`);
      }
      registry.dockerPsList(true);
      registry.discoverAgents();
      jobLog.finish(job, true, { name: agent.name });
      return textResult({ ...result, log });
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
      try {
        await vm.updateAgent(agent.name, { pull: true, onLog, onStep });
      } catch (e) {
        jobLog.fail(job, e.message);
        throw new McpError(ErrorCode.InvalidRequest, `Update failed: ${e.message}`);
      }
      registry.dockerPsList(true);
      registry.discoverAgents();
      jobLog.finish(job, true, { name: agent.name });
      return textResult({ ok: true, name: agent.name, action: 'updated' });
    }
  );

  // ─── Job readers (the answer to a timed-out create/recreate) ────────────
  // A create or a rebuild holds the MCP connection open for minutes, and the
  // client's timeout is not ours to raise. The work does NOT stop on a client
  // timeout — so the way out is never "retry the create" (that races a second
  // build against the first) but "read the job it left behind".

  /** The job key for a PAD. `kind` narrows it: 'create' → `<name>`,
   *  'recreate'/'update' → `update:<name>`, 'health' → `health:<name>`.
   *  Omitted → the most recently started job of any kind for this pad. */
  /** Jobs are keyed by the RESOLVED pad name (`update:pad-proj2`), so a caller
   *  that holds a `display_name` or a bare name would otherwise get "no job in
   *  memory" for a job that is genuinely running. Resolving first is what makes
   *  the job readers agree with the tools that created the job. */
  function resolveJobName(name, kind) {
    const resolved = resolveAgentName(name).name || name;
    if (kind) {
      if (kind === 'create') return resolved;
      if (kind === 'health') return `health:${resolved}`;
      return `update:${resolved}`;
    }
    const jobs = jobLog.listJobs().filter((j) => j.name === resolved || j.name.endsWith(`:${resolved}`));
    return jobs.length ? jobs[0].name : resolved;
  }

  registerToolBound(
    'job_status',
    {
      title: 'Progress of a create / recreate / update',
      description: 'Read the progress of a long-running Paddock operation: the current step, whether it is still running, and the log line count. USE THIS INSTEAD OF RETRYING after a `create_agent` / `recreate` / `update` call times out — a timed-out call does NOT cancel the work, it keeps building in the background, and a second create would race it. Pass the pad name; omit `kind` to get the most recent job of any kind. Job state: running → done | failed. Jobs are held in memory and expire 5 minutes after they finish (a webui restart clears them all).',
      inputSchema: {
        name: z.string().describe('PAD name'),
        kind: z.enum(['create', 'recreate', 'update', 'health']).optional().describe('Which job to read (default: the most recent one for this pad)'),
        tail: z.number().int().min(1).max(200).optional().describe('Also return the last N log lines (default 0 = status only)'),
      },
    },
    async ({ name, kind, tail }) => {
      requireTool(currentUser(), 'job_status', name);
      const jobName = resolveJobName(name, kind);
      const status = jobLog.getStatus(jobName);
      if (!status) {
        const known = jobLog.listJobs().map((j) => j.name);
        // Do not point a caller at a pad that does not exist. The old hint sent
        // them to `get_agent` / `list_agents` for the very name that has no
        // instance directory, so following it only produced a second
        // contradiction (plan 61, finding 1a).
        const exists = !!resolveAgentName(name).name;
        return textResult({
          found: false,
          job: jobName,
          padExists: exists,
          hint: exists
            ? 'No job in memory for this operation. Either it finished more than 5 minutes ago, the webui restarted, or the operation never started. Check the pad itself with get_agent.'
            : await notFoundMessage(name, resolveAgentName(name).candidates),
          liveJobs: known,
        });
      }
      const out = { found: true, ...status, expiresIn: status.state === 'running' ? null : 'within 5 minutes of finishing' };
      if (tail) out.log = jobLog.logLines(jobName, { tail }) || [];
      return textResult(out);
    }
  );

  registerToolBound(
    'job_log',
    {
      title: 'Log of a create / recreate / update',
      description: 'The build/recreate log of a long-running Paddock operation — the same lines those tools return on success, readable afterwards. This is how you see WHY a create failed or how far a timed-out build got, without restarting anything. Pass the pad name; omit `kind` for the most recent job. Jobs expire 5 minutes after finishing, and a webui restart clears them.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        kind: z.enum(['create', 'recreate', 'update', 'health']).optional().describe('Which job to read (default: the most recent one for this pad)'),
        tail: z.number().int().min(1).max(2000).optional().describe('Return the last N lines (default 100)'),
      },
    },
    async ({ name, kind, tail }) => {
      requireTool(currentUser(), 'job_log', name);
      const jobName = resolveJobName(name, kind);
      const status = jobLog.getStatus(jobName);
      const lines = jobLog.logLines(jobName, { tail: tail || 100 });
      if (!status) {
        return textResult({
          found: false, job: jobName,
          hint: 'No job in memory for this operation (expired after 5 min, or the webui restarted).',
          liveJobs: jobLog.listJobs().map((j) => j.name),
        });
      }
      return textResult({ found: true, job: jobName, state: status.state, step: status.step, error: status.error, lineCount: status.lineCount, log: lines || [] });
    }
  );

  registerToolBound(
    'help',
    {
      title: 'How to use Paddock through MCP',
      description: 'The full "how to use Paddock" guide for an LLM — what Paddock is, the tool surface, caller rules/pitfalls, and numbered workflow recipes. Read this first, then call `agent_commands` for the exact non-interactive command catalog of the PAD type you are targeting.',
      inputSchema: {},
    },
    async () => textResult({ guide: getGuide() })
  );

  registerToolBound(
    'agent_commands',
    {
      title: 'Non-interactive command catalog for an agent type',
      description: 'Set B of the command catalog (plan 35a): the non-interactive, LLM-safe commands for one agent type, grouped by category, each with {label, cmd, desc, caveats}. `{key}` placeholders must be filled in by you (shell-quote values). Commands with `credentialInput: "stdin"` take a secret via `exec.stdin` — never put it in the command text. `notUsable` lists interactive-only commands you cannot run headlessly — hand those to the user. Defaults to openclaw.',
      inputSchema: {
        type: z.enum(listCatalogTypes()).optional().describe('Agent type (openclaw, opencode, picoclaw, hermes, codex, claude) — default openclaw'),
      },
    },
    async ({ type }) => {
      const catalog = getCommandCatalog(type);
      return textResult(catalog);
    }
  );

  registerToolBound(
    'exec',
    {
      title: 'Run command in PAD',
      description: 'Run a shell command inside a PAD container (docker exec). Returns stdout, stderr, exit code, and the `cwd` it actually ran in — read `cwd` before assuming anything about where a command landed, because the default is the CONTAINER\'s working directory (often the mounted workspace, sometimes not), not the workspace root you may have had in mind. Pass `cwd` to be explicit; it is resolved inside the container and the response echoes what was used. Use for `openclaw ...` and other in-container commands. No TTY is allocated — interactive commands hang or fail, so use the non-interactive alternatives from `agent_commands`. Optional `stdin` is written verbatim to the process stdin and is the ONLY safe channel for secrets (API keys, tokens) — it is never echoed back or logged.',
      inputSchema: {
        name: z.string().describe('PAD name'),
        command: z.string().describe('Shell command to run inside the PAD'),
        cwd: z.string().optional().describe('Directory to run in, INSIDE the container (e.g. the workspace mount /www1). Defaults to the container working directory.'),
        stdin: z.string().optional().describe('Optional text written verbatim to the command\'s stdin (secrets only — never place a secret in `command`)'),
        timeout: z.number().int().min(1000).max(600000).optional().describe('Timeout in ms (default 30000)'),
      },
    },
    async ({ name, command, cwd, stdin, timeout }) => {
      const agent = await requirePad('exec', name);
      const containers = registry.dockerPsList();
      if ((containers[agent.runtime_ref] || '').toString().toLowerCase() !== 'running') {
        throw new McpError(ErrorCode.InvalidRequest, `Container is not running: ${agent.name}`);
      }
      // The cwd is applied by prefixing `cd`, so an invalid directory fails
      // loudly instead of silently running somewhere else. This matters: a
      // forgotten `cd` used to be a *plausible, wrong, successful* listing.
      const runIn = cwd ? `cd ${shellQuote(cwd)} && { ${command}\n}` : command;
      const r = await dockerExec(agent.runtime_ref, runIn, timeout || 30000, stdin);
      // Report where it ACTUALLY ran, not where we asked. The probe must carry
      // the SAME `cd`, or it reports the container's own default while the
      // command ran somewhere else — the exact confusion this field exists to
      // remove, reintroduced one line below.
      const probe = await dockerExec(agent.runtime_ref, cwd ? `cd ${shellQuote(cwd)} && pwd` : 'pwd', 10000, null);
      return textResult({
        name: agent.name,
        cwd: String(probe.stdout || '').trim(),
        requestedCwd: cwd || null,
        exitCode: r.code === undefined ? 0 : r.code,
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }
  );

  // ─── Task queue (plan 47) — HIDDEN, not removed ──────────────────────────
  // The 8 task_* tools are unregistered from the MCP surface (user decision
  // 2026-09-29): Mission sessions + plans are the workflow, the headless queue
  // only caused conflicts. The service underneath (task-runner.js, its tables,
  // grants, requireTaskGrant) stays intact, so re-enabling is one flag.
  // Set PADDOCK_TASK_QUEUE=1 to bring the tools back.
  if (process.env.PADDOCK_TASK_QUEUE === '1') {

  registerToolBound(
    'task_submit',
    {
      title: 'Submit a task to an opencode PAD (or the shared pool)',
      description: 'Push: runs `opencode run` inside the named opencode PAD in the background and returns a task_id immediately — poll with task_status, fetch with task_result, stop with task_cancel. The task runs in THAT PAD\'s effective workspace (its custom mount when it has one, never a driver default the PAD does not have) and auto-approves permissions that are not explicitly denied (pass autoApprove:false to refuse that). Pull: omit `name` to file the task in the shared pool at `priority`; combine `name` with enqueue:true to address a task to one PAD without starting it yet. A worker PAD then claims it with task_get_next. Never pick an agent with an @mention in the prompt — headless runs silently fall through to the primary agent; use `agent` instead. TIMEOUT: capped at 1 hour (default 10 minutes); on expiry the task is marked `error` with `timedOut: true` and the process is killed, which is how you tell a timeout from a crash without reading stderr. For genuinely long work, file a short task that re-files itself and exits.',
      inputSchema: {
        name: z.string().optional().describe('PAD to run the task on (opencode only). Omit to add it to the unassigned pool. This is the PAD the task RUNS IN — the opposite of task_get_next\'s `worker`, which is the PAD doing the claiming.'),
        prompt: z.string().describe('Task instructions for the agent'),
        model: z.string().optional().describe('provider/model override, e.g. anthropic/claude-sonnet-4-5'),
        agent: z.string().optional().describe('OpenCode agent to run as (--agent). Use this, never an @mention.'),
        enqueue: z.boolean().optional().describe('File addressed to `name` without starting it — it stays pending for task_get_next'),
        priority: z.number().int().optional().describe('Queue rank for pool tasks — lower numbers are served first (default 0)'),
        timeout: z.number().int().min(1000).max(3600000).optional().describe('Kill the task after this many ms (default 600000, max 3600000)'),
        autoApprove: z.boolean().optional().describe('Auto-approve permissions not explicitly denied (default true) — same trust level as exec'),
      },
    },
    async (args) => {
      const user = currentUser();
      const pad = args.name || '';
      let target;
      if (pad) {
        requireTool(user, 'task_submit', pad);
        // Resolve before submitting: the gate proved the RESOLVED pad is
        // permitted, so the task must be addressed to that one. Passing the
        // raw string onward would check one name and file against another.
        target = await requireAgent(pad);
      } else if (user && !toolAllowed(user, 'task_submit', '')) {
        throw new McpError(ErrorCode.InvalidRequest, 'Not permitted by API key tool grant: task_submit');
      }
      const id = await taskErrorAsync(() => taskRunner.submitTask({
        name: target ? target.name : undefined,
        prompt: args.prompt,
        model: args.model,
        agent: args.agent,
        enqueue: args.enqueue === true,
        priority: args.priority,
        timeout: args.timeout,
        autoApprove: args.autoApprove !== false,
        user,
      }));
      const task = taskRunner.getTask(id);
      // A pool task does not start itself (plan 63 1d). `ok: true` used to read
      // as "a worker will pick this up" with no way to check, so the filing
      // response now carries the queue it landed in. `recentClaimers` is the
      // honest version of "will anyone run this": empty means no PAD has claimed
      // work in the window, and nothing will start this until one does.
      //
      // `mode` is read off the row's OWN `route` rather than recomputed from
      // whether a name was passed. Those are not the same question: an addressed
      // `enqueue: true` submit has a name and does not start, and a top-level
      // `mode: "push"` there would be a second, contradicting answer to the one
      // `task.route` already gives correctly.
      const route = taskRunner.taskRoute(task);
      const out = { ok: true, task_id: id, mode: route, task: taskRow(task) };
      if (!pad) {
        out.queue = {
          ...taskRunner.queueState(),
          position: taskRunner.queuePosition(id),
          for: 'any worker (task_get_next)',
        };
        out.note = 'Filed to the shared pool. Nothing runs until a worker PAD calls task_get_next — a pool task is inert on its own.';
      } else if (route === 'enqueued') {
        out.note = `Filed to ${target.name} for a worker to claim with task_get_next — enqueue was set, so it did not start on the PAD.`;
      }
      return textResult(out);
    }
  );

  registerToolBound(
    'task_get_next',
    {
      title: 'Claim the next queued task for a PAD',
      description: 'Pull: atomically claim the next pending task for this worker — either addressed to it or sitting in the shared pool, lowest `priority` first, ties oldest-first — and return it. The worker then does the work itself and reports with task_complete (passing the same `worker` name). Returns { task: null, queueEmpty: true } when there is nothing to do. This MUTATES state (the task becomes `running`), so it is not a way to look at the queue: use task_list, which reports `nextUp` without claiming anything. A read-only key cannot use this tool.',
      inputSchema: {
        // Optional in the schema on purpose: if `worker` were required, the SDK's
        // own validation would reject a caller who passed `name` with "expected
        // string, received undefined at worker" — true, and it teaches nothing.
        // The handler below refuses with the sentence that says what the two
        // spellings MEAN, which is the whole point of the rename.
        worker: z.string().optional().describe('The PAD claiming the work — the worker doing the task itself. Required. (NOT `name`: on task_submit, `name` is the PAD a task runs IN.)'),
        name: z.string().optional().describe('REMOVED — this tool takes `worker`. Passing `name` here is an error, not an alias.'),
      },
    },
    async ({ worker, name }) => {
      if (name !== undefined) {
        throw new McpError(ErrorCode.InvalidRequest,
          'task_get_next takes `worker` (the PAD doing the claiming), not `name` — on task_submit, `name` is the PAD a task runs IN. Retry with {worker: "<pad>"}.');
      }
      if (!worker) {
        throw new McpError(ErrorCode.InvalidRequest, 'task_get_next requires `worker` — the PAD that will do the work.');
      }
      const agent = await requirePad('task_get_next', worker);
      const task = taskError(() => taskRunner.claimNextTask(agent.name));
      return textResult(task ? { task: taskRow(task) } : { task: null, queueEmpty: true });
    }
  );

  registerToolBound(
    'task_complete',
    {
      title: 'Report a claimed task finished',
      description: 'Pull: close out a task THIS worker claimed. `done` stores your summary as the task result; `failed` records the failure. Only a `running` task can be completed, and only by the PAD named in `worker` — a task nobody claimed is refused too, so "done" always means a worker actually did the work. Use task_retry to re-file a task that failed.',
      inputSchema: {
        task_id: z.string().describe('Task id from task_get_next or task_submit'),
        worker: z.string().describe('The PAD that claimed this task (must match its `claimed_by`)'),
        status: z.enum(['done', 'failed']).optional().describe('done (default) or failed'),
        summary: z.string().optional().describe('What was done, or why it failed'),
      },
    },
    async ({ task_id, worker, status, summary }) => {
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(currentUser(), 'task_complete', task);
      if (!worker) {
        throw new McpError(ErrorCode.InvalidRequest,
          'task_complete requires `worker` — the PAD that claimed this task. Reporting a completion without naming the claimer would let any worker close out anybody else\'s work.');
      }
      // Resolve the worker through the same name resolver as every other tool, so
      // the pad that claimed under one spelling is recognised under the other
      // two and the check cannot be dodged by re-spelling.
      const agent = await requirePad('task_complete', worker);
      const done = taskError(() => taskRunner.completeTask(task_id, {
        status: status || 'done',
        summary: summary || '',
        worker: agent ? agent.name : null,
      }));
      return textResult({ task: taskRow(done) });
    }
  );

  registerToolBound(
    'task_retry',
    {
      title: 'Re-file a finished task',
      description: 'Re-file the prompt of a task that has finished as a new task, keeping its target PAD, priority and timeout. The old row is left as it ended and gains `supersededBy`, and the new row carries an incremented `attempt` — so a task that failed three times reads as one chain of three attempts rather than three unrelated rows. The replacement is always a CLAIMABLE task (`route: "enqueued"`), even when the original was a push: a retry is a re-file, not a run, so it never silently starts work. Claim it with task_get_next. Only a finished task can be retried; a pending or running one is refused.',
      inputSchema: {
        task_id: z.string().describe('Task id that finished (error, cancelled or done)'),
      },
    },
    async ({ task_id }) => {
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(currentUser(), 'task_retry', task);
      const { task: fresh, superseded } = taskError(() => taskRunner.retryTask(task_id));
      return textResult({ ok: true, task_id: fresh.id, task: taskRow(fresh), superseded: taskRow(superseded) });
    }
  );

  registerToolBound(
    'task_priority',
    {
      title: 'Re-rank a queued task',
      description: 'Re-order the queue: task_get_next serves lower numbers first. Only a `pending` task can be re-ranked.',
      inputSchema: {
        task_id: z.string().describe('Task id'),
        rank: z.number().int().describe('New priority — lower is earlier in the queue'),
      },
    },
    async ({ task_id, rank }) => {
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(currentUser(), 'task_priority', task);
      return textResult({ task: taskRow(taskError(() => taskRunner.setPriority(task_id, rank))) });
    }
  );

  registerToolBound(
    'task_status',
    {
      title: 'Task status',
      description: 'Read a task\'s state: pending | running | done | error | cancelled, with the claimer, priority, timing, an optional tail of its output, and the three fields that settle how it went: `outcome` (ok / failed / unknown — unknown covers anything unfinished or cancelled), `timedOut` (it hit its timeout rather than crashing), and `exit_code` (only ever set for a task that ran a real process; a pull worker reports its own result and has no exit code, which is why `outcome` exists). `last_output_at` is a heartbeat: it moves only while new bytes are arriving, so a task that is alive but stuck reads as stale. `created_by` says who filed it (`key:<id>` over MCP, `user:<id>` from the web UI, `mcp` when unknown).',
      inputSchema: {
        task_id: z.string().describe('Task id'),
        tail: z.number().int().min(1).max(20000).optional().describe('Return the last N characters of captured stdout'),
      },
    },
    async ({ task_id, tail }) => {
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(currentUser(), 'task_status', task);
      const out = taskRow(task, { full: true });
      if (tail) out.stdout_tail = taskRunner.stripAnsi(task.stdout).slice(-tail);
      return textResult(out);
    }
  );

  registerToolBound(
    'task_result',
    {
      title: 'Task result',
      description: 'Full result of a task: the extracted assistant text, exit code, outcome, and the captured stdout/stderr (byte-capped, ANSI colour codes stripped — the agent colours its own logs and the escapes are noise in a result).',
      inputSchema: {
        task_id: z.string().describe('Task id'),
      },
    },
    async ({ task_id }) => {
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(currentUser(), 'task_result', task);
      return textResult({
        id: task.id,
        status: task.status,
        outcome: taskRunner.taskOutcome(task),
        timedOut: !!task.timed_out,
        exit_code: task.exit_code,
        result: task.result_summary,
        stdout: taskRunner.stripAnsi(task.stdout),
        stderr: taskRunner.stripAnsi(task.stderr),
        finished_at: task.finished_at,
      });
    }
  );

  registerToolBound(
    'task_list',
    {
      title: 'List tasks',
      description: 'List tasks in SERVICE order: pending tasks first, lowest `priority` first (that is the order task_get_next serves them), then finished tasks newest-first. `nextUp` names the task task_get_next would hand out next WITHOUT claiming it, so this stays a read — the queue is answerable without mutating anything. Filter with `name` (one PAD: tasks addressed to it or claimed by it) and `status`; `total` counts every matching row and `truncated` says whether the limit hid any, so an empty list and an exhausted queue are not the same answer. Each row carries `route` (push = the PAD runs it itself, enqueued = filed to that PAD for a worker to claim, pull = a worker does it itself) and `outcome`. Rows are scoped to what your key may see; unclaimed pool tasks are shared.',
      inputSchema: {
        name: z.string().optional().describe('Only tasks for this PAD (addressed to or claimed by it). This is the PAD to filter BY, not the worker claiming — task_get_next uses `worker` for that.'),
        status: z.enum(['pending', 'running', 'done', 'error', 'cancelled']).optional().describe('Only tasks in this state. `status: "pending"` with `total` answers "is the queue complete?" in one read.'),
        limit: z.number().int().min(1).max(200).optional().describe('How many to return (default 50)'),
      },
    },
    async ({ name, status, limit }) => {
      const user = currentUser();
      let pad = null;
      if (name) {
        requireTool(user, 'task_list', name);
        pad = (await requireAgent(name)).name;
      }
      // Count over the rows the caller may SEE, after the filter and before the
      // slice. `countTasks` is unscoped, so using it here made `total` and
      // `truncated` two answers to a question about a different set than the one
      // in `tasks`: a key that could not see four rows was told the list was
      // truncated, and a short visible list read as "that is everything" when the
      // real total was larger. Same trap as the network-filter cap in
      // settings_get — a filter that runs after the cap is not a filter.
      const CEILING = 1000;
      const all = taskRunner.listTasks({ pad, status, limit: CEILING });
      const visible = pad
        ? all
        : all.filter((t) => {
          const owner = t.claimed_by || t.agent_name || '';
          return !owner || (canAccess(user, owner) && targetAllowed(user, owner));
        });
      // nextUp is computed by the same selector the claim uses, so the preview
      // cannot name a task the claim would then skip.
      const up = taskRunner.nextUpTask(pad);
      const out = {
        tasks: visible.slice(0, limit).map((t) => taskRow(t)),
        total: visible.length,
        truncated: visible.length > limit,
        nextUp: up ? { task_id: up.id, priority: up.priority, for: pad || 'any worker (task_get_next)' } : null,
        order: 'pending first by priority asc, then finished newest-first',
      };
      if (all.length >= CEILING) {
        out.fetch_capped = CEILING;
        out.note = `Read stopped at ${CEILING} matching rows, so \`total\` is a floor, not a count. Narrow with \`name\` or \`status\`.`;
      }
      return textResult(out);
    }
  );

  registerToolBound(
    'task_cancel',
    {
      title: 'Cancel a task',
      description: 'Stop a pending or running task: signals the process (SIGTERM, then SIGKILL after a grace period) and marks the task `cancelled`. Requires confirm: true. A cancel is distinguishable from a timeout — `timedOut` is false here — so the two causes never read the same.',
      inputSchema: {
        task_id: z.string().describe('Task id'),
        confirm: z.boolean().describe('Must be true to cancel'),
      },
    },
    async ({ task_id, confirm }) => {
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(currentUser(), 'task_cancel', task);
      if (confirm !== true) {
        throw new McpError(ErrorCode.InvalidRequest, 'Refusing to cancel without confirm: true.');
      }
      return textResult({ task: taskRow(taskError(() => taskRunner.cancelTask(task_id))) });
    }
  );

  } // end PADDOCK_TASK_QUEUE gate — service below stays loaded

  // ─── Mission (plan 55) ───────────────────────────────────────────────────
  // A project is (PAD, folder); a session is the only unit of work — a live TUI
  // in that folder that the human and the agent both type into and both watch.
  // Only the three coding drivers have Mission projects (opencode, codex,
  // claude), enforced in the service so this surface cannot walk around it.

  registerToolBound(
    'mission_projects',
    {
      title: 'List Mission projects',
      description: "The Mission page's projects: each is a (PAD, folder) pair, with its sessions and how many are live. Only the coding agents (opencode, codex, claude) have projects — a personal agent (openclaw, picoclaw, hermes) cannot. Scoped to what your key may see, so a project on someone else's PAD is simply absent. **These counts are LIVENESS, not progress**: `sessionCount` is how many sessions the project ever had, `liveCount` how many hold a pane, `openCount` how many hold a live TUI. A session that did 400 tool calls and one that opened and died look identical here — for what a project is actually WORKING ON, see the plans facility (plan_list / plan_activity). Filter with `agent` (one PAD), `project_id`, `name` or `folder`; a name or folder that matches zero or several is reported with the candidates rather than returning the whole list, and a project also carries `agentStatus` so you can see whether its pad is running without a second tool. Each session also carries `busy` / `busyKnown` / `open` / `kind`, so you can tell \"the human is typing right now\" from \"here but idle\" from \"a dead pane\" from \"a live shell\" without opening the session — but read `mission_sessions` for the rows themselves: they are opt-in here via `include_sessions`.",
      inputSchema: {
        agent: z.string().optional().describe('Only this PAD\'s projects'),
        project_id: z.string().optional().describe('Exactly this project (from a previous call)'),
        name: z.string().optional().describe('One project by its Mission name (e.g. "paddock") — refused with the candidates if it matches zero or several'),
        folder: z.string().optional().describe('One project by its folder inside the PAD (e.g. "/www2/paddock") — a project\'s name is NOT its folder, so this is usually what a caller holding a directory has'),
        include_sessions: z.boolean().optional().describe('Also inline each session (default false — use mission_sessions)'),
      },
    },
    async ({ agent, project_id, name, folder, include_sessions }) => {
      const user = currentUser();
      if (agent) requireTool(user, 'mission_projects', agent);
      const projects = missionCallSync(() =>
        mission.listProjects({ agent: agent || '', agents: missionVisibleAgents(user) })
      );
      // Never fail the list on liveness: fall back to un-stamped rows. The busy
      // pass is the page's own second step (`withAgentBusyProjects`) — it is what
      // turns "live" into "the human is mid-turn", and it is cached per
      // (PAD, folder), so it costs one probe per project, not per row.
      const live = (await missionWithLive(() => mission.withLive(projects))) || projects;
      const marked = (await missionWithLive(() => mission.withAgentBusyProjects(live))) || live;
      const selected = missionSelectProjects(marked, { projectId: project_id || '', name: name || '', folder: folder || '' });
      const rows = selected.map((p) => missionProjectRow(p, { includeSessions: !!include_sessions }));
      return textResult({
        projects: rows,
        total: rows.length,
        ...(name || folder || project_id ? { matched: rows.length } : {}),
        ...(include_sessions ? {} : { hint: 'Sessions omitted — pass include_sessions: true, or read mission_sessions {project_id}.' }),
        supportedAgentTypes: mission.supportedTypes(),
      });
    }
  );

  registerToolBound(
    'mission_sessions',
    {
      title: 'List Mission sessions — or read one session\'s screen',
      description: "A session IS the unit of work on the Mission page: a live agent TUI in a project's folder, typed into by the human and by you. List mode (no `session_id`) returns every session your key can see, with its project, agent, folder and live/dead state — filter with `project_id` / `agent`. Detail mode (`session_id`) returns that session's metadata, its pane state, and the tail of what its TUI is showing RIGHT NOW, so you can see what the human is doing without them narrating it. Read `mission_sessions` before typing into a session you did not start; a session with `locked: true` is the human's deliberate \"driving alone\" switch.\n\n**LIVENESS, and the three fields are not interchangeable.** `live` = we hold a tmux pane. `busy` = a turn is streaming RIGHT NOW, and it requires `live` (a dead row is never busy; if a dead row carries `wasBusy: true` the conversation is still working somewhere you cannot reach). `open` = a LIVE TUI is attached to the conversation — never a dead row, never a bare shell. It is NOT the send verdict: a solo-locked row and a permission-parked row are both still `open` (the human may be driving them). Ask `canSend` in detail mode, which is the same check the write path applies. `busyKnown: false` means the probe COULD NOT ANSWER, which is not the same as idle, so never treat it as licence to type. `state: \"dead\"` is a corpse. Each row also carries `kind`: `\"agent\"` means a TUI is in the pane, `\"shell\"` means a send would run SHELL COMMANDS (mission_send refuses it) — check this before typing.\n\nDetail mode reports `blockedOn: \"permission\"` (with the tool and path) when the pane is parked on a permission dialog: that session is blocked, NOT idle, and `mission_send` refuses it — answer it with `mission_permission_answer`.",
      inputSchema: {
        session_id: z.string().optional().describe('One session in full — metadata + pane state + screen tail'),
        project_id: z.string().optional().describe('Only this project\'s sessions'),
        agent: z.string().optional().describe('Only sessions on this PAD'),
        lines: z.number().int().min(1).max(200).optional().describe('Screen tail length in detail mode (default 40, max 200)'),
        limit: z.number().int().min(1).max(200).optional().describe('List mode: how many sessions to return, newest first (default 50, max 200)'),
      },
    },
    async ({ session_id, project_id, agent, lines, limit }) => {
      const user = currentUser();

      // Detail mode — one session, with its screen. The row is stamped by
      // `mission.screen` itself (plan 62 1d): it already probes the pane, so
      // running a second decoration pass here would either duplicate the probe
      // or — because the raw row has no `live` — stamp every session as a
      // corpse. The list/detail parity rule is satisfied by the STORE owning
      // the truth, not by both call sites remembering to decorate.
      if (session_id) {
        const { session, project } = missionRequireSession(user, 'mission_sessions', session_id);
        const r = await missionCall(() => mission.screen(session.id, lines || 40));
        return textResult({
          session: missionSessionRow(r.session, project),
          state: r.state,
          live: r.live,
          screen: r.screen,
          ...(r.blockedOn ? { blockedOn: r.blockedOn, permission: r.permission } : {}),
          // The detail view carries what a send would do, before anyone sends —
          // and it is the STORE's verdict (the same function the write path
          // gates on), never `open` re-derived here. Deriving it from `open`
          // promised `canSend: true` for a locked row and for a pane parked on
          // a permission dialog, both of which the write then refused.
          canSend: r.canSend === true,
          ...(r.canSend === true ? {} : { sendRefusal: r.refusal }),
          hint: r.live
            ? undefined
            : 'The tmux session is gone — the human can restart it on the Mission page, or a session can be started again with mission_session_start.',
        });
      }

      // List mode. `agent` gets an explicit gate (a clear refusal beats a
      // silently empty list); the store filter does the per-row owner scoping.
      if (agent) requireTool(user, 'mission_sessions', agent);
      const scoped = missionVisibleAgents(user);
      const byId = new Map();
      let sessions;
      let projects;
      if (project_id) {
        const project = missionRequireProject(user, 'mission_sessions', project_id);
        byId.set(project.id, project);
        sessions = missionCallSync(() => mission.listSessions({ projectId: project.id }));
      } else {
        const all = missionCallSync(() => mission.listAllSessions({ allow: (n) => missionMaySee(user, n) }));
        for (const p of all.projects) byId.set(p.id, p);
        sessions = all.sessions.filter((s) => {
          const name = s.project?.agent_name;
          if (agent && name !== agent) return false;
          return true;
        });
        projects = all.projects.filter((p) => (!agent || p.agent_name === agent) && missionMaySee(user, p.agent_name));
      }

      const live = (await missionWithLive(() =>
        project_id
          ? mission.withLiveSessions(sessions, byId.get(project_id).agent_name)
          : mission.withLiveSessionsByAgent(sessions, (s) => s.project?.agent_name)
      )) || sessions;
      // Same second step the REST route takes: stamp busy/open so the LLM can
      // see that the human is mid-turn before it types. Grouped and cached per
      // (PAD, folder) by the store; a failure here costs the stamp, not the list.
      const marked = (await missionWithLive(() =>
        mission.withAgentBusy(
          live,
          (s) => byId.get(s.project_id)?.agent_name,
          (s) => byId.get(s.project_id)?.folder
        )
      )) || live;
      const capped = marked.slice(0, limit || 50);
      return textResult({
        sessions: capped.map((s) => missionSessionRow(s, byId.get(s.project_id))),
        total: marked.length,
        truncated: marked.length > capped.length,
        projects: projects || undefined,
        hint: capped.length
          ? undefined
          : 'No sessions yet — open one with mission_session_start on a project (from mission_projects).',
      });
    }
  );

  registerToolBound(
    'mission_project_create',
    {
      title: 'Create a Mission project',
      description: "Create a Mission project — a (PAD, folder) pair — on a coding agent your key owns, the LLM-side twin of the page's \"+ New project\" dialog. Row only: no container, no tmux session, no shell. A folder you pass must be an absolute path that exists INSIDE the PAD (it is probed there, and refused otherwise); omit it to use that agent type's default workspace. The project appears in the Mission page's first column immediately. Not for openclaw / picoclaw / hermes — they do not support Mission.",
      inputSchema: {
        name: z.string().describe('Project name (shown in the Mission page)'),
        agent: z.string().describe('PAD name — must be an opencode, codex or claude agent you own'),
        folder: z.string().optional().describe('Absolute container path (default: that agent type\'s workspace dir)'),
      },
    },
    async ({ name, agent, folder }) => {
      const user = currentUser();
      // Gate BEFORE the probe: the probe is a container command on that PAD.
      requireTool(user, 'mission_project_create', agent);

      // Probe a PASSED folder inside the PAD before writing the row — a host path
      // that is not mounted in the container looks perfectly valid from here and
      // would only fail later, at session start. projectFolders resolves the
      // agent itself, so a mistyped PAD name is mission_agent_not_found rather
      // than a type complaint. With no folder the store picks the driver default
      // (what the page's dialog does), so there is nothing to probe.
      let dir = '';
      if (folder) {
        dir = missionCallSync(() => mission.normalizeFolder(folder));
        const probe = await missionCall(() => mission.projectFolders(agent, dir));
        if (!probe.exists || !probe.isDir) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `mission_folder_missing: ${dir} does not exist as a directory inside ${agent}` +
              (probe.entries.length ? ` — nearby: ${probe.entries.slice(0, 8).map((e) => e.name).join(', ')}` : '')
          );
        }
      }

      const project = missionCallSync(() =>
        mission.createProject({ name, agent, folder: dir, createdBy: (user && user.userId) || null })
      );
      return textResult({ project: missionProjectRow({ ...project, sessions: [], sessionCount: 0, liveCount: 0 }) });    }
  );

  registerToolBound(
    'mission_session_start',
    {
      title: 'Open a Mission session (start an agent TUI)',
      description: "Start a session in a Mission project: a fresh `msn-*` tmux session created ROOTED AT THE PROJECT FOLDER, with the agent's own TUI launched into it. This is the server path behind the page's \"+ New session\" — the TUI is launched on purpose, because a session is only useful when the human can watch it. The row is stamped `origin='agent'`, so the page badges it \"started by agent\". Refuses when the PAD is stopped (409 `mission_agent_stopped`) or the folder has vanished inside it (`mission_folder_missing`) — start the PAD or fix the project. Pass `agent_session_id` (from a session's history) to resume that conversation instead of starting a fresh one.",
      inputSchema: {
        project_id: z.string().describe('Project id from mission_projects'),
        label: z.string().optional().describe('Label shown on the session row (default: none)'),
        agent_session_id: z.string().optional().describe("Resume this conversation id from the agent's own history instead of starting fresh"),
      },
    },
    async ({ project_id, label, agent_session_id }) => {
      const user = currentUser();
      const project = missionRequireProject(user, 'mission_session_start', project_id);
      // The key id is recorded on the row, so "did I start this?" and "was that
      // really an agent?" stay answerable after the fact instead of resting on
      // the caller's own memory (plan 67, 67.3).
      const createdBy = user && user.keyId ? `key:${user.keyId}` : null;
      const r = await missionCall(() =>
        mission.startSession(project.id, {
          label: label || '',
          origin: 'agent',
          agentSessionId: agent_session_id || '',
          createdBy,
        })
      );
      return textResult({
        session: missionSessionRow({ ...r.session, live: r.state ? r.state.live : null }, project),
        state: r.state,
        project: { id: project.id, name: project.name, folder: project.folder, agent: project.agent_name },
        createdBy,
        // The pane's folder is the thing that silently goes wrong (tmux starts
        // in the parent when -c is given a missing dir), so it is reported, not
        // left for the caller to discover.
        startedInFolder: r.state ? r.state.cwd : null,
        expectedFolder: project.folder,
        inExpectedFolder: !!(r.state && r.state.cwd && r.state.cwd === project.folder),
      });
    }
  );

  registerToolBound(
    'mission_send',
    {
      title: 'Type into a live Mission session',
      description: "Type a line into a session's live TUI — your way of working IN a session that already exists, side by side with the human. The session must be live AND running an agent; a solo-locked session (`locked: true`, the human's \"drive alone\" switch) is refused with `mission_session_locked`, a pane running a shell is refused with `mission_not_an_agent` (a send there would run your text as shell commands), and a pane parked on a permission dialog is refused with `mission_permission_pending` (answer it with mission_permission_answer). In every one of those cases NOTHING is typed — do not retry, use another session, relaunch, or ask. Read `mission_sessions` first when you did not start the session: you are typing into the human's conversation. Multi-line text is typed as separate lines; each line is submitted. The response echoes the project and session and returns the pane's screen, so you can see the text actually landed.",
      inputSchema: {
        session_id: z.string().describe('Session id from mission_sessions'),
        text: z.string().describe('Text to type into the TUI (submitted with Enter)'),
      },
    },
    async ({ session_id, text }) => {
      const user = currentUser();
      const { session, project } = missionRequireSession(user, 'mission_send', session_id);
      // mission.sendText is the ONE writer path (human or agent), so this is
      // also the one place the solo lock is enforced.
      const r = await missionCall(() => mission.sendText(session.id, text));
      return textResult({
        ok: true,
        sent: r.sent,
        // Echo where the text went (plan 62 1i): an operator-set `label` is
        // often empty or stale, and a write that does not say which project it
        // landed in cannot be checked afterwards.
        project: r.project,
        session_id: r.session_id,
        session: missionSessionRow(r.session, project),
        // The pane's screen after the write, so "the TUI took it" is visible
        // rather than asserted (1h).
        screen: r.screen,
        hint: 'The text was typed into the TUI. Read it back with mission_sessions {session_id} to see the answer.',
      });
    }
  );

  registerToolBound(
    'mission_permission_answer',
    {
      title: 'Answer a permission prompt blocking a Mission session',
      description: "A live session parked on an agent permission dialog (`△ Permission required` — a tool call waiting for a human) is BLOCKED, not idle: mission_send refuses it with `mission_permission_pending`, and the text you would send would land in the dialog and press its confirm key. This tool answers the dialog explicitly. `choice: \"once\"` selects the FIRST option (`Allow once`) and confirms; `choice: \"reject\"` selects the LAST (`Reject`) and confirms. `choice: \"always\"` is REFUSED with `mission_permission_refused` — \"Allow always\" is a durable policy change to a machine's permissions, which is the human's decision, not yours. Read the dialog's tool and path first (`mission_sessions {session_id}` reports `blockedOn: \"permission\"` with them) and prefer `reject` if you did not expect that call.",
      inputSchema: {
        session_id: z.string().describe('Session id from mission_sessions — the one showing the permission dialog'),
        choice: z.enum(['once', 'reject']).describe('\"once\" allows this single call, \"reject\" refuses it. \"always\" is not available to an agent caller.'),
      },
    },
    async ({ session_id, choice }) => {
      const user = currentUser();
      const { session, project } = missionRequireSession(user, 'mission_permission_answer', session_id);
      const r = await missionCall(() => mission.answerPermission(session.id, choice));
      return textResult({
        ok: true,
        choice: r.choice,
        project: r.project,
        session_id: r.session_id,
        session: missionSessionRow(r.session, project),
        stillPending: r.stillPending,
        screen: r.screen,
        hint: r.stillPending
          ? 'The dialog is still on screen — read it with mission_sessions {session_id} before answering again.'
          : 'The prompt is gone. Read the session to see what the agent did next.',
      });
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

// The grant + Mission gate helpers are exported for the same reason the grant
// ones are: they are the policy, and `mcp.test.js` asserts on them directly.
// `mcpContext` is exported so a test can run a tool call under a synthetic
// identity (it is the same store mountMcp fills per request).
module.exports = { mountMcp, authenticateRequest, registerTools, createServer, SERVER_NAME, SERVER_VERSION, keyGrants, targetAllowed, toolAllowed, requireTool, mcpContext, missionVisibleAgents, missionMaySee, missionRequireProject, missionRequireSession, missionFail, publicAgent, resolveAgentName, notFoundMessage, shellQuote, missionSelectProjects };
