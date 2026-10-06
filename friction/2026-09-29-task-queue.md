# Chat Test — "Add a task to run infinite queue in paddock"

**Date:** 2026-09-29
**Mode:** chat test (MCP only — no shell, no API, no backend code). No
deviations.
**Task:** "in paddock is the queue compelete?" → "add a task to run infinte
queue in paddock" → "like i want some like of a task queue?" — i.e. read the
task queue, then build a real one.

Outcome: the queue was drained and I built a 3-task pool, which worked. **No
blockers this session** — seven new `guessing` findings, one `noise`, and the
sharpest one is a vocabulary collision: the parameter `name` means two different
fields depending on which tool you pass it to. "Infinite queue" turns out not to
be a feature, a mode, or a flag anywhere in the surface.

I did **not** drain the pool I created, on purpose — the only tool that can pull
from the pool is the same tool that claims from it. Findings 2 and 3 are that
sentence, written down.

**Resolution since (2026-09-29 — every finding in this file is RETIRED, not
fixed):** all eight `task_*` tools — `task_submit`, `task_status`, `task_result`,
`task_list`, `task_get_next`, `task_complete`, `task_priority`, `task_cancel` —
are gone from the MCP surface. The retirement is deliberate: plan 52's
`## Status:` line, read through `plan_list`, says *"**The queue is gone;**"* and
plan 74 (`74-task-lifecycle-and-done-detection.md`) is a design for a different,
issue-shaped task record. So findings 1-7 below and the three extensions are
kept for history and should not be re-filed as open defects. **What is still
missing is a note in `help`** — the string "task" does not appear in the guide
once, so a caller arriving from this file finds eight tools absent and no way to
learn whether they were retired, renamed or gated. That gap is filed as a new
blocker in [`2026-09-29-recheck-friction-log.md`](2026-09-29-recheck-friction-log.md)
finding 1, along with the one related fix that did land: `exec` now has a `cwd`
parameter.

## Findings

### `task_get_next {name}` and `task_submit {name}` write two different fields under one parameter name

- **Tool:** `task_submit` + `task_get_next` + `task_list`
- **Severity:** guessing
- **What I asked:** "add a task to run infinite queue" — file work, then find out
  who is supposed to run it.
