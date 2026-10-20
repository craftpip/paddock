# 85 — Infinite sessions: one session list, one terminal

## Status: Complete — 2026-10-20

## What the user wants

> **User review (2026-10-11):** Session opening alone has not delivered a usable
> runner. The current interface has no queue setup/task-progress flow; the
> inspected `test / infi` cannot Run because QUEUE.md is missing. Follow
> [plan 86](86-infinite-queue-usable-workflow.md) for visible setup, current/next
> tasks, progress, Run/Pause and proof of actual automatic continuation. Do not
> treat this plan's implemented controls as completion of the runner feature.

An infinite runner **is a session**. It belongs in the existing Sessions listing,
using the same session row, sorted before ordinary sessions. Clicking it opens
that session's normal terminal in column 3. It does not open configuration.

Run/Pause belongs in that session's terminal panel and controls queue execution.
Opening a conversation and running its queue are separate actions.

```text
Sessions (count includes infinite sessions)
  My infinite session       ∞       same session row
  Another infinite session  ∞       same session row
  Ordinary conversation             same session row

Click any row → its normal column-3 terminal

Infinite session terminal header:  [Run / Pause] [Configure]
Terminal: the existing agent TUI
```

There is no separate runner section above the Sessions heading, no divider, and
no second rendering of the worker. Configuration is an explicit secondary action.

## Supersedes these parts of plan 83

- The configuration-only entry with no session until first Run. New infinite
  sessions need a real session independently of whether their queue is running.
- Pause killing the tmux session. Pause controls the queue; it must not tear down
  the conversation the user is watching.
- The prohibition on reopening a paused session by clicking it. Clicking may
  reopen that exact conversation through normal Mission recovery; it does not
  enable the queue or send a startup/nudge prompt.
- The popup as the viewing surface for paused/dead/unstarted runners.

Keep plan 83's queue format, project plans-folder resolution, exact conversation
identity, explicit queue execution, and stop-on-human-input requirements. Its
completion claims need re-auditing against actual implementation and tests.

## Evidence from the running page

On 2026-10-11, opened Mission and selected `test`:

- `infi`, marked Paused, rendered above `SESSIONS(21)` in `.msn-runners-pinned`.
- Clicking `.msn-runner-row` opened `Runner: infi` with settings and Start/Resume.
- Column 3 stayed on the previously open `schlorp` conversation.
- Six project rows were present before inspection. No runner execution or
  session lifecycle action was invoked during reproduction.

## Code audit — the causes and affected paths

### Listing and selection

| Location | Current behavior | Required correction |
|---|---|---|
| `src/client/src/components/SessionList.jsx`, merge around lines 461–518 | Filters bound sessions out of the normal list | Decorate the real session with runner metadata; merge/deduplicate once, then sort runner-first |
| Same file, lines 588–624 | Separate pinned container before the Sessions heading | Remove the separate section and divider; render all rows below the single heading |
| Same file, `RunnerRow` | Independently implemented row, actions, age and control-state display | Use the shared session row; small infinity indication in the existing metadata line |
| Same file, row click at line 611 | `openRunner` failure becomes `setRunnerDialog` | Route row activation through the session opening flow; configuration never handles an open failure |
| `src/client/src/stores/mission.js`, `openRunner` | Refuses sessions absent from the current list or not `live === true` | Resolve the real session and open it regardless of queue state; preserve normal recovery and error handling |
| Same store, `fetchRunners` | One global array, no all-projects fetch, no response scope guard | Scope runner reads with the session listing and reject stale responses |
| Same store, `refreshActive` / `fetchAll` / `fetchSessions` | Ordinary refresh/poll paths do not refresh runners | Refresh session and runner metadata together without resetting the terminal |
| Same store, runner mutations | Refresh only runners, leaving worker session state stale | Refresh the active listing and selected session after mutation; preserve terminal identity |
| `src/client/src/pages/Mission.jsx` | Column 3 only has ordinary session controls; no queue controls | Add queue Run/Pause and Configure to the open session's terminal header |
| `RunnerDialog.jsx` | Captures runner object at open, uses globally selected project for creation, retains stale action state | Resolve current record by ID; submit explicit project identity; keep settings separate from session navigation |

