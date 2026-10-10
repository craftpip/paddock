# Plan 80 — Mission: a row is a conversation — it keeps its name (and its selection) when the pane closes

## Status: Complete — absorbed 2026-10-10. All 6 items built, tested (142 tests pass), live-verified.

## Report (the user's words)

> When in the missions panel I open a new session, it first starts with like an
> `msn` session id. So it shows like the "MSN" tmux id … After I chat in it, the
> agent gives the chat a name and only then does the session listing show
> something different. … what I do next is I close the terminal for that session
> — as soon as I close it the MSN thing disappears and appears as a different
> name directly. And it is not selected, which should be selected right. It
> basically comes up as a different item.

## The bug in one sentence

The live session row and the history row for **the same conversation** are
rendered as two different items — different name, different key, and only one of
them can ever be highlighted — so a fresh session reads as `msn-…`, and the
moment it is closed it "renames" and de-highlights into what looks like a new
row.

## Diagnosis (read from the code, not guessed)

### Symptom A — the live row is named by the tmux id

- A live row renders `session.label || session.tmux_id`
  (`src/client/src/components/SessionList.jsx:93`, and the col-3 header at
  `src/client/src/pages/Mission.jsx:594`).
- `+ New session` posts no label (`startSession` sends `{ label: '', agentSessionId: '' }`,
  `stores/mission.js:421`), so a fresh session shows its `tmux_id` (`msn-…`).
  Only a *resume* sets a label, and it is a snapshot of the title at resume time
  (`SessionList.jsx:403`), i.e. stale the moment the agent renames.
- The agent's own conversation title **is already reachable for free**: the list
  routes stamp `live/kind/busy/open` through `withLiveSessions` + `withAgentBusy`
  (`app.js:2665-2677`), and `withAgentBusy` → `busyForSessions`
  (`services/mission.js:1335`) already does one `agentStore.readActivity(vm, id)`
  per row — whose return value **already carries `title`**
  (`services/agent-store.js:545`). `busyForSessions` simply throws it away,
  keeping only `{ busy, known }`.
- The history row renders `item.title` (`SessionList.jsx:271`) — the same
  conversation, a different name. That is the "different name" the user sees the
  instant the live row goes away.

### Symptom B — after Close, the surviving conversation cannot be selected

- The highlight is the mission-session id: `selected={row.session.id === selectedSessionId}`
  (`SessionList.jsx:542`); `HistoryRow` has **no** selected state at all.
- `closeSession` DELETEs the row, clears `openSession`, then `refreshActive()`
  (`stores/mission.js:555-559`). Its refetch spreads `followSessionPatch(sessions,
  selectedSessionId)` (`:300`, `:353`), which looks for the now-deleted
  `msn_…` and falls back to `rows.find(live) || rows[0]` — the plan 73
  phantom-pick, or `''` when no session is left.
- Meanwhile the conversation reappears as a history row keyed `hist:<ses_…>`
  (`SessionList.jsx:445`) — a row that is never highlighted. So: the `msn` item
  vanishes, a differently-named item appears, nothing is selected.

### Why A and B are one bug

The list already knows these are the same conversation — the merge collapses the
live/history pair by `agent_session_id` (`liveAgentIds`, `SessionList.jsx:428`).
What is missing is that the **name** and the **selection** are not derived from
that same identity: the name comes from `label||tmux_id` on one side and `title`
on the other, and the selection is the mission id, which does not exist once the
pane is closed.

## The model (the decision this plan makes)

**A row is a conversation, and its identity is `agent_session_id`.** The mission
session id is a property of *a pane on* that conversation, not of the
conversation. So:

- the row is **named** by the conversation (`title`), and
- the row is **selected** by the conversation (`agent_session_id`),

and closing the pane removes the *pane*, not the item: the same conversation
stays, with the same name, still highlighted, now rendered as its history row.

`openSession` (what col 3 shows) is **not** changed by this: closing still empties
col 3, as plan 68 defines ("close is the one thing that clears it"). The
selection and the open pane are deliberately different questions — a closed
conversation can be selected-with-nothing-open, which is the state the user is
asking for.

---

## Solution (concrete changes, file by file)

### 1. `src/services/mission.js` — capture the title the list already reads

`busyForSessions` (`:1335`) does the store read; keep its `title` too. Extend the
cache value and the return map set:

