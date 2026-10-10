# Chat Test — "do you feel any difference in the harness now? many of them are done, check"

**Date:** 2026-09-29
**Mode:** chat test (MCP only — no shell, no web UI, no backend code). Two
deviations, both into `pad_exec` **inside a pad**, which is a `pad_*` tool and
therefore still the MCP surface: verifying that `workspace_write` and
`plan_write` actually reach disk, and removing the probe file afterwards. No
`bash`/`curl`/`docker`, no repository source, no web UI.
**Task as phrased:** *"Do you feel any difference in the harness that you are
using now? Because the large friction that you added, many of them are done. Can
you please check?"* — i.e. re-verify the open findings in this log against the
live surface.
**Outcome:** **yes, and it is the largest change between any two of these
sessions.** Fourteen open findings are now fixed and verified, one whole tool
family (8 `task_*` tools) has been retired, and three new tool families
(`plan_*`, `mission_session_close`/`relaunch`/`restart`,
`mission_permission_answer`) exist. **Seven new findings**, one of them a
blocker: the plans facility — the flagship fix for the 2026-09-29 "no plans
facility at all" blocker — **refuses on every opencode pad that has a mounted
workspace**, which is the exact failure mode `2026-09-29-list-plans.md`
predicted before it shipped.

## What I verified as fixed (Resolution lines added to the original entries)

Recorded here for the session narrative; the Resolution lines themselves are
appended to the entries they belong to, per the log's rules.

| Original finding | File | Verified how |
|---|---|---|
| `config_get` leaks live secrets | `2026-09-27-tool-surface-sweep.md` | `gateway.auth`, `auth`, `channels.telegram.botToken` all `"[REDACTED]"` in **both** `config` and `configRaw`, plus `redacted: true` |
| `get_agent` returns the web token | same | `web: {…, "tokenConfigured": false}`, no `token` key |
| `settings_get` leaks password + `startCommand` | same | `authToken: ""`, `startCommand: "[redacted: web start command for port 7890]"` |
| `list_agents` advertises a phantom pad | same | 10 rows, `scope: "all"`, `agentsTotal: 10`; spot-opened `pad-picoclaw-asdsa` and both work-pls/proj spellings — every row resolved |
| Bare names fail with no hint | same | `get_agent {name: "opencode-proj"}` → the full `pad-opencode-proj` object |
| The dead-session error points at a tool that does not exist | same | `mission_session_relaunch` → `mission_session_dead: … mission_session_restart brings it back (this tool needs a LIVE pane)` — names a tool that exists |
| `workspace_*` trio cannot do their one job | same + `2026-09-29-list-plans.md` | `workspace_list`/`workspace_read` retired per the recorded decision; `workspace_write` now returns `ok/size/modified` and the file **was on disk** — but see finding 4 |
| `hostBrowsable` has no explanation anywhere | `2026-09-29-list-plans.md` | `workspaceMount.hostBrowseReason` now carries the sentence verbatim on every pad |
| Recipe 7 still advertises the dead trio | same | rewritten: *"There is deliberately NO browse tool… A refusal here is a POLICY decision about this PAD, not a missing capability"* |
| No plans facility in the surface at all | same | `plan_list`/`plan_write`/`plan_activity` exist and work end to end — with finding 2's caveat |
| `mission_projects` has no `project_id`/`name`/`folder` filter | `2026-09-29-project-progress.md` | `agentStatus` on every row; filters present; unfiltered call is a 1.5 KB summary |
| `mission_projects` inlines every session | same | nested rows behind `include_sessions` (default false) with a `hint` naming the flag |
| `origin: "human"` cannot be audited | same | `createdBy: "user:admin_…"` beside `origin` — see finding 5 |
| `recreate` silently destroys sessions | `2026-09-29-task-session-status.md` | `endedAt` + `endedBy` on every dead row; `recreate`'s own description now names `sessionsEnded` and `endedBy: "recreate"` |
| `last_seen_at` is frozen | same | **live control**: `13:43:47` → `13:45:13` → `13:45:23` across three reads of a working session |
| `get_agent` returns three null timestamps on a running pad | same | `created_at`, `updated_at`, `last_activity_at` all populated |
| `lines` does not scroll the screen tail | `2026-09-29-project-progress.md` | `lines: 30` vs `lines: 200` returned **different** screens; the 200-line read reaches further up the pane |
| The surface can never read a conversation | `2026-09-29-task-session-status.md` | `plan_activity` returned the real last user/assistant pair, `messageCount: 135`, `lastToolCall` and `lastActivityAt` |
| `exec` has no `cwd` | `2026-09-29-list-plans.md` | `cwd` + `requestedCwd` params; `exec {cwd: "/www2/paddock"}` landed there and the response echoed it |
| `networkFilter` / the `availableNetworks` cap | `2026-09-27-craftpip-status.md` | `networkFilter: "craftpip"` → `[]`, `availableNetworksSearchedAll: true`, `availableNetworksTotal: 0` |

