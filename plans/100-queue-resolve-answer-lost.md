# 100 — Mission queue "Resolve blocker" loses the answer and Enter submits nothing

## Status: done (2026-10-15)

4/4 fixes implemented and tested:
- Bug 1 (answer lost): Stable draft key using `resolveItemId` from popup args or blocked summary ✅
- Bug 2 (Enter doesn't submit): `onKeyDown` handlers added to inline and modal fields ✅
- Bug 3 (spurious "Discard changes?"): `useDirtyNavigation` guard identity changed to session-based ✅
- Bug 4 (silent failures): `resolveRunnerQueue` store action added with operationFeedback ✅

All 46 queue tests + 128 mission tests + 57 plan-mcp tests pass. Build successful.

## The bug

On the Mission page the infinite queue is **blocked on input** (`Needs input`,
`Next (blocked) — 75 …`). The one control that can unblock it is the blocker
block's inline answer field + `Resolve blocker` button, which opens a
`Resolve blocker` modal. Today that flow cannot be completed the way a user
naturally does it:

1. Type the answer into the **inline** `Your answer for the agent…` field.
2. Press `Resolve blocker` (or Enter).
3. The modal opens, but its input is **empty** — the answer typed in step 1 is
   gone from the modal, and `Send & resume` is disabled.
4. Type the answer again in the modal and press **Enter** → **nothing happens**.
   The modal stays open, no request is sent. Only clicking the `Send & resume`
   button works.

Net effect for the reporter: the queue looks permanently stuck because the
obvious way to answer the agent does nothing.

Reporter's URL:
`http://10.69.1.164:6789/mission?project=prj_de534a1f68a8bb97&view=project&session=msn_969165b823fe66b9`

## Reproduction (verified live, 2026-10-14, cloakbrowser)

Loaded the URL above against the live app. The panel showed, exactly as reported:

```
state:   "Needs input"
next:    'Next (blocked) — 75 — Empty Request Activity Shows "No Data" Instead of Empty Graph'
blocker: 'Blocked on 75 — Empty Request Activity Shows "No Data" Instead of Empty Graph'
reason:  'Fix + tests + docs + build-proof done; blocked on final live check …'
```

Then, step by step:

1. Typed `confirmed` into `.msn-queue-resolve-input` → field value `confirmed`.
2. Clicked `.msn-btn-queue-resolve-open` (`el.click()`).
   - Popup URL became `…&popup=queue-resolve%3Arun_2232730b234d809a%3Aq-mv8n9bji-edu6e`.
   - `.msn-queue-resolve-text` (modal input) value = **`""`**
   - `.msn-queue-resolve-input` (inline) value = **`""`**
   - `Send & resume` button = **disabled**.
3. Typed `confirmed` into the modal input, focused it, wrapped `window.fetch` to
   count resolve calls, dispatched `Enter`.
   - After 800 ms: **`fetchCalls: 0`**, modal still open, value still `confirmed`.
4. Clicked the modal's `Cancel` → a **second** modal appeared:
   `Discard changes?` (`Keep editing` / `Discard`). Clicking `Discard` finally
   closed the resolve popup, and the inline field then showed `confirmed` again
   (the text was only ever lost from the *popup's* draft, not the inline one).

So three distinct defects live in one small flow. They are independent fixes.

## Root causes (all in `src/client/src/components/QueuePanel.jsx`)

### 1. The answer is lost because the draft KEY changes when the popup opens

`QueuePanel.jsx:100`:

```js
const [resolveText, setResolveText] = useDraftState(
  `queue-resolve:${runner?.id}:${popup?.type === 'queue-resolve' ? popup.args[1] : ''}`, '')
```

`useDraftState` (`src/client/src/lib/navigation.jsx:110`) keeps one draft per
**key** in a memory-only map. The key above is `queue-resolve:<runnerId>:` while
the popup is closed and `queue-resolve:<runnerId>:<itemId>` while it is open.
Typing into the inline field writes the first key; opening the modal reads the
second — empty. That is the "popup opens with empty input" symptom. Both the
inline field and the modal field bind the SAME `resolveText`, so both render the
(new, empty) popup-key draft.

### 2. Enter does nothing because neither field has a key handler

- Inline field: `QueuePanel.jsx:390-396` — `onChange` only, no `onKeyDown`.
- Modal field: `QueuePanel.jsx:467-472` — `onChange` only, no `onKeyDown`.
- No enclosing `<form>`, so a bare Enter has nothing to submit.

Only the two buttons (`Resolve blocker` → `openPopup`; `Send & resume` →
`doResolve`) act, via `onClick`.

### 3. Cancel raises a spurious "Discard changes?" prompt

`QueuePanel.jsx:101`:

```js
useDirtyNavigation(!!resolveText && !!resolve, popupIdentity, () => setResolveText(''))
```

`popupIdentity` (`navigation.jsx:138`) is `pathname + ':' + popup-values`. Closing
the popup therefore changes the identity, the guard (`navigation.jsx:95`)
reports a "navigation away from a dirty draft", and `Cancel`/close is intercepted
by the `Discard changes?` modal. The draft is per runner+item and is preserved
across popup open/close, so closing the popup does **not** discard anything and
should not ask — the guard is guarding the wrong identity.

### 4. (Adjacent, same flow) Resolve has no store action, so it is silent

`doResolve` (`QueuePanel.jsx:150-162`) calls `api(...)` directly and its `catch`
is empty with the comment "Feedback is set by the store action". There is **no**
`resolveRunnerQueue` action in `src/client/src/stores/mission.js` (grep confirms
only `setupRunnerQueue` / `updateRunnerQueue` / `startRunner` / `pauseRunner` /
`resumeRunner` / `removeRunner`). Consequences:

- A failed resolve is completely silent (revision conflict, delivered-but-not-
  requeued, PAD stopped, …) — the popup just stays open.
- The `Resolving…` label at `QueuePanel.jsx:458` keys off
  `queueAction === 'update'`, which resolve never sets, so it never appears.
- On success the queue is not explicitly refreshed; the panel waits up to 15 s
  for the poll, so the blocker appears to linger.

The backend endpoint already exists and works: `POST
/api/mission/runners/:id/resolve` (`src/app.js:3168`) →
`mission.resolveRunnerQueue` (`src/services/mission.js:2652`), which delivers the
answer, requeues the item, lifts the paused marker and re-enables supervision.

## Impact

The queue can only be answered by clicking the one working button after retyping
the answer, with zero error reporting. A user who presses Enter — the natural
action — sees a dead control and concludes the queue is stuck. This is the exact
"the queue is stuck" report.

## Fix

### A. One stable draft key for inline + modal (bug 1)

Compute the resolve item id once, independent of popup state, and use it for both
fields. The blocked item is already in the store queue
(`queue.summary.blocked.id`, set by `plans.js` summary), so it is available at
hook time. Replace `QueuePanel.jsx:100` with:

```js
const resolveItemId = popup?.type === 'queue-resolve'
  ? popup.args[1]
  : (queue?.summary?.blocked?.id || '')
const [resolveText, setResolveText] = useDraftState(
  `queue-resolve:${runner?.id}:${resolveItemId}`, '')
```

When the popup is opened on the blocked item, `popup.args[1] === blocked.id`, so
the key is identical before and after opening → the typed answer carries into the
modal. Keying by item id (not a constant) still resets per blocked plan, which is
the reason the popup argument was in the key to begin with.

### B. Enter submits (bug 2)

Add `onKeyDown` to both fields. Guard IME composition so a confirming Enter in a
CJK composition is not swallowed:

Inline (`QueuePanel.jsx:390-396`):

```jsx
onKeyDown={(e) => {
  if (e.key === 'Enter' && !e.nativeEvent?.isComposing && resolveText.trim() && !busy) {
    e.preventDefault()
    setResolve(blocked)   // same as the Resolve blocker button: open the modal
  }
}}
```

Modal (`QueuePanel.jsx:467-472`):

```jsx
autoFocus
onKeyDown={(e) => {
  if (e.key === 'Enter' && !e.nativeEvent?.isComposing && resolveText.trim() && !busy) {
    e.preventDefault()
    doResolve()
  }
}}
```

Decision: Enter in the **inline** field opens the modal (parity with the adjacent
button); Enter in the **modal** submits (`doResolve`). This keeps the single
confirmation step the modal exists for.

### C. Guard the draft's real identity, not the popup's (bug 3)

Replace `popupIdentity` as the guard identity so toggling the resolve popup is not
a "leave". Change `QueuePanel.jsx:101` to an identity built from the route +
session (the draft context), e.g.:

```js
const draftIdentity = (loc) =>
  loc.pathname + ':' + (new URLSearchParams(loc.search).get('session') || '')
useDirtyNavigation(!!resolveText && (!!resolve || !!blocked), draftIdentity, () => setResolveText(''))
```

Now `Cancel` closes the modal cleanly, the answer stays in the inline field, and
the "Discard changes?" prompt only appears when actually leaving the session with
an unsent answer.

### D. Route resolve through a store action (bug 4)

Add `resolveRunnerQueue` to `src/client/src/stores/mission.js`, mirroring
`updateRunnerQueue` (`mission.js:901-927`):

```js
resolveRunnerQueue: async (runnerId, { itemId, answer, revision }) => {
  if (get().queueAction) return
  set({ queueAction: 'resolve', queueError: '' })
  try {
    await api(`/api/mission/runners/${runnerId}/resolve`, {
      method: 'POST', body: { itemId, answer, revision },
    })
    get().setOperationFeedback(runnerId, { severity: 'success', message: 'Answer sent — queue resumed' })
    await get().reloadRunnerQueue()
  } catch (e) {
    get().setOperationFeedback(runnerId, {
      severity: e?.code === 'queue_revision_conflict' ? 'warning' : 'error',
      message: errText(e, 'Could not send the answer'),
    })
  } finally {
    set({ queueAction: '' })
  }
}
```

Then `QueuePanel.doResolve` (`QueuePanel.jsx:150-162`) calls the action and keeps
its own popup close only on success:

```js
const doResolve = async () => {
  if (!resolve || !resolveText.trim()) return
  try {
    await resolveRunnerQueue(id, { itemId: resolve.id, answer: resolveText.trim(), revision: queue.revision })
    closePopup({ saved: true, expected: popup?.value })
    setResolveText('')
  } catch { /* feedback set by the action */ }
}
```

Wire `resolveRunnerQueue` into the QueuePanel selectors (`QueuePanel.jsx:85-88`)
and switch the button label at `QueuePanel.jsx:458` to
`queueAction === 'resolve' ? 'Resolving…' : 'Send & resume'`.

Note: the action must NOT set `queueError` for a resolve failure (that is for
read errors); use `operationFeedback`, which the panel already renders
(`QueuePanel.jsx:239-254`).

## Affected files

- `src/client/src/components/QueuePanel.jsx` — key (A), Enter (B), guard (C),
  store wiring + label (D).
- `src/client/src/stores/mission.js` — new `resolveRunnerQueue` action (D);
  export it in the returned store object (the object with `setupRunnerQueue`).
- `src/test/mission-queue.test.js` — new behavioral tests (below).
- `docs/tabs/mission.md` (or the queue section of `docs/` for the Mission tab) —
  document the resolve flow, Enter semantics and success/failure feedback.
- Rebuild + restart to ship: `cd src/client && npm run build` then
  `docker restart paddock` (SPA is served prebuilt from `src/public/`).

## Tests

Run individually (never the combined suite):

```bash
timeout 60 docker exec paddock node --test test/mission-queue.test.js
```

Add to `src/test/mission-queue.test.js` (it already mocks routes via the
`json()`/`routes` harness, see the file header):

1. **resolve posts the right request and reports success** — mock
   `POST /api/mission/runners/:id/resolve`; call
   `resolveRunnerQueue('run_x', { itemId: 'q1', answer: 'confirmed', revision: 7 })`;
   assert the URL, method and body (`itemId`/`answer`/`revision`) and that
   `operationFeedback[run_x].severity === 'success'`, then a queue re-read
   happened.
2. **revision conflict is surfaced, not swallowed** — mock the route to reject
   with `{ code: 'queue_revision_conflict' }`; assert severity `warning`, message
   present, and NO success feedback.
3. **a generic failure is reported as an error** — mock a 500; assert severity
   `error` with the message; assert `queueAction` returns to `''`.
4. **the resolve action is a no-op while another action runs** — set
   `queueAction: 'update'` first, call, assert no fetch.

Component-level draft/Enter behaviour cannot be unit-tested here (no jsdom/RTL in
`src/client/package.json`). Pin the shape in a source-text assertion **and** treat
the browser check below as the authoritative oracle (per AGENTS.md: a suite of
source regexes cannot see a component that no longer parses). One cheap source
pin: `assert.match(src, /queue-resolve:\$\{runner\?\.id\}:\$\{resolveItemId\}/)`
plus the two `onKeyDown` handlers, and — because `node --check` rejects JSX — run
the esbuild parse with `write:false` resolved via
`createRequire(client/package.json)` to prove the file still compiles.

## Browser verification (the real oracle)

After build + `docker restart paddock`, on the reporter's URL:

1. The blocker block shows the inline `Your answer for the agent…` field.
2. Type `confirmed`, press **Enter** → the `Resolve blocker` modal opens **with
   `confirmed` already in it** and `Send & resume` **enabled**.
3. Press **Enter** in the modal → assert a POST to
   `/api/mission/runners/<id>/resolve` was sent (count `window.fetch`), the
   success feedback banner appears, the popup closes, and the blocker clears on
   the next queue read.
4. Re-open the flow, type text, click `Cancel` → the modal closes with **no**
   `Discard changes?` prompt.
5. Repeat the whole thing once from the inline field to the modal with the modal
   field left untouched, confirming the text is shared (not retyped).

Do not click `Send & resume` against the live plan-75 blocker to "prove" it
unless the reporter wants plan 75 unblocked — answering it delivers a real
message to the agent and resumes the queue. Use the assertions in steps 2–4 (which
do not submit) for verification; only the reporter decides when to actually
answer plan 75.

## Edge cases to handle

- **Answer for a different item**: if `blocked.id` changes while text is present
  (queue re-read), the stable key changes and the draft resets — acceptable and
  intended (never send plan A's answer to plan B).
- **Popup opened from a URL that already has `popup=queue-resolve`** (deep link /
  reload): `resolveItemId` comes from `popup.args[1]`; the inline field is not
  rendered unless `blocked` is present, and the modal's effect closes it if the
  item is no longer `need input` (`QueuePanel.jsx:102-108`). Keep that effect.
- **`busy`**: Enter must respect the same `busy`/`!resolveText.trim()` guards as
  the buttons so a double-submit cannot fire twice.
- **IME composition**: skip submit when `e.nativeEvent.isComposing`.
- **Backend rejects because the runner is not `need_input`/`paused`**
  (`runner_invalid_state`) — surfaced as error feedback now, not silence.

## Out of scope

- Why plan 75 is blocked (that is the agent's legitimate question to the human).
- Terminal-based answering (already possible); this plan only fixes the queue
  panel's resolve UI.
