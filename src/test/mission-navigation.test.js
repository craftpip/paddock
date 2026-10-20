const { it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
register('./helpers/client-store-resolve.mjs', pathToFileURL(__filename));
let store, calls, responses, oldFetch;
const response = (body, status = 200) => ({ status, ok: status < 400, text: async () => JSON.stringify(body), json: async () => body });
const detail = (id, live = false) => ({ session: { id, project_id: 'owner', tmux_id: `tmux-${id}`, agent_session_id: `chat-${id}`, live }, state: { live, tuiAlive: live } });
beforeEach(async () => {
  oldFetch = global.fetch;
  calls = [];
  responses = new Map();
  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });
    if (responses.has(url)) return typeof responses.get(url) === 'function' ? responses.get(url)(url, options) : responses.get(url);
    if (url === '/api/mission/projects/owner') return response({ project: { id: 'owner', name: 'Owner', agent_name: 'pad-test', folder: '/workspace' } });
    if (url === '/api/mission/projects/owner/conversations/chat-1') return response({ project: { id: 'owner', name: 'Owner' }, conversation: { id: 'chat-1', title: 'Saved conversation' } });
    if (/\/sessions\/[^/]+$/.test(url)) return response(detail(url.split('/').pop()));
    return response({ sessions: [], conversations: [], runners: [] });
  };
  ({ useMission: store } = await import(pathToFileURL(path.join(__dirname, '../client/src/stores/mission.js')).href + `?t=${process.hrtime.bigint()}`));
});
afterEach(() => { global.fetch = oldFetch; });

it('restores a dead row independently of the list using only GETs and no recovery', async () => {
  await store.getState().restoreView({ project: 'listing', session: 's1' });
  assert.equal(store.getState().selectedProjectId, 'listing');
  assert.equal(store.getState().openSession.projectId, 'owner');
  assert.equal(store.getState().openSession.agentName, 'pad-test');
  assert.equal(store.getState().sessionState.live, false);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((c) => c.method === 'GET'));
});
it('popup/list-only restoration never clears or replaces the pinned terminal snapshot', async () => {
  await store.getState().restoreView({ session: 's1' });
  const before = store.getState().openSession;
  const states = [];
  const unsubscribe = store.subscribe((s) => states.push(s.openSession?.id));
  await store.getState().restoreView({ project: 'other', session: 's1' });
  unsubscribe();
  assert.equal(store.getState().openSession, before);
  assert.ok(states.every((id) => id === 's1'));
});
it('late A/B reads cannot overwrite Back to A', async () => {
  let firstA, b;
  responses.set('/api/mission/sessions/a', () => new Promise((r) => { firstA = r; }));
  responses.set('/api/mission/sessions/b', () => new Promise((r) => { b = r; }));
  const aRead = store.getState().restoreView({ session: 'a' });
  const bRead = store.getState().restoreView({ session: 'b' });
  responses.set('/api/mission/sessions/a', response(detail('a')));
  await store.getState().restoreView({ session: 'a' });
  b(response(detail('b'))); firstA(response(detail('a')));
  await Promise.all([aRead, bRead]);
  assert.equal(store.getState().openSession.id, 'a');
  assert.equal(store.getState().viewError, '');
});
it('transient failure retains the requested state and retry can restore it', async () => {
  responses.set('/api/mission/sessions/s1', response({ error: 'Offline' }, 503));
  await store.getState().restoreView({ session: 's1' });
  assert.equal(store.getState().viewUnavailable, false);
  assert.equal(store.getState().viewError, 'Offline');
  responses.delete('/api/mission/sessions/s1');
  await store.getState().restoreView({ session: 's1' });
  assert.equal(store.getState().openSession.id, 's1');
});
it('definitive missing/denied targets are distinct from unreadable targets', async () => {
  responses.set('/api/mission/sessions/s1', response({ error: 'Missing' }, 404));
  await store.getState().restoreView({ session: 's1' });
  assert.equal(store.getState().viewUnavailable, true);
  assert.equal(store.getState().openSession, null);
});
it('history-only navigation and clearing selection never start a session', async () => {
  await store.getState().restoreView({ conversation: 'chat-1', terminalProject: 'owner' });
  assert.equal(store.getState().historyView.project.id, 'owner');
  assert.equal(store.getState().openSession, null);
  await store.getState().restoreView({});
  assert.equal(store.getState().historyView, null);
  assert.ok(calls.every((c) => c.method === 'GET'));
});
it('explicit row-open recovery remains a positive twin of read-only restoration', async () => {
  await store.getState().restoreView({ session: 's1' }, { autoReopen: true });
  for (let n = 0; n < 20; n++) await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/restart')).length, 1);
});
it('a late project listing cannot overwrite the current scope', async () => {
  let resolveOld;
  responses.set('/api/mission/projects/a/sessions', () => new Promise((r) => { resolveOld = r; }));
  store.setState({ selectedProjectId: 'a' });
  const oldRead = store.getState().fetchSessions('a');
  store.setState({ selectedProjectId: 'b' });
  responses.set('/api/mission/projects/b/sessions', response({ sessions: [{ id: 'current', project_id: 'b' }] }));
  await store.getState().fetchSessions('b');
  resolveOld(response({ sessions: [{ id: 'old', project_id: 'a' }] }));
  await oldRead;
  assert.equal(store.getState().loadedFor, 'b');
  assert.equal(store.getState().sessions[0].id, 'current');
});
it('fresh re-entry revalidates a previously pinned snapshot before attaching', async () => {
  store.setState({ openSession: { id: 's1', agentName: 'stale-pad' }, sessionState: { live: true } });
  responses.set('/api/mission/sessions/s1', response({ error: 'Denied' }, 403));
  await store.getState().restoreView({ session: 's1' }, { fresh: true });
  assert.equal(store.getState().openSession, null);
  assert.equal(store.getState().viewUnavailable, true);
  assert.ok(calls.every((c) => c.method === 'GET'));
});
it('a late explicit start cannot replace a later URL view or leave its busy flag stuck', async () => {
  let finishStart;
  responses.set('/api/mission/projects/a/sessions', (url, options) => options.method === 'POST'
    ? new Promise((r) => { finishStart = r; }) : response({ sessions: [] }));
  const pending = store.getState().startSession('a');
  assert.equal(store.getState().starting, true);
  await store.getState().restoreView({ session: 'b' });
  finishStart(response({ session: { id: 'started', project_id: 'a', agent_session_id: 'chat-started' } }));
  await pending;
  assert.equal(store.getState().openSession.id, 'b');
  assert.equal(store.getState().starting, false);
});
