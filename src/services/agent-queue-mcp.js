const { McpError, ErrorCode } = require('@modelcontextprotocol/sdk/types.js');
const { z } = require('zod');
const runnerQueue = require('./runner-queue');
const mission = require('./mission');

function errorResult(err) {
  const msg = err?.message || String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: msg }],
  };
}

function getRunnerIdForAgent(agentName) {
  const runner = mission.getActiveRunnerForAgent(agentName);
  if (!runner) {
    throw new McpError(ErrorCode.InvalidParams, `No active runner found for agent ${agentName}`);
  }
  return runner.id;
}

function registerAgentQueueTools(server) {
  const registerToolBound = (name, config, handler) => {
    server.registerTool(name, config, async (...args) => {
      try {
        return await handler(...args);
      } catch (err) {
        if (err instanceof McpError) throw err;
        console.error(`[agent-queue-mcp] tool ${name} failed:`, err?.message || err);
        return errorResult(err);
      }
    });
  };

  registerToolBound(
    'agent_queue_read',
    {
      title: 'Read my queue',
      description: 'Read the canonical queue for the current agent runner. Returns items with server-generated IDs, positions, plans, statuses, and the queue revision for CAS mutations.',
      inputSchema: {
        agent_name: z.string(),
      },
    },
    async ({ agent_name }) => {
      const runnerId = getRunnerIdForAgent(agent_name);
      const snapshot = runnerQueue.snapshot(runnerId);
      return { content: [{ type: 'text', text: JSON.stringify(snapshot, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_update_item',
    {
      title: 'Update queue item status',
      description: 'Update a queue item status (new, in_progress, need_input, done). Requires the item ID and current queue revision for CAS. For need_input, a non-empty reason is required.',
      inputSchema: {
        agent_name: z.string(),
        item_id: z.string(),
        status: z.enum(['new', 'in_progress', 'need_input', 'done']),
        reason: z.string().optional(),
        revision: z.number().int(),
      },
    },
    async ({ agent_name, item_id, status, reason = '', revision }) => {
      const runnerId = getRunnerIdForAgent(agent_name);
      const updated = runnerQueue.updateItem(runnerId, item_id, { status, reason }, revision, { actor: 'agent' });
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_add_custom_instructions',
    {
      title: 'Add custom queue instructions',
      description: 'Add or update custom instructions for the queue. Requires current revision for CAS.',
      inputSchema: {
        agent_name: z.string(),
        custom_instructions: z.string(),
        revision: z.number().int(),
      },
    },
    async ({ agent_name, custom_instructions, revision }) => {
      const runnerId = getRunnerIdForAgent(agent_name);
      const updated = runnerQueue.setCustomInstructions(runnerId, custom_instructions, revision, { actor: 'agent' });
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_reorder',
    {
      title: 'Reorder queue items',
      description: 'Reorder queue items by providing the full array of item IDs in the new order. Requires current revision for CAS.',
      inputSchema: {
        agent_name: z.string(),
        item_ids: z.array(z.string()),
        revision: z.number().int(),
      },
    },
    async ({ agent_name, item_ids, revision }) => {
      const runnerId = getRunnerIdForAgent(agent_name);
      const updated = runnerQueue.reorder(runnerId, item_ids, revision, { actor: 'agent' });
      return { content: [{ type: 'text', text: JSON.stringify(updated, null, 2) }] };
    }
  );

  registerToolBound(
    'agent_queue_resolve_need_input',
    {
      title: 'Resolve need-input blocker',
      description: 'Resolve a need_input queue item by providing an answer. This requeues the item (status -> new, reason cleared) and resumes the runner. Requires idempotency key for safe retries.',
      inputSchema: {
        agent_name: z.string(),
        item_id: z.string(),
        answer: z.string(),
        revision: z.number().int(),
        idempotency_key: z.string(),
      },
    },
    async ({ agent_name, item_id, answer, revision, idempotency_key }) => {
      const runnerId = getRunnerIdForAgent(agent_name);
      const result = await mission.resolveRunnerQueue(runnerId, item_id, answer, revision, idempotency_key, { actor: 'agent' });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
}

module.exports = { registerAgentQueueTools };