const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { getDb } = require('./db');
const history = require('./runner-history');
const runnerTransition = require('./runner-transition');
const exec = promisify(execFile);

function isRecovery(row) {
  return row.event === 'usage_exhausted' && Number(row.recreate_resume) === 1;
}

async function containerId(name) {
  const { stdout } = await exec('docker', ['inspect', '--format', '{{.Id}}', name], { timeout: 10000 });
  return stdout.trim();
}

// This opt-in runs outside the PAD. Persist identity before invoking any script
// that can kill its worker. A crash never authorizes replay of the rotation.
async function begin(row, { inspect = containerId } = {}) {
  if (!isRecovery(row)) return null;
  const db = getDb();
  const runner = db.prepare('SELECT * FROM infinite_runners WHERE id = ?').get(row.runner_id);
  const runtime = runner && runnerTransition.getRuntime(row.runner_id);
  const session = runner && db.prepare('SELECT * FROM mission_sessions WHERE id = ?').get(runner.session_id);
  if (!runner || !runtime || runtime.state !== 'waiting_input' || runtime.reason_code !== 'usage_exhausted' || !session?.agent_session_id) {
    throw new Error('Quota recovery requires the stopped runner and its original conversation');
  }
  const previous = db.prepare('SELECT * FROM runner_quota_recoveries WHERE event_id = ?').get(row.id);
  if (previous) throw new Error('This recovery already owns an attempt; automatic replay withheld');
  const id = await inspect(row.agent_name);
  if (!id) throw new Error('Could not identify the PAD before recovery');
  db.prepare(`INSERT INTO runner_quota_recoveries
    (event_id, runner_id, session_id, conversation_id, generation, container_id, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'script_running', ?)`)
    .run(row.id, row.runner_id, session.id, session.agent_session_id, runtime.generation, id, new Date().toISOString());
  return db.prepare('SELECT * FROM runner_quota_recoveries WHERE event_id = ?').get(row.id);
}

async function complete(row, context, outcome, { inspect = containerId, resume } = {}) {
  if (!context) return;
  const db = getDb();
  const settle = (status, error = null) => db.prepare('UPDATE runner_quota_recoveries SET status = ?, error = ?, updated_at = ? WHERE event_id = ?')
    .run(status, error, new Date().toISOString(), row.id);
  if (outcome.status !== 'ok') {
    settle(outcome.exit_code === 75 ? 'held' : 'failed', `Recovery script ${outcome.status} (exit ${outcome.exit_code})`);
    history.record({ id: row.runner_id, session_id: context.session_id }, outcome.exit_code === 75 ? 'recovery_held' : 'recovery_failed', { groupId: row.id, key: `${row.id}:recovery-result`, severity: 'warning', exitCode: outcome.exit_code });
    return;
  }
  const claim = db.prepare("UPDATE runner_quota_recoveries SET status = 'restoring' WHERE event_id = ? AND status = 'script_running'").run(row.id);
  if (!claim.changes) return;
  try {
    const runner = db.prepare('SELECT * FROM infinite_runners WHERE id = ?').get(context.runner_id);
    const runtime = runner && runnerTransition.getRuntime(context.runner_id);
    if (!runner || !runtime || runtime.generation !== context.generation || runtime.state !== 'waiting_input' || runtime.reason_code !== 'usage_exhausted') {
      throw new Error('Recovery cancelled by a newer runner control action');
    }
    const after = await inspect(row.agent_name);
    if (!after || after === context.container_id) throw new Error('Script exited successfully but the PAD was not recreated; resume withheld');
    history.record({ id: row.runner_id, session_id: context.session_id }, 'container_recreated', { actor: 'recovery-script', groupId: row.id, key: `${row.id}:recreated` });
    history.record({ id: row.runner_id, session_id: context.session_id }, 'session_restoring', { groupId: row.id, key: `${row.id}:restoring` });
    await (resume || require('./mission').resumeQuotaRecovery)(context);
    settle('resumed');
    history.record({ id: row.runner_id, session_id: context.session_id }, 'recovery_resumed', { groupId: row.id, key: `${row.id}:recovery-result` });
  } catch (e) {
    settle('failed', e.message);
    history.record({ id: row.runner_id, session_id: context.session_id }, 'recovery_failed', { groupId: row.id, key: `${row.id}:recovery-result`, severity: 'warning', code: e.code || 'recovery_failed', reason: 'Recovery stopped; the session was not blindly resent' });
    const runtime = runnerTransition.getRuntime(context.runner_id);
    if (runtime?.state === 'waiting_input' && runtime.generation === context.generation) {
      runnerTransition.setReason(context.runner_id, 'quota_recovery_failed', `Quota recovery stopped: ${e.message}`);
    }
  }
}

module.exports = { isRecovery, begin, complete };
