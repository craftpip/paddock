const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// This suite CLEARS the mission tables (see cleanup below), so it used to run
// against the live dev database and take the user's real projects and sessions
// with it — the reason AGENTS.md carried a "back up app.db first" warning. Point
// it at a throwaway database instead: same code path, same migrations, none of
// the user's rows at risk. Set BEFORE requiring anything that loads db.js, which
// reads the path at module load.
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-mission-'));
process.env.PAD_DB_PATH = path.join(DB_DIR, 'mission.test.db');
process.on('exit', () => fs.rmSync(DB_DIR, { recursive: true, force: true }));

const { getDb } = require('../services/db');
const mission = require('../services/mission');

// A throwaway DB, so the "real dev DB" the comment below referred to is no
// longer true — what matters now is that each test clears the mission tables of
// THIS database and seeds the agents it needs.
const PADS = [
  ['pad-msn-oc', 'opencode', 'user-1'],
  ['pad-msn-oc2', 'opencode', 'user-1'],
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

describe('Mission - project folder probe', () => {
  const workspace = require('../services/workspace');
  const real = workspace.listFolders;
  let calls = [];

  beforeEach(() => {
    calls = [];
    workspace.listFolders = async (agentName, path) => {
      calls.push({ agentName, path });
      return { path, exists: true, isDir: true, entries: ['craftpip.com', 'paddock'] };
    };
  });

  afterEach(() => {
    workspace.listFolders = real;
  });

  it('reports what the PAD can actually see, with sibling folders', async () => {
    const out = await mission.projectFolders('pad-msn-oc', '/www1');
    assert.equal(out.exists, true);
    assert.equal(out.isDir, true);
    assert.deepEqual(out.entries, ['craftpip.com', 'paddock']);
    assert.deepEqual(calls, [{ agentName: 'pad-msn-oc', path: '/www1' }]);
  });

  it('normalizes a trailing slash before probing', async () => {
    const out = await mission.projectFolders('pad-msn-oc', '/www1/');
    assert.equal(out.path, '/www1');
    assert.equal(calls[0].path, '/www1');
  });

  it('passes a missing folder through as exists:false instead of throwing', async () => {
    workspace.listFolders = async (agentName, path) => ({ path, exists: false, isDir: false, entries: [] });
    const out = await mission.projectFolders('pad-msn-oc', '/nope');
    assert.equal(out.exists, false);
    assert.deepEqual(out.entries, []);
  });

  it('refuses a personal agent — Mission is coding models only', async () => {
    await assert.rejects(
      () => mission.projectFolders('pad-msn-pc', '/www1'),
      (e) => e.code === 'mission_unsupported_agent'
    );
    assert.equal(calls.length, 0, 'never probes a pad the dialog would not offer');
  });

  it('refuses a stopped agent and a missing one', async () => {
    getDb().prepare("UPDATE agents SET status='stopped' WHERE name='pad-msn-oc'").run();
    await assert.rejects(
      () => mission.projectFolders('pad-msn-oc', '/www1'),
      (e) => e.code === 'mission_agent_stopped'
    );
    getDb().prepare('UPDATE agents SET status=? WHERE name=?').run('running', 'pad-msn-oc');
    await assert.rejects(
      () => mission.projectFolders('pad-ghost', '/www1'),
      (e) => e.code === 'mission_agent_not_found' && e.status === 404
    );
  });

  it('needs a folder to probe', async () => {
    await assert.rejects(
      () => mission.projectFolders('pad-msn-oc', ''),
      (e) => e.code === 'mission_bad_folder'
    );
  });
});

// The agent's own history is what makes a project show the conversations you
// already had in that folder, instead of an empty column. These pin the shape
// it comes back in and — just as important — that it never reads a PAD the
// Mission dialog would not offer.
describe('Mission - agent history', () => {
  const workspace = require('../services/workspace');
  const real = workspace.listAgentSessions;
  let calls = [];

  const sample = {
    source: 'opencode',
    available: true,
    total: 888,
    exactCount: 9,
    subfolderCount: 693,
    exact: [
      { id: 'ses_a', title: 'Running dev server', directory: '/www1/craftpip.com', updatedAt: '2026-09-13T23:00:06.612Z' },
      { id: 'ses_b', title: 'Friendly greeting', directory: '/www1/craftpip.com', updatedAt: '2026-08-23T18:57:28.421Z' },
    ],
    subfolders: [{ id: 'ses_c', title: 'Dashboard queue', directory: '/www1/xdl', updatedAt: '2026-09-26T20:48:54.000Z' }],
  };

  beforeEach(() => {
    calls = [];
    workspace.listAgentSessions = async (agentName, type, folder, limit) => {
      calls.push({ agentName, type, folder, limit });
      return sample;
    };
  });

  afterEach(() => {
    workspace.listAgentSessions = real;
  });

  it('returns the conversations that ran in the project folder', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const h = await mission.agentHistory(p.id);
    assert.equal(h.available, true);
    assert.equal(h.exactCount, 9);
    assert.equal(h.subfolderCount, 693);
    assert.equal(h.exact.length, 2);
    assert.equal(h.exact[0].id, 'ses_a');
    assert.deepEqual(calls, [
      { agentName: 'pad-msn-oc', type: 'opencode', folder: '/www1/craftpip.com', limit: 50 },
    ]);
  });

  it('withholds subfolder conversations unless asked — 693 of them is not a default', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1' });
    const narrow = await mission.agentHistory(p.id);
    assert.deepEqual(narrow.subfolders, []);
    assert.equal(narrow.subfolderCount, 693, 'but still counts them so the UI can offer the toggle');
    const wide = await mission.agentHistory(p.id, { includeSubfolders: true });
    assert.equal(wide.subfolders.length, 1);
  });

  it('passes the limit through', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1' });
    await mission.agentHistory(p.id, { limit: 5 });
    assert.equal(calls[0].limit, 5);
  });

  it('treats "this agent has no history yet" as a normal answer, not an error', async () => {
    workspace.listAgentSessions = async () => ({ source: 'claude', available: false, reason: 'no-store' });
    const p = mission.createProject({ name: 'cc', agent: 'pad-msn-cl', folder: '/root/.claude/workspace' });
    const h = await mission.agentHistory(p.id);
    assert.equal(h.available, false);
    assert.equal(h.reason, 'no-store');
    assert.deepEqual(h.exact, []);
  });

  it('refuses a personal agent without reading its store', async () => {
    // A project snapshots its agent_type at creation, so the gate reads the
    // project row: flip THAT to a personal type and the history read must be
    // refused before anything is opened in the PAD.
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1' });
    getDb().prepare("UPDATE mission_projects SET agent_type = 'picoclaw' WHERE id = ?").run(p.id);
    await assert.rejects(
      () => mission.agentHistory(p.id),
      (e) => e.code === 'mission_unsupported_agent'
    );
    assert.equal(calls.length, 0);
  });

  it('refuses a stopped PAD — its files cannot be read', async () => {
    getDb().prepare("UPDATE agents SET status = 'stopped' WHERE name = 'pad-msn-oc'").run();
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1' });
    await assert.rejects(() => mission.agentHistory(p.id), (e) => e.code === 'mission_agent_stopped');
    assert.equal(calls.length, 0);
  });

  it('turns a read failure into a MissionError', async () => {
    workspace.listAgentSessions = async () => ({ error: 'Container is not running' });
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1' });
    await assert.rejects(
      () => mission.agentHistory(p.id),
      (e) => e.code === 'mission_history_failed' && e.status === 500
    );
  });
});

