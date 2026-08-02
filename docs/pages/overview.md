# Pages

All pages are React components served from `src/client/src/pages/`. The built SPA lives at `src/public/` and is served by Express at the root path.

## Login (`/login`)

File: `Login.jsx`

Simple login form with password input. Submit calls `POST /api/login`. On success redirects to `/agents`. On error shows error message. If the server has no AUTH_PASSWORD set, redirects immediately.

## Dashboard (`/agents`)

File: `Dashboard.jsx`

Fleet view showing all discovered PADs as cards. Features:
- Agent cards with name, status badge (running/stopped/transition), avatar initial
- Start/Stop/Restart inline buttons
- CPU + MEM stats on running agents (hover for Network + Disk I/O)
- Search/filter by name or display name
- Loading skeleton, empty state

## UI Enhancements

Implemented enhancements for user experience and functionality:

### Agent Detail Page

- **Tab state persistence** — remember which tab was active per agent (localStorage) so navigating back doesn't reset to the first tab.
- **Tab loading states** — each tab shows a proper skeleton/spinner while loading, not a blank flash.
- **Sticky tab bar** — when scrolling down on a tab with lots of content, the tab bar stays visible at the top.
- **Sidebar status/badge alignment** — status badge and action buttons (Stop, Restart) on the same line with compact icon buttons.
- **Hover stats alignment** — hover panel (Net I/O, Disk I/O) uses CSS grid with short labels.
- **Resource stats placeholder** — CPU and MEM lines show `&ndash;%` / `&ndash;` placeholders while loading.
- **Tab order** — Core tools first, then configuration, then Settings. Sessions and Activity tabs removed.
- **Activity merged into Overview** — full activity table shown in Overview tab below quick links.

### Workspace Tab

- **Drag & drop upload** — drag zone implemented.
- **File preview for images** — png/jpg/gif/svg/webp render inline in the file modal.
- **Search within workspace** — file name filter bar added.

### Consistent Page Layout

- **Credentials page** — `max-w-7xl mx-auto px-4 sm:px-6 py-8` wrapper added.
- **Global Backups page** — same wrapper added.
- **Create Agent page** — `py-8` added to existing `max-w-xl mx-auto`.

### Dashboard / Fleet View

- **Health indicators** — show CPU/memory/uptime next to the status indicator.
- **Sorting & grouping** — sort by Name/Status/Type, group by Status/Type.
- **Fleet Resources bar always visible** — always rendered with `&ndash;%` / `&ndash;` placeholders.
- **Mem total instead of Mem avg** — total memory summed from all containers in human-readable format.

### Terminal Tab

- **Copy on select** — `copyOnSelect: true` option set.

### Config Tab

- **Search within config** — search bar filters matching lines with count.

### Logs Tab

- **Log level filter** — filter by All/Info/Warn/Error.
- **Search within logs** — search/filter log content by text.
- **Timestamp toggling** — show/hide timestamps button.
- **Auto-scroll lock** — toggle already existed.

### General

- **Standardized confirmation modals** — supports title, message, danger styling, confirm/cancel buttons.
- **Keyboard shortcuts** — Ctrl+K (search), Ctrl+N (new agent), Ctrl+S (save).
- **Toast notification improvements** — stacking, auto-dismiss, action/undo buttons, slide-in animation.
- **Offline/broken state handling** — shows "Connection lost" when backend is unreachable.

## Create Agent (`/agents/create`)

File: `CreateAgent.jsx`

Form to create a new PAD, laid out in three rows:

```
─────────────────────────────────────────────────────┐
│  ← Back to fleet                                    │
│                                                     │
│  Create PAD                                       │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ vm-  [openclaw ▼]  -  [my-PAD           ] │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  Clone from backup (optional)                       │
│  ┌─────────────────────────────────────────────┐    │
│  │ [No clone — Fresh install              ▼]   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │         Create vm-openclaw-my-PAD         │    │
│  └─────────────────────────────────────────────┘    │
─────────────────────────────────────────────────────┘
```

## Create Agent (`/agents/create`)

File: `CreateAgent.jsx`

Form to create a new PAD, laid out in three rows:

