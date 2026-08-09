# Plan 36e — Agent Profiles · Subtask: Codex research

## Status: Proposed (2026-08-09) — research not started. 0/6 research items done.

> Sub-file of `plans/36-agent-profiles.md`. This file holds the Codex-specific
> research; the sibling `36-<type>-profiles.md` files cover the other agent
> types. Read the main plan first.

## Scope

Codex CLI has a **profiles** concept in its config (`config.toml`, `codex
--profile <name>`?). Research whether these are true isolated agents (own
state, cwd, credentials) or just alternate config sets — and how the working
directory behaves per profile (the Hermes gotcha applies by default unless
`terminal.cwd` is set, so the codex analogue must be pinned down).

## Paddock driver facts (src/services/drivers/codex.js)

- `dataDir`: `/root/.codex` · `workspaceDir`: `/root/.codex/workspace`
  (`workspaceCapability: 'editable'`).
- `configFile`: `config.toml` (toml — served/written verbatim, no redaction).
- `setupSteps`: none (config created on first run).
- `tuiCommand`: `codex`.
- Commands groups: provider (login/logout), MCP, session, plugin, doctor.
- No messaging channels; skills are file-based.

## Research questions

1. Does codex support profiles (`codex --profile <name>`, `profile = [...]` in
   config.toml)? Where is profile state stored (`~/.codex/profiles/...`?)
2. What does a profile isolate: config only, or also auth/sessions/state?
3. Working-directory behavior per profile — does it follow the profile, the
   launch cwd, or a `terminal.cwd`-style setting?
4. Credentials: shared (`~/.codex/auth.json`) or per-profile?
5. Any gateway/daemon per profile (codex has no messaging channels)?
6. How would this map onto Paddock (CommandsPane group, verbatim toml config
   handling)?

## Verification

- Test PADs: `pad-test-codex`, `pad-codex-wstest` (codex, running).
- Steps: survey CLI + docs, create a test profile, prove state/cwd isolation,
  then clean up.

## Checklist

- [ ] Survey codex CLI + docs for the profiles concept
- [ ] Verify profile state isolation (config-only vs full)
- [ ] Verify per-profile working-directory behavior
- [ ] Verify credential scoping across profiles
- [ ] Live-test on a running codex PAD
- [ ] Map findings onto Paddock driver / CommandsPane
