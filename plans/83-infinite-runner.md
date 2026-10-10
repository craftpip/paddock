# 83 — Infinite runner sessions

## Status: In progress (2026-10-11) — Phase 1 complete (signals recorded, paths aligned with plan 82); Phase 2 complete (queue contract, MCP tools + grants); Phase 3 complete (runner persistence); Phase 4 complete (supervisor loop); Phase 5 complete (MCP tools + grants + UI); Phase 6 starting next (browser/session flow verification); 5/7 implementation phases complete

## Goal

Create an **Infinite runner** from the Mission sessions listing. It owns a marked,
pinned worker session and works through a markdown queue of plans. Start creates
the worker session if needed, otherwise reuses it, and sends instructions to read
the queue and begin. A backend monitor watches progress and nudges the worker when
it has stopped between turns with work remaining.

The runner can be started and paused; manual Pause stops its tmux session too.
A blocker requiring human intervention
stops queue execution immediately, keeps the tmux session open, and shows what is
needed. Queue completion is detected in code from the queue file, without asking
another LLM whether the work is done.

This plan specifies the feature; implementation has not started.

## Related work

- **82 — Per-project plans folder:** supplies the project's configured plans
  directory and `INDEX.md`. That file teaches plan management. This plan's `QUEUE.md`
  teaches queue management. Resolve both through the project, not the PAD's default
  workspace or a hardcoded `plans/`.
- **74 — Task lifecycle and done detection:** reuse measured turn boundaries and
  activity signals where applicable. A finished turn is not a finished queue.
- **75 — Provider exhaustion:** reuse evidence-backed detection. An empty reply,
  silence, or a transient 429 does not prove subscription exhaustion.
- **78 / 80 — Session identity:** supervision must follow the worker's actual
  conversation across resume/relaunch. Never attach to a guessed conversation.
- The existing `infinite.md` convention is separate. Do not silently convert it or
  inherit its old skip-blockers rule: **this runner stops on intervention**.

## Current code — checked before implementation

These are findings from the current worktree, not capabilities inferred from the
related plans. Recheck them when implementation starts because those plans are
still in flight.

| Existing code | What exists / what this plan must add |
|---|---|
| `src/services/db.js`, `mission_projects` / `mission_sessions` | Project, tmux, conversation ID, lock, death stamps and start-idempotency fields exist. There is no runner record or plans-folder field in the current schema. Add runner persistence; plan 82's path configuration is a dependency, not shipped functionality. |
| `src/services/mission.js`, `startSession` | Checks PAD/folder, supports idempotency keys, and tries to create an OpenCode conversation before launching. Conversation creation is best effort and can return no ID. Runner startup must require an exact observable conversation before it sends work. |
| `mission.js`, `relaunchTui` / `restartSession` | Existing recovery primitives preserve the ID when available, but fall back to a **fresh** conversation if absent. Add a runner-specific exact-identity precondition; do not blindly invoke the fallback. |
| `mission.js`, `sendVerdict` / `sendText` | Gates dead panes, shell panes, solo locks and permission prompts. It does **not** gate busy/unknown turns. Add a serialized runner dispatch preflight around this writer; calling `sendText` alone is not sufficient. |
| `mission.js`, `busyForSessions` | Five-second cache; `busy` is only `lastToolCall.status === 'running'`, and `known` only means the store was readable. Neither a false busy flag nor a true known flag proves a completed/idle turn. |
| `src/services/agent-store.js`, `readOpencode` / `readActivity` | Returns latest text/tool, message count and an activity timestamp derived from message/tool timestamps. No explicit turn boundary, compaction state, tool heartbeat, or provider-exhaustion verdict is exposed. Extend the reader with measured signals rather than treating this summary as a progress clock. |
| `src/services/task-pipeline.js` | Already drives Mission sends and polls explicit `task_steps` reports with timeouts. Its loop is an in-memory Map intentionally lost on webui restart. Reuse service patterns, not its report-driven state machine or timeout-as-failure rule for silent builds. |
| `src/services/plans.js`, `plansRoot` / `plansDir` | **Plan 82 SHIPPED (2026-10-10):** `plansDir(agent, {project})` now resolves a project's own `<folder>/<plans_folder>`. `projectPlansRoot` maps the folder through `containerViewOf` (pad-root `/www2/paddock` → `/workspace` rw), then `webuiMountViewOf` (the webui's OWN `/proc/self/mountinfo`, longest mountpoint prefix), then the driver data-dir default — refusing with `plan_workspace_read_only` (a ro mount) or `plan_workspace_not_host_visible` (unmounted). Pad-root `plansRoot` keeps the legacy `hostBrowsable` gate; project scope dropped it (the resolver IS the gate). The runner's QUEUE.md path is `plansDir({project}) + 'QUEUE.md'`. `RESERVED_PLAN_NAMES` already excludes `queue.md` from plan listings and generated `INDEX.md` already links `QUEUE.md`. |
| `src/services/workspace.js`, `readFile` / `writeFile` | Supports host and container scope. Host writes use direct `fs.writeFileSync` — no atomic replace, no compare-and-swap. **Plan 82 precedent:** project-scope writes in `plans.js` now ALSO go direct fs (resolver-is-the-gate), bypassing this service. Queue revision-safe writes need shared CAS support; the ownership gates are now exercised through the resolver path. |
| `src/services/pad-tmux.js`, `sendText` / `sendKeys` | Text is submitted **one line at a time**, each with Enter. Send startup/nudge instructions as one logical line referencing QUEUE/INDEX, not a multiline prompt accidentally submitted as several turns. Raw keys exist, but a verified per-driver stop/interrupt contract still needs defining. |
| `src/client/src/components/SessionList.jsx` | Merges Mission/history rows, deduplicates by conversation ID, then sorts by activity. Put the creation control beside `.msn-group-sessions` / `.msn-group-count`; add runner-first ordering and preserve the merge's no-duplicate behaviour. |
| `src/client/src/stores/mission.js` | Owns scope refresh and the open-session snapshot. Add runner refresh/actions here while keeping terminal selection independent from list sorting and polling. |

