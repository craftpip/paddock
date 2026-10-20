# Mission — Infinite Queue Plan Management

## Status: Proposed — 2026-10-19

0/5 phases complete. This plan covers table-like plan management in an infinite session's
expanded details panel: arrow-only queue ordering, opening and editing plan files, sorting the
Add plans picker, and archiving completed plans.

## Requested Outcome

When an infinite Mission session is open, its queue details remain expanded by default. The
details occupy column 3; collapsing them restores the terminal, without closing, restarting or
changing the terminal session.

Make the visible plan list a manageable table-like surface. Its rows must provide arrow controls
instead of the current written `Up` and `Down` actions. Selecting a plan opens that plan's
Markdown file in a file viewer/editor. The editor reuses the existing workspace file-viewing
experience rather than creating a second, inconsistent editor.

When adding plans, show the latest updated plans first by default. Let the picker order plans by
updated date, creation date or name, in either direction. A completed plan has an Archive action;
confirming it moves that plan file into the project's `plans/archive/` folder.

## User Journey

1. Open an infinite session. Its expanded queue details show the plan list and the terminal is
   hidden. Collapse the details and the same terminal is shown again; no runner or terminal
   action is triggered by the disclosure.
2. The queue list has clear table-like columns for status, plan name/path and row actions. Each
   movable row has accessible up/down arrow buttons. The first row's up button and final row's
   down button are disabled. Keyboard activation has the same result as a pointer click.
3. Click a plan name or row's Open action. A modal opens the correct plan file from the infinite
   runner's own project plans directory. It shows its name, status and Markdown text, supports
   editing, Save, unsaved-change protection and an error state. Saving refreshes the list's title,
   status and ordering facts without changing queue membership or runner state.
4. Choose Add plans. The picker opens with the most recently updated plans first. It has two
   explicit controls: `Sort by` (`Updated date`, `Created date`, `Name`) and `Order`
   (`Newest first`/`Oldest first` for dates, `A-Z`/`Z-A` for names). Filtering,
   completed/archived visibility and selection continue to work with every combination. The
   selected submission order, not the visual sort order, remains the order written to the queue.
5. A completed plan row shows Archive beside its other actions. Archive asks for confirmation,
   names the plan and says it moves the file to `archive/`. Confirming removes it from the active
   plan list and makes it available through the archive listing. Cancellation or a failed move
   leaves the original untouched and displays an actionable error.

## Scope And Contracts

### Queue Table And Reordering

- Update `src/client/src/components/QueuePanel.jsx` and any extracted row component. Preserve
  queue order, conflict handling, active-task protection, feedback and existing `msn-*` hooks.
- Replace the written `Up`/`Down` labels with recognisable SVG arrow icons. Keep visually hidden
  accessible names and descriptive `title` values such as `Move <plan> up`; icons alone must not
  be the only name.
- A plan title/path is the primary open target. Ensure row-action clicks do not also toggle,
  reorder or invoke another row action. The table must remain usable in narrow column 3 widths:
  paths may truncate visually but retain their full accessible title, and actions must not create
  horizontal page overflow.
- Do not reimplement queue ordering in the client. Continue moving stable queue IDs through the
  existing revision-protected `updateRunnerQueue` path. Show the server-authoritative order after
  each successful write and preserve the current conflict/reload behavior.

### Plan File Read And Edit

- Extract the generic file-modal/editor presentation currently embedded in
  `src/client/src/pages/AgentDetail.jsx` into a reusable component. Preserve its text/binary
  behavior, save status, JSON validation where it applies, unsaved-navigation guard and keyboard
  modal semantics. Mission consumes the reusable component with plan-specific read/save callbacks;
  it must not duplicate the workspace modal JSX.
- Add scoped Mission runner-plan read and write routes, backed by `src/services/mission.js` and
  `src/services/plans.js`. Resolve the runner first, then its project and agent. Accept only a
  relative active-plan Markdown path accepted by `plans.planPath`; do not expose arbitrary agent
  workspace paths, absolute paths, `..` traversal or reserved folder files.
- The read response includes the plan's body and list metadata needed by the modal. The write
  preserves the normal plan frontmatter contract (`created`, `started`, session binding,
  `last_activity`, `done`) and returns the refreshed plan row. Invalid Markdown status content,
  unreadable/missing files, stopped/unavailable workspace and write failures return typed,
  readable errors without replacing the editor's draft.
- Refresh the runner-plan source and queue decorations after a successful save. Editing a plan
  must not reorder, add, remove, archive, start, pause or restart a queue worker.

### Add Plans Sort

