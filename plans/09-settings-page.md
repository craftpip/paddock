# Settings Page — Plan

**Date:** 2026-08-03
**Status:** Implemented (Phases 1-3) — Phase 4 (Paddock MCP toggle) deferred by user decision 2026-08-04. **2026-08-04 +popup console:** Update, the docker toggle, and the network change all open a modal popup (`CommandModal.jsx`) that streams the job output live, instead of an inline pane. **2026-08-04 +version check:** Container Info shows the current OpenClaw version; clicking Update first checks current vs available (latest base image) and shows a confirm dialog with both versions before starting.
**Absorbed into docs:** `docs/tabs/settings.md` (+ `docs/tabs/overview.md`, `docs/backend/services.md`, `docs/operations/overview.md`). This file stays as the record of the deferred Phase 4 (MCP toggle) and the original design notes.
**Sources:** `plans/08-multiple-agents.md` Part 2 (docker checkbox), `plans/06-paddock-own-mcp.md` (fleet MCP server), `docs/operations/overview.md` Create flow (SSE/job-log streaming the Update card reuses)

## Goal

Add a **Settings** tab to the agent page that brings back the old settings page
(container info + delete) that was never ported to React, plus the docker/control
checkbox from the multiple-agents plan and a new **Network** option:

- **Update** button — redownload the image (`build --pull`), rebuild it, and
  recreate the container from the fresh image, streaming the whole run into a
  **console-style pane** (real-time output, not the interactive terminal). The
  recreate restarts the container automatically when it's done.
- **"Allow docker in the container"** toggle — gives the agent raw docker
  (socket + CLI) only. **Split off from the MCP install** (user decision
  2026-08-04) — this toggle is raw docker and nothing else.
- **"Install Paddock MCP"** toggle — **deferred**, not implemented. Would
  install the Paddock project MCP into the agent so it can manage other agents
  through `paddock_*` MCP tools. Requires `plans/06-paddock-own-mcp.md` (the
  webui `/mcp` server) which doesn't exist yet.
- **Network** dropdown — route the agent's traffic through **another running
  container** (e.g. gluetun for VPN) by joining that container's network
  namespace
- Danger Zone delete

One tab, six cards (five implemented, the MCP toggle deferred).

## What we know from the old plans

- **Old settings page** — old `src/views/agents/settings.ejs` showed **Container
  Info** (name, runtime, status, image) + a **Danger Zone** "Delete Container"
  button. It was never ported to React; the plan says it should become a tab in
  `AgentDetail.jsx`. The EJS file is dead code today (`routes/agents.js` is
  unmounted). The delete route already exists server-side
  (`POST /api/agents/:name/delete`, `app.js:554`) but has **no UI wired to it**
  in the SPA.
- **08-multiple-agents.md** — Part 2 planned a Settings mode with one checkbox:
  **"Allow docker in the container"**. Toggling it stops the agent, regenerates
  the instance compose file with the `/var/run/docker.sock:/var/run/docker.sock`
  volume, and restarts. State stored in `meta.env` (`DOCKER=1`). Compose files
  are machine-generated, so regeneration is the source of truth.
- **06-paddock-own-mcp.md** — the webui itself exposes an MCP server at `/mcp`
  (Streamable HTTP, bearer auth via API keys) with `paddock_*` tools:
  `paddock_list_agents`, `start/stop/restart_agent`, `paddock_exec`,
  `workspace_list/read/write`, `agent_logs`, `config_get`, `backup_*`. This is
  the "project's MCP". **This plan is a prerequisite** — the settings toggle
  installs this MCP into the agent, so `/mcp` must exist first.

## The Settings tab

Add `{ id: 'settings', label: 'Settings' }` to `MODES` in
`AgentDetail.jsx:8-15`.

The Settings tab (old settings.ejs + multiple-agents Part 2 + new Network
option + new Update). Six cards, top to bottom:

### 1. Container Info (read-only)

| Field | Source |
|-------|--------|
| Name | `agent.name` |
| Agent type | `agent.agent_type` (from `meta.env` AGENT) |
| Runtime | `agent.runtime_type` (`docker`) |
| Status | `agent.status` |
| Image | `AGENT_IMAGES[agent_type]` from `vm-manager.js`, or `docker inspect` on the container |

