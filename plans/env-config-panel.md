# Plan: Environment Config Panel

## Status: Complete — 6/6 items done

## Goal
Add a "Configs" panel to the Paddock web UI that reads, edits, and applies `.env` variables — with hot-reload (restart webui) or recreate (force-recreate container) depending on which variable changed.

## Design Decision: Categorized Form (not a table)
With only ~19 variables, a categorized form beats a flat table. Each variable has different impact (restart vs recreate vs agent-pass-through), needs descriptions, and secrets need masking. Groups let us show a single action button per category.

---

## Layout

New top-level route `/configs` with nav link (between "Backups" and theme toggle).

### Variable Groups (in order)

#### 1. Networking & Access (recreate required)
| Variable | Type | Description |
|----------|------|-------------|
| `CONTAINER_PREFIX` | text | PAD name prefix (e.g. `pad`) |
| `HOST_NAME` | text | Host IP / hostname |
| `HOST_PROTO` | select (`http`/`https`) | Protocol |
| `HOST_WORKSPACE_ROOT` | text | Host filesystem path for workspaces |

**Action:** "Recreate Container" button (red accent) — these vars only take effect after a full container recreate.

#### 2. Authentication (webui restart)
| Variable | Type | Description |
|----------|------|-------------|
| `AUTO_LOGIN` | toggle | Bypass login screen |
| `SESSION_SECRET` | secret text | Session signing key |
| `AUTH_PASSWORD` | secret text (optional) | Basic auth password |
| `VAULT_KEY` | secret text (locked) | Vault encryption key — **read-only**, show warning banner if user hovers lock icon |

**Action:** "Restart Webui" button — these are read at boot, need `docker restart paddock`.

#### 3. Agent Defaults (hot-reload, passed to agents)
| Variable | Type | Description |
|----------|------|-------------|
| `DEFAULT_MODEL_BASE_URL` | url | LLM API endpoint |
| `DEFAULT_MODEL_NAME` | text | Model identifier |
| `DEFAULT_CONTEXT_LENGTH` | number | Max token budget |
| `DEFAULT_ALLOW_FROM` | text | Telegram user ID allowlist |

**Action:** "Apply" button — writes to `.env`, agents pick up on next create/build. No restart needed for the webui itself.

#### 4. Permissions & Guards (webui restart)
| Variable | Type | Description |
|----------|------|-------------|
| `PUID` | number | Host UID for file ownership |
| `PGID` | number | Host GID for file ownership |
| `DOCKER_GID` | number | Docker group ID |
| `GUARD_PROJECT_ROOT` | toggle (`0`/`1`) | Block mounting project root as workspace |
| `GUARD_INSTANCES_PARENT` | toggle (`0`/`1`) | Block mounting instances parent |
| `GUARD_AGENT_DATA` | toggle (`0`/`1`) | Block mounting agent data dir |

**Action:** "Restart Webui" button — ownership/guard vars need a backend reload.

#### 5. System (read-only info)
| Variable | Type | Description |
|----------|------|-------------|
| `TZ` | text (readonly) | Timezone — set via docker-compose.yml `environment`, not .env |

