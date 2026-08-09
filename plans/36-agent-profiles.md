# Plan 36 — Agent Profiles

## Status: In progress (2026-08-09) — research sub-files created for **all six**
agent types (openclaw, opencode, picoclaw, hermes, codex, claude). Hermes
research done + live-verified on `pad-hermes-sup` (profile create/inspect/
delete round-trip, cwd resolution). The other five types: **research not
started** (0/5). Implementation 0% — no profile has been created in a real PAD
yet.

## Goal

**Agent Profiles = the internal multi-agent capability of each agent type.**
Most agents already have an option to create multiple "profiles" / agents /
identities inside themselves (we know Hermes does — `hermes profile create`).
We research **how agent management works in each agent type**, so a Paddock
user can create **multiple agents inside one agent** (one PAD) instead of
spinning up a whole new PAD per agent.

Each agent type gets its own research file (below). The recurring question for
every type is the **Hermes gotcha**: does the profile/agent get its own
working directory automatically, or must it be set explicitly? And what state
is actually isolated (config, credentials, sessions, memory, workspace)?

## Research sub-files

| Agent type | Subtask file | Status | Test PAD(s) |
|---|---|---|---|
| OpenClaw | `plans/36a-openclaw-profiles.md` | Proposed (not started) | `pad-openclaw-work-pls` |
| Opencode | `plans/36b-opencode-profiles.md` | Proposed (not started) | `pad-opencode-aic`, `pad-opencode-paddock-dev`, `pad-opencode-test3`, `pad-opencode-user-test` |
| Picoclaw | `plans/36c-picoclaw-profiles.md` | Proposed (not started) | `pad-picoclaw-asdsa` |
| Hermes | `plans/36d-hermes-profiles.md` | In progress (research done, live-verified) | `pad-hermes-sup` |
| Codex | `plans/36e-codex-profiles.md` | Proposed (not started) | `pad-test-codex`, `pad-codex-wstest` |
| Claude | `plans/36f-claude-profiles.md` | Proposed (not started) | none running — may need a new test PAD |

## Cross-cutting research questions (asked of every type)

1. Does the type support multiple isolated agents/profiles/identities, and
   what is the CLI/config surface (`hermes profile`, `opencode agent`,
   `codex --profile`, …)?
2. What state does a profile isolate: config only, or also credentials,
   sessions, memory, workspace?
3. **Working directory:** when a profile is active, where do terminal commands
   start? Does it follow the profile, or the launch dir (Hermes gotcha)?
4. Credential/API-key scoping — shared or per profile?
5. Gateway/daemon per profile (and how it is supervised in our Paddock images)?
6. How to surface this in Paddock so a user can create an agent inside a PAD:
   a CommandsPane command group per driver (`paste openclaw …` rule) —
   create / set cwd / switch / list.

## Hermes summary (the completed reference — detail in `36-hermes-profiles.md`)

- Profiles are **first-class**: `hermes profile create/list/use/delete`, each
  profile = an independent `HERMES_HOME` (own config, .env, SOUL.md, memory,
  sessions, skills, cron, gateway, state.db). Aliases: `coder chat` =
  `hermes -p coder chat`. Docker layout: `/opt/data/profiles/<name>/`.
- The **default profile** is the root home itself (`/opt/data`) — accumulates
  everything, which is why it underperforms; a fresh profile is clean.
- **Gotcha:** a profile does NOT get its own working directory automatically —
  `terminal.cwd` defaults to the launch dir (`/opt/data`). Fix:
  `hermes -p <name> config set terminal.cwd /absolute/path`.
- Profiles do NOT sandbox the filesystem (`HERMES_WRITE_SAFE_ROOT=/opt/data`
  applies to all). In our images, per-profile gateways run as plain processes
  (our `start.sh` overrides the s6 entrypoint).

## Implementation steps (after research)

- [ ] **1. Complete per-type research** in the six sub-files above (docs + CLI
      survey, then live verification on each type's test PAD).
- [ ] **2. Decide the create-agent-in-agent recipe per type** — commands for
      create, set working dir, switch, list, delete. Where the type cannot
      isolate (candidate: picoclaw, claude), document "one PAD per agent".
- [ ] **3. Codify in drivers** (`src/services/drivers/*.js`): a CommandsPane
      group per type so profile/agent creation is one paste-into-terminal
      action per the paste-commands rule (no backend action API).
- [ ] **4. Document** in `docs/` (per style guide) — the Agent Profiles model,
      the per-type commands, and the working-directory gotcha.

## Verification

- Hermes round-trip already proven live on `pad-hermes-sup`.
- Before delivery: for each type, create a profile/agent on its test PAD,
  prove the chat starts in the intended working dir, prove state is isolated
  (written under the profile's own dir), then clean up.