Additional UI issues: row-level runner action errors are stored but never rendered;
all runners dim together using fetch loading as action busy; the popup offers both
Start and Resume for a paused record; its queue filename field is editable even
though `updateRunner` does not save it. Cover these while correcting the same paths.

### Session/queue lifecycle

`src/services/mission.js` currently couples unrelated operations:

- `createRunner` inserts a configuration with nullable `session_id`.
- `startRunner` creates/restarts the session and sends queue instructions together.
  It tests `.live` on a raw stored session rather than an enriched pane observation.
- `pauseRunner` calls `endSession` before disabling the runner.
- `removeRunner` calls Pause for an enabled runner, killing its terminal too.
- Recovery creates a replacement Mission row instead of recovering the existing
  row, which undermines stable selection and can duplicate a conversation.
- Session Close is not coordinated with the runner binding; the FK sets the
  session reference to null, leaving a configuration that can create another worker.

### Queue engine gaps found while tracing the whole feature

These are source findings, not claims that live queue execution was tested:

1. `setRunnerControlState` changes `control_state` but never `enabled`; creation
   sets `enabled = 0`, while watcher/reconciliation select `enabled = 1`.
2. `runnerWatchTick` and `reconcileRunners` are defined/exported but no callers
   were found in `src/`. The implemented watcher is not wired to app startup.
3. Start increments a generation but does not serialize concurrent starts or
   deduplicate startup sends. There is no persisted queue lease in the schema.
4. Startup, nudge and recovery prompts are multiline, while Mission submits text
   line by line. They need one logical submission.
5. The watcher treats an unreadable store/no running tool as a candidate for idle,
   uses polling time as progress for running tools, and does not enforce the
   configured minimum nudge interval. `suspected_stuck` is passed as a control
   state even though the control-state validator rejects it.
6. Invalid queue sets `finished`; a finished runner cannot Run again. All-done
   nonempty and need-input queues are not gated before initial worker startup.
7. `queue_file` is stored, but supervision reads the project queue without passing
   that value. Prompts use the host-resolved queue path and string replacement
   for INDEX; worker-facing paths must be resolved in the container namespace.
8. Runner-ID REST routes lack the project/agent access check used on project-scoped
   runner creation/listing. Apply the existing Mission authorization pattern.
9. `mcp.js` contains runner permission names, but no runner tool registrations
   were found. Plan 83's claim that the MCP surface is implemented is unsupported.
10. `infinite-runner.test.js` covers configuration and missing/empty queue handling,
    not the rendered rows, terminal selection, active Pause/Remove, scheduling or
    successful queue execution. One test currently pins invalid → finished.

## Implementation

### Phase 1 — Separate conversation ownership from queue execution

- Introduce/reuse an idempotent worker-session ensure operation. It binds or
  resolves exactly one Mission session without enabling queue execution or sending
  queue instructions. Observe the pane through existing Mission primitives.
- Creating a new infinite session creates/binds its real session; converting an
  existing session keeps its row, conversation ID, lock and terminal identity.
- For legacy unbound records, resolve/create a session only on an explicit user
  open/create action, never during list reads or polling. Serialize concurrent
  opens and retain the new binding if a later step fails.
- A stopped PAD or unavailable original conversation yields the ordinary terminal
  error/retry state. Never silently substitute a different conversation.
- Opening uses ordinary selection/reopen behavior. It never calls queue Start.
- Pause disables queue dispatch/recovery and invalidates pending sends first. It
  leaves the terminal and conversation intact. An already-running turn may finish;
  Pause must not claim to have killed that turn or its background commands.
