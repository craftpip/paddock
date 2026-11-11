# Pages

> Last updated: 2026-11-12

All pages are React components served from `src/client/src/pages/`. The built SPA lives at `src/public/` and is served by Express at the root path.

## Login (`/login`)

File: `Login.jsx`

Simple login form with username + password input. Submit calls `POST /api/login`. On success redirects to `/agents`. On error shows error message. With `AUTO_LOGIN=true` (default) the app skips login entirely.

## Profile (`/profile`)

File: `Profile.jsx`

Three cards: **Email**, **Change Password**, and **API Keys**.

### API Keys card

Per-user bearer keys for the paddock MCP server (`/mcp`). Keys inherit the
user's webui role (admin → full fleet, user → owned agents only). See
`backend/services.md` — API Keys and `overview/business-logic.md` — Paddock MCP
Server Auth.

- **Create**: inline form (name input + Create). On success a modal shows the
  raw key **once** with a Copy button, plus copy-ready client configs (opencode
  / Claude Code snippets with the real key filled in).
- **List**: table of prefix (`pk_live_…`), name, created, last used (or
  "never"), Revoke button.
- **Revoke**: `DELETE /api/profile/keys/:id` (owner-scoped, confirm()).
  Instant — the hash lookup fails on the next `/mcp` request.

