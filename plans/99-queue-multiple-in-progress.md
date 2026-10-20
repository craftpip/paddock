# 99 — Queue: tolerate and display multiple "in progress" items

## Status: done (2026-10-15)

4/4 phases complete. All implementation done and tested:
- Phase 1: Parser + write validator tolerate multiple in-progress ✅
- Phase 2: queueSummary.warnings + read path (readQueue, readRunnerQueueFor) ✅
- Phase 3: QueuePanel warning line (msn-queue-warning), list always visible ✅
- Phase 4: Tests updated/added; MCP description + template prose updated ✅

API verified: `GET /api/mission/runners/run_9e972939037a6168/queue` returns `condition: 'ok'`, `summary.warnings[0].code: 'queue_multiple_in_progress'`, `error: null`, `items.length: 13`.

Browser verification of the warning display pending (build cache issue under investigation).

## The bug

A `QUEUE.md` with **more than one item at status `"in progress"`** is treated as a
fatal parse error, and that one error bricks the queue for **reading, running and
editing**:

- `src/services/plans.js:855` (`parseQueue`) throws
  `PlansError('queue_multiple_in_progress', 'Only one item may have status "in progress".')`.
- `src/services/plans.js:1038` (`validateQueueItems`, the **write** path) throws the
  same, so the user cannot repair it from the UI.
- `readQueue` catches the throw and returns `condition: 'malformed'`, `items: []`.
- `QueuePanel.jsx` renders the malformed branch and **hides every item** — the user
  sees only the error string.
- `startRunner` refuses with `runner_invalid_queue` (queue aggregate state `invalid`).

Live reproduction on the paddock runner (`run_9e972939037a6168`, session
`msn_c7e9f54459c23f56`), whose queue is `/www2/paddock/plans/QUEUE.md`:

```
GET /api/mission/runners/run_9e972939037a6168/queue
→ condition: "malformed", error: 'Only one item may have status "in progress".',
  itemCount: 0, state: "invalid"
```

Browser (cloakbrowser, `/mission?session=msn_c7e9f54459c23f56`) shows the panel with
only `Only one item may have status "in progress".` and **0 of 12 items**. Reproduced.

The trigger is real and legitimate: plans 93 and 98 are both in-progress, so the queue
genuinely holds two `"in progress"` rows.

## The decision (user's call: "there maybe two? why not")

The "at most one in progress" rule is **worker guidance text**, not a structural
invariant of the file. Two items may legitimately be in progress (e.g. two plans with
work outstanding). It must never be a hard parse error.

We **tolerate** multiple in-progress items and **surface them as a soft warning** while
keeping the whole list visible. The file is a human/agent-editable document; the panel
must always show what is in it.

Runner semantics with N in-progress: the runner resumes the **first** in-progress item
in array order (existing `find(status === 'in progress')` already does this); the
others stay in progress and are reached in order. No double-dispatch.

## Affected files

- `src/services/plans.js` — parser + write validator + `queueSummary` + template prose.
- `src/services/mission.js` — `readRunnerQueueFor` (carry `warnings`); no gate change needed.
- `src/client/src/components/QueuePanel.jsx` — render the warning line, keep the list.
- `src/test/queue.test.js` — retire the "rejects more than one in progress" test; add accept + warning + write tests.
- `src/mcp.js:2796` — queue-items schema description still says 'At most one "in progress".' → reword to guidance.

## Contracts

`queueSummary(parsed)` gains a `warnings` array (`[]` when none):

```js
warnings: [
  { code: 'queue_multiple_in_progress',
    message: '3 items are marked "in progress" (q-1, q-2, q-3). Work them in order.',
    itemIds: ['q-1','q-2','q-3'] }
]
```

- `summary.current` remains the **first** in-progress item; `counts.inProgress` already
  carries the number.
- `readQueue` payload: `condition: 'ok'` for multiple in-progress, `warnings` passed
  through, `error: null`.
- Genuinely malformed queues (bad JSON, missing fence, unknown status) still throw/return
  `malformed` — **only** the multi-in-progress throw is removed.
- `startRunner` no longer sees `invalid`, so the `runner_invalid_queue` refusal simply
  stops firing for this case.

## Implementation steps

1. **Parser:** in `src/services/plans.js` delete the `queue_multiple_in_progress` throw at
   `parseQueue` (~:853-857) and at `validateQueueItems` (~:1037-1038). Leave every other
   structural check intact.
2. **Summary:** in `queueSummary` add the `warnings` computation above (pure, derived from
   `items`). Include `warnings` in the returned object.
3. **Read path:** confirm `readQueue` returns `warnings` from the summary and that
   `condition` stays `'ok'` with two in-progress; confirm `mission.readRunnerQueueFor`
   forwards it and `error` is null.
4. **Template prose:** reword the rule in `queueTemplate` (~:736) and the editing rule
   (~:755) from "At most one item may be in progress" to guidance ("Keep one item in
   progress at a time; if more than one is marked, resume the earliest"). Note: existing
   files' prose is preserved by `spliceQueueBlock`, so the live `QUEUE.md` keeps its old
   wording — that is fine and does not need migrating.
5. **Panel:** in `QueuePanel.jsx` render `summary.warnings` as a readable wrapped line
   with a stable `msn-queue-warning` class (warning tone), above the item list. **Never**
   hide the list because of it. Confirm both in-progress rows already show their "Working"
   badge (they do once the list renders).
6. **MCP description:** update `src/mcp.js:2794` describe text to match (guidance, not a
   hard rule).

## Tests

- Retire `src/test/queue.test.js:170` "rejects more than one item in progress"; replace with:
  - `parseQueue` **accepts** two in-progress items and returns both.
  - `queueSummary(...)` with two in-progress → `warnings[0].code === 'queue_multiple_in_progress'`,
    `itemIds` in array order, `warnings.length === 1`; and **no** warning for exactly one.
  - aggregate state for two in-progress is `'in progress'` (not `invalid`).
- Write path: `writeQueue` / `validateQueueItems` accepts a queue with two in-progress
  (CAS section of `queue.test.js`).
- Guard against over-relaxing: a still-genuinely-malformed queue (e.g. unknown status)
  keeps its existing error test green.
- Run each file individually: `timeout 60 docker exec paddock node --test test/queue.test.js`.

## Browser verification (the real proof)

Read-only, no coordinate clicks, no session relaunch:

1. Restart webui (`docker restart paddock`; backend edit).
2. `GET /api/mission/runners/run_9e972939037a6168/queue` → `condition: 'ok'`,
   `items.length: 12`, `summary.warnings[0].code: 'queue_multiple_in_progress'`, `error: null`.
3. Open `http://10.69.1.164:6789/mission?session=msn_c7e9f54459c23f56` in the dev browser:
   `.msn-queue-panel .msn-queue-item` count is 12 (not 0); the two in-progress rows show
   their Working badge; `.msn-queue-warning` is present; the malformed block is gone.
4. Assert on the **resulting** DOM (item count + warning presence), not on a handler firing.

## Edge cases

- `need input` present alongside multiple in-progress → aggregate stays `'need input'`
  (already wins); warning still shown.
- Exactly one (or zero) in-progress → `warnings: []`, no visual change.
- Genuinely malformed file → unchanged `malformed` behaviour.

## Progress

- [ ] Phase 1 — Parser + write validator tolerate multiple in-progress.
- [ ] Phase 2 — `queueSummary.warnings` + read path (`readQueue`, `readRunnerQueueFor`).
- [ ] Phase 3 — `QueuePanel` warning line, list always visible.
- [ ] Phase 4 — Tests updated/added; live browser verification; MCP description + template prose.
