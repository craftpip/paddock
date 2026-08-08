# Custom Workspace Path + Bind Mount at Create Time (plan 24)

> **Updated 2026-08-08** — plan 25 (independent per-instance build files) is now
> implemented. This plan was refreshed to match the post-plan-25 codebase:
> `generateInstanceCompose` now also emits the per-instance build block
> (context `instances/<name>/build`, image `paddock-vm-<name>:latest`, generated
> `build.args:`), drivers dropped `buildImage`/`installDockerBuildArg` and
> renamed `buildRel` → `templateDir`, and `updateAgent`/settings run through the
> `--env-file` `composeCommand` helper. **None of that changes this plan's
> design** — the workspace mount is an extra volume line in the same
> `generateInstanceCompose`, and `WORKSPACE_*` meta flags stay the source of
> truth for it. Line references below point at the current code.
> Plan 24 itself is **not yet implemented**.

## Goal

When creating a new agent, let the user choose:

1. **Host workspace source** — which host folder is mounted.
2. **Container workspace path** — where that folder is mounted inside the
   container. This is the agent's effective workspace.

The paths are in different filesystems and are therefore independent. They have
their own defaults and validation; there is no chain/link control.

**Defaults = today's location.** The workspace folder already lives on the host
at `instances/<name>/<agent>/workspace` (opencode → `instances/<name>/opencode/
workspace`, openclaw → `instances/<name>/openclaw/workspace`), i.e. the
`workspace` subfolder of the driver's data dir. In the container that is the
driver's `workspaceDir` (`/root/.openclaw/workspace` for openclaw). So turning
the toggle on prefills the exact current location and **nothing moves** — it
just makes the folder an explicit, user-editable bind mount.

Today the workspace path is only *defined* inside the container — it's the
driver's static `workspaceDir` (e.g. `/root/.openclaw/workspace`) which just
happens to live inside the `dataDir` bind mount. It is **not** its own bind
mount, and the user has no say in where it lives. This plan makes the
workspace a first-class, user-controlled bind mount at create time.

**Accepted trade-off (2026-08-08, refined):** the paddock webui mounts only the
project root (`/workspace`) and `src/`. The **default** custom-workspace path
(`instances/<name>/<agent>/workspace`) sits inside the project, so the webui
*can* see it and the **host file browser keeps working** for it. The trade-off
also bites when the user picks a host source outside that agent's data
directory: sources outside the project are invisible to the webui, while sources
inside the project but outside the agent data directory are visible but blocked
by the host-scope safety clamp. In both cases, the host file browser is
unavailable for that workspace
(container-scope browsing still works while the agent runs; when it's down, the
tab shows a "start the agent to browse" empty state). Mounting the host root
into the webui (`- /:/host`) was considered and **rejected as too risky**
(whole host as root inside the container). There is no alternative right now;
we ship the trade-off and tell the user plainly in the UI.

## Terminology

- **Agent data directory**: the driver-owned persistent mount, such as
  `/root/.openclaw`, containing config, sessions, and the legacy workspace.
- **Host workspace source**: the host directory selected by the user and stored
  as `WORKSPACE_HOST`.
- **Container workspace path**: the absolute path selected inside the container
  and stored as `WORKSPACE_DIR`.
- **Workspace mount**: the `{ host, container }` pair above.
- **Effective workspace**: the container workspace path that the agent,
  terminal, and Workspace tab actually use.
- **Webui-visible**: the host source is under `HOST_WORKSPACE_ROOT`.
- **Host-browsable**: the host source is under this agent's data directory, so
  the existing host-scope clamp can safely reach it. This is stricter than
  webui-visible.

## Current behavior (verified 2026-08-08, post-plan-25)

- Compose emits exactly one volume: `HOST_WORKSPACE/instances/<name>/<agent>:<dataDir>`
  (`vm-manager.js` `generateInstanceCompose`, volume line at :180).
- The compose now also carries plan 25's per-instance build block: context
  `instances/<name>/build`, image `imageFor(name)` = `paddock-vm-<name>:latest`,
  and a `build.args:` block generated from the instance Dockerfile's ARG lines
  (`vm-manager.js:146-162`, via `instance-image.js` `argsFromDockerfile`). The
  workspace is **still not its own mount** — plan 25 touched build/image only.
- The workspace is `<dataDir>/workspace`, i.e. on the host it lands at
  `instances/<name>/<agent>/workspace` — a side effect of the data mount, not a
  deliberate workspace mount.
