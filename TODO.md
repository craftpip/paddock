# TODO

## ~~Workspace Accessible When Container Is Stopped~~ ✅ DONE

**Verified 2026-07-19:** Already works. `workspace.js` reads from host filesystem (`agent.workspace_root` = `/workspace/instances/<vm>/openclaw/workspace`) regardless of container state. `validateAgent` middleware doesn't check container status. Tested with stopped `vm-test` — workspace tab loads fine (empty because it's a fresh instance).

## ~~Layout: Left Sidebar Navigation + Right Content Area~~ ✅ DONE

**Verified 2026-07-19:** Converted horizontal top tabs to a left sidebar on the agent detail page. Sidebar is sticky, content area scrolls independently. Agent name, status, and stop/restart/start buttons are in the sidebar.

**Changes:**
- `src/views/agents/detail.ejs` — sidebar layout with agent info + tabs
- `src/views/layout.ejs` — `fullHeight` support (body `h-screen flex flex-col`, main `flex-1 overflow-hidden`)
- `src/routes/agents.js` — detail route sets `res.locals.fullHeight = true`

## ~~Workspace File Browser — View, Edit, Upload, Navigation~~ ✅ DONE

**Verified 2026-07-19:** Full workspace rebuild with all features.

**Changes:**
- `src/views/agents/workspace.ejs` — complete rewrite: HTMX folder nav, file viewer/editor modal, drag-drop upload, create file/folder, professional UI
- `src/services/workspace.js` — added `writeFile()` for saving edits
- `src/routes/agents.js` — added `/workspace/save` and `/workspace/create-file` endpoints, HTMX partial rendering for workspace tab

**Features:**
- Folder navigation via HTMX (no page reload)
- Breadcrumbs with HTMX links
- Click file → opens modal with editor (for text files) or viewer
- Ctrl+S to save, Save button, download button
- Drag-and-drop upload zone with progress bar
- Create file and create folder forms
- Rename/delete with confirmation modals

**Status:** Not started
