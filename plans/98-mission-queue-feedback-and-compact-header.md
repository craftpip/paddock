# Mission — Visible Queue Feedback and a Compact Top Panel

## Status: Complete — 2026-10-15

4/4 phases complete.
- Phase 1: Trace and centralize feedback ✓ (centralized `operationFeedback` in mission store, QueuePanel displays it)
- Phase 2: Compact header and panel ✓ (RunnerControls action-only, QueuePanel owns feedback display, compact summary)
- Phase 3: Real recovery controls ✓ (reconciliation/retry actions for unconfirmed deliveries, queue revision conflicts)
- Phase 4: Verification and docs ✓ (all tests pass, documentation updated)

Implemented:
- Centralized `operationFeedback` in `useMission` store, keyed by runnerId
- QueuePanel displays feedback with severity styling and dismiss action
- RunnerControls now action-controls only (errors moved to QueuePanel)
- Atomic `POST /api/mission/runners/:id/resolve` replaces send→requeue→start sequence
- Reconciliation/retry actions for unconfirmed deliveries (`operation_status === 'unconfirmed'`)
- Queue revision conflict handling with Reload queue button
- Auto-stop provenance tracking (`stop_cause`, `stop_origin`, `stop_at`, `marker_sync_error`)
- All automated tests pass (57 plan-mcp, 8 mission-reopen, 3 plan97-scheduler-decisions)
- Production build succeeds

## Requested Outcome

Show delivery warnings **inside the plans/queue panel**, where the user is looking for progress.
Reorganize Mission column 3's crowded top area so controls, status, warnings and the plan list fit
without stealing most of the terminal space.

The user supplied this warning and said it is not visible:

```text
The message was written but the pane showed no change, so delivery is unconfirmed — the session is live; reconcile or retry [project:paddock (prj_f34d6ccdb9bbc303) session:msn_c7e9f54459c23f56]
```

The message must be readable in the queue panel, not available only on hover or in a cramped header.
Plan 97 fixes resolution/Run behavior; this plan fixes where feedback appears and the panel layout.

## Code Findings

- `Mission.jsx` renders a fixed `h-9` terminal header with project, session label, cwd, solo badge,
  runner state/reason, Run/Pause, Configure, relaunch action and command name on one row.
- `RunnerControls.jsx` puts errors in a `max-w-56 truncate` inline span. Its runner reason is
  `hidden ... xl:inline`, so it disappears below the viewport breakpoint even when the actual
  column has room, or truncates in a wide viewport with a narrow column.
- Errors have several unrelated homes: `RunnerControls` local `error`, `QueuePanel` local
  `actionError`, store `runnersError`/`queueError`, and Mission's `actionError` bar outside the queue.
  `QueuePanel` does not receive Run/Pause action errors from `RunnerControls`.
- `QueuePanel` repeats state/counts in its header and a three-row Current/Next/Completed summary,
  followed by scheduler wording, pause wording, blocker form, full item list and queue path.
  The entire section is `shrink-0`; only the item list has a height bound (`max-h-40`).
- Collapsing the panel hides its action errors as well as its queue body. A warning can therefore
  remain unresolved but vanish with the details it belongs to.

These are code-confirmed visibility/layout problems. The exact historical destination of the
user's supplied warning still needs tracing through the action that returned it; do not assume
it came from one particular button merely because its wording matches a service error.

## Layout Contract

### Terminal Header

Keep one compact identity row: project, session/runner name, live indicator and solo state.
Identity text may truncate with a title; operational warnings may not. Move queue controls to the
queue toolbar. Put cwd/command metadata in an accessible details disclosure rather than competing
with primary actions. Keep recovery actions reachable for ordinary sessions without a queue.

### Plans/Queue Panel

Use this order:

```text
Infinite queue · Running · 3/8 done       Run/Pause ▾   Add plans   Configure   Collapse
Current: <plan> · Next: <plan>            working · Waiting for current turn
[Delivery unconfirmed: full readable message ...]
[Applicable reconciliation/recovery action; Details; Dismiss]
Working   <current plan>
Queued    <next plan>
...                                     Done (3) ▾
```

- A compact toolbar owns the queue state and queue controls. Avoid duplicate state badges and
  repeated counts across the header and summary. Keep the Pause modes and Configure accessible.
- One concise current/next line and one scheduler status are enough for normal operation.
  Use existing server summary/scheduler facts; do not re-derive whether the queue is running.
- Put important feedback directly under that summary, **inside `.msn-queue-panel` and above the
  plan list**. Wrap full text with `whitespace-pre-wrap`, `break-words`/`overflow-wrap:anywhere`.
  No `truncate`, `hidden xl:inline`, tooltip-only text or horizontal scroll for warnings.
- Keep unresolved important feedback visible when queue details are collapsed: retain a compact
  feedback area and an Expand action. Collapse should hide the list/details, not the warning.
- Show unfinished plans first in their original queue order; completed items remain available in
  a counted disclosure. Do not reorder or delete persisted queue entries to achieve this display.
