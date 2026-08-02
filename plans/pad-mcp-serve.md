# Per-PAD MCP Server (`openclaw mcp serve`) — Plan

## Status: Proposed (2026-08-02)

## Goal

Each PAD (OpenClaw agent container) should have its **own** MCP server. External MCP clients connect to a PAD and talk to its Gateway-backed channel conversations — list them, read transcripts, send replies, handle approvals.

OpenClaw ships this natively: `openclaw mcp serve` starts a stdio MCP server that bridges to the PAD's local Gateway over WebSocket. The client spawns the process; the PAD owns the conversations.

This plan wires that into paddock: a management panel on the existing MCP tab + copy-paste client configs + a live test button.

## How `openclaw mcp serve` works

From the OpenClaw docs (docs.openclaw.ai/cli/mcp):

1. An MCP client spawns `openclaw mcp serve` (stdio).
2. The bridge connects to the OpenClaw Gateway over WebSocket.
3. Routed sessions become MCP conversations.
4. Live events queue in memory while the bridge is connected.
5. Client disconnects → bridge exits, queue gone.

Exposed tools: `conversations_list`, `conversation_get`, `messages_read`, `attachments_fetch`, `events_poll`, `events_wait`, `messages_send`, `permissions_list_open`, `permissions_respond`.

Flags: `--url <gateway-ws>` (default local gateway), `--token-file` / `--password-file` / `--token` / `--password`, `--claude-channel-mode on|off|auto`, `-v`.

## The trick: connect via `docker exec -i`

`mcp serve` is stdio-only. The clean way to reach a PAD's bridge from a client on the host is to spawn it through the container, exactly like the webui's terminal already does (`docker exec -i`):

```json
{
  "mcpServers": {
    "love": {
      "command": "docker",
      "args": ["exec", "-i", "pad-openclaw-love", "openclaw", "mcp", "serve"]
    }
  }
}
```

- No gateway port needs publishing (the bridge runs inside the container, talks to its own local Gateway).
- stdin/stdout are piped cleanly; OpenClaw logs go to stderr.
- Same pattern the webui terminal uses → proven on this stack.

## Concept

```
┌───────────┐  docker exec -i ──────► ┌───────────────────────┐
│ MCP client│   openclaw mcp serve    │  PAD container         │
│  (host)   │  ─────────────────────► │  ┌──────────────────┐  │
└───────────┘                         │  │ mcp serve bridge │  │
                                      │  │      ↕ WS         │  │
                                      │  │   Gateway (local) │  │
                                      │  │      ↕ channels   │  │
                                      │  └──────────────────┘  │
                                      └───────────────────────┘
```

The paddock webui adds a management surface so you don't hand-write the config:
- per-PAD status: does the bridge spawn? what tools does it expose?
- copy-paste client snippets (Claude Code / opencode / Cursor)
- gateway token handling for remote access

## Webui panel (on the existing MCP tab)

Add an "Own MCP server" section to `McpTab` (or a second card under the outbound server list):

1. **Bridge test** — spawns `openclaw mcp serve` via `docker exec -i`, completes the `initialize` + `tools/list` handshake, prints the tool list (mirror of the existing probe modal). Kills the bridge after.
2. **Config snippets** — tabs for Claude Code / opencode / Cursor, with the container name filled in, token placeholder.
3. **Gateway note** — show whether the PAD's Gateway is up (`openclaw gateway status`), and a warning that only routed conversations with stored route metadata appear (`conversations_list` returns nothing otherwise).
4. **Optional: gateway token** — if the Gateway requires auth for the bridge, show where the token lives (`~/.openclaw/gateway.token`) and offer `--token-file` in the snippet.

## Backend endpoints

| Endpoint | What |
|----------|------|
| `GET /api/agents/:name/mcp-serve/status` | gateway up? bridge spawns? (`openclaw gateway status`, quick probe) |
| `POST /api/agents/:name/mcp-serve/test` | spawn bridge via `docker exec -i`, initialize + tools/list, return tools, kill |
| `GET /api/agents/:name/mcp-serve/config` | ready-made client config JSON for the PAD (name filled in) |

Reuse the webui's `dockerExec()` plumbing. Add a small MCP client helper (`@modelcontextprotocol/sdk` client) or drive the handshake with raw JSON-RPC over the exec stdio — the handshake is small (initialize + tools/list), so raw JSON-RPC keeps it dependency-free.

## Files

- **Modified** `src/app.js` — the three endpoints above.
- **Modified** `src/client/src/pages/AgentDetail.jsx` — `McpTab` gets the "Own MCP" section.
- **New** `src/services/mcp-serve.js` — bridge spawn + handshake helper.
- **No** `docker-compose.yml` changes (no new ports).

## Phases

### Phase 1 — Prove the bridge on a live PAD
- Pick a running PAD, spawn `docker exec -i <pad> openclaw mcp serve` from a host client (or MCP Inspector) and confirm `conversations_list` / `tools/list` work.
- Confirm whether the local Gateway needs a token for the bridge (`--token-file ~/.openclaw/gateway.token` if it does).

### Phase 2 — Backend endpoints
- `mcp-serve/status` + `mcp-serve/test` in `src/app.js`.
- Return the tool list and any diagnostics (gateway down, token needed).

### Phase 3 — UI panel
- "Own MCP" card on `McpTab`: status line, Test button → tool list modal, config snippet tabs.

## Verification

```bash
# bridge handshake from the host
npx @modelcontextprotocol/inspector  # config: command=docker, args=["exec","-i","<pad>","openclaw","mcp","serve"]

# or raw JSON-RPC
docker exec -i <pad> openclaw mcp serve <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"0"}}}
EOF

# webui: open agent detail → MCP tab → Own MCP → Test → tool list renders
# then send a real message with messages_send from the client and watch it arrive on the channel
```

## Gotchas (from docs)

- `conversations_list` only returns sessions with **stored route metadata** (channel, recipient, account/thread). No route → empty list, and that's not an MCP bug.
- The live event queue is memory-only and starts when the bridge connects. `events_poll`/`events_wait` won't replay older history — read that with `messages_read`.
- `messages_send` sends text only and reuses an existing stored route.
- Bridge dies with the client. No daemon to keep alive for stdio clients.
- `--claude-channel-mode auto` behaves like `on` today; generic clients can pass `off`.

## Related

- Paddock-level MCP server (the whole fleet as one MCP server): `paddock-own-mcp.md`
- Existing outbound MCP tab (`McpTab` in `AgentDetail.jsx`)