API: `GET/POST /api/profile/keys`, `DELETE /api/profile/keys/:id`
(session + CSRF protected; always scoped to the caller's own keys).

## Dashboard (`/agents`)

File: `Dashboard.jsx`

Fleet view showing all discovered PADs as cards. Features:
- Agent cards with name, status badge (running/stopped/transition), avatar initial
- Start/Stop/Restart inline buttons
- Search/filter by name or display name
- Loading skeleton, empty state

## UI Enhancements

Implemented enhancements for user experience and functionality:

### Agent Detail Page

- **Tab loading states** — each tab shows a proper skeleton/spinner while loading, not a blank flash.
- **Sticky tab bar** — when scrolling down on a tab with lots of content, the tab bar stays visible at the top.
- **Resource stats placeholder** — CPU and MEM lines show `—%` / `—` placeholders while loading.
- **Tab order** — Commands (default), then Workspace/Config/Web & Ports/Logs/Activity, then Settings. The old Sessions tab is removed.

### Workspace Tab

- **Drag & drop upload** — drag zone implemented.
- **File preview for images** — png/jpg/gif/svg/webp render inline in the file modal.
- **Search within workspace** — file name filter bar added.

### Consistent Page Layout

- **Vault page** — `max-w-7xl mx-auto px-4 sm:px-6 py-8` wrapper added.
- **Global Backups page** — same wrapper added.
- **Create Agent page** — `py-8` added to existing `max-w-xl mx-auto`.

### Dashboard / Fleet View

- **Fleet Resources bar always visible** — always rendered with `—%` / `—` placeholders.
- **Mem total instead of Mem avg** — total memory summed from all containers in human-readable format.

### Terminal Tab

- **Copy on select** — `copyOnSelect: true` option set.

### Config Tab

- **Search within config** — search bar filters matching lines with count.

### Logs Tab

- **Auto-scroll lock** — toggle already existed.

### General

Shared promise-based dialogs (`confirm`/`alert`/`prompt`), toasts, keyboard
shortcuts, and connection-lost handling live in
[`components/ux.md`](../components/ux.md).

## Create Agent (`/agents/create`)

File: `CreateAgent.jsx`

Form to create a new PAD. The visual core (plan 40 D9) is **name the agent +
pick the folder it will work on — that's it**; everything else sits under the
collapsed Optional settings accordion:

```
┌─────────────────────────────────────────────────────┐
│  ← Back to fleet                                    │
│                                                     │
│  Create Agent                                       │
│  Name your agent and pick the folder it will work   │
│  on — everything else is optional and can be        │
│  changed later.                                     │
│                                                     │
│  pad-  [openclaw ▼]  -  [my-PAD                ]    │
│                                                     │
│  Workspace source folder (host)  [ /www2/…     ▼ ]  │
│  This folder is where your agent's files live on    │
│  this PC — open it directly from your file manager. │
│  ⚠ 3 volumes found in mempalace's compose file —    │
│    pre-filled under Optional settings → Additional  │
│    volumes. Review, edit or remove them.            │
│                                                     │
│  ▼ Optional settings   (3 active)                   │
│    ┌ Container-side workspace path ────────────────┐ │
│    ┌ Container options (docker toggle, network ▼) ─┐ │
│    ┌ Additional volumes (+ Add volume rows) ───────┐ │
│    ┌ Additional ports (+ Add port rows) ───────────┐ │
│                                                     │
│  [ Create my agent                             ]    │
└─────────────────────────────────────────────────────┘
```

- **Identity row** — Prefix (from `CONTAINER_PREFIX`, e.g. `pad`), PAD type
  dropdown (openclaw/opencode/picoclaw/hermes/codex/claude), name input (alphanumeric
  + hyphens). Always visible.
- **Workspace source folder (host)** — the primary field, always visible,
  **resolved to an absolute host path by default** (e.g.
  `/www2/paddock/instances/pad-openclaw-mya/openclaw/workspace`, updating live
  as name/type/prefix change) so the user always sees the concrete path. It
  carries the plan-40 plumbing:
  - **Path autocomplete** — typing triggers `GET /api/paths/autocomplete`
    (debounced ~220 ms); suggestions are the hidden-filtered subdirectories of
    the typed prefix, pickable by keyboard or mouse, with a stale-response
    guard.
  - **Probe + discovery** — once the path settles (~550 ms) the form calls
    `GET /api/paths/probe` (exists/writable/compose detection) and, when a
    compose file exists, `GET /api/paths/volumes`.
  - **Pre-fill banner** — "N volumes found in &lt;project&gt;'s compose file —
    pre-filled under Optional settings → Additional volumes. Review, edit or
    remove them before creating." The discovered volumes pre-fill the
    **Additional volumes** rows (D4: a convenience, never a forced value —
    every row stays an editable input).
  - Gated by the driver's `workspaceCapability`: section hidden for `none`
    (hermes); probe + autocomplete for `fixed` (openclaw, picoclaw) and
    `editable` (opencode, codex, claude).
- **Optional settings** (collapsed by default; the badge shows how many active
  pre-filled/edited options):
  1. **Container-side workspace path** — plain input; disabled (locked to the
     driver's `workspaceDir`) for `fixed`-capability agents, editable for
     `editable` ones.
  2. **Container options** — "Allow docker in the container" toggle (docker.sock
     + CLI, rebuilds the image at create) and a Network dropdown of running
     containers (peer routing via `network_mode: container:`), plus the
     **Container user** segmented control (Root / Local user, plan 43 Phase 7).
     Local user runs the agent daemon + terminal as the `pad` user
     (`PUID:PGID`) so every file the agent writes is user-owned on the host;
     it persists as `USER_MODE=user` in `meta.env` (see
     `tabs/settings.md`). The control is disabled for hermes (already runs as
     its own user).
  3. **Additional volumes** — dynamic rows, each with a **type select**
     (Bind / Named volume), source-or-name input, container path, and readonly
     checkbox. Named-volume rows hint at discovery: "Attaches the existing
     volume &lt;external&gt;" vs "Creates a fresh volume"; the name validator rejects
     bare host paths on named-volume rows.
  4. **Additional ports** — dynamic `host → container` TCP port rows.

The form validates client-side before enabling **Create my agent** (name,
volume/port fields). Submit posts all options
(`allowDocker`, `network`, `extraVolumes`, `extraPorts`, `workspace_host`,
`workspace_dir`) to `POST /api/agents/create`; the server pre-flights
everything (`vm.validateAgentCreate`: network peer exists+running, extra
volumes/ports, SSH container port if any, workspace mount, cross-agent
host-port sweep) and returns `400` before the `202` if any check fails —
nothing is created. OpenSSH exposure is **not** part of the create form; it is
configured afterwards from the agent's [Web & Ports tab](../tabs/web.md).

**Named-volume inheritance** (plan 40 D5): discovered named volumes pre-fill as
`{ type: 'volume', name, container, readonly, external }`; the generated
compose emits the service mount **and** a top-level `volumes:` section —
`external: true` when the volume exists (attach the project's real data), a
fresh-volume declaration when it doesn't (never-started projects work on first
up). Named-volume pre-fills are never auto-applied — review/edit/delete before
submit. **Bind pre-fills are one-to-one** (dev-environment rule): the
Container path field is auto-filled with the Host source path, so the agent
sees the same filesystem layout as the host — you never have to type a
container path for a bind.

**Creation flow (live streaming):**
1. Form submits via fetch — POST `/api/agents/create` returns `202` immediately and a background job starts
2. The form is replaced by a live log pane (the shared `Console.jsx` component) that streams the **real command output** over SSE — no fake spinner steps
3. Steps appear as labeled command lines as they start: **build** → **up** → **setup** (fresh OpenClaw/PicoClaw) → **done**
4. **Success:** banner + prominent "Go to Agents" button — no auto-navigation, so the user can scroll the logs
5. **Failure:** red banner + error tail in the log pane; "back to form" or retry — never navigates

The SSE stream reconnects with `Last-Event-ID` on drop; polling `/create-status` is the fallback.

**Post-create gotcha (plan 45 — path doubling):** the `dcCmdForPad` helper
translates the literal `/workspace` token into the agent-specific container path
(e.g. `/root/.openclaw/workspace`). A whole-token guard
(`(^|[^/.\w-])` prefix) prevents matching `/workspace` when it already sits
inside a translated path like `/root/.openclaw/workspace/app` — earlier versions
doubled the path on a second agent create against the same workspace. The
workspace probe also reverse-translates lifecycle commands back to `/workspace`
convention before writing the devcontainer mirror, so different agent types
probing the same workspace get correct, non-polluted pre-fills. Switching agent
types mid-form clears the cached lifecycle drafts and re-probes.

**What was removed:**
- No clone-from-backup dropdown (the generic backup system is gone)

## Agent Detail (`/agents/:id`)

File: `AgentDetail.jsx`

Layout shell with a top header bar, 7 mode tabs, and a docked terminal. See `tabs/`
docs for each mode.

Header:
- Agent avatar + name + display name
- Status badge with pulse animation for transitions
- Live CPU/MEM stats on running agents
- Start/Stop/Restart buttons

Modes are defined in the `MODES` array in AgentDetail.jsx:
| Mode | Component | Feature |
|------|-----------|---------|
| commands | CommandsPane.jsx | Command pill flow + Run TUI + Vault dropdown (default landing mode) |
| workspace | WorkspaceTab.jsx | File browser, editor, upload |
| config | ConfigTab.jsx | Editor for the driver's config file (openclaw.json / opencode.json / config.yaml / config.toml / settings.json) |
| web | WebTab.jsx | "Web & Ports" — publish the web app, expose SSH, map extra TCP ports |
| logs | LogsTab.jsx | Container logs viewer (persistent log store) |
| activity | ActivityTab.jsx | Event timeline |
| settings | SettingsTab.jsx | Recreate, health checkup, docker, network, workspace, volumes, build commands, dev container, delete |

Every mode component lives in `src/client/src/pages/agent/`, one file per tab. The cards of the
Settings tab are one file each under `pages/agent/settings/`.

The terminal is docked at the bottom of every mode — always mounted, one per
agent, auto-collapsed outside Commands. See [tabs/terminal.md](../tabs/terminal.md).

## Settings Tab (per-PAD)

Container-level operations on the agent detail page: recreate/update, health
checkup, docker access, network routing, workspace, volumes, build commands,
dev container sync, and delete. Runs as
SSE-streamed background jobs with a Console popup. See
[tabs/settings.md](../tabs/settings.md) for the full contract.

## Global Backups (`/backups`)

File: `GlobalBackups.jsx`

**Maintenance empty state** — the generic archive system was removed (2026-08-09);
the page shows "The generic archive system was removed. Native driver backups are
coming soon." Legacy archives stay in `backups/` but are not restorable until
plan 26 (native per-driver backup/import) lands.

## Vault (`/vault`)

File: `Vault.jsx`

Encrypted key-value store for secrets such as API keys and bot tokens. One flat list of
entries, each a Name, a Description and a Value. The page and its API are admin-only.

This section covers the page. Keys, encryption, the PIN operations, the wrong-PIN lockout, the
routes and the storage tables are in the [Vault reference](../backend/vault.md).

### How the Vault Works

- **Values are encrypted at rest** with AES-256-GCM and never stored in plain text. Names and
  descriptions are stored in the clear.
- **The server key** is `VAULT_KEY` when it is set; otherwise a random key is generated on first
  use and kept in `vault.key` beside the database. There is no built-in fallback value.
- **A PIN (4 or 6 digits) is optional.** With a PIN set, the key that encrypts the items is
  wrapped under both the PIN and the server key, so losing the server key loses the vault.
- **The vault is always locked.** There is no unlock or lock route: every add, edit, delete and
  paste supplies the PIN for that one operation.
- **List responses never carry a value.** `GET /api/vault/:id/decrypt` returns one, and takes the
  PIN in the `X-Vault-Pin` request header so that it is never part of a URL.
- **Five wrong PINs in a row lock the vault** for 30 seconds, doubling up to 15 minutes; the route
  answers `429` with `code: "vault_locked_out"`.
- **Changing the PIN keeps every item.** It needs the current PIN and the account password.
  Only the forgotten-PIN path erases the items; it needs the account password.

### Vault Page UI

- Table: Name | Description | Value | Updated | actions
- Value cell: always `••••••••••` with a small lock icon. The page never shows a stored value.
- A small `locked` pill in the header while a PIN is set, next to **Change PIN** (or **Set PIN**
  while none is set).
- **PIN on every action:** add, edit and delete ask for the PIN in a modal. A wrong PIN keeps the
  prompt open and shows the error in place.
- Add form: inline row above the table with Name (required), Description (optional) and Value
  (`type=password`, required).
- Edit: inline form with name and description filled in and the value blank ("leave blank to keep
  existing value").
- Delete: confirm dialog, then the PIN prompt, then `DELETE`.
- **Change PIN** asks for the current PIN, the new PIN and the account password. Its **Forgot the
  PIN?** link switches the dialog to "Erase the vault and set a new PIN", which states that every
  item is permanently erased before it asks for the password.
- **CommandsPane (agent detail):** the Vault dropdown shows a lock banner while a PIN is set, with
  inline PIN forms for paste and add. See [Commands tab](../tabs/commands.md).

### Vault Files

- `src/client/src/pages/Vault.jsx` — the page
- `src/services/vault.js` — keys, encryption and item operations
- `src/routes/vault.js` — the `/api/vault` routes
- `src/services/db.js` — the `vault_items` and `vault_meta` tables

## Onboard (`/agents/:agentId/onboard`)

File: `Onboard.jsx`

Wizard for setting up a running PAD: Telegram bot token, channel user ID, and a
model-provider API key. Submits to `POST /api/agents/:name/onboard`
(`src/routes/agents.js`), which runs the `openclaw` CLI inside the PAD as the PAD's terminal
user. The API key is written to the standard input of
`openclaw models auth paste-api-key --provider <provider>` (`docker exec -i`), so it never
appears in a process argument list; `runCmd` in `src/app.js` writes its `input` option to the
child's stdin and then closes it. Secrets live in the Vault, not a JSON file.

## Mission (`/mission`)

File: `Mission.jsx` + `stores/mission.js` (zustand) + `components/SessionList.jsx`.

Three-column workspace for the coding agents (opencode/codex/claude): col 1 lists
the projects (a project is a PAD + folder pair), col 2 lists that project's
sessions (or, in the all view, every session across projects), col 3 is the open
session's terminal. Every element carries a stable `msn-*` class for points-at.

**Selection is the scope — there is no toggle (plan 68).** The old
`scope`/`setScope` ("This project" / "All projects" buttons) is gone. Scope is
derived from `selectedProjectId`: `''` = all projects (the aggregate read
`fetchAll`), a project id = that project (`fetchSessions`/`fetchHistory`). The
list is **never** auto-narrowed to `projects[0]`, and clicking the already
selected project again **deselects** to the all view. Two store consequences
worth keeping: `followSessionPatch` and `selectSession` never move
`selectedProjectId` (col 3 renders from the `openSession` snapshot's own
`projectId`, so session highlights track their own project, deliberately) and
every refetch path branches on `!selectedProjectId` — the selected project's
list refresh must never route into the all-view read, or a poll would drop the
selected column back to the aggregate (the old `refreshActive` froze
all-projects after any selected-project mutation).

**The view persists across a refresh (plan 68).** `selectedProjectId`,
`selectedConversationId` and the whole `openSession` snapshot persist to
`localStorage['pad-mission-view']` on every state change and hydrate once at
store creation. On load each field is validated: a project that no longer
exists → `''`, an `openSession` whose project is gone → `null`. A refresh
therefore re-attaches the open terminal to the same conversation with **no
click and no autoReopen** (the opt-in stays the user's open action). Two
implementation facts: `openSession` round-trips as `null`, never an **absent
key**, because `JSON.stringify` drops `undefined` and an absent key rehydrates
to `undefined` again (first-visit store state must be `null`); and a corrupt
blob is ignored (`''`/`''`/`null`), never thrown.

**A fetch never invents a highlight (plan 73).** The middle-column highlight is
the conversation the user opened (`selectedConversationId`), carried forward by
every refetch and poll and kept across a close; it is cleared only when the list
it belongs to is replaced (project switch, new project, delete project). So a
fresh page with nothing opened shows **zero** `.msn-row-selected` rows while col
3 shows "No session selected" — the two always agree.

**A green dot means "open", and the header says so (plan 81).** The dot is
mounted only when the server says `open` — a live agent TUI is attached, idle or
mid-turn — so it is not a "working" light. A live pane whose agent exited is a
different state: the row shows the word `shell` and no dot, because typing there
runs shell commands. Whenever at least one row carries a dot, the sticky
`Sessions` header shows a `● open` legend (with tooltip) so the meaning is
readable without hovering a 6px circle; the per-row dot keeps the precise
busy/idle `title`. The same `open` gates the row's hover actions
(`.msn-row-actions`: pop out, solo lock, runner, close): a shell row has none —
close would kill a pane whose conversation is already closed, lock has no agent
to lock out, and its timestamp must not fade to reveal buttons that do not
exist. Dead (history) rows have no actions either. `sessionOpen()` in
`SessionList.jsx` is the one server-first derivation used by both the row and
the legend (the `live || busy` fallback exists only for a row too old to carry
`open`).

**One split button creates a session (plan 96).** Col 2's toolbar carries a
single joined control, `[ + New session | ▾ ]`: the left half starts an ordinary
session in the selected project (the old `+ New session` behavior, including the
`Opening…` busy label), and the chevron opens a dropdown whose only item is
`∞ New infinite session` ("Runs QUEUE.md until done"), which opens the same
RunnerDialog create popup the old standalone `∞ Infinite runner` button did
(`openPopup('runner-new', project.id)` — a create, no runner bound until saved).
The left click never opens the menu, and the chevron never starts a session.
Hooks: `.msn-btn-new-session` stays on the left half, `.msn-btn-new-caret` is the
chevron (stroked 14px SVG, never a `▾` glyph), `.msn-new-menu` is the panel and
`.msn-new-menu-infinite` its item; `.msn-btn-new-runner` is gone. The menu's
`open` state is local to `SessionCreateSplit.jsx` on purpose — a 15s listing poll
re-renders the toolbar and must not close it. It closes on `Esc` (focus returns
to the chevron), an outside `mousedown`, focus leaving the group, or selecting
the item; opening moves focus to the item. `newBusy` (from `startingKey ===
'new:<projectId>'`) disables BOTH halves — one in-flight ordinary start must not
queue a second start or an infinite create — and with no project selected both
halves are disabled with the title "Pick a project first". The row-level ∞
actions and the terminal-header `RunnerControls` are unchanged.

**History probe errors live in the error band, not the list (plan 68).**
Per-project history reads that fail (e.g. "agent is not running") surface as a
band above the session scroller so they cannot push rows around. `SessionList`
runs each `error` through `lib/error-text.translateHistoryError` (a pure
function) for a human sentence and carries the raw reason in the row's `title`
— the raw string stays reachable on hover. The same translation can be reused
anywhere a backend error string needs to become UI prose.

**Infinite runner Plans and History share the terminal column.** The runner panel is one
header row (`msn-queue-header`): collapse toggle, state chip, done count, the live
worker/scheduler line (`msn-runner-status-strip`), then the Plans / History segmented tabs
(`msn-runner-tabs`, rendered only while the panel is open) and the queue actions. Collapsed, it
is that single row above the terminal. Expanded, the Plans view is a width-capped column: a
progress bar (`msn-queue-progress`), Current/Next (only while there is one), and the item list
(`msn-queue-item` with `msn-queue-item-index`, status chip, title over path, icon actions).
**Run queue** in the session header (`msn-btn-runner-toggle`) is the primary action; the
header's own state chip is screen-reader-only because the queue row shows the same word. The
terminal never pushes a size below 40x8 to the pad, so an expanded queue cannot shrink the
worker's pane. The URL's
`runnerTab=history` selects a durable newest-first event journal without changing
the open Mission session or remounting its terminal. Recovery/callback steps group
by attempt id; filters and cursor paging do not rebuild older activity from current
state. At narrow widths the History view overlays the Mission columns while keeping
the underlying terminal mounted. See [Runner History](../components/runner-history.md)
for the journal/API contract.

## Frontend Conventions and Gotchas

- **Tooltips are the shared `Tooltip` primitive, never a native `title`**
  (`src/client/src/components/Tooltip.jsx`) — it reveals on hover and on
  keyboard focus (`.tt:focus-within`), and clamps itself inside the viewport.
  Use `portal` when the trigger sits in an `overflow: auto` scroller (the
  collapsed project rail): a pseudo-element tooltip is clipped by the
  scrollport, so the portal renders the bubble in `document.body` and places it
  from the trigger's rect. The portal's focus handler checks
  `e.target.matches(':focus-visible')` because a mouse click also focuses the
  button — without it the bubble would stick after the pointer leaves.
- **JSX/CSS edits need a build.** The SPA serves the built bundle from
  `src/public/`, so editing a `.jsx` file alone does nothing until
  `cd src/client && npm run build` + `docker restart paddock`. Symptom: a new
  className never appears in the DOM. Verify the class string made it into
  `src/public/assets/index-*.js` before browser-testing.
- **`api()` rejects on non-2xx.** `src/client/src/lib/api.js` checks `res.ok` and, on any
  non-2xx response (not just 401), rejects with a plain `{ status, error, code }` object, not
  an `Error`. How to read it is in
  [Client Conventions](../components/client-conventions.md#what-api-rejects-with).
- **Safe state access on first render.** React 19 has no error boundary, so a
  render-time throw blanks the whole app. Tab components that fetch settings
  into `null`-initialized state must use `settings?.x` (or a derived safe
  variable like `settings?.network || ''`) on the first render — never
  `settings.network` directly.
- **File modal.** The workspace file modal uses `value` + `onChange` for
  content tracking, an Escape-key handler, and a dirty/saved indicator; close
  warns if there are unsaved changes.
- **Terminal keeps xterm's default colors** — the themed palette and
  `paddock:theme` listener were removed at the user's request; the theme
  toggle only affects the app UI, not the shell.
- **Custom scrollbars** live in `src/client/src/index.css`, token-driven
  (`scrollbar-width: thin`, WebKit `::-webkit-scrollbar`).
- **Logs tab fills its area** — root is `flex flex-col h-full min-h-0`,
  header `flex-shrink-0`, pre `flex-1 min-h-0 overflow-auto`.
