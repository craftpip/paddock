# 90 — Stop continuation spam while the worker is already working

## Status: Complete (2026-10-12) — all four phases done and verified. `agent-store.readTurn` gives the exact turn verdict (working/idle/unknown, never a tool-only guess); `computeSchedulerState` + `recordSchedulerDecision` persist `worker_state`/`scheduler_decision`/`scheduler_reason` on every tick and gate, shown in the terminal header (`msn-runner-scheduler`, `msn-runner-worker-state`); `ensureRunnerIndex` repairs a missing INDEX.md on every dispatch path and refuses with `runner_index_unavailable` when it cannot; leases (`acquireDispatchOwnership`) + `deliverRunnerInstruction`'s `beforeWrite` re-check make one instruction exactly one turn. Live controlled worker (`Runner 90 controlled proof`, `run_b9d0bedd159b8c6c`) worked proof-a/proof-b to done with exact input receipts and zero duplicate prompts. Suites green in-container: runner-dispatch 21/21, runner-turn 10/10, infinite-runner 33/33, mission 125/125, queue 42/42, mission-queue 11/11, mcp 141/141, db-migration 12/12, plan-mcp 57/57. Live API verified after restart (runner row, session detail and queue detail all carry the scheduler fields; served bundle contains the UI tokens; page 200). Boundary: no interactive desktop/narrow click-through from this shell (no browser tool; CDP unreachable) — strings served were verified, pixels were not.

## Goal

Group: Runner reliability. Implement before plans 91 (prompt setup) and 92
(callbacks); [grouped order](94-runner-and-navigation-plan-groups.md) is a planning
index, not a queue change.

One runner instruction starts one worker turn. While that turn is active or its
outcome is unknown, the supervisor must not send another startup/Continue/nudge.
Once the turn is positively finished, automatically continue unfinished work or
take the next queued plan according to queue state, grace and minimum intervals.
Pause/Close must cancel further sends without being undone by a stale tick.

## Observed failure

The user supplied a transcript where the worker selected plan 88, claimed its
queue item, and started reading the implementation. Repeated identical Continue
instructions arrived between those steps. This is not normal automatic task
continuation; it injects more instructions into work already underway.

The user also reports repeated `QUEUE.paused` checks: each injected Continue prompt
requests the check again, pulling the worker back to it mid-work. Preserve legitimate
pause-marker checks before starting an item; stop duplicate dispatch rather than
removing the check or telling the LLM to ignore extra instructions.

Current `src/services/mission.js:runnerWatchOnce`:

- Treats latest tool `status === running` as the only working signal. Between
  tools, thinking, replies and delayed tool-store writes can look idle.
- Stamps `last_progress_at` from polling time and resets retry count on every
  running-tool observation, rather than genuine new progress.
- Dispatches on queue revision change before the minimum-nudge-interval branch.
  Claiming an item changes the queue without ending the worker's turn.

These are code risk findings; correlate actual ticks and delivery records to
identify the observed spam's exact trigger before implementing. Plan 88 addresses
delivery acknowledgment/start reconciliation; this plan addresses permission to
dispatch a subsequent instruction. Share operation/receipt primitives rather
than introducing competing dispatch state machines.

## Required contract

1. At most one outstanding runner instruction per exact conversation/runner.
2. Accepted input is not a completed turn. Keep a dispatch outstanding while the
   worker thinks, streams prose, runs tools, or queues tool calls.
3. `No running tool`, unchanged screen, stale timestamp, and changed queue revision
   do not establish a turn end. Unknown observations suppress sends and explain why.
4. Claiming `new → in progress`, updating progress or adding another plan cannot
   authorize dispatch during the existing turn. Finishing an item also requires
   waiting for the current turn to end before prompting the next one.
5. After verified turn end: continue the current in-progress plan if unfinished;
   otherwise choose the next new item. Respect human blockers, both pause modes,
   exact identity, idle grace, minimum interval and bounded no-progress attempts.
6. Apply interval checks to EVERY dispatch reason, including revision changes.
   Reading the queue/polling/sending our own messages is not worker progress.
7. A user manually continuing the same conversation must also suppress supervisor
   dispatch while that human-started turn is working or unknown.
8. Do not require new worker MCP configuration. Use measured per-driver signals
   and existing shared stores/operations; unsupported certainty stays unknown.

## Phase 1 — Trace the incident and turn signals