// The "All projects" scope (plan 53 Phase 6). Two separate risks, so two
// separate guarantees: the merged read must tag every row with its project (or
// the UI cannot tell two rows apart, and clicking one opens the wrong PAD), and
// ONE failing project must never blank the other projects' conversations.
describe('Mission - the all-projects scope', () => {
  const workspace = require('../services/workspace');
  const realListAgentSessions = workspace.listAgentSessions;
  let perAgent;

  const conv = (id, updatedAt, directory) => ({
    source: 'opencode',
    available: true,
    total: 3,
    exactCount: 1,
    subfolderCount: 1,
    exact: [{ id, title: `t-${id}`, directory, updatedAt }],
    subfolders: [{ id: `sub-${id}`, title: `sub-${id}`, directory: `${directory}/lib`, updatedAt }],
  });

  beforeEach(() => {
    perAgent = {
      'pad-msn-oc': conv('ses_a', '2026-09-13T23:00:06.612Z', '/www1/craftpip.com'),
      'pad-msn-oc2': conv('ses_b', '2026-09-26T20:48:54.000Z', '/www1/xdl'),
    };
    workspace.listAgentSessions = async (agentName) => perAgent[agentName] || { available: false, reason: 'no-store' };
  });

  afterEach(() => {
    workspace.listAgentSessions = realListAgentSessions;
  });

  it('tags every session with the project it belongs to', () => {
    const a = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const b = mission.createProject({ name: 'xl', agent: 'pad-msn-oc2', folder: '/www1/xdl' });
    mission.createSession(a.id, { tmuxId: 'msn-1111aaaa' });
    mission.createSession(b.id, { tmuxId: 'msn-2222bbbb' });

    const all = mission.listAllSessions();
    assert.equal(all.sessions.length, 2);
    assert.equal(all.projects.length, 2);
    // A row without its project is unusable in this view: two sessions both
    // labelled by tmux id cannot be told apart, and a click cannot be trusted to
    // open the right PAD.
    assert.deepEqual(
      all.sessions.map((s) => [s.tmux_id, s.project.name, s.project.folder]).sort(),
      [['msn-1111aaaa', 'cp', '/www1/craftpip.com'], ['msn-2222bbbb', 'xl', '/www1/xdl']]
    );
  });

  it('hides another user\'s projects from the aggregate', () => {
    const a = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1' });
    const b = mission.createProject({ name: 'xl', agent: 'pad-msn-oc2', folder: '/www1/xdl' });
    mission.createSession(a.id, { tmuxId: 'msn-1111aaaa' });
    mission.createSession(b.id, { tmuxId: 'msn-2222bbbb' });

    const seen = [];
    const all = mission.listAllSessions({ allow: (agentName) => agentName === 'pad-msn-oc' });
    all.sessions.forEach((s) => seen.push(s.tmux_id));
    all.projects.forEach((p) => seen.push(p.name));
    assert.deepEqual(seen.sort(), ['cp', 'msn-1111aaaa']);
  });

  it('merges every project\'s conversations, newest first, each tagged', async () => {
    mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    mission.createProject({ name: 'xl', agent: 'pad-msn-oc2', folder: '/www1/xdl' });

    const h = await mission.allAgentHistory({ limit: 50 });
    assert.equal(h.projectCount, 2);
    // The subfolder entries are tagged too, and the whole merge is ONE date
    // order — sorting per project and concatenating would show three months of
    // one project above a conversation from yesterday in another.
    const dates = h.conversations.map((c) => c.updatedAt);
    assert.deepEqual(dates, [...dates].sort().reverse());
    assert.deepEqual(
      h.conversations.filter((c) => !c.subfolder).map((c) => [c.id, c.project.name]).sort(),
      [['ses_a', 'cp'], ['ses_b', 'xl']]
    );
    // With subfolders NOT expanded the rows are absent but the COUNT is not:
    // that count is what renders the expander, so deriving it from the loaded
    // rows would hide the 693 conversations and the button that reveals them.
    assert.equal(h.exactCount, 2);
    assert.equal(h.subfolderCount, 2);
    assert.equal(h.conversations.length, 2);
    assert.equal(h.available, true);
    assert.equal(h.errors.length, 0);

    const wide = await mission.allAgentHistory({ limit: 50, includeSubfolders: true });
    assert.equal(wide.conversations.length, 4);
    assert.equal(wide.subfolderCount, 2);
    assert.ok(wide.conversations.filter((c) => c.subfolder).every((c) => c.project.name));
  });

  it('reports one unreadable project and still lists the others', async () => {
    mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    mission.createProject({ name: 'cc', agent: 'pad-msn-cl', folder: '/root/.claude/workspace' });

    // A stopped PAD rejects; the other project's conversations must survive it —
    // the whole point of Promise.allSettled here.
    getDb().prepare("UPDATE agents SET status = 'stopped' WHERE name = 'pad-msn-oc'").run();
    const h = await mission.allAgentHistory({ limit: 50 });
    assert.deepEqual(h.conversations.map((c) => c.id), []);
    // Nothing was readable, so "no history yet" must NOT be the answer — the
    // errors are.
    assert.equal(h.available, false);
    assert.equal(h.errors.length, 2);
    // Both an unreadable project and an agent with no store are REPORTED, so the
    // column can say which project is missing what instead of looking empty.
    assert.ok(h.errors.some((e) => e.project.name === 'cp' && /not running/i.test(e.error)));
    assert.ok(h.errors.some((e) => e.project.name === 'cc' && e.error === 'no-store'));
  });

  it('excludes projects the caller may not touch', async () => {
    mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    mission.createProject({ name: 'xl', agent: 'pad-msn-oc2', folder: '/www1/xdl' });
    const h = await mission.allAgentHistory({ allow: (agentName) => agentName === 'pad-msn-oc' });
    assert.equal(h.projectCount, 1);
    assert.equal(h.conversations.length, 1);
    assert.equal(h.conversations[0].id, 'ses_a');
    assert.equal(h.conversations[0].project.name, 'cp');
  });

  it('stamps live per PAD, not per project', async () => {
    const padTmux = require('../services/pad-tmux');
    const real = padTmux.listSessions;
    const asked = [];
    // Two projects on the SAME PAD must cost ONE tmux call — asking per project
    // would make the aggregate read scale with the project count instead of the
    // PAD count, and ask the wrong container for the wrong sessions.
    padTmux.listSessions = async (vm) => {
      asked.push(vm);
      return vm === 'pad-msn-oc' ? [{ name: 'msn-1111aaaa' }] : [];
    };
    try {
      const a = mission.createProject({ name: 'cp1', agent: 'pad-msn-oc', folder: '/www1/a' });
      const b = mission.createProject({ name: 'cp2', agent: 'pad-msn-oc', folder: '/www1/b' });
      const c = mission.createProject({ name: 'xl', agent: 'pad-msn-oc2', folder: '/www1/xdl' });
      mission.createSession(a.id, { tmuxId: 'msn-1111aaaa' });
      mission.createSession(b.id, { tmuxId: 'msn-2222bbbb' });
      mission.createSession(c.id, { tmuxId: 'msn-3333cccc' });

      const all = mission.listAllSessions();
      const live = await mission.withLiveSessionsByAgent(all.sessions, (s) => s.project?.agent_name);
      // Compare as a LOOKUP, not a sequence. The three sessions are created back
      // to back, so whether they share a `created_at` millisecond is up to the
      // clock: when they do, the `rowid` tiebreaker keeps insertion order; when
      // they do not, `created_at DESC` is the intended newest-first order. Both
      // are correct, and asserting one exact sequence made this test fail on
      // timing alone — the "one call per PAD" claim is what it is here to prove.
      const stamped = new Map(live.map((s) => [s.tmux_id, s.live]));
      assert.strictEqual(stamped.get('msn-1111aaaa'), true, 'the PAD reporting the session has it live');
      assert.strictEqual(stamped.get('msn-2222bbbb'), false, 'and the others are not invented');
      assert.strictEqual(stamped.get('msn-3333cccc'), false);
      assert.deepEqual(asked.sort(), ['pad-msn-oc', 'pad-msn-oc2'], 'exactly one call per PAD');
      assert.strictEqual(asked.length, 2, 'not one per project, and not a duplicate per session');
    } finally {
      padTmux.listSessions = real;
    }
  });
});

