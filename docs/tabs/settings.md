# Settings Tab

> Last updated: 2026-08-09

Container-level operations for an agent: update, health checkup, docker access, network routing, custom workspace + extra volumes, ssh/extra-port exposure, and delete. Lives at the end of the tab bar in the agent detail page.

File: `src/client/src/pages/agent/SettingsTab.jsx`. Wired into `AgentDetail.jsx` as `{ id: 'settings', label: 'Settings' }` in `MODES`.

The Settings **POST** and the MCP `recreate` tool share one consolidated change
flow, `vm.prepareAgentChanges(name, body)` → `vm.applyAgentChanges(name, body,
{ onLog, onStep })` — every option (allowDocker, network, workspace, volumes,
extra ports, web, ssh) is an optional arg and the compose is regenerated exactly
once per change set.

## Cards

### 1. Container Info (read-only + popup)

Name, agent type, runtime, status, and image (per-instance tag
`paddock-vm-<name>:latest`). A **View full info** button opens the lazy-loaded
`ContainerInfoModal.jsx` — `GET /api/agents/:name/container-info` runs
`docker inspect` on demand and shows network mode + peer, mounts table, **published**
ports, env keys, and a collapsible raw inspect JSON with env secrets redacted.
Note: `EXPOSE`-declared ports are image metadata, NOT published — the popup
labels them "Not published"; peer-mode agents legitimately show no ports (the
host binding lives on their `<name>-door`).

### 2. Update (image refresh)

Redownloads the base image (`--pull`), rebuilds the **per-instance image** from `instances/<name>/build/`, and recreates the container — the recreate restarts it automatically. Runs as a background job; output streams into a console pane (the same `Console` component used by Create Agent).

- `GET /api/agents/:name/update-info` returns `{ currentVersion, availableVersion, updateAvailable }` for the confirm dialog
- POST returns `202 { ok: true, job: "update:<name>", streaming: true }`, the job runs in `setImmediate`
- Two steps, streamed as `step` events: **build** (`docker compose --env-file <build-dir>/build.env -f <instance-compose> build --pull <name>`, 900s timeout), then **recreate** (`docker compose ... up -d --no-deps --force-recreate <name>`, 300s timeout)
- A `system` line "Done — container recreated" ends the run, then the tab refetches agent state
- On failure the console keeps the error tail, the old container is left running (recreate is the last step), and a **Retry** button shows. The tab never navigates away.

### 3. Allow docker in the container (toggle)

Raw docker (docker CLI + host socket). Toggling mounts `/var/run/docker.sock:/var/run/docker.sock` in the agent's compose file and sets `DOCKER=1|0` in `meta.env`.

- Applies through the shared settings flow (stop → regenerate compose → start)
- Confirm popup warns the docker socket is **host-root equivalent** (the agent could control the entire host)
- Guard rail: if the image has no docker CLI (`docker exec <name> sh -lc 'command -v docker'` fails while the container runs), the toggle errors with "The image has no docker CLI — rebuild the image to enable docker access". The toggle writes `INSTALL_DOCKER=1` to the instance `build.env` and rebuilds the per-instance image with that arg automatically. Most agent images don't ship the CLI by default (hermes ships it — the rebuild is a verified no-op there).
- The "Install Paddock MCP" toggle is intentionally **not implemented** — see docs/tabs/mcp.md; the two were split by decision on 2026-08-04.

### 4. Container Health Checkup

Runs a generic, driver-agnostic Docker-level checkup: diffs the **declared** compose settings (`docker compose config --format json`) against the **actual** container (`docker inspect`). Works on stopped containers too — while down it reports *why* (exit code, OOM-kill, stale network peer, etc.).