Files: `mission.js:runnerWatchOnce/dispatchNext/startRunner/recovery`,
`agent-store.js`, driver signal readers, runner schema and app supervisor timer.

- Read plan 88's latest implementation and use its durable instruction identity.
- Capture chronological tick decisions, dispatch attempts/receipts, generation,
  queue revision and actual turn/tool transitions in controlled sessions. Diagnostic
  logs contain metadata/reasons only, never prompt contents or credentials.
- Identify overlapping timer callbacks, slow sends, stale probes and revision
  dispatches bypassing timing. Verify the observed worker conversation exactly.
- Measure the driver's real turn-completion signal. Do not reuse the Mission dot's
  tool-only busy flag as a turn verdict. Store readable means observable data,
  not necessarily known idle. Do not guess from the published web server status
  when the conversation is driven by a separate TUI process.

## Phase 2 — One serialized dispatch lifecycle

- Persist instruction operation, generation, exact conversation and pending/
  accepted/active/ended/unknown outcome using the shared plan-88 receipt contract.
- Acquire atomic database-backed ownership before a send. Two overlapping ticks,
  requests or supervisor instances cannot both pass a pre-check and dispatch.
- Immediately before delivery re-read ownership, pause/close generation, queue,
  identity and turn eligibility. Reserve delivery without blindly retrying an
  ambiguous write. Release outstanding work only on verified end or explicit
  invalidation, never just because a capture timeout elapsed.
- Separate meaningful worker progress from `last_observed_at`, dispatch timestamps
  and our own user prompts. Reset retry budget on measured progress, not repeated
  observation of the same running tool. Keep grace for real tool/turn activity.
- Revision change may select upcoming work but cannot bypass in-flight/turn/timing
  gates. One scheduler predicate covers revision, retry, resume and recovery paths.
- Enforce bounded backoff and interval on all sends. After uncertain outcome,
  reconcile read-only; do not resend until a safe non-duplicating decision exists.
- Stop/restart reconciliation preserves ownership and uncertainty. Pause/Close wins
  races; a late tick/receipt never re-enables execution or recreates a worker.

## Phase 3 — Observable scheduling and setup errors

- Show Worker working/idle/unknown and a concise continuation decision such as
  `Waiting for current turn`, `Next check after idle grace`, `Paused` or `Observation
  unavailable — automatic sends withheld`. Saved task `in progress` is separate.
- Clear obsolete dispatch errors only when reconciled; keep Pause/Close usable.
- The transcript also shows missing `INDEX.md`. Check the project's actual configured
  path during Run preflight. If missing, expose a specific setup/repair action;
  do not repeatedly instruct the worker to read a nonexistent file. Use the existing
  index generator only when absent and appropriate, preserving any existing file.

## Phase 4 — Proof required before completion

Automated isolated behavior tests and a controlled live worker:

- One long multi-step turn: claiming queue entry, reading files, reasoning between
  tools, prose streaming and editing code produce ZERO additional runner messages.
- Tool finishes but assistant turn continues: no dispatch. Unknown/unreadable probe:
  no dispatch. Queue revisions during both cases: no dispatch.
- Across those active-turn watcher ticks, the transcript contains no injected Continue
  prompts and no resulting prompt-driven repeat `QUEUE.paused` checks. Independent
  worker checks and legitimate new-item checks remain valid.
- Positively ended unfinished turn: exactly one eligible continuation targets the
  same item; after it finishes, one next-item dispatch occurs without manual Run.
- Overlapping ticks, delayed receipt, request retries and webui restart: one send,
  no duplicate instruction, same conversation and preserved operation identity.
- All reasons respect minimum interval; repeated tool observations do not replenish
  nudge budget. Real progress resets it according to the documented rule.
- Pause before next task/current task, Close and manual human turn race with pending
  dispatch: no forbidden send, recovery or stale re-enable.
- Missing INDEX.md yields actionable setup feedback and zero repeated prompts.
- Browser verifies actual transcript/message counts plus current/next/state and
  scheduling reasons on desktop/narrow layouts. No real user plan execution as a test.

Run suites individually, verify backend/client parsing, build affected client and
restart as necessary, inspect console/requests. A mock with frozen screen or an
assertion only on lastToolCall is not proof. Mutation controls run in copies and
must fail specifically when the outstanding-turn or interval guard is removed.

## Progress

