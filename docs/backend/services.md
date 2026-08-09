# Backend Services

> Last updated: 2026-08-09

## PAD Discovery (agent-registry.js)

Business logic: See `overview/business-logic.md` — PAD Discovery and State.

**Functions:**
- `discoverAgents()` — full scan: instances/ + docker ps + merge + SQLite sync
- `getAgent(name)` — single agent by name (reads docker cache, filesystem)
- `getAgentById(id)` — try name first, then SQLite id lookup
- `dockerPsList(force)` — cached docker ps -a (3s TTL). Returns `{ name: state }` map
- `getAgentStats()` — SQLite query: total, running, exited, unknown
- `recordActivity(agentId, category, action, status, details)` — INSERT into activity_events, update agent's last_activity_at
- `getActivity(agentId, limit)` — SELECT * from activity_events, ordered by timestamp DESC
- `buildAgent(vmName, dockerState)` — construct agent object from filesystem metadata + docker state

**Agent object shape:**
```
{ id, name, display_name, agent_type, runtime_type, runtime_ref,
  status, workspace_root, config_root, default_model, default_provider,
  tags, created_at, updated_at, last_activity_at }
```

**Regular expression for valid names:**
```
^<PREFIX>-[a-zA-Z0-9][a-zA-Z0-9_-]*$
```

## Workspace (workspace.js)

Business logic: See `overview/business-logic.md` — Workspace File Browser.

All functions take `(agentId, relativePath)` and internally:
1. Look up agent by ID via `getAgent()`
2. Resolve path via `resolveSafePath()` (canonicalize + traversal check)
3. Perform the filesystem operation

**Exported functions:** `listDir`, `readFile`, `writeFile`, `statFile`, `createFolder`, `renameEntry`, `deleteEntry`, `moveEntry`, `getBreadcrumbs`, `isPreviewable`, `getMimeType`, `resolveSafePath`

**Max upload size:** 100MB (via `MAX_UPLOAD_SIZE`)

**Legacy functions (kept for compat):** `listParentDir`, `readParentFile`, `downloadParentFile`, `writeParentFile` — these allow browsing above workspace root. Only used by old EJS routes; the React SPA no longer uses them.

## Path Probe (path-probe.js)

Read-only host-path probes backing the Create Agent workspace-source field
(plan 40). "Exists in the container" ≈ "valid host source for the daemon"
thanks to the one-to-one mount rule — a project folder mounted into paddock at
the same path it has on the host is identical in both namespaces. Business
logic: See `overview/business-logic.md` — Workspace as Project.

**Exports:**
- `probe(hostPath)` — `{ path, exists, isDir, writable, forbidden, compose }`;
  `writable` via `fs.accessSync(W_OK)`, `compose` is the found
  `docker-compose.yml`/`compose.yml` mapped to its host path (null when absent).
- `autocomplete(q)` — the subdirectories of the deepest existing ancestor of
  `q`, hidden-filtered (dot-dirs, system dirs, `/app`/`/workspace`) and mapped
  back to host paths; the client applies prefix filtering.
- `discoverVolumes(hostPath)` — the volume-inheritance model (below).
- `containerPathOf(hostPath)` / `hostPathOf(containerPath)` — the one-to-one
  mapping; only the paddock root (`HOST_WORKSPACE_ROOT` ↔ `WORKSPACE_ROOT`)
  changes, everything else is identity.
- `isForbidden(p)` / `isDangerousSource(src)` — the system-dir + own-mount
  blocklists; `isDangerousSource` additionally rejects `/var/run/docker.sock`
  (D6 — never inherited into an agent container).
- `findComposeFile(dir)` — first of `docker-compose.yml`/`.yaml`,
  `compose.yml`/`.yaml` present in the dir.

**Routes (app.js, read-only GETs, no CSRF):** `GET /api/paths/probe?path=…`,
`GET /api/paths/autocomplete?q=…`, `GET /api/paths/volumes?path=…`.

### discoverVolumes — the model

Compose file first, container supplement second (D2):

1. Run `docker compose --project-directory <dir> -f <compose> config --format
   json` inside paddock (the compose CLI lives there) — never hand-rolled YAML,
   so `${VAR}`, `.env`, `extends`, and override files resolve exactly like the
   real deploy. Parse errors are surfaced in the response `errors` array, not
   thrown.
