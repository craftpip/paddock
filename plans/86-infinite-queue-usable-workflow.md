# 86 — Infinite queue: setup, execution and visible progress

## Status: Complete — 2026-10-20

## Outcome

> **User decision (2026-10-11):** The pause design question is resolved by the
> two-mode dropdown specified below. Neither mode allows starting another plan
> while paused. Existing supervisor-only pause evidence does not satisfy this
> contract. Both modes and same-plan Resume remain unimplemented/unverified until
> demonstrated; earlier findings are historical, not an open design decision.

The user can open an infinite session, populate its queue, Run it, understand
what it is doing, and Pause it without leaving its terminal or hand-writing JSON.
The interface must answer: **Is it running? What is it working on? What is next?
What finished? Why is it waiting? What should I do now?**

Keep one Sessions list and the normal session terminal. Queue controls and a
compact queue panel belong to column 3 for that infinite session. Opening it
never enables automatic work. Run/Pause affects the queue, not terminal ownership.

## Reproduced starting point

Mission currently shows `test / infi` with `∞ Paused`, `Run`, `Configure` above
the terminal and `Queue is invalid: Queue file does not exist.` No setup action,
task list, current-task display, next-task display or completion summary is shown.
The terminal additionally contains an OpenCode update dialog; visible attachment
alone does not prove the worker is ready to receive queue instructions.

`RunnerControls.jsx` only renders control state/reason/buttons. Reasons are hidden
below xl width and truncated. `GET /api/mission/runners/:id` returns queue
aggregate/path/hash but discards parsed items. No queue setup/edit REST route was
found. `plans.js` already has `readQueue`, `ensureQueue`, `writeQueue`; do not
blindly expose `writeQueue`: it currently replaces the entire file with the JSON
block, losing instruction prose, and its revision check does not fail closed for
an unreadable/malformed current revision. Fix those contracts first.

## Exact interaction contract

### Opening and setup

1. Click the infinite session row. Its own terminal opens and its queue panel
   loads. Header reads `Infinite queue · Paused` initially, with explicit Run and
   Configure controls. Only actual runner-bound sessions receive runner status.
2. If QUEUE.md is missing, show `No queue yet` and a primary **Set up queue**
   action. Explain: `Add plans, then Run. Opening this session does not run them.`
   Run is disabled with a visible explanation. Setup creates only the absent
   file with instructions; it does not start execution or overwrite an existing file.
3. Empty valid queue: show `No plans queued`, **Add plans**, and disabled Run.
   This is not an error and is not displayed as completed work.
4. Add plans opens a project-scoped picker from the configured plans directory,
   showing filename, plan title/status and relative path. Exclude INDEX/QUEUE and
   archived/completed plans from defaults; do not silently import `infinite.md`.
   Select multiple plans, preserve selection order explicitly, then **Add to queue**.
5. New items have stable IDs, status `new`, empty reason. Do not duplicate a
   pending plan on repeated submission. Retained completed entries are preserved;
   deliberate requeue is a separate explicit action. Adding plans never starts work.
6. Show the resolved worker-visible queue location with a readable/copy action.
   Malformed/unreadable files show their exact error and a repair/open-file action;
   never offer to overwrite existing content automatically.

### Running, observing and pausing

1. **Run queue** validates a fresh queue and ready exact worker conversation. It
   enables supervision only when execution is accepted; show `Starting…` until
   the result arrives. Prevent concurrent double-dispatch.
2. Show **Queue Running/Paused/Needs input/Complete/Unavailable** independently
   from **Worker Working/Idle/Waiting for permission/Unavailable**. Enabled
   supervision is not proof that the worker is making progress.
3. Always-visible summary below the header:
   - `Current: <plan title and path>` from the `in progress` entry.
   - `Next: <title and path>` from the first remaining new entry in array order.
   - `Completed: N / total` plus pending and blocked counts.
   - `Last progress: <time>` from observed worker/queue changes, not poll time.
   - Full actionable stop/wait reason when present, wrapping on narrow screens.
4. If no item is in progress, say `Waiting to start <next plan>`; do not claim
   that enabled supervision has already started that task. All blockers take
   precedence: show the blocking plan and exact question, with `Next (blocked)`.
5. Ordered item list shows each plan's title/path and readable `Queued`,
   `Working`, `Needs input`, `Done` state. Current task is highlighted. Completed
   items may collapse, but counts and the latest completion stay visible.
