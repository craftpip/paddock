# Plan 122 — Audit fixes: PAD lifecycle, workspace and settings

## Status: In progress — 2026-11-11 — 0/21 items fixed; all traced in code by a read-only review, none yet reproduced

## Why

A read-only review of `services/vm-manager/`, the drivers, `workspace.js`,
`instance-image.js`, `job-log.js`, `task-runner.js` and neighbours on
2026-11-11. Nothing was run. **Each finding is reproduced (in a unit test
against a throwaway directory, or on a throwaway PAD) before it is fixed.**
Destructive findings (2, 4, 5) are reproduced **only** in tests on temp
directories or by reading the argv a fake runner records, never against real
data or other projects' containers.

## Findings

Severity: H = high, M = medium, L = low.

| # | Sev | Where | What is wrong | Scenario |
|---|---|---|---|---|
| 1 | H | `services/workspace.js` `resolveHostPath` and its users (`readFile`, `readFileB64`, `fsList`, `renameEntry`, `deleteEntry`, `moveEntry`, `resolveParentSafePath`) | The clamp is lexical; `fs.*` then follows symlinks as root | Same as plan 121 #5. **Fixed once, there; listed here because this is where the code is** |
| 2 | H | `vm-manager/lifecycle.js` `removeVm` | Deleting a PAD recursively deletes its `WORKSPACE_HOST` when that is under the project root but outside the PAD's data dir, with no exclusion for the project root, `instances/`, or a source another PAD mounts | With the guards off and the repo mounted as workspace, deleting the PAD deletes the repo. With guards on, a workspace at `<root>/docs` is deleted with the PAD. Two PADs sharing a source: deleting one wipes the other's |
| 3 | H | `vm-manager/devcontainer.js` runArgs and mounts; `compose.js`; re-resolved on every `applySettings` | `--env-file` paths are not validated, `--cap-add` / `--sysctl` take anything, and the "project internals" mount check runs on an un-normalised path | The agent writes a `devcontainer.json` naming the control plane's `.env` as an env file; the operator's next unrelated Apply recreates the PAD with those secrets and all capabilities |
| 4 | H | `app.js` `cleanOrphanDoors` (a dead duplicate sits in `vm-manager/doors-network.js`) | Matches every container named `*-door` or `*-web` and `docker rm -f`s it when no instance dir exists; no prefix or image check | Another project's `shop-web` container is force-removed on every webui boot |
| 5 | M | `services/workspace.js` `resolveHostPath`; `routes/agent-workspace.js` delete/rename/move | An outside or missing path is silently clamped to the root, and destructive operations then act on the root | `POST …/workspace/delete {}` deletes the PAD's whole data dir |
| 6 | M | `vm-manager/lifecycle.js` `createVm`, `validateAgentCreate` | `ROOT_PASSWORD` and `PORT` are written to `meta.env` raw | A password containing a newline injects `EXTRA_VOLUMES=…` and binds host `/` into the PAD, past every guard |
| 7 | M | `drivers/opencode.js`, `picoclaw.js`, `hermes.js`; `vm-manager/web.js` | The web password is placed inside shell single quotes unescaped | A password with `'` breaks the start hook; a crafted one runs a command as root in the PAD on every boot |
| 8 | M | `vm-manager/settings-apply.js`, `lifecycle.js` `resetVm` | Reset deletes the web hook and auth but `web.json` survives | A reset PAD shows "published" with nothing listening and the password gone |
| 9 | M | `vm-manager/settings-apply.js` `rollbackAgentChanges` | Does not restore `USER_MODE`, build commands or lifecycle scripts; drops `authToken`; `prepareAgentChanges` has a side effect | A failed user-mode toggle leaves the PAD in user mode on an image with no pad user |
| 10 | M | `vm-manager/internal.js` `setMetaFlag`; `instance-image.js` `setBuildEnv`, `writeCustomBuild` | `content.replace(re, userText)` interprets `$$`, `$&`, `` $` ``, `$'` | SSH password `pa$$w0rd` is stored as `pa$w0rd`; the next regeneration changes the root password |
| 11 | M | `vm-manager/settings-apply.js`; `routes/agent-settings.js` | `INSTALL_DOCKER=1` is set only in the REST route | MCP `recreate {allowDocker:true}` mounts the socket into an image with no docker CLI and reports success |
| 12 | L | `vm-manager/settings-apply.js` | `applyWebAuth` / `removeWebAuth` not awaited in apply and rollback | A corrupt openclaw config becomes an unhandled rejection and a misleading "did not come up" |
| 13 | L | `services/job-log.js` | A finished job's cleanup timer deletes whatever job now holds that key | A second update within five minutes loses its log; `job_status` says no job mid-build |
| 14 | L | `services/task-runner.js` boot reconciliation | Marks claimed pull-mode tasks as orphaned | A worker's later `task_complete` is refused after a webui restart |
| 15 | L | `vm-manager/compose.js`, `vm-manager/web.js` | Port-conflict regexes miss `"43817:4200/tcp"` | A stopped PAD's forward port is handed to another PAD |

