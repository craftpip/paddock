const { getDb } = require('./db');

const TYPES = {
  history_started: ['control', 'History recording started'],
  runner_created: ['control', 'Runner created'],
  runner_removed: ['control', 'Runner removed'],
  plan_added: ['plans', 'Plan added to queue'],
  plan_removed: ['plans', 'Plan removed from queue'],
  queue_reordered: ['plans', 'Queue order changed'],
  run_requested: ['control', 'Run requested'],
  runner_started: ['control', 'Queue supervision started'],
  run_failed: ['control', 'Run could not start'],
  pause_requested: ['control', 'Pause requested'],
  pause_applied: ['control', 'Queue dispatch paused'],
  pause_failed: ['control', 'Pause failed'],
  queue_stopped: ['control', 'Queue stopped'],
  queue_completed: ['plans', 'Queue completed'],
  plan_started: ['plans', 'Plan started'],
  plan_completed: ['plans', 'Plan completed'],
  plan_requeued: ['plans', 'Plan returned to queue'],
  input_needed: ['input', 'Input needed'],
  answer_submitted: ['input', 'Answer submitted'],
  answer_accepted: ['input', 'Answer accepted — queue resumed'],
  answer_failed: ['input', 'Answer could not be accepted'],
  usage_exhausted: ['recovery', 'Provider quota exhausted'],
  usage_recovered: ['recovery', 'Provider quota recovered'],
  recovery_requested: ['recovery', 'Recovery requested'],
  script_started: ['recovery', 'Callback script started'],
  script_completed: ['recovery', 'Callback script completed'],
  script_failed: ['recovery', 'Callback script failed'],
  script_unknown: ['recovery', 'Callback outcome unknown'],
  container_recreated: ['recovery', 'PAD recreation verified'],
  session_restoring: ['recovery', 'Restoring original conversation'],
  session_restored: ['recovery', 'Original conversation restored'],
  continuation_sent: ['recovery', 'Continuation sent'],
  continuation_accepted: ['recovery', 'Continuation accepted'],
  recovery_resumed: ['recovery', 'Recovery completed — queue resumed'],
  recovery_held: ['recovery', 'Recovery held — queue remains paused'],
  recovery_failed: ['recovery', 'Recovery could not complete'],
  quota_remains: ['recovery', 'Provider quota is still exhausted'],
  worker_exited: ['recovery', 'Worker process exited'],
  worker_restored: ['recovery', 'Worker session restored'],
  delivery_unconfirmed: ['control', 'Instruction delivery unconfirmed'],
  dispatch_failed: ['control', 'Worker instruction could not be sent'],
};

// Journal metadata, never a second transcript or copy of user answers/scripts.
const FIELDS = ['plan', 'itemId', 'reason', 'code', 'exitCode', 'characters', 'mode', 'state'];
function record(runner, type, { actor = 'runner', groupId = null, key = null, severity = 'info', ...metadata } = {}) {
  try {
    if (!runner?.id || !TYPES[type]) return null;
    const details = {};
    for (const field of FIELDS) {
      const value = metadata[field];
      if (typeof value === 'string') details[field] = value.slice(0, 1200);
      else if (typeof value === 'number' && Number.isFinite(value)) details[field] = value;
    }
    const result = getDb().prepare(`INSERT OR IGNORE INTO runner_history
      (runner_id,session_id,type,category,severity,actor,group_id,event_key,details,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(runner.id, runner.session_id || null, type, TYPES[type][0], severity,
      String(actor?.name || actor || 'runner').slice(0, 160), groupId, key ? `${runner.id}:${key}` : null,
      JSON.stringify(details), new Date().toISOString());
    return result.changes ? Number(result.lastInsertRowid) : null;
  } catch (e) {
    // History cannot turn an already-completed action into a failed action.
    console.error('[runner history] record failed:', e.code || e.message);
    return null;
  }
}

function baseline(runner) {
  return record(runner, 'history_started', { key: 'baseline', state: runner.control_state,
    reason: 'Earlier activity is not reconstructed. Plan transitions are dated when observed.' });
}

function describe(row) {
  return { id: row.id, type: row.type, title: TYPES[row.type]?.[1] || row.type,
    category: row.category, severity: row.severity, actor: row.actor,
    createdAt: row.created_at, details: JSON.parse(row.details) };
}

function read(runnerId, { before = null, category = 'all', limit = 40 } = {}) {
  if (!['all', 'plans', 'input', 'recovery', 'problems'].includes(category)) throw new TypeError('Invalid history filter');
  if (before !== null && (!/^\d+$/.test(String(before)) || !Number.isSafeInteger(Number(before)))) throw new TypeError('Invalid history cursor');
  const requested = Number(limit);
  const count = Number.isFinite(requested) ? Math.min(100, Math.max(1, Math.floor(requested))) : 40;
  const match = category === 'all' ? '1' : category === 'problems'
    ? "severity IN ('warning', 'error')" : 'category = ?';
  const params = [runnerId, ...(category !== 'all' && category !== 'problems' ? [category] : []), Number(before) || Number.MAX_SAFE_INTEGER, count + 1];
  const roots = getDb().prepare(`SELECT COALESCE(group_id, 'event:' || id) AS groupKey,
      MIN(id) AS root, MAX(id) AS latest, COUNT(*) AS total
    FROM runner_history WHERE runner_id = ? GROUP BY COALESCE(group_id, 'event:' || id)
    HAVING MAX(CASE WHEN ${match} THEN 1 ELSE 0 END) = 1 AND MIN(id) < ?
    ORDER BY root DESC LIMIT ?`).all(...params);
  const hasMore = roots.length > count;
  const groups = roots.slice(0, count).map((root) => {
    const rows = getDb().prepare("SELECT * FROM runner_history WHERE runner_id = ? AND COALESCE(group_id, 'event:' || id) = ? ORDER BY id LIMIT 100").all(runnerId, root.groupKey);
    return { id: root.root, groupId: rows[0].group_id, latest: root.latest, total: root.total,
      truncated: root.total > rows.length, createdAt: rows[0].created_at, events: rows.map(describe) };
  });
  const bounds = getDb().prepare('SELECT MIN(created_at) AS since, MAX(id) AS latest FROM runner_history WHERE runner_id = ?').get(runnerId);
  return { groups, nextCursor: hasMore ? groups.at(-1).id : null, since: bounds.since, latest: bounds.latest || 0 };
}

function output(runnerId, eventId) {
  // Same runner grant as the timeline, checked by the route before this read.
  return getDb().prepare('SELECT status,exit_code,stdout,stderr,truncated FROM runner_callback_outbox WHERE runner_id = ? AND id = ?').get(runnerId, eventId) || null;
}

module.exports = { record, baseline, read, output };
