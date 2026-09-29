# Chat Test — "what is the progress in the paddock project"

**Date:** 2026-09-29
**Mode:** chat test (MCP only — no shell, no web UI, no backend code). No
deviations.
**Task as phrased:** "what is the progress in the paddock project" → then
"u dont know what project that session is from?" → "the live session?" → "okay,
is owrking right".
**Outcome:** **I could not answer the question.** I identified the project and
found its one live session, and I could tell the user the session was *advancing*
— but "progress" is not a thing this surface reports, and after four reads the
honest answer was a description of the last shell command it ran. The
conversation then turned into the user checking whether the read itself was
sound, which is where the sharper findings came from.

## Findings

### A project has no progress, state, or work record — only a roster of sessions, and the roster is not progress

- **Tool:** `mission_projects` + `mission_sessions`
- **Severity:** blocker
- **What I asked:** "what is the progress in the paddock project".
- **What happened:** `mission_projects` (no `agent` filter) returned `total: 6`
  and six rows. The one named `paddock` is
  `{id: "prj_f34d6ccdb9bbc303", agent: "pad-opencode-proj", agent_type: "opencode", folder: "/www2/paddock", sessionCount: 10, liveCount: 1, openCount: 1, created_at: "2026-09-27T07:19:05.594Z"}`
  and its ten sessions with `label`, `origin`, `live`, `busy`, `created_at`,
  `last_seen_at` and `agent_session_id`. That is the entire vocabulary. There is
  no field for what a project is *doing*: no plan, no todo, no milestone, no
  task, no commit, no diff, no percent, no last activity summary, no
  `updatedAt`. The closest thing to a status field is `sessionCount` /
  `liveCount` / `openCount`, and `openCount` is documented as "live OR mid-turn" —
  a liveness number, not a work number. A session that started, did 400 tool
  calls, and finished leaves the same row as one that opened and died: both
  `live: false, open: false`. Ten of the paddock project's ten sessions are
  `live: false`, and I could not tell whether that is 10 tombstones or 10 pieces
  of finished work.
- **Why it hurts:** "what's the progress" is the single most natural question to
  ask a project manager, and the surface answers it with a question about
  *process liveness*. The distinction is not pedantic: liveness is what the
  Mission page needs to draw a green dot, and progress is what the user is
  actually asking for. Because the two look alike in the JSON
  (`liveCount`/`openCount` beside a `sessions` array), a caller who reaches for
  the counts and narrates them as progress will be confidently wrong, and there
  is no second call to catch the mistake — the second call is `mission_sessions`
  in detail mode, which returns a screen tail. This is the same wall as the
  missing plans facility in
  [`2026-09-29-list-plans.md`](2026-09-29-list-plans.md) seen from the other
  side: a directory of markdown plans exists on the host and no tool reads it, so
  the plans *are* the progress record and the surface cannot reach them.
- **Fix:** a `mission_project_get {project_id}` that returns a work summary —
  at minimum the plan/todo files found in the project's `folder` with their
  titles and completion state, plus `lastActivityAt` per session. Failing that,
  a `plan_list {project_id, path}` per the recorded user requirement, and one
  line in `mission_projects`'s description saying plainly that the tool reports
  session liveness and not project progress, so nobody has to infer the
  distinction from `liveCount`.
- **Resolution (plan 67, 2026-09-29 — the honesty half done, the mechanism
  deliberately not):** the second half of this fix landed. `mission_projects` now
  says **"These counts are LIVENESS, not progress"** in its own description, with
  the concrete consequence spelled out (a session that did 400 tool calls and one
  that opened and died are identical here), so the distinction is stated rather
  than inferred from `liveCount`. The work-summary mechanism was **not** built
  here: it is owned by plan 64 (`plan_list` / `plan_activity`), and plan 67 §67.1
  says in as many words not to reimplement it. A `mission_project_get` was also
  not added — `mission_projects {project_id, name, folder}` answers it, so a new
  tool would be surface nobody asked for. Until plan 64 lands, "what is the
  progress" is still honestly unanswerable; the difference is that the tool now
  says which half of the question it cannot answer.

### `busy: false` with `busyKnown: true` on a session whose pane shows a turn in flight, contradicting `state.live: true`

- **Tool:** `mission_sessions` (detail mode), four reads
- **Severity:** guessing
- **Original entry:** "The same session read two ways reports `open: true` and
  then `open: false`" —
  [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md),
  severity `guessing`, **no Resolution line**.
