# System Architecture

> Last updated: 2026-08-17

PAD Friends is a Docker-based control plane that manages AI agent containers (PADs) through a web UI. The agent program is driver-based: openclaw, opencode, picoclaw, hermes, codex, or claude.

## High-Level Flow

```
Browser → Web UI (React SPA)
              ↓
         Express API (port 6789)
              ↓
         Docker socket (/var/run/docker.sock)
              ↓
         PAD containers (driven by one of five drivers)
```

The webui container (`paddock`) manages PAD containers via the host's Docker socket. It discovers PADs from the filesystem, controls their lifecycle, execs commands inside them, and streams logs/terminals.

## Containers

| Container | Image | Purpose |
|-----------|-------|---------|
| `paddock` (service `webui`) | Build from src/Dockerfile (`paddock-webui`) | Express API + React SPA, manages all PADs |
| `&lt;prefix&gt;-&lt;name&gt;` | `paddock-vm-&lt;name&gt;:latest` (per-PAD build) | One per PAD; the driver agent runs inside |
| `&lt;prefix&gt;-&lt;name&gt;-door` | `alpine/socat` | Host-port carrier for peer-networked agents (web, SSH, extra ports) |

Container names use the `CONTAINER_PREFIX` from `.env` (`pad` here) — never hardcode a `vm-` scheme.

## Services

```
src/
├── app.js                    Express server, API routes, WebSocket terminal, auth
├── mcp.js                    The paddock's own /mcp Streamable HTTP server (19 tools)
├── middleware/
│   ├── auth.js               Session-based auth, CSRF tokens, login/logout
│   └── rateLimit.js          IP-based rate limiter
├── services/
│   ├── agent-registry.js     PAD discovery from instances/ + Docker state
│   ├── db.js                 SQLite metadata store (users, agents, vault, api_keys)
│   ├── workspace.js          Safe file operations with path traversal protection
│   ├── ownership.js          Chown-on-create discipline (ensureOwned, normalizeTree)
│   ├── path-probe.js         Read-only host-path probes + compose volume inheritance (plan 40)
│   ├── paddock-mcp.js        Internal Paddock MCP endpoint URL (plan 35b)
│   ├── llm-guide.js          MCP "help" + "agent_commands" guide text (plan 35a)
│   ├── vm-manager.js         Create/remove/reset PADs, compose generation, applySettings,
│   │                         applyAgentChanges, readSettings, containerInfo, the socat door
│   ├── devcontainer.js       Dev Container spec support — parse + sync workspace devcontainer.json (plan 41)
│   ├── drivers/              Per-type adapters: openclaw, opencode, picoclaw, hermes, codex, claude
│   ├── instance-image.js     Per-PAD image tags + build.env + Dockerfile ARG parsing
│   ├── container-health.js   Generic Docker-level health checkup (11 checks)
│   ├── cmd.js                Streaming command runner (spawn-based, feeds onLog callbacks)
│   ├── log-store.js          Persistent container log capture (instances/&lt;name&gt;/logs/)
│   ├── job-log.js            In-memory SSE event store for long-running jobs
│   ├── backup-manager.js     STUB — generic backups removed (see business-logic.md)
│   ├── api-keys.js           Per-user bearer keys for /mcp
│   └── vault.js              Encrypted key-value store (AES-256-GCM)
├── client/                   React SPA (see overview/react-migration.md)
└── routes/
    └── agents.js             Legacy EJS routes (dead code, not mounted)
```

## Data Flow

### PAD Discovery
1. Scan `instances/*/meta.env` for known PADs
2. Query `docker ps -a` for container state (3s TTL cache)
3. Merge filesystem state with Docker state
4. Return to frontend as agent list

### API Pattern
- All modern API endpoints live in `app.js` under `/api/agents/:name/*`
- POST routes require CSRF token via `x-csrf-token` header
- Responses are JSON
- Backend commands use `runCmd()` (execFile wrapper) or `spawn()` for streaming
- Long-running operations (create, update, settings, web, health) run as background
  jobs (`setImmediate`) streamed over SSE through `job-log.js`

### WebSocket Terminal

