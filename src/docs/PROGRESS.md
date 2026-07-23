# Paddock — Development Progress

## What We're Building
A web-based management dashboard for OpenClaw bot containers. The UI is at `http://localhost:5050` (served by `paddock-webui` container, Express + EJS + HTMX).

## Architecture
- **Express server** (`src/app.js`) — routes, auth, middleware
- **EJS templates** (`src/views/`) — layout + pages + partials
- **Agent-first** — all routes under `/agents/:id`
- **Legacy routes** preserved — `/vm/*` still works
- **Auth** — session-based via `AUTH_PASSWORD` env var (bypassed if unset)

## Project Structure
```
/workspace/
├── docker-compose.yml    # Root: runs ${CONTAINER_PREFIX}-webui
├── .env                  # CONTAINER_PREFIX, model defaults
├── AGENTS.md
├── instances/
│   ├── README.md         # Self-startable instances
│   └── <prefix>-<name>/  # Each has own docker-compose.yml
│       ├── docker-compose.yml
│       ├── meta.env
│       └── <agent-type>/
├── backups/
└── src/                  # All project code
    ├── app.js
    ├── routes/
    ├── services/
    ├── vm-builds/        # Docker build contexts
    ├── views/
    ├── docs/
    ├── scripts/
    └── ...
```

## What's Done

### Project Restructure (2026-07-23) — Paddock Rebrand
- **Named project `Paddock`** — clean, warm, animal-friends theme 🐴
- **All project code moved to `src/`** — root only has orchestration + instances
  - `docs/`, `scripts/`, `vm_openclaw/`, `vm_picoclaw/`, `vm_hermes/`, `vm_monitor/` → `src/`
  - Root `.md`, `.csv`, `bot-prefixes.json`, `opencode.json` → `src/docs/` or `src/data/`
- **Per-instance compose files** — each instance gets `instances/<name>/docker-compose.yml` (self-contained, startable from its folder)
- **Dynamic container prefix** — `CONTAINER_PREFIX` in `.env` (default `vm`), used everywhere for name matching
- **Removed `docker-compose.override.yml`** — no more shared override file
- **Image names**: `vm-friends-vm-*` → `paddock-vm-*`
- **Build contexts**: `./vm_openclaw` → `./src/vm-builds/openclaw` (relative from instance dir: `../../src/vm-builds/...`)
- **Removed `vm-friends/`** duplicate copy directory
- **Old instances removed** — `instances/` is clean for fresh starts

### Dashboard & Agent Cards
- `/agents` — fleet dashboard with agent cards
- Each card shows status, name, type, model
- **HTMX action buttons** on cards — play/stop/restart with `hx-post`, `hx-target="closest .agent-card"`, `hx-swap="outerHTML"`
- Card partial lives at `src/views/agents/partials/card.ejs`

### Agent Detail Page (`/agents/:name`) — Sidebar Layout
- **Left sidebar** (56px wide) — agent name, status badge, stop/restart/start buttons, 8 navigation links
- **Right content area** — fills remaining viewport height, scrolls independently
- **Full-height mode** — body `h-screen flex flex-col`, main `flex-1 overflow-hidden`
- All 8 tabs load via HTMX (`hx-trigger="load"`)

### Workspace File Browser (rebuilt 2026-07-19)
- HTMX folder navigation (no page reload)
- Breadcrumbs with HTMX links
- Click file → opens modal with editor (text files) or viewer
- Ctrl+S to save, Save button, download button
- Drag-and-drop upload zone with progress bar
- Create file and create folder forms
- Rename/delete with confirmation modals
- Works even when container is stopped (reads host filesystem)

### Logs Tab — Auto-scroll Toggle
- Auto-refresh every 5s, IntersectionObserver pauses when tab hidden
- Auto-scroll toggle button (ON/OFF, auto-disables on manual scroll)
- Scroll to bottom on click

### Other Tabs (all working)
- **Terminal** — xterm.js with WebSocket, resize support
- **Sessions** — session list
- **Config** — redacted config viewer
- **Backups** — list, download, restore, delete
- **Activity** — timeline of events

### Script Absorption — All bash/python scripts now in Node.js
- `add-vm.sh` → `src/services/vm-manager.js` (createVm)
- `remove-vm.sh` → `src/services/vm-manager.js` (removeVm)
- `reset-vm.sh` → `src/services/vm-manager.js` (resetVm)
- `manage_backups.sh` → `src/services/backup-manager.js` (backupAgent, restoreAgent)
- `scripts/onboard-bot.sh` + `.oauth-helper.py` → inlined in `app.js` routes + `vm-manager.js` config patching

### Compose Architecture (restructured 2026-07-23)
- Each instance has its own `docker-compose.yml` inside its instance directory
- Start: `docker compose -f instances/<name>/docker-compose.yml up -d`
- Manual: `cd instances/<name> && docker compose up -d`
- Build contexts use relative paths (`../../src/vm-builds/<type>`) from instance dir
- Imports: `vm-manager.js` exports `startAgent()` which tries `docker start` first, falls back to compose

## Config Roadmap
- **Phase 1** (now) — `CONTAINER_PREFIX` in `.env`, used in `docker-compose.yml` and all services
- **Phase 2** (future) — migrate `.env` settings into `src/data/app.db` SQLite, serve via API, editable from UI

## Future Tasks
- [ ] **Migration script** — convert old `vm-friends` project structure (override.yml, old build paths, vm-* instances) to new Paddock structure
- [ ] Commit all uncommitted changes
- [ ] Fix restore for stopped containers
- [ ] Fix `/agents/new` route (validateAgent catches "new")

## Key Gotchas
- **`CONTAINER_PREFIX`** must be set in `.env` and passed to webui container (`docker-compose.yml` env)
- **No `sudo`** inside `vm-webui` container
- **CSRF token** in templates: `<%= csrfToken %>` (NOT `req.csrfToken()`)
- **EJS include paths** are relative to current template file, not views root
- **File ownership** — files created by docker are owned by root; use `chown 1000:1000` after edits
- **`docker compose` not available** inside the webui container — use `docker restart <prefix>-webui` for route changes (EJS templates are hot-reloaded via bind mount)

## Files Reference
- `src/app.js` — Express server, all routes
- `src/routes/agents.js` — agent CRUD, lifecycle, workspace, tabs
- `src/services/vm-manager.js` — createVm, removeVm, resetVm, startAgent
- `src/services/backup-manager.js` — backupAgent, restoreAgent
- `src/services/workspace.js` — file operations (listDir, readFile, writeFile, createFolder, etc.)
- `src/services/agent-registry.js` — agent discovery, Docker state, SQLite sync
- `src/views/layout.ejs` — main layout with fullHeight support
- `src/views/agents/detail.ejs` — sidebar layout with 8 tabs
- `src/views/agents/workspace.ejs` — file browser with viewer/editor
- `src/views/agents/dashboard.ejs` — fleet dashboard
- `src/views/agents/partials/card.ejs` — HTMX agent card
- `src/views/agents/logs.ejs` — logs tab with auto-scroll toggle
