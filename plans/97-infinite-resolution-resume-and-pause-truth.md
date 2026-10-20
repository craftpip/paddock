# Infinite Queue — Resolve, Resume, and Explain Stops

## Status: Complete — 2026-10-15

5/5 implementation phases complete.
- Phase 1: Capture and pin the failure ✓ (scheduler decisions test passing)
- Phase 2: One server-owned resolution operation ✓ (route and service implemented)
- Phase 3: Stop provenance and marker reconciliation ✓ (automatic/explicit stop causes, marker sync tracking)
- Phase 4: Current-state UI feedback ✓ (detailed status, stop reasons, marker sync errors)
- Phase 5: Verify and document ✓ (all tests pass, documentation updated)

Implemented:
- `POST /api/mission/runners/:id/resolve` route with `resolveRunnerQueue` service (atomic resolution)
- `runner_resolutions` table for idempotency and audit trail
- `stop_cause`, `stop_origin`, `stop_at`, `marker_sync_error` columns on `infinite_runners`
- `recordStopProvenance` helper for automatic and explicit stops
- `syncQueuePausedMarker` tracks marker synchronization errors
- `POST /api/mission/runners/:id/resolve` atomic resolution: deliver answer, requeue, lift marker, enable supervision
- Scheduler decisions test capturing the resolution race (`working` → `wait_turn_end`)
- UI shows stop provenance (auto vs explicit), marker sync errors, detailed status badges
- All automated tests pass; production build succeeds

## Problem

The user answers a Needs input question with **Send & resume**. The agent starts working, but the
panel keeps showing:

```text
Resolution sent and the item requeued, but the queue did not resume: Waiting for current turn
```

The queue then stops advancing. `QUEUE.paused` also appears when the user did not press Pause.
Fix the full answer → resumed work → next item journey, including truthful stop feedback.

The user also confirmed a second entry path on the **Mission page**: after sending an ordinary
message, clicking **Run** is refused with “Waiting for current turn”. Fix explicit Run/Resume as
well as Send & resume. The user should be able to enable queue supervision while their agent is
working; enabling supervision must not mean sending another instruction into that active turn.

Further user report: pressing Run does send an instruction, but the agent replies that it is
pausing because `QUEUE.paused` exists. This is a concrete failed resume journey, not just a hidden
warning. The existing code already attempts marker removal before startup; investigate why that
attempt is ineffective or reversed rather than merely adding the same removal call again.

The next reported state is **“previous instruction is outstanding”** even though the worker
stopped after observing the pause file. Run is now blocked by the earlier instruction's operation
record. Treat this as part of the same recovery journey: delivered instruction, worker stops at
the marker, stale outstanding-operation gate prevents another Run. The report is not independent
proof of the worker's current turn state; confirm that state during implementation.

## Evidence and Cause

- `src/client/src/components/QueuePanel.jsx:doResolve` submits three separate actions: send the
  answer through the session send route, PUT the requeued items, then call `startRunner` if the
  captured runner prop is not enabled. Those actions are not one coordinated operation.
- `src/services/mission.js:startRunner` calls `canDispatch` before enabling supervision. That
  gate correctly refuses an extra startup instruction while the worker is busy. An answer can
  therefore start a worker turn and immediately make the subsequent Start fail. Simply weakening
  the busy gate would reintroduce duplicate instructions addressed by plans 90 and 91.
- `QueuePanel` stores this historical failure in `actionError`. Runner refreshes and actual
  recovery do not clear it. Store-level `runnersError` must also be checked for stale copies.
- `runnerWatchTick` selects only `enabled = 1`. A resolution turn can finish normally while its
  disabled supervisor never advances the remaining queue.
- `syncQueuePausedMarker` currently treats disabled supervision as a paused queue.
  `runnerWatchOnce:stopWith` writes the marker for Needs input, invalid queues, completion,
  permission stops and recovery exhaustion. Setup and failed startup can write it too.
- Read-only live evidence on 2026-10-12: Paddock's `infi` runner
  (`run_9e972939037a6168`) returned `enabled: 0`, `control_state: need_input`,
  `last_reason: Waiting for current turn`, with no user pause record (`pause_mode: null`,
  `pause_state: none`). `plans/QUEUE.paused` existed with only a generic paused sentence.
  The queue still had unfinished work, including an in-progress item. This establishes stopped
  supervision and unexplained marker state; it does not establish the historical writer of that
  particular marker.

## Required User Journey

1. A working queue reaches a question. Show **Needs input**, the affected plan and exact question.
   Explain that the supervisor stopped for input; do not claim the user paused it.
2. The user enters an answer and presses **Send & resume** once. Disable repeated submission while
   the request is pending. Deliver one answer to the runner's bound conversation.