### 2. Update (image refresh)

> **Update** — redownload the base image, rebuild it, and recreate the
> container from the new image. The whole run shows in a console-style pane
> (real-time output), and when it's done the container restarts automatically.

- Sits right under Container Info — it's the "image" card: one **Update** button
  plus a short "what it does" note.
- **Version check + confirm (2026-08-04):** clicking Update first calls
  `GET /api/agents/:name/update-info` which reports the **current** OpenClaw
  version (from the running container, or the built image when stopped) and the
  **available** version (the latest base image, pulled + version label read,
  cached 5 min). A confirm dialog then shows:
  - `An update is available — current X, available Y` (versions differ)
  - `No update available — already on the latest version (X)`, update still runs
    if confirmed (rebuilds same version). This is how the user judges whether
    the `:latest` tag moved: when the version stops changing, they're current.
- Clicking it starts a background job (same shape as the create flow in `docs/operations/overview.md`):
  1. **Pull + build** — `docker compose -f <instance-compose> build --pull <name>`.
     `--pull` always redownloads the base image first, so a `:latest` tag gets a
     fresh copy, then rebuilds (installs the docker CLI, openclaw, etc.).
  2. **Recreate** — `docker compose -f <instance-compose> up -d --no-deps
     --force-recreate <name>`. This tears down the old container and starts a
     new one from the fresh image — **the restart is automatic, no separate
     restart step**.
- Output streams into a **modal popup console** — `CommandModal.jsx` (a
  read-only line feed, same `Console` component used by Create Agent / Health /
  Messaging), not the interactive xterm terminal and not an inline pane. The
  popup shows the exact commands as they run (e.g. `docker stop <name>`,
  `docker compose -f instances/<name>/docker-compose.yml up -d --no-deps
  --force-recreate <name>`), a Running/Done/Failed badge, and a Close button
  (Escape works; while busy it notes the job "continues in the background").
  Steps are labeled as they start:
  - **Pull/build** — `build --pull` output
  - **Recreate** — `up -d --force-recreate` output
  - **Done** — success line, then the tab refetches agent status so the info
    card / dashboard reflect the new image and uptime.
- Same transport as create-agent: `POST /api/agents/:name/update` returns `202`
  and starts a job; `GET /api/agents/:name/update-log?since=<n>` is an SSE
  stream of `step`/`line`/`done`/`error` events with replay-on-reconnect. Reuses
  `src/services/job-log.js` and `runCmdStream()` from the create-agent plan.
- **All three run-a-command actions share the same popup + SSE job path:** the
  docker toggle and network change return `202 { job, streaming, reason }` too
  and stream through the same `/update-log` endpoint — the popup is identical.
- **Failure:** the console keeps the error tail, the agent is left as-is (if
  the recreate step failed, the old container is still running — the recreate is
  the last step), and a **Retry** button shows. Never navigate away.

Card look:

