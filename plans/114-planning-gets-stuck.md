# 114 — Planning gets stuck: repeated identical dispatch refusals never back off

## Status: In progress (2026-11-11) — 3/4 findings resolved, 1 remaining (item 4: back-off).

Origin: diagnosis of lap's live runners (2026-11-11). Work moved to the `meridian` host the same
day; lap-only data issues are out of scope.

## Resolved (absorbed into docs/reference/backend/mission-queue.md)

- [x] 1. Delivered instructions reported `mission_send_unconfirmed`: the receipt check read the
  store once, right after `sendText`. Now `awaitExactReceipt` polls for 5 s
  (`test/runner-receipt-poll.test.js`, mutation control verified). The live repro on meridian
  had a second cause, the TUI boot race, fixed by plan 116's ready gate.
- [x] 2. Stale legacy runner columns contradicted the canonical state (paused + "grace 118s
  remaining"; no session + `worker_state: working`). `publicRunner` now derives them from
  `execution` (`test/runner-public-view.test.js`, mutation control verified).
- [x] 3. Lap's paddock queue was emptied by plan 113's switch to canonical authority. Lap-only
  data; dropped when work moved off lap. Plan 113 intentionally imports nothing from the old file.

## Remaining

### 4. Repeated identical dispatch refusals retry forever (Low)

Seen on lap: 25+ `dispatch_failed` events with code `runner_dispatch_superseded`, every 2 minutes for
an hour (2026-10-20 21:16–22:10). The cause, a hash-vs-revision guard, was fixed in 87a344f, but the
retry loop has no cap on its own: any refusal that repeats with the same code will repeat forever.

Contract:

- Count consecutive automatic dispatch refusals per runner with the same `code` (reset on any
  successful dispatch, a different code, or an explicit Run/Pause).
- After `no_progress_budget` (default 3) identical refusals, transition to `waiting_input` with
  reason `Dispatch refused N times in a row: <code> — <reason>` and record one history event
  `dispatch_backoff` (no more `dispatch_failed` rows until the state changes).
- Explicit Run clears the counter and tries once.

Steps:

1. Find the watcher's automatic dispatch path (`runnerWatchOnce` → `dispatchNext` in
   `src/services/mission.js`) and where it records `dispatch_failed`.
2. Persist the counter on `infinite_runners` (new columns `refusal_code`, `refusal_count`; ALTER
   guarded like the other migrations in `db.js`; extend `test/db-migration.test.js`).
3. Apply the transition through `runnerTransition` (never write legacy columns as authority).
4. Tests: a fixture whose `beforeWrite` always throws `runner_dispatch_superseded` — after 3
   watcher ticks the runtime is `waiting_input` and history has exactly 3 `dispatch_failed` + 1
   `dispatch_backoff`; a positive twin where the refusal stops after 2 ticks keeps running.
   Mutation control: remove the cap → the first test goes red.
5. Live: on `pad-dev`, force a projection drift (edit `plans/QUEUE.md` by hand) while running and
   watch the runner reach `waiting_input` instead of logging refusals indefinitely; regenerate to
   recover.

- [ ] 4. Back-off implemented, tested, verified live, absorbed into docs.
