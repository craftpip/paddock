# Web Publishing (plan 23 — 2026-08-07)

## Goal

Let any agent host a website. Each agent gets a **Web** tab in the detail
page where you declare the web service the agent runs (the container port it
listens on) and the host port you want it exposed on. Saving rewrites the
instance compose with the new port binding and recreates the container so the
service becomes reachable at `http://<host>:<hostPort>`.

This is a pure port-binding feature. The agent itself starts and serves the
site (via the terminal / its own runtime); the webui just makes the port reach
the container.

## Research — built-in web apps per agent type (2026-08-07)

Researched online (docs.openclaw.ai, opencode.ai/docs, hermes-agent.nousresearch.com,
picoclaw docs). Summary of what each agent ships with:

| Agent | Built-in web app? | How to start it | Default port | Auth when exposed |
|-------|-------------------|-----------------|--------------|-------------------|
| **openclaw** | ✅ Gateway Dashboard ("Control UI") + WebChat | `openclaw dashboard` (gateway already runs `openclaw gateway run`) | **18789** (loopback; configurable via `gateway.web` / bind modes) | `gateway.auth.token` (`OPENCLAW_GATEWAY_TOKEN`) or `gateway.auth.password` |
| **opencode** | ✅ OpenCode Web (session browser + chat) | `opencode web` (built-in server; `opencode serve` similar) | random by default → `--port <n>`; bind with `--hostname 0.0.0.0` | `OPENCODE_SERVER_PASSWORD` (+ `OPENCODE_SERVER_USERNAME`, default `opencode`) |
| **hermes** | ✅ Web Dashboard (Status, Chat via embedded TUI/xterm, Config, API Keys, Sessions, Logs, Analytics, Cron, Profiles, Skills, MCP, Channels, Webhooks, System) | `hermes dashboard` | **9119** → `--port <n>`, `--host 0.0.0.0`, `--no-open` | loopback = no auth; non-loopback bind **fails closed** unless auth configured (`dashboard.basic_auth` username/password or Nous OAuth) |
| **picoclaw** | ✅ Browser chat UI (Pico channel WebSocket proxy) + dashboard | gateway already runs `picoclaw gateway -E` | **18790** | (depends on channel config) |
| **codex** | ❌ No official built-in web UI — terminal TUI only | n/a (community wrappers exist: Codex-webui, Codex-CLI-UI) | n/a | n/a |
| **claude** | ❌ No self-hosted dashboard. "Claude Code on the web" (claude.ai/code) is a **cloud/managed** feature (research preview, Pro/Max/Team) — nothing to run in the container. Desktop app has an in-app browser (Cmd+Shift+B) but that's not a service | n/a | n/a | n/a |

Notes / gotchas per agent:

- **openclaw** — gateway binds loopback by default; to make the dashboard
  reachable the gateway must bind a non-loopback address (docs "Web surfaces":
  bind modes + security notes). Port 18789. Dashboard docs:
  https://docs.openclaw.ai/web/dashboard.
- **opencode** — cleanest fit: `opencode web --hostname 0.0.0.0 --port 8080`.
  Our opencode container keeps alive via `tail -f /dev/null`, so the service
  must be started manually (or via the Web tab's optional start command). Docs:
  https://opencode.ai/docs/web/.
- **hermes** — dashboard needs optional extras NOT in the default image:
  `uv pip install -e ".[web,pty]"` (FastAPI + Uvicorn; `pty` adds the Chat
  tab). Non-loopback bind requires auth or it refuses to start — must configure
  `HERMES_DASHBOARD_BASIC_AUTH_*` (or Nous OAuth) for a published port.
  Docs: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard.
- **picoclaw** — `picoclaw gateway -E` (bind 0.0.0.0:18790) is the built-in
  web surface; starts only when config.json exists. Docs:
  https://docs.picoclaw.io.
- **codex / claude** — no built-in web app. The Web tab shows the "no web app
  available" empty state; nothing to publish (per user decision, no generic
  service binding for these types).

