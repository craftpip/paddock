# Business Logic

> Last updated: 2026-08-15

## PAD Discovery and State

### Discovery Flow

1. **Filesystem scan**: Read all directories under `instances/` that match the `CONTAINER_PREFIX-*` pattern (e.g. `pad-*`)
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
PORT=<ssh-host-port>
SSH_CPORT=<ssh-container-port>     # only when != 22
NETWORK=<peer-container>           # only when a network override is set
DOCKER=1                           # only when docker access is enabled
WORKSPACE_HOST=...                 # custom workspace bind (plan 24), when set
WORKSPACE_DIR=...
EXTRA_PORTS=[{"host":8080,"container":8080}]   # JSON array, when set
EXTRA_VOLUMES=[{"host":"/mnt/data","container":"/data","readonly":false},{"type":"volume","name":"mempalace-data","container":"/data","readonly":false,"external":"mempalace_mempalace-data"}]   # JSON array (binds + named volumes), when set
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

1. **Validation**: Check agent name doesn't already exist (filesystem + meta.env); validate custom workspace mount, network target, extra ports/volumes up front (400 on failure, nothing is created)
2. **Port assignment** (SSH): Find first unused host port starting from 43817 (`autoSshPort`), plus a distinct container port (`SSH_CPORT`, default 22) for peer-shared agents
3. **Directory setup**: Create `instances/<name>/<agent>/` directory
4. **meta.env**: Write `ROOT_PASSWORD`, `AGENT`, `PORT`, `SSH_CPORT`, `NETWORK`, `DOCKER`, `WORKSPACE_*`, `EXTRA_PORTS`, `EXTRA_VOLUMES` as set
5. **Seed build dir**: Copy the shared template `src/vm-builds/<type>/` → `instances/<name>/build/` (Dockerfile + start.sh + extras; idempotent, never overwrites existing build files) — each PAD now owns its image source
6. **Compose file**: Generate `docker-compose.yml` with absolute host paths (fixes bind-mount split-brain), `build.context: instances/<name>/build`, `image: paddock-vm-<name>:latest`, and a generated `build.args:` block from the Dockerfile's `ARG` lines
7. **Container start**: `docker compose --env-file <build-dir>/build.env -f <compose> up -d`
8. **Workspace setup**: For OpenClaw/PicoClaw agents, run `openclaw setup --baseline` inside the container (retry up to 15 times with 1s delay)
9. **Restart**: Restart container after setup

Clone-from-backup mode was **removed** with the generic backup system — creation is always fresh.

### Start / Stop / Restart

