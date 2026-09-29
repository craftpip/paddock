# Backend Services

> Last updated: 2026-09-29

## PAD Discovery (agent-registry.js)

Business logic: See `overview/business-logic.md` — PAD Discovery and State.

**Functions:**
- `discoverAgents()` — full scan: instances/ + docker ps + merge + SQLite sync
- `getAgent(name)` — single agent by name (reads docker cache, filesystem)
- `getAgentById(id)` — try name first, then SQLite id lookup
- `dockerPsList(force)` — cached docker ps -a (3s TTL). Returns `{ name: state }` map
- `getAgentStats()` — SQLite query: total, running, exited, unknown
- `recordActivity(agentId, category, action, status, details)` — INSERT into activity_events, update agent's last_activity_at
- `getActivity(agentId, limit)` — SELECT * from activity_events, ordered by timestamp DESC
- `buildAgent(vmName, dockerState)` — construct agent object from filesystem metadata + docker state

**Agent object shape:**
```
{ id, name, display_name, agent_type, runtime_type, runtime_ref,
  status, workspace_root, config_root, default_model, default_provider,
  tags, created_at, updated_at, last_activity_at }
```

**Regular expression for valid names:**
```
^&lt;PREFIX&gt;-[a-zA-Z0-9][a-zA-Z0-9_-]*$
```

## Workspace (workspace.js)

Business logic: See `overview/business-logic.md` — Workspace File Browser.

**The host-browsing gate (plan 64).** `workspace.writeFile` (and every other write
here) may only touch a path the pad is allowed to browse, and that is TWO
independent questions — a `hostBrowsable` CAPABILITY and a per-pad PERMISSION:

- **Capability** — can the webui see that folder on the host at all? A workspace
  that lives inside the project root does, as does the agent's own data dir
  (`insideDataDir`); one mounted from outside (`/www1`) does not.
- **Permission** — `HOST_BROWSE=1` in that pad's `meta.env`, and **only** for a
  mount that is also inside the project root. Granting the flag cannot buy access
  to a mount the capability says is invisible.

`workspaceMountInfo()` reports both as `hostBrowsable` plus a
`hostBrowseReason` sentence, so a refusal is always explainable, and
`settings_get` surfaces it. As of 2026-09-29 exactly one pad is opted in
(`pad-opencode-paddock-dev`, the paddock repo); every other pad refuses. The
MCP surface deliberately has **no browse tool** — `workspace_list` /
`workspace_read` were retired in plan 64 — because listing a whole tree into a
model's context is a large, usually unwanted read; `exec` on a running pad and
`workspace_write` are the routes. `plans.js` re-uses this same gate for plan
reads and writes rather than re-deriving it.

All functions take `(agentId, relativePath)` and internally:
1. Look up agent by ID via `getAgent()`
2. Resolve path via `resolveSafePath()` (canonicalize + traversal check)
3. Perform the filesystem operation

**Exported functions:** `listDir`, `readFile`, `writeFile`, `statFile`, `createFolder`, `renameEntry`, `deleteEntry`, `moveEntry`, `getBreadcrumbs`, `isPreviewable`, `getMimeType`, `resolveSafePath`

**Max upload size:** 100MB (via `MAX_UPLOAD_SIZE`)

**Legacy functions (kept for compat):** `listParentDir`, `readParentFile`, `downloadParentFile`, `writeParentFile` — these allow browsing above workspace root. Only used by old EJS routes; the React SPA no longer uses them.

## Plans (services/plans.js) — plan 64

A **plan** is one markdown file per piece of work, in that PAD's workspace under
`plans/`. It is the durable record: a conversation scrolls, is scoped to one
agent, and ends; a plan does not. Finished plans move to `plans/archive/` — that
is a human decision (move the file), not a field the tools flip.

**Location is per-PAD, so `agent` is REQUIRED on every plan tool.** Three pads
routinely share one workspace (`paddock`, `schlorp` and `craftpip` all ran on
`pad-opencode-proj`), and `/www2/paddock/plans` on one of them sits *outside*
that pad's workspace root, where traversal is refused. A tool that inferred the
root would write into somebody else's project.

**Frontmatter is machine-managed; the body is the caller's.** `plans.js` never
rewrites prose. The stamps each follow one rule, because a wrong stamp is a wrong
answer later:

| Field | Rule |
| --- | --- |
| `created` | set once on first write, never moved |
| `started` | set once, when the plan first binds a session |
| `session` | the session given now; a re-bind keeps `started` |
| `last_activity` | bumped on every write — this is what makes the listing answer "what is being worked on *right now*" |
| `done` | the human's to set |

Derived on read: `ageMs`, `idleMs`, `elapsedMs`, plus `title` and `status`
from the file's own first heading and `## Status:` line — the convention this
repo already uses. A plan with an unparseable frontmatter is still listed, with
`unreadable` on the row: the body is the durable record, so a broken header must
not hide the file.

**Writes go through the workspace service, never a private write.**
`writePlan` calls `workspace.createDirectories()` and `workspace.writeFile()`,
so it inherits the same path clamp and the same host-browsability gate as every
other write. `plansRoot()` re-checks that gate itself, because the *read* paths
need it too. `plans/README.md` (harness guidance) is created on the first plan
and excluded from the listing — a row with no `created` and no `## Status:` reads
as a plan nobody wrote.

**`withSessionState` stamps the conversation behind each plan** using the Mission
service, not a second probe. `mission` owns `live`/`open`/`busy`/`busyKnown`;
re-deriving any of them here would be a second source of truth written before the
field existed, and the busy probe is scoped to (PAD, folder), so a stamp computed
from the plan's folder rather than the session's project would answer about the
wrong conversation. A plan whose session has no Mission row is `sessionTracked:
false` with `sessionLive: null` — **unknown, not dead**: the conversation may
have been started outside the page. All four fields are always present, because a
missing field and a null one are different to a caller.

## Activity store (services/agent-store.js) — plan 64 §4

Reads one agent conversation out of that agent's **own** store, on the host. Per
driver:

| Driver | Store | Read |
| --- | --- | --- |
| opencode | `data/opencode/opencode.db` (sqlite) | `session` + `message` + `part` |
| codex | `codex/sessions/**/*.jsonl` (rollout) | `session_meta` / `turn_context` / `event_msg` / `response_item` |
| claude | `claude/projects/**/*.jsonl` | `type: user|assistant`, `message.content` parts |

The **first path segment is the per-PAD data dir name** (compose mounts
`<instance>/codex` at `/root/.codex`), so a codex rollout is at
`<workspace_root>/codex/sessions`. Reading `<workspace_root>/sessions` is a
`no-store` on every codex pad ever created — a tool that is right about opencode
and wrong about the other two is the worst kind of wrong.

**Why the queries look the way they do** (measured on a real 731-message
session, not reasoned about): `part` has an index on `session_id` *alone*, so
`order by time_created` over parts is a full sort — 10–21 ms per query. A
bounded window over *messages* does not reach the user either, because each
assistant **step** is its own message: the newest 12 messages were 12 assistant
steps and `lastMessage.user` came back null on a session that plainly had one.
The role is therefore part of the **query**, and the result is one pass answering
all three questions in ~2 ms. Both `lastMessage.user` and `lastToolCall` walk a
bounded window of *older* messages of the same role, because the newest message
of a role is often a step with nothing in it — the in-flight step, or a step that
only says something.

**A stopped pad still answers.** The store lives in the agent data dir on the
host, so the read never touches the container: `padRunning` (the container
state) and `store.available` (could we read it) are different questions, and a
failure is reported, never smoothed into "no activity". `store.reason` separates
`no-store` (no such store / empty folder), `empty-store` (the file exists with
no schema — a pad that has never run its agent), `unreadable` (there and did not
open) and `session-not-found` (the store *has* transcripts, none of them this
one, and `store.candidates` then names them). For the JSONL stores a session is
matched by its **file name**; a store holding exactly one file is answered from
it and says `matched: "only-file"`, which is a guess, so prefer the id the
agent's own history printed.

For codex, the human's turn is read from `event_msg` → `user_message`, **not**
from the `role: user` response items: those carry injected context and
environment blocks, so the "last user message" from them is the machine talking
to itself. A call with no result row behind it is `running`, not `completed` —
the quiet lie is the one that says a live tool call is done. That applies to
**claude as well as codex**: a claude transcript records the assistant's
`tool_use` in one row and the `tool_result` in a *later* user message, so an
unanswered `tool_use` is in flight, and `readClaude` used to stamp every one of
them `completed`. Nothing caught it because `pad-test-claude` has no real store
to read.

**The cost is per driver, and it is stated at the caller for that reason.**
opencode is one indexed query (~2 ms measured); codex and claude parse that one
conversation's rollout file, so the cost grows with the transcript's length.
"Never a scan" was true of the first and false of the other two — which rules in
polling one live session at 5 s and rules out looping the tool over every id.

**There is deliberately no `lines` / scrollback input.** A screen tail is a
different question from a store read, so honouring it would put two sources with
**different availability** in one tool: `lines` needs a live tmux pane and is gone
with the container, which is the one property that makes this tool worth having,
and the text carries no roles and no per-item timestamps. A caller that wants the
screen has `mission_sessions` (screen tail, live-only) and `exec`.

**Redaction happens where the read leaves the process** (`redactSecrets` over the
whole payload at once, so no field carrying a value is missed). The boundary is
deliberate, confirmed, and stated in the tool description: secret-*shaped*
configuration — any `api_key`/`token`/`password`/`*-key` field, any `headers`
map, and config/env lines carrying such a value — is scrubbed wherever it
appears, including inside dumped config text; free **prose** is not
pattern-matched, so a key pasted into a sentence comes back as written. The
asymmetry is the point: a mangled sentence is a *wrong answer* that corrupts
every future message mentioning anything key-shaped with no way for the caller
to notice, while the unscrubbed case is bounded — the transcript belongs to the
very key that may read it — and warned about where it is returned. It is
**MCP-only in effect**: `config_get` opts in with `{redact:true}` at its single
call site (the REST route round-trips `configRaw` back into the user's real
config, so redacting there would write `[REDACTED]` over a working key), and
`readActivity` has exactly one caller, the `plan_activity` tool.

## Path Probe (path-probe.js)

Read-only host-path probes backing the Create Agent workspace-source field
(plan 40). "Exists in the container" ≈ "valid host source for the daemon"
thanks to the one-to-one mount rule — a project folder mounted into paddock at
the same path it has on the host is identical in both namespaces. Business
logic: See `overview/business-logic.md` — Workspace as Project.

**Exports:**
- `probe(hostPath)` — `{ path, exists, isDir, writable, forbidden, compose }`;
  `writable` via `fs.accessSync(W_OK)`, `compose` is the found
  `docker-compose.yml`/`compose.yml` mapped to its host path (null when absent).
- `autocomplete(q)` — the subdirectories of the deepest existing ancestor of
  `q`, hidden-filtered (dot-dirs, system dirs, `/app`/`/workspace`) and mapped
  back to host paths; the client applies prefix filtering.
