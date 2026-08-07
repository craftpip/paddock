# Web Publishing (plan 23 — 2026-08-07, multi-goal per driver)

## Goal

Let any agent host a website. Each agent gets a **Web** tab in the detail
page. What the tab looks like and what it collects differs **per driver**,
because every agent ships a different built-in web app with different auth:

- openclaw → Gateway Dashboard (Control UI) on **18789**, auth via
  `gateway.auth.token` / `gateway.auth.password`.
- opencode → OpenCode Web on a chosen port (default 8080), auth via
  `OPENCODE_SERVER_PASSWORD`.
- hermes → Web Dashboard on **9119**, auth via `dashboard.basic_auth`
  username/password (required — non-loopback bind fails closed).
- picoclaw → Gateway web console / chat UI on **18790**, auth via
  `channels.pico.token`.
- codex / claude → no built-in web app → empty-state message, no form.

Saving rewrites the instance compose with the port binding, applies the
driver's auth config inside the container, and recreates the container so the
service becomes reachable at `http://<host>:<hostPort>`.

This is port-binding + auth-setup. The agent itself runs the web server (via
the terminal / its own runtime); the webui binds the port and configures the
auth so the exposed app is reachable.

## Research — built-in web apps per agent type (2026-08-07)

Researched online (docs.openclaw.ai, opencode.ai/docs, hermes-agent.nousresearch.com,
docs.picoclaw.io). Summary:

| Agent | Built-in web app? | How to start it | Default port | Auth when exposed |
|-------|-------------------|-----------------|--------------|-------------------|
| **openclaw** | ✅ Gateway Dashboard ("Control UI") + WebChat | `openclaw dashboard` (gateway already runs `openclaw gateway run`) | **18789** | `gateway.auth.token` (`OPENCLAW_GATEWAY_TOKEN`) or `gateway.auth.password` |
| **opencode** | ✅ OpenCode Web (session browser + chat) | `opencode web` (built-in server) | random → `--port <n>`; bind `--hostname 0.0.0.0` | `OPENCODE_SERVER_PASSWORD` (+ `OPENCODE_SERVER_USERNAME`, default `opencode`) |
| **hermes** | ✅ Web Dashboard (Status, Chat/xterm, Config, API Keys, Sessions, Logs, Analytics, Cron, Profiles, Skills, MCP, Channels, Webhooks, System) | `hermes dashboard` | **9119** → `--port <n>`, `--host 0.0.0.0` | loopback = no auth; non-loopback **fails closed** unless `dashboard.basic_auth` (username/password) or Nous OAuth |
| **picoclaw** | ✅ Gateway web console + browser chat UI (Pico channel WS proxy) | `picoclaw gateway -E` (already runs) | **18790** | `channels.pico.token` in `.security.yml` / config.json / `PICOCLAW_CHANNELS_PICO_TOKEN` env |
| **codex** | ❌ terminal TUI only (community wrappers only) | n/a | n/a | n/a |
| **claude** | ❌ "Claude Code on the web" is a **cloud/managed** feature (claude.ai/code, research preview) — nothing self-hosted to run | n/a | n/a | n/a |

Notes / gotchas per agent:

- **openclaw** — gateway binds loopback by default; a non-loopback bind (see
  docs "Web surfaces") makes the dashboard reachable. `openclaw dashboard`
  opens it + handles the token handoff. Docs:
  https://docs.openclaw.ai/web/dashboard.
- **opencode** — auth is **env-only** (no config-file field for the server
  password). `opencode web` binds `127.0.0.1` + random port by default; our
  container keeps alive via `tail -f /dev/null`, so the server is started
  manually. Docs: https://opencode.ai/docs/web/.
- **hermes** — dashboard needs optional extras NOT in the default image:
  `uv pip install -e ".[web,pty]"` (FastAPI + Uvicorn; `pty` = Chat tab).
  Non-loopback bind without an auth provider refuses to start.
  Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard.
- **picoclaw** — the web surface is the gateway's Pico channel on 18790
  (starts only when config.json exists). There's also a separate "Web Launcher
  Dashboard" on 18800 — that's the launcher process, NOT our web surface, so
  ignore it. Token resolution: env > `.security.yml` > config.json.
  Docs: https://docs.picoclaw.io/docs/configuration/token_authentication/.
- **codex / claude** — no web app; the tab is a read-only empty state (per
  user decision, no generic service binding for these types).

## Driver `webApp` descriptor (new driver field)

