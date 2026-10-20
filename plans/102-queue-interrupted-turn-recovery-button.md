# 102 — Interrupted worker turn shows Pause queue instead of Run queue

## Status: Complete (2026-10-15)

3/4 items done. Server verdict, recovery control and explicit recovery guards are
implemented and covered by focused regression tests. Remaining: controlled browser
verification and documentation absorption; no interruption was manufactured in the
user's live session.

## The bug

The queue reports:

```text
idle · Worker turn interrupted or failed — explicit recovery required
```

But its action button still says **Pause queue** instead of **Run queue**.
The worker has stopped and automatic continuation is withheld; the control offers
a pause rather than the explicit recovery the message requires. The user should
not have to pause an already-stalled queue before being able to run it again.

## Source findings

- `src/services/agent-store.js` returns `state: 'idle', outcome: 'error'` with
  the exact reported reason for an errored worker turn.
- `computeSchedulerState` in `src/services/mission.js` suppresses automatic
  dispatch for that error outcome, returning `observation_unavailable`. An
  explicit start is handled separately and may recover it after validation.
- `src/client/src/components/RunnerControls.jsx` selects Pause solely from
  `runner.control_state === 'enabled'`. This cannot distinguish an enabled
  queue waiting normally from one withheld pending explicit recovery.

These findings explain the mismatch. Verify the actual runner payload and
outstanding-operation state before choosing the implementation; the reported
reason is evidence of interrupted work, not a reason to bypass delivery guards.

## Expected user journey

1. A running queue's worker turn is interrupted or fails.
2. The queue displays the interruption reason and **Run queue** as its primary
   action. An existing Pause dropdown closes when that action changes.
3. Nothing resumes automatically, including on polling, page reload or opening
   the conversation.
4. Clicking Run queue performs one explicit recovery through the existing start
   action. Show pending feedback and prevent duplicate clicks.
5. On success, refresh the runner and queue immediately. Show Pause queue again
   when supervision is actually running; replace the stale recovery message.
6. If recovery is refused or fails, retain Run queue and show the real error.
   Preserve queue items and conversation identity.

## Implementation

- [x] **Define a recovery verdict at the server.** Inspect the runner read and
  scheduler enrichment paths. Expose a structured recovery-required fact for
  the verified idle/error outcome, reusing an existing field if it already
  expresses this exact fact. Do not match the human-readable reason string or
  infer recovery from all `idle`/`observation_unavailable` states: ordinary idle
  grace, unknown observations and unreadable stores are different cases.
- [x] **Render the correct action.** Consume that verdict in RunnerControls:
  recovery required → Run queue; enabled and ordinarily supervised → Pause
  queue. Keep queue validity and action-in-flight guards. Close any stale pause
  menu and make the state badge/reason agree with the recovery state. Inspect
  QueuePanel and any other rendering of the same controls for parity.
- [x] **Verify explicit recovery works.** Trace `startRunner` and its dispatch
  gate against an interrupted turn with an outstanding operation. Fix any
  legitimate recovery refusal without clearing an instruction that might still
  be executing or sending twice. Preserve generation checks, idle validation,
  receipt tracking and the prohibition on automatic recovery. Use the existing
  store action and operation feedback; refresh after success.
- [x] **Test and document.** Add behavioral regression coverage, build and
  restart the app, exercise the flow in the browser, then absorb the completed
  behavior into the relevant Mission docs before removing this plan.

## Verification

Locate the existing runner scheduler/start tests and client queue-control tests;
run each relevant test file individually with the project's 60-second timeout.

Required assertions:

- Verified idle + error outcome + enabled runner exposes recovery required and
  renders Run queue, with no pause menu. Normal enabled idle grace still offers
  Pause queue; working and unknown/unreadable observations do not masquerade as
  interrupted-turn recovery.
- Polling the failed turn makes no dispatch. Explicit Run validates the current
  worker and sends exactly once, including with the actual outstanding-operation
  fixture. Duplicate clicks cannot send twice.
- A recovery refusal preserves queue/conversation data and presents feedback;
  a successful recovery refreshes the visible action and reason.
- Restoring the old enabled-only button condition makes the regression fail.
  Perform mutation checks in a throwaway copy, never the bind-mounted source.

After the frontend build and service restart, use a controlled test runner to
reproduce the interruption. Assert the resulting DOM shows the reported reason
alongside Run queue. Click Run in a separate browser call, then check the resulting
DOM, request, worker delivery and refreshed state. Exercise keyboard activation
and narrow-screen visibility; inspect console errors and failed requests. Do not
interrupt or resume the user's live conversation just to create the fixture.

## Affected files

- `src/services/mission.js` — scheduler/read verdict and explicit recovery gate.
- `src/services/agent-store.js` — existing turn-outcome contract; change only if
  inspection demonstrates missing information.
- `src/client/src/components/RunnerControls.jsx` — action and menu state.
- `src/client/src/stores/mission.js` — existing start/refresh/feedback flow.
- Relevant runner/queue tests and Mission documentation (read `docs/README.md`
  and `docs/STYLE-GUIDE.md` before editing docs).
