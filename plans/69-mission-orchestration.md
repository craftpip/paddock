# Plan 69 — Mission orchestration via MCP (task lifecycle loop)

## Status: Proposed (2026-10-07) — design complete, not started. All design calls
are decided below (§ Design proposal); the audit (2026-10-06) stands. Nothing is
built; phases P1–P4 await the go to build.

Scope: **MCP / orchestration only.** How an LLM driving Paddock over MCP runs
work through agents and sessions: task model, lifecycle steps
(review → develop → test → bugs → commit), completion signals, review/redo.
No Mission-page UI work here — that lives in plan 68. No machine management
(`pad_*`) unless orchestration forces it.

Related: plan 52 (orchestrator — sessions not tasks, keys/grants/playbook),
plan 53 (Mission page + the five `mission_*` tools), plan 47 (task queue),
plan 64 (plans facility), plan 68 (Mission UI vision — sibling, not overlap).

---

## How we work this file

1. User drops an idea (any size).
2. Agent appends it as a new `###` section below, numbered, dated, user's
   words quoted first, then `Interpretation:` + `Open questions:` — no solving.
3. When the user says "enough, design it", we turn the pile into a proposal
   with phases and checklists, and flip `## Status:` to Proposed.

---

## Ideas (inbox)

### Idea 1 — The loop belongs inside the MCP: review → develop → test → fix → commit, per task (2026-09-29)

User's words:

> In MCP ideas, the LLM is managing the paddock, okay, and is also
> orchestrating tasks between the agents. Currently the flow is that the LLM
> manages the agent which has sessions in it. It has to start a session then
> put task in the session. That is how the flow is currently, and after putting
> a task, the agent won't know when the task is completed or anything like
> that. Okay and once the task is completed there is no way to review it and
> commit it nothing like that or re-do it or recheck it there is nothing like
> that that has to be added in orchestration so in orchestration I will add
> tasks okay a task will be simply to do one thing. And for you it is just a
> to-do. The task has few development steps, so basically the task will first
> go for review. You will send it to an agent to review. Then after reviewing,
> you will send it to the next step that is development. Then you will do
> testing. Then if testing doesn't succeed, you will report generate bugs and
> send it back to development. After testing a success, then you will commit it
> and then move to the next task. Now all of these are just MCP tools that are
> up to you. Inside the MCP tools we will have to write the loop on how to do
> it because the LLM who is using the MCP won't be calling the MCP pulling it
> again and again right

Interpretation:

- Gap in today's flow (`mission_session_start` → `mission_send` → …): after
  the LLM puts a task into a session, there is NO completion signal, NO
  review step, NO commit step, NO redo/recheck path. The LLM is left polling
  (or guessing) with nothing to poll on.
- Wanted: a task unit on top of sessions — one task = one to-do, one thing.
  Each task walks a fixed lifecycle:
  1. **Review** (send spec/plan to an agent for review),
  2. **Development** (implement),
  3. **Testing** (run tests),
  4. on failure → **bugs reported** → back to (2),
  5. on success → **commit** → next task.
- Key design call the user already made: **the loop lives INSIDE the MCP
  tools, not in the LLM's head.** The LLM must not have to poll/call
  repeatedly — it hands work over and gets back lifecycle events (done,
  failed+bugs, needs-review, committed). Server-side progression, not
  client-side polling.
