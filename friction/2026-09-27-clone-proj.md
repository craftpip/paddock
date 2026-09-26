# Chat Test — Clone `pad-opencode-proj` Into `proj2`

**Date:** 2026-09-27
**Mode:** chat test (MCP only — no shell, no API, no backend code)
**Task:** "create a clone of the proj pad name it proj2", then: user mode `user`,
web port `7891`, extra ports `54321-54325`, no SSH.

Result: the create landed in `meta.env` but **no container was produced** — the
tool call timed out and nothing in the tool surface reports what happened next.
Findings below.

## Findings

### `create_agent` name does not get the agent type inserted

- **Tool:** `create_agent`
- **Severity:** guessing
- **What I asked:** `create_agent { name: "proj2", agent: "opencode", … }` to
  clone a pad whose container is `pad-opencode-proj`.
- **What happened:** the pad landed as **`pad-proj2`**. Its own tool description
  shows `blog-bot` → `pad-blog-bot`, which reads as "the type is woven into the
  name for you". It isn't — the result is `CONTAINER_PREFIX` + the literal
  `name`, so an opencode pad named `blog-bot` becomes `pad-blog-bot` while
  every existing opencode pad follows `pad-opencode-<name>`.
- **Why it hurts:** the clone came out with a name that breaks the fleet's
  naming convention, and nothing in the response says which rule applied. A
  caller that guessed wrong has to `delete_agent` (destructive) and rebuild to
  fix the name — the most expensive possible mistake from a docstring.
- **Fix:** either insert the type (`pad-<type>-<name>`, matching the fleet) or
  state the rule literally in the description: *"the container name is
  `CONTAINER_PREFIX` + `name` verbatim; existing pads include the type in
  `name`, so pass `opencode-proj2` to get `pad-opencode-proj2`."* A one-line
  `resolvedName` in the create result would close it either way.
- **Resolution (2026-09-27):** fixed on the documentation route, and the naming
  rule itself is unchanged (nothing was renamed). The `create_agent` description
  now states the rule literally — `name` is the FINAL container name, the prefix
  is prepended only when you leave it off, and the agent type is never woven in —
  and the result returns `resolvedName` alongside `name`. Verified live:
  `create_agent {name: "friction-probe", agent: "picoclaw"}` → `pad-friction-probe`
  (not `pad-picoclaw-friction-probe`).

### A timed-out create is unobservable

- **Tool:** `create_agent` (and the absence of any build/job reader)
- **Severity:** blocker
- **What I asked:** create a pad — a heavy image build, `confirm: true` first.
- **What happened:** `MCP error -32001: Request timed out`. The create was still
  in flight server-side: `list_agents` showed `pad-proj2` as
  `status: "missing"`, `settings_get` showed every setting written, and
  `health` said `Container exists — not found`. There is **no tool for the
  create/update job log** — the UI streams it over SSE, and `task_status` is
  the opencode task queue, not the build. The only way to know whether the
  build is alive, finished or dead is to re-poll `get_agent` and hope.
- **Why it hurts:** the caller cannot tell "still building" from "died halfway"
  from "never started". The two states that look identical — `missing` — are the
  two that need opposite responses (wait vs. re-fire `recreate`). Blind polling
  also burns the one thing the caller has: the request timed out, so it has no
  result and no progress.
- **Fix:** a `job_*` reader for the existing create/update jobs — e.g.
  `job_status`/`job_log`/`job_list` returning `{ state, step, startedAt,
  logTail }`. Failing that, `create_agent` should return a `jobId` immediately
  (fire-and-poll) instead of holding the connection open through the build, and
  a timeout error should carry the `jobId` plus "the job is still running"
  rather than a bare `-32001`.
- **Resolution (2026-09-27):** fixed. Two read-only tools were added —
  `job_status {name, kind?, tail?}` and `job_log {name, kind?, tail?, since?}` —
  and create/recreate/update now register their jobs, so a timed-out call is
  fully observable. `kind` is optional and auto-resolves to the newest job for
  that pad, so the common case is just the name. Verified live against a real
  create whose client gave up after 20s: `job_status` reported
  `state: running`, `step: build` and 56 streaming build lines, and the same job
  later read `state: done` with the full 89-line log — no re-fire needed. The
  key convention is `<name>` (create), `update:<name>` (recreate/update),
  `health:<name>` (REST health); an unknown key answers with `liveJobs` so you
  can see what exists instead of a bare miss.

### `settings_get` returns the whole host's container list

