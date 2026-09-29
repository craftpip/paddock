# Infinite — the forever task queue

The agent's protocol for this file is `AGENTS.md` § Infinite loop. Nothing here
is read by the app; it exists so the user can drop work in and the agent picks it
up on the next "keep going".

**How to use:** append one line per plan to `## Queue`, top line = next up:

```md
- [ ] plans/59-something.md
```

Then tell the agent **"check infinite"** (or **"keep going"** / **"drain"**).
It works infinite: test each plan, commit it, then move straight to the next
until the queue is empty. **Infinite means keep going — never stop after one.**

## Needs your call

Decisions only you can make. Deliberately **not** `- [ ]` lines and **not** in
`## Queue`, so a "drain the queue" run cannot close a session or delete a pad on
its own recognizance — the agent's job is to surface these, not to guess. Each
one is a single reply away from done.

- **A stray Mission session on the `paddock` project** — `msn_aac88d72b8f5b16c`,
  label **"MCP tool orchestration suite"**, `origin=human`,
  `created_by=user:admin_1784916138567` (the REST path — not an MCP key, so no
  test key can be pointed at it), created 2026-09-29T07:49. The label says test
  suite, but nothing can attribute it to one, and **Close tears down that
  session's tmux session** — if it is a live conversation, that is a real kill.
  Your click, not the agent's: close it, or leave it.
- **Four leftover `pad-test-*` agent rows** — all kept, none deleted:
  `pad-test-claude` and `pad-test-codex` have **real instance dirs**;
  `pad-test-p25-clone` is DB-only with no history; `pad-test-p25` is DB-only but
  has `activity_events` from **2026-08-08** (create + settings update), so
  deleting it would destroy a real audit trail. Say the word if any should go.
  (For contrast: the 5 DB-only `pad-msn-*` seed rows **were** removed — no
  instance dir, no history, nothing to lose.)
- **`project_id` on `task_submit` (plan 63, finding 1k-related — not built, asking
  first).** The task queue reads a `name` (the PAD to run in) and has no way to say
  *which project within that PAD* the work belongs to. Plan 63 built the resolver
  that would carry it and stopped there, because plan 52 retired the headless task
  path and the 9 `task_*` tools are currently **hidden from the MCP surface**
  (`PADDOCK_TASK_QUEUE=1` re-enables them), so a `project_id` on a submit no caller
  can reach is speculative. Your call: add it, or leave the queue as a PAD-level
  concept. Nothing depends on the answer and nothing is blocked by it.
- **Rotate the 2 exposed MCP tokens** — plan 60 stopped the leak but cannot
  un-leak the credentials; operator action, §5. Tracked on its queue line below.

## Queue

- [ ] plans/64-plans-facility.md — `/plans` as the LLM's task method, **spec confirmed + session-bound with timings** (plan §1a: frontmatter `session:`/`created`/`started`/`last_activity`/`done`; §4: `plan_activity` reads the agent's own store from the host, so last chat + last tool-call timing survive a terminated container, ~0-6ms per call, pollable at 5s). Supersedes 53 Phase 9; owns 67 §67.1. Also retires `workspace_list`/`workspace_read` and **repairs** `workspace_write` (user decision 2026-09-29) + clears `hostBrowsable` for the paddock repo pad. See its `## Status:`
- [ ] plans/65-session-lifecycle.md — resume a conversation but never read or end one
- [ ] plans/66-network-peer-truth.md — `networkHealth` says "stale" and "running" at once
- [ ] plans/52-orchestrator.md
- [ ] plans/68-mission-page-ideas.md — Mission UI vision (UI-only, gathering): drop scope toggle for selection-driven sessions, persist page state over refresh, dedup fresh sessions, VS Code-style split panes, Ctrl+click multi-select projects
- [ ] plans/69-mission-orchestration.md — Orchestration via MCP (gathering): task lifecycle review → dev → test → bugs → commit with the loop inside the tools; nouns agreed (Driver/Orchestrator/PAD/Project/Session/Worker/Task/Human); session last-message + timing for done-ness
- [ ] plans/60-mcp-secret-hygiene.md — build done + verified (mcp 79/79, vm-manager 108/108), `## Status:` reads Complete, but **not yet absorbed** (file still present) and one open item remains — **blocked: rotate the 2 exposed MCP tokens (operator action, plan §5)**, which no agent can perform. Parked at the BOTTOM on purpose: it is not done, but leaving it at the top would head-block the loop on an action only the user can take.

