# Chat Test — Full Surface Sweep: try every tool, find what lies

**Date:** 2026-09-27
**Mode:** chat test (MCP tools). Deviations, all diagnostic and all recorded
below: I used `exec` and read the paddock container's filesystem to find the
root cause of two findings, and I inspected `src/mcp.js` to name the line
numbers. No product task was done any other way.
**Task:** "find more problems with the tools — try all things with the tools,
make a plan and execute".

Outcome: **four blockers, and the two worst are silent-data bugs.** The
`workspace_*` trio cannot return data or refuse anything. `config_get` and
`get_agent` hand out live bearer tokens while the guide promises they are
redacted. `list_agents` advertises a pad that does not exist. `mission_session_start`
can time out *and* succeed. Separately, `help` contradicts itself in two places
and once tells me a falsehood I then relied on.

The Mission service is in good shape: every error code I could reach fired
correctly with a usable message, and the schema bounds are enforced properly.
That is where I stopped finding bugs, so the findings below are concentrated in
the workspace tools, the read tools' secret handling, and the fleet listing.

Scratch pad used: `pad-opencode-user1` (test pad, zero projects/sessions before
this run). Left behind: one project `friction-probe` (prj_e94dc4cd65b50ea4) and
one dead session `msn_96f56b84015485e0` — **MCP has no way to delete either**
(see "no lifecycle tools"). Removed by hand: the empty `/www2/user1/Work`
directory, restored with its original `node:node` ownership. Two probe tasks
were completed; the queue is empty.

## Blockers

### `workspace_list`, `workspace_read` and `workspace_write` cannot do their one job

- **Tool:** `workspace_list` + `workspace_read` + `workspace_write`
- **Severity:** blocker
- **What I asked:** browse and write files in a PAD's workspace — recipe 7 of the
  guide, and the only file tools in the surface.
- **What happened:** all three return success-shaped answers containing none of
  their data.
  - `workspace_write {name: pad-opencode-user1, path: friction-probe.txt, content:
    "friction probe\nline two\n"}` → `{name, path}`. No error. The file **does not
    exist** — not in the pad, not under the host mount, not anywhere in the
    paddock container (`find / -name friction-probe.txt` → nothing). I had to
    prove the write was a no-op four different ways.
  - `workspace_read {path: "opencode.json"}` on a file I had confirmed exists
    (201 bytes) → `{name, path}`. No `content`, no `size`, no `modified`.
  - `workspace_list {path: "."}` → `{name}`. No `entries` key. Identical for
    every path, including a directory containing a file I had just "written".
  - The only tool of the three that ever errors is `workspace_read`, because its
    existence pre-check is the one call that is not async: a missing path gives a
    clean `File not found: friction-probe.txt`. Every other outcome — success,
    "not host-browsable", I/O failure — is indistinguishable from empty.
- **Why it hurts:** `workspace_write` is the only write path in the entire MCP
  surface, and it reports success while discarding the data. A caller building a
  workflow on it ("write the config, then read it back to confirm") will get a
  clean confirmation for a file that was never created, and will go on to report
  success to the user. The failure is maximally deceptive: a tool that cannot fail
  is more dangerous than one that errors, because it removes the check the caller
  would otherwise rely on.
- **Root cause (confirmed in `src/mcp.js`):** all three handlers call **async**
  service functions without `await` —
  `mcp.js:546` `const listing = workspace.listDir(...)`,
  `mcp.js:569` `const file = workspace.readFile(...)`,
  `mcp.js:588` `const result = workspace.writeFile(...)`.
  `{...listing}` on a Promise spreads to `{}`, so `entries` vanishes; `file.size`
  / `file.content` are `undefined`, and `JSON.stringify` drops undefined keys, so
  `content` vanishes. And the *error* path is swallowed too:
  `requireHostBrowsable()` (in `readFile`/`writeFile`/`listDir`) throws "Host file
  browser is not available for this agent — the workspace is mounted from a
  folder outside the agent folder", but as an unhandled promise rejection it
  never reaches the `registerTool` wrapper's `catch`, so the caller's
  `requireTool` refusal never happens either. `pad-opencode-user1` is exactly
  such a pad (`hostBrowsable: false`), which is why nothing was written to disk.
- **Fix:** `await` all three calls. Then the two halves separate: a
  non-host-browsable pad gets a clean `isError` refusal instead of a silent
  `{name}`, and a host-browsable pad gets its data. Also add an explicit
  existence/scope error for `workspace_list` on a path that resolves outside the
  workspace — today a traversal attempt returns an empty listing rather than
  saying "outside the workspace", so a caller cannot tell blocked from empty.

