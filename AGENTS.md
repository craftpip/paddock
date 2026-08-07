# PAD Friends Project — PAD Learnings

## How to Use This File

When the user says "remember" or "write this down in AGENTS.md", or whenever you encounter a problem, solve it, and learn something new — **write it here**. This includes:
- Commands that worked (or didn't work)
- Bug fixes and their root causes
- Project structure details
- Configuration quirks
- Any decision the user makes about how things should work

Append new entries under the relevant section or add a new section. Keep it concise but actionable so future PAD sessions benefit.

## Project Structure

- **`docker-compose.yml`** defines services.
- **`docker-compose.override.yml`** adds additional services.
- **`src/`** — Management dashboard container. Runs Node.js/Express on port 5050. **This is the control plane** — it manages all other containers via `/var/run/docker.sock`.
- **`vm_openclaw/`** Docker image builds from `ghcr.io/openclaw/openclaw:latest`.
- **`instances/<pad>/openclaw/`** is bind-mounted to `/root/.openclaw` inside each container.
- **`scripts/`** — Kept external scripts: `daily-commit.sh`, `record-usage.sh`, `usage-budget*.sh`
- **`backups/`** — stores timestamped backup archives per PAD.

### React SPA (root `/` since 2026-07-23)

- **`src/client/`** — React 19 + Vite 6 SPA. Built output goes to `src/public/` (at root).
- **SPA serves at root** `/` — no more `/new/*` prefix.
- **Vite config**: `base: '/'`, `outDir: '../public'`.
- **Express catch-all** at `app.get('*', ...)` serves `public/index.html` for client-side routing (skips `/api/` and `/ws/` paths).
- Old EJS routes have been **removed**. The old `routes/agents.js` and all EJS views are dead code.
- API endpoints are all under `/api/*` in `app.js`. WebSocket at `/ws/terminal/*`.

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

> **STALE (2026-08-03):** `scripts/` no longer exists — the external
> `onboard-bot.sh` was absorbed into the Node webui (`app.js` route handlers +
> `vm-manager.js`). `bot-prefixes.json` is gone; secrets live in the Vault now.
> Kept below as historical record only.

- **Script**: `scripts/onboard-bot.sh` — automates `openclaw onboard` + Telegram + API key setup for a running PAD.
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

### Full workflow for a new PAD:
  1. `sudo bash add-vm.sh <pad>`
  2. Save credentials (one-time): `--add-bot mybot=123:ABC --add-user alice=987`
  3. Onboard: `sudo bash scripts/onboard-bot.sh <pad> --bot mybot --user alice`
  4. Set API keys: `sudo bash scripts/onboard-bot.sh <pad> --api-key ollama-cloud=<key>`

### Legacy (OAuth / Device-code) — kept for debugging:
- **OAuth process**: Writes `/tmp/oauth-helper-<pad>.py` inside the container. The helper uses a PTY, strips ANSI/control output, waits until the OAuth URL is detected before blocking on the FIFO, and writes raw debug output to `/tmp/onboard-oauth-<pad>.url.repr`.
- **OAuth failure-path rule**: Keep all OAuth temp paths defined in both `setup_auth_oauth` and `complete_auth_oauth`; with `set -u`, completion error-reporting must not reference setup-local variables such as `c_log` unless redefined locally. Verify failed-auth paths as well as success paths.
- **Device-code process**: Uses `script -q -c` inside `docker exec` to create a pseudo-TTY for `openclaw models auth login --device-code`, then runs it in background with `nohup` + `disown` so it survives script exit.
- **Requirements**: Agent must already exist (created with `add-vm.sh`) and be running.

## Provider API Keys via `--api-key`

- Uses `openclaw models auth paste-api-key --provider <name>` inside the container.
- For `ollama-cloud`, automatically sets `ollama-cloud/gemma4:31b` as default model when no model is configured.
- Providers confirmed working: `openrouter`, `ollama-cloud`.
- To verify: `docker exec <pad> openclaw models auth list --json`


## Critical: `paste-api-key` Destroys Config

- Running `openclaw models auth paste-api-key` inside a container **overwrites the entire `openclaw.json`** with only auth info, destroying agents config, gateway config, plugins, etc.
- **Fix**: Always save the config before invoking `paste-api-key` and merge it back after.
- Also: `paste-api-key` reads the API key from stdin. Using `child_process.execFile` (which doesn't pipe stdin) causes the command to hang until timeout. Use `spawn` and write to `child.stdin` instead.
- The `meta.env` files in `instances/*/` are **critical** — without them, the PAD discovery system returns 0 PADs and all detail pages show "Agent not found".

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

### PAD Creation: `openclaw setup` requires a TTY (v2026.7.x)

**Root cause:** Since v2026.7.x, `openclaw setup` is an **alias for `openclaw onboard`** and refuses to run without an interactive TTY:
```
Onboarding needs an interactive TTY. Use `openclaw onboard --non-interactive --accept-risk ...` for automation.
```
Running plain `openclaw setup` via `docker exec` (no TTY) fails every retry and the create flow hangs.

**Fix:** Use `openclaw setup --baseline` — it creates config + workspace + session dirs non-interactively (no onboarding):
```
$ docker exec <pad> openclaw setup --baseline
Wrote ~/.openclaw/openclaw.json
Workspace OK: ~/.openclaw/workspace
Sessions OK: ~/.openclaw/agents/main/sessions
Setup complete: config, workspace, and session directories are ready.
```

**Always check the current docs** before using OpenClaw CLI: https://docs.openclaw.ai/cli/setup

### PAD Creation: Redundant `docker compose up --force-recreate` kills bind mount

**Root cause:** After `createVm()` already starts the container via its instance-specific compose file, the `/api/agents/create` route tried a second `docker compose up --no-deps --force-recreate` using the main `docker-compose.yml` + `docker-compose.override.yml`. New PADs are NOT services in these files, so docker compose fails with "service not found".

**Fix:** Removed the redundant second compose command entirely. The instance-specific compose is the single source of truth for each PAD.

### PAD Creation: `api()` helper doesn't throw on error status

**Root cause:** The `api()` helper in `src/client/src/lib/api.js` only threw on 401. For 400/500 errors, it returned the JSON body without throwing. The create handler used `result.name` which was `undefined` when the API returned an error object, causing a silent navigation to `/agents/undefined`.

**Fix:** Added `if (!res.ok)` check that throws with the error payload on any non-2xx response:
```js
if (!res.ok) {
  const data = await res.json().catch(() => ({}))
  throw { status: res.status, ...data }
}
```

### Container Prefix comes from `.env` `CONTAINER_PREFIX`

**Not hardcoded.** The prefix (`vm`, `vm2`, `pad`, etc.) comes from `CONTAINER_PREFIX` in `.env` and is passed to the container via `docker-compose.yml`. The frontend reads it via `/api/config`. Always use the dynamic prefix, never hardcode `vm-`.

## Backup & Restore (save_backups.sh)

**Path:** `./manage_backups.sh`

A self-aware script that discovers PADs from `instances/` and uses `openclaw backup create` inside each running container.

**Commands:**

- `sudo ./manage_backups.sh backup [pad]` — backup all PADs or a specific one.
- `sudo ./manage_backups.sh restore <pad>` — restore from the latest backup in `backups/`.

**Backup flow:**
1. Run `openclaw backup create --output /tmp/{name}_{timestamp}.tar.gz` inside the container.
2. Copy archive from container to host `backups/` dir.
3. Clean up temp file.

**Restore flow:**
1. Find latest `backups/{pad}_*.tar.gz`.
2. Copy into container, extract to `/root/.openclaw`.
3. Restart container.

**Bot Clone / Copy flow:**
To clone an existing bot into a new one:
1. Clone directly: `sudo bash add-vm.sh <new-pad> --clone <source-pad>` (this handles backup + copy in one step)
2. Optionally onboard for Telegram with `sudo bash scripts/onboard-bot.sh <new-pad> ...`

**Alternative (manual) flow:**
1. Backup source: `sudo ./manage_backups.sh backup <source-pad>`
2. Create target: `sudo bash add-vm.sh <new-pad> --fresh`
3. Stop target: `sudo docker compose stop <new-pad>`
4. Restore into target: `sudo ./manage_backups.sh restore <new-pad>` (after renaming backup to match target name)
5. Start target: `sudo docker compose up -d <new-pad>`
6. Optionally onboard for Telegram with `sudo bash scripts/onboard-bot.sh <new-pad> ...`

**Do NOT** use manual `tar -xzf` extraction when `manage_backups.sh restore` exists.

**Known issues:**
- Large workspaces can make the backup command slow.
- Backup copies the full state including SQLite databases (cron, auth, session store).

## Project Learnings

### Updating OpenClaw to latest

**Last updated:** 2026-07-01

**Correct Approach:** First record the current version with `docker exec <pad> openclaw --version`. If the user says they already have a backup, do not create another. Update with `docker compose build --pull <pad> && docker compose up -d --no-deps --force-recreate <pad>`. Then record the new version and image digest. After update, check OpenAI auth; if needed, have the user complete interactive device auth because non-TTY tool sessions cannot run `docker exec -it`.

**Verification:** Check `
docker compose ps <pad>`, `docker exec <pad> openclaw --version`, `docker exec <pad> openclaw cron list`, recent `docker logs --since 2m <pad>`, and send a Telegram test. Also verify agent/OpenAI auth with `docker exec <pad> openclaw models status` and `docker exec <pad> openclaw agent --agent dev --message "Reply with OK only"`. If Telegram can send messages but replies fail with `401 Unauthorized`, ask the user to run `docker exec -it <pad> openclaw models auth login --provider openai --force --device-code`, then re-run the checks.

**Related terms:** openclaw update, docker compose build --pull, latest, version record, telegram test, no backup, OpenAI auth, 401 Unauthorized, device-code

### Host-side Telegram reachability affects containers without gluetun

**Last updated:** 2026-07-01

**Problem:** Agents not routing through gluetun, so host-side reachability problems to `api.telegram.org` affect their Telegram sends directly.

**Correct Approach:** When Telegram send failures happen (`Network request for 'sendMessage' failed!`, `UND_ERR_CONNECT_TIMEOUT`), first test from the host: `curl -sv --connect-timeout 5 https://api.telegram.org`. If the host also times out while normal HTTPS works, it's a host/network or regional restriction issue.

**Verify:** Check `docker logs --since 30m <pad>` for Telegram timeout errors, and confirm host can/cannot reach `api.telegram.org`.

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
4. Restart the container: `docker compose restart <pad>`
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
- `src/services/vault.js` — Encrypted Vault (`VAULT_KEY`, AES-256-GCM) — replaces the removed `creds.js`
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
docker compose build paddock-webui && docker compose up -d --no-deps --force-recreate paddock-webui
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

## PAD Management System (v2 — 2026-07-18)

### Architecture

The system has been rewritten from a VM-centric dashboard to an PAD-first management platform.

**New directory structure:**
```
src/
├── app.js                    # Express server, legacy routes, WS terminal
├── services/vault.js         # Encrypted Vault (replaces removed creds.js)
├── middleware/
│   ├── auth.js               # Session-based auth, CSRF, login/logout
│   └── rateLimit.js          # IP-based rate limiter
├── routes/
│   └── agents.js             # All /agents/* routes (CRUD, workspace, runtime)
├── services/
│   ├── agent-registry.js     # PAD discovery from filesystem, SQLite sync
│   ├── db.js                 # SQLite metadata store (agents, activity, sessions)
│   └── workspace.js          # Safe file operations with path traversal protection
├── views/
│   ├── login.ejs             # Session-based login page
│   ├── agents/
│   │   ├── dashboard.ejs     # Fleet view with search/filter
│   │   ├── create.ejs        # Create PAD form
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

- **PAD-first, not VM-first**: All new routes use `/agents/:id` instead of `/vm/:name`
- **Legacy routes preserved**: `/vm/*`, `/backups` still work
- **Credentials page/system removed (2026-08-03)**: replaced by the Vault (`/vault`, `/api/vault*`). `/credentials` redirects to `/vault`.
- **SQLite metadata store**: `src/data/app.db` stores PADs, activity events, sessions
- **Filesystem-derived state**: PADs discovered from `instances/*/meta.env` + Docker state
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
docker exec paddock-webui node --test test/
```

## Development Workflow — Live Editing without Rebuild

### Key Insight
Bind-mount the entire `src/` directory over `/app` so any file change (JS, EJS, JSON, etc.) is reflected instantly — no image rebuild needed.

### Volumes Setup for the webui service
```yaml
volumes:
  - /home/boniface/www/vm-friends:/workspace:rw
  - /home/boniface/www/vm-friends/src:/app:rw
  - /var/run/docker.sock:/var/run/docker.sock:ro
```

Two mounts only: project root (for PAD discovery, instances, scripts) and `src/` (for live code).

### node_modules
`node_modules` must exist on the host for the bind mount to work (the image's `/app/node_modules` is hidden by the mount). Copy it once:
```bash
docker cp paddock-webui:/app/node_modules /workspace/src/node_modules
```
And **`.gitignore`** must keep `**/node_modules/` (already done).

### Rate Limiter
- `src/middleware/rateLimit.js` defaults to 30 requests/minute per IP.
- 30 is too tight for page loads + HTMX tab loads (8 tabs per detail page = 9 requests). Bumped to 300 for normal browsing.

### Restart Command (no rebuild needed)
```bash
docker compose up -d --no-deps --force-recreate paddock-webui
```

### Vite Dev Server (HMR for React SPA)

For React frontend development with hot reload, run Vite dev server inside the container:

```bash
docker exec -d paddock-webui sh -c 'cd /app/client && npm run dev'
```

- Vite runs on **port 5173** (already mapped in `docker-compose.yml`).
- **Access the app at `http://10.69.1.164:5173` during development** (NOT port 5051).
- Port 5051 also works — it serves the **built** SPA from `public/` via Express, but requires `cd client && npm run build` to see changes.
- In dev, use 5173 for instant HMR. In prod/demo, use 5051.
- Vite's config proxies `/api` and `/ws` to Express on port 5050.
- Express backend changes still use the bind mount (no rebuild needed).
- To stop: `docker exec paddock-webui sh -c "kill \$(lsof -ti:5173)"`

**Default workflow for me:** When doing frontend development, I must start the Vite dev server first (if not already running) and test on port 5173. No rebuild needed. Only use port 5051 for production/demo verification.

### Nav Items (current order)
Dashboard, +PAD, Vault, Backups
- **Usage tab removed** — it was an external OpenAI report, not useful in the panel.

### Cleanup Completed
- `src/views/usage.ejs` and `src/views/partials/usage_stats.ejs` deleted.
- Read-only `usage/usage_data.csv` reading code and all `/usage` / `/api/usage` routes removed from `app.js`.


## PAD Dashboard — HTMX Action Buttons (2026-07-18)

### Pattern: Inline Start/Stop/Restart on Dashboard Cards
- Dashboard now has compact SVG icon buttons (play/stop/restart) per PAD card using **HTMX** (, , ).
- Actions do a full card swap (no page reload) — the card re-renders with updated status.
- Loading state:  CSS dims the card during the request.
- CSRF sent via  — no hidden form fields needed with HTMX.

### PAD Card Partial
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


## PAD Dashboard — HTMX Action Buttons (2026-07-18)

### Pattern: Inline Start/Stop/Restart on Dashboard Cards
- Dashboard now has compact SVG icon buttons (play/stop/restart) per PAD card using **HTMX** (`hx-post`, `hx-target`, `hx-swap`).
- Actions do a full card swap (no page reload) — the card re-renders with updated status.
- Loading state: `.agent-card.htmx-request` CSS dims the card during the request.
- CSRF sent via `hx-headers='{"x-csrf-token": "<%= csrfToken %>"}'` — no hidden form fields needed with HTMX.

### PAD Card Partial
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

### Accessing the WebUI from Browser MCP
- Browser MCP runs on the host, so it accesses the webui at `http://10.69.1.164:5051` (local network IP, production SPA build).
- Vite dev server (HMR) runs on port 5173+ inside the container — use `http://10.69.1.164:5176` (or whichever port Vite picks) for live dev.
- `localhost:5050` does **NOT** work from browser MCP — it connects to a different network context.
- `172.19.0.1` (Docker gateway IP) does **NOT** work from browser MCP — use `10.69.1.164` instead.
- Quick restart (no rebuild): `docker restart paddock-webui`

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

### Test PADs Available
- Use test PADs for general testing.
- `test-agents` — general testing
  (use actual PAD names, not vm- prefixes)

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

### Tmux Scrollback Replay Formatting
- `tmux capture-pane` emits LF-only lines. Before replaying pane history to xterm over WebSocket, convert `\r?\n` to `\r\n`; otherwise xterm preserves the prior column and restored output renders diagonally.

## Models/Providers Page — Models Tab (2026-07-19)

### `getCatalogProviders` `r.stdout` Bug

**Root cause:** `getCatalogProviders()` in `src/routes/agents.js:447` used `r.stdout` but `runCmd()` returns a plain string (from `execFile`), not an object with a `.stdout` property. `JSON.parse(undefined)` threw silently, caught by the empty `catch {}`, returning `[]`.

**Fix:** Changed `r.stdout` to `r` at line 447.

**Symptoms:** The "Add Provider" grid was always empty (no unconfigured providers shown). All other model tab functionality (primary, fallback, remove provider) worked fine since they read from the agent config, not the model catalog.

### Action Buttons Verified (★ Primary, ⤵ FB, × Remove)
- ★ Primary — sets `agents.defaults.model.primary` via HTMX POST, model row shows ★ indicator, button gets cyan highlight.
- ⤵ FB — sets `agents.defaults.model.fallback` via HTMX POST (empty value clears it), model row shows ⤵ indicator, button gets amber highlight.
- × Remove — deletes auth profiles + `models.providers` entry + clears primary/fallback matching that provider. Uses `hx-confirm` for confirmation.
- All three tested with correct DOM updates and CSRF handling.


## Settings Tab — Agent Detail Page (2026-08-04)

### Implemented (plan 09, Phases 1-3)
- `src/client/src/pages/agent/SettingsTab.jsx` — 5 cards: Container Info, Update
  (SSE console), Allow docker toggle, Network dropdown, Danger Zone delete.
  Wired into `AgentDetail.jsx` via `{ id: 'settings', label: 'Settings' }` in MODES.
- Backend: `GET /api/containers`, `GET/POST /api/agents/:name/settings`
  (`{ allowDocker?, network? }`), `POST /api/agents/:name/update` (202 +
  job `update:<name>`), `GET /api/agents/:name/update-log` (SSE, same shape as
  create-log). `vm-manager.js`: `generateInstanceCompose` takes
  `{ allowDocker, network }` opts, plus `setMetaFlag()`, `applySettings()`,
  `updateAgent()`, exported `AGENT_IMAGES`.
- **Split decision**: "Allow docker" (raw socket+CLI) and "Install Paddock MCP"
  are two separate toggles. The MCP toggle is **deferred** (needs plan 06's
  `/mcp` server). Don't re-bundle them.

### Fix patterns
- **`registry.removeAgentFromDb is not a function`**: `POST /api/agents/:name/delete`
  called a registry function that never existed — `vm.removeVm()` (docker rm +
  instance dir) ran fine, then the missing call threw 500, so the SPA showed an
  error and stayed on the page even though the container was gone. The Settings
  tab was the first UI ever wired to delete, so the dormant bug only surfaced
  when it shipped. Fix: implemented `removeAgentFromDb(name)` in
  `agent-registry.js` (deletes `agents` row + related `activity_events`/
  `sessions` rows) and exported it. Any delete that "half-succeeds" with a 500
  and leaves stale DB rows — clean the orphan rows the same way.
- **Delete leaked the compose network**: `vm.removeVm()` only did `docker rm -f`
  + `rm -rf` the instance dir — it never removed the compose-created bridge
  network `<name>_default`. Every delete burned a subnet from the host's limited
  default address pool (172.x range taken by other projects, 192.168.0.0/16
  carved into 16 × /20 — all allocatable). After many create/delete cycles Docker
  errors with `all predefined address pools have been fully subnetted` and new
  agent creates fail at `compose up`. Fix: `removeVm()` now runs
  `docker network rm <name>_default` (error-swallowed) before removing the dir.
  Cleanup of already-leaked networks: `docker network ls --filter
  driver=bridge --format '{{.Name}}' | while read n; do case "$n" in pad-*) c=$
  (docker network inspect "$n" --format '{{len .Containers}}'); [ "$c" = "0" ]
  && docker network rm "$n";; esac; done`.
- **Network clear bug**: in `POST /api/agents/:name/settings`, empty string
  `network` means "clear the override" — validation of the target must only run
  when `newNetwork` is non-empty, or clearing errors with "Container '' not found".
- **API tests via curl need a session**: auto-login only boots on `GET
  /api/session`. Always fetch it first into a cookie jar, otherwise `:name`
  routes 403 via `app.param` ("Access denied").
- **Webui restarts wipe in-memory job logs**: `job-log.js` is in-memory. Any
  `docker restart paddock` (or a concurrent session's restart) kills running
  update/create jobs and their SSE streams ("Update job not found (server may
  have restarted)"). Long jobs are interrupted mid-run.

### Environment facts
- No `sudo` and no `python3` on this host — we're root. Use the `edit` tool or
  `node -e` for root-owned files; the edit tool works as root.
- Host reachability for the webui: `http://10.69.1.164:6789` (localhost:6789 is
  refused from this shell's network context).

## Driver Framework (Goal 1 — 2026-08-06)

- **`src/services/drivers/`** — one module per agent type (`openclaw.js`,
  `opencode.js`, `picoclaw.js`), registered in `index.js` as `drivers = { openclaw, opencode, picoclaw }`.
- `getDriver(type)` is the single source of truth for how routes/terminal/dashboard
  treat an agent type; **falls back to the openclaw driver** when a type has none
  (never crashes). `listDrivers()` feeds the CreateAgent type select
  (`[{ type, label, setupSteps }]`).
- Driver fields (implemented by every driver):
  `type`, `label`, `buildImage`, `buildRel`, `baseImage`, `dataDir`,
  `workspaceDir`, `configFile`, `setupSteps`, `backupTypeMarker`,
  `installDockerBuildArg`, `currentVersion(name)`, `availableVersion()`,
  `commands` (Status/Auth/Cron/Skills/Other groups for the CommandsPane).
- **vm-manager.js no longer exports `AGENT_IMAGES`/`AGENT_BUILD_REL`/`AGENT_BASE_IMAGES`.**
  Image/tag/version lookups all go through `getDriver(agent)`. The create-flow
  setup guard is "run `setupSteps` if non-empty".
- Config paths derive from `driver.configFile` (openclaw.json / opencode.json /
  config.json) — nothing is hardcoded to openclaw in the config GET/POST routes,
  agent-registry model extraction, or workspace/config root resolution.
- Frontend: CommandsPane fetches `/api/agent-types/<type>/commands`;
  CreateAgent type options + setup step come from `/api/agent-types`;
  SettingsTab version via `driver.currentVersion()`; workspace tab root via
  `driver.workspaceDir`.
- **After adding/editing a driver file, restart the webui** — Node caches
  `require()` at startup (see also Picoclaw section below).

## Picoclaw Driver (Goal 2 — 2026-08-06)

- picoclaw's CLI is a single Go binary `picoclaw` — **no `openclaw` binary**.
  Setup step is `picoclaw onboard` (non-interactive; writes
  `/root/.picoclaw/config.json` + workspace/AGENT.md… + `.security.yml`).
- Config file is `/root/.picoclaw/config.json` (NOT openclaw.json). Drivers now
  carry a `configFile` field; the config GET/POST routes + ConfigTab read it.
- Version: `picoclaw version` → `🦞 picoclaw 0.2.5 (git: …)` — heavy ANSI banner,
  parse with a `\d+\.\d+\.\d+` regex.
- Model config lives at `agents.defaults.provider` + `agents.defaults.model_name`
  (no primary/fallback like openclaw).
- **Alpine agent images must bake `tmux` + `sqlite`** — the terminal's lazy
  tmux install runs `apt-get`, which does not exist on Alpine. The picoclaw
  Dockerfile got them baked; keep this in mind for any future Alpine-based image.
- **Restart the webui after adding/editing a driver file.** Node caches
  `require()` at startup; a running process silently falls back to the openclaw
  driver and builds the wrong image (`getDriver` fallback).
- Backups are generic (tar of `driver.dataDir`) — they work for picoclaw without
  an `openclaw backup` command. `backupTypeMarker: ''` tags them `legacy`.
  Restore is tar-overlay + container restart; files created after the backup
  survive.
- Docker toggle: `INSTALL_DOCKER=1` build arg works on the Alpine image
  (`apk add docker-cli`); settings route auto-rebuilds when the CLI is missing.
- `picoclaw gateway -E` (bind 0.0.0.0:18790) starts only when config.json
  exists; otherwise start.sh stays in setup mode (`tail -f /dev/null`).

## Hermes Driver (Goal 3 — 2026-08-07)

- hermes (Nous Research Hermes Agent) has its own CLI `hermes` — **no
  `openclaw` binary**. Setup step is `hermes setup --non-interactive`
  (no TTY needed; bootstraps `/opt/data` dirs but does NOT create config.yaml).
- Config is **YAML** at `/opt/data/config.yaml` (env at `/opt/data/.env`).
  Config managed via `hermes config set/get/unset`. Drivers now carry a
  `configFormat` field; when it's not `'json'` the config GET/POST routes
  serve/write the file verbatim (no JSON.parse, no secret redaction) and the
  ConfigTab skips JSON validation. `configFormat: 'yaml'` is the first use.
- Version: `hermes --version` → `Hermes Agent v0.20.0 (2026.8.3)` — parse with
  a `\d+\.\d+\.\d+` regex.
- Model config lives at `model.provider` + `model.default` in config.yaml
  (no primary/fallback). Registry extracts via regex on the YAML text.
- **The hermes gateway drops to the `hermes` user (uid 10000) even when started
  as root** — a root-owned empty bind mount at `/opt/data` fails first boot with
  `PermissionError: /opt/data/logs`. Fix: start.sh runs
  `chown -R hermes:hermes /opt/data` before `hermes gateway run`
  (mirrors the official s6 entrypoint's chown).
- `hermes gateway run` keeps the container alive (cron + platforms); needs
  `HERMES_ALLOW_ROOT_GATEWAY=1` in the Dockerfile. `hermes update` refuses to
  run inside Docker → `availableVersion: ''`.
- The base image already ships the docker CLI — the `INSTALL_DOCKER=1` rebuild
  is a no-op and the settings flow correctly skips it (verified).
- Workspace IS the data dir: `workspaceDir: '/opt/data'` (no `workspace/`
  subdir). Host bind `instances/<pad>/hermes` → `/opt/data`.
- Backups are generic tar-of-dataDir (`backupTypeMarker: ''`, tagged `legacy`).
- Model extraction in agent-registry.js: hermes reads config.yaml with a
  `model:` block regex (`provider` / `default`), picoclaw reads
  `agents.defaults.model_name`, openclaw reads `agents.defaults.model.primary`.
- `hermes model` is interactive-only (needs TTY). `doctor`, `cron list`,
  `skills list`, `sessions list`, `mcp list`, `memory status` all work.
- **Restart the webui after adding/editing a driver file** (Node caches
  `require()` at startup — a stale process builds the wrong image via the
  openclaw-driver fallback).

## Architecture Documentation

- `docs/` — **Source of truth** for business logic, system architecture, page descriptions, routes, data model, security model, and all behavioral contracts. Split by area: `overview/` (architecture, business-logic, react-migration), `backend/` (services, middleware, user-management), `tabs/` (per-tab behavior), `pages/`, `components/`, `operations/`.
- Rule: If code and docs disagree, fix the code.
- AGENTS.md remains the place for operational learnings, bug fixes, commands, and PAD session context.

## User Preferences

- Planning/ideas files go in `/workspace/plans/` as separate `.md` files. When the user says they want to plan something or save an idea, write a new `.md` file in that folder.
- Messaging page plan: `/workspace/plans/messaging-auth-panel.md` — terminal + credential panel for messaging setup (Telegram, Signal, GChat). Uses `openclaw channels add/login/remove` commands.
- Model provider plan: `/workspace/plans/model-provider-panel.md` — terminal + API key panel for model provider setup. Uses `openclaw models auth paste-api-key/login/list` commands.
- Backups page plan: `/workspace/plans/backups-page.md` — global backup listing; add File Name column to the table.
- Create agent page plan: `/workspace/plans/create-agent-fix.md` — fix layout-breaking HTMX and simplify the form.

## OpenClaw Docs — Always Use Online Docs

- OpenClaw docs at https://docs.openclaw.ai change frequently (CLI flags, config structure, behavior).
- Never rely on cached or built-in knowledge about OpenClaw commands, flags, or configuration.
- Always look up the current online docs before using any OpenClaw CLI command.
- This applies to: `openclaw setup`, `onboard`, `agents`, `config`, `models`, `cron`, `gateway`, `backup`, and all other subcommands.
- Bookmark: https://docs.openclaw.ai as the primary reference.

## Docker-on-Docker Bind Mount Split-Brain

### Problem

The `paddock-webui` container manages PAD containers via the host's Docker socket. When it generates instance `docker-compose.yml` files with **relative paths** like `./openclaw:/root/.openclaw`, Docker Compose resolves the path relative to the compose file's location inside the webui container (`/workspace/instances/<pad>/`). It then sends the absolute path `/workspace/instances/<pad>/openclaw/` to the **real host's Docker daemon**.

But on the real host, the project lives at `/mnt/ddrive/www/vm-friends-dev/` (or wherever the volumes point). The daemon creates/mounts `/workspace/instances/<pad>/openclaw/` at the HOST ROOT level — a **different directory** from the actual project data. Result: the PAD container writes workspace files to the root-level directory, and the webui container can't see them (it reads from the project-level directory via its own bind mount).

**Architecture:**
```
Real Host (project at /mnt/ddrive/www/vm-friends-dev/)
  └── Dev/Webui container (/workspace → /mnt/ddrive/...)
        └── docker compose -f /workspace/instances/pad/docker-compose.yml
              → resolves `./openclaw` to `/workspace/instances/pad/openclaw/`
              → sends to Docker daemon (on REAL host)
              → daemon mounts `/workspace/instances/pad/openclaw/` at HOST ROOT
              → WRONG! Project is at `/mnt/ddrive/.../instances/pad/openclaw/`
```

### Fix

Use **absolute paths from the real host's perspective** in generated compose files:

1. `src/services/vm-manager.js` reads `HOST_WORKSPACE_ROOT` env var (falls back to `WORKSPACE_ROOT`)
2. `generateInstanceCompose()` produces: `- ${HOST_WORKSPACE_ROOT}/instances/${name}/${agent}:${dataDir}`
3. Set `HOST_WORKSPACE_ROOT=/mnt/ddrive/www/vm-friends-dev` in `.env` for the deployment
4. Pass it to the webui container in `docker-compose.yml`: `HOST_WORKSPACE_ROOT: "${HOST_WORKSPACE_ROOT:-}"`

### Key Files

- `src/services/vm-manager.js` — `generateInstanceCompose()` and `createVm()`
- `docker-compose.yml` — passes `HOST_WORKSPACE_ROOT` env var
- `.env` — sets `HOST_WORKSPACE_ROOT` to the real host's project path

### Verification

After creating a new PAD, check that container and host see the same files:
```bash
docker inspect <pad> --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}'
# Source MUST be /mnt/ddrive/... NOT /workspace/...
docker exec <pad> find /root/.openclaw/ -type f | wc -l
find /workspace/instances/<pad>/openclaw/ -type f | wc -l
# Counts must match!
```

### File Modal in SPA — Escape and Save Indicator

- File viewer modal in the workspace tab (AgentDetail.jsx) originally had no Escape key handler and no "unsaved changes" indicator.
- Fix: Added `onKeyDown` with `e.key === 'Escape'` on the backdrop div, switched from `defaultValue` to `value` + `onChange` for content tracking, added `fileDirty` / `fileSaved` state with visual indicator.
- The textarea needed a `setFileModal({ ...fileModal, content: e.target.value })` onChange to keep the state in sync.
- Close button and backdrop click both call `closeFileModal()` which warns if dirty: `if (fileDirty && !confirm('You have unsaved changes. Discard?')) return`.

## Do Not Do

- **Never touch containers outside our project.** Containers not defined in this project's `docker-compose.yml` are not ours. Do not start, stop, exec, inspect, or interact with them in any way. Our project only owns containers it creates.
- **Never create random containers for testing.** Spin up test containers only through the project's own tools (add-vm scripts, docker-compose services, or the web UI). Running `docker run` with external images is outside our scope.
- **Never refer to containers/PADs with a `vm-` prefix.** The naming scheme is not guaranteed. Refer to PADs by their actual name only.
- **Never use the question tool to ask the user questions during a conversation.** Ask questions directly in text instead. The tool is only for fallback or complex multi-option scenarios when explicitly justified.
