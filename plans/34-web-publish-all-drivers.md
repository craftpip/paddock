# Plan 34 — Web Publishing for All Drivers

## Status: In progress (2026-08-09) — research + live verification done
(terminology locked: "web console"), implementation 0/3. opencode web
publishing (the reference mechanism) is live; extending to openclaw, picoclaw,
and hermes is not started. All three consoles were **tested live on running
PADs today** (openclaw on pad-openclaw-work-pls, picoclaw on
pad-picoclaw-asdsa, hermes on pad-hermes-sup) — console behavior, auth, and
bind requirements are verified first-hand; see "Live verification" below.

Progress checklist:

- [x] Terminology locked ("web console")
- [x] Survey: which drivers ship a web console (4/6)
- [x] Live-verify openclaw console (bind modes, auth gate, fail-closed)
- [x] Live-verify picoclaw console (launcher dashboard, token login)
- [x] Live-verify hermes console (fails closed, env auth, login flow)
- [ ] Shared mechanism in vm-manager.js (readWebAuth/applyWebAuth/webChanged)
- [ ] openclaw driver webApp + boot-hook config patch
- [ ] picoclaw driver webApp + start-web.sh launcher hook
- [ ] hermes driver webApp + start-web.sh dashboard hook
- [ ] start.sh hook blocks (3 images rebuilt) + instance backfill
- [ ] WebTab.jsx: Start button, read-only fixed ports, peer-collision warning
- [ ] Per-driver live verification (publish/recreate/unpublish/door/rollback)
- [ ] Absorb into docs (web.md status) and close plan

## Terminology — "web console"

The agent's built-in browser UI is called the **web console** — Paddock's own
term, chosen 2026-08-09 after an ecosystem survey. The **terminal** is the
agent's CLI surface; the **web console** is its browser surface; **publishing**
is the act of exposing the console on a host port. The plan's old phrasing
("web publishing", "web app", "web UI") means exactly this. Each driver's own
vendor name is kept in the UI copy: openclaw **Control UI** (Gateway Dashboard
+ WebChat), hermes **Web Dashboard**, picoclaw **web console + chat**, opencode
**web**.

## Which agents have a web console (survey, 2026-08-09)

6 agent types exist; **4 ship a built-in web console, 2 do not**:

| Driver | Web console? | Name (vendor) | Default port | Status |
|--------|--------------|---------------|--------------|--------|
| opencode | ✅ | OpenCode Web (`opencode web`) | 8080 | **live** (reference mechanism) |
| openclaw | ✅ | Control UI + WebChat (Gateway-served) | 18789 | live-verified today |
| picoclaw | ✅ | **Launcher dashboard** (`picoclaw-launcher`) | **18800** | live-verified today |
| hermes | ✅ | Web Dashboard (`hermes dashboard`) | 9119 | live-verified today |
| codex | ❌ | none — terminal TUI only | n/a | `webApp: null` |
| claude | ❌ | none — terminal TUI only | n/a | `webApp: null` |

> Correction: picoclaw's web console is NOT the gateway (18790). The gateway
> only serves the pico **chat WebSocket** at `/pico/ws`; the actual console is
> the separate **launcher dashboard** process on port **18800**. Confirmed live
> 2026-08-09.

## Live verification (2026-08-09, all first-hand)

### openclaw — pad-openclaw-work-pls (2026.7.1)

- Gateway runs as PID 1 (`openclaw gateway run`), Control UI served at
  **`http://<host>:18789/`** → HTTP 200, `<title>OpenClaw Control</title>`.
- **Auth gate live**: `GET /control-ui-config.json` → **401** without
  `Authorization: Bearer <token>`, **200** with it. `gateway.auth.mode: token`
  (or `password`), key `gateway.auth.token`.
- **`gateway.bind` takes symbolic modes, NOT an IP**: allowed
  `auto | lan | loopback | custom | tailnet`. `"0.0.0.0"` is rejected with
  `gateway.bind: Invalid input`. `lan` = listen 0.0.0.0 (tcp4+tcp6).