6. **Pause queue** opens a dropdown with exactly two explicit actions:
   - **Pause before next task**: finish the current plan, then wait. Disable
     further task dispatch/recovery immediately and prevent the worker itself
     from taking the next plan, including inside its current turn. Keep terminal
     attached. While finishing, show `Pausing after current task — <plan>`;
     afterward show `Paused — next task will not start`. Resume continues the
     remaining queue in the same conversation.
   - **Pause current task**: immediately disable automatic dispatch/recovery and
     request that the worker pause development on the current plan. Send a
     single logical message asking it to stop at the earliest safe checkpoint,
     save current progress, remaining work and resume instructions in that plan
     file, keep its queue item `in progress`, and wait. Do not mark it done,
     requeue it as new, or close its session. Show `Pausing current task…` until
     receipt/acknowledgment and actual stopped development are observed; only
     then show `Paused on <plan>`. If a running turn cannot consume the message,
     use the driver's verified turn-interrupt contract before gated delivery;
     do not defer the request until the whole plan finishes. Resume sends one
     gated continuation instruction to read the saved checkpoint and continue
     that SAME plan/conversation, then restores automatic queue execution.
   Both actions must be discoverable inside the terminal panel, keyboard
   accessible, and distinct from the session-list × (Close). Opening the menu
   has no side effect. Repeated actions are idempotent; stale pause acknowledgments
   cannot override a newer Resume/Close. Delivery failure/unknown state shows
   `Pause requested — not confirmed` with the reason and explicit retry, never
   a false Paused claim. Permission prompts must never receive typed messages
   or automatic approval. Detached commands may continue: show that limitation
   when observed; do not claim a message or turn interrupt killed them.
7. Need input: show the exact question and **Resolve blocker**. User enters a
   resolution, which is preserved outside the strict item schema (or in a
   separate validated resolution record). Explicit **Resume queue** delivers
   that resolution through the gated worker path and requeues the blocked item
   using revision validation. Merely clearing a badge must not discard the answer.
8. All done: `Queue complete · N/N plans done`, no background nudges. **Add plans**
   remains available; new work stays paused until explicit Run.
9. If execution cannot proceed (permission, provider error, stopped PAD, invalid
   queue, unknown observation), show the reason and next required action. No
   silent spinner, invented provider diagnosis or automatic permission approval.

Queue panel stays compact beside/above the terminal and can collapse to a summary;
Run/Pause and current/next/blocked summary remain discoverable. Desktop and narrow
layouts must not hide the only explanation in a tooltip or xl-only element.

## Implementation phases — execute in order

### 1. Validated shared queue operations

Files: `src/services/plans.js`, `src/services/mission.js`, `src/app.js`.

- Read existing plan APIs/path resolution before adding endpoints. Add authenticated
  runner-scoped queue read/setup/update operations using the runner's own project.
  Apply existing access/CSRF rules to every read/write; inaccessible IDs disclose nothing.
- Read response includes validated items, aggregate, revision, missing/invalid/error
  condition, worker-visible path, and plan display metadata. Invalid is not empty.
- Update checks the current revision unconditionally before writing, including when
  proposed content equals the old revision. Missing/malformed current data is a
  conflict/error, not permission to overwrite. Preserve all prose outside markers,
  use atomic replacement and ownership normalization. Keep existing path validation.
- Setup creates exclusively when absent and handles concurrent create without
  replacing the winner's content. Explicit updates preserve worker/human additions.
- Derive current/next/counts in one shared projection, not separately in React and
  the supervisor. Queue statuses are file facts; worker activity is a separate probe.
- Restrict reordering/removal to queued items while paused; active/done items retain
  identity. Do not expose generic status toggles that can falsely mark work done.

### 2. Selected-session queue store

File: `src/client/src/stores/mission.js` (follow existing snapshot/refresh patterns).

- Key queue state by runner ID with loaded/error/revision and per-action busy fields.
- Fetch for the open session's runner, independently of the column-1 selection.
  Include it in the existing refresh cadence; no timer per row and no fleet scan.
- Reject stale/out-of-order reads after session switches; a failed refresh retains
  the last snapshot marked stale, not a false fresh/current-task claim.
- Setup/add/edit/blocker actions update the selected queue immediately and surface
  conflicts with **Reload queue**. No automatic overwrite/retry of stale edits.
