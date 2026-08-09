# Plan 37c — Commands Tab Audit · Subtask: Picoclaw

## Status: In progress (2026-08-09) — channels/cron/skills buttons added + verified live on `pad-picoclaw-asdsa`. Open decision: picoclaw MCP (bump base image vs defer).

> Sub-file of `plans/37-commands-button-audit.md`. Read the main plan first.

## Installed CLI (source of truth)

picoclaw **0.2.5** (`sipeed/picoclaw:v0.2.5-launcher`) in the test PAD. Verified
`--help`: `auth` (login/logout/models/status/wecom/weixin) · `skills`
(install/install-builtin/list/list-builtin/remove/search/show) · `cron`
(add/disable/enable/list/remove) · `gateway` (start) · `model` (show/set only).

**Two doc mismatches, both confirmed absent in v0.2.5:**
- `picoclaw mcp …` — in the official docs but **not in the installed CLI**.
- `picoclaw model add -b/-k` — not in v0.2.5; `model` only shows/sets.

## Driver inventory (`src/services/drivers/picoclaw.js`)

**Groups now:** Status (status, version, model) · Auth (status, models, login,
logout, weixin, wecom) · Channels (gateway) · Cron (list, add, enable, disable,
remove) · Skills (list, list-builtin, install-builtin, search, install, show,
remove) · Other (update, migrate --dry-run).

## Essential-groups coverage

| Group    | add                  | list                 | remove               | update                |
|----------|----------------------|----------------------|----------------------|-----------------------|
| Providers| ✅ auth login (OAuth/paste) | ✅ auth status/models | ✅ auth logout | ✅ model (set default) |
| Channels | ✅ auth weixin/wecom | ❌ no list command   | ❌ no remove command | ✅ gateway            |
| MCP      | ❌ not in v0.2.5     | ❌                   | ❌                   | ❌                    |
| Skills   | ✅ install / install-builtin | ✅ list / list-builtin | ✅ remove {name} | ✅ search (❌ no check/update) |

## Changes made this plan (all verified)

- **Auth:** `auth weixin` (WeChat QR), `auth wecom` (WeCom QR).
- **Channels (new group):** `gateway` (start the messaging gateway).
- **Cron:** `enable {id}`, `disable {id}`, and `remove {id}` now form-backed.
- **Skills:** `install-builtin`, `show {name}`, `remove {name}` (danger).

## Open decision — MCP

Docs describe `picoclaw mcp` but v0.2.5 has no such command. Options:
1. **Bump base image** to a newer launcher tag that ships `mcp` (verify first
   in a throwaway — the golden rule forbids random containers, so test via a
   recreated PAD), then add the MCP group.
2. **Defer** MCP buttons until the image is bumped; keep the `❌ not in v0.2.5`
   row as the documented state.

Also considered and rejected: `model add` (does not exist in v0.2.5).
A "Re-onboard" button for `picoclaw onboard` (already in `setupSteps`) is a
candidate future addition.

## Verification

- Browser: Commands tab on `pad-picoclaw-asdsa` renders all groups (27 buttons)
  with no console errors.
- Every added subcommand verified with `picoclaw <cmd> --help` in the container.

## Checklist

- [x] Audit current picoclaw driver buttons
- [x] Verify v0.2.5 CLI surface (auth/skills/cron/gateway/model/mcp)
- [x] Add weixin/wecom channels, gateway group, cron enable/disable, skills
      install-builtin/show/remove
- [x] Verify live in browser + container
- [ ] **Decide MCP path: bump image vs defer** (awaiting user call)
