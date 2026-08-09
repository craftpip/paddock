# Plan 37b — Commands Tab Audit · Subtask: Opencode

## Status: Complete (2026-08-09) — buttons added + verified live on `pad-opencode-test3`. The remaining gaps below are all N/A (the opencode CLI has no such feature), documented as notes — nothing actionable left.

> Sub-file of `plans/37-commands-button-audit.md`. Read the main plan first.

## Installed CLI (source of truth)

opencode **1.18.15** in the test PAD. Verified `--help` for: `mcp` (add/list/
auth/logout/debug), `models` (--refresh), `session` (list/delete), `plugin
<module>`, `providers` (list/login/logout).

## Driver inventory (`src/services/drivers/opencode.js`)

**Groups now:** Model (providers list/login/logout, models, models --refresh) ·
Session (session list, stats, export, session delete) · MCP (list, add, auth,
logout, debug) · Agent (list, create) · Plugin (install) · Other (--version,
debug info, debug config, upgrade).

## Essential-groups coverage

| Group    | add                  | list                 | remove               | update                |
|----------|----------------------|----------------------|----------------------|-----------------------|
| Providers| ✅ providers login   | ✅ providers list    | ✅ providers logout  | ✅ models --refresh   |
| Channels | ➖ (no messaging)    | ➖                   | ➖                   | ➖                    |
| MCP      | ✅ mcp add           | ✅ mcp list          | ❌ no CLI remove (config edit) | ✅ mcp auth/logout/debug |
| Skills   | ➖ file-based SKILL.md (no CLI) | ➖         | ➖                   | ➖                    |

## Changes made this plan (all verified)

- `models --refresh` — refresh the models.dev cache.
- `session delete {sessionID}` — form-backed (danger).
- `mcp logout {name}` / `mcp debug {name}` — form-backed.
- New **Plugin** group: `opencode plugin {module}` (form-backed).
- `mcp remove` deliberately omitted — the CLI has no such subcommand; removal
  is a config edit (note in button context via desc where relevant).

## Remaining gaps (not shipped)

- `opencode -c` (continue last session) — no button.
- No doctor/backup/profile surface exists in the CLI.
- Channels/skills are N/A (documented, not buttons).

## Verification

- Browser: Commands tab on `pad-opencode-test3` renders all 6 groups (24
  buttons) with no console errors.
- Backend: `registry.test.js` passes after driver changes.

## Checklist

- [x] Audit current opencode driver buttons
- [x] Add models --refresh, session delete, mcp logout/debug, Plugin group
- [x] Verify live in container (`opencode mcp --help` etc.) + browser
