/**
 * Mission projects: a named folder on one PAD that sessions and runners belong to.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  getProject,
  listProjects,
  projectTag,
  createProject,
  updateProject,
  deleteProject,
});

const { getDb } = require('../db');
const { agentRow, assertMissionAgent, normalizeFolder, normalizePlansFolder, newId } = require('./internal');
const { MissionError } = require('./errors');
const { audit } = require('./sessions');

// ─── Projects ────────────────────────────────────────────────────────────────

/** Create a project. A project IS an (agent, folder) pair; many projects per
 *  agent is the normal case, so there is no uniqueness constraint — the caller
 *  may warn about an exact duplicate, we never block it. */
function createProject({ name, agent, folder, plansFolder, createdBy = null, defaultFolder = '' }) {
  const projectName = String(name || '').trim();
  if (!projectName) throw new MissionError('mission_bad_name', 'A project needs a name');
  if (projectName.length > 120) throw new MissionError('mission_bad_name', 'Project name is too long');

  const agentName = String(agent || '').trim();
  const row = agentRow(agentName);
  const driver = assertMissionAgent(row.agent_type);

  const dir = normalizeFolder(folder || defaultFolder || driver.workspaceDir || '');
  const plansDir = normalizePlansFolder(plansFolder);

  const id = newId('prj');
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO mission_projects (id, name, agent_name, agent_type, folder, plans_folder, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(id, projectName, row.name, row.agent_type, dir, plansDir, createdBy, now, now);
  const project = getProject(id);
  audit(project, 'project_create', { actor: createdBy, details: dir });
  return project;
}

function getProject(id) {
  const row = getDb().prepare('SELECT * FROM mission_projects WHERE id = ?').get(String(id || ''));
  if (!row) throw new MissionError('mission_project_not_found', 'No such project', 404);
  return row;
}

/** Every project, with its sessions nested and a live flag per session when the
 *  caller supplies `isLive(sessionRow)`. The store never talks to docker; the
 *  route layer passes the liveness probe in. */
function listProjects({ agent = '', agents = null, createdBy = null, isLive = null } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (agent) { where.push('p.agent_name = ?'); params.push(String(agent)); }
  // Ownership scoping: a non-admin only ever sees projects on PADs they own, so
  // the route passes the allowed agent names in rather than the service knowing
  // anything about users.
  if (Array.isArray(agents)) {
    if (!agents.length) return [];
    where.push(`p.agent_name IN (${agents.map(() => '?').join(',')})`);
    params.push(...agents);
  }
  const rows = db
    .prepare(`SELECT p.* FROM mission_projects p${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY p.created_at DESC, p.name COLLATE NOCASE`)
    .all(...params);
  // `rowid ASC` is the tiebreaker for rows created in the same millisecond, and
  // it is not cosmetic: `created_at` alone leaves tied rows in whatever order
  // the query plan happens to produce, which is a function of the table's
  // physical layout. Any UPDATE (including the `last_seen_at` touch below) can
  // move a row and reshuffle its neighbours, so a session list that a user was
  // reading can reorder itself on a poll. Insertion order is the tie order the
  // listings have always shown, so state it rather than inherit it.
  const sessions = db.prepare('SELECT * FROM mission_sessions ORDER BY created_at DESC, rowid ASC').all();
  return rows.map((p) => withSessions(p, sessions.filter((s) => s.project_id === p.id), isLive));
}

function withSessions(project, sessions, isLive) {
  return {
    ...project,
    sessions: sessions.map((s) => ({ ...s, live: isLive ? !!isLive(s, project) : null })),
    sessionCount: sessions.length,
    liveCount: isLive ? sessions.filter((s) => isLive(s, project)).length : null,
  };
}

/** Rename and/or repoint the folder. Repointing deliberately does NOT touch
 *  live sessions (open question 1) — it applies to sessions created after the
 *  change. */
function updateProject(id, { name, folder, plansFolder } = {}) {
  const project = getProject(id);
  const sets = [];
  const params = [];
  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) throw new MissionError('mission_bad_name', 'A project needs a name');
    sets.push('name = ?');
    params.push(n);
  }
  if (folder !== undefined) {
    sets.push('folder = ?');
    params.push(normalizeFolder(folder));
  }
  if (plansFolder !== undefined) {
    sets.push('plans_folder = ?');
    params.push(normalizePlansFolder(plansFolder));
  }
  if (!sets.length) return project;
  sets.push("updated_at = ?");
  params.push(new Date().toISOString(), project.id);
  getDb().prepare(`UPDATE mission_projects SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProject(id);
}

/** Delete a project. Its tmux sessions are the caller's business (the route
 *  kills them first, so a delete never leaves an orphan TUI running). */
function deleteProject(id) {
  const project = getProject(id);
  // The project's runners go with it (foreign key), but their working state is
  // in tables no key reaches: remove that too.
  const runnerIds = getDb().prepare('SELECT id FROM infinite_runners WHERE project_id = ?').all(project.id).map((row) => row.id);
  getDb().prepare('DELETE FROM mission_sessions WHERE project_id = ?').run(project.id);
  getDb().prepare('DELETE FROM mission_projects WHERE id = ?').run(project.id);
  for (const runnerId of runnerIds) require('../runner-callbacks').purgeRunnerState(runnerId);
  return project;
}

function projectTag(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    agent_name: p.agent_name,
    agent_type: p.agent_type,
    folder: p.folder,
  };
}