```
┌─────────────────────────────────────────────────────┐
│  ← Back to fleet                                    │
│                                                     │
│  Create PAD                                       │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ vm-  [openclaw ▼]  -  [my-PAD           ] │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  Clone from backup (optional)                       │
│  ┌─────────────────────────────────────────────┐    │
│  │ [No clone — Fresh install              ▼]   │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │         Create vm-openclaw-my-PAD         │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

- **Row 1** — Prefix (from CONTAINER_PREFIX), PAD type dropdown (openclaw/picoclaw/hermes), name input (alphanumeric + hyphens)
- **Row 2** — Clone from backup dropdown (filtered by selected PAD type — only matching backup types shown). First option: "No clone — Fresh install". Replaces the old clone-from-running-PAD approach.
- **Row 3** — Create button shows the full name being created (e.g. "Create vm-openclaw-my-PAD")

**Creation flow:**
1. Form submits via fetch (no page navigation)
2. Inline progress bar appears on the same page (no layout-breaking body swap):
   - "Creating container…"
   - "Running setup…" (for OpenClaw/PicoClaw — runs `openclaw setup --baseline`)
   - "Done"
3. Redirects to agent detail on completion

**What was removed:**
- No more clone-from-running-PAD dropdown
- No separate progress page that broke layout

## Agent Detail (`/agents/:id`)

File: `AgentDetail.jsx`

Layout shell with sidebar and tabbed content. See `tabs/` docs for each tab.

Sidebar:
- Agent avatar + name + display name
- Status badge with pulse animation for transitions
- Live CPU/MEM stats on running agents (hover for Network/Disk I/O)
- Start/Stop/Restart buttons
- Tab navigation list (13 tabs)

Tabs are all defined inline in AgentDetail.jsx:
| Tab | Component | Feature |
|-----|-----------|---------|
| overview | OverviewTab | Agent info, quick links, recent activity |
| workspace | WorkspaceTab | File browser, editor, upload |
| terminal | TerminalTab | xterm.js terminal |
| logs | LogsTab | Container logs viewer |
| sessions | SessionsTab | Chat session list |
| config | ConfigTab | openclaw.json editor |
| mcp | McpTab | MCP server management |
| skills | SkillsTab | Skill list, install, manage |
| models | ModelsTab | Provider + model config |
| messaging | MessagingTab | Telegram/channel config |
| settings | SettingsTab | PAD info, backups (create/restore/delete), delete PAD |
| health | HealthTab | Diagnostic command toolbox |
| activity | ActivityTab | Event timeline |

## Settings Tab (per-PAD)

Replaces the old Backups tab. Contains three sections:

```
┌──────────────────────────────────────────────────────────────┐
│  Settings — ozden                                          │
│                                                               │
│  PAD Info                                                   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Name:    ozden                                    │    │
│  │  Type:    openclaw                                    │    │
│  │  Status:  running                                     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  Backups                                     [Create Backup]  │
│                                             [Restore Latest]  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  ramsey_20260719_004959.tar.gz    1.2 GB  [×]    │    │
│  │  ramsey_20260719_033154.tar.gz    850 MB  [×]    │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                               │
│  ┌─ Danger Zone ─────────────────────────────────────────┐    │
│  │                                                        │    │
│  │  [ Delete PAD ]                                      │    │
│  │  Deletes the container and all its data permanently.   │    │
│  └────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

- **PAD Info** — name, type, status summary
- **Backups** — Create Backup button, Restore Latest, list of archives with Download/Restore/Delete per row
- **Danger Zone** — Delete PAD button with confirmation warning

## Global Backups (`/backups`)

File: `GlobalBackups.jsx`

Global listing of all backup archives from the `backups/` folder. Features:

- **Quick Backup** — one button per running PAD, each with a status dot indicator
- **Table columns** — File Name (actual `.tar.gz` filename), Agent (with amber dot + "orphan" tag for deleted PADs), Type badge (OpenClaw/PicoClaw), Created (date, time, and relative time), Size, Actions (Download / Delete)
- **Download** — direct link to the archive
- **Delete** — with confirmation dialog
- **Empty state** — icon with message when no backups exist

## Credentials (`/credentials`)

File: `Credentials.jsx`

Three credential types managed from a single page with a sidebar tab switcher:

| Section | What It Stores |
|---------|---------------|
| **API Keys** | Provider API keys (openai, openrouter, ollama-cloud, anthropic) |
| **Bot Tokens** | Telegram bot tokens for messaging |
| **Allowed User IDs** | Telegram user IDs for DM allowlist |

Each table has an add form at the top and a row per credential. Token/key values are masked (first 4 + last 4 chars, stars in between).

### Used By Column

Every table has a **Used By** column that shows which PADs use each credential. On page load, the frontend calls `GET /api/credentials`. The backend (`app.js:879-958`) scans all PAD configs under `instances/*/openclaw/openclaw.json` and attaches a `used_by` array:

```json
{
  "api_keys": {
    "my-key": {
      "provider": "openai",
      "key": "sk-...",
      "used_by": [{ "name": "ozden", "status": "running" }]
    }
  }
}
```

Matching logic:

- **API keys** — matches by provider name against `models.providers.<name>` and `auth.profiles.*.provider`
- **Bot tokens** — matches by token value against `channels.*.botToken` / `channels.*.token`
- **User IDs** — matches by ID value against `channels.*.allowFrom` arrays

Frontend renders a `UsedByBadges` component per row. Running PADs get a cyan badge, stopped ones get slate. No usage shows a muted `—`.

### Backend API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/credentials` | GET | Returns all credentials with `used_by` enrichment |
| `/api/credentials/api-key` | POST | Add API key (name, provider, key) |
| `/api/credentials/bot-token` | POST | Add bot token (name, token) |
| `/api/credentials/user-id` | POST | Add user ID (name, uid) |
| `/api/credentials/delete` | POST | Delete credential (type, name) |

Credentials persist to `/app/data/credentials.json`. On startup, `bot-prefixes.json` is imported if it exists.

## Onboard (`/onboard/:name`)

File: `Onboard.jsx`

Wizard for setting up a new PAD: Telegram bot token, channel config, API keys.