- **Tool:** `settings_get`
- **Severity:** noise
- **What I asked:** the one read before a change.
- **What happened:** `availableNetworks` listed **~60 containers** — minecraft,
  qbittorrent, price-tracker-*, craftpip, navigator, the paddock webui itself —
  each with image and state. The useful field is "containers a PAD may route
  through as a network peer"; everything else is host trivia. The response was
  several times larger than the actual settings I asked for.
- **Why it hurts:** this is billed as *the* read to run before every mutation.
  Paying that token tax on each call, most of it unusable, invites an LLM to
  skip it or skim it — which is exactly the discipline the tool exists to
  enforce.
- **Fix:** filter `availableNetworks` to real network peers (containers not
  managed by Paddock, or ones with a published port) and cap it (e.g. 10) with
  a `truncated` marker. A `?networks=summary` or a separate `list_networks`
  tool would also work.
- **Resolution (2026-09-27):** fixed as suggested. `availableNetworks` is now
  built by a dedicated filtered lister (the UI's raw `listContainers` is
  untouched): the webui and every socat door are dropped, a PAD is only offered
  when it actually publishes something, the page is capped at 10, and the
  response carries `availableNetworksTotal` + `availableNetworksTruncated` so
  truncation is never silent. The current peer is flagged `isCurrent`. Live on
  `pad-proj2`: 46 candidates, 10 shown, `truncated: true`.

### `devcontainerPlan` describes a shared file, not this pad

- **Tool:** `settings_get`
- **Severity:** guessing
- **What I asked:** the clone's settings, to compare against `proj`.
- **What happened:** `devcontainerPlan` reported
  `filePath: /www1/.devcontainer/devcontainer.json`, `hasDevContainer: true`, and
  ports `5431→5433, 5432→5434` — which match **neither** `proj` (whose
  `actualPorts` are `5431→5431`, `5432→5432`) **nor** `proj2` (configured
  `54321–54325`). It also reported `userMode: ""` and `containerUser: ""` while
  the pad's own `userMode` was `user`.
- **Why it hurts:** two pads sharing a workspace also share one
  `.devcontainer/devcontainer.json`, so this block is a plan for a file
  somebody else owns. Read as "this pad's devcontainer", it is simply wrong,
  and the port numbers look authoritative enough to clone from.
- **Fix:** label it as derived from the workspace (not the pad) and say so in
  the key name, e.g. `workspaceDevcontainer`, with a `sharedWith: <other pads>`
  hint when the workspace is mounted by more than one pad. Blank
  `userMode`/`containerUser` should inherit the pad's values or be omitted.
- **Resolution (2026-09-27):** fixed. The key is now `workspaceDevcontainer`
  (`devcontainerPlan` is gone; nothing consumed it) and the block states its own
  scope: `scope: "workspace"`, `shared: true`, `sharedWith: ["pad-opencode-proj"]`
  and a `note` explaining that the file lives in the workspace, is not this pad's
  own config, that editing it affects every listed pad, and that its `ports` are a
  PLAN while the pad's live bindings are the `actualPorts` in the web state.
  Blank `userMode`/`containerUser` now inherit the pad's values (live
  `pad-proj2`: `userMode: "user"`, `containerUser: "pad (PUID:PGID)"`).

## Also worth fixing (not tool-surface, but found here)

- **`create_agent` cannot reproduce a pad's hooks.** `proj` carries a
  `postCreate` (installs the docker-compose CLI plugin), `postStart` and
  `postAttach`; `settings_get` reports all three, and `create_agent` has no
  field for any of them. A "clone" through the MCP surface is therefore never a
  full clone. Fix: add the hooks to `create_agent`, or a `clone_agent` tool
  that copies settings + hooks from a source pad in one confirmed step.
- **No "web" option on `create_agent`.** The web publish state (port, password,
  start command) lives only on `recreate`, so publishing a web app always costs
  a second heavy recreate. Fix: accept `web` on create.
- **Toggling web is a full image rebuild.** `recreate {web: …}` logged
  `start.sh must learn the web start hook — rebuilding the image, then
  recreating…`. Toggling a port is a multi-minute build for a config change.
  Fix: bake the web start hook into every image (guarded by a runtime flag), so
  a publish toggle is a plain container recreate.

**Resolutions for this section (2026-09-27):**

- *Hooks on create* — fixed by adding the four lifecycle fields to
  `create_agent`: `buildCommands`, `postCreate`, `postStart`, `postAttach`.
  A clone is now a full clone through the MCP surface, so no `clone_agent` tool
  was needed. Verified live: `create_agent {postCreate: "echo … > /root/probe.txt"}`
  ran the hook (`POST_CREATE_RAN_OK` in the container).
