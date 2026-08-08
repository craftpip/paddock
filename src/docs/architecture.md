# VM Friends — Architecture Document

> **Source of Truth.** This document describes how the VM Friends system works. If code and this document disagree, the code should be fixed to match this document.

---

## 1. Project Overview

VM Friends is a **self-hosted AI agent management platform**. It manages a fleet of Docker containers (each running an AI agent runtime like OpenClaw or PicoClaw) through a browser-based management dashboard.

**Core responsibilities:**
- Provision and destroy agent containers (Docker)
- Monitor agent status (running/stopped/missing)
- Provide a file browser (workspace) for each agent
- Provide a WebSocket-based terminal to each agent
- Manage `openclaw.json` configuration files
- Manage secrets via the encrypted Vault (`/vault`, AES-256-GCM)
- Track model providers (OpenAI, OpenRouter, Ollama Cloud, etc.)
- Track session and activity history per agent
- Support OAuth and API-key-based model provider auth

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────┐
│                      Host Machine                         │
│                                                           │
│  /home/boniface/www/vm-friends/                           │
│                                                           │
│  ┌──────────────────────────────────────────────────┐     │
│  │            vm-webui (Port 5050)                   │     │
│  │  Node.js/Express + EJS + HTMX + Tailwind + WS    │     │
│  │  src/app.js + src/views/ + src/services/         │     │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────────────┐ │     │
│  │  │ Express  │ │routes/   │ │services/          │ │     │
│  │  │ Server   │ │agents.js│ │ agent-registry.js  │ │     │
│  │  │ app.js   │ │         │ │ vm-manager.js      │ │     │
│  │  │          │ │         │ │ backup-manager.js  │ │     │
│  │  │          │ │         │ │ workspace.js       │ │     │
│  │  │          │ │         │ │ db.js              │ │     │
│  │  └──────────┘ └──────────┘ └───────────────────┘ │     │
│  │  Volumes: /var/run/docker.sock (Docker access)    │     │
│  └──────────────────────────────────────────────────┘     │
│                                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ vm-ozden│ │ vm-jake │ │ vm-test │ │ vm-test2     │ │
│  │ OpenClaw│ │ OpenClaw│ │ OpenClaw│ │ PicoClaw     │ │
│  │ :22     │ │ :22     │ │ :22     │ │ :22          │ │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘ │
│                                                           │
│  ┌──────────────────────────────────────────────────┐     │
│  │              instances/                           │     │
│  │  vm-ozden/meta.env + openclaw/openclaw.json      │     │
│  │  vm-jake/meta.env  + openclaw/openclaw.json      │     │
│  │  vm-test/meta.env  + openclaw/openclaw.json      │     │
│  │  vm-test2/meta.env + picoclaw/openclaw.json       │     │
│  └──────────────────────────────────────────────────┘     │
│                                                           │
│  ┌──────────────────────────────────────────────────┐     │
│  │                   backups/                        │     │
│  │  vm-ozden_20260719_120000.tar.gz                 │     │
│  │  vm-jake_20260719_130000.tar.gz                  │     │
│  └──────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────┘
```

**Key principle:** The dashboard (`vm-webui`) communicates with agent containers **only through Docker**. It never SSHs into them. File access is through the bind-mounted `instances/` directory on the host.

---

## 3. Directory Structure

```
/workspace/
├── docker-compose.yml              # Base services (vm-webui, vm-ozden, vm-pranav)
├── docker-compose.override.yml     # Auto-generated override (adds all other VMs)
├── .env                            # Environment variables (WEBUI_PASSWORD, etc.)
├── AGENTS.md                       # Agent operational learnings (not business logic)
│
├── src/                            # vm-webui application
│   ├── app.js                      # Express server + legacy routes + WS terminal
│   ├── Dockerfile                  # node:20-slim + docker-ce-cli
│   ├── package.json                # express, ejs, ws, better-sqlite3, multer
│   ├── data/
│   │   └── app.db                  # SQLite metadata store (agents, activity, sessions)
│   ├── middleware/
│   │   ├── auth.js                 # Session auth, CSRF, login/logout
│   │   └── rateLimit.js            # IP-based rate limiter (300 req/min)
│   ├── routes/
│   │   └── agents.js               # All /agents/* routes (CRUD, workspace, runtime)
│   ├── services/
│   │   ├── agent-registry.js       # Agent discovery from filesystem + Docker
│   │   ├── vm-manager.js           # createVm, removeVm, resetVm, compose generation
 │   │   ├── backup-manager.js       # Removed — stub until native backups (plan 26)
│   │   ├── workspace.js            # Safe file operations with path traversal protection
│   │   └── db.js                   # SQLite CRUD + schema migration
│   ├── views/
│   │   ├── layout.ejs              # Main layout (Tailwind, HTMX, xterm.js, CodeMirror)
│   │   ├── login.ejs               # Session-based login page
│   │   ├── backups.ejs             # Global backups page (all agents)
│   │   ├── onboard.ejs             # Onboard form (Telegram + API key setup)
│   │   ├── agents/
│   │   │   ├── dashboard.ejs       # Agent fleet grid with search/filter
│   │   │   ├── create.ejs          # Create agent form
│   │   │   ├── detail.ejs          # Tabbed detail page (9 tabs)
│   │   │   ├── workspace.ejs       # File browser with upload/download/rename/delete
│   │   │   ├── terminal.ejs        # xterm.js terminal
│   │   │   ├── logs.ejs            # Container logs with auto-refresh
│   │   │   ├── config.ejs          # CodeMirror JSON config editor
│   │   │   ├── models.ejs          # Model provider management (Primary, Fallback, Add)
│   │   │   ├── messaging.ejs       # Telegram config editor (token, policy, allowlist)
│   │   │   ├── backups.ejs         # Per-agent backup list
│   │   │   ├── sessions.ejs        # Session history table
│   │   │   └── activity.ejs        # Activity timeline
│   │   └── partials/
│   │       ├── card.ejs            # Agent card component (HTMX start/stop/restart)
│   │       ├── sidebar_status.ejs  # Sidebar status block (HTMX start/stop/restart)
│   │       ├── status_badge.ejs    # Status badge (running/stopped)
│   │       ├── error.ejs           # Error message partial
│   │       ├── api_key_row.ejs     # API key table row
│   │       ├── bot_token_row.ejs   # Bot token table row
│   │       └── user_id_row.ejs     # User ID table row
│   ├── public/
│   │   ├── xterm.js / xterm.css            # xterm.js terminal emulator
│   │   ├── xterm-addon-fit.js              # Fit addon for terminal
│   │   ├── xterm-addon-web-links.js        # Web links addon
│   │   └── codemirror/*                    # CodeMirror for JSON/YAML editing
│   └── test/
│       └── services.test.js       # Unit tests (workspace, registry, db, auth)
│
├── instances/
│   ├── vm-<name>/                  # One directory per agent
│   │   ├── meta.env                # Identity: AGENT, ROOT_PASSWORD, PORT
│   │   └── <agent-type>/           # e.g., openclaw/, picoclaw/
│   │       ├── openclaw.json       # Agent config (the "source of truth" file)
│   │       └── workspace/          # Agent's workspace (bind-mounted)
│
├── vm_openclaw/                    # Docker build context for OpenClaw
├── vm_picoclaw/                    # Docker build context for PicoClaw
├── vm_hermes/                      # Docker build context for Hermes
├── vm_nanobot/                     # Docker build context for Nanobot
│
├── backups/                         # Legacy generic archives (untouched, not restorable)
│
├── scripts/
│   ├── daily-commit.sh             # Auto git commit (cron)
│   └── record-usage.sh             # Usage tracking
│
├── task_create_docs.md             # Current task tracker
└── docs/
    └── architecture.md             # THIS FILE
```

---

## 4. Docker Infrastructure

### 4.1 Agent Types

| Agent Type   | Docker Image                          | Container Data Dir | Build Context   |
|-------------|---------------------------------------|-------------------|-----------------|
| `openclaw`  | `vm-friends-vm-openclaw:latest`       | `/root/.openclaw` | `./vm_openclaw` |
| `picoclaw`  | `vm-friends-vm-picoclaw:latest`       | `/root/.picoclaw` | `./vm_picoclaw` |
| `hermes`    | `vm-friends-vm-hermes:latest`         | `/opt/data`       | `./vm_hermes`   |
| `nanobot`   | `vm-friends-vm-nanobot:latest`        | `/root/.nanobot`  | `./vm_nanobot`  |

The mapping is defined in `src/services/vm-manager.js:21-33` (`AGENT_IMAGES` and `AGENT_BUILD` constants).

### 4.2 Docker Compose

**`docker-compose.yml`** defines the base services:
- `vm-webui` — the management dashboard (always present)
- `vm-ozden` — first agent (template for others)

**`docker-compose.override.yml`** is **auto-generated** by `vm-manager.generateOverrideYaml()`. It reads all `instances/vm-*/meta.env` files and generates a compose service entry for each.

The override file is regenerated whenever:
- A VM is created (`createVm`)
- A VM is removed (`removeVm`)
- A VM is reset (`resetVm`)

Each service entry includes:
- Build context (based on agent type)
- Container name
- `restart: unless-stopped`
- Port mapping (if `meta.PORT` is set, maps to container port 22 for SSH)
- Volume bind-mount: `./instances/<name>/<agent-type>:/root/.<agent-type>`
- Environment: `TZ=Asia/Kolkata`, `ROOT_PASSWORD=xxx`

### 4.3 VM Name Convention

All VM names must match: `^vm-[a-zA-Z0-9][a-zA-Z0-9_-]*$`

The name regex is defined in two places (must stay in sync):
- `src/app.js:23` (`VM_NAME_RE`)
- `src/services/agent-registry.js:7` (`VM_NAME_RE`)

### 4.4 vm-webui Container

**Dockerfile** (`src/Dockerfile`):
- Base: `node:20-slim`
- Installs: docker-ce-cli, docker-compose-plugin, python3, build tools (for better-sqlite3 native addon)
- Port: 5050
- CMD: `node app.js`

**Volumes** (3 mounts):
1. Project root → `/workspace:rw` — access to instances/, backups/, compose files
2. `src/` → `/app:rw` — live code reload without rebuild
3. `/var/run/docker.sock` → Docker access to manage other containers

---

## 5. WebUI Application (`src/app.js`)

### 5.1 Server Setup

```
Express + express-ejs-layouts + cookie-parser + express-session
  → EJS views at ./views/
  → Static files at ./public/
  → Rate limiter (300 req/min/IP)
  → Session auth (AUTH_PASSWORD env var)
  → CSRF token on all sessions
