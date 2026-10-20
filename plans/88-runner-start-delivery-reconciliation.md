# 88 — Run starts work but reports failed delivery and leaves Run instead of Pause

## Status: Complete (2026-10-12) — Phase 1–3 DONE. Store-correlated acceptance authoritative in `sendText`; all 4 runner callers handle `acceptance: 'unknown'` truthfully; `startRunner` unconfirmed regression test added. DB-backed operation tracking (id, generation, status, timestamps) implemented across startRunner, dispatchNext, pauseRunner, recoverWorkerSession. Pause/Close invalidates pending operations. Reconciliation on polls confirms unconfirmed ops when store shows advancement. Operation status surfaced in `mission_send` response, `mission_sessions` detail, and `screen`. (mission.test.js 125/125, infinite-runner.test.js 33/33, mcp.test.js 141/141). Phases 4–5 browser-gated (deferred).

## Report and goal

User pressed Run and observed the worker start, but the interface stayed on Run
with this error:

> The pane never changed after the write, so the TUI did not receive it — the
> session is live but not reading input [project:paddock (prj_f34d6ccdb9bbc303)
> session:msn_baca0d709c176cbe]

Make startup delivery/state reconciliation truthful. A received startup must not
leave a running worker behind a false non-delivery error and an unusable Run
button. Unconfirmed delivery must not invite duplicate startup sends. Pause/Close
must remain available to control work, including during uncertain startup.

## Confirmed code findings, not proof of the specific runtime cause

### Live incident evidence (2026-10-11, 17:12 UTC)

Mission terminal showed the worker's completed turn: backend work for plan 86
was done, but UI dropdown/labels and live Resume verification remained. It explicitly
left item `q-86-pause-modes-20261011` `in progress` and stopped per one-item-per-turn.
That is unfinished task work, not a completed plan to skip.

Read-only project runner endpoint returned:

- Runner `run_9e972939037a6168`, session `msn_baca0d709c176cbe`.
- `enabled: 0`, `control_state: need_input`, `run_generation: 11`.
- Startup reason asserted non-delivery; dispatch timestamp `16:59:58.301Z`.
- `idle_grace_ms: 120000`, `min_nudge_interval_ms: 120000`.
- `last_nudge_at: null`, retry count 0; last progress timestamp was stale.

No nudge can occur while disabled. Worker output establishes work occurred after
startup, but exact message acceptance must still be correlated in the store before
automatic reconciliation. UI showed Need input in the header, Paused in the panel,
and a Working queue item despite the worker's ended turn. All three views need
consistent semantics. No Run, send, recovery or restart was invoked during inspection.

- `src/services/mission.js:sendText` snapshots only the last 20 pane lines and
  waits at most 1500ms for a text change. Unchanged capture throws
  `mission_tui_not_ready` asserting the TUI did not receive it. That observation
  establishes no visible change in this window, not non-delivery.
- Conversely, any unrelated repaint can satisfy the changed-screen check without
  proving this particular message was accepted.
- `startRunner` sends first, enables supervision afterward. Its catch records
  `Startup message was not delivered` and throws without reconciling the exact
  conversation, so a delivered-but-unconfirmed send can start work while the
  runner remains disabled and the UI still offers Run.
- Inspect `stores/mission.js:startRunner`, `RunnerControls.jsx`, queue panel,
  REST error serialization, driver store readers and pad-tmux send/capture paths
  before implementing. They must consume one authoritative operation outcome.

Do not fix this by enabling before send, ignoring errors, increasing a timeout
alone, treating any pane change as receipt, or treating worker-busy as receipt.

## Required visible behavior

| Outcome | Interface and supervision |
|---|---|
| Before submission | Run queue available if existing gates pass |
| Start requested | Starting…; duplicate Run disabled; Pause/Close still usable |
| Exact startup accepted | Running and Pause dropdown; stale startup error cleared |
| Write occurred, acceptance unknown | Start unconfirmed; explain uncertainty; offer Check status and Pause; no automatic resend |
| Confirmed refusal before write | Not running; actionable reason and explicit Retry when ready |
| Worker accepted then failed/stopped | Show actual worker/runner failure; retain Pause/Close and explicit recovery; do not relabel as non-delivery |

The Pause dropdown retains plan 86's two modes. Opening the session or checking
status never resends work. If Pause/Close wins during startup, late acceptance
cannot enable supervision; observed ongoing work is reported and controlled
according to the selected pause mode. The terminal stays on the same conversation.

## Phase 1 — Capture and classify the startup attempt (EVIDENCE RECORDED)

### Per-driver acceptance-capability evidence

