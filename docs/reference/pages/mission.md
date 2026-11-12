# Mission Page

The Mission page (`/mission`) is the shared workplace for the human and the coding agents: a
three-column workspace of projects, their sessions, and the open session's live agent TUI. This
page covers what the page shows and does, the client store contracts behind it, and the terminal
rules it relies on. Queue and runner behavior is in
[Mission Queue and Runner](../backend/mission-queue.md); URL state is in
[URL Navigation](../components/navigation.md).

> Last updated: 2026-11-12

## The Model

### Projects and Sessions

| Concept | What it is | Stored in |
|---|---|---|
| Project | A PAD plus a container folder. Many per PAD, one per folder | `mission_projects` |
| Session | The only unit of work: a live agent TUI that the human and the agent both type into and watch | `mission_sessions` row + its `msn-*` tmux session |

- **A project is exactly (PAD, folder).** There is no uniqueness constraint on that pair: two
  projects on one PAD and folder are allowed, and the project dialog only warns about a duplicate.
- **`folder` is a container path.** The TUI runs inside the PAD, so only a path the PAD itself
  sees is valid. The page does not add mounts; that is Settings → Extra volumes plus a recreate.
  A folder the PAD cannot see is refused with `mission_folder_missing` before any row or tmux
  session exists, because `tmux new-session -c <missing>` silently starts in the parent folder.
- **`agent_type` is stored on the project**, not derived, so changing a PAD later cannot repoint
  a project at a different CLI.
- **Only the coding agents take part**: opencode, codex and claude. Eligibility is the driver flag
  `mission: { supported: true }`; the project dialog, the REST routes and the MCP tools all read
  that one field. A route that resolves a non-coding agent answers
  `400 mission_unsupported_agent`, so a client cannot walk around the picker.

### The Same Flow for Human and Agent

```text
1. an agent must exist          human: /agents/create      agent: create_agent
2. a project = agent + folder   human: + New project       agent: mission_project_create
3. a session opens the TUI      human: + New session       agent: mission_session_start
4. work happens in a session    human: types               agent: mission_send
```

There is no fifth step: no work is started outside the human's view. Both sides read the same
session list, an agent reads a session's screen tail through `mission_sessions`, and a session an
agent started is an ordinary row one click from being watched. tmux mirrors one session to every
attached client, so two writers are visible to each other rather than engineered around.