### Consequences for the design

- Implement a dedicated queue parser/service and durable runner supervisor; the
  existing task pipeline is not an infinite runner hidden behind another name.
- Add an observation contract with explicit `working / idle / unknown`, exact
  conversation match, current tool timing, compaction, and failure evidence.
  Unknown/unsupported signals disable automatic nudges, not the user's terminal.
- `readActivity` can report `matched: 'only-file'` for JSONL stores. That guessed
  match is unsuitable for runner control; require an exact conversation match.
- `sendText` confirms a changed screen, not a durable receipt of this particular
  message. An ambiguous delivery must not trigger a blind retry. Test this with
  the actual TUI, including a repaint unrelated to the sent prompt.
- **Plan 82 supersedes this:** `projectPlansRoot` now resolves the project's plans folder through the webui's own mountinfo (rw → host path, ro → `plan_workspace_read_only`, unmounted → `plan_workspace_not_host_visible`). The runner reads QUEUE.md via `plansDir({project}) + 'QUEUE.md'` — the same resolver, same three outcomes. A container-scope fallback is a separate path if the webui mount fails; the project resolver is the primary gate, not an implicit fallback.
- Revision checks serialize cooperative writers. They cannot guarantee against
  arbitrary direct editor writes between check and rename. Document that boundary
  and route worker updates through the revision-aware operation where available.

## Creation and session listing

Add an **Infinite runner** button beside the Sessions heading/count. It opens a
create/configure popup, using the existing dialog and form primitives.

The popup contains:

| Setting | Proposed default / behaviour |
|---|---|
| Name | Required custom display name |
| Project | Current project; require an explicit choice in the all-projects view |
| Queue file | `QUEUE.md` within the project's configured plans folder; show the resolved path |
| Worker session | Create on first Start, or select an existing eligible session in this project |
| Idle grace before nudge | 2 minutes after a confirmed idle turn with pending work |
| Minimum nudge interval | 2 minutes; repeated attempts back off |
| No-progress nudge budget | 3, reset only by real worker progress |
| Compaction/recovery grace | 5 minutes after a detected compaction or relaunch |
| Long-command review threshold | 30 minutes without observable progress; flags for review, does not kill the command |
| Recover exited worker | Enabled: resume the same conversation after a confirmed TUI/pane exit |
| Recovery attempt budget | 3 with backoff; then wait for input |
| Start immediately | Off; explicit Create and Create & Start actions |

These timings are proposed initial defaults, to be checked against real builds and
compactions. Advanced settings can be collapsed. Show units and explain what each
timer measures; no single global silence timeout.

Opening an existing runner's popup exposes **Edit**, **Pause / Resume**, and
**Remove as runner**. Edit loads the saved name/settings and saves changes back
to the same runner. Timing changes apply on the next monitor tick; changing the
project or worker binding requires pausing first and revalidating ownership.
Saving edits does not start or resume a runner.

