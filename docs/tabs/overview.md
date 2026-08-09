# Tabs Overview

> Last updated: 2026-08-09

The agent detail page is a **terminal emulator with a GUI command picker**:
one docked terminal that lives the whole time you're on the page, plus a few
GUI modes that genuinely need a GUI. Modes are defined inline in
`src/client/src/pages/AgentDetail.jsx` as the `MODES` array (order matters):

```js
const MODES = [
  { id: 'commands', label: 'Commands' },   // default landing mode
  { id: 'workspace', label: 'Workspace' },
  { id: 'config', label: 'Config' },
  { id: 'web', label: 'Web & Ports' },
  { id: 'logs', label: 'Logs' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]
```

`Commands` is the default landing mode — no hash, or an unknown hash, falls
back to it. Mode content renders above a terminal dock that is **always
mounted** (auto-collapses to its header outside Commands; the session stays
alive). See [terminal.md](terminal.md) for the dock and shell.

## Commands (default)

File: `src/client/src/pages/agent/CommandsPane.jsx`. See
[commands.md](commands.md) for the full mechanics and the per-type button
inventory.

One wrapped flow of command pills grouped by area, with a search box, a **Run
TUI** button, and a right-aligned **Vault dropdown**. Clicking a pill injects
the CLI command into the docked terminal via `run(cmd)` — buttons paste
commands, not APIs (Vault is the deliberate exception).

Groups + pills come from the agent driver's `commands` field, served by
`GET /api/agent-types/<type>/commands` (not hardcoded in the SPA). openclaw is
the one exception — it renders extra hardcoded flows (Messaging, Models, MCP,
Skills, Memory) on top of its driver groups.

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
(`openclaw.json` for openclaw, `opencode.json`, `config.json` for picoclaw,
`config.yaml` for hermes, `config.toml` for codex).
For `configFormat: 'json'` drivers the backend parses + redacts secrets and the
frontend validates JSON before save; for `yaml`/`toml`/verbatim formats
(hermes, codex) the file is served/written verbatim and the tab skips JSON
validation. Full config in a textarea, Save with validation, unsaved-changes
indicator, restart note after save.

## Web & Ports

Publishes the agent's built-in web app on a host port, exposes SSH, and maps
extra TCP ports — all driver-driven with a live-status pill; the Apply button
streams the recreate in a Console popup. In peer-mode networks every published
port rides the `<name>-door` socat container. Agents with no built-in web app
show a read-only empty state. See [web.md](web.md).

## Logs

Container logs viewer, streamed through the persistent log store
(`instances/<name>/logs/container.log`, appended incrementally across
recreates). Published web servers retain their own `<dataDir>/web.log` and
also stream output into the container log, so startup and runtime errors appear
here.

**Features:** tail-count selector, auto-scroll toggle, log-level filter
(All/Info/Warn/Error), text search, timestamp toggle, streaming dot indicator.

## Activity

Event timeline from the SQLite activity log (`activity_events` table).

**Columns:** Action (with color), Details, Timestamp. Status dot: green for ok,
red for error. Empty state: "No activity recorded yet."

Events tracked: lifecycle (start/stop/restart/create/delete/update), settings
(recreate), web publish/unpublish, ports update.

## Settings

Container-level operations: image refresh (update), health checkup, docker
access, network routing, workspace + volumes mounts, web binding carryover,
and delete. See [settings.md](settings.md).

## API Endpoints (app.js)

All modern endpoints live under `/api/agents/:name/*` in `src/app.js`; POST
routes require a CSRF token (`x-csrf-token` header). See the dedicated tab docs
for per-tab routes.