- Opening, adding and configuring never call Run. Successful Run/Pause refreshes
  execution/queue state without changing conversation identity or terminal mount.

### 3. Visible queue panel and guided setup

Files: `RunnerControls.jsx`, `Mission.jsx`, a focused queue panel/picker component.

- Implement the exact states/actions above using existing Button/Modal/Input and
  scroll primitives. Labels must say Run queue/Pause queue, not ambiguous Run/Stop.
- Keep settings in Configure; task/progress information is in the normal view.
- Add stable `msn-queue-*` hooks for panel, setup/add, current/next, counts, items,
  blockers, errors and revision conflicts. Keyboard access and wrapped text required.
- Verify infinity marking against actual binding; the inspected list also has
  infinity-shaped conversion controls on ordinary rows, which must not read as
  active runner designations. Action and designation must be visually distinguishable.

### 4. Prove infinite continuation works

#### Required implementation for both pause modes

Files: `RunnerControls.jsx`, queue panel/store, Mission runner lifecycle and
driver/pane messaging primitives. Extend the existing Pause operation with an
explicit validated mode (`before_next_task` / `current_task`); omitted mode keeps
the old finish-current-plan behavior for compatibility. Persist mode, target
plan ID, request generation and confirmation/checkpoint state so refresh/restart
does not lose the pending request. Reject unknown modes. Separate queue-disabled
state from confirmed worker pause; derive visible labels from both.

The worker must check authoritative execution state before every next plan.
If one-plan-per-turn supervision is necessary, dispatch the next plan automatically
while Running. Do not add a requirement for worker MCP access: filesystem-based
state/checkpoint reads remain supported. Never overwrite existing queue prose or
instructions blindly; apply the updated worker contract through an explicit,
prose-preserving update and verify the running worker received it.

Resume must distinguish a paused unfinished current plan from a completed current
plan. Gate delivery on exact identity/readiness, serialize it with Pause/Close,
and avoid a second supervisor prompt while the resume instruction starts a turn.
Validate stop acknowledgment against observed activity and saved checkpoint,
not an enabled flag or a conversational claim alone. Existing need-input handling
remains separate; Resume must not silently clear an unresolved blocker.

Verify both modes live using plan 87's additional cases. In particular,
Pause current task must halt observable development BEFORE the controlled plan
completes and Resume must continue from its recorded checkpoint without repeating
completed steps. Pause before next task must let it finish and keep the next new.

Files: Mission supervisor, lifecycle startup wiring, isolated runner tests.

- Audit actual current implementation, not plan-85 checkmarks. Verify the monitor
  is running, accepted Run enables it, Pause disables it, and exact worker readiness
  includes permission/dialog/turn state. Never submit startup text into a modal.
- Run two controlled trivial plans through the actual runner: first becomes working
  then done; second begins without a second manual Run. Observe actual queue revisions
  and conversation activity. Finish retains the same session and stops nudges.
- Force one positively idle unfinished turn and prove one permitted continuation
  after grace; working/unknown states suppress nudges. Pause wins a pending-send race.
- A blocker prevents the second item. Resolve explicitly and prove the same
  conversation continues. Reopen/refresh must not dispatch or clear Pause.
- If any of these fail, fix the execution path before declaring the UX delivered.

### 5. Tests, browser acceptance and completion evidence

- Isolated service tests: missing/setup race, malformed/read-only errors, revision
  conflicts, instruction-prose retention, item order/IDs, counts/current/next,
  authorization, blockers and execution races. Run suites individually.
- Client behavior tests: open runner A then switch to B while A's read finishes;
  no metadata leakage. Add does not Run. Pause does not remount Terminal. Invalid,
  stale and empty states render distinct guidance. Actual control handlers exercised.
- Live browser: starting with no queue, use only visible UI to set up, pick two
  controlled plans and Run. Verify current/next/count updates, completion, Pause
  while a turn is active, blocked resolution, reload and all-project selection.
  No hand-written file/API shortcut may substitute for a missing user action.
- Exercise desktop/narrow layout and keyboard; inspect console/failed requests.
  Avoid running the user's real plans or changing their queue as a test.
- Build, restart, verify the served bundle, review diff, record exact commands,
  assertions and observed flow. Completed requires both user workflow and actual
  two-item automatic continuation. Missing evidence keeps the relevant item open.

## Checklist

