# Business Logic

## PAD Discovery and State

### Discovery Flow

1. **Filesystem scan**: Read all directories under `instances/` that match `CONTAINER_PREFIX-*` (e.g. `vm-*`)
2. **Meta validation**: Each directory must contain a `meta.env` file with at minimum `AGENT=` line. Without it, the directory is skipped.
3. **Docker state query**: Run `docker ps -a --format "{{.Names}}\t{{.State}}"` to get running/exited/missing for each discovered PAD
4. **Agent build**: Merge filesystem metadata + Docker state into an agent object with:
   - `name`, `display_name` (capitalized name without prefix)
   - `status` (running/exited/missing)
   - `agent_type` from `meta.env` (openclaw/picoclaw/hermes)
   - `workspace_root` / `config_root` — resolved by probing the `instances/<name>/` directory
   - `default_model` / `default_provider` — parsed from the driver's `configFile` (e.g. `openclaw.json`) if it exists
5. **SQLite sync**: Each discovered agent is upserted into the `agents` table for metadata tracking

**Docker cache**: `docker ps -a` results are cached for 3 seconds. Calling `dockerPsList(true)` forces a refresh.

**Status resolution**: If `docker ps -a` reports a container name, use its state (`running` / `exited`). If the container is missing from Docker but the instance directory exists, status is `missing`.

### Workspace Root Resolution

```
instances/<name>/
  ├── meta.env
  └── openclaw/        ← agent type directory (name comes from agent_type)
       ├── openclaw.json   ← or the driver's configFile (opencode.json, config.json)
       └── workspace/
```

`findAgentDir()` first checks for a directory matching `agent_type` (e.g. `openclaw`). If not found, scans all subdirectories for one containing the driver's `configFile`. The workspace root is set to `agentDir` (the agent-type directory, not the workspace subfolder — the frontend navigates into `workspace/` by default).

### meta.env Format

```
AGENT=openclaw
ROOT_PASSWORD=<pw>
PORT=<ssh-port>
```

This file is **critical**. Without it, the PAD is invisible to the discovery system.

---

## Workspace File Browser

### Path Traversal Protection

All file operations go through `resolveSafePath(workspaceRoot, relativePath)`:

1. Normalize the relative path (`path.normalize`)
2. Strip leading `/`
3. Resolve against workspace root (`path.resolve`)
4. Verify the resolved path starts with workspace root + separator, or equals workspace root
5. If not, throw "Path traversal rejected"

This prevents `../../../etc/passwd` style attacks.

### Directory Listing

`listDir()` returns:
- Files and directories (sorted: directories first, then alphabetical)
- Hidden files (starting with `.`) are filtered out
- Each entry has: `name`, `type`, `size`, `modified` timestamp
- Returns empty array if path doesn't exist (graceful fallback)

### File Operations

| Operation | Method | Security check |
|-----------|--------|---------------|
| Read file | `readFile()` | Path traversal check, isDirectory check |
| Write file | `writeFile()` | Path traversal check, overwrite guard |
| Create folder | `createFolder()` | Path traversal, valid name, no dots prefix |
| Rename | `renameEntry()` | Path traversal, valid name, no overwrite |
| Delete | `deleteEntry()` | Path traversal, recursive rmdir for folders |
| Move | `moveEntry()` | Both source and dest path checked, no overwrite |
| Upload | multer via route | File type check, dangerous exts blocked (.exe, .bat, .ps1, etc.) |

### File Editor

Workspace files can be viewed and edited in a modal. Editable types are determined by extension (`.txt`, `.md`, `.json`, `.js`, `.py`, `.sh`, etc.). Before saving a `.json` file, the frontend validates it with `JSON.parse()` and shows the error line number.

---

## Agent Lifecycle

### Creation Flow (`createVm`)

