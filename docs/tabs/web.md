# Web & Ports Tab

Lets an agent host its built-in web app on a host port, expose SSH, and map
extra TCP ports. The tab lives in the agent detail page and renders from the
driver's `webApp` descriptor — so what it collects differs **per driver**.
Saving rewrites the instance compose with the port bindings, applies the
driver's auth inside the container, and recreates the container so the service
becomes reachable at `http://<host>:<hostPort>`.

This is port-binding + auth-setup. The agent itself runs the web server (via
the terminal / its own runtime); the webui binds the port and configures the
auth so the exposed app is reachable.

File: `src/client/src/pages/agent/WebTab.jsx`. Wired into `AgentDetail.jsx` as
`{ id: 'web', label: 'Web & Ports' }` in `MODES` (after `commands`).

## Built-in web apps per agent type

Each agent's built-in browser UI is its **web console** — how it works, its
port, and its auth requirements are detailed in
[web-consoles.md](web-consoles.md). The table here is the quick version:

| Agent | Built-in web app? | Default container port | Auth when exposed |
|-------|-------------------|------------------------|-------------------|
| **opencode** | OpenCode Web (`opencode web`) | **8080** | `OPENCODE_SERVER_PASSWORD` (username always `opencode`) |
| openclaw | Gateway Dashboard ("Control UI") + WebChat | 18789 | `gateway.auth.token` / `gateway.auth.password` (required — non-loopback bind fails closed) |
| hermes | Web Dashboard (`hermes dashboard`) | 9119 | `HERMES_DASHBOARD_BASIC_AUTH_*` (required — non-loopback bind fails closed) |
| picoclaw | Launcher dashboard (`picoclaw-launcher`) | **18800** | `PICOCLAW_LAUNCHER_TOKEN` (dashboard always gated) |
| codex | none — terminal TUI only | n/a | n/a |