2. Supplement: `docker ps -a --filter label=com.docker.compose.project=<name>`
   then `docker inspect` each container's `Mounts`; mounts not already covered
   by the compose file are added with `origin: 'container'`. Works for stopped
   containers (mounts are stored config). The project label comes from the
   compose `name`, falling back to the **host** directory name when the
   container view differs — the paddock root maps to `workspace` and would
   otherwise collide with any other project named `workspace`.

Each row is normalized `{ type: 'bind'|'volume', source, target, readonly,
service, origin: 'compose'|'container' }` — deduped (binds by source+target,
named volumes by target). Bind sources are mapped back to host paths. **Dev-
environment rule:** binds pre-fill **one-to-one** — `target` is set to the
host source path, so the agent container sees the same filesystem layout as
the host; the compose's own container destination is ignored for binds (rows
29→24 on `/www1/agents` when this landed — the remapped duplicates collapsed).
Named volumes keep their compose destination and are annotated with `external`
(the full Docker volume name: `<project>_<name>` for file volumes, the
volume's own name for container volumes) and `exists` (whether `docker volume
inspect` finds it now) — so the form can distinguish "attach the project's
real data" from "create a fresh volume".

D6 filters apply everywhere: `/var/run/docker.sock`, anonymous volumes, and
`tmpfs` mounts are dropped; system-dir sources are never inherited. The raw
compose file is never served — the endpoint returns the volume list only
(compose files can contain secrets).

**Returns:** `{ path, project, compose, source, volumes, errors }`.

## VM Manager (vm-manager.js)

Business logic: See `overview/business-logic.md` — Agent Lifecycle, Bind-Mount Split-Brain.

Per-instance build model: every PAD owns its build files (`instances/<name>/build/`)
and its own image tag (`paddock-vm-<name>:latest`). See
`services/instance-image.js` below.

**Functions:**
- `createVm(name, { agent, mode, skipSetup, workspaceHost, workspaceDir, allowDocker, network, sshEnabled, port, sshCport, password, extraVolumes, extraPorts, onLog, onStep })` — full streaming creation flow with SSH host/container port allocation. Emits steps via `onStep('build'|'up'|'setup', 'start'|'end'|'error')` and feeds command output through `onLog(stream, text)`. Seeds the instance build dir from the shared template (`seedBuildDir`). `mode: 'fresh'` only — clone-from-backup was removed with the generic backup system.
- `validateAgentCreate(name, opts)` — the shared create **pre-flight**: name/agent-type, network peer exists+running, extra volumes/ports, SSH container port, workspace mount, and the async cross-agent host-port sweep all abort (throw) before anything is created. Returns `{ sshHostPort, sshCport, wsMount }` normalized for `createVm`.
- `createAgent(name, opts)` — `validateAgentCreate` then `createVm` (mode `fresh`, port/sshCport/workspace normalized). The single create path behind both `POST /api/agents/create` and the MCP `create_agent` tool.
- `removeVm(name)` — `docker rm -f` the agent **and** its door (`<name>-door`/`<name>-web`), remove the compose network (`<name>_default`), delete the instance dir. The instance dir goes through `removeInstanceDir(name, instDir)`: a plain `fs.rmSync` works normally, but on `EACCES`/`EPERM` (root-owned data written by the agent container — the webui runs as uid 1000) it finishes the deletion with a one-shot root helper container built from our own image (the daemon resolves the bind by HOST path, not the webui's `/workspace` namespace). The helper clears the mount's **contents** — `docker run --rm -v <HOST_WORKSPACE>/instances/<name>:/d --entrypoint find paddock-webui:latest /d -mindepth 1 -delete` — never `rm -rf /d`, which fails on the bind mountpoint ("Device or resource busy"); the empty dir is then removed by the webui. If even that fails it throws the exact host `chown -R 1000:1000 <dir>` to run. Delete also runs `docker rmi paddock-vm-<name>:latest` then `pruneDanglingImages`.
- `pruneDanglingImages(onLog)` — `docker image prune -f` (dangling `<none>` layers only, never images a container references). Runs at the end of create, rebuild (`updateAgent`/`recreateAgent`) and delete to reclaim the layers each `docker compose build` orphans when it retags the per-PAD image; reports reclaimed space via `onLog`, never throws.
- `resetVm(name)` — remove container + wipe data + recreate + compose up; the compose regen reads the full persisted binding set from `meta.env`/`web.json` (docker, network, web, extra volumes/ports, workspace) so a reset never drops a bind
- `startAgent(name)` / `stopAgent(name)` / `restartAgent(name)` — docker lifecycle; also start/stop the socat door with the agent (`startDoors`/`stopDoors`)
 - `generateInstanceCompose(name, agent, password, port, { allowDocker, network, sshCport, workspaceHost, workspaceDir, extraVolumes, extraPorts, webService, webPeerNetwork })` — builds the compose as a structured JS object and serializes it with `JSON.stringify(..., null, 2)` (JSON is valid YAML) — never hand-concatenated YAML. `allowDocker` adds the `/var/run/docker.sock` volume, `network` adds `network_mode: container:<name>`, `extraPorts`/`webService`/`sshCport` produce `ports:` bindings (or door mappings in peer mode), `workspaceHost`/`workspaceDir` add a second volume line. Named-volume rows (plan 40 D5) emit their service mount **and** a top-level `volumes:` section — `external: true` when the volume already exists, a fresh-volume declaration otherwise (so never-started projects work on first up). When the pad has a persisted `SUBNET` in `meta.env`, the compose also declares `networks.default` with that explicit subnet (merged alongside any door `webbridge` network) — see the pad subnet pool note below. Builds from `instances/<name>/build` with `image: paddock-vm-<name>:latest`; the `build.args:` block is generated from the instance Dockerfile's `ARG` lines (values interpolated from the instance `build.env`).
 - `writeInstanceCompose(name, agent, password, port, opts)` — write the serialized compose to disk. Calls `ensurePadSubnet(name)` first so a never-started pad is assigned its fixed `/24` (persisted as meta `SUBNET`) before the generator reads it.
 - **Pad subnet pool** — the host daemon's `default-address-pools` are finite (`192.168.0.0/16` at `/20`, plus the stock `172.16.0.0/12`). When every slot is taken, `docker compose up` for a new pad dies with `all predefined address pools have been fully subnetted` — the subnet is unspecified, so the daemon tries to allocate from the pool. New pads sidestep the pools: `ensurePadSubnet` carves the lowest free `/24` from `10.200.0.0/16` (256 pads; disjoint from the pools and the office LAN) and persists it as meta `SUBNET`, and the generated compose declares it explicitly. Existing pads' networks are never touched — when `<name>_default` already exists, `ensurePadSubnet` returns empty and the compose stays subnet-less so a regen can't force a disruptive network recreate. Deleting a pad (`removeVm`) removes `<name>_default` and frees its `/24`.
 - `applySettings(name, { allowDocker, network, sshPort, sshCport, workspaceHost, workspaceDir, extraVolumes, extraPorts, password })` — regenerates compose + writes the changed `meta.env` keys (`DOCKER`, `NETWORK`, `PORT`, `SSH_CPORT`, `ROOT_PASSWORD`, `WORKSPACE_*`, `EXTRA_PORTS`, `EXTRA_VOLUMES`, `SUBNET`); returns the new state. **Async** — reads the active `web.json` binding itself and regenerates with `webService` + the resolved `webPeerNetwork` for the new network, so a network/docker-toggle change never drops a published web app.
- `applyAgentChanges(name, opts, { onLog, onStep })` — the **consolidated mutation flow**: settings POST, web/ports POST, and the MCP `recreate` tool all funnel through it (stop → regen → reconcile door → up → boot hooks → verify → rollback on failure)
- `updateAgent(name, { onLog, onStep })` — streams `docker compose --env-file <instance>/build/build.env -f <compose> build --pull <name>` (900s) then `up -d --no-deps --force-recreate <name>` (300s); steps `build`/`recreate`. No forced build args — the image is per-PAD, so the rebuild reads the instance Dockerfile + `build.env` directly.
- `readSettings(name)` — the full settings + published-web + ports picture shared by `GET /api/agents/:name/settings` and the MCP `settings_get` tool (`{ allowDocker, network, sshPort, sshContainerPort, image, version, networkHealth, workspaceMount, extraVolumes, extraPorts, web }`)
- `containerInfo(name)` — live `docker inspect` detail for the Container Info popup (mounts, published ports, env keys, raw JSON)
- `readWebService(name)` / `webServicePath(name)` — read/`web.json` path (per-agent published web binding `{ containerPort, hostPort }`; null when absent)
- `applyWebServices(name, webService)` — **async**. Set (truthy) or clear (`null`) the published web app: writes `web.json`, regenerates the compose with the `ports:` binding — or the socat door service when the agent routes through a network peer (see `tabs/web.md`). Returns `{ agent, webService }`. Does NOT stop/recreate — the route does that as an SSE job.
- `doorName(name)` — `<name>-door`, the socat door container name; `doorNameRe(name)` matches both `<name>-door` and the legacy `<name>-web`. `startDoors(name)`/`stopDoors(name)` start/stop it with the agent; `cleanOrphanDoors()` sweeps `<x>-door`/`<x>-web` containers whose agent is gone (runs at boot)
- `webHookPath(name, agent)` / `writeWebStartHook` / `removeWebStartHook` — the
  per-instance boot hook at `<dataDir>/start-web.sh`, executed with `bash` by
  the image `start.sh` so its port-guard cannot exit the parent start script.
  `buildWebHook` starts web servers through `tee`: output remains in
  `<dataDir>/web.log` and is also written to `/proc/1/fd/1` for `docker logs`
  and the Logs tab.
- `getNetworkHealth(name)` — resolves the compose `network_mode: container:<peer>` against live docker state → `none` / `ok` / `stale` (peer recreated, recorded ID dead) / `peer-stopped`
- `validateWorkspaceMount(name, agent, host, dir)` — the single authority for custom workspace binds (plan 24); returns `{ host, container, webuiVisible, hostBrowsable }` or throws
- `autoSshPort()` — next free host port starting at 43817 (scans web/extra/ssh host ports)
- `readSshCport(name)` — persisted SSH container port (meta `SSH_CPORT`, default `22`); `ensureSshStartBlock(name)` — backfills the `SSH_PORT` block into an old instance's own `build/start.sh` (idempotent)
- `readExtraPorts(name)` / `readExtraVolumes(name)` / `validateExtraPorts(...)` / `validateExtraVolumes(...)` — extra TCP port + volume management (plan 28). Extra volumes are `{ host, container, readonly }` binds or `{ type: 'volume', name, container, readonly, external }` named-volume entries (plan 40 D5)
- `setMetaFlag(name, key, value)` — writes/clears a `KEY=VALUE` line in `meta.env` preserving other lines (empty value **removes** the line)
- `seedBuildDir(name, agent, { installDocker })` — idempotently copies `src/vm-builds/<type>/` → `instances/<name>/build/`, seeds `extras/.gitkeep` + `build.env`; never overwrites existing build files
- `composeCommand(name, ...args)` — `docker compose --env-file <instance>/build/build.env -f <compose> ...` prefix used by every per-instance compose invocation (skips the env-file when the build dir is missing)
- `validateInstanceCompose(name)` — pre-flight gate: runs `docker compose ... config --quiet` (parse + schema + interpolation, no side effects) and throws with the parser output on failure. Call **before** stopping/recreating a PAD so a malformed document aborts with the container still running.
- `runCompose(name, args, opts)` — validates via `validateInstanceCompose` then runs the compose `build`/`up` command. Every per-instance compose action goes through it (or an explicit early `validateInstanceCompose` in the settings/ports/web/recreate routes), so a bad document never reaches `docker compose up`.
- `ensureInstanceBuilds()` — one-time migration: seeds build dirs, retags `paddock-vm-<type>:latest` → `paddock-vm-<name>:latest`, regenerates compose + force-recreates running containers. Idempotent; runs on webui boot and via `GET /api/admin/migrate-builds`.
- `setBuildEnv(name, kv)` / `readBuildEnv(name)` — read/write `instances/<name>/build/build.env` (K=V, `#` comments preserved)
- `existingServices()` — scan instances/ for existing compose files
- `instanceComposePath(name)`, `getComposePath(name)` — path helpers

## Instance Image & Build Files (services/instance-image.js)

Small dependency-free module (drivers, vm-manager and app.js all derive the same
tags/paths from it). No vm-manager/drivers imports — safe to require anywhere.

**Exports:**
- `imageFor(name)` — `paddock-vm-<name>:latest` (stable per-instance tag)
- `legacySharedImage(agent)` — `paddock-vm-<type>:latest` (migration retag source)
- `buildDir(name)` — `instances/<name>/build`
- `buildEnvPath(name)` — `instances/<name>/build/build.env`
- `readBuildEnv(name)` / `setBuildEnv(name, kv)` — parse / update the env file
  (preserves comments + other keys)
- `argsFromDockerfile(path)` — extract `ARG NAME[=default]` lines (commented
  ARGs skipped) → feeds the generated compose `build.args:` block

Image/tag/version lookups no longer live here — they go through
`getDriver(agent)` from `services/drivers/` (see below).

## Driver Registry (services/drivers/)

One module per agent type — `openclaw.js`, `opencode.js`, `picoclaw.js`,
`hermes.js`, `codex.js`, `claude.js` — registered in `index.js`. Every type is
an equal citizen. The per-driver field values, command groups, and gotchas
live in [drivers.md](drivers.md); this section documents the registry and the
interface.

**Functions:**
- `getDriver(type)` — returns the driver for a type, **falls back to the
  openclaw driver** when a type has none (never crashes callers)
- `listDrivers()` — `[{ type, label, setupSteps }]` for the CreateAgent select
- `drivers` — the raw registry object

**Driver fields:**
| Field | Purpose |
|-------|---------|
| `type` / `label` | agent type id + human label |
| `templateDir` | shared build template path (`../../src/vm-builds/<type>`) — the create-time copy source (the per-instance copy lives at `instances/<name>/build/`) |
| `baseImage` | upstream image the Dockerfile starts from |
| `dataDir` | in-container data directory (`/root/.openclaw`, `/root/.picoclaw`, `/opt/data`, …) |
| `workspaceDir` | workspace root inside the container (hermes: the data dir itself) |
| `configFile` / `configFormat` | config filename in `dataDir` + format (`json` for openclaw/picoclaw/opencode, `yaml` for hermes, `toml` for codex). Non-`json` = config served/written verbatim, no secret redaction |
| `setupSteps` | commands run right after `compose up` during create (empty for codex) |
| `backupTypeMarker` | filename sniff for backup-type detection (generic backups are removed; kept for plan 26) |
| `webApp` | built-in web app descriptor (`label`, `docs`, `containerPort`, `auth`, `startCommand`) — only opencode has one today |
| `startWebCommand` | shell command to (re)start the web app in the container |
| `currentVersion(name)` | live version inside the container (regex-parsed; picoclaw prints a heavy ANSI banner) |
| `availableVersion()` | upstream available version (cached 5 min; empty where inapplicable) |
| `commands` | Command groups (Status/Auth/Cron/Skills/Other) for the CommandsPane |

Per-instance image tags (`paddock-vm-<name>:latest`) come from
`instance-image.imageFor(name)` — drivers no longer hardcode `buildImage`;
`currentVersion` falls back to reading the version from `imageFor(name)` when
the container is down.

Config GET/POST, agent-registry model extraction, and workspace/config root
resolution all derive paths from `driver.configFile` / `driver.workspaceDir` /
`driver.dataDir` — nothing is hardcoded to openclaw anymore.

## Command Runner (cmd.js)

- `runCmd(cmd, args, options)` — `execFile`-based, returns the full combined output string (no streaming)
- `runCmdStream(cmd, args, { onLog, timeout })` — `spawn`-based; feeds every stdout/stderr chunk through `onLog(stream, text)` so long operations can stream live. Used by create (`build`/`up`/`setup`) and backup restore.

## Container Health (container-health.js)

Generic Docker-level container health checkup. **No agent/driver knowledge** — it diffs the *declared* compose settings (`docker compose -f instances/<name>/docker-compose.yml config --format json`) against the *actual* container (`docker inspect`) and reports what's out of line. Works on stopped containers (inspect + compose file both work while down) so it reports *why* a container stopped.

Each check: `{ key, label, status: 'ok'|'warn'|'error', expected, actual, hint }`. No auto-fix — failing rows carry a hint (usually "Recreate to fix").

**Functions:**
- `checkContainerHealth(name, onCheck?)` — runs all checks. With `onCheck`, each check is streamed as produced (health-check job); without, the full report is returned at once. Returns `{ name, status, checks, counts }` via `summarize(name, checks)`.
- `summarize(name, checks)` — tallies counts, derives `status` (`error` if any, else `warn` if any, else `ok`).

**Checks (11):** compose file exists · container exists/status (with OOM-kill + exit-code reason) · Docker healthcheck probe (`healthy`/`starting` warn/otherwise error) · restart policy vs compose · image (declared vs actual; warn on mismatch) · network mode + `container:` peer existence/running state · volumes/bind mounts (incl. `/workspace` host-path split-brain detection) · docker socket mount · published ports · environment keys (secrets excluded via `/(password|token|key|secret)/i`).

Driver-aware app-level checks are planned — see `plans/20-health-check-driver-aware.md`.

## Log Store (log-store.js)

Persistent container logs. `docker logs` dies with the container (docker rm
removes the log file), so a recreated PAD's Logs tab would start empty. The log
store captures each container's logs into a rolling file at
`instances/<name>/logs/container.log`:

- `capture(name)` — runs `docker logs --timestamps`, preserves each line's full
  RFC3339Nano timestamp, and appends only uncaptured lines. `meta.json` stores
  the last timestamp plus its boundary lines, preventing both nanosecond output
  loss and duplicate captures. A recreated container's logs naturally append
  with no dupes/gaps. File is trimmed past 8MB/20k lines.
- `captureAll(containerNames)` — the 30s `setInterval` sweep in app.js over all
  `safeVmName` containers.
- `readLogs(name, tail)` — read the captured file (used by the Logs tab and the
  MCP `agent_logs` tool).
- `logFile(name)` — the log file path.

Capture triggers: every `/api/agents/:name/logs` fetch, the 30s sweep, and the
start of each backend recreate/delete/update/settings job (final lines survive
the sweep window).

## Job Log (job-log.js)

In-memory event store for long-running operations (create agent, …). Holds an ordered event list per job plus SSE subscriber response objects; lines are fanned out immediately, late/reconnecting subscribers get a replay via the `since` index. Jobs are cleaned up 5 minutes after finishing (only if no subscriber is attached).

Events: `{ n, ts, type: 'step'|'line'|'check'|'done'|'error', step?, state?, stream?, text?, message?, ok?, name?, key?, label?, status?, expected?, actual?, hint? }`.

**Functions:** `createJob`, `getJob`, `getOrCreateJob`, `append`, `setStep(job, step, state)`, `line(job, stream, text)`, `check(job, item)` (streams a health-check result item — shape matches container-health checks), `finish(job, ok, extra)` (accepts `extra` like `{ status, counts }` for the health job), `fail(job, message)`, `subscribe(job, res, since)` (SSE fan-out + keep-alive), `getStatus(name)` (polling fallback).

In-memory is fine for a single-user panel: a create in flight during a server restart is lost (frontend shows "connection lost" and returns to the form).

## Backup Manager (backup-manager.js)

**STUB — generic backups removed (2026-08-09).** `backupAgent()` /
`restoreAgent()` throw `UNAVAILABLE` ("Generic backups were removed. Native
backups are not available yet.") with no callers in `src/`. Native per-driver
backup/import (`openclaw backup create`, `hermes backup`/`import`, …) is planned
in `plans/26-backup-and-restore.md`; until then the Backups page shows a
maintenance empty state and legacy archives in `backups/` are not restorable.

Business logic: See `overview/business-logic.md` — Backup and Restore.

## Database (db.js)

SQLite wrapper for `src/data/app.db`. Tables are created on first access (auto-initialization).

**Tables:**

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT UNIQUE, display_name TEXT,
  agent_type TEXT, runtime_type TEXT, runtime_ref TEXT,
  status TEXT, workspace_root TEXT, config_root TEXT,
  default_model TEXT, default_provider TEXT, tags TEXT,          -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME, last_activity_at DATETIME
);

CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT,
  category TEXT, action TEXT, status TEXT, details TEXT,
  resource_ref TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, status TEXT,
  model TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  started_at DATETIME, ended_at DATETIME
);
```

## API Keys (api-keys.js)

Per-user bearer keys for the paddock MCP server (`/mcp`). Replaces the
one-shared-`MCP_TOKEN` idea — one auth path, per-identity, revocable.

**Key format:** `pk_live_<base64url-24-random-bytes>` (~192 bits entropy).
Only `sha256(key)` is stored in `api_keys`; the raw key is shown once at
creation, never again. `prefix` (`pk_live_…`) is stored for display in the list.

**Functions:**
- `generate()` — raw key. `hash(key)` — sha256 hex.
- `create(userId, name, scopes)` — inserts hash + prefix, returns
  `{ key: raw, row: { id, prefix, … } }` (key is the only chance to see it).
- `listForUser(userId)` / `getForUser(id, userId)` — owner-scoped reads.
- `remove(id, userId)` — revoke (hard delete, instant).
- `authenticate(token)` — regex-validates `pk_live_` shape, hashes, looks up
  by `key_hash`, rejects missing/revoked. Returns `{ keyId, userId, name, scopes }`.
- `touchLastUsed(keyId)` — throttled to once per minute per key (no write per
  MCP request).

**Schema** (`api_keys` table in `db.js`, FKs to `users(id)`, indexed on
`user_id` and `key_hash`):

```
id TEXT PK, user_id TEXT NOT NULL, name TEXT NOT NULL,
key_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
scopes TEXT DEFAULT 'default', created_at DATETIME,
last_used_at DATETIME, revoked_at DATETIME
```

Auth in `src/mcp.js`: `authenticateRequest(req)` reads `Authorization: Bearer`,
`x-api-key`, or `?token=`, calls `apiKeys.authenticate()`, touches
`last_used_at`, and sets `req.mcpIdentity = { keyId, userId, keyName, scopes, role }`.
Missing/invalid key → 401 JSON-RPC error (`-32001 Unauthorized`). Tools enforce
the same owner-scoping as the REST API: admin → all agents, user → owned agents.

## MCP Tools (mcp.js)

`src/mcp.js` mounts the paddock's own MCP server at `/mcp` (Streamable HTTP). It
exposes 17 tools. Every tool is a thin adapter over the same `src/services/`
functions the REST API uses — behavior lives in the services, never in the tool
handlers (no duplication between REST and MCP).

| Tool | Purpose | Backed by |
|------|---------|-----------|
| `list_agents` | List PADs (owner-scoped) | `registry.discoverAgents()` |
| `get_agent` | Details + optional `logs` tail (≤500) | `registry` + `logStore` |
| `agent_logs` | Container logs tail (≤5000) | `logStore.capture/readLogs` |
| `config_get` | Driver config file (JSON redacted; yaml/toml verbatim) | `vm.readAgentConfig(agent)` |
| `settings_get` | Full read picture before a `recreate` | `vm.readSettings(name)` + `vm.listContainers()` |
| `health` | Docker-level health checkup (same as the Settings tab) | `containerHealth.checkContainerHealth(name)` |
| `workspace_list` | List a workspace dir | `workspace.listDir` |
| `workspace_read` | Read a text file (≤256KB) | `workspace.statFile/readFile` |
| `workspace_write` | Write a file | `workspace.writeFile` |
| `create_agent` | Create a PAD (full create flow); needs `confirm: true` | `vm.validateAgentCreate` + `vm.createAgent` |
| `start_agent` | Start container + socat door | `vm.startAgent(name)` |
| `stop_agent` | Stop container + door | `vm.stopAgent(name)` |
| `restart_agent` | Restart container + door | `vm.restartAgent(name)` |
| `recreate` | The one mutation tool — see below | `vm.applyAgentChanges(name, opts)` |
| `update` | Alias for `recreate {pull: true}` | `vm.updateAgent(name, { pull: true })` |
| `delete_agent` | Delete PAD; needs `confirm: true` | `vm.removeVm` + `registry.removeAgentFromDb` |
| `exec` | Run a shell command in the PAD | `docker exec` |

Rules:

- Tool names carry no `paddock_` prefix — the consuming MCP client namespaces
  the server's tools itself.
- `create_agent` is the only tool that takes a *bare* agent name (`createNameFor`
  adds the container prefix); every other tool takes the full name. It needs
  `confirm: true` (image build + new fleet member) and the creating API-key user
  becomes the owner (`registry.assignOwner`). It shares `validateAgentCreate` +
  `createAgent` with `POST /api/agents/create` — the REST route kept only the
  409 exists-check and the admin `assign_to` owner override.
- Mutations go through one gun: `recreate` accepts every Settings/Web option
  (`allowDocker`, `network`, `extraVolumes` — binds or named-volume entries,
  `workspaceHost`/`workspaceDir`,
  `sshEnabled`/`sshPort`/`sshContainerPort`/`sshPassword`, `extraPorts`, `web`)
  plus `pull` and `reset`. Only the options you specify change; pass `[]`,
  `''` or `false` to explicitly clear. `reset: true` wipes the data dir and
  requires `confirm: true`. `recreate` returns `{ ok, name, action, changed,
  summary, webService, log }`.
- `settings_get` is the paired read: one call returns allowDocker, network
  peer, SSH, workspace mount, volumes/ports, image/version, networkHealth, the
  available peer containers, AND the published-web state.
- Destructive tools require a guard: `delete_agent` needs `confirm: true`
  (and `create_agent` too — it adds fleet members).
- Secrets are write-only in the tools (`sshPassword`, `web.password`): empty
  means "keep current", never echo a stored secret back.
- The endpoint requires a bearer API key (`Authorization: Bearer` or
  `x-api-key`) and returns 406 unless the client sends
  `Accept: application/json, text/event-stream`. Responses are SSE
  (`event: message` + `data:` JSON lines).

### Design decisions (settled — do not add tools without re-checking the user)

These four rules and the fold decisions below were set when the `/mcp` surface
was built. Adding a tool that breaks them needs a re-check first.

- **One mutation gun, one read tool.** Mutations go through `recreate`; reads
  fold into `settings_get`. The web app (`web_get`), container info
  (`container_info`) and network list (`list_networks`) are **not** standalone
  tools — their reads are `settings_get` fields, their mutations are `recreate`
  args. **Exception: `health` is a standalone tool** (user request — run the
  Settings-tab checkup on demand). `list_agents` sends no model.
- **Terminal-command tools stay terminal-driven.** Actions that exist as
  `openclaw …` commands (MCP add/remove, skills install) are **not** mirrored
  as API-backed MCP tools — the frontend pastes the command into the docked
  terminal instead (see CommandsPane rule). Only genuinely headless operations
  get MCP tools.
- **`config_set` is deliberately absent** — an agent self-editing its own
  config can break itself (destroy agents config, auth, plugins). If ever
  added it must be admin-role scoped or confirm-gated. Default is **no**.
- **`backup` / `restore` tools are a standing candidate** (wrap
  `backup-manager.js`), not built yet — the backup service is a stub until
  native per-driver backups land (plan 26).
- **`update` is kept as a convenience alias** for `recreate {pull: true}` — the
  friendliest form of the common "update to latest" flow; dropping it is not on
  the table while it reads as `recreate {pull:true}`.

## Vault (vault.js)

Encrypted secret store replacing the old `creds.js` credential manager. Items
live in the SQLite `vault_items` table in `src/data/app.db` (plus `vault_meta`
holding the PIN salt + wrapped master key), AES-256-GCM encrypted.

**PIN (2026-08-07):** The vault is **always locked** — no module state, no
`unlock()`/`lock()`/`isLocked()`. Each operation (create/update/delete/decrypt)
takes a `pin` in the request body and calls `resolveMaster(pin)` to unwrap the
master key for that single operation, then discards it. Wrong PIN → GCM tag
mismatch → throws `Wrong PIN`. Without a PIN set, the master key falls back to
`VAULT_KEY` (or a scrypt derivation of `SESSION_SECRET`).

Envelope encryption: `scrypt(pin, salt) → pinKey → AES-GCM → masterWrapped`
(stored in `vault_meta`), with a random 32-byte `masterKey` per item via
AES-GCM (`enc_value`). `setPin(pin, { reset, oldPin })` — reset verifies
`oldPin` before wiping items (old master key unrecoverable). The item list is
public; only values are protected.

Routes: `GET /api/vault`, `POST /api/vault`, `PUT /api/vault/:id`,
`DELETE /api/vault/:id`, `GET /api/vault/:id/decrypt`, `POST /api/vault/pin`.
All mutating routes take `pin` in the body (decrypt takes it as a query param).
