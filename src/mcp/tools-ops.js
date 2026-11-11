/**
 * Job readers (the answer to a timed-out create or recreate), help, the command
 * catalogue and exec.
 */
const jobLog = require('../services/job-log');
const { z } = require('zod');
const { getGuide, listCatalogTypes, getCommandCatalog } = require('../services/llm-guide');
const registry = require('../services/agent-registry');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');

/** Register this area's tools. `registerToolBound` is mcp.js's error-catching wrapper;
 *  `ctx` carries the helpers mcp.js owns. */
module.exports = function register(registerToolBound, ctx) {
  const {
    resolveAgentName, requireTool, currentUser, textResult, notFoundMessage, requirePad,
    shellQuote, dockerExec,
  } = ctx;

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
      description: 'Run a shell command inside a PAD container (docker exec). Returns stdout, stderr, exit code, and the `cwd` it actually ran in — read `cwd` before assuming anything about where a command landed, because the default is the CONTAINER\'s working directory (often the mounted workspace, sometimes not), not the workspace root you may have had in mind. Pass `cwd` to be explicit; it is resolved inside the container and the response echoes what was used. Use for `openclaw ...` and other in-container commands. No TTY is allocated — interactive commands hang or fail, so use the non-interactive alternatives from `agent_commands`. Optional `stdin` is written verbatim to the process stdin and is the ONLY safe channel for secrets (API keys, tokens) — it is never echoed back or logged. In a USER-MODE pad (Settings → Container user = user) this runs as the PAD USER (uid 1000), not root — same as the terminal and Mission TUIs — so the pad\'s HOME stays user-owned and the agent keeps working; root-only commands (apt-get install, editing root-owned files) will fail there. Root-mode pads run as root, unchanged.',
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
};