### Driver `webApp` descriptor (new driver field)

Each driver already carries `type/label/version/commands/...`. Add a
`webApp` descriptor so the Web tab can prefill defaults and offer a
copy-to-terminal start command:

```js
webApp: {
  label: 'OpenClaw Dashboard',
  command: 'openclaw dashboard',
  port: 18789,               // container port to publish
  auth: 'gateway.auth.token (OPENCLAW_GATEWAY_TOKEN)',
  docs: 'https://docs.openclaw.ai/web/dashboard',
}
```

- `openclaw` → dashboard on 18789.
- `opencode` → `opencode web --hostname 0.0.0.0 --port 8080` on 8080.
- `hermes` → `hermes dashboard --host 0.0.0.0 --port 9119` on 9119.
- `picoclaw` → gateway already serves on 18790.
- `codex`, `claude` → `webApp: null` — **no web app available**.

### Empty state (codex / claude)

When `driver.webApp` is `null`, the Web tab does NOT show the service form.
It renders a single empty-state notice instead:

> No web app available for this agent type.
> codex / Claude Code don't ship a built-in web dashboard, so there's nothing
> to publish.

No add/apply UI, no port binding — the tab is read-only info for those types.

The Web tab shows the descriptor (label + docs link), prefills the container
port, and offers a "Start in terminal" button that pastes `command` into the
docked terminal (same pattern as CommandsPane `run(cmd)`). The user still
starts the app inside the container; the webui binds the port. For types with
`webApp: null` the whole form is replaced by the empty-state notice above.

## What the Web tab collects (per service)

A service entry = one row:

| Field | Meaning | Example |
|-------|---------|---------|
| Name | label for the row (shown in table + access link) | `catalog`, `stats` |
| Container port | the port the service listens on INSIDE the container | `8000` |
| Host port | the port you want on the host, `http://10.69.1.164:<port>` | `8090` |

Multiple services per agent. Rows are added/edited/removed, then **Apply**
recreates the container once with all bindings.

## Storage

- New file `instances/<name>/web.json` — `[{ "name", "containerPort", "hostPort" }]`.
  meta.env is KEY=VALUE only (holds the ssh `PORT`); a list needs JSON.
- The ssh port (`PORT=<host>:22`) stays exactly as it is today — web services
  are separate from it and both coexist in `ports:`.
- `generateInstanceCompose(name, agent, password, port, opts)` gains
  `opts.webServices = []` and emits one `ports:` block:

```yaml
    ports:
      - "<sshHost>:22"
      - "8090:8000"
      - "8091:8080"
```

- `applyWebServices(name, services)` in `src/services/vm-manager.js`:
  1. validate + write `web.json`,
  2. regenerate compose (keeps ssh port, allowDocker, network from meta),
  3. return the list for the response. It does NOT stop/recreate — the route
     does that as an SSE job, same pattern as `POST /api/agents/:name/settings`.

## Backend routes (`src/app.js`)

- `GET /api/agents/:name/web` → `{ services: [...], sshPort }` read from
  `web.json` + meta. Also returns actual published ports from `docker inspect`
  so the UI can show if a binding is live.
- `POST /api/agents/:name/web` → body `{ services: [...] }` (full list, atomic
  replace). Validates then runs the settings-style job:
  - stop if running (`docker stop -t 30`),
  - `logStore.capture(name)` first (final lines survive),
  - `vm.applyWebServices(name, services)`,
  - `docker compose -f instances/<name>/docker-compose.yml up -d --no-deps --force-recreate <name>`,
  - `recordActivity(name, 'web', 'update', 'ok'|'error', summary)`.
  - Returns `202 { ok, job: 'update:<name>', streaming: true }`; the frontend
    streams it in the same Console popup used by settings/update.
  - On failure: restore old `web.json` + compose, try to start the container
    again (mirror the settings rollback path at `app.js:1022`).

