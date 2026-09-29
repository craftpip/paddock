# Chat Test — "list plans in paddock", and the spec for a plans facility

**Date:** 2026-09-29
**Mode:** chat test (MCP only — no shell, no API, no backend code). No
deviations.
**Task:** "list plans in paddock" → then a specification: plans should be a
standard method for the LLM to manage, living in `/plans` in the project
workspace as markdown files, with `/plans/archive` for finished work and
`/plans/README.md` carrying harness prompts on how to manage plans well.

Outcome: **blocked, twice over, and the block is the finding.** There is no
"plans" concept anywhere in the MCP surface — nothing to list and no way to
create one — and the only tools that could have reached a workspace directory
are all three dead. So I could not list the plans *and* I could not create the
folder or write the README. The user's specification is recorded below as the
requirement, because the user is a permitted source of truth and the absence of
this facility is precisely what stopped the task.

**Resolution since (2026-09-29, user):** the `workspace_list` blocker below is
**retired, not fixed** — `exec` + the project's `folder` replaces it, verified
live. The `workspace_write` blocker stands, and so does the plans facility
itself.

## Findings

### There is no plans facility in the surface at all — "list plans" has no tool to call

- **Tool:** the whole `pad_*` surface (negative finding)
- **Severity:** blocker
- **What I asked:** "list plans in paddock".
- **What happened:** no tool in the family concerns plans. The complete surface is
  `help`, `agent_commands`, `list_agents`, `get_agent`, `agent_logs`,
  `config_get`, `settings_get`, `health`, `create_agent`, `delete_agent`,
  `start_agent`, `stop_agent`, `restart_agent`, `recreate`, `update`, `job_status`,
  `job_log`, `exec`, `workspace_list`, `workspace_read`, `workspace_write`,
  `task_submit`, `task_status`, `task_result`, `task_list`, `task_get_next`,
  `task_complete`, `task_priority`, `task_cancel`, and the five
  `mission_*` tools. Nothing is named for plans, documents, notes or files
  beyond the three broken `workspace_*` calls. The guide `help` returns contains
  no occurrence of "plan" — I read it in full. The user then told me a `plans/`
  directory is the intended home, and a prior finding's See Also link names
  `plans/35b-paddock-mcp-for-agents.md`, so **the directory exists on the host
  and the surface still offers no way to see it.**
- **Why it hurts:** a user asking a question of the control plane gets no error
  and no "not supported" — they get silence, and the caller has to work out on
  its own that the concept is absent. There is no discovery path: nothing lists
  "features you can ask me about", so the only way to learn plans are
  unsupported is to try. The one real plan file I know the name of, I know only
  because a friction log entry happened to link it.
- **Fix:** the smallest honest version is documentation — a line in `help`
  listing what the surface cannot do, including plans. The real fix is the
  facility the user specified (recorded next), exposed as at least a
  `plan_list {agent, path}` and a `plan_write`, since a directory an LLM is
  expected to manage on every session cannot be one it can only reach through a
  broken file tool.
- **Requirement, as stated by the user (2026-09-29, verbatim intent):** plans
  are to become a standard method for the LLM to manage. They live in the
  project's set folder `/plans`; in `plans` are `.md` files; they are managed in
  the workspace itself and the agent will be seeing them. The `plans` folder is
  created when the first plan is created, and only then. `/plans/archive` stores
  done, cancelled, or otherwise-ended plans. `/plans/README.md` carries harness
  prompts for the LLM on how to use the plans for best plans management.

### `workspace_write` is the only write path in the surface, and it is dead — so I cannot create the folder or the README

- **Tool:** `workspace_write` (and the absence of any other write tool)
- **Severity:** blocker
- **What I asked:** create `/plans`, and write `/plans/README.md` with the
  harness prompts.
