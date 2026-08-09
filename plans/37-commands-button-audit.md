# Plan 37 — Commands Tab: Button Audit & Knowledge Graph (all engine types)

## Status: Complete (2026-08-09) — research 100% complete; implementation 8/8
main items done. Per-type sub-plans created for **all six** agent types
(`37a`–`37f`). Done + verified live in the browser: hermes auth fix + MCP/
Plugins/Cron/Skills/Sessions expansion; codex driver rebuilt (broken `eval`
button removed); opencode mcp logout/debug + models --refresh + session delete
+ plugin group; picoclaw channels + cron enable/disable + skills additions;
**generic form support** in CommandsPane `FlowGroup`; **claude** driver
expanded (MCP add/get/remove + Plugin group + --bg/agents, removed broken
`claude import` button) and verified live on the new `pad-test-claude`
(claude 2.1.197). Remaining nicety, not a blocker: **picoclaw MCP** (v0.2.5
ships no `picoclaw mcp`; bump image vs defer).

## Goal

Audit the **Commands tab** button surface for every agent type (openclaw,
opencode, picoclaw, hermes, codex, claude), validate it against two inputs, and
produce a knowledge graph of **what buttons exist where and which are missing**:

1. The **essential management groups** every agent type should expose —
   **Providers, Channels, MCP, Skills** — with **add / list / remove / update**
   covered where the agent actually has that capability.
2. Each agent type's **own extra features** (memory, health/doctor, backups,
   profiles, sessions, cron, gateway, plugins, …) — these must also be
   documented and manageable as buttons, not only the four "primary" groups.

Every agent type has its **own sub-plan file** (table below) with its
per-type findings, button inventory and remaining gaps. This main file holds
the shared goal, the cross-cutting matrix, the architecture context and the
global implementation checklist.

## Sub-plan files (one per agent type)

| Agent type | Sub-plan file | Status | Test PAD(s) |
|---|---|---|---|
| OpenClaw | `plans/37a-openclaw-commands.md` | Complete — audited, no changes needed (user-reviewed) | `pad-openclaw-work-pls` |
| Opencode | `plans/37b-opencode-commands.md` | Complete — buttons added + verified live | `pad-opencode-test3` |
| Picoclaw | `plans/37c-picoclaw-commands.md` | In progress — buttons added + verified live; MCP decision pending | `pad-picoclaw-asdsa` |
| Hermes | `plans/37d-hermes-commands.md` | Complete — auth fix + groups added + verified live | `pad-hermes-sup` |
| Codex | `plans/37e-codex-commands.md` | Complete — driver rebuilt + verified live | `pad-test-codex` |
| Claude | `plans/37f-claude-commands.md` | Complete — driver expanded + verified live | `pad-test-claude` |

## Architecture context (how buttons work)

- **Buttons live in the agent driver**, not the frontend bundle:
  `src/services/drivers/<type>.js` → `commands: [ { title, color, commands:
  [{ cmd, label, desc, fields }] } ]`, served via
  `GET /api/agent-types/:type/commands` (`src/app.js:1331`). The CommandsPane
  fetches these groups and renders each command as a pill button
  (`src/client/src/pages/agent/CommandsPane.jsx`, `FlowGroup` → `Pill`).
- **openclaw is the exception**: it renders 5 hardcoded flows in the pane —
  `MessagingFlow`, `ModelsFlow`, `McpFlow`, `SkillsFlow`, `MemoryFlow` (forms
  via `usePrompt()`) — PLUS its driver groups (Config/Security/Doctor/
  Diagnostics) and a Vault dropdown. All other types render **only** their
  driver groups (`isOpenclaw` guard, CommandsPane.jsx:687, 750-754).
- **Everything is paste-into-terminal.** Buttons run `run(cmd)` against the
  docked terminal; there is deliberately **no backend action API** (AGENTS.md
  rule). Commands needing input can now declare `fields` → `FlowGroup` opens
  the existing prompt modal, substitutes `{key}` placeholders (shell-quoted)
  into the command, then pastes it (implemented this plan; see cross-cutting
  finding 2).
