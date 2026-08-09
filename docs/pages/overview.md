# Pages

> Last updated: 2026-08-09

All pages are React components served from `src/client/src/pages/`. The built SPA lives at `src/public/` and is served by Express at the root path.

## Login (`/login`)

File: `Login.jsx`

Simple login form with username + password input. Submit calls `POST /api/login`. On success redirects to `/agents`. On error shows error message. With `AUTO_LOGIN=true` (default) the app skips login entirely.

## Profile (`/profile`)

File: `Profile.jsx`

Three cards: **Email**, **Change Password**, and **API Keys**.

### API Keys card

Per-user bearer keys for the paddock MCP server (`/mcp`). Keys inherit the
user's webui role (admin → full fleet, user → owned agents only). See
`backend/services.md` — API Keys and `overview/business-logic.md` — Paddock MCP
Server Auth.

- **Create**: inline form (name input + Create). On success a modal shows the
  raw key **once** with a Copy button, plus copy-ready client configs (opencode
  / Claude Code snippets with the real key filled in).
- **List**: table of prefix (`pk_live_…`), name, created, last used (or
  "never"), Revoke button.
- **Revoke**: `DELETE /api/profile/keys/:id` (owner-scoped, confirm()).
  Instant — the hash lookup fails on the next `/mcp` request.