- **Start**: `docker start <name>` (falls back to `docker compose up -d` if the container doesn't exist anymore)
- **Stop**: `docker compose -f <compose> stop`
- **Restart**: Calls stop then start

The Paddock buttons also start/stop the socat door **with** the agent
(`startDoors`/`stopDoors`) so a stopped agent doesn't leave a dead open listener.
CLI `docker stop` from the host stops just the agent; the door keeps running.
The frontend polls agent state — no HTMX.

### Deletion Flow (`removeVm`)

1. `docker rm -f <name>`
2. `docker rm -f <name>-door` (and the legacy `<name>-web`) — frees the host ports
3. `docker network rm <name>_default` (error-swallowed) — frees the compose subnet
4. `rm -rf instances/<name>/` (recursive delete, via `removeInstanceDir`)
5. `registry.removeAgentFromDb(name)` — deletes the `agents` row plus its activity/sessions rows

**Instance data ownership:** the webui container runs as **root** (it needs
root control of the host filesystem and the docker socket to manage PADs), so
wipes and config reads/writes always work — `removeInstanceDir` is a plain
`fs.rmSync(instDir, { recursive: true, force: true })`, no helper container and
no `EACCES`. Everything the webui *creates* for the user (`instances/<pad>/`,
`meta.env`, `docker-compose.yml`, `web.json`, `logs/`, `src/data/app.db*`) is
explicitly `chown`ed back to `PUID:PGID` (`ownership.ensureOwned`, see
[backend/services.md](../backend/services.md)). Historical root-owned data
self-heals: a background boot sweep runs `normalizeTree` over `instances/` +
`src/data/`, replacing the old manual `chown -R node:node instances/` runbook.
Agent containers still run as root and write root-owned files mid-run; the
sweep re-normalizes them at every webui boot. The one exception is **hermes**:
its gateway drops to uid 10000 and re-`chown`s `/opt/data` on every boot, so
`normalizeTree` skips hermes data dirs (`isSelfManagedAgentData`).

**Per-PAD "Container user" (plan 43 Phase 7):** the sweep only *fixes* legacy
root-owned files — it cannot keep up with a process that still runs as root.
For new correctness, pads can opt into **user mode** (`USER_MODE=user`), where
the agent daemon *and* the web terminal run as the `pad` user (`PUID:PGID`,
1000:1000) so every file the agent writes is user-owned **by construction**,
in any folder (data dir, default or custom plan-24 workspace). The container
keeps its root boot (chpasswd, sshd, `start-web.sh` hooks) and the daemon
drops via `setpriv`/`su` (`start.sh` user branch re-`chown -R 1000:1000` the
data dir first, so workspace dirs the root boot recreated stay writable);
SSH stays the root admin door. This is the same shared foundation plan 41's
non-root dev containers ride on. See [backend/services.md](../backend/services.md)
and [tabs/settings.md](../tabs/settings.md) for the plumbing and the toggle.

**Image cleanup:** each PAD builds its own `paddock-vm-<name>:latest` tag.
Deleting a PAD also runs `docker rmi paddock-vm-<name>:latest`. Every image
build or rebuild orphans the previous build as a dangling `<none>` image, so
`pruneDanglingImages` (`docker image prune -f`) runs at the end of create,
rebuild (`updateAgent`/`recreateAgent`) and delete — it only touches `<none>`
layers no container references, so it can never break a running agent.

### Reset Flow (`resetVm`)

1. `docker rm -f <name>`
2. Delete agent data directory (not meta.env)
3. Re-create empty data directory
4. Regenerate compose file
5. `docker compose up -d`

Reset preserves the **complete persisted binding set** — docker, network peer,
published web app (+ door), custom workspace, and extra volumes/ports are all
read back from `meta.env`/`web.json` when the compose is regenerated, so a
reset never silently drops a bind.

---

## Per-Instance Build Model

Every PAD is fully self-contained: its build files live inside its own
instance folder and it builds its own image tag. Nothing is shared between
PADs of the same agent type anymore — rebuilding one PAD never touches
another.

### Build folder layout

```
instances/<name>/build/
├── Dockerfile      # copied from src/vm-builds/<type>/ — fully editable
├── start.sh        # copied — the container entrypoint (when the type has one)
├── build.env       # optional K=V build-arg overrides; machine-generated by
│                   #   toggles, hand-editable too. # comments allowed.
└── extras/         # optional drop-in assets (scripts, debs, configs), COPY'd
                    #   by the Dockerfile template when present
```

`src/vm-builds/<type>/` is the template source only: `seedBuildDir()` copies
it into `instances/<name>/build/` at create, clone, and migration time. After
that the instance build dir is the single source of truth for that PAD's
image.

### Self-describing build args

The compose `build.args:` block is generated from the instance's own
Dockerfile: `argsFromDockerfile()` emits one arg per `ARG <NAME>` line, and
values come from the instance `build.env`. Every per-instance compose
invocation passes that env-file (`docker compose --env-file
instances/<name>/build/build.env -f <compose> ...`). Editing an ARG value in
`build.env` takes effect on the next rebuild with zero compose regeneration;
adding or removing an ARG in the Dockerfile is picked up whenever the compose
is regenerated (create, settings, web publish, and reset all funnel through
`generateInstanceCompose()`).

### Dockerfile conventions

Each template is a set of marked sections (`# ---- N. NAME ----` banners)
that you can add, delete, or uncomment. Feature toggles are ARGs with sane
defaults (`INSTALL_DOCKER=0`, `INSTALL_TMUX=1`), overridable per instance in
`build.env`. The `extras/` block is a drop-in folder: drop a file in
`extras/` and reference it from the Dockerfile, or delete the block to drop
the convention. `start.sh` stays a separate copied file (runtime entry logic
stays out of the Dockerfile), including the web-hook sourcing block.

### Image tag and migration

`imageFor(name)` derives the stable tag `paddock-vm-<name>:latest`, used
consistently by drivers, vm-manager, and app.js. Existing PADs are migrated
by `ensureInstanceBuilds()` (webui boot + `GET /api/admin/migrate-builds`):
it seeds the build dir, retags the old shared `paddock-vm-<type>:latest`
image, regenerates the compose, and force-recreates running containers.
Function reference: [`backend/services.md`](../backend/services.md) — VM
Manager and Instance Image & Build Files.

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

## Workspace as Project

The folder the user picks as an agent's workspace **is the project** — this
holds uniformly for every agent type (personal, developer, or anything else);
there is no personal-vs-developer bifurcation. When that folder contains a
`docker-compose.yml`/`compose.yml`, the Create Agent form reads the project's
volumes and **pre-fills** the Additional volumes rows for review/edit/delete
(plan 40). The pre-fill is a convenience, never a forced value.

### Visibility: one-to-one mounts

A project folder must be bind-mounted into paddock **at the same path it has
on the host** (one-to-one) — only then can the webui probe it, read its
compose file, and trust "exists in the container" ≈ "valid host source for the
daemon". This is a one-time manual step in `docker-compose.yml` (e.g.
`- /www2:/www2:ro`) + a webui recreate; no registry or env var is involved —
the mount itself is the source of truth. A `:ro` mount is readable for probing
but the webui cannot create new folders inside it. The path must not collide
with paddock's own mounts (`/app`, `/workspace`) or system dirs
(`GUARD_SYSTEM_DIRS`).

