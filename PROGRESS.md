# VM Friends — Development Progress

## What We're Building
A web-based management dashboard for OpenClaw bot containers. The UI is at `http://localhost:5050` (served by `vm-webui` container, Express + EJS + HTMX).

## Architecture
- **Express server** (`src/app.js`) — routes, auth, middleware
- **EJS templates** (`src/views/`) — layout + pages + partials
- **Agent-first** — all routes under `/agents/:id`
- **Legacy routes** preserved — `/vm/*` still works
- **Auth** — session-based via `AUTH_PASSWORD` env var (bypassed if unset)

## What's Done

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

### Compose Project Fix
- All `docker compose` calls use `-p vm-friends --project-directory /workspace`
- Fixed in: `vm-manager.js`, `routes/agents.js`, `backup-manager.js`

## Key Gotchas
- **No `.env` file** — `AUTH_PASSWORD` is set directly in `docker-compose.yml` for `vm-webui`
- **No `sudo`** inside `vm-webui` container
- **CSRF token** in templates: `<%= csrfToken %>` (NOT `req.csrfToken()`)
- **EJS include paths** are relative to current template file, not views root
- **File ownership** — files created by docker are owned by root; use `chown 1000:1000` after edits
- **`docker compose` not available** inside the webui container — use `docker restart vm-webui` for route changes (EJS templates are hot-reloaded via bind mount)

## Files Reference
- `src/app.js` — Express server, all routes
- `src/routes/agents.js` — agent CRUD, lifecycle, workspace, tabs
- `src/services/vm-manager.js` — createVm, removeVm, resetVm
- `src/services/backup-manager.js` — backupAgent, restoreAgent
- `src/services/workspace.js` — file operations (listDir, readFile, writeFile, createFolder, etc.)
- `src/views/layout.ejs` — main layout with fullHeight support
- `src/views/agents/detail.ejs` — sidebar layout with 8 tabs
- `src/views/agents/workspace.ejs` — file browser with viewer/editor
- `src/views/agents/dashboard.ejs` — fleet dashboard
- `src/views/agents/partials/card.ejs` — HTMX agent card
- `src/views/agents/logs.ejs` — logs tab with auto-scroll toggle

## Next Steps (in order)
1. **Commit all uncommitted changes** — the entire Node.js rewrite is uncommitted
2. **Fix restore for stopped containers** — currently requires running container for docker cp/exec
3. **Fix `/agents/new` route** — returns 400 (validateAgent catches "new")