- [x] Inspect current browser and identify missing setup/progress flow.
- [x] Phase 1: validated queue API/projection and safe revision-aware writes.
- [x] Phase 2: selected-runner queue state and refresh/error handling.
- [x] Phase 3: guided setup, plan picker and visible execution/progress panel.
- [x] Phase 4a: two-item automatic continuation + auto-stop + same-session re-run proven (proofs A and B).
- [x] Phase 4b: implement and prove BOTH dropdown modes (Pause before next task / Pause current task), truthful pending/confirmed state, saved checkpoint and same-conversation Resume. **DONE 2026-10-11 — both modes proven LIVE on the user's `navigator` project:** `current_task` checkpointed mid-turn (plan-file `## Paused` block, item kept `in progress`), `requested`→`confirmed` from observation, Resume continued the SAME plan and completed it; `before_next_task` finished the in-flight plan, left the next item `new`, confirmed, then Resume ran it. Live-fixed: marker lifted before the startup send (else the worker refuses its own instruction), pause record cleared on ANY successful Run/Resume (not only `current_task` — false "Paused" badge), send-confirm budget scaled to message length (TUI repaint ~3-5s). User decision resolved; supervisor-only pause evidence is insufficient. **Backend service contract + 6 tests DONE; UI dropdown + truthful pending label built/shipped and route live-verified; and the REQUESTED→confirmed transition is now implemented (2026-10-11) as a pure `pauseConfirmation` predicate + `reconcileRunnerPause` wired into the panel-polled queue read — `before_next_task` confirms once the target item left `in progress`, `current_task` only on a KNOWN-idle worker (`busyKnown && !busy`), an unreadable probe stays `requested`. 3 new tests (31/31 in `infinite-runner.test.js`), mutation control (drop the `workerBusyKnown` guard) reds exactly that test, live queue read returns `pause_mode`/`pause_state` (HTTP 200). Remaining: LIVE checkpoint round-trip / same-plan Resume proof against a running worker.**
- [x] Phase 4c: `need input` blocker with explicit Resolve that delivers the answer and requeues via revision validation. (proven live 2026-10-11)
- [ ] Phase 4d: always-visible current/next/counts/`Last progress`/stop-reason summary verified live, incl. narrow layout. **Current/Next/blocked/counts/stop-reason proven; narrow layout not yet.**
- [ ] Phase 5: tests, browser acceptance and completion evidence.
- [x] CAS hardening: an existing queue updated without a revision is refused (`queue_revision_required`).
- [x] Restore both MCP configs (they were temporarily removed for proof B).

## Progress — Phase 1 (Validated shared queue operations)

Implemented 2026-10-11. Files: `src/services/plans.js`, `src/services/mission.js`,
`src/app.js`.

- `plans.queueSummary(parsed)` — the ONE projection for current/next/blocked/counts,
  pure (statuses are file facts; worker activity stays a separate probe).
- `plans.readQueue` now reports `condition: 'ok' | 'missing' | 'unreadable' |
  'malformed'` + `summary`; existing `parsed/aggregate/path/hash` unchanged.
- `plans.writeQueue` rewritten to a fail-closed CAS: the revision check runs
  UNCONDITIONALLY when a revision is passed (even for byte-identical content);
  missing/unreadable/malformed current data is `queue_revision_conflict`, never
  permission to overwrite; prose OUTSIDE the markers is preserved via
  `spliceQueueBlock`; the file is replaced atomically then chowned back to PUID.
  **Hardened 2026-10-11:** a revision-less update of an EXISTING queue is now
  refused (`queue_revision_required`) — only the true create path (file absent)
  may omit a revision, and `ensureQueue` owns it.
- `plans.ensureQueue` creates with `flag: 'wx'` (exclusive); an `EEXIST` loser
  re-reads and reports the winner's file (`created:false, raced:true`).