Pause disables the runner and ends its tmux session while retaining the session
record and conversation for Resume. Remove as runner disables supervision,
releases ownership, removes the runner designation and pin, and returns an existing
session to the ordinary listing. Removal preserves the conversation and QUEUE.md;
it does not itself terminate a live session. For a runner never started, removal
simply removes its configuration entry.

Runner sessions appear **pinned at the top** of the session listing, including
paused, waiting, and completed runners. Show their custom name, Infinite runner
badge, queue status, health/status reason, and Start/Pause/Configure actions.
Before first Start, show a pinned runner entry even though no worker session exists
yet. Selecting an existing session marks/pins that row rather than duplicating it.

Show the current plan and short blocker/error reason on the row; details can show
last observed progress, current tool and duration, last nudge, retry count, and the
queue path. Keep stable `msn-*` hooks for the new controls. Pinning must not change
which session is open in the terminal.

## Two kinds of status

**Queue status** uses exactly `new`, `in progress`, `need input`, `done`.

**Runner control state** records whether supervision is enabled, manually paused,
waiting for intervention, or finished. **Health** explains operational conditions:
working, waiting for tool, compacting, recovering, suspected stuck, usage exhausted,
authentication/session expired, temporarily rate limited, observation unavailable,
or invalid queue.

These fields answer different questions. A manually stopped runner can have an
`in progress` queue. An exhausted provider does not make its current plan `done`.
The UI reads the server's verdict and reason rather than deriving its own status.

## Queue file contract

Location: `<project.folder>/<plans_folder>/QUEUE.md`. The filename is `QUEUE.md`.

The file contains human-readable agent instructions followed by exactly one
machine-readable fenced JSON block inside fixed markers. JSON inside Markdown
keeps spaces, paths, and blocker messages unambiguous; a free-form Markdown table
would need escaping rules and would be easier to break.

Proposed generated `QUEUE.md` content:

````md
# Plan queue

Read this file and `INDEX.md` before starting or resuming work. `INDEX.md` explains
how to maintain plans; this file explains how to run this queue.

## Worker rules

1. Read the whole queue before acting. Work one item at a time, in array order.
2. If ANY item is `need input`, stop immediately. Explain its `reason` to the
   human, keep this session open, and wait. Never skip it to do later items.
3. Resume the `in progress` item first. Otherwise take the first `new` item and
   write `in progress` BEFORE doing work. At most one item may be in progress.
4. Read the referenced plan and follow INDEX.md's plan lifecycle. Keep the plan's
   progress current. Mark a queue item `done` only when its required work and
   verification are complete under those rules. Finishing a chat turn is not done.
5. When blocked or needing clarification, update the plan and set this item to
   `need input`. Put the exact question or required intervention in `reason`.
   Then stop. Do not guess, skip the item, or clear your own blocker.
6. After finishing an item, re-read this file and continue with the next item.
   When every item is done, report completion and wait. Do not invent work.
7. After the human resolves a blocker, they explicitly resume/requeue the item.
   Re-read the updated queue on Start; do not assume an old answer still applies.

## Editing rules — keep the parser working

- Preserve the two markers and exactly one JSON block between them.
- Keep `version` equal to 1 and use the exact lowercase status strings:
  `new`, `in progress`, `need input`, `done`.
- Each item has a unique, stable `id`, a `plan` path relative to this directory,
  a `status`, and a string `reason`. No absolute paths or paths escaping this directory.
- `reason` is required and nonempty for `need input`; use an empty string otherwise.
- Add new items at the end with status `new`. Never change existing item IDs.
- Keep completed entries as `done`; do not delete them to signal completion.
- Do not add comments or trailing commas inside JSON, extra JSON fields, duplicate
  keys, or a hand-written overall queue status. Overall status is computed in code.
- Re-read before writing so newly added tasks are preserved. Use the queue update
  operation with its revision check when available. Never overwrite a newer revision.
- Write the complete valid file atomically; never leave half-written JSON behind.
- Put explanations outside the marked block, or in the item's `reason` when blocked.

<!-- paddock-queue:start -->
```json
{
  "version": 1,
  "items": [
    { "id": "q-001", "plan": "example-plan.md", "status": "new", "reason": "" }
  ]
}
```
<!-- paddock-queue:end -->
````