- Tool shapes are explicitly left to the agent ("all of these are just MCP
  tools that are up to you") — to be designed once gathering is done.

Open questions (for user, later):

- Who defines "done" per step — the agent self-reports, or the server checks
  (tests green = done, no self-certification)?
- Review by a DIFFERENT agent/session than development (cross-review), or same
  one?
- Bugs: structured records (file:line + repro) or free text back to dev?
- Commit per task automatically, or staged for human approval first?
- One task active per session at a time, or a queue per session?

### Idea 2 — Driver sees last-message + its time per session; done-ness still needs an explicit signal (2026-09-29)

User's words:

> So whenever a session is going on and we are listing sessions when the
> driver wants to list sessions, in that session we will define that what was
> the last message of that session that we already do. Am I right? But we will
> also send that when was the message sent so that the LLM the driver will know
> that the task is done or not. How would we know the task is done or not?

Interpretation + truth check (read off `src/mcp.js` + `src/services/mission.js`):

- Half right. Detail mode (`mission_sessions {session_id}`) already returns a
  **screen tail** — the last N lines of what the TUI is showing RIGHT NOW. It
  is raw pane text, not a parsed "last message" (no author, no id).
- List mode returns NO message text at all — only
  `live/busy/busyKnown/open/kind`, `created_at`, and `last_seen_at`.
- The timestamp does NOT exist today. `last_seen_at` looks like it but is a
  **probe clock**: it advances on every poll of a live pane even when nobody
  typed anything (comment in code says exactly this). `created_at` is birth.
  Neither = "when the last message arrived".
- Wanted: each session row carries (a) the last message (or tail) and (b) when
  it was sent, so the Driver can judge done-ness.
- Honest caveat recorded: a timestamp alone does NOT answer "is the task
  done". Idle ≠ done — the Worker could be finished silently, stuck, or
  waiting on a permission dialog (`blockedOn: permission` exists for the last
  one). Today's closest signals are `busy: true→false` (turn stopped
  streaming) + reading the tail for a completion marker (fragile, parsey).
  Idea 1's explicit completion (Worker reports DONE/FAILED, Orchestrator
  records it) is what actually closes this — the timestamp is supporting
  evidence, not the verdict.

Open questions (for user, later):

- "Last message" = parsed last turn (author + text + time) or the existing raw
  screen tail plus a time?
- Whose clock — the Worker's message time, or when our side last observed it?
- Done = Worker says so, Orchestrator decides (tests green), or Driver reads
  the tail?

Timing sources noted (2026-09-29, from user's follow-up — confirmed tail is
plain text with no time; question was "how do we get the timing, since that
tells the Driver if the pane is active"):
1. tmux capture gives TEXT ONLY — no timestamps exist in pane content.
2. Cheapest universal source: server diffs the captured tail each poll, stamps
   "tail last changed at T". Works for all Worker types, no agent cooperation;
   granularity = poll interval, and it is observation time, not message time.
3. Turn-boundary stamps: the existing busy probe (`/session/status`, opencode
   only) already sees true→false transitions — stamp "turn ended at T".
   codex/claude have no equivalent probe today.
4. Real message time lives in each Worker's OWN store (opencode.db / codex
   rollouts / claude jsonl — the history readers already touch these; the
   claude one is a documented guess per plan 53 §8). Richest, most per-type work.
 Also fixed vocabulary: "pane active" is THREE things — live (TUI process
   holds a pane) vs working (turn streaming now = busy) vs recently active (tail
   changed T ago). Timing answers only the third.

---

## Audit (2026-10-06) — both ideas re-checked against what shipped since

Nothing was changed. Seven days of plans landed after these were written, and
they cover more of this file than the ideas assumed.

### Idea 2 is essentially BUILT — by plan 64, not by a design for this idea

`plan_activity {agent, session_id}` returns exactly the pair this idea asked for,
and returns it better:

| Idea 2 asked for | What shipped |
|---|---|
| last message of that session | `lastMessage` as a **user/assistant pair** |
| when the message was sent | timestamps on both halves, plus a separate `lastActivityAt` |
| is the task done or not | `lastToolCall.status`: running / completed / error |

So two of the idea's three open questions are already answered by the
implementation rather than by a decision: **"whose clock" is the agent's own store
clock** (the message's own `time_created`, not our observation time — i.e. option 4
of the "Timing sources" list above was chosen, and the cheaper option 2, diffing the
tail, was deliberately not), and **"last message" is a parsed pair**, not the raw
screen tail.

**The join to a Mission row exists and is one call.** `plan_activity`'s
`session_id` is the agent's own conversation id, and the tool description already
says to take it "from `mission_sessions`" — and since plan 52 R7 a fresh row carries
`agent_session_id` **from the first read**, so `session_id: row.agent_session_id` is
always available rather than sometimes null.

Two things the audit wants to flag before this is called done:

- **The LIST case is not solved, only the detail case.** The idea's wording is
  "when we are listing sessions", but `plan_activity` is one conversation per call.
  Putting a last message on every row of a listing means one call per session, which
  is exactly what plan 64's documented cost forbids: ~2 ms per indexed query on
  opencode, but a **full rollout-file parse** on codex and claude. The
  cheapest honest answer is a bounded window (the live few rows) rather than every
  row — a design decision, not a default.