## Done

- [x] plans/63-task-queue-vocabulary.md — absorbed 2026-09-29 into docs/reference/backend/services.md (§ Task Runner — "The queue's vocabulary") + AGENTS.md: `task_get_next` takes **`worker`** and a `name` there is a hard **refusal**, not an alias (with `worker` left optional in the schema so the SDK's `expected string, received undefined at worker` does not pre-empt the sentence that explains the difference). Five FACTS added to `tasks` — `enqueue`, `timeout_ms`, `timed_out`, `attempt`, `superseded_by` — and every agent-facing word **derived** from them: `route: push|enqueued|pull`, `outcome: ok|error|unknown` (unknown is a real third value, never failure), `timedOut`, and `claimed_by` keeps its one spelling with a test pinning the absence of a `claimedBy`. `task_list` is in **service order** with `nextUp` from the same selector the claim uses, so the preview cannot disagree with the claim and reading the queue does not consume it; `total`/`truncated` are counted **after the access filter, before the slice** (they were unscoped, so they described a different set than the rows in the payload). A pool submit now carries its `queue` + `recentClaimers` and says it is inert until claimed — there is no worker-presence registry, so no polling count is invented. `task_retry` (new, `exec`-gated) re-files with `attempt`/`superseded_by` and the replacement is **always** claimable, because copying the original's `enqueue` left a retried *push* labelled `push` with no child process. `task_complete` requires `worker`, resolves it through the shared name resolver, and reports `task_not_claimed` **before** the pending-state check because that is the thing the caller must fix. `submitTask` is async and verifies the PAD's effective workspace exists **in-container**, refusing `task_workspace_missing` before inserting. `task_result` strips ANSI at the boundary (the DB keeps raw bytes); listings mark a clipped prompt; a timeout is `error` + `timed_out: 1` instead of reading identically to a cancel. **Two things found on the way:** `mode` and `route` were two answers to one question in the same response, and `tasks.test.js` was running against the **live** DB with `DELETE FROM tasks` in `beforeEach` — it now uses a throwaway `PAD_DB_PATH`. Tests: tasks 72/72, **task-mcp 28/28 (new suite — the 9 tools through a real MCP client with `PADDOCK_TASK_QUEUE=1` set before load, since the service alone tests no schema or description)**, mcp 119/119, db-migration 11/11, db 3/3, mission 80/80, pad-tmux 24/24. The migration suite gained a **control that asserts the columns are ABSENT when the ALTERs are suppressed** — re-measured by deleting the loop: 3 red, 11 green on restore. Live: `/mission` renders with 0 console errors after restart; the 9 task tools stay hidden on the default surface. **Not built:** `project_id` on `task_submit` (see § Needs your call).
- [x] plans/62-mission-liveness-truth.md — absorbed 2026-09-29 into docs/reference/backend/services.md (§Liveness truth) + AGENTS.md: one `mission.stampTruth()` computes `(live, busy, busyKnown, open)` and BOTH list and detail run it, so a dead row reads dead instead of `busy: true, open: true` and a project header can no longer print `openCount > liveCount`; `busy` requires `live`, a dead row keeps `wasBusy` for forensics, and a cwd that differs from the project folder yields `busyKnown: false` (UNKNOWN, never idle). `kind: agent|shell` on every row makes the destructive trap visible *before* the write, and the shell test **fails closed** (an unknown/empty `pane_current_command` is a shell, never an agent). `mission.sendVerdict()` is the single function both `sendText`'s gate and the `canSend` projection call — it refuses a dead pane, a shell pane (`mission_not_an_agent`: the text would run as shell commands), a solo-locked one and a permission-parked one; `open` deliberately keeps its narrower meaning (a TUI is attached) because absorbing `locked` into it would unlight a human's own solo-driven session. A permission dialog is a state, not idle capacity: `blockedOn: "permission"` with tool+path, answered **by key** through `mission_permission_answer` (agents get `once`/`reject`; `always` is the human's `POST .../permission` route). A write is confirmed by the pane **changing** — capture before, poll ≤1.5s, `mission_tui_not_ready` if it never moved — so a live pane is no longer an acknowledgement, and that same comparison IS the post-send repaint wait. Two clocks: `last_seen_at` moves on every read, `last_output_at` only on a genuine content change (sha1 stored beside it, since no in-memory cache survives a restart), and the store returns the timestamp it *stored*. Writes echo `project` + `session_id`, every Mission error carries a `[project:… session:…]` suffix, and the agent's own title is `session.title` (via `driver.sessionTitle`, keyed by the agent's session id) kept apart from the operator's `label`. Two findings the plan did not ask for: the client was re-deriving `open = live || busy` and lit the dot for exactly the shell pane the server had just refused (a second source of truth, and the wrong one), and the fake panes in the tests were **black holes** that had to be given an echo. Tests: mission 80/80, mcp 119/119, pad-tmux 24/24, db-migration 7/7, db 3/3, plus mutation controls (reverting `canSend` to `session.open` and removing the 1f migrations each turn tests red). Live: `/mission` shows dead rows unlit, 3 shell rows badged, `paddock` at 14 rows / 4 dots matching the API, no console errors; the permission route 400s a bad choice and 409s with no dialog pending.
- [x] plans/67-project-progress-and-provenance.md — absorbed 2026-09-29 into docs/reference/backend/services.md + AGENTS.md: `mission_projects` takes `project_id` / `name` / **`folder`** (a project's name is not its folder), refusing on zero (`mission_project_not_found`) or several (`mission_project_ambiguous`) matches with the candidates, hinting near-misses in BOTH containment directions so a typo is found, and carrying `agentStatus` so reachability needs no second tool; sessions carry `createdBy` (`key:<id>` over MCP, `user:<id>` from the UI) beside `origin`, emitted only when stamped and never back-filled with a guess; nested `sessions` are opt-in via `include_sessions` and the counts serialize first (unfiltered: 26 nested rows → 1562 bytes), and the description says **LIVENESS, not progress** in as many words. §67.1's mechanism stays with plan 64. Also fixed on the way: `openCount` was skipped entirely for a project with zero sessions (the probe's early return also skipped the counting), so it is now always a number — absent only when the caller never loaded sessions. Tests: mcp 111/111, registry 4/4, vm-manager 111/111, mission 54/54, db 3/3, tasks 41/41, auth 3/3, container-health 8/8, log-store 1/1, ownership 6/6, pad-tmux 19/19, workspace 11/11 — all 12 suites green. Post-completion audit added the missing coverage: **db-migration 6/6** (the `created_by` ALTER had no test, via a new `PAD_DB_PATH` override; fixture derived from the real schema, and a control with the migration removed turns 4 of 6 red), and `mission.test.js` now runs on a throwaway DB so it no longer wipes the live Mission tables. Friction: 4 of 7 findings resolved here, 3 owned by plans 62/65.
- [x] plans/61-fleet-identity.md — absorbed 2026-09-29: one shared `resolveAgentName()` (exact / bare / `display_name` / unique substring, ambiguity refused) behind `requirePad()`, so every tool gates AND acts on the *resolved* name; `list_agents` rows are openable by construction + `scope`/`agentsTotal`/`owner`; `exec` returns `cwd`/`requestedCwd`/`exitCode` and takes a quoted `cwd`; `settings_get` gains `networkFilter`; `job_status` reports `padExists`; a non-PAD host container is named as one. Post-absorb audit also fixed `update` (acted on the raw name) and the `agent_logs`/`workspace_read` raw-name echoes, and moved the peer filter BEFORE the cap so `searchedAll` is true. Tests: mcp 93/93, registry 4/4, vm-manager 111/111. **Open: `list_containers` still needs approval.**
- [x] plans/59-network-switch-subnet-collision.md — absorbed 2026-09-29 into docs/reference/backend/services.md (pad subnet pool, `cleanStaleDoorDirs`, log-store door exclusion) + docs/reference/operations/overview.md (pool troubleshooting) + AGENTS.md (reservation ≠ live network, stale-door sweep writers)
- [x] plans/58-mission-page-updates.md — absorbed 2026-09-28 into plans/53 §6 (col-3 `openSession` contract, listing rhythm, modal confirms) and §9a (defects 5 and 6)