- `driver.workspaceDir` is static per driver (`/root/.openclaw/workspace`,
  `/opt/data`, `/root/.codex/workspace`, `/root/.opencode/workspace`,
  `/root/.picoclaw/workspace`). `driver.dataDir`/`workspaceDir` are unchanged by
  plan 25; what changed is `buildRel` → `templateDir` (the create-time copy
  source) and the removal of `buildImage`/`installDockerBuildArg`.
- `buildAgent()` (`agent-registry.js`) sets `workspace_root` = host agent dir
  (`instances/<name>/<agent>`, :197), `workspace_dir` = `driver.workspaceDir`
  (:200).
- Workspace tab (`AgentDetail.jsx` WorkspaceTab) assumes hostRoot
  (`workspace_root`) and containerRoot (`data_dir`) are the **same bind mount**
  and maps host↔container 1:1 by prefix.
- `workspace.js` host scope resolves every op against
  `resolveHostPath(agent.workspace_root, path)` — clamped to the agent dir.
- `createVm()` (`vm-manager.js:405`) creates `instances/<name>/<agent>`, seeds
  `instances/<name>/build/` from the shared template (plan 25), writes
  `meta.env` as a fresh file (:494), then `writeInstanceCompose` (:498), then
  builds/ups via `composeCommand` (`--env-file`, :504/:513). Clone mode copies
  the source agent dir **and** the source `build/` (:467-489).
- The current "Clone from backup" UI option restores an archive. It is not an
  agent clone and is deliberately out of scope for this workspace-mount plan.
- Every compose regeneration (create, settings, web publish, reset, **and plan
  25's `ensureInstanceBuilds` migration**, which reads the same meta and
  regenerates the compose at `vm-manager.js:642`) funnels through
  `generateInstanceCompose()`, so a meta-read inside it is sticky everywhere
  with no caller changes — the migration picks up a custom workspace mount for
  free.
- Settings flow (plan 25 state): GET returns
  `{ allowDocker, network, image, version, networkHealth }` where `image` comes
  from `vm.imageFor(name)` (`app.js:885`); POST persists the docker toggle in
  `instances/<name>/build/build.env` via `vm.setBuildEnv` (`app.js:978`) and
  only rebuilds when the image lacks the CLI. There is no `driver.buildImage`
  anywhere anymore.

## Design

### Create form (CreateAgent.jsx)

New **Workspace** card, always visible on the idle form, above the submit
button:

- Master toggle: **"Use a custom workspace folder"** — default **off** =
  current behavior (workspace stays `<dataDir>/workspace`, no extra mount).
  When on, two independent inputs appear:
  - **Host workspace source** — where the workspace lives on the host. Prefilled
    with the **current location** `instances/<full-pad-name>/<agent>/workspace`
    (the driver's data folder name, e.g. `openclaw`; server exposes
    `hostWorkspaceRoot` via `/api/config`). Editable.
  - **Container path** — where the Host path is mounted inside the container
    and where the agent works. It is independent from the Host path.
    - For **openclaw** and **picoclaw**, show the driver's `workspaceDir` as a
      read-only value: those CLIs require their workspace in that location.
    - For **opencode** and **codex**, prefill the driver's `workspaceDir` but
      keep the field editable. The user is responsible for selecting a path
      that their development workflow uses.
    - For **hermes**, hide the complete Workspace card.
  - Live validation hints under the fields (must be absolute / will resolve
    under the project, cannot be a system dir, etc.) mirroring server rules.
  - **Trade-off notice** shown when the toggle is on and the source is not
    host-browsable: "Custom workspace → the host file browser won't be
    available for this agent. Use the running container workspace instead."
- `handleSubmit` sends `workspace_host` + `workspace_dir` in the
  `POST /api/agents/create` body (empty strings when the toggle is off).
- Because the defaults are the current location, an agent created with the
  toggle on but untouched fields behaves **identically** to today — the extra
  mount is a shadow of the data mount's own `workspace` subfolder (same source
  and destination offset, harmless). The feature only changes behavior when
  the user edits either side.

> Decision: default **off** keeps every existing create-flow untouched. If we
> want it always-on later, flip the default — the plumbing is identical.

### Backend — create API (`app.js`)

- `GET /api/config` → add `hostWorkspaceRoot` (and `workspaceRoot`) so the form
  can prefill.
