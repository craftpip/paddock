/**
 * Runner tools (plan 128): run a queue of plans in a Mission session through MCP
 * alone — list, inspect, create, start, pause, reconcile, remove.
 *
 * Every handler goes through the same gate as the queue tools
 * (`missionRequireProject(user, <tool>, runner.project_id)`: visibility, target
 * grant, tool grant) and calls the SAME service functions as the REST routes.
 * Every result is one shape, the runner BRIEF, so an LLM reads the same fields
 * whatever it just did: state, what is blocked and on what question, what each
 * control would do, and one sentence naming the next useful call.
 */
const crypto = require('crypto');
const { z } = require('zod');
const mission = require('../services/mission');

const STATUS_WORD = { 'need input': 'need_input', 'in progress': 'in_progress' };
const wire = (status) => STATUS_WORD[status] || status;

/** The server's own verdict per control: `true`, or the sentence saying why not. */
function can(actions = {}) {
  const v = (a) => (a?.allowed ? true : a?.reason || 'not available');
  return {
    run: v(actions.run), pause: v(actions.pause), resolve: v(actions.resolve),
    reconcile: v(actions.reconcile), add_plans: v(actions.addItems), remove_item: v(actions.removeItem),
    reorder: v(actions.reorder),
  };
}

/** One sentence: the single most useful next call, read off the server's
 *  verdicts (never a second opinion about state — lesson S20). */
function nextStep(runnerId, b) {
  const blocked = b.blocked[0];
  if (b.state === 'setup_required') return `The queue is not set up: call queue_ensure {runner_id: "${runnerId}"}.`;
  if (b.state === 'projection_error') return `The QUEUE.md file was edited by hand and no longer matches the server queue. A human must regenerate it from the Mission page (Regenerate).`;
  if (b.waiting_for === 'permission') return `The worker is waiting on a permission dialog (${b.reason || 'a tool call needs approval'}). Read it with mission_sessions {session_id: "${b.session?.id}"}, then answer with mission_permission_answer {session_id: "${b.session?.id}", choice: "once" | "reject"} — reject anything the plan did not need. The queue continues by itself afterwards.`;
  if (blocked && b.can.resolve === true) return `The worker asked: "${blocked.question}". Answer with agent_queue_resolve_need_input {runner_id: "${runnerId}", item_id: "${blocked.item_id}", answer: "..."} — the worker then continues on its own.`;
  if (blocked) return `Plan ${blocked.plan} is waiting for input ("${blocked.question}"), but answering is not possible right now: ${b.can.resolve}.`;
  if (b.label === 'Usage limit') return `The provider's usage limit stopped the worker. Nothing needs answering. When the limit resets, call runner_start {runner_id: "${runnerId}"}; it checks the worker's screen first and refuses while the limit still shows.`;
  if (b.can.reconcile === true) return `An instruction was sent and not yet acknowledged. Wait a minute and call runner_get again; if it stays, call runner_reconcile {runner_id: "${runnerId}"} (it never re-sends).`;
  if (['dispatching', 'awaiting_receipt', 'running'].includes(b.state)) {
    return b.current
      ? `The worker is working on ${b.current.plan}. Check again with runner_get in a minute; mission_sessions {session_id: "${b.session?.id}"} shows its screen.`
      : `The runner is active. Check again with runner_get in a minute.`;
  }
  if (b.state === 'complete' || (b.counts.total > 0 && b.counts.done === b.counts.total)) return `All ${b.counts.total} plan(s) are done. Add more with queue_write {runner_id: "${runnerId}", plans: [...], revision: ${b.revision}}, then runner_start.`;
  if (!b.counts.total) return `The queue is empty. Write plans with plan_write, add them with queue_write {runner_id: "${runnerId}", plans: [...], revision: ${b.revision}}, then call runner_start.`;
  if (b.can.run === true) return `Call runner_start {runner_id: "${runnerId}"} to run the queue.`;
  return `Nothing can be done right now: ${b.can.run}`;
}

