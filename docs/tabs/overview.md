# Tabs Overview

All tabs are defined inline in `src/client/src/pages/AgentDetail.jsx`. Each renders conditionally based on `currentTab` state from the URL hash.

## Overview Tab

File: `AgentDetail.jsx` — `OverviewTab` function (lines 334-375)

Shows:
- Stat boxes: Type (openclaw/picoclaw/hermes), Runtime (agent type), Default Model
- Quick links to Workspace and Terminal tabs
- Recent activity (last 5 events)

## Workspace Tab

File: `AgentDetail.jsx` — `WorkspaceTab` function (lines 547-882)

Full file browser rooted at the agent's openclaw directory, defaults into `/workspace` subfolder.

**Features:**
- Breadcrumb navigation (openclaw / workspace / ...)
- Create file / create folder inline forms
- Upload with drag-and-drop + progress bar
- File table with name, size, modified, actions (DL, MV, RM)
- Up button to go to parent directory
- File viewer/editor modal:
  - Syntax-aware editing for .json, .md, .js, .py, .sh, etc.
  - JSON validation before save
  - Unsaved changes indicator + Escape to close
  - Download button
- SessionStorage persists the last-visited path per agent

**API:** `/api/agents/:name/workspace/*` (list, file, save, rename, delete, create-file, folder, upload, download, move)

## Terminal Tab

File: `AgentDetail.jsx` — `TerminalTab` function (lines 412-543)

Full xterm.js terminal connected via WebSocket to `docker exec -i :name sh`.

**Features:**
- Connection status indicator
- Font size controls (A- / A+)
- Clear and Reconnect buttons
- Dark theme with cyan cursor
- 10000-line scrollback
- Auto-fit on mount and resize (ResizeObserver)
- `\r` → `\n` conversion for non-PTY docker exec

## Logs Tab

File: `AgentDetail.jsx` — `LogsTab` function (lines 886-919)

Container logs viewer.

**Features:**
- Tail count selector (50, 100, 500, 1000)
- Auto-scroll toggle
- Streaming dot indicator
- Monospace dark display

## Sessions Tab

File: `AgentDetail.jsx` — `SessionsTab` function (lines 923-961)

Lists chat sessions from SQLite metadata store.

**Columns:** ID (truncated), Kind, Status (active/inactive), Model, Tokens In/Out.

Empty state: "No sessions recorded yet."

## Config Tab

File: `AgentDetail.jsx` — `ConfigTab` function (lines 1256-1297)

Raw JSON editor for `openclaw.json`.

**Features:**
- Full config in textarea
- Save button with JSON validation
- Unsaved changes indicator
- Agent restart note after save

## Models Tab

File: `AgentDetail.jsx` — `ModelsTab` function (lines 1379-1458)

Model provider management.

**Features:**
- Primary model display + set button (★)
- Fallback model display + set button (⤵)
- Provider list with models table
- Per-model ★ Primary and ⤵ Fallback action buttons
- Remove provider with confirmation
- OAuth login flow for OpenAI, Google, GitHub Copilot

**API:** set-primary, set-fallback, remove-provider, oauth-login, oauth-status, oauth-cancel

## Messaging Tab

File: `AgentDetail.jsx` — `MessagingTab` function (lines 1462-1507)

Channel configuration viewer.

**Features:**
- Telegram channel display: bot token (masked), DM policy, allowlist
- Raw config editor for channel config
- Save button

## Backups Tab

File: `AgentDetail.jsx` — `BackupsTab` function (lines 1301-1375)

Per-agent backup management.

**Features:**
- Create Backup button
- Restore Latest button (with confirmation)
- Backup file list with Delete
- Status messages for operations

**API:** create, restore, delete (via docker exec inside container)

## Activity Tab

File: `AgentDetail.jsx` — `ActivityTab` function (lines 965-1005)

Event timeline from SQLite activity log.

**Columns:** Action (with color), Details, Timestamp.
Status dot: green for ok, red for error.
Empty state: "No activity recorded yet."

Events tracked: start, stop, restart, create, delete, config updates, workspace operations, backup create/restore.

## Settings Tab

File: `src/client/src/pages/agent/SettingsTab.jsx`

Container-level operations: image refresh, docker access, network routing, delete. See [settings.md](settings.md).

**Cards:** Container Info, Update (SSE console, `build --pull` + force-recreate), Allow docker toggle (host socket + CLI), Network dropdown (`network_mode: container:<name>`), Danger Zone delete.

**API:** `GET /api/containers`, `GET/POST /api/agents/:name/settings`, `POST /api/agents/:name/update`, `GET /api/agents/:name/update-log` (SSE).