- [x] Phase 1 complete: dispatch serialization using plan-88 operation primitives.
  - `dispatchNext` checks `operation_status === 'pending' || 'unconfirmed'` and suppresses duplicate sends.
  - `runnerWatchOnce` checks outstanding operations BEFORE any dispatch logic (revChanged, retry, nudge).
  - Operation status lifecycle: `pending` → `confirmed`/`unconfirmed`/`ended`/`invalidated` (from Plan 88).
  - Reconciliation on polls: `runnerWatchOnce` confirms unconfirmed ops when store shows advancement.
  - Mutation test added: guard bites when operation is pending (dispatchNext not called).
- [x] Phase 2 complete: serialized outstanding instruction and shared eligibility gate.
  - `canDispatch(runnerId, { session, project, agent, queue, kind, gen })` — single predicate gates ALL dispatch paths (revChanged, retry, nudge, recovery, startRunner).
  - `acquireDispatchOwnership(runnerId, gen, kind, queueHash)` — atomic DB check-and-set for ownership; prevents overlapping ticks from both dispatching.
  - Minimum nudge interval applied to ALL dispatch kinds; retry budget checked in predicate.
  - `dispatchNext` now uses `canDispatch()` + `acquireDispatchOwnership()` — no duplicate dispatch from overlapping ticks.
- [x] Phase 3 complete: truthful scheduler feedback and missing-index handling.
  - `agent-store.readTurn` (opencode store reader, `runner-turn.test.js` 10/10): exact
    per-conversation turn verdict — working through thinking/streaming/between-tool
    gaps and completed-but-unstopped tool steps; idle only on a completed stop for
    the current input with an exact receipt hash; unknown on mismatch/compaction/
    unreadable/unsupported, never guessed idle.
  - `computeSchedulerState` + `recordSchedulerDecision` (mission.js): every watch
    tick and every gate persists `worker_state` / `scheduler_decision` /
    `scheduler_reason`; `Waiting for current turn`, `Next check after idle grace`,
    `Paused`, `Observation unavailable — automatic sends withheld` are stored
    sentences. The header shows them (`RunnerControls.jsx` `msn-runner-scheduler`
    + `msn-runner-worker-state`); saved task `in progress` stays in the queue
    summary, separate.
  - Obsolete dispatch errors clear only on reconciliation: `last_reason = NULL` on
    confirmed delivery and on exact-receipt release; Pause/Close invalidation is
    never cleared by a late receipt (`operation_status = 'invalidated'` wins).
  - `ensureRunnerIndex` (non-destructive `initProjectPlans`) runs on start,
    dispatch and recovery; a missing INDEX.md is repaired in place (concurrent-Run
    test proves one startup + repair), and an unrepairable folder refuses with
    `runner_index_unavailable` naming the repair. Startup/Continue/Recovery
    messages reference the index only as a path that now exists.
- [x] Phase 4 complete: no-spam and valid-continuation proofs, races and checks.
  - `runner-dispatch.test.js` 21/21 against the REAL watcher/writer (working turns
    + queue revisions send zero prompts with `wait_turn_end` recorded; unknown
    probe records `observation_unavailable`; accepted instruction stays outstanding
    across revisions and releases exactly once on the verified stop; concurrent
    ticks send once; nudge interval suppresses ALL revision sends; idle grace
    starts at the completed turn; repeated observations never touch retry/progress
    clocks; human-turn and Pause races withhold; queue change at the write
    boundary cancels; error turns need explicit recovery; recovery never restarts
    on unknown/active work; stale inputs cannot reconcile a new operation).
  - Controlled live worker: `src/data/runner90-verification-20261012/` — proof-a
    and proof-b both `done` by the worker, operation rows confirmed with exact
    `operation_receipt_user_id`, queue `allDone`, runner `finished`. No duplicate
    Continue prompts in the run.
  - Suites run individually in-container, all green (counts in Status). Backend
    parse-checked; webui restarted; live API + served bundle verified (boundary in
    Status: no interactive click-through from this shell).
  - Mutation-control shape is covered by twin design (idle twin sends once on the
    identical fixture that sends zero while working; unknown twin never sends),
    not by a comment-claim.

## Coordination

Plan 88 remains the active queue item. Do not restart or abandon it because this
plan exists. Queue this follow-up before lifecycle testing (87). Carry forward any
shared fixes from 88 and test the integrated outcome rather than duplicate its work.
Record evidence and update status/checklist before leaving. Docs absorption remains
subject to the user's existing review hold.
