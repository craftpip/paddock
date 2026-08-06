# Goal 6 — claude Driver + Image

## Status: Planned (2026-08-06)

## Goal

Add claude (Anthropic Claude Code) as a first-class agent: one Dockerfile + one
driver + a CreateAgent option. The terminal tab is the interface — you run
`claude` interactively; config (`~/.claude`) and workspace persist in the
mounted data dir.

## Details

### Dockerfile — `src/vm-builds/claude/Dockerfile`

- Base: `node:20-slim`
- `npm install -g @anthropic-ai/claude-code` (binary: `claude`)
- `ARG INSTALL_DOCKER=0` + conditional `docker.io` install — same pattern as
  openclaw. Do NOT bake the CLI in; the settings flow auto-rebuilds with
  `INSTALL_DOCKER=1`.
- No `mcporter`.
- sshd + `ROOT_PASSWORD` handling, TZ (`Asia/Kolkata`), `WORKDIR /root`,
  `EXPOSE 22`.
- `start.sh` = set password/TZ, `sshd &`, keep-alive (`tail -f /dev/null`) —
  claude has no gateway daemon.

### Driver — `src/services/drivers/claude.js`

| Field | value |
|-------|-------|
| `type` / `label` | `claude` / `Claude` |
| `buildImage` | `paddock-vm-claude:latest` |
| `buildRel` | `../../src/vm-builds/claude` |
| `baseImage` | `node:20-slim` |
| `dataDir` | `/root/.claude` |
| `workspaceDir` | `/root/.claude/workspace` |
| `setupSteps` | `[]` |
| `backupSteps` | `[]` (no openclaw backup) |
| `installDockerBuildArg` | `INSTALL_DOCKER=1` |
| `currentVersion(name)` | `claude --version` |
| `availableVersion()` | `''` (no base label → no update available) |
| `commands` | small bespoke set or `[]` for now |

### CreateAgent

- `<option value="claude">claude</option>` (or from the registry). No setup
  step.

## Files

- **New** `src/vm-builds/claude/Dockerfile`
- **New** `src/services/drivers/claude.js`
- **Modified** `src/client/src/pages/CreateAgent.jsx` — option
- **Modified** `src/services/vm-manager.js` only if AGENT maps still hold

## Progress

- [ ] Write `src/vm-builds/claude/Dockerfile`
- [ ] Build the image
- [ ] Write `src/services/drivers/claude.js`
- [ ] Add CreateAgent option
- [ ] Create a test claude agent
- [ ] Terminal drops into a shell; `claude --version` works
- [ ] `claude` interactive CLI runs; config writes to `/root/.claude`
- [ ] Data dir persists across container restart
- [ ] Terminal `pwd` = `driver.workspaceDir`
- [ ] Files written in the workspace show up in the workspace tab
- [ ] Settings page: version shows, docker toggle works (rebuild path)
- [ ] Update flow runs (compose build --pull) without breaking

## Verification

```bash
docker exec <test-claude> claude --version
docker exec <test-claude> pwd                    # /root/.claude/workspace
# restart container → config + files still there
# toggle docker on → docker ps works from inside
```

## Open questions

- Confirm the type name `claude` is what we want (the "Cloud?" question from
  plan 08). If it meant something else, say so before this goal starts.
- `commands` group content for claude — fill from `claude --help` during the
  goal, or leave empty until a separate commands pass.