```
┌── Update ─────────────────────────────────────────────────────────────────────┐
│                                                                               │
│  Update                                                                       │
│  Redownloads the image, rebuilds it, and recreates the container.             │
│  The container restarts automatically when it's done.                         │
│                                                                               │
│  [  Update  ]                                                                 │
│                                                                               │
│  ┌─ console pane (appears while running) ───────────────────────────┐        │
│  │ $ docker compose build --pull <name>                             │        │
│  │ …pull/build output…                                               │        │
│  │ $ docker compose up -d --no-deps --force-recreate <name>         │        │
│  │ …up output…  → Recreated — container restarted                   │        │
│  └────────────────────────────────────────────────────────────────────┘        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### 3. Allow docker in the container (toggle)

> **Allow docker in the container** — lets this agent run `docker` commands
> (docker CLI + host socket). Raw docker only; the Paddock MCP install is a
> **separate** toggle (card 4), deferred.

- Toggling **on** shows a confirm popup:
  > "This will stop and restart `<name>` to apply the change. Continue?"
- Same confirm when toggling **off**.
- The warning text must say the socket is **host-root equivalent**.
- If the image has no docker CLI, toggling **on** triggers a rebuild of the
  image with `--build-arg INSTALL_DOCKER=1` (base images ship without the CLI on
  purpose), streamed through the same SSE console as Update, then recreates the
  container with the socket mounted. Toggling **off** never rebuilds — it just
  removes the socket mount (the CLI stays in the image, inert without the
  socket).

#### What "on" does

1. If the image already has the docker CLI: stop → regenerate compose with the
   socket volume → recreate. `meta.env` `DOCKER=1`. The whole run streams in the
   same popup console as Update.
2. If the image has **no** docker CLI: respond `202 { job, streaming, reason:
   'rebuild' }`, then
   stop → `applySettings` (DOCKER=1 + socket) → `updateAgent({ buildArgs:
   ['INSTALL_DOCKER=1'], pull: false })` → recreate. The frontend opens the
   popup and streams the build log via `/api/agents/:name/update-log` like
   Update. On failure the
   settings are rolled back to the previous state and the agent is brought back
   up.

#### What "off" does

1. stop → regenerate compose without the socket volume → recreate.
2. `meta.env` `DOCKER=0`. Never rebuilds — the CLI stays in the image, inert
   without the socket. Streamed in the popup console.

> Note: originally this card bundled raw docker **and** the Paddock MCP install.
> The user decided (2026-08-04) they are two separate toggles — raw docker is
> implemented here; the MCP install is card 4 and is deferred. See Open questions
> (now resolved).

### 4. Install Paddock MCP (toggle — DEFERRED, not implemented)

> **Install Paddock MCP** — installs the Paddock project MCP into the agent so
> it can manage other agents through `paddock_*` MCP tools (controlled fleet
> management through the webui's `/mcp`, vs the raw docker socket on card 3).

**Deferred by user decision 2026-08-04.** All other options were implemented;
this one was explicitly not. Requires `plans/06-paddock-own-mcp.md` shipped
(the webui `/mcp` server + API key auth) — that plan is not implemented yet
(no `src/mcp.js`, nothing mounted at `/mcp`).

When it does get built:

- Toggle-on runs inside the agent:
  ```
  docker exec <name> openclaw mcp add --no-probe paddock \
    --url http://<webui-host>:6789/mcp \
    --transport streamable-http \
    --env PADDOCK_TOKEN=<pk_live_key>
  ```
- Toggle-off runs `docker exec <name> openclaw mcp remove paddock`.
- Connectivity via host IP (`http://10.69.1.164:6789/mcp`), bearer token from
  the webui's `api-keys.js`.
- Tool exposure: `paddock_list_agents`, `paddock_start/stop/restart_agent`,
  `paddock_exec`, workspace/logs/config/backup tools.

### 5. Network (dropdown)

> **Network** — route this agent's traffic through another running container
> by joining its network namespace (e.g. a gluetun container for VPN).

- Dropdown of **all running containers** visible to the webui (from
  `docker ps` / dockerode via the socket), plus the default option:
  `Default (no override)`.
- Picking a container sets `network_mode: container:<name>` on the agent's
  compose file. The agent then shares that container's network stack (own
  namespace is dropped — the agent becomes "a process on the other container's
  network").
- Applies the same stop → regenerate → start flow as the docker checkbox, with
  the same confirm popup ("This will stop and restart `<name>`...") and the same
  popup console streaming the recreate while it runs.
- If the currently selected network container is stopped, still show it in the
  list (badged `stopped`) so it can be cleared — `network_mode: container:`
  only works while the target is running.
- Note: compose's `network_mode: service:<name>` only works within the same
  compose file; each agent has its own file, so cross-container joining is done
  with `container:` mode, not `service:`. If we ever want a named Docker
  network (e.g. a shared `bridge`) instead of a container, that's a separate
  `networks:` option — out of scope for now (see Open questions).

Card look:

```
┌── Network ──────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Network                                                                     │
│  Route this agent's traffic through another running container                │
│  by joining its network namespace (e.g. gluetun for VPN).                    │
│                                                                              │
│  [ Default (no override)        ▾ ]  ← dropdown of running containers       │
│      Default (no override)                                                    │
│      gluetun                         ← target image                          │
│      pad-work-openclaw                                                        │
│      nginx-proxy                    (…stopped containers marked "stopped")   │
│                                                                              │
│  ⚠  Joining a container's network means the agent shares its network        │
│     stack. If the target stops, the agent loses its network.                 │
│                                                                              │
│  (saving shows: "This will stop and restart <name> to apply the change.      │
│   Continue?  [Cancel] [Continue])"                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6. Danger Zone — Delete Container

- Same as the old `settings.ejs`: warning text + red "Delete Container" button.
- Wires up the **existing** `POST /api/agents/:name/delete` (`app.js:554`) —
  the API is already there, the SPA just never calls it.
- Confirm modal (danger styling), text: "Permanently delete `<name>`, its
  container, and all files. This cannot be undone."

## Backend

### New endpoints (`src/app.js`)

- `GET /api/containers` — list containers for the Network dropdown. Return
  running containers from `docker ps` (via the existing `dockerPsList()`,
  `app.js:112`, or dockerode) as `{ name, image, state }`; include the
  currently-set network target even if stopped, so it can be cleared.
- `GET /api/agents/:name/settings` → `{ allowDocker, network, image, version }`
  - `allowDocker` read from `meta.env` `DOCKER=1|0` (absent = `false`).
    More robust than parsing compose YAML.
  - `network` read from `meta.env` `NETWORK=<container>` (absent = `''`).
  - `image` from `AGENT_IMAGES[agent_type]` (export the map from
    `vm-manager.js` or move it to a shared constant).
  - `version` — current OpenClaw version from `vm.readOpenClawVersion()`
    (running container, or built image), falling back to `meta.env`
    `OPENCLAW_VERSION` (written after each successful update).
- `GET /api/agents/:name/update-info` → `{ currentVersion, availableVersion,
  updateAvailable }` — powers the Update confirm dialog. Current from the
  running container/built image; available from the latest base image
  (`docker pull <base>` + read `org.opencontainers.image.version` label,
  cached 5 min). `updateAvailable` is true when both are known and differ.
- `POST /api/agents/:name/update` — `202` + background job (same job-log
  pattern as create-agent): `build --pull` then `up -d --no-deps
  --force-recreate` on the instance compose file. No body. The compose file is
  the source of truth and needs no edits — an update just rebuilds the image and
  recreates the container.
- `GET /api/agents/:name/update-log?since=<n>` — SSE stream of
  `step`/`line`/`done`/`error` events (same shape as `create-log`), replaying
  buffered lines after `since` for reconnect recovery. Uses `job-log.js`.
- `POST /api/agents/:name/settings` `{ allowDocker?: boolean, network?: string }`
  1. Validate name (`safeVmName`).
  2. If `network` is set, validate the target exists and is running (no
     self-reference, no phantom names).
  3. `docker stop <name>` (no-op if already stopped).
  4. Read `meta.env` (agent type, password, port), regenerate the compose file
     with the socket volume + `network_mode: container:<network>` via
     `writeInstanceCompose()`.
  5. `docker start <name>`.
  6. Write `DOCKER=1|0` and `NETWORK=<container>` (or clear it) to `meta.env`.
  7. Record an activity entry (jobLog pattern), return the new state.

  > No MCP install/remove step — that toggle (card 4) is deferred. When it lands,
  > add the `openclaw mcp add/remove paddock` docker exec around the stop/start.

### `src/services/vm-manager.js`

- `generateInstanceCompose(name, agent, password, port, { allowDocker, network })`:
  - when `allowDocker`, add the volume line:
    `    - /var/run/docker.sock:/var/run/docker.sock`
  - when `network` set, add:
    `    network_mode: container:<network>`
- `writeInstanceCompose()` passes the options through.
- New helper `updateAgent(name, { onLog, onStep, buildArgs, pull })` — runs
  `docker compose -f <path> build [--pull] [--build-arg K=V …] <name>` (long
  timeout, ~900s), then `up -d --no-deps --force-recreate <name>`, feeding
  every chunk through `onLog`. Built on `runCmdStream()`.
- New helper `applySettings(name, { allowDocker, network })` — reads meta,
  regenerates compose, returns the yaml (the route does the MCP install +
  stop/start around it). Keep `app.js` thin.
- Version helpers: `readOpenClawVersion(name, image)` (running container →
  built image → `''`), `readBaseImageVersion(agentType)` (pull base + read
  `org.opencontainers.image.version` label, normalized, 5-min cache),
  `getUpdateInfo(name, agentType)` → `{ currentVersion, availableVersion,
  updateAvailable }`. Base image per agent type in `AGENT_BASE_IMAGES`.
- Export `AGENT_IMAGES` (or a `hasDockerCli(agent)` helper) for the
  image-no-CLI guard.
- New helper `installPaddockMcp(name)` / `removePaddockMcp(name)` — wraps the
  `openclaw mcp add/remove paddock` docker exec (shares the command builder with
  the existing `/api/agents/:name/mcp/add` route). **Not built yet** — for the
  deferred card 4.

### `src/services/agent-registry.js` (optional)

- Expose `allowDocker`, `network` (from `meta.env` DOCKER/NETWORK) and `image`
  on the agent object in `buildAgent()` so the tab can render from `agent`
  alone, no extra fetch.

## Files

**New:**
- `src/client/src/pages/agent/SettingsTab.jsx` — the tab (separate file, same
  pattern as `CommandsPane.jsx`; `AgentDetail.jsx` is already 744 lines)
- `src/client/src/components/CommandModal.jsx` — the popup console that streams
  `/update-log` SSE for Update, docker toggle, and network change (all three use
  the same job path).

**Modified:**
- `src/client/src/pages/AgentDetail.jsx` — add `settings` to `MODES`, render
  `<SettingsTab agent={agent} />`
- `src/app.js` — `GET/POST /api/agents/:name/settings` + `GET /api/containers` +
  `POST /api/agents/:name/update` and `GET /api/agents/:name/update-log`
  (reuses `job-log.js`). (`installPaddockMcp`/`removePaddockMcp` helpers are
  NOT added — deferred card 4.) `GET /api/agents/:name/update-info` — version
  check for the Update confirm.
- `src/services/vm-manager.js` — `allowDocker` + `network` options, an
  `applySettings()` helper, `updateAgent()` (build --pull + force-recreate),
  `AGENT_BASE_IMAGES` + `getUpdateInfo`/`readOpenClawVersion`/
  `readBaseImageVersion` version helpers, and export `AGENT_IMAGES`
- `src/services/agent-registry.js` — optional `allowDocker`/`network`/`image`
  on agent
- `src/docs/architecture.md` + `docs/` tree — document the new settings tab
  and endpoints (same cleanup rules as the other recent doc work)

**Prerequisite (build first):** `plans/06-paddock-own-mcp.md` — the `/mcp` endpoint
on the webui. Without it, the "Install Paddock MCP" toggle (card 4) can't work.
That's why card 4 is deferred — the docker toggle (card 3) has no such
dependency and is already shipped.

## Guard rails (from 08-multiple-agents.md)

| Case | Handling |
|------|----------|
| docker socket = host root | Prominent warning in the confirm popup |
| Image without docker CLI | Base images ship without the CLI. Toggling on rebuilds the image with `--build-arg INSTALL_DOCKER=1` (SSE job, like Update), then recreates with the socket. Off never rebuilds |
| Container already stopped | Skip stop, still edit + start |
| Restart kills the running session | Confirm popup warns first |
| Compose file hand-edited | Regeneration overwrites it — documented as machine-generated |
| Network target not running | Rejected at save time; if it stops later, agent loses network (show warning; dropdown marks it `stopped`) |
| Network target = the agent itself | Rejected — no self-reference |
| Network target deleted | Agent keeps `network_mode: container:<gone>` and fails to start — clear the setting to recover |
| ~~`/mcp` not built / no API key~~ | ~~"Allow docker" MCP install step errors with a clear hint; socket-only part still applies~~ — MCP install is deferred (card 4), so this doesn't apply to the current docker toggle |
| Agent compromised | It holds a valid API key = full fleet control (same trust as a webui session) — warn in the popup and docs; revoke the key to cut it off. **Currently only matters once the MCP toggle ships** — the docker socket alone is root-equivalent |
| ~~MCP install fails mid-toggle~~ | ~~Don't write `DOCKER=1`; roll back compose; report the mcp add error~~ — deferred |
| ~~`mcp remove` on an agent without the server~~ | ~~No-op, continue (idempotent)~~ — deferred |
| Update while registry/network down | `build --pull` fails → old container untouched (recreate never runs); error tail in the console, Retry available |
| Build succeeds but recreate fails | Container left stopped or half-recreated; console shows the `up` error; Retry re-runs from `build --pull` |
| `:latest` version bump changes storage format | AGENTS.md "Updating OpenClaw to latest": after the recreate the agent may need `openclaw doctor --fix` (e.g. cron JSON → SQLite). Surface a hint in the Done line for openclaw-type agents |
| Update while agent is running | Fine — `--force-recreate` handles it; the running session is lost (same warning text as the docker toggle) |
| Update on an agent pinned to a version | `build --pull` still pulls the pinned tag; no surprise (pin = no drift) |

## Phases

> **All of Phases 1-3 are implemented (2026-08-04).** Phase 4 deferred.

### Phase 1 — Info + Danger Zone (no restart, safe) ✅
- Settings tab with Container Info card + Delete button wiring the existing
  `POST /api/agents/:name/delete`.
- Pure read + an already-existing write route. No vm-manager changes needed.

### Phase 2 — Update (image refresh) ✅
- Needs the streaming infra from the create flow (`docs/backend/services.md` — `job-log.js` +
  `runCmdStream()`).
- Update card + `POST /api/agents/:name/update` + SSE `update-log` route +
  console pane in `SettingsTab.jsx`.
- Build is the risky/long step — generous timeout, SSE keep-alives, failure
  leaves the old container running.

### Phase 3 — Docker toggle + Network ✅
- `allowDocker` + `network` in compose generation, `meta.env` `DOCKER`/`NETWORK`
  flags, `GET /api/containers`, `GET/POST /api/agents/:name/settings`,
  stop/edit/start flow, confirm popup, image-no-CLI guard, network-target
  validation.

### Phase 4 — Paddock MCP install (fleet control) ⏸ DEFERRED
- Requires `06-paddock-own-mcp.md` shipped (`/mcp` + API key auth).
- Toggle-on runs `openclaw mcp add paddock --url http://<webui>:6789/mcp`
  (with token) inside the agent; toggle-off runs `mcp remove`.
