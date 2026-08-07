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

**Functions:**
- `createVm(name, { agent, mode, skipSetup, onLog, onStep })` — full streaming creation flow with SSH port allocation. Emits steps via `onStep('build'|'up'|'setup', 'start'|'end'|'error')` and feeds command output through `onLog(stream, text)`. `skipSetup` skips the `openclaw setup --baseline` + restart block (used on the clone/restore path).
- `removeVm(name)` — force remove container + delete instance dir
- `resetVm(name)` — remove container + wipe data + recreate + compose up
- `startAgent(name)` — docker start with compose fallback
- `generateInstanceCompose(name, agent, password, port, { allowDocker, network })` — YAML generator using absolute host paths; `allowDocker` adds the `/var/run/docker.sock` volume, `network` adds `network_mode: container:<name>`
- `writeInstanceCompose(name, agent, password, port, opts)` — write YAML to disk (passes the options through)
- `applySettings(name, { allowDocker, network })` — regenerates compose + writes `DOCKER=1|0` and `NETWORK=<name>` (or empty) to `meta.env`; returns `{ allowDocker, network, image, agent }`
- `updateAgent(name, { onLog, onStep })` — streams `docker compose -f <compose> build --pull <name>` (900s) then `up -d --no-deps --force-recreate <name>` (300s); steps `build`/`recreate`
- `setMetaFlag(name, key, value)` — writes/clears a `KEY=VALUE` line in `meta.env` preserving other lines
- `existingServices()` — scan instances/ for existing compose files
- `instanceComposePath(name)`, `getComposePath(name)` — path helpers

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
| `buildImage` | `paddock-vm-<type>:latest` |
| `buildRel` | path to the per-type Dockerfile (`../../src/vm-builds/<type>`) |
| `baseImage` | upstream image the Dockerfile starts from |
| `dataDir` | in-container data directory (`/root/.openclaw`, `/root/.picoclaw`, …) |
| `workspaceDir` | workspace root inside the container |
| `configFile` | config filename in `dataDir` (openclaw.json / opencode.json / config.json) |
| `setupSteps` | commands run right after `compose up` during create |
| `backupTypeMarker` | filename sniff used by backup-manager for cli vs legacy type |
| `installDockerBuildArg` | build arg that installs docker CLI (`INSTALL_DOCKER=1`) |
| `currentVersion(name)` | live version inside the container (regex-parsed; picoclaw prints a heavy ANSI banner) |
| `availableVersion()` | upstream available version (cached 5 min) |
| `commands` | Command groups (Status/Auth/Cron/Skills/Other) for the CommandsPane |

Config GET/POST, agent-registry model extraction, and workspace/config root
resolution all derive paths from `driver.configFile` / `driver.workspaceDir` /
`driver.dataDir` — nothing is hardcoded to openclaw anymore.

## Command Runner (cmd.js)

- `runCmd(cmd, args, options)` — `execFile`-based, returns the full combined output string (no streaming)
- `runCmdStream(cmd, args, { onLog, timeout })` — `spawn`-based; feeds every stdout/stderr chunk through `onLog(stream, text)` so long operations can stream live. Used by create (`build`/`up`/`setup`) and backup restore.

## Job Log (job-log.js)

In-memory event store for long-running operations (create agent, …). Holds an ordered event list per job plus SSE subscriber response objects; lines are fanned out immediately, late/reconnecting subscribers get a replay via the `since` index. Jobs are cleaned up 5 minutes after finishing (only if no subscriber is attached).

Events: `{ n, ts, type: 'step'|'line'|'done'|'error', step?, state?, stream?, text?, message?, ok?, name? }`.

**Functions:** `createJob`, `getJob`, `getOrCreateJob`, `append`, `setStep(job, step, state)`, `line(job, stream, text)`, `finish(job, ok)`, `fail(job, message)`, `subscribe(job, res, since)` (SSE fan-out + keep-alive), `getStatus(name)` (polling fallback).

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

## Vault (vault.js)

Encrypted secret store replacing the old `creds.js` credential manager. Items
live in `src/data/vault.json`, AES-256-GCM encrypted with the `VAULT_KEY`
environment variable. Routes: `GET/POST /api/vault`, `DELETE /api/vault/:id`.
