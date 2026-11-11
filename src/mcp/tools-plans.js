/**
 * Plan and queue file tools: list, write and read activity for plans; read, write
 * and ensure a queue file.
 */
const { z } = require('zod');
const plans = require('../services/plans');
const agentStore = require('../services/agent-store');
const mission = require('../services/mission');

/** Register this area's tools. `registerToolBound` is mcp.js's error-catching wrapper;
 *  `ctx` carries the helpers mcp.js owns. */
module.exports = function register(registerToolBound, ctx) {
  const {
    resolvePlansScope, currentUser, plansCall, textResult, requirePad, missionActor,
  } = ctx;

  // --- plans (plan 64) ----------------------------------------------------
  // The durable record of a piece of work, kept as a MARKDOWN FILE in the PAD's
  // workspace under `plans/`, plus the live conversation state layered on top by
  // plan_activity. `agent` is REQUIRED on all three: three pads share /www1, so
  // "the workspace" has no single referent across the fleet and guessing one
  // would file somebody's plan in the wrong project.

  registerToolBound(
    'plan_list',
    {
      title: 'List the plans in a PAD or Mission project',
      description: "The plan files for one scope, newest activity first. A plan is a markdown file carrying machine-managed frontmatter (`session`, `created`, `started`, `last_activity`, `done`) and a `## Status:` header — the durable record of a piece of work, readable with `exec cat` when this tool is not there.\n\n**Scope is chosen by what you pass.** With `project_id` or `folder`, the plans live at `<project.folder>/<plans_folder>` INSIDE that Mission project's own directory (the project's `plans_folder`, default `plans`); only opencode/codex/claude have projects. With `agent` alone, you get that PAD's PAD-wide `plans/` folder (legacy mode). An explicit `project_id`/`folder` that matches nothing or several is REFUSED with candidates — it never falls back to the PAD folder. A `path` may be combined with a project scope to read ONE file inside it.\n\nEach row carries `status` (the canonical lifecycle value — `new`, `in progress`, `blocked`, `need clarification`, `done` — or the header verbatim when it matches none; `statusRaw` always keeps the header text) and `session` (the agent conversation it is bound to — pass it to `plan_activity`), plus DERIVED `ageMs` / `idleMs` / `elapsedMs`. `blocked` and `need clarification` are STOP states. A bound plan also carries `sessionTracked` / `sessionLive` / `sessionOpen` / `sessionBusy` / `sessionBusyKnown`. Archived (finished) plans live in `archive/` and are listed with `archive: true`.",
      inputSchema: {
        agent: z.string().optional().describe('PAD name. Required for the PAD-wide folder; when a project is given it must match that project\'s PAD.'),
        project_id: z.string().optional().describe("A Mission project id (from mission_projects); its plans folder is <project.folder>/<plans_folder>. Refused if it matches nothing, or nothing your key can see."),
        folder: z.string().optional().describe("Select a Mission project by its folder (e.g. \"/www2/paddock\"). A folder matching zero or several projects is refused with the candidates — never silently interpreted as the PAD folder."),
        path: z.string().optional().describe('Read ONE plan FILE inside the scope, e.g. "64-plans-facility.md", and get its body. Omit to LIST the whole folder.'),
        archive: z.boolean().optional().describe('List archive/ (finished plans) instead of the working folder (default false)'),
      },
    },
    async ({ agent, project_id, folder, path: relPath, archive }) => {
      const scope = await resolvePlansScope(currentUser(), 'plan_list', { agent, project_id, folder });
      return plansCall(async () => {
        const row = plans.requireAgent(scope.padName);
        const project = scope.project;
        const dir = plans.plansDir(row, { archive: !!archive, project });
        const scopeFields = project
          ? { project_id: project.id, project: project.name, folder: project.folder, plans_folder: project.plans_folder || 'plans' }
          : {};
        // ONE plan named → that plan, with its body. The listing is metadata, and
        // a caller holding a file name wants the file; answering with a one-row
        // list of titles and no way to get the text would send them to
        // `exec cat`, which is the thing this facility exists to replace.
        if (relPath) {
          const one = plans.readPlan(row, relPath, { archive: !!archive, project });
          if (!one) {
            return textResult({
              agent: scope.padName, ...scopeFields, archive: !!archive, path: relPath, found: false, count: 0, plans: [],
              hint: 'No such plan in this folder. plan_list with no path lists what is there.',
            });
          }
          const [stamped] = await plans.withSessionState(row, [one]);
          return textResult({ agent: scope.padName, ...scopeFields, archive: !!archive, found: true, count: 1, plans: [stamped] });
        }
        // In PROJECT mode the directory IS the scope: every file in it belongs to
        // that project, so there is nothing to attribute or drop. The session
        // stamp is still applied (it answers "who is working this"), it just no
        // longer decides which directory a plan is in.
        const stamped = await plans.withSessionState(row, plans.listPlans(row, { archive: !!archive, project }));
        return textResult({
          agent: scope.padName, ...scopeFields, archive: !!archive, plansFolder: dir,
          count: stamped.length, plans: stamped,
        });
      });
    }
  );

  registerToolBound(
    'plan_write',
    {
      title: 'Create or update a plan in a PAD or Mission project',
      description: "Write a plan file into one scope, creating the folder on first use. With `project_id` or `folder` the file lands at `<project.folder>/<plans_folder>` inside that Mission project's directory; with `agent` alone it goes to the PAD-wide `plans/` folder (legacy mode). An explicit project that matches nothing or several is refused with candidates — never a fallback.\n\nThe BODY is yours — this never rewrites your prose — but the frontmatter is machine-managed: `created` is stamped once and never moves, `last_activity` is bumped on every write (that is what makes `plan_list` able to answer \"what is being worked on right now\"), and `started` is stamped the first time you bind a `session`. Pass `session` (the agent's own conversation id — `ses_…` for opencode, the rollout uuid for codex, the `projects/*.jsonl` filename for claude) to bind the plan to a conversation; it is the same id you would resume with, and `plan_activity` takes it. The names `INDEX.md`, `README.md` and `QUEUE.md` are reserved for the folder's own entry files and refused as `path`. Ending a plan is a human decision: move the file to `archive/`, do not just stop writing to it.",
      inputSchema: {
        agent: z.string().optional().describe('PAD name. Required for the PAD-wide folder; when a project is given it must match that project\'s PAD.'),
        project_id: z.string().optional().describe("A Mission project id; write into <project.folder>/<plans_folder>. Refused if it matches nothing, or nothing your key can see."),
        folder: z.string().optional().describe("Select a Mission project by its folder. A folder matching zero or several projects is refused with the candidates — never the PAD folder."),
        path: z.string().describe('Plan file name relative to the plans folder, e.g. "64-plans-facility.md"'),
        content: z.string().describe('Full markdown body of the plan, WITHOUT frontmatter (it is managed for you)'),
        session: z.string().optional().describe('Agent conversation id this plan is worked in'),
      },
    },
    async ({ agent, project_id, folder, path: relPath, content, session }) => {
      const scope = await resolvePlansScope(currentUser(), 'plan_write', { agent, project_id, folder });
      // The callback is async BECAUSE the write is: plan_write goes through the
      // workspace service, so a rejection arrives as a promise. A sync callback
      // here would return a Promise as the tool's RESULT — the caller would get
      // a half-written object instead of a refusal, which is the exact shape
      // of the 3a bug this facility was built on.
      return await plansCall(async () => {
        const row = plans.requireAgent(scope.padName);
        const project = scope.project;
        const body = String(content == null ? '' : content);
        // A caller that pastes the file it just read back must not end up with
        // two frontmatter blocks, so the old one is stripped before the new
        // stamps go on. The body the caller sent wins either way.
        const clean = plans.stripFrontmatter(body);
        const written = await plans.writePlan(row, relPath, clean.startsWith('\n') ? clean.slice(1) : clean, { session: session || null, project });
        return textResult({
          agent: scope.padName, path: written.path,
          ...(project ? { project_id: project.id, project: project.name, folder: project.folder, plans_folder: project.plans_folder || 'plans' } : {}),
          ...written,
        });
      });
    }
  );

  registerToolBound(
    'plan_activity',
    {
      title: 'What a conversation is doing right now',
      description: "The LIVE half of the plans facility: the last chat and its timings for one agent conversation, read from that agent's own store. Returns `lastMessage` as a readable PAIR (`user` and `assistant` text with timestamps), `lastToolCall` with a `status` of `running` / `completed` / `error` — `running` means in flight right now — and `lastActivityAt`. This is the answer to \"what is this session actually doing?\", which a tmux screen tail cannot give (it is a picture, not messages) and cannot give at all once the container is stopped.\n\n**`padRunning` and `store.available` are different questions and must not be conflated.** `padRunning` is the container state; `store.available` is whether the transcript could be read. A STOPPED pad with `available: true` has a complete transcript — that is the whole point of reading the host store — and a running pad with `available: false` means the read failed, which is NOT the same as \"no activity\". Cheap enough to poll one live session at 5 s, and never `docker exec` — but the cost is PER DRIVER, so do not loop this over every id: on **opencode** it is one indexed sqlite query over a handful of rows (~2 ms measured); on **codex** and **claude** it parses that one conversation's rollout file, so the cost grows with the transcript's length. `running` is decided per driver: on opencode it is the tool part's own status, on codex AND claude a call with no result row behind it — a call is written when it is requested and its result in a later record, so an unanswered one is in flight. An unknown `session_id` refuses with `plan_session_unknown` rather than returning an empty success.\n\n**When the store cannot be read, `store.reason` says which way it failed, and they are not interchangeable:** `no-store` (this agent type keeps no transcript this tool reads, or the folder is empty), `empty-store` (the store file exists but has no schema yet — the pad has never run its agent), `unreadable` (the file is there and did not open), `session-not-found` (the store HAS transcripts, none of them this session — `store.candidates` then names the ones it has, because \"not found\" here is never a reason to read someone else's). For the JSONL stores a session is matched by its FILE NAME; when a store holds exactly one file the tool answers from it and says `matched: \"only-file\"`, which is a guess — prefer passing the id the agent's own history printed. \n\n**Redaction boundary, so you know what you are reading:** secret-shaped configuration (any `api_key`/`token`/`password`/`*-key` field, any `headers` map, and config/env lines carrying such a value) is scrubbed wherever it appears, including inside dumped config text. Free PROSE is not pattern-matched, so a key pasted into a sentence comes back as written — do not paste secrets into a conversation you intend to read this way.",
      inputSchema: {
        agent: z.string().describe('PAD name — required'),
        session_id: z.string().describe('Agent conversation id (from a plan\'s `session`, or from mission_sessions)'),
      },
    },
    async ({ agent, session_id }) => {
      const pad = await requirePad('plan_activity', agent);
      return plansCall(() => {
        const row = plans.requireAgent(pad.name);
        const id = String(session_id || '').trim();
        if (!id) {
          throw new plans.PlansError('plan_session_required', 'A session_id is required — the agent conversation id, e.g. "ses_…".');
        }
        const activity = agentStore.readActivity(row, id, { agentRunning: row.status === 'running' });
        if (!activity.store.available && activity.store.reason === 'no-store' && activity.store.detail && /no transcript/.test(activity.store.detail)) {
          throw new plans.PlansError('plan_session_unknown', `No transcript for ${id} on ${pad.name}.`);
        }
        return textResult({ agent: pad.name, ...activity });
      });
    }
  );

  // Queue tools (plan 83) — the plan queue lives in the project's plans folder
  registerToolBound(
    'queue_read',
    {
      title: 'Read a canonical Mission runner queue',
      description: "Read the server-owned queue for one Mission runner. QUEUE.md is only its generated worker projection; it is never the source of truth.",
      inputSchema: {
        runner_id: z.string().describe('Runner id from the Mission runner list'),
        project_id: z.string().optional().describe("A Mission project id (from mission_projects); its queue is at <project.folder>/<plans_folder>/QUEUE.md. Refused if it matches nothing, or nothing your key can see."),
        folder: z.string().optional().describe("Select a Mission project by its folder (e.g. \"/www2/paddock\"). A folder matching zero or several projects is refused with the candidates."),
      },
    },
    async ({ project_id, folder, runner_id }) => {
      const scope = await resolvePlansScope(currentUser(), 'queue_read', { project_id, folder });
      return plansCall(async () => {
        const project = scope.project;
        const runner = mission.getRunner(runner_id);
        if (!runner || runner.project_id !== project.id) throw new plans.PlansError('runner_not_found', `Runner ${runner_id} does not belong to this project.`);
        const detail = await mission.readRunnerQueue(runner.id);
        return textResult({
          agent: scope.padName,
          project_id: project.id,
          project: project.name,
          folder: project.folder,
          plans_folder: project.plans_folder || 'plans',
          runner_id: runner.id,
          queue: detail.queue,
        });
      });
    }
  );

  registerToolBound(
    'queue_write',
    {
      title: 'Add plans to a canonical Mission runner queue',
      description: "Add plan paths to the server-owned queue with revision CAS. The server assigns item IDs and regenerates QUEUE.md; callers cannot write the projection directly.",
      inputSchema: {
        runner_id: z.string().describe('Runner id from the Mission runner list'),
        project_id: z.string().optional().describe("A Mission project id; write into its queue. Refused if it matches nothing, or nothing your key can see."),
        folder: z.string().optional().describe("Select a Mission project by its folder. A folder matching zero or several projects is refused with the candidates."),
        plans: z.array(z.string()).min(1).describe('Plan paths relative to the project plans folder'),
        revision: z.number().int().describe('Revision returned by queue_read'),
      },
    },
    async ({ project_id, folder, runner_id, plans: planPaths, revision }) => {
      const scope = await resolvePlansScope(currentUser(), 'queue_write', { project_id, folder });
      return plansCall(async () => {
        const project = scope.project;
        const runner = mission.getRunner(runner_id);
        if (!runner || runner.project_id !== project.id) throw new plans.PlansError('runner_not_found', `Runner ${runner_id} does not belong to this project.`);
        const detail = await mission.addRunnerQueueItems(runner.id, planPaths, revision, { actor: missionActor(currentUser()) });
        return textResult({
          agent: scope.padName,
          project_id: project.id,
          project: project.name,
          folder: project.folder,
          plans_folder: project.plans_folder || 'plans',
          runner_id: runner.id,
          queue: detail.queue,
        });
      });
    }
  );

  registerToolBound(
    'queue_ensure',
    {
      title: 'Ensure a canonical Mission runner queue exists',
      description: "Create the canonical queue and regenerate its worker projection for one Mission runner.",
      inputSchema: {
        runner_id: z.string().describe('Runner id from the Mission runner list'),
        project_id: z.string().optional().describe("A Mission project id; ensure its queue. Refused if it matches nothing, or nothing your key can see."),
        folder: z.string().optional().describe("Select a Mission project by its folder. A folder matching zero or several projects is refused with the candidates."),
      },
    },
    async ({ project_id, folder, runner_id }) => {
      const scope = await resolvePlansScope(currentUser(), 'queue_ensure', { project_id, folder });
      return plansCall(async () => {
        const project = scope.project;
        const runner = mission.getRunner(runner_id);
        if (!runner || runner.project_id !== project.id) throw new plans.PlansError('runner_not_found', `Runner ${runner_id} does not belong to this project.`);
        const detail = await mission.setupRunnerQueue(runner.id, { actor: missionActor(currentUser()) });
        return textResult({
          agent: scope.padName,
          project_id: project.id,
          project: project.name,
          folder: project.folder,
          plans_folder: project.plans_folder || 'plans',
          runner_id: runner.id,
          queue: detail.queue,
        });
      });
    }
  );
};
