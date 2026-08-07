# Goal 5 — codex Driver + Image

## Status: Done (2026-08-07)

## Goal

Add codex (OpenAI Codex CLI) as a first-class agent: one Dockerfile + one
driver + a CreateAgent option. The terminal tab is the interface — you run
`codex` interactively; config (`~/.codex`) and workspace persist in the mounted
data dir.

## Details

### Dockerfile — `src/vm-builds/codex/Dockerfile`

- Base: `node:20-slim`
- `npm install -g @openai/codex` (binary: `codex` — npm wrapper spawns a native
  Rust binary from `@openai/codex-linux-x64`, auto-installed as an optional dep)
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
| `configFile` / `configFormat` | `config.toml` / `toml` (verbatim, not JSON) |
| `setupSteps` | `[]` |
| `backupSteps` | `[]` (no openclaw backup) |
| `installDockerBuildArg` | `INSTALL_DOCKER=1` |
| `currentVersion(name)` | `codex --version` → `codex-cli 0.147.0` |
| `availableVersion()` | `''` (no base label → no update available) |
| `commands` | Session (exec help, eval help) + Other (version, help) |

### CreateAgent

- Type select is dynamic from `/api/agent-types` (listDrivers) — codex showed
  up automatically after registering the driver; no CreateAgent.jsx edit.

## Files

- **New** `src/vm-builds/codex/Dockerfile`
- **New** `src/vm-builds/codex/start.sh`
- **New** `src/services/drivers/codex.js`
- **Modified** `src/services/drivers/index.js` — register `codex`
- **Modified** `plans/16-goal-5-codex.md` (this file)

## Progress

- [x] Write `src/vm-builds/codex/Dockerfile`
- [x] Build the image
- [x] Write `src/services/drivers/codex.js`
- [x] Register driver + restart webui (CreateAgent option appears)
- [x] Create a test codex agent
- [x] Terminal drops into a shell; `codex --version` works
- [x] `codex` interactive CLI runs; config writes to `/root/.codex`
- [x] Data dir persists across container restart
- [x] Terminal `pwd` = `driver.workspaceDir` (`/root/.codex/workspace`)
- [x] Files written in the workspace show up in the workspace tab
- [x] Settings page: version shows, docker toggle works (rebuild path)
- [x] Update flow runs (compose build --pull) without breaking

## Verification

```bash
docker exec <test-codex> codex --version        # codex-cli 0.147.0
docker exec <test-codex> pwd                    # /root/.codex/workspace
# restart container → config + files still there (verified)
# toggle docker on → docker ps works from inside (verified — rebuilt, 29.5.3)
# config GET → configFormat "toml", verbatim raw
```

## Notes / Findings

- `config.toml` is TOML, not JSON — set `configFormat: 'toml'` so the config
  GET/POST routes serve it verbatim (same non-JSON path as hermes' yaml). The
  ConfigTab in AgentDetail.jsx already handles any non-json format.
- Codex npm package is a thin wrapper; the real binary is a Rust binary from
  the platform package. `npm install -g @openai/codex` installs it
  automatically on linux-x64.
- `codex --version` prints `codex-cli 0.147.0` — the parse regex
  (`\d+\.\d+\.\d+`) handles it.
- `codex exec` (non-interactive) confirmed working — good for scripts.
- Settings docker toggle detected missing docker CLI and rebuilt the image
  with `INSTALL_DOCKER=1` automatically (`reason: "rebuild"`), then recreated
  the container. Data survived the rebuild.
- The webui terminal's single-client policy kicked an earlier browser session
  when a probe connected to the same tmux session — Reconnect (via confirm
  dialog) restored it. Not a codex issue.
