# 107 — Queue resolution reconciles an unconfirmed write

## Status: Complete (2026-10-19)

4/4 items complete. A blocker answer can be written to the live Mission pane but
return `mission_send_unconfirmed` when the pane does not repaint. The worker may
then consume the answer and change its queue item while the runner remains paused.

## Goal

Never resend an answer that may already have reached the agent. After an
unconfirmed delivery, read the queue once: if the same blocked item has moved on,
record the resolution as reconciled and re-enable supervision; otherwise preserve
the unknown outcome for the user to reconcile manually.

## Implementation

- [x] Identify the safe post-write evidence that the same blocker advanced.
- [x] Reconcile an attempted-but-unconfirmed delivery without sending text again.
- [x] Add focused service coverage for the advanced queue state and active-worker adoption.
- [x] Build, restart, and verify the Mission runner resumes after reconciliation.

## Verification

- `test/infinite-runner.test.js`: 36 passing, including unconfirmed-write
  reconciliation and adoption of a verified active worker without another prompt.
- `test/runner-dispatch.test.js`: 22 passing, including outstanding-instruction
  and unconfirmed-delivery protections.
- Live Mission verification: the blocked item advanced to `In progress`; pressing
  `Run queue` resumed supervision without another message. The header now shows
  `∞ Running` and `Pause queue`.
