# Plan 122 — Audit fixes: PAD lifecycle, workspace and settings

## Status: In progress — 2026-11-11 — 21/22 items done; remaining: #22, the second review pass over the files the first reviewer did not read

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

## Results (2026-11-11)

Live checks ran on a throwaway PAD (`pad-audit`) and a deliberately failing
create (`pad-failcheck`); nothing was done to `pad-dev` or to any container
that is not ours. `npm test`: 74 files, 1222 tests.

| # | Fix | Evidence |
|---|---|---|
| 2 | `removeVm` deletes a workspace source only when the create itself made it (`WORKSPACE_CREATED=1` in meta), nobody else mounts it, and it is strictly inside the project root without containing `instances/`. PADs created before today have no flag, so their source is kept | `pad-delete-workspace.test.js` (5), control bites. Not run against real data, by design |
| 3 | Devcontainer plan: env files must be inside the workspace (real path), capabilities and sysctls are allow-listed, mount paths are normalised before the internals check. Also fixed: `--cap-add NAME` in the two-argument form was rejected | `devcontainer-safety.test.js` (3) + 4 in `vm-manager.test.js`, control bites |
| 4 | The orphan-door sweep names only a socat container called `<this project's PAD name>-door` / `-web` with no instance folder; the dead duplicate is gone | `orphan-doors.test.js` (4), control bites. Not run against other containers, by design |
| 6 | Create validates the password (no line break) and the port (a number) | `pad-input-safety.test.js` |
| 7 | A web password with a quote, backslash or line break is refused before anything is written | Live: `ab'cd` → 400; `Good-pass$$1` published and the console answered 200 with it, 401 without |
| 8 | Reset reads the web password before the wipe and restores the start hook and auth after it; the console is verified after a reset | Reproduced first: after a reset the port was published, nothing answered, `passwordConfigured: false`. After the fix: 200 with the password, 401 without, `passwordConfigured: true` |
| 9 | Rollback also restores user mode, build commands, lifecycle scripts, the docker build flag and the web token | Code; suites green. Not forced live |
| 10 | Function replacers wherever user text is the replacement | Test: `pa$$w0rd`, `$&`, `$'` stored verbatim on a second save; control bites. Live: `ROOT_PASSWORD=pa$$w0rd-2` in meta after two saves |
| 11 | `INSTALL_DOCKER` is written in the shared apply path, so MCP `recreate` gets it too | Code; suites green |
| 12 | `applyWebAuth` / `removeWebAuth` awaited in apply and rollback | Code; suites green |
| 13 | A job's cleanup timer removes only its own job | Test, control bites |
| 14 | Boot reconciliation leaves claimed tasks alone | Code (the task queue is off by default) |
| 15 | Port-conflict scans read `"43817:4200/tcp"` | Code; suites green |
| 16 | The parent-file save route is removed (it called a function that never existed) | Route table test |
| 17 | One change set per PAD at a time; a second is refused with 409 `pad_change_in_progress` | Test, control bites |
| 18 | A failed create removes its container, doors, network, instance folder and image; never the workspace source | Live: a create with `RUN exit 7` failed and left dir 0, containers 0, networks 0, images 0 |
| 19 | A container path may not contain `:` or a line break | Code; suites green |
| 20 | A log over 8 MB is cut to under it even when it is a few very long lines; a running task's output is bounded in memory | `log-store.test.js` |
| 21 | Stop reports a real docker failure (a container already gone is fine); restart falls back to a compose recreate like start does | Live: stop and restart of `pad-audit` |

While writing these fixes my own edit script corrupted two files with exactly
the `$'`-in-a-replacement-string bug of #10. Both were restored from git and
redone; the edit helper now splices by index.

## Progress

- [x] 1 (done under plan 121 #5)
- [x] 2 `removeVm` deletes only a workspace it created and nobody shares
- [x] 3 Devcontainer plan: env files, capabilities, sysctls and mounts validated
- [x] 4 Orphan-door sweep limited to this project's doors
- [x] 5 Destructive workspace operations refuse an outside, missing or root path (done with plan 121 #5; live: `delete {}` → 400)
- [x] 6 Create validates password and port
- [x] 7 Web password shell-quoted in every driver
- [x] 8 Reset keeps the web console published and working, or unpublishes it
- [x] 9 Rollback restores everything apply changed
- [x] 10 Function replacers for user text
- [x] 11 `INSTALL_DOCKER` set in the shared apply path
- [x] 12 `applyWebAuth` / `removeWebAuth` awaited
- [x] 13 Job cleanup timer only removes its own job
- [x] 14 Boot reconciliation leaves claimed tasks alone
- [x] 15 Port-conflict scan reads `/tcp` ports
- [x] 16 Parent-file save removed (it called a function that never existed; nothing used it)
- [x] 17 One apply per PAD at a time
- [x] 18 Failed create cleans up after itself
- [x] 19 Container paths validated
- [x] 20 Output and log growth bounded
- [x] 21 Stop / restart report docker failures
- [ ] 22 Second review pass over the files listed under "Not reviewed"
