# PAD Friends Project — PAD Learnings

## How to Use This File

When the user says "remember" or "write this down in AGENTS.md", or whenever you encounter a problem, solve it, and learn something new — **write it here**. This includes:
- Commands that worked (or didn't work)
- Bug fixes and their root causes
- Project structure details
- Configuration quirks
- Any decision the user makes about how things should work

Append new entries under the relevant section or add a new section. Keep it concise but actionable so future PAD sessions benefit.

### "learn" — Where It Goes (rule)

When the user says "learn" about something, save it in one of two places:

1. **`docs/` — the code and why it exists.** If the learning is about the code — its logic, its purpose, the reason a piece of code is there, how the system works, business rules, architecture, routes, data model, behavioral contracts — write it in the `docs/` folder. Pick the matching subfolder (`overview/`, `backend/`, `tabs/`, `pages/`, `components/`, `operations/`) or the `README.md` index, following the structure in the "Architecture Documentation" section below. Prefer `docs/` whenever the learning is about the code/system, since `docs/` is the source of truth for business logic.
2. **`AGENTS.md` — the agent's behavior.** If the learning is about the agent's (my) behavior, workflow, conventions, commands, gotchas, or preferences — how the agent should act or operate — write it here in AGENTS.md instead.

Rule of thumb: **code logic and the reason the code is there → `docs/`; agent behavior and operational workflow → AGENTS.md.**

## Project Structure

- **`docker-compose.yml`** defines the webui service (`webui`, container `paddock`, image `paddock-webui:latest`).
- **`src/`** — Management dashboard container. Runs Node.js/Express on port **6789**. **This is the control plane** — it manages all other containers via `/var/run/docker.sock`.
- **`src/vm-builds/<type>/`** — per-agent-type Dockerfile + start.sh (openclaw, opencode, picoclaw, hermes, codex, monitor). Images tag `paddock-vm-<type>:latest`.
- **`instances/<pad>/<agent>/`** — bind-mounted to the driver's data dir (`/root/.openclaw`, `/root/.picoclaw`, `/opt/data`, etc.) inside each container.
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

> **STALE (2026-08-09):** `scripts/daily-commit.sh` no longer exists — there is
> **no `scripts/` dir and no crontab** on this host anymore (verified). The
> daily `sudo git add -A && sudo git commit -m "auto: daily commit"` push
> (historically `scripts/daily-commit.sh` at 18:00 via crontab) is not running.
> If a daily commit is wanted again, re-create it (agent-driven or crontab) and
> record the new mechanism here.

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

### Slow container stops: bare `bash`/`sleep` as PID 1 drops SIGTERM

**Symptom:** `docker stop <pad>` hangs the full `-t 30` grace then SIGKILLs (exit 137). Affected: every `vm-builds/` image whose `ENTRYPOINT` is `start.sh` directly (picoclaw, codex, opencode, hermes). Only openclaw stopped fast.

**Root cause:** The kernel does not deliver default-action signals to PID 1 unless it installed a handler. A script running `bash start.sh` as PID 1 neither handles SIGTERM nor forwards it to the app child (`picoclaw gateway`, `tail -f /dev/null`, `hermes gateway run`). Verified empirically: `kill -TERM 1` inside the container is silently ignored; killing the app child only makes bash's `||` restart it.

**Fix (2026-08-07):** Wrap every `vm-builds/*/Dockerfile` entrypoint in tini (mirrors openclaw image, which already used `tini -s --`):
- picoclaw (Alpine): `apk add tini` → `ENTRYPOINT ["/sbin/tini", "-s", "--", "/usr/local/bin/start.sh"]`
- codex / opencode / hermes (Debian): `apt-get install -y tini` → `ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/start.sh"]`

tini forwards SIGTERM to its bash child, bash dies, tini exits → clean stop in ~0.1–0.3s with exit 143. No `start.sh` changes needed (openclaw keeps the `|| tail -f /dev/null` pattern and still stops fast).

**Rebuild/verify notes:**
- Rebuild tags the shared `paddock-vm-<type>:latest`, so **recreate** existing containers (`docker compose -f instances/<pad>/docker-compose.yml up -d --force-recreate`) to pick up the new entrypoint — `docker start` keeps the old image ID.
- Preserve the docker toggle on rebuild: agents with the docker socket mount were built with `--build-arg INSTALL_DOCKER=1` (codex/opencode at the time of writing; picoclaw with default 0). Check the instance `docker-compose.yml` for the `docker.sock` mount before rebuilding.
- Verify PID 1 is `tini` via `docker exec <pad> ps -o pid,ppid,comm`, then `time docker stop <pad>` should be well under a second.
- `AGENT-*` legacy images (`sleep infinity` / `opencode web` as PID 1) have the same class of problem; not migrated.

## Backup & Restore

> **STALE (2026-08-09):** The old generic tar flow is **gone**. `manage_backups.sh`
> no longer exists (no `scripts/` dir, no top-level script). `src/services/backup-manager.js`
> is now a **stub** — `backupAgent()` / `restoreAgent()` throw `UNAVAILABLE`
> ("Generic backups were removed. Native backups are not available yet.") with
> no callers in `src/`. Backups are being redesigned as **native per-driver**
> backup/import (`openclaw backup create`, `hermes backup`/`hermes import`, …)
> under `plans/26-backup-and-restore.md`. Nothing below describes current code.

**Historical (what the removed generic flow did):** a self-aware script that
discovered PADs from `instances/` and used `openclaw backup create` inside each
running container.

- Backup flow: `openclaw backup create --output /tmp/{name}_{timestamp}.tar.gz`
  inside the container → copy archive to `backups/` → clean up.
- Restore flow: find latest `backups/{pad}_*.tar.gz` → copy in, extract to the
  data dir → restart container.
- Clone: backup source → create fresh target → stop → restore → start.
- Known issues: large workspaces slow the command; backup copies SQLite state.

**Current state:** backups live only as old archives in `backups/`
(plus `backup-meta.json`). There is no working backup/restore path until
plan 26 is implemented.

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

> **HISTORICAL (2026-08-09):** describes the Flask→Express + EJS era. The EJS
> views were replaced by the React SPA (2026-07-23, see "React SPA" above) —
> `src/views/` and `routes/agents.js` are dead code. The WebSocket/terminal
> notes and the EJS pitfall list below are kept as history only.

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
docker compose build webui && docker compose up -d --no-deps --force-recreate webui
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

> **HISTORICAL (2026-08-09):** the EJS + HTMX architecture described below
> (directory tree, `views/`, `routes/agents.js`, HTMX partials, VMF) was
> replaced by the React SPA. Keep for context; the current layout is in the
> "React SPA" and "Driver Framework" sections above.

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
| `AUTO_LOGIN` | No | `true` (default) auto-logs every request in as the admin user — no login screen. Set to anything else to enable real auth (`/login`, `/api/setup`) |
| `SESSION_SECRET` | No | Auto-generated if not set. Set for persistence across restarts |

`AUTH_PASSWORD` is **gone** — auth is now a multi-user system (users table +
password hashes in `src/data/app.db`), see `docs/backend/user-management.md`.

### Workspace Mount Guards (`GUARD_*`)

Every safety check in `vm.validateWorkspaceMount()` (src/services/vm-manager.js) is a
named guard, ON by default. Set `GUARD_<NAME>=0` in `.env` to disable that single
check, then recreate the webui (`docker compose up -d --force-recreate paddock`).
Guard names: `SYSTEM_DIRS`, `PROJECT_ROOT`, `APP_DIR`, `SRC_DIR`, `INSTANCES_PARENT`,
`INSTANCE_DIR`, `AGENT_DATA`, `OTHER_AGENT`, `SYMLINK_ESCAPE`, `CONTAINER_PROTECTED`,
`DATA_DIR_SWALLOW`, `CRITICAL_STATE`, `FIXED_WORKSPACE`.

To let one agent mount the whole project root (`/www2/paddock`) as its workspace
source (e.g. a "develop Paddock itself" agent), disable three guards — mounting the
root triggers them in order:
```bash
GUARD_PROJECT_ROOT=0        # "The project root cannot be the workspace source"
GUARD_INSTANCES_PARENT=0    # root contains instances/
GUARD_AGENT_DATA=0          # root swallows instances/<pad>/<agent>
```
Remember what you're buying: that agent then has read/write over `src/`, `instances/`
(every PAD's sessions/configs), `backups/`, and `.env` (VAULT_KEY, AUTH_PASSWORD,
SESSION_SECRET). Guards are read from `process.env` at call time — no reload needed
mid-process, but the webui restart picks up new `.env` values.


### Testing

**Run the test files individually — never the whole suite at once.** The
combined `node --test test/` run always hangs past the tool timeout (the
suite is huge; known issue). Run each file separately:

```bash
timeout 60 docker exec paddock node --test test/vm-manager.test.js   # 34/34
timeout 60 docker exec paddock node --test test/mcp.test.js          # 7/7
timeout 60 docker exec paddock node --test test/auth.test.js
timeout 60 docker exec paddock node --test test/db.test.js
timeout 60 docker exec paddock node --test test/registry.test.js
timeout 60 docker exec paddock node --test test/workspace.test.js
```

Notes:
- `vm-manager.test.js` asserts the `GUARD_*` defaults, which `.env` disables —
  run it with the guard envs cleared:
  `docker exec -e GUARD_PROJECT_ROOT= -e GUARD_INSTANCES_PARENT= -e GUARD_AGENT_DATA= paddock node --test test/vm-manager.test.js`
- Some suites (e.g. `mcp.test.js`) need real Docker state — running them from
  inside the container against the live host socket is expected.

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
docker cp paddock:/app/node_modules /workspace/src/node_modules
```
And **`.gitignore`** must keep `**/node_modules/` (already done).

### Rate Limiter
- `src/middleware/rateLimit.js` defaults to 30 requests/minute per IP.
- 30 is too tight for page loads + HTMX tab loads (8 tabs per detail page = 9 requests). Bumped to 300 for normal browsing.

### Restart Command (no rebuild needed)
```bash
docker compose up -d --no-deps --force-recreate webui
```

Note: the compose service is named `webui` (container `paddock`). A plain
`docker restart paddock` also works when nothing in the image changed.

### Vite Dev Server (HMR for React SPA)

For React frontend development with hot reload, run Vite dev server inside the container:

```bash
docker exec -d paddock sh -c 'cd /app/client && npm run dev'
```

- Vite runs on **port 5173** (already mapped in `docker-compose.yml`).
- **Access the app at `http://10.69.1.164:5173` during development** (NOT port 6789).
- Port 6789 also works — it serves the **built** SPA from `public/` via Express, but requires `cd client && npm run build` to see changes.
- In dev, use 5173 for instant HMR. In prod/demo, use 6789.
- Vite's config proxies `/api` and `/ws` to Express on port 6789.
- Express backend changes still use the bind mount (no rebuild needed).
- To stop: `docker exec paddock sh -c "kill \$(lsof -ti:5173)"`

**Default workflow for me:** When doing frontend development, I must start the Vite dev server first (if not already running) and test on port 5173. No rebuild needed. Only use port 6789 for production/demo verification.

### Nav Items (current order)
Dashboard, +PAD, Vault, Backups
- **Usage tab removed** — it was an external OpenAI report, not useful in the panel.

### Cleanup Completed
- `src/views/usage.ejs` and `src/views/partials/usage_stats.ejs` deleted.
- Read-only `usage/usage_data.csv` reading code and all `/usage` / `/api/usage` routes removed from `app.js`.


## PAD Dashboard — HTMX Action Buttons (2026-07-18)

> **HISTORICAL (2026-08-09):** HTMX was removed in the React SPA migration —
> this and the duplicate section below describe the dead EJS-era pattern.

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

> **HISTORICAL (2026-08-09):** HTMX was removed in the React SPA migration.

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

> **STALE (2026-08-09):** none of these exist anymore — `scripts/` is gone from
> the repo (verified: no `scripts/` dir, no crontab). See "Daily Commit" above.

### Key Files Created
- `src/services/vm-manager.js` — createVm, removeVm, resetVm, docker-compose override YAML generation, config patching
- `src/services/backup-manager.js` — backupAgent, restoreAgent via docker exec + docker cp

### Pattern for Post-Creation Config
- Instead of a separate "onboard" service, Telegram + API key setup is done inline with direct `runCmd('docker', [...])` calls in route handlers
- Config patching (Telegram bot token, model provider) is a pure JS function in `vm-manager.js` — no Python scripts needed

## MCP Browser Testing (2026-07-18)

### Accessing the WebUI from Browser MCP
- Browser MCP runs on the host, so it accesses the webui at `http://10.69.1.164:6789` (local network IP, production SPA build).
- Vite dev server (HMR) runs on port 5173+ inside the container — use `http://10.69.1.164:5173` for live dev.
- `localhost:6789` does **NOT** work from browser MCP — it connects to a different network context.
- `172.19.0.1` (Docker gateway IP) does **NOT** work from browser MCP — use `10.69.1.164` instead.
- Quick restart (no rebuild): `docker restart paddock`

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


## Blank Settings Tab: unguarded `settings.network` on first render (2026-08-08)

**Symptom:** The agent Settings tab renders a fully blank page (empty `#root`).
The whole SPA unmounts — no error message, because React 19 has no error
boundary, so a render-time throw blanks the entire app.

**Root cause:** In `SettingsTab.jsx`, state `settings` starts `null` and is
filled by a `refresh()` fetch. The new "Additional ports" JSX (plan 28) read
`settings.network` directly (no `?.`) during the **first render**, throwing
`TypeError: Cannot read properties of null (reading 'network')`. The rest of
the file already used safe `settings?.x` or a derived `currentNetwork`
(`settings?.network || ''`). Any new JSX that touches `settings` on initial
mount must use the safe form.

**Fix:** Replaced `settings.network` in the ports section with the existing
`currentNetwork` variable. Rebuild + restart:
```bash
cd src/client && npm run build   # output → src/public/
docker restart paddock
```

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

## Container Health Checkup (2026-08-07)

- **`src/services/container-health.js`** — generic Docker-level checkup, no
  agent/driver knowledge. Diffs **declared** compose
  (`docker compose -f instances/<name>/docker-compose.yml config --format json`)
  against **actual** container (`docker inspect`). Works on stopped containers —
  reports *why* it's down (OOM-kill, exit code, stale peer) instead of failing.
- 11 checks: compose file · container exists/status · Docker `/healthz` probe ·
  restart policy · image · network mode + `container:` peer existence/running
  state · volumes/bind mounts (incl. `/workspace` split-brain) · docker socket ·
  published ports · env keys (secrets excluded via
  `/(password|token|key|secret)/i`).
- Check shape: `{ key, label, status: 'ok'|'warn'|'error', expected, actual, hint }`.
  `checkContainerHealth(name, onCheck?)` — with `onCheck` streams per-check
  (health job), without returns the full report. `summarize()` derives status:
  error if any, else warn if any, else ok.
- **No auto-fix** — failing rows carry a hint (usually "Recreate to fix"). The
  dashboard Start button already falls back to compose recreate when
  `docker start` fails.
- Routes: `GET /api/agents/:name/health` (passive pill),
  `POST /api/agents/:name/health-check` (job `health:<name>`),
  `GET /api/agents/:name/health-log` (SSE `check`/`done`/`error` events),
  `POST /api/agents/:name/recreate` (job `recreate:<name>`, force-recreate SSE).
- `job-log.js`: new `check(job, item)` event; `finish(job, ok, extra)` now
  accepts `{ status, counts }` for the health summary.
- `vm-manager.js`: `getNetworkHealth(name)` → `none|ok|stale|peer-stopped`;
  settings GET returns it as `networkHealth`. `stale` = peer container recreated
  (recorded ID dead, start fails "No such container"); `peer-stopped` = peer
  exists but not running. Both trigger the amber banner + "Recreate to fix".
- Frontend: `HealthCheckModal.jsx` (SSE checklist popup, ✓/✗/~ rows,
  expected/found detail, hints, counts footer) + health section in
  `SettingsTab.jsx` (Run button + status pill + stale-peer banner). Rows use
  `items-center` so the icon centers against the label text.
- **Driver-aware app checks planned but NOT implemented** — see
  `plans/20-health-check-driver-aware.md` (driver `healthChecks` group:
  openclaw cron/gateway/models, hermes config.yaml/model, picoclaw
  gateway/config, codex login, generic config-file parse).
- Tests: `services.test.js` passes; `mcp.test.js` only passes when run
  individually (`timeout 60 docker exec paddock node --test test/mcp.test.js`)
  — the combined `node --test test/` run hangs past the 120s tool timeout.

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
- **The base image's `/etc/profile` resets PATH to base dirs for login shells**
  — `docker exec` works (image `ENV PATH` includes `/opt/hermes/bin`), but the
  webui terminal/tmux spawn login shells (`/bin/bash`) and could NOT find
  `hermes`. Fix: Dockerfile writes `/etc/profile.d/hermes-path.sh` that
  re-appends `/opt/hermes/bin:/opt/hermes/.venv/bin:/opt/data/.local/bin` to
  PATH for login shells. Always verify commands from a login shell
  (`bash -lc`) and through the actual terminal WS, not just `docker exec`.
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

## Codex Driver (Goal 5 — 2026-08-07)

- codex (OpenAI Codex CLI) has its own CLI `codex` — **no `openclaw` binary**.
  The npm package `@openai/codex` is a thin wrapper that spawns a native Rust
  binary from `@openai/codex-linux-x64` (auto-installed optional dep). No
  gateway daemon — container keeps alive via `tail -f /dev/null`.
- Version: `codex --version` → `codex-cli 0.147.0` — parse with a
  `\d+\.\d+\.\d+` regex. `availableVersion: ''` (no base label).
- Config is **TOML** at `/root/.codex/config.toml` (driver `configFile:
  'config.toml'`, `configFormat: 'toml'`). Any non-`'json'` configFormat makes
  the config GET/POST routes serve/write the file verbatim (same path as
  hermes' yaml) and the ConfigTab skips JSON validation.
- Workspace: `workspaceDir: '/root/.codex/workspace'`. Terminal `pwd` lands
  there; host bind `instances/<pad>/codex` → `/root/.codex`.
- Docker toggle: `INSTALL_DOCKER=1` build arg installs `docker.io`; the
  settings route auto-rebuilds when the CLI is missing (verified — detected,
  rebuilt, recreated, docker works from inside).
- `codex exec` (non-interactive) works for scripts; `codex` interactively is
  the TUI in the terminal tab.
- **Restart the webui after adding/editing a driver file** (Node caches
  `require()` at startup — a stale process builds the wrong image via the
  openclaw-driver fallback).

## Web Publishing + the socat Door (2026-08-07)

Agents with a web app (opencode web, hermes web dashboard) get a **Web tab** that
publishes a host port to their app via `POST /api/agents/:name/web`
(`{ containerPort, hostPort, auth }`). Flow: write `web.json` in the instance dir,
regenerate the instance compose (`vm.applyWebServices(name, webService)`), recreate
the container, then `docker exec <name> bash <dataDir>/start-web.sh` (drivers have a
`startWebCommand` + auto-start boot hook in `start.sh`). `GET /web` inspects the
publishing container for `actualPorts`; the pill is `live` only when the published
port matches. Delete/unpublish = regenerate compose without ports + remove container.

**Network peer (network_mode: container:) case — the socat door.** Agents that route
through a peer (e.g. `network_mode: container:gluetun-global`) can NEVER publish host
ports (docker refuses: "conflicting options: port publishing and the container type
network mode"), AND gluetun's firewall drops host-LAN inbound to its namespace. But
containers on the peer's docker bridge ARE allowed through (gluetun auto-allows bridge
subnets). Verified: a throwaway `alpine/socat` container on `gluetun_default` reached
`gluetun-global:8080` → HTTP 200.

Fix: emit a **door service** (`<name>-web`) in the instance compose:

```yaml
  <name>-web:
    image: alpine/socat
    container_name: <name>-web
    restart: unless-stopped
    networks:
      webbridge:
        external: true
        name: <peerNetwork>   # e.g. gluetun_default
    ports:
      - "<hostPort>:<containerPort>"
    command: TCP-LISTEN:<containerPort>,fork,reuseaddr TCP:<peer>:<containerPort>
```

- Door joins the peer's bridge, publishes the host port, forwards to the peer **by
  name** per connection → survives peer recreates, never touches gluetun itself.
- Peer recreated: pad still needs its stale-peer recreate; door is untouched.
- Peer on `network_mode: host` (no bridge) → door uses `network_mode: host`,
  forwards to `127.0.0.1:<containerPort>`.
- `getPeerNetworkName(peer)` inspects the peer's `NetworkSettings.Networks`; the
  agent gets NO `ports:` block in peer mode. `applyWebServices` is async.
- `GET /web` inspects the **door** container for actualPorts (peer case). Unpublish/
  rollback: `docker rm -f <name>-web` after compose regen.
- Live-verified on pad-opencode-yo (gluetun-global): publish 43818 → door up, curl
  200, pad still `container:gluetun-global`; restart pad → boot hook relaunches, door
  still serves; unpublish → door gone, port 000.

### Network switch must keep a published web app live

Switching networks in the Settings tab while a web app is published silently broke
the binding (old `applySettings` regenerated the compose WITHOUT `webService`, so the
ports/door vanished even though `web.json` still said active — the Web pill showed
"active" but nothing was published). Fixes (2026-08-07):

- `vm.applySettings()` is now **async** and reads the active `web.json` binding itself,
  regenerating the compose with `webService` + the resolved `webPeerNetwork` for the
  NEW network. `applySettings` never drops the web binding anymore (covers docker
  toggle too, not just network changes).
- The settings route (`POST /api/agents/:name/settings`) re-applies the web binding
  after the change: force-recreates the door on a network change (plain `up` on a
  docker-only toggle), drops the door when leaving peer mode, re-execs the
  `start-web.sh` hook, and re-verifies the server (same poll as the publish flow).
- **Door must be removed BEFORE the agent recreate when leaving peer mode** — the
  door still holds the host port, so the agent's new `ports:` bind fails with
  "Bind for 0.0.0.0:PORT failed: port is already allocated". Same ordering rule in the
  settings rollback path.
- **Restart the webui after editing vm-manager.js / app.js** — `require()` is cached;
  the running process silently keeps the old (buggy) code. A user-reported "doesn't
  work" on a code change that was never restarted is the classic symptom.

### Multiple agents on the SAME peer collide on the published port (2026-08-08)

**Symptom:** Every published web URL for several agents shows the SAME app (e.g. all
opencode agents showed "only paddock directory available"). It looked like the web
publish was "always sending to one container".

**Root cause:** All agents used `network_mode: container:gluetun-nord`, so they ALL
share gluetun-nord's network namespace. Each agent's web app was published with the
DEFAULT container port (8080 for opencode). In a shared namespace only ONE process
can bind `0.0.0.0:8080` — the first starter wins (paddock-dev). The losers'
`start-web.sh` idempotency probe (`/dev/tcp/127.0.0.1/<port>`, app.js:1113) sees the
port already listening **in the shared namespace** and silently skips starting their
own server. Every socat door forwards to `peer:<containerPort>`, so every published
URL reached the ONE process that owned the socket.

**Fix:** Publish each agent on a **unique container port** when they share a peer
(8080, 8081, 8082…). Each `opencode web --port 808X` binds its own port in the shared
namespace and its door (`TCP-LISTEN:<cport>,fork,reuseaddr TCP:<peer>:<cport>`)
reaches the right app. Re-publish via the Web tab with the container-port field set.

**Gotchas hit while fixing:**
- **The Web tab's container-port field defaults to the driver's port (8080).** A
  re-publish from the Web tab that leaves that field untouched silently REVERTS the
  unique-port fix: the door goes back to `peer:8080` and the agent's own server never
  starts (probe sees the peer holder's socket). Always set an explicit unique
  container port for every peer-shared agent, on every publish.
- `hostPortInUse` (app.js:1131) does NOT exclude the agent's own door container
  (`<name>-web`), so re-publishing on the SAME host port fails with "already in use
  by another agent" while the old door holds it. Use a fresh host port, or unpublish
  first then republish.
- Deleted agents leave orphan door containers (`<name>-web`) holding their host port
  — the instance dir is gone so nothing cleans them up. `docker rm -f <name>-web`
  frees the port (verified: removed `pad-opencode-ai-company-web`, freed 3456).
- Verify the fix: door cmd must say `TCP:<peer>:<newPort>`, the agent's own process
  must be running `opencode web --port <newPort>` with cwd = its workspace, and the
  old port must be refused (HTTP 000).

### Live fix on pad-opencode-aic (2026-08-08)

- aic collided with `pad-opencode-paddock-dev` on 8080 in the gluetun-nord namespace
  (paddock-dev won the bind). aic's `start-web.sh` probe saw 8080 busy and silently
  skipped its own server, and its door forwarded to paddock-dev's app — every request
  to aic's URL "failed" by hitting the wrong workspace.
- Re-published aic via a node script mirroring `POST /api/agents/:name/web` with
  `{ containerPort: 8081, hostPort: 3457 }` (script: write hook → applyWebServices →
  validateInstanceCompose → stop → compose up agent+door → exec start-web.sh →
  verify reachable). Door now `TCP-LISTEN:8081 → TCP:gluetun-nord:8081`, aic runs
  `opencode web --port 8081`, cwd=/www2/ai-company, old port 3456 refused.
- **socat is raw TCP — WebSockets pass through fine.** The user suspected the
  forwarder; it wasn't the problem. Full proof through the door:
  1. `POST /pty` (auth: `Authorization: Basic base64("opencode:<pass>")` +
     `x-opencode-ticket: 1`) → `{id:"pty_..."}` (ptyID must start with `pty`).
  2. `POST /pty/<id>/connect-token?directory=<cwd>` → `{ticket, expires_in:60}`.
  3. `ws://host:port/pty/<id>/connect?directory=...&cursor=0&ticket=<t>`
     → 101, real shell prompt + cursor frames.
  - A WS upgrade on the wrong path (`/` or legacy `/api/pty/.../connect`) with valid
    basic auth HANGS (000, server never replies) instead of erroring — don't
    misread that as a forwarding failure. The v1 `/pty/.../connect` path responds
    401/400 correctly, proving the handshake reaches the app.

### Door rename: `<name>-web` → `<name>-door`, and all ports ride the door (2026-08-09)

**What changed:** the socat door was renamed from `<name>-web` to `<name>-door`,
and it no longer exists for web apps only — in peer mode the door now carries
**web + SSH + extra ports** in one container, one `socat TCP-LISTEN:<hostPort>,fork,reuseaddr TCP:<peer>:<containerPort>`
process per port (identity `host:host` maps). Peer-networked agents can now expose
SSH and additional ports via the Settings tab — the old "cannot publish ports in
peer mode" bans in `validateExtraPorts`/settings/ports/create routes were removed.

**Migration gap:** existing agents' compose files were generated with the old
`-web` door. The reconcile (`syncDoors`/`removeDoors` in `src/app.js`) originally
only matched `^<name>-door$`, so a regenerated compose would emit `-door` while
the stale `-web` container still held the host ports → "port already allocated".
**Fix:** `doorNameRe(name)` now matches both `^(<name>-door|<name>-web)$`, and
`removeVm()` drops both suffixes. Live-migrated `pad-opencode-aic` and
`pad-opencode-paddock-dev` via a ports POST with a real extra port (triggers the
regen+reconcile; a no-op POST short-circuits at the `!changed` guard and does
NOT migrate).

**Legacy doors were standalone instance dirs:** the old web-publish flow built a
per-door IMAGE (`paddock-vm-<name>-web:latest`) from `instances/<name>-web/`
(with its own compose/build/logs). After migration these `<name>-web` dirs are
dead — new doors are an `alpine/socat` SERVICE inside the agent's own compose.
Deleted agents' orphan doors (e.g. `pad-opencode-yo-web` holding 43818) had no
agent to reconcile them. **Fix:** `cleanOrphanDoors()` runs at webui boot and
`docker rm -f` any `*-door`/`*-web` container whose `instances/<base>` dir no
longer exists (safe — only our system creates `<x>-door`/`<x>-web` containers).
Manually removed `pad-opencode-yo-web` (freed 43818) + stale `-web` dirs for
`ai-company`, `yo`, `aic`, `paddock-dev`.

**Verified live (aic, gluetun-nord peer):** added extra port 34851→3456 (aic's
own `opencode web --port 3456`), door grew `TCP-LISTEN:34851→TCP:gluetun-nord:3456`,
host:34851 → HTTP 200; POST `extraPorts: []` reverted the door to web-only and
34851 → 000. Same flow on paddock-dev (51234). `hostPortInUse` does NOT exclude
the agent's own door, so reusing a just-freed host port still errors until the
door is gone — use a fresh host port or two POSTs.

**Door follows the agent on Paddock Start/Stop/Restart (2026-08-09):** the
Start/Stop/Restart buttons now start/stop the door **together with** the agent
(`startDoors`/`stopDoors` in `src/app.js` — `docker start` is a no-op on a
running door, `docker stop` skips already-stopped doors). Stopping the agent
inside Paddock stops the door too (it forwards to the agent's ports in the peer
namespace, so a stopped agent makes it a dead open listener). This ONLY applies
to the Paddock buttons — `docker stop <name>` from the CLI stops just the agent,
and the door keeps running; starting the agent again from Paddock then works
fine (the still-running door just resumes forwarding). Verified live on aic:
Paddock stop → agent Exited + door Exited + port 000; Paddock start → both Up +
port 200; CLI-stop-then-Paddock-start → agent Up, door never went down, port 200.

## MCP Server /mcp — Shared-Function Rule (2026-08-09; plan 30 absorbed — see docs/backend/services.md "MCP Tools")

- `src/mcp.js` exposes **17 tools** over the `/mcp` Streamable HTTP endpoint:
  `list_agents`, `get_agent`, `agent_logs`, `config_get`, **`settings_get`**,
  **`health`** (→ `containerHealth.checkContainerHealth(name)`, the same checkup
  as the Settings tab), `workspace_list`, `workspace_read`, `workspace_write`,
  **`create_agent`** (→ `vm.createAgent`: validate + build image + seed config +
  setup steps; caller becomes owner), `start_agent`, `stop_agent`,
  `restart_agent`, **`recreate`** (the ONE mutation
  "gun" — every settings/web option is an optional arg), `update` (alias for
  `recreate {pull:true}`), `delete_agent`, `exec`.
- **Tool names carry NO `paddock_` prefix** — the consuming MCP client already namespaces the
  server's tools itself, so a prefixed name would double-prefix. Keep new tools unprefixed.
- **Business logic lives in `src/services/`; REST routes (app.js) AND MCP tools (mcp.js) are thin
  adapters over the SAME service functions — never duplicate behavior between them.** Examples:
  config read → `vm.readAgentConfig(agent)` (driver-aware configFile/configFormat, redacts JSON
  secrets); start/stop/restart → `vm.startAgent`/`stopAgent`/`restartAgent` (these also start/stop
  the socat door with the agent — the CLI-only `docker start/stop` does NOT touch the door);
  delete → `vm.removeVm` + `registry.removeAgentFromDb`; create (REST + MCP) →
  **`vm.validateAgentCreate(name, opts)`** (pre-flight: name/agent type, network peer running,
  extra volumes/ports, SSH container port, workspace mount, cross-agent host-port availability —
  throws before anything is created) then **`vm.createAgent(name, opts)`** (normalizes
  port/sshCport/workspaceHost/workspaceDir + `createVm`). Both `POST /api/agents/create` and the
  MCP `create_agent` go through these — the route kept only the 409 exists-check and the
  admin `assign_to` owner override, which now uses `registry.assignOwner(name, userId)`;
  settings/web/ports POST and MCP `recreate` → **`vm.applyAgentChanges(name, opts, {onLog, onStep})`** (the consolidated flow);
  settings GET → `vm.readSettings(name)`; container-info GET → `vm.containerInfo(name)`.
- `vm-manager.js` now exports `VM_NAME_RE` and `hostPortInUse` (both were duplicated in app.js;
  the app.js copies are deleted). `create_agent` (MCP) takes a **bare** name and builds the full
  prefixed one (`createNameFor` — strips an already-present prefix); every other MCP tool takes
  the full name. MCP `create_agent` requires `confirm: true` (heavy — image build + new fleet
  member); the REST create route never required confirm and still doesn't.
- **`vm-manager.js` runCmd contract differs from app.js's**: it REJECTS on non-zero exit and
  resolves `{ stdout, stderr }` with **NO `code` field** (app.js's resolves `{ stdout, stderr, code }`).
  Any vm-manager code copied from app.js that checks `r.code !== 0` / `r.code === 0` is always
  wrong. Fix: try/await/catch; `/no such (object|container)/i` for "not found" (this bit
  `containerInfo` and `imageHasDockerCli`/`imageHasSshPortSupport` — see below).
- MCP auth: `Authorization: Bearer <api key>` or `x-api-key`. Keys are created in the webui Vault /
  API keys page; the raw key is shown once (`api-keys.create`), only the hash is stored.
- `get_agent` accepts an optional `logs` param (tail N ≤ 500) and includes recent container
  logs via `logStore.capture` + `readLogs`. `agent_logs` is the standalone equivalent.
- `delete_agent` requires `confirm: true` — destructive, no undo (removes container, door,
  network, instance dir). Keep that guard. `recreate` requires `confirm: true` only when
  `reset: true` (wipes the data dir). `create_agent` requires `confirm: true` too.
- Testing MCP over HTTP: `docker exec -e MCP_KEY=<key> paddock node -e '…http POST /mcp…'` — responses
  are SSE (`event: message` + `data: {...}` lines), parse the `data:` lines. The `/mcp` endpoint
  refuses without a valid key, and returns 406 unless the client sends
  `Accept: application/json, text/event-stream`.
- Tests: `timeout 60 docker exec paddock node --test test/mcp.test.js` (8 tests; the combined
  `node --test test/` run hangs, known issue — run mcp.test individually).

### vm-manager tests inside the paddock container: unset the GUARD_* envs

The `.env` deliberately sets `GUARD_PROJECT_ROOT=0`, `GUARD_INSTANCES_PARENT=0`,
`GUARD_AGENT_DATA=0` (so a pad may mount the project root). `vm-manager.test.js`
asserts the guards work by DEFAULT, so running the suite inside the container
fails 1 test unless you override them empty:
```bash
docker exec -e GUARD_PROJECT_ROOT= -e GUARD_INSTANCES_PARENT= -e GUARD_AGENT_DATA= \
  paddock node --test test/vm-manager.test.js   # 34/34 pass
```

## Architecture Documentation

- **Read order:** when a task touches docs or you need the system's shape, first read `docs/README.md` (index + map of folders), then the relevant `docs/` pages. Before **writing or editing** any doc, read `docs/STYLE-GUIDE.md` and follow it — it is the single authority for format, skeleton, voice, and terminology. A doc that disagrees with the style guide gets fixed.
- `docs/` — **Source of truth** for business logic, system architecture, page descriptions, routes, data model, security model, and all behavioral contracts. Split by area: `overview/` (architecture, business-logic, react-migration), `backend/` (services, middleware, user-management), `tabs/` (per-tab behavior), `pages/`, `components/`, `operations/`.
- Rule: If code and docs disagree, fix the code.
- AGENTS.md remains the place for operational learnings, bug fixes, commands, and PAD session context.

### Main documentation files (paths)

- `docs/README.md` — index + folder map (read first)
- `docs/STYLE-GUIDE.md` — the style guide: format, skeleton, voice, terminology (read before writing/editing docs)
- `docs/overview/architecture.md` — system architecture, containers, data flow
- `docs/overview/business-logic.md` — detailed workflows: discovery, workspace, lifecycle, backup, auth, terminal, MCP, skills, OAuth, config
- `docs/backend/services.md` — all backend services with functions, schemas, business logic
- `docs/backend/user-management.md` — multi-user system, owner-based scoping
- `docs/tabs/terminal.md` — the docked interactive shell (tmux + xterm)
- `docs/tabs/web.md` — web publishing + the socat door
- `docs/tabs/settings.md` — container settings: update, health, docker, network, delete
- `docs/operations/overview.md` — agent lifecycle, dev workflow, git workflow

## User Preferences

- Planning/ideas files go in `/workspace/plans/` as separate `.md` files. When the user says they want to plan something or save an idea, write a new `.md` file in that folder.
- **Remove a plan file after absorbing it.** Once a plan's implementation is done (features built, verified, learnings recorded in AGENTS.md), delete the `.md` plan file — don't leave stale "future work" docs around. `rm plans/<file>` (sudo if needed). If a plan is only partially absorbed, keep it and update it to reflect what's left.
- Messaging page plan: `/workspace/plans/messaging-auth-panel.md` — terminal + credential panel for messaging setup (Telegram, Signal, GChat). Uses `openclaw channels add/login/remove` commands.
- Model provider plan: `/workspace/plans/model-provider-panel.md` — terminal + API key panel for model provider setup. Uses `openclaw models auth paste-api-key/login/list` commands.
- Backups page plan: `/workspace/plans/backups-page.md` — global backup listing; add File Name column to the table.
- Create agent page plan: `/workspace/plans/create-agent-fix.md` — fix layout-breaking HTMX and simplify the form.

## Terminal: Ctrl+C Leaves a Blank Line on Alpine/busybox-ash Pads

**Symptom:** Pressing Ctrl+C in the webui terminal on a busybox-ash pad (picoclaw/Alpine) shows an extra blank line after `^C`:

```
0e15261df60d:~# ^C

0e15261df60d:~# ^C
```

**Root cause:** busybox ash v1.37.0 itself emits `^C\r\n\r\n` (TWO CRLFs) on Ctrl+C in a plain PTY — reproduced with no webui/tmux involved (python3 pty harness), with raw `tmux send-keys C-c`, and via the WS probe. bash emits a clean single newline. It's shell-level behavior, not the webui or tmux. (ash.c `preadfd()` writes `^C` then one `bb_putchar('\n')` + `goto retry`; lineedit.c VINTR path uses `break_out = -1`.)

**Fix (2026-08-07):** `ensureTmuxSession()` in `src/app.js` now runs `tmux new-session ... bash` when `command -v bash` succeeds in the container, falling back to the default shell otherwise. bash is present in the picoclaw image (`/bin/bash`, musl build). The colored PS1 hook in `/root/.bashrc` was already bash-targeted.

**Important:** the fix only affects sessions created AFTER the change. Existing sessions still run the old shell — kill the session (Sessions dropdown) and reconnect to pick up bash. Webui restart needed after editing `src/app.js` (`docker compose restart webui`).

**Debug helpers:**
- Plain-PTY repro (no webui): python3 pty harness doing `docker exec -it <pad> sh` and sending `\x03`.
- WS probe: `docker cp /tmp/opencode/ctrl-c-probe*.js paddock:/app/` + `docker exec -i paddock node /app/ctrl-c-probe2.js <pad>`; webui WS is `ws://localhost:6789/ws/terminal/<pad>?session=main` (**6789, not 5050**).
- busybox sources checked: `/tmp/opencode/ash.c`, `/tmp/opencode/lineedit.c`.

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

## CommandsPane Buttons Paste Commands, Not APIs (2026-08-07)

**Rule:** Every action button in the agent Commands pane (`CommandsPane.jsx` + openclaw
flows) must paste an `openclaw ...` command into the docked terminal via `run(cmd)`.
It must NOT call a backend action API. The terminal is the interface; the API routes
that wrap `docker exec openclaw ...` are a trap that bypasses the visible terminal.

- **MCP "Add server"** no longer POSTs `/api/agents/:name/mcp/add`. It collects
  name + transport + url/command via the prompt modal, builds
  `openclaw mcp add <name> [--no-probe] --url <u> --transport <t>` (HTTP) or
  `openclaw mcp add <name> --command <cmd>` (stdio) and `run(cmd)`s it.
- **MCP "Remove server"** and the chip `×` run `openclaw mcp unset <name>`
  (was `/mcp/remove`).
- **Skills "Install skill"** runs `openclaw skills install <ref>` (was
  `/skills/install`). Search/List-tools already pasted commands.
- Dropped `--no-probe` from the backend-built command (it only existed because the
  API ran headless with a 30s timeout). Now the add form has a **"Test MCP
  connection"** checkbox (default checked = probe runs; unchecked appends
  `--no-probe`).
- Read-only GETs are still fine (`/mcp` server chips, `/agent-types/:type/commands`
  button groups). Only actions go through the terminal.
- The Vault dropdown is the exception on purpose — decrypt/add hit `/api/vault*`
  because secrets are stored server-side (that's the feature, not a command flow).

### Prompt modal field types (prompt.jsx)

Supports beyond plain text inputs: `type: 'select'` (with `options` as strings or
`{value,label}`), `type: 'checkbox'` (with `defaultValue`, `checkLabel` next to the
box, `hint` below), and conditional visibility via `when(values)` (a function —
used to show URL only for HTTP transports and command only for stdio).


- **Never touch containers outside our project.** Containers not defined in this project's `docker-compose.yml` are not ours. Do not start, stop, exec, inspect, or interact with them in any way. Our project only owns containers it creates.
- **Never create random containers for testing.** Spin up test containers only through the project's own tools (add-vm scripts, docker-compose services, or the web UI). Running `docker run` with external images is outside our scope.
- **Never refer to containers/PADs with a `vm-` prefix.** The naming scheme is not guaranteed. Refer to PADs by their actual name only.
- **Never use the question tool to ask the user questions during a conversation.** Ask questions directly in text instead. The tool is only for fallback or complex multi-option scenarios when explicitly justified.

## Container Info Popup — `exposed` vs `published` (2026-08-09)

- Settings → Container Info popup (`ContainerInfoModal.jsx` + `GET /api/agents/:name/container-info` in app.js) shows live container detail: network mode + peer, mounts table (type/source/destination/access), published ports, env keys, and a collapsible raw `docker inspect` JSON with env secrets redacted.
- **Do NOT present `Config.ExposedPorts` as "exposed" ports** — it's pure image/compose metadata, never bound to the host. Every pad image declares `EXPOSE 22` (from the base Dockerfile), so agents show `22/tcp` in ExposedPorts while nothing is reachable. Only `HostConfig.PortBindings` / `NetworkSettings.Ports` are real (published) ports.
- Ports section renders published ports when any exist; otherwise shows "No host-published ports." plus a warning listing the `EXPOSE`-declared ones as "Not published … nothing is reachable".
- **Peer-mode agents never publish on their own container** — the host binding lives on the `<name>-door` socat container, so the agent's Ports section is legitimately empty even when the Web tab shows a live URL.
- Popup is lazy-loaded: the endpoint is called only when the popup opens (not on page load). Live uptime is derived in the frontend from `State.StartedAt` and ticks every second — no backend uptime field.

## Persistent Container Logs (2026-08-07)

- `docker logs` dies with the container (docker rm removes the log file), so a recreated PAD's Logs tab started empty.
- `src/services/log-store.js` captures each container's logs into a rolling file at `instances/<name>/logs/container.log` (auto-gitignored — `instances/*` is already ignored). It runs `docker logs --timestamps`, parses each line's RFC3339Nano timestamp, appends only lines newer than the last captured one (`meta.json` stores `lastTs`), so a recreated container's logs naturally append with no dupes/gaps. File is trimmed past 8MB/20k lines.
- Capture triggers: every `/api/agents/:name/logs` fetch (view is always fresh), a 30s `setInterval` sweep in app.js over all `safeVmName` containers (logs persist even if the page is never opened), and at the start of each backend recreate/delete/update/settings `setImmediate` (final lines survive the sweep window).
- The MCP `agent_logs` tool also reads from log-store now.
- The old `dockerLogs()` helpers were removed from app.js and mcp.js (dead). `routes/agents.js` still has one — that file is dead code, not mounted.

## Theme / Logs UI fixes (2026-08-07)

- Custom scrollbars: global CSS in `src/client/src/index.css` — `scrollbar-width: thin` + `scrollbar-color: var(--t-raised) transparent` for Firefox, `::-webkit-scrollbar` (10px, rounded thumb, `background-clip: padding-box`, hover `--t-raised-hover`) for WebKit. Token-driven so it themes with light/dark.
- Logs tab 100% height: the `<pre>` had `max-h-96` capping it. LogsTab root is now `flex flex-col h-full min-h-0`, header `flex-shrink-0`, pre `flex-1 min-h-0 overflow-auto` — it fills the mode-content area and scrolls internally.
- **Terminal keeps xterm's DEFAULT colors** — the themed `xtermTheme()` (CSS-var bg + palette ANSI colors) and the `paddock:theme` listener were REMOVED from `Terminal.jsx` at the user's request. The terminal stays black-on-white-foreground in both light and dark modes; the theme toggle only affects the app UI around it, not the shell. Do not re-theme the terminal.

### Do Not Do (SPA rebuild gotcha)

- **JSX/CSS edits need `cd src/client && npm run build` + `docker restart paddock`** — the bind mount serves the BUILT bundle from `src/public/`, so editing a `.jsx` file alone does nothing until rebuilt. Symptom: new className never appears in the DOM (computed styles unchanged). Always verify the class string made it into `src/public/assets/index-*.js` before browser-testing.

## Custom Workspace Mount (plan 24 — 2026-08-08)

- Create/Settings now offer a custom workspace bind: host source (`WORKSPACE_HOST`)
  + container path (`WORKSPACE_DIR`), persisted in `meta.env`. Default (toggle
  off) keeps the workspace as the `workspace/` subfolder of the data mount —
  nothing moves.
- `vm.validateWorkspaceMount(name, agent, host, dir)` (vm-manager.js:103) is the
  single authority. Returns normalized `{ host, container, webuiVisible,
  hostBrowsable }` or throws. Both-or-neither, relative must start with
  `instances/`, absolute must not be a protected/system dir or swallow the data
  mount or another agent's dir. For fixed-path drivers (openclaw, picoclaw) the
  container destination must equal the driver's `workspaceDir`; opencode/codex
  allow an editable container path; **hermes is excluded** (its data dir IS the
  workspace — reject any workspace input).
- `generateInstanceCompose()` reads `WORKSPACE_*` from meta and emits a second
  volume line — so settings regen, web publish, reset, update, and the
  `ensureInstanceBuilds` migration all preserve the mount with zero caller
  changes. `createVm` must write the meta flags **before** `writeInstanceCompose`
  (and mkdir the host source only when webui-visible; Docker auto-creates
  invisible sources).
- Host file browser availability keys off `hostBrowsable` (mount under
  `workspace_root`), not merely on being under the project root. Non-browsable
  mounts: Host scope hidden with a note; container scope works while running,
  container-down shows a "start the agent to browse" empty state.
- Settings GET carries `workspaceMount`; POST accepts `workspaceHost`/
  `workspaceDir` (empty clears). Changing/clearing a mount never moves/deletes
  files — new folder starts empty, old folder left on disk.
- `removeVm()` removes the workspace dir only when `WORKSPACE_HOST` lies under
  the project root. Backup/restore and "Clone from backup" do NOT include an
  external workspace (documented limitation in the UI).

## Compose Serialization + Validation (plan 29 — 2026-08-08)

- `generateInstanceCompose()` builds the compose as a **structured JS object**
  and serializes with `JSON.stringify(..., null, 2)` — JSON is valid YAML, so no
  YAML library and no hand-built YAML strings. `${VAR:-default}` interpolation
  and `host:port` / `host:path` colon values survive byte-for-byte as JSON
  values (the original bug: unquoted `${INSTALL_DOCKER:-0}` in hand-joined YAML
  was parsed as flow syntax). Unit tests parse the output with `JSON.parse()`
  and assert structure, never layout text.
- `vm.validateInstanceCompose(name)` runs
  `docker compose --env-file <build.env> -f <compose> config --quiet` (parse +
  schema + interpolation, no side effects) and **throws with the parser output**
  on failure. It catches what JSON generation can't: schema violations,
  interpolation failures (a `${ARG}` missing from `build.env`), and invalid
  external-network references.
- `vm.runCompose(name, args, opts)` validates then runs every per-instance
  `build`/`up`. Settings/ports/web/recreate routes additionally call
  `validateInstanceCompose` **before** `docker stop` — so a bad document aborts
  with the PAD still running (verified live: corrupted compose → recreate →
  error event with go-yaml output, container stayed "Up").
- The settings/ports/web rollback paths only force-recreate when a `touched`
  flag was set (i.e. the container was actually stopped) — a validation failure
  that aborts before the stop leaves the running container untouched, instead
  of pointlessly restarting it.
- Compose CLI lives **inside the webui container** (`/usr/libexec/docker/
  cli-plugins/docker-compose`, v5.3.1) — the host docker CLI has no compose
  plugin. `docker compose` is always invoked from the container; the host only
  needs the plugin if you want to test from this shell (`cp` it from the
  container to `~/.docker/cli-plugins/`).
- `docker compose config --quiet` does NOT check build-context existence or
  external-network existence — those surface at `build`/`up` time. Its value is
  syntax/schema/interpolation, and it's cheap (~100ms).

## SSH Expose in Settings (2026-08-08)

- The Create page's "Expose OpenSSH" toggle is mirrored in the agent Settings
  tab (`SettingsTab.jsx` SSH card) — enable/disable + a host port field (empty
  = auto-allocate 43817+ via `vm.autoSshPort()`), applied through the same
  SSE settings job as docker/network/workspace (recreate).
- Backend: `GET /api/agents/:name/settings` returns `sshPort` (meta.PORT).
  `POST` accepts `sshEnabled` + `sshPort`. `sshEnabled === undefined` → no
  change; `false` → un-expose; `true` → keep/clear/auto-allocate. Validation:
  integer 1–65535, `hostPortInUse` against other agents (self excluded),
  conflict vs this agent's extra ports + web host port. Rollback path restores
  `oldSshPort`.
- `vm.applySettings` takes an optional `sshPort` opt (new value wins over
  `meta.PORT`) and now always writes `PORT` into meta.env.
- **`setMetaFlag(name, key, '')` now REMOVES the line instead of writing
  `KEY=`** — matches createVm (only writes `PORT=` when non-empty) and keeps
  meta.env clean. All readers use falsy checks, so behavior is unchanged for
  existing empty-value writers (WORKSPACE_*/NETWORK/EXTRA_*).
- Peer-mode agents (network override) can't publish SSH — the Settings UI
  disables the toggle with a warning (matches the additional-ports pattern);
  the compose generator already skips ports in peer mode.

## SSH Expose — container port + password (2026-08-09)

**Why:** the SSH card in the Web tab only asked for a host port. Agents that
share a network namespace (peer mode) can't ALL bind 22 inside it — exactly
like the web 8080 collision — so each needs a distinct *container* port, and
the root/SSH password was never settable from the UI. The SSH card now mirrors
the web-app publish card: host port + container port (default 22) + an optional
password (Show/Hide + Generate), plus a "Currently published: host X →
container Y" line.

- **Container port is real, not cosmetic:** meta `SSH_CPORT` (default `22`,
  read via `vm.readSshCport(name)`). The compose maps `${host}:${sshCport}`
  and the door forwards `TCP:<peer>:${sshCport}`. The container's sshd must
  therefore LISTEN on that port — passed as `SSH_PORT` env (added to
  `service.environment` only while exposed) and honored by a new block in every
  `vm-builds/*/start.sh` that `sed`s `Port $SSH_PORT` into sshd_config before
  launching sshd. Verified live: container port 3022 → sshd listens on 3022 →
  `sshpass -p … ssh -p 43850 root@host` logs in.
- **`ensureSshStartBlock(name)`** in vm-manager.js backfills that block into an
  OLD instance's own `build/start.sh` (idempotent; returns true only when it
  patched). The baked image's start.sh only changes on REBUILD, so the settings
  route calls `imageHasSshPortSupport(name, image, wasRunning)` (grep SSH_PORT
  in the running container's `/usr/local/bin/start.sh`, or throwaway `docker
  run --rm` of the image) and — when a non-22 container port is requested and
  the image lacks support — sets `sshRebuild`. `needRebuildFinal` folds it into
  the existing rebuild path (`vm.updateAgent pull:false`) with a clear log
  ("start.sh must inform us of the custom SSH container port"). Rebuild is
  cheap: only the `COPY start.sh` layer + metadata change (npm layer is CACHED).
- `POST /api/agents/:name/settings` accepts `sshContainerPort` (validated
  1–65535, `sshCportChanged`), `sshPassword` (string; empty ⇒ keep current;
  strips CR/LF; `passwordChanged = newPw !== oldRootPw`). applySettings persists
  `SSH_CPORT` and `ROOT_PASSWORD` meta + returns `sshCport`. Create route +
  `createVm` take `sshContainerPort`/`password` too (CreateAgent.jsx got the
  same two-column SSH fields).
- `autoSshPort()` now scans `/"(\d+):(\d+)"/g` — container ports vary now, and
  it must collect web/extra host ports too (not just `:22`).
- **Never echo the stored password** — the Web tab loads the sshPassword field
  empty and treats a non-empty typed value as "set"; empty stays "keep current".

## Host Override (HOST_NAME / HOST_PROTO) — 2026-08-09

- `.env` can set `HOST_NAME` (IP **or** hostname, e.g. `10.69.1.164` or
  `paddock.local`) and `HOST_PROTO` (`http`|`https`). These override the base
  used for **published web-app links** (AgentCard ↗ icon, Web tab access URL).
- `/api/config` exposes them as `host` + `hostProtocol`.
- Frontend `src/client/src/lib/web.js`:
  - `loadWebConfig()` fetches `/api/config` once at app boot (`main.jsx`) and
    caches it.
  - `webBase()` uses `config.host` + `config.hostProtocol` when set; otherwise
    falls back to `window.location` (derive-from-where-loaded is the default).
- Because `.env` vars are baked in at container **create** (env_file), a
  `docker restart` is NOT enough — you must **recreate** the paddock container
  for config changes to take effect.
- **Recreate gotcha**: the host docker CLI has no compose plugin; running
  `docker compose` inside a throwaway container resolves relative volume paths
  (`./src`) against the throwaway container's cwd → the host daemon mounts
  host-root `/workspace/...` (bind-mount split-brain, empty dirs, app.js
  MODULE_NOT_FOUND crash loop). Fix: recreate with host-absolute paths:
  ```bash
  docker rm -f paddock
  docker run -d --name paddock --restart unless-stopped \
    -p 6789:6789 -p 5173:5173 \
    -v /www2/paddock:/workspace:rw -v /www2/paddock/src:/app:rw \
    -v /var/run/docker.sock:/var/run/docker.sock:ro \
    --env-file /www2/paddock/.env paddock-webui:latest
  ```
  The compose file's relative mounts work when created from the host's real
  context only.
