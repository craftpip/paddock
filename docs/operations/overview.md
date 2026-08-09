# Operations

> Last updated: 2026-08-09

## Agent Lifecycle

### Create

POST `/api/agents/create` is **async + streaming**. It returns `202 { ok: true, job: name, streaming: true }` immediately and runs the create in a background job (`setImmediate`). Live output streams to the frontend over SSE.

Job steps (streamed as `step` events; `line` events carry stdout/stderr/system text):
1. **build** — `docker compose -f <instance-compose> build` as its own step (900s timeout)
2. **up** — `docker compose -f <instance-compose> up -d` (300s timeout)
3. **setup** (fresh OpenClaw/PicoClaw only) — `docker exec <name> openclaw setup --baseline` with 15x wait+retry ("Container not ready yet (attempt N/15)…"), then `docker restart <name>`. Non-interactive; plain `openclaw setup` requires a TTY since v2026.7.x
4. **done** / **error** — terminal events; job cleaned up 5 min after finishing

Event store is in-memory (`services/job-log.js`): `{ n, ts, type: 'step'|'line'|'done'|'error', step?, stream?, text?, ... }`. On completion the registry is re-discovered, owner assignment + activity are recorded.

Streaming routes:
- `GET /api/agents/:name/create-log` — SSE, replays events after `since` (from `?since=` or `Last-Event-ID`), keep-alive comment every 15s, `retry: 3000`. Sends a terminal `error` event if the job is gone (e.g. server restart).
- `GET /api/agents/:name/create-status` — polling fallback: `{ step, state, done, failed, error, lineCount }`.

Why SSE not WebSocket: `/ws/terminal/:name` rejects connections while the container isn't running — exactly the window creation needs to stream through (build runs before the container exists). SSE is one-way, auto-reconnects with `Last-Event-ID`, and needs no changes to the wss handler.

### Troubleshooting: "all predefined address pools have been fully subnetted"

A create that dies at the **up** step with this error means the host daemon's
`default-address-pools` are exhausted — the pad's compose left its `default`
network subnet unspecified, so the daemon tried to allocate one from its finite
pools (`192.168.0.0/16` at `/20`). New pads no longer hit this: the compose
generator carves a fixed `/24` out of `10.200.0.0/16` (persisted as `SUBNET` in
`meta.env`) and declares it explicitly. See `docs/backend/services.md` (pad
subnet pool). Delete the leftover instance dir + its image (`docker rmi
paddock-vm-<name>:latest`) if the failed create left state behind, then retry
from the form.

### Start / Stop / Restart

POST routes use docker compose lifecycle:
- Start: `docker compose -f <instance-compose> up -d`
- Stop: `docker compose -f <instance-compose> stop`
- Restart: stop + start

Start/Stop/Restart also start/stop the agent's socat **door** (`<name>-door`)
together with it — CLI `docker stop <name>` alone does NOT touch the door.
Responses are JSON for the React SPA (the old HTMX card-partial behaviour is
gone).

### Update (image refresh)

POST `/api/agents/:name/update` is async + streaming like create: returns `202 { ok: true, job: "update:<name>", streaming: true }` and runs in a background job. Streams to `GET /api/agents/:name/update-log` (SSE, same event shape as `create-log`, replays after `since`).

Steps:
1. **build** — `docker compose -f <instance-compose> build --pull <name>` (900s timeout). `--pull` redownloads the base image first, so a `:latest` tag gets a fresh copy, then rebuilds.
2. **recreate** — `docker compose -f <instance-compose> up -d --no-deps --force-recreate <name>` (300s). This is the last step and restarts the container automatically; if it fails the old container is left running.
3. **done** — "Done — container recreated" `system` line, registry re-discovered, `lifecycle/update` activity recorded.

### Settings (docker access, network, workspace, volumes, ssh, ports)

`POST /api/agents/:name/settings` accepts an optional field for every Settings
option (`allowDocker`, `network`, `workspaceHost`/`workspaceDir`, `extraVolumes`,
`sshEnabled`/`port`/`sshContainerPort`/`password`). The change set is validated +
consolidated by `vm.prepareAgentChanges(name, body)`; if nothing changed the
route short-circuits (`{ changed: false }`). Otherwise it runs the SSE job
`update:<name>` through `vm.applyAgentChanges` (validate → regenerate compose →
stop → recreate → door handling → exec web boot hook → verify).

`POST /api/agents/:name/ports` replaces the extra TCP ports
(`{ extraPorts: [{ host, container }] }`) through the same consolidated flow —
peer-mode ports ride the agent's socat door.

Both write their state to `meta.env` (`DOCKER`, `NETWORK`, `WORKSPACE_HOST`,
`WORKSPACE_DIR`, `EXTRA_VOLUMES`, `EXTRA_PORTS`, `PORT`, `SSH_CPORT`,
`ROOT_PASSWORD`, `WEB_*`). See `docs/tabs/settings.md` and `docs/tabs/web.md`.

