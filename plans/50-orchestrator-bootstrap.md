# Plan 50 — Orchestrator bootstrap: inspect → inventory → devcontainer → setup → dispatch

## Status: [SUPERSEDED by plan 52 — do not build from this file; remaining work tracked ONLY in plan 52]  Draft (2026-09-24) — raw requirements from the user. 0 phases
built, design NOT started. Depends on: plan 49 (workspace modes) for agent
setup, plan 48 (task queue + steering) for dispatch, plan 41 (devcontainer
generate) for devcontainer handling. Nothing here is verified against the
current MCP/lifecycle surface yet — every tool name below carries a verify
marker.
Build order: Block 4 (runbook), needs Blocks 0–3. Master sequence: plan 48 “Build order”.

## 1. The user's requirement (kept intact)

> When all of this is done, when the agent is created, then it will be up all
> the time. So what would happen for the orchestrator: the orchestrator would
> FIRST set up the agent. The orchestrator would have to see what the
> folder's — the target folder's — requirements are, how many agents are
> already created for it, if there is no dev container in it then manage
> that, handle the dev container thing.

The orchestrator never dispatches into a void. Every run begins with a
bootstrap sequence — setup BEFORE tasks. Order is fixed:

```
inspect folder → inventory agents → devcontainer check/handle →
setup (reuse or create) → dispatch → steer → collect
```

## 2. Step 1 — Inspect the target folder (requirements discovery)

The manager MUST see the target folder before doing anything:

- [ ] List the folder (`workspace_list`) — what stack is this? (language,
      frameworks, package files, existing docs).
- [ ] Read the requirements signal: `.devcontainer/devcontainer.json` if
      present (base image, features, ports, post-create hooks); else infer
      from the tree (`package.json`, `requirements.txt`, `go.mod`,
      `Dockerfile`, …). Inference rules are design-phase work — v1 may be
      "report what you found and ask" rather than silent auto-detect.
- [ ] Record the findings ON the run (task prompt context / steering note) so
      a later steer or a second manager session doesn't re-discover them.
- VERIFY: which of this is reachable over MCP today (`workspace_list/read`
  exist per plan 47 — confirm scoping: can the manager read a host folder
  with no PAD attached to it yet? If not, bootstrap needs a scout path —
  design must answer).

## 3. Step 2 — Inventory existing agents for the folder

> "How many agents are already created for it."

- [ ] List agents and filter by workspace source (`WORKSPACE_HOST`/`meta` —
      VERIFY a query path exists: `list_agents` + filter client-side vs a
      dedicated lookup; plan 49's mode flags join this filter).
- [ ] For each match: status (running/stopped?), agent type, workspace mode
      (bind/copy/volume — plan 49), what it's currently doing (any
      non-terminal tasks? `task_list` per PAD).
