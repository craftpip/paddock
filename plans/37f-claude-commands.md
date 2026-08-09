# Plan 37f — Commands Tab Audit · Subtask: Claude

## Status: Complete (2026-08-09) — claude test PAD created (`pad-test-claude`, claude 2.1.197), CLI verified live, driver buttons added + browser-verified.

> Sub-file of `plans/37-commands-button-audit.md`. Read the main plan first.

## How this was unblocked

Per the golden rule, claude buttons could not be shipped without a live PAD.
**`pad-test-claude` was created** via `POST /api/agents/create` (image:
`src/vm-builds/claude`, claude 2.1.197) and used to verify every command below
with `claude <cmd> --help`. The user granted full authority over test agents
for this.

## Driver inventory (`src/services/drivers/claude.js` — updated)

**Groups now:** Status (doctor, auth status, --version) · Auth (auth login,
auth logout, setup-token) · Session (-c, --bg {prompt}, agents --json,
agents --all --json) · MCP (list, add -t {transport} {name} {commandOrUrl},
get, remove, login, logout) · Plugin (list, marketplace, install, update,
uninstall) · Other (update, install stable).

## Essential-groups coverage (verified live)

| Group    | add                  | list                 | remove               | update                |
|----------|----------------------|----------------------|----------------------|-----------------------|
| Providers| ✅ auth login       | ✅ auth status       | ✅ auth logout       | ✅ setup-token (CI)   |
| Channels | ➖ (MCP push channels, not messaging) | | | |
| MCP      | ✅ `mcp add` (form: name+url/cmd+transport) | ✅ mcp list | ✅ `mcp remove {name}` | ✅ get/login/logout |
| Skills   | ➖ file-based `.claude/skills/` (no CLI) | ➖ | ➖ | ➖ |

## Changes made this plan (all verified live in 2.1.197)

- **MCP:** added `mcp add` (form with name + command-or-URL + transport
  select), `mcp get {name}`, `mcp remove {name}` (danger); made `mcp login`/
  `logout` form-backed (`{name}`).
- **Plugin (new group):** list, marketplace, install {plugin}, update {plugin},
  uninstall {plugin} (danger).
- **Session:** added `--bg {prompt}` (start background agent, form) and
  `agents --all --json`.
- **Removed broken button:** `claude import codex --dry-run` — **`claude
  import` does not exist in 2.1.197** (the button would have started an
  interactive session with "import" as a prompt). Confirmed via the 2.1.197
  commands list (agents/auth/auto-mode/doctor/gateway/install/mcp/plugin/
  project/setup-token/ultrareview/update).

## Corrections to the original docs-based proposal

- The plan proposed `claude stop` / `claude rm` / `claude logs` /
  `claude respawn` for background agents. **None exist in 2.1.197** — background
  agents are started with `claude --bg` and managed with the single `claude
  agents [options]` command (flags: `--json`, `--all`, `--cwd`, …). Implemented
  as such.
- `claude mcp add` needs `<name> <commandOrUrl>` plus `-t/--transport`
  (stdio/sse/http) — captured as a 3-field form.

## Verification

- Browser: Commands tab on `pad-test-claude` renders all 6 groups (26 buttons),
  no console errors; the MCP add form shows name + command-or-URL inputs and
  the transport select (stdio/http/sse).
- Backend: `registry.test.js` passes; `GET /api/agent-types/claude/commands`
  returns 200 after `docker restart paddock`.

## Checklist

- [x] Create a running claude test PAD (`pad-test-claude`)
- [x] Verify `claude mcp add/get/remove`, plugin commands, agents flags live
- [x] Apply driver changes (MCP add/get/remove, Plugin group, --bg, agents
      --all; remove broken `claude import` button)
- [x] Browser-verify Commands tab + form
- [x] Update main plan 37 status + matrix