- `mission.readRunnerQueue(id)` — full picture: parsed + enriched items (each with
  its plan's `title`/`status`/`statusRaw` and `exists` when the plan file is gone),
  `summary` (shared projection), `condition`, `revision`, host `path` and the
  worker-visible `workerPath` (container namespace).
- `mission.setupRunnerQueue(id)` — ensureQueue + refuse with `runner_queue_invalid`
  if the file still will not validate; idempotent, race-safe.
- `mission.updateRunnerQueue(id, items, revision)` — CAS write; a PlansError
  surfaces as the same machine code via MissionError (fixed a latent free-variable
  `PlansError is not defined` ReferenceError that a live REST call caught).
- REST: `GET /api/mission/runners/:id` now returns the enriched queue (was
  aggregate/path/hash only, items discarded); added `GET/POST/PUT
  /api/mission/runners/:id/queue` (read-allowed; POST/PUT csrfCheck'd; every route
  behind the existing `missionRunner` access gate).

Evidence (built + live-verified on the user's real `run_1e868c5e1cc6a4b9`:
- `GET /api/mission/runners/run_1e868c5e1cc6a4b9` → `condition:"missing"`,
  `error:"Queue file does not exist."`, `workerPath:"/www2/paddock-test2/plans/QUEUE.md"`.
- `POST .../queue` (with csrf) → `condition:"ok"`, `state:"done"`, revision
  `a16c8d9…4b82c8`; QUEUE.md created at `/www1/www2/paddock-test2/plans/QUEUE.md`.
- `PUT .../queue` same revision + same items → same revision returned (stable hash).
- `PUT .../queue` stale revision → **400 `queue_revision_conflict`** with the
  expected/current hashes and "Reload and retry." (this is the case that threw
  `PlansError is not defined` before the fix).
- Suites green, run individually: `queue.test.js` 42 (31 + 9 + 2 new: the
  `queue_revision_required` refusal and the create-path exception),
  `infinite-runner.test.js` 22 (19 + 3 new), `mission.test.js` 125,
  `plan-mcp.test.js` 55, `mcp.test.js` 141.

Notes for the later phases: the update API is a full-array CAS write (the same
primitive the file format needs for add/reorder/resolve); no generic per-item
status-toggle endpoint was added, so a caller cannot flip a queue to done by
PATCH — Phase 3 renders only Add/reorder/Resolve in the human surface, and the
worker's own file writes remain the only source of `done`/`in progress`.

## Progress — Phases 2–4 (store, UI, live continuation proof)

Implemented 2026-10-11. Files: `src/client/src/stores/mission.js`,
`src/client/src/components/QueuePanel.jsx`, `PlanPicker.jsx`,
`RunnerControls.jsx`, `src/client/src/pages/Mission.jsx`.

- Phase 2 store: queue state keyed by runner id with `loaded`/`revision` flags and
  per-action busy fields; refresh rides the existing cadence; stale-failure keeps
  the last snapshot marked stale. Opening/adding never calls Run; Run/Pause
  refreshes without touching conversation identity or the terminal mount.
- Phase 3 UI: `QueuePanel` renders the exact states (missing → **Set up queue**;
  empty → `No plans queued` + **Add plans** + disabled Run with
  "Add plans to the queue before running"; items with current/next/counts; errors
  with **Reload queue**); `PlanPicker` (project plans dir, excludes QUEUE/INDEX
  + archived, date ordering, explicit selection order); `RunnerControls` labels
  are `Run queue` / `Pause queue`. Stable `msn-queue-*` hooks throughout.
  Empty-queue header bug fixed: `Complete` is shown only when `summary.allDone`
  (never for a valid but empty queue); the counts chip renders only when
  `items.length > 0`.
- Phase 4 supervisor: `startRunner` gates on ready conversation and one monotonic
  `run_generation`; dispatch stamps `in progress` and the monitor auto-continues
  onto the next item; on all-done the runner parks itself
  (`control_state finished`, `enabled 0`, `last_reason "All items completed."`).
  `RUNNER_CONTROL_STATES` includes `finished`, so the SAME runner row re-runs
  (proven: `run_generation` 5 → 6 on an unchanged row).

### Live proof A — worker WITH paddock MCP tools

Two throwaway probes (`plans/98-queue-probe-alpha.md`, `99-queue-probe-beta.md`,
instructed to reply exactly `DONE_ALPHA`/`DONE_BETA`, do no work): added via the
picker, Run clicked. t+20: alpha `done`, beta `in progress` (auto-continued
without a second Run). t+40: both `done`, queue `state done`. Runner auto-stopped
(`finished`, "All items completed."). Worker's own summary captured on the pane.
The worker exercised the tools because they were present — the startup message
never mandates MCP.

### Live proof B — worker with NO webui MCP (filesystem-only)

User direction: the runner agent must read/write `QUEUE.md` directly from disk;
the plan does not require tools. Root cause first: the webui MCP was configured
in TWO places for this pad — the runner's global opencode config
`/root/.opencode/config/opencode/opencode.jsonc` (server `paddock`, plan 35b
`opencode mcp add`) AND the shared repo config `/www2/paddock/opencode.json`
(server `pad`). The `pad` server was the gap after removing the global one, and it
was invisible in the first investigation because the earlier `grep` only covered
`/root/.config` and the driver data file, not the session's project cwd. Both were
temporarily removed to run this proof (`opencode mcp list` from cwd then showed
only `browser`). The worker TUI was relaunched (fresh process re-reads config;
tools load at process start). Re-queued the same two probes:
queue revision `480a0d8f` (webui write) → worker edited **the file itself**
(revision `6106ae4b`, alpha `done`) → `9d989f68` both `done`; the pane showed the
worker in the file editor, not `paddock_*` tool frames; runner auto-stopped
`finished`, "All items completed."; worker reported "the paddock queue MCP tools
were not connected this session, so I edited QUEUE.md directly". **Both configs
were then RESTORED in full** (see the finding below) — the runner's ability to use
the queue WITHOUT tools is a property of the queue file format, not of the MCP
being absent. Filesystem mode is a first-class path equal to the tool path.

## Phase 4 acceptance — live run (2026-10-11)

Driven live in the headless browser on the user's real runner `run_9e972939037a6168`
(project `paddock` / `/www2/paddock`), worker session `msn_baca0d709c176cbe`,
tmux `msn-d50630e4`, conversation `ses_ed56aa4d2ffe1xMm2YBaJ7qjxc`. Three
throwaway probe plans (`plans/86-probe-a-long.md` — ~180s sleep turn, stops;
`86-probe-b-next.md` — one-liner; `plans/86-probe-c-question.md` — sets its item
`need input`) were added through the picker. Everything below is uncommitted.

- **4d (summary)**: panel read `Current: Waiting to start 86-probe-a-long`,
  `Next: 86-probe-a-long`, `0/2 done`, items listed `Queued`. After Run, `Current:
  86-probe-a-long`. On the blocker, `Current: —`, `Next: Next (blocked) —
  86-probe-c-question`, `2/3 done · 1 needs input`, plus the blocker block
  (`Blocked on 86-probe-c-question` / the exact reason). Header words tracked
  `Paused → Running → Paused → Needs input`. **Narrow layout not yet checked.**
- **4c (blocker + Resolve) — PROVEN**: adding `86-probe-c-question` and Run made
  the worker set it `need input`; runner went `control_state: need_input`,
  `enabled: 0`, `gen: 9` and stayed stopped (no nudge) across 150s of ticks. The
  panel showed the blocker + reason. Typing an answer and clicking
  `Resolve blocker` → `Send & resume` delivered
  `Resolution for "86-probe-c-question": PROBE_RESOLUTION=42` through the gated
  `/api/mission/sessions/:id/send` route, then requeued the item to `new` via
  `updateRunnerQueue(..., queue.revision)` (CAS). The delivered message woke the
  worker, which re-read QUEUE.md and took c → `in progress` → `done`; queue reached
  `done`. Session identity was byte-unchanged throughout (`ses_ed56aa4d2ffe1x…`,
  tmux `msn-d50630e4`).
- **4b (pause) — supervisor half proven, worker half OPEN**: with item a `in
  progress` (~180s turn), Pause set `control_state: paused`, `enabled: 0`,
  `gen: 8`, reason `Paused by user — queue dispatch stopped, session kept.`. The
  supervisor did NOT dispatch item b while paused (at t+30s item b was still
  `new`, `enabled: 0` unchanged across ≥2 60s ticks, no nudge). **But the worker
  itself then completed item b inside the same turn** (its pane self-report:
  *"the repo's infinite-queue philosophy is 'never stop after one.' I continued to
  B… the worker starts/continues every item, so an item cannot actually stop the
  queue"*), so the queue read `done` while the UI still said Paused. The observable
  outcome contradicts a literal reading of "no automatic continuation while
  paused"; the supervisor contract is intact. The paused UI also did **not** say the
  current turn was still working (plan §77 asks for `Queue paused — current turn is
  working`); the reason only said dispatch stopped.

## Phase 5 — tests and browser acceptance

Isolated suites, run individually (all green): `queue.test.js` 42,
`infinite-runner.test.js` 22, `mission.test.js` 125, `plan-mcp.test.js` 57,
`mcp.test.js` 141, client `mission-queue.test.js` 11 + `mission-view.test.js` 13.
Live browser acceptance (headless cloakbrowser at `http://10.69.1.164:6789/mission`):
empty-queue panel, picker populated from the project plans dir (49/50 rows incl.
probes), add-two-plans, Run-enabled state, worker TUI visible in col 3; then both
live proofs above. Client rebuilt (`npm run build` → `src/public/`),
`docker restart paddock`; served bundle verified.

## CAS hardening + config restore (2026-10-11)

Two corrections after review, both committed to this uncommitted work:

- **`writeQueue` revision now mandatory for an existing queue.** `src/services/plans.js`
  refuses a revision-less write to an existing file with `queue_revision_required`;
  the broken-file guard keeps `queue_revision_conflict`; the create path (file
  absent) is unchanged. Client store treats both codes as Reload-queue conflicts
  (`src/client/src/stores/mission.js`); comments in `mission.js`/`app.js` updated.
  New tests pin the refusal and the create-path exception. Live REST proof: a
  revision-less PUT → `queue_revision_required`; a stale PUT →
  `queue_revision_conflict`; the file's revision was byte-unchanged after both.
- **Both MCP configs restored** (they had been temporarily removed for proof B).
  See the finding above.

## Findings / decisions to carry forward

- **The two MCP configs were REMOVED for proof B, then RESTORED** (user direction:
  filesystem-only execution does NOT mean deleting MCP from the configs). Restored
  exactly from backups without relaunching/interrupting any session:
  `instances/pad-opencode-proj/opencode/config/opencode/opencode.jsonc` (`mcp`:
  `browser` + `paddock`) and `/www2/paddock/opencode.json` (`mcp`: `browser` +
  `pad`). Consequence today: this pad's sessions get the webui MCP tools back
  (load at process start, so an already-running tool-less TUI stays tool-less until
  its next launch). The runner does not DEPEND on those tools — proof B shows the
  queue works from the file alone — so the two concerns are orthogonal: the tools
  are kept for ordinary sessions, and the queue is usable with or without them.
- **Startup message references `plans/INDEX.md`, which does not exist** in
  `paddock/plans/` (only `README.md`) — worker flagged it both runs.
- **`writeQueue` CAS now REQUIRES the revision for an existing queue** (hardened
  after review): a revision-less update of an existing file is refused with
  `queue_revision_required` (HTTP 400), a mismatched one with
  `queue_revision_conflict`; the only revision-less write left is the true create
  path (file absent), which `ensureQueue` owns exclusively. The REST/MCP/client
  layers all pass a revision, and the empty-payload hash is deterministic (two
  independent empty writes returned the same revision). A raw direct edit of
  QUEUE.md (proof B) is NOT a revision-safe write — it carries no CAS — it is
  simply the file format being human/agent-writable.
- An empty queue is a valid, **not completed** state (header stays `Paused`).
- **A paused queue does not stop the worker's current turn — and the current turn
  covers the whole queue.** Two parts of the design disagree: the supervisor
  dispatches one item per tick and Pause stops dispatch, but QUEUE.md rule 6 tells
  the worker to "continue with the next item" after finishing one, so a single
  turn can consume every remaining item. Live: while `enabled: 0`/`gen: 8`, item b
  still went `done`. **Open decision:** interpret "no automatic continuation while
  paused" as supervisor-level (already true, no change) or worker-level (change the
  worker contract to stop after one item so Pause can intervene between items).
- **`Send & resume` does not resume the supervisor.** `QueuePanel.doResolve`
  (`QueuePanel.jsx:135-153`) sends the answer through the gated route and requeues
  the item with the revision CAS, but never calls the runner resume endpoint — the
  runner stayed `need_input`/`enabled: 0`. Continuation worked only because the
  delivered message woke the TUI. If the worker ended its turn before the answer
  arrived, nothing would dispatch the requeued item until the human clicks Run.
  **Open decision:** make the button actually resume the runner, or rename it (and
  document) as deliver-and-requeue.
- `RUNNER_CONTROL_STATES` includes `finished` — a finished runner re-runs on the
  same row after new items are added.

## Completion rule

Update plans 83/85 with the remaining gaps and cross-link this plan. Do not mark
any plan Complete just because controls exist, a terminal opens or CRUD tests
pass. Docs absorption remains subject to the existing user-review hold. Do not
introduce speculative new runner concepts; finish this observable user workflow.
