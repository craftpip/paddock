# Goal 1 — Driver Framework + openclaw Reference Driver

## Status: Complete (2026-08-06)

Backend + frontend migrated to the driver registry and verified live on
`pad-openclaw-test`. Docker toggle not re-run destructively (triggers an image
rebuild on the live pad); its changed bits — image lookup and the
`INSTALL_DOCKER=1` build arg — are behavior-identical to the pre-driver code
and were confirmed via diff + live `GET /api/agents/:name/settings`.

## Retest after create-flow fixes (2026-08-06)

Post-Goal-1 regression on a fresh agent found the create flow was broken; two
frontend fixes landed (uncommitted, pending commit):

1. **CreateAgent.jsx** — `/agents/create` and `/agents/create/:name` render the
   same component, so React reused the instance and the `phase`/`jobName`
   initializers never re-ran on navigation. Added a `useEffect` on `urlName`
   that flips to `creating` + syncs the name, plus `setPhase('creating')`
   before `navigate(...)` in `handleSubmit`.
2. **Terminal.jsx** — never `fit()` a hidden/zero-size container (FitAddon
   clamps to 2x1 instead of bailing), so collapsed terminals no longer shred
   the buffer or look busy forever. Live `collapsedRef` + guards in the
   ResizeObserver, font-size effect, and busy polling.

Full retest on `pad-openclaw-goal1-regression` (deleted after testing):
- Create (fresh) via UI: SSE stream, build → up → `openclaw setup --baseline`
  → restart, "done" phase + "Go to" button — all working.
- Terminal connects; `openclaw --version` → `OpenClaw 2026.7.1`; a driver
  command (`openclaw status`) runs through the docked terminal.
- Settings shows Version 2026.7.1 (driver `currentVersion`).
- `/api/agents/:name/update-info` → current/available both 2026.7.1.
- Update flow: confirm dialog shows driver version, SSE modal streams
  `compose build --pull` (build output shows `INSTALL_DOCKER=1` applied), then
  recreate, container back up, version intact.
- Workspace tab browses `/root/.openclaw` (driver `dataDir`), paths map to the
  instance bind mount.
- Config / Logs / Sessions / Activity tabs render.
- Backup creates an archive; type detection via `backupTypeMarker`.
- Stop → Start → Restart all work.
- Delete removes container + compose network + instance dir + DB rows.
- Dashboard back to the 2 kept PADs (test, work-pls).

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
| `backupTypeMarker` | `_openclaw-backup-cli_` (filename sniff for type) |
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
- **backup-manager.js** — backup type detection via `driver.backupTypeMarker`
  (no `backupSteps` field; backup-manager composes the command and uses
  `driver.dataDir` for the in-container path).

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

- [x] `src/services/drivers/index.js` — registry + `getDriver()` + fallback
- [x] `src/services/drivers/openclaw.js` — reference driver with all fields
- [x] vm-manager.js — maps/version/setup-guard → driver calls
- [x] app.js — settings + update-info version via driver
- [x] app.js — `GET /api/agent-types/:type/commands`
- [x] agent-registry.js — workspace/config root via driver
- [x] backup-manager.js — via `driver.backupTypeMarker` + `dataDir`
- [x] CommandsPane.jsx — fetch + render from driver
- [x] CreateAgent.jsx — options + setup from registry
- [x] SettingsTab.jsx — version row via driver
- [x] AgentDetail.jsx — workspace container root via driver
- [x] Regression: create, terminal, versions, update card, workspace, backup
      behave exactly as before on a live openclaw PAD
- [ ] Regression: docker toggle (plan 09) — verified by diff + live settings
      API only; full toggle rebuild not run on the live pad

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
