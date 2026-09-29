# Chat Test — "what's going on now, what tasks?", and why 28 of 29 sessions are dead

**Date:** 2026-09-29
**Mode:** chat test (MCP only — no shell, no API, no backend code). No
deviations.
**Task:** "hi whats going on now what tasks ?" — i.e. read the task queue and the
session board. Mid-session the user supplied the missing explanation: *"its
default i recreated the agent so its sessions stopped."*

Outcome: the queue is unchanged from the 19:49 session earlier today, and the
board is almost entirely dead — 28 of 29 sessions `live: false`. The user's
explanation is **correct and is not in the data anywhere**: no tool records why a
session ended, when, or that `recreate` will end it. The sharpest result of the
session is a **correction**: two findings I wrote in the last 24 hours are wrong
about `mission_sessions` / `mission_projects`, and one of them sent me looking
for a session that was there all along.

## Findings

### `recreate` silently destroys every session on the pad, and no tool, description or response says so

- **Tool:** `recreate` (description) + `mission_sessions` + `mission_projects`
- **Severity:** guessing
- **What I asked:** "what's going on now what tasks?" — read the board and see what
  is in flight.
- **What happened:** 28 of 29 sessions report `"live": false`. Every project
  header agrees: `paddock` `sessionCount: 11, liveCount: 0, openCount: 0`;
  `schlorp` `sessionCount: 10, liveCount: 0, openCount: 0`;
  `craftpip` `sessionCount: 2, liveCount: 0, openCount: 0`;
  `root` `sessionCount: 1, liveCount: 0, openCount: 0`;
  `friction-probe` `sessionCount: 1, liveCount: 0, openCount: 0`; and `test`
  `sessionCount: 4, liveCount: 1`. The one live row is this session. So a pad
  that a day ago carried four projects of work now carries one live session and
  twenty-eight tombstones.
  The cause is known to the operator and to nobody reading the API. `recreate`'s
  description is a wall of mount, port, SSH and web options, and the words
  *session* and *tmux* do not appear in it. A session row carries `created_at`
  and `last_seen_at` and **no** `ended_at`, `exit_reason`, `state` or `dead`
  field — `live: false` is the whole story. So the sequence a caller sees is:
  call `recreate`, get `{ok: true}`, and on the next board read find every
  conversation on that pad gone, with no field that distinguishes "this session
  ended because its container was replaced" from "this session exited normally
  hours ago" from "this session was killed by someone else's `task_cancel`".
