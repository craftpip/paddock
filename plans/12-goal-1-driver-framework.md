# Goal 1 — Driver Framework + openclaw Reference Driver

## Status: Planned (2026-08-06)

## Goal

Build the driver framework and move openclaw's existing behavior into the
reference driver — with zero visible change. This is the foundation every other
goal builds on. Everything openclaw does today (versions, workspace, setup,
backup, commands, docker arg) must keep working exactly as before through the
driver.

## Details

### Driver registry — `src/services/drivers/`

- `index.js` — registry + `getDriver(type)`. Falls back to the openclaw driver
  when a type has none. Also `listDrivers()` / `agentTypes()` for the
  CreateAgent select and the commands endpoint.
- `openclaw.js` — the reference driver. Implements every field:

| Field | openclaw value |
|-------|----------------|
| `type` / `label` | `openclaw` / `OpenClaw` |
| `buildImage` | `paddock-vm-openclaw:latest` |
| `buildRel` | `../../src/vm-builds/openclaw` |
| `baseImage` | `ghcr.io/openclaw/openclaw:latest` |
| `dataDir` | `/root/.openclaw` |
| `workspaceDir` | `/root/.openclaw/workspace` |
| `setupSteps` | `openclaw setup --baseline` |
| `backupSteps` | `openclaw backup create --output /tmp/{name}_{ts}.tar.gz` |
| `installDockerBuildArg` | `INSTALL_DOCKER=1` |
| `currentVersion(name)` | `openclaw --version` (container, fallback image) |
| `availableVersion()` | base image version label (cached 5 min) |
| `commands` | the existing Commands page groups |

### Backend consumers → driver calls

- **vm-manager.js** — remove `AGENT_IMAGES`, `AGENT_BUILD_REL`,
  `AGENT_BASE_IMAGES`, `containerDataDir()`, `parseOpenClawVersion()` /
  `readOpenClawVersion()` / `readBaseImageVersion()`, `getUpdateInfo()`. All
  replaced with `getDriver(agent)` calls. The createVm setup guard becomes
  "run `setupSteps` if non-empty".
- **app.js** — settings + update-info routes call
  `getDriver(type).currentVersion(name)` / `.availableVersion()`. New endpoint
  `GET /api/agent-types/:type/commands` serves `driver.commands`.
- **agent-registry.js** — `getWorkspaceRoot()` / `getConfigRoot()` /
  `buildAgent()` derive paths from `driver.workspaceDir` / `driver.dataDir`
  instead of defaulting to `openclaw`.
- **backup-manager.js** — backup/restore runs `driver.backupSteps`.

### Frontend consumers

- **CommandsPane.jsx** — stop hardcoding the `SIMPLE_GROUPS`; fetch
  `/api/agent-types/<type>/commands` and render. Layout, colors, confirm,
  prompt/run plumbing stay the same.
- **CreateAgent.jsx** — type options come from the registry (via
  `/api/agent-types`); the setup step reads from the driver instead of the
  hardcoded `openclaw setup --baseline`.
- **SettingsTab.jsx** — version row via `driver.currentVersion()`.
- **AgentDetail.jsx** — workspace tab container root becomes
  `driver.workspaceDir` instead of hardcoded `/root/.openclaw`.

## Files

- **New** `src/services/drivers/index.js`
- **New** `src/services/drivers/openclaw.js`
- **Modified** `src/services/vm-manager.js`
- **Modified** `src/services/agent-registry.js`
- **Modified** `src/services/backup-manager.js`
- **Modified** `src/app.js` (version routes + commands endpoint)
- **Modified** `src/client/src/pages/agent/CommandsPane.jsx`
- **Modified** `src/client/src/pages/CreateAgent.jsx`
- **Modified** `src/client/src/pages/agent/SettingsTab.jsx`
- **Modified** `src/client/src/pages/AgentDetail.jsx`

## Progress

- [ ] `src/services/drivers/index.js` — registry + `getDriver()` + fallback
- [ ] `src/services/drivers/openclaw.js` — reference driver with all fields
- [ ] vm-manager.js — maps/version/setup-guard → driver calls
- [ ] app.js — settings + update-info version via driver
- [ ] app.js — `GET /api/agent-types/:type/commands`
- [ ] agent-registry.js — workspace/config root via driver
- [ ] backup-manager.js — via `driver.backupSteps`
- [ ] CommandsPane.jsx — fetch + render from driver
- [ ] CreateAgent.jsx — options + setup from registry
- [ ] SettingsTab.jsx — version row via driver
- [ ] AgentDetail.jsx — workspace container root via driver
- [ ] Regression: create, terminal, versions, update card, workspace, backup
      behave exactly as before on a live openclaw PAD
- [ ] Regression: docker toggle (plan 09) still works

## Verification

```bash
# regression on a live openclaw PAD
#   - create agent via UI, terminal connects
#   - settings page shows version from driver
#   - update-info returns current/available
#   - workspace tab browses /root/.openclaw/workspace
#   - backup runs
#   - docker toggle on/off still works

curl http://10.69.1.164:6789/api/agent-types/openclaw/commands   # groups
curl http://10.69.1.164:6789/api/agent-types                      # type list
```

## Open questions

- Commands endpoint shape: `GET /api/agent-types/:type/commands` vs bundled
  into `/api/config` — settled here, backend-only.
- Where does `openclaw.json` model reading (registry `buildAgent`) live — stays
  in the registry or moves into the driver? Driver owns it long-term.
