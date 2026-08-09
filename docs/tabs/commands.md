# Commands Mode

> Last updated: 2026-08-09

The Commands mode is the default landing mode of the agent detail page — a
terminal emulator with a GUI command picker. One wrapped flow of pill buttons;
clicking a pill pastes a CLI command into the docked terminal. This page covers
the pane (`CommandsPane.jsx`), the driver command API, and the per-type button
inventory for all six agent types.

## How buttons work

### Where buttons live

Command groups live in the **agent driver**, not the frontend bundle. Each
driver in `src/services/drivers/<type>.js` exposes a `commands` array of groups
(title, color, commands):

```js
{ title: 'MCP', color: 'success', commands: [
  { cmd: 'codex mcp list', label: 'List servers', desc: 'Configured MCP servers' },
  { cmd: 'codex mcp add {name}', label: 'Add server', desc: 'Add an MCP server', fields: [
    { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem' },
  ]},
]}
```

`GET /api/agent-types/:type/commands` (`src/app.js:1365`) serves
`{ type, commands, tuiCommand }`. `CommandsPane.jsx` fetches it and renders
each group as a colored `GroupLabel` chip followed by its `Pill` buttons
(`FlowGroup`). `tuiCommand` drives the **Run TUI** button, which launches the
agent's interactive CLI in the terminal.

### Paste commands, not APIs

Every button `run(cmd)`s the command into the docked terminal — there is
deliberately **no backend action API** (AGENTS.md rule). Read-only GETs are
still fine (MCP server chips, skills list, Vault names).

### Form-backed commands (`fields`)

Any command may declare `fields`; `FlowGroup` then opens the shared prompt
modal, substitutes each `{key}` placeholder in `cmd` with the entered value
(**shell-quoted**), and pastes the result. Field types: text, `select`
(options as strings or `{value, label}`), `checkbox`, and conditional
visibility via `when(values)` — used by `claude mcp add` to show the URL field
only for remote transports. This is how arg-required commands ship as buttons
(e.g. `hermes mcp remove {name}`, `codex plugin add {name}`). Before this
support was generalized, only the openclaw flows could prompt.

### The openclaw exception

openclaw is the only type that renders extra **hardcoded flows** in the pane on
top of its driver groups: `MessagingFlow`, `ModelsFlow`, `McpFlow`,
`SkillsFlow`, `MemoryFlow` (`CommandsPane.jsx`). They are form-capable via
`usePrompt()` and show data (servers, skills, backups) as compact chips. All
other types render **only** their driver groups (`isOpenclaw` guard,
`CommandsPane.jsx:716`, `779-783`). Every type also gets the right-aligned
**Vault dropdown** — a server-side secrets exception to the paste rule: clicking
an item decrypts the value and pastes it into the terminal.

## Knowledge graph — essential groups

Legend: ✅ present as buttons · ❌ missing · ➖ not applicable (the agent has no
such feature / no CLI for it) · ⚠️ present but wrong/broken. The four "primary"
groups are Providers, Channels, MCP, and Skills.

### Providers

| Type    | add                      | list                     | remove                | update/set            |
|---------|--------------------------|--------------------------|-----------------------|-----------------------|
| openclaw| ✅ Add provider          | ✅ List added providers  | ✅ Remove provider     | ✅ Set default model   |
| opencode| ✅ `providers login`     | ✅ `providers list`      | ✅ `providers logout`  | ✅ `models --refresh`  |
| picoclaw| ✅ `auth login` (no `model add` in v0.2.5) | ✅ `auth status`/`models` | ✅ `auth logout` | ✅ `model` (set default) |
| hermes  | ✅ `auth add {provider}` | ✅ `auth list`           | ✅ `auth logout {provider}` | ✅ `model`/`fallback` |
| codex   | ✅ `codex login`         | ✅ `login status`        | ✅ `codex logout`      | ➖ (no model selector) |
| claude  | ✅ `auth login`          | ✅ `auth status`         | ✅ `auth logout`       | ✅ `setup-token` (CI)  |

### Channels / Messaging

| Type    | add                    | list                 | remove            | update                |
|---------|------------------------|----------------------|-------------------|-----------------------|
| openclaw| ✅ Add/Remove channel  | ✅ List added channels| ✅ same Add/Remove| ✅ status/logs        |
| opencode| ➖ (no messaging)      | ➖                    | ➖                | ➖                    |
| picoclaw| ✅ `auth weixin`/`wecom` | ❌ no list command  | ❌ no remove command | ✅ `gateway`      |
| hermes  | ✅ `gateway setup`     | ✅ `gateway list`/`status` | ⚠️ partial (gateway profiles) | ✅ `gateway restart` |
| codex   | ➖ (no messaging)      | ➖                    | ➖                | ➖                    |
| claude  | ➖ ("channels" are MCP-push, not messaging) | | | |

### MCP

