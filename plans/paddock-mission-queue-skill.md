---
created: 2026-10-29T22:01:09.807Z
last_activity: 2026-10-29T22:01:09.807Z
---
## Status: in progress

# Paddock Mission queue and plan management skill

## User's intended workflow
The user expects a usable management surface for the plan files and the Mission queue: create/add, edit/update, and remove/archive plan files; add, remove, update, and reorder queue entries; then start, stop/pause, and resume queue execution. Keep plan-file lifecycle distinct from queue membership: removing an item from a queue must not silently delete its plan file; editing plan content must not silently mutate queue membership or start work.

## Verified architecture and contracts
- Paddock is both a PAD/container control plane and a shared Mission workspace for coding agents. A Mission project is a (PAD, folder) pair; Mission work happens in a visible agent TUI session.
- The canonical queue is the Mission runner's configured `QUEUE.md` file/queue service, not the legacy root `infinite.md` checklist.
- Queue API/service: `plans.readQueue`, `ensureQueue`, `writeQueue`; Mission runner read/setup/update flow. Existing queue writes use revision/hash CAS, preserve prose outside queue markers, and refuse revision-less updates to an existing queue. Setup is exclusive/race-safe. Invalid/malformed is not equivalent to empty.
- Queue entries have stable IDs, statuses and reasons; queue summary distinguishes current/next/counts. Worker progress/status and supervisor state are distinct.
- Visible workflow (per plan 86): create/setup queue, add project-scoped plans via picker while preserving explicit selection order; adding/configuring does not run. Run validates queue and worker readiness; automatic continuation proceeds through items and stops on completion. Pause/Resume and blocker resolution have explicit state/delivery contracts; do not claim success until observed/confirmed. Empty valid queue is not completed work.
- Current MCP queue tools in this surface (`queue_read`, `queue_write`, `queue_ensure`) manage server-owned queue entries and regenerate `QUEUE.md`; they are separate from Mission runner execution controls.
- Plan 105 is still Proposed (0/5 phases complete) and covers improved queue plan management: open/edit plan file from queue rows, sortable Add Plans picker, completed-plan archival, and table-like queue controls. The checked document is a proposal, not proof of shipped implementation.
- Plan 86 records implemented setup/add/reorder/resolve/run/pause workflow, plus historical open verification gaps. Plan 101 records queue-row move/remove with active-task protection as complete. Confirm actual current code/state before asserting any capability as shipped.

## Safety and operating rules
1. Read Paddock MCP `help` for current contract; inspect project, sessions, plan, queue, and runner state before mutation.
2. Before starting or typing into a Mission session, read its session list/details. Reuse the fitting session; never interrupt a busy, locked, or permission-blocked session. If dead, inspect captured screen, then restart/relaunch same row as appropriate.
3. For PAD settings mutations, call `settings_get` first. Use supported Paddock operations; never guess IDs or parameters. After external state writes, read back the exact target.
4. Never expose credentials. Config reads redact secrets; use `exec.stdin` only when a secret must be consumed, never in command/prompt text.
5. Recreate kills every Mission session on that PAD; report/consider the impact. Never reset/delete/restart/commit/deploy/rotate credentials or networks without explicit authorization.
6. Plans are project-scoped when passing `project_id`/folder. Read the plan before execution; statuses are `new`, `in progress`, `blocked`, `need clarification`, `done`. `blocked` and `need clarification` are stop states. Archive by explicit move to archive, not merely ceasing work.
7. Queue membership mutations must be revision-aware and preserve concurrent changes. Do not use raw file overwrite as a shortcut. Adding/removing/reordering must not change a plan's content/status or trigger execution unless the user explicitly asked to run.
8. Verify in the UI/session and with the matching read tool; distinguish tool acceptance, agent activity, worker activity, and task completion.

## Evidence still needed before describing as current behavior
Read plan 105 and plan 86 against current code/tests and inspect the live Mission UI. Verify which plan-file CRUD actions (creation, edit, archive/delete), queue CRUD/reorder, and run/pause/resume/stop actions are currently shipped. Check any actual queue capacity/size constraints in schemas/storage, not the word “infinite.” The word refers to an execution workflow if documented; do not infer literal unbounded capacity.

## Acceptance for a user-requested queue-management implementation
- Project-scoped plan create/read/update/archive/remove behavior is explicit and safe.
- Queue add/update/remove/reorder uses stable IDs + CAS; plan files are preserved unless explicit archive/delete action is chosen.
- Run, pause-before-next, pause-current, resume, stop/close semantics are distinct and truthful, with same-session identity preserved where specified.
- Blockers, permissions, provider failures, stale revisions, empty/completed queues and stopped workers are distinct states.
- Automated tests and live UI verification pass; report exact checks and unresolved gaps. Do not mark plans complete on UI presence alone.
