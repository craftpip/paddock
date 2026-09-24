# Settings Tab

> Last updated: 2026-08-17

Container-level operations for an agent: recreate/update, health checkup, docker access, network routing, custom workspace + extra volumes, build & lifecycle commands, dev container sync, and delete. Lives at the end of the tab bar in the agent detail page.

File: `src/client/src/pages/agent/SettingsTab.jsx`. Wired into `AgentDetail.jsx` as `{ id: 'settings', label: 'Settings' }` in `MODES`.

The Settings **POST** and the MCP `recreate` tool share one consolidated change
flow, `vm.prepareAgentChanges(name, body)` → `vm.applyAgentChanges(name, body,
{ onLog, onStep })` — every option (allowDocker, network, workspace, volumes,
extra ports, web, ssh) is an optional arg and the compose is regenerated exactly
once per change set.

## Cards

### 0. Stale network peer warning (conditional)

Amber banner at the top when the compose routes through a `container:` peer
that was recreated (docker still points at the old deleted container) or is
stopped. Shows a **Recreate to fix** button (`POST /api/agents/:name/recreate`)
to rebind to the current peer. Only visible when network health is `stale` or
`peer-stopped`.

### 1. Container Info (read-only + popup)

Name, agent type, runtime, status, and image (per-instance tag
`paddock-vm-&lt;name&gt;:latest`). An **Inspect details** button opens the lazy-loaded
`ContainerInfoModal.jsx` — `GET /api/agents/:name/container-info` runs
`docker inspect` on demand and shows network mode + peer, mounts table, **published**
ports, env keys, and a collapsible raw inspect JSON with env secrets redacted.
Note: `EXPOSE`-declared ports are image metadata, NOT published — the popup
labels them "Not published"; peer-mode agents legitimately show no ports (the
host binding lives on their `&lt;name&gt;-door`).

### 2. Recreate Container (update / recreate / full reset)

General-purpose dialog replacing the old dedicated Update card. The **Recreate
Container** button opens a confirm with checkboxes:

- **Pull latest image update** — pulls the base image, rebuilds the per-instance
  image, then force-recreates (the old update flow)
- **Reset the whole user folder** — wipes the data dir (config, sessions, data)
  so the agent starts completely fresh; the bind-mounted workspace folder is
  preserved

On confirm: 202 + background job (`recreate:&lt;name&gt;` or `update:&lt;name&gt;`) streamed
into a Console popup. Steps vary by checkbox: pull → build → recreate for
update; just recreate for a plain recreate; wipe + recreate for reset.

### 3. Container Health Checkup

Runs a generic, driver-agnostic Docker-level checkup: diffs the **declared** compose settings (`docker compose config --format json`) against the **actual** container (`docker inspect`). Works on stopped containers too — while down it reports *why* (exit code, OOM-kill, stale network peer, etc.).

- **Run Health Check** button starts an SSE job (`health:&lt;name&gt;`) — each check streams into a live popup (`HealthCheckModal.jsx`) as a checklist row: ✓ pass / ✗ fail / ~ warn, with `expected`/`found` detail and a fix hint on failures. No auto-fix — each failing row tells you what to do (usually **Recreate**).
- **Status pill** (next to the button) shows the last passive report: `✓ Healthy` / `~ N issues` / `✗ N problems`; click it to reopen the full report. Fetched on mount from `GET /api/agents/:name/health`.

Checks (11): compose file · container exists + status (with OOM/exit-code reason) · Docker healthcheck probe · restart policy · image · network mode + peer · volumes/bind mounts (incl. `/workspace` host-path split-brain detection) · docker socket mount · published ports · env keys (secrets excluded).

Driver-aware app-level checks are planned but not yet implemented — see `plans/20-health-check-driver-aware.md`.

### 4. Allow docker in the container (toggle)

Raw docker (docker CLI + host socket). Toggling mounts `/var/run/docker.sock:/var/run/docker.sock` in the agent's compose file and sets `DOCKER=1|0` in `meta.env`.