// Resuming is the whole point of listing history: `opencode -s <id>` in a tmux
// pane rooted at the project folder, with the id kept on the row so a relaunch
// after the TUI dies comes back to the SAME conversation.
describe('Mission - resuming a conversation', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let sent = [];
  let killed = [];

  beforeEach(() => {
    sent = [];
    killed = [];
    padTmux.folderExists = async () => true;
    padTmux.createSession = async () => {};
    padTmux.killSession = async (vm, tid) => { killed.push(tid); };
    padTmux.sendCommand = async (vm, tid, cmd) => { sent.push(cmd); };
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, cwd: '/www1/craftpip.com' });
  });

  afterEach(() => {
    for (const k of ['folderExists', 'createSession', 'killSession', 'sendCommand', 'paneState']) {
      padTmux[k] = real[k];
    }
  });

  it('launches the resume command and remembers the agent session id', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, { agentSessionId: 'ses_abc' });
    assert.equal(session.agent_session_id, 'ses_abc');
    assert.deepEqual(sent, ['opencode -s ses_abc']);
  });

  it('starts fresh when no conversation is named', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    assert.equal(session.agent_session_id, null);
    assert.deepEqual(sent, ['opencode']);
  });

  it('codex and claude resume in their own dialects', async () => {
    const cx = mission.createProject({ name: 'cx', agent: 'pad-msn-cx', folder: '/root/.codex/workspace' });
    await mission.startSession(cx.id, { agentSessionId: '01a0d312' });
    assert.deepEqual(sent, ['codex resume 01a0d312']);
    const cl = mission.createProject({ name: 'cl', agent: 'pad-msn-cl', folder: '/root/.claude/workspace' });
    await mission.startSession(cl.id, { agentSessionId: 'cl-1' });
    assert.deepEqual(sent[1], 'claude -r cl-1');
  });

  it('comes back to the same conversation when the TUI has to be relaunched', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, { agentSessionId: 'ses_abc' });
    sent = [];
    // The TUI exited, the pane fell back to the shell: tuiAlive false.
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, cwd: '/www1/craftpip.com' });
    await mission.relaunchTui(session.id);
    assert.deepEqual(sent, ['opencode -s ses_abc'], 'a relaunch must not orphan the history');
  });

  it('relaunches a fresh session as fresh', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    sent = [];
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, cwd: '/www1/craftpip.com' });
    await mission.relaunchTui(session.id);
    assert.deepEqual(sent, ['opencode']);
  });

  it('leaves no row behind when the TUI never launched', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    padTmux.sendCommand = async () => { throw new Error('tmux exploded'); };
    await assert.rejects(() => mission.startSession(p.id, {}));
    assert.equal(mission.listSessions({ projectId: p.id }).length, 0);
    assert.equal(killed.length, 1, 'and the tmux session it made is cleaned up');
  });

  // A pane can end up in the wrong directory without anyone noticing: kill the
  // tmux session and a terminal attaching to it re-creates it in the PAD's
  // default dir, and the launch commands are deliberately bare (the
  // CommandsPane pastes them into whatever pane the user is in). The machine
  // path has to put it back, or the agent works one level too high.
  it('changes to the project folder when the pane is in the wrong directory', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, { agentSessionId: 'ses_abc' });
    sent = [];
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, cwd: '/www1' });
    await mission.relaunchTui(session.id);
    assert.deepEqual(sent, ["cd '/www1/craftpip.com' && opencode -s ses_abc"]);
  });

  it('leaves the command alone when the pane is already in the project folder', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, { agentSessionId: 'ses_abc' });
    sent = [];
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, cwd: '/www1/craftpip.com' });
    await mission.relaunchTui(session.id);
    assert.deepEqual(sent, ['opencode -s ses_abc']);
  });

  it('quotes a folder with a space or quote in it', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: "/www1/it's here" });
    const { session } = await mission.startSession(p.id, {});
    sent = [];
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, cwd: '/www1' });
    await mission.relaunchTui(session.id);
    assert.deepEqual(sent, ["cd '/www1/it'\\''s here' && opencode"]);
  });
});

