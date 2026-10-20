const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

register('./helpers/client-store-resolve.mjs', pathToFileURL(__filename));

// Plan 86 §Phase 2 — the selected-session QUEUE store, pinned behaviourally.
//
// Claims, one per describe:
//  (1) The queue follows col 3, never col 1: resolved from the OPEN session's
//      runner (a runners-list row bound by session_id when it has landed,
//      otherwise the runner embedded in the open snapshot) and fetched
//      independently of `selectedProjectId`.
//  (2) A queue answer that lands after the open session changed is DROPPED —
//      it must never become the next conversation's queue.
//  (3) A failed refresh keeps the last snapshot MARKED STALE — a failed read is
//      not a fresh current/next claim. A failed FIRST read has nothing to keep.
//  (4) Setup (POST) creates only; Update (PUT) sends items+revision and surfaces
//      a CAS conflict as Reload-queue (stale flag), never an automatic overwrite.
//      Neither ever calls Run.
//  (5) `refreshActive` includes the open runner's queue read in the cadence —
//      one GET for the open runner, no timer per row, no fleet scan.

const STORE_URL = pathToFileURL(
  path.join(__dirname, '..', 'client', 'src', 'stores', 'mission.js')
).href;

const json = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

let calls;
let bodies;
let routes;

function route(match, body, status = 200) {
  routes.push([match, body, status]);
}

beforeEach(() => {
  calls = [];
  bodies = [];
  routes = [];
  global.fetch = async (p, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(`${method} ${p}`);
    bodies.push(opts.body ? JSON.parse(opts.body) : null);
    for (const [match, body, status] of routes) {
      if (typeof match === 'string' ? p === match : match.test(p)) {
        if (body && typeof body.then === 'function') return body.then((b) => json(b, status));
        return json(body, status);
      }
    }
    if (p === '/api/mission/projects') return json({ projects: [] });
    if (/^\/api\/mission\/sessions/.test(p)) return json({ sessions: [] });
    if (/^\/api\/mission\/history/.test(p)) return json({ history: [] });
    if (/^\/api\/mission\/runners$/.test(p)) return json({ runners: [] });
    if (/^\/api\/mission\/projects\/.+/.test(p)) return json({ project: null });
    return json({});
  };
});

async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

let store;

function freshStore() {
  return import(`${STORE_URL}?t=${process.hrtime.bigint()}`).then((m) => m.useMission);
}

// The queue payload the real backend returns for a runner whose queue is valid.
// Every queue endpoint answers with the ENVELOPE `{ runner, project, queue,
// updatedAt }`; the store unwraps `queue`.
const QINNER = (revision = 'rev1', extra = {}) => ({
  state: 'running',
  reason: '',
  condition: 'ok',
  error: null,
  revision,
  path: '/www1/alpha/plans/QUEUE.md',
  workerPath: '/www2/alpha/plans/QUEUE.md',
  items: [{ id: 'it1', plan: '1-first.md', status: 'new', reason: '', exists: true, title: 'First' }],
  summary: { total: 1, counts: { new: 1, inProgress: 0, needInput: 0, done: 0 }, current: null, next: { id: 'it1', plan: '1-first.md' }, blocked: null, allDone: false },
  ...extra,
});
const Q = (revision = 'rev1', extra = {}) => ({
  runner: { id: 'run_a', name: 'A', control_state: 'paused', session_id: 'ses_a', queue_file: 'QUEUE.md' },
  project: { id: 'prj_a', name: 'alpha', folder: '/www2/alpha' },
  queue: QINNER(revision, extra),
  updatedAt: '2026-10-11T00:00:00Z',
});

// A runner bound to session `ses_a` through the runners list (the reality a
// poll sees), plus the same runner embedded in the open snapshot.
const RUN_A = { id: 'run_a', name: 'A', session_id: 'ses_a', control_state: 'paused' };
const RUN_B = { id: 'run_b', name: 'B', session_id: 'ses_b', control_state: 'paused' };

function openA() {
  return { id: 'ses_a', agentSessionId: 'con_a', projectId: 'prj_a', runner: RUN_A };
}

async function firstCall(fn, ...args) {
  const s = await freshStore();
  await fn(s, ...args);
  await settle();
  return s;
}

