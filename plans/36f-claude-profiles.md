# Plan 36f — Agent Profiles · Subtask: Claude research

## Status: Proposed (2026-08-09) — research not started. 0/6 research items done.
No claude PAD currently running (none exists in `instances/`) — research may
need a fresh test PAD or CLI-level checks only.

> Sub-file of `plans/36-agent-profiles.md`. This file holds the Claude-specific
> research; the sibling `36-<type>-profiles.md` files cover the other agent
> types. Read the main plan first.

## Scope

Claude Code (Anthropic) — does it support multiple isolated agents? It has a
subagents/`agents` concept and per-directory settings (`CLAUDE.md`), but no
classic "profiles" CLI. Research what multi-agent isolation looks like here
(subagents vs `.claude/` dirs vs separate PADs) and how the working directory
behaves.

## Paddock driver facts (src/services/drivers/claude.js)

- `dataDir`: `/root/.claude` · `workspaceDir`: `/root/.claude/workspace`
  (`workspaceCapability: 'editable'`).
- `configFile`: `settings.json` (json).
- `setupSteps`: none.
- `tuiCommand`: `claude`.
- Commands groups: doctor, auth (login/logout/setup-token), session (continue,
  background agents, import codex), MCP, update/install.
- No built-in web app.

## Research questions

1. What multi-agent surface does Claude Code have: subagents (`claude agents`,
   `--agent`, `--subagent`), per-directory settings, `CLAUDE.md`/AGENTS.md
   scoping? Do any behave like isolated profiles?
2. State: is there anything like per-agent/per-project isolated state, or is
   everything under `/root/.claude` + the launch directory?
3. Working-directory behavior: launch-cwd-bound (Hermes-style gotcha) — is
   there a config for a default project dir per agent?
4. Credentials: single Anthropic account/auth shared across everything?
5. Background agents (`claude agents`) — do they run isolated?
6. If true isolation is impossible, the answer for this type is "one PAD per
   agent" — document that.

## Verification

- No claude PAD exists today. Options: check against `claude --help` + docs,
  or propose creating a test PAD for live verification.
- Steps: survey CLI + docs, live-test multi-agent behavior on a claude PAD if
  one is created, then clean up.

## Checklist

- [ ] Survey Claude Code docs + CLI for agents/profiles/workspace concepts
- [ ] Verify state isolation surface (subagents, .claude dirs)
- [ ] Verify working-directory behavior
- [ ] Verify credential scoping
- [ ] Decide live-test path (create a claude test PAD?) and verify
- [ ] Map findings onto Paddock driver / CommandsPane (or "one PAD per agent")