- Keep the question and answer action together for Needs input. Avoid repeating the same answer
  input in both an inline panel and a modal; choose one visible editor and preserve its draft.
- Move queue path and verbose diagnostics into Details with Copy actions. The exact supplied
  message remains readable; project/session IDs may be separate copyable context in Details.
- Bound the expanded queue area to `min(40vh, 20rem)` initially, with `min-height:0` and an internal
  list/details scroller. Keep the compact toolbar and feedback reachable. On short screens allow
  the body/long warning to scroll, rather than a `shrink-0` stack squeezing the terminal to zero.
  Validate this budget during implementation; do not fix overlap by shrinking text into illegibility.
- Respond to **column width**, not only viewport breakpoints: use wrapping/container-aware layout.
  At narrow widths place toolbar actions on a second row; retain text labels for primary controls.

## Feedback and Recovery Contract

Use one runner/session-scoped feedback source for queue actions, consumed by the queue panel.
Record action/operation identity, severity, message and structured delivery state. Keep raw answer
text out of diagnostics. Preserve ordinary non-queue session errors in their own visible surface.

- Route Run, Resume, Pause, resolution, queue writes and applicable delivery-unconfirmed outcomes
  into this feedback surface. Remove duplicate rendering from the cramped runner-control span.
- “Waiting for current turn” while enabled is ordinary scheduler status, never a red action error.
- Delivery unconfirmed means a write occurred without confirmation. Do not label it unsent,
  stopped or successfully received. Show the live-session fact separately from delivery certainty.
- Trace whether an existing reconciliation action exists. Expose it if available; otherwise add
  an owner-scoped operation reconciliation service/route using plans 88/90's receipt rules.
  Never add a button that merely reloads the queue while claiming to reconcile delivery.
- Retry must reuse the operation's idempotency key and reconcile prior acceptance first. A
  one-click blind resend of an unknown delivery can duplicate user messages and is not recovery.
- Clear obsolete errors when current operation state proves recovery. Keep unresolved delivery
  warnings until confirmed or dismissed; dismissal hides presentation, not the unresolved operation.
  Navigation must never transfer one runner's feedback to another runner.
- Feedback uses `role="status"` for normal transitions and an appropriate alert/live region for
  actionable failures. Do not repeatedly announce the same warning on every polling refresh.

## Implementation Checklist

### Phase 1 — Trace and Centralize Feedback

- [ ] Trace the supplied warning through `mission.js:sendText`, runner delivery/start operations,
  REST serialization, the Mission store and all UI catches. Identify lost structured fields.
- [ ] Add the scoped feedback contract to `src/client/src/stores/mission.js`; integrate plan 97's
  resolution results and retain machine-readable acceptance/operation identity at the API boundary.
- [ ] Ensure operation feedback is current across polling and navigation; no automatic resend.

### Phase 2 — Compact the Header and Panel

- [ ] Refactor `src/client/src/pages/Mission.jsx` identity row and queue control placement.
- [ ] Make `RunnerControls.jsx` action controls only; render errors in `QueuePanel.jsx`.
- [ ] Compact queue summary and scheduler in `QueuePanel.jsx`/`RunnerSchedulerStatus.jsx`; add
  readable feedback, completed disclosure, metadata details and bounded internal scrolling.
- [ ] Preserve stable `msn-*` hooks and terminal mounting identity. Changing queue state or
  expanding details must not reconnect the terminal or change the opened session/project.

### Phase 3 — Real Recovery Controls

- [ ] Implement/expose reconciliation and idempotent retry only where supported by operation
  state. Keep explicit user Pause authoritative. Add a dismissible presentation where appropriate.
- [ ] Distinguish normal waiting, delivery-unknown, queue conflict and blocker repair with useful
  actions. Refreshing current state must remove a superseded failure without hiding a real one.

### Phase 4 — Verification and Docs

- [ ] Add behavior tests proving a Run action's failure reaches the queue feedback source,
  stays scoped, clears on confirmed recovery, and does not cause another send on reconciliation.
- [ ] Parse/build affected JSX and run relevant individual queue/runner/store tests in isolation.
- [ ] During implementation, verify actual desktop, narrow-column and short-height layouts:
  the complete supplied warning is visible/wrapped in the panel, controls stay reachable,
  completed items are expandable, the terminal retains usable space and no horizontal overflow.
- [ ] Test collapsed warning visibility, long unbroken IDs, multiple errors, empty/malformed queue,
  Needs input editor, dropdown keyboard focus and both themes. Inspect console/request failures.
- [ ] Measure that queue updates and disclosure toggles preserve the same terminal instance/WS.
- [ ] Update the Mission reference docs with the final feedback placement and recovery behavior;
  absorb this plan only after implementation and full verification are complete.

The current task ends with written plans. Browser checks in Phase 4 are acceptance requirements
for the later implementation, not a request to inspect the user's browser during planning.