describe('plan 86: the queue follows the OPEN session, independent of the column-1 selection', () => {
  it('resolves the runner from the snapshot even before the runners list lands', async () => {
    const s = await freshStore();
    s.setState({ openSession: openA() }); // runners: [] still — the restore-instant case
    const runner = s.getState().openRunner();
    assert.equal(runner.id, 'run_a');
    assert.equal(runner.name, 'A');
  });

  it('prefers a runners-list row bound by session_id over the embedded snapshot', async () => {
    const s = await freshStore();
    const updated = { ...RUN_A, control_state: 'enabled', last_reason: 'working' };
    s.setState({ runners: [RUN_B, updated], openSession: openA() });
    const runner = s.getState().openRunner();
    assert.equal(runner.id, 'run_a');
    assert.equal(runner.control_state, 'enabled'); // the poll's fresher copy wins
  });

  it('fetches the queue of the open session with a DIFFERENT (or no) col-1 selection', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/queue$/, Q('r1'));
    // col 1 selects project B while col 3 shows A's session — the queue read
    // must still be run_a's.
    s.setState({ selectedProjectId: 'prj_b', runners: [RUN_A], openSession: openA() });
    await s.getState().fetchOpenRunnerQueue();
    await settle();
    const st = s.getState();
    assert.equal(st.queueForRunner, 'run_a');
    assert.equal(st.queue.revision, 'r1');
    assert.equal(st.queue.condition, 'ok');
    assert.equal(st.queueStale, false);
    assert.ok(!('queue' in st.queue)); // the {runner,project,queue} envelope is unwrapped
    assert.ok(calls.includes('GET /api/mission/runners/run_a/queue'));
  });

  it('clears the snapshot and reads nothing when no runner is open', async () => {
    const s = await freshStore();
    await s.getState().fetchOpenRunnerQueue();
    await settle();
    assert.equal(s.getState().queue, null);
    assert.equal(s.getState().queueForRunner, '');
    assert.ok(!calls.some((c) => c.includes('/queue')));
  });
});

describe('plan 86: a queue read that lands after the session switched is dropped', () => {
  it('an answer for the session we LEFT never becomes the new session\'s queue', async () => {
    const s = await freshStore();
    let resolveA;
    const deferredA = new Promise((res) => (resolveA = res));
    route(/\/api\/mission\/runners\/run_a\/queue$/, deferredA);
    route(/\/api\/mission\/runners\/run_b\/queue$/, Q('rB'));

    s.setState({ runners: [RUN_A], openSession: openA() });
    const p1 = s.getState().fetchOpenRunnerQueue(); // A in flight
    await new Promise((r) => setImmediate(r));

    // The user opens a different conversation while A's read is still out.
    s.setState({ runners: [RUN_B], openSession: { id: 'ses_b', agentSessionId: 'con_b', projectId: 'prj_b', runner: RUN_B } });
    await s.getState().fetchOpenRunnerQueue();
    await settle();

    // Now A's answer finally lands — it must be thrown away.
    resolveA(Q('rA'));
    await p1.catch(() => {});
    await settle();

    const st = s.getState();
    assert.equal(st.queueForRunner, 'run_b');
    assert.equal(st.queue.revision, 'rB');
    assert.notEqual(st.queue.revision, 'rA');
  });
});

describe('plan 86: a failed refresh is a STALE read, never a fresh claim', () => {
  it('keeps the last snapshot marked stale when the same runner\'s read fails', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/queue$/, Q('r1'));
    s.setState({ runners: [RUN_A], openSession: openA() });
    await s.getState().fetchOpenRunnerQueue();
    await settle();
    assert.equal(s.getState().queueStale, false);

    // The next refresh (a poll) fails.
    routes.length = 0;
    route(/\/api\/mission\/runners\/run_a\/queue$/, { error: 'boom' }, 500);
    await s.getState().fetchOpenRunnerQueue();
    await settle();

    const st = s.getState();
    assert.equal(st.queueForRunner, 'run_a');
    assert.equal(st.queue.revision, 'r1'); // last known good retained
    assert.equal(st.queueStale, true); // ...and NOT presented as the truth
    assert.match(st.queueError, /boom/);
  });

  it('a failed FIRST read holds no snapshot and reports the error', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/queue$/, { error: 'down' }, 500);
    s.setState({ runners: [RUN_A], openSession: openA() });
    await s.getState().fetchOpenRunnerQueue();
    await settle();
    const st = s.getState();
    assert.equal(st.queue, null);
    assert.equal(st.queueForRunner, '');
    assert.equal(st.queueStale, false);
    assert.match(st.queueError, /down/);
  });
});