### `config_get` returns live secrets in the clear, and the guide says it redacts them

- **Tool:** `config_get` + `help`
- **Severity:** blocker (security)
- **What I asked:** read `pad-opencode-proj`'s opencode config.
- **What happened:** the guide states, twice, that this is safe: *"`config_get`
  (driver config file, secrets redacted for JSON)"* and *"**Never expose
  secrets:** `config_get` redacts JSON secrets"*. The response contains working
  credentials, in **both** `config` and `configRaw`, unredacted:
  `mcp.browser.headers.authorization = "Bearer nvg_…"` (a live browser-MCP token)
  and `mcp.torrent.headers["X-MCP-Key"] = "i-4Fw…"` — the latter on a server
  marked `enabled: false`, so the redactor is key-name driven, not
  value-or-scope driven. `configRaw` is the untouched original text, so even a
  fixed `config` would still leak through the second field.
- **Why it hurts:** the danger is the *documentation*. A caller reading the guide
  will call `config_get` freely, put the result in context, and paste it onward
  on the firm promise that it is redacted. It will also be logged in any MCP
  transcript. Two live bearer tokens for this host's services are exposed to
  every API key with read access to that pad.
- **Fix:** redact by shape, not key name — any `headers` value, any
  `authorization`/`api_key`/`token`/`secret`/`password`/`*-key` key at any depth,
  in `config` **and** in `configRaw`; or drop `configRaw` for JSON formats. Then
  correct the guide, and rotate the two tokens that this session exposed.
- **Resolution (2026-09-29, plan 60):** fixed and verified live. `redactSecrets`
  now matches on a **normalized** key (camelCase split, separators unified) as
  either the whole word or a `_`-terminated suffix, and redacts wholesale under
  any `headers`-shaped map — so `X-MCP-Key` and `apiKey` are both caught.
  `readAgentConfig(agent, {redact:true})` scrubs **both** `config` and
  `configRaw`; the raw path is only reachable from the session-authenticated REST
  route, which the config editor needs to round-trip a save. yaml/toml are
  line-scrubbed rather than served verbatim. The guide's two sentences are
  corrected. Three bugs in the first implementation of the fix were caught by
  testing and are worth knowing about: the key matcher claimed to normalize but
  tested the raw key (`xMcpKey` passed), the depth cutoff returned the value
  *untouched* instead of failing closed, and the headers rule was anchored
  (`httpHeaders` slipped). **Still open: rotate the two tokens** — they are
  compromised by record in this log.

### `get_agent` returns the published web app's auth token

- **Tool:** `get_agent` + `help`
- **Severity:** blocker (security)
- **What I asked:** read `pad-openclaw-work-pls` in full.
- **What happened:** the row includes `web: {active: true, hostPort: "18789",
  containerPort: 18789, label: "Gateway Dashboard + WebChat", token:
  "fecwfwfxwfwfxwfw"}`. The guide's rule is *"**Write-only secrets:** `sshPassword`
  / web `password` are never returned by any read tool"*. A `token` is arguably
  not the `password` field, but it is the bearer credential for that published
  app, and it is handed out by a read tool with no marking. Note the shape is
  inconsistent even within the fleet: `pad-opencode-aic` also publishes and its
  `token` is `""`.
- **Why it hurts:** a caller sweeping the fleet with `get_agent` to build a
  picture collects every pad's published-app token into one output, and the guide
  actively tells it that read tools never return web secrets.
- **Fix:** omit `token` (return `tokenConfigured: true`, as `health`/`settings_get`
  already do for other write-only fields) and make the guide's sentence cover
  tokens, not just passwords.
- **Resolution (2026-09-29, plan 60):** fixed and verified live. `get_agent` now
  projects the registry object through `publicAgent()`, which drops `web.token`
  and adds `web.tokenConfigured`. The dashboard's own open-console link still
  reads the token through its own path, so there is no UI regression — verified
  in the browser, not assumed. **The sweep also found the same leak in two places
  this entry did not name:** `settings_get` returned the web password twice, as
  `web.authToken` and baked into `web.startCommand` (the driver's start command is
  built from it). Both are now redacted for MCP, and `startCommand` is replaced by
  the container port, which is the part that is not a secret. Fixing only the two
  reported findings would have left a live credential readable to any
  read-scoped key.