**Action:** None (display only, explain it's in compose).

---

## UX Per Variable
Each row shows:
- **Label** (human-readable name, e.g. "Container Prefix")
- **Input** — `<input>`, `<select>`, or toggle depending on type
- **Description** — one-line help text below the input
- **Changed indicator** — subtle badge if value differs from saved
- **Secrets** — masked with `••••••` by default, eye-icon toggle to reveal
- **Locked** — greyed out input with lock icon and warning tooltip (VAULT_KEY only)

## Action Buttons
- Each group section has its own action button at the bottom
- Button label matches the impact: "Recreate Container" / "Restart Webui" / "Apply Changes"
- Button is disabled if no values changed in that group
- Clicking triggers a confirmation modal ("This will restart the webui container. Continue?")
- After success: toast notification, unsaved indicators clear

---

## Implementation Steps

### [x] 1. Backend API — `GET /api/env` and `POST /api/env`
**File:** `src/app.js` (add near existing `/api/config` route)

- `GET /api/env` — Read `.env` file, return all vars as `{ key, value, source }[]`. Secrets (`SESSION_SECRET`, `VAULT_KEY`, `AUTH_PASSWORD`) return `{ key, value: '••••••••', isSecret: true }`.
- `POST /api/env` — Accept `{ vars: { KEY: value, ... } }`. Merge into `.env` file (preserve comments, ordering). Return updated list. **Do NOT restart** — let the frontend decide based on which vars changed.
- **Security:** Only admins can access these endpoints. Gate with existing auth middleware.

### [x] 2. Frontend — `Configs.jsx` page
**File:** `src/client/src/pages/Configs.jsx` (new)

- Fetch on mount: `api('/api/env')`
- Render 5 groups as `<section>` cards matching existing SettingsTab pattern
- Each variable renders based on type (text/number/url/select/toggle/secret)
- Track `dirty` state per group — enable/disable action buttons
- On action click: `confirm()` modal → `POST /api/env` with changed vars → if group is "recreate" → `CommandModal` for streaming recreate; if "restart" → `POST /api/env` with `_action: 'restart'`; if "apply" → just save

### [x] 3. Frontend — Route & Nav Link
**File:** `src/client/src/App.jsx` + `src/client/src/components/DashboardLayout.jsx`

- Add route: `/configs` → `Configs` component (auth required)
- Add nav link in `DashboardLayout.jsx` top bar: "Configs" between "Backups" and theme toggle

### [x] 4. Backend — Restart/Recreate Action Endpoints
**File:** `src/app.js`

- `POST /api/env/restart` — `docker restart paddock` (for auth/guard changes)
- `POST /api/env/recreate` — Full `docker compose up -d --force-recreate paddock` (for prefix/host/workspace changes). Uses streaming SSE like existing recreate flow.
- These are separate from `POST /api/env` (which only writes the file) to keep concerns clean.

### [x] 5. Hot-Reload Logic — Which Vars Need What
**File:** `src/app.js` (or a new `env-actions.js` service)

Classify each variable:
```js
const VAR_IMPACT = {
  CONTAINER_PREFIX:    'recreate',
  HOST_NAME:           'recreate',
  HOST_PROTO:          'recreate',
  HOST_WORKSPACE_ROOT: 'recreate',
  AUTO_LOGIN:          'restart',
  SESSION_SECRET:      'restart',
  VAULT_KEY:           'locked',
  AUTH_PASSWORD:       'restart',
  PUID:                'restart',
  PGID:                'restart',
  DOCKER_GID:          'restart',
  GUARD_PROJECT_ROOT:  'restart',
  GUARD_INSTANCES_PARENT: 'restart',
  GUARD_AGENT_DATA:    'restart',
  DEFAULT_MODEL_BASE_URL: 'agent',
  DEFAULT_MODEL_NAME:     'agent',
  DEFAULT_CONTEXT_LENGTH: 'agent',
  DEFAULT_ALLOW_FROM:     'agent',
  TZ:                     'none',
}
```

The frontend reads this map to show the correct button per group and determine what action to take after save.

### [x] 6. Testing & Verification
- Manual: Open http://10.69.1.164:6789/configs, verify all variables load ✓
- Edit a value, verify unsaved indicator appears ✓
- Verify secrets are masked by default, revealable on click ✓
- Verify VAULT_KEY is locked with lock icon ✓
- Verify all 5 groups render with correct action buttons ✓
- Verify .env file preserved after API read ✓
- Verify nav link "Configs" in top bar ✓

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/app.js` | Add `GET/POST /api/env`, `POST /api/env/restart`, `POST /api/env/recreate` |
| `src/client/src/pages/Configs.jsx` | **New** — full config panel page |
| `src/client/src/App.jsx` | Add `/configs` route |
| `src/client/src/components/DashboardLayout.jsx` | Add "Configs" nav link |
| `plans/env-config-panel.md` | This plan file |

## Decisions
- **VAULT_KEY:** Locked (read-only with warning banner). Changing it would break existing vault entries.
- **Comments preservation:** Yes — `#` lines before a var are preserved in `.env` and shown as description text under each variable in the UI.
- **Import/export:** Deferred — skip for now, add later if needed.
