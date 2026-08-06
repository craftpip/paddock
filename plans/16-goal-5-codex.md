# Goal 5 — codex Driver + Image

## Status: Planned (2026-08-06)

## Goal

Add codex (OpenAI Codex CLI) as a first-class agent: one Dockerfile + one
driver + a CreateAgent option. The terminal tab is the interface — you run
`codex` interactively; config (`~/.codex`) and workspace persist in the mounted
data dir.

## Details

### Dockerfile — `src/vm-builds/codex/Dockerfile`

- Base: `node:20-slim`
- `npm install -g @openai/codex` (binary: `codex`)
- `ARG INSTALL_DOCKER=0` + conditional `docker.io` install — same pattern as
  openclaw. Do NOT bake the CLI in; the settings flow auto-rebuilds with
  `INSTALL_DOCKER=1`.
- No `mcporter`.
- sshd + `ROOT_PASSWORD` handling, TZ (`Asia/Kolkata`), `WORKDIR /root`,
  `EXPOSE 22`.
- `start.sh` = set password/TZ, `sshd &`, keep-alive (`tail -f /dev/null`) —
  codex has no gateway daemon.

### Driver — `src/services/drivers/codex.js`

| Field | value |
|-------|-------|
| `type` / `label` | `codex` / `Codex` |
| `buildImage` | `paddock-vm-codex:latest` |
| `buildRel` | `../../src/vm-builds/codex` |
| `baseImage` | `node:20-slim` |
| `dataDir` | `/root/.codex` |
| `workspaceDir` | `/root/.codex/workspace` |
| `setupSteps` | `[]` |
| `backupSteps` | `[]` (no openclaw backup) |
| `installDockerBuildArg` | `INSTALL_DOCKER=1` |
| `currentVersion(name)` | `codex --version` |
| `availableVersion()` | `''` (no base label → no update available) |
| `commands` | small bespoke set (login, exec…) or `[]` for now |

### CreateAgent

- `<option value="codex">codex</option>` (or from the registry). No setup step.

## Files

- **New** `src/vm-builds/codex/Dockerfile`
- **New** `src/services/drivers/codex.js`
- **Modified** `src/client/src/pages/CreateAgent.jsx` — option
- **Modified** `src/services/vm-manager.js` only if AGENT maps still hold

## Progress

- [ ] Write `src/vm-builds/codex/Dockerfile`
- [ ] Build the image
- [ ] Write `src/services/drivers/codex.js`
- [ ] Add CreateAgent option
- [ ] Create a test codex agent
- [ ] Terminal drops into a shell; `codex --version` works
- [ ] `codex` interactive CLI runs; config writes to `/root/.codex`
- [ ] Data dir persists across container restart
- [ ] Terminal `pwd` = `driver.workspaceDir`
- [ ] Files written in the workspace show up in the workspace tab
- [ ] Settings page: version shows, docker toggle works (rebuild path)
- [ ] Update flow runs (compose build --pull) without breaking

## Verification

```bash
docker exec <test-codex> codex --version
docker exec <test-codex> pwd                      # /root/.codex/workspace
# restart container → config + files still there
# toggle docker on → docker ps works from inside
```

## Open questions

- `commands` group content for codex — fill from `codex --help` during the
  goal, or leave empty until a separate commands pass.
