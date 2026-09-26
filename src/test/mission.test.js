const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const { getDb } = require('../services/db');
const mission = require('../services/mission');

// The store runs against the real dev DB (like tasks.test.js), so each test
// clears only the mission tables and seeds the agents it needs.
const PADS = [
  ['pad-msn-oc', 'opencode', 'user-1'],
  ['pad-msn-cx', 'codex', 'user-1'],
  ['pad-msn-cl', 'claude', 'user-2'],
  ['pad-msn-pc', 'picoclaw', 'user-1'],
];

function seedPads() {
  const db = getDb();
  for (const [name, agent_type, owner_id] of PADS) {
    db.prepare(
      `INSERT OR REPLACE INTO agents (id, name, agent_type, runtime_type, runtime_ref, status, owner_id)
       VALUES (?, ?, ?, 'docker', ?, 'running', ?)`
    ).run(name, name, agent_type, name, owner_id);
  }
}

beforeEach(() => {
  seedPads();
  getDb().prepare('DELETE FROM mission_sessions').run();
  getDb().prepare('DELETE FROM mission_projects').run();
});

afterEach(() => {
  getDb().prepare('DELETE FROM mission_sessions').run();
  getDb().prepare('DELETE FROM mission_projects').run();
});

describe('Mission - schema', () => {
  it('creates mission_projects and mission_sessions with the documented columns', () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    assert.ok(tables.includes('mission_projects'), 'mission_projects exists');
    assert.ok(tables.includes('mission_sessions'), 'mission_sessions exists');
    const pcols = db.prepare('PRAGMA table_info(mission_projects)').all().map((c) => c.name);
    for (const c of ['id', 'name', 'agent_name', 'agent_type', 'folder', 'created_by', 'created_at', 'updated_at']) {
      assert.ok(pcols.includes(c), `mission_projects has ${c}`);
    }
    const scols = db.prepare('PRAGMA table_info(mission_sessions)').all().map((c) => c.name);
    for (const c of ['id', 'project_id', 'tmux_id', 'label', 'origin', 'locked', 'agent_session_id', 'created_at', 'last_seen_at']) {
      assert.ok(scols.includes(c), `mission_sessions has ${c}`);
    }
  });
});

describe('Mission - agent eligibility', () => {
  it('only the three coding drivers are supported', () => {
    assert.deepEqual(mission.supportedTypes().sort(), ['claude', 'codex', 'opencode']);
  });

  it('accepts a project on every coding driver', () => {
    for (const [name] of PADS.slice(0, 3)) {
      const p = mission.createProject({ name: `p-${name}`, agent: name, folder: '/www2/paddock' });
      assert.equal(p.agent_name, name);
    }
  });

  it('rejects a personal agent with mission_unsupported_agent', () => {
    assert.throws(
      () => mission.createProject({ name: 'nope', agent: 'pad-msn-pc', folder: '/www2/paddock' }),
      (e) => e.code === 'mission_unsupported_agent'
    );
  });

  it('rejects an agent that does not exist', () => {
    assert.throws(
      () => mission.createProject({ name: 'ghost', agent: 'pad-msn-ghost', folder: '/x' }),
      (e) => e.code === 'mission_agent_not_found' && e.status === 404
    );
  });
});