async function runnerBrief(runnerId) {
  const detail = await mission.readRunnerQueue(runnerId);
  const runner = mission.getRunner(runnerId);
  const q = detail.queue || {};
  const ex = q.execution || {};
  const items = (q.items || []).map((it) => ({ item_id: it.id, plan: it.plan, title: it.title || null, status: wire(it.status), reason: it.reason || null }));
  const counts = { total: items.length, done: 0, in_progress: 0, new: 0, need_input: 0 };
  for (const it of items) if (it.status in counts) counts[it.status] += 1;
  let session = null;
  if (runner.session_id) {
    try {
      const s = mission.getSession(runner.session_id);
      session = { id: s.id, tmux_id: s.tmux_id, conversation_id: s.agent_session_id || null };
    } catch { session = { id: runner.session_id, missing: true }; }
  }
  const current = items.find((it) => it.status === 'in_progress') || null;
  const b = {
    runner_id: runner.id,
    name: runner.name,
    project: detail.project ? { id: detail.project.id, name: detail.project.name, folder: detail.project.folder } : { id: runner.project_id },
    session,
    state: ex.state || null,
    label: ex.label || null,
    reason: ex.reason || null,
    banner: ex.banner?.text || null,
    revision: q.revision,
    counts,
    current: current ? { item_id: current.item_id, plan: current.plan } : null,
    blocked: items.filter((it) => it.status === 'need_input').map((it) => ({ item_id: it.item_id, plan: it.plan, question: it.reason || '(no question text)' })),
    items,
    can: can(ex.actions),
    // What the runner is waiting on, when it is not a question about a plan.
    waiting_for: ex.permissionWait ? 'permission' : (ex.label === 'Usage limit' ? 'usage_limit' : (items.some((it) => it.status === 'need_input') ? 'answer' : null)),
  };
  b.next = nextStep(runner.id, b);
  return b;
}