Noted by the reviewer below the cut, each to be checked the same way:

| # | Where | What |
|---|---|---|
| 16 | `routes/agent-workspace.js` → `workspace.writeParentFile` | The function does not exist, so `POST …/workspace/parent/save` always answers 500; `listParentDir` ignores `subpath` |
| 17 | `vm-manager/settings-apply.js` | Nothing serialises `applyAgentChanges` per PAD; two concurrent applies both rewrite meta and compose |
| 18 | `vm-manager/lifecycle.js` `createVm` | A failed create leaves `instances/<pad>/` behind with no rollback |
| 19 | `vm-manager/workspace-mount.js` | A container path containing `:` (`/work:ro`) changes the compose short-syntax meaning; `existsSync` is checked in the wrong namespace when `HOST_WORKSPACE != WORKSPACE` |
| 20 | `services/task-runner.js`, `services/log-store.js` | Unbounded `state.out`; `trim` never shrinks a file of long lines |
| 21 | `vm-manager/lifecycle.js` `stopAgent` / `restartAgent` | Docker errors are swallowed and the route answers `ok: true` |

## Not reviewed

`container-health.js`, `net-peer.js`, `task-pipeline.js`,
`vm-manager/config-redaction.js`, `backup-manager.js`, `drivers/mcp-util.js`;
only skimmed: `agent-registry.js`, `vm-manager/subnets.js`, `path-probe.js`,
the drivers beyond their start commands. A second pass is item 22.

## How each fix is proven

- `vm-manager.test.js` and new focused tests use throwaway directories
  (`WORKSPACE_ROOT` pointed at a temp tree) and a recording fake for docker.
  Each new test has a mutation control via `scripts/mutate.sh`.
- Live, on a throwaway PAD created through the app: create with a password
  containing `$$` and `'`, publish the web console with such a password, reset,
  delete. Nothing is done to `pad-dev` or to any container not named
  `paddock` / `pad-*`.
- `npm test` green.

## Progress

- [x] 1 (done under plan 121 #5)
- [ ] 2 `removeVm` deletes only a workspace it created and nobody shares
- [ ] 3 Devcontainer plan: env files, capabilities, sysctls and mounts validated
- [ ] 4 Orphan-door sweep limited to this project's doors
- [x] 5 Destructive workspace operations refuse an outside, missing or root path (done with plan 121 #5; live: `delete {}` → 400)
- [ ] 6 Create validates password and port
- [ ] 7 Web password shell-quoted in every driver
- [ ] 8 Reset keeps the web console published and working, or unpublishes it
- [ ] 9 Rollback restores everything apply changed
- [ ] 10 Function replacers for user text
- [ ] 11 `INSTALL_DOCKER` set in the shared apply path
- [ ] 12 `applyWebAuth` / `removeWebAuth` awaited
- [ ] 13 Job cleanup timer only removes its own job
- [ ] 14 Boot reconciliation leaves claimed tasks alone
- [ ] 15 Port-conflict scan reads `/tcp` ports
- [x] 16 Parent-file save removed (it called a function that never existed; nothing used it)
- [ ] 17 One apply per PAD at a time
- [ ] 18 Failed create cleans up after itself
- [ ] 19 Container paths validated
- [ ] 20 Output and log growth bounded
- [ ] 21 Stop / restart report docker failures
- [ ] 22 Second review pass over the files listed under "Not reviewed"
