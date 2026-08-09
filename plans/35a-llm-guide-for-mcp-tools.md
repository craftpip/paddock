# Plan 35a — LLM guide for MCP tools: how an LLM drives Paddock through the MCP surface (tool guide + non-interactive command catalog)

## Status: Draft (2026-08-09) — raw requirements recorded; research on the core
catalog commands verified live against a running openclaw PAD (v2026.7.1);
credential-insertion and authorization flow designed; nothing implemented yet.

> **Task A of plan 35 (renamed from plan 33, 2026-08-09).** Plan 35 is ONE plan
> with TWO **simultaneous** tasks — they do not block each other, they exist
> for each other. Task A (this file) makes the Paddock MCP surface descriptive
> and usable by the LLM; Task B (`35b-paddock-mcp-for-agents.md`) wires Paddock's
> MCP server into the agents. The two are kept as separate, independent files
> that reference each other. Read the sibling before or after this one.

> **The goal of this plan:** give the LLM a better understanding of **how to use Paddock** —
> what Paddock is, what the LLM can do through it, which commands exist, which are
> interactive vs non-interactive, and how to run them perfectly through the MCP `exec` tool.
> The result is a first-class LLM usage guide (a "how to use Paddock" document + the
> mechanism that serves it), not a hidden manual.
>
> The concrete first use-case is creating MCP entries in the containers (adding models +
> adding MCP tools), but the mechanism — a non-interactive command catalog + guidance — is
> the general answer to "how does an LLM drive Paddock".

## Raw requirements (as dictated, kept verbatim)

1. **New option: create MCP entries in the containers** — add MCP servers into an agent's
   container (e.g. `openclaw mcp add ...`). Scoped by the twist: **only for the MCP tools
   that will be exposed to the LLM**.
2. The human path already exists: MCP entries are created today through the web terminal in
   the Paddock web UI (CommandsPane → MCP → "Add server" pastes `openclaw mcp add ...` into
   the docked terminal).