The example demonstrates the format; a newly created real queue starts with an
empty `items` array, not a task pointing to a nonexistent example plan. The
generated instructions link to `INDEX.md` in the same configured plans directory.

### Parser and aggregate status

- Validate the markers, version, exact schema, unique IDs, allowed statuses,
  reason requirements, path containment (including symlinks), and single active item.
- Valid empty queue, or all items `done` → **done**.
- Any `need input` → **need input**, regardless of position in the list.
- Otherwise any `in progress`, or completed items plus remaining new work →
  **in progress**. An untouched nonempty queue → **new**.
- Missing, unreadable, malformed, or unsupported queue → **invalid/unavailable**,
  never done. A missing unfinished plan is an error, never inferred completion.
- A completed plan may have been archived/absorbed according to INDEX.md; its
  retained `done` queue entry remains valid even if the original plan path is gone.
- Invalid writes pause dispatch; re-read to distinguish a transient write from a
  persistent error, but never act on the previous queue snapshot meanwhile.
- Code determines completion of the recorded queue. It cannot prove that an LLM's
  `done` claim accurately describes the code; plan verification remains required.

Use a content hash/revision for compare-and-swap queue updates. Expose a shared
validated read/update operation to UI/API/MCP so an agent need not rewrite the
entire file by hand. Preserve user prose. A direct file edit is still supported,
but only a fully valid fresh snapshot authorizes dispatch.

Create the queue and its instructions only when absent. Never overwrite an
existing file automatically. Existing incompatible content produces an actionable
validation error. Exclude configured queue files from ordinary plan listings.

## Start, pause, remove, wait, and finish

**Start:** validate settings and queue, acquire the queue's single-runner lease,
then resolve the marked worker session. Reuse a live agent TUI; relaunch a bare
shell or restart a missing pane using the existing Mission recovery paths. Create
a session only when this runner has none. Repeated Start requests are idempotent.

Send one startup message containing the actual queue path and INDEX path, requiring
the worker to read both and follow the queue rules. Do not send into a permission
dialog, solo-locked session, busy turn, or unknown state. If an eligible existing
session is busy, wait before sending; do not interrupt it. An existing empty/done
queue can finish in code without creating or waking a worker.

**Pause (manual stop):** disable nudges and recovery immediately and cancel pending
sends using a run-generation check, then end this worker's tmux session. Preserve
the Mission row, exact conversation ID, queue status and runner configuration.
Use the stamp-and-keep `mission.endSession` path, not `closeSession`, which deletes
the row. Already-gone panes are an idempotent pause outcome; verify the pane is
gone before reporting pause complete, and show a teardown error if it is not.
Do not claim that killing tmux also terminated detached background builds.

Keep the paused worker pinned. Resume explicitly recreates its pane and resumes
the same conversation before reading QUEUE.md again. Neither polling, terminal
reconnection nor clicking the pinned row may auto-restart a paused worker; the
existing row-click auto-reopen path and terminal attach path need runner-aware
guards. Viewing a paused runner shows its status and Resume control.

**Remove as runner:** invalidate the run generation before removing the binding,
cancel pending nudges/recoveries, release the queue lease, then remove the runner
configuration/designation. Keep any existing Mission session/conversation and
queue file. The row loses runner controls and pinning and follows normal session
ordering. If it was paused, removal must not restart it. This action and Pause
must also work while the worker is waiting for input or already gone.

**Need input:** disable automatic continuation and retain the open tmux session.
Show the exact question/reason. A permission prompt also waits for the human;
the runner never grants permissions on its own. Resolving input does not secretly
restart execution: Resume is explicit.

**Done:** stop nudges/recovery, release the lease, retain the pinned session and
show completion. Newly appended tasks update the queue badge but do not silently
restart a finished/stopped runner; Start is the opt-in.

## Watch loop and recovery

The monitor runs in the backend, independent of whether the Mission page is open.
It uses the conversation's own store, Mission pane state, queue revision, and
driver-specific turn/tool/compaction signals. Poll enabled runners only; start
around 5 seconds, share/cache probes, and respect the different costs of SQLite
and JSONL readers. Do not create a second LLM just to classify progress.

Decision order on every tick:

1. Confirm this run generation still owns the lease and has not been stopped.
2. Read and validate the queue. Done or need input ends automatic dispatch.
3. Verify conversation identity and observe pane/turn state. Failed observation
   is unknown, not idle; pause sends and show the reason.