- Applies through the shared settings flow (stop → regenerate compose → start)
- Confirm popup warns the docker socket is **host-root equivalent** (the agent could control the entire host)
- Guard rail: if the image has no docker CLI (`docker exec &lt;name&gt; sh -lc 'command -v docker'` fails while the container runs), the toggle errors with "The image has no docker CLI — rebuild the image to enable docker access". The toggle writes `INSTALL_DOCKER=1` to the instance `build.env` and rebuilds the per-instance image with that arg automatically. Most agent images don't ship the CLI by default (hermes ships it — the rebuild is a verified no-op there).

### 4b. Container user (Root / Local user) (plan 43 Phase 7)

Per-PAD choice of which user the agent **daemon and terminal** run as. Root (the
default) is the legacy behavior; Local user drops them to the `pad` user
(`PUID:PGID`, 1000:1000) so every file the agent writes — in the data dir, the
workspace, anywhere — is user-owned on the host by construction.

- Persisted as `USER_MODE=user|(absent)` in `meta.env`; the generated compose
  emits `USER_MODE: 'user'` into the service environment (not `user:` — the
  container keeps its root boot, see below)
- **How it works (drop-privilege entrypoint):** the container still boots as
  root (chpasswd, sshd config, sshd, `start-web.sh` hooks all unchanged), then
  the user-mode branch of `start.sh` re-`chown -R 1000:1000` the data dir (so
  workspace dirs the root boot recreated stay writable) and `exec setpriv
  --reuid 1000 --regid 1000 --clear-groups` (fallback `su -s /bin/bash pad`)
  the keeper. SSH stays the root admin door.
- **Terminal/exec runs as the pad user too:** the terminal's tmux setup,
  attach, and exec (`termUserArgs` in app.js) add `-u 1000:1000 -e HOME=/root`
  for user-mode pads, so the tmux socket (`/tmp/tmux-1000`), the shell, and
  every file typed in the terminal all belong to the pad user. The Engine-API
  attach exec sets the same `User` + `HOME=/root`.
- **`HOME=/root` is kept on purpose** — the agent CLIs (openclaw, opencode, …)
  resolve their config/workspace via `$HOME`, and `/root/.&lt;agent&gt;` is the
  bind-mounted data dir. The images `chmod 755 /root` so the pad user can
  traverse it; the PS1 hook adds a HISTFILE guard for the unwritable
  `/root/.bash_history`.
- **Switching mode on an existing pad** runs the shared settings flow (confirm
  → rebuild if needed → recreate → restore prior stopped state). If the image
  lacks the pad user (`imageHasPadUser` runs `id pad`), the toggle rebuilds it
  first via `ensureUserModeBuildFiles` — regenerates `start.sh` from the shared
  template when the `__PAD_USER_MODE__` marker is missing, and surgically
  injects the pad-user block into the (user-editable) Dockerfile.
- **hermes is excluded** — it already runs its daemon as its own user
  (`/opt/data`, uid 10000); the control is hidden in Settings and disabled
  with an explanation in the create form.
- New pads in user mode run their setup steps as `-u 1000:1000`, so config
  files are born user-owned.

### 5. Network (dropdown)

Routes the agent's traffic through another running container by joining its network namespace (`network_mode: container:&lt;name&gt;`).

- Dropdown lists all containers visible to the webui (`docker ps -a`), with stopped ones badged `(stopped)`; the currently-set target stays in the list even if stopped so it can be cleared
- Choosing a container runs the shared settings flow with a confirm popup; the warning notes the agent loses its network if the target stops
- `Default (no override)` clears the override (`network: ""`)
- Validation at save time: target must exist, be running, and not be the agent itself
- State stored in `meta.env` `NETWORK=&lt;container&gt;` (empty = default)
- A published web app / ssh / extra ports are **carried over** on a network switch (door re-created on peer changes) — see web.md

### 5b. Additional volumes (card)

