# Web Consoles

A **web console** is the agent's own built-in browser UI — the counterpart to
the terminal's CLI surface. Every agent type that ships one can have it
*published* on a host port through the Web & Ports tab; publishing, the boot
hook, the socat door and the `webApp` descriptor are described in
[web.md](web.md). This page documents each console itself: what it is, which
port it uses, **whether a password is required or optional, where that password
is stored, and exactly how to set it**.

> Last updated: 2026-08-15 — vendor docs verified online AND **live-tested on
> running PADs** (openclaw on pad-openclaw-work-pls, picoclaw on
> pad-picoclaw-asdsa, hermes on pad-hermes-sup). All four consoles are now
> published through Paddock (plan 34, 34a-34f done; peer-mode door carry
> live-verified on pad-test-oc-web).

## Overview

| Driver | Console | Served by | Default port | Auth | Password can be set? |
|--------|---------|-----------|--------------|------|----------------------|
| opencode | OpenCode Web | `opencode web` (own process) | 8080 | optional | yes (`OPENCODE_SERVER_PASSWORD`, env-only) |
| openclaw | Control UI + WebChat | gateway | 18789 | **required** for non-loopback bind | yes (`gateway.auth.password`) or token (`gateway.auth.token`) |
| picoclaw | **Launcher dashboard** | `picoclaw-launcher` (own process) | **18800** | **always gated** (token login) | yes (`PICOCLAW_LAUNCHER_TOKEN`, env) |
| hermes | Web Dashboard | `hermes dashboard` (own process) | 9119 | **required** for non-loopback bind | yes (`HERMES_DASHBOARD_BASIC_AUTH_*`, env) |
| codex | none | — | n/a | n/a | n/a |
| claude | none | — | n/a | n/a | n/a |

Summary of the two questions this page answers:

- **Password required?** openclaw and hermes *fail closed*: they refuse to
  serve beyond loopback without auth (verified: exact refusal messages
  captured). The picoclaw launcher dashboard is *always* gated — `/api/*`
  returns 401 and `/` redirects to `/launcher-login` until you log in with the
  dashboard token (random per run, or pinned via `PICOCLAW_LAUNCHER_TOKEN`).
  opencode is the only one that serves open by default.
- **Where is it stored?** opencode: environment variable baked into the start
  command. openclaw: `openclaw.json` (`gateway.auth.*` + `gateway.bind`).
  picoclaw: `PICOCLAW_LAUNCHER_TOKEN` env (the gateway's separate pico chat
  token is `channels.pico.token`). hermes: `HERMES_DASHBOARD_BASIC_AUTH_*`
  env (or `config.yaml` `dashboard.basic_auth`).

In a PAD the files live in the agent's bind-mounted data dir
(`instances/&lt;name&gt;/&lt;agent&gt;/`), so the webui can patch them — the exact PAD path
is given under each driver.

## opencode — OpenCode Web

The browser app for the OpenCode CLI. No gateway daemon: the web server is a
separate process you start yourself.

### How it runs

```bash
opencode web --hostname 0.0.0.0 --port 8080
```

- Binds `127.0.0.1` with a random port by default; `--hostname 0.0.0.0` makes
  it reachable on the network, `--port` fixes the port.
- In a PAD the webui starts it through the `start-web.sh` boot hook (see
  [web.md](web.md)); the terminal "Start" button pastes the same command.
- Server settings can also live in the `server` block of the opencode config
  (`port`, `hostname`, `mdns`, `cors`) — CLI flags win.

### Auth — optional password

The console is **open by default**. A password is **optional**; set it and the
browser login is HTTP Basic with the username `opencode` (override with
`OPENCODE_SERVER_USERNAME`).

### Setting the password

**There is no config-file auth.** The password is an environment variable read
by the `opencode web` process — it must be present when the server starts. In a
PAD the webui embeds it in the start command / `start-web.sh`:

```bash
OPENCODE_SERVER_PASSWORD='secret' opencode web --hostname 0.0.0.0 --port 8080
```

- To change it: stop the web server, start it again with the new value, then
  reload the browser. The Web tab's Apply triggers this.
- File to edit: none (the `opencode.json` `server` block holds no secret; auth
  is env-only by design).

## openclaw — Control UI + WebChat

The Gateway's own web console: a Vite/Lit single-page app served by the Gateway
process (the one `start.sh` launches with `openclaw gateway run`). It includes
chat, session browsing, cron, plugins, skills and config editing, and the
WebChat surface. No separate server to start — the console is already running
whenever the gateway is.