4. Check explicit provider/auth failures and permission/solo locks before recovery.
5. If a tool is running, output is advancing, a turn is streaming, or compaction
   is active, wait. Track tool start and progress times separately. A build can be
   silent for a long time; unchanged terminal output is not proof of a dead turn.
6. After compaction/relaunch, allow the configured grace. A turn with no current
   tool can still be thinking or replying; the newest tool alone is insufficient.
7. If a turn is positively idle with pending queue work and grace has elapsed,
   send one continuation nudge through the existing Mission send gate. Re-read
   state and queue immediately before sending. The message says to re-read QUEUE.md,
   continue the active/next item, or record need input if blocked.
8. If the TUI/pane definitely exited and recovery is enabled, capture the last
   screen/status first, then recover the same conversation with bounded backoff.
   Never replace it with a fresh conversation to hide a recovery failure.
9. Repeated nudges with no genuine progress exhaust the configured budget and
   surface suspected stuck / need input. A long-running tool past its review
   threshold is a diagnostic condition, not permission to interrupt or double-run
   its command. Do not send text into a still-running turn to try to unstick it.

Progress must come from the worker (new assistant/tool activity, tool completion,
or meaningful queue transitions), not our own prompts, polling timestamps, or
unrelated human edits. Keep last observation, last progress, and last nudge separate.

For usage exhaustion, show a confirmed label only from captured provider evidence.
Transient rate limits honor retry/backoff signals. An unanswered turn gets an
honest unknown/failed-response reason rather than “subscription expired.” Capture
the notice and conversation identity before any recovery that could erase it.
Confirmed usage/auth exhaustion pauses automatic attempts until explicit Resume
after the human fixes the issue; no repeated paid/rejected requests to test it.

## Persistence and service boundaries

- Persist runner configuration, project/session binding, enabled/control state,
  retry counters, last progress/nudge, reason, and run generation. Queue item truth
  lives in QUEUE.md; do not introduce an independently editable task list in SQLite.
- One worker session belongs to at most one runner. One resolved queue has at most
  one active runner, including when projects share the same mounted files.
- Use a durable lease plus serialization/idempotency for Start, nudge, and recovery.
  After a webui restart, reconcile enabled runners before acting. Never blindly
  resend a startup message whose delivery is uncertain; surface uncertainty if
  delivery cannot be established.
- Reuse project access checks, workspace file access, drivers, Mission send/recovery
  gates, and pad-tmux. No new raw shell typing path or bypass of user-mode execution.
- A stopped PAD is reported and waits for explicit action; a worker crash recovery
  setting is not permission to restart the entire PAD.
- Session close/project removal and runner removal must reconcile monitoring first.
  Removing a runner leaves its queue and conversation intact unless the human
  separately requests deletion. No orphan watcher may recreate a deliberately
  closed session.
- Record transitions and action metadata for diagnosis, not full prompts, provider
  credentials, or arbitrary transcript copies in audit logs.

## Phase 1 Findings — per-driver signals (2026-10-11)

The table below records what `readActivity` actually surfaces for each driver, so the supervisor knows exactly which automatic decisions are possible and which require unknown/unsupported handling.

| Signal | opencode (sqlite) | codex (jsonl) | claude (jsonl) |
|---|---|---|---|
| **Last user/assistant message** | `lastMessage.{user,assistant}.{text,at}` — newest prose per role | Same shape | Same shape |
| **Last tool call** | `lastToolCall.{tool,status,at}` — `status: 'running'` when tool part has `state.status === 'running'` | `status: 'running'` when `function_call` has no `function_call_output` | `status: 'running'` when `tool_use` has no matching `tool_result` |
| **Message count** | `messageCount` (sqlite `COUNT(*)`) | Not available | Not available |
| **Conversation match** | `matched: 'exact'` (session id is primary key) | `matched: 'name' | 'only-file'` — filename match or single-file guess | `matched: 'name' | 'only-file'` |
| **Turn boundary** | **No** — each assistant step is its own message; no grouping | **No** — `event_msg` → `user_message` marks human turns, but assistant turns are implicit | **No** — `user`/`assistant` role alternation is implicit |
| **Compaction state** | **No** — not exposed in sqlite | **No** — not in rollout | **No** — not in jsonl |
| **Provider errors (429, exhaustion)** | **No** — not in store; would need output scan or provider API | **No** | **No** |
| **Token usage / cost** | **No** | **No** | **No** |
| **Exit signal (pane/tmux)** | `padRunning` (container) + `paneState().live` (mission) | Same | Same |
| **Identity guarantee** | Exact (sqlite PK) | Filename match or 'only-file' guess | Filename match or 'only-file' guess |