Each driver carries `type/label/version/commands/...`. Add a `webApp`
descriptor so the Web tab knows the preset + form fields per driver:

```js
webApp: {
  label: 'Gateway Dashboard (Control UI)',
  command: 'openclaw dashboard',                       // "Start in terminal"
  port: 18789,                                         // default container port
  docs: 'https://docs.openclaw.ai/web/dashboard',
  auth: {                                              // form section + where it lands
    label: 'Dashboard auth',
    mode: 'token',                                     // token | password | basic | none
    fields: [ { key: 'token', label: 'Auth token', secret: true } ],
    target: 'openclaw.json',                           // which config the backend patches
  },
}
```

- **port is NOT uniform** — each driver prefills its own container port
  (18789 / 8080 / 9119 / 18790). The user picks the **host** port.
- Auth `target` is one of: `openclaw.json` (JSON, `gateway.auth`),
  `config.yaml` (hermes, `dashboard.basic_auth`), `.security.yml` (picoclaw,
  `channels.pico.token`), or `env` (opencode — no file patch, the password is
  embedded in the start command).
- codex / claude → `webApp: null` → empty state.

## Goal 0 — Shared plumbing (all drivers with a webApp)

The pieces every driver reuses.

### Activate / deactivate UX — Console popup (same as Settings)

Submitting the Web form (activate OR deactivate) runs the settings-style SSE
job, and the frontend opens the **same Console popup** used by Settings/Update.
Every step streams live as `system` lines so the user sees exactly what runs —
no silent magic:

```
■ Web auth   → writing gateway.auth.token to openclaw.json
■ Startup    → writing start-web.sh (auto-start on boot)
■ Compose    → writing port binding 8090:8080 → instances/<name>/docker-compose.yml
■ Container  → docker compose up -d --no-deps --force-recreate <name>
■ Service    → starting web service inside container (docker exec)
✓ Done — web service is live at http://10.69.1.164:8090
```

- On success the popup closes by itself and the status pill flips to
  `listening`. On failure it stays open with the error + rollback lines.
- **Deactivate** = same popup: remove the binding, delete `start-web.sh`, stop
  the service, recreate. Service won't come back.

### The recreate question (why the service needs an auto-start hook)

`--force-recreate` kills the container; only what the image **entrypoint**
starts comes back. Per driver:

| Driver | Entrypoint process | Web app survives recreate? |
|--------|--------------------|----------------------------|
| openclaw | `openclaw gateway run` | ✅ dashboard auto-returns |
| picoclaw | `picoclaw gateway -E` | ✅ web console auto-returns |
| opencode | `tail -f /dev/null` | ❌ `opencode web` is manual → lost |
| hermes | `hermes gateway run` | ❌ `hermes dashboard` is separate → lost |

**Decision — boot hook in the image start.sh (opencode + hermes):** their
`start.sh` sources an optional per-instance hook `<dataDir>/start-web.sh` (the
webui writes it into the bind mount, so it lives on disk, not in the shared
image). On boot, if the hook exists, start.sh runs it in the background and
then continues (`tail`/gateway). The web app then auto-restarts on **every**
recreate — Settings toggle, Update, network-fix recreate, host reboot.

- `start-web.sh` content = the exact start command incl. env vars (e.g.
  `OPENCODE_SERVER_PASSWORD='…' opencode web --hostname 0.0.0.0 --port 8080`).
- Activate writes it; deactivate deletes it.
- This requires a small one-time change to the opencode + hermes `start.sh`
  (source hook if present). openclaw/picoclaw need no change.
- hermes note: start.sh chowns `/opt/data` to `hermes` and the gateway drops
  to the `hermes` user — the hook must launch `hermes dashboard` in the same
  user context so the dashboard can read config.yaml.
- The Apply job ALSO runs the start command once immediately after recreate
  (`docker exec`), so the service is up the moment the popup closes — the hook
  only guards future recreates.

### Storage

- New file `instances/<name>/web.json`:
  `{ "containerPort": 8080, "hostPort": 8090 }` (single web app per agent —
  each driver ships exactly one built-in web app). meta.env stays KEY=VALUE
  (holds the ssh `PORT`).
- `generateInstanceCompose(name, agent, password, port, opts)` gains
  `opts.webService = { containerPort, hostPort }` and emits `ports:`:

```yaml
    ports:
      - "<sshHost>:22"
      - "8090:8080"
```

- `applyWebServices(name, webService)` in `src/services/vm-manager.js`:
  1. validate + write `web.json`,
  2. regenerate compose (keeps ssh port, allowDocker, network from meta),
  3. return the binding. It does NOT stop/recreate — the route does that as an
     SSE job, same pattern as `POST /api/agents/:name/settings`.