- **Run Health Check** button starts an SSE job (`health:<name>`) — each check streams into a live popup (`HealthCheckModal.jsx`) as a checklist row: ✓ pass / ✗ fail / ~ warn, with `expected`/`found` detail and a fix hint on failures. No auto-fix — each failing row tells you what to do (usually **Recreate**).
- **Status pill** (next to the button) shows the last passive report: `✓ Healthy` / `~ N issues` / `✗ N problems`; click it to reopen the full report. Fetched on mount from `GET /api/agents/:name/health`.
- **Stale network peer banner** (top of the tab): if the compose file routes through a `container:` peer that was recreated (docker still points at the old deleted container) or is stopped, an amber banner explains it and shows a **Recreate to fix** button (runs `POST /api/agents/:name/recreate`). This is the fix for the "exited container won't start" case.

Checks (11): container exists + status (with OOM/exit-code reason), Docker healthcheck probe, restart policy, image, network mode + peer, volumes/bind mounts (incl. `/workspace` host-path split-brain detection), docker socket mount, published ports, environment keys (secrets excluded).

Driver-aware app-level checks are planned but not yet implemented — see `plans/20-health-check-driver-aware.md`.

### 5. Network (dropdown)

Routes the agent's traffic through another running container by joining its network namespace (`network_mode: container:<name>`).

- Dropdown lists all containers visible to the webui (`docker ps -a`), with stopped ones badged `(stopped)`; the currently-set target stays in the list even if stopped so it can be cleared
- Choosing a container runs the shared settings flow with a confirm popup; the warning notes the agent loses its network if the target stops
- `Default (no override)` clears the override (`network: ""`)
- Validation at save time: target must exist, be running, and not be the agent itself
- State stored in `meta.env` `NETWORK=<container>` (empty = default)
- A published web app / ssh / extra ports are **carried over** on a network switch (door re-created on peer changes) — see web.md

### 6. Workspace mount (toggle)

Custom workspace bind: host source (`WORKSPACE_HOST`) + container path
(`WORKSPACE_DIR`), persisted in `meta.env`. Default (off) keeps the workspace as
the `workspace/` subfolder of the data mount. Validated by
`vm.validateWorkspaceMount` (both-or-neither, no protected/system dirs, no
swallowing the data mount or another agent's dir); hermes is excluded (its data
dir IS the workspace). Changing/clearing a mount never moves or deletes files.
A new folder starts empty; the old folder stays on disk.

### 7. Extra volumes (card)

Additional bind mounts `hostPath:containerPath` (`EXTRA_VOLUMES` in meta.env,
`[{"host":"/mnt/data","container":"/data","readonly":false}]` — a JSON array of
`{ host, container, readonly }`, `[]` when empty). Validated by
`vm.validateExtraVolumes` (same guard family as the workspace mount: no system
dirs, no project root / `src` / `instances`, no other agent's folder, no
swallowing the data mount; container path must not be a protected system path
or a parent-or-self of the data dir, though descendant subfolders ARE allowed).
Removing a volume row removes only the bind from meta + compose (agent
recreates); the host source directory is **never deleted** — extra-volume
sources are arbitrary user dirs, so `removeVm()` does not clean them up.

### 8. Danger Zone — Delete Container

Wires the existing `POST /api/agents/:name/delete` (stop + remove container + door + network, delete instance dir, drop from metadata store). Danger-styled confirm: "Permanently delete <name>, its container, and all files. This cannot be undone." On success the SPA navigates back to the fleet list.

