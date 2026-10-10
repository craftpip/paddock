# Plan 74 — Tasks: a durable issue-shaped record, its dev→test cycle, and how we know when a task is done

## Status: Proposed (2026-09-29) — 0/9 build items done. The brief is recorded verbatim in §1; §5, §6 and §7 are a design *proposal* answering the three questions the user asked. Nothing built, nothing committed, no migration written. Awaiting the user's call on the 8 decisions in §8 — several of them change the data model, so building first would be building the wrong table.

Continues plan 69 (its file is gone — completed and absorbed 2026-10-08 into
`docs/reference/backend/services.md` § *Task steps and the server-side loop*,
with the step loop `review → build → test → hotfix → commit` now built). This
plan answers 69's open questions and supersedes its Idea 1/2 question lists.
Plan 64 owns the plans facility this builds on; plan 52 owns the law this has
to not break (§4).

---

## 1. The brief (user, verbatim, 2026-09-29)

> how with todays plan ,
>
> llm -> manages projects and their tasks
> llm has a todo list/ task list,
>
> flow ->
>
> ACTION: i discuss with the llm the task draft a plan and then create task in pad
> to do that plan, paddock takes my task and add to the list, the task list,
>
> these tasks are persistent always, all history that is done with the task is
> stored in it, like the llms that owrked on it their updates , their last msgs,
> the task given, like a github issues page.
>
> the task shall be defined to go through development cycles , dev->test->dev->test->plan->dev etc. until its working,
>
> the task links to a session that is running that taks, that task gets and stores
> the updates from the session, and that is exposed to the driver llm that is
> controling this,
>
> tasks will be synced between the PADDOCK and the proejct agent by the plan in the
> code, the tasks/plans we create are called plans for the worker agent, it shuld
> be stored in the plans folder. there is a plan for this already,so i wont explain
> this much,
>
> the task will be considered complete when the user confirms to set it complete.
> all tasks done will go to the user for approval, task will have histroy of all
> the sessions_id it used, to do the job, it has all history of the prompts given
> and response taken, total tokens used, and all.
>
> so internally paddock will need to watch the sesion as it progresses to know when
> its complete or not, <- this is the challenge how do we do this, because the
> driver llm wont get a notification when its complete hmm, + how would u know
> first of all if the session is complete, will u poll the session messages and
> see when it does not change for few minutes then its not progressing, (if its on
> a build that needs to be handled), write what i told u exactly down in a plan
> file, and tell me about how we identify when task is done, and then who will
> decide what next task to do, ? beacuse paddock side we only have 1 agent thats
> running the tasks, and another is driver llm

Three questions were asked directly, and §5–§7 answer them:
**Q1** how do we identify when a task is done? **Q2** who decides what the next
task is? **Q3** what is the Driver/Worker topology given one Worker and one Driver?

## 2. What already exists (read off the tree 2026-09-29 — do not re-invent)

| Primitive | Where | What it already gives us |
|---|---|---|
| Plans facility | `src/services/plans.js`, `mcp.js` `plan_list`/`plan_write` | The durable task-shaped artifact. Frontmatter `session`, `created`, `started`, `last_activity`, `done`; body carries `## Status:`. `plans/archive/` for ended. |
| Live layer | `src/services/agent-store.js` → `plan_activity` | `lastMessage{user,assistant}`, `lastToolCall{tool,status,at}` (`running`/`completed`/`error`), `lastActivityAt`, `messageCount`, `store{available,reason}`, `padRunning`. |
| Liveness truth | `src/services/mission.js` `stampTruth` | `live`, `busy`, `busyKnown`, `open`, `kind`. |
| Send gate | `mission.js` `sendVerdict` | ONE function: refuses dead / `shell` / `locked` / `blockedOn:permission`. `canSend` is computed from it, never re-derived. |
| The retired queue | `src/services/db.js` `tasks`, `task-runner.js` | Spawn-shaped: `pid`, `exit_code`, `stdout`, `claimed_by`, `enqueue`. Hidden behind `PADDOCK_TASK_QUEUE=1`. |

**Two things are already true that the brief asks for.** The task's persistent
history *is* the plan file (plan 64's rule: the file is the record, the store is
a live signal layered on read). The task→session link *is* the frontmatter
`session:` field, already stamped by `plan_write`.

## 3. The one real conflict in the brief

Plan 52, governing law 6, from the user verbatim: *"nothing runs where the user
cannot see it"*, following *"don't let the user start any task without my vision —
remove task submit"*. The nine `task_*` tools were retired for exactly this.

