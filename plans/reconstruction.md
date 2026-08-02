# Reconstruction Report — Unwired React Components

**Date:** 2026-07-25
**Status:** Files exist on disk and are committed, but NOT connected to the running app.

## What Happened

A previous agent session (likely another opencode instance) created several React components and utility modules on **July 24** as part of building out user management, profile, setup, and shared UI infrastructure. These files were written to disk but **never wired into the application's routing, providers, or navigation**.

When the messaging tab work was committed in `5dd2a96` (2026-07-25 10:36 UTC), all these untracked files were swept into that commit along with the messaging changes. The files survived, but the **connecting code was never written**. The agent that committed them treated them as "done" when they were only "created."

**The result:** The components exist as dead code. They import from stores and APIs that work, but nothing in the app imports *them* or routes to *them*.

## Architecture Context

The app is a React SPA (Vite + React Router + Zustand) served at `src/client/`. The entry point is:

- `src/client/src/App.jsx` — defines all `<Route>` elements
- `src/client/src/components/DashboardLayout.jsx` — top nav bar with sidebar links
- `src/client/src/main.jsx` — mounts `<App />` into DOM

The Express backend at `src/app.js` serves the SPA and provides API endpoints. Session auth returns `username`, `role`, `userId` from `/api/session`.

## Unwired Files — Full Inventory

### 1. Page Components (no routes exist for these)

#### `src/client/src/pages/Users.jsx` (152 lines)
- **Purpose:** Admin-only user management panel. Lists all users in a table with username, email, role, agent count, created date. Supports creating users, resetting passwords, and deleting non-admin users.
- **Backend APIs used:** `GET /api/users`, `POST /api/users`, `POST /api/users/:id/reset-password`, `DELETE /api/users/:id`
- **Backend status:** All routes exist in `src/app.js` (lines 386-453) with `requireAdmin` middleware.
- **What's missing in App.jsx:**
  ```jsx
  import Users from './pages/Users'
  // Need route:
  <Route path="/users" element={<AuthPage><Users /></AuthPage>} />
  ```
- **What's missing in DashboardLayout.jsx:** A "Users" link in the nav bar (admin-only, check `role === 'admin'`).
- **What's missing in auth.js:** The store does NOT capture `username` or `role` from the session response. The `/api/session` endpoint returns them, but `checkSession` only sets `authenticated`. The Users page checks `useAuth((s) => s.role)` which will always be `undefined`.

#### `src/client/src/pages/Profile.jsx` (106 lines)
- **Purpose:** Current user's profile page. Shows avatar initial, username, role badge. Lets user update email and change password.
- **Backend APIs used:** `GET /api/profile`, `PATCH /api/profile`, `POST /api/profile/change-password`
- **Backend status:** All routes exist in `src/app.js` (lines 456-489).
- **What's missing in App.jsx:**
  ```jsx
  import Profile from './pages/Profile'
  // Need route:
  <Route path="/profile" element={<AuthPage><Profile /></AuthPage>} />
  ```
- **What's missing in DashboardLayout.jsx:** A "Profile" link or a clickable username in the header that navigates to `/profile`.
- **Same auth.js issue:** Uses `useAuth((s) => s.username)` and `useAuth((s) => s.role)` — both `undefined`.

#### `src/client/src/pages/Setup.jsx` (91 lines)
- **Purpose:** First-run admin account creation page. Checks `GET /api/setup` to see if setup is needed; if not, redirects to `/login`. Shows a form to create the initial admin username + password.
- **Backend APIs used:** `GET /api/setup`, `POST /api/setup`
- **Backend status:** Routes exist in `src/app.js` (lines 325-384). The `/api/setup` path is in the `publicPaths` array (line 57) so it doesn't require auth.
- **What's missing in App.jsx:**
  ```jsx
  import Setup from './pages/Setup'
  // Need route (outside AuthPage, since it's unauthenticated):
  <Route path="/setup" element={<Setup />} />
  ```
- **No nav link needed** — this is a one-time setup flow that redirects itself.

### 2. Shared UI Components (not imported anywhere)

#### `src/client/src/components/Console.jsx` (71 lines)
- **Purpose:** Reusable terminal/console output widget. Renders a scrollable list of command lines, stdout, and stderr with timestamps. Used by the Messaging tab and could be used by Health, Terminal, and other tabs.
- **Props:** `lines`, `runningCmd`, `onClear`, `label`, `emptyMessage`, `autoScroll`, `className`, `headerRight`, `children`
- **Current state:** The MessagingTab in `AgentDetail.jsx` reimplements its own inline console instead of using this component. The Console component is orphaned.
- **To fix:** MessagingTab (and potentially HealthTab, TerminalTab) should import and use `Console` instead of duplicating the pattern.

