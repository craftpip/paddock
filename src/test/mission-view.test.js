const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

register('./helpers/client-store-resolve.mjs', pathToFileURL(__filename));

// Plan 68 — the store's VIEW layer, pinned behaviourally.
//
// Three claims, one per describe:
//  (1) The selection IS the scope. `''` = the all view, and since plan 68 there
//      is NO fallback to "always one project selected" (Finding A): a project
//      list that arrives without the selection leaves it `''`, and `fetchAll`
//      is the read that selection implies. Auto-selecting `projects[0]` is the
//      exact dead-end the finding named — a refresh would keep hijacking the
//      user's view to one project.
//  (2) Clicking the selected project again DESELECTS (Idea 1). Toggling — not
//      "no-op when same" — is what makes "pick nothing" an honest state instead
//      of a corner.
//  (3) A refresh keeps the page state (Idea 2): the three view fields persist
//      together and hydrate together, and a selection/open-session whose project
//      has vanished is cleared rather than left pointing at a deleted row.

const STORE_URL = pathToFileURL(
  path.join(__dirname, '..', 'client', 'src', 'stores', 'mission.js')
).href;

const json = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Mission API stand-in. `route()` adds a URL→body mapping; anything unrouted
 *  answers empty-but-valid, so the paths under test run end to end rather than
 *  short-circuiting. `calls` records every request so tests can assert what the
 *  store actually asked for. */
let calls;
let routes;

function route(match, body, status = 200) {
  routes.push([match, body, status]);
}