// Restart is the OTHER half of "the pane is gone": relaunch only re-runs the
// TUI inside a session that is still there, and refuses a dead one on purpose.
// Restart re-creates that same pane — same tmux name, same mission row, same
// agent conversation — rooted at the project folder.
describe('Mission - restarting a dead session', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let sent = [];
  let created = [];
  let killed = [];
  let folderOk = true;

  beforeEach(() => {
    sent = [];
    created = [];
    killed = [];
    folderOk = true;
    padTmux.folderExists = async () => folderOk;
    padTmux.createSession = async (vm, tid, opts) => { created.push({ tmux: tid, cwd: opts && opts.cwd }); };
    padTmux.killSession = async (vm, tid) => { killed.push(tid); };
    padTmux.sendCommand = async (vm, tid, cmd) => { sent.push(cmd); };
    padTmux.paneState = async () => ({ live: false, tuiAlive: false, cwd: '', reason: 'no-session' });
  });

  afterEach(() => {
    for (const k of ['folderExists', 'createSession', 'killSession', 'sendCommand', 'paneState']) {
      padTmux[k] = real[k];
    }
  });

  it('re-creates the same pane in the project folder and reopens the conversation', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, { agentSessionId: 'ses_abc' });
    sent = [];
    created = [];
    const r = await mission.restartSession(session.id);
    assert.deepEqual(created, [{ tmux: session.tmux_id, cwd: '/www1/craftpip.com' }], 'rooted at the project folder');
    assert.deepEqual(sent, ['opencode -s ses_abc'], 'same conversation, not a fresh one');
    assert.equal(r.session.id, session.id, 'and the same mission row — a restart is not a new session');
  });

  it('replaces a live-but-empty pane rather than typing into it', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    sent = [];
    created = [];
    killed = [];
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, cwd: '/www1' });
    await mission.restartSession(session.id);
    assert.deepEqual(killed, [session.tmux_id]);
    assert.deepEqual(created, [{ tmux: session.tmux_id, cwd: '/www1/craftpip.com' }]);
  });

  it('refuses when a TUI is already running — that is relaunch, not restart', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, cwd: '/www1/craftpip.com' });
    await assert.rejects(
      () => mission.restartSession(session.id),
      (e) => e.code === 'mission_tui_already_running' && e.status === 409
    );
  });

  it('refuses a missing folder instead of restarting in the wrong one', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, { agentSessionId: 'ses_abc' });
    sent = [];
    created = [];
    folderOk = false;
    await assert.rejects(
      () => mission.restartSession(session.id),
      (e) => e.code === 'mission_folder_missing' && e.status === 409
    );
    assert.deepEqual(created, [], 'nothing half-created');
    assert.deepEqual(sent, [], 'and no TUI launched into the wrong directory');
  });
});