- Verify the enabled agent can `tools/list` the `paddock_*` tools and actually
  start/stop another PAD via `paddock_start_agent`.

## Verification

Phase 1:
- Open Settings tab on a test PAD; info card matches the dashboard; Delete opens
  confirm; confirming removes the agent (container + instance files gone,
  dashboard updates).

Phase 2 (Update):
```bash
curl -X POST http://10.69.1.164:6789/api/agents/<pad>/update
```
- Settings tab shows the console pane streaming `build --pull` then
  `up -d --no-deps --force-recreate` output in real time; ends with a
  "Recreated — container restarted" line.
- Container is up and restarted automatically afterward:
  ```bash
  docker inspect <pad> --format '{{.Image}}'          # new image digest
  docker ps --filter name=<pad> --format '{{.Status}}' # Up — recreated
  ```
- Dashboard + info card show the agent running again; a failed build (registry
  down) leaves the old container running and shows a Retry button.
- Pull the image before updating and confirm a "no changes" run still recreates
  cleanly (proves `--pull` + `--force-recreate` behave even when the image is
  unchanged).
- **Popup console (2026-08-04):** clicking Update opens the CommandModal popup
  that streams `docker stop <name>` + `docker compose -f instances/<name>/… up
  -d --no-deps --force-recreate <name>` live, shows Running → Done, and closes
  with the agent back up.