- Update `src/client/src/components/PlanPicker.jsx` with two labelled, keyboard-accessible
  dropdowns: `Sort by` and `Order`. `Updated date` + `Newest first` is the default. The available
  fields are `Updated date` (`lastActivity`, falling back to `created`), `Created date` (`created`)
  and `Name` (displayed title, then path).
- Date sort direction is `Newest first` or `Oldest first`; name sort direction is `A-Z` or `Z-A`.
  Apply deterministic tie-breakers so rows never jump unpredictably: a secondary date where
  available, then case-insensitive title and path. Missing dates sort after dated entries for
  newest-first and before them for oldest-first; unreadable files remain listed and sortable.
- Keep the chosen field and direction only for the active picker view (URL/query state if it is
  part of the existing picker navigation pattern). Do not persist or submit a rewritten queue
  order merely because a picker is sorted differently.
- Keep filtering and the completed/archived toggle independent from sorting. A selected item stays
  selected if the filter, field or direction changes, and Add to queue keeps selection order.

### Archive Completed Plans

- Add a plan-service operation that moves one active plan from that project's plans folder into
  its own `archive/` subfolder. The destination stays inside the scoped plans root, creates the
  archive folder when needed, rejects reserved paths, rejects a missing source and refuses an
  existing archive destination rather than overwriting user data.
- Expose it through a Mission runner-plan archive route that performs resolve-then-gate access
  checks and permits only a plan whose parsed lifecycle is complete (`done`/completed status).
  A server-side check is mandatory; hiding or disabling a client button is not authorization.
- A plan still referenced by a runner queue, including a completed queue entry, cannot be archived
  until it is removed from that queue through its existing revision-protected flow. Show the
  Archive action in its completed row but disable it with an explanation while the queue reference
  exists. This prevents moving a file while a queue item still points at the old active path.
- Require confirmation before the move. On success refresh active-plan and queue views and show
  concise success feedback. The file must be discoverable through the existing archived-plan
  listing. Do not delete the file, rewrite its content, or silently remove queue history.

## Implementation Steps

1. Trace the current queue plan list, `PlanPicker`, runner-plan route, `plans` path helpers and
   Agent Detail's inline file modal. Add focused service tests before changing behavior.
2. Extract the reusable file viewer/editor and migrate Agent Detail without changing its visible
   workspace behavior. Add scoped runner-plan read/write APIs and client actions, then connect
   queue-row opening and saving.
3. Convert queue rows to the table-like layout and arrow-only movement controls. Preserve stable
   hooks, accessible labels, boundaries, revision conflict behavior and narrow-column layout.
4. Add the picker field and direction dropdowns plus deterministic sort functions. Ensure
   selection and submission ordering retain their separate contracts.
5. Add the complete-plan archive operation, route and confirmation UX. Add queue-reference
   protection, refresh behavior, failures and archive visibility.

## Verification

- Run relevant plan, Mission queue and workspace-editor tests individually. Add tests for scoped
  path validation, list ordering, plan read/write metadata preservation, archive eligibility,
  collision refusal and queue-reference refusal.
- Build the client, restart the webui, and test `http://10.69.1.164:6789/mission` in the browser.
  Check an infinite session starts with details expanded; collapse/expand repeatedly and confirm
  the existing terminal remains attached and no runner state changes.
- Open a plan through its row, edit and save it, then verify the changed title/status/list sorting
  appears after refresh. Test unsaved-change cancellation, missing/unreadable file and save error
  without losing the draft. Confirm Agent Detail's workspace file viewer/editor still works.
- Verify arrow buttons visually and by keyboard: boundaries disable correctly, a move persists
  after reload, and a stale revision surfaces Reload queue rather than losing a concurrent change.
- Test the default Updated date/Newest first ordering, both date directions, name A-Z/Z-A,
  missing dates and stable ties. Repeat with filtering, completed/archived visibility and multiple
  selections. Confirm changing either dropdown does not change the order items are added to the
  queue.
- Archive a completed unqueued plan, cancel once, then confirm it. Verify it moves to `archive/`,
  disappears from the active list, remains readable in the archive listing and is never deleted.
  Verify incomplete, queued and destination-collision plans are refused without moving data.
- Check desktop and narrow Mission columns, console errors and failed requests. Compare Mission
  project counts before and after browser testing; do not delete unexplained user-created rows.

## Progress

- [ ] Extract and reuse the workspace file viewer/editor for Mission plan files.
- [ ] Add scoped runner-plan read/write and completed-plan archive service/API contracts.
- [ ] Make the expanded queue list table-like with accessible arrow-only move controls and plan opening.
- [ ] Add updated/created/name and direction dropdowns without changing queue submission order.
- [ ] Verify end to end, update the matching Mission documentation, then absorb this plan.