```

**Key app-level decisions:**
- `app.set('view engine', 'ejs')`
- `app.use(layouts)` — layout.ejs wraps all pages
- `app.use(express.urlencoded({ extended: true }))`
- `app.use(express.json())`
- `app.use(cookieParser())`
- `app.use(express.static('public'))` — serves xterm.js, CodeMirror, etc.
- `app.use(rateLimit)` — all routes rate-limited
- `app.use(csrfToken)` — CSRF token injected into every session

### 5.2 HTMX Handling Middleware

When an HTMX request is detected (`req.headers['hx-request']`), the middleware at `app.js:67-77` forces `layout: false` so only the partial HTML is returned (no full page wrapper). This is a monkey-patch on `res.render`.

### 5.3 Route Map

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | `/` | Redirect | → `/agents` |
| GET | `/login` | `handleLogin` | Login form |
| POST | `/login` | `handleLogin` | Authenticate |
| GET | `/logout` | `handleLogout` | Destroy session |
| GET | `/agents` | `agents.js` | Agent dashboard |
| GET | `/agents/create` | `agents.js` | Create agent form |
| POST | `/agents/create` | `agents.js` | Create agent |
| GET | `/agents/:id` | `agents.js` | Agent detail |
| GET | `/agents/:id/*` | `agents.js` | Agent sub-pages |
| GET | `/vm/:name` | Redirect | → `/agents/:name` |
| POST | `/vm/:name/start\|stop\|restart` | Direct | Docker lifecycle |
| POST | `/vm/:name/remove\|reset` | `vm-manager.js` | Remove/reset |
| GET | `/vm/:name/meta\|config\|logs` | Direct | Read data |
| GET | `/onboard/:name` | Direct | Onboard form |
| POST | `/onboard/:name/run` | Direct | Execute onboard |
| GET | `/api/vms\|user-ids\|api-keys` | Direct | JSON APIs |
| GET | `/api/profile/keys` | Direct | List own MCP API keys (prefix only, no raw key) |
| POST | `/api/profile/keys` | Direct | Create an MCP API key (raw key returned once) |
| DELETE | `/api/profile/keys/:id` | Direct | Revoke own MCP API key |
| POST | `/api/providers/add` | Direct | Add model provider |
| POST | `/api/config/backup\|restore/:agent` | Direct | Config save/restore |
| POST | `/mcp` | `mcp.js` | MCP tools call (Streamable HTTP, API-key auth) |
| GET | `/mcp` | `mcp.js` | MCP SSE client connection (API-key auth) |
| DELETE | `/mcp` | `mcp.js` | Terminate MCP SSE session (API-key auth) |
| WS | `/ws/terminal/:name` | Direct | WebSocket terminal |

### 5.4 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_PASSWORD` | Yes (if auth desired) | `''` (no auth) | Session login password |
| `SESSION_SECRET` | No | Random 32 bytes | Session signing secret |
| `WORKSPACE_ROOT` | No | `/workspace` | Project root path |
| `WEBUI_PASSWORD` | No | `''` | From .env file, same as AUTH_PASSWORD |
| `DEFAULT_MODEL_BASE_URL` | No | `http://10.69.1.131:11434/v1` | Default Ollama base URL |
| `DEFAULT_MODEL_NAME` | No | `gpt-oss:20b-73728` | Default model |
| `DEFAULT_CONTEXT_LENGTH` | No | `96000` | Default context window |
| `DEFAULT_ALLOW_FROM` | No | `532156945` | Default Telegram user ID |

### 5.5 Helper Functions

**`runCmd(cmd, args, options)`** — Wraps `child_process.execFile()` in a Promise. Options: `timeout`, `check` (reject on non-zero), `input` (stdin string).

**`dockerPsList(force)`** — Executes `docker ps -a --format '{{json .}}'` and parses the JSON lines. Results cached for 3 seconds. Returns a map of `{ containerName: containerObject }`.

**`getVmStatus(vmName)`** — Returns the `State` field from cached Docker data, or `'stopped'`.

**`readMeta(vmName)`** — Parses `instances/<vmName>/meta.env` into a key-value object.

**`getAllVms()`** — Lists all `vm-*` directories in `instances/`, reads their meta.env, checks Docker status, and returns an array of VM objects.

**`dockerExec(vmName, cmd)`** — Runs a shell command inside a container: `docker exec -i <vmName> sh -lc '<cmd>'`.

**`dockerLogs(vmName, tail)`** — Gets the last N log lines from a container: `docker logs --tail N <vmName>`.

**`safeVmName(name)`** — Validates VM name against `VM_NAME_RE`, returns `null` if invalid.

**`stripSensitiveMeta(meta)`** — Removes `ROOT_PASSWORD` from meta objects.

**`stripSensitiveConfig(data)`** — Redacts `api_keys`, `telegram.botToken`, and plugin keys (replaces with `'[REDACTED]'`).

---

## 6. Agent Discovery & Registry (`src/services/agent-registry.js`)

### 6.1 How Agents Are Discovered

`discoverAgents()` runs on every dashboard page load:
1. Run `docker ps -a` to get all container states
2. List `instances/` directory, filter to `vm-*` subdirectories
3. For each directory that has a `meta.env` file, build an agent object
4. Sync each agent to the SQLite metadata store

A directory in `instances/` without a `meta.env` is invisible to the system.

### 6.2 Agent Object Structure

```javascript
{
  id: 'vm-test',                    // Same as name
  name: 'vm-test',
  display_name: 'Test',             // Capitalized name without vm- prefix
  agent_type: 'openclaw',           // From meta.env AGENT= field
  runtime_type: 'docker',           // Always 'docker'
  runtime_ref: 'vm-test',           // Used for docker commands
  status: 'running'|'exited'|'missing',
  workspace_root: '/workspace/instances/vm-test/openclaw/workspace',
  config_root: '/workspace/instances/vm-test/openclaw',
  default_model: 'ollama/gpt-oss:20b-73728',   // From openclaw.json
  default_provider: 'ollama',                   // Extracted from primary model
  tags: [],
  created_at: '2026-07-01T...',
  updated_at: '2026-07-19T...',
  last_activity_at: '2026-07-19T...'
}
```

### 6.3 Agent Directory Resolution

`findAgentDir(vmDir, agentType)` tries two approaches:
1. Look for `<agentType>` subdirectory (e.g., `openclaw/`)
2. Fallback: scan all subdirectories for one containing `openclaw.json`

### 6.4 Status Determination

Agent status comes from Docker state:
- Container exists and `State` is `'running'` → `'running'`
- Container exists and `State` is anything else → `'exited'`
- Container doesn't exist → `'missing'`

### 6.5 Docker Cache

- Cache TTL: 3 seconds
- Stored as a module-level `_dockerCache` variable
- `dockerPsList(true)` forces a refresh
- The cache is invalidated after any lifecycle action (start/stop/restart/create/remove)

---

## 7. VM/Agent Lifecycle

### 7.1 Create Agent (`vm-manager.createVm()`)

**Flow:**
1. Validate name doesn't already exist (check compose files + filesystem)
2. Generate password (default: name without `vm-` prefix)
3. Optionally allocate SSH port (starts at 43817, finds first available)
4. Create `instances/<name>/<agent-type>/` directory
5. If mode is `clone`, copy all files from source agent's directory
6. Write `meta.env` with `ROOT_PASSWORD`, `AGENT`, and optional `PORT`
7. Regenerate `docker-compose.override.yml`
8. Run `docker compose up -d <name>` to start the container
9. If `defaultConfig` is requested:
   - Run `openclaw onboard --non-interactive --accept-risk ...` inside container
   - Wait for `openclaw.json` to appear (poll up to 60s)
   - Apply default config: Telegram bot token, model provider, allowlist
   - Restart container
10. If an API key provider is specified (from `app.js` POST handler):
    - Wait 3 seconds
    - Run `docker exec -i <name> openclaw models auth paste-api-key --provider <provider>`

**Visual:** For `POST /agents/create` → `POST /vm/create` (redirect).

### 7.2 Start / Stop / Restart

All three use `lifecycleCmdBg()` pattern in `src/routes/agents.js`:

```javascript
lifecycleCmdBg('start', agentName, runtimeRef, auditFn)
```

- Start: Try `docker start <name>`, fallback to `docker compose up -d <name>`
- Stop: `docker stop <name>`
- Restart: `docker restart <name>`

**HTMX behavior:**
- If the request is HTMX (`hx-request` header), return the card partial immediately with a `poll` parameter
- The card polls every 2s via `hx-trigger="every 2s"` until the expected status is reached
- After 30 seconds, polling stops (fallback script in card)
- If non-HTMX, set a flash message and redirect

### 7.3 Remove Agent (`vm-manager.removeVm()`)

1. `docker rm -f <name>` (ignore errors)
2. Delete `instances/<name>/` directory recursively
3. Regenerate override YAML

### 7.4 Reset Agent (`vm-manager.resetVm()`)

1. Force-remove the container
2. Delete the agent's data directory (but keep meta.env)
3. Recreate empty agent directory
4. Regenerate override YAML
5. Docker compose up to recreate the container fresh

---

## 8. Backup System (`src/services/backup-manager.js`)

**Removed (plan 26 pre-plan).** The generic archive system is gone: Paddock no
longer runs `tar` over a driver's `dataDir`, extracts archives over the live
data directory, or clones a PAD from an archive at create time.
`backup-manager.js` is a stub that refuses every operation.

Native per-driver backup/restore capabilities replace it in plan 26 Goal 0
(OpenClaw archive create, Hermes full backup/import, session export for OpenCode,
unsupported for PicoClaw/Codex). The Backups routes and MCP tools were removed
with the generic system and are reintroduced only in Goal 0.

---

## 9. Workspace Service (`src/services/workspace.js`)

### 9.1 Path Safety

`resolveSafePath(workspaceRoot, relativePath)` is the gatekeeper:

1. If path is `'/'` or empty, return workspaceRoot
2. Normalize the path, strip leading `/`
3. Resolve against workspaceRoot
4. Check the resolved path starts with `workspaceRoot + path.sep` OR equals workspaceRoot
5. If not, throw `'Path traversal rejected'`

This blocks: `../../etc/passwd`, `/etc/passwd`, `foo%2F..%2F..%2Fetc%2Fpasswd`

### 9.2 File Operations

All operations call `getAgent()` via `agent-registry` to get the agent's `workspace_root` path, then resolve through `resolveSafePath()`.

| Operation | Method | Description |
|-----------|--------|-------------|
| List directory | `listDir(agentId, path)` | Returns `{ path, entries: [{ name, type, size, modified }] }` |
| Read file | `readFile(agentId, path)` | Returns `{ content, size, modified, name }` |
| Write file | `writeFile(agentId, path, content)` | Atomic write, returns file metadata |
| Stat file | `statFile(agentId, path)` | Returns file metadata or null |
| Create folder | `createFolder(agentId, path, name)` | `mkdirSync` with recursive |
| Rename | `renameEntry(agentId, path, newName)` | Rename file or folder |
| Delete | `deleteEntry(agentId, path)` | Delete file or folder (recursive if dir) |
| Move | `moveEntry(agentId, fromPath, toDir)` | Move file to another directory |

### 9.3 Hidden Files

Files starting with `.` are **filtered out** of directory listings. This is intentional — dotfiles are considered system/internal.

### 9.4 Upload Limits

- **Max file size:** 100 MB (controlled by `MAX_UPLOAD_SIZE`)
- **Max download size:** 50 MB
- **Blocked extensions:** `.exe`, `.bat`, `.cmd`, `.ps1`, `.dll`, `.so`, `.dylib`
- `.sh` is allowed (explicitly whitelisted from the block list)

### 9.5 Previewable Files

The `isPreviewable()` function determines if a file can be opened in the CodeMirror editor. It checks the extension against a list of 40+ text-based extensions. Binary files and archives are not previewable.

### 9.6 MIME Type Mapping

`getMimeType()` maps extensions to Content-Type headers for file downloads. Falls back to `text/plain`.

---

## 10. Vault (Secret Storage)

The legacy credentials system (`src/creds.js`, `/api/credentials*`, the Credentials
page) has been **removed**. Secrets now live in the encrypted Vault.

### 10.1 Storage

`src/services/vault.js` stores secrets in `src/data/vault.json`, encrypted with
AES-256-GCM using the `VAULT_KEY` environment variable. The Vault is a simple
key-value store; items are not owner-scoped.

### 10.2 API

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/vault` | List all items (values decrypted) |
| POST | `/api/vault` | Add/update an item |
| DELETE | `/api/vault/:id` | Remove an item |

### 10.3 UI

`src/client/src/pages/Vault.jsx` renders the Vault at `/vault` (nav item "Vault").
The old `/credentials` URL redirects to `/vault`.

---

## 11. Web UI Pages

### 11.1 Layout (`layout.ejs`)

Common to all pages:

**Nav bar** (sticky top):
- "VM Friends" logo → `/agents`
- "Agents" → `/agents`
- "+ Agent" → `/agents/create`
- "Vault" → `/vault`
- "Backups" → `/backups`
- Logout button

**Global features:**
- Toast notification system (`VMF.toast()`)
- Confirmation modal (`VMF.confirm()`)
- Keyboard shortcut: `Ctrl+K` focuses search, `Escape` closes modal

**CDN dependencies:**
- Tailwind CSS (CDN)
- HTMX 2.0.4
- xterm.js (local)
- CodeMirror (local)

**Terminal system (`VMF.initTerminal`):**
- IntersectionObserver defers `fit()` until terminal is visible
- ResizeObserver for continuous auto-resize
- Font size controls (A+/A-)
- WebSocket reconnection logic
- Dark theme with cyan accents

**HTMX handling:**
- `htmx:afterSwap` event re-executes `<script>` tags in swapped content
- Terminal instances are re-initialized after swap
- Global script src references are tracked via `data-hmxGlobal` to avoid duplicates

### 11.2 Login (`login.ejs`)

- Standalone page (no nav, no layout)
- Simple password form
- Error message display
- Redirects to return URL after login

### 11.3 Agent Dashboard (`agents/dashboard.ejs`)

**Route:** `GET /agents`

**Content:**
- Header with agent count stats (total, running, stopped)
- Search input: client-side filtering by name/display name
- "New Agent" button
- Grid of agent cards (1-3 columns responsive)
- Empty state with CTA to create first agent

**Client-side search:**
```javascript
function filterAgents(query) {
  // Filters .agent-card elements by data-name and data-display
  // Shows/hides cards, toggles "no results" message
}
```

### 11.4 Agent Card (`agents/partials/card.ejs`)

**Rendered by:** Dashboard and lifecycle action routes (HTMX)

**Content:**
- Agent initial avatar (first letter of display name)
- Display name (link to detail page)
- VM name
- Status badge (colored: green=running, red=exited, gray=other)
- Agent type label
- Default model (if set)
- Action buttons (conditional on status):
  - Running: Stop (amber square), Restart (cyan refresh)
  - Stopped: Start (green play)
  - In transition: Spinner icon

**Polling behavior:** When `poll` parameter is set (e.g., `{ poll: 'running' }`), the card:
- Shows a "starting"/"stopping" animated badge
- Polls every 2s via `hx-trigger="every 2s"` to a `GET /agents/:name/card?expect=<state>` endpoint
- Stops polling after 30 seconds (injected `<script>` removes the hx-get attribute)

### 11.5 Create Agent (`agents/create.ejs`)

**Route:** `GET /agents/create`

**Form fields:**
- Agent name (prepended with `vm-`)
- Agent type (dropdown: OpenClaw, PicoClaw, Hermes)
- Clone from (dropdown of existing agents, or "Fresh install")

**Submission:** `POST /agents/create` → `POST /vm/create` → creates VM, redirects to agent detail

### 11.6 Agent Detail (`agents/detail.ejs`)

**Route:** `GET /agents/:agentId`

**Layout:** Sidebar + content area (flex layout, full height)

**Sidebar:**
- Status block (avatar, name, status badge, Start/Stop/Restart buttons) — **polling same as card**
- Navigation tabs (9 tabs):
  1. Overview (default)
  2. Workspace
  3. Terminal
  4. Logs
  5. Sessions
  6. Config
  7. Models
  8. Messaging
  9. Backups
  10. Activity

**Tab loading:** All tabs except Overview use **HTMX lazy loading** (`hx-get`, `hx-trigger="load"`). Each tab shows a skeleton placeholder while loading.

**Tab switching:** JavaScript (`VMFswitchTab`):
- Updates sidebar button styling (cyan highlight border)
- Shows/hides tab panels
- Updates URL hash
- Refreshes CodeMirror if present

**Overview tab:**
- 3 info cards: Type, Runtime, Model
- Quick links: Workspace, Terminal
- Recent activity (last 5 events)

### 11.7 Workspace (`agents/workspace.ejs`)

**Route:** `GET /agents/:agentId/workspace`

**Rendered by:** HTMX lazy load from detail page

**Components:**
- Breadcrumbs (clickable, HTMX-powered navigation)
- Action bar:
  - Create file (inline form: name input + button)
  - Create folder (inline form: name input + button)
  - Upload (click or drag-and-drop)
  - Upload progress bar
- File table:
  - Name (click for directory navigation, click for file preview)
  - Size (hidden on mobile)
  - Modified (hidden on mobile)
  - Actions: Download (files only), Rename, Delete
  - "Up" link when not at root

**File preview modal:**
- Opens on file click via `openFile(filePath)`
- Fetches file content via JSON API
- Shows in CodeMirror (JSON/YAML) or textarea (other text), or plain `<pre>` (non-editable)
- Save button (with JSON/YAML validation on blur)
- Save via POST to `/agents/:name/workspace/save`
- Ctrl+S shortcut
- Download button

**Drag-and-drop upload:**
- Visual feedback on dragover (cyan border highlight)
- Upload via FormData + XMLHttpRequest (with progress tracking)
- Redirects back to workspace on completion

### 11.8 Terminal (`agents/terminal.ejs`)

**Route:** `GET /agents/:agentId/terminal`

**Rendered by:** HTMX lazy load from detail page

**Components:**
- Terminal header: status indicator (dot), status text, agent name, dimensions (e.g., 80x24)
- Toolbar: font size controls (A-/A+), font size display, Clear, Reconnect
- Terminal container: `#terminal-container` with `data-agent-name` attribute
- Height: 70vh, min 480px

**Behavior:** See section 13 (WebSocket Terminal).

### 11.9 Logs (`agents/logs.ejs`)

**Route:** `GET /agents/:agentId/logs`

**Rendered by:** HTMX lazy load from detail page

**Components:**
- Header: title, live indicator (green pulsing dot), log line count selector (50/100/500/1000), auto-scroll toggle, Refresh button
- Scrollable `<pre>` block

**Auto-refresh:**
- Polls every 5 seconds via `setInterval`
- Auto-scroll enabled by default, disables if user scrolls up
- IntersectionObserver pauses polling when tab hidden, resumes when visible
- Scroll button toggles auto-scroll mode

### 11.10 Config (`agents/config.ejs`)

**Route:** `GET /agents/:agentId/config`

**Rendered by:** HTMX lazy load from detail page

**Components:**
- Header: "Agent Configuration" with filename `openclaw.json`
- Status indicator (valid JSON / unsaved changes / saved)
- CodeMirror JSON editor (dark theme, line numbers, matching brackets, auto-close brackets)

**Behavior:**
- Initial value: stringified `openclaw.json` (full raw, before redaction — sent as textarea value only, never exposed via JSON API)
- Dirty tracking: compares current value to original
- Validation: parses JSON on blur and save
- Save via POST to `/agents/:name/config`
- After save: "Restart the agent to apply" flash message
- Ctrl+S saves

### 11.11 Models (`agents/models.ejs`)

**Route:** `GET /agents/:agentId/models`

**Rendered by:** HTMX lazy load from detail page

**Components:**

**Primary Model section:**
- Displays current primary model (from `agents.defaults.model.primary`)
- Read-only display

**Fallback Model section:**
- Displays current fallback model (from `agents.defaults.model.fallback`)
- "Remove" button (HTMX, clears the fallback)

**Configured Providers list:**
- One card per provider (e.g., ollama, openai, openrouter)
- Each card shows a table of models with columns: Model ID, Input type, Context window
- Per-model actions:
  - "★ Primary" button (HTMX, sets model as primary, cyan when active)
  - "⤵ FB" button (HTMX, sets model as fallback, amber when active)
- Provider-level "Remove" button with confirmation (HTMX + hx-confirm)

**Add Provider section:**
- **OAuth providers** (openai, google, github-copilot): Card with "OAuth Login" button
  - Click triggers `POST /agents/:name/models/oauth-login`
  - Opens modal with URL + code
  - Polls `oauth-status` every 5 seconds
  - On completion, reloads models tab
- **API key providers** (from catalog): Card with "+ Setup" button
  - Click reveals inline password input + "Add" button
  - Posts to `/api/providers/add`
- **Custom provider**: Form at bottom with provider ID + API key inputs

**Config save/restore flow for adding providers:**
1. Save current `openclaw.json` to `openclaw.json.bak`
2. Run `paste-api-key --provider <provider>` (which overwrites config)
3. Merge saved config with new auth info
4. Restore config, keeping new `auth` and `meta` sections
5. Populate model list from `openclaw models list --all --json`

### 11.12 Messaging (`agents/messaging.ejs`)

**Route:** `GET /agents/:agentId/messaging`

**Rendered by:** HTMX lazy load from detail page

**Components:**
- Telegram settings card:
  - Bot token (password input)
  - DM Policy (dropdown: allowlist / pairing)
  - Allowed User IDs:
    - Saved user IDs shown as toggleable pills (cyan = active, gray = inactive)
    - Clicking a pill toggles that user ID in the allowlist
    - Custom ID input + Add button (saves to the agent allowlist)
    - In pairing mode, the allowlist is hidden
- Save button (dirty tracking, saves full config to `/agents/:name/config`)

**Data flow:**
- Config is read from raw `openclaw.json` (hidden textarea)
- UI reads/writes to this hidden textarea's JSON
- On save, the entire JSON is POSTed to the config endpoint
- `preserveSecrets()` in the route handler ensures redacted fields aren't overwritten

### 11.13 Backups (per-agent) (`agents/backups.ejs`)

**Removed (plan 26 pre-plan).** The per-agent backup tab no longer exposes
Create/Restore/Download/Delete actions. It shows a maintenance empty state until
plan 26 Goal 0 ships the native Backups tab.

### 11.14 Sessions (`agents/sessions.ejs`)

**Route:** `GET /agents/:agentId/sessions`

**Rendered by:** HTMX lazy load from detail page

**Content:**
- Table of recent sessions (last 50) from SQLite: ID (truncated), Kind (badge), Status (colored badge), Model, Tokens (in+out), Started at
- Empty state: "No sessions recorded yet"

### 11.15 Activity (`agents/activity.ejs`)

**Route:** `GET /agents/:agentId/activity`

**Rendered by:** HTMX lazy load from detail page

**Content:**
- Table of activity events (last 100): Action (with colored icon), Details, Timestamp
- Action colors: start=emerald, stop=amber, restart=cyan, other=slate
- Status badges: ok (green) / err (red)
- Empty state: "No activity recorded yet"

**Activity categories:** lifecycle (create/start/stop/restart), config (update/set-primary/set-fallback/remove-provider), workspace (upload/save/rename/delete/create_folder/create_file)

### 11.16 Global Backups Page (`views/backups.ejs`)

**Removed (plan 26 pre-plan).** The global Backups page (`/backups`) no longer
lists generic archives or offers Quick Backup / Download / Delete actions. It
shows a maintenance empty state until plan 26 Goal 0 replaces it with a
manifest-backed list.

### 11.17 Vault Page (`/vault`)

The encrypted Vault page (`src/client/src/pages/Vault.jsx`) replaces the removed
Credentials page. It lists Vault items with add/edit/delete actions backed by
`/api/vault*`. Legacy `/credentials` URLs redirect here.

### 11.18 Onboard Page (`views/onboard.ejs`)

**Route:** `GET /onboard/:name`

**Content:**
- Status badge
- Agent info
- Telegram Bot section: Bot token input + saved tokens dropdown, User ID input + saved users dropdown
- Provider API Key section: Provider dropdown + key input + saved keys dropdown
- "Run Onboard" button (HTMX, output displayed in a pre block)
- Output area (pre-formatted text)

---

## 12. Route Map Detail: `/agents/:agentId` sub-routes

All defined in `src/routes/agents.js`.

### 12.1 Validation Middleware

`validateAgent` middleware runs before most routes:
1. Checks agent ID matches `VM_NAME_RE`
2. Calls `registry.getAgent(agentId)` to check existence
3. Stores `req.agent` for downstream use

### 12.2 Complete Sub-Route Table

| Method | Path | Description |
|--------|------|-------------|
| GET | `/agents/:agentId` | Detail page |
| GET | `/agents/:agentId/card` | Card partial (for polling) |
| GET | `/agents/:agentId/sidebar-status` | Sidebar status partial (for polling) |
| POST | `/agents/:agentId/start` | Start container |
| POST | `/agents/:agentId/stop` | Stop container |
| POST | `/agents/:agentId/restart` | Restart container |
| GET | `/agents/:agentId/workspace` | Workspace browser |
| GET | `/agents/:agentId/workspace/tree` | JSON directory listing |
| GET | `/agents/:agentId/workspace/file` | File content JSON |
| GET | `/agents/:agentId/workspace/download` | File download |
| POST | `/agents/:agentId/workspace/upload` | File upload (multipart) |
| POST | `/agents/:agentId/workspace/folder` | Create folder |
| POST | `/agents/:agentId/workspace/rename` | Rename entry |
| POST | `/agents/:agentId/workspace/delete` | Delete entry |
| POST | `/agents/:agentId/workspace/move` | Move entry |
| POST | `/agents/:agentId/workspace/save` | Save file content |
| POST | `/agents/:agentId/workspace/create-file` | Create new file |
| GET | `/agents/:agentId/terminal` | Terminal page |
| GET | `/agents/:agentId/logs` | Container logs |
| GET | `/agents/:agentId/config` | Config viewer/editor |
| POST | `/agents/:agentId/config` | Save config (full replace) |
| GET | `/agents/:agentId/messaging` | Messaging config |
| GET | `/agents/:agentId/models` | Model provider management |
| POST | `/agents/:agentId/models/set-primary` | Set primary model |
| POST | `/agents/:agentId/models/set-fallback` | Set fallback model |
| POST | `/agents/:agentId/models/remove-provider` | Remove provider |
| POST | `/agents/:agentId/models/oauth-login` | Start OAuth flow |
| GET | `/agents/:agentId/models/oauth-status` | Check OAuth status |
| POST | `/agents/:agentId/models/oauth-cancel` | Cancel OAuth flow |
| GET | `/agents/:agentId/activity` | Activity timeline |
| GET | `/agents/:agentId/sessions` | Session history |

---

## 13. WebSocket Terminal

> Full, self-contained write-up: **`src/docs/terminal.md`**. This section is
> the condensed contract.

### 13.1 Connection

WebSocket endpoint: `ws://<host>/ws/terminal/<vmName>?cols=<n>&rows=<n>`

**Authentication:** WebSocket connections bypass HTTP auth middleware and are validated on connection:
```javascript
const containers = await dockerPsList(true);
if (parts[0] !== 'ws' || parts[1] !== 'terminal' || !safeVmName(vmName) ||
    (containers[vmName]?.State || '').toLowerCase() !== 'running') {
  ws.close();
  return;
}
```

The container must be in `running` state. This checks the `State` property of the Docker JSON object.

### 13.2 Docker Exec (real PTY via Docker Engine API)

The terminal uses **dockerode** (`new Docker({ socketPath: '/var/run/docker.sock' })`) to create a
Docker-managed exec session with `Tty: true`. Docker allocates a **real PTY**, so Enter,
arrow keys, and raw-mode TUI apps (opencode, fzf, htop, ...) behave exactly like a local terminal:

```javascript
const dockerExec = await container.exec({
  AttachStdin: true,
  AttachStdout: true,
  AttachStderr: true,
  Tty: true,
  Env: ['TERM=xterm-256color'],
  Cmd: ['bash', '-i'],
});
const stream = await dockerExec.start({ hijack: true, stdin: true, stdout: true, stderr: true });
```

No `script` wrapper and **no `\r` → `\n` conversion** — the PTY line discipline handles CR/LF.

**Demux required:** the hijacked stream is multiplexed (8-byte frames
`[type:1][reserved:3][len:4 BE]`); the handler strips headers with
`dockerClient.modem.demuxStream(...)` so they never reach the WebSocket
(otherwise a printable length byte renders as a stray character).

### 13.3 Message Protocol

**Client → Server:**
- Raw text (keystrokes): written to the hijacked docker stream as-is.
- JSON `{ type: 'resize', cols: N, rows: N }`: calls `dockerExec.resize({ h: N, w: N })`.

**Server → Client:**
- Demuxed stdout/stderr decoded with `StringDecoder('utf8')` (handles multi-byte
  UTF-8 split across chunks) and sent as a text frame.

### 13.4 Resize Handling

- Initial PTY size comes from `?cols=&rows=` URL params and is applied immediately after
  `exec.start()` via `dockerExec.resize({ h: rows, w: cols })`.
- Live resize: the client sends `{ type: 'resize', cols, rows }` after `fit()` and font-size
  changes; the server calls the official `POST /exec/:id/resize` API. This resizes the actual
  running PTY (the old `docker exec stty` approach never worked because it targeted a new process).

### 13.5 Cleanup

On close/error of either WebSocket or docker stream:
- `dockerStream.destroy()` — closing the hijacked stream makes the Docker daemon kill the exec process.
- `ws.close()` if docker dies
- Cleanup runs at most once (`closed` guard flag)

### 13.6 Client-Side (xterm.js)

- **FitAddon** for auto-sizing
- **WebLinksAddon** for clickable URLs
- **IntersectionObserver**: Connects WebSocket only when terminal tab is visible
- **ResizeObserver**: Triggers fit + resize message on container resize
- **Font size**: 10-24 range, saved to variable (not persisted)
- **Scrollback**: 10,000 lines
- **Theme**: Professional dark with cyan accents

### 13.7 Locked / Read-only Mode (operator-driven)

The `<Terminal>` component supports being locked from outside (the `disabled`
prop or the imperative `lock()`/`unlock()`/`setLocked(v)` handle). While
locked, user keystrokes, paste, and Ctrl+C are dropped — only commands injected
via `runCommand()` execute. During an injected command the user can type again
(to answer prompts); when it finishes, the terminal auto-locks.

Since a PTY has no "command finished" signal, `runCommand()` in locked mode
appends a sentinel to the injected line — `<cmd>; echo; echo __PAD_DONE_<id>__`.
The client scans the output for `\n__PAD_DONE_<id>__` on a rolling tail; the
PTY-echoed copy of the injected line can't false-match (the sentinel sits
mid-line there).
`onCommandStart`/`onCommandDone` fire around the run, and a Locked/Running badge
+ stopped cursor blink reflect the state.

Timing gotcha: the `disabled` prop reaches the lock via a React effect, so
`runCommand()` called in the same tick that `disabled` flips to `true` runs
unlocked — operator flows should use the synchronous imperative `lock()` +
`runCommand()`. Full write-up in **`src/docs/terminal.md`**.

---

## 14. SQLite Data Model (`src/services/db.js`)

Database file: `src/data/app.db`

### 14.1 Schema

**`agents` table:**
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | VM name (e.g., `vm-test`) |
| `name` | TEXT UNIQUE | Same as id |
| `display_name` | TEXT | Capitalized without vm- prefix |
| `agent_type` | TEXT | `openclaw`, `picoclaw`, `hermes` |
| `runtime_type` | TEXT | Always `docker` |
| `runtime_ref` | TEXT | Container name |
| `status` | TEXT | `running`, `exited`, `missing` |
| `workspace_root` | TEXT | Absolute path |
| `config_root` | TEXT | Absolute path |
| `default_model` | TEXT | From openclaw.json |
| `default_provider` | TEXT | First segment of primary model |
| `tags` | TEXT | JSON array |
| `created_at` | TEXT | Auto-set |
| `updated_at` | TEXT | Auto-set |
| `last_activity_at` | TEXT | Updated on activity |

**`activity_events` table:**
| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK AUTO | |
| `agent_id` | TEXT FK→agents | |
| `category` | TEXT | `lifecycle`, `config`, `workspace` |
| `action` | TEXT | `create`, `start`, `stop`, `restart`, `update`, etc. |
| `actor` | TEXT | Default: `system` |
| `status` | TEXT | `ok`, `error` |
| `timestamp` | TEXT | Auto-set |
| `details` | TEXT | Human-readable description |
| `resource_ref` | TEXT | Optional reference |

**`sessions` table:**
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `agent_id` | TEXT FK→agents | |
| `kind` | TEXT | `direct`, etc. |
| `status` | TEXT | `active`, etc. |
| `summary` | TEXT | |
| `model` | TEXT | Model name used |
| `provider` | TEXT | Provider name |
| `tokens_in` | INTEGER | |
| `tokens_out` | INTEGER | |
| `cost_estimate` | REAL | |
| `source` | TEXT | |
| `started_at` | TEXT | |
| `ended_at` | TEXT | |

### 14.2 Migrations

The `migrate()` function uses `CREATE TABLE IF NOT EXISTS` — no versioned migrations. Schema changes are additive only.

### 14.3 Connection Management

- Singleton pattern: `getDb()` creates/returns a single instance
- WAL journal mode enabled
- Foreign keys enforced

---

## 15. Authentication & Security

### 15.1 Session-Based Auth (`src/middleware/auth.js`)

- Uses `express-session` with a random secret (or `SESSION_SECRET` env var)
- Cookie name: `vmf.sid`
- Cookie: `httpOnly`, `sameSite: 'lax'`, maxAge 24h
- Login: compare `password` to `AUTH_PASSWORD` env var
- Session flag: `req.session.authenticated`
- Redirects to login page if not authenticated
- API and WebSocket routes return `401` JSON instead of redirect

### 15.2 CSRF Protection

- Token generated per session: `crypto.randomBytes(32).toString('hex')`
- Available as `res.locals.csrfToken` in all templates
- Checked on all non-GET requests via `csrfCheck` middleware
- Token can be in `req.body._csrf` or `req.headers['x-csrf-token']`
- HTMX requests send CSRF via `hx-headers='{"x-csrf-token": "<%= csrfToken %>"}'`

**Important:** Both `app.js` legacy routes AND `routes/agents.js` use CSRF checks, but `app.js` does NOT use `csrfCheck` middleware on legacy POST routes (it relies on session check indirectly). Only `routes/agents.js` explicitly applies `csrfCheck`.

### 15.3 Rate Limiting (`src/middleware/rateLimit.js`)

- Per-IP tracking with in-memory Map
- Window: 60 seconds
- Limit: 300 requests per window
- Returns `429 Too Many Requests` on overflow
- Cleanup: Stale entries evicted every 2 minutes

### 15.4 Secret Redaction

Config responses are redacted in two places:
- `app.js:382-399` (`stripSensitiveConfig`) — strips `api_keys`, `telegram.botToken`, plugin keys
- `routes/agents.js:743-760` (`readAgentConfig`) — same redaction for agent-level config

The full raw config (including secrets) is only sent to the Config and Messaging pages as a hidden `<textarea>` value (not exposed via JSON API).

### 15.5 Path Traversal Protection

- `workspace.resolveSafePath()` (see section 9.1)
- `safeVmName()` — validates VM name format
- Multer file filter — blocks dangerous extensions

### 15.6 API Keys (MCP bearer tokens) — `src/services/api-keys.js`

Per-user API keys for the `/mcp` endpoint (external MCP clients don't do cookies). MCP auth is covered in section 25; this is the key store behind it.

- **Format:** `pk_live_<base64url-24-random-bytes>` (192 bits of entropy). Non-`pk_live_`-shaped tokens are rejected immediately.
- **Storage:** only `sha256(key)` (hex) + a display `prefix` are stored in the `api_keys` table — the raw key is shown **once** at creation and never again. A leaked DB leaks no usable keys.
- **Ownership:** every key belongs to a user and inherits their role — **admin → full fleet**, **user → owned agents only** (same `agents.owner_id` rule as the REST API). List/delete are scoped to `req.session.userId` — you can only see/revoke your own keys.
- **Scopes:** `scopes` column (`default`/`read`/`control`, comma-joined). `default` = inherit user role; reserved for future narrowed scopes.
- **`last_used_at`:** touched at most once per minute per key (throttled, not per-request).
- **Revocation:** delete the row → the sha256 lookup fails → the key stops working instantly.

Endpoints (session + CSRF protected):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/profile/keys` | List own keys (prefix, name, created, last used) — no hashes, no raw keys |
| POST | `/api/profile/keys` | Create a key `{ name, scopes? }` → returns `{ key: 'pk_live_…', … }`, the only time the raw key is visible |
| DELETE | `/api/profile/keys/:id` | Revoke (delete) an own key; 404 for unknown/foreign ids |

Created 2026-08-04, plan `plans/11-mcp-api-keys.md`. Absorbed into `docs/backend/services.md` — API Keys and `docs/pages/overview.md` — Profile; the plan file is removed.

---

## 16. Onboarding Flow (New Agent)

The onboarding flow wires up an agent with Telegram and API key authentication. It can be triggered from:
1. The **Create Agent form** (with default config option)
2. The **Onboard page** (`GET /onboard/:name`)
3. The **Models tab** (adding providers individually)

### 16.1 Full Onboard via Create Form

When creating an agent with `defaultConfig=true`:

```javascript
// 1. Create and start container (createVm)
// 2. Run openclaw onboard (non-interactive, minimal flags)
await runCmd('docker', ['exec', name, 'sh', '-lc',
  'openclaw onboard --non-interactive --accept-risk --mode local --flow manual ' +
  '--auth-choice skip --skip-channels --skip-skills --skip-search --skip-ui ' +
  '--skip-health --no-install-daemon >/tmp/onboard.log 2>&1 || true'
]);
// 3. Wait for openclaw.json to appear (poll up to 60s)
// 4. applyDefaultConfig(): Write Telegram bot token, model provider, allowlist
// 5. Restart container
// 6. (Optionally) run paste-api-key for a provider
```

### 16.2 applyDefaultConfig() Logic

Writes `openclaw.json` with:

**For OpenClaw agents:**
```json
{
  "channels": {
    "telegram": {
      "botToken": "<token>",
      "allowFrom": ["<uid>"],
      "dmPolicy": "allowlist",
      "enabled": true
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "ollama/<model>" }
    }
  },
  "models": {
    "providers": {
      "ollama": {
        "baseUrl": "<url>",
        "apiKey": "ollama",
        "api": "ollama",
        "models": [{ "id": "<model>", "name": "<model>", ... }]
      }
    }
  }
}
```

**For PicoClaw agents:**
```json
{
  "channels": { "telegram": { "token": "<token>", "enabled": true } },
  "agents": { "defaults": { "model": "<model>", "provider": "openai", "contextLength": 96000 } },
  "providers": { "openai": { "apiBase": "<url>", "apiKey": "ollama" } },
  "model": "<model>",
  "model_list": [{ "model_name": "<model>", "model": "ollama/<model>", "api_base": "<url>" }]
}
```

---

## 17. Models & Providers System

### 17.1 Provider Types

Two types of providers:
1. **API key providers** (most common): openrouter, ollama-cloud, anthropic, etc.
2. **OAuth providers**: openai, google, github-copilot

### 17.2 Adding a Provider

**API key flow** (`POST /api/providers/add`):
1. Save current `openclaw.json` to `.bak`
2. Run `openclaw models auth paste-api-key --provider <name>` with API key as stdin
3. This **overwrites** the entire config file with auth info only
4. Restore saved config, merging in new `auth` and `meta` from the overwritten file
5. Query `openclaw models list --all --json` to populate the model list for the provider
6. Write merged config back

**OAuth flow** (`POST /agents/:id/models/oauth-login`):
1. Spawn `docker exec <name> script -q -c 'openclaw models auth login --provider <name> --device-code' /dev/null`
2. Parse stdout for URL and Code
3. Return URL+Code to client (shown in modal)
4. Client opens URL in browser
5. Poll `oauth-status` endpoint every 5 seconds
6. On status `complete`, refresh models

### 17.3 Provider Removal

Removing a provider (`POST /agents/:id/models/remove-provider`):
1. Delete primary/fallback model if they use this provider
2. Delete all auth profiles matching this provider
3. Delete the provider entry from `models.providers`
4. Write config

### 17.4 Model Catalog

The catalog comes from `openclaw models list --all --json` inside the container. This lists all models known to OpenClaw globally.

`getCatalogProviders()` in `routes/agents.js:447` parses the catalog:
1. Groups model IDs by provider prefix (the part before the first `/`)
2. Filters out already-configured providers
3. Adds OAuth providers (openai, google, github-copilot) even if not in catalog

### 17.5 paste-api-key Critical Issue

**`paste-api-key` overwrites the entire config file.** This is a known OpenClaw behavior. The mitigation:
1. Save config BEFORE calling `paste-api-key`
2. After call, merge saved config with new auth info
3. Both `routes/agents.js:757-793` and `app.js:708-738` implement this pattern

---

## 18. Config Save/Restore Safety

The `preserveSecrets()` function in `routes/agents.js:408-428` prevents accidental secret erasure when saving config from the UI:

```javascript
// Before writing, restore redacted values from old config:
if (oldConfig.api_keys && newConfig.api_keys === '[REDACTED]') {
  newConfig.api_keys = oldConfig.api_keys;  // Keep the real keys
}
// Same for telegram.botToken and plugin keys
```

This means when the UI saves config (which has secrets replaced with `'[REDACTED]'`), the real secrets from the old config are preserved.

---

## 19. Activity Audit System

All significant actions are logged to the `activity_events` table via `registry.recordActivity()`.

**Categories and actions:**
| Category | Actions |
|----------|---------|
| `lifecycle` | create, start, stop, restart |
| `config` | update, set-primary, set-fallback, remove-provider |
| `workspace` | upload, save, rename, delete, create_folder, create_file, move |

Each event records: agent_id, category, action, status (ok/error), details (human-readable), and timestamp.

---

## 20. Testing

**Command:** `docker exec vm-webui node --test test/`

**Test coverage:**
- Workspace path safety (traversal prevention)
- Previewable file detection
- Breadcrumb generation
- VM name validation (regex)
- Meta.env reading
- Database schema creation and CRUD
- CSRF token generation
- Rate limiter module loading

---

## 21. Agent Configuration Model (`openclaw.json`)

This is the "source of truth" config for each agent. Key sections used by the dashboard:

```jsonc
{
  // Used by: Models tab, Messaging tab, Config tab
  "agents": {
    "defaults": {
      "model": {
        "primary": "openrouter/deepseek/deepseek-v4-flash",   // Models tab
        "fallback": "openrouter/anthropic/claude-3.5-sonnet"   // Models tab
      }
    }
  },
  "models": {
    "providers": {
      "openrouter": {
        "models": [
          { "id": "deepseek/deepseek-v4-flash", "name": "DeepSeek V4 Flash", "input": ["text"], "contextWindow": 128000 }
        ]
      }
    }
  },
  "channels": {
    "telegram": {
      "botToken": "[REDACTED]",        // Messaging tab
      "allowFrom": ["532156945"],      // Messaging tab
      "dmPolicy": "allowlist",         // Messaging tab
      "enabled": true
    }
  },
  "auth": {
    "profiles": { /* managed by paste-api-key / OAuth */ }
  },
  "api_keys": "[REDACTED]",            // Config tab (display only)
  "plugins": {
    "active-memory": { "key": "[REDACTED]" }  // Config tab (display only)
  }
}
```

---

## 22. Error Handling

### 22.1 Express Error Pages

- **404:** `partials/error` with "Page not found"
- **500:** `partials/error` with error message
- **HTMX requests:** Partial HTML with error message, correct HTTP status
- **JSON API requests:** `{ error: "message" }` with appropriate status

### 22.2 Flash Messages

Session-based flash for all mutating operations:
```javascript
req.session.flash = { type: 'success'|'error'|'warning', message: '...' };
```

Flash is consumed on the next page render and cleared from session.

### 22.3 Confirmation Modals

All destructive actions use `VMF.confirm()`:
- Stop agent (dashboard card only)
- Remove provider (models tab)
- Delete file (workspace)

---

## 23. Legacy Routes

For backward compatibility, the following routes still work (but redirect to the new `/agents/*` equivalents):

| Old Route | New Route |
|-----------|-----------|
| `GET /` | → `/agents` |
| `GET /vm/create` | → `/agents/create` |
| `GET /vm/:name` | → `/agents/:name` |
| `GET /terminal/:name` | → `/agents/:name` |
| `GET /hx/vm-status/:name` | (still served) |

---

## 24. Key Business Rules Summary

1. **Agent names must start with `vm-`** and match `^vm-[a-zA-Z0-9][a-zA-Z0-9_-]*$`
2. **A VM without `meta.env` is invisible** — no agent is created for it
3. **Docker state is authoritative** for running/stopped status; filesystem state is authoritative for existence
4. **Docker cache TTL is 3 seconds** — always force-refresh after mutations
5. **Generic backups are removed** — no tar archives, no restore-from-archive, no create-time clone (plan 26 pre-plan)
6. **paste-api-key destroys config** — always save and merge
7. **Files starting with `.` are hidden** in the workspace browser
8. **Terminals are real PTYs via Docker Engine API** — `Tty: true` allocates a PTY, so no `\r` → `\n` conversion is needed (see section 13 / `src/docs/terminal.md`)
9. **Config secrets are double-redacted** — once for JSON API, once for the raw config editor (with preservation on save)
10. **HTMX responses skip layout** — only the partial is returned

---

## 25. MCP Server (`src/mcp.js`)

The webui exposes its own MCP server (Streamable HTTP transport) at **`/mcp`** so external MCP clients — opencode, Claude Code, Cursor, Claude Desktop, or another OpenClaw instance — can connect **in** and manage PADs (list, start/stop, exec, workspace, logs, config).

Today MCP also goes the other way: each PAD connects **out** to third-party MCP servers (the MCP tab in `AgentDetail.jsx` / `openclaw mcp add`). This endpoint is the reverse: paddock exposes its own tools.

```
┌──────────┐  stdio or http   ┌─────────────────────────────┐  docker exec  ┌────────┐
│ opencode │                   │        paddock webui        │               │  PADs  │
│  Claude  │ ──── MCP ───────► │  Express :6789 + /mcp        │ ────────────► │        │
│  Cursor  │   (bearer token)  │  (streamable-http MCP)       │  docker.sock │  ...   │
└──────────┘                   └─────────────────────────────┘               └────────┘
```

- No new ports and no new containers — `/mcp` mounts on the existing Express server.
- Built on `@modelcontextprotocol/sdk` v1.30+ rather than hand-rolled JSON-RPC: the SDK owns Streamable HTTP framing (SSE + POST), capability negotiation, `initialize`, `tools/list`, `tools/call`, and the JSON-RPC error shapes.

### Endpoint

- `POST /mcp` — JSON-RPC (`initialize`, `tools/list`, `tools/call`, `notifications/initialized`).
- `GET /mcp` / `DELETE /mcp` — SSE session connect/terminate. Stateless mode: no sessions, `sessionIdGenerator` is `undefined`.
- Mounted in `src/app.js` behind the `MCP_ENABLED` flag (`MCP_ENABLED=false` disables it; default on). Skipped by session auth (`publicPaths`) — the MCP layer does its own auth.

### Auth

- Bearer API key (`Authorization: Bearer pk_live_…`), `X-Api-Key` header, or `?token=` query param, validated by `services/api-keys.authenticate()` (see section 15.6). Only the sha256 hash of the key is stored; the raw key is shown once at creation.
- Keys inherit the creator's webui role: **admin → full fleet**; **user → owned agents only** (same owner rule as `requireAgentAccess`). Ownership is checked inside every tool handler via the `agents.owner_id` column; admins bypass.
- The authenticated user is carried per-request via `AsyncLocalStorage` (`mcpContext`) and read in handlers with `currentUser()`. The SDK v1.30 does not forward `req.auth` into tool handlers, which is why the context store is needed.
- No new env var and no static `MCP_TOKEN` — one auth path, so "who used which key" is never a mystery.

### Stateless Transport Pattern

Each request creates a **fresh `McpServer` + fresh `StreamableHTTPServerTransport`**. The SDK throws if a server is connected to a second transport (`server.connect()` asserts `this._transport` is unset) and a stateless transport cannot be reused across requests — so the classic "one server, one transport, reuse per request" V1 example hangs on the second call (the request is received but never routed to a handler). `registerTools(server)` re-registers the 13 tools per request — cheap and deterministic. See `src/mcp.js:mountMcp`.

### Tools

Every tool returns `{ content: [{ type: 'text', text: <JSON> }] }` where `<JSON>` is the payload below. Errors are structured MCP errors (`isError: true`), never stack traces. Tool names carry no `paddock_` prefix — the consuming client namespaces the server's tools itself.

| Tool | Arguments | Returns |
|------|-----------|---------|
| `list_agents` | none | `{ agents: [{ name, status, display_name, agent_type, runtime_ref, default_model, default_provider }] }` — admin sees the full fleet, users only their own |
| `get_agent` | `name`, `logs?` (1–500, tail lines) | full agent object from `agent-registry.getAgent`; with `logs` also `{ name, logs }` recent container lines |
| `agent_logs` | `name`, `tail?` (1–5000, default 100) | `{ name, logs }` (stdout+stderr from `docker logs`) |
| `config_get` | `name` | driver-aware config read via `vm.readAgentConfig` (JSON parsed + secrets redacted; yaml/toml verbatim) |
| `workspace_list` | `name`, `path?` (default `/`) | directory listing via `services/workspace.listDir` |
| `workspace_read` | `name`, `path` | `{ name, path, size, modified, content }` — text only, files > 256 KB rejected |
| `workspace_write` | `name`, `path`, `content` | `{ name, path, size, modified }` — creates or overwrites |
| `start_agent` | `name` | `{ ok, name, status }` — starts the socat door too (`vm.startAgent`) |
| `stop_agent` | `name` | `{ ok, name, status }` — stops the socat door too (`vm.stopAgent`) |
| `restart_agent` | `name` | `{ ok, name, status }` |
| `delete_agent` | `name`, `confirm: true` | `{ ok, name, deleted }` — removes container, door, network, instance dir; requires `confirm: true` |
| `exec` | `name`, `command`, `timeout?` (1000–600000 ms, default 30000) | `{ name, stdout, stderr }` — `docker exec -i <pad> sh -lc '<command>'`; container must be running |

Control tools force a docker-cache refresh after the mutation so the returned status is fresh.

### Secrets redaction (`redactConfig`)

`config_get` strips secret-looking values (`api_keys`, `bot_token`, plugin keys…) via `redactSecrets` in `vm-manager.js`. Same fields the webui config route redacts.

### Error mapping / edge cases

| Case | Handling |
|------|----------|
| Missing or bad API key | HTTP 401, JSON-RPC error `-32001` "Unauthorized: missing or invalid API key" |
| Invalid arguments (missing/wrong type) | `-32602` (SDK validation) |
| Agent not found | `-32600` "Agent not found: <name>" |
| Agent not owned / not visible to user | `-32600` "Access denied or agent not found: <name>" (never leaks existence) |
| Container not running (exec) | `-32600` "Container is not running: <name>" |
| File not found / too large (read) | `-32600` with detail |
| Workspace path traversal | rejected by `resolveSafePath()` (section 9.1) — "Path traversal rejected" |
| Long-running exec | same `runCmd` timeout as the webui; `timeout` arg documented on the tool |
| Request handling error | HTTP 500 JSON-RPC `-32603`, logged as `[mcp] request error:` |

### Verification

```bash
# unit tests (mcp.test.js: initialize handshake + auth)
docker exec paddock sh -c 'cd /app && node --test test/mcp.test.js'

# handshake
curl -s -X POST http://10.69.1.164:6789/mcp \
  -H "Authorization: Bearer $PADDOCK_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# MCP Inspector (interactive)
npx @modelcontextprotocol/inspector
```

### Client config

opencode (`opencode.json`):
```json
{
  "mcp": {
    "paddock": {
      "type": "http",
      "url": "http://10.69.1.164:6789/mcp",
      "headers": { "Authorization": "Bearer <pk_live_your_key>" }
    }
  }
}
```

Claude Code (`~/.claude.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "paddock": {
      "type": "http",
      "url": "http://10.69.1.164:6789/mcp",
      "headers": { "Authorization": "Bearer <pk_live_your_key>" }
    }
  }
}
```

API keys are minted per-user in **Profile → API Keys**. Key lifecycle is documented in `docs/backend/services.md` — API Keys and `docs/overview/business-logic.md` — Paddock MCP Server Auth (the plan file is removed).


---

*Document generated 2026-07-19 from codebase analysis.*