module.exports = function register(registerToolBound, ctx) {
  const { currentUser, missionCall, missionCallSync, missionRequireProject, missionVisibleAgents, missionSelectProjects, missionActor, textResult } = ctx;

  /** Resolve a runner the caller may use with this tool (visibility, target, grant). */
  const requireRunner = (tool, runnerId) => {
    const runner = missionCallSync(() => {
      const r = mission.getRunner(String(runnerId || ''));
      if (!r) throw new mission.MissionError('runner_not_found', `No runner ${runnerId}. runner_list shows the runners you can use.`);
      return r;
    });
    missionRequireProject(currentUser(), tool, runner.project_id);
    return runner;
  };
  const brief = (id) => missionCall(() => runnerBrief(id));
  const actor = () => missionActor(currentUser());

  registerToolBound(
    'runner_list',
    {
      title: 'List queue runners',
      description: 'A runner works through a queue of plan files in ONE Mission session: it types each plan into the agent\'s TUI, waits for the turn to finish, and moves on; when the worker needs a decision it stops and asks. This lists the runners you can use, each as a short brief (state, counts, what is blocked, and `next`: the call to make). Filter with `project_id` (from mission_projects). Get one runner in full with runner_get.',
      inputSchema: {
        project_id: z.string().optional().describe('Only this Mission project\'s runners'),
      },
    },
    async ({ project_id }) => {
      const user = currentUser();
      let projects = missionCallSync(() => mission.listProjects({ agents: missionVisibleAgents(user) }));
      if (project_id) projects = missionSelectProjects(projects, { projectId: project_id });
      const out = [];
      for (const p of projects) {
        for (const r of missionCallSync(() => mission.listRunnersForProject(p.id))) {
          const b = await brief(r.id);
          out.push({ runner_id: b.runner_id, name: b.name, project: b.project, state: b.state, label: b.label, counts: b.counts, current: b.current, blocked: b.blocked, next: b.next });
        }
      }
      return textResult({ runners: out, count: out.length, ...(out.length ? {} : { next: 'No runners yet. Create one with runner_create {project_id, name, plans: [...]}.' }) });
    }
  );

  registerToolBound(
    'runner_get',
    {
      title: 'Read one runner',
      description: 'Everything about one runner in one call: state and its plain-language label, why it stopped, every queue item (item_id, plan, status new|in_progress|need_input|done, reason), what is blocked and the worker\'s question, whether each control is possible right now (`can.*` is true or the reason it is not), the queue `revision` that writes need, and `next`: the single most useful call to make. Poll this while a queue runs.',
      inputSchema: { runner_id: z.string().describe('From runner_list or runner_create') },
    },
    async ({ runner_id }) => {
      const runner = requireRunner('runner_get', runner_id);
      return textResult(await brief(runner.id));
    }
  );

  registerToolBound(
    'runner_create',
    {
      title: 'Create a queue runner',
      description: 'Create a runner for a Mission project and set up its queue, ready to run — one call. Without `session_id` a NEW session is started for it (the agent\'s TUI launches in the project folder); with `session_id` an existing session of that project becomes the worker. `plans` (paths relative to the project\'s plans folder, written with plan_write) are queued in order. Nothing is sent to the agent until runner_start. Returns the runner brief.',
      inputSchema: {
        project_id: z.string().describe('The Mission project (from mission_projects / mission_project_create)'),
        name: z.string().min(1).max(80).describe('A short name for the runner, e.g. "web fixes"'),
        session_id: z.string().optional().describe('Use this existing session of the project as the worker (omit to start a new one)'),
        plans: z.array(z.string()).optional().describe('Plan paths to queue, in order, e.g. ["01-footer.md", "02-copy.md"]'),
      },
    },
    async ({ project_id, name, session_id, plans }) => {
      missionRequireProject(currentUser(), 'runner_create', project_id);
      const runner = await missionCall(() => mission.createRunner({ projectId: project_id, name, sessionId: session_id || undefined, actor: actor() }));
      await missionCall(() => mission.setupRunnerQueue(runner.id, { actor: actor() }));
      if (plans && plans.length) {
        const rev = (await missionCall(() => mission.readRunnerQueue(runner.id))).queue.revision;
        await missionCall(() => mission.addRunnerQueueItems(runner.id, plans, rev, { actor: actor() }));
      }
      return textResult(await brief(runner.id));
    }
  );

  registerToolBound(
    'runner_start',
    {
      title: 'Run the queue',
      description: 'Press Run: the runner sends the next plan to its worker session and keeps going plan after plan until the queue is done, a plan needs input, or the provider\'s usage limit is hit. Also the way to continue after a usage limit has reset (it checks the worker\'s screen first and refuses while the limit still shows). Refusals name the reason and what fixes it. Returns the runner brief.',
      inputSchema: { runner_id: z.string() },
    },
    async ({ runner_id }) => {
      const runner = requireRunner('runner_start', runner_id);
      const result = await missionCall(() => mission.startRunner(runner.id, { actor: actor() }));
      const b = await brief(runner.id);
      return textResult({ started: !!result?.started, outcome: result?.reason || (result?.started ? 'started' : null), ...b });
    }
  );

  registerToolBound(
    'runner_pause',
    {
      title: 'Pause the queue',
      description: 'Stop the runner from starting the next plan. mode "before_next_task" (default): the plan in progress finishes, nothing new starts. mode "current_task": the worker is asked to stop at a safe point and write its progress into the plan file; runner_start later resumes it. Returns the runner brief.',
      inputSchema: {
        runner_id: z.string(),
        mode: z.enum(['before_next_task', 'current_task']).optional(),
      },
    },
    async ({ runner_id, mode }) => {
      const runner = requireRunner('runner_pause', runner_id);
      await missionCall(() => mission.pauseRunner(runner.id, { mode: mode || 'before_next_task', actor: actor() }));
      return textResult(await brief(runner.id));
    }
  );

  registerToolBound(
    'runner_reconcile',
    {
      title: 'Reconcile an unacknowledged instruction',
      description: 'When runner_get says an instruction was sent but not acknowledged (state awaiting_receipt or held), look for the worker\'s receipt of it in the agent\'s own store. Never re-sends: either the instruction is confirmed and the queue continues, or the brief says what is still unknown. Returns the runner brief.',
      inputSchema: { runner_id: z.string() },
    },
    async ({ runner_id }) => {
      const runner = requireRunner('runner_reconcile', runner_id);
      const result = await missionCall(() => mission.reconcileRunnerOperation(runner.id, { actor: actor() }));
      return textResult({ reconciled: result, ...(await brief(runner.id)) });
    }
  );

  registerToolBound(
    'runner_remove',
    {
      title: 'Remove a runner',
      description: 'Remove the runner: supervision stops and its destroy callback (if any) runs. The worker session and its conversation stay open as an ordinary session; plan files are untouched.',
      inputSchema: { runner_id: z.string() },
    },
    async ({ runner_id }) => {
      const runner = requireRunner('runner_remove', runner_id);
      const result = await missionCall(() => mission.removeRunner(runner.id, { actor: actor() }));
      return textResult({ removed: true, runner_id: runner.id, session_kept: runner.session_id || null, ...result });
    }
  );

  registerToolBound(
    'agent_queue_remove_item',
    {
      title: 'Remove a plan from the queue',
      description: 'Take one item off the runner\'s queue (the plan file stays). Refused for the item in progress and while the runner is running — pause first. `revision` is optional: the current one is used if omitted.',
      inputSchema: {
        runner_id: z.string(),
        item_id: z.string(),
        revision: z.number().int().optional(),
      },
    },
    async ({ runner_id, item_id, revision }) => {
      const runner = requireRunner('agent_queue_remove_item', runner_id);
      const rev = revision ?? (await missionCall(() => mission.readRunnerQueue(runner.id))).queue.revision;
      await missionCall(() => mission.removeRunnerQueueItem(runner.id, item_id, rev, { actor: actor() }));
      return textResult(await brief(runner.id));
    }
  );
};

/** Deterministic idempotency key for a blocker answer: the same answer to the
 *  same item is the same request, so a retried call can never answer twice. */
module.exports.answerKey = (runnerId, itemId, answer) =>
  'mcp-' + crypto.createHash('sha256').update(`${runnerId}\0${itemId}\0${answer}`).digest('hex').slice(0, 32);
module.exports.runnerBrief = runnerBrief;