- Installed CLI versions (verified live, the source of truth for what a button
  may actually run): opencode **1.18.15**, picoclaw **0.2.5**, hermes
  **v0.20.0 (2026.8.3)**, codex **codex-cli 0.147.0**, claude **2.1.197**
  (all verified in the test PADs listed above).

---

## Knowledge graph — Essential groups matrix

Legend: ✅ present in the Commands tab · ❌ missing · ➖ not applicable (agent
has no such feature / no CLI for it) · ⚠️ present but wrong/broken.

### Providers

| Type    | add                      | list                     | remove                | update/set            |
|---------|--------------------------|--------------------------|-----------------------|-----------------------|
| openclaw| ✅ Add provider          | ✅ List added providers  | ✅ Remove provider     | ✅ Set default model   |
| opencode| ✅ providers login       | ✅ providers list        | ✅ providers logout    | ✅ models --refresh    |
| picoclaw| ✅ auth login (no `model add` in v0.2.5) | ✅ auth status/models | ✅ auth logout         | ✅ model (set default) |
| hermes  | ✅ `auth add {provider}` | ✅ `auth list`           | ✅ `auth logout {provider}` | ✅ model/fallback |
| codex   | ✅ `codex login`          | ✅ `login status`        | ✅ `codex logout`      | ➖ (no model selector) |
| claude  | ✅ auth login             | ⚠️ auth status           | ✅ auth logout         | ✅ setup-token (CI token) |

### Channels / Messaging

| Type    | add                      | list                     | remove                | update                |
|---------|--------------------------|--------------------------|-----------------------|-----------------------|
| openclaw| ✅ Add/Remove channel    | ✅ List added channels   | ✅ (same Add/Remove)   | ✅ Check status/logs   |
| opencode| ➖                       | ➖                       | ➖                     | ➖                     |
| picoclaw| ✅ `auth weixin`/`wecom` | ❌ (no list)             | ❌ (no remove)         | ✅ `gateway`           |
| hermes  | ✅ gateway setup         | ✅ gateway list/status   | ⚠️ partial             | ✅ gateway restart     |
| codex   | ➖                       | ➖                       | ➖                     | ➖                     |
| claude  | ➖ (its "channels" = MCP push channels, not messaging) | | | |

### MCP

| Type    | add                 | list            | remove            | update/auth/tools         |
|---------|---------------------|-----------------|-------------------|---------------------------|
| openclaw| ✅ Add server        | ✅ List servers  | ✅ Remove server   | ✅ Reload/probe/doctor     |
| opencode| ✅ mcp add           | ✅ mcp list      | ❌ (no CLI remove) | ✅ mcp auth/logout/debug   |
| picoclaw| ❌ not in v0.2.5 CLI | ❌               | ❌                 | ❌                        |
| hermes  | ✅ `mcp add {name}`   | ✅ mcp list      | ✅ `mcp remove {name}` | ✅ test/catalog/install/serve |
| codex   | ✅ `mcp add {name}`   | ✅ mcp list      | ✅ `mcp remove {name}` | ✅ get/login/logout       |
| claude  | ✅ `mcp add -t {transport} {name} {commandOrUrl}` | ✅ mcp list | ✅ `mcp remove {name}` | ✅ get/login/logout |

### Skills

| Type    | add                     | list               | remove              | update/search          |
|---------|-------------------------|--------------------|---------------------|------------------------|
| openclaw| ✅ Install skill        | ✅ List installed   | ➖ (config-based)    | ✅ Search/Update all   |
| opencode| ➖ (file-based SKILL.md, no CLI) | ➖            | ➖                   | ➖                     |
| picoclaw| ✅ skills install / install-builtin | ✅ list / list-builtin | ✅ `skills remove {name}` | ✅ search (❌ no check/update) |
| hermes  | ✅ skills install       | ✅ skills list      | ✅ `skills uninstall {name}` | ✅ search/check/update |
| codex   | ➖ (file-based, no CLI) | ➖                   | ➖                   | ➖                     |
| claude  | ➖ (file-based `.claude/skills/`, no CLI) | ➖ | ➖                    | ➖                     |

---

## Cross-cutting findings