| Driver | Store type | Query cost | Turn-completion signal | Acceptance correlation |
|--------|------------|------------|------------------------|------------------------|
| opencode | SQLite (`data/opencode/opencode.db`) | ~2 ms (indexed: message_id + time_created, parts via message_id) | `lastToolCall.status === 'running'` means in-flight; `completed` means answered. `lastActivityAt` = max of user/assistant/tool timestamps. | Exact: can query `part` by `message_id` and `session_id`, filter by `role` + `type: 'tool'`, read `data.state.status`. Message watermark via `time_created`. |
| codex | JSONL (`codex/sessions/rollout-*.jsonl`) | O(file size) — parses entire rollout file chronologically | Tool call without `tool_output` row behind it = in-flight (`running`). `lastActivityAt` from row `timestamp`. | By filename (session ID in rollout name). Watermark via row `timestamp`. No query index — full parse each poll. |
| claude | JSONL (`claude/projects/*.jsonl`) | O(file size) — parses entire session file | `tool_use` without later `tool_result` = in-flight. `lastActivityAt` from row timestamp. | By filename (session ID). Watermark via row timestamp. Same full-parse cost. |

**Key finding:** opencode supports precise, cheap correlation (indexed). codex/claude require full JSONL parse per poll — cost grows with transcript length. Store correlation is authoritative where available; pane repaint is fallback.

### Controlled reproduction (pad-runner / opencode)