```js
async function busyForSessions(rows) {
  const busyOf = new Map();
  const knownOf = new Map();
  const titleOf = new Map();
  await Promise.all((rows || []).map(async (s) => {
    const id = s && s.agent_session_id;
    const vm = s && s.agent_name;
    if (!id || !vm) return;
    const key = `${vm}::${id}`;
    const hit = BUSY_CACHE.get(key);
    if (hit && Date.now() - hit.at < BUSY_TTL) {
      busyOf.set(id, hit.value.busy);
      knownOf.set(id, hit.value.known);
      if (hit.value.known) titleOf.set(id, hit.value.title || '');
      return;
    }
    let value = { busy: false, known: false, title: '' };
    try {
      const row = await agentStore.readActivity(vm, id);
      const ok = !!(row && row.store && row.store.available);
      value = {
        busy: !!(ok && row.lastToolCall && row.lastToolCall.status === 'running'),
        known: ok,
        title: ok ? (row.title || '') : '',
      };
    } catch {
      value = { busy: false, known: false, title: '' };
    }
    BUSY_CACHE.set(key, { at: Date.now(), value });
    busyOf.set(id, value.busy);
    knownOf.set(id, value.known);
    if (value.known) titleOf.set(id, value.title);
  }));
  return { busyOf, knownOf, titleOf };
}
```

`stampTruth` (`:1131`) stamps it, **only when the store was actually read**
(`titleOf` only holds known ids, so presence is the proof):

```js
function stampTruth(s, probe) {
  const live = s.live === true;
  const id = s.agent_session_id;
  const looked = !!(id && probe.knownOf && probe.knownOf.get(id));
  const title = id && probe.titleOf && probe.titleOf.get(id);
  const withTitle = title ? { title } : {};
  if (!live) {
    const wasBusy = !!(id && probe.busyOf && probe.busyOf.get(id));
    return { ...s, busy: false, busyKnown: looked, open: false, state: 'dead', ...withTitle, ...(wasBusy ? { wasBusy: true } : {}) };
  }
  if (s.tuiAlive === false) {
    return { ...s, busy: false, busyKnown: looked, open: false, ...withTitle };
  }
  const busy = !!(id && probe.busyOf && probe.busyOf.get(id));
  return { ...s, busy, busyKnown: looked, open: s.tuiAlive !== false, ...withTitle };
}
```

No new container command: `sessionTitle` (`:1082`, the `sqlite3` exec) is **not**
called per row — it stays only on the send/detail paths. History rows already
carry their own `title` from `agentHistory`, so `withHistoryActivity` /
`withAgentBusyProjects` need no change.

### 2. `src/client/src/stores/mission.js` — selection is the conversation, and a fetch never moves it

- Rename `selectedSessionId` → **`selectedConversationId`** everywhere in this
  file; it now holds a row's `agent_session_id` (falling back to the mission id
  for a legacy row that has none).
- Persistence (`readPersistedView` / `writePersistedView`, `:38-74`): write
  `selectedConversationId`; on read, `selectedConversationId: v.selectedConversationId
  || v.openSession?.agentSessionId || ''` (old blobs lose the highlight once;
  `openSession` still restores col 3, so nothing else is lost).
- `snapshotOf` (`:110`): add `title: row.title || ''` and
  `agentSessionId: row.agent_session_id || ''`.