- **Re-verified (2026-09-29):** `get_agent` returns `web: {…, "tokenConfigured":
  false}` with no `token` key, and `settings_get` returns `authToken: ""` plus
  `startCommand: "[redacted: web start command for port 7890]"`. Note the pad I
  read has `tokenConfigured: false`; `pad-openclaw-work-pls` reports
  `tokenConfigured: true` and still no value.

### `list_agents` advertises a PAD that does not exist and no other tool can open

- **Tool:** `list_agents` + `get_agent` + `settings_get` + `config_get` +
  `health` + `task_get_next` + `job_status`
- **Severity:** blocker
- **What I asked:** survey the fleet.
- **What happened:** `list_agents` returns 14 rows including
  `pad-openclaw-cp` (`status: "running"`, `agent_type: openclaw`,
  `runtime_ref: pad-openclaw-cp`) — presented exactly like the 13 pads that
  work. Every other tool refuses it: `get_agent`, `settings_get`, `config_get`,
  `health`, `delete_agent` and `task_get_next` all return
  `Agent not found: pad-openclaw-cp`, and `job_status` happily answers about jobs
  for a pad that does not exist. It is a phantom: `docker ps -a` has **no**
  container by that name and `instances/` has **no** directory for it. It is a
  stale row being surfaced as fleet.
- **Why it hurts:** the fleet listing is the first call every caller makes, and
  it is the caller's map of what exists. A row in it invites `get_agent`,
  `health`, `restart`, `delete` — seven tools that all say the pad is not found.
  The natural conclusions are all wrong: "the pad is corrupt", "the tools are
  flaky", "I mistyped". It took filesystem access to establish that the pad
  simply is not there. `job_status`'s own hint makes it worse — *"Check the pad
  itself with get_agent / list_agents"* points straight back into the
  contradiction.
- **Fix:** `list_agents` should resolve each row the same way the detail tools
  do and either drop the unresolvable ones or mark them (`managed: false`,
  `reason: "no instance directory"`), so a row in the listing always means
  something can open it. `job_status` should also verify the pad exists before
  offering a hint about it.
- **Resolution (2026-09-29, plan 61):** fixed, with a correction to the diagnosis.
  `list_agents` is **directory-derived**, not DB-derived, and `pad-openclaw-cp` is
  gone from disk, so the phantom row cannot reappear that way. The listing still
  now filters every row through `registry.getAgent()` (openable by construction)
  and returns `scope` + `agentsTotal`. The `job_status` half was real and is fixed:
  a missing pad returns `padExists: false` and a not-found message instead of
  "check the pad with get_agent / list_agents", which pointed straight back into
  the contradiction. Verified live: 13 rows, every one openable.
- **Re-verified (2026-09-29):** 10 rows, `scope: "all"`, `agentsTotal: 10`. I
  opened `pad-picoclaw-asdsa`, `pad-openclaw-work-pls` and `pad-opencode-proj`
  (by bare name) — all resolve. The fleet is smaller than it was (13 on
  2026-09-27, 10 now), so the phantom's absence is weaker evidence than the
  Resolution's directory-derived argument; the fix is the argument, not the count.

### `mission_session_start` can time out and still create the session

- **Tool:** `mission_session_start` + `mission_sessions`
- **Severity:** blocker
- **What I asked:** open a session in a project I had just created.
- **What happened:** `mission_session_start {project_id: prj_e94dc4cd65b50ea4,
  label: "probe A"}` returned `MCP error -32001: Request timed out`. No session
  id, no job id, no hint. The session **was** created and live:
  `mission_sessions {project_id: prj_e94dc4cd65b50ea4}` →
  `msn_96f56b84015485e0`, `live: true`, `origin: "agent"`. I only found it
  because I guessed to re-list the project.
- **Why it hurts:** a timeout reads as failure, so the natural retry is to start
  another session — and now there are two live agent TUI sessions in the folder,
  the first one invisible to the caller. The surface has no `job_status` for this
  (that is documented for `create`/`recreate`/`update` only), no session-close
  tool, and no idempotency key, so the duplicate cannot even be cleaned up from
  MCP. It is the one place in the surface where "did it happen?" is genuinely
  unanswerable.
- **Fix:** give `mission_session_start` a `job_status`-shaped handle (or make it
  return the session id before the TUI finishes coming up, since the tmux session
  and the row exist well before the pane is live), and make the timeout message
  say "may still have started — list the project's sessions before retrying".

## Guessing

### The same session read two ways reports `open: true` and then `open: false`

