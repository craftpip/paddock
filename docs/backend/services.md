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
- `createVm(name, options)` — full creation flow with SSH port allocation
- `removeVm(name)` — force remove container + delete instance dir
- `resetVm(name)` — remove container + wipe data + recreate + compose up
- `startAgent(name)` — docker start with compose fallback
- `generateInstanceCompose(name, agent, password, port)` — YAML generator using absolute host paths
- `writeInstanceCompose(name, agent, password, port)` — write YAML to disk
- `existingServices()` — scan instances/ for existing compose files
- `instanceComposePath(name)`, `getComposePath(name)` — path helpers

**Agent images:**
| Agent | Image tag | Data dir inside container |
|-------|-----------|--------------------------|
| openclaw | paddock-vm-openclaw:latest | /root/.openclaw |
| picoclaw | paddock-vm-picoclaw:latest | /root/.picoclaw |
| nanobot | paddock-vm-nanobot:latest | /root/.nanobot |
| hermes | paddock-vm-hermes:latest | /opt/data |

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

## Credential Manager (creds.js)

Stores API keys and bot tokens in `src/data/credentials.json`.

**Structure:**
```json
{
  "api_keys": {
    "my-key": { "provider": "openai", "key": "sk-..." }
  },
  "bot_tokens": {
    "my_bot": { "token": "123:ABC", "platform": "telegram" }
  },
  "user_ids": {
    "me": { "id": "532156945", "platform": "telegram" }
  }
}
```

**Functions:** `getCredentials()`, `addCredential(type, name, value, provider)`, `removeCredential(type, name)`