- `followSessionPatch` (`:89`): the auto-pick goes. A data fetch **keeps** the
  current value and never picks a row (this is plan 73's fix, subsumed here):

  ```js
  function followSessionPatch(_rows, currentId) {
    // A fetch must not move the selection: the highlight is what the user
    // chose, and a refetch (every 15s, every action, every scope switch)
    // must not adopt a row on its own (plan 73). Kept as a pass-through so
    // the spread sites stay one shape.
    return { selectedConversationId: currentId || '' };
  }
  ```

- `selectSession` (`:465`): resolve the clicked row and store its conversation id:

  ```js
  selectSession: (sessionId) => {
    const row = get().sessions.find((s) => s.id === sessionId);
    set({
      selectedConversationId: row?.agent_session_id || sessionId || '',
      openSession: snapshotOf(row, get().projects),
      sessionState: null,
      reopenError: '',
    });
    if (sessionId) get().fetchSessionState(sessionId, { autoReopen: true });
  },
  ```

- `startSession` (`:433`): `selectedConversationId: data.session.agent_session_id || data.session.id`.
- `closeSession` (`:555`): **stop clearing** it — that is the fix for symptom B.
  The `openSession` clear stays:

  ```js
  closeSession: async (sessionId) => {
    await api(`/api/mission/sessions/${sessionId}`, { method: 'DELETE' });
    set((s) => (s.openSession?.id === sessionId ? { openSession: null, sessionState: null } : {}));
    await get().refreshActive();
  },
  ```

- `select` (`:243`, `:247`), `createProject` (`:574`), `deleteProject` (`:607`)
  clear `selectedConversationId: ''` together with the list, as they do today.
- `fetchSessionState` (`:492`): refresh the snapshot's **display** title from the
  detail read without moving which session is open:

  ```js
  const data = await api(`/api/mission/sessions/${id}`);
  state = data.state || null;
  set((s) => (s.openSession?.id === id
    ? { sessionState: state, openSession: { ...s.openSession, title: data.session?.title || s.openSession.title } }
    : s));
  ```

### 3. `src/client/src/components/SessionList.jsx` — one name, one highlight per conversation

- `LiveRow` (`:35`): `const name = session.title || session.label || session.tmux_id;`
  and use it at both `title={name}` (`:91`) and `{name}` (`:93`).
- Merge (`:428-446`): give every row a `conversationId` —
  live: `conversationId: s.agent_session_id || `live:${s.id}``,
  history: `conversationId: h.id`.
- Render (`:537-556`): `selected={row.conversationId === selectedConversationId}`
  for **both** row kinds.
- `HistoryRow` (`:231`): add a `selected` prop and paint the same class —
  `msn-row-selected` on the `selected` case, `hover:bg-raised` otherwise (`:262`).
  Clicking a selected history row still resumes it; selected ≠ open.

### 4. `src/client/src/pages/Mission.jsx` — col-3 header uses the same name

`:594` → `{session.title || session.label || session.tmux_id}`.

### 5. Tests

- Backend (`test/mission*.test.js`): `busyForSessions` returns `titleOf` and
  `stampTruth` stamps `title`; and does **not** stamp when the store could not be
  read (`known: false`).
- Store (`test/mission-view.test.js`, `test/mission-reopen.test.js`): selection is
  stored as a conversation id; a refetch after "close" leaves it unchanged;
  `followSessionPatch` no longer auto-picks (pin the plan 73 phantom by a test
  that fails if the old `rows[0]` fallback returns). Update the renamed field.
- Client: a source-parse/behaviour test that a live row and a history row for one
  `agent_session_id` render the **same** name and share the selected state. Keep
  the esbuild **parse** guard for the touched `.jsx` (plan 66's lesson: a
  text-regex suite cannot see a file that stopped parsing).
- Mutation controls run in a `/tmp` copy (never `/app` — `src/` is bind-mounted):
  restore the `rows[0]` fallback → the phantom test reds; drop the
  `titleOf` capture → the title test reds.

### 6. Live verification

On a real opencode pad: open a fresh session (row shows `msn-…` before the agent
titles it), chat one turn, watch the row take the conversation title on the next
refresh, then Close — assert the row **stays**, keeps the same name, and remains
highlighted as a history row, and that col 3 shows its (now empty) state.
Re-open it by clicking and confirm the same conversation resumes.

---

## Open questions / risks

- **A brand-new conversation may have no title until the agent's first reply.**
  Until then `title` is empty and the row shows the label/`tmux_id`. That is
  honest (there is no name yet) and identical to how the history row would render
  it, so the row does not "rename on close" for that case — it is unnamed on both
  sides. Do not invent a placeholder to hide this.
- **Title freshness on typing in the terminal.** The terminal types straight to
  the pane; the row's title arrives on the next `refreshActive` (15s poll or any
  action) through the `withAgentBusy` read (5s TTL). That is the existing refresh
  rhythm — no per-keystroke probe is added.
- **Overlap with plan 73.** Plan 73 (unbuilt) removes the same auto-pick; item 2
  here does that too. Do not build both. Plan 73 should be closed into this plan
  (its highlight-selection rule is item 2/3) or dropped, and its file noted.
- **Plan 78 is a different bug** (an id that *drifts*, causing a reopen loop). It
  is unrelated to naming/selection and must not be conflated with this.
- **`readActivity` vs the driver's `sessionTitle`.** Both read the same
  `opencode.db`; `readActivity` is host-side and exec-free, which is why the
  listing uses it. The driver's version additionally filters
  `time_archived IS NULL`; if an archived conversation ever needs to be excluded
  from a listing, that filter belongs in the store read, not in a second probe.