1. **Validation**: Check agent name doesn't already exist (filesystem + meta.env)
2. **Port assignment** (SSH): Find first unused port starting from 43817
3. **Directory setup**: Create `instances/<name>/<agent>/` directory
4. **Clone mode** (optional): Copy source agent's entire data directory recursively (type-locked — source must be the same agent type; copies the source's `build/` too)
5. **meta.env**: Write `ROOT_PASSWORD`, `AGENT`, `PORT` to the instance dir
6. **Seed build dir**: Copy the shared template `src/vm-builds/<type>/` → `instances/<name>/build/` (Dockerfile + start.sh + extras; idempotent, never overwrites existing build files) — each PAD now owns its image source
7. **Compose file**: Generate `docker-compose.yml` with absolute host paths (fixes bind-mount split-brain), `build.context: instances/<name>/build`, `image: paddock-vm-<name>:latest`, and a generated `build.args:` block from the Dockerfile's `ARG` lines
8. **Container start**: `docker compose --env-file <build-dir>/build.env -f <compose> up -d`
9. **Workspace setup**: For OpenClaw/PicoClaw agents, run `openclaw setup --baseline` inside the container (retry up to 15 times with 1s delay)
10. **Restart**: Restart container after setup

### Start / Stop / Restart

- **Start**: `docker start <name>`. Falls back to `docker compose up -d` if the container doesn't exist anymore.
- **Stop**: `docker compose -f <compose> stop`
- **Restart**: Calls stop then start

All operations are async (fire-and-forget) with HTMX polling for status updates.

### Deletion Flow (`removeVm`)

1. `docker rm -f <name>` (ignore error if not running)
2. `rm -rf instances/<name>/` (recursive delete)
3. SQLite metadata remains (orphaned agents are cleaned up on next discovery)

### Reset Flow (`resetVm`)

1. `docker rm -f <name>`
2. Delete agent data directory (not meta.env)
3. Re-create empty data directory
4. Regenerate compose file
5. `docker compose up -d`

---

## Backup and Restore

The generic archive system was **removed** (plan 26 pre-plan). Paddock no longer
tars an agent's `dataDir`, extracts archives over the live data directory, or
clones a PAD from an archive during creation. `backup-manager.js` is a stub that
refuses every operation.

Native per-driver backup/restore capabilities replace it in plan 26 Goal 0
(OpenClaw archive create, Hermes full backup/import, session export for OpenCode,
unsupported for PicoClaw/Codex). Until then the Backups pages show a maintenance
empty state. Legacy archives in `backups/` stay on disk but are not served as
restorable data.

---

## Bind-Mount Split-Brain

### The Problem

The webui container (paddock-webui) generates docker-compose files for new PADs. When the compose file uses relative paths like `./openclaw:/root/.openclaw`, Docker Compose resolves the path relative to the compose file's location **inside the webui container** (`/workspace/instances/<name>/`). It then sends this absolute path to the **real host's Docker daemon**.

If the project lives at `/mnt/ddrive/www/paddock/` on the host, the daemon ends up mounting `/workspace/instances/<name>/openclaw/` at the **host root level** — a completely different directory from the actual project path. The PAD container writes files to the wrong location.

### The Fix

Generate compose files with **absolute host paths**:

```yaml
volumes:
  - /mnt/ddrive/www/paddock/instances/<name>/openclaw:/root/.openclaw
```

- The `HOST_WORKSPACE_ROOT` env var tells the webui container what the host-side path is
- `generateInstanceCompose()` uses this to produce `- ${HOST_WORKSPACE_ROOT}/instances/${name}/${agent}:${dataDir}`
- Without this fix, newly created PADs have empty workspaces

---

## Auth and Session

Full user management and owner-based scoping docs: [`backend/user-management.md`](../backend/user-management.md).

### Session-Based Auth

- Sessions use `express-session` with a random `SESSION_SECRET` (auto-generated if not set)
- Session cookie name: `vmf.sid`
- Cookie config: `httpOnly: true`, `sameSite: 'lax'`, `maxAge: 24 hours`
- Login: validate username + password against `users` table, set `session.userId` and `session.role`
- Logout: destroy session, redirect to `/login`
- Sessions stored in SQLite (`user_sessions` table) — survive server restarts

### Multi-User Model

