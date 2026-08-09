# Plan 37e — Commands Tab Audit · Subtask: Codex

## Status: In progress (2026-08-09) — driver rebuilt from broken stubs; verified live on `pad-test-codex`.

> Sub-file of `plans/37-commands-button-audit.md`. Read the main plan first.

## Installed CLI (source of truth)

**codex-cli 0.147.0** in the test PAD. Verified `--help`:
- `login` (interactive / `status` subcommand / `--with-api-key` reads stdin),
  `logout`
- `mcp` — list/get/add/remove/login/logout
- `plugin` — list/add/marketplace/remove
- `resume [--last]`, `review [PROMPT]`, `exec [PROMPT]`, `doctor`, `update`,
  `apply <TASK_ID>`, `features`

## The bug that started this plan

The old driver's "Session" group was two `--help` stubs: `codex exec --help`
and **`codex eval --help`**. Running `codex eval --help` confirmed there is
**no `eval` subcommand** — codex treats `eval` as an interactive prompt and
prints the generic root help. The button was broken/misleading.

## Driver inventory (`src/services/drivers/codex.js`)

**Groups now:** Provider (login, login status, logout) · MCP (list, get {name},
add {name}, remove {name}, login {name}, logout {name}) · Session (resume
--last, review) · Plugin (list, marketplace, add {name}, remove {name}) ·
Health (doctor) · Other (--version, update, --help).

## Essential-groups coverage

| Group    | add                  | list                 | remove               | update                |
|----------|----------------------|----------------------|----------------------|-----------------------|
| Providers| ✅ `codex login`     | ✅ `login status`    | ✅ `codex logout`    | ➖ (no model selector)|
| Channels | ➖ (no messaging)    | ➖                   | ➖                   | ➖                    |
| MCP      | ✅ `mcp add {name}`  | ✅ `mcp list`        | ✅ `mcp remove {name}` | ✅ get/login/logout  |
| Skills   | ➖ file-based (no CLI) | ➖                  | ➖                   | ➖                    |

## Changes made this plan (all verified)

- Removed the broken `codex eval --help` and `codex exec --help` stubs.
- Added the Provider, MCP, Session, Plugin, Health and Update commands above;
  arg-taking commands are form-backed (`{name}` / `{identifier}`).

## Remaining gaps (not shipped)

- `codex exec` / `codex apply <TASK_ID>` — need a prompt/TASK_ID from an
  external source; not clean button material.
- `codex sandbox`, `codex mcp-server`, `codex fork/archive/delete`, `codex
  features` — lower value; candidates for a later pass.
- Channels/skills are N/A (no messaging; skills are file-based).

## Verification

- Browser: Commands tab on `pad-test-codex` renders all 6 groups (22 buttons)
  with no console errors.
- Every added subcommand verified with `codex <cmd> --help` in the container.
- Backend: `registry.test.js` passes.

## Checklist

- [x] Audit current codex driver buttons (found broken `eval` stub)
- [x] Verify codex-cli 0.147.0 surface (login/mcp/plugin/session/doctor/update)
- [x] Rebuild driver: Provider/MCP/Session/Plugin/Health/Other groups
- [x] Verify live in browser + container
