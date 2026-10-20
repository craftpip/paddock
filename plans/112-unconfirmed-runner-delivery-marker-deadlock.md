# 112 — Unconfirmed runner delivery must not re-pause its worker

## Status: Complete — 2026-10-20

0/4 phases complete. On Mission project `paddock`, runner `run_9e972939037a6168`
reported an unconfirmed startup delivery for session `msn_89bda48e9517acb2` while
the queue's `QUEUE.paused` marker existed. The worker's own first instruction is
to stop when that marker exists, so an attempted delivery can be made impossible
to reconcile by the safety mechanism intended to prevent extra work.

## Requested Outcome

When an explicit **Run** sends an instruction but Mission cannot prove the pane
accepted it, Paddock must withhold duplicate sends without reintroducing the
`QUEUE.paused` marker that tells a successfully reached worker to stop.

The runner remains visibly unconfirmed and does not dispatch a second instruction
until the original attempt has an exact receipt or is conclusively held. The
Mission page must give the user a real reconciliation action, not a reload button
whose label suggests recovery while it merely re-fetches the same stuck state.

## Observed Failure

1. The user presses **Run** on a paused Mission queue with pending work.
2. `startRunner()` correctly removes `QUEUE.paused` before sending because every
   worker prompt begins by checking that file.
3. `sendText()` reports `mission_send_unconfirmed`: it may already have written
   the input, but the pane did not show a confirming change.
4. `startRunner()` restores `QUEUE.paused` in its catch path while retaining the
   unconfirmed operation.
5. If the input did arrive, the worker reads the restored marker and obeys it by
   stopping. If it did not arrive, no receipt can ever appear. In either case the
   page shows an unconfirmed delivery with a **Reconcile** control that only
   reloads the queue.

The current Mission page visibly shows this form: `idle · Instruction delivery
unconfirmed — automatic resend withheld; waiting for the exact input receipt`, a
`Needs input` queue, and a current plan described as waiting to start.

## Safety Contract

- An attempted but unconfirmed instruction remains one durable operation. Never
  resend it automatically, never acquire a second operation lease, and never
  dispatch a later queue item while it is outstanding.
- The pause marker is a worker instruction, not merely a server flag. Once input
  may have landed, restoring it is an active instruction to abandon that work.
  Keep it absent while that exact operation is awaiting reconciliation.
- Keep supervision disabled for this narrow pending state until an exact receipt
  proves the worker received the persisted prompt. A missing marker alone must
  not authorize scheduler dispatch, a retry, or a queue mutation.
- A receipt must match the operation's bound conversation, baseline user message
  and persisted prompt hash. A different user turn, another session, a changed
  queue revision, a solo lock, Pause, Close, or a new run generation must never
  confirm or resume the old operation.
- On a verified receipt, atomically move the same runner to enabled supervision,
  preserve the absent marker, and observe the current turn before considering any
  later dispatch. Do not send another startup prompt.
- On an explicit cancel/hold, a terminal expiry without a receipt, or any state
  that proves the operation is superseded, restore `QUEUE.paused` and surface the
  exact recovery action. A late receipt after that hold must not silently restart
  the queue.
- Distinguish **unconfirmed**, **confirmed and working**, **confirmed and idle**,
  and **held** in the server response and UI. Do not call the queue `Needs input`
  merely because delivery evidence is missing; reserve that state for a real
  queue blocker or an explicit human recovery decision.

## Implementation Scope

- Trace `startRunner()`, `deliverRunnerInstruction()`, `observeRunnerTurn()`,
  `computeSchedulerState()`, `runnerWatchOnce()` and boot reconciliation in
  `src/services/mission.js`. Replace the blanket unconfirmed catch behavior with
  an explicit durable awaiting-receipt state and a single transition function.
- Ensure disabled unconfirmed runners are still safely observed for their one
  persisted operation. The observer may read the conversation and reconcile the
  operation, but it may not dispatch new work just because the marker is absent.
- Add an authenticated Mission API/service action that performs reconciliation of
  the exact outstanding operation. Wire `QueuePanel`'s **Reconcile** control to
  it. It must report whether it observed a receipt, remains awaiting evidence, or
  held the operation; a plain queue reload stays a separate action.
- Keep **Retry** safe: it must not resend while the original operation can still
  be received. After a deliberate hold, it starts a fresh explicit operation only
  after re-reading queue state and proving the worker is idle.
- Update `QueuePanel.jsx`, `RunnerSchedulerStatus` and the Mission store/API
  projection so the visible message explains the true state and does not offer a
  contradictory `Needs input` badge. Preserve stable `msn-*` hooks and keyboard
  behavior.
- Update the queue worker rule and prompt text only if needed to express the
  durable operation state. Do not weaken the existing `QUEUE.paused` stop rule:
  it must still stop a genuinely paused queue before the next task.

## Implementation Steps

1. Reproduce the failure with a controlled attempted/unconfirmed startup write.
   Record the runner row, marker presence, operation identifiers, queue summary
   and worker/store turn before and after the catch path.
2. Define one server-owned receipt reconciliation transition. Route startup,
   watcher/boot observation and the explicit Reconcile endpoint through it so the
   marker, runner flags and operation state cannot drift.
3. Change the unconfirmed startup path to preserve an open marker window only for
   its owned operation, then add its bounded hold/expiry and Pause/Close/new-run
   invalidation paths. Keep scheduler dispatch gated on a confirmed receipt.
4. Wire the Mission UI to the real reconciliation result, render each distinct
   state truthfully, add focused tests, build, restart and browser-test all user
   controls before documenting and absorbing the finished plan.

## Verification

- Add a regression test where `sendText()` attempts the startup input then returns
  `mission_send_unconfirmed`. Assert `operation_status: unconfirmed`, supervision
  is not allowed to send a second prompt, and `QUEUE.paused` remains absent while
  the original receipt is still eligible.
- Give that fixture its positive twin: inject the exact persisted input receipt,
  run reconciliation, and assert one transition to enabled observation with no
  duplicate input and no marker restoration.
- Add negative twins for a mismatched prompt hash, changed conversation, stale
  generation, Pause and Close. Each must hold/invalidates the old operation,
  restore the marker where appropriate, and never re-enable the runner.
- Test expiry/explicit hold: no receipt restores the marker, reports the hold,
  and a later stale receipt cannot restart supervision. Test an explicit retry
  only after that hold, proving it uses a fresh operation and current queue read.
- Run relevant suites individually: `test/infinite-runner.test.js`,
  `test/runner-dispatch.test.js`, `test/mission-queue.test.js`, and any new
  Mission API/store test. Run mutation controls in a `/tmp` copy, never the
  bind-mounted source tree.
- Build the client, restart `paddock`, then test
  `http://10.69.1.164:6789/mission` in the browser. Exercise Run → forced
  unconfirmed → Reconcile, hold, Retry, Pause and Close. Inspect the resulting
  DOM, queue marker, runner state, console and failed requests; compare Mission
  project counts before and after testing.

## Progress

- [x] Model an unconfirmed startup as a receipt-awaiting operation without re-pausing its worker.
- [x] Add exact receipt reconciliation, durable hold/expiry, and safe retry transitions.
- [x] Replace the reload-only Reconcile control with real state-specific feedback.
- [ ] Prove the marker, operation and UI behavior end to end, then update docs and absorb this plan.
