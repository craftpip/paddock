# Goal 4 — opencode Driver + Image

## Status: Planned (2026-08-06)

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

- [ ] Write `src/vm-builds/opencode/Dockerfile`
- [ ] Build the image (`docker compose -f instances/... build`)
- [ ] Write `src/services/drivers/opencode.js`
- [ ] Add CreateAgent option
- [ ] Create a test opencode agent
- [ ] Terminal drops into a shell; `opencode --version` works
- [ ] `opencode` interactive CLI runs; config writes to `/root/.opencode`
- [ ] Data dir persists across container restart
- [ ] Terminal `pwd` = `driver.workspaceDir`
- [ ] Files written in the workspace show up in the workspace tab
- [ ] Settings page: version shows, docker toggle works (rebuild path)
- [ ] Update flow runs (compose build --pull) without breaking

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
