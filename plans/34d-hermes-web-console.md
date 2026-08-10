# Sub-goal 34d — Hermes Web Console (Web Dashboard, 9119)

## Status: Proposed (2026-08-10) — 0/4 items. Research done in plan 34; implementation not started.

Progress checklist:

- [ ] `webApp` descriptor in `src/services/drivers/hermes.js`
- [ ] `startCommand` with `HERMES_DASHBOARD_BASIC_AUTH_*` env + stable `_SECRET`
- [ ] `start.sh` hook block at `/opt/data`
- [ ] Rebuild image + live verify

Parent: `plans/34-web-publish-all-drivers.md`. Depends on 34a. Research
details in parent §"hermes — pad-hermes-sup".

## Scope

**No Dockerfile change** — web/pty extras are already baked (fastapi + uvicorn,
prebuilt UI at `/opt/hermes/hermes_cli/web_dist`); `hermes dashboard
--skip-build --no-open` works.

`src/services/drivers/hermes.js` — add `webApp`:

- `label: 'Web Dashboard'`
- `containerPort: 9119`, **`containerPortEditable: true`** (takes `--port`)
- `auth: { target: 'env', envKeys: ['HERMES_DASHBOARD_BASIC_AUTH_USERNAME',
  'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD',
  'HERMES_DASHBOARD_BASIC_AUTH_SECRET'] }`
- `startCommand`:
  `HERMES_DASHBOARD_BASIC_AUTH_USERNAME='...'
  HERMES_DASHBOARD_BASIC_AUTH_PASSWORD='...' HERMES_DASHBOARD_BASIC_AUTH_SECRET='...'
  hermes dashboard --host 0.0.0.0 --port <cport> --no-open --skip-build`

Auth facts (verified live):

- Fails closed: 0.0.0.0 with no auth provider → `Refusing to bind dashboard to
  0.0.0.0 …` and no listen. `--insecure` is a NO-OP since the June 2026
  hardening.
- With `_BASIC_AUTH_USERNAME`/`_PASSWORD`: binds 0.0.0.0, `auth_required: true`,
  all sensitive `/api/*` 401 without a session.
- Login: `POST /auth/password-login {provider:"basic", username, password}` →
  `hermes_session_at` cookie.
- **Set a stable `_SECRET`** — sessions are HMAC-signed; without it they're
  signed with a random per-process secret (invalidated on restart).

`start.sh` hook block — at `/opt/data`, before the keep-alive line: the
dashboard is a **separate process** (gateway does not serve it) — background it
with an idempotent port-probe.

## Acceptance

- `GET /api/agents/:name/web` returns the descriptor.
- Publish → dashboard 200 at the host port, `/login` gate, sensitive `/api/*`
  401 without session.
- Recreate survives; sessions survive restarts (stable `_SECRET`).

## Files

- **Modified** `src/services/drivers/hermes.js` — `webApp` + dashboard startCommand
- **Modified** `src/vm-builds/hermes/start.sh` — hook block at `/opt/data`