- `discoverVolumes(hostPath)` — the volume-inheritance model (below).
- `containerPathOf(hostPath)` / `hostPathOf(containerPath)` — the one-to-one
  mapping; only the paddock root (`HOST_WORKSPACE_ROOT` ↔ `WORKSPACE_ROOT`)
  changes, everything else is identity.
- `isForbidden(p)` / `isDangerousSource(src)` — the system-dir + own-mount
  blocklists; `isDangerousSource` additionally rejects `/var/run/docker.sock`
  (D6 — never inherited into an agent container).
- `findComposeFile(dir)` — first of `docker-compose.yml`/`.yaml`,
  `compose.yml`/`.yaml` present in the dir.

**Routes (app.js, read-only GETs, no CSRF):** `GET /api/paths/probe?path=…`,
`GET /api/paths/autocomplete?q=…`, `GET /api/paths/volumes?path=…`.

### discoverVolumes — the model

Compose file first, container supplement second (D2):

1. Run `docker compose --project-directory &lt;dir&gt; -f &lt;compose&gt; config --format
   json` inside paddock (the compose CLI lives there) — never hand-rolled YAML,
   so `${VAR}`, `.env`, `extends`, and override files resolve exactly like the
   real deploy. Parse errors are surfaced in the response `errors` array, not
   thrown.
2. Supplement: `docker ps -a --filter label=com.docker.compose.project=&lt;name&gt;`
   then `docker inspect` each container's `Mounts`; mounts not already covered
   by the compose file are added with `origin: 'container'`. Works for stopped
   containers (mounts are stored config). The project label comes from the
   compose `name`, falling back to the **host** directory name when the
   container view differs — the paddock root maps to `workspace` and would
   otherwise collide with any other project named `workspace`.

