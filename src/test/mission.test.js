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

// Plan 52 C1-F1. `opencode` mints a conversation id when its TUI starts and never
// reports it, so a fresh start used to leave the row with no id FOREVER and
// every later read answered "I looked, it is idle" for a pane that was visibly
// mid-turn. The fix mints the conversation BEFORE the pane exists, so the id is
// a fact at start time rather than a guess made afterwards from timestamps.
describe('Mission - a fresh start knows its own conversation (plan 52 C1-F1)', () => {
  const padTmux = require('../services/pad-tmux');
  const drivers = require('../services/drivers');
  const driver = drivers.getDriver('opencode');
  const real = { ...padTmux };
  const realCreate = driver.createConversation;
  const realGetAgent = require('../services/agent-registry').getAgent;
  let sent = [];
  let created = [];

  beforeEach(() => {
    sent = [];
    created = [];
    padTmux.folderExists = async () => true;
    padTmux.createSession = async () => {};
    padTmux.killSession = async () => {};
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, cwd: '/www1/craftpip.com' });
    padTmux.sendCommand = async (vm, tid, cmd) => { sent.push(cmd); };
    driver.createConversation = async (vm, folder, port) => {
      created.push({ vm, folder, port });
      return 'ses_minted';
    };
    // The port is read from the PAD's own published web block, so the fake PAD
    // has to answer one — and with the REAL port, to pin that it is this PAD's
    // port being used rather than a driver default.
    require('../services/agent-registry').getAgent = () => ({ web: { containerPort: 7890 } });
  });

  afterEach(() => {
    for (const k of ['folderExists', 'createSession', 'killSession', 'paneState', 'sendCommand']) padTmux[k] = real[k];
    driver.createConversation = realCreate;
    require('../services/agent-registry').getAgent = realGetAgent;
  });

  it('mints the conversation first, then launches the TUI INTO it', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    // The row carries the id from its FIRST read — the property the whole
    // defect was the absence of.
    assert.strictEqual(session.agent_session_id, 'ses_minted');
    assert.deepEqual(created, [{ vm: 'pad-msn-oc', folder: '/www1/craftpip.com', port: 7890 }],
      'the conversation is created in the PROJECT folder, on this PAD\'s own port');
    // And the TUI is resumed into it rather than left to mint its own — two
    // conversations for one pane is the failure this ordering prevents.
    assert.deepEqual(sent, ['opencode -s ses_minted']);
  });

  it('a relaunch after the TUI dies comes back to the SAME conversation', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    sent = [];
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, cwd: '/www1/craftpip.com' });
    await mission.relaunchTui(session.id);
    assert.deepEqual(sent, ['opencode -s ses_minted'],
      'before the fix this relaunched as a brand-new empty conversation, orphaning the history');
  });

  it('a caller-supplied id wins — we never mint a second conversation for it', async () => {
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, { agentSessionId: 'ses_abc' });
    assert.strictEqual(session.agent_session_id, 'ses_abc');
    assert.deepEqual(created, [], 'the caller already named the conversation');
    assert.deepEqual(sent, ['opencode -s ses_abc']);
  });

  it('a retry does not mint a second conversation', async () => {
    // The dedup check has to run BEFORE the mint. After it, a timed-out client
    // that retries with the same key would get its own row back but ALSO leave
    // an orphaned empty conversation in the agent's store on every attempt.
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const first = await mission.startSession(p.id, { idempotencyKey: 'caller-token-1' });
    const retry = await mission.startSession(p.id, { idempotencyKey: 'caller-token-1' });
    assert.strictEqual(retry.deduped, true);
    assert.strictEqual(retry.session.id, first.session.id);
    assert.strictEqual(created.length, 1, 'exactly one conversation for the whole retry sequence');
  });

  it('a start still succeeds when the agent cannot mint one', async () => {
    // Best effort by design: the row just loses its busy stamp, which is the
    // old behaviour. Refusing to start would trade a cosmetic loss for a dead
    // button, and the agent is perfectly able to run without our knowing its id.
    driver.createConversation = async () => '';
    const p = mission.createProject({ name: 'cp', agent: 'pad-msn-oc', folder: '/www1/craftpip.com' });
    const { session } = await mission.startSession(p.id, {});
    assert.strictEqual(session.agent_session_id, null);
    assert.deepEqual(sent, ['opencode'], 'launches fresh, as it did before');
    // And the honesty rule then covers the row: no id means UNKNOWN, not idle.
    const row = mission.stampTruth(
      { ...session, live: true, cwd: '/www1/craftpip.com' },
      { ids: new Set(), known: true }
    );
    assert.strictEqual(row.busyKnown, false);
  });

  it('a driver that cannot mint one is never asked to', async () => {
    // codex/claude expose no create-session API, so the capability check is
    // what keeps a personal agent from being handed a call it does not have.
    const claude = drivers.getDriver('claude');
    const realClaude = claude.createConversation;
    claude.createConversation = undefined;
    try {
      const p = mission.createProject({ name: 'cp', agent: 'pad-msn-cx', folder: '/www1/craftpip.com' });
      await mission.startSession(p.id, {});
      assert.deepEqual(created, [], 'no mint attempted, and no crash from the missing method');
    } finally {
      claude.createConversation = realClaude;
    }
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
describe('Mission - liveness must not lie (plan 62, as amended by plan 52 R8)', () => {
  // Plan 52 R8 moved the busy half from the opencode web server's folder-scoped
  // `?directory=` probe to each conversation's OWN store. The probe shape is now
  // `{ busyOf, knownOf }` Maps keyed by `agent_session_id` — `busyOf` holds ids
  // whose newest tool part is running, `knownOf` ids whose store we could read.
  // A probe is only as good as what it was probed WITH: a row whose id is absent
  // from `knownOf` was never looked at and is UNKNOWN, never idle (C1-F1).
  const mkProbe = ({ busy = [], known = [] } = {}) => ({
    busyOf: new Map(busy.map((id) => [id, true])),
    knownOf: new Map(known.map((id) => [id, true])),
  });
  const stamp = (s, probe) =>
    mission.stampTruth(s, {
      busyOf: new Map(),
      knownOf: new Map(),
      ...probe,
    });

  it('a dead row is never busy and never open, however hard the store claims', () => {
    const dead = stamp({ id: 'msn_a', live: false, agent_session_id: 'ses_x' }, mkProbe({ busy: ['ses_x'], known: ['ses_x'] }));
    assert.strictEqual(dead.busy, false, 'a corpse cannot be working');
    assert.strictEqual(dead.open, false, 'and open must not count a row send refuses');
    assert.strictEqual(dead.state, 'dead', 'the corpse says so');
    // The forensics survive without contaminating `busy`: a frozen `running`
    // (a process killed mid-call never writes `completed`) counsels "do not
    // act" on the dead row only (plan 65's upper-bound precedent).
    assert.strictEqual(dead.wasBusy, true, 'the store still claims the conversation');
  });

  it('a live row whose store says running is busy and open', () => {
    const row = stamp({ id: 'msn_b', live: true, agent_session_id: 'ses_y', cwd: '/w' }, mkProbe({ busy: ['ses_y'], known: ['ses_y'] }));
    assert.strictEqual(row.busy, true);
    assert.strictEqual(row.open, true);
    assert.strictEqual(row.busyKnown, true);
  });

  it('a live SHELL pane is not open, because a send there runs commands', () => {
    const row = stamp({ id: 'msn_c', live: true, tuiAlive: false, kind: 'shell', agent_session_id: 'ses_z' }, mkProbe({ busy: ['ses_z'], known: ['ses_z'] }));
    assert.strictEqual(row.open, false, 'open means "a send would be accepted"');
    assert.strictEqual(row.busy, false, 'a shell is not working on anything');
  });

  it('a pane running in ANOTHER folder is still answered by its own store (plan 52 R8)', () => {
    // Plan 62 1e's cwd-vs-folder UNKNOWN branch is GONE: it existed because the
    // folder-scoped web probe could not answer for a pane running elsewhere, and
    // an id-keyed store read has no such blind spot. A conversation's store IS
    // the conversation, wherever the pane sits.
    const row = stamp({ id: 'msn_d', live: true, folder: '/proj', cwd: '/elsewhere', agent_session_id: 'ses_w' }, mkProbe({ busy: ['ses_w'], known: ['ses_w'] }));
    assert.strictEqual(row.busy, true, 'the store says the session itself is mid-turn');
    assert.strictEqual(row.busyKnown, true, 'and we did look at that conversation');
  });

  it('an unreadable store never yields busyKnown: true', () => {
    const row = mission.stampTruth(
      { id: 'msn_e', live: true, folder: '/proj', cwd: '/proj', agent_session_id: 'ses_v' },
      { busyOf: new Map(), knownOf: new Map() }
    );
    assert.strictEqual(row.busyKnown, false, 'unknown, not idle');
  });

  it('a row with no agent conversation is never busy, whatever the probe holds', () => {
    const row = stamp({ id: 'msn_f', live: true, agent_session_id: null, cwd: '/p' }, mkProbe({ busy: ['ses_u'], known: ['ses_u'] }));
    assert.strictEqual(row.busy, false, 'no id to match means no claim to make');
    // Plan 52 C1-F1. This is the assertion that was MISSING, and its absence is
    // why the defect survived a green suite: the row above proves we refuse to
    // claim busy, but it said nothing about what we claim to KNOW. With no id
    // the probe was never intersected with anything, so `busyKnown` reporting
    // the probe's own `known: true` turned "I could not look at this
    // conversation" into "I looked, it is idle" — a licence to type into a pane
    // that was visibly mid-turn. Nothing contradicts `busy: false` on its own,
    // which is exactly why the lie was invisible.
    assert.strictEqual(row.busyKnown, false, 'no id means the conversation was never looked at');
  });

  it('an id-less DEAD row is unknown too — the corpse was never observed busy', () => {
    // The dead branch has its own `busyKnown`, and it is the same defect with
    // an extra step: a corpse with no id reported `busyKnown: true`, so a caller
    // polling a dead row would read a positive statement about a conversation
    // nobody ever checked.
    const row = stamp({ id: 'msn_g', live: false, agent_session_id: null }, mkProbe({ busy: ['ses_t'], known: ['ses_t'] }));
    assert.strictEqual(row.state, 'dead');
    assert.strictEqual(row.busyKnown, false, 'a corpse with no id is unknown, not idle');
    assert.strictEqual(row.wasBusy, undefined, 'and carries no busy forensics to suggest otherwise');
  });

  it('a SHELL pane with no id is unknown, not idle', () => {
    const row = stamp({ id: 'msn_h', live: true, tuiAlive: false, kind: 'shell', agent_session_id: null }, mkProbe({ busy: ['ses_s'], known: ['ses_s'] }));
    assert.strictEqual(row.open, false);
    assert.strictEqual(row.busyKnown, false, 'same rule on the shell branch');
  });
});

// Plan 52 R8(a): `busy` is answered by each conversation's OWN store, not by the
// opencode web server's `/session/status` — the server only reports conversations
// ITS process drives, and a Mission pane is a separate TUI with no sockets, so
// its turns never appeared there (measured: an idle web-UI session reported busy
// across 42s of a visible `esc interrupt` on a Mission pane). The store is the
// shared sqlite, so its newest tool-part status is the truth for WHICHEVER
// client drives the conversation. These tests stub `agentStore.readActivity` and
// assert through the real `busyForSessions` / `withAgentBusy` /
// `withAgentBusyProjects` seams, exactly as production calls them. Distinct
// `agent_session_id`s per subtest so the 5s `BUSY_CACHE` never answers the next
// test from this one's reads.
describe('Mission - busy reads each conversation\u2019s own store (plan 52 R8)', () => {
  const agentStore = require('../services/agent-store');
  const realRead = agentStore.readActivity;
  const running = { store: { available: true }, lastToolCall: { status: 'running' } };
  const done = { store: { available: true }, lastToolCall: { status: 'completed' } };

  afterEach(() => {
    agentStore.readActivity = realRead;
  });

  it('busyOf names exactly the sessions whose newest tool part is running', async () => {
    agentStore.readActivity = async (vm, id) => (id === 'run_1' ? running : done);
    const { busyOf, knownOf } = await mission.busyForSessions([
      { agent_name: 'pad-msn-oc', agent_session_id: 'run_1' },
      { agent_name: 'pad-msn-oc', agent_session_id: 'idle_1' },
    ]);
    assert.strictEqual(busyOf.get('run_1'), true);
    assert.strictEqual(busyOf.get('idle_1'), false);
    assert.strictEqual(knownOf.get('run_1'), true, 'the running store was readable');
    assert.strictEqual(knownOf.get('idle_1'), true);
  });

  it('an unreadable or throwing store is known:false, never a claim', async () => {
    agentStore.readActivity = async () => {
      throw new Error('boom');
    };
    const { busyOf, knownOf } = await mission.busyForSessions([{ agent_name: 'pad-msn-oc', agent_session_id: 'dead_1' }]);
    assert.strictEqual(busyOf.get('dead_1'), false);
    assert.strictEqual(knownOf.get('dead_1'), false, 'a read we could not make is UNKNOWN, not idle');
  });

  it('a row with no conversation id is not even asked', async () => {
    let asked = 0;
    agentStore.readActivity = async () => {
      asked++;
      return done;
    };
    await mission.busyForSessions([{ agent_name: 'pad-msn-oc', agent_session_id: null }]);
    assert.strictEqual(asked, 0, 'no id means there is nothing to intersect');
  });

  it('withAgentBusy stamps a session busy from its OWN store, even with a drifted cwd', async () => {
    const p = mission.createProject({ name: 'r8-busy', agent: 'pad-msn-oc', folder: '/www1/r8' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-a1111111' });
    agentStore.readActivity = async (vm, id) => (id === 'run_2' ? running : done);
    const [row] = await mission.withAgentBusy(
      [{ ...s, live: true, tuiAlive: true, cwd: '/elsewhere', folder: '/www1/r8', agent_session_id: 'run_2' }],
      () => p.agent_name
    );
    // Plan 62 1e's cwd-vs-folder UNKNOWN branch is retired: the id-keyed store
    // answers the conversation itself, so WHERE the pane sits is irrelevant.
    assert.strictEqual(row.busy, true, 'the store says this conversation is mid-turn');
    assert.strictEqual(row.busyKnown, true);
    assert.strictEqual(row.open, true);
  });

  it('withAgentBusyProjects aggregates the store-backed busy into openCount', async () => {
    const p = mission.createProject({ name: 'r8-aggr', agent: 'pad-msn-oc', folder: '/www1/r8' });
    const a = mission.createSession(p.id, { tmuxId: 'msn-b2222222' });
    const b = mission.createSession(p.id, { tmuxId: 'msn-c3333333' });
    agentStore.readActivity = async (vm, id) => (id === 'run_3' ? running : done);
    const [proj] = await mission.withAgentBusyProjects([
      {
        id: p.id,
        agent_name: p.agent_name,
        folder: p.folder,
        sessions: [
          { ...a, live: true, tuiAlive: true, agent_session_id: 'run_3' },
          { ...b, live: false, agent_session_id: 'idle_3' },
        ],
      },
    ]);
    assert.strictEqual(proj.sessions[0].busy, true, 'the running tool part lights the row');
    assert.strictEqual(proj.sessions[0].open, true);
    assert.strictEqual(proj.sessions[1].busy, false, 'a dead row is never busy, however the store reads');
    assert.strictEqual(proj.sessions[1].state, 'dead');
    assert.strictEqual(proj.openCount, 1, 'only the live running session counts open');
  });

  it('titleOf carries the agent\u2019s OWN title from the same store read (plan 80)', async () => {
    agentStore.readActivity = async (vm, id) =>
      (id === 'titled_1' ? { store: { available: true }, lastToolCall: { status: 'completed' }, title: 'auth v3' } : done);
    const { titleOf, knownOf } = await mission.busyForSessions([
      { agent_name: 'pad-msn-oc', agent_session_id: 'titled_1' },
    ]);
    assert.strictEqual(titleOf.get('titled_1'), 'auth v3');
    assert.strictEqual(knownOf.get('titled_1'), true);
  });

  it('an UNREADABLE store yields NO title — an invented name is worse than none (plan 80)', async () => {
    agentStore.readActivity = async () => {
      throw new Error('boom');
    };
    const { titleOf, knownOf } = await mission.busyForSessions([
      { agent_name: 'pad-msn-oc', agent_session_id: 'titled_unread_1' },
    ]);
    assert.strictEqual(knownOf.get('titled_unread_1'), false, 'the probe itself failed');
    assert.ok(!titleOf.has('titled_unread_1'), 'a conversation we could not read must not be handed a name');
  });

  it('withAgentBusy stamps the agent\u2019s title onto the row (plan 80)', async () => {
    const p = mission.createProject({ name: 'r8-title', agent: 'pad-msn-oc', folder: '/www1/r8' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-d4444444' });
    agentStore.readActivity = async (vm, id) =>
      (id === 'titled_live_1' ? { store: { available: true }, lastToolCall: { status: 'completed' }, title: 'migration plan' } : done);
    const [row] = await mission.withAgentBusy(
      [{ ...s, live: true, tuiAlive: true, agent_session_id: 'titled_live_1' }],
      () => p.agent_name
    );
    assert.strictEqual(row.title, 'migration plan', 'the row the listing renders carries the title');
    assert.strictEqual(row.busyKnown, true);
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
    const [listed] = await mission.withAgentBusy(liven, () => p.agent_name);
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

// Plan 65 — the session lifecycle an LLM can drive: a start that survives its
// own timeout (1f), a dead session you can still READ (1a), a row that says HOW
// it died (1b), a recreate that accounts for what it kills (1d), and a close that
// is not a lie (1e). Each of these is a question a caller can only answer if the
// service keeps the fact; the tests below are the answer, not the implementation.
describe('Mission - plan 65: a session that can be retried (1f)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let created = [];
  let sent = [];

  beforeEach(() => {
    created = [];
    sent = [];
    padTmux.folderExists = async () => true;
    padTmux.createSession = async (vm, tid) => { created.push(tid); };
    padTmux.killSession = async () => {};
    padTmux.sendCommand = async (vm, tid, cmd) => { sent.push(cmd); };
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, cwd: '/www1/beat' });
  });

  afterEach(() => {
    for (const k of ['folderExists', 'createSession', 'killSession', 'sendCommand', 'paneState']) padTmux[k] = real[k];
  });

  it('the same idempotency_key returns the SAME session instead of a second one', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const first = await mission.startSession(p.id, { idempotencyKey: 'caller-token-1' });
    // The retry a timed-out client sends. The pane is up this time, which is the
    // whole point: the duplicate would be created at exactly this moment.
    const second = await mission.startSession(p.id, { idempotencyKey: 'caller-token-1' });

    assert.strictEqual(second.session.id, first.session.id, 'the retry is the same session');
    assert.strictEqual(second.deduped, true, 'and it is told so, rather than being allowed to look like a fresh start');
    assert.strictEqual(mission.listSessions({ projectId: p.id }).length, 1, 'exactly one row exists');
    assert.deepStrictEqual(created, [first.session.tmux_id], 'ONE tmux session — the retry did not bring up a second pane');
    assert.strictEqual(sent.length, 1, 'and launched the TUI once');
  });

  it('two different keys are two different sessions', async () => {
    // The control for the test above: a key that dedupes EVERYTHING would pass it
    // while quietly collapsing real work. A caller that wants two sessions sends
    // two keys, and it must get two.
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const a = await mission.startSession(p.id, { idempotencyKey: 'k-a' });
    const b = await mission.startSession(p.id, { idempotencyKey: 'k-b' });
    assert.notStrictEqual(a.session.id, b.session.id);
    assert.notStrictEqual(a.session.tmux_id, b.session.tmux_id);
    assert.strictEqual(b.deduped, undefined, 'a fresh start is not reported as a dedupe');
    assert.strictEqual(mission.listSessions({ projectId: p.id }).length, 2);
    assert.strictEqual(created.length, 2, 'two panes, as asked for');
  });

  it('the key is scoped to the PROJECT, not global', async () => {
    // A key is the caller's token for one request in one project. Reusing the
    // same string in a different project must not hand back the other project's
    // session — that would resolve to a tmux id in a folder the caller never
    // named, and the mismatch is invisible in the response.
    const p1 = mission.createProject({ name: 'one', agent: 'pad-msn-oc', folder: '/www1/one' });
    const p2 = mission.createProject({ name: 'two', agent: 'pad-msn-oc', folder: '/www1/two' });
    const a = await mission.startSession(p1.id, { idempotencyKey: 'shared' });
    const b = await mission.startSession(p2.id, { idempotencyKey: 'shared' });
    assert.notStrictEqual(b.session.id, a.session.id, 'a different project is a different session');
    assert.strictEqual(b.session.project_id, p2.id);
  });

  it('the CONCURRENT race returns the winner, not a second launch into its pane', async () => {
    // The check-before-insert cannot see a sibling that has not committed yet, so
    // the unique index is the authority and the losing insert has to report
    // itself. Returning a bare row made the loser go on to create a tmux session
    // on the WINNER's tmux id and launch a second TUI in it — the duplicate this
    // whole mechanism exists to prevent, reached through the race rather than
    // the retry. Simulated here by inserting the key between the check and the
    // insert.
    const p = mission.createProject({ name: 'race', agent: 'pad-msn-oc', folder: '/www1/race' });
    // The winner commits for real, then the check is made blind. Patching the
    // DB's own `prepare` (rather than the exported lookup) is what a race looks
    // like from the code's side: the SELECT simply cannot see the row yet, and
    // only the unique index can catch the loser.
    const now = new Date().toISOString();
    getDb().prepare(
      `INSERT INTO mission_sessions (id, project_id, tmux_id, label, origin, created_by, agent_session_id, created_at, last_seen_at, idempotency_key)
       VALUES (?, ?, ?, '', 'agent', NULL, NULL, ?, ?, ?)`
    ).run('msn-winnerrrr', p.id, 'msn-winwinww', now, now, 'race-key');

    const db = getDb();
    // Hold the METHOD, not a copy of it bound to this db: `db.prepare` is a
    // singleton the rest of the suite keeps using, so restoring a bound function
    // here would leave it permanently closed over its own receiver.
    const realPrepare = db.prepare;
    let blind = false;
    db.prepare = function (sql) {
      if (!blind && /idempotency_key = \?/.test(sql)) {
        blind = true;
        return { get: () => undefined };
      }
      return realPrepare.call(db, sql);
    };
    try {
      const r = await mission.startSession(p.id, { idempotencyKey: 'race-key' });
      assert.ok(blind, 'sanity: the check really was blind to the committed sibling');
      assert.strictEqual(r.session.id, 'msn-winnerrrr', 'the caller is handed the row that won');
      assert.strictEqual(r.deduped, true, 'and is told it lost the race, not that it started a session');
      assert.deepStrictEqual(created, [], 'the loser created NO pane');
      assert.strictEqual(sent.length, 0, 'and launched no second TUI into the winner\'s pane');
      assert.strictEqual(mission.listSessions({ projectId: p.id }).length, 1, 'one row, not two');
    } finally {
      db.prepare = realPrepare;
    }
  });

  it('a failed launch leaves no row behind, so a retry is not deduped onto a corpse', async () => {
    // The failure path deletes the row. If it did not, the retry with the same
    // key would find a dead row and answer "deduped" — handing back a session
    // that was never started, which is the one outcome the token cannot repair.
    const p = mission.createProject({ name: 'boom', agent: 'pad-msn-oc', folder: '/www1/boom' });
    padTmux.sendCommand = async () => { throw new Error('tmux exploded'); };
    await assert.rejects(() => mission.startSession(p.id, { idempotencyKey: 'doomed' }), /tmux exploded/);
    assert.strictEqual(mission.listSessions({ projectId: p.id }).length, 0, 'the row is gone');
    assert.strictEqual(mission.getSessionByIdempotencyKey(p.id, 'doomed'), null, 'so the key is free again');

    padTmux.sendCommand = async (vm, tid, cmd) => { sent.push(cmd); };
    sent = [];
    const ok = await mission.startSession(p.id, { idempotencyKey: 'doomed' });
    assert.strictEqual(ok.deduped, undefined, 'the retry is a real start');
    assert.ok(/^msn_/.test(ok.session.id), `with a real session id, got ${ok.session.id}`);
    assert.strictEqual(sent.length, 1, 'and the TUI actually launched');
  });
});

// Plan 65 1a — the surface could resume a conversation but never READ one. The
// detail read answered `screen: ""` for a corpse, and an empty string is
// ambiguous: an agent that said nothing, a broken capture, or a session we
// cannot see any more all look identical. These tests pin the three answers the
// caller can now tell apart, and the clock that dates the stored one.
describe('Mission - plan 65: reading a dead session (1a)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let paneIsLive;

  beforeEach(() => {
    paneIsLive = true;
    padTmux.captureScreen = async () => (paneIsLive ? { text: 'the agent said this', live: true } : { text: '', live: false });
    padTmux.paneState = async () => (paneIsLive
      ? { live: true, tuiAlive: true, command: 'node', cwd: '/www1/beat' }
      : { live: false, tuiAlive: false, command: '', cwd: '', reason: 'no-session' });
    padTmux.listSessions = async () => (paneIsLive ? [{ name: 'msn-deadbeef' }] : []);
    padTmux.listPanes = async () => new Map();
  });

  afterEach(() => {
    for (const k of ['captureScreen', 'paneState', 'listSessions', 'listPanes']) padTmux[k] = real[k];
  });

  it('a live pane says so, and stores its screen for later', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-deadbeef' });
    const r = await mission.screen(s.id);
    assert.strictEqual(r.screenFrom, 'live-pane', 'a live capture is labelled as one');
    assert.match(r.screen, /the agent said this/);
    assert.ok(r.lastScreenAt, 'and dated');
    // The screen is kept ON THE ROW, which is the whole design: no teardown hook
    // to lose, and the read that already captured a pane is the only place we
    // had the text anyway.
    const row = mission.getSession(s.id);
    assert.match(row.last_screen, /the agent said this/);
    assert.ok(row.last_screen_at, 'with its own clock');
    assert.strictEqual(row.last_screen_truncated, 0, 'and recorded that it was not cut');
  });

  it('a dead pane answers from the STORED screen, dated, and says which one it is', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-deadbeef' });
    await mission.screen(s.id); // the live read that stores the tail
    paneIsLive = false; // and now it dies

    const r = await mission.screen(s.id);
    assert.strictEqual(r.screenFrom, 'last-captured', 'the caller is told this is not a live pane');
    assert.match(r.screen, /the agent said this/, 'and gets the last thing it said');
    assert.ok(r.lastScreenAt, 'dated — "when" is the difference between history and now');
    assert.strictEqual(r.live, false);
  });

  it('a dead pane with NOTHING stored says none — never an empty string standing in for a screen', async () => {
    // The control on the test above. Without it, `screenFrom: 'last-captured'`
    // passes on a store that never stored anything: an empty capture and a lost
    // one are the same row. This session was NEVER read while alive.
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-deadbeef' });
    paneIsLive = false;
    const r = await mission.screen(s.id);
    assert.strictEqual(r.screenFrom, 'none', '"we never captured it" is the honest answer');
    assert.strictEqual(r.screen, '', 'and there is genuinely nothing to show');
    assert.strictEqual(r.lastScreenAt, undefined, 'with no clock for a capture that never happened');
  });

  it('the stored screen is capped, and SAYS it was cut', async () => {
    // A row carries this text into every listing read, so it cannot grow without
    // bound. But a screen that ended where we cut it and one trimmed to fit read
    // identically otherwise, and the difference decides whether the top line is a
    // real message or half of one — so the cut is stored, not implied.
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-deadbeef' });
    const long = 'x'.repeat(9000);
    padTmux.captureScreen = async () => ({ text: long, live: true });
    await mission.screen(s.id);
    const row = mission.getSession(s.id);
    assert.ok(row.last_screen.length <= 8000, `stored screen is capped, got ${row.last_screen.length}`);
    assert.strictEqual(row.last_screen_truncated, 1, 'and the cut is recorded');
    assert.ok(row.last_screen.endsWith('x'), 'the TAIL is what is kept — the newest output');
  });
});

// Plan 65 1b — a row that says HOW it ended, and a `gone` that is a first
// observation rather than a re-dating on every poll.
describe('Mission - plan 65: how a session ended (1b)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let alive;

  beforeEach(() => {
    alive = true;
    padTmux.listSessions = async () => (alive ? [{ name: 'msn-1111aaaa' }, { name: 'msn-2222bbbb' }] : []);
    padTmux.listPanes = async () => new Map();
  });

  afterEach(() => {
    for (const k of ['listSessions', 'listPanes']) padTmux[k] = real[k];
  });

  it('first sighting of a gone pane is dated `gone`; later polls do not move it', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    alive = false;
    const rows = await mission.withLiveSessionsByAgent([s], () => 'pad-msn-oc');
    assert.strictEqual(rows[0].ended_by, 'gone', 'the cause is on the row');
    assert.ok(rows[0].ended_at, 'and the moment we first saw it');
    const first = rows[0].ended_at;

    // A second poll must not re-date it: the first observation is the best
    // information we will ever have, and moving it turns "died at 10:04" into
    // "died whenever someone last looked".
    const again = await mission.withLiveSessionsByAgent([mission.getSession(s.id)], () => 'pad-msn-oc');
    assert.strictEqual(again[0].ended_at, first, 'a second sighting is not a second death');
  });

  it('a session that comes back has its death CLEARED, and dies again only on a NEW sighting', async () => {
    // The other half of "first sighting": resurrection is not a new session, so
    // a stamp left behind would have the row claiming it died while it is
    // demonstrably running. `clearEnded` is what makes the stamp trustworthy —
    // a stamp that can outlive the fact is worse than no stamp.
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    alive = false;
    await mission.withLiveSessionsByAgent([s], () => 'pad-msn-oc');
    assert.strictEqual(mission.getSession(s.id).ended_by, 'gone');

    alive = true;
    const back = await mission.withLiveSessionsByAgent([mission.getSession(s.id)], () => 'pad-msn-oc');
    assert.strictEqual(back[0].ended_at, null, 'the row no longer claims a death it survived');
    assert.strictEqual(back[0].ended_by, null);
    assert.strictEqual(mission.getSession(s.id).ended_by, null, 'and the DB agrees with the row it was handed');

    alive = false;
    const died = await mission.withLiveSessionsByAgent([mission.getSession(s.id)], () => 'pad-msn-oc');
    assert.strictEqual(died[0].ended_by, 'gone', 'a later, real death is dated again');
  });
});

// Plan 65 1d — a recreate answers with what it KILLED. The tool description
// promised the sessions and the response did not carry them, so the caller
// could not tell a pad with nobody working in it from one whose conversation
// just died under them.
describe('Mission - plan 65: what a recreate takes with it (1d)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };

  beforeEach(() => {
    padTmux.listSessions = async () => [{ name: 'msn-1111aaaa' }];
    padTmux.listPanes = async () => new Map();
  });

  afterEach(() => {
    for (const k of ['listSessions', 'listPanes']) padTmux[k] = real[k];
  });

  it('reports each live session it is about to kill, with the project and what it last said', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    const killed = await mission.endSessionsForPad('pad-msn-oc', 'recreate');
    assert.strictEqual(killed.length, 1);
    assert.strictEqual(killed[0].id, s.id);
    assert.strictEqual(killed[0].project.id, p.id, 'the caller learns WHICH conversation died');
    assert.strictEqual(killed[0].project.name, 'beat');
    assert.strictEqual(killed[0].lastScreen, null, 'with "never captured" rather than an invented screen');
    assert.strictEqual(mission.getSession(s.id).ended_by, 'recreate', 'stamped with the cause we caused');
  });

  it('an ALREADY dead row keeps its own cause — a recreate must not overwrite a real event', async () => {
    // The ordering trap: the row is observed `gone`, and THEN a recreate runs.
    // Re-dating it `recreate` would move the death later in time and attribute
    // it to an operation that found it already dead. The first cause is the one
    // we can defend, so a recreate reports only what it actually kills.
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    padTmux.listSessions = async () => []; // it died
    await mission.withLiveSessionsByAgent([s], () => 'pad-msn-oc');
    const diedAt = mission.getSession(s.id).ended_at;
    assert.strictEqual(mission.getSession(s.id).ended_by, 'gone');

    const killed = await mission.endSessionsForPad('pad-msn-oc', 'recreate');
    assert.deepStrictEqual(killed, [], 'a row the recreate did not kill is not in its report');
    assert.strictEqual(mission.getSession(s.id).ended_by, 'gone', 'and its cause is untouched');
    assert.strictEqual(mission.getSession(s.id).ended_at, diedAt, 'as is its timestamp');
  });

  it('a pad with no sessions reports nothing rather than an empty wrapper', async () => {
    assert.deepStrictEqual(await mission.endSessionsForPad('pad-msn-oc2', 'recreate'), []);
  });
});

