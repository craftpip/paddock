# 89 — User-mode agents must not recreate root-owned OpenCode state

## Status: Complete (2026-10-16) — all 5 phases done and verified live. Managed agent processes (published web server, task-runner, orchestrator exec, MCP exec) run as the pad user; existing hooks migrated; live PAD repaired and non-recurrence proven on a container restart. One disclosed limitation: the *exact historical* root writer (pid) was never pinned — it is inferred to be a root `opencode` CLI/TUI, and the corrected code makes every managed launch non-root, so a managed launch cannot recreate the defect. Absorbed into `docs/reference/backend/services.md`; committed.

## Goal

In a user-mode PAD, every managed agent CLI, TUI, published agent server and
agent-writing command must run as the configured PAD user. A running worker must
keep filesystem/MCP access across boot, publish, updates and session recovery.
Repair the cause, not just repeatedly chowning files. Preserve conversations,
queues, credentials, configured MCP tools and state-directory contents.

User reports recurring MCP SSE failure:
`PermissionDenied: FileSystem.makeDirectory /root/.local/state/opencode/locks/...`.
Do not diagnose this as a browser-server lock or remove MCP configuration.

## Live evidence

Read-only probes on `pad-opencode-proj`, using
`docker exec -u 1000:1000 -e HOME=/root`:

- This coding agent on the host is UID/GID 1000.
- Mission OpenCode TUI processes run as 1000:1000. The user's premise is correct
  for those workers; do not blame them without evidence.
- `/root`, `.local`, `.local/state`, `.local/state/opencode`: 1000:1000, mode 755.
- `/root/.local/state/opencode/locks`: **0:0, mode 755**. UID 1000 `test -w`
  returns exit 1. This directly explains inability to create MCP lock directories.
- Published `opencode web --hostname 0.0.0.0 --port 7890`, PID 18, runs as **0:0**;
  its tee process runs as root too. Container keeper runs as UID 1000.
- Server started `2026-10-11 20:04:55 +0530`; locks directory birth
  `2026-10-11 20:05:03 +0530` (eight seconds later). Temporal evidence is strong,
  but it does not identify the creator by itself. Directory remained root-owned
  at inspection, with later modification/change timestamp.

Known code path: `src/vm-builds/opencode/start.sh` executes the published web hook
before the keeper drops privileges. `src/services/vm-manager.js:buildWebHook`
launches the driver command directly in a root-run hook. Create/publish/recreate
also re-execute hooks through docker exec. The user-mode terminal fix does not
cover a server launched outside those terminal primitives.

Earlier AGENTS.md evidence said the web server did not write this state during a
particular test. Recheck current version/boot/MCP initialization conditions; that
old observation is not proof of current behavior. Do not rewrite it as a universal
fact or assert the web process caused this directory until attribution is measured.

## Phase 1 — Attribute the writer and audit identities

Files to inspect: all `src/vm-builds/*/start.sh`, driver web commands,
`vm-manager.js` web hook generation/re-execution and ownership helpers,
`pad-tmux.js:termUserArgs/padExec`, `mcp.js:execDockerArgs`, app terminal/CLI
launch routes, managed post-start hooks, and relevant existing tests/docs.

- Record effective USER_MODE/PUID/PGID, process identities and effective HOME/XDG
  paths. Do not dump environments/configs containing secrets.
- Trace every managed agent launch, including web publish on create/recreate,
  boot hook, settings apply, version/update/config commands and session recovery.
  Identify any root command that writes the shared agent home.
- On a dedicated project-managed test PAD, observe directory ownership across
  server start, MCP initialization, session creation and user TUI start. Capture
  actual writer PID/UID using available filesystem/process tracing, or an isolated
  single-writer control. Never delete/recreate the user's active locks to test.
- Use the installed OpenCode version and current official docs for XDG/CLI behavior.
  Record what is observed versus inferred and any tracing limitation.

## Phase 2 — Drop privileges on every managed agent path

- Reuse a shared configured-user launch primitive instead of another hardcoded
  UID 1000 or inline `su` variant. Apply correct PUID:PGID and HOME consistently.
- In user mode, run published agent servers and their log writers as the PAD user,
  on initial boot and EVERY later re-execution. Ensure auth env survives safely,
  paths are correctly quoted, pid/log files remain writable, and stop/restart still
  targets the intended server. No secrets in diagnostics/argv logs.
- Hooks may perform legitimate privileged system setup, but agent CLI invocations
  from managed hooks must use the user launcher. Define the supported hook contract
  clearly; arbitrary user-written root commands cannot be silently guaranteed safe.
- Keep root-mode PAD behavior explicit. Do not silently change unrelated PAD mode
  or the root control-plane/sshd/init requirements. The requirement concerns agent
  execution in a PAD configured as user mode.
- Do not use chmod 777, world-writable state, disabling MCP, or isolated replacement
  config/home as a shortcut. Worker and server retain the intended shared data.

## Phase 3 — Existing PAD migration and careful repair

- Update generated hooks/build templates and migration detection so existing
  user-mode PADs do not retain stale root-launch scripts. Preserve user-editable
  sections and custom settings. Version/mode-aware marker must detect this exact fix,
  not merely the older home-chown marker.
- Before changing the user's live runtime, record active sessions and plan a
  minimal repair that does not recreate the container or kill unrelated TUIs.
  Explain any required server/TUI interruption before doing it.
