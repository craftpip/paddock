# MCP (in the Commands pane)

MCP server management for an agent lives in the **Commands** mode (the old
dedicated MCP tab was removed in the SPA migration). Configured servers show as
chips; all **actions paste `openclaw mcp ...` commands into the docked
terminal** — buttons never call a backend action API. This flow is
openclaw-only; other agent types manage MCP through their driver buttons (see
[commands.md](commands.md)).

> Last updated: 2026-11-12

## The rule: paste commands, not APIs

Every MCP action in `CommandsPane.jsx` builds an `openclaw mcp ...` command and
`run(cmd)`s it into the docked terminal (the terminal is the interface; the old
backend routes that wrapped `docker exec openclaw mcp ...` headlessly are a
trap that bypasses the visible terminal):

- **Add server** — the prompt modal collects name + transport + URL/command,
  then runs:
  - HTTP: `openclaw mcp add &lt;name&gt; [--no-probe] --url &lt;url&gt; --transport &lt;transport&gt;`
  - stdio: `openclaw mcp add &lt;name&gt; --command &lt;cmd&gt; [--no-probe]`
  - A **"Test MCP connection"** checkbox (default checked = the probe runs;
    unchecked appends `--no-probe`).
- **Remove server** — chip × runs `openclaw mcp unset &lt;name&gt;`.
- **Toggle / test / probe** — the old `/mcp/toggle`, `/mcp/probe`, `/mcp/test-url`
  buttons no longer exist in the UI; equivalent behaviour is via the terminal
  (`openclaw mcp probe --json`, etc.).

**Read-only GETs are still fine** — the configured-server chips load from
`GET /api/agents/:name/mcp` (openclaw-specific: reads `mcp.servers` from
`/root/.openclaw/openclaw.json`, and curl-probes reachability of HTTP servers).

## API surface (app.js)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:name/mcp` | List configured MCP servers (chips) — the only endpoint the UI still calls |
| POST | `/api/agents/:name/mcp/add` | Legacy headless add — no longer used by the UI (CommandsPane pastes the command instead) |
| POST | `/api/agents/:name/mcp/remove` | Legacy headless unset — unused |
| POST | `/api/agents/:name/mcp/toggle` | Legacy headless configure — unused |
| POST | `/api/agents/:name/mcp/test-url` | Legacy reachability probe — unused |
| POST | `/api/agents/:name/mcp/probe` | Legacy headless probe — unused |

The POST routes are kept for backward compatibility but are **not** wired to the
SPA.

The routes live in `src/routes/agent-integrations.js`. Two rules hold for the POST routes, which
build a shell string that runs inside the PAD:

- **Every caller-supplied value is single-quoted** before it joins the command: the server name,
  URL, transport, command, each argument, the working directory, each `KEY=value` and the
  timeout. A server name is required and is otherwise passed as given; quoting, not a name
  pattern, is what keeps it from being read as shell.
- **`test-url` validates the URL and probes from inside the PAD.** The URL must parse and be
  `http` or `https` (`400` otherwise). The probe is a `curl` run in the PAD, where the MCP server
  will be used from, so it reaches only what the PAD can reach. An unreachable URL answers
  `{ ok: false, error }`, a reachable one `{ ok: true, status }`.

The driver `mcp` command builders that CommandsPane pastes into the terminal quote their values
the same way (`sq` in `src/services/drivers/mcp-util.js`).

## Components

- `src/client/src/pages/agent/CommandsPane.jsx` — MCP group (Add server, Remove
  server) + server chips
- The shared prompt modal (`src/client/src/lib/prompt.jsx`) supports
  `type: 'select'` (with `options` as strings or `{value,label}`),
  `type: 'checkbox'` (with `defaultValue`, `checkLabel`, `hint`), and
  conditional visibility via `when(values)` — used to show the URL field only
  for HTTP transports and the command field only for stdio.