## API Endpoints (app.js)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/containers` | All containers as `{ name, image, state }` (for the network dropdown) |
| GET | `/api/agents/:name/settings` | `vm.readSettings(name)` → `{ allowDocker, network, networkHealth, image, version, sshPort, sshContainerPort, workspaceMount, extraVolumes, extraPorts, web }` |
| POST | `/api/agents/:name/settings` | Apply `{ allowDocker?, network?, workspaceHost?, workspaceDir?, extraVolumes?, sshEnabled?, port?, sshContainerPort?, password? }` — through `prepareAgentChanges`/`applyAgentChanges` (SSE job `update:<name>`), records `settings/update` activity |
| GET | `/api/agents/:name/container-info` | Lazy `docker inspect` summary + redacted raw JSON (shared with MCP `settings_get`) |
| GET | `/api/agents/:name/update-info` | `{ currentVersion, availableVersion, updateAvailable }` for the update confirm |
| POST | `/api/agents/:name/update` | 202 + background job `update:<name>`: `build --pull` then `--force-recreate` |
| GET | `/api/agents/:name/update-log` | SSE stream of `step`/`line`/`done`/`error` events, replays after `since`/`Last-Event-ID` (same shape as `create-log`) |
| POST | `/api/agents/:name/ports` | Replace extra TCP ports `{ extraPorts: [{host, container}] }` — SSE job; peer-mode ports ride the door |
| GET | `/api/agents/:name/health` | Passive (no job) full health report `{ name, status, checks, counts }` — powers the settings health pill |
| POST | `/api/agents/:name/health-check` | 202 + background job `health:<name>`: streams each check live via `jobLog.check()` then finishes with `{ status, counts }` |
| GET | `/api/agents/:name/health-log` | SSE stream of `check`/`done`/`error` events for the health job, replays after `since`/`Last-Event-ID` |
| POST | `/api/agents/:name/recreate` | 202 + background job `recreate:<name>`: `up -d --no-deps --force-recreate` — fixes stale network peer / container-vs-compose drift |

## vm-manager.js helpers

- `prepareAgentChanges(name, body)` — builds a consolidated change set from
  `{ allowDocker, network, workspaceHost, workspaceDir, extraVolumes, extraPorts, web, sshEnabled, sshPort, sshContainerPort, password, ... }`; returns `{ ctx, changed, ... }` (no-op bodies short-circuit with `changed: false`, no compose regen)
- `applyAgentChanges(name, body, { onLog, onStep })` — validate → regenerate compose → stop → recreate (+ door handling) → exec the web boot hook → verify; used by settings/web/ports POST and MCP `recreate`
- `readSettings(name)` / `containerInfo(name)` — the two GET shapes above (also MCP `settings_get`)
- `updateAgent(name, { onLog, onStep })` — streams `build --pull` then `up -d --no-deps --force-recreate`
- `setMetaFlag(name, key, value)` — writes/clears a `KEY=VALUE` line in `meta.env` preserving other lines (empty value REMOVES the line)
- `getNetworkHealth(name)` — resolves the compose `network_mode: container:<peer>` against the live docker state: `none` (no override) / `ok` (peer running + bound) / `stale` (peer container was recreated — recorded ID dead, start fails with "No such container") / `peer-stopped` (peer exists but not running)
- `validateWorkspaceMount(name, agent, host, dir)` — single authority for workspace bind validation
- `ensureSshStartBlock(name)` / `imageHasSshPortSupport(name, image, wasRunning)` — backfill the `Port $SSH_PORT` sed block into old instances' `build/start.sh` / detect it in the image; a non-22 ssh container port on an image without support sets `sshRebuild` into the update flow
- Per-instance image tags come from `instance-image.js` (`imageFor(name)` → `paddock-vm-<name>:latest`); the shared template the instance build dir is copied from lives in `src/vm-builds/<type>/` (driver `templateDir`). vm-manager no longer exports `AGENT_IMAGES` / `AGENT_BASE_IMAGES`.

## Notes

- Empty `network: ""` means "clear the override" — target validation only runs for non-empty values (a cleared override must not be treated as a container lookup).
- The container health checkup works on stopped/exited containers — it inspects from the host side (`docker inspect` + compose file), so it reports *why* the container is down rather than failing to run. No auto-fix: failing rows give a hint (usually Recreate).
- Update/create/health/recreate jobs live in the in-memory `job-log.js`; a webui restart mid-run kills them ("Update job not found (server may have restarted)"). Long jobs can be interrupted by a restart.
- SSH + web host ports are allocated 43817+; see web.md for peer-namespace port-collision rules.