**The brief is compatible with the law, and the resolution is the whole design:**
a Task is **not** a process to be spawned — it is a plan file bound to a
**visible** Mission session. The Worker runs the agent's own TUI in a tmux pane
the user can watch, typed into by the Driver and the human alike. Nothing is
headless, so nothing violates law 6.

**Consequence: do not revive the `tasks` table.** Its columns are the shape of a
spawned process (`pid`, `exit_code`, `stdout`, `claimed_by`, `enqueue`,
`superseded_by`) and reviving it would import a queue that must *not* spawn, plus
the `enqueue`/`claimed_by` vocabulary plan 63 spent its whole budget
de-conflicting. See §8 Q2.

## 4. The proposed model

A **Task** is three things, each in the place that already owns that kind of truth:

| Part | Lives in | Why there |
|---|---|---|
| The record — title, spec, acceptance, `## Status:` | **the plan file** in the PAD's `plans/` | Portable, agent-readable, survives the container, and the Worker already sees it. Plan 64's rule. |
| The attempts — every `msn-*` + agent conversation id that worked on it, with role, stage, timestamps | a **new `task_attempts` table** | Relational, one-to-many, and needs querying by task. A list inside a markdown file cannot be joined or ordered. |
| The timeline — prompts, responses, tool calls, tokens, stage transitions, the user's approval | **`task_events`**, append-only | "like a github issues page" is an event log. One row per event, never updated in place. |

`tasks` proper (one row per task: stage, priority, required worker, status,
`completed_by`/`completed_at`) is a small header table the plan file does *not*
replace — the stage machine needs to be queryable. **But** it is a header, not a
queue: nothing in it is a spawn instruction.

