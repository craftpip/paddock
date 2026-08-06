# Goal 4 — opencode Driver + Image

## Status: Done (2026-08-06)

## Goal

Add opencode as a first-class agent: one Dockerfile + one driver + a
CreateAgent option. The terminal tab is the interface — you run `opencode`
interactively, config and workspace persist in the mounted data dir.

## Details

### Dockerfile — `src/vm-builds/opencode/Dockerfile`

- Base: `node:20-slim`
- `npm install -g opencode-ai` (binary: `opencode`)
- `ARG INSTALL_DOCKER=0` + conditional `docker.io` install — same pattern as
  openclaw. Do NOT bake the CLI in; the settings flow auto-rebuilds with
  `INSTALL_DOCKER=1` when toggling on (app.js:861-890).
- No `mcporter` (OpenClaw's MCP runner — nothing to do here).
- sshd + `ROOT_PASSWORD` handling, TZ (`Asia/Kolkata`), `WORKDIR /root`,
  `EXPOSE 22`.
- `start.sh` = set password/TZ, `sshd &`, then keep-alive
  (`tail -f /dev/null`) — opencode has no gateway daemon.

### Driver — `src/services/drivers/opencode.js`

| Field | value |
|-------|-------|
| `type` / `label` | `opencode` / `Opencode` |
| `buildImage` | `paddock-vm-opencode:latest` |
| `buildRel` | `../../src/vm-builds/opencode` |
| `baseImage` | `node:20-slim` |
| `dataDir` | `/root/.opencode` |
| `workspaceDir` | `/root/.opencode/workspace` |
| `setupSteps` | `[]` |
| `backupSteps` | `[]` (no openclaw backup) |
| `installDockerBuildArg` | `INSTALL_DOCKER=1` |
| `currentVersion(name)` | `opencode --version` |
| `availableVersion()` | `''` (no base label → no update available) |
| `commands` | small bespoke set (login, serve/doctor, model list…) or `[]` for now |

### CreateAgent

- `<option value="opencode">opencode</option>` (or from the registry if Goal 1
  added that). No setup step — `setupSteps: []`.

## Files

- **New** `src/vm-builds/opencode/Dockerfile`
- **New** `src/services/drivers/opencode.js`
- **Modified** `src/client/src/pages/CreateAgent.jsx` — option
- **Modified** `src/services/vm-manager.js` only if AGENT maps still hold
  (Goal 1 removes them)

## Progress

- [x] Write `src/vm-builds/opencode/Dockerfile`
- [x] Build the image (`docker compose -f instances/... build`)
- [x] Write `src/services/drivers/opencode.js`
- [x] Add CreateAgent option — automatic: the select is fed from `/api/agent-types` (driver registry), no JSX change needed
- [x] Create a test opencode agent (`pad-opencode-pad-opencode-test`, deleted after testing)
- [x] Terminal drops into a shell; `opencode --version` works (1.18.14)
- [x] `opencode` interactive CLI runs; config writes to `/root/.opencode`
- [x] Data dir persists across container restart
- [x] Terminal `pwd` = `driver.workspaceDir` (`/root/.opencode/workspace`)
- [x] Files written in the workspace show up in the workspace tab
- [x] Settings page: version shows (1.18.14), docker toggle works (rebuild path: `INSTALL_DOCKER=1` + socket mount, docker CLI 20.10 + host daemon verified inside container)
- [ ] Update flow — not run end-to-end (no base image → `updateAvailable: false`; same code path as openclaw)

## Test log (2026-08-06)

- Image build: `node:20-slim` + `npm install -g opencode-ai` (binary `opencode` 1.18.14).
  **Heredoc `cat > start.sh <<'EOF'` inside a RUN produced a 0-byte file** — Docker's
  multi-line RUN parsing ate it. Fix: `start.sh` is now a real file in the build context,
  `COPY`'d in. Rebuilt clean.
- `opencode --version` → `1.18.14`; `pwd` → `/root/.opencode/workspace` (WORKDIR + driver
  `workspaceDir` agree); sshd up.
- XDG env vars work: first run wrote `/root/.opencode/config/opencode/opencode.jsonc`
  (config), plus `data/`, `cache/` — all inside the bind mount. Restart kept workspace
  files + config.
- Terminal (docked): shell works, `opencode --version` runs, interactive `opencode` TUI
  renders (OpenCode logo + "Run /connect to add an AI provider").
- "Run TUI" button hardcoded `openclaw` → `openclaw: command not found` on opencode
  agents. Fixed by adding `tuiCommand` to each driver (`openclaw`/`opencode`), served by
  `/api/agent-types/:type/commands`, consumed by CommandsPane. Button now says
  "Run opencode interactively in the terminal".
- Settings: version from `driver.currentVersion()`, no update available (no base image).
  Docker toggle → stop, rebuild with `INSTALL_DOCKER=1`, recreate with
  `/var/run/docker.sock` mount. Verified `docker version` client 20.10.24 / server 29.5.3
  from inside, workspace intact after recreate.
- Delete: container + instance dir + compose network all removed; DB row cleaned.
- API: `/api/agent-types` lists `opencode`; `/api/agent-types/opencode/commands` serves
  the Model/Other groups + `tuiCommand`.
- Cleanup: all test artifacts removed. The user created their own `pad-opencode-asda`
  during the session (untouched).

## Verification

```bash
docker exec <test-opencode> opencode --version
docker exec <test-opencode> pwd                     # /root/.opencode/workspace
# restart container → config + files still there
# toggle docker on → docker ps works from inside
```

## Open questions

- `commands` group content for opencode — fill from `opencode --help` during
  the goal, or leave empty until the commands work is a separate pass?
