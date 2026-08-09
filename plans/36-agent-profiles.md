# Plan 36 — Agent Profiles

## Status: In progress (2026-08-09) — research is complete for OpenCode and
Hermes (2/6); OpenClaw, Picoclaw, Codex, and Claude remain. Implementation 0%.
The research distinguishes true isolated profiles from coding-agent persona or
background-agent features that share state and therefore are not profiles.

## Goal

**Agent Profiles = persistent, isolated personal-agent identities inside one
PAD.** A profile must have a documented isolation boundary for its state, and
must not be confused with a coding agent's persona, subagent, or background
task. We research each agent type and expose profiles only where the agent
actually supports them. Where it does not, Paddock documents the limitation
and keeps the one-PAD-per-isolated-agent model.

Each agent type gets its own research file (below). The recurring question for
every type is the **Hermes gotcha**: does the profile/agent get its own
working directory automatically, or must it be set explicitly? And what state
is actually isolated (config, credentials, sessions, memory, workspace)?

## Research sub-files

| Agent type | Subtask file | Status | Test PAD(s) |
|---|---|---|---|
| OpenClaw | `plans/36a-openclaw-profiles.md` | Proposed (not started) | `pad-openclaw-work-pls` |
| Opencode | `plans/36b-opencode-profiles.md` | Complete research; no profile feature | `pad-opencode-aic`, `pad-opencode-paddock-dev`, `pad-opencode-test3`, `pad-opencode-user-test` |
| Picoclaw | `plans/36c-picoclaw-profiles.md` | Proposed (not started) | `pad-picoclaw-asdsa` |
| Hermes | `plans/36d-hermes-profiles.md` | In progress (research done, live-verified) | `pad-hermes-sup` |
| Codex | `plans/36e-codex-profiles.md` | Proposed (not started) | `pad-test-codex`, `pad-codex-wstest` |
| Claude | `plans/36f-claude-profiles.md` | Proposed (not started) | none running — may need a new test PAD |

## Cross-cutting research questions (asked of every type)

1. Does the type support multiple isolated personal-agent profiles? Record
   persona, subagent, and background-task features separately; they do not
   qualify as profiles when state is shared.
2. What state does a profile isolate: config only, or also credentials,
   sessions, memory, workspace?
3. **Working directory:** when a profile is active, where do terminal commands
   start? For Hermes, use the workspace selected by the user as
   `terminal.cwd`; never assume profile activation changes cwd.
4. Credential/API-key scoping — shared or per profile?
5. Gateway/daemon per profile (and how it is supervised in our Paddock images)?
6. How to surface the result in Paddock: a CommandsPane profile group only for
   true profiles (`paste <agent> …` rule), or a clear limitation note for
   shared-state personas and one-PAD-per-agent types.

## Hermes summary (the completed reference — detail in `36d-hermes-profiles.md`)

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
  applies to all). The user's selected workspace is passed to each profile as
  `terminal.cwd`; it is a working-directory choice, not a security boundary.
  In our images, per-profile gateways run as plain processes (our `start.sh`
  overrides the s6 entrypoint).

## Implementation steps (after research)

- [ ] **1. Complete per-type research** in the six sub-files above (docs + CLI
      survey, then live verification on each type's test PAD where available).
- [ ] **2. Classify each type** as true profile support, shared-state persona,
      ephemeral background agent, or one-PAD-per-agent. Do not add profile
      buttons for the last three categories.
- [ ] **3. Design the CommandsPane actions** for true profiles: list, create,
      select/use, set the user-selected workspace as cwd, and delete. Each
      action must say exactly what it pastes into the terminal, shell-quote
      user values, and require confirmation before destructive deletion.
- [ ] **4. Codify only approved actions** in `src/services/drivers/*.js` and
      `CommandsPane.jsx`. Driver metadata may describe simple commands; a
      multi-step recipe needs explicit UI handling rather than pretending one
      generic button can safely perform it.
- [ ] **5. Document** in `docs/` (per style guide): put the cross-driver model
      and limitations in `docs/overview/business-logic.md`, the per-driver
      classification and command reference in `docs/backend/drivers.md`, and
      the CommandsPane behavior in `docs/tabs/overview.md`.

## Button design and current implementation gap

Only a type classified as a true profile gets profile buttons. For Hermes, the
planned CommandsPane group is:

- **List profiles** — paste `hermes profile list`.
- **Create profile** — prompt for a profile name, then paste the create command
  followed by `hermes -p <name> config set terminal.cwd <user-workspace>`.
- **Use profile** — prompt for a name and paste the verified Hermes profile
  selection/launch command. This changes which profile the next terminal agent
  command uses; it does not change the workspace.
- **Delete profile** — prompt for a name, show a destructive confirmation, and
  paste the verified delete command.

The current generic driver-button path handles one command with shell-quoted
scalar fields, but it does not yet provide a safe multi-step recipe or generic
destructive confirmation. That is the implementation problem to solve before
adding the Hermes buttons. The solution must remain terminal-paste based: no
headless profile action API. The final implementation should either add a
small profile-specific flow in `CommandsPane.jsx` or extend command metadata
with explicit recipe and confirmation support; it must not hide a chain of
unquoted shell commands inside a generic driver string.

OpenCode gets no profile buttons. Its existing **Agent** buttons remain
persona-management actions, and the other types get profile buttons only after
their research proves persistent state isolation.

## Verification

- Hermes profile create/inspect/delete and cwd behavior were already tested on
  `pad-hermes-sup`; the final recipe must repeat this with the user's selected
  workspace as `terminal.cwd`.
- Before delivery, for every type classified as a true profile, create two
  profiles and verify separate config/state/session or memory directories,
  credential scoping, the intended workspace cwd, and gateway/process behavior.
  Run the profiles concurrently where the type supports gateways. Delete both
  profiles and verify no test state remains.
- For every type not classified as a true profile, verify the shared-state
  limitation and document the correct alternative instead of creating a
  misleading profile action.