- **Driver workspace capabilities**:
  - **openclaw** and **picoclaw** use a fixed container workspace path. The
    Container path input is read-only at that driver's `workspaceDir`; users
    may still bind any valid Host path to it.
  - **opencode** and **codex** allow an editable Container path. Prefill the
    driver's `workspaceDir`, but accept a valid user-selected path as the
    effective workspace.
  - **hermes is excluded**. Its `dataDir === workspaceDir === /opt/data`, so a
    separate workspace bind would replace its complete persistent state, not
    just its workspace. Hide the Workspace card and reject workspace inputs.
- `POST /api/agents/create` → read `workspace_host` / `workspace_dir`; run them
  through `vm.validateWorkspaceMount(name, agent, workspaceHost, workspaceDir)`
  which **returns the normalized `{ host, container, webuiVisible,
  hostBrowsable }`** or throws;
  pass the normalized values to `createVm`. Meta stores the normalized values
  (never the raw input).
- Validation rules (server is authoritative; frontend hints mirror them):

  **Common**
  - Both-or-neither: host without container (or vice versa) → 400.
  - Trim; NUL/control chars rejected.
  - Normalize: collapse `//`, strip trailing `/`; reject `/` itself as a value.

  **`workspace_host`** (source = resolved by the host daemon)
  - Reject any `.`/`..` segment and embedded `:` (Windows-ish).
  - **Relative** (not starting with `/`) must start with `instances/` → resolved
    to `${HOST_WORKSPACE_ROOT}/<rel>` for storage. Anything else → reject
    ("must be absolute or start with instances/").
  - **Absolute** → kept as-is; compute `webuiVisible` from whether it starts
    with `${HOST_WORKSPACE_ROOT}/`, and `hostBrowsable` from whether it is
    under this agent's data directory.
  - Reject: the project root itself; `${HOST_WORKSPACE_ROOT}/src` and `/app`
    (webui code); system dirs (`/`, `/etc`, `/proc`, `/sys`, `/dev`, `/boot`,
    `/bin`, `/sbin`, `/usr`, `/lib`, `/home`, `/root`, `/opt`, `/tmp`,
    `/var/run`); any **other** agent's `instances/<other>/` prefix; the agent's
    **own** `instances/<name>` and `instances/<name>/<agent>` (the data mount
    source itself — would swallow it).
  - For webui-visible paths, resolve the nearest existing ancestor with
    `fs.realpath` before creating the missing suffix; the real path must stay
    under `HOST_WORKSPACE_ROOT` (blocks symlink escape while allowing a new
    workspace directory).
  - If the source already exists, it must be a directory. Validate existing
    sources before compose generation; never bind a file as a workspace.

  **`workspace_dir`** (container destination)
  - Must be absolute (starts with `/`); not `/`.
  - Reject only protected system paths and their descendants: `/etc`, `/proc`,
    `/sys`, `/dev`, `/var/run`, `/usr`, `/bin`, `/sbin`, `/lib`,
    `/boot`, and `/tmp`. Do **not** reject `/root` or `/opt`: every
    currently supported driver has its data directory below one of them.
  - Reject if it **equals `dataDir`** or is a **parent** of `dataDir` (would
    swallow the data mount).
  - A descendant of `dataDir` is allowed only if it equals the driver's
    `workspaceDir` or lies under it. Any other descendant (`…/config`,
    `…/sessions`, `…/agents`) is rejected because it shadows critical state.
  - A path outside `dataDir` is valid only for drivers with an editable
    Container path (**opencode** and **codex**). For fixed-path drivers
    (**openclaw** and **picoclaw**), reject any path other than that driver's
    `workspaceDir`.

  **hermes**: any non-empty workspace input → 400 ("hermes does not support a
  custom workspace — the data dir is the workspace").

### Compose generation (`vm-manager.js`)

- `generateInstanceCompose()` reads `meta.env` for `WORKSPACE_HOST` /
  `WORKSPACE_DIR` (it already receives `name`). When both present, emit a second
  volume line in the existing volumes block (`vm-manager.js:180`). The agent
  data folder's existing mount is **untouched** — only its `workspace`
  subfolder is additionally mapped by the user:
  ```yaml
  volumes:
    - <HOST_WORKSPACE>/instances/<name>/<agent>:<dataDir>   # unchanged (line 180)
    - <workspace_host>:<workspace_dir>                      # NEW: user-mapped workspace
    - /var/run/docker.sock:/var/run/docker.sock             # when allowDocker
  ```
  Default values: `<workspace_host>` = `<HOST_WORKSPACE_ROOT>/instances/<name>/
  <agent>/workspace`, `<workspace_dir>` = `<dataDir>/workspace` — the second
  mount is then a shadow of the first's own workspace subfolder (same content,
  harmless). Editing either side makes the workspace genuinely distinct.
  Because every regen path (settings, web publish, reset, update, **and plan
  25's `ensureInstanceBuilds` migration**) funnels through this function, the
  mount is **sticky** with zero caller changes. The plan-25 build block
  (`context`/`image`/`args`, `vm-manager.js:146-162`) is unrelated and stays as
  is — it already reads `meta` indirectly only via `name`. Serialize the compose
  structure with a YAML library, or safely quote every volume value.
  User-provided paths must not be interpolated as raw YAML.
- **Split-brain note**: the source is resolved by the real host's daemon →
  absolute source paths must use `HOST_WORKSPACE_ROOT` (host view), never the
  webui container's `/workspace` view. Relative host input resolves to
  `${HOST_WORKSPACE_ROOT}/...` exactly like the dataDir mount does today.
- `createVm(name, { workspaceHost, workspaceDir, ... })`:
  1. Validate (above) → normalized `{ host, container, webuiVisible,
     hostBrowsable }`.
  2. If `webuiVisible`: `fs.mkdirSync(host, { recursive: true })` **before**
     `writeInstanceCompose`. Otherwise skip mkdir because the webui cannot see
     that source; Docker creates a missing source directory on the real host.
  3. Persist `WORKSPACE_HOST=…` + `WORKSPACE_DIR=…` in `meta.env` **before**
     `writeInstanceCompose` so the compose picks it up. Today `createVm` writes
     `meta.env` as a fresh file at `vm-manager.js:494` and only calls
     `writeInstanceCompose` at :498 — fold the `WORKSPACE_*` lines into that
     initial `metaTxt` (or `setMetaFlag` right after the write) so they land
     before :498. Plan 25's `seedBuildDir` (:491) is unaffected.
  4. Apply the driver's workspace capability. Openclaw and picoclaw keep their
     fixed `workspaceDir`; opencode and codex are configured to use
     `WORKSPACE_DIR` as their effective workspace. Terminal startup and the
     Workspace tab consume that effective path; they do not invent a separate
     workspace. (Open question 3's verification — how opencode/codex are told
     their workspace — should reuse plan 25's per-instance `start.sh`/build-dir
     mechanism where possible.)
- `removeVm()`: when the agent has a `WORKSPACE_HOST` that lies **under
  `HOST_WORKSPACE`**, remove it too (never touch absolute paths outside the
  project). Existing behavior otherwise unchanged.

### Backup / restore and clone

These are explicitly **out of scope**. Do not change, invoke, or delete the
existing backup/restore implementation as part of this work. The current
"Clone from backup" create option is a restore flow, not an agent clone, and
must not seed or migrate a custom workspace. A later dedicated plan will replace
or remove that product flow after its intended behavior is decided.

The Workspace UI must state that an external workspace is not included in the
existing agent-data backup. This is an intentional current limitation, not a
reason to add an unfinished archive format to this feature.

### Agent payload / consumers

- `buildAgent()` (`agent-registry.js:136`) — read `WORKSPACE_HOST`/`WORKSPACE_DIR`
  from meta (today it hardcodes `workspace_root` = host agent dir at :197 and
  `workspace_dir` = `driver.workspaceDir` at :200):
  - present → `workspace_dir = <container>` (custom), new field
    `workspace_mount: { host, container, webuiVisible, hostBrowsable }`.
    `webuiVisible` means the source is under the project root;
    `hostBrowsable` means it is under `workspace_root`, the only source the
    current host-scope clamp can safely reach. `buildAgent()` recomputes both
    from normalized metadata.
  - absent → current values, `workspace_mount: null`.
  - `workspace_root` stays the host agent dir (unchanged semantics, DB column
    unchanged) — host-scope ops on the project stay exactly as today.
- **Host file browser availability depends on `hostBrowsable`** (mount under
  `workspace_root`), not on "has a mount" and not merely on being under the project root:
  - Default mount (`instances/<name>/<agent>/workspace`) is inside
    `workspace_root` → host browsing works unchanged (the existing clamp and
    prefix mapping already handle it).
  - A custom webui-visible path like `instances/<name>/shared-ws` (inside the
    project but OUTSIDE the agent dir) is webui-visible yet **unreachable** —
    every host op clamps back to `workspace_root`. It gets the same treatment
    as out-of-project (hide host scope).
  - An out-of-project host source cannot be read by the webui.
- Centralize host-scope authorization in `workspace.js`: every host operation
  (list, read/save, create/upload, rename/move/delete, and download) calls a
  single `requireHostBrowsable(agent)` guard before resolving a path. Do not
  rely on a guard only in the listing route.
- **WorkspaceTab (`AgentDetail.jsx`)** — behavior keyed on the mount:
  - No mount, or a mount with `hostBrowsable: true` → current two-scope tab,
    untouched.
  - Mount with `hostBrowsable: false` → the **Host scope button is hidden/
    disabled**, with a note: "Host file browser is not available for this
    agent — the workspace is mounted from a folder outside the agent folder."
    Container scope works as today (docker exec) while the agent runs. When
    the container is **down**, no browse is possible for the workspace: show
    an empty state — "Start the agent to browse its workspace" — instead of
    the current force-to-host fallback.

### Editing after creation (Settings tab)

- `GET /api/agents/:name/settings` adds `workspaceMount: { host, container } |
  null` (from meta `WORKSPACE_HOST` / `WORKSPACE_DIR`).
- `SettingsTab.jsx` gets a **Workspace** card mirroring the create form: a
  custom toggle + independent host/container inputs + the same trade-off notice.
  When custom is on, it shows the current mount for editing; when off, it shows
  the default (`<dataDir>/workspace`) and a way to enable a custom mount.
- `POST /api/agents/:name/settings` accepts `workspaceHost` / `workspaceDir`
  (empty string clears the override). When the workspace changes, the existing
  SSE job flow runs — stop → `vm.applySettings(name, { allowDocker, network,
  workspaceHost, workspaceDir })` → force-recreate → rollback on failure.
  `applySettings` sets/clears the `WORKSPACE_*` meta flags; the compose regen
  picks them up, so the mount swaps on the recreate. No image rebuild — a mount
  change is just a recreate (plan 25's docker-CLI rebuild logic is untouched and
  only triggers when the docker toggle changes and the image lacks the CLI).
  ⚠️ **Ordering**: `applySettings` today writes the compose FIRST, then meta
  flags (`vm-manager.js:257-259`; it also calls `seedBuildDir` first at :250).
  Because `generateInstanceCompose` reads `WORKSPACE_*` from meta, the flags
  must be written **before** `writeInstanceCompose` here (opposite of the
  DOCKER/NETWORK pattern) — see Open questions (5).
- **Data safety:** changing or clearing the mount does **not** move or delete
  files — the new folder starts empty and the old folder is left on disk
  untouched. The confirm dialog warns the user to move files themselves. (A
  "copy existing workspace" option is a possible follow-up — see Open
  questions.)
- Rollback behaves like the network path: regen the compose back, recreate if
  it was running.

### Terminal (nice-to-have)

- When a mount exists, start the tmux session with the shell in the custom
  container workspace (`tmux new-session … bash` then
  `tmux send-keys -t <session> "cd <containerPath>" Enter`), so the terminal
  opens in the agent's real work folder. No behavior change for unmounted
  agents.

### Housekeeping

- `.gitignore`: no change needed — the default workspace lives under
  `instances/*/<agent>/workspace`, already covered by the existing `instances/`
  ignore rules. (The earlier `<project>/workspaces/` idea is dropped — default
  host path is `instances/<name>/<agent>/workspace`.)
- Docs: update `docs/overview/business-logic.md` (create flow + workspace
  model), `docs/backend/services.md` (vm-manager), and the create-page section
  of `docs/pages/`.

## Files

- **Modified** `src/client/src/pages/CreateAgent.jsx` — Workspace card (toggle,
  independent host/container inputs, hints, submit fields).
- **Modified** `src/client/src/pages/AgentDetail.jsx` — WorkspaceTab: hide the
  Host scope + container-down empty state for out-of-project mounts.
- **Modified** `src/app.js` — `/api/config` (`hostWorkspaceRoot`; today it only
  returns `{ containerPrefix }` at :1594), create route
  validation + pass-through (:2344).
- **Modified** `src/app.js` — settings GET/POST carry the workspace mount
  (`workspaceMount` in GET, `workspaceHost`/`workspaceDir` in POST). Today the
  GET returns `{ allowDocker, network, image, version, networkHealth }` at :877
  and the POST at :938 uses the SSE job flow + `vm.applySettings`.
- **Modified** `src/services/vm-manager.js` — `validateWorkspaceMount()`,
  compose volume emission from meta with safe YAML serialization (volumes block
  at :180), `createVm`
  (mkdir only when webui-visible, meta flags before compose at :498, configure
  the effective workspace), `applySettings`
  (set/clear `WORKSPACE_*` flags — order per open question; today compose→meta
  at :257-259), `removeVm`
  workspace cleanup (today it also drops the per-instance image via
  `imageFor(name)` at :561 — keep that).
- **Unchanged** `src/services/instance-image.js` + `composeCommand` (plan 25) —
  the workspace mount lives in the compose `volumes:` block only; it does not
  touch build args, build.env, or the image tag. `seedBuildDir`/`buildDir`
  already exported from vm-manager stay as-is.
- **Modified** `src/services/agent-registry.js` — `workspace_mount` + custom
  `workspace_dir` in `buildAgent` (:136, reads `WORKSPACE_*` from meta at
  :197-200).
- **Modified** `src/services/workspace.js` — central host-scope guard for every
  operation when `workspace_mount.hostBrowsable` is false.
- **Modified** `src/client/src/pages/agent/SettingsTab.jsx` — Workspace card
  (toggle, independent host/container inputs, trade-off notice, confirm dialog).
- **Modified** `docs/…` — business-logic, services, create-page.

## Progress

- [ ] `/api/config` exposes `hostWorkspaceRoot`
- [ ] `vm.validateWorkspaceMount()` + create-route wiring
- [ ] `generateInstanceCompose` emits the extra volume from meta
- [ ] `createVm` mkdir (webui-visible only) + meta flags before compose +
      configure effective workspace; `removeVm` cleanup
- [ ] `buildAgent` → `workspace_mount` + custom `workspace_dir`
- [ ] Settings GET/POST carry the workspace mount; `applySettings` sets/clears
      `WORKSPACE_*` flags
- [ ] SettingsTab.jsx Workspace card (toggle, independent inputs, confirm dialog)
- [ ] Central `workspace.js` host-scope guard for all workspace operations
- [ ] CreateAgent.jsx Workspace card (independent fields, hints, trade-off notice)
- [ ] WorkspaceTab: hide Host scope + container-down empty state for custom
      mounts
- [ ] Terminal opens in the custom container workspace (nice-to-have)
- [ ] Unit tests: compose emits mount; validation accepts driver defaults and
      rejects protected/overlapping paths; every host-scope operation rejects
      non-host-browsable mounts
- [ ] Docs (+ `.gitignore` no-change note)
- [ ] Live regression (below)

## End-State Acceptance Tests

The feature is complete only when all of these outcomes are true:

- **No workspace mount:** creating every supported agent with the toggle off
  produces the existing single data-directory bind mount and preserves the
  existing two-scope Workspace tab behavior.
- **OpenClaw and PicoClaw:** enabling the mount accepts a custom Host path but
  shows a read-only Container path at the driver's `workspaceDir`. Docker
  mounts the selected Host path at that fixed destination; terminal and the CLI
  operate in that workspace.
- **Opencode and Codex:** enabling the mount accepts a custom Host path and an
  editable Container path. Docker mounts the selected source at that exact
  destination; terminal, Workspace tab, and the CLI use that selected path as
  their effective workspace.
- **Hermes:** the Workspace card is absent. Supplying either workspace API field
  is rejected with a clear 400 response and cannot modify `/opt/data`.
- **Path validation:** default paths under `/root` and `/opt` are accepted;
  protected paths, a data-directory parent/equal path, invalid fixed-driver
  destinations, symlink escapes, and existing file sources are rejected.
- **Host browser:** a host-browsable source supports every host operation
  (list, read, save, upload, create, rename, move, delete, download). A source
  outside the agent data directory hides Host scope; every host-operation API
  endpoint rejects it, while Container scope works when the agent is running.
- **Lifecycle:** create, settings changes, web publishing, update, reset,
  recreate, and plan 25's `ensureInstanceBuilds` migration preserve the
  configured mount. Changing or clearing a mount does not
  delete or migrate the old source directory.
- **Regression:** existing backup/restore and “Clone from backup” behavior are
  unchanged. The UI clearly says an external workspace is not part of the
  existing agent-data backup.
- **Browser:** verify the Create and Settings cards on desktop and mobile,
  including fixed versus editable Container path controls, validation messages,
  confirmation dialog, and SSE recreate flow.

## Verification

```bash
# unit
docker exec paddock node --test test/services.test.js

# live — create with a custom mount
# host = /www2/paddock/instances/pad-openclaw-ws1/openclaw/workspace  (in-project default)
# container = /root/.openclaw/workspace  (driver.workspaceDir)
docker inspect pad-openclaw-ws1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}'
#   expect BOTH the dataDir mount and the custom workspace mount
#   Source must be a HOST path (HOST_WORKSPACE_ROOT), never /workspace/…

# files shared both ways (default in-project mount)
#   host: touch /www2/paddock/instances/pad-openclaw-ws1/openclaw/workspace/hello.txt
#   container: docker exec pad-openclaw-ws1 ls /root/.openclaw/workspace/hello.txt
#   container: docker exec pad-openclaw-ws1 sh -c 'echo hi > /root/.openclaw/workspace/from-container.txt'
#   host: ls /www2/paddock/instances/pad-openclaw-ws1/openclaw/workspace/from-container.txt

# workspace tab, custom mount OUTSIDE workspace_root: host scope button hidden +
#   "not available" note; container scope browses the workspace while running;
#   container down → empty state "start the agent", never a broken host read
# settings regen keeps the mount (flip docker toggle / network → inspect again)
# settings edit: change host+container path → SSE job recreates, docker inspect
#   shows the NEW mount, old folder untouched on disk; toggle off → mount gone
# web publish keeps the mount (plan 23 flow → inspect)
# delete removes the workspace dir (only when under the project)
# agents WITHOUT the toggle keep the exact old compose (single mount) and the
#   full two-scope workspace tab
# hermes: Workspace card hidden, API rejects any workspace input

curl http://10.69.1.164:6789/api/config   # now includes hostWorkspaceRoot
```

## Open questions

1. **hermes**: excluded from the feature (its workspace IS the data dir). If
   we later want a workspace remap for hermes, it means shadowing `/opt/data`
   itself — decide then whether that's wanted.
2. **Keep host browsing or not?** Open debate: host browsing stays the default
   and is cheap to disable later (hide the Host scope button for all agents).
   Current plan keeps it for no-mount + host-browsable mounts; if we decide to drop
   it entirely, delete the route guard too. Recommend: keep it — easier to
   disable later than to rebuild.
3. **Opencode/Codex implementation detail**: verify the current supported way
   to make their editable Container path the effective workspace before coding.
   Plan 25 made the per-instance `start.sh` the natural place for this (each PAD
   owns its build dir), but whether the CLI itself can work from an arbitrary
   path still needs checking. If either CLI cannot support it, change that
   driver to a fixed-path capability rather than creating a mount the CLI
   ignores.
4. **Always-on vs toggle**: plan ships the section with the toggle defaulting
   **off** (no behavior change). If the user wants every new agent to get a
   separate workspace mount by default, flip the default and set both fields'
   prefills accordingly — plumbing identical.
5. **`applySettings` ordering**: because `generateInstanceCompose` will read
   `WORKSPACE_*` from meta, the flags must be written BEFORE `writeInstanceCompose`
   in `applySettings` (today the compose is written first, then meta —
   `vm-manager.js:257-259`, opposite order from DOCKER/NETWORK; `seedBuildDir`
   runs first at :250). Decide whether
   to always set workspace flags before writing compose, or to pass
   `workspaceHost/workspaceDir` as explicit opts through the whole regen chain.
   Note the same ordering holds in the plan-25 `ensureInstanceBuilds` migration
   (`vm-manager.js:642`) and `applyWebServices` (:317) if they ever need to
   re-emit the mount — a meta-read inside `generateInstanceCompose` covers all
   three with no per-caller code.
6. **Editing after creation — file migration**: changing the mount (new path,
   different container name, or toggling off) leaves old files untouched by
   default (user moves them). A "copy existing workspace into the new folder"
   checkbox in the settings confirm dialog is a possible follow-up — decide
   whether it's wanted.