- **Why it hurts:** `recreate` is billed as the safe, reversible, everything-survives
  call — its own description says *"Config/data live in bind mounts, so they
  survive"*, and `help` pairs it with *"The old container stays up through the
  build and is only swapped at recreate"*. That is true of files and false of
  sessions, and the sentence a caller would quote back is the one that is wrong.
  A manager about to recreate a pad to fix a network peer (exactly the case in
  [`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md)) has no
  way to know it is about to drop every live conversation, and no count to check
  against afterwards. The work is recoverable only if each session still has an
  `agent_session_id` to resume — and 8 of the 29 have `agent_session_id: null`,
  so those are gone for good.
- **Fix:** two lines. (1) In `recreate`'s description, say plainly: *"This replaces
  the container. tmux sessions on the PAD do not survive it — they are listed in
  the response as `sessionsEnded: [<session_id>, …]` so you can warn first."*
  (2) Have `recreate` report what it took, and have `mission_sessions` carry a
  terminal `state: "dead"` with `endedAt` + `endedBy: "recreate" | "exit" |
  "unknown"`. A caller can then ask "what did that recreate cost me?" in one call
  instead of reconstructing it by diffing 29 rows.

### `last_seen_at` is frozen on a session that is alive and busy right now, so it cannot be used to judge life or death

- **Tool:** `mission_sessions` + `mission_projects`
- **Severity:** guessing
- **What I asked:** work out when the sessions stopped, using the one timestamp on
  the row that looked like a clock.
- **What happened:** `msn_9a1a4e6ce0b08293` — the session I am running in — reports
  `"live": true, "busy": true, "busyKnown": true, "open": true` alongside
  `"created_at": "2026-09-28T20:33:23.495Z", "last_seen_at": "2026-09-28T20:33:23.495Z"`.
  Identical to the millisecond, and roughly twenty hours stale, on a row that
  says a turn is streaming into it *now*. So `last_seen_at` is not a heartbeat.
  The dead rows show the same freeze from the other side: 24 of 29 have
  `last_seen_at == created_at` exactly, and the five that differ were only ever
  bumped by a one-off probe (`msn_ba4d7caa6660a80a` +42s, `msn_6f1c4ea23d0a7d85`
  +6m, `msn_fd0cf30a17ab1931` +50s, `msn_7aca489d9a1e9e27` +1d9h,
  `msn_96f56b84015485e0` +1d9h).
- **Why it hurts:** the equality `last_seen_at == created_at` is doing double duty
  and means two incompatible things: *"this pane was never observed again"* (a
  session that died seconds after starting) and *"this pane was never probed
  after its first frame"* (a session that ran for nine hours and was only ever
  looked at once). I could not tell those apart, and since `last_seen_at` is the
  only timestamp on the row, there is nothing else to try — which is why the
  recreate boundary is not derivable from the data even though the user knows it
  exactly. The stale value on a live busy row is the sharper half: a caller
  reading `last_seen_at` as "last activity" concludes a working agent has been
  silent for 20 hours, and might kill or restart it on that basis.
- **Fix:** update `last_seen_at` on every probe of a live pane (it is already the
  field being written, just not for live rows), and rename the concept —
  `lastProbedAt` for the probe and a separate `lastOutputAt` for agent activity,
  which is the number a caller actually wants. If the field genuinely only
  advances when something asks, say so in the description, because a field that
  looks like a heartbeat and is not will be read as one.

### Correction: `mission_sessions` and `mission_projects` **do** return `total` — yesterday's finding that they don't is wrong

- **Tool:** `mission_sessions` + `mission_projects`
- **Severity:** guessing
- **Original entry:** "The only tool that reads the pool is the tool that consumes
  it, and the list has no count" —
  [`2026-09-29-task-queue.md`](2026-09-29-task-queue.md). Its closing sentence:
  *"the same two fields are conspicuously absent from `task_list`,
  `mission_projects` and `mission_sessions`."*
- **Extension (2026-09-29, later the same day) — the claim is half wrong.** Both
  tools carry `total` today:
  - `mission_sessions {limit: 20}` → `"total": 29, "truncated": true`.
  - `mission_projects` → `"total": 6`.

  And `mission_projects` is not truncated at all: its per-project session arrays
  sum to exactly 29 — 1 + 4 + 1 + 11 + 10 + 2 — so it hands back the complete
  board in one call, while `mission_sessions` at `limit: 20` shows 20. **The
  defect is confined to `task_list`**, which I re-checked: seven rows at
  `limit: 20`, no `total`, no `truncated`, no `status` filter. The finding's
  *fix* stands for `task_list` and should be struck for the other two.
- **Why it hurts:** the error is in a log whose entire value is that its claims
  are reproducible. A reader who trusts that sentence goes looking for missing
  fields that are present, or files the same ticket twice, or — worst — concludes
  the surface is sloppier than it is and stops reading the good parts. It also
  cost me today: I expected to have to page through `mission_sessions` to
  establish a total, and the *useful* fact was the opposite of what the log said,
  namely that `mission_projects` is the complete view and `mission_sessions` is
  the paged one.
- **Fix (to the log, not the code):** the entry above is corrected in place by
  this line; no code change. What is genuinely missing is that neither Mission
  tool documents that `mission_projects` returns the *unpaginated* board, which
  is the single most useful thing a caller learns today and is nowhere in either
  description.

### Correction: the session "Starting infinite queue" was never missing — I recorded a false negative

- **Tool:** `mission_sessions` + `mission_projects`
- **Severity:** guessing
- **Original entry:** "After a write, nothing tells you which project you are in —
  and the label is not a substitute" —
  [`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md). It
  states: *"I was told a session named 'starting infinite queue' was running. It
  is in none of the 22 sessions."*
- **Extension (2026-09-29) — it is there.** `msn_5f22bca2e691c421`, label
  **"Starting infinite queue"**, project `paddock`, folder `/www2/paddock`, agent
  `pad-opencode-proj`, `origin: "human"`,
  `agent_session_id: "ses_f16b9f286ffe7PqRupdIxxHl7W"`,
  `created_at: "2026-09-28T18:39:59.676Z"`, `live: false`. It also has a near
  neighbour, `msn_9a3b06b91ef135e4` "Start infinite queue in paddock project",
  same project, same day, and `msn_6f1c4ea23d0a7d85` "Infinite queue" started by
  an agent. So three sessions, three near-identical labels, one conversation the
  user was asking about.
  That entry's *real* point survives and is now sharper than it was: the labels
  are not merely stale, they are **near-colliding**. Across 29 sessions the label
  set contains 4 empty strings, 4× "Delayed Smooth Video Auto-Centering", 2×
  "Dashboard download queue timestamps", 2× "paddock - Mission 3-Column Workspace
  Plan", 2× "Friendly greeting", and the three "infinite queue" variants above.
  And since the session is resumable by id, the answer to "is the infinite queue
  work still there" is a single `mission_session_start {agent_session_id:
  "ses_f16b9f286ffe7PqRupdIxxHl7W"}` — which I have not fired, because starting a
  conversation is a mutation and the user did not ask me to resume it.
- **Why it hurts:** a false negative in this log is worse than a missing entry. A
  reader would have concluded the surface cannot find sessions by name, when in
  truth I had not looked properly — and the near-colliding labels make that
  mistake easy to repeat, not easy to avoid.
- **Fix (to the log):** the "is in none of the 22 sessions" sentence is corrected
  by this line. The tool fix it argues for stands: expose a distinct `title`
  (refreshed from the agent's own session title) beside the operator-set
  `label`, and echo `project` on writes. And `mission_sessions` should support a
  `q`/`label` filter, so "which session was doing X" is one call instead of
  reading every row — with 29 sessions and near-duplicate labels that filter is
  the difference between a lookup and an audit.

### A finished task row carries no evidence that the task ran, and the queue's only complete view is unreadable

- **Tool:** `task_list` + `task_submit` (description)
- **Severity:** guessing
- **What I asked:** "what tasks?" — read the queue.
- **What happened:** the queue is unchanged from 19:49 yesterday: 3 `pending` pool
  tasks I filed and left unclaimed, 2 `done`, 2 `error`. The two `done` rows are
  `d44f9cf2-…` and `25dada25-…`, and between them they carry **no author, no exit
  code, and on one of them no claimer**:
  - `d44f9cf2-d500-4cda-830b-2eeb4c0fae84` — `"status": "done"`,
    `"claimed_by": "pad-opencode-user1"`, `"exit_code": null`,
    `"agent_name": null`, `finished_at: "2026-09-27 09:18:45"`.
  - `25dada25-1734-4f82-bc22-fca7aba312b7` — `"status": "done"`,
    `"claimed_by": null`, `"exit_code": null`, `"agent_name": null`.

  So `done` is an assertion with nothing behind it on the row: the process's
  actual outcome, who filed it, and (on one) which pad ran it are all absent.
  The only tool that holds the answer is `task_result`, one call per task. And
  the row's `prompt` is still clipped mid-word — the `9c494bc2` error row ends
  `…which address is the default-` with no marker, exactly as
  [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) recorded.
- **Why it hurts:** "did that task actually work?" is the question after every
  completed task, and `task_list` — the tool you would scan — cannot answer it
  and does not say it cannot. A caller scanning for failures has to compare
  `exit_code: null` against `exit_code: 1` and guess that the former means
  success, which is the same inference as
  [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md)'s
  "`error` is overloaded" finding, on the other side of the same field.
- **Fix:** populate `exit_code` on `done` rows, carry `created_by` (which
  `task_submit` returns and `task_list` drops — already filed), and append a
  `…[truncated]` marker to clipped prompts. One `outcome: "ok" | "failed" |
  "unknown"` field on the row would settle all three at once.

### The surface can resume a conversation but never read one — a dead session's chat is unreachable by any tool

- **Tool:** `mission_sessions` (detail) + `agent_logs` + the whole `pad_*` surface
  (negative finding)
- **Severity:** blocker
- **What I asked:** "u cant read their chats?" — the user asked whether I could
  read what the dead sessions were discussing, which is the precondition for
  "continue the sessions that were running".
- **What happened:** no, and the answer is a flat no rather than a hard one. Four
  dead sessions opened in detail mode, every one identical:
  `"state": {"live": false, "tuiAlive": false, "command": "", "cwd": "",
  "reason": "no-session"}, "live": false, "screen": ""`.
  The `screen` field — documented as *"the tail of what its TUI is showing RIGHT
  NOW"* — is the **empty string**, not a stale capture. The pane is not being
  retained; there is nothing to read. So I cannot tell what any of the 28 dead
  sessions was doing, what any of them concluded, or whether any was mid-turn.
  Two more places I looked, both dead ends: the `session` block in detail mode
  carries the same fields as list mode (`label`, `folder`, `created_at`,
  `last_seen_at`, `agent_session_id`) and no transcript handle; and `agent_logs`
  on `pad-opencode-proj` is opencode server bootstrap — the ASCII banner,
  `Local access: http://localhost:7890`, an `xdg-open` ENOENT — with no
  conversation content anywhere in 40 lines. There is no `mission_transcript`,
  no `history`, no read side to any session tool. The complete surface is the
  list in [`2026-09-29-list-plans.md`](2026-09-29-list-plans.md) plus
  `pad_workspace_read`, which reads a file and cannot reach an agent's own
  session history.