3. Successful resolution clears that item's blocker and restores queue supervision. If the answer
   starts a turn immediately, show **Running — waiting for current turn** as normal scheduler
   status. Do not send an additional startup or continuation while that turn is working.
4. After the turn finishes, the supervisor observes the updated queue, respects idle/nudge gates,
   and continues the next unfinished item in the same conversation without a second Run click.
5. The historical resume warning disappears when recovery is confirmed. Refreshing, switching
   sessions and returning must display current state, never another runner's old action error.
6. If a real failure remains, say which step failed and offer the applicable recovery. Once an
   answer was delivered, recovery must not require sending it again.
7. A later explicit Pause wins over an in-flight resolution. The answer may have been accepted,
   but no late completion may re-enable that paused run.
8. The user sends an ordinary message on Mission, then clicks **Run** while the answer is working.
   Accept the Run intent, enable supervision and show **Running — waiting for current turn**.
   After the turn ends, continue eligible queued work. Do not require the user to time another
   click for the idle window. Genuine unresolved blockers still refuse Run with their exact cause.

## State and Marker Contract

Keep three facts separate: supervision enabled, worker turn state, and why dispatch is stopped.
An active worker does not prove the queue is supervised; waiting for an active turn is not an error.

| Condition | Visible status | New automatic instruction? |
|---|---|---|
| Resolution accepted, worker working | Running · waiting for current turn | No |
| Resolution accepted, worker verified idle | Running · next check / next item | Only through scheduler gates |
| Explicit Pause | Paused / pausing after current task | No |
| Unresolved queue question | Needs input · exact question | No |
| Permission dialog | Needs permission · dialog details | No |
| Invalid queue or observation failure | Specific repair / observation reason | No guessed dispatch |
| All items done | Complete | No |

`QUEUE.paused` is an existing worker stop signal, not proof that the human pressed Pause.
Preserve its existence-based worker compatibility, but make the reason explicit and observable:

- Centralize every automatic and manual stop transition. Record a stable stop cause, origin
  (human/supervisor), timestamp and generation; use existing fields where they carry these exact
  facts, otherwise add the smallest migration needed. Do not infer historical origins.
- Write human-readable cause/origin in the marker and expose the effective stop reason in runner
  reads. Do not put the answer or other conversation text in this metadata or the audit log.
- Audit all marker writers: runner creation, setup, enable/disable, watch-loop stops, startup
  failure/rollback, session close, runner removal and boot reconciliation. Also check worker
  instructions for any path that tells the agent to write/delete this control-plane marker.
- Removing the stop signal during an authorized resume must be confirmed before delivering an
  answer that permits new work. A swallowed filesystem error is not successful resume.
  Verify the physical path the backend clears maps to the exact worker-visible path named in
  the rendered instruction. Include custom workspaces and plans folders. If this cannot be
  established, withhold startup and expose the specific synchronization failure.
- Serialize marker transitions with resolution/start/pause ownership. A stale watch read, setup
  request or failure callback must not restore a marker after a newer successful resume.
- If several runners/projects resolve to the same physical queue, reconcile ownership at that
  queue path: one disabled runner must not overwrite the active owner's marker. Enforce the
  existing queue-owner rule or add an explicit conflict refusal; do not guess an owner.
- On restart, reconcile from durable control/operation state. Preserve an explicit pause and
  genuine blocker. If metadata is legacy/unknown, report that fact rather than inventing a user
  action. Never blindly delete existing markers to make the queue run.

## Implementation

### Phase 1 — Capture and Pin the Failure

- [ ] Add a deterministic service fixture where sending the resolution changes the worker from
  idle to working immediately. Prove the current send → requeue → Start sequence cannot resume.
- [ ] Capture the corresponding runner, queue revision, turn identity, dispatch operation and
  marker state in the fixture. Cover a watch tick racing the resolution using an old queue read.
- [ ] Map all stop and marker writers listed above. Keep confirmed causes separate from the
  user's historical report. Do not restart or alter their live queue to reproduce this.
- [ ] Reproduce “Run sent, agent stops because QUEUE.paused exists” in an isolated fixture.
  Check marker-removal failure, host/worker path mismatch and recreation by a concurrent watcher,
  setup request, another runner or delayed startup rollback. Identify which cases actually occur;
  do not assign the user's historical occurrence to a guessed writer.

### Phase 2 — One Server-Owned Resolution Operation

- [ ] Add a runner-scoped POST resolution route in `src/app.js`, delegated to a service operation
  in `src/services/mission.js`. Use the existing authenticated owner/CSRF/grant checks.
  Input: item ID, expected queue revision, answer and caller-generated idempotency key.
  Derive project and worker session from the runner; do not trust a client-supplied session ID.