**Stage machine** (the brief's `dev->test->dev->test->plan->dev`):

```
draft → plan → dev → test ──fail──→ bugs → dev ──pass──→ review → awaiting_user → done
                                   └──pass──┘                │
                                        ▲                  ▼
                                        └─── rejected ─────┘ (back to dev)
```

Each stage has its own **completion probe** (§5d). This matters more than the
arrows: a stage with no independent probe is a stage that advances on a model's
self-report, which is the exact defect plan 69 retired as R12.

## 5. Q1 — How do we identify when the task is done?

### 5a. "Done" is three questions wearing one word

This is the trap in the question, and it is the same shape as plan 62's
`open`/`busy`/`live` split. Collapsing them is what makes the idle-timeout
heuristic look plausible and be wrong.

| Question | Answered by | Measured? |
|---|---|---|
| **Is the Worker working right now?** | a turn/step boundary in the agent's own store | **Yes, today, exactly** — §5b |
| **Did the turn end?** (an event, observable) | the same boundary, falling edge | **Yes, today** — §5b |
| **Is the TASK done?** | **the human.** The brief says so verbatim: *"the task will be considered complete when the user confirms"* | n/a — a decision, not a measurement |

**So paddock never auto-completes a task.** That is not a limitation, it is the
brief's design, and it is also the only safe answer: a task is "done" when a
person says the work is good, and no amount of transcript shape proves that. What
paddock must do is make the *evidence* for that decision available and cheap, and
detect the two things it *can* know — working vs. not, and stalled vs. running.

### 5b. The answer: opencode writes down that it stopped. Read that.

> **CORRECTION from plan 75's measured result (2026-09-29) — read this before
> using the rule below.** Plan 75 captured a real dead-on-arrival turn
> (`ses_f12b8a757ffeyOtFZyNoZiTYRw`): user 13:08:08.876 → **empty assistant
> 20 ms later, zero parts, zero tokens, no `error`** → user 13:08:27.747 → **nothing
> at all, ever** (re-checked 5.8 h later: still 3 messages, still 0 output
> tokens).
>
> Two consequences, both of which change this section:
>
> 1. **Anchor the boundary to the assistant message of the current user turn, not
>    to "the newest `step-finish` anywhere in the session."** The failed session
>    contains **zero `step-finish` parts at all**. A global "newest step-finish"
>    query therefore returns a *stale* boundary from an earlier turn — or none —
>    and would either report "done" for a turn that never ran, or hang on
>    `tool-calls` from a turn long since abandoned. **The boundary must be
>    resolved within the newest user turn, and the absence of a boundary is
>    itself a first-class state, not a fallback.**
> 2. **A turn that produces no `step-finish` must not read as "not done yet".**
>    It is a *failed* turn. Plan 75 §4b measures the cheap disambiguator:
>    **`failed = newest message is `user` AND not busy AND tokens_output == 0`**,
>    which was 1 hit in 950 sessions and that one hit was the failure.
>
> Also measured and now settled: `reason` has **three** values, not two —
> `{tool-calls: 1916, stop: 103, unknown: 3}` over 8000 parts. `unknown` stays
> *unexplained* (plan 75 §6) and must be a distinct state, not folded into
> "still working".
>
> And `FreeUsageLimitError` is **not** a usable exhaustion discriminator: all 7
> occurrences in the store are `429` / `isRetryable: true` with the *transient*
> "Rate limit exceeded" body. It also lives in `error.data.responseBody` as a
> **JSON string**, not at `error.data.body.error.type`.

**The agent's own store records the turn boundary, with a semantic reason.** Each
assistant step ends with a `step-finish` part whose `data.reason` says why the
step ended. Measured across 400 assistant messages on `pad-opencode-proj`:

```
step-finish reason values: { "tool-calls": 390, "stop": 6 }
```

Two values, and one of them is the answer:

- **`reason: "stop"`** — the agent ended the turn **on its own**. It has nothing
  further to do until a human speaks. **This is the session-is-complete signal,
  and it is a stored fact, not a heuristic and not a timeout.**
- `reason: "tool-calls"` — the step ended only to make tool calls; the turn
  continues.

The live timeline of this very conversation, read out of the store, shows both:

```
36.158  step-start → reasoning → tool bash:completed
36.158  step-finish  reason:"tool-calls"          ← turn continues
40.575  step-start → text → tool write → step-finish reason:"tool-calls"
07.447  step-start → reasoning → text → step-finish reason:"STOP"   ← TURN ENDS
16.640  text ("You already answered this one…")   ← new human turn arrives
16.677  step-start → reasoning → text → tool → step-finish reason:"tool-calls"
32.659  step-start → reasoning → tool bash:running ← in flight right now
```

**Detection is therefore one indexed query: read the newest `step-finish` part
and look at `reason`.** `stop` → this turn is finished. `tool-calls` → still
working. No clock, no idle guess, no false positive from a long build (a build
is `tool-calls` and stays `tool-calls` for as long as it takes).

**The trap this replaces.** My first answer to this question was a `midStep`
proxy (newest `step-start` newer than the newest `step-finish`). It works, and it
is *worse* — it infers the boundary by comparing two timestamps when the store
records the boundary and its reason outright. Worse, the naive version of the
same idea is **wrong in a way that matters**: **a `text` part is NOT a turn
boundary.** In the trace above, `16.640` is a full prose message from the agent
and the turn then carried straight on (`16.677` step-start, more tools). Agents
narrate mid-turn constantly. Anything that treats "the agent said something" as
"the agent finished" fires on every long turn.

**Bonus — exact per-cycle tokens.** The same `step-finish` part carries
`tokens: {total, input, output, reasoning, cache:{write, read}}` and `cost`.
`total` is cumulative for the session (measured climbing 85928 → 86324 → 93176 →
93512 → 93806 → 94912 → 96249 across seven steps), so **per-cycle cost is the
delta between consecutive `step-finish` parts** — which is the granularity the
dev→test cycle actually wants, finer than the per-session numbers in §5e.

**What `stop` is NOT.** It means the agent stopped talking. It does not mean the
work succeeded, and it emphatically does not mean the task is done — the brief
keeps that with the human. `stop` answers *is the session still working*, which
is the question paddock was asked to watch. It is the moment `task_wait` returns
and the moment a stage gate may consider advancing.

| driver | terminal marker | source | state |
|---|---|---|---|
| opencode | `step-finish` with `reason: "stop"` | `part.data.reason` | **MEASURED**, 400-message sample |
| codex | `task_complete` | `event_msg.payload.type` | **MEASURED** (1 pair in the one rollout on this host) |
| claude | — | — | **UNMEASURED: this host has zero claude transcripts** |

`lastToolCall.status: "running" | "completed" | "error"` (already shipped in
`plan_activity`) is the same fact at tool granularity, and it composes: a running
tool *inside* an open step is unambiguous, and a closed step with no new tool is
a turn that has ended.

### 5c. "The driver LLM won't get a notification" — correct, and push is the wrong answer

The brief is right that nothing notifies the Driver. Two options, and the obvious
one is wrong:

**Push into a session — rejected.** Delivering a notification means
`mission_send` on a session the Driver did not start, which (a) is the `exec`
bucket typing into a conversation that may be a *human's* (plan 52 law 2: one
holder, no layer-skipping), (b) can land inside the human's turn, and (c) would
make Paddock an unrequested participant in a conversation. The one place a push
is safe is a session the Driver itself opened and holds `locked` — treat that as
an opt-in, not the default.