- **Why it hurts:** this is the asymmetry that makes the whole board unusable for
  handover. `mission_session_start {agent_session_id}` will happily resume
  `ses_f16b9f286ffe7PqRupdIxxHl7W` and the *agent* will know where it left off —
  but the **caller** never can, at any point, before or after. So the only way to
  learn what a dead session was doing is to spend a real agent turn asking it,
  and the only way to verify that the resume actually restored the right context
  is to read the new session's screen and trust that the agent is describing its
  own past accurately. A manager cannot pick up a colleague's conversation; they
  can only re-open the door and knock. Note this is strictly worse for the
  *resumed* session than for the original: once `screen` is non-empty you get the
  tail, so the information exists only while it is still on the terminal, and
  `screen: ""` for a corpse is indistinguishable from a session that was created
  and died in the same instant.
- **Fix:** persist the pane tail with the session and return it for dead rows —
  `lastScreen: "…"` captured at teardown, the same buffer `screen` already uses.
  That one change makes a dead session reviewable, turns `screen: ""` from
  ambiguous into honest, and costs nothing for live rows. Failing that,
  `mission_session_start` should echo back a short summary of what it resumed
  (`resumedFrom: {agent_session_id, lastSeenAt, messageCount}`) so the caller can
  tell a restored context from a fresh one without reading the agent's self-report.