- **Bind changes need a FULL gateway restart**: writing `bind: lan` triggers
  "config change requires gateway restart (gateway.bind)" and an **in-process
  SIGUSR1 restart that keeps the old sockets** (loopback stayed). Only a fresh
  process (container restart) applied `lan` → `LISTEN 0.0.0.0:18789`.
  Implication: PAD publish should patch openclaw.json **before**
  `openclaw gateway run` in start.sh (boot-hook), never at runtime.
- **Fails closed, exact message**: `Refusing to bind gateway to lan without
  auth.` — with `bind: lan` and no auth the gateway **does not listen at all**
  (probe fails). Auth (token or password) is mandatory for publishing.
- ⚠️ **Device pairing NOT verified** — the gateway loads a `device-pair`
  plugin; whether a fresh browser must approve pairing after auth is still
  unconfirmed. Needs a real-browser test before the UI promises the dashboard
  end-to-end. (Plan's earlier worry stands.)

### picoclaw — pad-picoclaw-asdsa

- Gateway `picoclaw gateway -E` binds **0.0.0.0:18790** already (all ifaces).
  `/health` → 200. Root `/` → 404 (gateway serves NO console HTML).
- Pico chat channel: `channels.pico.enabled` is **false** by default; `/pico/ws`
  (WS chat proxy) returns **401** until enabled + token set. Token transport is
  a custom WS handshake (Bearer / X-Pico-Token / query all → 401) — irrelevant
  for Paddock because the launcher proxies chat internally.
- **The console is `picoclaw-launcher`** (separate binary, present in image):
  `picoclaw-launcher -console -no-browser -public -port <cport> [config.json]`.
  Default port **18800**, `-public` = 0.0.0.0. Launcher coexists fine with the
  gateway started by start.sh (it attaches; reports its own gatekeeping, e.g.
  "no default model configured").
- **Dashboard auth live**: unauthenticated `/` → 302 → `/launcher-login` (200
  SPA); `/api/*` → 401. Login = `POST /api/auth/login {token}` → 200 + cookie
  `picoclaw_launcher_auth`. Dashboard token is random **per run** unless pinned
  via env **`PICOCLAW_LAUNCHER_TOKEN`** (verified in `/api/auth/status`:
  `token_help.env_var_name`). `PICOCLAW_LAUNCHER_TOKEN` is the Paddock publish
  path.
- Pico channel token precedence: env `PICOCLAW_CHANNELS_PICO_TOKEN` >
  `.security.yml` `channels.pico.token` > `config.json` `channels.pico.token`;
  both files' `channels.pico.enabled`/`token` were patched in testing.

### hermes — pad-hermes-sup (v0.20.0)

- **Web/pty extras ARE baked** in the image (fastapi + uvicorn present,
  prebuilt UI at `/opt/hermes/hermes_cli/web_dist`) — **no Dockerfile change
  needed**. `hermes dashboard --skip-build --no-open` works.
- Loopback bind works with no auth: `/` → 200 dashboard HTML, `/login` → 200,
  `/api/health` → `{"ok":true,...}` (auth not yet engaged).
- **Fails closed, exact message** (0.0.0.0 with no auth provider):
  `Refusing to bind dashboard to 0.0.0.0 — the auth gate engages on
  non-loopback binds, but no auth providers are registered.` … lists the
  fix (basic_auth or OAuth). `--insecure` is a **NO-OP** since the June 2026
  hardening (verified in `--help`).
- **Auth env vars** (verified in plugin code + live): `HERMES_DASHBOARD_
  BASIC_AUTH_USERNAME` + `_PASSWORD` (or `_PASSWORD_HASH`, `_SECRET`,
  `_TTL_SECONDS`). With them set: binds 0.0.0.0, `auth_required: true`, and
  **all sensitive `/api/*` endpoints 401 without a session** (`/api/status` is
  the only public one).
- **Login flow live**: `POST /auth/password-login {provider:"basic",
  username, password}` → 200 + `hermes_session_at` cookie → unlocks
  `/api/config`. Sessions are HMAC-signed; without `_SECRET` they're signed
  with a random per-process secret (invalidated on restart) — publish should
  set a stable `_SECRET`.

### Corrected understanding vs. research

- openclaw bind is `"lan"`, never `"0.0.0.0"` (and not patchable at runtime —
  boot-hook only).
- picoclaw console is the **launcher (18800, separate process)** — the gateway
  (18790) is only the chat WS. So picoclaw's startCommand must **background the
  launcher** (exactly the opencode start-web.sh pattern), and the console auth
  is the **launcher token**, not `channels.pico.token`.
- hermes image already has web extras — drop the Dockerfile task.

Sources (verified online): openclaw docs — the Control UI is a gateway-served
Vite+Lit app on 18789, auth via `gateway.auth.token`/`gateway.auth.password`,
and **new browsers must complete device pairing** (auth runs before pairing;
loopback does not bypass it); hermes docs — dashboard is a *separate*
`hermes dashboard` process (not served by the gateway), non-loopback bind
fails closed without basic auth; opencode docs — `opencode web` runs a
browser app. The online picoclaw docs were misleading (they point at the
gateway chat UI) — the real console is the **launcher dashboard** (separate
`picoclaw-launcher` process, token via `PICOCLAW_LAUNCHER_TOKEN`), confirmed
by the live verification above. codex/claude ship no first-party web UI —
only third-party wrappers exist.

## Goal

Extend the opencode-only web publishing (Web tab → driver `webApp` descriptor →
`start-web.sh` hook → socat door) to every agent type that ships a built-in web
console: **openclaw** (Gateway Dashboard/Control UI + WebChat, 18789), **hermes**
(Web Dashboard, 9119), **picoclaw** (launcher dashboard, 18800).
**codex / claude** stay `webApp: null` (terminal-only; already the fallback).

## How much is done (research findings, 2026-08-09)

### Done — the mechanism (opencode-only, live-verified)

- `webApp` driver descriptor — shape, `startCommand({password, containerPort})`,
  auth `target` (`env` today). **Only `src/services/drivers/opencode.js:38` has it.**
- `web.json` binding (`webServicePath`/`readWebService`, vm-manager.js:825/831);
  `buildWebHook` (1532) writes an idempotent `start-web.sh` (port-probe +
  pidfile) into the data-dir bind mount; `writeWebStartHook`/`removeWebStartHook`/
  `webHookPath` (929-941); re-exec + `webPortReachable` verify after recreate
  (2196-2213); rollback restores hook + binding (2257-2264).
- Socat door (`doorName`/`doorPorts`/`desiredDoors`/`syncDoors`/`removeDoors`/
  `cleanOrphanDoors`, 878-911, 1618-1665) — carries web + SSH + extra ports in
  peer mode; compose emits `ports:` only in default mode.
- `prepareAgentChanges`/`applyAgentChanges` consolidated flow with the `web`
  option (1988-2015, 2101-2213); `GET /api/agents/:name/web` (app.js:917,
  includes `webApp` from the driver), `POST /api/agents/:name/web` (app.js:985);
  MCP `recreate` uses the same path. `agent-registry.js:210` dashboard `web`
  summary. `WebTab.jsx` renders fully from `driver.webApp` (null → empty state).
- `docs/tabs/web.md` already documents the per-driver table + descriptor shape
  (lines 17-59) — the plan for all drivers is pre-written there.

### Missing — the per-driver work

1. **No `webApp` in openclaw / picoclaw / hermes drivers** — GET web returns
   `webApp: null`, POST returns 400 "no web app to publish" (app.js:985-987).
2. **`start.sh` boot hook block only in opencode** (`if [ -f /root/.opencode/start-web.sh ]`, opencode/start.sh:19-21). openclaw/picoclaw/hermes `start.sh`
   have no such block — published servers would die on recreate.
3. **`applyWebAuth` does not exist at all.** Docs describe auth `target`s
   `openclaw.json` / `config.yaml` / `.security.yml` but nothing patches them.
   Live verification simplified this: **picoclaw and hermes consoles take
   env-var auth embedded in `startCommand`** (exactly the opencode pattern —
   `PICOCLAW_LAUNCHER_TOKEN`, `HERMES_DASHBOARD_BASIC_AUTH_*`). Only **openclaw**
   needs config-file patching (`gateway.bind` + `gateway.auth`) because its
   console is the already-running gateway.
4. **`readHookPassword` is hardcoded** to the `OPENCODE_SERVER_PASSWORD='...'`
   regex (1550-1555) — no path to read a config-file auth secret.
5. **Password-only changes don't re-apply**: `webChanged` compares only
   `hostPort:containerPort` (2013-2014) and the hook is rewritten only
   `if (webChanged)` (2102) — changing the opencode password alone is a silent
   no-op today (known gap; must be fixed for any driver).
6. **No "Start in terminal" button** in WebTab.jsx (docs promise it; the
   terminal is the interface — CommandsPane rule).

### Per-driver research (docs + live, 2026-08-09)

- **openclaw** — gateway serves Control UI + WebChat at 18789 (`gateway.run`
  in start.sh). Auth: `gateway.auth.token` / `gateway.auth.password` in
  openclaw.json. Bind is symbolic (`lan`), fails closed without auth, needs
  full gateway restart to apply → patch config via boot hook. Device pairing
  for fresh browsers still unverified (needs real-browser test).
- **hermes** — `hermes dashboard` (separate process; gateway doesn't serve it).
  Default 9119, loopback bind; non-loopback **fails closed without auth**.
  Auth: `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` + `_PASSWORD` / `_PASSWORD_HASH`
  (bcrypt) env (or `dashboard.basic_auth` in config.yaml). startCommand:
  `hermes dashboard --host 0.0.0.0 --port <cport> --no-open --skip-build`.
  Image **already ships** web/pty extras — no Dockerfile change.
- **picoclaw** — web console is the **launcher dashboard** (`picoclaw-launcher`,
  separate process, port 18800, `-public` = 0.0.0.0), NOT the gateway. Gateway
  (18790, `picoclaw gateway -E`) serves the pico **chat WS** at `/pico/ws`,
  token-gated. Launcher token pinned via `PICOCLAW_LAUNCHER_TOKEN` env.
- **codex / claude** — no web UI; `webApp: null` already renders the read-only
  empty state. Nothing to do.
- **Peer-mode collision (document!)**: openclaw binds fixed 18789; the picoclaw
  launcher takes a `-port` but the **gateway** chat port is fixed 18790; hermes
  dashboard takes `--port`. Two peer-shared agents of the same type CANNOT both
  publish the same fixed port — Web tab must warn when the container port can't
  vary (read-only field for fixed-port drivers).
- **Design doc (2026-08-09):** `docs/tabs/web-consoles.md` is the full
  per-console reference — which consoles require a password (openclaw, hermes
  fail closed; opencode, picoclaw optional), where each password is stored
  (`openclaw.json` / `.security.yml`+`config.json` / `config.yaml`+`.env` /
  env-only), and exactly how to set it. Auth facts were verified live on
  2026-08-09.

## Implementation steps

### 1. Shared mechanism (do first — unblocks everything)

- `vm-manager.js`:
  - Generalize `readHookPassword` → `readWebAuth(driver, name)`:
    `env` → existing regex (keep; opencode, picoclaw, hermes); `openclaw.json`
    → parse `gateway.auth.*` (only openclaw uses a config file).
  - Add `applyWebAuth(name, driver, password)` / `removeWebAuth(name, driver)`:
    for **openclaw** patch openclaw.json (bind→lan + auth token, keep backup for
    rollback); for **picoclaw/hermes** the env is already handled by
    `startCommand`. Called in `applyAgentChanges` step 1 (before compose regen)
    and by the REST `POST /web` when the password changes; old values restored
    by `rollbackAgentChanges`.
  - Fix `webChanged` to include the password: compare
    `readWebAuth(driver, name)` against `opts.web.password` so password-only
    changes flow through the recreate (needed for openclaw config patches to
    take effect).
- `start.sh` (all three): add the generic hook block
  `if [ -f <dataDir>/start-web.sh ]; then bash <dataDir>/start-web.sh || true; fi`
  — **openclaw**: BEFORE the `openclaw gateway run` line (hook patches config);
  **picoclaw** → `/root/.picoclaw` and **hermes** → `/opt/data`: before the
  keep-alive line (hook backgrounds the launcher/dashboard). Images must be
  **rebuilt** (shared `:latest` tag) + instances force-recreated. Mirror the
  `ensureSshStartBlock` pattern (backfill old instances' build/start.sh)
  instead of requiring a manual rebuild.
- `WebTab.jsx`: add the **Start in terminal** button
  (`run(webApp.startCommand(...))`); render the container-port field
  **read-only** for fixed-port drivers (`webApp.containerPortEditable:
  false` — openclaw 18789); peer-mode collision warning (openclaw gateway
  fixed 18789; picoclaw gateway chat fixed 18790 — two same-type peers can't
  both publish those fixed gateway ports).

### 2. openclaw driver

- `webApp`: `{ label: 'Gateway Dashboard + WebChat', docs, containerPort: 18789,
  containerPortEditable: false, auth: { target: 'openclaw.json',
  patch: { token/password under gateway.auth } }, startCommand: no-op/verify }`
  (gateway already runs — hook only verifies or no-ops).
- **Boot-hook patches config BEFORE the gateway runs** (start.sh hook block must
  sit **above** the `openclaw gateway run` line — openclaw start.sh:16): set
  `gateway.bind: "lan"` and ensure `gateway.auth` has a token/password.
  Idempotent: preserve an existing `gateway.auth.token`; only overwrite when a
  new password is published. `applyWebAuth`/`removeWebAuth` write this hook
  content (it's the only driver needing config-file patching).
- ⚠️ VERIFY with a real browser: whether the Control UI requires device
  pairing for a fresh browser after auth. If yes, decide how the Web tab
  communicates it (or add `openclaw devices approve` to the flow).

### 3. picoclaw driver

- `webApp`: `{ label: 'Web Console', docs, containerPort: 18800,
  containerPortEditable: true, auth: { target: 'env',
  envKey: 'PICOCLAW_LAUNCHER_TOKEN' }, startCommand({password, containerPort}) {
  PICOCLAW_LAUNCHER_TOKEN='...' picoclaw-launcher -console -no-browser
  -public -port <cport> } }` — the console is the **launcher process** (like
  opencode's web server), so start-web.sh backgrounds it (idempotent
  port-probe).
- Optional chat plumbing: the dashboard proxies chat to the gateway's
  `/pico/ws`, which needs `channels.pico.enabled: true` + token. Decide during
  implementation whether the boot hook also enables it (chat works without
  further config if pico is already enabled, as on the test PAD).

### 4. hermes driver

- `webApp`: `{ label: 'Web Dashboard', docs, containerPort: 9119,
  containerPortEditable: true, auth: { target: 'env', envKeys:
  ['HERMES_DASHBOARD_BASIC_AUTH_USERNAME', 'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD',
  'HERMES_DASHBOARD_BASIC_AUTH_SECRET'] },
  startCommand: 'HERMES_DASHBOARD_BASIC_AUTH_* env hermes dashboard --host
  0.0.0.0 --port <cport> --no-open --skip-build' }`.
- Needs the start-web.sh boot hook (dashboard is NOT started by the gateway) —
  background it, idempotent port-probe. **No Dockerfile change** (extras are
  baked). Set a stable `_SECRET` so sessions survive restarts.

### 5. Verification (per driver, live)

- Publish on a test PAD (default network + one peer-mode pad via gluetun):
  URL 200, auth gate works, recreate survives, unpublish cleans up, door
  carries the binding in peer mode, rollback restores old auth.
- Update `docs/tabs/web.md` status line (17-29) once each lands.

## Files

- **Modified** `src/services/drivers/{openclaw,picoclaw,hermes}.js` — `webApp`
  (picoclaw/hermes: env-var auth + launcher/dashboard startCommand; openclaw:
  config-patch target, no-op startCommand)
- **Modified** `src/services/vm-manager.js` — `readWebAuth`/`applyWebAuth`/
  `removeWebAuth` (openclaw config patch only), `webChanged` password fix,
  hook paths
- **Modified** `src/app.js` — wire auth patch + password into `POST /web` if
  needed (currently passes `opts.web.password` through prepareAgentChanges)
- **Modified** `src/vm-builds/{openclaw,picoclaw,hermes}/start.sh` — boot hook
  block (openclaw: above the gateway line; picoclaw/hermes: background
  launcher/dashboard). No hermes Dockerfile change (extras are baked).
- **Modified** `src/client/src/pages/agent/WebTab.jsx` — Start in terminal,
  read-only container port for fixed-port drivers (openclaw), collision warning
- **Modified** `docs/tabs/web.md` — status + peer-collision note