- **What happened:** `workspace_write` is the only file-writing tool in the entire
  MCP surface, and it is one of the three documented dead tools — *"cannot return
  data or refuse anything"* (see
  [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md), severity
  `blocker`, **no Resolution line**). The sweep established it reports success
  while discarding the data, proved it four ways, and found the error path
  swallowed too, so it cannot even refuse. I did not fire it: the read side is
  dead as well (verified tonight, below), so I had no way to check a write
  afterwards, and a write I cannot verify is exactly the call the sweep shows
  must not be trusted. There is no other option — not `exec` (that is in-container
  shell, not the MCP file surface, and would be working around the tool), and no
  `plan_*` tool, because of the finding above.
- **Why it hurts:** this is the harness's own stated discipline biting: *"the
  only thing I write to disk is the friction log itself."* So the user's second
  half of the request — the folder, the archive, the README, the harness prompts
  — is not merely un-doable through the product, it is out of scope for me by
  construction. A caller asked to seed a directory that an agent will then read on
  every session has no tool at all. The prompts are the valuable part of the
  request, and there is no sanctioned channel to deliver them.
- **Fix:** fix `workspace_write` first (the sweep's fix — `await` the handler, so
  a non-host-browsable pad refuses cleanly instead of silently discarding), and
  give it an honest write-confirmation. Until then the surface has no file-write
  story, and a plans feature has nowhere to put its files.
- **Planned (2026-09-29, user — not a Resolution, nothing is fixed or verified
  yet):** the user states the plans management tools and the `workspace_write`
  fix "will exist together, no problem". So this is a known, accepted blocker with
  an intended remedy, not a discovery — the next session should not re-report it as
  unknown. One consequence of bundling them is recorded as the finding below:
  the two changes interact, and doing them in the stated order would ship the
  plans tools with no working writer underneath them.
- **Fix, as stated by the user (2026-09-29, after a live reproduction — not a
  Resolution, nothing is fixed or verified yet):** *"`workspace_*` should behave
  like the `write` command in opencode behaves."* The user is the target of
  this surface — the agents in these pads are opencode, and they are given this
  MCP server as a tool source — so the contract is not "a file tool", it is
  "the `write` tool these agents already know". That is a concrete and
  testable bar, and it settles two questions this log had left open: (a) the
  success shape is opencode's, so a write that does not reach disk is not a
  success, and (b) the path semantics are opencode's, so a caller passing
  `../plans/67-…` is asking for a real thing rather than probing an edge.
  Reproduction, same session, quoted from the tool: `workspace_write
  {name: "pad-opencode-proj", path: "../plans/67-project-progress-and-provenance.md",
  content: "…"}` returned `{"name": "pad-opencode-proj", "path":
  "../plans/67-project-progress-and-provenance.md"}` — a success object echoing
  my own arguments back, with no `ok`, no bytes written, no error, and not one
  word about a path outside the workspace root. The follow-up
  `exec {command: "cd /www2/paddock && ls -la plans/67*"}` returned
  `ls: cannot access 'plans/67*': No such file or directory`, i.e. **the write
  is gone and the escape outside the workspace was not even refused.** The
  document it would have written was a plan file derived from this log, so the
  plans facility has a second, sharper dependency on the writer: today the log
  is the only artifact this surface can produce, and a live agent could not
  write even that through `workspace_write`.

### "The workspace" has no single referent across a 13-pad fleet, so `/plans` is ambiguous before it is unreachable

- **Tool:** `settings_get` + `workspace_list`
- **Severity:** guessing
- **What I asked:** manage plans in "the project's set folder `/plans`", "in the
  workspace itself".
- **What happened:** each pad has its own workspace root, and they are not the
  same directory. `pad-opencode-proj` reports
  `workspaceMount: {host: "/www1", container: "/www1"}`;
  `pad-opencode-paddock-dev` reports
  `workspaceMount: {host: "/www2/paddock", container: "/www2/paddock"}`. So
  "`/plans`" resolves to `/www1/plans` on one pad and `/www2/paddock/plans` on
  another — the same instruction, two different directories, and the fleet has
  both mounted simultaneously. Worse, `/www2` is present on `pad-opencode-proj` as
  an `extraVolume` (`{"host": "/www2", "container": "/www2"}`) rather than as its
  workspace, so paddock's plans are physically reachable *inside* that container
  while being outside the workspace `workspace_list` resolves against — and that
  tool blocks traversal by design. A third pad, `pad-proj2`, shares
  `/www1` with `pad-opencode-proj` (its `workspaceDevcontainer.sharedWith` says
  so), so "the workspace" is not even one-per-pad.
