# VM Friends Project — Agent Learnings

## How to Use This File

When the user says "remember" or "write this down in AGENTS.md", or whenever you encounter a problem, solve it, and learn something new — **write it here**. This includes:
- Commands that worked (or didn't work)
- Bug fixes and their root causes
- Project structure details
- Configuration quirks
- Any decision the user makes about how things should work

Append new entries under the relevant section or add a new section. Keep it concise but actionable so future agent sessions benefit.

## Project Structure

- **`docker-compose.yml`** defines services (vm-ozden, vm-pranav).
- **`docker-compose.override.yml`** adds vm-jake, vm-ozden2, vm-reze, vm-test.
- **`src/`** — Management dashboard container. Runs Node.js/Express on port 5050. **This is the control plane VM** — it manages all other containers via `/var/run/docker.sock`.
- **`vm_openclaw/`** Docker image builds from `ghcr.io/openclaw/openclaw:latest`.
- **`instances/<vm>/openclaw/`** is bind-mounted to `/root/.openclaw` inside each container.
- **`scripts/`** — Kept external scripts: `daily-commit.sh`, `record-usage.sh`, `usage-budget*.sh`
- **`backups/`** — stores timestamped backup archives per agent.

## OpenClaw Cron System

### Storage (version 2026.4.x+)

- Cron uses **SQLite** at `state/openclaw.sqlite` (tables: `cron_jobs`, `cron_run_logs`).
- **`cron/jobs.json` is legacy** — the Gateway no longer reads from it on startup. It is **not** auto-imported.
- To import old `jobs.json` entries into SQLite, run: `openclaw doctor --fix`
- New jobs added via `openclaw cron add` or the Gateway cron tool call go **only** to SQLite.

### Cron Jobs Capture Model at Creation Time

- Cron jobs store the model string at creation time and **do not** auto-update when `agents.defaults.model.primary` changes.
- To update cron jobs to a new model, use `openclaw cron update <id> --model <new-model>` or delete and recreate.
- Check current model per job with `openclaw cron list` (look at the Model column).

### Persistence Across Container Recreates

- `state/openclaw.sqlite` is inside the bind mount → persists.
- `cron/jobs.json` is also persisted on disk but is **stale** — not the source of truth.
- If containers are rebuilt (e.g., `docker compose build` pulls a new `:latest` image), a version change can cause silent data loss if the storage format changed and a migration step (like `doctor --fix`) was missed.

### `:latest` Tag Risk

- The Dockerfile uses `FROM ghcr.io/openclaw/openclaw:latest`.
- OpenClaw releases breaking changes (e.g., JSON → SQLite cron storage) under the same `:latest` tag.
- Pin a version (`v2026.6.1`) to avoid surprise changes.

## Git / Versioning

### File Permissions

- Instance files are owned by `root` (Docker creates them). Must use `sudo` for git operations on them.
- Example: `sudo git add -A && sudo git commit -m "msg"`

### Executable Bit Loss on Commit

- `sudo git add -A` resets executable bits to whatever git has in its index. A script made executable via `chmod +x` will lose that bit on the next commit if git tracks it as mode 100644.
- **Fix**: `sudo git update-index --chmod=+x <file>` to update the index, then commit. This permanently sets the mode to 100755.
- Affected: `scripts/record-usage.sh` kept losing its executable bit every daily commit until fixed in git's index.

### Embedded Git Repos

- OpenClaw creates nested git repos in:
  - `instances/*/openclaw/agents/*/agent/codex-home/.tmp/plugins*/`
  - `instances/*/openclaw/workspace/`
- These must have their `.git/` directories removed before `git add`, or they get added as submodules (mode 160000).
- Fix: `sudo find instances/ -path '*/.tmp/plugins*' -name '.git' -type d -exec rm -rf {} +`

### .gitignore

Current rules:

```
instances/*/openclaw/npm/
**/node_modules/
```

The `npm/` folder is OpenClaw's internal plugin cache (not project dependencies). `node_modules/` lives inside it and is equally unnecessary to version.

## Daily Commit

- `scripts/daily-commit.sh` runs at 18:00 daily via crontab.
- Does `sudo git add -A && sudo git commit -m "auto: daily commit" && sudo git push`.

## Onboard Bot Script

- **Script**: `scripts/onboard-bot.sh` — automates `openclaw onboard` + Telegram + API key setup for a running VM.
- **Flow**:
  1. First run: generates skeleton config, adds Telegram channel with allowlist.
  2. Saves/reads credentials from `bot-prefixes.json` (gitignored).
  3. Supports API key providers (`--api-key`, `--setup-api-key`).
  4. OAuth and device-code flows are disabled in the script but kept for future debugging.
- **Telegram credentials**: Stored in `bot-prefixes.json` at project root (gitignored).
- **Structure**:
  ```json
  {
    "bots": { "wilmaa_bot": "8775500299:AAF__..." },
    "users": { "boniface": "532156945" }
  }
  ```

### Save credentials with a name (persists to bot-prefixes.json):
  ```bash
  --add-bot <name>=<token>     Save a Telegram bot token
  --add-user <name>=<id>       Save a Telegram user ID
  ```

### Use by saved name:
  ```bash
  --bot <name>       Look up bot token from bot-prefixes.json
  --user <name>      Look up user ID from bot-prefixes.json
  ```

### Other flags:
  ```bash
  --bot-token <token>     Direct bot token (no save)
  --allow-from <id>       Direct user ID (no save)
  --api-key <prov>=<key>  Set provider API key (repeatable)
  --setup-api-key         Interactive provider API key setup
  --reset                 Wipe config + kill stale auth
  --continue              Finalize after device-code auth
  --redirect-url <url>    Complete OAuth with redirect URL
  ```

### Full workflow for a new VM:
  1. `sudo bash add-vm.sh vm-xxx`
  2. Save credentials (one-time): `--add-bot mybot=123:ABC --add-user alice=987`
  3. Onboard: `sudo bash scripts/onboard-bot.sh vm-xxx --bot mybot --user alice`
  4. Set API keys: `sudo bash scripts/onboard-bot.sh vm-xxx --api-key ollama-cloud=<key>`

### Legacy (OAuth / Device-code) — kept for debugging:
- **OAuth process**: Writes `/tmp/oauth-helper-<vm>.py` inside the container. The helper uses a PTY, strips ANSI/control output, waits until the OAuth URL is detected before blocking on the FIFO, and writes raw debug output to `/tmp/onboard-oauth-<vm>.url.repr`.
- **OAuth failure-path rule**: Keep all OAuth temp paths defined in both `setup_auth_oauth` and `complete_auth_oauth`; with `set -u`, completion error-reporting must not reference setup-local variables such as `c_log` unless redefined locally. Verify failed-auth paths as well as success paths.
- **Device-code process**: Uses `script -q -c` inside `docker exec` to create a pseudo-TTY for `openclaw models auth login --device-code`, then runs it in background with `nohup` + `disown` so it survives script exit.
- **Requirements**: VM must already exist (created with `add-vm.sh`) and be running.

## Provider API Keys via `--api-key`

- Uses `openclaw models auth paste-api-key --provider <name>` inside the container.
- For `ollama-cloud`, automatically sets `ollama-cloud/gemma4:31b` as default model when no model is configured.
- Providers confirmed working: `openrouter`, `ollama-cloud`.
- To verify: `docker exec <vm> openclaw models auth list --json`


## Critical: `paste-api-key` Destroys Config

- Running `openclaw models auth paste-api-key` inside a container **overwrites the entire `openclaw.json`** with only auth info, destroying agents config, gateway config, plugins, etc.
- **Fix**: Always save the config before invoking `paste-api-key` and merge it back after.
- Also: `paste-api-key` reads the API key from stdin. Using `child_process.execFile` (which doesn't pipe stdin) causes the command to hang until timeout. Use `spawn` and write to `child.stdin` instead.
- The `meta.env` files in `instances/*/` are **critical** — without them, the agent discovery system returns 0 agents and all detail pages show "Agent not found".

## Known Issues & Fixes

### File Ownership

- `AGENTS.md` at project root is owned by `root` (like instance files). Cannot use the `edit` tool — must use `sudo python3` or `sudo sed` to modify it.
- When using `sudo python3` with embedded code, use `<< 'PYEOF'` (single-quoted heredoc delimiter) to prevent bash from interpreting backticks and `$` inside the Python code.

### Issue: Embedded git repos inside `instances/` prevent `git add`

**Cause**: OpenClaw creates temporary git repos in `.tmp/` and `workspace/` directories.

**Fix**: Strip `.git/` directories before adding:
```bash
sudo find instances/ -name '.git' -type d -exec rm -rf {} + 2>/dev/null
```

## Backup & Restore (save_backups.sh)

**Path:** `./manage_backups.sh`

A self-aware script that discovers agents from `instances/vm-*/` and uses `openclaw backup create` inside each running container.

**Commands:**

- `sudo ./manage_backups.sh backup [agent]` — backup all agents or a specific one.
- `sudo ./manage_backups.sh restore <agent>` — restore from the latest backup in `backups/`.

**Backup flow:**
1. Run `openclaw backup create --output /tmp/{name}_{timestamp}.tar.gz` inside the container.
2. Copy archive from container to host `backups/` dir.
3. Clean up temp file.

**Restore flow:**
1. Find latest `backups/{agent}_*.tar.gz`.
2. Copy into container, extract to `/root/.openclaw`.
3. Restart container.

**Bot Clone / Copy flow:**
To clone an existing bot into a new one:
1. Clone directly: `sudo bash add-vm.sh <new-vm> --clone <source-vm>` (this handles backup + copy in one step)
2. Optionally onboard for Telegram with `sudo bash scripts/onboard-bot.sh <new-vm> ...`

**Alternative (manual) flow:**
1. Backup source: `sudo ./manage_backups.sh backup <source-vm>`
2. Create target: `sudo bash add-vm.sh <new-vm> --fresh`
3. Stop target: `sudo docker compose stop <new-vm>`
4. Restore into target: `sudo ./manage_backups.sh restore <new-vm>` (after renaming backup to match target name)
5. Start target: `sudo docker compose up -d <new-vm>`
6. Optionally onboard for Telegram with `sudo bash scripts/onboard-bot.sh <new-vm> ...`

**Do NOT** use manual `tar -xzf` extraction when `manage_backups.sh restore` exists.

**Known issues:**
- Large workspaces can make the backup command slow.
- Backup copies the full state including SQLite databases (cron, auth, session store).

## Project Learnings

### Updating OpenClaw to latest (vm-ozden / vm-jake pattern)

**Last updated:** 2026-07-01

**Correct Approach:** First record the current version with `docker exec <vm> openclaw --version`. If the user says they already have a backup, do not create another. Update with `docker compose build --pull <vm> && docker compose up -d --no-deps --force-recreate <vm>`. Then record the new version and image digest. After update, check OpenAI auth; if needed, have the user complete interactive device auth because non-TTY tool sessions cannot run `docker exec -it`.

**Verification:** Check `docker compose ps <vm>`, `docker exec <vm> openclaw --version`, `docker exec <vm> openclaw cron list`, recent `docker logs --since 2m <vm>`, and send a Telegram test. Also verify agent/OpenAI auth with `docker exec <vm> openclaw models status` and `docker exec <vm> openclaw agent --agent dev --message "Reply with OK only"`. If Telegram can send messages but replies fail with `401 Unauthorized`, ask the user to run `docker exec -it <vm> openclaw models auth login --provider openai --force --device-code`, then re-run the checks.

**Related terms:** openclaw update, docker compose build --pull, latest, version record, telegram test, no backup, OpenAI auth, 401 Unauthorized, device-code

### Host-side Telegram reachability affects containers without gluetun

**Last updated:** 2026-07-01

**Problem:** `vm-ozden` and `vm-jake` do not route through gluetun, so host-side reachability problems to `api.telegram.org` affect their Telegram sends directly.

**Correct Approach:** When Telegram send failures happen (`Network request for 'sendMessage' failed!`, `UND_ERR_CONNECT_TIMEOUT`), first test from the host: `curl -sv --connect-timeout 5 https://api.telegram.org`. If the host also times out while normal HTTPS works, it's a host/network or regional restriction issue.

**Verify:** Check `docker logs --since 30m <vm>` for Telegram timeout errors, and confirm host can/cannot reach `api.telegram.org`.

### Local Vector Memory (Semantic Search) for OpenClaw Bots

**Last updated:** 2026-07-05

**Goal:** Self-contained local semantic memory using ChromaDB + local GGUF embeddings (no cloud API).

**Steps:**
1. Install the llama-cpp provider plugin inside the container:
   ```
   openclaw plugins install @openclaw/llama-cpp-provider
   ```
2. Add plugin entry to `plugins.entries` in `openclaw.json`:
   ```json
   "llama-cpp": { "enabled": true }
   ```
3. Configure `memorySearch` under `agents.defaults` with the correct structure:
   ```json
   "memorySearch": {
     "provider": "local",
     "local": {
       "modelPath": "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf"
     }
   }
   ```
4. Restart the container: `docker compose restart <vm>`
5. Run the index: `openclaw memory index`

**Notes:**
- The default model is `embeddinggemma-300m-qat-Q8_0.gguf` -- the `modelPath` can also point at a local `.gguf` file.
- Everything runs CPU-only inside the container; no host-side installs needed.
- Changing the embedding provider/model invalidates the existing vector index. Rebuild with `openclaw memory index --force`.
- The `active-memory` plugin should also be enabled for interactive semantic recall during chats.
- Official docs: https://docs.openclaw.ai/plugins/llama-cpp

## Node.js/Express Rewrite (src/ 2026-07-18)

### Why
- Python Flask + gunicorn had persistent WebSocket issues (terminal blocked workers).
- Node.js/Express handles WebSocket natively without workarounds.

### Files Created
- `src/app.js` — Express server with all routes, helpers, auth middleware, WebSocket terminal
- `src/creds.js` — Credential manager ported from `creds.py` (already existed)
- `src/views/` — 18 EJS templates (layout + 11 pages + 6 partials), replacing Jinja2 `templates/`
- `src/package.json` — dependencies (express, ejs, express-ejs-layouts, ws, cookie-parser)
- `src/Dockerfile` — `node:20-slim` with docker-ce-cli installed

### Key Implementation Details
- **WebSocket terminal**: Uses `ws` library + `docker exec -i` (no -t) to avoid PTY issues. Simple stdin/stdout piping.
- **Helper functions**: `runCmd()` wraps `child_process.execFile()` in a Promise. `runWorkspaceScript()` uses `fs.mkdtemp()` + `fs.chmodSync()` for temp script files.
- **Docker cache**: Same 3-second TTL on `docker ps -a` results (module-level variable).
- **Auth**: Session-based auth with CSRF tokens replacing Basic Auth.

### Template Conversion Rules (Jinja2 → EJS)
| Jinja2 | EJS |
|--------|-----|
| `{{ var }}` | `<%= var %>` |
| `{% if cond %}` | `<% if (cond) { %>` |
| `{% endif %}` | `<% } %>` |
| `{% for x in list %}` | `<% for (const x of list) { %>` |
| `{% endfor %}` | `<% } %>` |
| `{% include "x.html" %}` | `<%- include('partials/x') %>` |
| `{% block content %}{% endblock %}` | `<%- body %>` (in layout) |
| `{% extends "base.html" %}` | N/A (layout handled by `express-ejs-layouts`) |
| `{{ var.get('key', 'default') }}` | `<%= var.key || 'default' %>` |
| `{{ var.property }}` | `<%= var.property %>` |
| `{% for k, v in dict.items() %}` | `<% for (const [k, v] of Object.entries(dict)) { %>` |

### Deploy
```bash
docker compose build vm-webui && docker compose up -d --no-deps --force-recreate vm-webui
```

### Common EJS Template Mistakes
- **Stray `<% } %>`** (orphaned closing brace) causes `Missing catch or finally after try` — EJS interprets it as an unmatched `try`.
- Always match `{` with `}` inside `<% %>` blocks.
- When embedding flash messages, escape single quotes: `<%= flash.message.replace(/'/g, "\\'") %>`.

### Terminal: xterm.js sends \r but docker exec -i without PTY needs \n

**Root cause:** xterm.js fires `\r` (carriage return) on Enter key. `docker exec -i` (no `-t`) does not allocate a PTY, so there's no terminal line discipline to convert `\r` to `\n`. The shell hangs waiting for a recognized command terminator.

**Fix:** In the WebSocket `on('message')` handler in `src/app.js`, convert `\r` to `\n` before writing to docker stdin:
```js
docker.stdin.write(data.toString().replace(/\r/g, '\n'));
```

**Verify:** Send a command ending with `\r` via WebSocket — the shell should execute it immediately.

## Agent Management System (v2 — 2026-07-18)

### Architecture

The system has been rewritten from a VM-centric dashboard to an agent-first management platform.

**New directory structure:**
```
src/
├── app.js                    # Express server, legacy routes, WS terminal
├── creds.js                  # Credential manager
├── middleware/
│   ├── auth.js               # Session-based auth, CSRF, login/logout
│   └── rateLimit.js          # IP-based rate limiter
├── routes/
│   └── agents.js             # All /agents/* routes (CRUD, workspace, runtime)
├── services/
│   ├── agent-registry.js     # Agent discovery from filesystem, SQLite sync
│   ├── db.js                 # SQLite metadata store (agents, activity, sessions)
│   └── workspace.js          # Safe file operations with path traversal protection
├── views/
│   ├── login.ejs             # Session-based login page
│   ├── agents/
│   │   ├── dashboard.ejs     # Fleet view with search/filter
│   │   ├── create.ejs        # Create agent form
│   │   ├── detail.ejs        # Tabbed detail (8 tabs)
│   │   ├── workspace.ejs     # File browser with upload/download/rename/delete
│   │   ├── terminal.ejs      # xterm.js terminal
│   │   ├── logs.ejs          # Container logs
│   │   ├── config.ejs        # Redacted config viewer
│   │   ├── backups.ejs       # Backup management
│   │   ├── sessions.ejs      # Session list
│   │   └── activity.ejs      # Activity timeline
│   └── partials/             # Shared components
└── test/
    └── services.test.js      # Unit tests
```

### Key Design Decisions

- **Agent-first, not VM-first**: All new routes use `/agents/:id` instead of `/vm/:name`
- **Legacy routes preserved**: `/vm/*`, `/backups`, `/credentials` still work
- **SQLite metadata store**: `src/data/app.db` stores agents, activity events, sessions
- **Filesystem-derived state**: Agents discovered from `instances/*/meta.env` + Docker state
- **Session-based auth**: Replaces Basic Auth. Uses `express-session` with CSRF tokens
- **CSRF on all POST routes**: Every form includes `_csrf` hidden field
- **Path traversal protection**: `workspace.resolveSafePath()` canonicalizes all paths against workspace root
- **Secret redaction**: Config API responses strip `api_keys`, `bot_token`, plugin keys
- **Flash messages**: Session-based flash for action feedback (success/error toasts)
- **Confirmation modals**: Destructive actions (delete, restore, stop) use `VMF.confirm()`
- **Skeleton loading**: Tabs show shimmer placeholders while HTMX loads content
- **Responsive design**: Tables hide columns on mobile, forms stack vertically

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_PASSWORD` | Yes | Password for session-based login |
| `SESSION_SECRET` | No | Auto-generated if not set. Set for persistence across restarts |

### Testing

```bash
docker exec vm-webui node --test test/
```

## Development Workflow — Live Editing without Rebuild

### Key Insight
Bind-mount the entire `src/` directory over `/app` so any file change (JS, EJS, JSON, etc.) is reflected instantly — no image rebuild needed.

### Volumes Setup (`docker-compose.yml` for `vm-webui`)
```yaml
volumes:
  - /home/boniface/www/vm-friends:/workspace:rw
  - /home/boniface/www/vm-friends/src:/app:rw
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

Two mounts only: project root (for agent discovery, instances, scripts) and `src/` (for live code).

### node_modules
`node_modules` must exist on the host for the bind mount to work (the image's `/app/node_modules` is hidden by the mount). Copy it once:
```bash
docker cp vm-webui:/app/node_modules /workspace/src/node_modules
```
And **`.gitignore`** must keep `**/node_modules/` (already done).

### Rate Limiter
- `src/middleware/rateLimit.js` defaults to 30 requests/minute per IP.
- 30 is too tight for page loads + HTMX tab loads (8 tabs per detail page = 9 requests). Bumped to 300 for normal browsing.

### Restart Command (no rebuild needed)
```bash
docker compose up -d --no-deps --force-recreate vm-webui
```

### Nav Items (current order)
Dashboard, +VM, Backups, Creds
- **Usage tab removed** — it was an external OpenAI report, not useful in the panel.

### Cleanup Completed
- `src/views/usage.ejs` and `src/views/partials/usage_stats.ejs` deleted.
- Read-only `usage/usage_data.csv` reading code and all `/usage` / `/api/usage` routes removed from `app.js`.


## Agent Dashboard — HTMX Action Buttons (2026-07-18)

### Pattern: Inline Start/Stop/Restart on Dashboard Cards
- Dashboard now has compact SVG icon buttons (play/stop/restart) per agent card using **HTMX** (, , ).
- Actions do a full card swap (no page reload) — the card re-renders with updated status.
- Loading state:  CSS dims the card during the request.
- CSRF sent via  — no hidden form fields needed with HTMX.

### Agent Card Partial
- Card markup lives in  and is included by the dashboard.
- Route handlers check  — if true, render the card partial (no layout); otherwise redirect.
- The partial is self-contained: receives  and  as locals.

### What Changed
-  — now uses 
-  — new file, extracted card partial with HTMX buttons
-  — start/stop/restart routes now support HTMX responses (return card partial instead of redirect)
-  — added  CSS for loading state

### EJS Include Pitfall
- Include paths in EJS are **relative to the current template**, not the views root.
- From , include  (not ).


## Agent Dashboard — HTMX Action Buttons (2026-07-18)

### Pattern: Inline Start/Stop/Restart on Dashboard Cards
- Dashboard now has compact SVG icon buttons (play/stop/restart) per agent card using **HTMX** (`hx-post`, `hx-target`, `hx-swap`).
- Actions do a full card swap (no page reload) — the card re-renders with updated status.
- Loading state: `.agent-card.htmx-request` CSS dims the card during the request.
- CSRF sent via `hx-headers='{"x-csrf-token": "<%= csrfToken %>"}'` — no hidden form fields needed with HTMX.

### Agent Card Partial
- Card markup lives in `src/views/agents/partials/card.ejs` and is included by the dashboard.
- Route handlers check `req.headers['hx-request']` — if true, render the card partial (no layout); otherwise redirect.
- The partial is self-contained: receives `agent` and `csrfToken` as locals.

### What Changed
- `src/views/agents/dashboard.ejs` — now uses `<%- include('partials/card', { agent, csrfToken }) %>`
- `src/views/agents/partials/card.ejs` — new file, extracted card partial with HTMX buttons
- `src/routes/agents.js` — start/stop/restart routes now support HTMX responses (return card partial instead of redirect)
- `src/views/layout.ejs` — added `.agent-card.htmx-request` CSS for loading state

### EJS Include Pitfall
- Include paths in EJS are **relative to the current template**, not the views root.
- From `views/agents/dashboard.ejs`, include `partials/card` (not `../partials/card`).


## Script Absorption into Node.js (2026-07-18)

### What Changed
All bash/Python scripts that were external to src/ have been absorbed into Node.js service modules:

- **`add-vm.sh`** → `src/services/vm-manager.js` (createVm, removeVm, resetVm)
- **`remove-vm.sh`** → `src/services/vm-manager.js` (removeVm)
- **`reset-vm.sh`** → `src/services/vm-manager.js` (resetVm)
- **`manage_backups.sh`** → `src/services/backup-manager.js` (backupAgent, restoreAgent)
- **`scripts/onboard-bot.sh`** + **`scripts/.oauth-helper.py`** → inlined into route handlers in `app.js` and config patching in `vm-manager.js`

### Removed Dependencies
- `runWorkspaceScript()` removed from both `app.js` and `routes/agents.js`
- `stripContainerCheck()` removed from `app.js`
- `os` import removed from `routes/agents.js`

### Kept External Scripts
- `scripts/daily-commit.sh` — daily git commit
- `scripts/record-usage.sh` — usage tracking
- `scripts/usage-budget-compact.sh` / `scripts/usage-budget.sh` — budget reports

### Key Files Created
- `src/services/vm-manager.js` — createVm, removeVm, resetVm, docker-compose override YAML generation, config patching
- `src/services/backup-manager.js` — backupAgent, restoreAgent via docker exec + docker cp

### Pattern for Post-Creation Config
- Instead of a separate "onboard" service, Telegram + API key setup is done inline with direct `runCmd('docker', [...])` calls in route handlers
- Config patching (Telegram bot token, model provider) is a pure JS function in `vm-manager.js` — no Python scripts needed

## MCP Browser Testing (2026-07-18)

### Accessing vm-webui from Browser MCP
- Browser MCP runs on the host, so it accesses the webui at `http://172.19.0.1:5050` (Docker gateway IP).
- `localhost:5050` does **NOT** work from browser MCP — it connects to a different network context.
- OP-friends container shares gluetun's network namespace — cannot be connected to other Docker networks.
- vm-webui is on `workspace_default` (172.30.0.2) and `browser-search-mcp_default` (172.23.0.3).
- Quick restart (no rebuild): `docker restart vm-webui`

### MCP Config
- Created `/workspace/opencode.json` with MCP browser config pointing at `http://localhost:3000/mcp`.

## Terminal Sizing Fix (2026-07-18)

### Problem
Terminal appeared small/constrained because xterm.js FitAddon calls `fit()` before the terminal tab is visible (HTMX loads tabs lazily).

### Fix
- Added **IntersectionObserver** in `src/views/layout.ejs` that defers `fit()` until the terminal container is actually visible in the viewport.
- Also added **ResizeObserver** on the terminal container for continuous auto-resize.
- Added `IntersectionObserver` to pause/resume logs auto-refresh when tab is hidden/visible.

### xterm.js Addons
- FitAddon and WebLinksAddon are loaded via `<script>` tags from `/app/public/xterm-addon-fit.js` and `xterm-addon-web-links.js`.
- They are NOT npm packages installed in node_modules — they're standalone browser bundles.
- Download with `curl -o <path> <cdn-url>` into `src/public/`.

### Terminal Theme
- Professional dark theme with cyan accents matching the UI color scheme.
- Defined in `VMF.initTerminal()` in `src/views/layout.ejs`.
- 10000 scrollback lines.

### Terminal Resize to Docker
- When the terminal resizes, send `docker exec resize` via WebSocket.
- Done in the ResizeObserver callback after fit().

## Critical: Always Test Before Delivering

**Rule:** Never hand code to the user for testing without testing it yourself first.

- You have browser MCP tools (Target, navigate, screenshot, DOM query, click, evaluate JS) — use them.
- After every code change: restart the service, open the browser, navigate to the affected page, and verify it works.
- If something is broken, fix it before telling the user. Do not ask the user to test unless you cannot access the thing yourself.
- "It works on my end" is not acceptable — prove it works by testing it live.
- The user has given you everything you need. No excuses.

### Test VMs Available
- `vm-test` — general testing
- `vm-test2` — general testing
- `vm-ramsey` — general testing
- Navigate to `http://10.69.1.164:5050/agents/<vm-name>#<tab>` to test specific pages.
- Always test tab switching, HTMX loading, and WebSocket connections — these are the most fragile parts.

### Rule: Never Deliver Broken Things
- The user expects every change to work on the first try.
- No "fix it later" or "try it and let me know" — fix it NOW before delivering.
- If you're unsure whether something works, TEST it before responding.

## Critical: Terminal WebSocket Bug (2026-07-19)

### Root Cause
- `dockerPsList()` in `src/app.js` stores the **full JSON object** per container (`containers[c.Names] = c`), not just the state string.
- The WebSocket handler compared `containers[vmName] !== 'running'` — comparing an **object** to a string, which always returns `true`.
- This caused every WebSocket connection to be **immediately rejected** with `ws.close()`.
- The fix: `(containers[vmName]?.State || '').toLowerCase() !== 'running'`.