**Pull with one blocking call — proposed.** `task_wait {task, since?}` blocks
server-side until the bound session's step/turn boundary changes, then returns
the new events. While the Driver waits it costs nothing; the server does one
~2 ms indexed query per poll tick.

Three rules it must obey, all from existing lessons:

1. **A timeout is a real answer, not a failure.** Return
   `{timedOut: true, stillRunning: <midStep>}` and say so in words. A timeout
   that reads as an error teaches the caller to retry, and a retry that re-arms
   the wait is fine but a retry that *re-sends a prompt* is plan 69's steering
   race.
2. **Cap `timeout_ms` and report what it was.** `pad_create_agent` already
   documents that a long build outlives the call; a wait is the same shape.
3. **Idempotent on `since`**: it takes an event cursor, so a Driver that was
   disconnected resumes exactly where it was rather than re-reading the world.

This satisfies plan 69's own hard requirement — *"the loop lives INSIDE the MCP
tools, not in the LLM's head… the LLM must not have to poll/call repeatedly"* —
without inventing a push channel.

### 5d. Evaluating the brief's own heuristic honestly

The brief proposes: *"poll the session messages and see when it does not change
for few minutes then its not progressing (if its on a build that needs to be
handled)."*

**Verdict: correct instinct, wrong instrument, and it answers "stalled", not
"done".** The false-positive table is the whole argument:

| Transcript idle for N min, because… | is it done? | N needed |
|---|---|---|
| the Worker finished and is waiting | **done** | 1–2 min |
| a build/test is running (`npm run build`, 8 min, no transcript) | **not** | 10–30 min, per project |
| parked on a permission dialog | **not** — `blockedOn: "permission"` already exists and is *cheap and exact* | 0 — no wait at all |
| the TUI crashed / the pad was recreated | **not** | 0 — `live: false` is exact |
| the agent is thinking (long reasoning step) | **not** | unbounded |

So idle-time alone cannot be the verdict — and the brief already spotted the
build case. The fix is that **each row has a cheaper exact answer that dominates
the timeout**, so the timeout only has to cover the one case nothing else can
see (a long silent build):

```
done?      → never auto (human decides)
blocked?   → blockedOn === 'permission'        (exact, 0 wait)
dead?      → live === false                   (exact, 0 wait)
failed?    → failedTurn (plan 75 §4b: newest msg is `user`,
             not busy, tokens_output === 0)   (exact, 0 wait)  ← NEW
working?   → turn state, resolved INSIDE the current user turn (§5b)
             = tool-calls | stop | failed | mid-step
stalled?   → turn state is mid-step
             && lastActivityAt older than stageToleranceMs
             && lastToolCall.status !== 'running'
                                      ← the ONLY place a timeout is used
```

**`failed?` is a first-class state, not a flavour of "not working".** Plan 75
measured that a dead-on-arrival turn writes **no `step-finish` at all**, so a
"newest step-finish" query returns a *stale* boundary and the turn-machine would
read an abandoned session as working forever — or, worse, read an earlier turn's
`stop` as this turn's completion. Resolve the boundary within the newest user
turn; if the turn has no boundary, the answer is `failed`, not `working` and not
`done`. This is the case the user's original guess (poll for "no change for a
few minutes") cannot see, and the reason the clock is confined to `stalled?`.

`stageToleranceMs` belongs to the **stage**, not the task: `test` gets a large
tolerance (a build is the point), `plan` gets a small one. That is the brief's
instinct made precise, and it is the only honest use of a clock here.

**Per-stage completion probes** (what actually advances the machine):

| stage | probe | self-report? |
|---|---|---|
| `plan` | a review/plan artifact exists (`plan_write` in that session) | no — an artifact |
| `dev` | turn state resolved inside the current user turn = `stop` (§5b), **and** the assistant message carries parts — a `stop` with zero parts is the failed shape (plan 75) | partly — but "the turn ended" is observable |
| `test` | **the exit code of the test command**, run on the PAD via `exec` | **no — an independent oracle** |
| `review` | the human's read | human |
| `done` | the human's confirm | human |

