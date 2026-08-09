# Plan 37d — Commands Tab Audit · Subtask: Hermes

## Status: In progress (2026-08-09) — deprecated auth fixed + MCP/Plugins/Cron/Skills/Sessions expanded; verified live on `pad-hermes-sup`.

> Sub-file of `plans/37-commands-button-audit.md`. Read the main plan first.

## Installed CLI (source of truth)

hermes **v0.20.0 (2026.8.3)** in the test PAD. Verified `--help`:
- `auth` — add/list/remove/reset/status/logout/spotify
- `mcp` — serve/add/remove/list/test/configure/login/reauth/picker/catalog/
  install
- `skills` — browse/search/install/inspect/list/check/update/audit/uninstall/
  reset/list-modified/diff/opt-out/opt-in/repair-official/publish/snapshot/tap/
  config
- `cron` — list/create/edit/pause/resume/run/remove/status/runs/tick
- `sessions` — list/export/delete/prune/archive/optimize/…/stats
- `plugins` — install/update/remove/list/enable/disable
- `logs` — [agent|errors|gateway|gui|desktop] with -n/-f/--level

## Driver inventory (`src/services/drivers/hermes.js`)

**Groups now:** Status · Model · **Auth (fixed)** · Gateway · Cron · Skills ·
**MCP (new)** · Memory · Sessions · **Plugins (new)** · Other.

## Essential-groups coverage

| Group    | add                  | list                 | remove               | update                |
|----------|----------------------|----------------------|----------------------|-----------------------|
| Providers| ✅ `auth add {provider}` | ✅ `auth list`     | ✅ `auth logout {provider}` | ✅ model/fallback |
| Channels | ✅ gateway setup     | ✅ gateway list/status | ⚠️ partial (via gateway profiles) | ✅ gateway restart |
| MCP      | ✅ `mcp add {name}` / `mcp install {id}` | ✅ mcp list | ✅ `mcp remove {name}` | ✅ test/catalog/serve |
| Skills   | ✅ skills install    | ✅ skills list       | ✅ `skills uninstall {name}` | ✅ search/check/update |

## Defect fixed (critical)

**`hermes login`/`hermes logout` were deprecated** — the CLI says "Use `hermes
auth` to manage credentials, `hermes model` to select a provider". Every click
of the old buttons printed a deprecation warning (or failed). Replaced with:
`auth list`, `auth add {provider}`, `auth status {provider}`, `auth logout
{provider}` (form-backed for the provider arg).

## Changes made this plan (all verified)

- **Auth:** new auth subcommands (see above); deprecated login/logout removed.
- **MCP (new group):** list, catalog, install {identifier}, add {name}, remove
  {name}, test {name}, serve.
- **Cron:** added status, pause {job_id}, resume {job_id}, remove {job_id}.
- **Skills:** added search {query}, check, update, uninstall {name}.
- **Sessions:** added export, stats.
- **Plugins (new group):** list, install {identifier}, enable {name}, disable
  {name}.
- **Other:** added `logs -n 100`.

## Remaining gaps (not shipped)

- **Profiles** — `hermes profile create/list/use/delete` are high-value but
  tracked under **plan 36** (`36d-hermes-profiles.md`), not here.
- `sessions delete/prune`, `skills audit/config`, `cron edit`, `hermes
  security audit`, `hermes dump`, `hermes tools`, `hermes setup` button —
  candidates for a later pass (need forms or extra research).
- Form-backed commands require `fields` (implemented this plan); zero-arg
  commands run bare.

## Verification

- Browser: Commands tab on `pad-hermes-sup` renders all groups; the
  `auth add` form pasted `hermes auth add 'openrouter'` into the terminal
  (confirmed in the activity log).
- Every added subcommand verified with `hermes <cmd> --help` in the container.
- Backend: `registry.test.js` passes.

## Checklist

- [x] Audit current hermes driver buttons
- [x] Verify v0.20.0 CLI surface (auth/mcp/skills/cron/sessions/plugins/logs)
- [x] Fix deprecated login/logout → auth subcommands
- [x] Add MCP + Plugins groups; expand Cron/Skills/Sessions/Other
- [x] Verify live in browser + container
- [ ] Profiles → defer to plan 36 (not this plan's scope)