#### `src/client/src/lib/confirm.jsx` (88 lines)
- **Purpose:** React context provider for confirmation dialogs. Provides a `useConfirm()` hook that returns an async function: `const confirm = useConfirm(); const ok = await confirm({ title, message, danger })`.
- **What's missing:** The `ConfirmProvider` must wrap the app tree in `App.jsx` or `main.jsx`:
  ```jsx
  import { ConfirmProvider } from './lib/confirm'
  // In App():
  <ConfirmProvider>
    <AuthGate>...</AuthGate>
  </ConfirmProvider>
  ```
- **No component currently imports this.** It was built for future use (delete confirmations, destructive actions).

#### `src/client/src/lib/toast.jsx` (119 lines)
- **Purpose:** React context provider for toast notifications. Provides `useToast()` hook with methods: `toast(msg)`, `toast.success(msg)`, `toast.error(msg)`, `toast.warning(msg)`, `toast.info(msg)`. Auto-dismisses with configurable duration. Supports action buttons.
- **What's missing:** The `ToastProvider` must wrap the app tree:
  ```jsx
  import { ToastProvider } from './lib/toast'
  // In App():
  <ToastProvider>
    <ConfirmProvider>
      <AuthGate>...</AuthGate>
    </ConfirmProvider>
  </ToastProvider>
  ```
- **No component currently imports this.** It was built to replace the current pattern of inline error/success messages.

#### `src/client/src/lib/shortcuts.js` (36 lines)
- **Purpose:** Global keyboard shortcuts hook. `Ctrl+K` focuses search, `Ctrl+N` navigates to create agent, `Ctrl+S` clicks a save button.
- **What's missing:** Needs to be called in `DashboardLayout.jsx` or `App.jsx`:
  ```jsx
  import { useKeyboardShortcuts } from './lib/shortcuts'
  // Inside DashboardLayout:
  useKeyboardShortcuts()
  ```
- **No component currently calls this.**

### 3. Auth Store Gap

#### `src/client/src/stores/auth.js`
- **Bug:** The `checkSession` function receives `username` and `role` from `/api/session` but only stores `authenticated`:
  ```js
  // Current (broken):
  set({ authenticated: data.authenticated, loading: false, error: null })
  
  // Should be:
  set({
    authenticated: data.authenticated,
    username: data.username,
    role: data.role,
    userId: data.userId,
    loading: false,
    error: null,
  })
  ```
- **Impact:** Any component reading `useAuth((s) => s.username)` or `useAuth((s) => s.role)` gets `undefined`. This affects Users.jsx (admin check), Profile.jsx (avatar + role display), and the missing header username display.

### 4. Nav Bar Gap

#### `src/client/src/components/DashboardLayout.jsx`
- **Current nav items:** Agents, + Agent, Creds, Backups, Logout
- **Missing nav items:** Users (admin only), Profile (all users)
- **Missing header element:** The logged-in username should display in the header bar (next to logout button), linking to `/profile`.
- **No user menu or dropdown exists.** The Profile page was designed to be reached by clicking the username.

## What Needs To Be Done (Reconstruction Checklist)

1. **Fix `auth.js`** — Store `username`, `role`, `userId` from session response
2. **Fix `App.jsx`** — Add routes for `/users`, `/profile`, `/setup`; wrap tree in `ToastProvider` and `ConfirmProvider`
3. **Fix `DashboardLayout.jsx`** — Add nav links for Users (admin-only) and Profile; display username in header; call `useKeyboardShortcuts()`
4. **Wire `Console.jsx`** — Refactor MessagingTab (and optionally HealthTab, TerminalTab) to use the shared Console component
5. **Wire `confirm.jsx` and `toast.jsx`** — Start using `useConfirm()` and `useToast()` in existing pages (e.g., delete buttons, save actions)

## 5. Dead Legacy Code (EJS System)

The entire old EJS rendering system is dead code. The React SPA replaced it, and the SPA catch-all (`app.js:1460`) intercepts all non-API requests before they reach any EJS route.

### Dead EJS Views (18 files in `src/views/`)