The one privacy control is the per-session **solo lock** (`mission_sessions.locked`). It makes
`mission_send` refuse that session; the agent can still read it. It is a row flag, so it survives
a restart, and col 3 shows a `solo` badge (`msn-badge-solo`) while it is set. Grants, error codes
and the full `mission_*` tool contract are in
[Backend Services → MCP Tools](../backend/services.md#mcp-tools-mcpjs--mcp).

### Launching the TUI

The TUI command is always server-side, from the driver's `tuiLaunch`, never from client text:

| Type | `fresh` | `resume` | `continueLatest` |
|---|---|---|---|
| opencode | `opencode` | `opencode -s <id>` | `opencode -c` |
| codex | `codex -C <cwd>` | `codex resume <id>` | `codex resume --last` |
| claude | `claude --session-id <id>` | `claude -r <id>` | `claude -c` |

A fresh start must not leave the row without a conversation id, or the runner cannot find its
transcript. opencode creates its conversation through its server first and launches into it;
claude has the id **minted** (`mintConversationId`, a UUID) and launched with
`tuiLaunch.freshWithId`. A claude transcript only exists once its first message is written, so a
relaunch or restart before that starts fresh under the same id; after it, or when the store
cannot be read, it resumes (`relaunchCommand`, `agentStore.hasConversation`).

codex has no flag to choose an id and writes its rollout only on the first message, so a fresh
codex row starts id-less and **adopts** its conversation later (`sessions.tryAdoptConversation`,
write-once, audited as `session_conversation_adopted`). The candidate is a rollout whose
`session_meta.cwd` is the project folder, that started at or after the row (5 s slack), and whose
id no other Mission row on the PAD owns. Exactly one candidate is adopted; none or several leave
the row alone. The runner's dispatch gate runs this before refusing an id-less worker — see
[Mission Queue and Runner](../backend/mission-queue.md#worker-observation-by-driver).

A session start creates the `msn-<8 hex>` tmux session with `-c <project folder>`, types the
command with `send-keys`, and inserts the row. A resume stores the source conversation in
`mission_sessions.agent_session_id`. The history listing reads each agent's own store (opencode's
`opencode.db`, codex rollout files, claude's `projects/*.jsonl`) rather than the CLIs, because
opencode's `session list` blocks behind a running TUI.

## Layout

File: `pages/Mission.jsx`, with `components/SessionList.jsx` (col 2),
`components/MissionSessionView.jsx` (col 3), `components/ProjectDialog.jsx`,
`components/Splitter.jsx`, `components/OverlayScroll.jsx` and `stores/mission.js` (zustand,
split into `stores/mission/*.js` slices).

```text
┌ col 1: Projects ┬ col 2: Sessions ─┬ col 3: open session ─────────────┐
│ + New project ‹ │ [+ New session|▾]│ header: dot · project · title    │
│ paddock         │ Sessions (N)     │ queue panel (infinite sessions)  │
│  pad · /www2/…  │ ● conversation   │ terminal (agent TUI)             │
│  2 live · 9     │   conversation   │                                  │
└─────────────────┴──────────────────┴──────────────────────────────────┘
```

- **Full page, no page-wide header.** Each create action sits in its own column toolbar
  (`+ New project` in col 1, the new-session split button in col 2).
- **Resizable columns.** Defaults are 260px, 220px and the rest. Col 2's floor is 180px; col 1 and
  col 2 are capped at 45% and 40% of the row. Widths persist in `pad-mission-col1` and
  `pad-mission-col2`; double-click a divider to reset; `←`/`→` nudge by 16px when focused.
- **Col 1 folds into a 56px avatar rail.** `COL1_MIN = 200` is the hinge: dragging the divider
  under 200px snaps to the rail, dragging the rail out to 200px reopens it. The chevron
  (`‹`/`›`, a 14px stroked SVG) does the same in one click. `Splitter` is given `min={RAIL_W}` so it reports
  widths under 200px and the parent decides what they mean, and `openAt={COL1_MIN}` so the first
  keyboard press from the rail jumps to an open width. The divider stays mounted in both states.
  The rail shows each project as a 32px circle with the first two letters of its name; edit and
  delete need the full row. The folded state persists in `pad-mission-col1-collapsed`.
- **Narrow windows fold col 1 automatically** below 1024px (`NARROW_MAX`, read from
  `window.innerWidth` on `resize`), giving the width to the terminal. An explicit open sets
  `narrowOverride` so the fold does not spring back; crossing the breakpoint clears it.
- **Folding moves nothing.** One 12px gutter (`(56 - 32) / 2`) holds for the toolbar, rows, rail
  avatars and rail head, so the chevron sits on the same pixels folded and open.
- **Floating scrollbars.** Both listings use `OverlayScroll`: the native bar is off
  (`scrollbar-width: none`, 0px reserved) and a 6px thumb is drawn over the content while hovered,
  dragged, or for 900ms after a scroll. It listens with a native `scroll` listener, because scroll
  does not bubble to React's delegated `onScroll`.

## Element Hooks

Every element carries a stable `msn-*` class so a UI instruction can name the exact element
(for example `.msn-project-row .msn-btn-delete`). The classes carry no styles.

| Area | Hooks |
|---|---|
| Shell | `msn-page` `msn-cols` `msn-col-shell` `msn-splitter` `msn-splitter-1` `msn-splitter-2` |
| Any column | `msn-col` `msn-col-toolbar` `msn-col-header` `msn-col-title` `msn-col-count` `msn-col-body` `msn-empty` `msn-empty-title` `msn-empty-text` `msn-error-bar` |
| Col 1 | `msn-col-projects` `msn-project-row` (+`msn-row-selected`) `msn-project-name` `msn-badge-folder-missing` `msn-project-meta` `msn-project-counts` `msn-live-dot` `msn-project-actions` `msn-btn-new-project` `msn-btn-edit` `msn-btn-delete` `msn-btn-retry` `msn-btn-collapse` |
| Col 1 rail | `msn-col-projects-rail` `msn-col-rail` `msn-rail-head` `msn-rail-body` `msn-rail-btn` `msn-avatar` `msn-avatar-on` `msn-btn-expand` `msn-btn-new-project-mini` |
| Col 2 | `msn-col-sessions` `msn-sessions` `msn-sessions-body` `msn-new-split` `msn-btn-new-session` `msn-btn-new-caret` `msn-new-menu` `msn-new-menu-infinite` `msn-project-folder` `msn-btn-subfolders` `msn-cap-note` `msn-group-sessions` `msn-group-count` `msn-dot-legend` `msn-history-errors` `msn-history-error` |
| Col 2 rows | `msn-row-slot` `msn-session-row` (+`msn-row-selected`, `msn-row-shell`, `msn-row-infinite`) `msn-session-dot` `msn-session-label` `msn-session-id` `msn-row-project` `msn-row-actions` `msn-btn-popout` `msn-btn-lock` `msn-btn-runner-config` `msn-btn-runnerify` `msn-btn-close` `msn-history-row` `msn-history-title` `msn-history-meta` `msn-history-hint` |
| Col 3 | `msn-col-agent` `msn-session-view` `msn-agent-header` `msn-agent-dot` `msn-agent-project` `msn-agent-label` `msn-agent-cwd` `msn-agent-actions` `msn-badge-solo` `msn-btn-relaunch` `msn-btn-restart` `msn-col3-body` `msn-queue-split` `msn-queue-splitter` `msn-terminal-view` `msn-terminal-wrap` `msn-terminal` |
| Queue panel | `msn-queue-panel` `msn-queue-header` `msn-queue-toggle` `msn-queue-state` `msn-queue-counts` `msn-runner-status-strip` `msn-runner-tabs` `msn-queue-actions` `msn-queue-body` `msn-queue-feedback` `msn-queue-progress` `msn-queue-items` `msn-queue-item` `msn-queue-item-open` `msn-btn-queue-up` `msn-btn-queue-down` `msn-btn-queue-remove` `msn-queue-path` |
| Project dialog | `msn-dialog` `msn-dialog-form` `msn-field-name` `msn-field-agent` `msn-field-folder` `msn-field-plans-folder` `msn-input-name` `msn-input-folder` `msn-input-plans-folder` `msn-agent-option` (+`msn-selected`) `msn-stopped-note` `msn-no-agent` `msn-link-create-agent` `msn-folder-chips` `msn-folder-chip` `msn-suggestions` `msn-suggestion-chip` `msn-folder-status` (+`msn-ok`/`msn-warn`) `msn-plans-folder-status` `msn-dup-warning` `msn-btn-submit` `msn-btn-cancel` |

`QueuePanel.jsx` carries more `msn-queue-*` hooks for blockers, repair and reconcile states; grep
the file for the full set.

## Column 1: Projects

A project row shows the name, `<PAD> · <folder>`, and `N live · M sessions` with a live dot.
Projects are re-read on the 15s poll, so one created in another tab appears.

A **folder missing** badge (`msn-badge-folder-missing`, tooltip naming the folder and PAD) marks a
project whose folder no longer exists inside its PAD. `GET /api/mission/projects` stamps
`folderExists` through `mission.withFolderState`: one `pad-tmux.foldersExist` exec per PAD (not
per project), cached for 15 seconds. The field is `true` or `false` only when the PAD answered; a
stopped PAD or a failed exec leaves it off, and the page draws nothing for an absent field —
"could not ask" is not "missing". A session start still checks the folder itself and refuses with
`mission_folder_missing`.

### Project Dialog

- **Agent** — chips for running coding agents only. Stopped ones are counted
  (`N stopped — start one to open a session`); non-coding agents are not listed. With no coding
  agent, the dialog shows **Create an agent first** linking to `/agents/create`. The agent cannot
  change on edit.
- **Folder** — prefilled from the agent's `workspace_dir`, probed inside the PAD through
  `GET /api/agents/:name/mission-folders?path=…` (debounced): "Openable in this PAD." or
  "Not found inside the PAD — mount it in Settings → Extra volumes, or pick a path the PAD already sees."
  Chips offer child folders, `..`, and the folders the PAD can already see (its workspace and
  extra-volume mounts).
- **Plans folder** — a relative folder inside the project folder, default `plans`. Absolute paths
  and `..` are refused in the dialog and again on the server (`mission_bad_plans_folder`). See
  [Per-Project Plans Folder](#per-project-plans-folder).
- **Duplicate warning** — shown when this PAD already has a project on that folder; saving stays
  allowed.

Deleting a project uses the shared `useConfirm()` dialog. The route closes every session of the
project (pane killed, row deleted) before deleting the project row.

## Column 2: Sessions

### Selection Is the Scope

There is no scope toggle. `selectedProjectId` `''` means all projects (the aggregate reads
`GET /api/mission/sessions` and `GET /api/mission/history`); a project id means that project.
The list is never auto-narrowed to the first project, and clicking the selected project again
deselects to the all view. In the all view each row carries its project name
(`msn-row-project`).

Every refetch path branches on `!selectedProjectId`: a selected project's refresh must never
route into the aggregate read, or a poll would drop the column back to all projects.
`followSessionPatch` and `selectSession` never move `selectedProjectId`.

### One List of Conversations

Col 2 is one sticky `Sessions (N)` header (`msn-group-sessions`) over one merged list: live
mission sessions and the agent's own past conversations in the folder, newest activity first
(`last_seen_at || created_at` for a live row, `updatedAt` for a history row). Order is by recency,
never by state, so a row does not jump when its dot lights.

**A row is a conversation, and its identity is `agent_session_id`.** A resumed conversation exists
both as a live row and as a history row; history rows whose id is a live row's
`agent_session_id` are dropped. Both kinds are named by the agent's own title for the
conversation (`title`, from the same store read that answers `busy`), falling back to the label
and then the tmux id for a conversation the agent has not titled yet. Closing a session's pane
therefore leaves the same name in place: the item turns into its history row, still highlighted.

Subfolder conversations are included with `subfolders=1` (`msn-btn-subfolders`); the server caps
the history read at 200 and the column says when it is showing only the most recent
(`msn-cap-note`).

### Highlight

The highlight is `selectedConversationId`: the conversation the user opened. It is written only by
`selectSession` (a row click), `startSession`, and an accepted URL restoration. Every fetch and
the 15s poll only carry it forward, so a fresh page with nothing opened has zero
`.msn-row-selected` rows while col 3 shows its empty state ("No session selected" or "No project
selected"). It is cleared only when the list
it belongs to is replaced (`select`, `createProject`, `deleteProject`), never by
`closeSession`.

### The Dot

The green dot is mounted only when the server says `open`: a live pane running the agent TUI,
idle or mid-turn. A live pane whose agent exited shows the word `shell` (`msn-row-shell`) and no
dot, because typing there runs shell commands. A history row is `open` when its conversation is
busy or resumed into a live session. Whenever one row carries a dot, the sticky header shows a
`● open` legend (`msn-dot-legend`). `sessionOpen()` in `SessionList.jsx` is the one derivation
for the row and the legend. How `live`, `open` and `busy` are computed is in
[Backend Services → Liveness truth](../backend/services.md#liveness-truth-plan-62).

No user-visible text names tmux, a pane or an attach. A missing pane is a closed session.

### Rows and Actions

A row is two lines. Line 1 is the name alone, at the full row width. Line 2 holds the dot, the
project name in the all view, and the time flush right.

Hover actions (`msn-row-actions`: pop out, solo lock, runner, close) exist only on an `open`
row. They are `absolute` and `opacity-0` until the row is hovered or a button inside it has focus,
so they reserve no space and stay keyboard-reachable; the time fades out beneath them. The hidden
buttons are `pointer-events-none`, so a click on the time selects the row instead of landing on
an invisible Close. The lock and close icons are identical 16px boxes with 12px stroked SVGs.

- **Close** asks through the shared `useConfirm()` dialog, then `DELETE /api/mission/sessions/:id`
  kills the pane and deletes the row. The conversation remains as its history row. A failed
  close leaves the session open with the error shown.
- **A history row opens on a click anywhere** (`role="button"`, Enter or Space). The corner hint
  `msn-history-hint` reads `opening…` only while that row's start is in flight.
- **A history row resumes in its own project**, never the col-1 project.

### Starting a Session

`[ + New session | ▾ ]` is one split control (`SessionCreateSplit.jsx`). The left half starts an
ordinary session in the selected project; the chevron opens a menu whose only item is
`∞ New infinite session`, which opens the runner create popup. The menu's open state is local so
a poll re-render does not close it; it closes on `Esc`, an outside `mousedown`, focus leaving, or
selection. With no project selected both halves are disabled ("Pick a project first").

Busy state is per action: `startingKey` (project id plus conversation key, or `new:<projectId>`)
lights only the row or button that was clicked, and disables both halves of the split control
while an ordinary start is in flight. `startSession` refuses a repeat of the same key, because a
double-click once started two TUIs on one conversation; a monotonic token stops an older request
from resetting a newer one's selection when it resolves late.

### History Errors

A per-project history read that fails (for example "agent is not running") shows in a band above
the scroller (`msn-history-errors`), not in the list. `lib/error-text.translateHistoryError`
turns the raw reason into a sentence; the raw string stays in the row's `title`.

## Column 3: The Open Session

### Pinned to `openSession`

Col 3 renders from `openSession`, a snapshot of the row taken when it was opened
(`id`, `tmux_id`, `label`, `title`, `agentSessionId`, `locked`, `live`, `projectId`,
`projectName`, `agentName`, `folder`), never from a lookup in col 2's list. A list that is
refetched is emptied for a moment, and a column derived from it would unmount the terminal, close its
WebSocket and re-attach for the same conversation.

- **Written by two user actions**: `selectSession` and `startSession`, plus URL restoration.
  **Cleared by** `closeSession` (when it is the open session) and `detachSession` (the pop-out
  hand-off). Nothing that only changes which rows are listed may write it.
- **Refreshes update display fields only** (`label`, `locked`, `title`, liveness); they never
  change which session is open.
- **The project handed to the terminal comes from `openSession.projectId`**, not
  `selectedProjectId`. Switching projects in col 1 clears the highlight but keeps the terminal
  running; that is the one state where col 3 shows a conversation col 2 does not highlight.
- **If the open row vanishes** (closed in another tab, project deleted), col 3 keeps the session
  and shows the closed state instead of re-pointing at a neighbor.
- **`sessionState` is keyed to `openSession.id`**, so a poll does not flicker the header.
- **`startSession` re-reads pane state right after setting `openSession`**: the snapshot is taken
  before the TUI has painted, and a snapshot alone would render a new session as closed.

The view (`selectedProjectId`, `selectedConversationId`, `openSession`) persists to
`localStorage['pad-mission-view']` on every change and is validated on load: a project that no
longer exists becomes `''`, an `openSession` whose project is gone becomes `null`, a corrupt blob
is ignored. `openSession` is stored as `null`, never an absent key. How URL state and this
preference combine is in
[URL Navigation → Mission Restoration](../components/navigation.md#mission-restoration).

### Session States

`MissionSessionView.jsx` is the one session view, used by col 3 and by the pop-out window. Its
header shows the live dot, project, title (runner name, conversation title, label, then tmux
id), cwd and the solo badge, plus `RunnerControls` for an infinite session.

| State | Shows |
|---|---|
| Pane not yet verified | "Checking session…"; the terminal attaches only after the pane read |
| Live, agent running | The terminal |
| Live, agent exited | The terminal (a shell) and **Relaunch TUI**, which types the driver's `fresh` command into the same tmux session |
| Pane gone | "This session is closed" and **Reopen this conversation**, which restarts the same `tmux_id` with the same `agent_session_id` in the project folder |
| Reopening | "Reopening…" |

**Opening a closed session reopens it.** When an open the user just made reads `live: false`,
`fetchSessionState(id, { autoReopen: true })` calls `restart(id)` once. This starts the agent
again in that conversation, so it can spend tokens without a prompt; the opt-in is the user's
open action, never a poll, so a pane that dies while you watch it shows the closed state and the
button. `reopenFor` is the in-flight guard (one reopen per open). The pane is re-read before
`reopenFor` is cleared, and that read is awaited: clearing first flashes the closed state on the
success path. `reopenError` renders beside the Reopen button, which is the manual retry.
`src/test/mission-reopen.test.js` holds this ordering as a predicate over the whole sequence of
store states.

### Queue Panel

An infinite-runner session renders `QueuePanel` between the header and the terminal. Its one
header row (`msn-queue-header`) holds the collapse toggle, state chip, done count, the live
worker/scheduler line (`msn-runner-status-strip`), the Plans / History tabs
(`msn-runner-tabs`, only while open) and the queue actions. **Run queue** in the session header
(`msn-btn-runner-toggle`) is the primary action; the header's own state chip is
screen-reader-only because the queue row shows the same word. The expanded Plans view is a
width-capped column: a progress bar (`msn-queue-progress`), Current/Next while there is one, and
the items in persisted queue order (`msn-queue-item-index`, status chip, title over path, icon
actions). The title over path (`msn-queue-item-open`) opens that plan file in the shared
[File Viewer](../components/file-viewer.md) as popup `plan-file:<runnerId>:<path>`, editable,
with a save that refuses to overwrite an edit the agent made meanwhile
([Plan File](../backend/mission-queue.md#plan-file)).

- **Open, the queue and the terminal split the column.** `queue=open` or no `queue` parameter
  means open; `queue=closed` means collapsed. Open, the queue (`msn-queue-split`) sits above a
  draggable divider (`msn-queue-splitter`, the shared `Splitter` with `axis="y"`: drag, ↑/↓ by
  16px, shift for 64px) and the terminal fills the rest, re-fitting through its ResizeObserver.
  The queue's height is stored per browser in `localStorage['pad-mission-queue-split-h']`
  (default 45% of the space below the header); it is at least 120px, and CSS keeps the terminal
  at least 120px however tall the stored height is. Queue, divider and terminal share one body
  box (`msn-col3-body`), so the limits are measured against the space they divide. Collapsed,
  only the queue's header row sits above the terminal. The queue keeps one wrapper in both
  states, so toggling never remounts it. (The open queue used to REPLACE the terminal, hidden but
  mounted; that toggle is gone.)
- **A queue that needs repair stays open** and gets the split even while the URL says closed (`QueuePanel` reports its real state through `onOpenChange`; `repairRequired`: a non-`ok` queue condition, or
  an execution state of `projection_error`, `awaiting_receipt` or `held`), so collapse cannot hide
  the only evidence needed to fix it.
- **Feedback lives in the panel.** Queue actions write one per-runner `operationFeedback` record
  (severity plus message) in the store, rendered as `msn-queue-feedback` with **Dismiss**,
  wrapped in full. The feedback and the queue warnings (`msn-queue-warning`, e.g. more than one
  plan in progress) are one block: at the top of the body while expanded, and directly under the
  header row (`msn-queue-notices-collapsed`) while collapsed, so collapsing never hides an
  unresolved warning. `RunnerControls` holds controls only. A
  revision conflict reads "The queue changed elsewhere — reload and retry" with **Reload queue**.
  An awaiting-receipt delivery offers **Reconcile** ("No resend will be made"), never a blind
  resend.
- **Rows can be reordered and removed.** Each item has Move up, Move down and Remove buttons named
  for the task; movement is disabled at the ends. A move sends the whole id order with the queue
  revision. Remove asks through `useConfirm()` ("This removes it from the queue only. Its plan
  file stays in place.") and is refused for an `in progress` item. Whether an edit is allowed
  comes from the server's action verdicts, not the client.
- The terminal never pushes a size below 40x8 to the PAD, so the queue cannot shrink the worker's
  pane. While a queue is active, the page re-reads it every 3s.

`runnerTab=history` shows the runner's event journal without remounting the terminal; at narrow
widths it overlays the Mission columns while the terminal stays mounted. See
[Runner History](../components/runner-history.md). The queue's states, verdicts, delivery
guarantees and routes are in [Mission Queue and Runner](../backend/mission-queue.md).

## Pop-Out Window

The row's pop-out button (`msn-btn-popout`) opens that session in its own browser window at
`/mission/session/:sessionId` (`pages/MissionSessionPopout.jsx`): the same
`MissionSessionView`, without app navigation or the Mission listings. The route is
authenticated and resolves the session's project from the session itself, so a copied URL or a
reload works without the opener.

- **Opening** (`lib/mission-popout.js`) calls `window.open` synchronously from the click, with a
  per-session window name (`paddock-mission-session-<id>`). Clicking again for a session whose
  window is open focuses it instead of opening a second one.
- **Hand-off.** The popup posts `paddock:mission-popout-ready` (or `…-failed` with a message) to
  the same origin once it has resolved the session; the opener accepts only messages from that
  window for that session id. Only on ready does the opener call `detachSession(id)`, which clears
  the embedded view if it is that session and touches nothing else: no close, pause or restart, no
  row removed. A different embedded session stays. A blocked popup, a failure, or no answer within
  10 seconds shows a toast and leaves the embedded view in place.
- **Reopen policy.** Opening the window opts into the dead-pane reopen; reloading it does not.
- **Geometry.** The popup saves `outerWidth`, `outerHeight`, `screenX` and `screenY` every second,
  on `resize` and on `pagehide`, to `localStorage['pad-mission-popout-v1:<userId>']`. One record
  is shared by all session popouts. On open, non-finite values fall back to 980x720 at (80, 60);
  width and height are floored at 480 and 360. The result is then fitted to the opener's screen
  (`screen.availLeft/availTop/availWidth/availHeight`): a size larger than the screen shrinks to
  it, and a position that would leave part of the window off it moves back on. A negative origin
  is kept when that display really starts there (a monitor left of or above the primary); one
  saved on a monitor that is no longer attached is pulled onto the current screen. With no
  readable screen the saved bounds are used as they are.

## Mission Terminal Contract

Col 3 is the shared `components/Terminal.jsx` with `sessionId` (pins the tmux session) and
`showSessions={false}` (hides the tab strip). See [Terminal](../tabs/terminal.md) for the general
contract. Mission sessions differ in these ways:

- **Multi-client.** `msn-*` sessions are exempt from the single-client takeover rule, so two tabs,
  the agent-detail terminal strip and a pop-out can attach at once without kicking each other.
- **A closed session is refused, not resurrected.** An attach whose `msn-*` id has no row closes
  with code `4003` ("mission session closed"), and the client stops. `4002` means "PAD stopped"
  and is retried, which turned one Close into a refusal storm.
- **No lazy tmux create.** Mission created the tmux session itself, so its attach skips
  `ensureTmuxSession`; re-creating it would bring a dead pane back as a bare shell.
- **Swapping sessions** sends `history=0` (no scrollback replay into a buffer about to be
  repainted) and resets the reused xterm, so the outgoing session's screen never shows under the
  new name.
- **Attach clients are tracked by PID.** Each Mission attach writes
  `/tmp/paddock-at-<boot token>-<conn>.pid`; cleanup kills its own client after checking
  `/proc/<pid>/cmdline`, and the first attach after a webui restart sweeps files from the previous
  boot token. This reaps attaches a restart orphaned without touching a human's own `tmux attach`.
- **`escape-time 10`.** `pad-tmux.js` sets it as a PAD-global option when it creates a session,
  so a quick ESC is not held 500ms by tmux. Check it with `tmux show-options -gv escape-time`;
  `show-options -g` does not list it.

## Per-Project Plans Folder

Each project has a `plans_folder` (default `plans`), a relative folder inside the project folder.
Its plans live at `<project.folder>/<plans_folder>/`. Creating a project (REST or
`mission_project_create`) initializes that folder and writes its `INDEX.md` entry file once; the
create response carries `plansInit` with what happened, and an initialization failure does not
fail the create. Changing the plans folder points future reads and writes at the new folder; it
does not move existing files. Resolution, statuses and the MCP scope rules are in
[Backend Services → Plans](../backend/services.md#plans-servicesplansjs--plan-64).

## Routes

| Method | Route | Does |
|---|---|---|
| GET | `/api/mission/projects` | Projects the caller may see, with session and live counts |
| POST | `/api/mission/projects` | Create a project (`name`, `agent`, `folder`, `plansFolder`); returns `{ project, plansInit }` |
| GET, PATCH, DELETE | `/api/mission/projects/:id` | Read, rename or repoint (`name`, `folder`, `plansFolder`), delete with its sessions |
| GET | `/api/mission/projects/:id/sessions` | That project's sessions with liveness |
| GET | `/api/mission/projects/:id/history` | The agent's own conversations in the folder (`subfolders=1`) |
| POST | `/api/mission/projects/:id/sessions` | Start a session (fresh, or resume with `agentSessionId`) |
| GET | `/api/mission/projects/:id/conversations/:conversationId` | Saved-conversation metadata for a history-only link |
| GET | `/api/mission/sessions`, `/api/mission/history` | The all-projects aggregates |
| GET | `/api/mission/sessions/:id` | One session with pane state |
| POST | `/api/mission/sessions/:id/send`, `/permission`, `/relaunch`, `/restart` | Send text, answer a permission prompt, relaunch the TUI, restart a gone pane |
| PATCH, DELETE | `/api/mission/sessions/:id` | Relabel or toggle `locked`; close (kill pane, delete row) |
| GET | `/api/agents/:name/mission-folders?path=` | Probe a container path for the project dialog |

Every mutating route is CSRF-checked and resolves the PAD from the project row before the access
check. Runner routes are in
[Mission Queue and Runner](../backend/mission-queue.md#runner-rest-surface).

## Not Built

- Plan 53's `mission_notes` / `mission_checklist` tables: superseded by plan files
  ([Backend Services → Plans](../backend/services.md#plans-servicesplansjs--plan-64)).
- The original busy probe through opencode's `GET /session/status`: replaced by per-conversation
  store reads, because the web server only reports conversations its own process drives.

## See Also

- [Pages](overview.md)
- [URL Navigation](../components/navigation.md)
- [Mission Queue and Runner](../backend/mission-queue.md)
- [Runner History](../components/runner-history.md)
- [Backend Services](../backend/services.md) — Mission service layout, Plans, MCP tools, liveness
- [Terminal](../tabs/terminal.md)
- [Client Conventions](../components/client-conventions.md)
