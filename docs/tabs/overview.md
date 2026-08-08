# Tabs Overview

The agent detail page is a **terminal emulator with a GUI command picker**:
one docked terminal that lives the whole time you're on the page, plus a few
GUI modes that genuinely need a GUI. Modes are defined inline in
`src/client/src/pages/AgentDetail.jsx` as the `MODES` array (order matters):

```js
const MODES = [
  { id: 'commands', label: 'Commands' },   // default landing mode
  { id: 'workspace', label: 'Workspace' },
  { id: 'config', label: 'Config' },
  { id: 'web', label: 'Web' },
  { id: 'logs', label: 'Logs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]
```

`Commands` is the default landing mode — no hash, or an unknown hash, falls
back to it. Mode content renders above a terminal dock that is **always
mounted** (auto-collapses to its header outside Commands; the session stays
alive). See [terminal.md](terminal.md) for the dock and shell.

## Commands (default)

File: `src/client/src/pages/agent/CommandsPane.jsx`.

One wrapped flow of command pills grouped by area (Messaging, Models, MCP,
Skills, Memory, Config, Other, Security, Doctor, Diagnostics), with a search
box, a **Run TUI** button, and a right-aligned **Vault dropdown**. Clicking a
pill injects the CLI command into the docked terminal via `run(cmd)` — buttons
paste commands, not APIs (Vault is the deliberate exception). Groups + pills
are hardcoded in `CommandsPane.jsx`, not a config file.

Per-driver command groups come from the driver `commands` field — see
`/api/agent-types/<type>/commands`.

## Workspace

File: `AgentDetail.jsx` — workspace content.

Full file browser rooted at the agent's data directory, defaults into the
driver's `workspaceDir` (`/workspace` subfolder for openclaw).

**Features:**
- Breadcrumb navigation
- Create file / create folder inline forms
- Upload with drag-and-drop + progress bar
- File table with name, size, modified, actions (DL, MV, RM)
- File viewer/editor modal:
  - Syntax-aware editing, JSON validation before save
  - Unsaved changes indicator + Escape to close
- SessionStorage persists the last-visited path per agent

**API:** `/api/agents/:name/workspace/*` (list, file, save, rename, delete,
create-file, folder, upload, download, move).

## Config

Raw editor for the agent's config file — the driver's `configFile`
(`openclaw.json` for openclaw, `opencode.json`, `config.json` for picoclaw).
For `configFormat: 'json'` drivers the backend parses + redacts secrets and the
frontend validates JSON before save; for `yaml`/`toml`/verbatim formats
(hermes, codex) the file is served/written verbatim and the tab skips JSON
validation. Full config in a textarea, Save with validation, unsaved-changes
indicator, restart note after save.

## Web

Publishes the agent's built-in web app on a host port. Driver-driven form
(container port, host port, per-driver auth) + live-status pill; the Apply
button streams the recreate in a Console popup. Agents with no built-in web app
(codex/claude) show a read-only empty state. See [web.md](web.md).

## Logs

Container logs viewer, streamed through the persistent log store
(`instances/<name>/logs/container.log`, appended incrementally across
recreates).

**Features:** tail-count selector, auto-scroll toggle, log-level filter
(All/Info/Warn/Error), text search, timestamp toggle, streaming dot indicator.

## Sessions

Lists chat sessions from the SQLite metadata store (`sessions` table).

**Columns:** ID (truncated), Kind, Status (active/inactive), Model,
Tokens In/Out. Empty state: "No sessions recorded yet."

## Activity

Event timeline from the SQLite activity log (`activity_events` table).

**Columns:** Action (with color), Details, Timestamp. Status dot: green for ok,
red for error. Empty state: "No activity recorded yet."

Events tracked: start, stop, restart, create, delete, config updates, workspace
operations, backup create/restore, web publish/unpublish.

## Settings

Container-level operations: image refresh (update), health checkup, docker
access, network routing, web binding carryover, and delete. See
[settings.md](settings.md).

## API Endpoints (app.js)

All modern endpoints live under `/api/agents/:name/*` in `src/app.js`; POST
routes require a CSRF token (`x-csrf-token` header). See the dedicated tab docs
for per-tab routes.
