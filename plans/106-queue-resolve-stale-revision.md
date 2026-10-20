# 106 — Queue resolve retries a stale revision

## Status: Complete (2026-10-19)

4/4 items complete. The resolver used the UI projection's `queue.revision` in
both compare-and-swap steps even though `plans.readQueue()` exposes `queue.hash`;
it also passed an agent conversation id into `sendText`, which requires a Mission
session id.

## Problem

The Mission queue is blocked on a human answer. The UI loads the queue, accepts an
answer, and opens the confirmation dialog, but submitting it returns:

```
Queue was modified since you loaded it — reload and retry
```

Reloading and repeating the same flow returns the same error. The runner remains
blocked, so the only UI path to resume the queue is unusable.

## Goal

Resolve a blocker using the revision returned by the queue read. A true concurrent
change must remain a visible conflict; it must not be retried blindly or send an
answer to a different item.

## Implementation

- [x] Trace the queue revision supplied by the client and checked by the resolve route.
- [x] Compare the submitted revision with `plans.readQueue().hash`.
- [x] Deliver the answer through the bound Mission session and keep the dialog open on failure.
- [x] Add focused regression tests for the accepted revision and a true conflict.
- [x] Build, restart, and prove the live blocker resumes through the Mission UI.

## Verification

- `test/infinite-runner.test.js`: 34 passing, including a full resolve from the
  revision returned by `readRunnerQueue` through delivery, requeue, and resume.
- `test/mission-queue.test.js`: 12 passing, including conflict feedback that
  rethrows so the modal keeps its draft.
- The Mission page accepted the answer without a revision conflict. The delivery
  confirmation returned unknown (HTTP 409), so it did not resend; the worker then
  consumed the written answer and the queue moved from `Needs input` to
  `In progress` with no blocker or dialog remaining.

## Edge Cases

- A changed blocked item keeps the answer unsent and tells the user to reload.
- A true conflict surfaces as an error rather than retrying forever.
- A failed resolve keeps the modal open with its draft intact.