- `users` table stores credentials and roles (`admin` / `user`)
- On first startup, `admin`/`admin` is seeded automatically
- Admin creates all users (no public registration)
- Every resource (agents, backups) has an `owner_id` referencing `users(id)`
- Admin sees all resources; regular users see only their own
- Vault items (`vault_items` in SQLite) are encrypted and **not** owner-scoped; the vault is always locked behind a 4–6 digit PIN (per-op, no global unlock state)

### Auth Bypass Rules

- `GET /api/session` — React SPA checks this to determine if user is logged in
- Route-level: `/api/*` and `/ws/*` paths bypass the `requireAuth` middleware (the React SPA handles 401 responses client-side)
- If `AUTH_PASSWORD` is empty, auth is completely disabled

### CSRF Protection

- Each session gets a CSRF token (`crypto.randomBytes(32)`) on first request
- Token sent to client via `res.locals.csrfToken` and in EJS templates
- React SPA includes it in `x-csrf-token` header on all POST requests
- Server validates: token from header/body must match session token
- GET/HEAD/OPTIONS requests are exempt

---

## WebSocket Terminal

The terminal is the agent page's one interactive shell: a **persistent tmux
session** inside the PAD container, attached over a real Docker PTY and shown
with xterm.js. Sessions survive page reloads, mode switches, and webui
restarts; only stopping the PAD kills them. See [`tabs/terminal.md`](../tabs/terminal.md) for the
full write-up.

### Connection Flow

1. Client opens WebSocket to `/ws/terminal/:name?session=<id>&cols=&rows=` (`session` optional → `main`)
2. Server resolves the session cookie and requires a valid authenticated session (admin, or owner of the PAD) **before** any Docker inspection or exec — skipped only when `AUTO_LOGIN=true`
3. `ensureTmuxSession()` — idempotent per connect: lazy tmux install on old images (`apt-get install -y tmux`, cached in a `tmuxReady` set), run the session with `bash` when the image has it (falls back to the default shell), hook colored PS1 into `/root/.bashrc`, write `/root/.tmux.conf` (`smcup@:rmcup@` so output accumulates on the normal screen), create the session if missing (`tmux new-session -d`), bump `history-limit` to 10000
4. Attach via dockerode: `container.exec({ Tty: true, Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'], Cmd: ['tmux', 'attach-session', '-t', <id>] })` → `exec.start({ hijack: true })`. Docker allocates a **real PTY**
5. Fresh connections first replay the pane history (`tmux capture-pane -t <session> -p -e -S -10000`, LF → CRLF) so scrollback survives refresh
6. Two-way piping:
   - Client → Server: raw keystroke bytes; resize arrives as a double-NUL-framed JSON control frame (`\x00\x00{type:'resize',cols,rows}`) — no `JSON.parse` on keystrokes
   - Server → Client: demuxed PTY output (`dockerClient.modem.demuxStream`), UTF-8 decoded via `StringDecoder`

### Non-PTY quirk (solved by the real PTY)

The old implementation ran `docker exec -i <name> sh` without a PTY, so there
was no terminal line discipline to convert `\r` to `\n` — xterm.js sends `\r`
on Enter and the shell hung. The dockerode PTY + tmux path has no such issue:
no `\r` → `\n` conversion is performed anywhere.

### Sessions & single-client policy

- Each terminal session = one tmux session in the container. `GET/DELETE
  /api/agents/:name/terminal-sessions[/:id]` lists, switches, creates, and
  kills them; names validate against `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$`
- Selection persists per agent in `localStorage` (`pad-term-session-<name>`)
- Exactly **one attached client per session**: the newest connection wins,
  older ones are kicked with close code 4001; `sweepStaleAttaches()` runs on
  connect and close so orphaned `tmux attach-session` processes never pile up
- Command log: `POST /api/agents/:name/command-log` `{ cmd, status, ts }` powers
  the Activity tab

### Docked layout & CommandsPane

- The dock is **always mounted** on the agent page, one per agent, at the
  bottom of every mode. Commands is the default landing mode and takes the full
  remaining height; other modes auto-collapse the dock to its header (session
  stays alive). A drag handle resizes it and a header button fullscreens it.