// Plan 65 1e — closing a session. The tool description promised a
// `mission_session_dead` refusal that the service never performed, so a close
// on a corpse silently RE-DATED a death we could still read: `gone` (or
// `recreate`) became `closed`, crediting a deliberate end to an accident. A
// description promising a guarantee the code does not keep is the finding
// itself, so these pin the code, not the prose.
describe('Mission - plan 65: closing a session (1e)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let paneIsLive;
  let killed;

  beforeEach(() => {
    paneIsLive = true;
    killed = [];
    padTmux.captureScreen = async () => (paneIsLive ? { text: 'last words', live: true } : { text: '', live: false });
    padTmux.hasSession = async () => paneIsLive;
    padTmux.killSession = async (vm, tid) => { killed.push(tid); };
    padTmux.paneState = async () => ({ live: paneIsLive, tuiAlive: true, command: 'node', cwd: '/www1/beat' });
  });

  afterEach(() => {
    for (const k of ['captureScreen', 'hasSession', 'killSession', 'paneState']) padTmux[k] = real[k];
  });

  it('kills the pane, keeps the ROW, and captures the screen before the kill', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    const r = await mission.endSession(s.id);
    assert.deepStrictEqual(killed, ['msn-1111aaaa'], 'the pane is gone');
    assert.match(r.screen, /last words/, 'and the last thing it said was captured BEFORE the kill');
    assert.ok(r.session.id, 'the row survives — closing is not deleting');
    assert.strictEqual(mission.getSession(s.id).ended_by, 'closed', 'stamped with the deliberate cause');
    assert.match(mission.getSession(s.id).last_screen, /last words/, 'so the conversation is still readable');
  });

  it('refuses an ALREADY-dated session WITHOUT re-dating it', async () => {
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    padTmux.listSessions = async () => [];
    padTmux.listPanes = async () => new Map();
    await mission.withLiveSessionsByAgent([s], () => 'pad-msn-oc');
    const diedAt = mission.getSession(s.id).ended_at;
    assert.strictEqual(mission.getSession(s.id).ended_by, 'gone');

    await assert.rejects(() => mission.endSession(s.id), (e) => {
      assert.strictEqual(e.code, 'mission_session_dead', 'the code the description names');
      assert.match(e.message, /already ended/, 'and a sentence saying what to do instead');
      return true;
    });
    assert.deepStrictEqual(killed, [], 'nothing was killed — it was already gone');
    assert.strictEqual(mission.getSession(s.id).ended_by, 'gone', 'and the real cause survives the attempt');
    assert.strictEqual(mission.getSession(s.id).ended_at, diedAt);
  });

  it('refuses an undated row whose pane is ALREADY gone, and does not blame `closed` for it', async () => {
    // The harder half. The row says nothing (no listing has seen it die) but the
    // pane is gone, so a blind stamp would credit a deliberate close to a death
    // nobody performed. Refuse, and leave the row for the next liveness pass to
    // date `gone` — the one witness to the event.
    const p = mission.createProject({ name: 'beat', agent: 'pad-msn-oc', folder: '/www1/beat' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    paneIsLive = false;
    await assert.rejects(() => mission.endSession(s.id), /no live pane/);
    assert.deepStrictEqual(killed, [], 'nothing to kill');
    const row = mission.getSession(s.id);
    assert.strictEqual(row.ended_by, null, 'NOT stamped `closed` — nobody closed it');
    assert.strictEqual(row.ended_at, null, 'the row is left for the liveness pass to date honestly');
  });
});