3. When this web UI is being **controlled by an LLM** (via Paddock's `/mcp` server), we will
   just have to **guide the LLM** on what the commands are for a tool and how to use those
   commands.
4. We already expose the **`exec`** MCP tool — the LLM can use it to make changes in config
   files. We will have to somehow tell/guide the LLM about everything so that it does it
   perfectly.
5. **The two things the LLM must be able to do via MCP:**
   - Adding **models** (to an agent container)
   - Adding **MCP tools** (to an agent container)
6. The MCP surface has many tools, but those tools only **control Paddock**. All other agent
   configuration is done in the terminal **by the user** — the same will be done here through
   MCP tool calls (the LLM runs the commands via `exec`).
7. **Guidance source:** the agent driver already has the tool definitions we use — the
   `commands` groups in `src/services/drivers/*.js`, served to the Commands tab and rendered
   as buttons.
8. **The problem:** those tool definitions, when sent to the LLM, will be different. We must
   create **two different tool definitions**, because some of the tools in the driver
   definitions are **interactive** (need a TTY / user input), but when the LLM calls a tool it
   must be **non-interactive**. ⇒ Categorize the tool definitions into **interactive** and
   **non-interactive**.
9. **When the MCP calls the tool, send it ONLY the non-interactive tools** (the commands).
10. For **all the buttons/commands** we have, identify which are interactive commands, then
    find an **alternative non-interactive command** to send to the LLM when it is called via
    MCP.

## What the guide must cover

The plan is to build a full "how to use Paddock" guide for an LLM. Section 5 (the command
catalog) is the core; sections 1–4 give the LLM the context it needs to use the tools
correctly instead of guessing.

### 1. What Paddock is

- A management dashboard ("control plane") for a fleet of **agent containers (PADs)** of
  several types: openclaw, opencode, picoclaw, hermes, codex. Each PAD is a container;
  Paddock manages its lifecycle, config, workspace, web publishing, SSH, extra ports, and
  health.
- **Where the boundary sits:** the MCP tools control **Paddock** (the fleet, the containers).
  Configuration *inside* a container is the agent's own business — normally done by the user
  in the terminal, and by the LLM through the `exec` tool. The guide must state this boundary
  explicitly so the LLM knows which tool to reach for.

### 2. The MCP tool surface — how the LLM controls Paddock

The 17-tool surface (live, plan 30). The guide documents each tool: when to use it, what it
needs, what it returns.

**Read / inspect**

| Tool | What it's for |
|---|---|
| `list_agents` | fleet summary (name, status, type) — pick a PAD |
| `get_agent` | full agent object; `logs` (≤500 lines) includes recent container logs |
| `agent_logs` | standalone `docker logs` tail (≤5000), persists across recreates |
| `config_get` | driver config file, driver-aware (JSON parsed + secrets redacted; yaml/toml verbatim) |
| `settings_get` | **the ONE read tool** — the full picture before a change (see §3) |
| `health` | the Settings-tab checkup — diffs declared compose vs live container, per-check detail, works on stopped containers |
| `workspace_list` / `workspace_read` / `workspace_write` | browse / read / write the agent's workspace files (path-traversal safe, text ≤256 KB) |

**Control**

| Tool | What it's for |
|---|---|
| `create_agent` | create a PAD (bare name → prefixed; `confirm: true` required; caller becomes owner) |
| `start_agent` / `stop_agent` / `restart_agent` | lifecycle; these also start/stop the socat door with the agent |
| `recreate` | **the ONE mutation gun** — every Settings-tab + Web-tab option is an arg; only specified options change |
| `update` | alias for `recreate {pull:true}` (update to latest image) |
| `delete_agent` | remove container, door, network, instance dir (`confirm: true`, no undo) |

**Exec**

| Tool | What it's for |
|---|---|
| `exec` | run any shell command inside a PAD (`docker exec -i sh -lc`) — the vehicle for agent-config commands (models, MCP servers, skills, …) |

### 3. Caller rules / pitfalls (must be in the guide)

- **Read-tool discipline:** run `settings_get` first; it returns everything (settings, ssh,
  workspace mount, volumes/ports, image/version, networkHealth, web publish state,
  availableNetworks) so the LLM reconstructs the picture before mutating.
- **Change only what you specify:** `recreate` leaves every unspecified option untouched.
  `undefined` = keep; `[]` / `''` / `false` = explicit clear. Never default an option.
- **confirm-gated tools:** `create_agent` (heavy, adds a fleet member), `delete_agent`
  (destructive), `recreate` with `reset: true` (wipes the data dir). The LLM must pass
  `confirm: true` and only after checking with the user.
- **No TTY in `exec`:** commands that demand a TTY (`openclaw onboard`,
  `openclaw configure --section model`, `openclaw models auth login`) hang or fail. Use the
  non-interactive alternatives from the catalog (§5).
- **Write-only secrets:** `sshPassword` / web `password` are never returned by any read tool;
  an empty string means "keep current". Never echo them back.
- **Never expose secrets:** `config_get` redacts JSON secrets; don't ask for or report raw
  keys/tokens beyond what a command needs.
- **Tool names have no `paddock_` prefix** — the consuming client namespaces them itself.
- **Verification habit:** after any mutation (recreate, start/stop, config change), re-run the
  matching read tool (`settings_get`, `get_agent`, `health`, `exec`-driven `openclaw mcp list`
  / `models status`) and confirm the state before reporting success.

### 4. Workflow recipes

Numbered, end-to-end recipes the guide gives the LLM:

1. **Survey the fleet:** `list_agents` → `get_agent` (or `agent_logs`) for detail/logs.
2. **Inspect before changing anything:** `settings_get` → (optional) `config_get`, `health`.
3. **Create a PAD:** `create_agent` (bare name, agent type, `confirm: true`, optional
   allowDocker/network/workspace/ssh/ports). Verify with `get_agent` + `settings_get`.
4. **Update to latest:** `update` (or `recreate {pull:true}`). Config/data survive (bind
   mounts).
5. **Change a setting / web / ssh / ports:** one `recreate` with only the options that change.
6. **Health check / explain why down:** `health` (works on stopped containers).
7. **Work in the workspace:** `workspace_list` / `workspace_read` / `workspace_write`.
8. **Add a model to an agent** (first required capability): see §5 Models catalog — read
   `models status`/`auth list` via `exec`, then the non-interactive add path, then verify.
9. **Add an MCP server to an agent** (second required capability): see §5 MCP catalog — read
   `mcp list` via `exec`, then `openclaw mcp add ... --no-probe`, then `mcp list`/`probe`.
10. **Run one-off commands / config changes:** `exec`.
11. **Delete a PAD:** `delete_agent` (`confirm: true`, no undo).

### 5. The command catalog — interactive vs non-interactive (core chapter)

The guide's heart: for every command/button Paddock offers, the LLM gets the
**non-interactive** form. Interactive commands are either replaced by a non-interactive
alternative or marked "ask the user to run it in the terminal".

**Set A — UI/human tool definitions:** the current `driver.commands` (buttons). May be
interactive, may rely on prompt-modal collected input (CommandsPane `click:` handlers).

**Set B — LLM/non-interactive tool definitions:** a filtered version — only non-interactive
commands with full arguments pre-resolved, plus usage guidance and caveats. This is what the
MCP sends to the LLM.

**How the two sets are produced (proposal):** each command in `driver.commands` gets an
`interactive: true` marker (default: non-interactive) and, where the interactive version has a
non-interactive replacement, an `llm: { cmd, desc, caveats }` field holding the alternative
command. The MCP guidance surface serializes Set B as `{ label, cmd, desc, caveats }` per
command, grouped by category, filtered to non-interactive only. A command that is interactive
AND has no non-interactive replacement is flagged `not_llm_usable` — the guidance tells the
LLM to ask the user to run it in the terminal (or skip it).

#### Models (the LLM must be able to ADD models)

> Live-verified 2026-08-09 against `pad-openclaw-work-pls` (v2026.7.1): the
> non-interactive `models auth paste-api-key --provider <name>` subcommand
> exists and takes key via stdin. `models auth add` is the interactive helper;
> `login` runs provider OAuth flows. TTY-only commands: `login-github-copilot`,
> `setup-token`.

| Button / command today | Interactive? | Non-interactive alternative for the LLM |
|---|---|---|
| "Add provider" `openclaw configure --section model` | **YES** — interactive TUI (login, OAuth, device code) | `openclaw models auth paste-api-key --provider <name>` (key via stdin) — **CAVEAT: overwrites the whole `openclaw.json`; save the config first and merge it back** (AGENTS.md). Or `openclaw models auth login --device-code` only when a TTY is available |
| `openclaw models auth list` | no | as-is |
| "Remove provider" `openclaw gateway call models.authLogout --params '{"provider":"<id>"}' --json` | no | as-is |
| `openclaw models list` | no | as-is |
| `openclaw models status` | no | as-is |
| "Set default model" `openclaw models set <model>` | no | as-is (cron jobs store model at creation — the LLM must also run `openclaw cron update <id> --model ...` when changing a model used by cron) |

#### MCP tools (the LLM must be able to ADD MCP servers)

> Live-verified 2026-08-09 against `pad-openclaw-work-pls` (v2026.7.1): `openclaw
> mcp add <name>` takes `--url`, `--transport streamable-http|sse`,
> `--header <key=value>`, `--command`, `--no-probe`, `--include/--exclude`
> (tool filter), `--timeout/--connect-timeout`, `--disabled`. `mcp reload`,
> `mcp probe [name]`, `mcp doctor`, `mcp tools <name> --include/--exclude`
> (per-server filter, least privilege) all exist.

| Button / command today | Interactive? | Non-interactive alternative for the LLM |
|---|---|---|
| "Add server" → `openclaw mcp add <name> [--no-probe] --url <u> --transport <t>` / `--command <c>` | no, when fully parameterized | as-is, but **default `--no-probe` for LLM calls** (the probe can hang without a TTY/network) |
| "Remove server" `openclaw mcp unset <name>` | no | as-is |
| `openclaw mcp list` / `reload` / `probe [name]` / `doctor` / `tools` | no | as-is |

#### Other openclaw flows (for the same audit)

- **Messaging:** `openclaw configure --section channels` and `openclaw channels add ...` are
  interactive → no clean non-interactive replacement yet; `channels list --all` /
  `status --probe` / `capabilities` / `logs --lines 100` / `agents bindings` are fine.
- **Skills:** `openclaw configure --section skills` interactive; `skills list / check /
  search / install <ref> / update --all` non-interactive.
- **Memory:** all non-interactive (`memory status[/--deep] / index[/--force] /
  search <q> / promote --apply`).
- **Driver groups (Config/Security/Doctor/Diagnostics):** mostly non-interactive; the
  `confirm: true` destructive ones (`security audit --fix`, `doctor --fix`,
  `doctor --state-sqlite compact`) need confirm semantics in guidance, not a TTY.

#### Other drivers

picoclaw, hermes, codex, opencode each carry their own `commands` and CLI — the same
interactive/non-interactive audit applies (`picoclaw onboard`? `hermes config set`,
`hermes model` is interactive-only per AGENTS.md; `codex` TUI, etc.). To be inventoried
during implementation.

### 6. Credential insertion through MCP (required capability)

The LLM must be able to add a model/provider that requires a secret, but an MCP
tool call has no terminal prompt or TTY. `exec` therefore needs an explicit
`stdin` input in addition to `command`:

```json
{
  "name": "pad-example",
  "command": "openclaw models auth paste-api-key --provider openai",
  "stdin": "<user-supplied API key>"
}
```

Implementation contract:

- `exec.stdin` is optional, is written verbatim to the container process stdin,
  and must never be included in activity logs, process-error messages, tool
  responses, browser telemetry, or command-history output.
- The guide tells the LLM to ask the user for a provider credential only at the
  final write step. It must not place a secret in the shell command, a config
  write, or a tool result.
- The command catalog marks every operation that needs stdin as
  `credentialInput: "stdin"`, including the provider name and exact verification
  command. An interactive-only OAuth/device-login flow remains unavailable to
  MCP and must be handed to the human terminal.
- For OpenClaw, preserve `openclaw.json`, run `models auth paste-api-key` with
  `stdin`, merge the auth result back into the saved config, then run
  `openclaw models auth list` and `openclaw models status`. This prevents the
  known config-destroy behavior.
- Never return or repeat the supplied credential. Success is verified only by
  provider/model status, not by printing config or auth records.

This is distinct from the initial Paddock-MCP connection credential. That
bootstrap happens before the agent can use Paddock MCP and is specified in
plan 35b.

## Current state (context)

- The Commands-tab buttons live in the drivers: `GET /api/agent-types/:type/commands`
  (src/app.js:1331) serves `driver.commands` + `driver.tuiCommand`; `CommandsPane.jsx`
  renders them (`FlowGroup`) and the openclaw-only flows (Messaging / Models / MCP / Skills /
  Memory) are hardcoded in `CommandsPane.jsx` (lines ~750–754).
- MCP `exec` tool (src/mcp.js:490) runs `docker exec -i <pad> sh -lc '<cmd>'` — the vehicle
  the LLM uses. **No TTY is allocated**, so any command that demands a TTY will hang or fail.
- Plan 30 rule #4 already says terminal-command tools (MCP add, skills install) are NOT
  mirrored as API-backed MCP tools — they run through `exec`. This plan extends that: expose
  the **commands + guidance** to the LLM (non-interactive only), never a backend endpoint.
- `exec` runs via `sh -lc` — a login shell, so PATH fixes (hermes `/etc/profile.d`) apply.

## Guidance delivery (open question)

The LLM needs the catalog + "how to use it perfectly" text. Options:

1. **A new MCP tool** (e.g. `commands` / `agent_commands`) returning Set B for an agent type:
   `{ type, groups: [{ title, commands: [{ label, cmd, desc, caveats }] }], notUsable: [...] }`
   — plus, for the general guide (§§1–4), either a `help` tool or a static document served by
   the MCP server. The LLM reads it, then uses `exec` to run a command. (Recommended — keeps
   the guide versioned with the driver and available on demand.)
2. A markdown guide written into the agent workspace (AGENTS.md / MEMORY.md) at create time.
3. Static text embedded in the `exec` tool description (suits §5 only; too big for §§1–4).

The general guide (§§1–4) and the per-agent command catalog (§5) may be delivered
differently — e.g. a `paddock_help`-style tool returning the full guide, plus the
`commands` tool returning the catalog for a specific agent type.

## Design decisions to make during implementation

- Where the interactive/non-interactive split lives: flag on each `driver.commands` entry vs
  a separate per-driver `llmCommands` list.
- Whether the guidance tool is read-only (yes — it only returns text).
- Encoding the `paste-api-key` config-destroy caveat in the guidance text (models add).
- Defaulting `--no-probe` on LLM-built `mcp add` commands.
- How to represent "interactive-only, ask the user" commands in the guidance.
- Whether §§1–4 are served as a separate help tool or merged into one document.
- Add `stdin` to MCP `exec` as a redacted secret channel; do not attempt to
  emulate interactive prompts with shell pipes or command-string interpolation.

## Files (anticipated)

- **Modified** `src/services/drivers/*.js` — add `interactive`/`llm` fields to command
  definitions (Set B source).
- **Modified** `src/mcp.js` — new read-only guidance/help tool(s) serving the guide + Set B.
- **Modified** `src/app.js` — possibly extend `/api/agent-types/:type/commands` or add a
  guidance endpoint reused by both MCP and the frontend (shared-function rule #1).

## Open questions

- Deliver guidance via MCP tool, workspace doc, or both? Split the general guide vs the
  command catalog?
- Do we expose Set B for the human UI too (e.g. show the non-interactive command on each
  button so the user can copy it)?
- ~~Confirm `openclaw models auth paste-api-key` is still the current non-interactive way to
  add a provider~~ **ANSWERED live (2026-08-09, v2026.7.1):** yes, exists and takes the key
  via stdin; `models auth add`/`login` remain interactive. The config-destroy caveat
  (AGENTS.md) still stands and must be encoded in the guidance text.
- Where does the general guide (§§1–4) live as source of truth — duplicated in the plan, in
  `docs/`, or generated? (docs/ is the source of truth per AGENTS.md; the guide should be
  generated from `docs/` where possible.)
- The openclaw non-interactive catalog is verified; the same audit for opencode / picoclaw /
  hermes / codex / claude is still "to be inventoried" — their CLI sets differ (see sibling
  plan 35b for the per-driver MCP shapes already researched).