- **Extension (2026-09-29, four reads of one live session, `busy` now provably
  false rather than merely null):** `msn_dc493ea9d87313e7`, `state: {live: true,
  tuiAlive: true, command: "opencode", cwd: "/www2/paddock"}`, top-level
  `busy: false, busyKnown: true, open: false` — while every one of the four
  screen tails showed a spinner (`⠴`/`⠸`/`⠹`/`⠏` next to `Build · Big Pickle`)
  or `Thinking` or a running `+ Thought: 8.8s` / `+ Thought: 14.3s`. Three
  distinct screens across three reads, so the turn was demonstrably running the
  whole time. The sweep's entry covers `session.live: null` / `session.open:
  false` in detail mode; this is the sharper case: `busyKnown: true` is a
  positive claim that the probe worked, and the answer it returned is **wrong**,
  not unfilled. `state.live: true` matches reality and `busy` does not.
- **Why it hurts:** the `mission_send` description tells me to read
  `mission_sessions` first and tells me `busyKnown: false` means UNKNOWN, not
  idle — so `busy` is documented as the field that decides whether a session is
  safe to type into. This session is `busy: false, busyKnown: true`, i.e. the
  documented "known idle" answer, while a turn is streaming. A caller following
  the tool's own instruction would type into it. The `state` block and the
  top-level row also disagree inside a single response, and nothing marks which
  is authoritative — the same defect the sweep named, now with the wrong answer
  moved from a null to a `false`.
- **Fix:** same as the sweep's — run the `withLive`/`withAgentBusy` pass on the
  session object in detail mode so the row and the `state` block cannot
  disagree, and if the busy probe cannot answer, set `busyKnown: false` rather
  than `busy: false, busyKnown: true`.
- **Status: open — owned by plan 62** (`plans/62-mission-liveness-truth.md`).
  Plan 67 explicitly does not touch liveness, so this entry stays unresolved here.

### `last_seen_at` held identical across four reads with four different screens, so it is not a liveness or staleness signal

- **Tool:** `mission_sessions` (detail mode), four reads
- **Severity:** guessing
- **Original entry:** "`last_seen_at` is frozen on a session that is alive and
  busy right now, so it cannot be used to judge life or death" —
  [`2026-09-29-task-session-status.md`](2026-09-29-task-session-status.md),
  severity `guessing`, **no Resolution line**.
- **Extension (2026-09-29, the direct test the original entry could not run):**
  the original showed `last_seen_at == created_at` to the millisecond on a live
  session and concluded it was not a heartbeat. This session ran the control: I
  read the same live session four times over several minutes and the screen
  changed every time — `pad-test-subnet` network inspect, then
  `pad-opencode-user1` compose read, then a `docker exec` into `paddock`
  calling `vm.generateInstanceCompose`, then a third command — while
  `last_seen_at` stayed `2026-09-28T20:40:20.783Z` on all four. Note this is
  *not* the frozen-on-create equality: `created_at` is
  `2026-09-28T20:24:06.785Z`, so the value is +16m14s past create and still
  inert. It was bumped once by something and never again, which is exactly the
  "one-off probe" pattern the original entry inferred from the dead rows — now
  observed directly on a live one.
- **Why it hurts:** I led with it. My first answer told the user the live
  session was "last seen ~8 hours ago" as evidence it might be stale, and the
  field was wrong — the session was actively working while I said that. A
  timestamp on a live-session row is exactly the kind of field a caller trusts
  without a control experiment, and here the experiment is the only thing that
  reveals it.
- **Fix:** the original's — update `last_seen_at` on every probe of a live
  pane. If the intent is instead "when the row was last *changed*", rename it
  to `updatedAt` and drop it from the row a caller reads for liveness.
- **Status: open — not plan 67's field.** A liveness signal is plan 62's subject;
  plan 67 touched only provenance (`createdBy`) and the project payload, neither
  of which writes `last_seen_at`.

### The screen tail is bottom-anchored and `lines` does not scroll it, so a session's conclusions are unreachable

- **Tool:** `mission_sessions` (detail mode)
- **Severity:** guessing
- **Original entry:** "A finished turn leaves no trace in the pane, so a
  completed session reads as a stall" —
  [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md),
  severity `blocker`, **no Resolution line**.
- **What I asked:** (implicit, four times) what this session had concluded.
- **What happened:** `lines: 80` and `lines: 200` on the same session returned
  **byte-identical** `screen` strings. The 200-line request did not scroll back,
  did not return more, and did not say it was truncated — there is no `truncated`
  flag on the `screen` field, unlike `get_agent`'s `logs` cap and unlike
  `availableNetworksTruncated` elsewhere in this same surface. The tail is
  anchored to the bottom of the viewport, so what I got was the *current*
  command and its output, and the reasoning and the conclusions above it were
  never in the payload. Every read gave me a step and never the destination:
  the compose diff (`network_mode: container:gluetun-nordvpn2` on disk vs
  `network_mode: undefined` from the generator) is visible as data, and nothing
  states what the agent made of it, because the turn was still in `Thinking`
  each time I looked.
- **Why it hurts:** the surface's only window into a session's work is a
  viewport, and the viewport cannot be moved. Combined with the previous
  finding, a caller watching a session can establish that it is *working* and
  cannot establish that it is *right* — and `screen` is documented as "the tail
  of what its TUI is showing RIGHT NOW", which is accurate and still not enough
  for the question every caller has. A `truncated: true` would at least let me
  report the limit instead of discovering it by byte-comparing two responses.
- **Fix:** honour `lines` as a scrollback request (return the last N lines of
  the pane's scrollback buffer, not of the viewport), and add
  `screenTruncated: true` when the buffer is longer than the cap. Longer term
  the `agent_session_id` already on the row is the handle to the conversation
  itself — `mission_session_messages {session_id}` would answer the actual
  question instead of showing me a picture of a terminal.
- **Status: open — owned by plan 65** (`plans/65-session-lifecycle.md`), which
  covers reading a conversation rather than viewing a pane.

### "The paddock project" is unresolvable by name — a project and a pad carry the same word and nothing cross-references them

- **Tool:** `mission_projects` + `list_agents`
- **Severity:** guessing
- **What I asked:** (the user's) "the paddock project" — no pad, no project id.
- **What happened:** `list_agents` has `pad-opencode-paddock-dev`
  (`display_name: "Paddock-dev"`, `agent_type: opencode`, `status: exited`).
  `mission_projects` has a project `{"id": "prj_f34d6ccdb9bbc303", "name":
  "paddock"}` on `pad-opencode-proj`, folder `/www2/paddock`, and a *different*
  pad `pad-opencode-paddock-dev` whose own workspace root is also `/www2/paddock`
  per
  [`2026-09-29-list-plans.md`](2026-09-29-list-plans.md). So the same repository
  is reachable through two pads, one of which is down, and the project's name
  is the repo path minus its directory. `mission_projects` takes an `agent`
  filter but there is **no `name` or `id` filter** — the only way to resolve a
  project by name is to fetch all of them and match client-side, and the
  response is scoped to "what your key may see", so a project on someone else's
  pad is silently absent rather than reported as found-but-forbidden. Neither
  tool mentions the other's vocabulary: the fleet listing has no `project_id`
  column, the project listing has no `hostBrowsable`/`status` for its pad.
- **Why it hurts:** I picked the project literally named `paddock` and said so,
  but I could not verify that was the one meant — `pad-opencode-paddock-dev` is
  the pad a reader would most naturally reach for ("the paddock pad"), and it is
  `exited`, so answering from it would have meant reporting an empty fleet
  while the work sat on a different pad entirely. The user's follow-up — "u dont
  know what project that session is from?" — was a fair challenge to exactly
  this inference, and the honest answer is that the surface cannot make the
  identification either.
- **Fix:** let `mission_projects` take `project_id` or `name` directly, and add
  the pad's `status` and `agent_session_id`-bearing pad name to each project row
  so a caller never has to cross-reference a second tool to learn whether the
  project is reachable. If a name matches zero or several projects, say which
  instead of returning an unfiltered list.
- **Resolution (plan 67, §67.2, 2026-09-29 — fixed):** `mission_projects` now
  takes `project_id`, `name` **and** `folder`. The folder axis is the one this
  entry actually needed and the original fix did not name: `schlorp` is the
  name and `/www1/xdl` the folder, so "the sessions in xdl" was unanswerable by
  name alone. Each project now carries `agentStatus`, so reachability needs no
  second tool. Zero matches (`mission_project_not_found`) and several
  (`mission_project_ambiguous`) both refuse and name the candidates rather than
  falling back to the unfiltered list. Two details that the first version of this
  fix got wrong and the tests caught:
  1. The near-miss hint matched name containment one way only, so it was blind to
     exactly the case it was written for — a **typo**. `paddockk` matched
     nothing, because `paddock` does not contain `paddockk`. It now tests
     containment both ways.
  2. The candidate list is drawn from what the caller may already see, so the
     hint never confirms that a project on someone else's pad exists. The message
     deliberately says "that your key can access" rather than "forbidden" —
     naming a scope you were refused would be an existence oracle.
  Live-verified: `name: "paddock"` → one project; `folder: "/www1/xdl"` →
  `schlorp`; `name: "paddockk"` → `mission_project_not_found` naming `paddock`
  as the close match.

### `mission_projects` inlines every session of every project, so the project list is a superset of `mission_sessions` and the "count" arrives after the data

- **Tool:** `mission_projects` + `mission_sessions`
- **Severity:** noise
- **What I asked:** "what is the progress in the paddock project" — a question
  about one project.
- **What happened:** one call with no arguments returned 6 projects and, nested
  inside them, **26 full session objects** with the same 14 fields
  `mission_sessions` returns per row. The response ran to several hundred lines
  for a fleet question, and the five projects that were not mine came first.
  The header shape is inverted relative to the question: `sessionCount` /
  `liveCount` / `openCount` are the summary, and they sit *after* the nested
  `sessions` array they summarize. The answer I needed was one line
  (`paddock → /www2/paddock, 10 sessions, 1 live`) and it was maybe four lines
  into a payload carrying every project on the pad.
- **Why it hurts:** this is the read billed as the way to find a project, and
  its cost is paid before the caller knows which project it wants. With more
  projects or longer labels it gets worse, and the `agent` filter is the only
  lever — there is no way to ask for one project (see the previous finding). It
  is also the same payload twice: after paying for it here, `mission_sessions`
  returned the same session ids and fields again for the one I cared about.
- **Fix:** make the `sessions` array opt-in (`includeSessions: true`) or cap it
  at a couple of rows with `sessionsTotal`, and move the counts ahead of the
  nested data. `settings_get` is the counter-example in this same surface: ~120
  lines that carry every field they claim, in the order a reader needs.
- **Resolution (plan 67, §67.4, 2026-09-29 — fixed):** the nested `sessions`
  array is behind `include_sessions` (default **false**), and the response names
  the flag in a `hint` pointing at `mission_sessions {project_id}` for the rows.
  `sessionCount` / `liveCount` / `openCount` are now serialized **before** the
  row's remaining fields, so the summary arrives before the detail it summarizes.
  Measured on this fleet: the unfiltered call went from 26 nested session objects
  (several hundred lines) to a **1562-byte** summary of all six projects; the
  same call with `include_sessions: true` on one project returns that project's
  11 rows, which is the opt-in path working as intended.
  The REST route is deliberately untouched — `missionProjectRow` is the MCP
  projection, and the Mission page still gets its nested rows from
  `/api/mission/projects`, so this is not a page regression. Live-verified at
  1576 bytes for the whole six-project fleet, `openCount` present on every row,
  `agentStatus` on every row, and the Mission page still rendering all nested
  rows and zero console errors.

  While measuring this, a related hole turned up: **`openCount` was missing
  entirely on a project with zero sessions**, because the busy probe's early
  `return projects` short-circuited the counting as well as the probe. A count
  present on five rows and absent on the sixth reads as "unknown", and a caller
  who has to guard against that is how a count goes unused — the same class of
  problem as this finding. Fixed: zero sessions is, definitively, zero open. The
  field is now absent only when the caller never loaded sessions for that project,
  where we genuinely did not look.

### `origin: "human"` is the only provenance on a session, and nothing lets a caller confirm it — so "did an agent start this?" is unanswerable

- **Tool:** `mission_sessions` (detail mode) + `mission_projects`
- **Severity:** guessing
- **What I asked:** check the status of the live session in `/www1/xdl` —
  `msn_114187033c8c9d7e`, "Plan 038: fix schlorp pan snapback".
- **What happened:** the row carries `origin: "human"` and nothing else about
  provenance: no `createdBy`, no key id, no host, no `startedBy`. I reported
  its status — the fix is complete and green, 213/213 tests, nothing committed
  — and offered it as the one session whose work was done. The user replied
  that I had started it, and it was not in the friction log. It was not: I had
  no idea, and the surface gave me no way to find out, because the only
  provenance field is a two-valued `origin`. My own answer was the available
  evidence — `origin: "human"`, `created_at: 2026-09-28T20:43:01.473Z`, against
  my own session on the same pad created `21:08:52.203Z`, so 26 minutes *after*
  it; and I made no `mission_session_start` or `mission_send` call in this
  session at all. The surface stamps `origin: "agent"` reliably — three rows I
  read are stamped that way (`msn_6f1c4ea23d0a7d85` "Infinite queue",
  `msn_fd0cf30a17ab1931` "IP check", `msn_96f56b84015485e0` "probe A") and each
  was in fact started over MCP — so `human` is a real signal that something
  started this outside the API. Which outside, is not answerable.
- **Why it hurts:** "is a human or an agent driving this session" is the
  first question for anyone about to `mission_send` into it, and it is decided
  by a field that says *kind* and not *who*. The user was right to doubt me and
  wrong to doubt the data, and neither of us could do better than compare
  timestamps. It also cuts the other way: a genuine agent-started session on
  another key, or one started by a UI path that does not stamp `agent`, is
  indistinguishable from a human's. And a `human` stamp cannot be audited —
  two humans on one key produce identical rows, so a later reader cannot tell
  whether a session was a person's or an agent's after the fact. The
  consequence here was that I had to tell the user their own session was theirs,
  and they could not check me: the answer rested on my account of my own calls,
  which is the least trustworthy source in the system.
- **Fix:** add `createdBy` to the session row — the key id or user that started
  it, alongside the existing `origin`. That is one field, it makes
  "was this me?" answerable without trusting the caller's memory, and it lets a
  reviewer audit a `human` row later. Failing that, put the calling key id in
  `mission_session_start`'s own response so the caller can correlate what it
  started with what the board later shows.
- **Resolution (plan 67, §67.3, 2026-09-29 — fixed, and both halves):** the
  session row now carries `createdBy` next to `origin`, and
  `mission_session_start` echoes it in its own response, so the correlation in
  the fallback is available too. It is the **key** id, self-describing —
  `key:<id>` for a start over MCP, `user:<id>` for one from the web UI — because
  the verify line asked for a third key's session to be distinguishable and a
  bare user id could not do that (two keys belong to one user).
  Two deliberate choices worth keeping:
  - **The field is emitted only when stamped.** A row created before this existed
    reports nothing, and the migration does not back-fill a value nobody
    recorded — an invented `createdBy` is worse than an absent one, because it
    would be believed. The `human` row this finding was actually about still
    reads `createdBy: absent`, and that is the honest answer.
  - **The REST route stamps `user:<id>` too**, so a session opened in the UI is
    auditable on the same axis rather than only API-created ones.

## What held up well

`mission_projects` and `mission_sessions` are the two tools that made this
session possible at all, and they did one thing very well: the project id, the
folder, the pad, and the session id all travel together on every row, so the
chain "this project → this folder → this session → this tmux id" needed no
reconstruction and no guessing about string shapes. `state.cwd` in detail mode
(`/www2/paddock`, matching the project's `folder`) is the single most useful
field in the payload for a caller who did not start the session. I also never
once regretted calling `mission_sessions` before typing — it is what stopped me
from interleaving into a human's live conversation.

## What I could not do, and why

- **Could not report progress.** No tool in the surface carries project work
  state, and the two tools that could have reached the workspace's plan files
  are the dead `workspace_*` trio (retire-not-fix, per
  [`2026-09-29-list-plans.md`](2026-09-29-list-plans.md)). I did not reach for
  `exec` to `ls` the folder: not because it would not have worked, but because
  the user asked what the *control plane* knows, and reading the repo directly
  would have produced a progress report that the MCP surface did not give me —
  which is a different (and much more flattering) answer.
- **Could not confirm the live session is healthy, only that it is moving.**
  Four reads, four different screens, a spinner each time. That distinguishes
  "working" from "hung" and nothing else.
- **Did not type into the live session.** It is `origin: "human"`,
  `locked: false`, and mid-turn. It is the user's conversation and I have no
  mandate in it.

## See Also

- [`2026-09-29-list-plans.md`](2026-09-29-list-plans.md) — the missing plans
  facility; the progress record the surface cannot read.
- [`2026-09-29-task-session-status.md`](2026-09-29-task-session-status.md) —
  source of the `last_seen_at` finding extended above; also `recreate` killing
  sessions and 28 tombstones on the same pad.
- [`2026-09-27-run-task-in-project.md`](2026-09-27-run-task-in-project.md) —
  source of the screen-tail finding extended above.
- [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) —
  source of the detail-mode projection finding extended above.