- Remove as runner removes supervision and pinning while keeping the session open.
- Explicit session Close disables supervision before its existing close behavior;
  a watcher may not resurrect the closed session. Coordinate project deletion too.

### Phase 2 — One normalized listing

- Enrich the real session row with optional runner metadata keyed by session ID.
  Keep runner configuration persistence separate; do not manufacture a second
  conversation identity from a runner ID.
- Preserve Mission/history deduplication, scoped by agent/project where necessary.
  Prefer the bound Mission row for its conversation, even if history is newer.
- Sort infinite sessions first, then apply existing activity ordering within each
  group with stable tie-breaking. Include paused/waiting/finished sessions.
- Use one shared session-row renderer: same title geometry, metadata line,
  selected state, focus behavior, lock, and ordinary session interaction.
- Show the custom infinite-session name and compact infinity indicator without
  making it a separate card/status panel. Put detailed queue state in column 3.
- Count the merged rows once. Runner-only projects must not also show “No
  conversations”. Maintain normal first-load and background-refresh behavior.
- Support both project and all-projects views; all-project rows retain their own
  project identity. A stale project response cannot relabel another project's row.

### Phase 3 — Normal terminal, queue controls alongside it

- Remove popup fallback from row click/Enter/Space. Only Configure opens settings.
- Resolve column-3 runner metadata from `openSession`'s own session/project, never
  from whichever project happens to be selected in column 1.
- Add Run/Pause, queue state and a concise reason to the terminal header. Keep the
  existing Terminal mounted while the queue changes state.
- Run explicitly enables queue work; Pause explicitly disables it. Reopening a
  paused conversation leaves its queue paused. Completed queues can be Run again
  after new work is added without creating another runner/session.
- Show per-runner action progress/errors in column 3. A background metadata fetch
  must not disable every row. Clicking queue/settings controls must not trigger
  row opening or another action through event bubbling, including keyboard use.
- Refresh the bound session after Run creates/recovers it; do not wait for the
  next global poll. Polls, scope switches and sorting cannot change `openSession`.
- Refresh dialog settings/state by ID and use explicit project IDs in submissions.
  Use the existing accessible modal primitive for Configure.

### Phase 4 — Make Run/Pause truthful end to end

- Establish one authoritative execution-state transition; keep any compatibility
  `enabled` field synchronized atomically rather than independently writable.
- Serialize Run/Pause/Remove/recovery and add database-backed worker/queue ownership
  where concurrent requests can race. Recheck generation immediately before sends
  or recovery; an invalidated pending action must stop.
- Gate valid empty/all-done/need-input/invalid queues before dispatch. Preserve an
  actionable error state; fixing a file must allow Run on the same session.
- Resolve supported queue filenames consistently for reading, updating and prompts;
  reject unsupported settings rather than displaying a field that does nothing.
- Use container-visible queue/INDEX paths and single-submission instructions.
- Require exact conversation identity and positively observed idle turns. Unknown
  observations suppress automatic sends. Implement only measured driver signals;
  unsupported compaction/provider signals stay explicit unknowns.
- Track genuine activity separately from polling and our own prompts. Enforce
  idle grace, minimum intervals, recovery grace and bounded no-progress attempts.
- Wire one non-overlapping supervisor lifecycle at app startup only after these
  gates pass tests. Reconciliation must not blindly replay uncertain startup sends.
- Apply access checks to all runner-ID endpoints. Bring actual MCP registrations
  and their descriptions into agreement with the implemented service contract.

### Phase 5 — Regression tests and real browser verification

Run suites individually with isolated databases. Add behavior tests for:

- One worker + history twin + runner produces one session row below Sessions.
- Infinite rows sort first and count correctly in project/all-project views.
- Click/Enter/Space on an active, paused, finished or dead bound session selects
  the same conversation in column 3, never opens Configure, never starts its queue.