- Command pills in CommandsPane inject CLI commands into the terminal via
  `run(cmd)` — **buttons paste commands, not APIs** (the Vault dropdown is the
  deliberate exception; secrets live server-side). Tracked commands append a
  `__PAD_DONE_<id>__` sentinel so `onCommandDone` fires when the command
  actually finishes.

---

## Web Publishing

Agents whose driver carries a `webApp` descriptor can publish their built-in
web app on a host port. See [`tabs/web.md`](../tabs/web.md) for the full write-up and per-driver
auth.

### Publish flow (`POST /api/agents/:name/web`)

1. Validate: `containerPort`/`hostPort` 1–65535; host port must not collide
   with the agent's ssh port (`meta.env` `PORT`) or any other agent's published
   port (`hostPortInUse()` scans instance compose files + live `docker ps`)
2. 202 + SSE job (`update:<name>`, streamed into the Console popup):
   - stop if running (`logStore.capture` first),
   - write the boot hook `<dataDir>/start-web.sh` (removed when deactivating),
   - `vm.applyWebServices(name, webService)` — writes `web.json`, regenerates
     the compose with the `ports:` binding (or the socat door in peer mode),
   - `docker compose up -d --no-deps --force-recreate` (+ the door service in
     peer mode),
   - exec the boot hook inside the container so the server is up immediately,
   - poll the container port until it answers (fail → rollback),
   - `recordActivity(name, 'web', 'publish'|'unpublish', 'ok'|'error', …)`
3. On failure: restore old `web.json` + hook + compose, remove the door,
   start the container again

### The boot hook (why the service survives recreates)

`--force-recreate` kills the container; only what the image entrypoint starts
comes back. opencode's entrypoint is `tail -f /dev/null`, so a manually-started
`opencode web` would be lost. The webui writes `start-web.sh` into the bind
mount and the image `start.sh` sources it when present — so the web app
auto-restarts on **every** recreate (Settings toggle, Update, network-fix
recreate, host reboot).

### The socat door (network peer case)

Agents with `network_mode: container:<peer>` can't publish host ports (Docker
refuses) and the peer's firewall may drop host-LAN inbound. A **door service**
(`<name>-web`, alpine/socat) joins the peer's docker bridge, publishes the host
port on its own, and forwards to the peer **by name** per connection — survives
peer recreates with no changes of its own. `getPeerNetworkName(peer)` inspects
the peer's `NetworkSettings.Networks`; a peer on `network_mode: host` gets a
host-mode door forwarding to `127.0.0.1:<containerPort>`. Unpublish/rollback:
`docker rm -f <name>-web` after the compose is regenerated without the door.

### Network switch keeps the binding