> The picoclaw gateway (18790) does NOT serve a console — it only hosts the
> Pico chat WebSocket at `/pico/ws`. The actual web console is the separate
> launcher dashboard on 18800 (verified live 2026-08-09).

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
    target: 'env',                                      // env | openclaw.json (see below)
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
  user picks the **host** port. For fixed-port drivers (`containerPortEditable:
  false`, e.g. openclaw's gateway at 18789) the field renders read-only.
- Auth `target` is one of: `env` (opencode, picoclaw launcher, hermes — no file
  patch; the password is embedded in the start command via `startCommand`), or
  `openclaw.json` (openclaw, `gateway.auth` + `gateway.bind` — the only driver
  needing a config-file patch, applied by the boot hook before `gateway run`).
- `webApp: null` (codex/claude) → the tab renders a read-only empty state:
  no form, no Apply, no auth section.

## UI

The tab is organized as three cards (plus a delete note in the web-app card):

1. **Web app publish card** — app label, docs link, **Start in terminal**
   button (pastes `webApp.startCommand(...)` via `run(cmd)` — CommandsPane
   pattern). Binding form: container port (prefilled; must be a **unique**
   port when peers share a namespace — see below) + host port. Auth section
   rendered from `webApp.auth` (secret field masked, generate helper). Plus
   a **Deactivate** link. **Apply** → `POST /api/agents/:name/web` → Console
   popup on `streaming` → refetch + toast.
2. **SSH expose card** — enable/disable toggle + host port (empty =
   auto-allocate 43817+) + container port (default 22; agents sharing a peer
   namespace each need a distinct container port) + optional root password
   (Show/Hide + Generate). "Currently published: host X → container Y" line.
   Applies through `POST /api/agents/:name/settings`.
3. **Extra TCP ports card** — add/remove `hostPort→containerPort` mappings.
   Applies through `POST /api/agents/:name/ports`; peer-mode agents' extra
   ports ride the door (see below).

All three cards share the **live-status pill** (`listening`/`down`) from
`actualPorts` (docker inspect) and stream their recreate through the same SSE
Console popup. See [settings.md](settings.md) for the SSH + extra-ports API
shapes.

## Storage

- `instances/<name>/web.json`:
  `{ "containerPort": 8080, "hostPort": 8090 }` (single web app per agent).
  `meta.env` carries `PORT` (ssh host port), `SSH_CPORT` (ssh container port),
  `ROOT_PASSWORD`, and `EXTRA_PORTS` (`[{"host":8080,"container":8080}]` — a
  JSON array of `{ host, container }`, `[]` when empty).
- `generateInstanceCompose(name, agent, password, port, opts)` gains
  `opts.webService = { containerPort, hostPort }` and emits a `ports:` block:
  `- "<hostPort>:<containerPort>"`. On a network peer it emits the socat door
  instead (see below).
- `applyWebServices(name, webService)` in `src/services/vm-manager.js`:
  1. validate + write `web.json`,
  2. regenerate compose (keeps ssh port, allowDocker, network, extra ports
     from meta),
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
| GET | `/api/agents/:name/web` | `{ webApp, active, networkMode, webService, passwordConfigured, startCommand, actualPorts, extraPorts, sshPort, sshContainerPort }`. `webApp` comes from the driver; `actualPorts` from `docker inspect` (the door container in peer mode) so the UI shows if the binding is live. Extra ports + ssh are always reported, even for agent types with no web app. |
| POST | `/api/agents/:name/web` | Body `{ active, hostPort, containerPort, password }`. Validates, then runs the SSE job `update:<name>`: stop if running → write/remove boot hook → `applyWebServices` → `compose up --force-recreate` (plus the door service in peer mode) → exec the start hook → verify the port answers. Returns `202 { ok, job, streaming, action }`. On failure: restore old `web.json` + hook + compose, remove the door, start the container again. |

Validation (shared): `containerPort`/`hostPort` integers 1–65535; host port
must not collide with the agent's own ssh port (`meta.env` `PORT`) or any other
agent's published port (`hostPortInUse()` scans every `instances/*/docker-compose.yml`
for `"<n>:"` plus live `docker ps`); conflicts are 400, not a job failure.
`hostPortInUse` does NOT exclude the agent's own door container — re-publishing
on a just-freed host port fails until the old door is gone; use a fresh host
port or unpublish first.

## Network peer (network_mode: container:) — the socat door

Agents that route through a peer container (e.g. `network_mode: container:gluetun-nord`)
can NEVER publish host ports — Docker refuses (`conflicting options: port publishing and
the container type network mode`). Worse, the peer's firewall (gluetun) drops host-LAN
inbound to its namespace, so host-level forwarding to the peer's IP times out. BUT
connections from other containers on the peer's docker bridge are allowed.

**Solution: a socat "door" service in the instance compose.** The door is a second
service in `instances/<name>/docker-compose.yml`, named **`<name>-door`** (renamed
from `<name>-web` on 2026-08-09):

```yaml
  <name>-door:
    image: alpine/socat
    container_name: <name>-door
    restart: unless-stopped
    networks:
      - webbridge
    ports:
      - "<hostPort>:<containerPort>"
    command: TCP-LISTEN:<hostPort>,fork,reuseaddr TCP:<peer>:<containerPort>
networks:
  webbridge:
    external: true
    name: <peerNetwork>
```

- The door joins the peer's docker network (`gluetun_nord`), publishes the host
  port on its own bridge, and forwards to the peer **by name**. The agent's web server
  binds inside the peer's namespace → reachable at `<peer>:<containerPort>`.
- **The door carries web + SSH + extra ports** in one container — one socat
  `TCP-LISTEN:<hostPort>,fork,reuseaddr TCP:<peer>:<containerPort>` process per
  mapping (identity `host:host` when the container port equals the host port).
  Peer-networked agents can expose SSH and extra ports too; the old "cannot
  publish ports in peer mode" bans were removed. On the default network these
  bind straight on the agent's `ports:`.
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
- Unpublish/rollback: `docker rm -f <name>-door` after the compose is regenerated
  without the door service.
