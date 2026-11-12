const { z } = require('zod');
const mission = require('./mission');

/** Plan 117: the tools a WORKER needs. The runner MCP surface registers only
 *  these; reorder, custom instructions and blocker resolution are management
 *  and stay on the control surface (a worker cannot resolve its own blocker). */
const WORKER_QUEUE_TOOLS = ['agent_queue_read', 'agent_queue_update_item'];

function registerAgentQueueTools(registerAll, { authorize, actor, only = null }) {
  const registerToolBound = only
    ? (name, ...rest) => (only.includes(name) ? registerAll(name, ...rest) : undefined)
    : registerAll;
  // Exact runner identity is mandatory: one PAD routinely hosts several
  // projects and conversations. Never pick a runner by enabled flag or recency.
  const requireRunner = (runnerId, write) => authorize(runnerId, write);

  registerToolBound(
    'agent_queue_read',
    {
      title: 'Read my queue',
      description: 'Read the canonical queue for the current agent runner. Returns items with server-generated IDs, positions, plans, statuses, and the queue revision for CAS mutations.',
      inputSchema: {
        runner_id: z.string(),
      },
    },
    async ({ runner_id }) => {
      const runnerId = requireRunner(runner_id, false).id;
      const snapshot = await mission.readRunnerQueue(runnerId);
      return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_update_item',
    {
      title: 'Update queue item status',
      description: 'Update a queue item status (new, in_progress, need_input, done). Requires the item ID and current queue revision for CAS. For need_input, a non-empty reason is required.',
      inputSchema: {
        runner_id: z.string(),
        item_id: z.string(),
        status: z.enum(['new', 'in_progress', 'need_input', 'done']),
        reason: z.string().optional(),
        revision: z.number().int(),
      },
    },
    async ({ runner_id, item_id, status, reason = '', revision }) => {
      const runnerId = requireRunner(runner_id, true).id;
      // The worker's write is guarded by OWNERSHIP (its assigned item, a legal
      // status step), not by the queue revision: the revision moves whenever a
      // human adds a plan or pauses mid-turn, and a worker that met that
      // conflict once tended to give up on closing its item at all. So a stale
      // revision is retried once against the current one; every other refusal
      // (not assigned, illegal transition) still stands.
      const write = (rev) => mission.updateRunnerQueueItem(runnerId, item_id, { status, reason }, rev, { actor: actor(), source: 'worker' });
      let updated;
      try {
        updated = await write(revision);
      } catch (e) {
        if (e?.code !== 'queue_revision_conflict') throw e;
        updated = await write((await mission.readRunnerQueue(runnerId)).queue.revision);
      }
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_add_custom_instructions',
    {
      title: 'Add custom queue instructions',
      description: 'Add or update custom instructions for the queue. Requires current revision for CAS.',
      inputSchema: {
        runner_id: z.string(),
        custom_instructions: z.string(),
        revision: z.number().int(),
      },
    },
    async ({ runner_id, custom_instructions, revision }) => {
      const runnerId = requireRunner(runner_id, true).id;
      const updated = await mission.updateRunnerQueueCustomInstructions(runnerId, custom_instructions, revision, { actor: actor() });
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_reorder',
    {
      title: 'Reorder queue items',
      description: 'Reorder queue items by providing the full array of item IDs in the new order. Requires current revision for CAS.',
      inputSchema: {
        runner_id: z.string(),
        item_ids: z.array(z.string()),
        revision: z.number().int(),
      },
    },
    async ({ runner_id, item_ids, revision }) => {
      const runnerId = requireRunner(runner_id, true).id;
      const updated = await mission.reorderRunnerQueue(runnerId, item_ids, revision, { actor: actor() });
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_resolve_need_input',
    {
      title: 'Resolve need-input blocker',
      description: 'Answer the question a worker asked when it stopped a plan with need_input (runner_get lists them under `blocked`, with the item_id and the question). The answer is typed into the worker\'s session, the plan goes back to the queue and the runner continues on its own. `revision` and `idempotency_key` are optional: the current revision is used, and the key defaults to one derived from runner, item and answer, so two overlapping calls with the same answer are one request. Retrying after success is refused with queue_item_not_blocked — the answer is never typed twice.',
      inputSchema: {
        runner_id: z.string(),
        item_id: z.string().describe('The blocked item (runner_get → blocked[].item_id)'),
        answer: z.string().min(1).describe('Your decision, in plain words the worker can act on'),
        revision: z.number().int().optional().describe('Queue revision you read (optional)'),
        idempotency_key: z.string().optional().describe('Optional; same key = same request'),
      },
    },
    async ({ runner_id, item_id, answer, revision, idempotency_key }) => {
      const runnerId = requireRunner(runner_id, true).id;
      // Defaults an LLM would otherwise get wrong. The current revision is taken
      // only for an item that is still waiting for input, so it cannot turn a
      // stale answer into a write over a changed queue.
      let rev = revision;
      if (rev === undefined) {
        const snap = await mission.readRunnerQueue(runnerId);
        const item = (snap.queue.items || []).find((it) => it.id === item_id);
        if (!item) throw new Error(`queue_item_not_found: no item ${item_id} on runner ${runnerId}; runner_get lists the blocked items`);
        if (item.status !== 'need input') throw new Error(`queue_item_not_blocked: item ${item_id} is "${item.status}", not waiting for input — nothing to answer`);
        rev = snap.queue.revision;
      }
      const key = idempotency_key || require('../mcp/tools-runners').answerKey(runnerId, item_id, answer);
      const result = await mission.resolveRunnerQueue(runnerId, item_id, answer, rev, key, { actor: actor() });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
}

module.exports = { registerAgentQueueTools, WORKER_QUEUE_TOOLS };