### Discovery order (compose first, container supplement)

`discoverVolumes()` (`services/path-probe.js`) reads the workspace folder's
compose file via `docker compose config --format json` (the compose CLI lives
in paddock — `${VAR}`, `.env`, `extends`, and override files resolve like the
real deploy), then supplements with `docker inspect` mounts from the project's
containers that the file did not already cover — so `docker run`-only mounts
surface too, and stopped projects still work (mounts are stored config). Only
compose files can serve never-started projects (no container object exists).
Named volumes are annotated with their full Docker volume name (`external`)
and whether it exists right now. Reference: `backend/services.md` — Path Probe.

### Security filters (D6)

`/var/run/docker.sock`, system-dir sources, anonymous volumes, and `tmpfs`
mounts are never inherited into an agent container. The raw compose file is
never served — the discovery endpoint returns the volume list only, because
compose files can contain secrets.

### Generated compose shape (D5)

Each inherited named volume becomes a service mount plus a top-level
`volumes:` entry: `external: true` when the volume exists (attach the
project's real data), a fresh-volume declaration when it does not (so
never-started projects get a working volume on first up).

**Dev-environment rule for binds:** inherited bind mounts are **one-to-one** —
the container path is set to the host source path (`/www1/navigator` →
`/www1/navigator`, not the compose's own destination). The agent container
mirrors the host filesystem layout, so you never type a separate container
path. Only named volumes keep their compose destination.

### Behavioral note — persona bootstrap

openclaw `setup --baseline` (and the other setups) bootstrap persona files
into the workspace (`BOOTSTRAP.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md`,
`USER.md`, `IDENTITY.md`, `openclaw-workspace-state.json`). For a
project-as-workspace agent these land in the user's real project folder —
expected, not a bug: the project is the agent's home.

---

## Auth and Session

Full user management and owner-based scoping docs: [`backend/user-management.md`](../backend/user-management.md).

### Session-Based Auth

- Sessions use `express-session` with a random `SESSION_SECRET` (auto-generated if not set)
- Session cookie name: `vmf.sid`
- Cookie config: `httpOnly: true`, `sameSite: 'lax'`, `maxAge: 24 hours`
- Login: validate username + password against `users` table, set `session.authenticated`, `session.userId`, and `session.role`
- Logout: destroy session, redirect to `/login`
- Session store is **in-memory** (`MemoryStore`) — a webui restart wipes sessions (the `ensureAutoLogin` middleware re-establishes the admin session on the next request when `AUTO_LOGIN=true`)

### Multi-User Model

- `users` table stores credentials and roles (`admin` / `user`)
- On first startup, `admin`/`admin` is seeded automatically
- Admin creates all users (no public registration)
- Every resource (agents) has an `owner_id` referencing `users(id)`
- Admin sees all resources; regular users see only their own
- Vault items (`vault_items` in SQLite) are encrypted and **not** owner-scoped; the vault is always locked behind a 4–6 digit PIN (per-op, no global unlock state)

### Auth Bypass Rules

- `GET /api/session` — React SPA checks this to determine if user is logged in
- `AUTO_LOGIN=true` (default) — an `ensureAutoLogin` middleware logs every request in as the first admin, and the auth gate is skipped entirely. Set it to anything else to enable real login
- With real auth, `/api/*` and `/ws/*` requests from unauthenticated sessions get a 401 JSON (the React SPA handles it client-side); page loads redirect to `/login`

### CSRF Protection

- Each session gets a CSRF token (`crypto.randomBytes(32)`) on first request
- Token set on `req.session.csrfToken` and exposed via `/api/session`
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

**User-mode pads (plan 43 Phase 7):** a pad with `USER_MODE=user` runs the
whole terminal stack as the `pad` user. Every tmux/exec `docker exec` gains
`-u <USER_UID>:<USER_GID> -e HOME=/root` (`termUserArgs` in app.js), and the
dockerode attach exec sets `User: <uid>:<gid>` + `Env: ['HOME=/root', …]`.
The tmux socket therefore lives at `/tmp/tmux-1000` (matching the pad-user
session created by the boot flow), the shell runs as uid 1000, and files typed
in the terminal are user-owned on the host. Root-mode pads are untouched
(socket `/tmp/tmux-0`). The PS1 hook stays a root-written `/root/.bashrc`
entry (root-owned config), read by the pad-user shell through the chmod'd-755
`/root`; a HISTFILE guard silences the unwritable `.bash_history` warning.
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
refuses) and the peer's firewall may drop host-LAN inbound. A **door container**
(`<name>-door`, alpine/socat) joins the peer's docker bridge, publishes the host
ports on its own, and forwards to the peer **by name** per connection — survives
peer recreates with no changes of its own. The door carries **all** of the
agent's host bindings in peer mode: the published web app, SSH, and any extra
ports (one `TCP-LISTEN:<hostPort>,fork,reuseaddr TCP:<peer>:<containerPort>`
process per mapping). `getPeerNetworkName(peer)` inspects the peer's
`NetworkSettings.Networks`; a peer on `network_mode: host` gets a host-mode door
forwarding to `127.0.0.1:<containerPort>`. Unpublish/rollback:
`docker rm -f <name>-door` after the compose is regenerated without the door.