### Nothing in the surface dates a session's death, and `get_agent` returns three null timestamps on a running pad

- **Tool:** `mission_sessions` + `get_agent` + `agent_logs`
- **Severity:** guessing
- **What I asked:** "when they are closed?" — the user asked when the sessions
  stopped.
- **What happened:** four escalating attempts, none of which the surface answers.
  1. A session row has `created_at` and `last_seen_at` and no `ended_at`, no
     `exit_reason`, no terminal `state`. Detail mode adds
     `state.reason: "no-session"` — the tmux session is absent — which is a
     condition, not a timestamp.
  2. `last_seen_at` cannot substitute, and this is the second symptom of the
     entry above: it equals `created_at` to the millisecond on 24 of 29 rows, and
     is 20 hours stale on the one row that is `live: true, busy: true` right now.
     A field frozen at birth on the dead and frozen at birth on the alive carries
     no death time.
  3. `get_agent {name: "pad-opencode-proj"}` on a **running** pad returns
     `"created_at": null, "updated_at": null, "last_activity_at": null`. Three
     nulls on a container that is demonstrably up. This is the one object whose
     job is a pad's timeline and it declines to give one.
  4. `agent_logs` is the only tool that produced a real number, and it is not a
     session tool. Its tail shows the opencode server announcing itself at
     `2026-09-28T20:32:02.425722397Z`; this session was created at
     `2026-09-28T20:33:23.495Z`, 81 seconds later. The latest activity recorded
     on any dead session is `msn_ba4d7caa6660a80a` at `20:22:01.738Z`. So the
     kill is bracketed between those two — which is *my* arithmetic across two
     unrelated tools, and even that I can only state loosely: a 40-line log tail
     cannot distinguish a container start from an opencode-server restart inside a
     container that never stopped, so I am not willing to say the recreate
     happened at 20:32.
- **Why it hurts:** "when did this die, and what killed it" is the first two
  questions about a corpse, and the surface answers neither. The user knew the
  answer instantly — *"i recreated the agent"* — which is the sharpest possible
  contrast: the operator had it in their head, and the API had it nowhere, and the
  only route I found to even bracket it was a container log that was never meant
  to be read as a session ledger. A caller correlating a mass session death
  against a pad event has to do this cross-tool join by hand, from timestamps
  that are null or frozen.