- Reopening a dead paused session recovers the same conversation and remains paused.
- Legacy unbound double-open creates one session, not two; failures stay visible.
- Run and Pause affect queue state without remounting/killing the terminal. Remove
  unpins in place and preserves the conversation and live pane.
- Scope-switch races, out-of-order fetches and polling cannot swap runner metadata
  or move the selected terminal. Settings follow the open session's own project.
- Pending send vs Pause/Close/Remove, concurrent Run, exact-ID recovery, invalid and
  done queues, unknown/working turns, minimum intervals and authorization refusals.
- A successful watcher turn actually advances a controlled queue; checking only
  configuration CRUD is not verification of a runner.

In the browser, compare ordinary/infinite row geometry; click the actual rows;
assert the resulting terminal identity and absence of a popup. Exercise Run/Pause
on a controlled test session, verify pane survival and unchanged conversation ID,
and check queue dispatch separately from merely seeing a terminal. Test keyboard,
dark/light modes, narrow width, all-project scope and refresh. Read console and
failed requests. Count projects at the end; do not delete unexplained rows.

Parse changed JSX, run affected store/Mission/runner/queue suites individually,
build the SPA, restart the webui, and verify the newly served bundle. Test mutation
controls in copies: restore popup fallback or pause-kills-pane and demonstrate the
specific regression fails. Preserve existing uncommitted work.

### Phase 6 — Reconcile the specification and report evidence

- Update plan 83's status/checklist to reflect verified implementation rather than
  retaining its current completed-surface/supervisor claims.
- Keep a short record of exact test results and browser interactions here.
- Absorb the final agreed behavior into docs only after the existing user-review
  hold on plan 83 is released. Read docs index/style guide first.

## Progress

- [x] Reproduce the reported listing/popup behavior in the running browser.
- [x] Trace row merge, selection, store refresh, terminal, configuration, REST,
  service lifecycle, schema, supervisor wiring and existing test coverage.
- [x] Record the user's clarified session/queue interaction contract.
- [x] Phase 1: session lifecycle independent of queue execution.
- [x] Phase 2: single merged session list with infinite sessions first.
- [x] Phase 3: terminal selection and terminal-header Run/Pause/Configure.
- [x] Phase 4: verified queue execution, ownership and service/API parity —
  EXCEPT gap 9 (MCP runner tool registrations: still missing, plan 83's claim
  still unsupported) and the host/container mapping divergence below.
- [~] Phase 5: backend suites green (queue 31, infinite-runner 19, mission 125,
  plan-mcp 55, mcp 141, mission-reopen 8, db-migration 12) + live browser
  verification of every interaction below. Mutation controls red-then-green in
  a container-side copy. NOT done: client unit tests for the merged list/row
  click/header (no such suite exists; verified live instead).
- [x] Phase 6: plan 83 status/checklist corrected (MCP claim, unwired supervisor,
  pinned rows, pause-kills, invalid→finished, 10→19 tests). Evidence recorded
  here. Docs absorption still HELD for user review.

## Evidence (2026-10-11, live browser + backend)

Backend (`src/services/mission.js`, `src/app.js`):

- `createRunner` mints a real session when none is given (stopped pad fails the
  whole create, no half-row — tested). Non-`QUEUE.md` `queue_file` is refused
  (`runner_queue_file_unsupported`) instead of stored-and-ignored.
- `setRunnerEnabled` is the one writer of `enabled`; `setRunnerControlState`
  never touches it (tested). Pause = disable + generation bump, pane untouched
  (tested: session row not ended). Remove = delete only.
- `startRunner` gates refuse `invalid`/`need input`/done WITHOUT marking
  `finished` — re-Runnable on the same runner (tested, incl. second-attempt).
  Startup is sent BEFORE enabling (a boot-race refusal no longer strands an
  ENABLED runner with no startup — found live, fixed, re-verified).
- Prompts are single logical submissions with container-namespace paths
  (`<folder>/<plans_folder>/QUEUE.md`); host-resolved paths no longer go to the
  worker. `suspected_stuck` no longer thrown at the control-state validator;
  unknown store observations suppress nudges; min nudge interval enforced;
  lease re-checked before autonomous sends.