1. **Driver commands are only as good as the installed CLI.** Two mismatches
   found: picoclaw docs describe `picoclaw mcp` but installed v0.2.5 lacks it;
   the codex driver referenced `codex eval` which does not exist (it just
   started the interactive CLI with "eval" as the prompt). Every new button
   must be validated against the running container's `--help` before shipping
   (this plan did exactly that).
2. **Form support is now generalized.** Driver commands can declare `fields`;
   `FlowGroup` (CommandsPane.jsx) opens the existing prompt modal, substitutes
   `{key}` placeholders (shell-quoted) into `cmd`, and pastes the result —
   same paste-into-terminal rule, no backend action API. Before this plan only
   the openclaw flows could prompt.
3. **"Channels" only exists where the agent has messaging.** opencode/codex/
   claude have no chat channels; for them the row is N/A, not missing. claude's
   "channels" feature is MCP-push, not messaging.
4. **"Skills" is CLI-based for openclaw/picoclaw/hermes, file-based for
   opencode/codex/claude.** The latter three cannot have skill buttons; document
   them as file placement (SKILL.md) instead of a missing button.
5. **hermes `login`/`logout` deprecation** was a real defect in the shipped
   driver (every click printed a deprecation warning) — fixed via the auth
   subcommands.
6. **Arg-required commands need a form.** Pasting `hermes mcp remove <name>`
   bare executes with a missing arg and errors. The `fields` mechanism (finding
   2) is how such commands ship as buttons.

## Implementation steps (checklist)

- [x] **1. Complete per-type audit** — each type's current buttons vs its
      installed CLI + docs, recorded in its sub-plan (`37a`–`37f`).
- [x] **2. hermes** — fix deprecated Auth group; add MCP/Plugins groups; expand
      Cron/Skills/Sessions/Other. See `37d`.
- [x] **3. codex** — remove broken `eval`/`exec --help`; add Provider/MCP/
      Session/Plugin/Health/Update groups. See `37e`.
- [x] **4. opencode** — add mcp logout/debug, models --refresh, session delete,
      plugin group. See `37b`.
- [x] **5. picoclaw** — add channels, cron enable/disable, skills additions;
      MCP **decision pending** (bump image vs defer). See `37c`.
- [x] **6. Form support** in CommandsPane `FlowGroup` (driver-declared
      `fields` → prompt modal → `{key}` substitution, shell-quoted).
- [x] **7. claude** — add `claude mcp add/get/remove` (form), plugin group,
      `--bg {prompt}` / `agents --all`; removed broken `claude import codex
      --dry-run` (no such subcommand in 2.1.197). Verified live on
      `pad-test-claude`. See `37f`.
- [x] **8. Verify** every changed button live (container `--help` + browser at
      http://10.69.1.164:6789) and run backend tests. Done for all 5 CLI
      drivers.

## Verification

- Each driver change validated with `timeout 60 docker exec <pad> <cli>
  <command> --help` against the running test PADs listed in the sub-plan table.
- Browser check of the Commands tab per agent type after
  `docker restart paddock` (+ `cd src/client && npm run build` for the form
  change). Confirmed live: hermes, codex, opencode, picoclaw, claude command
  groups render and the form modal pastes a correctly shell-quoted command
  (activity log: `hermes auth add 'openrouter'`).
- claude verified on `pad-test-claude` (claude 2.1.197): all 6 groups / 26
  buttons render, MCP add form shows name + command-or-URL inputs and the
  transport select (stdio/http/sse); `claude import` confirmed absent in
  2.1.197 (removed button).

## Sources

- opencode CLI: https://opencode.ai/docs/cli/ (+ installed 1.18.15 `--help`)
- picoclaw: https://docs.picoclaw.io/docs/getting-started/,
  https://docs.picoclaw.io/docs/configuration/cli-parameters/
  (+ installed 0.2.5 `--help`)
- hermes: https://hermes-agent.nousresearch.com/docs/reference/cli-commands/
  (+ installed v0.20.0 `--help`)
- codex: installed codex-cli 0.147.0 `--help` +
  https://deepwiki.com/openai/codex/6.3-mcp-cli-commands
- claude: https://code.claude.com/docs/en/cli-reference + .../mcp