### Network switch keeps the binding

`vm.applySettings()` is async and reads the active `web.json` itself,
regenerating the compose with `webService` + the resolved `webPeerNetwork` for
the NEW network — it never drops a published web app on a network or
docker-toggle change. The settings route re-applies the binding: force-recreates
the door on a network change, drops it when leaving peer mode (BEFORE the agent
recreate, so the new `ports:` bind doesn't hit "port already allocated"),
re-execs the boot hook, and re-verifies the server.

### Ownership model: root control, user-owned files

The webui container runs as **root** — it needs root-level control of the host
filesystem (bind-mounted `/workspace`) and the docker socket to manage PADs.
So it can always read/write agent data and always wipe it. Because a root
process creates root-owned files by default, everything the webui writes on the
user's behalf is chown-on-created back to `PUID:PGID`
(`src/services/ownership.js`: `ensureOwned` after every create site). A boot
sweep (`normalizeTree` over `src/data/` and `instances/`) heals historical
root-owned data; hermes data dirs are skipped because hermes manages its own
ownership (uid 10000). `web.json` still persists the openclaw gateway token so
`readWebAuth` never has to read the config on the hot path, but that is now a
consistency choice, not an access workaround.


---

## MCP Server Management

MCP servers for an agent are managed in the **Commands pane** — chips show each
server's status (ok/error/configured) via a read-only GET, and every action
**pastes an `openclaw mcp …` command into the docked terminal** (`run(cmd)`):

- **Add**: `openclaw mcp add <name> [--no-probe] --url <u> --transport <t>` (HTTP) or `openclaw mcp add <name> --command <c>` (stdio). The add form has a "Test MCP connection" checkbox (default on = probe runs; unchecked appends `--no-probe`)
- **Probe**: `openclaw mcp probe <name> --json` → tool list + diagnostics modal
- **Remove**: `openclaw mcp unset <name>`

The old backend action routes (`POST /api/agents/:name/mcp/add`, …) still exist
in app.js but the frontend does **not** use them — they bypass the visible
terminal and are a trap. Read-only GETs (server chips) stay API-backed.

### The paddock's own `/mcp` server

Separate from per-agent MCP servers: the webui itself exposes 19 tools over
`/mcp` (Streamable HTTP) so opencode/Claude Code can manage the fleet. Bearer
API keys per user; tools reuse the REST ownership rule. See
`backend/services.md` — API Keys and the section below.

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

Skills are managed in the **Commands pane** the same way as MCP: a read-only
`GET /api/agents/:name/skills` lists skills + check state (30s cache), and
actions **paste `openclaw skills …` commands into the docked terminal**:

- **Install**: `openclaw skills install @owner/slug` (ClawHub), `openclaw skills install git:owner/repo` (Git), or `openclaw skills install ./path` (Local); optional `--as <name>` / `--force`
- **Verify**: `openclaw skills verify --json`
- **Update**: `openclaw skills update [--all]`
- **Remove**: there's no `openclaw skills uninstall` — removal is filesystem-based: `rm -rf /root/.openclaw/workspace/skills/<slug>`

The backend action routes (`/api/agents/:name/skills/install`, …) still exist
but the frontend no longer calls them — paste-through-terminal is the rule
(see `tabs/terminal.md` — Command flow).

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