| Type    | add                 | list            | remove            | update/auth/tools         |
|---------|---------------------|-----------------|-------------------|---------------------------|
| openclaw| ✅ Add server (form)| ✅ List servers | ✅ Remove server   | ✅ Reload/probe/doctor     |
| opencode| ✅ `mcp add`        | ✅ `mcp list`   | ❌ no CLI remove (config edit) | ✅ `mcp auth`/`logout`/`debug` |
| picoclaw| ❌ not in v0.2.5   | ❌               | ❌                 | ❌                        |
| hermes  | ✅ `mcp add {name}` / `mcp install {id}` | ✅ `mcp list` | ✅ `mcp remove {name}` | ✅ test/catalog/serve |
| codex   | ✅ `mcp add {name}` | ✅ `mcp list`   | ✅ `mcp remove {name}` | ✅ get/login/logout       |
| claude  | ✅ `mcp add -t {transport} {name} {commandOrUrl}` | ✅ `mcp list` | ✅ `mcp remove {name}` | ✅ get/login/logout |

### Skills

| Type    | add                     | list               | remove              | update/search          |
|---------|-------------------------|--------------------|---------------------|------------------------|
| openclaw| ✅ Install skill (form) | ✅ List installed  | ➖ config-based     | ✅ Check/Search/Update all |
| opencode| ➖ file-based `SKILL.md` (no CLI) | ➖       | ➖                   | ➖                     |
| picoclaw| ✅ `skills install`/`install-builtin` | ✅ `list`/`list-builtin` | ✅ `skills remove {name}` | ✅ search (no check/update) |
| hermes  | ✅ `skills install`     | ✅ `skills list`    | ✅ `skills uninstall {name}` | ✅ search/check/update |
| codex   | ➖ file-based (no CLI)  | ➖                   | ➖                   | ➖                     |
| claude  | ➖ file-based `.claude/skills/` (no CLI) | ➖ | ➖                    | ➖                     |

## Per-type group inventory

| Type    | Groups in the Commands tab |
|---------|----------------------------|
| openclaw| hardcoded flows: Messaging, Models, MCP, Skills, Memory · driver groups: Config, Security, Doctor, Diagnostics · Vault dropdown |
| opencode | Model, Session, MCP, Agent, Plugin, Other |
| picoclaw | Status, Auth, Channels, Cron, Skills, Other |
| hermes  | Status, Model, Auth, Gateway, Cron, Skills, MCP, Memory, Sessions, Plugins, Other |
| codex   | Provider, MCP, Session, Plugin, Health, Other |
| claude  | Status, Auth, Session, MCP, Plugin, Other |

Per-command button details live in the driver source
(`src/services/drivers/<type>.js`) and are summarized per driver in
[backend/drivers.md](../backend/drivers.md).

## Cross-cutting findings

1. **Buttons are only as good as the installed CLI.** Every new button must be
   validated against the running container's `--help` before shipping. The
   audit found doc-ghosts that shipped buttons for commands that do not exist:
   `codex eval` (was just `codex` with "eval" as a prompt), `claude import codex
   --dry-run`, and `picoclaw mcp` (v0.2.5 lacks the subcommand).
2. **"Channels" only exists where the agent has messaging.** opencode/codex/
   claude have no chat channels, so their row is N/A, not missing. claude's
   "channels" feature is MCP-push, not messaging.
3. **Skills are CLI-based or file-based.** openclaw/picoclaw/hermes manage
   skills via their CLI (buttons); opencode/codex/claude use file placement
   (`SKILL.md`, `.claude/skills/`) with no CLI, so they have no skill buttons.
4. **Arg-required commands need a form.** Pasting `hermes mcp remove <name>`
   bare executes with a missing argument and errors. The `fields` mechanism is
   how such commands ship as buttons.
5. **hermes `login`/`logout` were deprecated** — every click printed a
   deprecation warning (or failed). The driver now uses the `auth` subcommands
   (`auth add/list/status/logout`).

## Verified CLI versions

Buttons were audited against the installed CLIs — the source of truth — in live
test PADs:

| Type    | Version          | Test PAD              |
|---------|------------------|-----------------------|
| openclaw| audited, no changes | `pad-openclaw-work-pls` |
| opencode| 1.18.15          | `pad-opencode-test3`  |
| picoclaw| 0.2.5            | `pad-picoclaw-asdsa`  |
| hermes  | v0.20.0 (2026.8.3) | `pad-hermes-sup`     |
| codex   | codex-cli 0.147.0 | `pad-test-codex`      |
| claude  | 2.1.197          | `pad-test-claude`     |

## See Also

- [overview.md](overview.md) — the agent detail page and all its modes
- [mcp.md](mcp.md) — the openclaw MCP flow (chips + `openclaw mcp` commands)
- [skills.md](skills.md) — the openclaw skills flow
- [backend/drivers.md](../backend/drivers.md) — per-driver field values and gotchas
- [backend/services.md](../backend/services.md) — the driver registry and `getDriver()`