- **The idea's own caveat survives intact.** `lastToolCall.status` is *liveness*,
  not *completion*: a finished turn and a stuck one both read `completed`, and a
  silent idle agent reads the same as a task done. This is why Idea 1's explicit
  done-signal is the part that still has to be built.

### Idea 1's premise is half stale — a task lifecycle already exists

The idea says "after putting a task into a session there is NO completion signal,
NO review step, NO commit step, NO redo/recheck path". Three of those are now
wrong. The MCP surface carries **eight `task_*` tools** (plans 47/50/51/52):
`task_submit`, `task_get_next`, `task_list`, `task_status`, `task_result`,
`task_complete`, `task_retry`, `task_cancel`.

- **Completion signal: exists.** `task_complete {done | failed}`, and the server
  refuses a completion for a task no worker claimed — so "done" already means *a
  worker really did the work*, which is a stronger guarantee than the idea asked
  for and answers its own open question "who defines done: the agent self-reports,
  or the server checks?" — the worker self-reports, and the server guarantees the
  claim.
- **Redo path: exists.** `task_retry` re-files a failed task.
- **Review step: still missing**, and it is missing for a structural reason rather
  than an oversight: a task has **one outcome**, so "review" has nowhere to live as
  a distinct state. The idea's five-step loop needs a per-task *step* model, and
  nothing in the schema has one.
- **Commit step: still missing.** No tool commits. `exec` could run `git commit`,
  but nothing is task-scoped, so "the commit that belongs to this task" is not a
  thing the system can name.
- **The session binding is the real gap.** The task system's worker is a **PAD** —
  `task_submit`'s `name` is the PAD it runs in, `task_complete`'s `worker` is the PAD
  that claimed it, and push mode launches `opencode run` **headless**. Mission
  sessions are the other axis entirely: a human watching a TUI in a project folder.
  So the flow the user describes — "start a session, then put the task in the
  session" — is still not expressible. That is the sentence the design has to
  answer, and it is why "just wire Idea 1 to the existing tasks" is not a plan.

**The user's key design call has no support anywhere today, and it is the expensive
one.** "The loop lives INSIDE the MCP tools, not in the LLM's head" means the server
progresses a task by itself. Today every hop is an explicit LLM call, which is
visible, interruptible and free. Server-side progression needs somewhere to record
step transitions, a per-step timeout and retry policy, and a way to stop a loop
whose worker has gone away — and the existing task tools are deliberately built the
other way (`task_get_next` even mutates state so it cannot be used to look, and
`task_list` exists precisely to observe without claiming). Worth naming that this is
a real cost, so the choice is made knowingly.

---

## Design proposal (2026-10-07) — decided, awaiting the go to build

Turns the audit into a proposal. Every open question from the Ideas inbox is
decided here. Constraint the whole design obeys: **the `tasks` table and the
existing eight `task_*` tools are frozen (plan 52 G2)** — this design adds a
layer next to them, never a column or a semantic on `tasks`.

### D1 — A task's steps are a new `task_steps` table, one row per step attempt

`tasks` stays exactly as plan 63 defined it (facts only: `enqueue`, `timeout_ms`,
`attempt`, `superseded_by`, …). The lifecycle lives in a sibling table
`task_steps(task_id, step, attempt, state, status, session_id, reported_by,
notes, artifact, occurred_at)`, FK to `tasks.id`, child-cleared before any parent
delete (the audit-FK lesson). `step` is one of `review | build | test | hotfix |
commit`; `state` is `pending | running | needs_review | failed | done | aborted`;
`status` is `passed | failed | error` for finished attempts. A task's *current
step* is derived: the newest `task_steps` row. `task_status` reads it, so "where
is this task in the loop" is one call and one answer, and nothing on `tasks`
changes.

### D2 — A task binds to a Mission session; the session binding is the actual gap

`task_submit` gains an optional `session_id`. With it, the task is **in-session**:
every step runs in THAT Mission session's folder, and every step tool honors the
session gates this project already built for `mission_send` — a locked session
(`task_session_locked`), a dead pane, a shell pane, or a permission-parked pane
parks/refuses the step exactly as a send would (`blockedOn: permission` is read,
not guessed). That makes the user's sentence — "start a session, then put the
task in the session" — expressible end to end. Without `session_id`, the task
keeps today's PAD/push behavior untouched (back-compat, no forced migration).

### D3 — Review runs in the same session by default; cross-review is opt-in