- [ ] Validate the item is still Needs input, the revision matches and the bound worker may
  receive the answer. Permission/solo-lock/dead-worker/unknown-delivery rules remain enforced.
  Reserve resolution ownership before any write or send; invalidate stale dispatch ownership.
- [ ] Prepare the requeue and lift the stop marker before sending, while automatic dispatch is
  held. Revalidate generation and queue ownership at side effects. Handle queue CAS races without
  overwriting agent changes. A definitely unsent failure restores the prior blocker only if its
  own revision still owns the prepared change; otherwise return the actual partial outcome.
- [ ] On confirmed answer acceptance, enable supervision without calling the startup-dispatch
  path. Record the resolution operation/receipt so the scheduler sees the answer's active turn
  and sends nothing else until normal eligibility returns. Reconcile an answer turn that starts
  or completes before the final commit; do not force the observed worker state to idle.
- [ ] Persist enough operation state for timeout/restart recovery and deduplicate concurrent
  retries. A request with the same key returns its existing result without sending twice.
  Delivery-unknown remains explicit and withholds resend until reconciled; pane repaint alone
  must not masquerade as exact answer receipt. Reuse plans 88/90's receipt conventions.
- [ ] Return structured current outcomes: resolution delivery state, item/revision, supervision
  state and scheduler status. Distinguish accepted-and-running, accepted-but-explicitly-paused,
  definitely-not-sent, conflict and delivery-unconfirmed. Never return working as resume failure.

### Phase 3 — Stop Provenance and Marker Reconciliation

- [ ] Implement the state/marker contract above in `mission.js` and `plans.js`; add durable fields
  in `db.js` only where required. Generation-fence watch-loop terminal decisions against the
  resolved queue revision, not just the initial runner read.
- [ ] Record automatic stop causes and explicit pause causes separately. Keep audit failures
  non-fatal to an action already performed. Marker synchronization failures must be reported.
- [ ] Check scheduler and resume logic so enabling supervision while working is supported,
  without relaxing `canDispatch` or allowing a send during streaming/tools/compaction/unknown.
- [ ] Split explicit `startRunner`/`resumeRunner` control intent from instruction eligibility.
  For an existing bound, verified-working worker with a valid runnable queue, accept Run/Resume,
  clear the applicable stop record/marker under generation ownership and enable supervision
  without startup delivery. Return structured `started`/supervision and waiting status.
  Keep the initial idle-worker startup receipt requirement, dead-worker recovery and actual
  blocker refusals. For an unknown observation, report supervision/observation truth separately
  and withhold instructions; do not interpret unknown as either working or idle.
- [ ] Validate shared-queue ownership and boot reconciliation. Existing user pauses must survive;
  stale disabled-runner writes must not stop the authorized active owner.
- [ ] Reconcile outstanding instruction ownership when the worker received the exact instruction
  and its corresponding turn completed without queue progress (including stopping at the marker).
  Delivery confirmation, turn completion and plan completion are different facts. Close that
  operation's active lease on verified turn completion without marking the plan done; retain its
  receipt/history and expose the stop cause. Explicit Run must reconcile before rejecting a stale
  lease, including when the runner is disabled and therefore receives no watch ticks.
- [ ] For the marker-stop case, an authorized Run clears/verifies the marker, retires only the
  proven-completed prior operation and resumes unfinished work through normal dispatch ownership.
  Working turns still withhold sends; missing receipt or unknown turn observation stays explicitly
  unconfirmed with reconciliation available, never auto-cleared merely because the pane is live
  or a timer elapsed. Preserve generation fencing and an explicit later Pause.

### Phase 4 — Current-State UI Feedback

- [ ] Replace `QueuePanel:doResolve`'s three calls with one store action in
  `src/client/src/stores/mission.js`. Keep one idempotency key for retries of the same submission.
- [ ] Render normal waiting in `RunnerSchedulerStatus.jsx`, not the permanent action-error area.
  Use structured server outcomes rather than matching the string “Waiting for current turn”.
- [ ] Scope feedback to runner/item/operation. Clear recovered resume errors when a fresh read
  confirms supervision is enabled; reset feedback on runner identity changes. Retain actionable
  unresolved delivery/revision errors until they are resolved or dismissed. Check `runnersError`
  as well as component-local `actionError` for duplicated historical messages.
- [ ] Show automatic stop reason versus user Pause in `QueuePanel.jsx` and `RunnerControls.jsx`.
  Preserve answers on definitely-unsent failures. For accepted partial outcomes offer resume or
  reconciliation without resending the answer. New hooks use stable `msn-queue-*` classes.

