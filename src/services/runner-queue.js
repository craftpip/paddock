const crypto = require('crypto');
const path = require('path');

const { getDb } = require('./db');

const ITEM_STATUSES = Object.freeze(['new', 'in_progress', 'need_input', 'done']);

class RunnerQueueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerQueueError';
    this.code = code;
  }
}

function now() {
  return new Date().toISOString();
}

function queueId() {
  return `rq_${crypto.randomUUID()}`;
}

function itemId() {
  return `rqi_${crypto.randomUUID()}`;
}

function eventId() {
  return `rqe_${crypto.randomUUID()}`;
}

function validatePlan(plan) {
  if (typeof plan !== 'string' || !plan.trim() || path.isAbsolute(plan) || plan.includes('..') || !plan.toLowerCase().endsWith('.md')) {
    throw new RunnerQueueError('queue_plan_invalid', 'Plan must be a relative Markdown path inside the project plans folder.');
  }
  return plan.trim().split(path.sep).join('/');
}

function validateStatus(status, reason = '') {
  if (!ITEM_STATUSES.includes(status)) {
    throw new RunnerQueueError('queue_status_invalid', `Status must be one of: ${ITEM_STATUSES.join(', ')}.`);
  }
  if (typeof reason !== 'string') {
    throw new RunnerQueueError('queue_reason_invalid', 'Reason must be text.');
  }
  if (status === 'need_input' && !reason.trim()) {
    throw new RunnerQueueError('queue_reason_required', 'A need_input item requires a reason.');
  }
}

function queueRow(runnerId) {
  return getDb().prepare('SELECT * FROM runner_queues WHERE runner_id = ?').get(runnerId);
}

function itemsFor(queue) {
  return getDb().prepare('SELECT * FROM runner_queue_items WHERE queue_id = ? ORDER BY position').all(queue.id);
}

function summary(items) {
  const counts = { total: items.length, new: 0, inProgress: 0, needInput: 0, done: 0 };
  for (const item of items) {
    if (item.status === 'new') counts.new++;
    else if (item.status === 'in_progress') counts.inProgress++;
    else if (item.status === 'need_input') counts.needInput++;
    else if (item.status === 'done') counts.done++;
  }
  const pick = (item) => item && ({ id: item.id, plan: item.plan, status: item.status, reason: item.reason });
  return {
    counts,
    current: pick(items.find((item) => item.status === 'in_progress')) || null,
    next: pick(items.find((item) => item.status === 'new')) || null,
    blocked: pick(items.find((item) => item.status === 'need_input')) || null,
    complete: items.length > 0 && counts.done === items.length,
  };
}

function snapshot(queue) {
  const items = itemsFor(queue);
  return {
    id: queue.id,
    runnerId: queue.runner_id,
    revision: queue.revision,
    customInstructions: queue.custom_instructions,
    items: items.map((item) => ({
      id: item.id,
      position: item.position,
      plan: item.plan,
      status: item.status,
      reason: item.reason,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
    })),
    summary: summary(items),
    createdAt: queue.created_at,
    updatedAt: queue.updated_at,
  };
}