- `ensureRunnerSession` (idempotent, per-runner serialized) backs open/create/
  Run; `POST /api/mission/runners/:id/session` opens without enabling.
  `closeSession` disables a bound runner first (tested) so the watcher cannot
  resurrect a closed session. All runner-ID routes access-checked via
  `missionRunner` (resolve-then-gate). Supervisor wired at startup (reconcile
  log + non-overlapping 60s tick, no auto-resume). New `GET /api/mission/runners`
  serves the all-projects view; session detail carries the open session's own
  `runner` for the header.

Client (`SessionList.jsx`, `Mission.jsx`, `RunnerControls.jsx`, `RunnerDialog.jsx`, store):

- No `.msn-runners-pinned`, no divider, no `RunnerRow`, no dialog-on-row-click
  (asserted live: 0/0/0; dialog never opened on any row click).
- Bound sessions render as ordinary rows (identical 50px height, 12px/500 name,
  same inset) with runner name + ∞ badge, sorted first; count includes them
  (`Sessions(22)`); unbound runners render same-shape rows (`no session yet`).
- Row click opens the terminal (live, paused, unbound → session created then
  opened). Terminal header shows `∞ <State>` + reason + Run/Pause + Configure;
  per-runner busy/error; terminal never remounts on queue changes.
- Dialog is Create/Configure only: no Start/Pause/Resume, no queue-file field,
  "New session" wording, fresh-by-ID record, explicit project (all-view create
  fixed), Remove closes the dialog.
- Runner metadata refreshes with every poll/action (`refreshActive`), guarded
  by scope token; `openSession` never moves except by open/start/close.
- **Runner pop-up reachable from the row (user, 2026-10-11).** A BOUND infinite
  session row now carries its own Configure gear (`msn-btn-runner-config`) in the
  hover actions, exactly like the unbound row — previously only the terminal
  header offered it, so a session that was open and selected was a dead end for
  the pop-up the unbound row already had. Verified live: bound `infi` row shows
  the gear (unbound already did), clicking it opens `Runner: infi` with all
  fields while the terminal is open; no console errors.

Live run (schlorp, probe runner `probe85`, trivial 1-item queue):

- Create → session minted, row first with ∞. Click → terminal, `∞ Paused`.
- Run (missing queue first): inline `runner_invalid_queue`, stays paused.
- Run (valid queue): `∞ Running`, startup delivered (confirmed pane change).
  Agent read the queue, set the bogus item `need input` with an exact question.
- Watcher tick: `∞ Need input` + reason, dispatch stopped. Run again: inline
  `runner_need_input` refusal, state unchanged, terminal intact.
- Remove (dialog): row unpinned in place, session + live pane kept, header
  controls gone. Session closed afterwards; schlorp QUEUE.md restored from
  backup. Projects still 6; no junk rows; no console errors except the expected
  refusal 4xxs. Two transient 403s observed (stale session/CSRF across a webui
  restart; endpoint 200s before and after) — noted, not reproduced.

## Open findings (not fixed here)

- **Host/container queue-path divergence (plan 82 territory).** `ensureQueue`
  on the `paddock` project wrote `/www1/www2/paddock/plans/QUEUE.md` (webui
  view) while the pad sees `/www2/paddock` (host worktree) — different files.
  Out-of-mount folders join the absolute folder onto the mount host instead of
  refusing `plan_workspace_read_only`. Supervisor reads and worker reads then
  disagree. Cleaned up the two stray files; live test ran on schlorp where the
  mapping agrees. Needs a plan-82 fix, not a plan-85 one.
- **MCP runner tools (gap 9).** Still no registrations; plan 83's claim
  corrected to open.
- **Client unit tests (Phase 5).** Merge/sort/row-click/header behavior is
  verified live only.