### Delete

POST `/api/agents/:name/delete`:
1. Stop + remove container, the `<name>-door` (both `-door`/`-web` suffixes), and the compose bridge network `<name>_default`
2. Delete instance directory
3. Remove from metadata store (`registry.removeAgentFromDb`)

## Dev Workflow

### Live Editing

Source code at `src/` bind-mounted to `/app` in the webui container. JS/JSON
backend changes are reflected instantly — no image rebuild. **React JSX/CSS
edits need a rebuild**: the SPA serves the built bundle from `src/public/`, so
run `cd src/client && npm run build && docker restart paddock` (see below).

### Restart (no rebuild)

```bash
docker restart paddock
```

The compose service is `webui`, container name `paddock`.

### Runtime File Ownership

The webui runs as numeric UID/GID `1000:1000`, configured by `PUID` and
`PGID` in `.env`. Docker stores these numeric IDs on bind-mounted files; the
host and container each resolve them to their own local account names. No host
account name is added to or exposed inside the container.

`docker-compose.yml` includes `1000:1000` fallbacks if `PUID` or `PGID` are
not supplied. The container image makes `/home` writable by UID `1000` and
sets `HOME=/home`, giving tools such as Docker CLI a container-local user
directory.

The webui also has supplementary group `DOCKER_GID` (currently `988`) so it
can access the mounted `/var/run/docker.sock`. Socket access is equivalent to
host-root-level Docker control and is required for the webui to manage PADs.

Files created by the webui in project bind mounts use UID/GID `1000:1000`.
Files created by the Docker daemon, Docker-managed volumes, or individual PAD
agent containers can use different ownership because they are created by
different processes.

### Vite Dev Server (HMR)

```bash
docker exec -d paddock sh -c 'cd /app/client && npm run dev'
```

- Vite on port 5173, proxies `/api` and `/ws` to Express on 6789
- Access at `http://10.69.1.164:5173` (host LAN IP, not localhost); 6789 serves
  the built SPA
- Express backend changes still use bind mount (no rebuild)
- Stop: `docker exec paddock sh -c "kill \$(lsof -ti:5173)"`

### Production Build

```bash
cd src/client && npm run build
```

Output to `src/public/`, served by Express on port 6789.

### Testing

Run each suite individually — the combined `node --test test/` run hangs:

```bash
timeout 60 docker exec paddock node --test test/vm-manager.test.js
timeout 60 docker exec paddock node --test test/mcp.test.js
```

`vm-manager.test.js` asserts the `GUARD_*` defaults, which `.env` disables —
run it with the guard envs cleared:
`docker exec -e GUARD_PROJECT_ROOT= -e GUARD_INSTANCES_PARENT= -e GUARD_AGENT_DATA= paddock node --test test/vm-manager.test.js`

## Git Workflow

- Instance files owned by root (Docker creates them). Use `sudo` for git ops.
- `sudo git add -A && sudo git commit -m "msg" && sudo git push`
- Strip embedded git repos before add (OpenClaw nests repos in
  `.tmp/plugins*/` and `workspace/`):
  ```bash
  sudo find instances/ -name '.git' -type d -exec rm -rf {} +
  ```
- Fix executable bit in git index:
  ```bash
  sudo git update-index --chmod=+x <file>
  ```
- **No daily-commit script exists anymore** (no `scripts/`, no crontab) — a
  daily `sudo git add -A && sudo git commit -m "auto: daily commit"` is not
  running. Re-create it if wanted.

## Container Process and Signals (PID 1)

**Problem:** a bare `bash start.sh` as PID 1 silently drops SIGTERM (the kernel
does not deliver default-action signals to PID 1 without a handler), so
`docker stop <pad>` hangs the full `-t 30` grace then SIGKILLs (exit 137).

**Fix (2026-08-07):** every `vm-builds/*/Dockerfile` entrypoint is wrapped in
tini (mirrors the openclaw image, which used `tini -s --` already):

- picoclaw (Alpine): `apk add tini` →
  `ENTRYPOINT ["/sbin/tini", "-s", "--", "/usr/local/bin/start.sh"]`
- codex / opencode / hermes (Debian): `apt-get install -y tini` →
  `ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/start.sh"]`

tini forwards SIGTERM to its bash child; bash dies, tini exits → clean stop in
~0.1–0.3s with exit 143.

**Rebuild notes:** rebuilding tags the per-instance `paddock-vm-<name>:latest`
(from `instances/<pad>/build/`), so **recreate** the container
(`docker compose -f instances/<pad>/docker-compose.yml up -d --force-recreate`)
to pick up a new entrypoint — `docker start` keeps the old image ID. Rebuilds
go through Settings → Update; the docker toggle writes `INSTALL_DOCKER=1` into
the instance `build.env` and rebuilds only that PAD's image. Verify PID 1 is
`tini` via `docker exec <pad> ps -o pid,ppid,comm`, then `time docker stop
<pad>` should be well under a second.
