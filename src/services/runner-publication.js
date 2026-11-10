const fs = require('fs');
const crypto = require('crypto');
const { getDb } = require('./db');
const runnerQueue = require('./runner-queue');
const plans = require('./plans');

const inFlight = new Set();
const PUBLISH_LEASE_MS = 120_000;

class RunnerPublicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerPublicationError';
    this.code = code;
  }
}

function assertPathAvailable(runnerId, project, agent, queueFile) {
  const candidateProject = { ...project, plans_folder: project.plans_folder || 'plans' };
  const candidateFile = plans.queuePath(agent, candidateProject, queueFile);
  const candidateMarker = plans.queuePausedPath(agent, candidateProject);
  for (const candidate of [candidateFile, candidateMarker]) {
    const owned = getDb().prepare('SELECT runner_id FROM runner_projection_owners WHERE path = ?').get(candidate);
    if (owned && owned.runner_id !== runnerId) {
      throw new RunnerPublicationError('runner_projection_path_owned', `Queue output or pause marker ${candidate} is already owned by runner ${owned.runner_id}.`);
    }
  }
  const rows = getDb().prepare(`SELECT r.id, r.queue_file, p.name AS project_name, p.agent_name,
      p.folder, p.plans_folder
    FROM infinite_runners r JOIN mission_projects p ON p.id = r.project_id WHERE r.id != ?`).all(runnerId);
  for (const row of rows) {
    try {
      const otherAgent = plans.requireAgent(row.agent_name);
      const otherProject = { ...row, plans_folder: row.plans_folder || 'plans' };
      const otherFile = plans.queuePath(otherAgent, otherProject, row.queue_file || 'QUEUE.md');
      const otherMarker = plans.queuePausedPath(otherAgent, otherProject);
      if (candidateFile === otherFile || candidateMarker === otherMarker) {
        throw new RunnerPublicationError('runner_projection_path_owned', `Queue output or pause marker is already owned by runner ${row.id}. Choose another project plans root.`);
      }
    } catch (error) {
      if (error instanceof RunnerPublicationError) throw error;
      // A runner on an unrelated read-only/unmapped project cannot own the
      // writable host path being published here. Any path the caller itself
      // cannot resolve already fails at its own project boundary.
    }
  }
  return { projectionPath: candidateFile, markerPath: candidateMarker };
}

function claimPaths(runnerId, projectionPath, markerPath) {
  const db = getDb();
  const tx = db.transaction(() => {
    for (const [kind, path] of [['projection', projectionPath], ['marker', markerPath]]) {
      const owner = db.prepare('SELECT runner_id FROM runner_projection_owners WHERE path = ?').get(path);
      if (owner && owner.runner_id !== runnerId) {
        throw new RunnerPublicationError('runner_projection_path_owned', `${kind} path ${path} is already owned by runner ${owner.runner_id}.`);
      }
      db.prepare('INSERT INTO runner_projection_owners (path, runner_id, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO NOTHING')
        .run(path, runnerId, kind, new Date().toISOString());
      db.prepare('UPDATE runner_projection_owners SET kind = ? WHERE path = ? AND runner_id = ?').run(kind, path, runnerId);
    }
    db.prepare('DELETE FROM runner_projection_owners WHERE runner_id = ? AND path NOT IN (?, ?)')
      .run(runnerId, projectionPath, markerPath);
  });
  tx.immediate();
}

function acquireLease(runnerId) {
  const db = getDb();
  const ownerId = `pub_${crypto.randomUUID()}`;
  const stamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PUBLISH_LEASE_MS).toISOString();
  const claimed = db.prepare(`INSERT INTO runner_publication_leases (runner_id, owner_id, acquired_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(runner_id) DO UPDATE SET owner_id = excluded.owner_id, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      WHERE runner_publication_leases.expires_at <= ?`)
    .run(runnerId, ownerId, stamp, expiresAt, stamp);
  if (!claimed.changes) {
    throw new RunnerPublicationError('runner_publication_busy', `Runner ${runnerId} already has a publisher in another process.`);
  }
  return ownerId;
}

function withPublisherLease(runnerId, action) {
  const db = getDb();
  const tx = db.transaction(() => acquireLease(runnerId));
  const ownerId = tx.immediate();
  try {
    return action();
  } finally {
    db.prepare('DELETE FROM runner_publication_leases WHERE runner_id = ? AND owner_id = ?').run(runnerId, ownerId);
  }
}

function publish(runner, project, agent) {
  if (inFlight.has(runner.id)) throw new RunnerPublicationError('runner_publication_busy', `Runner ${runner.id} already has a publication in progress.`);
  inFlight.add(runner.id);
  try { return withPublisherLease(runner.id, () => publishLatest(runner, project, agent)); }
  finally { inFlight.delete(runner.id); }
}