- [ ] Reuse policy (design must fix the rules — user's direction so far):
      a running bind-mode agent for the folder is the MAIN LINE — reuse it,
      don't duplicate it. Parallel/experimental streams get NEW copy-mode
      agents (plan 49), never a second bind on the same source.
- [ ] Stopped agents: restart (`start`) vs create fresh — restarted agent
      keeps its volume/copy state per mode semantics; design states the rule.

## 4. Step 3 — Devcontainer handling ("if there is no dev container, manage that")

- [ ] If `.devcontainer/devcontainer.json` exists and parses → use it as the
      requirements source (base image/features/ports feed agent setup).
- [ ] If missing → the orchestrator handles it: generate one (plan 41 built
      devcontainer generate/sync through the webui — VERIFY MCP reachability;
      if the manager can't reach it, bootstrap needs a creation path, not
      just docs).
- [ ] If present but broken (invalid JSON, unbuildable image reference) →
      report, don't silently overwrite. v1: manager flags it in the run +
      steering note; auto-fix is explicitly OUT (human's repo, human's call —
      same principle as plan 49 §7).
- [ ] Generated devcontainers are committed to the source folder (host truth)
      so the next bootstrap finds them — never container-only.

## 5. Step 4 — Setup (start, reuse or create, then ensure UP)

- [ ] STOPPED agent exists → simply START it, no asking (plan §8 law 3:
      starting restores human-approved state — reversible, no new
      footprint). Then reuse it.
- [ ] Prefer reuse (§3 policy). CREATE only when: no agent for the folder
      (and then only on user go-ahead per §8 law 3 — report type/mode and
      wait), or the work needs isolation (copy/worktree-mode parallel —
      creation of an experiment agent is still creation: propose, wait), or
      the type is wrong for the task (needs codex, only openclaw present —
      plan 48 drivers; same propose-and-wait).
- [ ] Create carries the workspace mode decision (plan 49): main line = bind
      (or pre-existing), experiments = worktree (git) / copy (non-git),
      persistent-detached = volume.
- [ ] Post-create: agent MUST be running before dispatch (health/status check
      — VERIFY tool). "Up all the time" is the invariant: bootstrap ends with
      a running agent, dispatch never starts against a stopped one.
- [ ] Setup is idempotent: running bootstrap twice must not create two
      agents (inventory first, create guarded by re-check — same discipline
      as plan 47's atomic claim).

## 6. Step 5+ — Dispatch → steer → collect (already designed, referenced not repeated)

- Dispatch: plan 48 (`task_submit` push / pool+`task_get_next` pull).
- Steer: plan 48 §H (note/stop/redirect, resume-first, token ladder).
- Gates: plan 48 §H approve + §K control (the orchestrator — plan 51 role —
  runs ALL of plan 50 too: bootstrap is orchestrator-over-MCP, no UI steps).
- Collect: `task_result`/`task_list` per PAD; findings feed the next
  bootstrap (requirements discovered once, reused).

## 7. Open decisions for the design phase (user calls these, not assumed)

- [ ] Reuse-vs-create thresholds: max parallel experiment agents per source?
      (Answered in §8: cleanup is human-only — no auto-delete ever. Open: a
      cap number + who gets asked when it's hit.)
- [ ] Scout path (§2 VERIFY): if MCP can't read unattached host folders, what
      is the bootstrap's eye? (Options: temporary scout PAD, webui-assisted
      endpoint, operator pastes context — design picks with user.)
- [ ] Inference depth (§2): v1 report-only vs auto-detect stack — user
      decides how much the manager guesses.
- [ ] Broken-devcontainer auto-fix: stays OUT unless the user explicitly
      moves it in.

## 8. Lifecycle governance (user's rules — verbatim intent, non-negotiable)

> The agent runs forever until stopped by the administrator. The orchestrator
> stops it only when the user tells the orchestrator to stop it. If I tell the
> orchestrator to start a task in a project and there is no container for it,
> the orchestrator simply tells me it needs to start an agent for it.

Three laws (corrected 2026-09-24: run-forever is impossible — host resources
are finite. Workers scale to zero; only the orchestrator PAD stays up):

1. **Workers stop when idle, wake on dispatch.** No running/claimed tasks
   for N minutes (N = design work) → the orchestrator stops the container.
   A task arrives → the orchestrator starts it (cheap, automatic, already
   approved — same act as law 3's start). Stop ≠ delete: volumes, worktrees,
   and copy-dirs persist, so wake-up loses nothing. Finishing work is
   therefore a reason to SLEEP, and idleness is the normal state — the fleet
   at rest costs ~zero. The orchestrator PAD itself stays UP (it's the front
   door for Telegram/phone/LLM; one container). Webui restarts still never
   touch container state: boot reconciliation touches task rows ONLY
   (VERIFY in code, Phase 0).
2. **Explicit stop is user-initiated, orchestrator-relayed.** The ONLY
   stop path is:
   user tells the orchestrator to stop agent X → orchestrator stops X (and
   reports back). The orchestrator may SUGGEST stopping ("this experiment
   agent has been idle since Tuesday, want it stopped?") but suggesting is
   not doing — the stop happens after the user says so. Design the runbook
   line as a question template, not an action.
3. **Start is automatic, create is confirmed.** Split, because they are
   different acts (user's refinement, 2026-09-24):
   - Agent EXISTS but is stopped → the orchestrator simply STARTS it. No
     asking. Starting restores a state the human already approved —
     reversible, no new footprint, no new mounts, no build. This is the
     "start an existing agent if it is already there" half.
   - NO agent exists for the folder → the orchestrator tells the user what
     it needs ("no agent for <folder> — start one: type <t>, mode <m>?")
     and creates on go-ahead. Creation is new footprint (container, image
     build, mounts, volume) — that stays human-confirmed. This is the
     narrowed "simply tells me" half, applying to create-only.
   - Rationale to keep: a wrongly-started agent costs nothing and is
     one stop away from fixed; a wrongly-created agent leaves mounts,
     volumes, and images behind. Convenience where it's free, confirmation
     where it isn't.

Consequences for the runbook (Phase 1 must encode all three as checklist
gates, not prose advice):

- After dispatch: done means SLEEP-when-idle (law 1 housekeeping), never
  delete, never explicit teardown steps in the runbook.
- `task_cancel`/`stop` tools stop TASKS, never agents — the runbook must
  never present task-stop as agent-stop. Agent stop is a lifecycle action
  (`stop`/`delete` PAD), gated behind user instruction.
- Missing-agent branch: exactly one allowed behavior — tell the user what is
  needed and wait. Any auto-create path discovered in Phase 0 gets a confirm
  gate, no exceptions.

## 9. Full-lifecycle loop (user's requirement: "a perfect software")

> The orchestrator has to go through all the development lifecycle changes so
> that we can make a perfect software.

A dispatched task finishing is NOT the end — it is one turn of a loop the
orchestrator drives until the work is actually good. The loop, fixed order,
every task, every project:

```
plan → approve plan → implement → test (gates) → review →
  pass? accept : redirect-with-feedback → … → accept → collect
```

- **Plan.** Non-trivial work is decomposed FIRST (pool tasks + `priority`
  ranks, dependencies in prompt context). Trivial work may skip to implement
  — the runbook defines "trivial" (design phase; v1: single-file,
  no-dependency edits).
- **Approve plan.** `needs_approval` gate (plan 48 §H): manager or human
  approves the decomposition before implementation burns tokens. This is the
  cheapest defect to catch — a wrong plan implemented is the most expensive
  token waste there is.
- **Implement.** Dispatch per §6 (push/pull, plan 48).
- **Test (gates).** Every implementation turn ends against quality gates run
  INSIDE the PAD: test suite, lint, typecheck (exact gate set per stack is
  design-phase work; v1: `exec` the repo's own scripts — `npm test`,
  `pytest`, `go test`… — never the manager's guess of correctness). A turn
  that fails gates is not "done with errors" — it is unfinished, and the
  gate output becomes the next redirect's feedback verbatim.
- **Review.** Tail + diff review via `task_watch`/`workspace_read`; approve
  or request-changes (plan 48 §H approve/reject-with-redirect).
- **Accept.** Done = the agent finished. ACCEPTED = gates pass AND
  manager/human sign-off. Only accepted work counts as complete in
  `task_list` terms (design: an `accepted` marker vs raw `done` — Phase 2
  backend if Phase 0 proves it missing).
- **Collect.** Result + summary + what was learned (requirements discovered
  feed the next bootstrap per §6).

Loop bounds (anti-burn rules, designer must fix numbers with user):

- Max redirect turns per task (default TBD, e.g. 3) — past it, the
  orchestrator stops and reports to the user instead of burning ("stuck
  protocol": note + escalate, never infinite retry).
- Gate failures route to the SAME session first (resume-redirect, plan 48
  token ladder) — a fresh agent for a fix is the last resort, same as any
  redirect.
- Merge/release mechanics stay OUT (plan 48 §J) — "perfect" ends at
  accepted-in-the-PAD; the PAD's own git history (§1.4) is the record.

## 10. Phases (sketch — design phase will concretize)
- [ ] Phase 0 — VERIFY every tool/path marker above against code; record.
- [ ] Phase 1 — bootstrap runbook in `llm-guide.js` (the manager's playbook):
      inspect → inventory → devcontainer → setup → dispatch checklist with
      exact tool calls. No new backend — runbook only, tested as a live
      manager walkthrough on a throwaway folder.
- [ ] Phase 2 — backend gaps Phase 0 finds (e.g. scout path, inventory
      filter, setup idempotency guard). Only what Phase 0 proves missing.
- [ ] Phase 3 — absorb into `docs/` and close. Gated on explicit user
      confirmation (house rule).

## Verification (house rule)

- Phase 1 verifies LIVE: a real manager walkthrough over MCP on a throwaway
  folder (inspect → inventory → devcontainer → setup → dispatch one task →
  steer it → collect), narrated step by step, before the runbook counts as done.
- Backend edits (if Phase 2 exists): `docker restart paddock` +
  individual test files only.