### Ports and binding

- Default: `http://&lt;host&gt;:18789/` (verified: root serves the Control UI HTML,
  `&lt;title&gt;OpenClaw Control&lt;/title&gt;`, HTTP 200). The port is `gateway.port`.
- Bind address is `gateway.bind`. Binding **beyond loopback without auth is
  blocked** — publishing to a host port therefore forces you to configure auth
  first. Verified refusal: `Refusing to bind gateway to lan without auth.`
- **`gateway.bind` takes symbolic modes, not an IP.** Allowed:
  `auto | lan | loopback | custom | tailnet`. `"0.0.0.0"` is rejected
  (`gateway.bind: Invalid input`). `lan` = listen on 0.0.0.0 (verified: after a
  restart with `bind: "lan"` the socket was `LISTEN 0.0.0.0:18789` and reachable
  via the container's LAN IP).
- **`gateway.*` changes need a FULL gateway restart.** The config watcher
  detects the change, logs "config change requires gateway restart", and does
  an **in-process SIGUSR1 restart that keeps the old sockets** — verified that
  writing `bind: lan` at runtime left it on loopback. Only a fresh process
  (container recreate) applies it. In a PAD the boot hook patches the config
  **before** `openclaw gateway run`, so a container restart applies it cleanly.
- Optional URL prefix: `gateway.controlUi.basePath` (e.g. `/openclaw`).

### Auth — token or password, required to expose

Two supported modes, selected by `gateway.auth.mode`:

| mode | credential | env override | notes |
|------|-----------|--------------|-------|
| `token` (default) | `gateway.auth.token` | `OPENCLAW_GATEWAY_TOKEN` | no configured token ⇒ gateway generates an ephemeral runtime token each start |
| `password` | `gateway.auth.password` | `OPENCLAW_GATEWAY_PASSWORD` | browser keeps a per-session login |

Auth runs before device pairing, and **loopback does not bypass it** — even a
localhost connection must present the token/password. Verified live: with the
gateway in `token` mode, `GET /control-ui-config.json` returned **401** without
`Authorization: Bearer &lt;token&gt;` and **200** with it; the gate held on `0.0.0.0`
too.

### Setting a token or password

File: **`/root/.openclaw/openclaw.json`** (JSON5; the gateway hot-watches it,
but `gateway.*` changes need a **full gateway restart** — the automatic
in-process reload does NOT re-bind the socket; see "Ports and binding").

Password mode:

```json5
{
  gateway: {
    port: 18789,
    bind: "lan",
    auth: { mode: "password", password: "choose-a-strong-password" },
  },
}
```

Token mode:

```json5
{
  gateway: {
    bind: "lan",
    auth: { mode: "token", token: "a-long-random-token" },
  },
}
```

CLI equivalents (inside the container):

```bash
openclaw config set gateway.auth.mode password
openclaw config set gateway.auth.password 'choose-a-strong-password'
openclaw config set gateway.bind lan
```

```bash
openclaw config set gateway.auth.mode token
openclaw config set gateway.auth.token 'a-long-random-token'
openclaw config set gateway.bind lan
```

Then restart the gateway or container (a full process start is required for the
bind change). Verify with `openclaw gateway status` (shows `bind=lan (0.0.0.0)`
and the dashboard URL). Env overrides beat the file when both are set.

### Device pairing — skipped on plain HTTP

After auth succeeds, a **new browser** normally still must complete a one-time
pairing approval or it sees `disconnected (1008): pairing required`:

```bash
openclaw devices list
openclaw devices approve &lt;requestId&gt;
```

`openclaw dashboard` on the gateway host opens a short-lived, single-use
pairing link instead. **Live-verified 2026-08-10 (real browser):** the pairing
step is the blocker for publishing over plain HTTP — the gateway's `device-pair`
plugin **refuses the WS handshake from an insecure context**
(`cause: control-ui-insecure-auth`), and neither the token gate nor
`gateway.controlUi.allowInsecureAuth` alone fixes it. Paddock's publish patch
sets `gateway.controlUi.dangerouslyDisableDeviceAuth: true` (token-only auth,
device identity skipped), and unpublish restores the pre-publish `controlUi`
value from the state file.

### Paddock status

Implemented (plan 34b, live-verified): `webApp` descriptor — `containerPort:
18789`, `containerPortEditable: false`, `startable: false`, auth
`{ target: 'openclaw.json', required: true }`. Because the console is
gateway-served, the boot hook can only *verify*, never start it (hence
`startable: false` — no "Start in terminal" button); auth + `gateway.bind:
"lan"` + the `dangerouslyDisableDeviceAuth` flag are patched into
`openclaw.json` **before** the gateway starts. A runtime config reload does NOT
rebind — a full gateway start does. Publish/unpublish roundtrip verified on
pad-openclaw-work-pls and pad-test-oc-web.

## picoclaw — Launcher dashboard (web console)

The web console is the **launcher dashboard** — a separate process from the
gateway. The gateway (`picoclaw gateway -E`, launched by `start.sh`) does NOT
serve any console HTML; it only serves the Pico **chat WebSocket** at
`/pico/ws` (and channel webhooks) on its shared HTTP port.

### Ports and binding

- Launcher dashboard: default **`http://&lt;host&gt;:18800/`**, configurable with
  `-port`. `-public` listens on 0.0.0.0; without it, loopback only.
- Gateway (chat WS only): `http://&lt;host&gt;:18790/` — verified serving NOTHING at
  `/` (404); `/pico/ws` is the chat endpoint (401 without a valid pico token).
  The PAD `start.sh` exports `PICOCLAW_GATEWAY_HOST=0.0.0.0`.

### How it runs (verified live)

```bash
picoclaw-launcher -console -no-browser -public -port 18800 /root/.picoclaw/config.json
```

- The launcher binary ships in the PAD image (`/usr/local/bin/picoclaw-launcher`).
- It attaches to the already-running gateway (started by `start.sh`) — both
  coexist; the launcher reports its own gatekeeping (e.g.
  `gateway_start_reason: "no default model configured"`) but serves the
  dashboard regardless.
- In a PAD the webui must start it via the `start-web.sh` boot hook (same
  idempotent background pattern as opencode), NOT via the gateway.

### Auth — always gated (token login)

The dashboard is **always protected**: unauthenticated `/` → 302 →
`/launcher-login` (SPA), and every `/api/*` returns 401 until login.

- **Login** (verified): `POST /api/auth/login` with body `{"token":"..."}` →
  200 + cookie `picoclaw_launcher_auth`; the cookie unlocks `/api/*`.
- **Dashboard token**: random **per run** (printed to the launcher log) UNLESS
  pinned via the env var **`PICOCLAW_LAUNCHER_TOKEN`** (verified:
  `/api/auth/status` reports `token_help.env_var_name: PICOCLAW_LAUNCHER_TOKEN`).
  First-run password setup in GUI mode uses `/launcher-setup`.
- For Paddock publishing, embed `PICOCLAW_LAUNCHER_TOKEN` in the start command
  so the token is stable across recreates.

### Pico chat token (separate, optional)

The chat *inside* the dashboard is proxied by the launcher to the gateway's
`/pico/ws`, which is gated by a pico channel token:

- `channels.pico.enabled` must be `true` (default **false**) or the gateway
  won't serve chat.
- Token precedence: env `PICOCLAW_CHANNELS_PICO_TOKEN` > `.security.yml`
  `channels.pico.token` > `config.json` `channels.pico.token`.
- The token travels in a custom WS handshake (Bearer / header / query variants
  all rejected — verified), so it's not a URL/login credential; the launcher
  presents it for you.

### Paddock status

Implemented (plan 34c, live-verified): `webApp` descriptor — `containerPort:
18800`, editable, auth `{ target: 'env', envKey: 'PICOCLAW_LAUNCHER_TOKEN',
required: false }`. The console is a **background launcher process** (like
opencode's web server), so the `start-web.sh` boot hook starts it with the
token pinned and the auth is env-based — no config-file patching needed.
Publish/unpublish roundtrip + token login verified on pad-picoclaw-asdsa.

## hermes — Web Dashboard

A browser UI for managing the agent — config, API keys, sessions, analytics,
cron, skills, MCP — plus an embedded browser **Chat** tab that renders the real
TUI through xterm.js.

### How it runs

Unlike the gateway-served consoles, the dashboard is a **separate process** the
gateway does not start:

```bash
hermes dashboard --host 0.0.0.0 --port 9119 --no-open --skip-build
```

- Binds `127.0.0.1:9119` by default; `--host 0.0.0.0` exposes it, `--no-open`
  skips the browser, `--skip-build` serves the prebuilt UI (verified:
  `/opt/hermes/hermes_cli/web_dist`).
- The dashboard is **machine-level**: one server manages every hermes profile
  on the box.
- In a PAD the webui must start it via the `start-web.sh` boot hook (the
  dashboard is the one console that needs a real start command). The image
  **already ships** the web + pty extras (verified: fastapi + uvicorn present).

### Auth — required, fails closed

Binding to a non-loopback address with **no auth provider fails closed at
startup**. Verified refusal message:

```
Refusing to bind dashboard to 0.0.0.0 — the auth gate engages on non-loopback
binds, but no auth providers are registered. Configure an auth provider before
exposing the dashboard: Password: set dashboard.basic_auth.username +
password_hash in config.yaml ... There is no unauthenticated public-bind option.
```

`--insecure` is a **NO-OP** (since the June 2026 hardening) — it no longer
disables auth on a public bind. There is no token-only option.

### Setting username + password (verified env path)

Two equivalent stores; **env wins over config** and an empty value is treated
as unset. Env vars (verified in the basic-auth provider plugin):

```bash
HERMES_DASHBOARD_BASIC_AUTH_USERNAME=admin
HERMES_DASHBOARD_BASIC_AUTH_PASSWORD=choose-a-strong-password
HERMES_DASHBOARD_BASIC_AUTH_SECRET=<32+ random bytes; openssl rand -base64 32>
```

(`_PASSWORD_HASH` = bcrypt hash instead of `_PASSWORD`; `_TTL_SECONDS` = session
lifetime.)

Config store — **`/opt/data/config.yaml`**, `dashboard.basic_auth`:

```yaml
dashboard:
  basic_auth:
    username: admin
    password: choose-a-strong-password
    secret: <32+ random bytes>
```

`secret` signs session cookies. Without one the provider mints a random
**per-process** secret (verified in plugin code) — sessions die on every
restart, so publishing must set a stable `_SECRET`.

### Verifying the gate and logging in (verified live)

With the env vars set and `--host 0.0.0.0`, the dashboard binds 0.0.0.0 and:

```bash
curl -s http://&lt;ip&gt;:9119/api/health | jq '.auth_required'
# true
```

All sensitive `/api/*` endpoints (config, keys, secrets, sessions, agents,
settings, logs, models…) return **401 without a session**; `/api/status` is
the only public one.

Login is a cookie session flow, **not** per-request Basic:

```bash
curl -s -X POST http://&lt;ip&gt;:9119/auth/password-login \
  -H 'Content-Type: application/json' \
  -d '{"provider":"basic","username":"admin","password":"choose-a-strong-password"}'
# {"ok":true,"next":"/"}  + Set-Cookie: hermes_session_at=...
```

With that cookie, `/api/config` returns 200. (`/api/auth/login` is NOT the
endpoint — the provider POSTs to `/auth/password-login` with a `provider`
field.)

### Image prerequisites

- The web + pty extras are **already baked** into the PAD hermes image
  (verified: fastapi/uvicorn importable, web UI dist present) — no Dockerfile
  change needed for plan 34.
- The bundled username/password provider must be enabled: `basic` in
  `plugins.enabled` (if it is disabled, a non-loopback dashboard still fails
  closed).

### Paddock status

Implemented (plan 34d, live-verified): `webApp` descriptor — `containerPort:
9119`, editable, auth `{ target: 'env', required: true }` (the start command
embeds `HERMES_DASHBOARD_BASIC_AUTH_USERNAME/PASSWORD/_SECRET`, so sessions
survive restarts). The dashboard is started by the `start-web.sh` boot hook
(the gateway does not start it). One hermes-specific gotcha was solved:
- Hermes re-locks `/opt/data` to **0700 on gateway boot** via
  `secure_parent_dir()` in `hermes_constants.py`, which would break the hook
  write — the hermes `start.sh` holds it at 755 with a small watchdog loop.
Login flow (`admin`/password → `/sessions`) verified on pad-hermes-sup.

## codex and claude — no web console

Both are terminal-only agents (codex TUI, Claude Code TUI). Neither ships a
first-party web UI — only third-party wrappers exist. In Paddock their
`webApp` is null, so the Web tab renders the read-only empty state: no publish
form, no auth section, no Start button. Additional TCP ports and SSH are still
available.

## See Also

- [Web & Ports tab](web.md) — the publish mechanism, `webApp` descriptor,
  boot hook, socat door
- [Drivers reference](../backend/drivers.md) — per-driver fields and gotchas
- [Settings tab](settings.md) — recreate/update flow the publish job uses
