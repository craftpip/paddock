# System Architecture

PAD Friends is a Docker-based control plane that manages OpenClaw AI agent containers through a web UI.

## High-Level Flow

```
Browser → Web UI (React SPA)
              ↓
         Express API (port 5050)
              ↓
         Docker socket (/var/run/docker.sock)
              ↓
         PAD containers (OpenClaw agents)
```

The webui container (paddock-webui) manages PAD containers via the host's Docker socket. It discovers PADs from the filesystem, controls their lifecycle, execs commands inside them, and streams logs/terminals.

## Containers

| Container | Image | Purpose |
|-----------|-------|---------|
| paddock-webui | Build from src/Dockerfile | Express API + React SPA, manages all PADs |
| vm-openclaw-* | ghcr.io/openclaw/openclaw:latest | Per-PAD OpenClaw agent |

## Services

```
src/
├── app.js                    Express server, API routes, WebSocket terminal, auth
├── middleware/
│   ├── auth.js               Session-based auth, CSRF tokens, login/logout
│   └── rateLimit.js          IP-based rate limiter
├── services/
│   ├── agent-registry.js     PAD discovery from instances/ + Docker state
│   ├── db.js                 SQLite metadata store
│   ├── workspace.js          Safe file operations with path traversal protection
│   ├── vm-manager.js         Create/remove/reset PADs, generate compose files
│   ├── backup-manager.js     Backup/restore via docker exec
│   └── vault.js              Encrypted key-value store (AES-256-GCM)
├── client/                   React SPA (see overview/react-migration.md)
└── routes/
    └── agents.js             Legacy EJS routes (dead code, kept for reference)
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

### WebSocket Terminal

The terminal is a persistent **tmux session** inside the PAD container,
attached over a real Docker PTY (dockerode hijack stream). See
`tabs/terminal.md` for the full write-up.

1. Client opens WS to `/ws/terminal/:name?session=<id>`
2. Server verifies auth + container state, `ensureTmuxSession()` (lazy tmux
   install, PS1, tmux.conf, history-limit 10000)
3. Attaches via `tmux attach-session -t <session>` with `Tty: true` — Docker
   allocates a real PTY; closing the WS detaches but the session survives
4. Fresh connections replay the pane history (`tmux capture-pane -S -10000`,
   LF → CRLF) before attaching, so scrollback survives refresh
5. Client keystrokes → WebSocket → docker stdin; resize sent as
   double-NUL-framed JSON control frames
6. Output is demuxed (dockerode `demuxStream`) and UTF-8 decoded — no `\r` →
   `\n` conversion, the PTY line discipline handles CR/LF

### Web Publishing

Agents with a built-in web app (drivers with a `webApp` descriptor) can publish
it on a host port. `POST /api/agents/:name/web` writes `web.json` + a boot hook
(`<dataDir>/start-web.sh`, sourced by the image `start.sh`), regenerates the
compose with the `ports:` binding, and recreates the container. On a network
peer (`network_mode: container:`) a **socat door** service carries the host
port and forwards to the peer by name. See `tabs/web.md`.


## Key Design Decisions

| Decision | Why |
|----------|-----|
| React SPA at root `/` | All pages migrated from EJS+HTMX |
| Express serves built SPA from public/ | Simple prod deployment |
| No EJS rendering for modern pages | API-only for React |
| Session-based auth with CSRF | Replaced Basic Auth |
| CSRF on all POST routes | Security |
| Docker exec for all container commands | No agent-side daemon needed |
| 3s cache on docker ps | Reduces API latency |
| Path traversal protection on workspace | Security |
| Secret redaction in config responses | Don't leak tokens |
| `HOST_WORKSPACE_ROOT` env var | Fixes bind-mount split-brain |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_PASSWORD` | Yes | Password for login |
| `SESSION_SECRET` | No | Auto-generated if not set |
| `CONTAINER_PREFIX` | No | Default: `vm` |
| `HOST_WORKSPACE_ROOT` | Yes | Real host path to project root |
| `VAULT_KEY` | No | 32+ bytes for vault encryption (falls back to SESSION_SECRET) |
| `WEBUI_PASSWORD` | No | Maps to AUTH_PASSWORD |

## Networking

- webui container maps ports 5051 → 5050 (Express) and 5173 (Vite dev)
- Access production UI at `http://<host-ip>:5051`
- Access Vite dev at `http://<host-ip>:5173`
- Docker gateway IP (172.19.0.x) not accessible from host browser MCP
