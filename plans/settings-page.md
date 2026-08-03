# Settings Page — Plan

**Date:** 2026-08-03
**Status:** Plan
**Sources:** `plans/reconstruction.md` (dead settings.ejs), `plans/coding-agent-builds.md` Part 2 (docker checkbox), `plans/paddock-own-mcp.md` (fleet MCP server), `plans/create-agent.md` (SSE/job-log streaming the Update card reuses)

## Goal

Add a **Settings** tab to the agent page that brings back the old settings page
(container info + delete) that was never ported to React, plus the docker/control
checkbox from the coding-agent-builds plan and a new **Network** option:

- **Update** button — redownload the image (`build --pull`), rebuild it, and
  recreate the container from the fresh image, streaming the whole run into a
  **console-style pane** (real-time output, not the interactive terminal). The
  recreate restarts the container automatically when it's done.
- **"Allow docker in the container"** checkbox — gives the agent raw docker
  (socket + CLI) **and** installs the **Paddock project MCP** into the agent, so
  it can manage other agents through `paddock_*` MCP tools
- **Network** dropdown — route the agent's traffic through **another running
  container** (e.g. gluetun for VPN) by joining that container's network
  namespace
- Danger Zone delete

One tab, five cards.

## What we know from the old plans

- **reconstruction.md** — old `src/views/agents/settings.ejs` showed **Container
  Info** (name, runtime, status, image) + a **Danger Zone** "Delete Container"
  button. It was never ported to React; the plan says it should become a tab in
  `AgentDetail.jsx`. The EJS file is dead code today (`routes/agents.js` is
  unmounted). The delete route already exists server-side
  (`POST /api/agents/:name/delete`, `app.js:554`) but has **no UI wired to it**
  in the SPA.
- **coding-agent-builds.md** — Part 2 planned a Settings mode with one checkbox:
  **"Allow docker in the container"**. Toggling it stops the agent, regenerates
  the instance compose file with the `/var/run/docker.sock:/var/run/docker.sock`
  volume, and restarts. State stored in `meta.env` (`DOCKER=1`). Compose files
  are machine-generated, so regeneration is the source of truth.
- **paddock-own-mcp.md** — the webui itself exposes an MCP server at `/mcp`
  (Streamable HTTP, `MCP_TOKEN` bearer auth) with `paddock_*` tools:
  `paddock_list_agents`, `start/stop/restart_agent`, `paddock_exec`,
  `workspace_list/read/write`, `agent_logs`, `config_get`, `backup_*`. This is
  the "project's MCP". **This plan is a prerequisite** — the settings toggle
  installs this MCP into the agent, so `/mcp` + `MCP_TOKEN` must exist first.

## The Settings tab

Add `{ id: 'settings', label: 'Settings' }` to `MODES` in
`AgentDetail.jsx:8-15`.

The Settings tab (old settings.ejs + coding-agent-builds Part 2 + new Network
option + new Update). Five cards, top to bottom:

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
- Clicking it starts a background job (same shape as `plans/create-agent.md`):
  1. **Pull + build** — `docker compose -f <instance-compose> build --pull <name>`.
     `--pull` always redownloads the base image first, so a `:latest` tag gets a
     fresh copy, then rebuilds (installs the docker CLI, openclaw, etc.).
  2. **Recreate** — `docker compose -f <instance-compose> up -d --no-deps
     --force-recreate <name>`. This tears down the old container and starts a
     new one from the fresh image — **the restart is automatic, no separate
     restart step**.
- Output streams into a **console-style pane** (a read-only line feed, the same
  `Console` component used by Create Agent / Health / Messaging) — a console,
  not the interactive xterm terminal. Steps are labeled as they start:
  - **Pull/build** — `build --pull` output
  - **Recreate** — `up -d --force-recreate` output
  - **Done** — success line, then the tab refetches agent status so the info
    card / dashboard reflect the new image and uptime.