- **Why it hurts:** "the agent will be seeing this" is the load-bearing part of the
  user's spec, and which agent sees which `/plans` is undetermined by the request
  itself. With 13 pads, at least 3 distinct workspace roots, and a shared one, a
  plans folder written in the wrong root is invisible to the agent it was written
  for, with no tool that reports which root a given session is reading. The
  caller has to ask `settings_get` per pad and infer, which is the re-derivation
  the surface should be summarizing.
- **Fix:** a tool that resolves "the workspace for this pad" alongside the plan
  path, and have any plan tool require an explicit `agent` so the target root is
  never inferred. `settings_get` already carries the answer
  (`workspaceMount.container`); nothing exposes it as an addressable target.

### `workspace_list` is dead on a healthy running pad too — the "stopped pad" confound is eliminated

- **Tool:** `workspace_list` + `settings_get` (extension to an existing entry)
- **Severity:** blocker
- **Original entry:** "`workspace_list`, `workspace_read` and `workspace_write`
  cannot do their one job" —
  [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md).
- **Extension (2026-09-29, second reproduction, confound removed):** the sweep
  traced the cause to handlers missing an `await`, and separately observed the
  tools on `pad-opencode-user1`, which is `hostBrowsable: false` — leaving open
  the alternative that a non-host-browsable pad is simply not listable. Tonight
  that alternative is ruled out, twice:
  - `workspace_list {name: "pad-opencode-paddock-dev", path: "plans"}` →
    `{name: "pad-opencode-paddock-dev"}`. No `entries`.
  - `workspace_list {name: "pad-opencode-proj", path: "plans"}` →
    `{name: "pad-opencode-proj"}`. No `entries`. And that pad is `running`,
    `networkHealth.state: "ok"`, `peerName: "gluetun-nordvpn1"`,
    `peerState: "running"`, version `1.18.33` — the healthiest object in the
    fleet, and still `hostBrowsable: false`, which per the sweep is what the
    refusal path was supposed to key on.

  So the defect is unconditional: it is not the pad's state, not the host-browsable
  flag, and not the version. Two pads, two paths, one live and one exited, two
  image versions (`1.18.15`, `1.18.33`), identical payload-less success object.
  Two days on, still no Resolution line. What a caller actually gets back is the
  worst possible shape: **success, with no field that can hold the answer**, so
  "that folder is empty", "that folder does not exist" and "this tool is broken"
  are one indistinguishable response. A false `entries: []` would at least be
  honestly wrong.
- **Fix:** the sweep's fix (`await` all three handlers, and let the
  `requireHostBrowsable` refusal reach the `isError` path instead of becoming an
  unhandled rejection). It is a four-line change that has now been outstanding
  across three sessions and is the single blocker standing between this surface
  and a plans facility.
- **Decision (2026-09-29, user — this changes the fix, do not re-report as an
  open blocker):** **do not repair the trio, retire it.** `workspace_list` is not
  needed: an LLM with `exec` runs `ls` on the folder directly, and the Mission
  project details carry the project's **pwd** (`mission_projects` →
  `projects[].folder`, also on every session row), so the target path is already
  in hand before the call. Verified live tonight on the healthy
  `pad-opencode-proj`: `exec {command: "ls -la /www1/craftpip.com"}` returned the
  real listing, and `mission_projects` for that pad reports
  `craftpip → /www1/craftpip.com` — the two compose with no extra tool. So the
  four-line `await` fix is superseded: the honest end state is these three tools
  gone from the surface (and from recipe 7 of the guide), with `exec` + the
  project's `folder` as the documented path. The one capability that genuinely
  disappears is browsing a **stopped** pad — `exec` refuses with
  `Container is not running: <name>`, which a host-side reader would not have
  done — so if the trio is retired rather than fixed, say so in `help` instead
  of leaving callers to discover it. The residual gap that decision creates is
  the next finding.

### Retiring `workspace_list` leaves the guide pointing at it, and the pwd is only on rows that exist