### Phase 5 — Verify the Whole Run and Document It

- [ ] Add behavioral coverage to `mission-queue.test.js`, `runner-dispatch.test.js`,
  `runner-turn.test.js` and the applicable client-store/component test. Add marker/migration
  coverage where the implementation changes those contracts.
- [ ] Build/restart and exercise the browser journey below on a dedicated project-owned test
  workspace through the project's normal UI/tools. Keep the user's actual queue untouched.
- [ ] Update `docs/reference/pages/mission.md` and relevant backend runner/queue reference pages
  (locate the current pages through `docs/README.md`) with resolution and stop semantics.
  Mark this plan Complete only after the full journey passes; absorb it into docs afterwards.

## Required Tests and Browser Assertions

1. **Fast answer turn:** Needs input → Send & resume → immediate working turn. Assert one answer,
   enabled supervision, no marker blocking that resumed run, and zero extra startup sends.
   Finish the first item and verify the next item actually starts without another user action.
2. **Slow/instant turn:** Exercise both a delayed worker start and a turn that finishes before the
   resolution response. Neither loses supervision or dispatches a duplicate continuation.
   Also send an ordinary Mission message, then click Run and Resume during its working turn:
   assert accepted control intent, no busy-turn error banner, no extra send and subsequent queue
   progression. Repeat with an actual unresolved blocker to prove its refusal remains intact.
3. **Racing watch tick:** Hold an old Needs input observation; resolve; release the tick. It must
   not disable the resumed generation or rewrite its marker. Give the test a positive counterpart
   where a still-current blocker really does stop supervision.
4. **Explicit Pause race:** Pause before resolution commit and during pending delivery. Assert
   pause state/marker survive and no late enable/send overrides the user's action.
5. **Retries and partial failure:** Concurrent duplicate requests, HTTP timeout, service restart,
   stale revision, marker removal failure, definitely-unsent failure and delivery-unknown. Assert
   no lost queue items, no duplicate answers and truthful recoverable outcomes in each case.
6. **Stop provenance:** Manual pause, blocker, invalid file, permission dialog, completion and
   startup failure have distinct causes. Test shared queue ownership and setup racing resume.
   Start from a stopped runner with an existing marker and a runnable queue. Assert marker absence
   at the worker-visible path BEFORE startup is delivered, and again when the worker begins the
   next item. Force marker removal to fail: no startup may land and the exact failure must appear
   in the queue feedback panel from plan 98. Let a stale writer complete after resume: it must not
   recreate the marker. The positive counterpart is a new explicit Pause, which must create it.
7. **UI lifecycle:** In the browser, observe the exact reported banner path, then confirm it is
   absent after real recovery and remains absent across polling and session navigation. Force a
   genuine failure and verify its recovery action still appears. Check desktop and narrow layout,
   browser console and failed requests. Count projects before/after; do not delete unknown rows.
8. **Controls:** In a throwaway copy only, restore the old busy-Start sequence and stale marker
   write. Relevant regression tests must fail while unrelated tests stay green. Read the original
   source back to ensure the controls never touched the bind-mounted worktree.
9. **Outstanding-after-marker-stop:** Deliver an instruction with an exact receipt, let its turn
   stop because the marker exists, and leave queue work unfinished. With supervision disabled,
   press Run: it must reconcile the completed operation, verify marker removal and resume on the
   same session without a permanent “previous instruction is outstanding” refusal. Verify that
   retries cannot duplicate the new instruction. Positive guards: an actually working prior turn
   remains protected, an unknown delivery is not silently retired, and plan status is never changed
   to done solely because the instruction turn ended. Repeat across service restart.

Run affected test files individually, for example:

```bash
timeout 60 docker exec paddock node --test test/mission-queue.test.js
timeout 60 docker exec paddock node --test test/runner-dispatch.test.js
timeout 60 docker exec paddock node --test test/runner-turn.test.js
timeout 60 docker exec paddock node --test test/queue.test.js
```

Use isolated databases/workspaces for added tests. A green build or a label reading Running is
not completion: the answered item and following item must demonstrably progress in one run.

## Related Work

- Plan 86: queue panel, blocker resolution and pause modes.
- Plan 87: infinite-session lifecycle tests.
- Plans 88/90: delivery reconciliation, operation ownership and duplicate-dispatch prevention.
- Plan 91: turn-aware idle gating and prompt templates.
- Plan 92: lifecycle callbacks; resumed/stop outcomes must not duplicate callback events.

Implement against the current versions of those facilities. Do not fix this by clearing the banner
on a timer, ignoring Pause, deleting the marker blindly or weakening busy-worker send guards.