describe('Mission - finding a session by its tmux id', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };

  beforeEach(() => {
    padTmux.folderExists = async () => true;
    padTmux.createSession = async () => {};
    padTmux.sendCommand = async () => {};
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, cwd: '' });
  });

  afterEach(() => {
    for (const k of ['folderExists', 'createSession', 'sendCommand', 'paneState']) {
      padTmux[k] = real[k];
    }
  });

  it('finds a live session and returns null once it is closed', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    const found = mission.getSessionByTmux(session.tmux_id);
    assert.ok(found, 'the terminal WebSocket identifies a session by tmux id');
    assert.equal(found.id, session.id);
    mission.deleteSession(session.id);
    // The WS is allowed to lazily re-create a missing tmux session, so a closed
    // session has to be recognised as gone or "Close" un-does itself.
    assert.equal(mission.getSessionByTmux(session.tmux_id), null);
  });

  it('ignores anything that is not a mission session name', () => {
    assert.equal(mission.getSessionByTmux('term-1'), null, 'agent terminals are not mission sessions');
    assert.equal(mission.getSessionByTmux(''), null);
    assert.equal(mission.getSessionByTmux(null), null);
    assert.equal(mission.getSessionByTmux('msn-x/../etc'), null, 'and it cannot be used to probe other names');
  });
});