- **Version confirm (2026-08-04):** Container Info shows the current version;
  clicking Update shows a confirm dialog with current vs available
  (`GET /api/agents/:name/update-info`). When equal → "No update available —
  already on the latest version (X)"; when different → "An update is available
  (X → Y)". Cancel leaves the container untouched; confirm opens the popup
  console.

Phase 3:
```bash
curl -X POST http://10.69.1.164:6789/api/agents/<pad>/settings -d '{"allowDocker":true}' -H 'Content-Type: application/json' -H 'X-CSRF-Token: ...'
docker inspect <pad> --format '{{range .Mounts}}{{.Source}} {{.Destination}}{{"\n"}}{{end}}'
# → /var/run/docker.sock /var/run/docker.sock
docker exec <pad> docker ps       # works (coding image with CLI)
```
- Toggle off → mount gone, `docker ps` inside fails.
- Toggle on an openclaw PAD (no CLI in image) → `202` + the Update console
  streams the rebuild (`apt-get … docker.io`), then the container recreated with
  the socket; `docker exec <pad> docker ps` works. Toggle off → socket gone,
  `docker ps` inside fails (CLI remains in the image). A deliberately failed
  rebuild rolls the settings back and brings the agent back up.
- **Popup console (2026-08-04):** toggling docker opens the CommandModal popup
  streaming the recreate (`docker stop <name>` + `compose up -d --force-recreate`),
  Done badge, close refreshes agent state. Backend returns
  `202 { ok, job, streaming, reason: 'rebuild'|'docker' }` — the UI shows the
  popup whenever `streaming` is true.
