# Web Tab

Lets an agent host its built-in web app on a host port. The tab lives in the
agent detail page and renders from the driver's `webApp` descriptor — so what it
collects differs **per driver**. Saving rewrites the instance compose with the
port binding, applies the driver's auth inside the container, and recreates the
container so the service becomes reachable at `http://<host>:<hostPort>`.

This is port-binding + auth-setup. The agent itself runs the web server (via
the terminal / its own runtime); the webui binds the port and configures the
auth so the exposed app is reachable.

File: `src/client/src/pages/agent/WebTab.jsx`. Wired into `AgentDetail.jsx` as
`{ id: 'web', label: 'Web' }` in `MODES` (after `commands`).

## Built-in web apps per agent type

| Agent | Built-in web app? | Default container port | Auth when exposed |
|-------|-------------------|------------------------|-------------------|
| **opencode** | OpenCode Web (`opencode web`) | **8080** | `OPENCODE_SERVER_PASSWORD` (username always `opencode`) |
| openclaw | Gateway Dashboard ("Control UI") + WebChat | 18789 | `gateway.auth.token` / `gateway.auth.password` |
| hermes | Web Dashboard | 9119 | `dashboard.basic_auth` username/password (required — non-loopback bind fails closed) |
| picoclaw | Gateway web console + chat UI | 18790 | `channels.pico.token` |
| codex / claude | none — terminal TUI only | n/a | n/a |

**Currently implemented in the codebase:** only the opencode driver carries a
`webApp` descriptor today (live-verified on pad-opencode-yo). The others are
planned per driver — see below for the descriptor shape each will use.

## Driver `webApp` descriptor

```js
webApp: {
  label: 'OpenCode Web',
  docs: 'https://opencode.ai/docs/web/',
  containerPort: 8080,                                  // default in-container port
  auth: {
    label: 'Server password',
    hint: 'Optional — protects the web UI with a password.',
    target: 'env',                                      // env | openclaw.json | config.yaml | .security.yml
    envKey: 'OPENCODE_SERVER_PASSWORD',                 // for target: 'env'
  },
  startCommand({ password = '', containerPort }) {
    // shell command used both for the on-boot hook (start-web.sh) and the
    // terminal "Start" button
    return `${password ? `${this.auth.envKey}='${password}' ` : ''}opencode web --hostname 0.0.0.0 --port ${containerPort}`;
  },
}
```

- **port is NOT uniform** — each driver prefills its own container port. The
  user picks the **host** port.
- Auth `target` is one of: `openclaw.json` (JSON, `gateway.auth`),
  `config.yaml` (hermes, `dashboard.basic_auth`), `.security.yml` (picoclaw,
  `channels.pico.token`), or `env` (opencode — no file patch, the password is
  embedded in the start command).
- `webApp: null` (codex/claude) → the tab renders a read-only empty state:
  no form, no Apply, no auth section.

## UI

- **Header card** — app label, docs link, **Start in terminal** button (pastes
  `webApp.startCommand(...)` via `run(cmd)` — CommandsPane pattern).
- **Binding form** — container port (prefilled) + host port (user picks).
- **Auth section** — rendered from `webApp.auth` (secret field masked, with a
  generate helper for passwords).
- **Apply** — confirm modal → `POST /api/agents/:name/web` → Console popup on
  `streaming` → refetch + toast.
- **Live-status pill** (`listening`/`down`) from `actualPorts` (docker inspect).
- **Deactivate** — same flow: remove the binding, delete `start-web.sh`, drop
  the door, recreate. Service won't come back.

## Storage

- `instances/<name>/web.json`:
  `{ "containerPort": 8080, "hostPort": 8090 }` (single web app per agent).
  Rides along in backups (backup-manager tars the whole instance dir).
- `generateInstanceCompose(name, agent, password, port, opts)` gains
  `opts.webService = { containerPort, hostPort }` and emits a `ports:` block:
  `- "<hostPort>:<containerPort>"`. On a network peer it emits the socat door
  instead (see below).
- `applyWebServices(name, webService)` in `src/services/vm-manager.js`:
  1. validate + write `web.json`,
  2. regenerate compose (keeps ssh port, allowDocker, network from meta),
  3. return the binding. It does NOT stop/recreate — the route does that as an
     SSE job, same pattern as `POST /api/agents/:name/settings`.
- `readWebService(name)` — reads `web.json` (null if absent).
- `webHookPath(name, agent)` / `writeWebStartHook(name, agent, content)` /
  `removeWebStartHook(name, agent)` — the **boot hook** at `<dataDir>/start-web.sh`.
  The image `start.sh` sources it on boot when present, so the web app
  auto-restarts on **every** recreate — Settings toggle, Update,
  network-fix recreate, host reboot. opencode's `tail -f /dev/null` entrypoint
  would otherwise never restart the server. Apply also execs the hook once
  after recreate so the service is up the moment the popup closes.

