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

describe('plan 68: the all view never hijacks the selection', () => {
  it('fetchAll follows a live row to the HIGHLIGHT, never to selectedProjectId', async () => {
    store = await freshStore();
    route(/^\/api\/mission\/sessions$/, {
      sessions: [{ id: 'msn_x', live: true, project: { id: 'prj_a' } }],
    });
    store.setState({ selectedProjectId: '' });
    await store.getState().fetchAll();
    await settle();

    assert.strictEqual(store.getState().selectedSessionId, 'msn_x', 'the row is still highlighted');
    assert.strictEqual(store.getState().selectedProjectId, '',
      'the row\'s project must not become the selection — that would flip the very list that just loaded');
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

  it('hydrates the three view fields from localStorage on store creation', async () => {
    seedStorage({
      selectedProjectId: 'prj_a',
      selectedSessionId: 'msn_z',
      openSession: { id: 'msn_z', projectId: 'prj_a', agentName: 'pad-opencode-proj', folder: '/www2/alpha' },
    });
    store = await freshStore();
    await settle();

    assert.strictEqual(store.getState().selectedProjectId, 'prj_a');
    assert.strictEqual(store.getState().selectedSessionId, 'msn_z');
    assert.strictEqual(store.getState().openSession?.id, 'msn_z');
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

  it('clears an open session whose project has vanished (validation on fetch)', async () => {
    seedStorage({
      selectedProjectId: 'prj_a',
      selectedSessionId: 'msn_z',
      openSession: { id: 'msn_z', projectId: 'prj_gone', agentName: 'pad-opencode-proj', folder: '/www2/gone' },
    });
    store = await freshStore();
    route(/^\/api\/mission\/projects$/, { projects: PROJECTS });
    await store.getState().fetchProjects();
    await settle();

    assert.strictEqual(store.getState().openSession, null,
      'a snapshot whose project is deleted cannot render a terminal — it must be dropped');
    assert.strictEqual(store.getState().sessionState, null);
    // The selection itself also survives only while its project does.
    assert.strictEqual(store.getState().selectedProjectId, 'prj_a', 'the SELECTED project still exists, so it survives');
  });

  it('a corrupt persisted blob is ignored, not fatal to the store', async () => {
    seedStorage('{not json');
    store = await freshStore();
    await settle();
    assert.strictEqual(store.getState().selectedProjectId, '');
    assert.strictEqual(store.getState().openSession, null);
  });
});