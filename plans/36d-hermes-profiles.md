# Plan 36d — Agent Profiles · Subtask: Hermes research

## Status: In progress (2026-08-09) — research complete + live-verified against
`pad-hermes-sup` (hermes v0.20.0): profile create/inspect/delete round-trip,
cwd resolution, and a code walk of `profiles.py` + `tools/environments/local.py`.
No profile has been created in a real PAD yet (implementation 0%).

> Sub-file of `plans/36-agent-profiles.md`. This file holds the Hermes-specific
> research; the sibling `36-<type>-profiles.md` files cover the other five
> agent types. Read the main plan first.

## Scope

Hermes is the type with **first-class profiles** (`hermes profile …`). A
profile is a full Hermes agent — every feature (config, .env, SOUL.md, memory,
sessions, skills, cron, gateway, MCP, model) — but its **state lives in its own
directory**. The critical, non-obvious finding: **a profile does NOT get its
own working directory automatically** — you must set `terminal.cwd`.

## Findings (all verified 2026-08-09)

### Profile model

- `hermes profile create/list/use/show/describe/rename/delete/export/import`
  is a first-class CLI feature (v0.20.0, confirmed in our container).
- **A profile = a fully independent `HERMES_HOME` directory.** Own `config.yaml`,
  `.env`, `SOUL.md`, memories, sessions, skills, cron jobs, gateway state,
  `state.db`. Verified live: `hermes profile create researchtest` produced
  `/opt/data/profiles/researchtest/` with empty `workspace/`, `memories/`,
  `sessions/`, `cron/`, `logs/` subdirs, own `.env` + `SOUL.md`, 71 bundled
  skills — nothing shared with the default home.
- **The default profile is special** — it IS the root `HERMES_HOME` itself
  (`hermes profile show default` → `Path: /opt/data` in our deployment).
  It accumulates everything over time (71 skills + memories + sessions + kanban
  board + cron into context), which is why it underperforms.
- **State isolation is by `HERMES_HOME`, NOT by working directory.** Two
  processes must never share one profile home — both write memory and each
  loads the other's writes into its system prompt.

### Docker/Paddock layout

- When `HERMES_HOME` points outside `~/.hermes` (ours: `/opt/data`), profiles
  live under `HERMES_HOME/profiles/<name>/` — confirmed from
  `profiles.py::_get_profiles_root()` and live (profile landed at
  `/opt/data/profiles/researchtest/`).
- **Profile aliases:** every profile becomes a command — `hermes profile create
  coder` yields `coder chat` / `coder gateway start` / etc. Wrapper at
  `~/.local/bin/<name>` = `exec hermes -p <name> "$@"`.
- `hermes gateway list` lists all profiles + gateway status.

### The critical gotcha — working directory

- **A profile does NOT change the working directory.** `terminal.cwd` defaults
  to `.` = "the directory Hermes was launched from" — in our container that is
  `/opt/data` (container WORKDIR), i.e. the default profile's home. Verified
  empirically: launching `hermes -p researchtest chat` from `/opt/data`
  resolves the terminal cwd to `/opt/data`, NOT the profile's `workspace/`.
- **No auto-cd exists.** The only `os.chdir` in hermes startup is a cwd
  *restore* (`main.py:2584`). The scaffolded `workspace/` subdir is never
  entered automatically.
- **Fix:** `hermes -p <name> config set terminal.cwd /absolute/path`. Official
  docs warn: *"Asking the model 'what directory are you in?' is not a reliable
  isolation test — set `terminal.cwd` explicitly."*
- **Profiles do NOT sandbox the filesystem.** Same OS-user access as the base
  agent; our container-wide write boundary is `HERMES_WRITE_SAFE_ROOT=/opt/data`
  regardless of profile. "Isolation" = clean state dir + separate cwd, not a
  security boundary.

### Context size / why the default feels bad

- Hermes injects a **live git/workspace snapshot** into the system prompt when
  cwd is a code workspace (git repo or `package.json`/`pyproject.toml`
  markers) — `agent/coding_context.py`. Point a profile's `terminal.cwd` at a
  project and that whole tree lands in context.
- Our hermes container mounts only `/opt/data` (its own home) and has **no
  docker socket** (CLI present, `/var/run/docker.sock` absent). The default
  profile's cwd `/opt/data` is neither a git repo nor a project root — its
  bloat is accumulated *state*, which a fresh profile eliminates.

### Operational notes specific to Paddock

- **Gateway supervision:** the official image s6-supervises per-profile
  gateways, but our `start.sh` overrides the s6 entrypoint with tini. A
  profile's gateway therefore runs as a plain process in our deployment — no
  auto-restart slot. Handle explicitly if a profile's gateway must stay up.
- Fresh profiles have **no API keys** — they inherit keys from the shell
  environment, or run `<name> setup` / `hermes -p <name> auth add`. A blank
  profile also has **no config.yaml** until first write (defaults apply).

## Paddock driver facts (src/services/drivers/hermes.js)

- `dataDir`/`workspaceDir`: `/opt/data` (fixed, `workspaceCapability: 'none'`).
- `configFile`: `config.yaml` (yaml, served/written verbatim).
- `setupSteps`: `hermes setup --non-interactive`.
- No profile command group in the CommandsPane today — candidate to add
  (create / set cwd / use / list).

## Verification

- Live-tested on `pad-hermes-sup`: create profile → inspect dir layout →
  cwd-resolution check → delete. All behaved as documented above.
- Remaining: create a profile via the planned recipe on a real PAD, prove the
  chat starts in the new cwd (not `/opt/data`), and prove state is written
  under `HERMES_HOME/profiles/<name>/`.

## Checklist

- [x] Confirm `hermes profile …` CLI surface (list/create/use/delete/show)
- [x] Confirm profile = independent `HERMES_HOME`; inspect live layout
- [x] Confirm default profile = root home (`/opt/data`)
- [x] Confirm profiles root in Docker layout (`HERMES_HOME/profiles/`)
- [x] Confirm profile does NOT auto-change working dir (code + empirical)
- [x] Confirm `terminal.cwd` fix + no filesystem sandboxing
- [x] Confirm coding-context (workspace snapshot) mechanism
- [x] Note Paddock-specific gateway supervision caveat
- [ ] Decide naming/placement + `terminal.cwd` target per profile
- [ ] Prove profile chat starts in new cwd on a real PAD (implementation)