## Backend routes (`src/app.js`)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:name/web` | `{ webApp, active, networkMode, webService, passwordConfigured, startCommand, actualPorts }`. `webApp` comes from the driver; `actualPorts` from `docker inspect` (the door container in peer mode) so the UI shows if the binding is live. |
| POST | `/api/agents/:name/web` | Body `{ active, hostPort, containerPort, password }`. Validates, then runs the SSE job `update:<name>`: stop if running → write/remove boot hook → `applyWebServices` → `compose up --force-recreate` (plus the door service in peer mode) → exec the start hook → verify the port answers. Returns `202 { ok, job, streaming, action }`. On failure: restore old `web.json` + hook + compose, remove the door, start the container again. |

Validation (shared): `containerPort`/`hostPort` integers 1–65535; host port
must not collide with the agent's own ssh port (`meta.env` `PORT`) or any other
agent's published port (`hostPortInUse()` scans every `instances/*/docker-compose.yml`
for `"<n>:"` plus live `docker ps`); conflicts are 400, not a job failure.

## Network peer (network_mode: container:) — the socat door

Agents that route through a peer container (e.g. `network_mode: container:gluetun-global`)
can NEVER publish host ports — Docker refuses (`conflicting options: port publishing and
the container type network mode`). Worse, the peer's firewall (gluetun) drops host-LAN
inbound to its namespace, so host-level forwarding to the peer's IP times out. BUT
connections from other containers on the peer's docker bridge are allowed.

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
- The peer and its other tenants are never touched, stopped, or edited.
- Edge case: peer on `network_mode: host` (no docker network to join) → the door uses
  `network_mode: host` and forwards to `127.0.0.1:<containerPort>`.
- Discovery: `getPeerNetworkName(peer)` inspects the peer's `NetworkSettings.Networks`
  for its bridge network. `applyWebServices()` is async and resolves it.
- `GET /api/agents/:name/web` inspects the DOOR container (not the agent) for
  `actualPorts`, so the "● Live" pill reflects the real published port.
- Unpublish/rollback: `docker rm -f <name>-web` after the compose is regenerated
  without the door service.

## Edge cases / decisions

- **Network switch keeps the binding:** `vm.applySettings()` is async and reads
  the active `web.json` itself, regenerating the compose with `webService` +
  the resolved `webPeerNetwork` for the NEW network — it never drops the web
  binding on a network or docker-toggle change. The settings route then
  force-recreates the door on a network change (plain `up` on a docker-only
  toggle), drops the door when leaving peer mode (BEFORE the agent recreate, so
  the new `ports:` bind doesn't hit "port is already allocated"), re-execs the
  `start-web.sh` hook, and re-verifies the server.
- **Stop during apply:** if stopped, the job skips `docker stop` and just
  regenerates + `up -d --force-recreate` (which starts it), then stops again.
- **Apply while the app inside isn't serving yet:** binding is still created;
  the pill shows `down` until the agent starts the server.
- **Auth cleared:** empty auth field in the form = remove the config key
  (hermes can't run exposed without it — enforce when hostPort is set).
- **Delete agent:** removes the container + instance dir; `web.json` goes with
  the dir. No extra cleanup.
- **Backup:** `web.json` + patched configs ride along in backups.
- **Config format guards:** openclaw.json is JSON (parse errors are real —
  validate before patch), hermes config.yaml and picoclaw .security.yml are
  YAML (patch minimally, never rewrite the whole file by hand).
- **Container-health coverage:** `container-health.js` diffs declared compose
  `ports:` against actual and reports a missing binding — free coverage for the
  web port.

## Per-driver auth patches (planned per driver)

- **opencode** — password is **env-only**; no config-file patch (`applyWebAuth`
  is a no-op, target `env`). The password lives in `start-web.sh` and the
  immediate post-recreate `docker exec` start.
- **openclaw** — `gateway.auth.token` or `gateway.auth.password` in
  `openclaw.json`; patch BEFORE recreate so the gateway starts with the new
  secret. Caveat: the dashboard is only reachable when the gateway binds a
  non-loopback address.
- **hermes** — `dashboard.basic_auth` `{ username, password, secret }` in
  `config.yaml`; `secret` should be a random 32-byte key. Required — hermes
  fails closed on a non-loopback bind with no auth provider. Needs
  `uv pip install -e ".[web,pty]"` baked into the image.
- **picoclaw** — `channels.pico.token` in `.security.yml` (recommended over
  config.json / env). Env overrides file — if the instance sets
  `PICOCLAW_CHANNELS_PICO_TOKEN`, the file is ignored. The gateway already runs
  `picoclaw gateway -E`, so no boot hook needed.