- `doorNameRe(name)` matches `^(<name>-door|<name>-web)$` so a regenerated compose
  reconciles stale `-web` doors; `removeVm()` drops both suffixes. Orphan doors
  (`<name>-door`/`<name>-web` whose `instances/<base>` dir is gone) are removed by
  `cleanOrphanDoors()` at webui boot.

### Peers sharing one namespace collide on the same container port

All agents on the same peer share its network namespace — only ONE process can bind
`0.0.0.0:8080` in it. The first starter wins; every later agent's `start-web.sh`
idempotency probe sees the port already listening and silently skips starting its
own server, and its door forwards to the winner's app. **Fix:** publish each
peer-shared agent on a unique container port (8080, 8081, …). Same for SSH:
only one agent can bind container port 22 in the shared namespace, so give each
a distinct `sshContainerPort`. Live-verified on `pad-opencode-aic` (8081) and
`pad-opencode-paddock-dev`.

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
- **Delete agent:** removes the container, door, network, + instance dir;
  `web.json`/`meta.env` go with the dir. No extra cleanup.
- **Door follows the agent on Paddock Start/Stop/Restart:** the Start/Stop/
  Restart buttons start/stop the door together with the agent (CLI
  `docker stop <name>` stops only the agent; the door keeps forwarding).
- **Config format guards:** openclaw.json is JSON (parse errors are real —
  validate before patch), hermes config.yaml and picoclaw .security.yml are
  YAML (patch minimally, never rewrite the whole file by hand).
- **Container-health coverage:** `container-health.js` diffs declared compose
  `ports:` against actual and reports a missing binding — free coverage for the
  web/ssh/extra ports.

## Per-driver auth patches (planned per driver)

For the full per-console reference — which consoles require a password, where
it is stored, and exactly how to set it — see
[web-consoles.md](web-consoles.md). Summary of the patch targets:

- **opencode** — password is **env-only**; no config-file patch (`applyWebAuth`
  is a no-op, target `env`). The password lives in `start-web.sh` and the
  immediate post-recreate `docker exec` start.
- **openclaw** — `gateway.auth.token` in `openclaw.json` + `gateway.bind:
  lan`. The only driver that needs a config-file patch, applied by the boot
  hook BEFORE `openclaw gateway run` in start.sh. Bind changes require a FULL
  gateway restart (in-process restart keeps old sockets); the gateway binds
  nothing at all when auth is missing on a `lan` bind (fails closed).
- **hermes** — `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD` (plus
  optional `_PASSWORD_HASH`, `_SECRET`, `_TTL_SECONDS`) embedded in
  `hermes dashboard --host 0.0.0.0 --port <cport> --no-open --skip-build`
  via a `start-web.sh` hook. Required — fails closed on non-loopback without
  auth. The web/pty extras are already baked in the image (no Dockerfile
  change); only `/api/status` is public when auth is on.
- **picoclaw** — `PICOCLAW_LAUNCHER_TOKEN` pinned via env + a `start-web.sh`
  hook running `picoclaw-launcher -console -no-browser -public -port <cport>`
  alongside the gateway (the launcher coexists with `picoclaw gateway -E`).
  The dashboard is always gated; the gateway on 18790 has no console UI.

## Link base override (HOST_NAME / HOST_PROTO)

`.env` can set `HOST_NAME` (IP or hostname) and `HOST_PROTO` (`http`|`https`).
These override the base used for **published web-app links** (AgentCard ↗ icon,
Web tab access URL). `/api/config` exposes them as `host` + `hostProtocol`.
The frontend `src/client/src/lib/web.js` caches them at boot and uses them in
`webBase()`; otherwise it falls back to `window.location`. Because `.env`
values are baked in at container create (env_file), a plain `docker restart` is
not enough — **recreate** the paddock container to pick up the change.