- **Tool:** `mission_sessions` (list mode + detail mode)
- **Severity:** guessing
- **What I asked:** is anyone driving this session right now?
- **What happened:** list mode for the project returned
  `msn_96f56b84015485e0` with `live: true, busy: false, busyKnown: true,
  open: true`. Detail mode for the same id returned one response containing four
  different answers to the same question: `state.live: true`, top-level
  `live: true`, `session.live: null`, and `session.open: false`.
- **Why it hurts:** `open` is documented as the union (live OR busy) and is
  described in the guide as how you answer "is anyone driving right now?" — so
  this is the field a caller branches on, and it is **false in detail mode for a
  live session**. `session.live: null` is a different projection (detail mode does
  not run the liveness pass, so the field is unfilled rather than absent), and
  nothing marks which of the nested fields is authoritative.
- **Fix:** stamp the session object in detail mode with the same `withLive`/
  `withAgentBusy` pass list mode uses — the guide's own parity rule — or state in
  the description that `session.live`/`session.open` are null in detail mode and
  `state.*` is the truth.

### `task_complete` closes a task that was never claimed, so any worker can mark the pool done

- **Tool:** `task_complete` + `task_get_next` + `task_priority`
- **Severity:** guessing
- **What I asked:** exercise the pull-queue lifecycle.
- **What happened:** the queue behaved correctly on the happy path — two pool
  tasks enqueued at priorities 5 and 1, and `task_get_next` served the
  priority-1 one first; `task_priority` correctly refused to re-rank it once it
  was `running` ("Only pending tasks can be re-ranked: … is running"). But
  `task_complete {task_id: <the OTHER task>}` — still `pending`, never claimed,
  `claimed_by: null`, `started_at: null` — succeeded and returned
  `status: "done"`, `finished_at` set, with my `summary` as its
  `result_summary`. The tool checks that the state is `pending` or `running` and
  nothing else.
- **Why it hurts:** `task_get_next` is documented as the *atomic claim* step, so
  claim ownership is the whole integrity model of the pull queue. A mis-wired or
  careless worker can complete every pending task it was never given, and the
  rows then look genuinely done — to the user and to every other worker — with a
  summary that was never worked. The queue drains itself into false completions.
- **Fix:** require `claimed_by` to match the pad calling `task_complete` (or at
  minimum require the task to have been claimed, i.e. reject
  `claimed_by: null`), and say so in the description.

### Bare pad names fail with no hint, though `create_agent` takes bare names

- **Tool:** `get_agent` + `create_agent` (description)
- **Severity:** guessing
- **What I asked:** `get_agent {name: "opencode-proj"}`.
- **What happened:** `Agent not found: opencode-proj`. The guide teaches one
  naming rule — *"`create_agent` takes the FINAL pad name with the container
  prefix left off; Paddock prepends `CONTAINER_PREFIX` … use the returned
  `resolvedName` in every later call"* — so "pass the bare name" is the one piece
  of naming guidance there is, and it silently does not work for reads. Nothing in
  the error points at `pad-opencode-proj`.
- **Why it hurts:** a caller that drops the prefix everywhere (a natural reading
  of the only documented rule) gets "not found" for pads it can plainly see in
  `list_agents`, and has to guess that this one tool family wants the opposite.
  The error would cost one line to make actionable: "no agent named X — did you
  mean pad-X?"
- **Fix:** resolve with or without the prefix on the read tools, or have the
  not-found error suggest the prefixed name when that exists.
- **Resolution (2026-09-29, plan 61):** fixed and verified live. One shared
  `resolveAgentName()` now serves every `name`-taking tool, accepting the exact
  container name, the bare name `create_agent` itself accepts, an exact
  `display_name`, and a UNIQUE substring. Ambiguity refuses rather than guesses
  ("Ambiguous — it matches 4 pads: …"). Live: `opencode-proj` → `pad-opencode-proj`,
  `Proj` → `pad-opencode-proj`, `Proj2` → `pad-proj2`. Critically, resolution runs
  BEFORE the grant check and every grant uses the resolved name, so a
  target-restricted key is still confined to its own pad under any spelling.

### The dead-session error points at a capability the tool surface does not have

- **Tool:** `mission_send` + the Mission tool set
- **Severity:** guessing
- **What I asked:** send into a session whose tmux I had killed.
- **What happened:** the refusal itself is correct and clean —
  `mission_session_dead: This session is gone — restart it to get a fresh TUI`.
  But there is no tool to do that. The Mission surface is five tools:
  `mission_projects`, `mission_sessions`, `mission_project_create`,
  `mission_session_start`, `mission_send`. There is no close, no relaunch, no
  restart, and no project delete. The page has all of them; MCP has none.
