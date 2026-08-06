# Goal 7 — Docker MCP (openclaw)

## Status: Planned (2026-08-06)

## Goal

Document and verify the docker MCP setup for openclaw/picoclaw agents with the
"Allow docker" checkbox on. No autoconfig — the user adds the MCP server
manually through the existing MCP commands flow, and we make sure the command
is right and documented.

## Details

### 1. Verify the exact command

Check the current docs (https://docs.openclaw.ai) and npm for the right MCP
server and invocation. Candidates:

- `openclaw mcp add docker -- npx -y mcp-server-docker`
- Docker's official `docker-mcp` package (`npx -y docker-mcp`)
- The `docker mcp` subcommand if the image's docker CLI supports it

Pick the one that actually works with the socket mount and record it here.

### 2. Test on a real PAD

- Pick a PAD with "Allow docker" on (socket mount present).
- Run the verified `openclaw mcp add` from the MCP commands in the terminal.
- Confirm the MCP tool appears in `openclaw mcp list` / tools list and that a
  docker call works end to end (e.g. ask the agent to run `docker ps`).

### 3. Document it

- Add the docker MCP command to the MCP commands group so it shows up as a
  one-click button. After Goal 1 this group lives in the openclaw driver
  (`commands`); before that it is the hardcoded CommandsPane MCP group.
- Note the dependency: the MCP alone is useless without the socket mount — the
  settings checkbox is the real gate.

## Files

- **Modified** `src/services/drivers/openclaw.js` (MCP commands group) — after
  Goal 1; otherwise the CommandsPane MCP group in the frontend
- Possibly a doc note in the driver or Commands page

## Progress

- [ ] Verify exact MCP server package + command against current docs
- [ ] Confirm a PAD with the socket mount
- [ ] Run `openclaw mcp add docker` on it
- [ ] MCP tool appears in list / tools
- [ ] Agent can call docker end to end (e.g. `docker ps`)
- [ ] Command documented in the MCP commands group
- [ ] Dependency on the socket mount noted in the UI/docs

## Verification

```bash
docker exec <pad> openclaw mcp list            # docker server present
# in chat: ask the agent to run docker ps via the MCP tool → real output
```

## Open questions

- Do we also wire docker MCP for opencode/codex/claude later? They configure
  MCP through their own CLIs (opencode config, codex `config.toml`,
  `.mcp.json`) — parked here, noted in their drivers.