function publishLatest(runner, project, agent) {
  const db = getDb();
  const queue = runnerQueue.snapshot(runner.id);
  const contentHash = runnerQueue.publicationHash(queue);
  const { projectionPath, markerPath } = assertPathAvailable(runner.id, project, agent, runner.queue_file);
  claimPaths(runner.id, projectionPath, markerPath);
  let publication = db.prepare('SELECT * FROM runner_publications WHERE runner_id = ?').get(runner.id);
  if (!publication) {
    throw new RunnerPublicationError('runner_publication_missing', `Runner ${runner.id} has no desired publication record.`);
  }
  try {
    db.prepare('UPDATE runner_publications SET error = NULL, updated_at = ? WHERE runner_id = ?')
      .run(new Date().toISOString(), runner.id);
    publication = db.prepare('SELECT * FROM runner_publications WHERE runner_id = ?').get(runner.id);
    if (publication.desired_revision !== queue.revision || publication.desired_hash !== contentHash) {
      throw new RunnerPublicationError('runner_publication_superseded', 'Queue changed before its projection could be published; retry from the latest snapshot.');
    }

    plans.writeQueueProjection(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, queue.items,
      queue.customInstructions, runner.queue_file);

    // There are no async gaps between atomic replacement and this check, but the
    // version guard also protects future publishers that yield during I/O.
    const current = db.prepare('SELECT * FROM runner_publications WHERE runner_id = ?').get(runner.id);
    const latestQueue = runnerQueue.snapshot(runner.id);
    const latestHash = runnerQueue.publicationHash(latestQueue);
    if (current.desired_revision !== queue.revision || current.desired_hash !== contentHash ||
        latestQueue.revision !== queue.revision || latestHash !== contentHash) {
      throw new RunnerPublicationError('runner_publication_superseded', 'A newer queue revision replaced this projection while it was publishing.');
    }
    const runtime = db.prepare('SELECT state FROM runner_runtime WHERE runner_id = ?').get(runner.id);
    const markerRequired = !runtime || ['paused', 'waiting_input', 'held', 'complete', 'projection_error'].includes(runtime.state);
    plans.setQueuePausedMarker(agent, { ...project, plans_folder: project.plans_folder || 'plans' }, markerRequired);
    if (fs.existsSync(markerPath) !== markerRequired) {
      throw new RunnerPublicationError('runner_marker_publish_failed', `Could not publish the ${markerRequired ? 'paused' : 'running'} queue marker.`);
    }
    const stamp = new Date().toISOString();
    const acknowledged = db.prepare(`UPDATE runner_publications SET acknowledged_revision = ?, acknowledged_hash = ?,
      desired_marker = ?, error = NULL, updated_at = ? WHERE runner_id = ? AND desired_revision = ? AND desired_hash = ?`)
      .run(queue.revision, contentHash, markerRequired ? 1 : 0, stamp, runner.id, queue.revision, contentHash);
    if (!acknowledged.changes) {
      throw new RunnerPublicationError('runner_publication_superseded', 'Queue changed before publication acknowledgement.');
    }
    db.prepare('UPDATE infinite_runners SET marker_sync_error = NULL WHERE id = ?').run(runner.id);
    return { revision: queue.revision, hash: contentHash, path: projectionPath, markerRequired };
  } catch (error) {
    try {
      db.prepare('UPDATE runner_publications SET error = ?, updated_at = ? WHERE runner_id = ?')
        .run(error.message, new Date().toISOString(), runner.id);
    } catch { /* preserve the original publication failure */ }
    if (error instanceof RunnerPublicationError) throw error;
    throw new RunnerPublicationError('runner_publication_failed', `Could not publish runner queue: ${error.message}`);
  }
}

function publishMarker(runner, project, agent) {
  return withPublisherLease(runner.id, () => publishMarkerLatest(runner, project, agent));
}

function publishMarkerLatest(runner, project, agent) {
  const runtime = getDb().prepare('SELECT state FROM runner_runtime WHERE runner_id = ?').get(runner.id);
  const markerRequired = !runtime || ['paused', 'waiting_input', 'held', 'complete', 'projection_error'].includes(runtime.state);
  const scopedProject = { ...project, plans_folder: project.plans_folder || 'plans' };
  const markerPath = plans.queuePausedPath(agent, scopedProject);
  assertPathAvailable(runner.id, project, agent, runner.queue_file);
  claimPaths(runner.id, plans.queuePath(agent, scopedProject, runner.queue_file), markerPath);
  plans.setQueuePausedMarker(agent, scopedProject, markerRequired);
  if (fs.existsSync(markerPath) !== markerRequired) {
    const error = `Could not publish the ${markerRequired ? 'paused' : 'running'} queue marker.`;
    getDb().prepare('UPDATE runner_publications SET error = ?, updated_at = ? WHERE runner_id = ?')
      .run(error, new Date().toISOString(), runner.id);
    throw new RunnerPublicationError('runner_marker_publish_failed', error);
  }
  const ack = getDb().prepare(`UPDATE runner_publications SET desired_marker = ?, error = NULL, updated_at = ?
    WHERE runner_id = ? AND desired_marker = ?`).run(markerRequired ? 1 : 0, new Date().toISOString(), runner.id, markerRequired ? 1 : 0);
  if (!ack.changes) {
    throw new RunnerPublicationError('runner_marker_superseded', 'Runner state changed before its marker was acknowledged.');
  }
  getDb().prepare('UPDATE infinite_runners SET marker_sync_error = NULL WHERE id = ?').run(runner.id);
  return { markerRequired };
}

function read(runnerId) {
  return getDb().prepare('SELECT * FROM runner_publications WHERE runner_id = ?').get(runnerId) || null;
}

function invalidateAcknowledgement(runnerId) {
  return withPublisherLease(runnerId, () => getDb().prepare(`UPDATE runner_publications
    SET acknowledged_revision = NULL, acknowledged_hash = NULL, updated_at = ? WHERE runner_id = ?`)
    .run(new Date().toISOString(), runnerId).changes > 0);
}

module.exports = {
  RunnerPublicationError, assertPathAvailable, claimPaths, acquireLease, withPublisherLease,
  publish, publishMarker, read, invalidateAcknowledgement,
};