`task_submit` (or the review step) accepts an optional `reviewer` session/PAD. A
fleet usually has exactly one agent per folder, so **same-session review is the
default** and `reviewer` is the explicit alternative — never the other way round.
This answers the inbox's "same or different agent" as "same, unless told".

### D4 — Done-ness is self-reported per step, with the claim guarantee kept

The server has no universal "tests green" oracle, so it never guesses a step's
verdict (the audit's caveat: a silent idle agent reads like a done one). Each
step completes through a step-scoped report, and the report's actor must match
the step's worker (reusing the existing `task_not_claimed`-style refusal). The
timestamp/`lastToolCall` pair from plan 64 stays **supporting evidence**, never
the verdict — the verdict is the report.

### D5 — Bugs are structured when the reporter has them

`task_steps.notes` is free text (a review/hotfix writeup); a failed `test` step
may additionally record structured bugs — `{file, line, summary, repro}` — as
extra rows on the same step attempt, so "send it back to development" carries
what development needs instead of a wall of prose.

### D6 — Commit is server-run, task-scoped, in the project folder

`task_step_commit` runs the commit in the bound session's folder via the
existing exec path and records the resulting sha in the step's `artifact`. "The
commit that belongs to this task" becomes a name-able thing. Automatic per-task
commit (the user's flow: test passes → commit → next task) is the default.

### D7 — The loop lives INSIDE the MCP; the server drives it, with a stop

This is the user's explicit design call and the expensive one (the audit named
it). `task_pipeline_start {task_id}` hands a task to a server-side driver that
advances steps by driving the bound session (through the same paths
`mission_send` uses) and records each step in `task_steps`. The driver's rules,
each a hard wall:

- It never advances past a step whose report is missing, `error`, or parked —
  it stops and reports, it does not guess.
- Per-step timeout comes from `tasks.timeout_ms`; a step that overruns is
  stamped `error` and the pipeline parks for a human.
- `task_pipeline_stop` aborts at the next step boundary; a dead/locked session
  or a removed task parks the pipeline rather than aborting silently.
- Concurrency: one active pipeline step per task — `task_pipeline_start` on a
  task whose newest step is `running` refuses (`task_pipeline_busy`).

### Tool surface

- `task_submit` (extended): `session_id` (optional), `reviewer` (optional).
- New: `task_step_report`, `task_step_bug`, `task_step_commit` — the explicit
  single-step tools (everything the driver does, only LLM-visible and
  interruptible for the "keep the loop visible" path).
- New: `task_pipeline_start` / `task_pipeline_status` / `task_pipeline_stop` —
  the server-side loop.
- `task_status` / `task_list`: extended to read the derived step (newest
  `task_steps` row) without changing their `tasks`-only storage reads.
- `task_retry` re-files a task and now re-creates its step chain (fresh
  `task_steps`), not just the queue row.

Every new tool goes through `registerTool` (the MCP wrapper that turns a
throwing handler into `{ isError: true }`) and is resolve-then-gate on the
session's pad, exactly like the `mission_*` tools.

### Phases / checklist

- [ ] **P1 — schema + session binding.** `task_steps` table (derived from the
      real schema, migration suite with the absent-columns control), `task_submit
      { session_id, reviewer }` validation (session exists on the pad, folder
      matches project), `task_status`/`task_list` read the derived step. Tests:
      db-migration control, mcp suite, act-gate tests.
- [ ] **P2 — single-step tools.** `task_step_report`, `task_step_bug`,
      `task_step_commit`, all with the session gates from D2 and the actor-claim
      check from D4. Tests: refusal matrix (locked/dead/shell/permission-parked),
      commit-sha recording.
- [ ] **P3 — the pipeline driver.** `task_pipeline_start/status/stop` with the
      four hard walls from D7, task step records, timeout from `tasks.timeout_ms`.
      Proved END TO END live (a task walked review→build→test→hotfix→commit in a
      real session), not by a green unit suite — the driver is the one place a
      unit test cannot see (the same shape as the default-runner lesson).
- [ ] **P4 — guide + absorb.** `pad_help` recipes name the loop and the stop;
      docs + AGENTS.md capture D1–D7; plan absorbed and deleted like 68.

### What this deliberately does NOT do

- No change to `tasks` or the existing eight tools (G2 freeze).
- No Mission-page UI (plan 68's province).
- No machine lifecycle (`pad_*`) — orchestration only.
- No "server decides tests are green" — D4 is explicit on who writes a verdict.