Every file in `src/views/` is unreachable:
- `src/views/layout.ejs` — old HTML layout (SPA has its own layout in `DashboardLayout.jsx`)
- `src/views/login.ejs` — old login page (SPA has `Login.jsx`)
- `src/views/agents/dashboard.ejs` — old fleet view (SPA has `Dashboard.jsx`)
- `src/views/agents/create.ejs` — old create form (SPA has `CreateAgent.jsx`)
- `src/views/agents/create_progress.ejs` — old create progress overlay
- `src/views/agents/detail.ejs` — old detail page (SPA has `AgentDetail.jsx`)
- `src/views/agents/settings.ejs` — old settings page (never ported to React)
- `src/views/agents/workspace.ejs` — old file browser (SPA has WorkspaceTab in `AgentDetail.jsx`)
- `src/views/agents/terminal.ejs` — old terminal (SPA has TerminalTab in `AgentDetail.jsx`)
- `src/views/agents/logs.ejs` — old logs (SPA has LogsTab in `AgentDetail.jsx`)
- `src/views/agents/config.ejs` — old config (SPA has ConfigTab in `AgentDetail.jsx`)
- `src/views/agents/messaging.ejs` — old messaging (SPA has MessagingTab in `AgentDetail.jsx`)
- `src/views/agents/models.ejs` — old models (SPA has ModelsTab in `AgentDetail.jsx`)
- `src/views/agents/activity.ejs` — old activity (SPA has ActivityTab in `AgentDetail.jsx`)
- `src/views/agents/backups.ejs` — old backups (SPA has BackupsTab in `AgentDetail.jsx`)
- `src/views/agents/sessions.ejs` — old sessions (removed from SPA)
- `src/views/agents/partials/` — old partials directory (sidebar, card, etc.)

### Dead EJS Routes File

`src/routes/agents.js` (800+ lines) is **not imported by `app.js`**. It contains old Express routes that render EJS templates. It's entirely orphaned. The SPA's API routes are defined directly in `app.js`.

### Dead Settings Page

The old `settings.ejs` showed container info + a "Delete Container" button. It was never ported to the React SPA. If this feature is needed, it should be added as a tab or section in `AgentDetail.jsx`.

## 6. Committed Build Artifacts (`src/public/`)

The `src/public/` directory contains Vite build output committed to git:
- `src/public/index.html` — SPA entry point
- `src/public/assets/index-CRQlfaYG.js` — 346KB bundled JS
- `src/public/assets/index-CvA_5K-v.css` — bundled CSS
- `src/public/assets/xterm-*.js` and `xterm-*.css` — terminal dependencies
- `src/public/assets/addon-fit-*.js` — xterm fit addon

These are **stale** — they represent whatever was built at the time of commit `5dd2a96` and will not reflect any source changes made after that. They should be in `.gitignore` since the build runs inside the container.

## 7. OfflineBanner (Listed but Not Implemented)

`plans/ui-enhancements.md` marks "Offline/broken state handling — OfflineBanner shows 'Connection lost' when backend is unreachable" as done (`[x]`). However, no `OfflineBanner` component exists anywhere in the codebase. This was planned but never built.

## 8. Console Component Duplication

`src/client/src/components/Console.jsx` is a shared, reusable console output widget with proper props (lines, runningCmd, onClear, label, etc.). However, **no component imports it**. Both `HealthTab` and `MessagingTab` in `AgentDetail.jsx` have their own inline console implementations (~40 lines each) that duplicate the same pattern.

This means there are three console implementations: one shared (unused) and two inline (used). The inline ones should be replaced with the shared component.

## Verification After Reconstruction

```bash
# Rebuild and test
docker exec paddock-webui sh -c 'cd /app/client && npx vite build'
# Or for dev:
# Vite dev server auto-reloads on file changes

# Check routes work:
# /setup — should show admin creation form (if no admin exists)
# /login — login page
# /users — admin user management (requires admin role)
# /profile — current user profile with email + password change
# Header should show username linking to /profile
```

## Files That Are Clean (no issues)

These files exist, are committed, and are properly wired:
- `src/client/src/pages/AgentDetail.jsx` — fully connected, all tabs working
- `src/client/src/pages/Dashboard.jsx` — fleet view
- `src/client/src/pages/CreateAgent.jsx` — agent creation form
- `src/client/src/pages/Credentials.jsx` — credential management
- `src/client/src/pages/GlobalBackups.jsx` — backup management
- `src/client/src/pages/Onboard.jsx` — bot onboarding
- `src/client/src/pages/Login.jsx` — login page
- `src/client/src/stores/agents.js` — agent state store
- `src/client/src/lib/api.js` — API client with CSRF

## Commit History Reference

| Commit | Date | What |
|--------|------|------|
| `d07e8b5` | Jul 23 19:44 | Project restructure (Paddock rebrand) |
| `1e3dfba` | Jul 23 19:51 | Container rename |
| `b0185d6` | Jul 23 21:46 | Settings tab (old EJS system, now superseded) |
| `1d341ae` | Jul 24 00:04 | Used By column in credentials |
| `331336d` | Jul 24 00:05 | Cleanup old assets |
| `071301d` | Jul 24 00:07 | Health tab |
| `0e7ac0f` | Jul 24 00:12 | Health tab SSE |
| `7a5fca4` | Jul 24 09:16 | MCP tab, Skills tab, workspace browsing |
| `d182930` | Jul 24 11:33 | Workspace browser fix |
| `9505e12` | Jul 25 09:02 | AUTO_LOGIN env var |
| `5dd2a96` | Jul 25 10:36 | Messaging tab + swept in all unwired files |
| `1b51747` | Jul 25 10:36 | Plan update |