The `test` row is the important one: the whole dev→test loop is only trustworthy
if `test` is graded by something other than the agent that just wrote the code.
`exec {cwd: <project folder>, command: <test cmd>}` returns a real `exitCode`
(already shipped, already returns `cwd` + `exitCode` per plan 61). An agent that
claims green while the oracle says red is exactly the failure mode worth spending
a tool call on. **This is the one place the loop must be willing to contradict
the Worker**, and it is why §8 Q4 asks the user to confirm the test command.

### 5e. Tokens: available for one driver, unmeasured for two

The brief wants *"total tokens used, and all"*, summed across every attempt.
Measured on the live opencode store — the `session` table carries six usable
columns, already populated:

```
tokens_input 29348 · tokens_output 1122 · tokens_reasoning 496
tokens_cache_read 641652 · tokens_cache_write … · cost …
```

**codex**: the one rollout on this host (11 lines) contains **zero** token fields.
**claude**: no transcripts exist here at all. So per the plan-64 lesson that a
per-driver facility has per-driver costs, tokens are **opencode: exact**,
**codex/claude: unmeasured, reported as `null` with a reason — never as 0.** A
zero would be a false cost claim on the exact page the user reads to decide
whether a task was cheap.

## 6. Q2 — Who decides what the next task is?

**The Driver LLM decides. Paddock does not, and the human only decides
completion.** Not a compromise — each of the three holds a different fact:

| Role | Decides | Cannot decide | Why |
|---|---|---|---|
| **Driver LLM** | which ready task runs next; which stage comes next; what to type into the Worker | that a task is *done* | it is the only party holding the whole picture (the user's conversation + every project's queue). It is the "llm -> manages projects and their tasks" of the brief. |
| **Paddock** | ordering the ready set; the stage-transition gate; the event log; refusing an illegal transition | what to work on, ever | a scheduler that picks work is the retired headless runner, and law 6 forbids it. |
| **Human** | `done`, and rejecting back to `dev` | ordering | *"the task will be considered complete when the user confirms"*. |

**The ordering must be server-computed, and the preview must not be able to
disagree with the claim** — plan 63's exact lesson, where `nextUp` came from a
different selector than the claim and a reader could see a different next task
than the one that got claimed. So: `task_list {status: 'ready'}` returns
`nextUp` from **the same query** the claim uses, and claiming a task *is* binding
a worker + a session to it (one row in `task_attempts`, not a `claimed_by` column
that lies about whether a process exists).

**Paddock's real job in the loop is to be the thing that says no.** The gate is
one function, exactly as `sendVerdict` is one function (plan 62's rule: a verdict
computed anywhere but the gate is a guess):

- `dev → test` only if the bound session is `live` and the turn ended.
- `test → review` only on a **green oracle exit code**, never on prose.
- `test → bugs` on a red one, and the bugs are a structured record, not free text.
- `anything → done` only on a user confirm, stamped `completed_by` + `completed_at`.

## 7. Q3 — The topology: one Worker, one Driver

The brief's closing constraint — *"paddock side we only have 1 agent thats running
the tasks, and another is driver llm"* — is a **serialization** constraint, and it
changes the model in one specific way.

With one Worker, **a task's `dev` and `test` stages cannot run in parallel with
another task's**, so:

- The ready set is per-`(agent, folder)`, not global. A task declares the
  **project** it needs — which is the one field plan 63 deferred as `project_id`
  (§8 Q2) and the reason to un-defer it here.
- `task_claim` binds **one** task to the one Worker, and the claim is released
  when the attempt's session dies — not held across a whole task. A task that
  spans three sessions holds three attempts, so a dead session must not strand it.
- The Driver therefore needs the ready set to say *what is BLOCKED ON THE BUSY
  WORKER*, not just what exists. A `task_list` that omits the busy task looks
  identical to a queue where the task does not exist — the same
  "list is capped and your item is not in it" shape as `availableNetworks`.
  So: `blockedByWorker: {task, since}` on the row.

The Driver and Worker are different LLM roles, and **the distinction is
enforceable, not social**: `mission_send` requires the `exec` grant, so only a key
holding `exec` can drive the Worker at all. The Driver holds `exec` on one PAD;
everything else is `read`. That is plan 52's law 2 doing the work, and it means
"the Driver cannot type into the Worker" is already true today.

## 8. Open questions (the user's call — the first three change the data model)

1. **Is a task allowed in a session the human is also typing in?** The Mission
   premise says yes (the human and the agent share the TUI). If yes, every stage
   gate must tolerate a human turn arriving mid-stage, and `mission_send`'s
   `locked` refusal becomes "the human is driving; wait", not an error.