API: `GET/POST /api/profile/keys`, `DELETE /api/profile/keys/:id`
(session + CSRF protected; always scoped to the caller's own keys).

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
- **Tab order** — Commands (default), then Workspace/Config/Web & Ports/Logs/Activity, then Settings. The old Sessions tab is removed.

### Workspace Tab

- **Drag & drop upload** — drag zone implemented.
- **File preview for images** — png/jpg/gif/svg/webp render inline in the file modal.
- **Search within workspace** — file name filter bar added.

### Consistent Page Layout

- **Vault page** — `max-w-7xl mx-auto px-4 sm:px-6 py-8` wrapper added.
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

Shared promise-based dialogs (`confirm`/`alert`/`prompt`), toasts, keyboard
shortcuts, and connection-lost handling live in
[`components/ux.md`](../components/ux.md).

## Create Agent (`/agents/create`)

File: `CreateAgent.jsx`

Form to create a new PAD. Name row on top, an expandable **Optional settings**
accordion below, then the create button:

```
┌─────────────────────────────────────────────────────┐
│  ← Back to fleet                                    │
│                                                     │
│  Create Agent                                       │
│  Only a name is required — everything else is       │
│  optional and can be changed later.                 │
│                                                     │
│  pad-  [openclaw ▼]  -  [my-PAD                ]    │
│                                                     │
│  ▼ Optional settings                                │
│    ┌ Workspace (host source + container path) ─────┐ │
│    ┌ Container options (docker toggle, network ▼) ─┐ │
│    ┌ Additional volumes (+ Add volume rows) ───────┐ │
│    ┌ Additional ports (+ Add port rows) ───────────┐ │
│                                                     │
│  [ Create my agent                             ]    │
└─────────────────────────────────────────────────────┘
```

- **Name row** — Prefix (from CONTAINER_PREFIX, e.g. `pad`), PAD type dropdown
  (openclaw/opencode/picoclaw/hermes/codex), name input (alphanumeric +
  hyphens).
- **Optional settings** — four cards, all optional:
  1. **Workspace** — host source + fixed container path (locked per driver).
  2. **Container options** — "Allow docker in the container" toggle (docker.sock
     + CLI, rebuilds the image at create) and a Network dropdown of running
     containers (peer routing via `network_mode: container:`).
  3. **Additional volumes** — dynamic `host → container` bind rows with a
     readonly checkbox.
  4. **Additional ports** — dynamic `host → container` TCP port rows.

The form validates client-side before enabling **Create my agent** (name,
volume/port fields). Submit posts all options
(`allowDocker`, `network`, `extraVolumes`, `extraPorts`, `workspace_host`,
`workspace_dir`) to `POST /api/agents/create`; the server pre-flights
everything (`vm.validateAgentCreate`: network peer exists+running, extra
volumes/ports, SSH container port if any, workspace mount, cross-agent
host-port sweep) and returns `400` before the `202` if any check fails —
nothing is created. OpenSSH exposure is **not** part of the create form; it is
configured afterwards from the agent's [Web & Ports tab](../tabs/web.md).

**Creation flow (live streaming):**
1. Form submits via fetch — POST `/api/agents/create` returns `202` immediately and a background job starts
2. The form is replaced by a live log pane (the shared `Console.jsx` component) that streams the **real command output** over SSE — no fake spinner steps
3. Steps appear as labeled command lines as they start: **build** → **up** → **setup** (fresh OpenClaw/PicoClaw) → **done**
4. **Success:** banner + prominent "Go to Agents" button — no auto-navigation, so the user can scroll the logs
5. **Failure:** red banner + error tail in the log pane; "back to form" or retry — never navigates

The SSE stream reconnects with `Last-Event-ID` on drop; polling `/create-status` is the fallback.

**What was removed:**
- No clone-from-backup dropdown (the generic backup system is gone)

## Agent Detail (`/agents/:id`)

File: `AgentDetail.jsx`

Layout shell with a sidebar, 7 mode tabs, and a docked terminal. See `tabs/`
docs for each mode.

Sidebar:
- Agent avatar + name + display name
- Status badge with pulse animation for transitions
- Live CPU/MEM stats on running agents (hover for Network/Disk I/O)
- Start/Stop/Restart buttons
- Mode navigation (7 tabs)

Modes are defined in the `MODES` array in AgentDetail.jsx:
| Mode | Component | Feature |
|------|-----------|---------|
| commands | CommandsPane.jsx | Command pill flow + Run TUI + Vault dropdown (default landing mode) |
| workspace | — | File browser, editor, upload |
| config | — | Editor for the driver's config file (openclaw.json / opencode.json / config.yaml / config.toml) |
| web | WebTab.jsx | "Web & Ports" — publish the web app, expose SSH, map extra TCP ports |
| logs | — | Container logs viewer (persistent log store) |
| activity | — | Event timeline |
| settings | SettingsTab.jsx | Update, health checkup, docker, network, workspace, volumes, delete |

The terminal is docked at the bottom of every mode — always mounted, one per
agent, auto-collapsed outside Commands. See [tabs/terminal.md](../tabs/terminal.md).

## Settings Tab (per-PAD)

Container-level operations on the agent detail page: image refresh (Update),
container health checkup, docker access, network routing, and delete. Runs as
SSE-streamed background jobs with a Console popup. See
[tabs/settings.md](../tabs/settings.md) for the full contract.

## Global Backups (`/backups`)

File: `GlobalBackups.jsx`

**Maintenance empty state** — the generic archive system was removed (2026-08-09);
the page shows "The generic archive system was removed. Native driver backups are
coming soon." Legacy archives stay in `backups/` but are not restorable until
plan 26 (native per-driver backup/import) lands.

## Vault (`/vault`)

File: `Vault.jsx`

Encrypted key-value store that replaced the Credentials page. One flat list of
secret entries — no provider/type structure. Just Name, Description, Value.

### Data Model

SQLite tables in `src/data/app.db`:

`vault_items`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | PK, autoincrement |
| `name` | TEXT | UNIQUE, required |
| `description` | TEXT | optional, defaults to `''` |
| `enc_value` | TEXT | base64(`iv:tag:ciphertext`) |
| `created_at` | TEXT | datetime |
| `updated_at` | TEXT | datetime |

`vault_meta` (single row `id=1`):

| Column | Type | Notes |
|--------|------|-------|
| `pin_set` | INTEGER | 0/1 |
| `pin_salt` | TEXT | salt for the PIN-derived key |
| `master_wrapped` | TEXT | master key wrapped by `pinKey` (AES-GCM) |
| `pin_set_at` | TEXT | datetime |

Value is **never stored plaintext**. The old `credentials.json` is not touched — this is a separate store.

### Encryption

Service: `src/services/vault.js` (Node built-in `crypto`, no new deps).

Envelope encryption:

```
scrypt(pin, salt) ──► pinKey ──► AES-GCM ──► masterWrapped  (vault_meta)
masterKey (random 32B) ──► AES-GCM ──► enc_value (per item)
```

- **Algorithm:** AES-256-GCM, random 12-byte IV per item, auth tag stored with ciphertext. Format stored: `iv:tag:data` all base64.
- **Always locked (2026-08-07):** no module state, no unlock/lock. Every op (add/edit/delete/paste) supplies the PIN at that moment; `resolveMaster(pin)` unwraps the master key for the single op and discards it. Wrong PIN → GCM tag mismatch → `Wrong PIN`.
- **No PIN set:** master key falls back to `VAULT_KEY` (32+ bytes) or a stable scrypt derivation from `SESSION_SECRET` (works out of the box, with a warning logged).
- **PIN set:** `scrypt(pin, salt)` wraps a fresh random 32-byte master key into `vault_meta.master_wrapped`. PIN must be 4 or 6 digits.
- **Decrypt** only inside the service. The API layer never returns plaintext in list responses.

### API

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/api/vault` | — | `{ items: [...], meta: { pinSet, locked } }` — **no value**; `locked = !!pinSet` |
| POST | `/api/vault/pin` | `{ pin, reset?, oldPin?, password? }` | `{ ok: true, meta }` — reset requires the logged-in user's `password` (401 if wrong) then `oldPin` (400 `Wrong PIN`), then wipes items |
| POST | `/api/vault` | `{ name, description?, value, pin }` | `{ ok: true, item: {...} }` |
| PUT | `/api/vault/:id` | `{ name?, description?, value?, pin }` — empty `value` = keep existing | `{ ok: true, item: {...} }` |
| DELETE | `/api/vault/:id` | `{ pin }` | `{ ok: true }` |
| GET | `/api/vault/:id/decrypt` | `?pin=` query param | `{ value }` — admin only, for terminal-paste integration |

- POST rejects duplicate names (409). Wrong PIN → 400 `Wrong PIN`.
- List responses never include plaintext or masked hints — UI always shows `••••••••••`.
- All routes behind `requireAuth` + CSRF (`csrfCheck` for mutating methods).
- There is no `/unlock` or `/lock` route — the vault is always locked by design.

### UI

- Table: Name | Description | Value | Updated | actions
- Value cell: always `••••••••••` with a small lock icon (fixed, no first-4-last-4 mask — user said never display it again).
- A small `locked` pill in the header while a PIN is set. No persistent banner.
- **PIN on every action:** add/edit/delete ask for the PIN via a modal/inline form. Wrong PIN keeps the prompt open and shows `Wrong PIN` in place.
- Add form: inline row above table — Name (required), Description (optional), Value (`type=password`, required). First-time setup (no PIN + zero items) opens a "Set PIN" modal; otherwise the add row opens directly and the PIN is asked on save.
- Edit: inline form with name/description populated, value blank with placeholder "leave blank to keep existing value". Save does PUT + PIN prompt.
- Delete: custom confirm dialog, then PIN prompt, then DELETE.
- **CommandsPane (agent detail):** Vault dropdown shows a lock banner while locked, with inline PIN forms for paste (`Unlock & paste`) and add (`Unlock & add`).
- Add/edit/delete use the existing `api()` helper — CSRF handled automatically.

### Security

- **Always-locked PIN (4–6 digits):** backend is stateless; the PIN is required per operation. Note: a short PIN is brute-forceable offline if the DB leaks — acceptable for a local tool.
- Value encrypted at rest; DB leak alone does not reveal secrets without the PIN (or `VAULT_KEY` when no PIN is set).
- Value never travels back to the browser in list/read responses.
- `/decrypt` is admin-only and intended for server-side paste flows, never for display.
- Resetting the PIN verifies the user's password + old PIN, then wipes every item (old master key unrecoverable) — the UI warns loudly.
- If the PIN/`VAULT_KEY` is lost, values are unrecoverable — nothing plaintext is ever stored.

### Future Integration (not built now)

- **Model setup terminal:** Vault list becomes a click-to-paste source when `openclaw models auth paste-api-key` waits for input. Uses `/decrypt` endpoint server-side → terminal stdin over WebSocket.
- **Bot onboarding:** `--bot` / `--api-key` values pulled from Vault instead of `bot-prefixes.json`.
- Anything else that needs a secret: just reference by name.

### Files

- `src/services/vault.js` — encrypt/decrypt + CRUD on SQLite
- `src/client/src/pages/Vault.jsx` — the page
- `src/services/db.js` — `vault_items` table in `migrate()`
- `src/app.js` — vault API routes

## Onboard (`/agents/:agentId/onboard`)

File: `Onboard.jsx`

Wizard for setting up a running PAD: Telegram bot token, channel user ID, and a
model-provider API key. Submits to `POST /api/agents/:name/onboard` (the flow
that was formerly `scripts/onboard-bot.sh`, absorbed into app.js route handlers
and `vm-manager.js` config patching). Secrets live in the Vault, not a JSON file.

## Frontend Conventions and Gotchas

- **JSX/CSS edits need a build.** The SPA serves the built bundle from
  `src/public/`, so editing a `.jsx` file alone does nothing until
  `cd src/client && npm run build` + `docker restart paddock`. Symptom: a new
  className never appears in the DOM. Verify the class string made it into
  `src/public/assets/index-*.js` before browser-testing.
- **`api()` throws on non-2xx.** `src/client/src/lib/api.js` checks `res.ok`
  and throws with the error payload on any non-2xx response (not just 401).
- **Safe state access on first render.** React 19 has no error boundary, so a
  render-time throw blanks the whole app. Tab components that fetch settings
  into `null`-initialized state must use `settings?.x` (or a derived safe
  variable like `settings?.network || ''`) on the first render — never
  `settings.network` directly.
- **File modal.** The workspace file modal uses `value` + `onChange` for
  content tracking, an Escape-key handler, and a dirty/saved indicator; close
  warns if there are unsaved changes.
- **Terminal keeps xterm's default colors** — the themed palette and
  `paddock:theme` listener were removed at the user's request; the theme
  toggle only affects the app UI, not the shell.
- **Custom scrollbars** live in `src/client/src/index.css`, token-driven
  (`scrollbar-width: thin`, WebKit `::-webkit-scrollbar`).
- **Logs tab fills its area** — root is `flex flex-col h-full min-h-0`,
  header `flex-shrink-0`, pre `flex-1 min-h-0 overflow-auto`.