describe('Mission - projects', () => {
  it('defaults the folder to the driver workspace dir', () => {
    const p = mission.createProject({ name: 'defaulted', agent: 'pad-msn-cx' });
    assert.equal(p.folder, '/root/.codex/workspace');
  });

  it('lets one agent hold many projects on different folders', () => {
    mission.createProject({ name: 'a', agent: 'pad-msn-oc', folder: '/www1' });
    mission.createProject({ name: 'b', agent: 'pad-msn-oc', folder: '/www2' });
    const list = mission.listProjects({ agent: 'pad-msn-oc' });
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((p) => p.folder).sort(), ['/www1', '/www2']);
  });

  it('allows a duplicate (agent, folder) pair rather than blocking it', () => {
    mission.createProject({ name: 'one', agent: 'pad-msn-oc', folder: '/www1' });
    const dup = mission.createProject({ name: 'two', agent: 'pad-msn-oc', folder: '/www1' });
    assert.ok(dup.id);
    assert.equal(mission.listProjects({ agent: 'pad-msn-oc' }).length, 2);
  });

  it('rejects a relative folder and a non-empty name', () => {
    assert.throws(
      () => mission.createProject({ name: 'x', agent: 'pad-msn-oc', folder: 'relative/dir' }),
      (e) => e.code === 'mission_bad_folder'
    );
    assert.throws(
      () => mission.createProject({ name: '   ', agent: 'pad-msn-oc', folder: '/www1' }),
      (e) => e.code === 'mission_bad_name'
    );
  });

  it('trims a trailing slash so /www1 and /www1/ are the same folder', () => {
    const p = mission.createProject({ name: 'slash', agent: 'pad-msn-oc', folder: '/www1/' });
    assert.equal(p.folder, '/www1');
  });

  it('scopes the list to the agents a non-admin owns', () => {
    mission.createProject({ name: 'mine', agent: 'pad-msn-oc', folder: '/www1' });
    mission.createProject({ name: 'theirs', agent: 'pad-msn-cl', folder: '/www2' });
    assert.equal(mission.listProjects({ agents: ['pad-msn-oc'] }).length, 1);
    assert.equal(mission.listProjects({ agents: [] }).length, 0);
    assert.equal(mission.listProjects({}).length, 2);
  });

  it('renames and repoints a folder', () => {
    const p = mission.createProject({ name: 'before', agent: 'pad-msn-oc', folder: '/www1' });
    const after = mission.updateProject(p.id, { name: 'after', folder: '/www2' });
    assert.equal(after.name, 'after');
    assert.equal(after.folder, '/www2');
  });

  it('cascades sessions away with the project', () => {
    const p = mission.createProject({ name: 'cascades', agent: 'pad-msn-oc', folder: '/www1' });
    const s = mission.createSession(p.id);
    mission.deleteProject(p.id);
    assert.throws(() => mission.getSession(s.id), (e) => e.code === 'mission_session_not_found');
  });
});

describe('Mission - sessions', () => {
  it('mints a tmux name that app.js can pass to tmux unquoted', () => {
    const p = mission.createProject({ name: 's', agent: 'pad-msn-oc', folder: '/www1' });
    const s = mission.createSession(p.id);
    assert.match(s.tmux_id, /^msn-[0-9a-f]{8}$/);
    assert.ok(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s.tmux_id), 'matches SESSION_NAME_RE');
    assert.equal(s.origin, 'human');
    assert.equal(s.locked, 0);
  });

  it('records agent provenance without changing ownership semantics', () => {
    const p = mission.createProject({ name: 's', agent: 'pad-msn-oc', folder: '/www1' });
    const s = mission.createSession(p.id, { origin: 'agent', label: 'from the LLM' });
    assert.equal(s.origin, 'agent');
    assert.equal(s.label, 'from the LLM');
  });

  it('nests sessions under their project and counts them', () => {
    const p = mission.createProject({ name: 's', agent: 'pad-msn-oc', folder: '/www1' });
    mission.createSession(p.id);
    mission.createSession(p.id);
    const [project] = mission.listProjects({ agent: 'pad-msn-oc' });
    assert.equal(project.sessionCount, 2);
    assert.equal(project.sessions.length, 2);
  });

  it('refuses a writer on a solo-locked session but still reads it', () => {
    const p = mission.createProject({ name: 's', agent: 'pad-msn-oc', folder: '/www1' });
    const s = mission.createSession(p.id);
    assert.doesNotThrow(() => mission.assertNotLocked(s));
    const locked = mission.updateSession(s.id, { locked: true });
    assert.equal(locked.locked, 1);
    assert.ok(mission.getSession(s.id), 'a locked session is still readable');
    assert.throws(
      () => mission.assertNotLocked(mission.getSession(s.id)),
      (e) => e.code === 'mission_session_locked' && e.status === 409
    );
  });

  it('rejects a hand-rolled tmux name that is not ours', () => {
    const p = mission.createProject({ name: 's', agent: 'pad-msn-oc', folder: '/www1' });
    assert.throws(() => mission.createSession(p.id, { tmuxId: 'main' }), (e) => e.code === 'mission_bad_session');
  });

  it('never prunes anything on its own', () => {
    const p = mission.createProject({ name: 's', agent: 'pad-msn-oc', folder: '/www1' });
    for (let i = 0; i < 5; i++) mission.createSession(p.id);
    assert.equal(mission.listSessions({ projectId: p.id }).length, 5);
  });
});