`vm.applySettings()` is async and reads the active `web.json` itself,
regenerating the compose with `webService` + the resolved `webPeerNetwork` for
the NEW network — it never drops a published web app on a network or
docker-toggle change. The settings route re-applies the binding: force-recreates
the door on a network change, drops it when leaving peer mode (BEFORE the agent
recreate, so the new `ports:` bind doesn't hit "port already allocated"),
re-execs the boot hook, and re-verifies the server.


---

## MCP Server Management

### List Flow

1. Read the agent's config file (`driver.configFile` — e.g. `openclaw.json`)
2. Extract `mcp.servers` block
3. For each server, map to enhanced object with name, enabled, transport, command/args/url, status, issues
4. Return to frontend

### Add Flow

1. Build `openclaw mcp add --no-probe <name>` command
2. For stdio: append `--command <cmd> --arg <a> --arg <b> [--cwd <dir>]`
3. For HTTP: append `--url <url> --transport streamable-http`
4. Run via `docker exec` inside the container

### Probe Flow

1. Run `openclaw mcp probe <name> --json` inside container
2. Parse JSON output for tools, diagnostics, status
3. Return to frontend for display in modal

---

## Paddock MCP Server Auth (API Keys)

The paddock's own MCP server (`/mcp`, mounted in `app.js` via
`require('./mcp').mountMcp(app)`) is **closed by default** — it requires a
per-user bearer API key. No cookie sessions (MCP clients like opencode/Claude
Code don't do cookies).

### Auth flow

1. Client sends `Authorization: Bearer pk_live_…` (also accepts `x-api-key`
   header or `?token=` for simple clients).
2. `apiKeys.authenticate(token)` regex-validates the `pk_live_` shape, sha256s
   it, looks up `api_keys.key_hash`. Missing or revoked → 401 JSON-RPC error.
3. On success: `last_used_at` touched (throttled to 1/min), identity set as
   `{ userId, role, scopes }`, tools run in an AsyncLocalStorage context.
4. Tools reuse the REST ownership rule: admin → all agents, user → owned
   agents only (`owner_id` match). A non-admin key gets a 403-style tool error
   on agents it doesn't own.

### Key lifecycle

- **Create** — Profile page "API Keys" card (or `POST /api/profile/keys`).
  Raw key shown exactly once, with copy-ready opencode/Claude Code configs.
- **List** — prefix + name + created + last used + revoked; never the raw key
  or hash.
- **Revoke** — `DELETE /api/profile/keys/:id` (owner-scoped). Instant: the
  hash lookup fails on the next `/mcp` request.

### Security properties

- Only `sha256(key)` + a display prefix are stored — a leaked DB doesn't leak
  usable keys.
- Revocation is instant (hard delete).
- A short PIN-style secret is not involved here; keys are 192-bit random —
  unbruteable.

---

## Skills Management

### List Flow

1. Run `openclaw skills list --json` and `openclaw skills check --json` inside the container
2. Merge results into `{ skills[], check }` response
3. Cache for 30 seconds (per agent)

### Install Flow

1. Based on source type:
   - ClawHub: `openclaw skills install @owner/slug`
   - Git: `openclaw skills install git:owner/repo`
   - Local: `openclaw skills install ./path`
2. Optional flags: `--as <name>`, `--force`
3. Run via `docker exec`
4. Invalidate skills cache

### Remove Flow

There's no `openclaw skills uninstall` command. Removal is filesystem-based:
```bash
rm -rf /root/.openclaw/workspace/skills/<slug>
```

---

## Exec-Stream (Health Tab)

The Health tab uses Server-Sent Events (EventSource) to stream command output:

1. Client opens `GET /api/agents/:name/exec-stream?cmd=<encoded>`
2. Server spawns `docker exec <name> sh -c <cmd>` with pipe
3. Output is streamed as JSON lines:
   - `{ type: "stdout", text: "..." }`
   - `{ type: "stderr", text: "..." }`
   - `{ type: "close", code: 0 }` — command finished
   - `{ type: "error", text: "..." }` — connection failed

---

## Config Management

### Read

1. Read `instances/<name>/<agent>/<driver.configFile>` from disk (e.g. `openclaw.json`)
2. Deep-clone the config object
3. Redact sensitive fields:
   - `api_keys` → `[REDACTED]`
   - `channels.telegram.botToken` → `[REDACTED]`
   - `plugins.*.key` → `[REDACTED]`
4. Return redacted config to frontend

### Save (Preserve Secrets)

When the user edits and saves the config via the Config tab:

1. Parse the submitted JSON
2. Read the current raw config from disk
3. Check which redacted fields in the submitted config still show `[REDACTED]`
4. Replace `[REDACTED]` values with the actual values from disk
5. Write the merged config back to disk

This ensures saving the config doesn't accidentally wipe out secrets that were only displayed as `[REDACTED]`.

---

## OAuth Login for Models

The OAuth flow for model providers (OpenAI, Google, GitHub Copilot) uses a device-code flow:

1. Spawn `docker exec <name> script -q -c "openclaw models auth login --provider <p> --device-code" /dev/null`
2. Capture stdout, look for `URL:` and `Code:` patterns
3. Return the URL and code to the frontend
4. Frontend opens the URL in a new tab, the user completes auth there
5. Frontend polls `GET /api/agents/:name/models/oauth-status?provider=<p>` every 2 seconds
6. When the session process exits, check if the provider is now in the configured providers list
7. If yes → auth complete. If no → expired.

The spawned process is tracked in an in-memory map (`oauthProcesses`) and can be cancelled by the frontend.