function record(queue, action, actor, before, after, itemIdValue = null) {
  getDb().prepare(
    'INSERT INTO runner_queue_events (id, queue_id, item_id, actor, action, before_json, after_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(eventId(), queue.id, itemIdValue, actor || null, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, now());
}

function ensure(runnerId, { actor = null } = {}) {
  const db = getDb();
  const run = db.transaction(() => {
    let queue = queueRow(runnerId);
    if (queue) return queue;
    const exists = db.prepare('SELECT id FROM infinite_runners WHERE id = ?').get(runnerId);
    if (!exists) throw new RunnerQueueError('runner_not_found', `Runner ${runnerId} not found.`);
    const stamp = now();
    queue = { id: queueId(), runner_id: runnerId, revision: 0, custom_instructions: '', created_at: stamp, updated_at: stamp };
    db.prepare('INSERT INTO runner_queues (id, runner_id, revision, custom_instructions, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)')
      .run(queue.id, runnerId, '', stamp, stamp);
    record(queue, 'queue_created', actor, null, { revision: 0 });
    return queue;
  });
  return snapshot(run());
}

function requireQueue(runnerId) {
  const queue = queueRow(runnerId);
  if (!queue) throw new RunnerQueueError('queue_not_found', `Runner ${runnerId} has no canonical queue.`);
  return queue;
}

function requireRevision(queue, revision) {
  if (!Number.isInteger(revision)) throw new RunnerQueueError('queue_revision_required', 'A queue revision is required.');
  if (queue.revision !== revision) throw new RunnerQueueError('queue_revision_conflict', 'Queue changed since it was loaded. Reload and retry.');
}

function mutate(runnerId, revision, actor, action, fn) {
  const db = getDb();
  const run = db.transaction(() => {
    const queue = requireQueue(runnerId);
    requireRevision(queue, revision);
    const before = snapshot(queue);
    const itemIdValue = fn(queue, before);
    const stamp = now();
    db.prepare('UPDATE runner_queues SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
      .run(stamp, queue.id, queue.revision);
    const updated = queueRow(runnerId);
    const after = snapshot(updated);
    record(updated, action, actor, before, after, itemIdValue);
    return after;
  });
  return run();
}

function add(runnerId, plan, revision, { actor = null } = {}) {
  const cleanPlan = validatePlan(plan);
  return mutate(runnerId, revision, actor, 'item_added', (queue, before) => {
    if (before.items.some((item) => item.plan === cleanPlan)) {
      throw new RunnerQueueError('queue_plan_duplicate', `${cleanPlan} is already in this queue.`);
    }
    const stamp = now();
    const id = itemId();
    getDb().prepare('INSERT INTO runner_queue_items (id, queue_id, position, plan, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, queue.id, before.items.length, cleanPlan, 'new', '', stamp, stamp);
    return id;
  });
}

function addPlans(runnerId, plans, revision, { actor = null } = {}) {
  if (!Array.isArray(plans) || !plans.length) throw new RunnerQueueError('queue_plans_missing', 'Choose at least one plan.');
  const cleanPlans = plans.map(validatePlan);
  if (new Set(cleanPlans).size !== cleanPlans.length) throw new RunnerQueueError('queue_plan_duplicate', 'A plan can only be added once per request.');
  return mutate(runnerId, revision, actor, 'items_added', (queue, before) => {
    const existing = new Set(before.items.map((item) => item.plan));
    const duplicate = cleanPlans.find((plan) => existing.has(plan));
    if (duplicate) throw new RunnerQueueError('queue_plan_duplicate', `${duplicate} is already in this queue.`);
    const stamp = now();
    const insert = getDb().prepare('INSERT INTO runner_queue_items (id, queue_id, position, plan, status, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    cleanPlans.forEach((plan, index) => insert.run(itemId(), queue.id, before.items.length + index, plan, 'new', '', stamp, stamp));
    return null;
  });
}

function updateItem(runnerId, id, patch, revision, { actor = null } = {}) {
  return mutate(runnerId, revision, actor, 'item_updated', (queue) => {
    const item = getDb().prepare('SELECT * FROM runner_queue_items WHERE queue_id = ? AND id = ?').get(queue.id, id);
    if (!item) throw new RunnerQueueError('queue_item_not_found', `Queue item ${id} not found.`);
    const status = patch.status === undefined ? item.status : patch.status;
    const reason = patch.reason === undefined ? item.reason : patch.reason;
    validateStatus(status, reason);
    getDb().prepare('UPDATE runner_queue_items SET status = ?, reason = ?, updated_at = ? WHERE id = ?').run(status, reason, now(), id);
    return id;
  });
}

function remove(runnerId, id, revision, { actor = null } = {}) {
  return mutate(runnerId, revision, actor, 'item_removed', (queue) => {
    const item = getDb().prepare('SELECT * FROM runner_queue_items WHERE queue_id = ? AND id = ?').get(queue.id, id);
    if (!item) throw new RunnerQueueError('queue_item_not_found', `Queue item ${id} not found.`);
    getDb().prepare('DELETE FROM runner_queue_items WHERE id = ?').run(id);
    getDb().prepare('UPDATE runner_queue_items SET position = position - 1 WHERE queue_id = ? AND position > ?').run(queue.id, item.position);
    return id;
  });
}

function reorder(runnerId, ids, revision, { actor = null } = {}) {
  if (!Array.isArray(ids)) throw new RunnerQueueError('queue_order_invalid', 'Order must be an array of item IDs.');
  return mutate(runnerId, revision, actor, 'items_reordered', (queue, before) => {
    const current = before.items.map((item) => item.id);
    if (ids.length !== current.length || new Set(ids).size !== ids.length || ids.some((id) => !current.includes(id))) {
      throw new RunnerQueueError('queue_order_invalid', 'Order must contain every current queue item exactly once.');
    }
    // Shift into negative space first; the uniqueness constraint then remains
    // true at every statement instead of depending on SQLite update ordering.
    getDb().prepare('UPDATE runner_queue_items SET position = -position - 1 WHERE queue_id = ?').run(queue.id);
    const setPosition = getDb().prepare('UPDATE runner_queue_items SET position = ?, updated_at = ? WHERE id = ?');
    const stamp = now();
    ids.forEach((id, position) => setPosition.run(position, stamp, id));
    return null;
  });
}

function setCustomInstructions(runnerId, customInstructions, revision, { actor = null } = {}) {
  if (typeof customInstructions !== 'string') {
    throw new RunnerQueueError('queue_custom_instructions_invalid', 'Custom instructions must be text.');
  }
  return mutate(runnerId, revision, actor, 'instructions_updated', (queue) => {
    getDb().prepare('UPDATE runner_queues SET custom_instructions = ? WHERE id = ?').run(customInstructions, queue.id);
    return null;
  });
}

function events(runnerId) {
  const queue = requireQueue(runnerId);
  // Timestamps may share a millisecond; rowid preserves the append order the
  // event stream promises without asking callers to sort random UUIDs.
  return getDb().prepare('SELECT * FROM runner_queue_events WHERE queue_id = ? ORDER BY created_at, rowid').all(queue.id);
}

module.exports = {
  ITEM_STATUSES,
  RunnerQueueError,
  ensure,
  add,
  addPlans,
  updateItem,
  remove,
  reorder,
  setCustomInstructions,
  events,
  snapshot: (runnerId) => snapshot(requireQueue(runnerId)),
};
