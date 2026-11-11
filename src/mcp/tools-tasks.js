/**
 * The task queue tools. Registered only when PADDOCK_TASK_QUEUE=1; absent from
 * the surface otherwise.
 */
const { z } = require('zod');
const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const taskRunner = require('../services/task-runner');
const mission = require('../services/mission');
const taskPipeline = require('../services/task-pipeline');

/** Register this area's tools. `registerToolBound` is mcp.js's error-catching wrapper;
 *  `ctx` carries the helpers mcp.js owns. */
module.exports = function register(registerToolBound, ctx) {
  const {
    currentUser, requireTool, requireAgent, toolAllowed, taskErrorAsync, taskRow, textResult,
    requirePad, taskError, requireTaskGrant, stepRow, canAccess, targetAllowed,
    missionRequireSession, missionCall, missionActor, pipelineCall,
  } = ctx;

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
      description: 'Push: runs `opencode run` inside the named opencode PAD in the background and returns a task_id immediately — poll with task_status, fetch with task_result, stop with task_cancel. The task runs in THAT PAD\'s effective workspace (its custom mount when it has one, never a driver default the PAD does not have) and runs sandboxed by default, stopping on anything needing a decision (pass autoApprove:true to auto-approve instead). Pull: omit `name` to file the task in the shared pool at `priority`; combine `name` with enqueue:true to address a task to one PAD without starting it yet. A worker PAD then claims it with task_get_next. Never pick an agent with an @mention in the prompt — headless runs silently fall through to the primary agent; use `agent` instead. TIMEOUT: capped at 1 hour (default 10 minutes); on expiry the task is marked `error` with `timedOut: true` and the process is killed, which is how you tell a timeout from a crash without reading stderr. For genuinely long work, file a short task that re-files itself and exits.',
      inputSchema: {
        name: z.string().optional().describe('PAD to run the task on (opencode only). Omit to add it to the unassigned pool. This is the PAD the task RUNS IN — the opposite of task_get_next\'s `worker`, which is the PAD doing the claiming.'),
        prompt: z.string().describe('Task instructions for the agent'),
        model: z.string().optional().describe('provider/model override, e.g. anthropic/claude-sonnet-4-5'),
        agent: z.string().optional().describe('OpenCode agent to run as (--agent). Use this, never an @mention.'),
        enqueue: z.boolean().optional().describe('File addressed to `name` without starting it — it stays pending for task_get_next'),
        priority: z.number().int().optional().describe('Queue rank for pool tasks — lower numbers are served first (default 0)'),
        timeout: z.number().int().min(1000).max(3600000).optional().describe('Kill the task after this many ms (default 600000, max 3600000)'),
        autoApprove: z.boolean().optional().describe('Opt in to auto-approving permissions not explicitly denied — i.e. opencode `--auto`, codex `--sandbox danger-full-access` (no sandbox at all). DEFAULT false, so a task runs sandboxed and stops on anything needing a decision; plan 52 R3/A3 flipped this from true because the headless task path runs where the user cannot see it, which law 6 forbids. Pass true only when you have decided the prompt is safe unattended.'),
        session_id: z.string().optional().describe('Bind the task to a Mission session (D2): the task then lives in that session\'s PAD and folder, its steps are gated by that session\'s state (locked/dead/shell/permission-parked refuse), and it is refused if the session is on a different PAD than `name`. Omit for an ordinary headless task — no step tool will resolve a session for it.'),
        reviewer: z.string().optional().describe('Session that REVIEWS this task (D3) — requires `session_id` (the task\'s own session) and must be on the same PAD. The binding row records it as `reviewer:<id>`, and a review step may then be reported from either session.'),
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
        autoApprove: args.autoApprove === true,
        session_id: args.session_id,
        reviewer: args.reviewer,
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
      // The binding (session + reviewer) lives on task_steps, not on `tasks`,
      // so a submit response would otherwise answer nothing about D2/D3 — the
      // caller needs to know which session the steps are now gated by.
      const binding = taskRunner.taskBinding(id);
      if (binding.session_id) out.binding = binding;
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
      // Where is this in the loop (D1) + which session gates its steps (D2/D3).
      // Both live on task_steps, so this stays a read of the sibling table —
      // `tasks` itself is frozen.
      out.current_step = stepRow(taskRunner.getCurrentTaskStep(task_id));
      const binding = taskRunner.taskBinding(task_id);
      if (binding.session_id) out.binding = binding;
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
      // The current step is ONE batched query over the page's tasks, not a read
      // per row — a listing that fans out per row is how a list becomes a probe
      // storm. Rows with no steps (an unbound headless task) simply carry null.
      const page = visible.slice(0, limit);
      const steps = taskRunner.currentStepsFor(page.map((t) => t.id));
      const out = {
        tasks: page.map((t) => {
          const row = taskRow(t);
          const step = steps[t.id];
          if (step) row.current_step = stepRow(step);
          return row;
        }),
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

  // ─── Step tools (plan 69 D2/D4/D6) ───────────────────────────────────────
  // One task = one session-bound loop (D2). Every step write runs the same
  // three checks in this order: the TASK grant, then the SESSION grant + state
  // gates (D2), then the actor-claim (one attempt is one identity's to report).
  // Nothing here reads `tasks` for its lifecycle — that table is frozen, so
  // every fact about where a task is in the loop is a `task_steps` row.

  const STEP_NAMES = ['review', 'build', 'test', 'hotfix', 'commit'];

  /** Which session this step belongs to, and its gates (D2). `session_id` is
   *  explicit when the caller passes one (a reviewer session reporting
   *  `review` — D3); otherwise it is the session task_submit bound the task to.
   *  Both halves are enforced: a caller may not report against a session the
   *  task is not bound to, and the session's own state is then read from tmux
   *  (locked → `task_session_locked`, dead → `mission_session_dead`, a bare
   *  shell → `mission_not_an_agent`, permission-parked →
   *  `mission_permission_pending`). */
  async function stepSession(tool, task, sessionId) {
    const binding = taskRunner.taskBinding(task.id);
    const want = sessionId || binding.session_id;
    if (!want) return { sessionId: null, binding, project: null };
    if (sessionId && binding.session_id
        && sessionId !== binding.session_id && sessionId !== binding.reviewer) {
      throw new McpError(ErrorCode.InvalidRequest,
        `task_session_mismatch: task ${task.id} is bound to session ${binding.session_id}`
        + (binding.reviewer ? ` (reviewer ${binding.reviewer})` : '')
        + ` — ${tool} cannot report a step against ${sessionId}.`);
    }
    const user = currentUser();
    // Grant first (the session's PAD must be one this key may reach), then the
    // tmux state gates — a refusal for "wrong PAD" should never cost a probe.
    const { project } = missionRequireSession(user, tool, want);
    await missionCall(() => mission.assertStepSession(want));
    return { sessionId: want, binding, project };
  }

  /** Actor-claim (D4): an attempt is ONE identity's to report. A second
   *  identity is refused with the holder's name rather than silently
   *  overwriting who said what — an amend that changed `reported_by` would
   *  make the audit trail argue with itself. */
  function claimOrThrow(open, actor) {
    if (open && open.reported_by && open.reported_by !== actor) {
      throw new McpError(ErrorCode.InvalidRequest,
        `task_step_claimed: step '${open.step}' attempt ${open.attempt} of task ${open.task_id}`
        + ` is held by ${open.reported_by} (${actor} is a different identity).`
        + ' One attempt is one actor\'s to report — finish or fail it, or start the NEXT attempt.');
    }
  }

  /** Write one step row: AMEND the attempt already in flight (the binding row
   *  a submit wrote, or a report left pending) so `current_step` stays
   *  unambiguous, otherwise INSERT a new attempt. */
  function writeStep(task, { step, state, status, session_id, notes, artifact, reported_by }) {
    const open = taskRunner.openStepRow(task.id, step);
    claimOrThrow(open, reported_by);
    if (open) {
      const patch = { state, status };
      if (session_id !== undefined && session_id !== null) patch.session_id = session_id;
      if (notes !== undefined) patch.notes = notes;
      if (artifact !== undefined) patch.artifact = artifact;
      if (!open.reported_by) patch.reported_by = reported_by;
      return taskRunner.updateTaskStep(open.id, patch);
    }
    return taskRunner.insertTaskStep({
      task_id: task.id,
      step,
      attempt: taskRunner.nextStepAttempt(task.id, step),
      state,
      status,
      session_id: session_id || null,
      reported_by,
      notes,
      artifact,
    });
  }

  function stepResponse(task, row, binding) {
    return textResult({
      ok: true,
      step: stepRow(row),
      current_step: stepRow(taskRunner.getCurrentTaskStep(task.id)),
      binding,
    });
  }

  registerToolBound(
    'task_step_report',
    {
      title: 'Report a task step',
      description: 'Record where a task is in its loop: one `task_steps` row per step attempt. `state` is where the step IS (pending / running / needs_review / failed / done / aborted); `status` is the verdict (passed / failed / error) — the two are kept apart so "the test is running" and "the test failed" are never the same row. A report AMENDS the attempt already in flight (the binding row task_submit wrote, or a report left pending) and starts a NEW attempt otherwise, so `attempt` counts up across a re-run. Gated by the task\'s session: a locked session refuses with `task_session_locked`, a dead one with `mission_session_dead`, a bare shell with `mission_not_an_agent`, a permission-parked one with `mission_permission_pending`. Actor-claim: an attempt is one identity\'s to report, and a second one is refused with `task_step_claimed` rather than overwriting who said what. Read the derived step back from task_status (`current_step`) or task_list.',
      inputSchema: {
        task_id: z.string().describe('Task id'),
        step: z.enum(STEP_NAMES).describe('Which step of the loop: review | build | test | hotfix | commit'),
        state: z.enum(['pending', 'running', 'needs_review', 'failed', 'done', 'aborted']).describe('Where the step is NOW'),
        status: z.enum(['passed', 'failed', 'error']).optional().describe('The verdict, when the step has one — `state` says where it is, `status` says how it went'),
        session_id: z.string().optional().describe('Session to report against. Defaults to the session task_submit bound the task to; a reviewer session (D3) may report the `review` step'),
        notes: z.string().optional().describe('Human note for this attempt'),
        artifact: z.string().optional().describe('Evidence for the report — an id, a path, a link. NOT the step\'s location: that is `session_id`'),
      },
    },
    async ({ task_id, step, state, status, session_id, notes, artifact }) => {
      const user = currentUser();
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(user, 'task_step_report', task);
      const actor = missionActor(user);
      const s = await stepSession('task_step_report', task, session_id);
      const row = writeStep(task, {
        step,
        state,
        status,
        session_id: s.sessionId,
        notes,
        artifact,
        reported_by: actor,
      });
      return stepResponse(task, row, s.binding);
    }
  );

  registerToolBound(
    'task_step_bug',
    {
      title: 'Record a bug against a task step',
      description: 'A defect found while working a task, filed as an EXTRA row on the same attempt as the step it belongs to (`state: failed`, `status: failed`) so it sits under `current_step` without replacing the step\'s own report. `artifact` carries `{file, line, summary, repro}` as JSON (machine-readable), `notes` carries the one-line summary (human-readable). It does NOT change the task\'s own status — the task\'s outcome is task_complete\'s to set; a bug is evidence, not a verdict on the whole task. Same session gates and actor-claim as task_step_report.',
      inputSchema: {
        task_id: z.string().describe('Task id'),
        step: z.enum(STEP_NAMES).optional().describe('Step the defect belongs to (default `test`)'),
        session_id: z.string().optional().describe('Session to report against — defaults to the task\'s bound session'),
        file: z.string().describe('Where the defect is — a path inside the workspace'),
        line: z.number().int().optional().describe('Line number, when known'),
        summary: z.string().describe('One line: what is wrong'),
        repro: z.string().optional().describe('How to reproduce it'),
      },
    },
    async ({ task_id, step, session_id, file, line, summary, repro }) => {
      const user = currentUser();
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(user, 'task_step_bug', task);
      const actor = missionActor(user);
      const s = await stepSession('task_step_bug', task, session_id);
      const useStep = step || 'test';
      claimOrThrow(taskRunner.openStepRow(task.id, useStep), actor);
      const cur = taskRunner.getCurrentTaskStep(task.id);
      const row = taskRunner.insertTaskStep({
        task_id: task.id,
        step: useStep,
        attempt: cur && cur.step === useStep ? cur.attempt : taskRunner.nextStepAttempt(task.id, useStep),
        state: 'failed',
        status: 'failed',
        session_id: s.sessionId,
        reported_by: actor,
        notes: summary,
        artifact: JSON.stringify({
          file,
          line: line == null ? null : line,
          summary,
          repro: repro || null,
        }),
      });
      return stepResponse(task, row, s.binding);
    }
  );

  registerToolBound(
    'task_step_commit',
    {
      title: "Commit the task's work",
      description: "Runs `git add -A && git commit` INSIDE the task's PAD and records a `commit` step row whose `artifact` is the resulting SHA — the commit is a step of the loop, so it shows up in task_status's `current_step` instead of living only in captured stdout. The folder is the bound session's project folder, or (an unbound task) its own workspace; pass `cwd` to commit somewhere else. Refuses with `task_commit_no_pad` when the task has no PAD (a pool task claims one only when a worker takes it) and returns `ok: false, error: task_commit_nothing` when the tree is clean, because there is then no new SHA to record. Any git failure is recorded as a `failed` step carrying git's output, so a failed commit never claims a SHA it did not make. Same session gates as the other step tools.",
      inputSchema: {
        task_id: z.string().describe('Task id'),
        session_id: z.string().optional().describe('Session whose folder to commit in — defaults to the task\'s bound session'),
        message: z.string().optional().describe('Commit message (default: the task prompt, clipped to 500 chars)'),
        cwd: z.string().optional().describe('Directory to commit (default: the session\'s project folder, else the task workspace). Quoted into `cd`, so a bad path fails loudly instead of committing somewhere else'),
      },
    },
    async ({ task_id, session_id, message, cwd }) => {
      const user = currentUser();
      const task = taskRunner.getTask(task_id);
      requireTaskGrant(user, 'task_step_commit', task);
      const actor = missionActor(user);
      const s = await stepSession('task_step_commit', task, session_id);

      const agentName = (s.project && s.project.agent_name) || task.agent_name || task.claimed_by || '';
      let folder = cwd || (s.project && s.project.folder) || '';
      let agent = null;
      if (agentName) {
        try { agent = await requireAgent(agentName); } catch { agent = null; }
      }
      if (!agent) {
        throw new McpError(ErrorCode.InvalidRequest,
          `task_commit_no_pad: task ${task.id} has no PAD to commit in (a pool task gets one only when a worker claims it).`
          + ' Bind it with task_submit {session_id}, or claim it with task_get_next first.');
      }
      if (!folder) folder = await taskErrorAsync(() => taskRunner.resolveTaskWorkspace(agent));

      const res = await taskRunner.runGitCommit(
        agent.runtime_ref || agent.name,
        folder,
        message || task.prompt || `task ${task.id}`
      );
      const ok = res.code === 0 && !!res.sha;
      const notes = res.clean
        ? 'nothing to commit — the working tree was already clean, so no new SHA exists'
        : res.output.slice(-2000);
      const row = taskRunner.insertTaskStep({
        task_id: task.id,
        step: 'commit',
        attempt: taskRunner.nextStepAttempt(task.id, 'commit'),
        state: ok ? 'done' : 'failed',
        status: ok ? 'passed' : (res.clean ? 'error' : 'failed'),
        session_id: s.sessionId,
        reported_by: actor,
        notes,
        artifact: ok ? res.sha : '',
      });
      const out2 = {
        ok,
        step: stepRow(row),
        current_step: stepRow(taskRunner.getCurrentTaskStep(task.id)),
        binding: s.binding,
        sha: res.sha,
        exit_code: res.code,
        commit_output: res.output.slice(-2000),
      };
      if (res.clean) out2.error = { code: 'task_commit_nothing', message: 'Working tree clean — nothing to commit, so there is no task SHA to record.' };
      else if (!ok) out2.error = { code: 'task_commit_failed', message: `git exited ${res.code} — see commit_output.` };
      return textResult(out2);
    }
  );
  // ─── The pipeline driver (plan 69 P3 / D7) ───────────────────────────────
  // The server-side loop: it drives the bound session through review → build →
  // test (→ hotfix ⇄ test) → commit, writing every stage to task_steps and
  // parking on each of D7's four walls instead of guessing. Resolve-then-gate
  // like every other session tool: the TASK's pad first, then the SESSION's.

  async function pipelineGate(tool, task) {
    requireTaskGrant(currentUser(), tool, task);
    const binding = taskRunner.taskBinding(task.id);
    if (binding.session_id) missionRequireSession(currentUser(), tool, binding.session_id);
    return binding;
  }

  registerToolBound(
    'task_pipeline_start',
    {
      title: "Run a task's whole loop on the server",
      description: 'Hand a SESSION-BOUND task to a server-side driver that advances it through review → build → test (a failed test earns a hotfix, then the test runs again) → commit, sending each step into the bound session and writing every stage to task_steps. Refuses: `task_pipeline_no_session` (bind it with task_submit { session_id }), `task_pipeline_busy` (one active step per task — a newest row already running, or a driver already alive), `task_pipeline_closed` (the task is done/cancelled), and any session gate (locked → `task_session_locked`, dead → `mission_session_dead`, shell → `mission_not_an_agent`, permission-parked → `mission_permission_pending`). FOUR HARD WALLS, each of which parks with a readable reason instead of guessing: it never advances past a step whose report is missing, failed, error or needs_review; a step that overruns the task\'s timeout_ms is stamped failed/error; a dead/locked session or a removed task parks; and task_pipeline_stop lands on the next tick. The driver runs git ITSELF at the commit stage (D6), but every other step advances only on a task_step_report — usually from the agent in that session. The driver lives in MEMORY: a webui restart drops it and task_pipeline_status says so. It does NOT set the task\'s own status — that stays task_complete\'s.',
      inputSchema: {
        task_id: z.string().describe('Task id — must be bound to a Mission session'),
      },
    },
    async ({ task_id }) => pipelineCall(async () => {
      const task = taskRunner.getTask(task_id);
      await pipelineGate('task_pipeline_start', task);
      const rec = await taskPipeline.start(task_id, { actor: missionActor(currentUser()) });
      return textResult({
        ok: true,
        pipeline: taskPipeline.snapshot(rec),
        current_step: stepRow(taskRunner.getCurrentTaskStep(task_id)),
        binding: taskRunner.taskBinding(task_id),
        note: 'The driver is in-memory and waits for reports: watch with task_pipeline_status, stop with task_pipeline_stop, and let the session\'s agent report each step with task_step_report (task_step_bug for defects).',
      });
    })
  );

  registerToolBound(
    'task_pipeline_status',
    {
      title: "Where is a task's server-side loop?",
      description: 'Read the driver (if one is alive), the task\'s derived current_step, its next_step exactly as the driver\'s own planner would pick it, and the FULL task_steps history. `active` distinguishes a live driver from a finished one; when nothing is running the `note` says why (a driver lives in MEMORY, so a webui restart ends it) — it never reads a stale step as a running loop. Pure read: a read-only key may poll it. The steps are the record (plan 69 D1), so `pipeline.reason` / `pipeline.detail` name exactly which wall a parked run hit (timeout, report_failed, needs_review, max_hotfix, mission_session_dead, task_gone, commit_nothing, …).',
      inputSchema: {
        task_id: z.string().describe('Task id'),
      },
    },
    async ({ task_id }) => pipelineCall(async () => {
      const task = taskRunner.getTask(task_id);
      await pipelineGate('task_pipeline_status', task);
      const out = taskPipeline.status(task_id);
      return textResult({
        ok: true,
        active: out.active,
        pipeline: out.pipeline,
        binding: out.binding,
        current_step: out.current_step ? stepRow(out.current_step) : null,
        next_step: out.next_step,
        steps: out.steps.map(stepRow),
        task_status: out.task_status,
        ...(out.note ? { note: out.note } : {}),
      });
    })
  );

  registerToolBound(
    'task_pipeline_stop',
    {
      title: 'Stop a running task loop',
      description: 'Abort the driver: the flag lands on its next tick (≤ the poll interval) and the step it is waiting on is stamped `aborted` immediately, so the newest row stops claiming work right away. Nothing after the current step starts. Refuses with `task_pipeline_idle` when there is neither a driver nor a running step — a stop that pretended to stop something would be worse than no stop. A run that already ended leaves `pipeline.reason` readable (parked / done / stopped), so the stop never has to guess what it stopped.',
      inputSchema: {
        task_id: z.string().describe('Task id'),
      },
    },
    async ({ task_id }) => pipelineCall(async () => {
      const task = taskRunner.getTask(task_id);
      await pipelineGate('task_pipeline_stop', task);
      const res = taskPipeline.stop(task_id, { actor: missionActor(currentUser()) });
      const row = res.aborted_step ? taskRunner.getTaskStep(res.aborted_step) : null;
      return textResult({
        ok: true,
        pipeline: res.rec ? taskPipeline.snapshot(res.rec) : null,
        aborted_step: row ? stepRow(row) : null,
        current_step: stepRow(taskRunner.getCurrentTaskStep(task_id)),
      });
    })
  );

  }
};