describe('queue blocker resolution failures remain actionable', () => {
  it('surfaces and rethrows a revision conflict so the modal stays open', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/resolve$/, {
      error: 'Queue was modified since you loaded it — reload and retry',
      code: 'queue_revision_conflict',
    }, 400);

    await assert.rejects(
      () => s.getState().resolveRunnerQueue('run_a', { itemId: 'it1', answer: 'confirmed', revision: 'rev1' }),
      (e) => e.code === 'queue_revision_conflict'
    );
    await settle();

    const feedback = s.getState().operationFeedback.run_a;
    assert.equal(feedback.severity, 'warning');
    assert.match(feedback.message, /reload and retry/i);
    assert.equal(s.getState().queueAction, '');
  });
});

describe('plan 86: setup creates only; update is a CAS write; neither calls Run', () => {
  it('setup POSTs, applies the created queue, and never touches /start', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/queue$/, Q('fresh'));
    s.setState({ runners: [RUN_A], openSession: openA(), queue: null, queueForRunner: '' });
    await s.getState().setupRunnerQueue('run_a');
    await settle();
    const st = s.getState();
    assert.ok(calls.includes('POST /api/mission/runners/run_a/queue'));
    assert.equal(st.queueForRunner, 'run_a');
    assert.equal(st.queue.revision, 'fresh');
    assert.equal(st.queueAction, '');
    assert.ok(!calls.some((c) => c.includes('/start')));
  });

  it('update sends items + revision and applies the response', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/queue$/, Q('rev2', { items: [] }));
    s.setState({ runners: [RUN_A], openSession: openA() });
    await s.getState().updateRunnerQueue('run_a', [{ id: 'x', status: 'new' }], 'rev1');
    await settle();
    const put = calls.find((c) => c.startsWith('PUT /api/mission/runners/run_a/queue'));
    assert.ok(put);
    const sent = bodies.find(Boolean);
    assert.deepEqual(sent.items, [{ id: 'x', status: 'new' }]);
    assert.equal(sent.revision, 'rev1');
    assert.equal(s.getState().queue.revision, 'rev2');
    assert.equal(s.getState().queueStale, false);
    assert.ok(!calls.some((c) => c.includes('/start')));
  });

  it('a revision conflict keeps the snapshot, marks it STALE, and does not retry', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/queue$/, Q('rev1'));
    s.setState({ runners: [RUN_A], openSession: openA() });
    await s.getState().fetchOpenRunnerQueue();
    await settle();
    assert.equal(s.getState().queueStale, false);

    routes.length = 0;
    route(/\/api\/mission\/runners\/run_a\/queue$/, {
      error: 'Queue was modified by another writer (expected rev1, current rev9). Reload and retry.',
      code: 'queue_revision_conflict',
    }, 400);

    let err = null;
    try {
      await s.getState().updateRunnerQueue('run_a', [], 'rev1');
    } catch (e) {
      err = e;
    }
    await settle();

    const st = s.getState();
    assert.equal(err.code, 'queue_revision_conflict');
    assert.equal(st.queueForRunner, 'run_a');
    assert.equal(st.queue.revision, 'rev1'); // last known good retained
    assert.equal(st.queueStale, true); // Reload queue surface
    assert.match(st.queueError, /Reload/);
    assert.equal(st.queueAction, '');
  });
});

describe('plan 86: the open queue rides the existing refresh cadence', () => {
  it('refreshActive reads the open runner\'s queue ONCE alongside runners and the sessions list', async () => {
    const s = await freshStore();
    route(/\/api\/mission\/runners\/run_a\/queue$/, Q('r1'));
    s.setState({ runners: [RUN_A], openSession: openA(), selectedProjectId: 'prj_a' });
    // Forcing the run so the un-awaited reads inside refreshActive complete
    // before assertions — same entry point the 15s poll uses.
    await s.getState().fetchOpenRunnerQueue();
    await settle();

    calls.length = 0;
    routes.length = 0;
    // The poll cycle: one runner listing + one queue read, not a fleet scan.
    s.setState({ runners: [RUN_A] });
    await s.getState().refreshActive();
    await settle();

    const queues = calls.filter((c) => c.includes('/queue'));
    assert.equal(queues.length, 1);
    assert.equal(queues[0], 'GET /api/mission/runners/run_a/queue');
    assert.ok(calls.includes('GET /api/mission/projects/prj_a/runners'));
    assert.ok(!calls.some((c) => c.includes('/queue') && c.includes('run_b')));
  });
});