**Implications for the supervisor (Phase 4):**
- **Turn idle detection**: Must use tool completion + grace period, not an explicit turn boundary. Unknown `busy` when store unreadable → no auto-nudge.
- **Compaction grace**: Cannot detect compaction; rely on tool absence + time + no new messages.
- **Provider exhaustion**: Must capture from pane text (e.g., OpenCode's subscription notice) or skip auto-recovery when unconfirmed.
- **Identity**: Reject 'only-file' matches for runner control; require exact session id match.
- **Cost**: opencode = 1 indexed query (~2ms); codex/claude = parse one jsonl file (grows with transcript). Budget polling accordingly.

**Explicitly unsupported (no automatic recovery will be attempted):**
- Provider API rate limits without pane evidence
- Compaction waits beyond configured grace
- 'Only-file' guessed identity for runner control
- Token budget enforcement

All cases above surface as `unknown` / `observation unavailable` health states with reason, never as idle or done.

## Implementation checklist

- [x] **1. Dependencies and signals:** align paths with plan 82; confirm actual
  per-driver turn/tool/compaction, identity, exit, and provider-error signals. Record
  unsupported/unknown cases explicitly before enabling automatic recovery.
- [x] **2. Queue contract:** parser, generated QUEUE.md instructions, aggregate state,
  validated revision-aware updates, path checks, plan-list exclusion, and file errors.
- [x] **3. Runner persistence:** schema/migrations, project/session binding, settings,
  queue ownership lease, lifecycle transitions, idempotency and restart reconciliation.
- [x] **4. Supervisor:** startup prompt, progress sampling, conservative nudging,
  bounded recovery, stop handling, intervention and usage-limit states.
- [x] **5. Surfaces:** create/configure popup, pinned listing rows and statuses,
  Edit/Start/Pause/Resume/Remove as runner, details; shared API/MCP operations and tool descriptions.
- [ ] **6. Verification:** parser/state-machine tests plus actual browser/session
  flows below; tune defaults from observed behaviour.
- [ ] **7. Documentation:** document queue format and runner behaviour, reconcile
  generated INDEX/QUEUE instructions, absorb completed plan into docs only after delivery.

## Acceptance and verification

- Create a named runner from Sessions; it stays pinned across refresh, filtering,
  stopping and completion. Test desktop/mobile, popup validation and keyboard use.
- First Start creates one session; subsequent/concurrent/retried Starts reuse it
  and deliver at most one startup action. Starting an existing busy worker waits.
- A custom plans folder resolves INDEX.md and QUEUE.md correctly. An existing queue is preserved.
  Parser fixtures cover malformed/partial JSON, duplicate IDs/keys/markers, unknown
  statuses, multiple active items, path escape, missing plans, and empty completion.
- New → in progress → done runs in order. A need-input item anywhere blocks later
  items; resolving it and pressing Resume continues the same conversation.
- All done/empty is detected by code with zero LLM calls. Invalid/unreadable never
  appears done. Adding work to a finished queue does not automatically launch it.
- A slow silent build and a compaction followed by a delayed reply receive no
  premature nudge or restart. Confirm genuinely idle unfinished work does get one.
- A confirmed exited worker resumes the right conversation; stale identity, an
  unknown probe, permission prompt or solo lock cannot receive a send.
- Repeated non-progress nudges hit backoff/budget and wait visibly. Provider-limit
  fixtures distinguish confirmed exhaustion, transient 429, and an empty reply;
  verify live exhaustion when available without inventing an observed result.
- Pause races with a pending nudge/recovery and wins; the tmux pane ends while the
  row, conversation, queue and pinned runner remain. Resume uses that same
  conversation. Row clicks, attached terminals and webui restart cannot undo Pause.
  Need input still keeps its pane open. No dispatch occurs after pause/need-input/done.
- Reopen the popup, edit and save settings, and verify persistence without starting
  work. Remove as runner while active, paused, waiting and never-started: no later
  nudge/recovery, no pin/designation, and existing session/queue data preserved.
- Two runners cannot own one queue/session. Human edits during agent updates do
  not disappear; stale revisions refuse rather than overwrite.
- Run relevant suites individually against isolated data. Exercise the real browser
  controls and inspect resulting DOM, console and request failures. Use controlled
  test sessions for interruption/recovery and preserve existing user sessions.