### Backend routes (`src/app.js`)

- `GET /api/agents/:name/web` → `{ webApp, auth, webService, actualPorts }`.
  `webApp` comes from the driver; `auth` includes **current** auth state
  (e.g. is a gateway token already set, is hermes basic auth configured);
  `actualPorts` from `docker inspect` so the UI shows if the binding is live.
- `POST /api/agents/:name/web` → body
  `{ hostPort, containerPort, auth: { ...driver fields } }`. Validates, then:
  - stop if running (`docker stop -t 30`), `logStore.capture(name)` first,
  - `vm.applyWebAuth(name, authValues)` (per-driver config patch, Goal 1–4),
  - write `start-web.sh` boot hook (opencode/hermes) — or delete it when
    deactivating,
  - `vm.applyWebServices(name, webService)`,
  - `docker compose -f instances/<name>/docker-compose.yml up -d --no-deps --force-recreate <name>`,
  - `docker exec <name> <web start command>` to bring the service up right away
    (drivers where the app is a manual process),
  - `recordActivity(name, 'web', 'update', 'ok'|'error', summary)`.
  - Every step streams to the job log (see Console popup flow above).
  - Returns `202 { ok, job: 'update:<name>', streaming: true }`; frontend
    streams it in the Console popup.
  - On failure: restore old `web.json` + config + compose, try to start the
    container again (mirror the settings rollback at `app.js:1022`).
- New helper `src/services/web-auth.js`: `applyWebAuth(driver, name, values)`
  + `readWebAuth(driver, name)` dispatch to per-driver patches (each driver
  goal below implements its own file patch; web-auth just switches on
  `webApp.auth.target`).

### Validation (shared)

- `containerPort`, `hostPort`: integers 1–65535.
- Host port conflict **across** agents: scan every `instances/*/docker-compose.yml`
  for `"<n>:"` and reject with `Port <n> already in use by <agent>`; also check
  live `docker ps` published ports. 400, not a job failure.
- Host port must not collide with the agent's own ssh port.
- Auth required? Some drivers fail closed without auth (hermes) — enforce the
  field there before applying.

### Web tab skeleton (`WebTab.jsx`)

- `AgentDetail.jsx`: add `{ id: 'web', label: 'Web' }` to `MODES` (after
  `commands`).
- `WebTab.jsx` renders from `driver.webApp`:
  - Header card: app label, docs link, **Start in terminal** button (pastes
    `webApp.command` via `run(cmd)` — CommandsPane pattern).
  - Binding form: container port (prefilled, read-only-ish) + host port
    (user picks).
  - Auth section rendered from `webApp.auth.fields` (per-driver — see each
    goal). Secret fields masked, with a "generate" helper for tokens.
  - **Apply** button: confirm modal → POST → Console popup on `streaming` →
    refetch + toast.
  - Live-status pill (`listening`/`down`) from `actualPorts`.
  - `webApp: null` → empty state (Goal 5).

## Goal 1 — openclaw driver (Gateway Dashboard)

- `webApp`:
  `{ label: 'Gateway Dashboard (Control UI)', command: 'openclaw dashboard', port: 18789, docs: 'https://docs.openclaw.ai/web/dashboard' }`
- **Auth**: `gateway.auth.token` or `gateway.auth.password` in `openclaw.json`.
  Form shows a mode toggle (none / token / password) + one secret field.
- **Config patch** (`openclaw.json`):
  - read `instances/<name>/openclaw/openclaw.json`,
  - set `gateway.auth.token` (or `gateway.auth.password`),
  - write back (keep everything else). Don't touch `paste-api-key`-style flows.
- **Apply order matters**: patch auth BEFORE recreate so the gateway starts
  with the new secret. No extra restart needed — recreate restarts the gateway.
- Caveat: the dashboard is only reachable when the gateway binds a
  non-loopback address. Note in the tab: if the dashboard doesn't load, check
  the gateway's web-surface bind (docs link).

## Goal 2 — opencode driver (OpenCode Web)

- `webApp`:
  `{ label: 'OpenCode Web', command: 'opencode web --hostname 0.0.0.0 --port 8080', port: 8080, docs: 'https://opencode.ai/docs/web/' }`
- **Auth**: password is **env-only** — `OPENCODE_SERVER_PASSWORD` (username
  defaults to `opencode`). No config-file patch.
