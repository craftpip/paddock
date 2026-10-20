# 108 — Queue resolution lock recovery

## Status: Complete (2026-10-19)

3/3 items complete. Plan 94 was blocked because an omitted idempotency key was
stored as `''`, and the table's unique `(runner_id, idempotency_key)` constraint
therefore permits only one resolution for the runner for its entire lifetime.

## Goal

Never leave a queue blocker permanently locked by an interrupted or unconfirmed
resolution. A retried resolution must either resume the existing completed work
without a second delivery or safely take over a stale pending row.

## Implementation

- [x] Trace the pending-row lifecycle and identify its safe recovery evidence.
- [x] Store an absent idempotency key as `NULL`, preserving real-key retries while allowing later resolutions.
- [x] Test and live-verify Plan 94 resumes once.

## Verification

- `test/infinite-runner.test.js`: 36 passing.
- `test/mission-queue.test.js`: 12 passing.
- Live: Plan 94 accepted one answer, advanced to done, and the queue resumed
  Plan 95 with `∞ Running`, a working worker, and no blocker.
