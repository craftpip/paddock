# Paddock's Own MCP Server — Plan

## Status: Proposed (2026-08-02)

## Goal

The paddock webui already manages the fleet through its REST API. Give the paddock itself an MCP server so external MCP clients — opencode, Claude Code, Cursor, Claude Desktop, or another OpenClaw instance — can connect **in** and manage PADs (list, start/stop, exec, workspace, logs, backups).

Today MCP only goes one way: each PAD connects **out** to third-party MCP servers (the existing MCP tab / `openclaw mcp add`). This plan adds the reverse: paddock exposes its own tools over MCP.

## Concept

```
┌──────────┐   stdio or http    ┌──────────────────────────┐   docker exec   ┌─────────┐
│ opencode │                    │        paddock webui     │                  │  PADs   │
│  Claude  │ ──── MCP ────────► │  Express :5050 + /mcp     │ ───────────────► │         │
│  Cursor  │   (bearer token)   │  (streamable-http MCP)    │   docker.sock   │  ...    │
└──────────┘                    └──────────────────────────┘                  └─────────┘
```

- MCP endpoint mounts on the existing Express server at `/mcp` (Streamable HTTP transport).
- Each MCP tool wraps an existing helper in `src/app.js` (dockerExec, agent-registry, backup-manager, workspace).
- No new ports. No new containers. Same 5050/5051.

## Tools

Each tool maps to an existing API route. Prefix with `paddock_` so clients group them.

| Tool | Backs onto | Notes |
|------|-----------|-------|
| `paddock_list_agents` | `GET /api/agents` | name, status, image, cpu/mem |
| `paddock_get_agent` | agent detail | |
| `paddock_start_agent` | `POST /api/agents/:id/start` | |
| `paddock_stop_agent` | `POST /api/agents/:id/stop` | |
| `paddock_restart_agent` | `POST /api/agents/:id/restart` | |
| `paddock_exec` | `dockerExec()` | run `openclaw ...` / shell in a PAD, return stdout/stderr |
| `paddock_workspace_list` | `GET .../workspace` | safe path resolution |
| `paddock_workspace_read` | workspace file read | text only, size-capped |
| `paddock_workspace_write` | workspace save | |
| `paddock_agent_logs` | `GET .../logs` | last N lines |
| `paddock_config_get` | `GET .../config` | already redacts secrets |
| `paddock_backup_list` | backups | |
| `paddock_backup_create` | `backupAgent()` | |

Start with read/control tools. Add `workspace_write` and `backup_create` once the read side works.

## Auth

MCP clients don't do the webui's cookie session cleanly. Use a dedicated token:

- New env var `MCP_TOKEN` (add to `.env`, pass through `docker-compose.yml`).
- `/mcp` requires `Authorization: Bearer <MCP_TOKEN>` (also accept `?token=` for simple clients).
- If `MCP_TOKEN` is unset, the MCP endpoint is disabled (404) — opt-in, like `WEBUI_PASSWORD`.
- Same trust level as a logged-in webui session (full API access). Keep the token out of git.

## Client configs

opencode (`opencode.json`):
```json
{
  "mcp": {
    "paddock": {
      "type": "http",
      "url": "http://10.69.1.164:5051/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

Claude Code (`~/.claude.json` or project `.mcp.json`):
```json
{
  "mcpServers": {
    "paddock": {
      "type": "http",
      "url": "http://10.69.1.164:5051/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" }
    }
  }
}
```

## Implementation

### Files

- **New** `src/mcp.js` — builds the MCP server: imports `@modelcontextprotocol/sdk`, registers tools, calls existing helpers.
- **Modified** `src/app.js` — mount the MCP server at `/mcp` (streamable-http), token middleware, enable flag.
- **Modified** `.env` — `MCP_TOKEN`
- **Modified** `docker-compose.yml` — pass `MCP_TOKEN` to the webui container.
- **New** `src/test/mcp.test.js` — tools/list + initialize handshake.

### Dependencies

- `@modelcontextprotocol/sdk` (Streamable HTTP server). Node 20 in the container supports it.
- Install inside the container so the host bind-mount `src/node_modules` picks it up:
  ```bash
  docker exec paddock-webui sh -c 'cd /app && npm install @modelcontextprotocol/sdk'
  ```

### Why the SDK and not hand-rolled JSON-RPC

The SDK handles Streamable HTTP framing (SSE + POST), capability negotiation, `initialize`, `tools/list`, `tools/call`, and JSON-RPC error shapes. Hand-rolling that is a lot of protocol surface to get subtly wrong. One npm dep beats a half-correct protocol implementation.

## Phases

### Phase 1 — Skeleton + auth
- Add `MCP_TOKEN` env plumbing.
- Mount an SDK streamable-http server at `/mcp` with one echo/`paddock_list_agents` tool.
- Verify with `curl` (initialize + tools/list) and the MCP Inspector.

### Phase 2 — Control + inspect tools
- Add start/stop/restart/exec/logs/config/workspace-list/workspace-read.
- Each tool shells into the existing helpers so behavior matches the webui exactly.

### Phase 3 — Write tools + polish
- workspace_write, backup_create.
- Error mapping (PAD not found, container down → structured MCP errors, not stack traces).
- Timeouts on exec (reuse existing runCmd timeout).

## Verification

```bash
# unit tests still pass
docker exec paddock-webui node --test test/

# handshake
curl -s -X POST http://localhost:5051/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# MCP Inspector against http://host:5051/mcp with the bearer token
npx @modelcontextprotocol/inspector

# live: connect opencode/Claude Code to the endpoint and run list + start/stop on a test PAD
```

## Edge cases

| Case | Handling |
|------|----------|
| No `MCP_TOKEN` set | `/mcp` 404, disabled |
| Bad/absent token | 401 JSON-RPC error |
| PAD not found / not running | structured error from existing helpers |
| `paddock_exec` long running | same timeout as `runCmd`; document it |
| Workspace path traversal | reuse `resolveSafePath()` |
| Secrets in config_get | already redacted by the config route |

## Related

- Per-PAD MCP bridge (each agent as its own MCP server): `pad-mcp-serve.md`
- Existing outbound MCP tab in `AgentDetail.jsx` (`McpTab`)