**Still open from before:** `create_agent`'s `agent` enum still omits `claude`
(`["openclaw","opencode","picoclaw","hermes","codex"]`) while `help`,
`agent_commands {type:"claude"}` (full catalog returned), `list_agents`
(`pad-test-claude` running) and `mission_projects.supportedAgentTypes` all treat
it as first-class — unchanged since 2026-09-27, `2026-09-27-craftpip-status.md`.

## Findings

### The entire `task_*` family is gone and `help` never mentions it existed

- **Tool:** the whole `pad_*` surface (negative finding) + `help`
- **Severity:** blocker
- **What I asked:** re-verify the log's open findings. The log's biggest body of
  work — 7 findings in `2026-09-29-task-queue.md` plus extensions in three other
  files — is about eight tools that are no longer in my tool list.
- **What happened:** `task_submit`, `task_status`, `task_result`, `task_list`,
  `task_get_next`, `task_complete`, `task_priority` and `task_cancel` are all
  absent. I read `help` in full: the string "task" does not appear once. The
  Mission section still says *"There is no headless path: if you want to work,
  you work in a session"*, and the tool surface section lists
  Read/Control/Job-progress/Exec/Mission/**Plans** — no queue, and no note that
  one was there. The retirement is real and deliberate: plan 52's `## Status:`
  line, read through `plan_list`, says *"**The queue is gone;**"*, and plan 74
  (`74-task-lifecycle-and-done-detection.md`) is a design for a different task
  record. So the product knows. Only the MCP surface does not say so.
- **Why it hurts:** this log is the documentation a caller arrives with, and it
  spends four files teaching a queue that no longer exists. A reader — me,
  today — reaches for `task_submit`, finds nothing, and has no way to learn
  whether the tool is missing, renamed, gated behind a flag, or retired. The
  guide's remaining "no headless path" sentence reads as a **design rule** rather
  than the aftermath of a removal, so a caller who used to have a headless option
  concludes the product never had one. Nothing in the surface is broken; the
  surface is simply silent about the single largest change to it.
- **Fix:** one line in `help`, where the queue paragraph used to be: *"The task
  queue (`task_submit` and the seven tools beside it) was **retired**. There is no
  headless path; work happens in a Mission session or through the agent's own
  driver commands via `exec`."* And a `Resolution` line on each of the eleven
  task-queue entries saying **retired, not fixed**, so the history stays honest
  without a reader filing the same ticket again.
- **Resolution (2026-10-09, verified live):** the doc half is fixed. `help` now
  documents the family — recipe 15, *"Run a task as a loop (the `task_*` tools,
  when they are listed)"* — covering `task_submit { …, session_id }` binding,
  `task_pipeline_start`, `task_step_report`, `task_step_bug`, `task_step_commit`,
  `task_pipeline_status` (`{active, state, current_step, next_step, reason}`),
  `task_pipeline_stop`, and the refusal codes (`task_pipeline_no_session`,
  `task_pipeline_busy`, `task_step_claimed`, the session gates). And the tools
  are not gone after all: they are gated behind `PADDOCK_TASK_QUEUE=1`
  (46 registered / 31 visible with it on; 15 `task_*` hidden with it off — see
  [`2026-10-08-plan69-pipeline-proof.md`](2026-10-08-plan69-pipeline-proof.md)).
  So the surface is no longer silent about either the family or its gate.

### `plan_*` refuses on every pad whose workspace is a bind mount — the failure `list-plans.md` predicted

- **Tool:** `plan_list` (and `plan_write` / `plan_activity` by the same gate) +
  `settings_get` + `exec`
- **Severity:** blocker
- **What I asked:** verify the plans facility — the fix for "there is no plans
  facility in the surface at all".
- **What happened:** I ran `plan_list {agent}` across the fleet. It works on 4
  pads and refuses on 4, and the refusals are the opencode pads — the ones with
  the Mission projects:
  - `plan_list {agent: "pad-opencode-proj"}` → `MCP error -32600:
    plan_workspace_not_host_visible: The workspace of pad-opencode-proj is
    mounted from /www1, which the webui cannot reach on the host. Plans can only
    be kept for a PAD whose workspace is a folder the webui can see.`
  - Same for `pad-opencode-user1` (`/www2/user1`), `pad-proj2` (`/www1`),
    `pad-opencode-jake-man` (`/www2/vm-friends/instances/vm-jake/openclaw`).
  - Works, `count: 0`: `pad-openclaw-work-pls`, `pad-test-codex`,
    `pad-test-claude`. Works, **`count: 44`**: `pad-opencode-paddock-dev`,
    `plansFolder: "/workspace/plans"`.
  The refusal itself is *good* — clean, with the mount path named and a reason —
  and that is precisely the problem this log warned about.
  `2026-09-29-list-plans.md` → *"Every pad I sampled is `hostBrowsable: false`"*
  predicted it exactly: *"the plans feature ships, passes a smoke test against a
  fixture or a non-PAD path, and is dead on every real pad. The failure is also a
  **better** failure than today's, which means it is more likely to be shipped
  believing it works."* The 4 pads that work are the ones whose workspace is the
  driver's default folder inside the instance directory — i.e. the fixture. The
  one real repository pad (`paddock-dev`, `/workspace/plans`) works only because
  `/workspace` happens to be webui-visible on the host.
- **Why it hurts:** the plans facility exists to answer *"what has this project
  been worked on"*, and 4 of the 6 opencode pads — every pad carrying a real
  project — cannot keep a plan. A caller who writes plans on `pad-test-codex`
  and then asks the same question of `pad-opencode-proj` gets a clean, explained,
  permanent refusal. And the sharpest version of the split is invisible from the
  tool surface: `/www2/paddock/plans` is a **real, populated directory reachable
  inside `pad-opencode-proj`** (`exec {cwd: "/www2/paddock", command: "ls
  plans"}` → `01-ideas.md`, `20-health-check-driver-aware.md`, …) while
  `plan_list` on the very same pad refuses, and `plan_list` on
  `pad-opencode-paddock-dev` — a different pad, same host directory — returns all
  44. Same folder, same files, two answers, decided by which PAD you ask.
- **Fix:** store plans through the pad's own container path (`exec`-equivalent
  service call, or the same path `workspace_write` uses) rather than through the
  host file browser, and keep `hostBrowseReason` as the *reason it is nice* rather
  than the precondition. If the host path really is required for the web UI to
  show them, then either clear `hostBrowsable` for the pads whose workspace is
  meant to be browsable (the fix this same finding asked for on 2026-09-29), or
  state the constraint in `help` next to the Plans section so a caller learns it
  before writing their first plan.

### `plan_list {folder}` returns zero plans for the folder those plans live in

- **Tool:** `plan_list` (+ `mission_projects`)
- **Severity:** guessing
- **What I asked:** the question from `2026-09-29-project-progress.md` — what is
  the progress in the paddock project — following the surface's own recipe 14.
- **What happened:** recipe 14 says *"See what a project is WORKING ON:
  `mission_projects {folder}` for the project's folder → `plan_list {agent}`"*, and
  `plan_list`'s description adds that *"`folder` narrows the listing to one
  project for you. Plans FILES live in the pad workspace, so a plan is matched
  through the project of the conversation it is bound to; a plan whose session the
  page does not know cannot be attributed, and those are reported as
  `sessionUnattributed` rather than quietly dropped."* So I narrowed:
  `mission_projects {name: "paddock"}` → `folder: "/www2/paddock"` on
  `pad-opencode-proj`; then `plan_list {agent: "pad-opencode-paddock-dev", folder:
  "/www2/paddock"}` →
  `{"agent": "pad-opencode-paddock-dev", "plansFolder": "/workspace/plans",
  "folder": "/www2/paddock", "sessionUnattributed": 44, "count": 0, "plans":
  []}`.
  **Zero plans, and 44 of them reported as unattributed** — because every one of
  the 44 rows has `session: null`. Not one plan on this pad is bound to a
  conversation, so the documented project→plan bridge cannot attribute a single
  one of them.
- **Why it hurts:** `count: 0, plans: []` is the answer "this project has no
  plans", and `sessionUnattributed: 44` beside it is the answer "there are 44 and
  I cannot place them" — two contradictory answers in one small object, with
  nothing telling the caller that the second is the true one or why it happened.
  A caller asking the progress question and following the documented narrowing
  concludes the paddock project has done nothing. The un-narrowed
  `plan_list {agent}` returns all 44 with their `## Status:` lines and is a
  complete answer, so the narrowing parameter is the only thing standing between
  the question and its answer. The unattributed count is also not actionable: it
  does not say the plans predate the `session` frontmatter, or that binding is
  optional, or that `plan_write {session}` is how a plan becomes attributable.
- **Fix:** when a plan carries no `session`, attribute it by its own path/folder
  rather than dropping it from a `folder`-narrowed listing — or, if the folder
  genuinely cannot be attributed, say so in the response: `"narrowedBy": "session
  attribution only — 44 plans in this pad are unbound and are not shown; call
  plan_list {agent} to see them"`. And when `sessionUnattributed > 0`, make it the
  loud field rather than a counter next to a `count: 0`.

### `workspace_write` writes the agent's data dir, not the PAD's workspace

- **Tool:** `workspace_write` + `plan_write` + `get_agent` + `exec`
- **Severity:** guessing
- **What I asked:** is the dead write path fixed?
- **What happened:** partly, and the part that is fixed is a real fix.
  `workspace_write {name: "pad-openclaw-work-pls", path:
  "friction-verify-probe.txt", content: "probe line one\nprobe line two\n"}`
  returned `{"ok": true, "name": "friction-verify-probe.txt", "path":
  "friction-verify-probe.txt", "size": 30, "modified":
  "2026-09-29T13:45:44.177Z"}` — a real confirmation with a byte count and a
  timestamp, and `exec` found the file. The silent `{name, path}` no-op of
  2026-09-27 is gone. But the file landed at **`/root/.openclaw/friction-verify-probe.txt`**,
  and on that same pad `get_agent` reports `data_dir: "/root/.openclaw"` and
  `workspace_dir: "/root/.openclaw/workspace"`. So a relative `path` resolves
  against the **data dir**, one level above the workspace. Meanwhile
  `plan_write {agent: "pad-openclaw-work-pls", path: "zz-friction-probe.md"}` on
  the same pad landed at `/root/.openclaw/workspace/plans/zz-friction-probe.md` —
  the **workspace**. Two tools, the same parameter name, the same relative-path
  shape, two different roots on one pad. And `workspace_write`'s description
  calls it *"Write text content to a file in a PAD's **workspace**"* — on
  `pad-opencode-proj`, whose `workspace_dir` is `/www1`, it cannot write there
  at all: it refuses with `plan_workspace_not_host_visible`'s sibling reason, so
  the tool named for the workspace is gated on the agent folder and blind to the
  mount.
- **Why it hurts:** the tool's name, its description and the directory it
  actually uses are three different things, and the disagreement is only visible
  after a write plus a read-back. A caller writing `path: "plans/74-x.md"` gets a
  file in `…/.openclaw/plans/` and a separate `plan_write` of the same relative
  path gets one in `…/.openclaw/workspace/plans/`; the two never meet. And on the
  pads that actually have a mounted user workspace, the workspace-named writer is
  the one tool that cannot reach it. Minor, on top: the response's `name` is the
  **file's basename**, while the `name` I passed in was the **pad** — the field
  flipped meaning between input and output, which is the same collision
  `2026-09-29-task-queue.md` recorded for `task_submit`/`task_get_next`.
- **Fix:** resolve `workspace_write`'s relative `path` against `workspace_dir`
  (the same base `plan_write` uses) and say which one it is in the description;
  echo the pad under a different key than the file (e.g. `agent: <pad>`), the way
  every other tool in this surface already does. If writing the data dir is a
  deliberate second capability, it deserves its own name — `agent_file_write`.

### `plan_write`'s `abs` is a host path that does not exist inside the container

- **Tool:** `plan_write` (+ `exec`)
- **Severity:** guessing
- **What I asked:** where did the plan file actually land?
- **What happened:** `plan_write` returns `"abs":
  "/workspace/instances/pad-openclaw-work-pls/openclaw/workspace/plans/zz-friction-probe.md"`,
  and `plan_list` repeats it on every row (`plansFolder:
  "/workspace/instances/pad-openclaw-work-pls/openclaw/workspace/plans"`). Inside
  the container that path does not exist: `exec {command: "ls -la /workspace"}`
  → `ls: cannot access '/workspace': No such file or directory`. The same file is
  at `/root/.openclaw/workspace/plans/zz-friction-probe.md`. Every other path in
  the surface is marked or obviously container-side (`settings_get.workspaceMount.container`
  says `container`; `exec`'s response echoes the container `cwd` it used), and
  `get_agent` is careful to carry both — `workspace_root:
  "/workspace/instances/pad-opencode-proj/opencode"` (host) beside `workspace_dir:
  "/www1"` (container). `abs` carries the host one with no marker at all, and
  `abs` is the field a caller reaches for when it wants to `cat` the file it just
  wrote.
- **Why it hurts:** the cost is one failed `exec` plus a moment of "did the write
  lie to me?" — and that moment is expensive on the plans facility specifically,
  because `plan_write` is the newest write path in the surface and its whole
  value is that it reaches disk. I confirmed it did, but only by searching the
  container filesystem rather than using the path the tool gave me.
- **Fix:** return both — `"abs": <host path>, "containerPath":
  "/root/.openclaw/workspace/plans/…"` — or rename to `absHost` / `absContainer`
  and say which side each is in the description. One word in the description
  ("`abs` is the HOST path; inside the PAD the same file is under the driver
  workspace") is the cheapest version that removes the guess.

### `createdBy` is on some session rows, absent on others, and in no description

- **Tool:** `mission_sessions` (list mode)
- **Severity:** guessing
- **What I asked:** who started these sessions?
- **What happened:** in one `mission_sessions {project_id, limit: 6}` response,
  rows `msn_084db4003f95f5ed`, `msn_b440733a8f26f6d2`, `msn_aefd65cf2afe4c90` and
  `msn_aac88d72b8f5b16c` all carry `"createdBy": "user:admin_1784916138567"`, and
  rows `msn_a2fda77c73f2090b` and `msn_dc493ea9d87313e7` carry **no `createdBy`
  key at all** — same call, same project, both `origin: "human"`. The two without
  it are the older rows. The design is right and the recorded Resolution says so
  deliberately (*"The field is emitted only when stamped … an invented
  `createdBy` is worse than an absent one"*), but `mission_sessions`' own
  description never mentions `createdBy`. It is described thoroughly — `live`,
  `busy`/`busyKnown`, `kind`, `state`, `endedAt`/`endedBy`, `blockedOn`,
  `screenFrom` — and the one field a caller will branch on to answer "was this
  me?" is the only one with no stated contract.
- **Why it hurts:** absence is the honest answer here, but a caller cannot tell
  *absent because nobody recorded it* from *absent because it was never stamped*
  from *absent because this row predates the field*, and the three lead to
  different conclusions about a session's provenance. The whole point of the fix
  was to stop a caller having to trust their own memory of their own calls; for
  the oldest rows the surface still requires exactly that.
- **Fix:** one sentence in `mission_sessions`' description — *"`createdBy` is
  `key:<id>` or `user:<id>`; it is **absent** on rows started before it was
  recorded, which is not the same as `human`."* Optionally emit
  `createdBy: null` rather than omitting the key, so the shape is uniform.

### `plan_activity`'s `lastMessage.user` can be a harness reminder, not the human

- **Tool:** `plan_activity`
- **Severity:** guessing
- **What I asked:** what is this conversation doing?
- **What happened:** `plan_activity {agent: "pad-opencode-proj", session_id:
  "ses_f12e37447ffeMJASrRjA1vCPWP"}` is a genuinely good answer — `messageCount:
  135`, `store.available: true`, `matched: "exact"`, a real assistant message with
  a timestamp, `lastToolCall: {tool: "bash", status: "completed"}`,
  `lastActivityAt`. But `lastMessage.user` was:
  `{"role": "user", "text": "<system-reminder>The user has changed the current
  working directory to \"/www2/paddock\". This is still the same project but at a
  possibly new location; take this into account when working with any files from
  now on.</system-reminder>", "at": "2026-09-29T13:43:56.803Z"}`
  — a `<system-reminder>` the harness injected, tagged `"role": "user"`. The
  human's actual last message is not shown anywhere in the payload; the real
  exchange is 9 minutes older and only its **reply** is here.
- **Why it hurts:** the field is labelled `role: "user"` and the tool is billed as
  *"the last chat and its timings"* — so "what did the human last say to this
  agent" reads `lastMessage.user.text` and gets a cwd-change notification. For
  the question this tool exists to answer ("is this session working on my thing,
  and did it just get a new instruction?") that is the wrong half of the
  conversation. `lastActivityAt` is also taken from the reminder
  (`13:43:56`), so a caller using it as "when did the human last engage" is
  reading the harness's own timestamp.
- **Fix:** keep system-injected turns out of `lastMessage.user` (or tag them
  `role: "system"` / add `synthetic: true`), and expose both — `lastUserMessage`
  for the last human turn and `lastMessage` for the literal last record — so
  "the human engaged at" and "the session last did something at" are two
  numbers instead of one ambiguous one.

### The `workspace_write` refusal prints its own explanation twice

- **Tool:** `workspace_write`
- **Severity:** noise
- **What I asked:** write a file to a pad whose workspace is not host-browsable.
- **What happened:** `workspace_write {name: "pad-opencode-proj", path:
  "friction-probe-verify.txt", content: "probe\n"}` returned, verbatim:
  `Host file browser is not available for this agent — workspace is mounted from
  a folder outside both this PAD's folder and the project root, so the webui
  cannot reach it on the host. Use the container workspace while the agent is
  running.. Use the container workspace while the agent is running.`
  The doubled `..` is the seam: the reason string taken from `hostBrowseReason`
  already ends with *"Use the container workspace while the agent is running"*,
  and the handler appends the same sentence again.
- **Why it hurts:** small, but this is the refusal that replaces the silent
  no-op the log spent three sessions on, so it is the message a caller will read
  most often when the policy bites. A doubled sentence reads like a
  concatenation bug in the very tool whose job is to be trustworthy, and it makes
  the message longer for no gain.
- **Fix:** append the fallback sentence only when `hostBrowseReason` does not
  already contain it — or drop the suffix from `hostBrowseReason` and keep it in
  exactly one place.
- **Re-observed (2026-10-09), unchanged:** `workspace_write {name:
  "pad-opencode-proj", path: "PIPELINE-REL/test.txt", content: "hello"}` returns
  the identical doubled message verbatim, `..` seam and all. The refusal also
  still names the *capability* (host file browser unavailable) without naming
  `exec` as the working fallback — see
  [`2026-10-08-plan69-pipeline-proof.md`](2026-10-08-plan69-pipeline-proof.md).

## Extensions to existing findings

### `exec` rejects an empty command, but still false-greens on a whitespace-only one

- **Tool:** `exec`
- **Original entry:** "`exec` accepts an empty command and reports success" —
  [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md),
  severity `noise`, **no Resolution line**.
- **Extension (2026-09-29):** half fixed, and the fixed half mislabels itself.
  `exec {name: "pad-openclaw-work-pls", command: ""}` now returns
  `Unable to connect. Is the computer able to access the url?` — not `{ok: true}`,
  so the false green is gone for the empty string. But that message reads as an
  MCP transport failure, and I could not tell a client-side hiccup from a
  server-side refusal without immediately re-calling with `command: "true"` to
  prove the connection was alive. `exec {command: "   "}` (whitespace only) still
  returns `{"ok": true, "cwd": "/root", "requestedCwd": null, "exitCode": 0,
  "stdout": "", "stderr": ""}` — the original false green, unchanged, for the
  case the original fix named alongside it (*"reject an empty/whitespace-only
  `command`"*).
- **Why it hurts:** the finding's cost was that a verification command which
  fat-fingers gets a clean confirmation for work that never ran, and that
  half of it is still true. The new half trades one confusion for another: an
  empty command now produces an error about the network, so a caller debugging a
  real connection problem sees this message too and has one more thing to rule
  out.
- **Fix:** one `if (!command?.trim()) throw` at the top of the handler, before
  anything else — that closes the whitespace case and gives the empty case a
  message about the command instead of the transport.

### `settings_get {networkFilter}` returns the whole pad, and `availableNetworksTotal` changes meaning under it

- **Tool:** `settings_get`
- **Original entry:** "`availableNetworks` is capped and the cap hides the
  container a caller asked about" —
  [`2026-09-27-craftpip-status.md`](2026-09-27-craftpip-status.md), **Resolution
  applied (plan 61)**.
- **Extension (2026-09-29):** the fix works — `networkFilter: "craftpip"` searched
  all peers and reported `availableNetworks: []`, `availableNetworksTotal: 0`,
  `availableNetworksSearchedAll: true`, which answers "is craftpip a container"
  (no, it is not) in a way the cap never could. Two costs the fix did not
  address. (1) The response is the **entire settings payload** — the same ~200
  lines as the unfiltered call, including `workspaceDevcontainer`, the web block
  with `actualPorts`, `postCreate` and all — for a lookup whose answer is one
  line. The parameter narrows one array and nothing else. (2)
  `availableNetworksTotal` reads `43` unfiltered and `0` filtered, so the field
  means "total in the current result" and not "total peers on this host"; a
  caller reading `availableNetworksTotal: 0` next to a non-matching filter can
  conclude the host has no peer containers at all. `availableNetworksSearchedAll`
  is a new field that appears in no description or recipe.
- **Why it hurts:** `settings_get` is billed as *"the ONE read tool — full
  picture before any change"*, so a full payload is defensible; but the caller
  who reached for `networkFilter` did not want the full picture, they wanted one
  name, and the `total` field now undercuts them in the same object.
- **Fix:** have `networkFilter` return a compact `{agent, filter,
  searchedAll, matches}` object instead of the full settings, or add
  `settings_get {sections: "networks"}`. And rename the filtered case —
  `availableNetworksMatching` vs `availableNetworksTotal` — so the two cannot be
  read as one number.

### The log's own `README.md` still describes a surface that no longer exists

- **Tool:** the friction log itself (`README.md` + four superseded entries)
- **Severity:** guessing
- **What I asked:** find out what had been fixed.
- **What happened:** the folder holds 10 session files; `README.md`'s Entries
  list names 6 of them and stops at `2026-09-29-task-queue.md`. The four missing
  are `2026-09-29-exec-ls.md`, `2026-09-29-list-plans.md`,
  `2026-09-29-project-progress.md` and `2026-09-29-task-session-status.md` — the
  four most recent and the four with the most `Resolution` lines. The
  `list-plans` bullet also still leads with *"there is no plans facility in the
  surface at all"* and ends by calling `workspace_list` dead, and the
  `task-queue` bullet still advertises the queue as a live part of the surface.
- **Why it hurts:** this log's value is that a finding survives its fix, so a
  reader arrives through the entry point and is told by it that five things are
  broken that are not. The cost lands on exactly the reader the log is for.
  `AGENTS.md` says *"I do not write an index; the folder listing is the index"* —
  and then an index exists, is half-maintained, and is the first thing read.
- **Fix:** either delete `README.md` and let the folder listing be the index, or
  list all 10 files and make each bullet end with its status. The second is
  better: the index is also where "what is still open" should live, and today
  nothing in the folder says that in one place.

## Context: the fleet as read (not findings)

10 pads, 8 running, 2 exited (`pad-opencode-aic`, `pad-opencode-paddock-dev`),
`scope: "all"` — down from 13-14 on 2026-09-29 earlier and 14 on 2026-09-27. 6
Mission projects, 37 sessions across them, 1 live (the user's own, in
`/www2/paddock`), and every dead row now carries `endedAt` + `endedBy: "gone"`.
Four dead rows share `endedAt: "2026-09-29T13:03:00.665Z"` to the millisecond,
which is the documented meaning (*"the first time we LOOKED and it was already
gone"*) and is honest — but it does mean a mass death caused by a recreate is
recorded as `gone` rather than `recreate` for every row the recreating caller did
not hold open, so the attribution this log asked for only lands on the sessions
that happened to be visible at the moment.

## What I left behind

- One probe plan, `zz-friction-probe.md`, on **`pad-openclaw-work-pls`** at
  `/root/.openclaw/workspace/plans/zz-friction-probe.md` (host:
  `/workspace/instances/pad-openclaw-work-pls/openclaw/workspace/plans/`), with
  `## Status: probe — verifying plan_write, not real work`. Kept deliberately as
  the evidence for finding 3's `workspace_write` path test and so the next
  session can read a plan back. Delete with `rm` in that pad; it is not archived.
- The `workspace_write` probe file was removed (`rm` inside the pad, verified
  gone). Nothing else was written, no session was started, typed into, restarted
  or closed, and no pad was created, recreated, stopped or deleted.

## What held up well

`plan_activity` is the single best thing in this surface today and it did not
exist two days ago. It answered a question nothing else could — "what is this
conversation actually doing" — from the agent's own store, on a live session, in
one call, with `messageCount`, a tool-call status, and `store.reason` to say
when it cannot answer. The `## Status:` line that `plan_list` lifts onto every
row is the thing this whole log kept asking for: 44 rows of `In progress — 8/10
phases built`, `Draft — 0/4`, `Complete — 5/5, verified`, each one the record of
a piece of work, in one read. `health` on the broken `paddock-dev` is still
exemplary — it named the exit code, the missing door, the two unbound ports, and
`staleBinding: true` with *"the configured peer IS running and needs nothing.
Recreate to rebind"* — which is precisely the explanation
`settings_get.networkHealth` still cannot give (plan 66, open, 0/4). And the
refusals are uniformly good: `mission_session_dead` on both a relaunch and a
close, each naming the right tool and the state that caused it, with nothing
typed and nothing changed. A surface that says no clearly is worth more than one
that says yes vaguely, and this one has learned that.

## See Also

- [`2026-09-29-list-plans.md`](2026-09-29-list-plans.md) — the plans blocker this
  session re-tested, and the `hostBrowsable` prediction that finding 2 confirms.
- [`2026-09-29-project-progress.md`](2026-09-29-project-progress.md) — the
  progress question finding 3 re-runs, and the `last_seen_at` / screen-tail
  findings verified fixed above.
- [`2026-09-29-task-queue.md`](2026-09-29-task-queue.md) — the retired queue
  behind finding 1.
- [`2026-09-29-task-session-status.md`](2026-09-29-task-session-status.md) — the
  conversation-read blocker that `plan_activity` closes.
- [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) — the
  secret, phantom-row and naming fixes re-verified above; the empty-command noise
  entry extended.
- [`2026-09-27-craftpip-status.md`](2026-09-27-craftpip-status.md) — the `claude`
  enum gap, still open and unchanged since 2026-09-27.
