# Sub-goal 34a — Shared Web-Publish Mechanism

## Status: Proposed (2026-08-10) — 0/4 items. Research done in plan 34; nothing built yet.

Progress checklist:

- [ ] Generalize `readHookPassword` → `readWebAuth(driver, name)`
- [ ] Add `applyWebAuth` / `removeWebAuth` (openclaw config patch with backup + rollback)
- [ ] Fix `webChanged` to include the password (password-only changes re-apply)
- [ ] Generic `start-web.sh` boot-hook block in all three `start.sh` + instance backfill

Parent: `plans/34-web-publish-all-drivers.md`. This sub-goal is the
**do-first** shared infra that unblocks 34b/34c/34d. Details live in the
parent's research; this file is the work contract.

## Scope

`src/services/vm-manager.js`:

- **`readWebAuth(driver, name)`** — generalize `readHookPassword`
  (vm-manager.js:1550-1555, hardcoded `OPENCODE_SERVER_PASSWORD='...'` regex):
  - `auth.target: 'env'` → existing regex (opencode, picoclaw, hermes).
  - `auth.target: 'openclaw.json'` → parse `gateway.auth.*` (only openclaw uses
    a config file).
- **`applyWebAuth(name, driver, password)` / `removeWebAuth(name, driver)`** —
  for **openclaw** only, patch `openclaw.json` (`gateway.bind: "lan"` +
  `gateway.auth` token/password), keeping a backup for rollback. picoclaw/hermes
  auth is env-var inside `startCommand` — nothing to patch. Called from
  `applyAgentChanges` step 1 (before compose regen) and by REST `POST /web`
  when the password changes; old values restored by `rollbackAgentChanges`.
- **`webChanged` password fix** — currently compares only
  `hostPort:containerPort` (vm-manager.js:2013-2014); add
  `readWebAuth(driver, name) !== opts.web.password` so password-only changes
  flow through the recreate (required for openclaw config patches to apply).

`src/vm-builds/{openclaw,picoclaw,hermes}/start.sh`:

- Add the generic hook block
  `if [ -f <dataDir>/start-web.sh ]; then bash <dataDir>/start-web.sh || true; fi`
  (mirror the `ensureSshStartBlock` backfill pattern — do NOT require manual
  rebuilds).
- Placement differs per driver — see 34b/34c/34d for the exact position.

`src/app.js`:

- Wire the auth patch + password into `POST /web` if needed (currently passes
  `opts.web.password` through `prepareAgentChanges`; verify it reaches
  `applyWebAuth`).

## Acceptance

- Password-only web change triggers a recreate + auth re-apply (not a silent no-op).
- Publish on openclaw persists `gateway.bind: lan` + auth; unpublish restores the
  backup (old auth/bind).
- No start.sh boot-hook regressions on existing instances.

## Files

- **Modified** `src/services/vm-manager.js` — `readWebAuth`/`applyWebAuth`/
  `removeWebAuth`, `webChanged` password fix
- **Modified** `src/app.js` — wire password into `POST /web` if needed
- **Modified** `src/vm-builds/{openclaw,picoclaw,hermes}/start.sh` — generic hook block