- Toggling docker must **not** wipe an existing `NETWORK` override (regression
  found 2026-08-04 — fixed with `network !== undefined ? (network || '') :
  oldNetwork` in the settings POST).
- Restart flow records activity; session-loss warning shown first.

Network:
```bash
curl -X POST http://10.69.1.164:6789/api/agents/<pad>/settings -d '{"network":"gluetun"}' -H 'Content-Type: application/json' -H 'X-CSRF-Token: ...'
docker inspect <pad> --format '{{.HostConfig.NetworkMode}}'
# → container:gluetun
docker exec <pad> ip route       # shows the target container's routing (VPN)
```
- Setting network to a stopped container → rejected with a clear error.
- Setting it back to `Default` → `network_mode` gone, agent back on the compose
  bridge network.
- **Popup console (2026-08-04):** a network change opens the CommandModal popup
  streaming `docker stop <name>` + recreate, same as the docker toggle
  (`202 { reason: 'network' }`).
- Dropdown lists running containers; currently-set stopped target still visible
  and clearable.

Paddock MCP (Phase 4):
```bash
docker exec <pad> openclaw mcp list
# → paddock  (streamable-http, http://10.69.1.164:6789/mcp)
# from inside the agent: tools/list shows paddock_list_agents, paddock_start_agent, ...
docker exec <pad> openclaw mcp test paddock   # or ask the agent to list agents
```
- Enabled agent can call `paddock_start_agent`/`paddock_stop_agent` on a test
  PAD and see the dashboard change.
- Toggle off → `openclaw mcp list` no longer shows `paddock`, socket mount gone.

## Open questions

- **Image source**: `AGENT_IMAGES` lookup vs `docker inspect` vs storing in
  `meta.env`? Registry doesn't carry it today.
- **Docker CLI on openclaw image too?** **RESOLVED (2026-08-04)** — base images
  do NOT bake in the docker CLI. All three Dockerfiles (openclaw, hermes,
  picoclaw) take `ARG INSTALL_DOCKER=0` and only install the CLI when the
  settings toggle enables it.
- **Flag storage**: `meta.env` `DOCKER=1` / `NETWORK=<container>` (coding
  plan's lean) — but the agent registry parses meta.env already, so this is the
  natural home.
- **Named Docker networks**: should the dropdown ever list named networks
  (`networks:` in compose) in addition to containers (`network_mode: container:`)?
  The user asked for containers; named networks are a possible later add.
- **MCP vs raw docker**: **RESOLVED (2026-08-04)** — split into two toggles:
  "Allow docker" (raw socket+CLI) and "Install Paddock MCP" (controlled fleet
  management). The docker toggle is implemented; the MCP toggle is deferred
  until `06-paddock-own-mcp.md` ships.
- **Connectivity**: host IP (`10.69.1.164:6789/mcp`) vs putting agents on the
  webui's network so they reach it as `http://paddock:6789/mcp`. Host IP is
  simplest and matches the MCP plan's client configs.
- **Version pinning**: Update follows whatever `:latest` is. AGENTS.md flags the
  `:latest` risk (breaking changes land under the same tag). Should update also
  offer pinning a version (e.g. `v2026.6.1`) instead of always chasing the tag?

## Related

- `plans/08-multiple-agents.md` — Part 2 is the docker checkbox this pulls in;
  Phase 2 of that plan becomes Phase 3 here.
- `docs/backend/services.md` — the **streaming infra** the Update card reuses:
  `job-log.js`, `runCmdStream()`, SSE `create-log` shape, `Console.jsx`.
- `plans/06-paddock-own-mcp.md` — **prerequisite**; the `/mcp` fleet server +
  API key that Phase 4 installs into enabled agents.
- `src/views/agents/settings.ejs` — the old page being replaced (delete after).
