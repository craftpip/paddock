# Plan 36a — Agent Profiles · Subtask: OpenClaw research

## Status: Proposed (2026-08-09) — research not started. 0/6 research items done.

> Sub-file of `plans/36-agent-profiles.md`. This file holds the OpenClaw-specific
> research; the sibling `36-<type>-profiles.md` files cover the other agent
> types. Read the main plan first.

## Scope

Can OpenClaw run multiple isolated agents — via personas, identities, config
profiles, or multiple data dirs — analogous to Hermes profiles? If yes, does
the working directory / workspace follow the isolated identity (the Hermes
gotcha), or is it fixed? The goal: the correct way to run one OpenClaw agent
per purpose without state bleed.

## Paddock driver facts (src/services/drivers/openclaw.js)

- `dataDir`: `/root/.openclaw` · `workspaceDir`: `/root/.openclaw/workspace`
  (`workspaceCapability: 'fixed'` — the CLI requires its workspace there).
- `configFile`: `openclaw.json` (json).
- `setupSteps`: `openclaw setup --baseline`.
- Commands groups: config validate/file, security audit, doctor, status/gateway.
- AGENTS.md gotcha: `openclaw models auth paste-api-key` destroys the whole
  `openclaw.json` — save/merge back.

## Research questions

1. Does OpenClaw have personas/identities/profiles (e.g. `openclaw persona` /
   `--identity` / `OPENCLAW_` env overrides)? What CLI surface exposes them?
2. Can multiple independent configs + workspaces coexist (per-persona
   workspace vs the fixed `/root/.openclaw/workspace`)?
3. When an identity/profile is active, where does the working directory resolve?
   Does it follow the identity (Hermes-style gotcha) or is the workspace fixed?
4. Credentials/API keys: shared vs per-persona?
5. Any gateway/daemon per persona?
6. How would this map onto Paddock (CommandsPane command group, data dir
   handling, config.js read/write with the paste-api-key caveat)?

## Verification

- Test PAD: `pad-openclaw-work-pls` (openclaw, running).
- Steps: query the CLI surface (`openclaw --help`, persona/identity docs),
  create a second identity if supported, prove state + cwd isolation live,
  then delete/clean up.

## Checklist

- [ ] Survey OpenClaw docs + CLI for persona/identity/profile surface
- [ ] Verify multiple isolated config/state dirs are possible
- [ ] Verify working-directory behavior when identity is active
- [ ] Verify credential scoping
- [ ] Live-test on `pad-openclaw-work-pls`
- [ ] Map findings onto Paddock driver / CommandsPane