- Same transport as create-agent: `POST /api/agents/:name/update` returns `202`
  and starts a job; `GET /api/agents/:name/update-log?since=<n>` is an SSE
  stream of `step`/`line`/`done`/`error` events with replay-on-reconnect. Reuses
  `src/services/job-log.js` and `runCmdStream()` from the create-agent plan.
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
> (docker CLI + host socket) **and** installs the Paddock project MCP into the
> agent so it can manage other agents.

- Toggling **on** shows a confirm popup:
  > "This will stop and restart `<name>` to apply the change. Continue?"
- Same confirm when toggling **off**.
- The warning text must say the socket is **host-root equivalent**.
- If the image has no docker CLI, the toggle errors instead of succeeding
  (see guard rails).

#### What "on" does (two parts)

1. **Docker** (coding-agent-builds flow): stop → regenerate compose with the
   socket volume → start. `meta.env` `DOCKER=1`.
2. **Paddock MCP install** — the agent gets the project's MCP so it can manage
   other agents:
   ```
   docker exec <name> openclaw mcp add --no-probe paddock \
     --url http://<webui-host>:6789/mcp \
     --transport streamable-http \
     --env PADDOCK_TOKEN=<MCP_TOKEN>
   ```
   - Reuses the existing `POST /api/agents/:name/mcp/add` command builder
     (`app.js:949-975`) — same `openclaw mcp add` shape.
   - **Connectivity**: the agent reaches the webui over the host IP
     (`http://10.69.1.164:6789/mcp`), matching the client configs in
     `paddock-own-mcp.md`. Instances sit on their own bridge networks, so
     container-name DNS to the webui is not guaranteed — host IP is the default.
   - The agent's env var carries the bearer token (the webui injects
     `MCP_TOKEN` from its own env when running the `mcp add` command).
   - Tool exposure: `paddock_list_agents`, `paddock_start/stop/restart_agent`,
     `paddock_exec`, workspace/logs/config/backup tools — that's how the agent
     manages another agent.

#### What "off" does

1. `docker exec <name> openclaw mcp remove paddock`
2. stop → regenerate compose without the socket volume → start.
3. `meta.env` `DOCKER=0`, `PADDOCK_MCP=0` (or clear).