- **Why it hurts:** the error's only instruction is impossible to follow, and it
  compounds the timeout finding above: a duplicate session created by a retry, or
  a dead one, is **permanently** in the fleet view. It also means my own probe
  project and session are still there, and the same is true of the two junk
  projects (`test`, `root`) an earlier session created.
- **Fix:** add `mission_session_close` (and a `relaunch`/`restart` for the dead
  case) and `mission_project_delete`, or have the dead-session error point at the
  page instead of at a tool that does not exist.
- **Resolution (2026-09-29, plan 65 — three of the four shipped, and the error
  now points somewhere real):** `mission_session_close`, `mission_session_restart`
  and `mission_session_relaunch` all exist, and `mission_permission_answer`
  arrived with them. Both refusal paths were exercised on a dead row
  (`msn_dc493ea9d87313e7`) and are correct and specific:
  - `mission_session_relaunch` → `mission_session_dead: This session is gone —
    mission_session_restart brings it back (this tool needs a LIVE pane)`. The
    instruction is now followable, which was the whole point.
  - `mission_session_close` → `mission_session_dead: Session msn_dc493ea9d87313e7
    already ended (endedBy: gone) — there is nothing to close.` Nothing was
    killed, nothing typed.
  **Still open: `mission_project_delete`.** A project row is still permanent from
  MCP, so the `friction-probe`, `test` and `root` projects this log mentions
  cannot be cleaned up by an agent — and the same gap now also applies to plan
  files, which can be created with `plan_write` and not removed by any tool.

## Noise

### `task_list` truncates the prompt mid-word with no marker

- **Tool:** `task_list`
- **Severity:** noise
- **What I asked:** what is in the queue?
- **What happened:** each row's `prompt` is cut at ~128 characters with no
  ellipsis and no `truncated` flag, so both my probe tasks read
  `"…is the default-"` and `"…else the driver defau"`. The full text is available
  per task, but from the list alone a caller cannot tell what a queued task is, and
  cannot judge whether the row is the task it thinks it is.
- **Fix:** cut on a word boundary, append `…`, and set `promptTruncated: true`.

### `config_get`'s shape flips with the format, and `config` is null for yaml/toml

- **Tool:** `config_get`
- **Severity:** noise
- **What I asked:** read the hermes config.
- **What happened:** for the yaml pad the response is
  `{configFormat: "yaml", configFile: "config.yaml", config: null,
  configRaw: "{}"}`; for the opencode pad `config` is the parsed object and
  `configRaw` is the same text. A caller that reads `config` — the obvious field
  — gets `null` on every non-JSON driver and concludes there is no config, or
  reports a broken pad. (`configRaw` is still the leak channel; see the blocker
  above.)
- **Fix:** document the two shapes, or always populate one field with the parsed
  value where the format allows and mark the other as the verbatim copy.

### `exec` accepts an empty command and reports success

- **Tool:** `exec`
- **Severity:** noise
- **What I asked:** `exec {name, command: ""}` (a typo probe).
- **What happened:** `{ok: true, stdout: "", stderr: ""}`. No validation, no
  error. Under the guide's "verification habit" — verify with an `exec`-driven
  command after acting — a caller that fat-fingers the command string gets a clean
  confirmation for work that never ran.
- **Fix:** reject an empty/whitespace-only `command` with an `isError` result.
- **Re-observed (2026-10-09), fully open:** `exec {name: "pad-opencode-proj",
  command: ""}` returns `{ok: true, cwd: "/www1", requestedCwd: null,
  exitCode: 0, stdout: "", stderr: ""}`, and `command: "   "` returns the same.
  **Both** the empty and the whitespace-only case false-green, so the
  2026-09-29 note in [`recheck-friction-log.md`](2026-09-29-recheck-friction-log.md)
  that the empty case had started erroring does not hold on this build. The one
  `if (!command?.trim())` guard this entry asked for is still absent.

### `task_status` on an unknown id drops the id and the next step