- **Fix:** three fields. `endedAt` and `endedBy: "recreate" | "exit" | "gone"` on
  the session row (written at teardown, next to the existing `lastScreen`
  buffer), and populate `created_at` / `last_activity_at` on `get_agent` — a
  running container with three null timestamps is a bug in its own right,
  independent of sessions.

## Extensions to existing findings

### Re-observed, unchanged: the queue is a day old and nothing has claimed it

- **Tool:** `task_list`
- **Original entry:** "A pool task is inert, and nothing in the submit response
  hints that" — [`2026-09-29-task-queue.md`](2026-09-29-task-queue.md), severity
  `guessing`, **no Resolution line**. Same file, ~20 hours earlier.
- **Extension (2026-09-29):** the three no-op tasks are still
  `"status": "pending", "claimed_by": null, "finished_at": null` with
  `created_at: "2026-09-28 19:49:28"`, and no opencode pad in the fleet has
  called `task_get_next` in that time. The finding's core claim — that a caller
  who fills the pool and walks away cannot tell that nothing will ever run it —
  is now confirmed over a full day rather than inferred at the moment of filing.
  Still no Resolution line.

### Re-observed, and now with a verdict: the `task_list` no-count finding is real but was overstated

- **Tool:** `task_list`
- **Original entry:** finding 3 of [`2026-09-29-task-queue.md`](2026-09-29-task-queue.md).
- **Extension (2026-09-29):** see the correction above — the `total`/`truncated`
  half of it applies to `task_list` alone. The other half is confirmed: 7 rows at
  `limit: 20` with no `total` and no `status` filter, so "is the queue complete"
  still cannot be asked without pulling every terminal row into context.

## Context: the board as read (not findings)

13 pads, 10 running, 3 exited — unchanged. 6 Mission projects, all on
`pad-opencode-proj` except `friction-probe` on `pad-opencode-user1`. 29 sessions
total, 1 live (this one), 28 dead. 8 of the 29 have `agent_session_id: null` and
are therefore not resumable by any tool.

One locked row, `msn_eaf4eb83ca6a35ed` (`locked: true`, `live: false`). A caller
typing into it would be refused with `mission_session_locked` — the human's
"drive alone" refusal — when the actual situation is that the pane is gone. Two
different causes, one refusal code, and the locked one is the misleading.

The user's account — *"i recreated the agent so its sessions stopped"* — fits
`pad-opencode-proj` completely. It does not quite fit `pad-opencode-user1`: that
pad's only session, `msn_96f56b84015485e0`, has `last_seen_at:
"2026-09-28T18:36:21.402Z"`, which is two hours **before** this session was
created on `proj` at 20:33. So the two pads' sessions stopped at different times,
and if only one pad was recreated, `user1`'s single dead session has a cause
nobody has stated. Recording it as an open question rather than a contradiction.

## What held up well

`mission_projects` is the best read in the surface and I under-used it until
today. One call returned the entire board — all 6 projects, all 29 sessions,
`total: 6` — with per-project `sessionCount` / `liveCount` / `openCount` headers
and the full session rows nested underneath. It is a strictly better question to
ask than `mission_sessions`, and neither description says so. The `openCount`
counters also make the "dead but reported busy" row from 2026-09-28 immediately
visible: this time every `openCount` agrees with its `liveCount`.

`mission_sessions` gets the small stuff right, and it is worth saying: the shape
of a row is genuinely good. `origin` (`human` / `agent`), `locked`, `busy` +
`busyKnown` + `open`, `tmux_id` alongside the opaque `msn_` id, and `folder` on
every row — so a session is self-locating and I never had to make a second call to
know which pad or which directory a row belongs to. The problem is not the shape
of a live row, it is that a dead row is the same shape with one bit flipped.

## See Also

- [`2026-09-29-task-queue.md`](2026-09-29-task-queue.md) — the queue, the
  `total`/`truncated` claim corrected above, and the inert-pool finding extended.
- [`2026-09-28-pm-portfolio-intake.md`](2026-09-28-pm-portfolio-intake.md) — the
  `busy` on a corpse finding, the dead-session finding, and the false negative
  corrected above.
- [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md) —
  `error`/`exit_code: null` being two different failures.
- [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) — the
  prompt truncation, still unfixed, and `total`/`truncated` as the house pattern.
