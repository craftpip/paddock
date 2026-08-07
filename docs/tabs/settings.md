# Settings Tab

Container-level operations for an agent: image refresh, docker access, network routing, and delete. Lives at the end of the tab bar in the agent detail page.

File: `src/client/src/pages/agent/SettingsTab.jsx`. Wired into `AgentDetail.jsx` as `{ id: 'settings', label: 'Settings' }` in `MODES`.

## Cards

### 1. Container Info (read-only)

Name, agent type, runtime, status, and image. Image comes from `getDriver(agent).buildImage` in `src/services/drivers/` (`paddock-vm-openclaw:latest`, `paddock-vm-picoclaw:latest`, etc.).

### 2. Update (image refresh)

Redownloads the base image (`--pull`), rebuilds it, and recreates the container — the recreate restarts it automatically. Runs as a background job; output streams into a console pane (the same `Console` component used by Create Agent).

- POST returns `202 { ok: true, job: "update:<name>", streaming: true }`, the job runs in `setImmediate`
- Two steps, streamed as `step` events: **build** (`docker compose -f <instance-compose> build --pull <name>`, 900s timeout), then **recreate** (`docker compose -f <instance-compose> up -d --no-deps --force-recreate <name>`, 300s timeout)
- A `system` line "Done — container recreated" ends the run, then the tab refetches agent state
- On failure the console keeps the error tail, the old container is left running (recreate is the last step), and a **Retry** button shows. The tab never navigates away.

### 3. Allow docker in the container (toggle)

Raw docker (docker CLI + host socket). Toggling mounts `/var/run/docker.sock:/var/run/docker.sock` in the agent's compose file and sets `DOCKER=1|0` in `meta.env`.

- Toggle-on runs stop → regenerate compose → start; same for off
- Confirm popup warns the docker socket is **host-root equivalent** (the agent could control the entire host)
- Guard rail: if the image has no docker CLI (`docker exec <name> sh -lc 'command -v docker'` fails while the container runs), the toggle errors with "The image has no docker CLI — rebuild the image to enable docker access". Drivers set `installDockerBuildArg` (`INSTALL_DOCKER=1`) — when the CLI is missing the settings route rebuilds the image with that arg automatically. Most agent images don't ship the CLI by default.
- The "Install Paddock MCP" toggle is intentionally **not implemented** — see docs/tabs/mcp.md / plans/06; the two were split by decision on 2026-08-04.

### 4. Network (dropdown)

Routes the agent's traffic through another running container by joining its network namespace (`network_mode: container:<name>`).

- Dropdown lists all containers visible to the webui (`docker ps -a`), with stopped ones badged `(stopped)`; the currently-set target stays in the list even if stopped so it can be cleared
- Choosing a container runs the same stop → regenerate compose → start flow with a confirm popup; the warning notes the agent loses its network if the target stops
- `Default (no override)` clears the override (`network: ""`)
- Validation at save time: target must exist, be running, and not be the agent itself
- State stored in `meta.env` `NETWORK=<container>` (empty = default)

### 5. Danger Zone — Delete Container

Wires the existing `POST /api/agents/:name/delete` (stop + remove container, delete instance dir, drop from metadata store). Danger-styled confirm: "Permanently delete <name>, its container, and all files. This cannot be undone." On success the SPA navigates back to the fleet list.

## API Endpoints (app.js)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/containers` | All containers as `{ name, image, state }` (for the network dropdown) |
| GET | `/api/agents/:name/settings` | `{ allowDocker, network, image }` from `meta.env` (`DOCKER`, `NETWORK`) + `getDriver(agent).buildImage` |
| POST | `/api/agents/:name/settings` | Apply `{ allowDocker?, network? }` — validates network target + docker-CLI guard, stop → regenerate compose → start, records `settings/update` activity |
| POST | `/api/agents/:name/update` | 202 + background job `update:<name>`: `build --pull` then `--force-recreate` |
| GET | `/api/agents/:name/update-log` | SSE stream of `step`/`line`/`done`/`error` events, replays after `since`/`Last-Event-ID` (same shape as `create-log`) |

## vm-manager.js helpers

- `generateInstanceCompose(name, agent, password, port, { allowDocker, network })` — adds the docker.sock volume and/or `network_mode: container:<name>`
- `writeInstanceCompose(...)` — passes the options through
- `applySettings(name, opts)` — regenerates compose + writes `DOCKER`/`NETWORK` to `meta.env`; returns `{ allowDocker, network, image, agent }`
- `updateAgent(name, { onLog, onStep })` — streams `build --pull` then `up -d --no-deps --force-recreate` (built on `runCmdStream()`)
- `setMetaFlag(name, key, value)` — writes/clears a `KEY=VALUE` line in `meta.env` preserving other lines
- Image/tag lookups live in `src/services/drivers/` (`getDriver(agent).buildImage` / `.buildRel`) — vm-manager no longer exports `AGENT_IMAGES` / `AGENT_BUILD_REL`

## Notes

- Empty `network: ""` means "clear the override" — target validation only runs for non-empty values (a cleared override must not be treated as a container lookup).
- Update/create jobs live in the in-memory `job-log.js`; a webui restart mid-run kills them ("Update job not found (server may have restarted)"). Long jobs can be interrupted by a restart.