- **Tool:** `help` (recipe 7) + `mission_projects` + `settings_get` + `exec`
- **Severity:** guessing
- **What I asked:** what replaces `workspace_list` once it is retired.
- **What happened:** the substitution works, but the surface still routes
  callers the other way in two places, and the pwd has exactly one home.
  - Recipe 7 of `help` reads, verbatim: *"**Work in the workspace:** \`workspace_list\`
    / \`workspace_read\` / \`workspace_write\`."* The trio is advertised there as
    **the** way to work with files, and the tool list in the same guide repeats
    it under **Read / inspect**. A caller who reads the guide and then finds
    those three tools dead has no stated alternative — `exec` is presented only
    as the vehicle for `openclaw …` config commands. So the guide is the reason
    a caller reaches for the dead tool in the first place; retiring the tool
    without rewriting this line leaves the same trap with a smaller name.
  - The pwd lives on the **project** row, not the pad: `mission_projects` returns
    `folder` per project and per session, and tonight that was accurate for all
    six projects I could see (`paddock → /www2/paddock`, `craftpip →
    /www1/craftpip.com`, `schlorp → /www1/xdl`, `friction-probe →
    /www2/user1/Work`, plus the two junk rows). A pad with **no** Mission project
    therefore has no pwd anywhere in the Mission surface, and the only remaining
    source is `settings_get.workspaceMount.container` — which the guide tells
    you to read for *settings*, never for "where am I".
  - `exec` takes `{name, command, stdin, timeout}` and **no `cwd`**, so the
    substitution is `cd <folder> && ls`, not `ls`. That is a one-token habit, but
    it is undocumented, and the guide has no recipe that shows it.
- **Why it hurts:** the decision above is right — the tool is redundant — but
  redundancy is only cheaper than a working tool if the replacement is
  *discoverable*. Right now a caller must combine three reads it was never told
  to combine (`mission_projects` for the folder, `exec` for the listing, the
  knowledge that the second needs the first's output spliced into a `cd`), and
  the guide actively recommends the alternative that does not work. The failure
  mode is quiet: `exec` with a bare `ls` returns the **container's** working
  directory — on `pad-opencode-proj` that is `/www1`, not the project folder —
  so a caller who forgets the `cd` gets a plausible, wrong, successful listing
  rather than an error.
- **Fix:** rewrite recipe 7 and the Read/inspect line to name the real path —
  "the project's `folder` from `mission_projects` is the pwd; `cd` there and
  `exec`" — and, for a pad with no project, point at
  `settings_get.workspaceMount.container` as the fallback pwd. Better still, add
  an optional `cwd` to `exec` so the `cd` cannot be forgotten; failing that, have
  the Mission row's `folder` be the one thing a caller needs and say so in the
  `mission_projects` description.

### Every pad I sampled is `hostBrowsable: false`, so the agreed fix makes `workspace_write` refuse fleet-wide

- **Tool:** `settings_get` (×2) + the sweep's proposed fix
- **Severity:** blocker
- **What I asked:** follow-up on the user's plan to ship the plans tools and the
  `workspace_write` fix together.
- **What happened:** the sweep's fix for the dead trio is not only `await` the
  handlers but *let the refusal reach the caller* — a pad that is not
  host-browsable should get a clean `isError` instead of a silent `{name}`. That is
  correct, and it is the same fix the clone-proj and PM entries asked for
  elsewhere. But every pad I read tonight is non-host-browsable:
  - `pad-opencode-proj` → `workspaceMount: {host: "/www1", container: "/www1",
    webuiVisible: false, hostBrowsable: false}`
  - `pad-opencode-paddock-dev` → `workspaceMount: {host: "/www2/paddock",
    container: "/www2/paddock", webuiVisible: true, hostBrowsable: false}`

  and the PM session recorded the same for `pad-opencode-user1` (`hostBrowsable:
  false`, the pad the sweep used). Three for three, including a pad whose mount is
  flagged `webuiVisible: true` and which is *specifically* the paddock repo. So
  the moment the error path stops being swallowed, `workspace_write` and
  `workspace_read` will refuse on every pad in the fleet rather than on a subset.
- **Why it hurts:** this is a sequencing trap inside the agreed work. The fix
  converts a silent no-op into a loud, correct, **uniform** refusal. If the plans
  tools are built on top of `workspace_write` and go live before
  `hostBrowsable` is understood, then `plan_write` inherits a writer that
  cleanly refuses everywhere — the plans feature ships, passes a smoke test
  against a fixture or a non-PAD path, and is dead on every real pad. The failure
  is also a *better* failure than today's, which means it is more likely to be
  shipped believing it works. And `hostBrowsable` is the one field in
  `workspaceMount` that has no explanation anywhere in `help` or in the tool
  descriptions — the sweep quoted the error text (*"the workspace is mounted from
  a folder outside the agent folder"*) but that string is not reachable through
  any tool, so a caller cannot tell which pads are meant to be listable or what
  would make one so.
- **Fix:** before or alongside the plans tools, document what `hostBrowsable`
  gates and either clear it for the pads whose workspace is meant to be browsable
  (the paddock repo pad, at minimum, is the obvious candidate) or add a
  `workspaceWrite` path that does not depend on the host-browser at all — these
  are bind mounts with `readonly: false`, so a refusal is a policy choice, not a
  capability limit, and the surface currently does not let a caller tell which it
  is. Expose the reason in `settings_get` (e.g. `hostBrowsable: false,
  hostBrowseReason: "workspace mounted from outside the agent folder"`) so the
  refusal is predictable instead of surprising.

## Context: the pads that matter here

| Pad | workspace root | state | plans reachable? |
|---|---|---|---|
| `pad-opencode-proj` | `/www1` | running, `networkHealth: ok`, v1.18.33 | `/www1/plans` (wrong repo); `/www2/paddock/plans` is mounted as an extraVolume but outside the workspace root, and traversal is blocked |
| `pad-opencode-paddock-dev` | `/www2/paddock` | **exited** | correct root, but the pad is down — and its own `networkHealth` is `state: "stale"` with empty `peerName`/`peerState`, the hard-blocked condition from [`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md) |
| `pad-proj2` | `/www1` (shared with `proj`) | running | same root as `proj`; one `/plans` serves both |