- *Web on create* — fixed. `create_agent` now takes the same `web` block as
  `recreate` (`active`, `hostPort`, `containerPort`, `password`). It is validated
  before anything is written, persisted with the instance, and applied during the
  initial bring-up — no second recreate. Verified live: one build, then
  `Web app is live at http://10.69.1.164:8123` (HTTP 302) plus a `health` ports
  check of `8123:8123`. `openclaw` still refuses to publish without a gateway
  token, which is the driver refusing to bind non-loopback, not a Paddock limit.
- *Web toggle rebuilds the image* — fixed at the root. The web start hook is now
  baked into every `src/vm-builds/*/start.sh`, so a publish toggle is a plain
  container recreate. The image capability probes were also corrected: they used
  to `docker exec` into a container that might already be stopped, so a stale
  `wasRunning` made every probe throw, every pad looked like it "needed a
  rebuild", and unrelated toggles triggered a full image build. Verified live:
  unpublish → republish on `pad-proj2` logs a plain `Recreate`, no build.

## Session outcome

- `create_agent` for `pad-proj2` timed out, then **completed on its own** several
  minutes later — confirmed only by a later `list_agents` (`status: running`).
  Good evidence for the "unobservable create" finding above: the tool gave no
  signal at any point, and a caller who trusted the timeout would have re-fired
  a create on top of a running build.
- `recreate {web: 7891→7891}` then succeeded and reported
  `Web app re-verified live at http://10.69.1.164:7891`; `health` came back
  13 ok / 0 warn / 0 error.

### `health` reports the published ports as "(none)"

- **Tool:** `health`
- **Severity:** guessing
- **What I asked:** confirm the clone came up with the ports it was created with.
- **What happened:** the `ports` check read `expected: "(none)"` /
  `actual: "(none)"` and was scored `ok`, while the same run's `door` check
  confirmed `pad-proj2-door (running)` carrying 7891 and 54321–54325 (per the
  recreate log). Published ports are carried by the socat door, not the agent
  container, so the declared-vs-live diff has nothing to compare and reports an
  empty set as healthy.
- **Why it hurts:** "Ports: ok (none)" reads as "nothing is exposed". A caller
  verifying a clone's ports gets a green light on an empty check, and only
  learns the real state from the door line or by trial and error.
- **Fix:** make the ports check read the door's published ports for peer-networked
  agents (and the container's for default-network ones), so `expected` is the
  configured set; if a check cannot be evaluated, report `warn` with a reason
  rather than `ok (none)`.
- **Resolution (2026-09-27):** fixed. The ports check now reads the door
  whenever the compose declares one — `label: "Ports (via door)"` — and compares
  the door's declared ports against the door container's live bindings; a
  default-network pad still reads its own container under the plain `Ports`
  label. A door that is gone can no longer masquerade as healthy: the check
  reports the ports as unbound (`error`) or, when there is nothing declared to
  verify, `warn: "not verifiable (door missing)"`. An unbound declared port also
  now says `none bound` rather than `(none)`, so the same misleading string
  cannot come back through the error path. Verified live on `pad-proj2`:
  `Ports (via door) — ok — expected/actual 7891:7891, 54321:54321 … 54325:54325`,
  13 ok / 0 warn / 0 error.

## Also found while verifying the fixes above

- **`task_submit` on a named PAD was completely broken.** Every non-enqueue
  submit threw `Task submission is not supported by [object Object] agents`: the
  submit path resolves the driver's task capability and then passes it to a
  builder that looked the value up *again* as a driver type, which never matches.
  `taskCapability` now accepts a type string, a driver object, a pad-like
  `{agent_type}`, or an already-resolved capability. Verified live on
  `pad-opencode-proj`: `status: done`, `exit_code: 0`, `result_summary: "ok"`.
- **A missing `tasks.last_output_at` migration could kill the whole webui.** The
  live database predated the column the task runner stamps as a liveness
  heartbeat, so `flushLive` threw `SqliteError: no such column: last_output_at`
  from a `setInterval` callback — an uncaught exception in a timer, which
  restarted Paddock mid-task and orphaned the run. The column is now in the
  `CREATE TABLE` plus an idempotent `ALTER` for existing databases, and the
  heartbeat flush is wrapped so no database hiccup can take the control plane
  down again.
- **Three module-level timers kept their processes alive forever** (the task-job
  cleanup, the rate-limit sweep, and the task-runner flush interval). They are
  now `unref`'d, and the job store cancels its cleanup timer when a job is
  cleared. Without this, running a single test file hung until it was killed.

## See Also

- [`README.md`](README.md) — how this log is written.
- [`plans/35b-paddock-mcp-for-agents.md`](../plans/35b-paddock-mcp-for-agents.md) —
  the plan that built the MCP surface.
