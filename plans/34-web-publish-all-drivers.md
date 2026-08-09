# Plan 34 — Web Publishing for All Drivers

## Status: In progress (2026-08-09) — research done, implementation 0/3.
opencode web publishing (the reference mechanism) is live; extending to
openclaw, picoclaw, and hermes is not started.

## Goal

Extend the opencode-only web publishing (Web tab → driver `webApp` descriptor →
`start-web.sh` hook → socat door) to every agent type that ships a built-in web
UI: **openclaw** (Gateway Dashboard/Control UI + WebChat, 18789), **hermes**
(Web Dashboard, 9119), **picoclaw** (gateway web console + chat, 18790).
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
   Only `env` works (password embedded in the start command by `startCommand`).
   For openclaw/picoclaw the web UI is the already-running **gateway** (start.sh
   runs `openclaw gateway run` / `picoclaw gateway -E`), so the hook cannot
   inject auth — the config files must be patched before/at publish.
4. **`readHookPassword` is hardcoded** to the `OPENCODE_SERVER_PASSWORD='...'`
   regex (1550-1555) — no path to read a config-file auth secret.
5. **Password-only changes don't re-apply**: `webChanged` compares only
   `hostPort:containerPort` (2013-2014) and the hook is rewritten only
   `if (webChanged)` (2102) — changing the opencode password alone is a silent
   no-op today (known gap; must be fixed for any driver).
6. **No "Start in terminal" button** in WebTab.jsx (docs promise it; the
   terminal is the interface — CommandsPane rule).

### Per-driver research (docs, 2026-08-09)

- **openclaw** — gateway already serves Control UI + WebChat at 18789
  (`gateway.run` in start.sh). Auth: `gateway.auth.token` / `gateway.auth.password`
  in openclaw.json. Caveat: Control UI over plain HTTP has device-identity /
  insecure-auth restrictions (may need `gateway.bind: "0.0.0.0"` and an
  insecure-HTTP allowance) — VERIFY live before promising the dashboard.
- **hermes** — `hermes dashboard` (separate process; gateway doesn't serve it).
  Default 9119, loopback bind; non-loopback **fails closed without auth**.
  Auth: `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` + `_PASSWORD_HASH` (bcrypt) env in
  `/opt/data/.env` (or `dashboard.basic_auth` config). startCommand:
  `hermes dashboard --host 0.0.0.0 --port <cport> --no-open`. VERIFY the image
  ships the web/pty extras (`hermes dashboard` may need
  `uv pip install -e ".[web,pty]"` in the Dockerfile).
- **picoclaw** — gateway already serves web console + chat at 18790
  (`picoclaw gateway -E`, binds 0.0.0.0). Auth: `channels.pico.token`
  (config.json / `.security.yml` / env `PICOCLAW_CHANNELS_PICO_TOKEN`).
- **codex / claude** — no web UI; `webApp: null` already renders the read-only
  empty state. Nothing to do.
- **Peer-mode collision (document!)**: openclaw/picoclaw gateways bind fixed
  ports (18789/18790) — two peer-shared agents of the same type CANNOT both
  publish (unlike opencode's per-instance `--port`). Web tab must warn when
  the requested container port can't vary (read-only field for fixed-port
  drivers, or verify gateway port override support).

## Implementation steps

### 1. Shared mechanism (do first — unblocks everything)

- `vm-manager.js`:
  - Generalize `readHookPassword` → `readWebAuth(driver, name)`:
    `env` → existing regex (keep); `openclaw.json` → parse `gateway.auth.*`;
    `config.yaml` → read `dashboard.basic_auth` (or env file);
    `.security.yml` → parse `channels.pico.token`.
  - Add `applyWebAuth(name, driver, password)` / `removeWebAuth(name, driver)`:
    patch the target config file (keep a backup / old value for rollback).
    Called in `applyAgentChanges` step 1 (before compose regen) and by the
    REST `POST /web` when the password changes; old values restored by
    `rollbackAgentChanges`.
  - Fix `webChanged` to include the password: compare
    `readWebAuth(driver, name)` against `opts.web.password` so password-only
    changes flow through the recreate (needed for openclaw/picoclaw config
    patches to take effect).
- `start.sh` (all three): add the generic hook block
  `if [ -f <dataDir>/start-web.sh ]; then bash <dataDir>/start-web.sh || true; fi`
  before the gateway/keep-alive line (openclaw → `/root/.openclaw`, picoclaw →
  `/root/.picoclaw`, hermes → `/opt/data`). Images must be **rebuilt**
  (shared `:latest` tag) + instances force-recreated. Mirror the
  `ensureSshStartBlock` pattern (backfill old instances' build/start.sh)
  instead of requiring a manual rebuild.
- `WebTab.jsx`: add the **Start in terminal** button
  (`run(webApp.startCommand(...))`); render the container-port field
  **read-only** for fixed-port drivers (`webApp.containerPortEditable:
  false`); peer-mode collision warning.

### 2. openclaw driver

- `webApp`: `{ label: 'Gateway Dashboard + WebChat', docs, containerPort: 18789,
  containerPortEditable: false, auth: { target: 'openclaw.json',
  patch: { token/password under gateway.auth } }, startCommand: no-op/verify }`
  (gateway already runs — hook only verifies or no-ops).
- `applyWebAuth`: patch `gateway.auth.password` in openclaw.json.
- VERIFY: Control UI reachable over plain HTTP from LAN (bind + insecure-HTTP
  allowances); WebChat token flow; door on peer mode.

### 3. picoclaw driver

- `webApp`: `{ label: 'Gateway Web Console + Chat', containerPort: 18790,
  containerPortEditable: false, auth: { target: '.security.yml',
  patch: channels.pico.token } }` (gateway already runs).
- `applyWebAuth`: write `channels.pico.token` (config.json or `.security.yml`).

### 4. hermes driver

- `webApp`: `{ label: 'Web Dashboard', docs, containerPort: 9119,
  auth: { target: 'config.yaml' (or env), basic_auth username + bcrypt hash },
  startCommand: 'hermes dashboard --host 0.0.0.0 --port <cport> --no-open' }`.
- Needs the start-web.sh boot hook (dashboard is NOT started by the gateway) +
  possibly image web/pty extras.
- `applyWebAuth`: write `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` +
  `_PASSWORD_HASH` (bcrypt — generate in Node) into `/opt/data/.env`.

### 5. Verification (per driver, live)

- Publish on a test PAD (default network + one peer-mode pad via gluetun):
  URL 200, auth gate works, recreate survives, unpublish cleans up, door
  carries the binding in peer mode, rollback restores old auth.
- Update `docs/tabs/web.md` status line (17-29) once each lands.

## Files

- **Modified** `src/services/drivers/{openclaw,picoclaw,hermes}.js` — `webApp`
- **Modified** `src/services/vm-manager.js` — `readWebAuth`/`applyWebAuth`/
  `removeWebAuth`, `webChanged` password fix, hook paths
- **Modified** `src/app.js` — wire auth patch + password into `POST /web` if
  needed (currently passes `opts.web.password` through prepareAgentChanges)
- **Modified** `src/vm-builds/{openclaw,picoclaw,hermes}/start.sh` — boot hook
  block (+ hermes Dockerfile web extras if `hermes dashboard` needs them)
- **Modified** `src/client/src/pages/agent/WebTab.jsx` — Start in terminal,
  read-only container port for fixed-port drivers, collision warning
- **Modified** `docs/tabs/web.md` — status + peer-collision note