- **Tool:** `task_status`
- **Severity:** noise
- **What I asked:** `task_status {task_id: "does-not-exist-1234"}`.
- **What happened:** `Task not found` — no id echoed, no hint. Every other tool in
  this family is better: `task_cancel` names the id and its state ("is not
  cancellable (done)"), `task_priority` names the id and the state, and
  `mission_sessions` gives a `mission_session_not_found` code.
- **Fix:** `Task not found: does-not-exist-1234` plus a pointer to `task_list`.
- **Extension (2026-09-28, same defect, two more tools — see
  [`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md)):**
  the Mission write path drops the id the same way. Probed with two refusals
  (neither mutates anything):
  `mission_session_start {project_id: "prj_does_not_exist_0000"}` →
  `MCP error -32600: mission_project_not_found: No such project`, and
  `mission_send {session_id: "msn_does_not_exist_0000"}` →
  `MCP error -32600: mission_session_not_found: No such session`. Neither echoes
  the id the caller sent, neither names the project, and neither lists what does
  exist — so the two error codes are the entire guidance available. Severity
  raised from `noise` to `guessing`: the id-echo part is cosmetic, but losing the
  project leaves a caller with no orientation at all on a surface whose whole
  value is that projects contain sessions. Fix applies here too — echo the id,
  then name the project and the sibling ids.

## Two false statements in the guide itself

Not tool findings, but the guide is the first thing every caller reads and both
of these actively misdirected me.

1. **"There is no headless path: if you want to work, you work in a session."**
   This sits in the Mission section of `help`, in the same document that spends a
   paragraph on the task queue and whose recipe 12 is "Dispatch a task (push)".
   The headless path is the task queue. A caller who reads the Mission section as
   a rule will refuse to use `task_submit` at all.
2. **"`opencode run --format json --dir <workspace>` — the PAD's own workspace,
   never the container root."** The first half is false in practice: the task runs
   in the opencode *driver default* (`/root/.opencode/workspace`), not the pad's
   mount. That assertion is what made me submit to `pad-opencode-user1` with
   confidence and get `Failed to change directory to /root/.opencode/workspace`
   back in two seconds. It is the same defect as the `task_submit` blocker
   recorded in [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md),
   but the guide is currently *affirming* the wrong behaviour, so fixing the code
   without fixing this sentence leaves the lie in place.

## What I could not test, and why

- **`mission_session_locked`** — the fleet has one locked session
  (`msn_eaf4eb83ca6a35ed`, in the schlorp project). Probing it means typing into
  a conversation a human has deliberately claimed as solo. The guard is asserted
  in the guide and I have no way to test it that does not risk exactly the thing
  the guard exists to prevent. Deliberately untested.
- **`mission_project_forbidden`** — my key is an admin, so the cross-user scoping
  path is unreachable. Also **`mission_agent_stopped`**: it needs a project on a
  stopped pad, and since MCP cannot delete a project, the test would leave junk on
  one of the user's pads forever. Both are the same gap as the missing
  lifecycle tools.
- **`update` / `recreate` with `pull`** — a real image pull and rebuild, minutes
  long. Not run: it is the user's fleet, and the timeout/poll contract around it
  is the one thing this session already found wanting.
- **`pad_project_create` on `codex` / `claude`** — `claude` has a full command
  catalog and a running pad (`pad-test-claude`), and both opencode and codex pads
  took projects, so I have no reason to doubt the type gate. Noted because
  `create_agent`'s enum omits `claude` while everything else supports it — see
  [`2026-09-27-craftpip-status.md`](2026-09-27-craftpip-status.md).

## What held up well

Worth recording so the next sweep does not re-test it: every Mission error code I
could reach fired correctly and said something actionable —
`mission_unsupported_agent` (lists the supported types), `mission_agent_not_found`,
`mission_folder_missing` (twice, once at create and once at session start, both
naming the path and the pad), `mission_session_dead`, `mission_session_not_found`.
Schema bounds are properly enforced with the field named
(`limit` must be >= 1, `lines` must be <= 200). The `confirm` guards refuse
correctly and specifically (`Refusing to reset without confirm: true (wipes the
data dir)`). `health` on a stopped container is genuinely excellent — it names the
exit code and points at the Logs tab. `start_agent`/`stop_agent` round-tripped
cleanly. The empty-state hint on `mission_sessions` ("No sessions yet — open one
with mission_session_start…") is the right instinct and should be copied to the
other list tools.

## See Also

- [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md) — the
  same `task_submit` cwd defect, found by hitting it.
- [`2026-09-27-craftpip-status.md`](2026-09-27-craftpip-status.md) — the
  `create_agent` claude enum gap, and the mirror image of today's phantom-pad
  finding (a non-PAD invisible vs a non-pad visible).
- [`docs/tabs/mcp.md`](../../docs/tabs/mcp.md) — the reference these findings
  contradict.
