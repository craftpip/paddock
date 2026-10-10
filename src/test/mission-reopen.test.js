const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const { register } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

// The client store is written for Vite's resolver; Node needs a nudge for its
// extensionless relative imports. Registered before the dynamic import below.
register('./helpers/client-store-resolve.mjs', pathToFileURL(__filename));

// Plan 68 — the auto-reopen ORDER, pinned behaviourally.
//
// The defect: on a SUCCEEDING reopen, clearing `reopenFor` before re-reading the
// pane leaves `sessionState` holding the pre-restart `{ live: false }` while the
// guard is already null — exactly the pair Mission.jsx renders as "This session
// is closed" + a pointless Reopen button. Measured live at 376ms between
// "Reopening…" and the terminal.
//
// The invariant is therefore NOT "reopenFor is eventually cleared" (both orders
// satisfy that, so such an assert cannot fail) but:
//
//   once the reopen has STARTED, the guard must never read null while
//   sessionState is still the dead read.
//
// The `once started` qualifier matters. Before `reopenFor` is set there is
// genuinely a (null, live:false) state — the detection read landing — and it is
// harmless because the set that follows is in the SAME synchronous block, so
// React batches them into one paint. A predicate that ignored the qualifier would
// fail on correct code and would have been "fixed" by weakening itself.

const STORE_URL = pathToFileURL(
  path.join(__dirname, '..', 'client', 'src', 'stores', 'mission.js')
).href;

const SESSION_ID = 'msn_test68';
const SNAPSHOT = {
  id: SESSION_ID,
  tmux_id: 'msn_test68',
  label: '',
  locked: false,
  projectId: 'prj_test',
  agentName: 'pad-opencode-proj',
  folder: '/www2/paddock',
};

let store;
let fetchStub;
let observed;

const json = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

/** Mission API stand-in. `paneReads` is consumed IN ORDER, so `[dead, alive]`
 *  models a restart that actually worked and `[dead, dead]` a restart that came
 *  back with no pane. Unlisted reads answer alive, so a listing refresh cannot
 *  accidentally become the thing under test. Every other endpoint answers
 *  empty-but-valid, including the listing `refreshActive` triggers, so the reopen
 *  path runs end to end rather than short-circuiting. */
function stubFetch({ paneReads, restartFails } = {}) {
  const queue = [...(paneReads || [])];
  fetchStub = async (p, opts = {}) => {
    const method = opts.method || 'GET';
    fetchStub.calls.push(`${method} ${p}`);
    if (p === `/api/mission/sessions/${SESSION_ID}`) {
      const next = queue.length ? queue.shift() : { live: true };
      return json({ state: { live: next.live, cwd: '/www2/paddock' } });
    }
    if (p === `/api/mission/sessions/${SESSION_ID}/restart`) {
      if (restartFails) {
        return json(
          { error: 'mission_folder_missing', message: 'The project folder is gone' },
          409
        );
      }
      return json({ ok: true });
    }
    if (p.startsWith('/api/mission/sessions')) return json({ sessions: [] });
    if (p.startsWith('/api/mission/history')) return json({ history: [] });
    if (p.startsWith('/api/mission/projects')) return json({ projects: [] });
    return json({});
  };
  fetchStub.calls = [];
  global.fetch = fetchStub;
}

/** Let an in-flight reopen finish. `selectSession` deliberately does NOT return
 *  the promise (a click handler ignores it), so a test cannot simply await it —
 *  which is exactly why this was browser-only before. Each round drains every
 *  queued microtask, so the nested read → restart → refresh → re-read chain
 *  completes well inside the budget. */
async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

const restarts = () => fetchStub.calls.filter((c) => c.endsWith('/restart'));
const paneReads = () =>
  fetchStub.calls.filter((c) => c === `GET /api/mission/sessions/${SESSION_ID}`);

/** Index of the first state where the reopen is actually under way. */
const reopenStartedAt = () => observed.findIndex((s) => s.reopenFor === SESSION_ID);

/** The bug, over the states that exist AFTER the reopen started. */
function sawDeadEndFlash() {
  const from = reopenStartedAt();
  if (from === -1) return false;
  return observed
    .slice(from)
    .some((s) => s.reopenFor === null && s.live === false);
}

/** The row-click path under test, driven the way the page drives it. */
async function clickDeadRow() {
  store.getState().selectSession(SESSION_ID);
  await settle();
}

beforeEach(async () => {
  stubFetch({ paneReads: [{ live: false }, { live: true }] });
  // A fresh module instance per test: a zustand store is a module singleton, and
  // a carried-over `reopenFor` would make the ordering assertions pass for free.
  ({ useMission: store } = await import(`${STORE_URL}?t=${process.hrtime.bigint()}`));
  store.setState({
    sessions: [{ id: SESSION_ID, live: false, project: { id: 'prj_test' } }],
    projects: [{ id: 'prj_test', name: 'paddock', folder: '/www2/paddock' }],
    // ALREADY OPEN. Without this every direct fetchSessionState call takes the
    // "the user left on another row" early return — which made a "the poll never
    // restarts" test pass for the wrong reason, asserting nothing at all.
    openSession: { ...SNAPSHOT },
    selectedConversationId: SESSION_ID,
    sessionState: null,
    reopenFor: null,
    reopenError: '',
  });
  observed = [];
  store.subscribe((s) => {
    observed.push({
      reopenFor: s.reopenFor,
      live: s.sessionState ? s.sessionState.live : null,
    });
  });
});