beforeEach(() => {
  calls = [];
  routes = [];
  global.fetch = async (p, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${p}`);
    for (const [match, body, status] of routes) {
      if (typeof match === 'string' ? p === match : match.test(p)) return json(body, status);
    }
    if (p === '/api/mission/projects') return json({ projects: [] });
    if (/^\/api\/mission\/sessions/.test(p)) return json({ sessions: [] });
    if (/^\/api\/mission\/history/.test(p)) return json({ history: [] });
    if (/^\/api\/mission\/projects\/.+/.test(p)) return json({ project: null });
    return json({});
  };
});

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

let store;

const PROJECTS = [
  { id: 'prj_a', name: 'alpha', folder: '/www2/alpha' },
  { id: 'prj_b', name: 'beta', folder: '/www2/beta' },
];

function freshStore() {
  return import(`${STORE_URL}?t=${process.hrtime.bigint()}`).then((m) => m.useMission);
}

describe('plan 68: the selection IS the scope — no auto-select fallback', () => {
  it('a project list that arrives with no matching selection leaves `""` (Finding A)', async () => {
    store = await freshStore();
    route(/^\/api\/mission\/projects$/, { projects: PROJECTS });
    await store.getState().fetchProjects();
    await settle();

    assert.strictEqual(store.getState().selectedProjectId, '',
      'no selection present → no project is invented as a fallback');
    // And the no-selection view is the aggregate one: the read fires.
    assert.ok(calls.includes('GET /api/mission/sessions'), 'the all view re-read is the one the selection implies');
  });

  it('a selection that survived keeps the project scoped read, not the aggregate', async () => {
    store = await freshStore();
    route(/^\/api\/mission\/projects$/, { projects: PROJECTS });
    route(/^\/api\/mission\/projects\/prj_b\/sessions$/, { sessions: [] });
    route(/^\/api\/mission\/projects\/prj_b\/history/, { history: [] });
    store.setState({ selectedProjectId: 'prj_b' });
    await store.getState().fetchProjects();
    await settle();

    assert.strictEqual(store.getState().selectedProjectId, 'prj_b');
    assert.ok(calls.includes('GET /api/mission/projects/prj_b/sessions'));
    assert.ok(!calls.includes('GET /api/mission/sessions'), 'a selection must not also fire the aggregate read');
  });
});

describe('plan 68: clicking the selected project again deselects (Idea 1)', () => {
  it('select → select same → `""` and the all view loads', async () => {
    store = await freshStore();
    store.getState().select('prj_a');
    assert.strictEqual(store.getState().selectedProjectId, 'prj_a');

    store.getState().select('prj_a');
    assert.strictEqual(store.getState().selectedProjectId, '',
      'same project clicked again → deselected to the all view');
    assert.deepStrictEqual(store.getState().sessions, [], 'the stale list is dropped with the selection');
    assert.strictEqual(store.getState().history, null, 'the stale history is dropped with the selection');
    await settle();
    assert.ok(calls.includes('GET /api/mission/sessions'), 'deselecting reads the aggregate');
  });

  it('select → select a DIFFERENT project switches scope without fetching the aggregate', async () => {
    store = await freshStore();
    store.getState().select('prj_a');
    store.getState().select('prj_b');
    assert.strictEqual(store.getState().selectedProjectId, 'prj_b');
    await settle();
    assert.ok(!calls.includes('GET /api/mission/sessions'), 'a scope switch must not read the aggregate');
  });
});

describe('plan 80: a fetch never invents a highlight', () => {
  it('fetchAll with no prior selection highlights NOTHING (plan 73 phantom)', async () => {
    store = await freshStore();
    route(/^\/api\/mission\/sessions$/, {
      sessions: [{ id: 'msn_x', live: true, agent_session_id: 'ses_x', project: { id: 'prj_a' } }],
    });
    store.setState({ selectedProjectId: '' });
    await store.getState().fetchAll();
    await settle();

    assert.strictEqual(store.getState().selectedConversationId, '',
      'a fetch must not adopt a live row on its own — that is the phantom `msn-row-selected`');
    assert.strictEqual(store.getState().selectedProjectId, '',
      'the row\'s project must not become the selection — that would flip the very list that just loaded');
  });

  it('a fetch PRESERVES a selection the user made', async () => {
    store = await freshStore();
    route(/^\/api\/mission\/sessions$/, {
      sessions: [{ id: 'msn_x', live: true, agent_session_id: 'ses_x', project: { id: 'prj_a' } }],
    });
    store.setState({ selectedProjectId: '', selectedConversationId: 'ses_x' });
    await store.getState().fetchAll();
    await settle();

    assert.strictEqual(store.getState().selectedConversationId, 'ses_x', 'the highlight survives a refresh');
  });

  it('the PROJECT-scoped fetch invents nothing either (the other spread site)', async () => {
    store = await freshStore();
    route(/^\/api\/mission\/projects\/prj_a\/sessions$/, {
      sessions: [{ id: 'msn_y', live: true, agent_session_id: 'ses_y', project: { id: 'prj_a' } }],
    });
    store.setState({ selectedProjectId: 'prj_a' });
    await store.getState().fetchSessions('prj_a');
    await settle();

    assert.strictEqual(store.getState().selectedConversationId, '',
      'a project list landing must not adopt its first live row either');
  });

  it('selectSession is the user action that owns BOTH the highlight and col 3', async () => {
    store = await freshStore();
    store.setState({
      selectedProjectId: '',
      sessions: [{
        id: 'msn_x',
        live: true,
        agent_session_id: 'ses_x',
        label: 'row',
        project: { id: 'prj_a', name: 'alpha', agent_name: 'pad-a', folder: '/www2/a' },
      }],
    });
    store.getState().selectSession('msn_x');
    await settle();

    assert.strictEqual(store.getState().selectedConversationId, 'ses_x');
    assert.strictEqual(store.getState().openSession?.id, 'msn_x');
    assert.strictEqual(store.getState().openSession?.projectId, 'prj_a');
  });

  it('a row vanishing on refetch clears NEITHER the highlight nor col 3 (plan 80)', async () => {
    // Plan 73 was written before plan 80 made the highlight a CONVERSATION:
    // a close drops the live row but the history twin carries the same id, and
    // a read is never allowed to move either selection. So the plan's original
    // "row vanishes → highlight clears" expectation is superseded on purpose.
    store = await freshStore();
    route(/^\/api\/mission\/sessions$/, { sessions: [] });
    store.setState({
      selectedProjectId: '',
      selectedConversationId: 'ses_x',
      openSession: { id: 'msn_x', agentSessionId: 'ses_x', projectId: 'prj_a' },
      sessions: [{ id: 'msn_x', live: true, agent_session_id: 'ses_x' }],
    });
    await store.getState().fetchAll();
    await settle();

    assert.strictEqual(store.getState().selectedConversationId, 'ses_x',
      'the selection is the user\'s conversation and survives the row going away');
    assert.strictEqual(store.getState().openSession?.id, 'msn_x',
      'a read must not move col 3 either');
  });

  it('close does NOT clear the highlight — the conversation stays selected', async () => {
    store = await freshStore();
    route(/^\/api\/mission\/sessions\/msn_x$/, {}, 204);
    route(/^\/api\/mission\/sessions$/, { sessions: [] });
    store.setState({
      selectedProjectId: '',
      selectedConversationId: 'ses_x',
      openSession: { id: 'msn_x', agentSessionId: 'ses_x', projectId: 'prj_a' },
    });
    await store.getState().closeSession('msn_x');
    await settle();

    assert.strictEqual(store.getState().selectedConversationId, 'ses_x',
      'closing the pane removes the pane, not the conversation — the row must stay highlighted');
    assert.strictEqual(store.getState().openSession, null, 'but col 3 is emptied');
  });
});

describe('Mission popout handoff', () => {
  it('detaches only the matching embedded view without issuing a destructive request', async () => {
    store = await freshStore();
    store.setState({
      selectedConversationId: 'ses_x',
      openSession: { id: 'msn_x', agentSessionId: 'ses_x', projectId: 'prj_a' },
      sessionState: { live: true },
    });
    assert.strictEqual(store.getState().detachSession('msn_other'), false);
    assert.strictEqual(store.getState().openSession.id, 'msn_x', 'another popup cannot displace the embedded session');
    assert.strictEqual(store.getState().detachSession('msn_x'), true);
    assert.strictEqual(store.getState().openSession, null);
    assert.strictEqual(store.getState().sessionState, null);
    assert.strictEqual(store.getState().selectedConversationId, 'ses_x', 'detaching a view does not unselect its conversation');
    assert.ok(!calls.some((call) => call.startsWith('DELETE ') || call.includes('/restart')), 'handoff does not end or restart a session');
  });
});

describe('plan 68: the view persists and hydrates (Idea 2)', () => {
  function seedStorage(view) {
    const box = {};
    global.localStorage = {
      getItem: (k) => (k in box ? box[k] : null),
      setItem: (k, v) => { box[k] = String(v); },
      removeItem: (k) => { delete box[k]; },
    };
    if (view !== undefined) box['pad-mission-view'] = JSON.stringify(view);
    return box;
  }

  it('exposes the persisted view for the URL bootstrap, and restoreView applies it', async () => {
    // Plan 93 moved hydration out of store creation: the store exposes the
    // parsed blob as `persistedView`, the navigation hook seeds the URL from it,
    // and `restoreView` is what applies (and revalidates) it. The fact is the
    // same — a refresh keeps the view — so the assertion follows its new home.
    seedStorage({
      selectedProjectId: 'prj_a',
      selectedConversationId: 'ses_z',
      openSession: { id: 'msn_z', agentSessionId: 'ses_z', projectId: 'prj_a', agentName: 'pad-opencode-proj', folder: '/www2/alpha' },
    });
    store = await freshStore();
    await settle();

    const persisted = store.getState().persistedView;
    assert.strictEqual(persisted.selectedProjectId, 'prj_a');
    assert.strictEqual(persisted.selectedConversationId, 'ses_z');
    assert.strictEqual(persisted.openSession?.id, 'msn_z');

    route(/^\/api\/mission\/sessions\/msn_z$/, {
      session: { id: 'msn_z', agent_session_id: 'ses_z', project_id: 'prj_a', title: 'z' },
      project: PROJECTS[0],
    });
    await store.getState().restoreView({ project: 'prj_a', session: 'msn_z' }, { fresh: true });
    await settle();

    assert.strictEqual(store.getState().selectedProjectId, 'prj_a');
    assert.strictEqual(store.getState().selectedConversationId, 'ses_z');
    assert.strictEqual(store.getState().openSession?.id, 'msn_z');
  });

  it('an old blob without `selectedConversationId` falls back to the open snapshot id', async () => {
    // Post-deploy migration (plan 80): the field was `selectedSessionId` and held
    // the MISSION id. A blob from that shape has no `selectedConversationId`, so
    // the open snapshot's conversation id stands in for one reload.
    seedStorage({
      selectedProjectId: 'prj_a',
      selectedSessionId: 'msn_z',
      openSession: { id: 'msn_z', agentSessionId: 'ses_z', projectId: 'prj_a', agentName: 'pad-opencode-proj', folder: '/www2/alpha' },
    });
    store = await freshStore();
    await settle();

    // The fallback lives in the persisted-view reader now (plan 93 moved the
    // application to the URL bootstrap); the highlight still survives the
    // rename, which is the fact that matters.
    assert.strictEqual(store.getState().persistedView.selectedConversationId, 'ses_z',
      'the highlight survives the rename by falling back to the snapshot conversation');
  });

  it('writes the same three fields back on every change', async () => {
    seedStorage({});
    store = await freshStore();
    store.getState().select('prj_b');
    await settle();

    const saved = JSON.parse(global.localStorage.getItem('pad-mission-view'));
    assert.strictEqual(saved.selectedProjectId, 'prj_b', 'a selection change persists');
  });

  it('a null openSession persists AS null — the key must not silently vanish', async () => {
    // Regression (plan 68, live-found): a store whose `openSession` was
    // `undefined` (first visit, empty blob) serialized with the key ABSENT, so
    // no write ever carried it and a refresh could never restore the terminal.
    seedStorage({});
    store = await freshStore();
    store.setState({ loading: false });
    await settle();

    const saved = JSON.parse(global.localStorage.getItem('pad-mission-view'));
    assert.ok('openSession' in saved, 'null must be serialized as null, not dropped as undefined');
    assert.strictEqual(saved.openSession, null);
  });

  it('refuses to restore a snapshot whose row no longer resolves (plan 93)', async () => {
    // Plan 93 replaced the old "the project listing clears the snapshot" rule
    // with the stronger one: a LISTING is not authority over a pinned terminal;
    // only a resolution verdict from the row's own read clears/refuses it. The
    // guarantee — a vanished project cannot render a terminal — is asserted at
    // the new source instead.
    seedStorage({
      selectedProjectId: 'prj_a',
      selectedConversationId: 'ses_z',
      openSession: { id: 'msn_z', agentSessionId: 'ses_z', projectId: 'prj_gone', agentName: 'pad-opencode-proj', folder: '/www2/gone' },
    });
    store = await freshStore();
    route(/^\/api\/mission\/sessions\/msn_z$/, { error: 'not found' }, 404);
    await store.getState().restoreView({ project: '', session: 'msn_z' }, { fresh: true });
    await settle();

    assert.strictEqual(store.getState().openSession, null,
      'a snapshot that cannot resolve cannot render a terminal');
    assert.strictEqual(store.getState().viewUnavailable, true,
      'a 404 is the verdict that makes it unavailable (not a transient read failure)');
    assert.ok(store.getState().viewError, 'and the column can say why');
  });

  it('a corrupt persisted blob is ignored, not fatal to the store', async () => {
    seedStorage('{not json');
    store = await freshStore();
    await settle();
    assert.strictEqual(store.getState().selectedProjectId, '');
    assert.strictEqual(store.getState().openSession, null);
  });
});