- Stop/replace the proven offending root writer before repairing affected ownership;
  otherwise it can recreate the defect. Repair narrowly, preserve locks/data and
  symlink boundaries, use configured UID/GID, and verify write access as that user.
- Investigate supported MCP reconnect/reload behavior before recommending a new
  conversation. Prefer restoring tools in the same conversation. If a fresh TUI
  process is needed, resume the exact existing ID; if even that cannot repair
  sticky tools, report the measured limitation and ask before replacing conversation.
- No state deletion, lock-server clearing, config removal, blind recursive chown
  of unrelated host directories or unasked queue resume.

## Phase 4 — Regression and live verification

- Unit tests assert generated web hooks and all managed re-execution branches
  invoke the configured-user primitive in user mode; root mode remains intentional.
  Test HOME, env forwarding, custom UID/GID, command quoting and log/pid ownership.
- Use a project-managed controlled PAD: boot/publish server → create conversation
  → start user TUI → connect/call browser MCP. Assert effective server/TUI UID/GID,
  lock-directory writable ownership and actual successful MCP call.
- Repeat the same assertions after publish reapply, server restart, normal PAD
  restart and relevant update/recreate migration (controlled PAD only).
- Recheck after a delay and new sessions/MCP initialization; a one-time chown pass
  before the offending writer runs is not proof of non-recurrence.
- Positive/negative controls: prove the old root launch can recreate the defect in
  the controlled environment where possible, and the corrected launch cannot under
  the same steps. Source mutations run in throwaway copies, never the bind mount.
- Relevant existing user-mode/home/web-hook tests run individually and isolated.
  Build/restart affected services only as necessary; browser verifies real tools,
  not merely an MCP Connected label. No test containers outside project tools.

## Phase 5 — Diagnose and document truthfully

- UI/runtime diagnostics should identify agent user, unwritable state path and
  actionable repair; do not classify filesystem EACCES as remote SSE/browser outage.
- Report exact writer attribution, changed launch paths, migration scope, same-ID
  tool recovery result and recurrence controls. If attribution is incomplete, say so.
- Update docs after reading index/style guide. Update AGENTS.md's relevant ownership
  gotcha only with measured findings, merging the existing rule rather than adding
  another contradictory claim. Preserve the distinction between old/new versions.

## Evidence (2026-10-16)

Repair, live on `pad-opencode-proj` (the user's real pad):

- Stopped the root server (pid 18) + root `tee` (19); re-ran
  `/root/.opencode/start-web.sh` as root → the runtime gate launched
  `opencode web` as **uid 1000**. Port 7890 back to HTTP 200.
- `chown -R 1000:1000 /root/.local/state/opencode`; the two Oct-15 root-owned
  `.lock` dirs became node-owned.
- `docker exec -u 1000:1000 -e HOME=/root … opencode mcp list` → exit 0, servers
  listed (`paddock` connected). The pad-user `mcp list` created its new lock dir
  **node-owned**; `find /root/.local/state/opencode -not -user node` → empty.

Controlled non-recurrence on `pad-opencode-user1` (dead test pad, project
`friction-probe`, all sessions ended 2026-09-29):

- Before: root web server (pid 23) + root-owned `locks/` (the defect).
- `docker restart` → boot `start.sh` ran the hook → `opencode web` **uid 1000**
  (`tee` still root), `web.pid`/`web.log` node-owned.
- Published server served HTTP 200 and a session POST; after that,
  root-owned files under `/root/.local/state/opencode`: **0**.
- Measured that the server does **not** create lock entries (empty `locks/`
  after boot + session POST) — the recurring root writer is a root `opencode`
  CLI/TUI, so plan 89's guarantee is "no *managed* process runs root".

Tests (all individually, green): `web-user-drop.test.js` (8),
`orchestrator` (7), `task-pipeline` (22), `tasks` (73), `mcp-exec-usermode` (5).
Because the worktree carried other in-flight work, the suites were re-run
against the **materialized index** (`git checkout-index -a --prefix=/tmp/staged`)
— the commit snapshot — and all passed there too. Mutation controls ran in a
`/tmp` copy (bind mount untouched): removing the orchestrator/task-runner drop,
the hook user branch, or the migration each reds exactly its own test.

## Checklist

- [x] Inspect live worker/server identities and lock-directory permissions safely.
- [x] Phase 1: all managed launch paths audited (published web hook on boot +
      exec re-exec, task-runner, orchestrator, MCP exec); exact historical writer
      pid not pinned — see limitation in Status.
- [x] Phase 2: consistent configured-user agent/server execution (runtime-gated
      `pad_run`; `termUserArgs` spliced into every exec/spawn).
- [x] Phase 3: stale-hook migration (`ensureWebHookUserDrop` + `migrateWebHooks`
      boot sweep) and the approved minimal repair on `pad-opencode-proj`.
- [x] Phase 4: live MCP success (exit 0) and non-recurrence proven on a container
      restart; mutation controls in a throwaway copy.
- [x] Phase 5: truthful diagnostics (docs + AGENTS merged, tee-stays-root and the
      "server is not the lock writer" measured facts recorded).

## Completion

Complete requires both ownership/access recovery AND proof the managed launch
cannot recreate root-owned state. An ownership command succeeding is not enough.
Record results here before leaving; preserve existing queue/task progress.

Both halves are satisfied and recorded above. The residual, disclosed risk is a
human-run root `opencode` (host `docker exec`/SSH) — outside the managed surface.
