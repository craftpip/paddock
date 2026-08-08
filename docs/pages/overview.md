# Pages

All pages are React components served from `src/client/src/pages/`. The built SPA lives at `src/public/` and is served by Express at the root path.

## Login (`/login`)

File: `Login.jsx`

Simple login form with password input. Submit calls `POST /api/login`. On success redirects to `/agents`. On error shows error message. If the server has no AUTH_PASSWORD set, redirects immediately.

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
- **Tab order** — Core tools first, then configuration, then Settings. Sessions and Activity tabs removed.
- **Activity merged into Overview** — full activity table shown in Overview tab below quick links.

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

- **Standardized confirmation modals** — supports title, message, danger styling, confirm/cancel buttons.
- **Keyboard shortcuts** — Ctrl+K (search), Ctrl+N (new agent), Ctrl+S (save).
- **Toast notification improvements** — stacking, auto-dismiss, action/undo buttons, slide-in animation.
- **Offline/broken state handling** — shows "Connection lost" when backend is unreachable.

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

**Creation flow (live streaming):**
1. Form submits via fetch — POST `/api/agents/create` returns `202` immediately and a background job starts
2. The form is replaced by a live log pane (the shared `Console.jsx` component) that streams the **real command output** over SSE — no fake spinner steps
3. Steps appear as labeled command lines as they start: **build** → **up** → **setup** (fresh OpenClaw/PicoClaw) or **restore** (clone from backup) → **done**
4. **Clone path:** success banner, then auto-navigates to the agent detail after ~1.8s
5. **Fresh path:** success banner + prominent "Go to Agents" button — no auto-navigation, so the user can scroll the logs
6. **Failure:** red banner + error tail in the log pane; "back to form" or retry — never navigates

The SSE stream reconnects with `Last-Event-ID` on drop; polling `/create-status` is the fallback.

**What was removed:**
- No more clone-from-running-PAD dropdown
- No separate progress page that broke layout

## Agent Detail (`/agents/:id`)

File: `AgentDetail.jsx`

Layout shell with a sidebar, 8 mode tabs, and a docked terminal. See `tabs/`
docs for each mode.

Sidebar:
- Agent avatar + name + display name
- Status badge with pulse animation for transitions
- Live CPU/MEM stats on running agents (hover for Network/Disk I/O)
- Start/Stop/Restart buttons
- Mode navigation (8 tabs)

Modes are defined in the `MODES` array in AgentDetail.jsx:
| Mode | Component | Feature |
|------|-----------|---------|
| commands | CommandsPane.jsx | Command pill flow + Run TUI + Vault dropdown (default landing mode) |
| workspace | — | File browser, editor, upload |
| config | — | Editor for the driver's config file (openclaw.json / opencode.json / config.yaml / config.toml) |
| web | WebTab.jsx | Publish the agent's built-in web app on a host port |
| logs | — | Container logs viewer (persistent log store) |
| sessions | — | Chat session list |
| activity | — | Event timeline |
| settings | SettingsTab.jsx | Update, health checkup, docker, network, delete |

The terminal is docked at the bottom of every mode — always mounted, one per
agent, auto-collapsed outside Commands. See [tabs/terminal.md](../tabs/terminal.md).

## Settings Tab (per-PAD)

Container-level operations on the agent detail page: image refresh (Update),
container health checkup, docker access, network routing, and delete. Runs as
SSE-streamed background jobs with a Console popup. See
[tabs/settings.md](../tabs/settings.md) for the full contract.

## Global Backups (`/backups`)

File: `GlobalBackups.jsx`

Global listing of all backup archives from the `backups/` folder. Features:

- **Quick Backup** — one button per running PAD, each with a status dot indicator
- **Table columns** — File Name (actual `.tar.gz` filename), Agent (with amber dot + "orphan" tag for deleted PADs), Type badge (OpenClaw/PicoClaw), Created (date, time, and relative time), Size, Actions (Download / Delete)
- **Download** — direct link to the archive
- **Delete** — with confirmation dialog
- **Empty state** — icon with message when no backups exist

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

## Onboard (`/onboard/:name`)

File: `Onboard.jsx`

Wizard for setting up a new PAD: Telegram bot token, channel config, API keys.