So the pad with the right workspace root is the one pad in this set that is
stopped, and the only way to change that is a mutation on the user's fleet that
I would not make unprompted.

## What I could not do, and why

- **Could not list the plans.** No plans tool; the one directory reader returns no
  directory content. Reported, not routed around — I did not reach for `bash`,
  `glob` or the web UI, per the harness rule that a missing tool is a finding and
  working around it destroys the evidence.
- **Could not create `/plans`, `/plans/archive`, or `/plans/README.md`.**
  `workspace_write` is the only write path and it is dead; and writing those files
  with anything else is outside what this harness is permitted to touch.
- **Could not test `workspace_read` or `workspace_write` tonight** without
  writing to the user's pads, so those two remain at the sweep's original
  evidence level. The read-side finding above rests on `workspace_list` alone.

## What held up well

`settings_get` is the counter-example that makes the other three findings
readable, and it deserves saying plainly. On `pad-opencode-proj` it returned
~120 lines in one call: the workspace root, the extra volumes, the devcontainer
with its `scope: "workspace"` / `sharedWith` / `note` block stating its own limits,
`networkHealth` with a resolved `peerName` and `peerState` — the exact fields the
PM session found empty on a stale pad — and `availableNetworks` capped at 10 with
`availableNetworksTotal: 45` and `availableNetworksTruncated: true`. That is the
contract the rest of the surface should meet: self-describing, scoped, honest
about truncation. The `workspace_*` trio is the same codebase returning `{name}`.

## See Also

- [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) — the
  dead `workspace_*` trio, extended above; also the `task_list` truncation and
  `availableNetworks` total/truncated pattern.
- [`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md) — the
  `networkHealth` findings and the hard-blocked `pad-opencode-paddock-dev`.
- [`2026-09-29-task-queue.md`](2026-09-29-task-queue.md) — the other task from
  this date, on the task queue.