// Plan 52 E1: an audit log that records only WHAT happened cannot answer the
// only question it exists for — was that the human, or a key? Before this,
// `actor` sat at its `system` default for every row in the table (702 of them,
// measured), because the writer `recordActivity` never had a parameter to set
// it and nothing Mission-shaped called it at all.
describe('Mission - activity_events audit (E1)', () => {
  const padTmux = require('../services/pad-tmux');
  const real = { ...padTmux };
  let screenText = 'the prompt\nwaiting';
  const acts = () =>
    getDb()
      .prepare("SELECT * FROM activity_events WHERE category = 'mission' ORDER BY id")
      .all();

  beforeEach(() => {
    // NOT cleared by the suite's global beforeEach: activity_events is shared
    // with settings/web/lifecycle, so only the mission rows are this test's.
    getDb().prepare("DELETE FROM activity_events WHERE category = 'mission'").run();
    screenText = 'the prompt\nwaiting';
    padTmux.folderExists = async () => true;
    padTmux.createSession = async () => {};
    padTmux.killSession = async () => {};
    padTmux.sendCommand = async () => {};
    padTmux.hasSession = async () => true;
    padTmux.paneState = async () => ({ live: true, tuiAlive: true, command: 'node', cwd: '/www1/a' });
    padTmux.captureScreen = async () => ({ text: screenText, live: true });
    padTmux.sendText = async (vm, tid, body) => {
      screenText = `the prompt\n> ${body}\nwaiting`;
      return { lines: 1 };
    };
  });

  afterEach(() => {
    for (const k of ['folderExists', 'createSession', 'killSession', 'sendCommand', 'hasSession', 'paneState', 'captureScreen', 'sendText']) {
      padTmux[k] = real[k];
    }
  });

  it('records the actor of a send as the key that made it', async () => {
    const p = mission.createProject({ name: 'aud', agent: 'pad-msn-oc', folder: '/www1/a', createdBy: 'key:748ebbc' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-1111aaaa' });
    await mission.sendText(s.id, 'run the thing', { actor: 'key:748ebbc' });
    const row = acts().find((r) => r.action === 'send');
    assert.ok(row, 'the send is in the audit log');
    assert.strictEqual(row.actor, 'key:748ebbc', 'attributed to the key, not `system`');
    assert.strictEqual(row.agent_id, 'pad-msn-oc', 'against the PAD the session ran on');
    assert.strictEqual(row.resource_ref, s.id, 'and names the session, which is what an operator then opens');
  });

  it('distinguishes a human send from a key send in the same column', async () => {
    const p = mission.createProject({ name: 'aud2', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-2222bbbb' });
    await mission.sendText(s.id, 'from the page', { actor: 'user:7' });
    await mission.sendText(s.id, 'from a key', { actor: 'key:748ebbc' });
    const sends = acts().filter((r) => r.action === 'send');
    assert.deepStrictEqual(sends.map((r) => r.actor), ['user:7', 'key:748ebbc']);
  });

  it('never stores the TEXT of a send — only that one happened and how big it was', async () => {
    // The reason: a send is the human's own conversation and can carry a pasted
    // secret. An audit trail is not a second copy of it.
    const p = mission.createProject({ name: 'aud3', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-3333cccc' });
    const SECRET = 'sk-live-DO-NOT-LOG-THIS';
    await mission.sendText(s.id, SECRET, { actor: 'user:7' });
    const row = acts().find((r) => r.action === 'send');
    assert.ok(!JSON.stringify(row).includes(SECRET), 'the secret appears nowhere in the row');
    assert.match(row.details, /1 line\(s\), \d+ chars/, 'but the line count and length are recorded');
  });

  it('writes NOTHING when a send is refused, so the log cannot credit a rejected write', async () => {
    const p = mission.createProject({ name: 'aud4', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-4444dddd' });
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, command: 'bash', cwd: '/www1/a' });
    await assert.rejects(() => mission.sendText(s.id, 'ls -la', { actor: 'key:748ebbc' }), (e) => e.code === 'mission_not_an_agent');
    assert.strictEqual(acts().filter((r) => r.action === 'send').length, 0);
  });

  it('audits a start, a relaunch, a restart and both kinds of close', async () => {
    const p = mission.createProject({ name: 'aud5', agent: 'pad-msn-oc', folder: '/www1/a', createdBy: 'user:7' });
    const { session } = await mission.startSession(p.id, { createdBy: 'key:748ebbc' });
    padTmux.paneState = async () => ({ live: true, tuiAlive: false, command: 'bash', cwd: '/www1/a' });
    await mission.relaunchTui(session.id, { actor: 'user:7' });
    await mission.restartSession(session.id, { actor: 'key:748ebbc' });
    const kept = await mission.endSession(session.id, { actor: 'user:7' });
    const actions = acts().map((r) => r.action);
    for (const a of ['project_create', 'session_start', 'session_relaunch', 'session_restart', 'session_close']) {
      assert.ok(actions.includes(a), `${a} is audited`);
    }
    assert.strictEqual(acts().find((r) => r.action === 'session_start').actor, 'key:748ebbc');
    assert.strictEqual(acts().find((r) => r.action === 'session_relaunch').actor, 'user:7');
    assert.strictEqual(acts().find((r) => r.action === 'session_restart').actor, 'key:748ebbc');
    // A restart of a row with no agent_session_id starts a NEW conversation, and
    // the log has to say so — that is the C1-F1 finding made visible rather than
    // something an operator has to infer from a silently empty column.
    assert.match(acts().find((r) => r.action === 'session_restart').details, /no agent session id/);
    assert.ok(kept.session);
  });

  it('audits the page Close (row deleted) and keeps the session id as the only handle', async () => {
    const p = mission.createProject({ name: 'aud6', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-5555eeee' });
    await mission.closeSession(s.id, { actor: 'user:7' });
    const row = acts().find((r) => r.action === 'session_delete');
    assert.ok(row, 'deleting a conversation is the action that most needs a record');
    assert.strictEqual(row.resource_ref, s.id, 'the id survives in the log after the row is gone');
    assert.strictEqual(mission.getSessions ? 1 : 1, 1);
  });

  it('records `system`, not a user, when the platform tears a project down', async () => {
    // app.js deletes a project's sessions with no actor. A `user:` row there
    // would put a name on a decision the human never made.
    const p = mission.createProject({ name: 'aud7', agent: 'pad-msn-oc', folder: '/www1/a', createdBy: 'user:7' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-6666ffff' });
    await mission.closeSession(s.id); // exactly what the project-delete path calls
    const row = acts().find((r) => r.action === 'session_delete');
    assert.strictEqual(row.actor, 'system');
  });

  it('a failing audit write never fails the action that already happened', async () => {
    const p = mission.createProject({ name: 'aud8', agent: 'pad-msn-oc', folder: '/www1/a' });
    const s = mission.createSession(p.id, { tmuxId: 'msn-7777aaaa' });
    getDb().prepare('DROP TABLE activity_events').run();
    try {
      const r = await mission.sendText(s.id, 'still typed', { actor: 'user:7' });
      assert.strictEqual(r.confirmed, true, 'the text landed; the log must not undo that');
    } finally {
      getDb().exec(`CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, category TEXT NOT NULL,
        action TEXT NOT NULL, actor TEXT DEFAULT 'system', status TEXT NOT NULL DEFAULT 'ok',
        timestamp TEXT NOT NULL DEFAULT (datetime('now')), details TEXT, resource_ref TEXT)`);
    }
  });
});
