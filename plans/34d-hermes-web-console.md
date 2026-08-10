# Sub-goal 34d — Hermes Web Console (Web Dashboard, 9119)

## Status: Complete (2026-08-10) — 4/4 items done, live-verified end-to-end.

Progress checklist:

- [x] `webApp` descriptor in `src/services/drivers/hermes.js`
- [x] `startCommand` with `HERMES_DASHBOARD_BASIC_AUTH_*` env + stable `_SECRET`
- [x] `start.sh` hook block at `/opt/data`
- [x] Rebuild image + live verify

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

## Implementation notes

- `web.json` for hermes stores `authToken: ""` (auth is server-enforced, no
  token passed in the open-link URL); `passwordConfigured` reads the hook env
  via `readWebAuth` (env-key regex on `HERMES_DASHBOARD_BASIC_AUTH_PASSWORD`).
- **Hermes re-locks `/opt/data` to 0700 on gateway boot** (`secure_parent_dir`
  in `hermes_constants.py`) — `chmod 755` alone loses the race. start.sh now
  runs a 5s **watchdog** that re-applies 755; this is what keeps
  `readWebAuth`/`passwordConfigured` working and the webui able to traverse
  the data dir. Applied to both the template and the per-instance
  `build/start.sh` (per-instance copy must be updated too — rebuilds use it).
- **Per-instance images**: current builds tag `paddock-vm-<padname>:latest`
  (e.g. `paddock-vm-pad-hermes-sup:latest`), built from
  `instances/<name>/build/`. The stale `paddock-vm-hermes:latest` template
  image is 2 days old and NOT what containers run — don't inspect it for
  current state.
- **WebHook helper fallback verified live**: publish and unpublish both went
  through `webHookViaHelper` (root helper container) on the 10000-owned data
  dir — hook written 0755 + chown 1000, removed cleanly, container recreated.
  `web.json`/`meta.env` remain webui-owned.
- Unpublish leaves the pad **running** (it was running before publish), and
  `step 9` restores the stopped state when the pad was stopped pre-publish.
- UI gotcha during testing: the unpublish "Done" modal can sit on top and
  swallow the next publish confirm — dismiss it before re-publishing; the
  WebTab password field resets to empty after unpublish (state refresh), so a
  re-publish without re-entering the password goes out unauthenticated and
  fails closed (no dashboard).

## Acceptance

- `GET /api/agents/:name/web` returns the descriptor.
- Publish → dashboard 200 at the host port, `/login` gate, sensitive `/api/*`
  401 without session.
- Recreate survives; sessions survive restarts (stable `_SECRET`).

## Files

- **Modified** `src/services/drivers/hermes.js` — `webApp` + dashboard startCommand
- **Modified** `src/vm-builds/hermes/start.sh` — hook block at `/opt/data`
