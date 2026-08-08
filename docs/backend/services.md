# Backend Services

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

## VM Manager (vm-manager.js)

Business logic: See `overview/business-logic.md` — Agent Lifecycle, Bind-Mount Split-Brain.

Per-instance build model: every PAD owns its build files (`instances/<name>/build/`)
and its own image tag (`paddock-vm-<name>:latest`). See
`services/instance-image.js` below.

**Functions:**
- `createVm(name, { agent, mode, skipSetup, onLog, onStep })` — full streaming creation flow with SSH port allocation. Emits steps via `onStep('build'|'up'|'setup', 'start'|'end'|'error')` and feeds command output through `onLog(stream, text)`. `skipSetup` skips the `openclaw setup --baseline` + restart block (used on the clone/restore path). Seeds the instance build dir from the shared template (`seedBuildDir`). Clone mode is type-locked (source must be the same agent type) and copies the source's `build/` too.
- `removeVm(name)` — force remove container + delete instance dir
- `resetVm(name)` — remove container + wipe data + recreate + compose up
- `startAgent(name)` — docker start with compose fallback
- `generateInstanceCompose(name, agent, password, port, { allowDocker, network })` — YAML generator using absolute host paths; `allowDocker` adds the `/var/run/docker.sock` volume, `network` adds `network_mode: container:<name>`. Builds from `instances/<name>/build` with `image: paddock-vm-<name>:latest`; the `build.args:` block is generated from the instance Dockerfile's `ARG` lines (values interpolated from the instance `build.env`).
- `writeInstanceCompose(name, agent, password, port, opts)` — write YAML to disk (passes the options through)
- `applySettings(name, { allowDocker, network })` — regenerates compose + writes `DOCKER=1|0` and `NETWORK=<name>` (or empty) to `meta.env`; returns `{ allowDocker, network, image, agent }`
- `updateAgent(name, { onLog, onStep })` — streams `docker compose --env-file <instance>/build/build.env -f <compose> build --pull <name>` (900s) then `up -d --no-deps --force-recreate <name>` (300s); steps `build`/`recreate`. No forced build args — the image is per-PAD, so the rebuild reads the instance Dockerfile + `build.env` directly.
- `setMetaFlag(name, key, value)` — writes/clears a `KEY=VALUE` line in `meta.env` preserving other lines
- `seedBuildDir(name, agent, { installDocker })` — idempotently copies `src/vm-builds/<type>/` → `instances/<name>/build/`, seeds `extras/.gitkeep` + `build.env`; never overwrites existing build files
- `composeCommand(name, ...args)` — `docker compose --env-file <instance>/build/build.env -f <compose> ...` prefix used by every per-instance compose invocation (skips the env-file when the build dir is missing)
- `ensureInstanceBuilds()` — one-time migration: seeds build dirs, retags `paddock-vm-<type>:latest` → `paddock-vm-<name>:latest`, regenerates compose + force-recreates running containers. Idempotent; runs on webui boot and via `GET /api/admin/migrate-builds`.
- `setBuildEnv(name, kv)` / `readBuildEnv(name)` — read/write `instances/<name>/build/build.env` (K=V, `#` comments preserved)
- `getNetworkHealth(name)` — resolves the compose `network_mode: container:<peer>` against live docker state → `none` / `ok` / `stale` (peer recreated, recorded ID dead) / `peer-stopped`
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

One module per agent type (`openclaw.js`, `opencode.js`, `picoclaw.js`),
registered in `index.js`. Every type is an equal citizen.

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
| `dataDir` | in-container data directory (`/root/.openclaw`, `/root/.picoclaw`, …) |
| `workspaceDir` | workspace root inside the container |
| `configFile` | config filename in `dataDir` (openclaw.json / opencode.json / config.json) |
| `setupSteps` | commands run right after `compose up` during create |
| `backupTypeMarker` | filename sniff used by backup-manager for cli vs legacy type |
| `currentVersion(name)` | live version inside the container (regex-parsed; picoclaw prints a heavy ANSI banner) |
| `availableVersion()` | upstream available version (cached 5 min) |
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

## Job Log (job-log.js)

In-memory event store for long-running operations (create agent, …). Holds an ordered event list per job plus SSE subscriber response objects; lines are fanned out immediately, late/reconnecting subscribers get a replay via the `since` index. Jobs are cleaned up 5 minutes after finishing (only if no subscriber is attached).

Events: `{ n, ts, type: 'step'|'line'|'check'|'done'|'error', step?, state?, stream?, text?, message?, ok?, name?, key?, label?, status?, expected?, actual?, hint? }`.

**Functions:** `createJob`, `getJob`, `getOrCreateJob`, `append`, `setStep(job, step, state)`, `line(job, stream, text)`, `check(job, item)` (streams a health-check result item — shape matches container-health checks), `finish(job, ok, extra)` (accepts `extra` like `{ status, counts }` for the health job), `fail(job, message)`, `subscribe(job, res, since)` (SSE fan-out + keep-alive), `getStatus(name)` (polling fallback).

In-memory is fine for a single-user panel: a create in flight during a server restart is lost (frontend shows "connection lost" and returns to the form).

## Backup Manager (backup-manager.js)

Business logic: See `overview/business-logic.md` — Backup and Restore.

**Functions:**
- `backupAgent(agentName)` — tar.gz inside container → copy to host → clean up → save meta
- `restoreAgent(agentName, archiveFile)` — copy into container → extract → clean up → restart
- `getBackupType(filename)` — cli vs legacy detection
- `loadMeta()` / `saveMeta(meta)` — read/write `backups/backup-meta.json`

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