Each row is normalized `{ type: 'bind'|'volume', source, target, readonly,
service, origin: 'compose'|'container' }` — deduped (binds by source+target,
named volumes by target). Bind sources are mapped back to host paths. **Dev-
environment rule:** binds pre-fill **one-to-one** — `target` is set to the
host source path, so the agent container sees the same filesystem layout as
the host; the compose's own container destination is ignored for binds (rows
29→24 on `/www1/agents` when this landed — the remapped duplicates collapsed).
Named volumes keep their compose destination and are annotated with `external`
(the full Docker volume name: `&lt;project&gt;_&lt;name&gt;` for file volumes, the
volume's own name for container volumes) and `exists` (whether `docker volume
inspect` finds it now) — so the form can distinguish "attach the project's
real data" from "create a fresh volume".

D6 filters apply everywhere: `/var/run/docker.sock`, anonymous volumes, and
`tmpfs` mounts are dropped; system-dir sources are never inherited. The raw
compose file is never served — the endpoint returns the volume list only
(compose files can contain secrets).

**Returns:** `{ path, project, compose, source, volumes, errors }`.

## Dev Container (devcontainer.js)

Plan 41 — Development Container Specification support. A workspace's
`.devcontainer/devcontainer.json` (per the spec's file precedence) is the
portable, version-controllable mirror of a pad: its lifecycle commands,
workspace folder, environment, mounts, run args, ports, and user.

**Exports:**
- `readDevContainer(containerPath)` — finds + parses the devcontainer.json
  following spec file precedence, returns the parsed fields (name,
  postCreateCommand, onCreateCommand, updateContentCommand, postStartCommand,
  postAttachCommand, workspaceFolder, forwardPorts, image, hasBuild,
  remoteUser, containerUser, preferredUserMode, filePath, generated)
- `writeDevContainer(filePath, fields)` — writes a generated or synced
  devcontainer.json back to the workspace

The Create Agent form reads the devcontainer via `GET /api/paths/devcontainer`
to pre-fill the post-create command box. The Settings tab's Dev Container card
(`GET /api/agents/:name/devcontainer`) shows the file path, state badge, and
both sides of the diff (current file vs what Paddock would write now). Sync
and Regenerate are available from the UI — Sync writes 1:1 mapped fields in
place (project-authored fields survive), Regenerate rewrites the whole file as
a generated mirror (`x-paddock.generated`).

## VM Manager (vm-manager.js)

Business logic: See `overview/business-logic.md` — Agent Lifecycle, Bind-Mount Split-Brain.

Per-instance build model: every PAD owns its build files (`instances/&lt;name&gt;/build/`)
and its own image tag (`paddock-vm-&lt;name&gt;:latest`). See
`services/instance-image.js` below.

**Functions:**
- `createVm(name, { agent, mode, skipSetup, workspaceHost, workspaceDir, allowDocker, network, sshEnabled, port, sshCport, password, extraVolumes, extraPorts, userMode, onLog, onStep })` — full streaming creation flow with SSH host/container port allocation. Emits steps via `onStep('build'|'up'|'setup', 'start'|'end'|'error')` and feeds command output through `onLog(stream, text)`. Seeds the instance build dir from the shared template (`seedBuildDir`). `mode: 'fresh'` only — clone-from-backup was removed with the generic backup system. `userMode: 'user'` (plan 43 Phase 7) writes `USER_MODE=user` to `meta.env` and runs the setup steps as `-u &lt;USER_UID&gt;:&lt;USER_GID&gt;` so config files are born user-owned.
- `validateAgentCreate(name, opts)` — the shared create **pre-flight**: name/agent-type, network peer exists+running, extra volumes/ports, SSH container port, workspace mount, and the async cross-agent host-port sweep all abort (throw) before anything is created. Rejects `userMode: 'user'` for hermes (already runs as its own user). Returns `{ sshHostPort, sshCport, wsMount }` normalized for `createVm`.
- `createAgent(name, opts)` — `validateAgentCreate` then `createVm` (mode `fresh`, port/sshCport/workspace normalized). The single create path behind both `POST /api/agents/create` and the MCP `create_agent` tool.
- `removeInstanceDir(name, instDir)` — a plain `fs.rmSync(instDir, { recursive:
  true, force: true })`. No helper container and no `EACCES` handling: the
  webui runs as root (plan 43), so it can always delete root-owned agent data.
  Used by `removeVm` (delete), `resetVm`, `recreateAgent` and the
  `applyAgentChanges` reset — every wipe of the instance/agent data dir.
- `removeVm(name)` — `docker rm -f` the agent **and** its door (`&lt;name&gt;-door`/`&lt;name&gt;-web`), remove the compose network (`&lt;name&gt;_default`), delete the instance dir via `removeInstanceDir(name, instDir)`. Delete also runs `docker rmi paddock-vm-&lt;name&gt;:latest` then `pruneDanglingImages`.
- `pruneDanglingImages(onLog)` — `docker image prune -f` (dangling `&lt;none&gt;` layers only, never images a container references). Runs at the end of create, rebuild (`updateAgent`/`recreateAgent`) and delete to reclaim the layers each `docker compose build` orphans when it retags the per-PAD image; reports reclaimed space via `onLog`, never throws.
- `resetVm(name)` — remove container + wipe data + recreate + compose up; the compose regen reads the full persisted binding set from `meta.env`/`web.json` (docker, network, web, extra volumes/ports, workspace) so a reset never drops a bind
- `startAgent(name)` / `stopAgent(name)` / `restartAgent(name)` — docker lifecycle; also start/stop the socat door with the agent (`startDoors`/`stopDoors`)
 - `buildInstanceCompose(name, agent, password, port, opts)` — the pure compose **model** (a structured JS object, never hand-concatenated YAML). `allowDocker` adds the `/var/run/docker.sock` volume, `network` adds `network_mode: container:<name>`, `extraPorts`/`webService`/`sshCport` produce `ports:` bindings (or door mappings in peer mode), `workspaceHost`/`workspaceDir` add a second volume line. Named-volume rows (plan 40 D5) emit their service mount **and** a top-level `volumes:` section — `external: true` when the volume already exists, a fresh-volume declaration otherwise (so never-started projects work on first up). Builds from `instances/<name>/build` with `image: paddock-vm-<name>:latest`; the `build.args:` block is generated from the instance Dockerfile's `ARG` lines (values interpolated from the instance `build.env`).
 - `usesProjectDefaultNetwork(services)` — true when a service in the model has **no** `network_mode`, i.e. it joins the project `default` network. A peer-networked pad's service shares the peer's namespace and its door rides the peer's own network, so nothing joins `default` and it must not reserve a `/24`.
 - `generateInstanceCompose(...)` — read-only preview: serializes the model with `JSON.stringify(..., null, 2)` (JSON is valid YAML) and, when `usesProjectDefaultNetwork` and the pad has a persisted `SUBNET`, merges `networks.default` with that explicit subnet alongside any door `webbridge` network. It never reserves or releases anything.
 - `writeInstanceCompose(name, agent, password, port, opts)` — resolves the subnet for the services that were just built, then writes the file. Default-network pad → `ensurePadSubnet(name)` (carve / re-pick / keep) and declare it; peer pad → `releasePadSubnet(name)` and declare no `default` network at all. Never both.
 - `writeInstanceCompose(name, agent, password, port, opts)` — write the serialized compose to disk. Calls `ensurePadSubnet(name)` first so a never-started pad is assigned its fixed `/24` (persisted as meta `SUBNET`) before the generator reads it.
 - **Pad subnet pool** — the host daemon's `default-address-pools` are finite (`192.168.0.0/16` at `/20`, plus the stock `172.16.0.0/12`). When every slot is taken, `docker compose up` for a new pad dies with `all predefined address pools have been fully subnetted` — the subnet is unspecified, so the daemon tries to allocate from the pool. New pads sidestep the pools: `ensurePadSubnet` carves the lowest free `/24` from `10.200.0.0/16` (256 pads; disjoint from the pools and the office LAN), persists it as meta `SUBNET`, and the generated compose declares it. **Only a pad with a service on the project `default` network gets a reservation** — a peer-networked pad reserves nothing, because such a reservation collides the moment that pad is switched to the default network (`Pool overlaps with other one on this address space`).
   - **A reservation is not a network.** `claimedPadSubnetOctets(name)` unions live Docker networks (`usedPadSubnetOctets`) with every *other* pad's meta `SUBNET` (`reservedPadSubnetOctets`, hidden/quarantine dirs excluded), and `pickFreePadSubnet` only hands out an octet in neither. A reservation with no network behind it is still a claim — that is what stops two pads being handed the same `/24` and one of them failing at `docker compose up`.
   - **A live network wins.** When `<name>_default` already exists, `ensurePadSubnet` returns empty and the compose stays subnet-less, so a regen can never force a disruptive network recreate (this is also how a pad that already carries a legacy compose-pool network keeps it).
   - **`ensurePadSubnet` validates a persisted `SUBNET`** against both sources and re-picks a free octet when the value is claimed by another pad or disagrees with a live `<name>_default`; it still throws on genuine pool exhaustion. `releasePadSubnet(name)` drops a reservation only when **no** live `<name>_default` network holds it, so a peer pad whose network still exists keeps the claim and the two can never diverge.
   - Deleting a pad (`removeVm`) removes `<name>_default` and frees its `/24`.
 - `cleanStaleDoorDirs({ isRegisteredAgent })` — boot sweep for legacy `<pad>-door` / `<pad>-web` **instance directories** left over from when the socat door was a real PAD. A candidate must match `^<existing-pad>-(door|web)$`, have no `AGENT=` in `meta.env`, no agent data dir, no registered-agent row, and either no container at all or only the managed socat door container. Matches are **moved** to `instances/.stale-door-dirs/<name>` (frees the `/24` and the name, stays reversible); the live door container is never removed. The SQLite `agents` table is not authoritative for the veto — pass the disk-derived registry list, or a deleted pad's stale row will protect its own leftover dir forever.
 - `applySettings(name, { allowDocker, userMode, network, sshPort, sshCport, workspaceHost, workspaceDir, extraVolumes, extraPorts, password })` — regenerates compose + writes the changed `meta.env` keys (`DOCKER`, `USER_MODE`, `NETWORK`, `PORT`, `SSH_CPORT`, `ROOT_PASSWORD`, `WORKSPACE_*`, `EXTRA_PORTS`, `EXTRA_VOLUMES`, `SUBNET`); returns the new state. **Async** — reads the active `web.json` binding itself and regenerates with `webService` + the resolved `webPeerNetwork` for the new network, so a network/docker-toggle change never drops a published web app.
- `applyAgentChanges(name, opts, { onLog, onStep })` — the **consolidated mutation flow**: settings POST, web/ports POST, and the MCP `recreate` tool all funnel through it (stop → regen → reconcile door → up → boot hooks → verify → rollback on failure). Detects `userModeChanged` (via `prepareAgentChanges`); switching an existing pad to user mode triggers `ensureUserModeBuildFiles` + an image rebuild when `imageHasPadUser` reports the current image lacks the pad user, then the normal recreate. Summary line reports `containerUser=&lt;mode&gt;`, reason `'user'`.
- `updateAgent(name, { onLog, onStep })` — streams `docker compose --env-file &lt;instance&gt;/build/build.env -f &lt;compose&gt; build --pull &lt;name&gt;` (900s) then `up -d --no-deps --force-recreate &lt;name&gt;` (300s); steps `build`/`recreate`/`cleanup`. No forced build args — the image is per-PAD, so the rebuild reads the instance Dockerfile + `build.env` directly. `applyAgentChanges` then runs an existing post-create script after every recreation.
- `readSettings(name)` — the full settings + published-web + ports picture shared by `GET /api/agents/:name/settings` and the MCP `settings_get` tool (`{ allowDocker, userMode, network, sshPort, sshContainerPort, image, version, networkHealth, workspaceMount, extraVolumes, extraPorts, web }`). `userMode` is `'user'` or `'root'` from meta `USER_MODE`.
- `containerInfo(name)` — live `docker inspect` detail for the Container Info popup (mounts, published ports, env keys, raw JSON)
- `readWebService(name)` / `webServicePath(name)` — read/`web.json` path (per-agent published web binding `{ containerPort, hostPort }`; null when absent)
- `applyWebServices(name, webService)` — **async**. Set (truthy) or clear (`null`) the published web app: writes `web.json`, regenerates the compose with the `ports:` binding — or the socat door service when the agent routes through a network peer (see `tabs/web.md`). Returns `{ agent, webService }`. Does NOT stop/recreate — the route does that as an SSE job.
- `doorName(name)` — `&lt;name&gt;-door`, the socat door container name; `doorNameRe(name)` matches both `&lt;name&gt;-door` and the legacy `&lt;name&gt;-web`. `startDoors(name)`/`stopDoors(name)` start/stop it with the agent; `cleanOrphanDoors()` sweeps `&lt;x&gt;-door`/`&lt;x&gt;-web` containers whose agent is gone (runs at boot)
- `webHookPath(name, agent)` / `writeWebStartHook` / `removeWebStartHook` — the
  per-instance boot hook at `&lt;dataDir&gt;/start-web.sh`, executed with `bash` by
  the image `start.sh` so its port-guard cannot exit the parent start script.
  `buildWebHook` starts web servers through `tee`: output remains in
  `&lt;dataDir&gt;/web.log` and is also written to `/proc/1/fd/1` for `docker logs`
  and the Logs tab.
- `getNetworkHealth(name)` — resolves the compose `network_mode: container:&lt;peer&gt;` against live docker state → `none` / `ok` / `stale` (peer recreated, recorded ID dead) / `peer-stopped`
- `validateWorkspaceMount(name, agent, host, dir)` — the single authority for custom workspace binds (plan 24); returns `{ host, container, webuiVisible, hostBrowsable }` or throws
- `autoSshPort()` — next free host port starting at 43817 (scans web/extra/ssh host ports)
- `readSshCport(name)` — persisted SSH container port (meta `SSH_CPORT`, default `22`); `ensureSshStartBlock(name)` — backfills the `SSH_PORT` block into an old instance's own `build/start.sh` (idempotent)
- `readExtraPorts(name)` / `readExtraVolumes(name)` / `validateExtraPorts(...)` / `validateExtraVolumes(...)` — extra TCP port + volume management (plan 28). Extra volumes are `{ host, container, readonly }` binds or `{ type: 'volume', name, container, readonly, external }` named-volume entries (plan 40 D5)
- `setMetaFlag(name, key, value)` — writes/clears a `KEY=VALUE` line in `meta.env` preserving other lines (empty value **removes** the line)
- `seedBuildDir(name, agent, { installDocker })` — idempotently copies `src/vm-builds/&lt;type&gt;/` → `instances/&lt;name&gt;/build/`, seeds `extras/.gitkeep` + `build.env`; never overwrites existing build files
- `ensureUserModeBuildFiles(name, agent)` / `imageHasPadUser(name, image, wasRunning)` — the existing-pad user-mode upgrade (plan 43 Phase 7). `imageHasPadUser` runs `docker run --rm --entrypoint &lt;sh&gt; &lt;image&gt; -c 'id -u pad'` (via `id -u pad` inside the image) to tell whether the pad-user build files are baked in. When they are not, `ensureUserModeBuildFiles` (a) regenerates the instance `build/start.sh` **from the shared template** when the `__PAD_USER_MODE__` marker is missing (start.sh is machine-managed, so it is safe to overwrite) and (b) injects the universal pad-user block (`PAD_USER_DOCKERFILE_BLOCK` — `groupadd`/`useradd` + `chmod 755 /root` + a **`sudo` self-install guard** (`apt-get install sudo` / `apk add sudo` when missing) + `ALL ALL=(ALL) NOPASSWD:ALL` sudoers, covering both apt and apk images) into the instance Dockerfile before the `COPY start.sh`/`ENTRYPOINT` line. The block is machine-managed: a **stale pre-existing block is replaced with the canonical one** (so rule/installer upgrades propagate), never the whole file clobbered — the rest of the Dockerfile stays the user's editable surface (plan 41). The `ALL ALL=` (username-independent) form matters because base images ship their own uid-1000 account (`node` in node:20-slim) that wins `sudo`'s uid→name lookup; the self-install matters because toggled pads build from their ORIGINAL (pre-sudo) package list. Callers must rebuild the image after.
- `imageProbe(name, image, wasRunning, script)` — the shared capability probe behind `imageHasDockerCli`, `imageHasSshPortSupport`, `imageHasWebStartSupport`, `imageHasPostStartHook` and `imageHasPadUser`. It answers "does the current image already have this?" by running `script` in a **throwaway container** (`docker run --rm --entrypoint sh <image> -lc <script>`), and only `docker exec`s into the live PAD when `wasRunning` **and** `isContainerRunning(name)` both hold. That liveness re-check is load-bearing: `wasRunning` is a cached status that can be stale, and an `exec` into a container that has since stopped throws — which read as "the image lacks this", made every pad look like it needed a rebuild, and turned unrelated settings toggles into multi-minute image builds. A probe reports capability by exit status, never by a `code` field, and returns `false` (never throws) when neither path can answer. `imageHasWebStartSupport`/`imageHasPostStartHook` are why a web-publish toggle no longer rebuilds: every `src/vm-builds/*/start.sh` bakes in the web start hook, so the answer is already yes.
- `composeCommand(name, ...args)` — `docker compose --env-file &lt;instance&gt;/build/build.env -f &lt;compose&gt; ...` prefix used by every per-instance compose invocation (skips the env-file when the build dir is missing)
- `validateInstanceCompose(name)` — pre-flight gate: runs `docker compose ... config --quiet` (parse + schema + interpolation, no side effects) and throws with the parser output on failure. Call **before** stopping/recreating a PAD so a malformed document aborts with the container still running.
- `runCompose(name, args, opts)` — validates via `validateInstanceCompose` then runs the compose `build`/`up` command. Every per-instance compose action goes through it (or an explicit early `validateInstanceCompose` in the settings/ports/web/recreate routes), so a bad document never reaches `docker compose up`.
- `ensureInstanceBuilds()` — one-time migration: seeds build dirs, retags `paddock-vm-&lt;type&gt;:latest` → `paddock-vm-&lt;name&gt;:latest`, regenerates compose + force-recreates running containers. Idempotent; runs on webui boot and via `GET /api/admin/migrate-builds`.
- `setBuildEnv(name, kv)` / `readBuildEnv(name)` — read/write `instances/&lt;name&gt;/build/build.env` (K=V, `#` comments preserved)
- `existingServices()` — scan instances/ for existing compose files
- `instanceComposePath(name)`, `getComposePath(name)` — path helpers

## Instance Image & Build Files (services/instance-image.js)

Small dependency-free module (drivers, vm-manager and app.js all derive the same
tags/paths from it). No vm-manager/drivers imports — safe to require anywhere.

**Exports:**
- `imageFor(name)` — `paddock-vm-&lt;name&gt;:latest` (stable per-instance tag)
- `legacySharedImage(agent)` — `paddock-vm-&lt;type&gt;:latest` (migration retag source)
- `buildDir(name)` — `instances/&lt;name&gt;/build`
- `buildEnvPath(name)` — `instances/&lt;name&gt;/build/build.env`
- `readBuildEnv(name)` / `setBuildEnv(name, kv)` — parse / update the env file
  (preserves comments + other keys)
- `argsFromDockerfile(path)` — extract `ARG NAME[=default]` lines (commented
  ARGs skipped) → feeds the generated compose `build.args:` block

Image/tag/version lookups no longer live here — they go through
`getDriver(agent)` from `services/drivers/` (see below).

## Driver Registry (services/drivers/)

One module per agent type — `openclaw.js`, `opencode.js`, `picoclaw.js`,
`hermes.js`, `codex.js`, `claude.js` — registered in `index.js`. Every type is
an equal citizen. The per-driver field values, command groups, and gotchas
live in [drivers.md](drivers.md); this section documents the registry and the
interface.

**Functions:**
- `getDriver(type)` — returns the driver for a type, **falls back to the
  openclaw driver** when a type has none (never crashes callers)
- `listDrivers()` — `[{ type, label, setupSteps }]` for the CreateAgent select
- `drivers` — the raw registry object

**Driver fields:**
| Field | Purpose |
|-------|---------|
| `type` / `label` | agent type id + human label |
| `templateDir` | shared build template path (`../../src/vm-builds/&lt;type&gt;`) — the create-time copy source (the per-instance copy lives at `instances/&lt;name&gt;/build/`) |
| `baseImage` | upstream image the Dockerfile starts from |
| `dataDir` | in-container data directory (`/root/.openclaw`, `/root/.picoclaw`, `/opt/data`, …) |
| `workspaceDir` | workspace root inside the container (hermes: the data dir itself) |
| `configFile` / `configFormat` | config filename in `dataDir` + format (`json` for openclaw/picoclaw/opencode, `yaml` for hermes, `toml` for codex). Non-`json` = config served/written verbatim, no secret redaction |
| `setupSteps` | commands run right after `compose up` during create (empty for codex) |
| `backupTypeMarker` | filename sniff for backup-type detection (generic backups are removed; kept for plan 26) |
| `webApp` | built-in web app descriptor (`label`, `docs`, `containerPort`, `auth`, `startCommand`) — only opencode has one today |
| `startWebCommand` | shell command to (re)start the web app in the container |
| `currentVersion(name)` | live version inside the container (regex-parsed; picoclaw prints a heavy ANSI banner) |
| `availableVersion()` | upstream available version (cached 5 min; empty where inapplicable) |
| `commands` | Command groups (Status/Auth/Cron/Skills/Other) for the CommandsPane |

Per-instance image tags (`paddock-vm-&lt;name&gt;:latest`) come from
`instance-image.imageFor(name)` — drivers no longer hardcode `buildImage`;
`currentVersion` falls back to reading the version from `imageFor(name)` when
the container is down.

Config GET/POST, agent-registry model extraction, and workspace/config root
resolution all derive paths from `driver.configFile` / `driver.workspaceDir` /
`driver.dataDir` — nothing is hardcoded to openclaw anymore.

## Command Runner (cmd.js)

- `runCmd(cmd, args, options)` — `execFile`-based, returns the full combined output string (no streaming)
- `runCmdStream(cmd, args, { onLog, timeout })` — `spawn`-based; feeds every stdout/stderr chunk through `onLog(stream, text)` so long operations can stream live. Used by create (`build`/`up`/`setup`) and backup restore.

## Container Health (container-health.js)

Generic Docker-level container health checkup. **No agent/driver knowledge** — it diffs the *declared* compose settings (`docker compose -f instances/&lt;name&gt;/docker-compose.yml config --format json`) against the *actual* container (`docker inspect`) and reports what's out of line. Works on stopped containers (inspect + compose file both work while down) so it reports *why* a container stopped.

Each check: `{ key, label, status: 'ok'|'warn'|'error', expected, actual, hint }`. No auto-fix — failing rows carry a hint (usually "Recreate to fix").

**Functions:**
- `checkContainerHealth(name, onCheck?)` — runs all checks. With `onCheck`, each check is streamed as produced (health-check job); without, the full report is returned at once. Returns `{ name, status, checks, counts }` via `summarize(name, checks)`.
- `summarize(name, checks)` — tallies counts, derives `status` (`error` if any, else `warn` if any, else `ok`).

**Checks (11):** compose file exists · container exists/status (with OOM-kill + exit-code reason) · Docker healthcheck probe (`healthy`/`starting` warn/otherwise error) · restart policy vs compose · image (declared vs actual; warn on mismatch) · network mode + `container:` peer existence/running state · volumes/bind mounts (incl. `/workspace` host-path split-brain detection) · docker socket mount · published ports · environment keys (secrets excluded via `/(password|token|key|secret)/i`).

Driver-aware app-level checks are planned — see `plans/20-health-check-driver-aware.md`.

## Log Store (log-store.js)

Persistent container logs. `docker logs` dies with the container (docker rm
removes the log file), so a recreated PAD's Logs tab would start empty. The log
store captures each container's logs into a rolling file at
`instances/&lt;name&gt;/logs/container.log`:

- `capture(name)` — runs `docker logs --timestamps`, preserves each line's full
  RFC3339Nano timestamp, and appends only uncaptured lines. `meta.json` stores
  the last timestamp plus its boundary lines, preventing both nanosecond output
  loss and duplicate captures. A recreated container's logs naturally append
  with no dupes/gaps. File is trimmed past 8MB/20k lines.
- `captureAll(containerNames)` — the 30s `setInterval` sweep in app.js over all
  `safeVmName` containers **minus managed door containers**. A door is a socat
  forwarder, not an agent: nothing ever reads its captured log, and capturing
  one `mkdir`s `instances/<pad>-door/logs/`, which resurrects the very
  instance dir `cleanStaleDoorDirs` quarantines — every 30 seconds.
- `readLogs(name, tail)` — read the captured file (used by the Logs tab and the
  MCP `agent_logs` tool).
- `logFile(name)` — the log file path.

Capture triggers: every `/api/agents/:name/logs` fetch, the 30s sweep, and the
start of each backend recreate/delete/update/settings job (final lines survive
the sweep window).

## Job Log (job-log.js)

In-memory event store for long-running operations (create agent, …). Holds an ordered event list per job plus SSE subscriber response objects; lines are fanned out immediately, late/reconnecting subscribers get a replay via the `since` index. Jobs are cleaned up 5 minutes after finishing (only if no subscriber is attached).

Events: `{ n, ts, type: 'step'|'line'|'check'|'done'|'error', step?, state?, stream?, text?, message?, ok?, name?, key?, label?, status?, expected?, actual?, hint? }`.

**Functions:** `createJob`, `getJob`, `getOrCreateJob`, `clearJob`, `append`, `setStep(job, step, state)`, `line(job, stream, text)`, `check(job, item)` (streams a health-check result item — shape matches container-health checks), `finish(job, ok, extra)` (accepts `extra` like `{ status, counts }` for the health job), `fail(job, message)`, `subscribe(job, res, since)` (SSE fan-out + keep-alive), `getStatus(name)` (polling fallback), `listJobs(prefix)` (every live job, newest first), `logLines(name, { tail, since })` (rendered `[stream] text` lines).

The store is also readable over MCP — see [Jobs](#jobs-job-logjs) under MCP Tools for the key convention and the polling contract. `clearJob` cancels the pending cleanup timer, and the timer is `unref`'d, so a job waiting to expire never holds a process open.

In-memory is fine for a single-user panel: a create in flight during a server restart is lost (frontend shows "connection lost" and returns to the form).

## Backup Manager (backup-manager.js)

**STUB — generic backups removed (2026-08-09).** `backupAgent()` /
`restoreAgent()` throw `UNAVAILABLE` ("Generic backups were removed. Native
backups are not available yet.") with no callers in `src/`. Native per-driver
backup/import (`openclaw backup create`, `hermes backup`/`import`, …) is planned
in `plans/26-backup-and-restore.md`; until then the Backups page shows a
maintenance empty state and legacy archives in `backups/` are not restorable.

Business logic: See `overview/business-logic.md` — Backup and Restore.

## Ownership (ownership.js)

The webui container runs as **root** (plan 43), so every file it writes is
root-owned by default — but the user's files must stay `PUID:PGID`-owned. This
module is the chown-on-create discipline that keeps user files owned by the
user despite the root process.

**Functions:**
- `ensureOwned(p)` — `fs.chownSync(p, USER_UID, USER_GID)` when not already
  owned (cheap `stat` compare). No-op on missing paths, never throws. Called
  right after every webui create site (instance dir, `meta.env`,
  `docker-compose.yml`, `web.json`, publish state files, `logs/`,
  `src/data/app.db*`) — one call after each create, never batched, so a crash
  between create and chown cannot leave a root-owned file.
- `normalizeTree(root, skipDir?)` — recursive chown of a tree. Symlinks are
  never followed. `skipDir` (predicate, called on each dir) prunes a subtree.
- `ensureDataOwned()` / `ensureDbOwned()` — normalize `src/data/`; the latter
  re-runs after the DB is opened because a fresh `app.db*` from a root process
  is root-owned.
- `isSelfManagedAgentData(dir, instancesRoot)` — depth-exact test for agent
  data dirs (`&lt;instancesRoot&gt;/&lt;pad&gt;/&lt;agent&gt;`) whose driver manages its own
  ownership. Only **hermes** today: its gateway drops to uid 10000 and
  `chown -R hermes:hermes /opt/data` on every boot, so chowning its data to
  `PUID` is undone at the next boot anyway. The boot sweep and the clone path
  pass this as the `skipDir` predicate; a pad *named* `hermes` or a workspace
  folder named `hermes` is not excluded.

`app.js` runs `ensureDataOwned()` + DB init at boot, then a background
`normalizeTree(INSTANCES_DIR, hermes-skip)` — the automatic replacement for the
old manual `chown -R node:node instances/` runbook.

## Database (db.js)

SQLite wrapper for `src/data/app.db`. Tables are created on first access (auto-initialization).

**Tables:**

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT UNIQUE, display_name TEXT,
  agent_type TEXT, runtime_type TEXT, runtime_ref TEXT,
  status TEXT, workspace_root TEXT, config_root TEXT,
  default_model TEXT, default_provider TEXT, tags TEXT,          -- JSON array
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME, last_activity_at DATETIME
);

CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT,
  category TEXT, action TEXT, status TEXT, details TEXT,
  resource_ref TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, agent_id TEXT, kind TEXT, status TEXT,
  model TEXT, tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  started_at DATETIME, ended_at DATETIME
);
```

`migrate(db)` runs the `CREATE TABLE IF NOT EXISTS` block, then patches older
databases with idempotent `ALTER TABLE` guards — `agents.owner_id`, and
`tasks.last_output_at` (the task runner's liveness heartbeat; without it the
runner's flush threw `SQLITE_ERROR` from a timer callback and restarted the
webui mid-task). Any code that writes a column must add it to both the
`CREATE TABLE` and one of these guards, or an existing `app.db` breaks.

## Task Runner (services/task-runner.js)

The opencode task queue behind the eight `task_*` MCP tools: push a prompt at a
PAD (`docker exec … opencode run --format json`), stream its output into the
`tasks` row, and extract the assistant text into `result_summary`. A row left in
`running` by a restart is swept to `error` / `orphaned by webui restart` at
module load.

`taskCapability(type)` resolves a driver's `task` capability and accepts **four**
shapes, because all four reach it on live paths: a type string, a driver object,
a pad-like `{ agent_type }`, and an already-resolved capability. The submit path
resolves the capability first and then hands it to `buildExecCommand`, so
looking that value up as a driver type must not be the only option — when it
was, every non-enqueue `task_submit` threw `Task submission is not supported by
[object Object] agents` and no task ever ran.

While a task runs, `flushLive` persists capped output plus the `last_output_at`
heartbeat on a 1s interval. The flush is wrapped in a try/catch on purpose: it
runs from a timer, and an exception in a timer callback is an uncaught exception
that kills the webui.

### The queue's vocabulary (plan 63)

**A name the surface hands out must mean one thing.** `task_submit {name}` is
the PAD a task *runs in*; `task_get_next {name}` was the *worker claiming* the
task. One parameter, two meanings, and the second read as the first. The claim
side is now `worker`, and passing `name` to `task_get_next` is a refusal rather
than an alias — with `worker` left **optional in the JSON schema** on purpose, so
the SDK's `expected string, received undefined at worker` does not pre-empt the
sentence that explains the difference.

**Facts are stored, vocabulary is derived.** `tasks` gained `enqueue`,
`timeout_ms`, `timed_out`, `attempt` and `superseded_by`. Nothing else: `route`,
`outcome` and `timedOut` are computed per row, and `claimed_by` keeps its one
snake_case spelling rather than gaining a `claimedBy` twin. A second column for
one value is the defect this replaced.

| Derived field | Answers | From |
|---|---|---|
| `route: push \| enqueued \| pull` | who runs this, and is it already running | `enqueue` + `claimed_by` |
| `outcome: ok \| error \| unknown` | did it work | `status` + `exit_code` |
| `timedOut` | a kill or a user cancel | `timed_out` |

`outcome: "unknown"` is a real third value and is never reported as failure — a
queued task has no verdict yet, and collapsing that into "failed" is how a caller
learns to distrust the field. A **pull** task has no process and therefore no
`exit_code`; `outcome` carries the verdict instead of fabricating `0`.

**One read answers "is the queue complete?".** `task_list` is in **service
order** (pending by `priority` ascending — the order `task_get_next` serves them
— then finished newest-first), and `nextUp` names the task the claim *would*
return, computed by the same selector, so the preview cannot disagree with the
claim. Neither mutates: reading the queue does not consume it. `status` +
`total` is the completion check, and `total`/`truncated` are counted over the rows
**this key may see, after the access filter and before the slice** — an unscoped
count described a different set than the one in `tasks`, so a short list read as
"that is everything" while a key that could not see four rows was told the answer
was truncated.

**A filed task does not start itself.** A pool `task_submit` used to answer
`ok: true` and nothing else, which reads as "a worker will pick this up" with no
way to check. It now carries `queue` (length, position, and `recentClaimers` over
30 minutes — empty means no PAD has claimed work in the window, which is the
honest form of "will anyone run this") and a note saying the task is inert until
a worker claims it. There is no worker-presence registry, so no polling count is
invented. The top-level `mode` is read off the row's own `route` rather than
recomputed from whether a name was passed — the two were different questions and
an addressed `enqueue: true` submit said `push` at the top and `enqueued` inside
the same response.

**A retry is a re-file, not a run.** `task_retry` re-files the prompt with an
incremented `attempt` and links the old row through `superseded_by`, so three
failures read as one chain rather than three unrelated rows. The replacement is
**always** a claimable `enqueued` task, even when the original was a push: copying
the original's `enqueue` flag left a retried push with no child process while
`task_route` still called it `push` — the label claiming a PAD was running
something nothing was running. It rides the `exec` grant, because re-filing starts
real work.

**Only the claimer may close a task.** `task_complete` **requires** `worker` and
resolves it through the shared name resolver, so a worker cannot close out
somebody else's work by re-spelling the pad. The service refuses an unclaimed
task as `task_not_claimed` — reported *before* the pending-state check, because
"never claimed" is what the caller must fix and "not in a claimable state
(pending)" is a true sentence that tells them nothing. A claimer that is present
but not `running` is `task_not_running`.

**A task's cwd is checked, not assumed.** `submitTask` is async and resolves the
PAD's effective workspace (`workspace_dir` when set, else the driver default),
verifies it exists **inside the container**, and refuses with
`task_workspace_missing` naming the mount it meant — before inserting anything.
The same rule as `tmux new-session -c`, which silently starts in the parent.

Also on rows: `created_by` (who filed it), `last_output_at`, ANSI stripped from
`task_result`'s `stdout`/`stderr` at the **boundary** (the database keeps the raw
bytes — stripping is a presentation choice), and a `…[truncated]` marker plus
`prompt_truncated` on a clipped prompt in listings. A timeout is now `status:
"error"` + `timed_out: 1` with a summary naming the limit (default 10 minutes,
max 1 hour, documented in the tool description) instead of landing on `cancelled`,
where it read identically to a user's cancel.

## API Keys (api-keys.js)

Per-user bearer keys for the paddock MCP server (`/mcp`). Replaces the
one-shared-`MCP_TOKEN` idea — one auth path, per-identity, revocable.

**Key format:** `pk_live_&lt;base64url-24-random-bytes&gt;` (~192 bits entropy).
Only `sha256(key)` is stored in `api_keys`; the raw key is shown once at
creation, never again. `prefix` (`pk_live_…`) is stored for display in the list.

**Functions:**
- `generate()` — raw key. `hash(key)` — sha256 hex.
- `create(userId, name, scopes)` — inserts hash + prefix, returns
  `{ key: raw, row: { id, prefix, … } }` (key is the only chance to see it).
- `listForUser(userId)` / `getForUser(id, userId)` — owner-scoped reads.
- `remove(id, userId)` — revoke (hard delete, instant).
- `authenticate(token)` — regex-validates `pk_live_` shape, hashes, looks up
  by `key_hash`, rejects missing/revoked. Returns `{ keyId, userId, name, scopes }`.
- `touchLastUsed(keyId)` — throttled to once per minute per key (no write per
  MCP request).

**Schema** (`api_keys` table in `db.js`, FKs to `users(id)`, indexed on
`user_id` and `key_hash`):

```
id TEXT PK, user_id TEXT NOT NULL, name TEXT NOT NULL,
key_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
scopes TEXT DEFAULT 'default', created_at DATETIME,
last_used_at DATETIME, revoked_at DATETIME
```

Auth in `src/mcp.js`: `authenticateRequest(req)` reads `Authorization: Bearer`,
`x-api-key`, or `?token=`, calls `apiKeys.authenticate()`, touches
`last_used_at`, and sets `req.mcpIdentity = { keyId, userId, keyName, scopes, role }`.
Missing/invalid key → 401 JSON-RPC error (`-32001 Unauthorized`). Tools enforce
the same owner-scoping as the REST API: admin → all agents, user → owned agents.

## MCP Tools (mcp.js)

`src/mcp.js` mounts the paddock's own MCP server at `/mcp` (Streamable HTTP). It
exposes 28 tools. Every tool is a thin adapter over the same `src/services/`
functions the REST API uses — behavior lives in the services, never in the tool
handlers (no duplication between REST and MCP).

| Tool | Purpose | Backed by |
|------|---------|-----------|
| `list_agents` | List PADs (owner-scoped); every row is openable; carries `scope` / `agentsTotal` / per-row `owner` | `registry.discoverAgents()` + `registry.getAgent()` |
| `get_agent` | Details + optional `logs` tail (≤500) | `registry` + `logStore` |
| `agent_logs` | Container logs tail (≤5000) | `logStore.capture/readLogs` |
| `config_get` | Driver config file (JSON redacted; yaml/toml verbatim) | `vm.readAgentConfig(agent)` |
| `settings_get` | Full read picture before a `recreate` | `vm.readSettings(name)` + `vm.listNetworkPeers()` |
| `health` | Docker-level health checkup (same as the Settings tab) | `containerHealth.checkContainerHealth(name)` |
| `workspace_list` | List a workspace dir | `workspace.listDir` |
| `workspace_read` | Read a text file (≤256KB) | `workspace.statFile/readFile` |
| `workspace_write` | Write a file | `workspace.writeFile` |
| `create_agent` | Create a PAD (full create flow); needs `confirm: true`; accepts the lifecycle hooks, `web`, and `userMode: 'root'\|'user'` | `vm.validateAgentCreate` + `vm.createAgent` |
| `start_agent` | Start container + socat door | `vm.startAgent(name)` |
| `stop_agent` | Stop container + door | `vm.stopAgent(name)` |
| `restart_agent` | Restart container + door | `vm.restartAgent(name)` |
| `recreate` | The one mutation tool — see below | `vm.applyAgentChanges(name, opts)` |
| `update` | Alias for `recreate {pull: true}` | `vm.updateAgent(name, { pull: true })` |
| `delete_agent` | Delete PAD; needs `confirm: true` | `vm.removeVm` + `registry.removeAgentFromDb` |
| `exec` | Run a shell command in the PAD (optional `stdin`, optional `cwd`); reports where it ran | `docker exec` |
| `job_status` | Poll a long-running job (see Jobs below) | `jobLog.getStatus` + `jobLog.listJobs` |
| `job_log` | Read a job's streamed log lines | `jobLog.logLines` |
| `help` | The "how to use Paddock through MCP" guide (§§1–4, plan 35a) | `llm-guide.js` |
| `agent_commands` | Set B — non-interactive command catalog for an agent type | `llm-guide.js` → `drivers` `llmCommands` |
| `task_submit` … `task_cancel` (9 tools, incl. `task_retry`) | HIDDEN from the MCP surface (user decision 2026-09-29; re-enable with `PADDOCK_TASK_QUEUE=1`) — service kept, vocabulary per §Task Runner | `services/task-runner.js` |
| `mission_projects` | The Mission projects (PAD + folder) the key may see, with session/live/open counts, the PAD's status, and per-session `busy`; narrow it with `project_id` / `name` / `folder`, and ask for nested sessions with `include_sessions` | `mission.listProjects` + `withLive` + `withAgentBusyProjects` |
| `mission_sessions` | Sessions list (filter by `project_id` / `agent`), or one session's metadata + pane state + screen tail; every row carries `busy` / `busyKnown` / `open` / `kind`, rows whose death has been observed carry `endedAt` / `endedBy`, and detail mode also returns `canSend` (+ `sendRefusal`), `screenFrom` and `lastScreenAt` | `mission.listSessions` / `listAllSessions` / `screen` + `withAgentBusy` |
| `mission_project_create` | Create a project row (folder probed inside the PAD) | `mission.projectFolders` + `mission.createProject` |
| `mission_session_start` | Open a session: `msn-*` tmux session at the project folder + the driver's TUI. `idempotency_key` (project-scoped) makes a retried timed-out call return the SAME row with `deduped: true` instead of a second session | `mission.startSession` |
| `mission_send` | Type into a live session — refuses a dead, shell, solo-locked or permission-parked one, and confirms the pane took it | `mission.sendText` |
| `mission_permission_answer` | Answer a permission dialog the pane is parked on (`once` / `reject` from an agent; `always` is the human's route) | `mission.answerPermission` |
| `mission_session_close` | End a session deliberately: pane killed, row kept and stamped `endedBy: "closed"`, screen captured first. Refuses `mission_session_dead` rather than re-dating a corpse | `mission.endSession` |
| `mission_session_relaunch` | Re-launch the TUI in a LIVE pane whose agent process died — keeps the conversation | `mission.relaunchTui` |
| `mission_session_restart` | Re-create a GONE tmux session with the same id and `agent_session_id`, rooted at the project's folder (checked with `folderExists` first) | `mission.restartSession` |
| `plan_list` | The plans in one PAD's workspace (`path` for one plan + its body, `archive` for `plans/archive`, `folder` to scope to one Mission project), each row with `status`, `session`, derived `ageMs`/`idleMs`/`elapsedMs`, the bound conversation's liveness and its `sessionProject` | `plans.listPlans` + `plans.withSessionState` + `plans.scopeByProjectFolder` |
| `plan_write` | Write one plan file; frontmatter is machine-managed, the body is the caller's; the folder is created on the first plan | `plans.writePlan` (via `workspace`) |
| `plan_activity` | What one conversation is doing, from the agent's own store on the host: last user + assistant text, last tool call and `lastActivityAt`. Works on a **stopped** pad. Cost is **per driver**: opencode ~2 ms (one indexed query), codex/claude parse that conversation's rollout file. Redacted | `agentStore.readActivity` |

Rules:

- Tool names carry no `paddock_` prefix — the consuming MCP client namespaces
  the server's tools itself.
- **Every `name` argument is resolved, never taken literally** (plan 61). A PAD has
  three spellings in circulation — the container name `pad-opencode-proj`, the bare
  name `create_agent` accepts, and the `display_name` `list_agents` prints — so all
  three are accepted by every tool that takes a `name`. `resolveAgentName()` tries
  them in that order, then falls back to a **unique** substring of either. Two
  precedence rules matter:
  - A **prefixed exact match beats substring ambiguity** — `proj` is the exact bare
    name of `pad-opencode-proj`, so it resolves there instead of being refused as
    ambiguous against `pad-proj2`.
  - **Genuine ambiguity refuses and names the candidates** (`opencode` matches five
    PADs). Guessing would mean running a command on the wrong agent.
- **Resolution runs BEFORE the grant check, and the grant and the action both use
  the resolved name.** This is the security half of the resolver: gating on the raw
  string means a target-restricted key is refused for the wrong reason, and a tool
  that gates on one identity then acts on the caller's spelling does work on a PAD
  it never authorized. `requirePad(tool, name)` performs
  **resolve-then-gate-then-act** in one call and returns the agent, so no handler
  can skip the last step. Job keys
  resolve the same way, so a `display_name` finds its job.
- A **non-PAD container is named as one.** When a name resolves to nothing,
  `notFoundMessage()` also probes `docker ps -a`; a real host container that
  Paddock does not manage is reported as such ("`schlorp` IS a container on this
  host, but it is not a Paddock-managed PAD"), which is distinguishable from a
  typo and implies the opposite next move. It says *container*, not *running
  container*, because the probe includes stopped ones. This is a near-miss hint
  for a name the caller already has — it is **not** `list_containers`, which is
  deliberately absent (see Design decisions).
- `create_agent` still takes a *bare* name, because it is the tool that mints one;
  every other tool resolves whatever spelling you have (above). `name` is the
  **final** container name:
  `createNameFor` prepends `CONTAINER_PREFIX` + `-` only when the caller left it
  off, and never inserts the agent type — `blog-bot` becomes `pad-blog-bot`, and
  `opencode-tester` becomes `pad-opencode-tester`. The result echoes
  `resolvedName` so a caller never has to guess which rule applied. It needs
  `confirm: true` (image build + new fleet member) and the creating API-key user
  becomes the owner (`registry.assignOwner`). It shares `validateAgentCreate` +
  `createAgent` with `POST /api/agents/create` — the REST route kept only the
  409 exists-check and the admin `assign_to` owner override.
- `create_agent` also carries the four lifecycle fields — `buildCommands`,
  `postCreate`, `postStart`, `postAttach` — and the same `web` block as
  `recreate`, so a PAD can be reproduced in full from the tool surface without a
  second heavy pass. Web is validated before anything is written
  (`resolveWebRequest`), persisted with the instance, and applied during the
  initial bring-up; `createVm` applies the auth and re-verifies after the
  driver's setup steps. `openclaw` still refuses to publish without a gateway
  token — that is the driver refusing a non-loopback bind, not a Paddock limit.
- Mutations go through one gun: `recreate` accepts every Settings/Web option
  (`allowDocker`, `network`, `extraVolumes` — binds or named-volume entries,
  `workspaceHost`/`workspaceDir`,
  `sshEnabled`/`sshPort`/`sshContainerPort`/`sshPassword`, `extraPorts`, `web`)
  plus `pull` and `reset`. Only the options you specify change; pass `[]`,
  `''` or `false` to explicitly clear. `reset: true` wipes the data dir and
  requires `confirm: true`. `recreate` returns `{ ok, name, action, changed,
  summary, webService, log }`.
- `settings_get` is the paired read: one call returns allowDocker, network
  peer, SSH, workspace mount, volumes/ports, image/version, networkHealth, the
  available peer containers, AND the published-web state. Two of those fields
  carry a deliberate contract:
  - `availableNetworks` is the filtered peer list from `listNetworkPeers` (the
    UI's raw `listContainers` is untouched): the webui and every socat door are
    dropped, a PAD appears only when it publishes something, the page is capped
    at 10, and `availableNetworksTotal` + `availableNetworksTruncated` make
    truncation explicit. The selected peer carries `isCurrent`. Because a
     caller who already knows a container's name is asking "is THIS valid?", not
     "show me ten", the optional `networkFilter` argument searches the **whole**
     candidate list and skips the cap entirely, setting
     `availableNetworksSearchedAll: true` — so an empty result is a real "no"
     instead of being indistinguishable from a truncated page. The filter is
     applied **before** the limit, not after a widened one: filtering a
     truncated list and then claiming `searchedAll` is the same silent maybe
     with a bigger number in front of it. The default (unfiltered) list is
     still capped at 10 and makes no `searchedAll` claim.
  - A PAD that is **not** listed here is usually excluded for publishing no ports,
    not by the 10-cap. The two are different filters, so a missing name is not
    evidence of an invalid peer until `networkFilter` has been tried.
  - `workspaceDevcontainer` describes the **workspace's** `.devcontainer`, not
    the PAD's own, so it states `scope: "workspace"`, `shared`, `sharedWith`
    (the other PADs on that workspace) and a `note`. Its `ports` are a plan; the
    PAD's live bindings are the `actualPorts` in the web state. It inherits the
    PAD's `userMode`/`containerUser` rather than reporting blanks.
- Destructive tools require a guard: `delete_agent` needs `confirm: true`
  (and `create_agent` too — it adds fleet members).
- The `mission_*` tools (plan 55, extended by plan 65) are the agent-visible half
  of the Mission page, and they have their own contract:
  - **Grants** — `mission_projects` + `mission_sessions` join `READ_TOOLS` (a
    `read` key may *watch* the human work, not type into it);
    `mission_project_create` maps to the `create` bucket; `mission_session_start`,
    `mission_send` and the three lifecycle verbs (`_close`, `_relaunch`,
    `_restart`) map to `exec` (they do work in a PAD, so they share the bucket
    `task_submit` uses). No new API-key scope was added.
  - **The gate is resolve-then-check** — a session is reachable only through its
    project, so the PAD name (and therefore `targetAllowed` → `requireAccess` →
    `toolAllowed`) always comes from the project row. A project on another user's
    PAD is refused as `mission_project_forbidden` rather than 403, so a read never
    confirms that someone else's row exists. List tools scope by the caller's
    owned agents plus the key's target grant (`missionVisibleAgents`).
  - **Errors carry the store's machine code** — a `MissionError` is re-thrown as
    `<code>: <message>` (`mission_session_locked`, `mission_session_dead`,
    `mission_agent_stopped`, `mission_folder_missing`,
    `mission_unsupported_agent`, `mission_project_forbidden`) because the LLM
    branches on the code and the SDK's own error path only prints `message`.
  - **Liveness is decoration** — one `list-sessions` per PAD
    (`mission.withLive` / `withLiveSessionsByAgent`), and a PAD that cannot be
    listed leaves its sessions marked dead rather than failing the read. The
    screen tail is clamped in the schema (1–200 lines) because an unbounded
    `capture-pane` floods an LLM context.
  - **A session's LIFE is separate from its liveness** (plan 65). Liveness
    (`live` / `busy` / `open`) answers "is it alive right now?"; `endedAt` /
    `endedBy` answer "what happened to it, and when did we find out?" — see §Session
    lifecycle below.
  - **"Mid-turn" is a separate, cached pass** — after liveness, the tools chain
    the same `withAgentBusy` / `withAgentBusyProjects` step the REST routes use,
    so `busy` / `busyKnown` / `open` reach the LLM on the same row as `live`.
    It is grouped and cached per (PAD, folder) by the store, so it is one probe
    per project and never one per row. `busyKnown: false` is **unknown, not
    idle** — the server exposes no idle-presence registry — so the tool projects
    the field only when the store stamped it, and the guide tells the LLM never
    to read it as licence to type. Without this the agent could only see "live"
    and would talk over a session the human was actively driving.
  - `mission_send` goes through `mission.sendText`, the single writer path the
    page's terminal uses, so the per-session solo lock is honoured in one place.

### Project progress: the plans facility (plan 64, closing 67 §67.1)

There is deliberately **no progress field on a project**. `mission_projects`
reports liveness, and a project whose sessions all died still reports the same
counts it did while they were alive — that is what the counts mean. "What has this
project been worked on?" is answered by the **plan files**: `mission_projects
{folder}` gives the project's `folder`, and `plan_list {agent, folder}` returns
the plans worked in it, with the conversation each is bound to and its real
timings. The plan file is the human's own record, so nothing is inferred.

The link runs through the **session**, not the filesystem: plan files live in the
PAD's workspace `plans/`, which is not a project's folder, so each stamped row
carries `sessionProject` (`{id, name, folder}`) taken from the Mission session's
own project row. Two consequences worth stating, because both are ways to lie
here. A plan whose conversation the page has never seen cannot be attributed, so
a folder-scoped listing reports `sessionUnattributed` rather than dropping those
rows — a short list that looks complete is the failure the filter exists to
prevent. And putting a copy of the plan list under each project folder would be a
second source of truth for the same thing, kept in step by hand.

`plan_list` takes `path` (one file) **or** `folder` (scope the list), never both:
the one-file branch returns before the scope is applied, so accepting both would
answer with the file and no sign the filter had run — indistinguishable from a
match. The combination is refused as `plan_path_and_folder`, with the message
naming the two calls that answer the conjunction.

Plan 53 Phase 9 (`mission_notes` + a checklist table) is **superseded by this**:
a plan *is* the checklist item, with the session it is worked in and its timings
attached, and a second table would be a competing source of truth for the same
thing. Do not build it.

### Session lifecycle (plan 65)

Liveness above answers *is it alive right now?* This section is the other half:
**what happened to it, and when did we find out?** Before plan 65 the answer was
"you diff 29 rows and guess", and a dead session's chat was unreachable — a tmux
screen tail only exists while the pane does.

**The store keeps the pane's last screen.** `noteOutput` persists `last_screen`
(every 200 chars or 2s, whatever landed first) alongside `last_screen_at`, capped
at `SCREEN_STORE_LIMIT = 8000` with `last_screen_truncated` set. There is no
teardown hook — tmux does not tell the webui a session died, and the container may
be gone before we could look — so the last screen is stamped from the reads that
*already* capture a pane. Detail mode reports `screenFrom` so an empty screen is
never ambiguous: `live-pane` (showing now), `last-captured` (the last thing we were
shown, and the only way to read a corpse), or `none` (never captured).

**`endedAt` is the FIRST OBSERVATION of a death, not the time of death.** Nothing
observes a Mission session dying, so only the deaths *we cause* are exactly dated:

| `endedBy` | meaning | exact? |
|---|---|---|
| `recreate` | our `recreate` killed the PAD's tmux sessions | yes |
| `closed` | `mission_session_close` killed this pane on purpose | yes |
| `gone` | first time we LOOKED, it was already gone | **no — an upper bound** |

A `gone` row was alive at its last probe and dead by the next one; the tool
description and the LLM guide both say so in words, because a caller reading
`endedAt` as a time of death is wrong on every `gone` row. An **absent** `endedAt`
means "we have never observed it dead" — *not* "it is running"; `live` answers
that. `syncEnded` stamps on the read paths (`screen`, the three list projections),
so the stamp happens on the same pass that noticed the absence. The migration
back-fills **nothing**: an invented death date is worse than a missing one.

**A refused close must not stamp.** `endSession` on a row that is already dated —
or undated with no live pane — raises `mission_session_dead` (409) and writes
nothing. "Close the corpse" is precisely the request that would otherwise
overwrite `gone` with `closed` and destroy the only evidence of what happened. The
`endedBy`/`endedAt` are also cleared when a live observation returns, so a session
that comes back is not permanently branded dead.

**Three verbs, deliberately not four.** `mission_session_close` (end
deliberately, keep the row), `_relaunch` (live pane, dead agent process → re-launch
the TUI, keep the conversation) and `_restart` (tmux session gone → re-create it
with the same id and `agent_session_id`, rooted at the project folder after
`folderExists` — `tmux new-session -c <dir>` silently starts in the *parent* when
the directory is missing). `mission_project_delete` is **not** built: it can end
other users' live sessions, and that is the human's call.

**A timeout is the client's, so the fix lives in the retry.**
`mission_session_start {idempotency_key}` is project-scoped, and a partial unique
index (`idx_mission_sessions_idem`) makes a *concurrent* retry dedupe at the
database — the in-process pre-check alone loses that race. A deduped insert
returns the existing row with `deduped: true` and never touches tmux, so the
caller's retry cannot become a second live session.

**`recreate` reports its own collateral.** `endSessionsForPad` marks only the
LIVE rows of that PAD with `endedBy: "recreate"` and returns them as
`sessionsEnded` (+ `sessionsEndedHidden` for rows the caller may not see), so a
caller is told which of its sessions just died instead of having to re-list. The
report carries an internal `agentName` purely for MCP visibility filtering and
strips it from the response.

### Liveness truth (plan 62)

`live`, `busy`, `busyKnown` and `open` are four different questions, and the
whole point of the vocabulary is that none of them can be inferred from another.
Before plan 62 a dead row reported `busy: true, open: true`, a project header
could print `openCount > liveCount`, and a live pane running only `bash` read as
an agent you were invited to type into.

- **One function computes the verdict, and every path calls it.**
  `mission.stampTruth(s, probe)` is the single source for `(live, busy,
  busyKnown, open)`, and both list mode and detail mode run it. Detail mode
  (`mission.screen`) is the parity fix (plan 62 1d): the same row read on its own
  used to answer differently from the row in the list, so a caller that checked
  before typing got two different verdicts from the same session.
  - `busy` **requires** `live`. A dead row reports `busy: false`, carries a
    terminal `state: "dead"`, and preserves `wasBusy: true` when the server still
    claims the conversation — the forensics without the lie.
  - `open` means **a live TUI is attached**: never a dead row, never a bare
    shell. It is deliberately *not* the send verdict; see `canSend` below.
  - `busyKnown: false` means the probe **could not answer**. The opencode status
    probe is folder-scoped, so when the pane's cwd differs from the project
    folder the answer is stamped UNKNOWN rather than idle (1e) — an unanswerable
  probe never yields `busyKnown: true`.
  - `kind: "agent" | "shell"` is on every row, so the destructive trap is
    visible *before* the write. The shell test fails **closed**: an unknown or
    empty `pane_current_command` is treated as a shell, never as an agent.

- **`canSend` is the store's verdict, not a field the client re-derives.**
  `mission.sendVerdict(session, perm)` answers "would a send be accepted right
  now", and `sendText` gates on the *same function* it projects. That is the
  discipline: a verdict computed anywhere but the gate is a guess, exactly like
  the gate-then-act split in the name resolver. It refused, with a code:
  `mission_session_dead`, `mission_not_an_agent` (a shell — the text would run as
  shell commands), `mission_session_locked` (the human is driving alone), and
  `mission_permission_pending`. Only detail mode can carry the permission arm,
  because only there was a screen captured; list mode makes no such claim rather
  than guessing.

- **`open` and `canSend` are separate on purpose.** A solo-locked row is still
  *open* — the human is driving it, and unlighting its dot would be a new lie
  pointed the other way. What differs is whether the *agent* may type, so that is
  the field that answers it.

- **A permission dialog is a state, not idle capacity** (1c). `detectPermission`
  reads the screen for the `Permission required` / `Allow once` / `Reject` shape
  and reports `blockedOn: "permission"` with the tool and path, so a session
  parked on a dialog no longer looks like free capacity.
  `mission_permission_answer {session_id, choice}` answers it **by key**
  (`Home`+`Enter` / `End`+`Enter`), never by typing text — text sent at a dialog
  lands in whatever it was waiting for. An agent may answer `once` or `reject`
  only; `always` is a durable policy change made by a machine and is refused at
  the store. The human's `POST /api/mission/sessions/:id/permission` route passes
  `allowAlways: true`, because a person pressed the button.

- **A write is confirmed by the pane CHANGING, not by the pane existing** (1h).
  `sendText` captures before the write and polls (≤1.5s) until the content
  differs, then throws `mission_tui_not_ready` if it never did. A live pane is
  not an acknowledgement, and a bare `ok: true` for a keystroke that went nowhere
  is the failure this replaces. The same comparison doubles as the post-send
  repaint wait (1g) — the new content *is* the evidence, so there is no separate
  repaint step to get wrong.

- **Two clocks, not one** (1f). `last_seen_at` is a **probe** clock and moves on
  every read. `last_output_at` is the one a caller actually wants, and it moves
  only when the pane's content genuinely changed — a sha1 of the screen is stored
  beside it (`last_output_hash`) so "changed" is answerable across requests, since
  there is no in-memory cache that survives a restart. A field that advanced on
  every read would be the same lie under a better name.

- **A write says where it landed** (1i). `mission_send` and
  `mission_session_start` echo `project: {id, name}` and the resolved
  `session_id`, and **every** Mission error carries the same
  `[project:… session:…]` suffix — a label is operator-set, often empty, and a
  wrong one is worse than none because it looks like an answer. The agent's own
  conversation title is exposed as `session.title` (via
  `driver.sessionTitle`, keyed by the agent's session id) and kept separate from
  the operator's `label`.

- **The client is not allowed to re-derive any of it.** `SessionList` used to
  compute `open` as `live || busy`, which lit the dot for exactly the shell pane
  the server had just refused. A server field re-derived on the client is a
  second source of truth, and it was the wrong one; the row now reads the store's
  value and only falls back when the field is absent. A `shell` pane gets a
  visible `shell` badge rather than a second dot, so the dot keeps meaning exactly
  one thing.

  - **A project is found by id, name or folder, and a miss says which**
    (plan 67, 67.2). `mission_projects` takes `project_id`, `name` and `folder`,
    because a project's `name` is not its `folder` (`paddock` → `/www2/paddock`)
    and a caller holding a directory — "the sessions in xdl" — could not look it
    up at all before. Zero matches and several matches are BOTH reported
    (`mission_project_not_found` / `mission_project_ambiguous`, with the
    candidates) rather than falling back to the unfiltered list: an unfiltered
    answer to a narrow question is the one response a caller cannot tell apart
    from success. The near-miss hint tests name containment **both ways**,
    because the common miss is a typo and `"paddock"` does not contain
    `"paddockk"`. Candidates come from what the caller may already see, so this
    never confirms that a project on someone else's PAD exists. Each project also
    carries `agentStatus` — the same repo is often mounted by two PADs and the one
    named after it is not always the running one, so reachability no longer costs
    a second tool.
  - **Session provenance is WHO, not just the kind** (plan 67, 67.3). `origin`
    (`human` / `agent`) says the *kind* of starter; the new `createdBy` says the
    *who* — `key:<id>` when an MCP key opened it, `user:<id>` when the web UI
    did. It is emitted only when stamped, so a row created before this existed
    says nothing rather than claiming a value nobody recorded, and the migration
    deliberately does not back-fill a guess. "Is a human or an agent driving
    this?" is the first question before `mission_send`, and it is now auditable
    after the fact instead of resting on the caller's own memory of its calls.
  - **`mission_projects` is a summary, not a superset of `mission_sessions`**
    (plan 67, 67.4). The nested `sessions` array is behind `include_sessions`
    (default false) and the response names the flag in a `hint`; `sessionCount`
    / `liveCount` / `openCount` are serialized **before** it, because those are
    the answer. One unfiltered call used to return every session of every
    project — 26 full rows for a six-project fleet, with the five that were not
    yours first. The REST route is untouched: the Mission page still gets its
    nested rows.
  - **The counts are liveness, not progress** (plan 67). `liveCount` / `openCount`
    sit next to the project row and read as "how far along is this?" — they are
    not. A session that did 400 tool calls and one that opened and died are both
    `live: false`, and nothing in the Mission vocabulary says what a project is
    *working on*. The tool description says so in as many words rather than
    leaving the distinction to be inferred from `liveCount`. What a project is
    actually doing is the plans facility (plan 64: `plan_list` / `plan_activity`),
    which is deliberately not reimplemented here.
  - **`openCount` is always a number, and that is not a formatting detail.**
    `withAgentBusyProjects` used to `return projects` early when no row needed the
    busy probe, which skipped the *counting* along with it, so a project with zero
    sessions came back with no `openCount` at all — a field its neighbours carried
    and this one did not. A count that appears for one project and vanishes for the
    next reads as "unknown", and a caller who has to guard for that is how the
    count ends up unused. Zero sessions is, definitively, zero open. The one case
    that stays absent is a project the caller never loaded sessions for: we did not
    look, so we have no opinion.
  - **The schema migration is tested, because it is the only part of the schema
    that runs against real rows.** `CREATE TABLE IF NOT EXISTS` skips a table that
    already exists, so on any database created before plan 67 the `created_by`
    column is added by the `ALTER` alone — and a migration that silently does
    nothing does not error at boot, it errors later as an `INSERT` against a
    missing column on whatever request happened to be next. `PAD_DB_PATH`
    (production: unset) lets `src/test/db-migration.test.js` point the real
    `getDb()` at a fixture, which is built by letting `db.js` create today's
    schema and then dropping exactly the columns the `ALTER`s own. The suite
    asserts the column arrives, existing rows survive with `created_by` NULL
    rather than a back-filled guess, a later boot does not clobber a recorded
    value, and re-running is idempotent.
  - **`last_output_at` + `last_output_hash` are a PAIR, added the same way**
    (plan 62 1f). The timestamp is the number a caller wants; the hash is what
    makes "the pane changed" answerable. Ship only the timestamp and every read
    looks like output — the half-migration would behave like the bug it was meant
    to fix. Both stay `NULL` until something has actually captured a pane, and
    `noteOutput` returns the timestamp it *stored* so the row handed back and the
    row in the database can never differ by a millisecond.
- Secrets are write-only in the tools (`sshPassword`, `web.password`): empty
  means "keep current", never echo a stored secret back.
- The endpoint requires a bearer API key (`Authorization: Bearer` or
  `x-api-key`) and returns 406 unless the client sends
  `Accept: application/json, text/event-stream`. Responses are SSE
  (`event: message` + `data:` JSON lines).

### Pad name resolution (plan 61)

The precedence order behind those rules, in full — `resolveAgentName(input)` in
`src/mcp.js` is the single resolver every name-taking tool goes through:

1. exact container name — `pad-proj2`
2. the prefixed form of a bare name — `proj2` → `pad-proj2`, mirroring the rule
   `create_agent` itself applies
3. exact `display_name`, case-insensitively — `Proj2` → `pad-proj2`
4. a **unique** substring of either the container name or the `display_name`

Rules 1–3 are exact, so they cannot be ambiguous. A name matching more than one
PAD under rule 4 resolves to none of them and the error names every candidate.

`requireTool(user, tool, name)` runs this **before** any grant check and applies
the target, owner, and tool checks to the canonical `agent.name`; `requirePad(tool,
name)` wraps it and returns that agent, so a handler cannot gate on one identity
and act on another. Every call site acts on the returned `agent.name` — the VM
call, the workspace path, the job key, and the response field. An unresolvable
name falls through to the raw string for the grants, which then fail closed: a
name that is not a PAD cannot pass an owner check or a target grant.

`notFoundMessage()` builds the miss, and it separates the two cases a caller must
not confuse — an ambiguous name lists the candidates, while a name that is a real
host container but not a PAD is named as one, with the reason
(`no instances/<name>/meta.env`) and the remedy. The container probe uses
`docker ps -a`, so a stopped container is still recognized.

`list_agents` rows are filtered through `registry.getAgent()`, so a row is only
listed when it is openable: the listing is where a caller forms their belief
about what exists, and an unopenable row there poisons every later call. Because
`buildAgent` is disk-derived and carries no owner, the owner is read once from the
`agents` table rather than per row. `agentsTotal` counts the rows in the
response — after the ownership and resolvability filters — so a short list is
never mistaken for the whole fleet.

`list_containers` — a tool that *lists* host containers which are not PADs — is
**not** built. The near-miss hint covers the "you named a real container" case;
discovering containers by list is a new read tool and needs the user's approval
first (see [Design decisions](#design-decisions-settled--do-not-add-tools-without-re-checking-the-user)).

### Jobs (`job-log.js`)

`services/job-log.js` is the in-memory store behind the create/recreate/update
SSE streams. The same store is readable over MCP through `job_status` and
`job_log`, which is what makes a **timed-out** `create_agent` recoverable: the
build keeps running server-side, and the caller polls it by name instead of
re-firing a create on top of a live build.

Job keys are shared with the REST routes so one name identifies one job:

| Key | Operation |
|-----|-----------|
| `<name>` | `create_agent` |
| `update:<name>` | `recreate` and `update` |
| `health:<name>` | the REST health route |

Both tools take the bare PAD name plus an optional `kind`; omitting `kind`
resolves to the newest job for that PAD whichever operation it came from, so the
common case is `job_status { name }`. The name goes through the resolver first, so
a `display_name` finds the job that was started under the container name.
`job_status` returns
`{ state, step, done, failed, error, lineCount, expiresIn }` and an optional
`tail`; `job_log` returns rendered `[stream] text` / `[step] …` lines with `tail`
and `since`. A name with no job answers
`{ found: false, padExists, hint, liveJobs }`, where `padExists` separates the two
misses that used to look alike: a PAD with no job in memory versus a name that is
not a PAD at all — and for the latter the hint is the resolver's own
not-found message, never a suggestion to go look up a name that does not exist.

Jobs are dropped 5 minutes after they finish, and only when no SSE subscriber is
still attached; a webui restart clears them all (the UI shows the same
"orphaned by webui restart" caveat for tasks). The cleanup timer is `unref`'d and
cancelled by `clearJob`, so a pending expiry never holds a process open.

### LLM guidance surface (plan 35a)

Three additions let an LLM drive Paddock headlessly:

- **`help`** — the full usage guide (what Paddock is, the tool surface, caller
  rules/pitfalls, numbered workflow recipes). Read-only, no args. Lives in
  `src/services/llm-guide.js` (`GENERAL_GUIDE`), versioned with the code.
- **`agent_commands`** — Set B of the command catalog: the *non-interactive*
  commands for one agent type, grouped by category as
  `{ label, cmd, desc, caveats, credentialInput? }`. `{key}` placeholders are
  filled by the LLM (shell-quoted). Built from each driver's `llmCommands`
  via `drivers.getLlmCatalog(type)`; defaults to openclaw. Interactive-only
  commands that have no headless form sit in `notUsable` — the guidance tells
  the LLM to hand those to the human.
- **`exec.stdin`** — optional text written verbatim to the container process
  stdin. The only sanctioned channel for secrets (API keys, tokens): never
  place a secret in `command`. `stdin` is never included in tool responses,
  errors, or logs (see `dockerExec` in `mcp.js`). Commands whose catalog entry
  has `credentialInput: "stdin"` expect the value there.
- **`exec.cwd`** — an optional working directory *inside* the container, applied
  by prefixing a quoted `cd`. The response carries the resolved `name`, the
  **actual** `cwd` the command ran in, `requestedCwd` (what was asked for),
  `exitCode`, `stdout`, and `stderr` — a bare `stdout` never says where it was
  produced. Two contracts make the field trustworthy:
  - The reported `cwd` is probed with the **same `cd`** the command received, not
    a bare `pwd` in a second `docker exec`. A bare probe reports the container's
    default directory, so the payload would say `cwd: "/www1"` next to
    `stdout: "/www1/craftpip.com"` — a self-contradicting answer, which is worse
    than reporting nothing at all. (This was caught only by the live test.)
  - A `cwd` that does not exist **fails loudly** (exit 2, nothing run) rather than
    falling through to another directory. The value is caller-controlled and
    interpolated into `sh -lc`, so it is shell-quoted.

### Design decisions (settled — do not add tools without re-checking the user)

These four rules and the fold decisions below were set when the `/mcp` surface
was built. Adding a tool that breaks them needs a re-check first.

- **One mutation gun, one read tool.** Mutations go through `recreate`; reads
  fold into `settings_get`. The web app (`web_get`), container info
  (`container_info`) and network list (`list_networks`) are **not** standalone
  tools — their reads are `settings_get` fields, their mutations are `recreate`
  args. **Exception: `health` is a standalone tool** (user request — run the
  Settings-tab checkup on demand). `list_agents` sends no model.
- **Terminal-command tools stay terminal-driven.** Actions that exist as
  `openclaw …` commands (MCP add/remove, skills install) are **not** mirrored
  as API-backed MCP tools — the frontend pastes the command into the docked
  terminal instead (see CommandsPane rule). Only genuinely headless operations
  get MCP tools. The LLM reaches the same commands through `exec` + the
  `agent_commands` catalog, never a backend endpoint.
- **`config_set` is deliberately absent** — an agent self-editing its own
  config can break itself (destroy agents config, auth, plugins). If ever
  added it must be admin-role scoped or confirm-gated. Default is **no**.
- **`backup` / `restore` tools are a standing candidate** (wrap
  `backup-manager.js`), not built yet — the backup service is a stub until
  native per-driver backups land (plan 26).
- **`update` is kept as a convenience alias** for `recreate {pull: true}` — the
  friendliest form of the common "update to latest" flow; dropping it is not on
  the table while it reads as `recreate {pull:true}`.
- **The `mission_*` tools are the one sanctioned exception to the read-fold
  rule** (plan 55, user request): a Mission session is a live TUI the human and
  the agent share, so "see what they are doing right now" is not a field on a
  PAD — it is a different object with its own read, and folding it into
  `settings_get` would put a screen capture on every PAD read. Two nouns, two
  read tools, no verb soup.
- **`list_containers` is deliberately absent** (plan 61, user decision): a tool
  that lists host containers which are *not* PADs stays unbuilt until the user
  asks for it. The non-PAD case is still answered at the point of use — a name
  that is a real container but not a PAD is named as one in the error — because
  a near-miss hint costs nothing while a new read tool adds surface the user did
  not ask for. Note the distinction: the *identity* case is solved, the
  *discovery* case is deferred.

## Vault (vault.js)

Encrypted secret store replacing the old `creds.js` credential manager. Items
live in the SQLite `vault_items` table in `src/data/app.db` (plus `vault_meta`
holding the PIN salt + wrapped master key), AES-256-GCM encrypted.

**PIN (2026-08-07):** The vault is **always locked** — no module state, no
`unlock()`/`lock()`/`isLocked()`. Each operation (create/update/delete/decrypt)
takes a `pin` in the request body and calls `resolveMaster(pin)` to unwrap the
master key for that single operation, then discards it. Wrong PIN → GCM tag
mismatch → throws `Wrong PIN`. Without a PIN set, the master key falls back to
`VAULT_KEY` (or a scrypt derivation of `SESSION_SECRET`).

Envelope encryption: `scrypt(pin, salt) → pinKey → AES-GCM → masterWrapped`
(stored in `vault_meta`), with a random 32-byte `masterKey` per item via
AES-GCM (`enc_value`). `setPin(pin, { reset, oldPin })` — reset verifies
`oldPin` before wiping items (old master key unrecoverable). The item list is
public; only values are protected.

Routes: `GET /api/vault`, `POST /api/vault`, `PUT /api/vault/:id`,
`DELETE /api/vault/:id`, `GET /api/vault/:id/decrypt`, `POST /api/vault/pin`.
All mutating routes take `pin` in the body (decrypt takes it as a query param).
