# Plan 36b — Agent Profiles · Subtask: Opencode research

## Status: Complete (2026-08-09) — research complete + live-verified on
`pad-opencode-test3` (opencode 1.18.15). Docs surveyed (opencode.ai/docs:
agents, config, permissions, tui, cli) + CLI/DB verified: agent list/create
(interactive + non-interactive), markdown agent files (global + project),
`--agent`/`--dir` selection, session DB schema (project/workspace/session),
auth store. Test artifacts cleaned up (built-in agents only remain).
Implementation 0%.

> Sub-file of `plans/36-agent-profiles.md`. This file holds the Opencode-specific
> research; the sibling `36-<type>-profiles.md` files cover the other agent
> types. Read the main plan first.

## Scope

Opencode has a built-in **agents** concept (`opencode agent list/create`).
Research verdict: **OpenCode does not support profiles**. Its agents are
persona presets, not isolated instances. They share config, credentials,
sessions, and data, while the working directory is selected per launch, never
per agent. Do not add an Agent Profiles action group for OpenCode. Document
`--agent` as a persona selector and use separate PADs when state isolation is
required.

## Findings (all verified 2026-08-09)

### What an opencode "agent" is

- **Two kinds:**
  - **Primary agents** (build, plan) — main assistants you talk to; cycle with
    **Tab** / `switch_agent` keybind. Build = default, all tools. Plan =
    restricted (edits/bash ask).
  - **Subagents** (general, explore, scout) — invoked by primaries or
    `@mention`. General = full tools (no todo); explore = fast read-only;
    scout = read-only external docs/deps.
  - Hidden system primaries: compaction, title, summary (auto-run, not
    selectable).
  - Custom agents: `mode: primary | subagent | all`.
- An agent = **description + mode + optional model + prompt + permissions +
  temperature/steps/etc.** It is a *persona preset*, not a separate runtime.

### Where agents live (verified in container + docs)

- **JSON:** `agent` key in config — global `~/.config/opencode/opencode.json`,
  project `opencode.json` (merged; later sources override). In our container
  the global root is `/root/.opencode/config/opencode/` (XDG_CONFIG_HOME).
- **Markdown:** `~/.config/opencode/agents/<name>.md` (global) or
  `.opencode/agents/<name>.md` (per-project). File name = agent name.
- Verified: writing `agents/researcher.md` made `researcher (primary)` appear
  in `opencode agent list` and `opencode debug config`. Project-level verified
  with `.opencode/agents/projagent.md` in `/tmp/projtest`.
- Extra dirs via `OPENCODE_CONFIG_DIR`. Precedence: remote → global →
  `OPENCODE_CONFIG` → project → `.opencode` → `OPENCODE_CONFIG_CONTENT` →
  managed.
- `default_agent` picks the default primary (verified via inline config
  `{"default_agent":"plan"}`); falls back to `build` if invalid/subagent.

### State isolation — NONE between agents (the big difference vs Hermes)

- All agents share **one instance**: one config, one credential store
  (`/root/.opencode/data/opencode/auth.json` — "0 credentials" on this PAD),
  one session DB (`opencode.db`), one data dir.
- No per-agent memory, sessions, workspace, or credentials.

### Working directory — per-LAUNCH, never per-agent

- There is **no per-agent cwd**. The working directory is chosen at launch:
  - `opencode` → current dir
  - `opencode /path/to/project` → that dir (project positional)
  - `opencode run --dir /path` → that dir (verified in CLI help + live)
  - combine with `--agent <name>`: `opencode run --agent plan --dir /tmp "test"`
    ran live in plan mode on `pad-opencode-test3`.
- **Isolation by project, not by agent:** session DB schema (verified) has
  `project` (keyed by `worktree` directory), `workspace` (FK→project), `session`
  (FK→workspace). Sessions/workspaces are scoped to the project directory you
  launched in. So a "separate workspace" in opencode = a different project dir,
  not a different agent.

### Creating agents (Paddock recipe implications)

- `opencode agent create` — interactive wizard (save location, description →
  LLM generates prompt + **auto-derives the agent name**, permission picker).
- Non-interactive with `--path --description --mode --permissions`: **still
  calls the LLM** to generate the prompt and names the agent from the
  description (description "Read-only security auditor" → agent
  `read-only-security-auditor`). Verified live.
- **Gotcha:** `--path` appends `agents/` (passing `.../agents` created
  `.../agents/agents/<name>.md`, listed as `agents/<name>`). Use `--path
  <config-root>`.
- **Deterministic LLM-free method (best for CommandsPane):** write the markdown
  file directly:
  ```
  mkdir -p ~/.config/opencode/agents
  cat > ~/.config/opencode/agents/<name>.md <<'EOF'
  ---
  description: What the agent is for
  mode: primary          # or subagent
  model: opencode/big-pickle
  permission:
    edit: deny
    bash: deny
  ---
  <system prompt body>
  EOF
  opencode agent list    # verify it appears
  ```
- Generated files use frontmatter with **explicit deny** for every
  not-allowed permission (read/glob/grep/bash/task/webfetch/websearch/lsp/
  skill/question/external_directory/doom_loop…).

### Credentials / providers

- Credentials are **global and shared** by all agents (`auth.json`); a
  per-agent `model` can target different providers.
- This PAD has OpenCode Zen built in (`opencode/*` — `big-pickle` default plus
  free models), so `opencode run` works with 0 explicit credentials.

### Paddock mapping

- Existing CommandsPane **Agent** group already has `opencode agent list` /
  `opencode agent create`.
- Keep the existing **Agent** group as a persona-management group only. Do not
  add profile creation or state-isolation actions for OpenCode. A future
  command may select a persona with `opencode --agent <name>` or
  `opencode run --agent <name> --dir <dir>`, but it must not be labelled as
  profile creation.
- OpenCode Web (built-in web app, port 8080) exposes the agent switcher in the
  browser.

## Checklist

- [x] Survey opencode docs + CLI for the agents/profiles concept
- [x] Verify agents = persona presets (prompt/model/mode/permissions), NOT isolated instances
- [x] Verify no per-agent state isolation (shared config/auth/session DB)
- [x] Verify working directory is per-launch (`opencode [project]`, `run --dir`), never per-agent
- [x] Verify project-scoped session isolation (DB schema: project/workspace/session)
- [x] Verify agent create (interactive + non-interactive, auto-named from description)
- [x] Verify markdown agent files (global + project) live
- [x] Verify credential scoping (global auth.json shared)
- [x] Clean up test agents; built-ins only remain
- [ ] Map recipe into Paddock driver / CommandsPane (implementation)