The terminal is a persistent **tmux session** inside the PAD container,
attached over a real Docker PTY (dockerode hijack stream). See
`tabs/terminal.md` for the full write-up.

1. Client opens WS to `/ws/terminal/:name?session=&lt;id&gt;`
2. Server verifies auth + container state, `ensureTmuxSession()` (lazy tmux
   install, PS1, tmux.conf, history-limit 10000)
3. Attaches via `tmux attach-session -t &lt;session&gt;` with `Tty: true` — Docker
   allocates a real PTY; closing the WS detaches but the session survives
4. Fresh connections replay the pane history (`tmux capture-pane -S -10000`,
   LF → CRLF) before attaching, so scrollback survives refresh
5. Client keystrokes → WebSocket → docker stdin; resize sent as
   double-NUL-framed JSON control frames
6. Output is demuxed (dockerode `demuxStream`) and UTF-8 decoded — no `\r` →
   `\n` conversion, the PTY line discipline handles CR/LF

### Web Publishing, SSH, and extra ports

Agents with a built-in web app (drivers with a `webApp` descriptor) can publish it
on a host port; peer-networked agents can also expose SSH and extra TCP ports.
`POST /api/agents/:name/web` writes `web.json` + a boot hook
(`&lt;dataDir&gt;/start-web.sh`, sourced by the image `start.sh`), regenerates the
compose with the `ports:` binding, and recreates the container. On a network
peer (`network_mode: container:`) a **socat door** service (`&lt;name&gt;-door`)
carries all host ports and forwards to the peer by name. See `tabs/web.md`.


## Key Design Decisions

| Decision | Why |
|----------|-----|
| React SPA at root `/` | All pages migrated from EJS+HTMX |
| Express serves built SPA from public/ | Simple prod deployment |
| Driver framework (`services/drivers/`) | Per-type behavior (openclaw/opencode/picoclaw/hermes/codex/claude) via one adapter |
| No EJS rendering for modern pages | API-only for React |
| Session-based auth with CSRF | Replaced Basic Auth; `AUTO_LOGIN=true` auto-logs in |
| CSRF on all POST routes | Security |
| Docker exec for all container commands | No agent-side daemon needed |
| Per-PAD image `paddock-vm-&lt;name&gt;:latest` | Each PAD owns its build dir (`instances/&lt;name&gt;/build/`) |
| 3s cache on docker ps | Reduces API latency |
| Path traversal protection on workspace | Security |
| Secret redaction in config responses | Don't leak tokens |
| Socat door for peer-networked agents | Port publishing is impossible on `network_mode: container:` |
| `HOST_WORKSPACE_ROOT` env var | Fixes bind-mount split-brain |
| One-to-one project-folder mounts (`- /www2:/www2:ro`) | Create Agent volume inheritance reads real project compose files at host-identical paths |
| MCP server at `/mcp` (bearer API keys) | opencode/Claude Code manage Paddock over Streamable HTTP |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTO_LOGIN` | No | `true` (default) auto-logs every request in as the first admin — no login screen. Any other value enables real auth |
| `SESSION_SECRET` | No | Auto-generated if not set |
| `CONTAINER_PREFIX` | No | Default: `pad` (PAD container name prefix) |
| `HOST_WORKSPACE_ROOT` | No | Real host path to project root (falls back to `WORKSPACE_ROOT`) |
| `VAULT_KEY` | No | 32+ bytes for vault encryption (falls back to SESSION_SECRET) |
| `HOST_NAME` / `HOST_PROTO` | No | Override the base for published web-app links (IP or hostname + `http`/`https`) |
| `GUARD_*` | No | Workspace-mount safety guards (on by default; set `GUARD_&lt;NAME&gt;=0` to disable) |

`AUTH_PASSWORD` is **gone** — auth is multi-user (users table in `src/data/app.db`), see `backend/user-management.md`.

## Networking

- webui container maps ports 6789 → 6789 (Express) and 5173 (Vite dev)
- Access production UI at `http://&lt;host-ip&gt;:6789`
- Access Vite dev at `http://&lt;host-ip&gt;:5173`
- Docker gateway IP (172.19.0.x) not accessible from host browser MCP — use the host LAN IP (e.g. `10.69.1.164`)