describe('plan 68: reopening a dead session does not flash the closed notice', () => {
  it('never clears the guard while sessionState is still the dead read', async () => {
    await clickDeadRow();

    assert.ok(reopenStartedAt() !== -1, 'the reopen must actually have started');
    assert.ok(
      !sawDeadEndFlash(),
      `col 3 fell through to "This session is closed" mid-reopen. States: ${JSON.stringify(observed)}`
    );
  });

  it('ends on the POST-restart read with the guard released', async () => {
    await clickDeadRow();

    const s = store.getState();
    assert.equal(s.reopenFor, null, 'the guard must be released once settled');
    assert.equal(s.reopenError, '');
    assert.deepEqual(
      s.sessionState,
      { live: true, cwd: '/www2/paddock' },
      'the reported state must be the POST-restart read, not the dead one'
    );
  });

  it('restarts once, and reports the outcome from a read AFTER it', async () => {
    await clickDeadRow();

    assert.deepEqual(restarts(), [`POST /api/mission/sessions/${SESSION_ID}/restart`]);
    const restartAt = fetchStub.calls.findIndex((c) => c.endsWith('/restart'));
    assert.ok(restartAt !== -1, 'a restart must have been issued');
    assert.ok(
      fetchStub.calls.indexOf(`GET /api/mission/sessions/${SESSION_ID}`) < restartAt,
      'one read must detect the dead pane BEFORE the restart'
    );
    // Two reads land after the restart, not one, and both are correct: the
    // `refreshActive()` inside the reopen already re-reads the open session
    // (fetchAll → fetchSessionState), and the awaited read after it is the one
    // the ordering comment is about. Pinning "exactly one" here would have been
    // an assertion about a detail the store never promised.
    const after = fetchStub.calls
      .slice(restartAt + 1)
      .filter((c) => c === `GET /api/mission/sessions/${SESSION_ID}`);
    assert.ok(after.length >= 1, 'the outcome must be read from a pane state taken after the restart');
  });

  it('a second read of the same row does not fire a second restart', async () => {
    // The second read sees the pane the first reopen produced, so it must not
    // reopen; and the re-read carries no autoReopen, so it could not have.
    await clickDeadRow();
    await store.getState().fetchSessionState(SESSION_ID, { autoReopen: true });
    await settle();

    assert.equal(restarts().length, 1, 'two live panes on one conversation');
  });

  it('the outcome read never restarts again, even if the pane is still dead', async () => {
    // Forced the interesting way: the restart "succeeded" but the pane did not
    // come up. A re-read carrying autoReopen would restart again — on the poll,
    // forever. This is the loop guard plan 68 also has to hold.
    stubFetch({ paneReads: [{ live: false }, { live: false }] });
    store.setState({ reopenFor: null, reopenError: '', sessionState: null });

    await store.getState().fetchSessionState(SESSION_ID, { autoReopen: true });
    await settle();

    assert.equal(restarts().length, 1, 'the outcome read must not restart a second time');
    assert.equal(store.getState().reopenFor, null);
    assert.equal(store.getState().reopenError, '', 'a still-dead pane is not an error');
  });
});

describe('plan 68: the guard covers the whole reopen', () => {
  it('holds reopenFor until the restart completes', async () => {
    // The window the guard exists for. If it cleared early, a poll landing in
    // here would see a dead pane, no guard, and open a SECOND conversation.
    let release;
    const gate = new Promise((r) => { release = r; });
    const inner = fetchStub;
    global.fetch = async (p, opts) => {
      if (String(p).endsWith('/restart')) await gate;
      return inner(p, opts);
    };

    store.getState().fetchSessionState(SESSION_ID, { autoReopen: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(store.getState().reopenFor, SESSION_ID, 'guard must be held while restarting');

    release();
    await settle();
    assert.equal(store.getState().reopenFor, null);
  });

  it('the poll path never restarts a dead session', async () => {
    stubFetch({ paneReads: [{ live: false }] });
    store.setState({ openSession: { ...SNAPSHOT }, sessionState: null });

    await store.getState().fetchSessionState(SESSION_ID);
    await settle();

    // Proves the fixture can express the difference at all: the same dead pane,
    // the same code path, WITH the flag does restart.
    assert.deepEqual(restarts(), [], "a pane that dies while you watch it is the human's call");
    const s = store.getState();
    assert.equal(s.reopenFor, null);
    assert.equal(s.reopenError, '');
    assert.deepEqual(s.sessionState, { live: false, cwd: '/www2/paddock' });
  });

  it('reports a failed reopen with the server own reason, and releases the guard', async () => {
    stubFetch({ paneReads: [{ live: false }, { live: false }], restartFails: true });

    await store.getState().fetchSessionState(SESSION_ID, { autoReopen: true });
    await settle();

    const s = store.getState();
    assert.match(s.reopenError, /folder is gone/i, "the server's reason must reach the UI");
    assert.equal(s.reopenFor, null, 'a failed reopen must not wedge the guard on');
    assert.equal(restarts().length, 1, 'a failure must not become a retry loop');
  });
});