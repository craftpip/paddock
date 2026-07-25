# MCP Tab

Manages MCP servers configured for an agent via OpenClaw's `mcp` CLI. Shows server cards with status, transport type, and action controls.

## Tab

Renders at `/agents/:id#mcp`. Tab position: after Config.

## Features

- **Server listing** — cards showing name, status dot (ok/error/configured), transport badge, command/URL, toggle switch
- **Add server form** — name, transport select (stdio / streamable-http), conditional fields per transport type:
  - stdio: command, args (comma-separated), optional CWD
  - HTTP: URL with "Test URL" button
- **Toggle** — enable/disable server inline via toggle switch
- **Test** — runs `openclaw mcp probe --json`, shows result modal with tool list and diagnostics
- **Remove** — unset with confirmation

## API Endpoints (app.js)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:name/mcp` | List MCP servers from agent config |
| POST | `/api/agents/:name/mcp/add` | Add server via `openclaw mcp add` |
| POST | `/api/agents/:name/mcp/remove` | Remove via `openclaw mcp unset` |
| POST | `/api/agents/:name/mcp/toggle` | Enable/disable via `openclaw mcp configure` |
| POST | `/api/agents/:name/mcp/test-url` | Test URL reachability |
| POST | `/api/agents/:name/mcp/probe` | Live probe via `openclaw mcp probe --json` |

## Components

File: `src/client/src/pages/AgentDetail.jsx` — `McpTab` function (lines 1009-1252).