- **Form**: optional password field. When set, the "Start in terminal"
  command becomes:
  `OPENCODE_SERVER_PASSWORD='<pw>' opencode web --hostname 0.0.0.0 --port <containerPort>`
  (and the tab explains: log in with user `opencode` + this password).
- **No backend config patch** — `applyWebAuth` is a no-op (auth target `env`).
  The password lives in `start-web.sh` (the boot hook) and in the immediate
  post-recreate `docker exec` start.
- **Auto-start (decided)**: the image `start.sh` gains the optional
  `start-web.sh` boot hook (Goal 0). The Apply job writes
  `start-web.sh` with `OPENCODE_SERVER_PASSWORD='<pw>' opencode web
  --hostname 0.0.0.0 --port <containerPort>` so the server survives every
  recreate. Without the hook the container's `tail -f /dev/null` entrypoint
  would never restart it.

## Goal 3 — hermes driver (Web Dashboard)

- `webApp`:
  `{ label: 'Web Dashboard', command: 'hermes dashboard --host 0.0.0.0 --port 9119 --no-open', port: 9119, docs: 'https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard' }`
- **Image dependency**: dashboard needs `uv pip install -e ".[web,pty]"`
  baked into the hermes Dockerfile (currently not installed). Part of this goal.
- **Auto-start (decided)**: hermes `start.sh` gains the optional `start-web.sh`
  boot hook (Goal 0) so `hermes dashboard --host 0.0.0.0 --port 9119 --no-open`
  relaunches on every recreate (the gateway entrypoint alone won't). The hook
  runs as the `hermes` user like the gateway.
- **Auth**: `dashboard.basic_auth` in `config.yaml` — username + password
  (plaintext `password` is accepted and hashed in-memory; `secret` should be
  a random 32-byte key for stable sessions). **Required**: hermes fails closed
  on a non-loopback bind with no auth provider.
- **Form**: username + password fields (password field generates the `secret`
  too). Show the fail-closed warning.
- **Config patch** (`config.yaml`):
  - read `instances/<name>/hermes/config.yaml` (may not exist on first boot —
    create if missing),
  - set `dashboard.basic_auth.username`, `dashboard.basic_auth.password`,
    `dashboard.basic_auth.secret` (random),
  - write back preserving everything else.

## Goal 4 — picoclaw driver (Gateway web console)

- `webApp`:
  `{ label: 'Gateway Web Console / Chat UI', command: 'picoclaw gateway -E', port: 18790, docs: 'https://docs.picoclaw.io/docs/configuration/token_authentication/' }`
  (command is informational — the gateway already runs it.)
- **Auth**: `channels.pico.token` in `.security.yml` (recommended over
  config.json / env). Single token.
- **Form**: optional token field (with generate helper). Empty token = no auth
  on the web console.
- **Config patch** (`.security.yml`, in the picoclaw data dir): set
  `channels.pico.token` (YAML, preserve rest). Env overrides file — if the
  instance sets `PICOCLAW_CHANNELS_PICO_TOKEN` env, note the file is ignored.
- Apply order: patch before recreate so the gateway loads the token.

## Goal 5 — codex / claude (empty state)

- `webApp: null`. The Web tab renders a single read-only notice:

  > No web app available for this agent type.
  > codex / Claude Code don't ship a built-in web dashboard, so there's
  > nothing to publish.

- No binding form, no Apply, no auth section.

## Files touched

- `src/services/vm-manager.js` — `opts.webService` in
  `generateInstanceCompose`, `applyWebServices()`, `readWebService()`.
- `src/services/web-auth.js` — new: per-driver auth read/apply dispatch.
- `src/app.js` — `GET/POST /api/agents/:name/web` + conflict scan + job.
- `src/services/drivers/*.js` — `webApp` descriptor per driver
  (openclaw/opencode/hermes/picoclaw presets + auth spec; codex/claude `null`).
- `src/client/src/pages/AgentDetail.jsx` — new MODES entry.
- `src/client/src/pages/agent/WebTab.jsx` — new tab (driver-driven form +
  auth section + empty state).
- `src/services/drivers/hermes.js` + `vm-builds/hermes/Dockerfile` — bake
  `.[web,pty]` extras (Goal 3).
- `vm-builds/opencode/Dockerfile` + `vm-builds/hermes/Dockerfile` — start.sh
  sources the optional `start-web.sh` boot hook (Goal 0 / the recreate
  question). Rebuild + recreate existing pads to pick it up.
- `container-health.js` — no change: it already diffs declared compose
  `ports:` against actual and reports a missing binding (free coverage).

## Testing

1. `cd src/client && npm run build` then `docker restart paddock`
   (bind mount serves the built bundle — a JSX edit alone does nothing).
2. **openclaw**: add `{ containerPort: 18789, hostPort: 18789 }` + set a token
   in the form → Apply → recreate → `curl http://10.69.1.164:18789` prompts for
   auth; the token from `openclaw.json` gateway.auth is accepted.
3. **opencode**: set a password, copy the start command into the terminal →
   `opencode web` starts → `curl` with basic auth works on the host port.
4. **hermes**: set username/password → Apply → dashboard binds (no fail-closed
   error) → login page appears on the host port.
5. **picoclaw**: set a token → Apply → gateway serves on host port; `curl
   -H "Authorization: Bearer <token>"` works.
6. Conflict test: bind a host port already used by another agent → 400 with
   owner name.
7. Recreate via Settings (docker toggle) — web binding + auth config survive,
   and the web app **auto-restarts** via `start-web.sh` (opencode/hermes;
   openclaw/picoclaw via their gateway entrypoint).
8. Deactivate: popup streams, binding + hook removed, service gone after
   recreate; a further recreate does NOT bring the service back.
9. codex/claude agent → Web tab shows the empty-state message, no form.
10. `docker exec paddock node --test test/services.test.js` stays green.

## Edge cases / decisions

- **Stop during apply**: if stopped, the job skips `docker stop` and just
  regenerates + `up -d --force-recreate` (which starts it).
- **Apply while the app inside isn't serving yet**: binding is still created;
  the pill shows `down` until the agent starts the server.

## Network peer (network_mode: container:) — the socat door (IMPLEMENTED 2026-08-07)

Agents that route through a peer container (e.g. `network_mode: container:gluetun-global`)
can NEVER publish host ports — Docker refuses (`conflicting options: port publishing and
the container type network mode`). Worse, gluetun's own firewall drops inbound
connections to its namespace from the host LAN, so even host-level forwarding to the
peer's IP times out. BUT connections from other containers on the peer's docker bridge
are allowed (gluetun auto-allows docker bridge subnets).

**Solution: a socat "door" service in the instance compose.** The door is a second
service in `instances/<name>/docker-compose.yml`:

```yaml
  <name>-web:
    image: alpine/socat
    container_name: <name>-web
    restart: unless-stopped
    networks:
      - webbridge
    ports:
      - "<hostPort>:<containerPort>"
    command: TCP-LISTEN:<containerPort>,fork,reuseaddr TCP:<peer>:<containerPort>
networks:
  webbridge:
    external: true
    name: <peerNetwork>
```

- The door joins the peer's docker network (`gluetun_default`), publishes the host
  port on its own bridge, and forwards to the peer **by name**. The agent's web server
  binds inside the peer's namespace → reachable at `<peer>:<containerPort>`.
- Resolving by name per connection means the door survives peer recreates with **no
  changes of its own** (DNS follows the new IP).
- Peer recreated = the pad still needs its existing stale-peer recreate, but the door
  itself is untouched. Verified live: pad restart → boot hook relaunches server → door
  still serves 200.
- gluetun and its other tenants are never touched, stopped, or edited.
- Edge case: peer on `network_mode: host` (no docker network to join) → the door uses
  `network_mode: host` and forwards to `127.0.0.1:<containerPort>`.
- Discovery: `getPeerNetworkName(peer)` inspects the peer's `NetworkSettings.Networks`
  for its bridge network. `applyWebServices()` is async now and resolves it.
- `GET /api/agents/:name/web` inspects the DOOR container (not the agent) for
  `actualPorts`, so the "● Live" pill reflects the real published port.
- Unpublish/rollback: `docker rm -f <name>-web` after the compose is regenerated
  without the door service.
- `hostPortInUse()` already scans `"<n>:"` across instance compose files, so door
  ports are covered by the same conflict check.
- **Auth cleared**: empty auth field in the form = remove the config key
  (hermes can't run exposed without it — enforce when hostPort is set).
- **Delete agent** removes the container + instance dir; `web.json` goes with
  the dir. No extra cleanup.
- **Backup**: `web.json` + patched configs ride along in backups
  (backup-manager tars the whole instance dir — keep it that way).
- **Config format guards**: openclaw.json is JSON (parse errors are real —
  validate before patch), hermes config.yaml and picoclaw .security.yml are
  YAML (patch minimally, never rewrite the whole file by hand).
