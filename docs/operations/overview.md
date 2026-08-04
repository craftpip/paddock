# Operations

## Agent Lifecycle

### Create

POST `/api/agents/create` is **async + streaming**. It returns `202 { ok: true, job: name, streaming: true }` immediately and runs the create in a background job (`setImmediate`). Live output streams to the frontend over SSE.

Job steps (streamed as `step` events; `line` events carry stdout/stderr/system text):
1. **build** — `docker compose -f <instance-compose> build` as its own step (900s timeout)
2. **up** — `docker compose -f <instance-compose> up -d` (300s timeout)
3. **setup** (fresh OpenClaw/PicoClaw only — `skipSetup` on clone path) — `docker exec <name> openclaw setup --baseline` with 15x wait+retry ("Container not ready yet (attempt N/15)…"), then `docker restart <name>`. Non-interactive; plain `openclaw setup` requires a TTY since v2026.7.x
4. **restore** (only when a backup file was selected) — `backup.restoreAgent()` streams `docker cp` + `tar -xzf` + `docker restart`
5. **done** / **error** — terminal events; job cleaned up 5 min after finishing

Event store is in-memory (`services/job-log.js`): `{ n, ts, type: 'step'|'line'|'done'|'error', step?, stream?, text?, ... }`. On completion the registry is re-discovered, owner assignment + activity are recorded.

Streaming routes:
- `GET /api/agents/:name/create-log` — SSE, replays events after `since` (from `?since=` or `Last-Event-ID`), keep-alive comment every 15s, `retry: 3000`. Sends a terminal `error` event if the job is gone (e.g. server restart).
- `GET /api/agents/:name/create-status` — polling fallback: `{ step, state, done, failed, error, lineCount }`.

Why SSE not WebSocket: `/ws/terminal/:name` rejects connections while the container isn't running — exactly the window creation needs to stream through (build runs before the container exists). SSE is one-way, auto-reconnects with `Last-Event-ID`, and needs no changes to the wss handler.

### Start / Stop / Restart

POST routes use docker compose lifecycle:
- Start: `docker compose -f <instance-compose> up -d`
- Stop: `docker compose -f <instance-compose> stop`
- Restart: stop + start

All return card partial for HTMX or redirect for full page.

### Update (image refresh)

POST `/api/agents/:name/update` is async + streaming like create: returns `202 { ok: true, job: "update:<name>", streaming: true }` and runs in a background job. Streams to `GET /api/agents/:name/update-log` (SSE, same event shape as `create-log`, replays after `since`).

Steps:
1. **build** — `docker compose -f <instance-compose> build --pull <name>` (900s timeout). `--pull` redownloads the base image first, so a `:latest` tag gets a fresh copy, then rebuilds.
2. **recreate** — `docker compose -f <instance-compose> up -d --no-deps --force-recreate <name>` (300s). This is the last step and restarts the container automatically; if it fails the old container is left running.
3. **done** — "Done — container recreated" `system` line, registry re-discovered, `lifecycle/update` activity recorded.

### Settings (docker access, network)

`POST /api/agents/:name/settings` `{ allowDocker?, network? }` applies either/both:
- `allowDocker: true` mounts `/var/run/docker.sock:/var/run/docker.sock`; enabling on a running agent errors first if the image has no docker CLI
- `network: "<container>"` sets `network_mode: container:<name>` (target must exist, be running, and not be the agent); `network: ""` clears the override

Both use the same stop → regenerate compose → start flow and write `DOCKER` / `NETWORK` to `meta.env`. See `docs/tabs/settings.md`.

### Delete

POST `/api/agents/:name/delete`:
1. Stop + remove container
2. Delete instance directory
3. Remove from metadata store

## Dev Workflow

### Live Editing

Source code at `src/` bind-mounted to `/app` in the webui container. Changes to JS/EJS/JSON are reflected instantly — no image rebuild needed.

### node_modules

Copied once from container to host:
```bash
docker cp paddock-webui:/app/node_modules src/node_modules
```
`.gitignore` has `**/node_modules/`.

### Restart (no rebuild)

```bash
docker compose up -d --no-deps --force-recreate paddock-webui
```

### Vite Dev Server (HMR)

```bash
docker exec -d paddock-webui sh -c 'cd /app/client && npm run dev'
```

- Vite on port 5173, proxies `/api` and `/ws` to Express on 5050
- Access at `http://10.69.1.164:5173` (host LAN IP, not localhost)
- Express backend changes still use bind mount (no rebuild)
- Stop: `docker exec paddock-webui sh -c "kill \$(lsof -ti:5173)"`

### Production Build

```bash
cd src/client && npm run build
```
Output to `src/public/`, served by Express. Access at port 5051.

### Testing

```bash
docker exec paddock-webui node --test test/
```

## Git Workflow

- Instance files owned by root (Docker creates them). Use `sudo` for git ops.
- `sudo git add -A && sudo git commit -m "msg" && sudo git push`
- Strip embedded git repos before add:
  ```bash
  sudo find instances/ -name '.git' -type d -exec rm -rf {} +
  ```
- Fix executable bit in git index:
  ```bash
  sudo git update-index --chmod=+x <file>
  ```
- Daily commit via crontab: `scripts/daily-commit.sh`