### Validation
- `name`: required, non-empty.
- `containerPort`, `hostPort`: integers 1–65535.
- No duplicate host ports **within** the list.
- Host port conflict **across** agents: scan every `instances/*/docker-compose.yml`
  for `"<n>:"` and reject with `Port <n> already in use by <agent>`. Also check
  the live `docker ps` published ports as a second net (covers containers not
  in our compose files). Both are advisory errors returned as 400, not job failures.
- Host port must not collide with the agent's own ssh port.
- Container port can be the same on several rows (different host ports) — fine.

## Frontend

- `AgentDetail.jsx`: add `{ id: 'web', label: 'Web' }` to `MODES` (after
  `commands`), new tab file `src/client/src/pages/agent/WebTab.jsx`.
- `WebTab.jsx`:
  - Table of rows: name, container port, host port, live status pill
    (`listening`/`down` from the `docker inspect` actual ports), access link
    `http://<host>:<hostPort>` (open in new tab).
  - Inline add/edit form rows (same feel as Vault edit rows): name + container
    port + host port. Remove button per row.
  - **Apply** button: confirm modal listing the resulting bindings, then POST
    the full list; on `streaming` show the Console popup, on done refetch +
    toast. Disabled when the list is unchanged.
  - Live-status probe: after recreate, poll `GET /api/agents/:name/web` once
    (or a dedicated `GET /api/agents/:name/web/:hostPort/status` doing a
    `docker exec` curl / TCP check) to flip the pill — nice-to-have, see Testing.
  - Port-conflict errors from the 400 render inline at the top of the tab.

## Files touched

- `src/services/vm-manager.js` — `opts.webServices` in
  `generateInstanceCompose`, new `applyWebServices()`, `readWebServices()`.
- `src/app.js` — `GET/POST /api/agents/:name/web` + conflict scan + job.
- `src/client/src/pages/AgentDetail.jsx` — new MODES entry.
- `src/client/src/pages/agent/WebTab.jsx` — new tab.
- `src/services/drivers/*.js` — new `webApp` descriptor per driver
  (openclaw/opencode/hermes/picoclaw presets, codex/claude `null`).
- `container-health.js` — no change needed: it already diffs declared compose
  `ports:` against actual and will report a missing binding as an error
  (good free coverage).

## Testing

1. `cd src/client && npm run build` then `docker restart paddock`
   (bind mount serves the built bundle — a JSX edit alone does nothing).
2. Create/use a test agent. In the Web tab add e.g. `python -m http.server 8000`
   served from a workspace dir via the terminal, then add a service row
   `{ name: demo, containerPort: 8000, hostPort: 8090 }` → Apply → SSE job runs,
   container recreates, `curl http://10.69.1.164:8090` returns the page.
3. Built-in web app test: for an openclaw agent, add `{ name: dashboard,
   containerPort: 18789, hostPort: 18789 }` and verify the Control UI loads
   (auth token prompt expected). Same idea for hermes on 9119 and picoclaw on
   18790.
3. Conflict test: try binding a host port already used by another agent → 400
   with the owner name.
4. Recreate the container again via Settings (docker toggle) — web bindings
   must survive (they live in the regenerated compose, not the container).
5. `docker exec paddock node --test test/services.test.js` stays green.

## Edge cases / decisions

- **Stop during apply**: if the container is stopped the job skips `docker
  stop` and just regenerates + `up -d --force-recreate` (which starts it).
- **Apply while a service inside isn't running yet**: binding is still created;
  the pill shows `down` until the agent starts serving. That's expected — the
  webui only binds ports.
- **Delete agent** already removes the container + instance dir; `web.json`
  goes with the dir. No extra cleanup.
- **Backup**: `web.json` should ride along in backups — check
  `backup-manager.js` includes whole instance dir (it does today for meta.env;
  keep it that way).
