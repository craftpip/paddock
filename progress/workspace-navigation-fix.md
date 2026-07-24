# Workspace Tab — Navigation Fix (COMPLETED)

## What's Been Done

### Bug 1: Blank workspace on refresh
- **Root cause**: `JSON.parse(null)` returns `null` (doesn't throw), so `restoreState()` returned `null` instead of `{}`
- **Fix**: Check `if (!raw) return {}` before parsing sessionStorage
- **File**: `src/client/src/pages/AgentDetail.jsx` — `restoreState()` function

### Bug 2: Refresh with parentView = true shows blank
- **Root cause**: `useEffect` only called `load(path)` when `!parentView`, no equivalent for `parentView = true`
- **Fix**: Effect now calls `loadParent()` when `parentView` is true
- **File**: `src/client/src/pages/AgentDetail.jsx`

### Bug 3: Parent subdirectory browsing broken
- **Root cause**: Clicking non-workspace dirs in parent view called `goToDir(entryPath)` which set `parentView = false` and tried to load via workspace API
- **Fix**: Added `parentSubpath` state + backend `listParentDir(agentId, subpath)` support
- **Files**: `src/client/src/pages/AgentDetail.jsx`, `src/services/workspace.js`, `src/app.js`

### Bug 4: "Up" button disabled in parent view
- **Root cause**: Was `opacity-40 cursor-not-allowed` with no-op onClick
- **Fix**: Now navigates up one level in parent directory tree when deeper than root

### Bug 5: File save path missing for parent subdirs
- **Root cause**: `readParentFile()` didn't return `path` field, so save used `fileModal.name` (just filename)
- **Fix**: Added `path: relativePath` to return value
- **File**: `src/services/workspace.js`

### Bug 6: Row clickability
- **Fix**: Moved onClick to `<td>` with `py-3` padding for bigger click area
- **File**: `src/client/src/pages/AgentDetail.jsx`

### Bug 7: JSON validation
- **Fix**: Blocks saving invalid JSON, shows line-number error in modal header
- **File**: `src/client/src/pages/AgentDetail.jsx`

## Solution: Eliminated Parent View Entirely

Instead of fixing the broken parent view navigation, the whole concept was removed.

### Root cause
The workspace browser had two modes: "workspace view" (inside workspace dir) and "parent view" (above workspace dir in the openclaw directory). The parent view was a separate code path with its own API endpoints, state variables, and navigation logic — and it was broken.

### Fix
1. Changed `workspace_root` in `agent-registry.js` to point to the openclaw directory itself (same as `config_root`)
2. Removed all parent view state/logic from `WorkspaceTab`: `parentView`, `parentSubpath`, `loadParent()`, all `/workspace/parent/*` API calls
3. Workspace tab now defaults to path `/workspace` — starts inside the workspace folder
4. User can navigate up to openclaw root and browse anywhere from there
5. Breadcrumbs show `openclaw / workspace / ...`

### Files changed
- `src/services/agent-registry.js` — `workspace_root` now points to `agentDir`
- `src/client/src/pages/AgentDetail.jsx` — WorkspaceTab simplified, parent view removed

### What works now
- Opens workspace tab → inside `/workspace` directory
- Breadcrumbs: `openclaw / workspace / ...`
- Navigate up → openclaw root (agents, completions, identity, logs, workspace, etc.)
- Navigate into any directory → works
- Open/edit/save files → works
- MV/RM/DL actions → works
- Session storage saves/restores path → works