Additional mounts — **bind** rows `hostPath:containerPath` or **named-volume**
rows. Persisted in `EXTRA_VOLUMES` in meta.env as a JSON array, `[]` when
empty: binds are `{ "host": "/mnt/data", "container": "/data", "readonly":
false }`, named volumes `{ "type": "volume", "name": "mempalace-data",
"container": "/data", "readonly": false, "external": "mempalace_mempalace-data"
}`. Validated by `vm.validateExtraVolumes` (same guard family as the workspace
mount: no system dirs, no project root / `src` / `instances`, no other agent's
folder, no swallowing the data mount; container path must not be a protected
system path or a parent-or-self of the data dir, though descendant subfolders
ARE allowed). Named volumes use the same type select as Create Agent; a
discovered volume shows "Attaches the existing volume &lt;external&gt;" / "Creates a
fresh volume", and the generator emits the top-level `volumes:` section with
`external: true` only when the volume exists. Removing a volume row removes
only the mount from meta + compose (agent recreates); the host source directory
is **never deleted** — extra-volume sources are arbitrary user dirs, so
`removeVm()` does not clean them up.

### 5d. Custom workspace folder (toggle)

Custom workspace bind: host source (`WORKSPACE_HOST`) + container path
(`WORKSPACE_DIR`), persisted in `meta.env`. Default (off) keeps the workspace as
the `workspace/` subfolder of the data mount. Validated by
`vm.validateWorkspaceMount` (both-or-neither, no protected/system dirs, no
swallowing the data mount or another agent's dir); hermes is excluded (its data
dir IS the workspace). Changing/clearing a mount never moves or deletes files.
A new folder starts empty; the old folder stays on disk.

### 5e. Build & lifecycle commands (plan 41)

Four textareas for the per-PAD Dockerfile and lifecycle hooks:

- **Build commands (Dockerfile)** — lines in `instances/&lt;name&gt;/build/Dockerfile`.
  A change rebuilds the image. A `FROM` line here fails the build (the current
  container stays up).
- **Post-create commands (bash)** — runs once in the running container after a
  recreate (project mounted, services up).
- **Post-start commands (bash)** — runs on every container start (baked into
  `start.sh`). Enabling on an older image rebuilds it once.
- **Post-attach commands (bash)** — runs on every terminal attach inside the
  PAD. No image change needed.

### 5f. Dev Container (plan 41 item 20)

