# Operations

## Agent Lifecycle

### Create

POST `/api/agents/create` triggers async creation:
1. Create instance directory (`instances/<name>/`)
2. Save `meta.env` with agent metadata
3. Generate `docker-compose.yml` with absolute host paths
4. If clone source: backup source, restore into target
5. Run `openclaw setup --baseline` inside container (non-interactive; plain `openclaw setup` requires a TTY since v2026.7.x)
6. `docker compose up -d` for the instance

Progress tracked in-memory, polled via `/api/agents/create-status/:name`.

### Start / Stop / Restart

POST routes use docker compose lifecycle:
- Start: `docker compose -f <instance-compose> up -d`
- Stop: `docker compose -f <instance-compose> stop`
- Restart: stop + start

All return card partial for HTMX or redirect for full page.

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