describe('Mission - openCount is a count, not a maybe', () => {
  it('reports 0 for a project that has no sessions at all', async () => {
    // The early `return projects` this replaced skipped the counting as well as
    // the probe, so a project with zero sessions came back with NO `openCount` —
    // a field that is present on its neighbours and missing here reads as
    // "unknown", and a caller who guards for that is how the count goes unused.
    const p = mission.createProject({ name: 'empty-probe', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const [row] = await mission.withAgentBusyProjects([{ id: p.id, agent_name: p.agent_name, folder: p.folder, sessions: [] }]);
    assert.strictEqual(row.openCount, 0, 'zero sessions is definitively zero open');

    // Same when the whole fleet is empty — the probe has nothing to do, but the
    // count is still an answer.
    const [only] = await mission.withAgentBusyProjects([{ id: p.id, agent_name: p.agent_name, folder: p.folder, sessions: [] }]);
    assert.strictEqual(only.openCount, 0);

    // A project the caller never loaded sessions for gets no opinion, because we
    // did not look — that is the one case where the field is correctly absent.
    const [unknown] = await mission.withAgentBusyProjects([{ id: p.id, agent_name: p.agent_name, folder: p.folder }]);
    assert.strictEqual('openCount' in unknown, false, 'no sessions supplied means no claim');
  });
});

// Plan 62: `live` / `busy` / `busyKnown` / `open` were three fields computed in
// two places, so they could disagree — most dangerously, a DEAD row reporting
// `busy: true, open: true` while `mission_send` refused it. These pin the one
// truth function both the list and detail paths now share.
describe('Mission - liveness must not lie (plan 62)', () => {
  const stamp = (s, probe) => mission.stampTruth(s, { ids: new Set(), known: true, ...probe });
  const busySet = (id) => ({ ids: new Set([id]), known: true });

  it('a dead row is never busy and never open, however hard the server claims', () => {
    const dead = stamp({ id: 'msn_a', live: false, agent_session_id: 'ses_x' }, busySet('ses_x'));
    assert.strictEqual(dead.busy, false, 'a corpse cannot be working');
    assert.strictEqual(dead.open, false, 'and open must not count a row send refuses');
    assert.strictEqual(dead.state, 'dead', 'the corpse says so');
    // The forensics survive without contaminating `busy`.
    assert.strictEqual(dead.wasBusy, true, 'the server still claims the conversation');
  });

  it('a live row the server calls busy is busy and open', () => {
    const row = stamp({ id: 'msn_b', live: true, agent_session_id: 'ses_y', cwd: '/w' }, busySet('ses_y'));
    assert.strictEqual(row.busy, true);
    assert.strictEqual(row.open, true);
    assert.strictEqual(row.busyKnown, true);
  });

  it('a live SHELL pane is not open, because a send there runs commands', () => {
    const row = stamp({ id: 'msn_c', live: true, tuiAlive: false, kind: 'shell', agent_session_id: 'ses_z' }, busySet('ses_z'));
    assert.strictEqual(row.open, false, 'open means "a send would be accepted"');
    assert.strictEqual(row.busy, false, 'a shell is not working on anything');
  });

  it('a pane running in ANOTHER folder is UNKNOWN, never idle', () => {
    // The probe is scoped to the project folder; this pane is not in it, so the
    // answer describes a different conversation. `busyKnown: true` here would
    // read as "genuinely idle" and become licence to type.
    const row = stamp({ id: 'msn_d', live: true, folder: '/proj', cwd: '/elsewhere', agent_session_id: 'ses_w' }, busySet('ses_w'));
    assert.strictEqual(row.busyKnown, false, 'a mismatched cwd cannot answer for this folder');
    assert.strictEqual(row.busy, false);
  });

  it('an unanswerable probe never yields busyKnown: true', () => {
    const row = mission.stampTruth(
      { id: 'msn_e', live: true, folder: '/proj', cwd: '/proj', agent_session_id: 'ses_v' },
      { ids: new Set(), known: false }
    );
    assert.strictEqual(row.busyKnown, false, 'unknown, not idle');
  });

  it('a row with no agent conversation is never busy, whatever the probe holds', () => {
    const row = stamp({ id: 'msn_f', live: true, agent_session_id: null, cwd: '/p' }, busySet('ses_u'));
    assert.strictEqual(row.busy, false, 'no id to match means no claim to make');
  });
});

// The pane map is what lets list mode say "shell" BEFORE a caller types into it.
describe('Mission - list mode knows what is in the pane (plan 62 1b)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };

  afterEach(() => {
    for (const k of ['listSessions', 'listPanes']) padTmux[k] = real[k];
  });

  it('carries kind agent/shell and the pane cwd, in one pane-map call', async () => {
    const p = mission.createProject({ name: 'kinds', agent: 'pad-msn-oc', folder: '/www1/kinds' });
    const shell = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    const agent = mission.createSession(p.id, { tmuxId: 'msn-2222bbbb' });
    let paneCalls = 0;
    padTmux.listSessions = async () => [{ name: 'msn-1111aaaa' }, { name: 'msn-2222bbbb' }];
    padTmux.listPanes = async () => {
      paneCalls++;
      return new Map([
        ['msn-1111aaaa', { command: 'bash', cwd: '/www1/kinds' }],
        ['msn-2222bbbb', { command: 'node', cwd: '/www1/kinds' }],
      ]);
    };
    const rows = await mission.withLiveSessions([shell, agent], p.agent_name);
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.strictEqual(byId.get(shell.id).kind, 'shell', 'a bash pane is a shell');
    assert.strictEqual(byId.get(shell.id).tuiAlive, false);
    assert.strictEqual(byId.get(agent.id).kind, 'agent', 'an opencode pane reports node');
    assert.strictEqual(byId.get(agent.id).tuiAlive, true);
    assert.strictEqual(byId.get(agent.id).cwd, '/www1/kinds');
    assert.strictEqual(paneCalls, 1, 'one pane map per PAD, not per session');
  });

  it('leaves kind absent when the pane map could not answer, rather than guessing', async () => {
    const p = mission.createProject({ name: 'nokind', agent: 'pad-msn-oc', folder: '/www1/nokind' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-3333cccc' });
    padTmux.listSessions = async () => [{ name: 'msn-3333cccc' }];
    padTmux.listPanes = async () => new Map();
    const [row] = await mission.withLiveSessions([s], p.agent_name);
    assert.strictEqual(row.live, true, 'liveness still answered');
    assert.strictEqual('kind' in row, false, 'kind is a claim, and we could not make one');
  });
});

// A write is the destructive action, so the refusals are the contract.
describe('Mission - send refuses what it cannot type into (plan 62 1b/1c/1h)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let typed = 0;
  let keys = [];
  let screenText = 'the prompt\nwaiting';

  beforeEach(() => {
    typed = 0;
    keys = [];
    screenText = 'the prompt\nwaiting';
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'node', cwd: '/www1/a' });
    padTmux.captureScreen = async () => ({ text: screenText, live: true });
    padTmux.sendText = async (vm, tid, body) => {
      typed++;
      // A real TUI ECHOES what it received, so its screen changes. A fake that
      // returns a frozen string is not a TUI, it is a black hole — and with the
      // 1h confirmation in place a black hole is now correctly refused, which is
      // the whole reason the confirmation exists.
      screenText = `the prompt\n> ${body}\nwaiting`;
      return { lines: 1 };
    };
    padTmux.sendKeys = async (vm, tid, ks) => { keys.push(ks); return { keys: ks.length }; };
  });

  afterEach(() => {
    for (const k of ['hasSession', 'paneState', 'captureScreen', 'sendText', 'sendKeys']) padTmux[k] = real[k];
  });

  it('refuses a shell pane with the command named, and types nothing', async () => {
    const p = mission.createProject({ name: 'sh', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, command: 'bash', cwd: '/www1/a' });
    await assert.rejects(
      () => mission.sendText(s.id, 'ls -la'),
      (e) => e.code === 'mission_not_an_agent' && /bash/.test(e.message)
    );
    assert.strictEqual(typed, 0, 'no text reached a shell');
  });

  it('refuses a pane parked on a permission prompt, naming the tool and path', async () => {
    const p = mission.createProject({ name: 'perm', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-2222bbbb' });
    screenText = '△ Permission required\n→ Read .env\nPath: .env\nAllow once  Allow always  Reject\n⇆ select  enter confirm';
    await assert.rejects(
      () => mission.sendText(s.id, 'carry on'),
      (e) => e.code === 'mission_permission_pending' && /\.env/.test(e.message)
    );
    assert.strictEqual(typed, 0, 'the text would have hit the dialog\'s confirm key');
  });

  it('detects the dialog shape and nothing else', () => {
    const dialog = mission.detectPermission('△ Permission required\n→ Read .env\nPath: .env\nAllow once  Allow always  Reject');
    assert.strictEqual(dialog.tool, 'Read .env');
    assert.strictEqual(dialog.path, '.env');
    assert.strictEqual(mission.detectPermission('just a normal TUI screen'), null, 'idle is not blocked');
    assert.strictEqual(mission.detectPermission('Permission required but no buttons'), null, 'a half-match is not a dialog');
  });

  it('confirms the write and returns the pane it landed in, with the project echoed', async () => {
    const p = mission.createProject({ name: 'echo', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-3333cccc' });
    const r = await mission.sendText(s.id, 'do the thing');
    assert.strictEqual(r.confirmed, true, 'never a bare ok for a keystroke that went nowhere');
    assert.strictEqual(r.session_id, s.id, 'the write says which session it landed in');
    assert.deepEqual(r.project, { id: p.id, name: 'echo' }, 'and which project, since a label is not one');
    assert.match(r.screen, /waiting/);
  });

  // 1h: the pane existing is not an acknowledgement. A live TUI that never
  // repaints did not take the text, and a bare `ok: true` for it is the exact
  // failure this item is about — the caller then waits for an answer that was
  // never going to come.
  it('refuses a live pane that never changes after the write, instead of a bare ok', async () => {
    const p = mission.createProject({ name: 'blackhole', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-4444dddd' });
    padTmux.sendText = async () => ({ lines: 1 }); // typed, echoed by nothing
    await assert.rejects(
      () => mission.sendText(s.id, 'anyone there?'),
      (e) => e.code === 'mission_tui_not_ready' && /never changed/.test(e.message)
    );
  });

  // 1f: two clocks. `last_seen_at` moves because someone LOOKED; `last_output_at`
  // moves because the agent PRODUCED something. A caller asking "is it still
  // working?" needs the second one, and a field that moved on every read would
  // answer yes forever.
  it('separates the probe clock from the output clock', async () => {
    const p = mission.createProject({ name: 'clocks', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-5555eeee' });
    const row = () => mission.getSession(s.id);
    // The clock has millisecond resolution, so two reads inside the same
    // millisecond produce IDENTICAL stamps and every "it moved" assertion below
    // becomes a coin flip that fails roughly one run in ten. Each read that is
    // supposed to advance the clock is therefore preceded by a gap larger than
    // the resolution — otherwise a correct implementation looks broken.
    const tick = () => new Promise((r2) => setTimeout(r2, 5));
    const read = async (text) => {
      padTmux.captureScreen = async () => ({ text, live: true });
      await tick();
      return mission.screen(s.id, 20);
    };

    assert.strictEqual(row().last_output_at, null, 'nothing observed yet, so nothing claimed');

    await read('first output');
    const first = row().last_output_at;
    assert.ok(first, 'a capture that saw new content records output');

    // Same content again: a PROBE happened, the agent did not produce anything.
    await read('first output');
    assert.strictEqual(row().last_output_at, first, 're-reading an unchanged pane is not output');
    assert.ok(row().last_seen_at, 'but it is still a probe, and says so in its own field');

    await read('second output');
    assert.notStrictEqual(row().last_output_at, first, 'changed content does move it');

    // The read that MOVED the clock must report having moved it. The row is
    // fetched before the write, so returning it untouched answers with the
    // PREVIOUS timestamp — and "non-null" cannot catch that, because an earlier
    // read already made it non-null. Assert it CHANGED.
    const prev = row().last_output_at;
    const r = await read('third output');
    assert.ok(r.session.last_output_at, 'the response carries an output clock');
    assert.notStrictEqual(r.session.last_output_at, prev, 'and it is the one this read just set');

    // The control: an unchanged pane does not move it, so the assertion above is
    // about a real advance and not just a differing string.
    const same = await read('third output');
    assert.strictEqual(same.session.last_output_at, r.session.last_output_at, 'an unchanged pane leaves it alone');
  });

  it('mission_tui_not_ready rather than a bare ok when the pane dies mid-write', async () => {
    const p = mission.createProject({ name: 'vanish', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-4444dddd' });
    padTmux.captureScreen = async () => ({ text: '', live: false });
    await assert.rejects(() => mission.sendText(s.id, 'anyone there?'), (e) => e.code === 'mission_tui_not_ready');
  });

  it('answers "Allow always" never — that is the human\'s durable policy call', async () => {
    const p = mission.createProject({ name: 'always', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-5555eeee' });
    screenText = '△ Permission required\n→ Bash(rm -rf x)\nAllow once  Allow always  Reject';
    await assert.rejects(
      () => mission.answerPermission(s.id, 'always'),
      (e) => e.code === 'mission_permission_refused'
    );
    assert.deepEqual(keys, [], 'no keys were pressed');
  });

  it('answers once/reject by key, not by typing text, and reports the result', async () => {
    const p = mission.createProject({ name: 'answer', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-6666ffff' });
    screenText = '△ Permission required\n→ Read .env\nAllow once  Allow always  Reject';
    const r = await mission.answerPermission(s.id, 'once');
    assert.deepEqual(keys, [['Home', 'Enter']], 'first option, confirmed explicitly');
    assert.strictEqual(r.choice, 'once');
    assert.strictEqual(r.session_id, s.id);
  });

  it('answers reject with the LAST option selected, not the first', async () => {
    const p = mission.createProject({ name: 'rej', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-7777aaaa' });
    screenText = '△ Permission required\n→ Read .env\nAllow once  Allow always  Reject';
    await mission.answerPermission(s.id, 'reject');
    assert.deepEqual(keys, [['End', 'Enter']]);
  });

  it('"always" is the human\'s privilege: refused by default, allowed on request', async () => {
    // The refusal has to be a CALLER rule, not a hard block, or the human cannot
    // use their own button; and it has to default to refused, or an agent caller
    // that forgot to pass the flag would be granting durable permissions.
    const p = mission.createProject({ name: 'humangate', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-0000aaa1' });
    screenText = '△ Permission required\n→ Read .env\nAllow once  Allow always  Reject';
    await assert.rejects(
      () => mission.answerPermission(s.id, 'always'),
      (e) => e.code === 'mission_permission_refused'
    );
    assert.deepEqual(keys, [], 'the refusal is checked before any key is pressed');

    const r = await mission.answerPermission(s.id, 'always', { allowAlways: true });
    assert.strictEqual(r.choice, 'always');
    assert.deepEqual(keys, [['Down', 'Enter']], 'the MIDDLE option, not the first and not the last');
  });

  it('refuses to answer when no dialog is showing, so a stray keypress cannot happen', async () => {
    const p = mission.createProject({ name: 'nodlg', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-8888bbbb' });
    screenText = 'ordinary TUI output';
    await assert.rejects(() => mission.answerPermission(s.id, 'once'), (e) => e.code === 'mission_no_permission_pending');
    assert.deepEqual(keys, []);
  });

  it('every refusal names the project AND the session id, since a label is not one', async () => {
    // A refusal is often the only thing a caller ever sees about a write, and
    // the row's `label` is operator-set — empty on most rows and arbitrary
    // otherwise. So the two things that ARE stable have to be in the message.
    const p = mission.createProject({ name: 'unnamed-ish', agent: 'pad-msn-oc', folder: '/www1/a' });
    mission.updateProject(p.id, { name: 'renamed-since' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-9999cccc', label: '' });
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, command: 'sh', cwd: '/www1/a' });
    await assert.rejects(
      () => mission.sendText(s.id, 'hi'),
      (e) => {
        assert.ok(e.message.includes(p.id), `the project id (${p.id}) is in: ${e.message}`);
        assert.ok(e.message.includes(s.id), 'the session id');
        assert.ok(e.message.includes('renamed-since'), 'and the name a human recognises');
        return true;
      }
    );
  });
});

// 1d: detail mode used to hand back a RAW row. Once `busy` started requiring
// `live` (1a) that turned into a worse bug than the one 1d was filed for — every
// live session's detail view reported `state: 'dead'`. Both halves of the
// contract are pinned here, against the store, not against a route.
describe('Mission - detail and list tell the same story (plan 62 1d)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };

  beforeEach(() => {
    padTmux.captureScreen = async () => ({ text: 'idle prompt', live: true });
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'node', cwd: '/www1/a' });
  });

  afterEach(() => {
    for (const k of ['captureScreen', 'paneState', 'listSessions', 'listPanes']) padTmux[k] = real[k];
  });

  it('a live agent session is live and open in detail, never a corpse', async () => {
    const p = mission.createProject({ name: 'detail', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    const r = await mission.screen(s.id);
    assert.strictEqual(r.session.live, true, 'the pane exists — that is not a corpse');
    assert.strictEqual(r.session.state, undefined, 'and certainly not dead');
    assert.strictEqual(r.session.open, true, 'a send would be accepted');
    assert.strictEqual(r.session.kind, 'agent');
  });

  it('a gone session says dead in detail too', async () => {
    const p = mission.createProject({ name: 'gone', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    padTmux.paneState = async () => ({ live: false, tuiAlive: false, command: '', cwd: '', reason: 'no-session' });
    padTmux.captureScreen = async () => ({ text: '', live: false });
    const r = await mission.screen(s.id);
    assert.strictEqual(r.session.state, 'dead');
    assert.strictEqual(r.session.open, false);
  });

  it('a shell pane is open: false in detail, matching what send will do', async () => {
    const p = mission.createProject({ name: 'shelldetail', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, command: 'bash', cwd: '/www1/a' });
    const r = await mission.screen(s.id);
    assert.strictEqual(r.session.live, true, 'the tmux session is real');
    assert.strictEqual(r.session.open, false, 'but a send is refused, so open is false');
    assert.strictEqual(r.session.kind, 'shell');
  });

  it('the detail row and the list row agree field for field', async () => {
    const p = mission.createProject({ name: 'parity', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    padTmux.listSessions = async () => [{ name: 'msn-aaaabbbb' }];
    padTmux.listPanes = async () => new Map([['msn-aaaabbbb', { command: 'node', cwd: '/www1/a' }]]);
    // The FULL list chain, because `open` is stamped by the busy pass — asking
    // `withLiveSessions` alone would compare a missing field against a real one
    // and prove nothing about parity.
    const liven = await mission.withLiveSessions([s], p.agent_name);
    const [listed] = await mission.withAgentBusy(liven, () => p.agent_name, () => p.folder);
    const detail = await mission.screen(s.id);
    for (const f of ['live', 'open', 'kind', 'tuiAlive', 'busy', 'busyKnown']) {
      assert.deepStrictEqual(detail.session[f], listed[f], `${f} must not depend on how it was read`);
    }
  });
});

// `last_seen_at` was frozen at creation on rows that were alive and busy, so a
// field that looks like a heartbeat read as a silence.
describe('Mission - last_seen_at moves on a live pane (plan 62 1f)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };

  afterEach(() => {
    for (const k of ['listSessions', 'listPanes']) padTmux[k] = real[k];
  });

  it('advances for a live row and leaves a dead one alone', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const alive = mission.createSession(p.id, { tmuxId: 'msn-aaaabbbb' });
    const dead = mission.createSession(p.id, { tmuxId: 'msn-ccccdddd' });
    // Seed a known-old stamp on both rows rather than diffing against the
    // creation value: create + probe can land in the same millisecond, and a
    // test whose assertion is "these two ISO strings differ" would then pass or
    // fail on how fast the machine is. A frozen value is unambiguous.
    const OLD = '2020-01-01T00:00:00.000Z';
    getDb().prepare('UPDATE mission_sessions SET last_seen_at = ?').run(OLD);
    padTmux.listSessions = async () => [{ name: 'msn-aaaabbbb' }];
    padTmux.listPanes = async () => new Map([['msn-aaaabbbb', { command: 'node', cwd: '/www1/beat' }]]);

    const rows = await mission.withLiveSessions([alive, dead], p.agent_name);
    assert.notStrictEqual(mission.getSession(alive.id).last_seen_at, OLD, 'probing a live pane moves it');
    assert.strictEqual(
      mission.getSession(dead.id).last_seen_at,
      OLD,
      'a dead pane has nothing to report, and a frozen clock must not look like a heartbeat'
    );
    // The in-memory row the caller got must carry the NEW stamp, not the one it
    // was read with — otherwise the API answers with a value its own DB no
    // longer holds.
    assert.strictEqual(rows[0].last_seen_at, mission.getSession(alive.id).last_seen_at);
  });
});