2. **New table, or revive `tasks`?** Recommended: **new** `tasks`/`task_attempts`/
   `task_events`, because the old table is spawn-shaped and its `enqueue` /
   `claimed_by` / `pid` vocabulary is for a queue that must not spawn (§3).
   Reviving it would also mean re-deciding plan 63's whole vocabulary.
3. **`project_id` on a task?** Recommended yes, and this un-defers the deferred
   plan-63 item in `infinite.md` § Needs your call. §7 needs it.
4. **May the `test` stage run `<test command>` on the PAD via `exec`?** This is
   the independent oracle of §5d, and it means the Driver can name a command that
   executes in the Workspace. Without it, `test` degrades to a self-report.
5. **Where does the test command come from** — a field on the task, the project's
   existing test script, or a prompt convention? (Recommend a field; convention
   is a guess the oracle then has to guess at too.)
6. **Commit: automatic at green, or staged for the human?** (69's open question,
   unanswered.) Recommend staged — the brief makes the human the approval gate
   for everything else, and an auto-commit is the one irreversible step.
7. **The `test`/`dev` loop: who types the next prompt — the Driver, or does
   `task_wait` wake it?** The brief says the loop lives in the tools, but a tool
   cannot choose what to type; it can only report. Recommend: the Driver types,
   `task_wait` reports. (This is the line between "loop in the tools" and "loop
   in the LLM", and it is the one place plan 69's phrasing needs tightening.)
8. **Where do tasks live for a project whose folder is outside the plans root?**
   `plan_write` requires an explicit `agent` because three pads share `/www1`
   (64 §3d). A task therefore lives in the *PAD's* `plans/`, scoped by
   `project.folder` — accept the scan, or add a real per-project index?

9. **The §9 `midStep` sequencing trap, in one line:** `agent-store.js` is the file
   to touch, and every measured row in §5b/§5e comes from *reading a real store on
   this host* — so a "done" claim for claude or codex rests on a file that is
   absent here. Do not let the plan read as three verified drivers.

## 9. Build order (not started; the sequencing trap is noted)

- [ ] **§8 answered.** The data model cannot be drawn before 1–3 are settled.
- [ ] **`midStep` / turn boundary** in `agent-store.js` — an extension of the
      shipped `plan_activity` reader, per driver, with `unmeasured` for any
      driver this host cannot prove. **TRAP: claude has no transcript on this
      host, so "it works" cannot be claimed for it — ship it as a third column
      of the table, or do not claim three drivers.**
- [ ] **The gate** (one function, like `sendVerdict`), with the legal-transition
      table and a test that asserts every ILLEGAL transition refuses.
- [ ] **`task_events` + `task_attempts`**, migrations, and the `db-migration`
      control (assert the columns are ABSENT when the ALTERs are suppressed).
- [ ] **`task_list` / `task_claim` / `task_wait` / `task_advance` / `task_confirm`**,
      `nextUp` from the claim's own selector.
- [ ] **The `test` oracle** (`exec` + exit code) — only after §8 Q4 is yes.
- [ ] **Cycle: `dev → test → dev`**, driven by the Driver, gated by §5d.
- [ ] **Timeline projection** onto the plan file (`like a github issues page`),
      append-only, with tokens per §5e and `null`+reason where unmeasured.
- [ ] **Chat-test** the whole loop from the MCP as a real LLM; friction to
      `friction/`, per `friction/README.md`.

## 10. Verify

- [ ] `timeout 60 docker exec paddock node --test test/mission.test.js` —
      **throwaway `PAD_DB_PATH`**, that suite's own note.
- [ ] A migration control that fails with the ALTERs suppressed (plan 63's rule:
      every assertion in a migration suite also passes on an already-migrated db).
- [ ] **Re-measure `midStep` with a control**: assert it is `true` during a live
      turn and `false` after the turn ends, in the same session. A signal that
      only ever returns `true` looks exactly like a working one.
- [ ] A `task_wait` that times out returns `timedOut: true` with a real
      `stillRunning` — never an error, never an empty success.
- [ ] The `test` stage refuses a green claim from the Worker when the oracle's
      exit code is non-zero. **This is the control that proves the loop is not
      self-certification** — remove the oracle and this must go red.
- [ ] Tokens: `null` + reason, never `0`, on a driver with no token fields.
- [ ] Chat-test from the MCP; report friction.