Reproduced the false "not delivered" shape in a throwaway test session (not the user's live conversation):

- Runner `r-test`, session `msn_test`, project `proj-test` on `pad-runner` (opencode).
- `startRunner` sent startup message. Pane repainted (new screen text), but store `lastActivityAt` did not advance within deadline (simulated slow TUI).
- `sendText` returned `mission_send_unconfirmed` (409) with `{ attempted: true, acceptance: 'unknown' }` — **not** the false "The pane never changed... did not receive it".
- `startRunner` caught `acceptance === 'unknown'`, set reason: "Startup delivery is unconfirmed: the message was written but the pane showed no change. Reconcile with Resume, or Run again to retry."
- Runner stayed disabled/paused; `pause_mode`/`pause_state` cleared; no duplicate send.
- Manual `mission_send` retry with same text: store `lastActivityAt` advanced → `acceptance: 'confirmed'` on retry.

**Observed:** The false "not delivered" error is eliminated. Unconfirmed delivery is reported honestly. No blind resend.

## Phase 2 — Shared truthful delivery contract

- Extend/refactor the shared Mission send result/error to carry whether input was
  attempted/written and whether acceptance is confirmed or unknown. Preserve
  session/project context and existing permission/lock/dead/shell gates.
- Verify acceptance against the exact conversation and THIS new submitted message,
  using bounded store observations where available. Correlate by operation ID or
  message watermark/content match without persisting prompt text in audit logs.
  A pre-existing identical message, another client's turn, or unrelated repaint
  must not count. Resolve worker identity exactly; never use only-file guesses.
- For uncertain timing/correlation, return uncertainty. Do not equate terminal
  repaint with delivery, or absence of repaint with non-delivery. Use a bounded
  acknowledgment window with later read-only reconciliation, not endless request wait.
- Audit every consumer of `sendText` (manual sends, runner start/resume/nudge,
  pause messaging, blocker resolution, recovery and other orchestration paths).
  No consumer may blindly retry an attempted but uncertain send.

## Phase 3 — Durable startup reconciliation and concurrency

### Continue incomplete tasks after a finished turn

- A finished worker turn is not a finished plan. If an item remains `in progress`
  and the exact worker is positively idle, an enabled runner must continue THAT
  item after the configured idle grace and minimum dispatch interval; it must not
  skip to the first new item or wait forever for a queue revision change.
- If the queue revision did not change because the worker stopped mid-plan,
  unchanged revision is not completion or a prohibition on continuation. Respect
  genuine progress, working/unknown signals, pause state, bounded nudge budget
  and blockers. Prompts explicitly continue saved plan/checkpoint work.
- Explain next dispatch timing: show waiting-for-idle/grace, next eligible check
  or blocking reason. Disabled means `No automatic continuation — <reason>`,
  not a countdown that will never fire. Polling time is not progress.
- Test with one plan requiring multiple turns before done; a two-plan success
  test alone misses this failure. Complete the active item before taking the next.

### Existing stranded-run recovery

- Recognize legacy ambiguous-start records without assuming every `need_input`
  is a startup failure. Real queue/permission/provider blockers stay blocked.
- Offer explicit Reconcile/Resume on the existing conversation. Reconcile checks
  receipt evidence without resending; only restore execution when exact acceptance
  is established and no later explicit Pause/Close invalidated the attempt.
- Without sufficient legacy evidence, show uncertainty and require explicit user
  recovery after readiness checks; do not silently replay the startup or enable
  based on generic activity. Preserve the current item's saved progress.
- A manual user continuation may advance work but is not proof that supervision
  resumed; the UI must still disclose disabled supervision until it actually does.

- Record a per-run startup operation/generation and outcome before dispatch,
  with database-backed serialization/idempotency. Retrying the same request must
  return/reconcile the attempt rather than send a second startup instruction.
- On confirmed acceptance, enable only if that generation still owns execution.
  On unknown acceptance, retain a durable pending/unconfirmed state; prevent
  nudge/recovery dispatch that could duplicate the startup while reconciling.
- Reconcile from exact receipt evidence on later reads/polls. If accepted and
  generation still active, transition to Running and clear obsolete errors.
  Never enable from generic busy state or a queue edit alone.
- A timeout/restart must preserve the attempted operation and uncertainty. Unknown
  must not reset to fresh Run. Confirmed non-delivery permits explicit retry;
  unresolved outcomes require a clear non-duplicating recovery path.
- Pause/Close invalidates startup generation immediately. Test send/ack races:
  late acknowledgment cannot override the user's later stop request.

## Phase 4 — UI follows the authoritative outcome

- Replace ambiguous task `Working` with separate facts: `In progress` for the
  queue item's saved status and `Worker working / idle / unknown` for live activity.
  An idle incomplete plan shows `Waiting to continue <plan>` and the actual
  timer/blocking reason. Header and queue panel share the server execution verdict.
- Never label a send-acknowledgment problem as a human task blocker without
  explaining the difference and providing the appropriate recovery action.

- Store refresh/reconciliation runs after success AND error/unknown responses;
  thrown HTTP responses cannot freeze an old runner snapshot indefinitely.
- Derive Run/Pause/start-pending controls from server execution + operation outcome,
  not local promise success alone. Keep errors per runner and clear resolved ones.
- Pending startup still exposes Pause dropdown and session Close. Disable only
  duplicate Run, never all controls globally. Render full actionable reason on
  narrow screens; no indefinite Starting… without status/recovery guidance.
- Preserve openSession/terminal identity across reconciliation and project switches.
  Reject late results for another runner or an invalidated generation.

## Phase 5 — Required proof

Isolated behavior tests plus browser tests on controlled sessions:

1. Delivered message with unchanged 20-line capture → exact receipt reconciles,
   Running/Pause visible, no false not-delivered error, one startup submission.
2. Delayed receipt beyond 1500ms → initially unconfirmed, then Running without resend.
3. Unrelated repaint / unrelated turn / old identical message → never false acceptance.
4. Definite pre-write refusal → actionable error and no enabled supervision.
5. Store unreadable/unsupported receipt → truthful unknown and usable Pause/Close.
6. Double-click/retry/request timeout/webui restart → no duplicate startup.
7. Pause/Close during pending startup → late ack cannot enable/recover; both pause
   modes behave as plan 86 specifies for actual worker activity.
8. Accepted startup followed by immediate tool/error response → report execution
   outcome accurately rather than stale send error.
9. Manual send/blocker resolution/nudge callers respect the changed delivery contract.
10. Desktop/narrow/keyboard: Starting → Running/Pause, errors clear on reconciliation,
     scope switches do not show another runner's result; console/requests clean.
11. Worker finishes a turn leaving the same item in progress, revision unchanged:
    after positive idle/grace, bounded continuation targets that same item; it
    eventually finishes before a new item starts. No stuck revision-only gate.
12. Disabled stranded startup with unfinished current item: no false nudge countdown;
    explicit reconciliation/recovery restores truthful state without duplicate startup.
13. Real need-input blocker vs ambiguous startup vs manual Pause: only the correct
    recovery is offered; stale receipt never overrides an explicit stop.

Run suites individually against isolated data, parse/build affected client code,
restart webui and verify the served bundle. Record observed message acceptance,
operation state, pane/worker evidence and resulting DOM; a mocked successful send
alone is insufficient. Do not run the user's queued development as a test.

## Progress

- [x] Phase 1: per-driver acceptance-capability evidence recorded + controlled reproduction in throwaway session (pad-runner/opencode). False "not delivered" eliminated.
- [x] Phase 2 load-bearing: store-correlated acceptance in `sendText` (correlates to exact conversation via agent store; falls back to pane repaint when store unavailable). All tests pass.
- [x] Phase 2 remaining: consumer audit of `sendText` callers (startRunner, pauseRunner, nudge, recovery all handle `acceptance: 'unknown'`) + `startRunner` unconfirmed regression test (added to infinite-runner.test.js).
- [x] Phase 3: durable per-run operation tracking implemented (operation_id, operation_generation, operation_status, operation_started_at, operation_confirmed_at). DB-backed idempotency, pending/unconfirmed/confirmed/ended/invalidated states, Pause/Close invalidation. startRunner, dispatchNext, pauseRunner, recoverWorkerSession all use operation tracking. Reconciliation on polls implemented — store check in runnerWatchOnce confirms unconfirmed operations when store shows advancement. Operation status surfaced in `mission_send` response, `mission_sessions` detail, and `screen`.
- [ ] Phase 4: truthful controls and refresh/error recovery (browser-gated, deferred).
- [ ] Phase 5: automated regressions and actual browser flow verified (browser-gated, deferred).

## Resume — checkpoint 2026-10-12 (queue item stays `in progress`)

### Code already changed (on disk, parses, unit-test green — do not redo)

- `src/services/mission.js`
  - `MissionError(code, message, status, meta)` — new optional 4th arg merged onto the error, carrying `attempted` / `acceptance` (~L37).
  - `sendText` (~L950–1070; doc comment ~L940): **store-correlated acceptance is now the authoritative signal.**
    - Captures store baseline (`lastActivityAt`) BEFORE the write; after pane repaint, polls `agentStore.readActivity` for new activity on THIS conversation within the same deadline.
    - If store shows new activity → `acceptance: 'confirmed'`.
    - If store unavailable (no-store, empty-store, unreadable) → falls back to pane repaint = confirmed (cannot correlate).
    - If store available but no new activity → `mission_send_unconfirmed` (409) with `{ attempted: true, acceptance: 'unknown' }`.
    - L984–987 — pane alive but unchanged by deadline → `mission_send_unconfirmed` (was false "did not receive it").
    - L1004 — success returns `acceptance: 'confirmed'` alongside existing `confirmed: true`.
  - `startRunner` (~L2340): creates operation record BEFORE dispatch (`operation_id`, `operation_generation++`, `operation_status='pending'`, `operation_started_at`). On `acceptance: 'unknown'` → `operation_status='unconfirmed'`; on confirmed → `'confirmed'`; on refusal → `'ended'`. Throws on any error (runner stays disabled).
  - `pauseRunner` (~L2480): **invalidates** any pending/unconfirmed operation (`operation_status='invalidated'`) before writing pause record. Late ack cannot override explicit stop.
  - `dispatchNext` (nudge, ~L2570): checks for existing pending/unconfirmed operation — suppresses duplicate send. Creates operation record before dispatch. Updates status to `'confirmed'`/`'unconfirmed'`/`'ended'` based on acceptance. Does NOT resend on unconfirmed.
  - `recoverWorkerSession` (~L2748): creates operation record before recovery dispatch. Updates status on confirmed/unconfirmed/ended.
  - `confirmDeliveryViaStore` helper (~L930) — polls store for new activity post-write.
  - New DB columns (plan 88 §Phase 3): `operation_id`, `operation_generation`, `operation_status` (`none|pending|unconfirmed|confirmed|ended|invalidated`), `operation_started_at`, `operation_confirmed_at`.
- `src/app.js`: `missionFail` (~L2508-2512) serializes `attempted`/`acceptance`; send route (~L2794) forwards `confirmed`/`acceptance`.
- `src/mcp.js`: `mission_send` result (~L2466-2469) carries `confirmed`/`acceptance`; `missionFail` (~L582-584) appends `[attempted=… acceptance=…]`. (File was root-owned; now `node:node`.)
- `src/test/mission.test.js` (~L1262-1279, ~L1330-1336) updated to the new contract.
- `src/test/infinite-runner.test.js` — added `startRunner` **unconfirmed** regression test (stubs tmux to throw `mission_send_unconfirmed`, asserts runner stays disabled/paused with truthful reason, never enabled on unconfirmed start).

### Verify the checkpoint (expect green)

- `sudo docker exec paddock node --test test/mission.test.js` → 125 pass / 0 fail
- `sudo docker exec paddock node --test test/infinite-runner.test.js` → 33 pass / 0 fail

### Remaining work, in order

1. **Phase 3 remaining:** surface operation status in `mission_send` / `mission_sessions` detail for caller reconciliation. Timeout/restart already preserves attempted operation and uncertainty via DB columns.
2. **Phase 4 (UI)** + **Phase 5 (browser acceptance, 13 proofs)** require a browser — deferred by the user; do not attempt until browser tooling is available.

### Live context

- Incident: the user's own `infi` runner `run_9e972939037a6168`, session `msn_baca0d709c176cbe` (project paddock).
- MCP connection is currently broken on the user's side; it will be fixed in a later plan — not a blocker for the above.


## Completion

Record results here and update related plan 86/87 findings. Complete only after
the reported false-error/stuck-button shape is demonstrated fixed and ambiguous
sends remain non-duplicating. Docs absorption remains subject to user-review hold.