- **What happened:** both tools take a parameter called `name` and neither says
  they are unrelated. `task_submit {name: "<pad>"}` writes the task's
  `agent_name` (the push target) and starts it. `task_get_next {name: "<pad>"}`
  writes the task's `claimed_by` (the pull worker) and claims it. The list then
  shows both fields, side by side, on every row:
  - `d44f9cf2…` → `"agent_name": null, "claimed_by": "pad-opencode-user1"`
  - `9c494bc2…` → `"agent_name": "pad-opencode-proj", "claimed_by": null`
  Nothing in either description says `name` is a different concept in each, and
  `task_list {name}` filters on **both at once** — *"optionally only those
  addressed to or claimed by one PAD"* — so one filter silently spans two
  different meanings. A third mode exists: `task_submit {name, enqueue: true}`
  sets `agent_name` **without** starting anything (*"it stays pending for
  task_get_next"*), so an addressed task can be picked up by a worker, leaving a
  row where `agent_name` and `claimed_by` are both set and mean different routes.
- **Why it hurts:** asked "is the queue complete", I had to first work out which
  of two pad-named columns a caller was looking at, and the answer changes what
  the row means. A row with `agent_name` set and `claimed_by: null` may be a
  push task that failed, or an enqueued task no worker has reached — opposite
  next actions (investigate vs. wait) from an identical row. The two modes are
  also spelled the same way in prose — `name` in a `task_submit` means "run it
  here", in a `task_get_next` means "who is asking" — and a caller composing a
  worker loop will pass the pad name to both and reasonably assume it means the
  same thing.
- **Fix:** rename the claim side to what it is (`worker` on `task_get_next`,
  `claimedBy` on rows) so the two cannot be read as one field, and have
  `task_list` expose a `route: "push" | "enqueued" | "pull"` derived from the two
  — that single field answers "who runs this, and is it already running?" without
  the caller cross-referencing anything.

### `task_list` sorts newest-first, which is the exact reverse of the order the queue is served in

- **Tool:** `task_list` + `task_priority` (description)
- **Severity:** guessing
- **What I asked:** what is in the queue I just filled?
- **What happened:** I filed three pool tasks at priorities 0, 5 and 10.
  `task_list` returned them CHARLIE (10) → BRAVO (5) → ALPHA (0), top to bottom.
  `task_priority`'s description says the opposite: *"Re-order the queue:
  `task_get_next` serves lower numbers first."* So the list presents the queue
  backwards — the task that will be served first is the **last** row. The list's
  own description explains the sort as *"List recent tasks, newest first"*, so
  recency is a hard-coded default that priority never overrides, and all three
  rows share a `created_at` of `2026-09-28 19:49:28`, meaning the order among
  them is arbitrary and merely happens to be the reverse of the service order.
- **Why it hurts:** the list is the only safe way to look at the pool, and a
  caller triaging it top-down reads it in reverse priority — picking up the
  lowest-priority work first. When recency and rank disagree, nothing marks which
  one the list is sorted by, and the tie here (identical timestamps) means the
  ordering carries no information at all while looking authoritative.
- **Fix:** sort pending tasks by `priority` ascending and add a `truncated`
  marker, or at minimum return a `nextUp: <task_id>` field naming the task
  `task_get_next` would serve, so the list cannot be misread as the work order.

### The only tool that reads the pool is the tool that consumes it, and the list has no count

- **Tool:** `task_get_next` + `task_list`
- **Severity:** guessing
- **What I asked:** "in paddock is the queue compelete?"
- **What happened:** to answer it I called `task_list {limit: 200}` and got the
  same 4 rows as `limit: 50` — all terminal, nothing `pending`, so the queue
  read as drained. But that is an *absence of evidence*, and nothing in the
  response lets me close it:
  - There is no `total` and no `truncated` on `task_list`, so I cannot tell 4
    from 400, and I cannot tell an empty queue from a filtered one. The
    description warns only that *"Rows are scoped to what your key may see"*.
  - There is no `status` filter, so I cannot ask the pool-only question
    ("anything pending?") without pulling every terminal row into context.
  - The tool that *would* settle it is documented as mutating: *"This mutates
    state (the task becomes `running`), so read-only keys cannot use it."* It
    returns `{ task: null, queueEmpty: true }` when there is nothing — a genuine
    answer, obtained only by being willing to consume a task.
  So I verified the per-pad scoping instead, calling `task_list {name}` on
  `pad-opencode-proj` (1 row) and `pad-proj2` (0 rows) and confirming both were
  strict subsets of the global list. That is three extra calls to substitute for
  the one field that would have answered the question.
- **Why it hurts:** "is the queue complete" is the first question a user asks
  about a queue, and the surface offers no way to answer it that does not change
  it. The cost is not just the calls — it is that the honest answer is always
  "nothing pending *in what I can see*", and there is no signal telling a caller
  which kind of answer they are holding. This is the identical gap the
  `availableNetworks` list had, and it was fixed on 2026-09-27 with
  `availableNetworksTotal` + `availableNetworksTruncated` (see
  [`2026-09-27-clone-proj.md`](2026-09-27-clone-proj.md)); the same two fields
  are conspicuously absent from `task_list`, `mission_projects` and
  `mission_sessions`.
- **Fix:** add `total` + `truncated` to `task_list` (and the two Mission list
  tools), plus a `status: "pending"` filter. That makes "is the queue complete"
  one call, and it is a fix already proven in this codebase.

### A pool task is inert, and nothing in the submit response hints that

- **Tool:** `task_submit`
- **Severity:** guessing
- **What I asked:** add a task to the queue.
- **What happened:** all three submits returned
  `{"ok": true, "mode": "pool", "task": {… "status": "pending", "pid": null,
  "claimed_by": null, "started_at": null, "last_output_at": null, …,
  "created_by": "admin_1784916138567"}}`. Three tasks are sitting in the pool and
  **none of them will ever run**, because the pool is passive: a task is only
  picked up when some pad independently calls `task_get_next`. The guide says so
  only in passing — *"a worker PAD then claims it"* — and the submit response
  carries no `pendingAhead`, no `queueLength`, and no count of pads currently
  polling. A file succeeded; a run did not start, and the response is identical in
  both cases.
- **Why it hurts:** a caller who fills the pool and walks away has handed work to
  a black hole and got three clean confirmations. The only way to know whether
  anything will ever claim it is to claim it yourself — which defeats the point
  of queueing it. This is the "mutation with no confirmation" shape, and it is
  worst exactly where a queue is supposed to be safe.
- **Fix:** have `task_submit` return the queue's state with the file —
  `queuedAt: <position>`, `queueLength: <n>`, `workersPolling: <n>` (0 being the
  one that matters) — so `ok: true` means "a worker will pick this up", not just
  "it was written down".

### An errored task has no retry, and the error row carries nothing that invites one

- **Tool:** `task_submit` + `task_list` + `task_status` (and the absence of any
  retry tool)
- **Severity:** guessing
- **What I asked:** re-run the work that died — the two IP-address tasks.
- **What I happened:** the queue's four prior tasks include two `error` rows, and
  the surface has no way to re-run either one. There is no `task_retry`; the
  whole task family is `task_submit` / `task_status` / `task_result` /
  `task_list` / `task_get_next` / `task_complete` / `task_priority` /
  `task_cancel`. Re-running means hand-writing a fresh `task_submit` prompt from
  scratch, and the failed row keeps no link to its replacement, so nothing
  prevents the same prompt being filed three times, or a duplicate going unnoticed
  because the original error row is not marked as superseded. The error row also
  has nothing on it that says a retry is even possible: no `attempt` count, no
  `retryable` flag, no `lastAttemptAt`.
- **Why it hurts:** "it failed" is the one state a caller always wants to move
  out of, and the queue is a dead end there. A caller has to reconstruct the
  original prompt by hand — and since `task_list` truncates prompts mid-word with
  no marker (already logged in
  [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md)), the
  reconstruction is from a clipped string. So the one task in the queue worth
  re-running is the one whose prompt I can only read three-quarters of.
- **Fix:** add `task_retry {task_id}` that re-files the identical prompt as a new
  task and marks the old row `supersededBy: <new id>` with an `attempt` count on
  both, so duplicates and repeated failures are visible instead of silent.

### `timeout` caps a task at one hour and the guide never says what a timeout does

- **Tool:** `task_submit` + `help`
- **Severity:** guessing
- **What I asked:** "add a task to run infinte queue" — a task that keeps
  working.
- **What happened:** the request is not expressible, and the reason is worth
  recording because it is a schema bound doing silent work. `timeout` is
  *"Kill the task after this many ms (default 600000)"* with `maximum: 3600000` —
  so no task can outlive one hour regardless of intent, and nothing in the
  description says what "Kill" leaves behind. Every other long-running operation
  in this surface has a documented answer to "my call timed out, what now?"
  (`job_status` for create/recreate/update; *"a timed-out call does NOT cancel
  the work"*). The task family has none, and the two observed terminal shapes
  don't settle it either: one task sat `error` / `exit_code: null`, another
  `error` / `exit_code: 1` after 2 seconds. A caller cannot tell whether a
  timeout kills the process, marks the row `error`, or leaves an orphan running
  inside a pad — and the last of those is the expensive one. Separately, the
  guide's own pull recipe is *"repeat until `queueEmpty`"* — terminating by
  design, with no flag to change that and no phrase anywhere in `help` matching
  "infinite".
- **Why it hurts:** the request I was given is a reasonable thing to want and the
  surface's answer is an undocumented cap. A caller who files a long task at the
  1h maximum has no idea what state it will be in afterwards, and — as the
  findings above show — the only way to find out is to leave the task and check
  later, against a `task_status` that will not distinguish "timed out" from
  "crashed".
- **Fix:** document the timeout's aftermath in the description (*"on timeout the
  task is marked `error` with `result_summary: "timed out after Nms"` and the
  process is killed"*) and add a `timedOut: true` flag on the row, so a caller can
  tell a timeout from a crash without reading stderr. If long-running work is a
  real use case, a sentinel (a task that re-files itself and exits) is the honest
  way to express it, and the description should say so.

### `created_by` is returned by `task_submit` and omitted from every `task_list` row

- **Tool:** `task_submit` + `task_list`
- **Severity:** guessing
- **What I asked:** whose work is in this queue?
- **What happened:** the submit response carries
  `"created_by": "admin_1784916138567"`. The `task_list` row for that same task
  does not — its fields are `id`, `status`, `agent_name`, `claimed_by`,
  `priority`, `prompt`, `exit_code`, `created_at`, `finished_at`. The four
  pre-existing tasks in the queue therefore have **no visible owner at all**, and
  I could not attribute any of them.
- **Why it hurts:** a shared pool is multi-tenant by construction, and authorship
  is the first question about a row someone else filed — especially for the two
  `error` rows, where the useful next step is "ask whoever filed this". The data
  exists one tool away in the write path and is simply not carried into the read
  path, so the answer to a routine question costs a submit per task.
- **Fix:** include `created_by` in `task_list` rows (and in `task_status`, which
  also omits it).

### Raw ANSI escapes are embedded in `task_result`'s `stderr` field

- **Tool:** `task_result`
- **Severity:** noise
- **What I asked:** read the failure reason off the errored task.
- **What happened:** the string is
  `"\u001b[91m\u001b[1mError: \u001b[0mFailed to change directory to /root/.opencode/workspace\n"`
  — literal SGR colour codes inside a JSON field, un-stripped.
- **Why it hurts:** minor, but it is the one field carrying the only real
  diagnosis of a failed task, and a caller string-matching it for `Error` or
  passing it to a consumer downstream has to strip escapes first.
- **Fix:** strip ANSI SGR sequences from captured `stdout`/`stderr` before
  returning them (or offer a `raw: true`).

## Extensions to existing findings

Two things I hit tonight were already logged on 2026-09-27 and I confirmed them
rather than duplicating them. Extending the original entries per the log's rules.

### Re-observed, still unfixed: the `/root/.opencode/workspace` cwd failure

- **Tool:** `task_submit` + `task_result`
- **Original entry:** "task_submit runs in the driver-default folder, which the
  pad does not have" —
  [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md),
  severity `blocker`, **no Resolution line**.
- **Extension (2026-09-29):** the same task, `2dfe7cf9-53e5-4608-8762-35e8adf7945a`
  on `pad-opencode-user1`, is still in the queue as a permanent `error` row with
  the identical stderr. Two days on, the defect is not only unfixed but has
  *accumulated* — every submit to a custom-workspace pad leaves a dead row behind
  that no tool can clear, and the queue's contents (2 of 4 rows are this one bug)
  now misreport the fleet's health. The proposed `task_workspace_missing` refusal
  would turn each of these into a non-row.
- **Extension (2026-09-29):** the guide is still asserting the false behaviour —
  *"`opencode run --format json --dir <workspace>` — the PAD's own workspace,
  never the container root"* — recorded as false-statement 2 in
  [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md). A caller
  reading it today will still submit to `pad-opencode-user1` with confidence.

### `error` is overloaded across two unrelated causes, which is why the queue is unreadable at a glance

- **Tool:** `task_status` + `task_result` + `task_list`
- **Original entry:** "A webui restart voids a running task, and `error` +
  `result: ""` hides work that succeeded" —
  [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md),
  severity `guessing`.
- **Extension (2026-09-29):** a third shape, from the queue's other error row.
  Both rows read `status: "error"` and nothing else in `task_list`:
  - `2dfe7cf9…` — a real crash: `exit_code: 1`, `result_summary: ""`, cause in
    `stderr`.
  - `9c494bc2…` — never ran: `exit_code: null`,
    `result_summary: "orphaned by webui restart"`, `stderr` empty.

  So one status word covers a process that died, a run that was cut short
  mid-flight (the original finding — its `stdout` holds a complete answer the
  tool never parses), and a task killed by an infrastructure restart. The three
  need three different responses — fix the cwd, parse the output, re-file the work
  — and `task_list` presents them identically. `exit_code` is the only
  discriminator and it is `null` in two of the three, so a caller scanning the
  list cannot even sort them. The entry's original fix (a distinct `orphaned`
  state) covers this; adding `exitCodeKnown` or a `cause: "crash" | "orphan" |
  "incomplete"` field would make the list self-describing without a per-task call.

## Queue state as left (context, not findings)

13 pads, 10 running, 3 exited — unchanged from
[`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md). All
four pre-existing tasks were from that session's IP-address work; the two that
errored are the two failure modes above.

**Left behind by me: three `pending` pool tasks, deliberately unclaimed** —
ALPHA `e589c996-b6af-4375-90ab-f4d14c5a0f40` (priority 0), BRAVO
`3411ea6a-c714-4309-adc5-df2884259112` (5), CHARLIE
`a0404465-9bd5-49c2-8ee2-b0b983b42c76` (10). They are no-op prompts (reply with
one word) and cost nothing until a worker calls `task_get_next`, of which
nothing is currently polling. They are still in the pool, not drained — see
finding 3 for why I could not check that without consuming one.

## What held up well

The pool happy path is correct and I want that on record, because the findings
above are about everything *around* it: three submits at distinct priorities all
landed `pending` in `mode: "pool"` with `pid`, `started_at` and `claimed_by`
consistently `null` — the "has not run yet" state is unambiguous at the row level
even though the list never says so in words. The `task_submit` response is also
the richest in the family: it returns the full task object with `created_by`,
`last_output_at` and `stdout`/`stderr` slots, which is why filing a task is
genuinely pleasant even though observing the queue is not. Per-pad scoping on
`task_list` also checked out — both sampled pads returned strict subsets of the
global list, so the filter is a true narrowing and not a second query with its own
view.

## See Also

- [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md) — the
  cwd blocker and the orphan finding extended above.
- [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) — the
  `task_list` prompt truncation, `task_complete` claiming a never-claimed task,
  and the `availableNetworks` total/truncated fix that finding 3 asks to reuse.
- [`2026-09-27-clone-proj.md`](2026-09-27-clone-proj.md) — the resolved
  `total`/`truncated` pattern, and the fix shape for finding 3.
- [`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md) — the
  session that filed the four tasks in this queue, and the one that recorded being
  told about a session named "starting infinite queue" that did not exist.
