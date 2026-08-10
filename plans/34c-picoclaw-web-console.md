# Sub-goal 34c — Picoclaw Web Console (Launcher Dashboard, 18800)

## Status: Proposed (2026-08-10) — 0/4 items. Research done in plan 34; implementation not started.

Progress checklist:

- [ ] `webApp` descriptor in `src/services/drivers/picoclaw.js`
- [ ] `startCommand` backgrounds the launcher (idempotent port-probe)
- [ ] `start.sh` hook block at `/root/.picoclaw`
- [ ] Rebuild image + live verify (decide whether the boot hook also enables `channels.pico`)

Parent: `plans/34-web-publish-all-drivers.md`. Depends on 34a. Research
details in parent §"picoclaw — pad-picoclaw-asdsa".

## Scope

Key correction (locked in parent): the picoclaw web console is the **launcher
dashboard** (`picoclaw-launcher`, separate process, port 18800), NOT the
gateway. The gateway (18790, `picoclaw gateway -E`) only serves the pico chat
WebSocket at `/pico/ws` — root `/` returns 404, no console HTML.

`src/services/drivers/picoclaw.js` — add `webApp`:

- `label: 'Web Console'`
- `containerPort: 18800`, **`containerPortEditable: true`** (launcher takes `-port`)
- `auth: { target: 'env', envKey: 'PICOCLAW_LAUNCHER_TOKEN' }` (dashboard token
  is random per run unless pinned via this env; verified via
  `/api/auth/status` → `token_help.env_var_name`)
- `startCommand({password, containerPort})`:
  `PICOCLAW_LAUNCHER_TOKEN='...' picoclaw-launcher -console -no-browser
  -public -port <cport>` — the launcher is a background process like opencode's
  web server, so `start-web.sh` backgrounds it with an idempotent port-probe.

`start.sh` hook block — at `/root/.picoclaw`, before the keep-alive line
(launcher coexists fine with the gateway started by start.sh; it attaches and
reports its own gatekeeping).

Optional chat plumbing: the dashboard proxies chat to the gateway's `/pico/ws`,
which needs `channels.pico.enabled: true` + token. Decide during implementation
whether the boot hook also enables it (chat works without further config if pico
is already enabled, as on the test PAD).

## Acceptance

- `GET /api/agents/:name/web` returns the descriptor.
- Publish → launcher dashboard 200 at the host port, `/launcher-login` gate,
  `/api/*` 401 without cookie.
- Recreate survives (hook re-launches the launcher); unpublish cleans up.

## Files

- **Modified** `src/services/drivers/picoclaw.js` — `webApp` + launcher startCommand
- **Modified** `src/vm-builds/picoclaw/start.sh` — hook block at `/root/.picoclaw`
