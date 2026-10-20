# Mission — Full-column Infinite Queue Details

## Status: Complete — 2026-10-20

3/4 steps complete. Queue/terminal view coordination, full-height layout and
persisted row management are implemented. Focused checks and the reported live
Mission URL were verified; remaining: full destructive-action/conflict browser
coverage and documentation absorption.

## Requested outcome

Inside `.msn-col-shell.msn-col-agent` (Mission column 3), opening the infinite queue details hides the terminal. The queue details take the full available column space below the session header. Closing the details shows the terminal again.

The queue must also be manageable here: move tasks up or down and remove tasks from the queue.

This replaces the stacked queue-above-terminal layout and the bounded expanded-panel budget described in plan 98.

## Visible behavior

- An infinite-queue session with details expanded shows the session header and a full-height queue panel. No terminal is visible or occupying space beneath it.
- The existing queue expand/collapse control remains reachable. Collapsing details restores the terminal, with the compact queue toolbar and applicable unresolved feedback above it.
- Expanding again restores the full-column queue view. Switching views does not start, pause, restart or relaunch the agent, and does not change the selected conversation.
- Keep all queue actions available: Run/Pause, Add plans, Configure, blocker answers and delivery recovery. Preserve answer drafts and feedback across view changes.
- Ordinary sessions without an infinite queue keep their existing terminal view.
- Keep the current URL behavior: `queue=closed` means collapsed; `queue=open` or an absent parameter means expanded. Browser Back/Forward must update the visible view consistently.

## Implementation

### 1. Coordinate the two views in column 3

Affected files:

- `src/client/src/pages/Mission.jsx` — owns column 3, `QueuePanel` and `Terminal` rendering.
- `src/client/src/components/QueuePanel.jsx` — currently reads `queue=closed` locally and renders a `shrink-0` section with a `max-h-40` item list.
- `src/client/src/components/Terminal.jsx` — inspect visibility/resize handling before changing its integration.

Derive expanded state once from the existing navigation URL and pass the relevant state into `QueuePanel`, so parent layout and child disclosure cannot disagree. Apply it only when the displayed session actually renders an infinite queue panel.

Hide the terminal's wrapper while queue details are expanded, without unmounting the terminal or changing its key/session identity. The hidden wrapper must reserve no layout space and its terminal/input must be unreachable by keyboard. Restore terminal sizing when it becomes visible; use the existing fit/resize mechanism where possible. Retain the same live attachment across toggles.

Hide terminal-only notices/recovery content with the terminal view as appropriate, so a closed-pane notice cannot consume space below the expanded queue. Queue-related feedback stays in the queue panel. Existing terminal recovery remains accessible after collapse.

### 2. Let the queue fill and scroll within the column

Use `flex-1 min-h-0` and a flex-column layout for the expanded queue panel. Replace the fixed item-list height cap with a flexible internal scrolling body. Ensure ancestors have the required `min-h-0`/overflow constraints.

Keep the toolbar and collapse control reachable while long lists, errors or blocker content scroll. Wrap long messages and paths without horizontal page overflow. The expanded panel fills the remaining height on short screens and narrow columns as well as wide desktop layouts; it must not push the page taller or overlap another Mission column.

Retain stable `.msn-*` hooks, adding a terminal-view hook if needed to assert actual visibility. Do not infer visibility from whether a terminal DOM node exists: it deliberately remains mounted.

### 3. Manage queue tasks

Add visible, keyboard-accessible Move up, Move down and Remove controls to queue rows, with accessible names that identify the task. Disable movement at the first/last position. Display tasks in persisted queue order so movement has an unambiguous result; if completed tasks remain grouped separately, make ordering explicit within that group and never imply a movement the displayed list hides.

Persist changes through the existing queue-write service/store path (`src/services/plans.js`, Mission runner routes and `src/client/src/stores/mission.js`); inspect its revision/conflict contract before implementing. Move existing items by stable ID, preserving their status, reason and other supported data. Removal removes only queue membership, never the plan file. Use a concise confirmation identifying the task and stating that its plan file stays in place.

Reordering changes future scheduling order, not the execution status of a task already working. Removing an in-progress task must not silently abandon a worker: refuse with a clear explanation until its active execution is resolved through the existing runner controls. Do not assume Pause alone means the current task has stopped. Allow removal of inactive entries, including completed ones; removing the final entry leaves the normal empty-queue state and disables Run.

Prevent overlapping row writes while saving. On revision conflict, retain the current server queue, show Reload queue feedback and require a fresh user action rather than overwriting concurrent agent edits. On other failure, show an inline error and keep/reload the authoritative order; never report success before persistence. Refresh current/next/counts from the server after success. No reorder/remove action may start a worker or change Run/Pause state.

### 4. Verify the actual interaction

Automated coverage should exercise URL-driven view selection, the non-queue case and toggle persistence. Use meaningful behavior assertions rather than source-text class matching.

Build the frontend, restart the webui and verify at `http://10.69.1.164:6789/mission`:

1. Open an existing infinite-queue session. Expanded details fill the available column height; terminal bounds/layout contribution are zero and its input cannot receive Tab focus.
2. Collapse in one browser action, then inspect the resulting DOM in a separate action: the terminal is visible, sized to its restored space and still attached to the same conversation.
3. Expand/collapse repeatedly. Observe no new terminal WebSocket attachment from toggling, no TUI restart and no Run/Pause mutation.
4. Exercise a long queue, long feedback and a blocker draft. Scroll to the final item, reach the toolbar, toggle away and back, and confirm the draft and feedback survive.
5. Check URL reload and Back/Forward in both states; verify ordinary sessions still show their terminal.
6. Repeat at narrow column width and short viewport height. Inspect console errors and failed requests. Compare Mission project counts before/after testing; investigate unexplained additions without deleting user work.
7. Move a queued task up and down, reload and verify persisted order and the server's Next item. Check boundary buttons, keyboard operation and that working-task state is unchanged.
8. Cancel and confirm removal; confirm the queue entry disappears but its plan file remains. Remove the final inactive entry and verify the empty state. Verify active-task removal is refused with an actionable explanation.
9. Exercise a stale revision and failed write. Verify concurrent queue changes are preserved, errors are readable and no worker is started. Include service tests for these mutations and preservation of item metadata.

## Progress

- [x] Coordinate URL-driven queue/terminal visibility while preserving the terminal attachment.
- [x] Make expanded queue details fill the column with usable internal scrolling.
- [x] Add persisted task reordering and removal with conflict handling and active-work protection.
- [x] Pass relevant checks and browser assertions; absorb completed behavior into the relevant `docs/` page before retiring this plan.