> Note: the MCP gives *controlled* fleet management (the webui's tools). The
> docker socket is the *raw* capability on top. If we ever want the MCP without
> raw docker, split this into two toggles — see Open questions.

### 4. Network (dropdown)

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
  the same confirm popup ("This will stop and restart `<name>`...").
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

### 5. Danger Zone — Delete Container

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
- `GET /api/agents/:name/settings` → `{ allowDocker, network, image }`
  - `allowDocker` read from `meta.env` `DOCKER=1|0` (absent = `false`).
    More robust than parsing compose YAML.
  - `network` read from `meta.env` `NETWORK=<container>` (absent = `''`).
  - `image` from `AGENT_IMAGES[agent_type]` (export the map from
    `vm-manager.js` or move it to a shared constant).
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
  3. If `allowDocker` changed → install/remove the Paddock MCP in the agent:
     `docker exec <name> openclaw mcp add/remove paddock ...` (reuse the
     `mcp/add` command builder; `MCP_TOKEN` from webui env).
  4. `docker stop <name>` (no-op if already stopped).
  5. Read `meta.env` (agent type, password, port), regenerate the compose file
     with the socket volume + `network_mode: container:<network>` via
     `writeInstanceCompose()`.
  6. `docker start <name>`.
  7. Write `DOCKER=1|0`, `PADDOCK_MCP=1|0` and `NETWORK=<container>` (or clear
     it) to `meta.env`.
  8. Record an activity entry (jobLog pattern), return the new state.

### `src/services/vm-manager.js`

- `generateInstanceCompose(name, agent, password, port, { allowDocker, network })`:
  - when `allowDocker`, add the volume line:
    `    - /var/run/docker.sock:/var/run/docker.sock`
  - when `network` set, add:
    `    network_mode: container:<network>`
- `writeInstanceCompose()` passes the options through.
- New helper `updateAgent(name, { onLog, onStep })` — runs
  `docker compose -f <path> build --pull <name>` (long timeout, ~900s), then
  `up -d --no-deps --force-recreate <name>`, feeding every chunk through
  `onLog`. Built on `runCmdStream()`.
- New helper `applySettings(name, { allowDocker, network })` — reads meta,
  regenerates compose, returns the yaml (the route does the MCP install +
  stop/start around it). Keep `app.js` thin.
- Export `AGENT_IMAGES` (or a `hasDockerCli(agent)` helper) for the
  image-no-CLI guard.
- New helper `installPaddockMcp(name)` / `removePaddockMcp(name)` — wraps the
  `openclaw mcp add/remove paddock` docker exec (shares the command builder with
  the existing `/api/agents/:name/mcp/add` route).

### `src/services/agent-registry.js` (optional)

- Expose `allowDocker`, `network` (from `meta.env` DOCKER/NETWORK) and `image`
  on the agent object in `buildAgent()` so the tab can render from `agent`
  alone, no extra fetch.

## Files

**New:**
- `src/client/src/pages/agent/SettingsTab.jsx` — the tab (separate file, same
  pattern as `CommandsPane.jsx`; `AgentDetail.jsx` is already 744 lines)

**Modified:**
- `src/client/src/pages/AgentDetail.jsx` — add `settings` to `MODES`, render
  `<SettingsTab agent={agent} />`
- `src/app.js` — `GET/POST /api/agents/:name/settings` + `GET /api/containers` +
  `installPaddockMcp`/`removePaddockMcp` helpers + `POST /api/agents/:name/update`
  and `GET /api/agents/:name/update-log` (reuses `job-log.js`)
- `src/services/vm-manager.js` — `allowDocker` + `network` options, an
  `applySettings()` helper, `updateAgent()` (build --pull + force-recreate), and
  export `AGENT_IMAGES`
- `src/services/agent-registry.js` — optional `allowDocker`/`network`/`image`
  on agent
- `src/docs/architecture.md` + `docs/` tree — document the new settings tab
  and endpoints (same cleanup rules as the other recent doc work)

**Prerequisite (build first):** `plans/paddock-own-mcp.md` — the `/mcp` endpoint
on the webui + `MCP_TOKEN` env plumbing. Without it, the "Allow docker" toggle
can't install the project MCP (falls back to docker-socket-only, or errors).

## Guard rails (from coding-agent-builds.md)

| Case | Handling |
|------|----------|
| docker socket = host root | Prominent warning in the confirm popup |
| Image without docker CLI | Toggle errors with a hint: "image has no docker CLI — rebuild the image" instead of silently succeeding |
| Container already stopped | Skip stop, still edit + start |
| Restart kills the running session | Confirm popup warns first |
| Compose file hand-edited | Regeneration overwrites it — documented as machine-generated |
| Network target not running | Rejected at save time; if it stops later, agent loses network (show warning; dropdown marks it `stopped`) |
| Network target = the agent itself | Rejected — no self-reference |
| Network target deleted | Agent keeps `network_mode: container:<gone>` and fails to start — clear the setting to recover |
| `/mcp` not built / `MCP_TOKEN` unset | "Allow docker" MCP install step errors with a clear hint; socket-only part still applies |
| Agent compromised | It holds `MCP_TOKEN` = full fleet control (same trust as a webui session) — warn in the popup and docs |
| MCP install fails mid-toggle | Don't write `DOCKER=1`; roll back compose; report the mcp add error |
| `mcp remove` on an agent without the server | No-op, continue (idempotent) |
| Update while registry/network down | `build --pull` fails → old container untouched (recreate never runs); error tail in the console, Retry available |
| Build succeeds but recreate fails | Container left stopped or half-recreated; console shows the `up` error; Retry re-runs from `build --pull` |
| `:latest` version bump changes storage format | AGENTS.md "Updating OpenClaw to latest": after the recreate the agent may need `openclaw doctor --fix` (e.g. cron JSON → SQLite). Surface a hint in the Done line for openclaw-type agents |
| Update while agent is running | Fine — `--force-recreate` handles it; the running session is lost (same warning text as the docker toggle) |
| Update on an agent pinned to a version | `build --pull` still pulls the pinned tag; no surprise (pin = no drift) |

## Phases

### Phase 1 — Info + Danger Zone (no restart, safe)
- Settings tab with Container Info card + Delete button wiring the existing
  `POST /api/agents/:name/delete`.
- Pure read + an already-existing write route. No vm-manager changes needed.

### Phase 2 — Update (image refresh)
- Needs the streaming infra from `plans/create-agent.md` (`job-log.js` +
  `runCmdStream()`).
- Update card + `POST /api/agents/:name/update` + SSE `update-log` route +
  console pane in `SettingsTab.jsx`.
- Build is the risky/long step — generous timeout, SSE keep-alives, failure
  leaves the old container running.

### Phase 3 — Docker toggle + Network
- `allowDocker` + `network` in compose generation, `meta.env` `DOCKER`/`NETWORK`
  flags, `GET /api/containers`, `GET/POST /api/agents/:name/settings`,
  stop/edit/start flow, confirm popup, image-no-CLI guard, network-target
  validation.

### Phase 4 — Paddock MCP install (fleet control)
- Requires `paddock-own-mcp.md` shipped (`/mcp` + `MCP_TOKEN`).
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

Phase 3:
```bash
curl -X POST http://10.69.1.164:6789/api/agents/<pad>/settings -d '{"allowDocker":true}' -H 'Content-Type: application/json' -H 'X-CSRF-Token: ...'
docker inspect <pad> --format '{{range .Mounts}}{{.Source}} {{.Destination}}{{"\n"}}{{end}}'
# → /var/run/docker.sock /var/run/docker.sock
docker exec <pad> docker ps       # works (coding image with CLI)
```
- Toggle off → mount gone, `docker ps` inside fails.
- Toggle on an openclaw PAD (no CLI in image) → error with rebuild hint.
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
- **Docker CLI on openclaw image too?** coding-agent-builds.md leaves it open —
  "only the new coding images for now". The checkbox is type-agnostic, so the
  guard rail matters for openclaw PADs until its image gets the CLI.
- **Flag storage**: `meta.env` `DOCKER=1` / `NETWORK=<container>` (coding
  plan's lean) — but the agent registry parses meta.env already, so this is the
  natural home.
- **Named Docker networks**: should the dropdown ever list named networks
  (`networks:` in compose) in addition to containers (`network_mode: container:`)?
  The user asked for containers; named networks are a possible later add.
- **MCP vs raw docker**: should the "Allow docker" toggle be split into two —
  "Control fleet (Paddock MCP)" and "Raw docker socket+CLI"? Today they're
  bundled; the MCP is the controlled path, the socket is the root-equivalent one.
- **Connectivity**: host IP (`10.69.1.164:6789/mcp`) vs putting agents on the
  webui's network so they reach it as `http://paddock:6789/mcp`. Host IP is
  simplest and matches the MCP plan's client configs.
- **Version pinning**: Update follows whatever `:latest` is. AGENTS.md flags the
  `:latest` risk (breaking changes land under the same tag). Should update also
  offer pinning a version (e.g. `v2026.6.1`) instead of always chasing the tag?

## Related

- `plans/coding-agent-builds.md` — Part 2 is the docker checkbox this pulls in;
  Phase 2 of that plan becomes Phase 3 here.
- `plans/create-agent.md` — the **streaming infra** the Update card reuses:
  `job-log.js`, `runCmdStream()`, SSE `create-log` shape, `Console.jsx`.
- `plans/paddock-own-mcp.md` — **prerequisite**; the `/mcp` fleet server +
  `MCP_TOKEN` that Phase 4 installs into enabled agents.
- `plans/reconstruction.md` — §"Dead Settings Page" section this revives.
- `src/views/agents/settings.ejs` — the old page being replaced (delete after).
