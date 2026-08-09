# Plan 36c — Agent Profiles · Subtask: Picoclaw research

## Status: Proposed (2026-08-09) — research not started. 0/6 research items done.

> Sub-file of `plans/36-agent-profiles.md`. This file holds the Picoclaw-specific
> research; the sibling `36-<type>-profiles.md` files cover the other agent
> types. Read the main plan first.

## Scope

Picoclaw is the lightweight OpenClaw-compatible agent (`sipeed/picoclaw`).
Can it run multiple isolated agents? It ships no profiles command today, but
it has an `onboard` flow, a fixed workspace, and is openclaw-config-compatible
(`picoclaw migrate --dry-run`). Research whether multiple isolated instances
are possible at all (e.g. separate config/workspace dirs via env/CLI), and if
not, whether the "isolated agent per purpose" pattern needs a different
mechanism (separate PADs).

## Paddock driver facts (src/services/drivers/picoclaw.js)

- `dataDir`: `/root/.picoclaw` · `workspaceDir`: `/root/.picoclaw/workspace`
  (`workspaceCapability: 'fixed'`).
- `configFile`: `config.json` (json).
- `setupSteps`: `picoclaw onboard` (writes config.json + workspace non-interactive).
- Commands groups: status/model, auth (login/logout/weixin/wecom), gateway,
  cron, skills (list/install/remove), update, migrate.
- `tuiCommand`: `picoclaw agent`.

## Research questions

1. Does picoclaw have any personas/identities/multiple-config support? Check
   `picoclaw --help` subcommands + `picoclaw agent` semantics.
2. Can a second config/workspace coexist with `/root/.picoclaw` (env var
   override, `--config`, `PICOCLAW_HOME`-style)? Or is one instance per
   container the ceiling?
3. Working-directory behavior: fixed workspace, launch cwd, or configurable?
4. Credentials: single auth store, or per-instance?
5. Gateway: single process per container — can a second gateway run?
6. If isolation is impossible inside one container, the fallback is one PAD
   per agent — note that as the answer for this type.

## Verification

- Test PAD: `pad-picoclaw-asdsa` (picoclaw, running).
- Steps: survey CLI + docs, attempt a second config/workspace, prove cwd/state
  isolation or prove it is not possible, then clean up.

## Checklist

- [ ] Survey picoclaw CLI + docs for multi-instance support
- [ ] Verify whether a second config/workspace can coexist
- [ ] Verify working-directory behavior
- [ ] Verify credential + gateway scoping
- [ ] Live-test on `pad-picoclaw-asdsa`
- [ ] Map findings onto Paddock (or document "one PAD per agent" answer)