The workspace's `devcontainer.json` is the portable mirror of this pad. The card
shows the file path, a state badge (generated / project-authored / not found),
and both sides of the diff preview (current file vs what Paddock would write
now from the pad's effective config).

- **Sync** — writes the mapped fields (workspace folder, lifecycle commands,
  env, volumes, ports) from the pad's settings into the workspace
  `devcontainer.json` in place (project-authored fields survive). No container
  recreate.
- **Regenerate** — rewrites (or creates) the `devcontainer.json` as the pad's
  full generated mirror (marked `x-paddock.generated`). No container recreate.

### 6. Danger Zone — Delete Container

Wires the existing `POST /api/agents/:name/delete` (stop + remove container + door + network, delete instance dir, drop from metadata store). Danger-styled confirm: "Permanently delete &lt;name&gt;, its container, and all files. This cannot be undone." On success the SPA navigates back to the fleet list.

## API Endpoints (app.js)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/containers` | All containers as `{ name, image, state }` (for the network dropdown) |
| GET | `/api/agents/:name/settings` | `vm.readSettings(name)` → `{ allowDocker, network, networkHealth, image, version, sshPort, sshContainerPort, workspaceMount, extraVolumes, extraPorts, web }` |
| POST | `/api/agents/:name/settings` | Apply `{ allowDocker?, network?, workspaceHost?, workspaceDir?, extraVolumes?, sshEnabled?, port?, sshContainerPort?, password? }` — through `prepareAgentChanges`/`applyAgentChanges` (SSE job `update:&lt;name&gt;`), records `settings/update` activity |
| GET | `/api/agents/:name/container-info` | Lazy `docker inspect` summary + redacted raw JSON (shared with MCP `settings_get`) |
| GET | `/api/agents/:name/update-info` | `{ currentVersion, availableVersion, updateAvailable }` for the update confirm |
| POST | `/api/agents/:name/update` | 202 + background job `update:&lt;name&gt;`: `build --pull` then `--force-recreate` |
| GET | `/api/agents/:name/update-log` | SSE stream of `step`/`line`/`done`/`error` events, replays after `since`/`Last-Event-ID` (same shape as `create-log`) |
| POST | `/api/agents/:name/ports` | Replace extra TCP ports `{ extraPorts: [{host, container}] }` — SSE job; peer-mode ports ride the door |
| GET | `/api/agents/:name/health` | Passive (no job) full health report `{ name, status, checks, counts }` — powers the settings health pill |
| POST | `/api/agents/:name/health-check` | 202 + background job `health:&lt;name&gt;`: streams each check live via `jobLog.check()` then finishes with `{ status, counts }` |
| GET | `/api/agents/:name/health-log` | SSE stream of `check`/`done`/`error` events for the health job, replays after `since`/`Last-Event-ID` |
| POST | `/api/agents/:name/recreate` | 202 + background job `recreate:&lt;name&gt;`: `up -d --no-deps --force-recreate` — fixes stale network peer / container-vs-compose drift |

## vm-manager.js helpers

- `prepareAgentChanges(name, body)` — builds a consolidated change set from
  `{ allowDocker, network, workspaceHost, workspaceDir, extraVolumes, extraPorts, web, sshEnabled, sshPort, sshContainerPort, password, ... }`; returns `{ ctx, changed, ... }` (no-op bodies short-circuit with `changed: false`, no compose regen)
- `applyAgentChanges(name, body, { onLog, onStep })` — validate → regenerate compose → stop → recreate (+ door handling) → exec the web boot hook → verify; used by settings/web/ports POST and MCP `recreate`
- `readSettings(name)` / `containerInfo(name)` — the two GET shapes above (also MCP `settings_get`)
- `updateAgent(name, { onLog, onStep })` — streams `build --pull` then `up -d --no-deps --force-recreate`
- `setMetaFlag(name, key, value)` — writes/clears a `KEY=VALUE` line in `meta.env` preserving other lines (empty value REMOVES the line)
- `getNetworkHealth(name)` — resolves the compose `network_mode: container:&lt;peer&gt;` against the live docker state: `none` (no override) / `ok` (peer running + bound) / `stale` (peer container was recreated — recorded ID dead, start fails with "No such container") / `peer-stopped` (peer exists but not running)
- `validateWorkspaceMount(name, agent, host, dir)` — single authority for workspace bind validation
- `ensureSshStartBlock(name)` / `imageHasSshPortSupport(name, image, wasRunning)` — backfill the `Port $SSH_PORT` sed block into old instances' `build/start.sh` / detect it in the image; a non-22 ssh container port on an image without support sets `sshRebuild` into the update flow
- Per-instance image tags come from `instance-image.js` (`imageFor(name)` → `paddock-vm-&lt;name&gt;:latest`); the shared template the instance build dir is copied from lives in `src/vm-builds/&lt;type&gt;/` (driver `templateDir`). vm-manager no longer exports `AGENT_IMAGES` / `AGENT_BASE_IMAGES`.

## Notes

- Empty `network: ""` means "clear the override" — target validation only runs for non-empty values (a cleared override must not be treated as a container lookup).
- The container health checkup works on stopped/exited containers — it inspects from the host side (`docker inspect` + compose file), so it reports *why* the container is down rather than failing to run. No auto-fix: failing rows give a hint (usually Recreate).
- Update/create/health/recreate jobs live in the in-memory `job-log.js`; a webui restart mid-run kills them ("Update job not found (server may have restarted)"). Long jobs can be interrupted by a restart.
- SSH + web host ports are allocated 43817+; see web.md for peer-namespace port-collision rules.
