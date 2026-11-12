# Plan 48 — Multi-driver task running + live monitoring

## Status: [SUPERSEDED by plan 52 — do not build from this file; remaining work tracked ONLY in plan 52]  In progress (2026-09-24) — design complete incl. PRIMARY steering
(§H: resume-steer, no token rebuild; §J: VibeKanban segment map), Phase 0
(code reading) done, build not started. User approved (2026-09-24) folding
Bernstein steering items in: `task_steer` + `task_approve` become Phase 4,
hooks/role-fence Phase 5; docs absorb moves to Phase 6. User constraint:
resubmit-redirect is LAST resort (token waste) — resume-steer is the
mechanism, resume flags confirmed live first. Phases 1–6 planned below.

> Plan 47 built the task queue opencode-only (`submitTask` hard-rejects any
> non-opencode driver at `task-runner.js:197`). This plan removes that wall:
> task running becomes a **per-driver capability** each agent type declares,
> and the queue gains the **live observability** an orchestrator needs — no
> more fire-and-forget "to-do list". The user framed this: *"I am the
> orchestrator… you will keep alert, take care of the agents until it's done…
> Like a small AI software development company."*


## Goal

1. **Multi-driver tasks.** `task_submit { name }` works for any PAD whose
   driver declares a `task` capability — opencode (`opencode run`) and codex
   (`codex exec --json`). A PAD whose driver has none (openclaw, picoclaw,
   hermes, claude) returns a clear, tool-native message:
   *"Task submission is not supported by <type> agents."* Nothing else
   changes — the management surface (status/result/cancel/list, pull loop)
   stays uniform across types.
2. **Live monitoring.** While a task is `running`, an orchestrator can now
   watch:
   - **Throttled flush** — stdout/stderr + a progressively half-baked
     `result_summary` are written to the DB every ~1s, so `task_status { tail }`
     shows real-time output instead of `''` until exit.
   - **Heartbeat** — `last_output_at` column: "is it stuck?" becomes a query
     (`running` but no new output for N minutes = suspect), not a guess.
   - **`task_watch` long-poll** — park on a task; returns at terminal state or
     after a `wait` window with the freshest tail.


## Research (2026-09-24)

- opencode `--format json` event shape already captured (plan 47): final text
  at `part.text`, top-level `text` fallback.
- codex `exec --json` JSONL shape — **live-captured on `pad-test-codex`**
  (`thread.started`, `turn.started`, `item.completed`, `turn.failed`,
  `error`). Success events: `{"type":"item.completed","item":{"id":"…",
  "type":"agent_message","text":"…"}}`. Older/experimental builds used
  `item.item_type: "assistant_message"`. Docs (`learn.chatgpt.com/docs/
  non-interactive-mode`) confirm `-o/--output-last-message` writes the final
  message to a file and `--json` streams JSONL. The extractor must accept
  both `item.type` and `item.item_type` spellings and take the **last**
  agent-message text.
- codex needs `--skip-git-repo-check` (workspace may not be a git repo) and
  `-C <dir>` for the working root. Auto-approve maps to a sandbox level;
  exact flag set gets confirmed live in Phase 2 (codex PAD is currently not
  logged in, so push uses a codex harness + `codex doctor`-level check).


## Design

### A. Driver capability: `task`

Each driver object gains an optional `task` block. **Presence = supported.**

```js
// opencode / codex (the two supported drivers)
task: {
  supported: true,
  // Build the inner container command (no pidfile/exec wrapper — the runner
  // adds that). Returns a shell string.
  buildCommand(prompt, { workspaceDir, model, agent, autoApprove }) { … },
  // Extract the final assistant text from the captured stdout stream.
  extractSummary(stdout) { … },
}
```

Drivers without a `task` block (openclaw, picoclaw, hermes, claude) are
"supported: false" implicitly — the runner throws at submit:

```
Task submission is not supported by <type> agents
```

openclaw/picoclaw/hermes/claude ship **no** `task` block. Future types just
add one; nothing in the runner special-cases the type name.

### B. task-runner delegation

- `submitTask` replaces the `driver.type !== 'opencode'` throw (`:197`) with:
  `const cap = getDriver(pad.agent_type).task;` — absent → the not-supported
  error above.
- `buildCommand(prompt, opts)` is **removed**; the runner asks the driver for
  the inner command, then wraps the existing pidfile + `PADDOCK_TASK_ID` +
  `exec` shim around it:
  ```js
  function buildExecCommand(driver, prompt, opts, taskId) {
    const inner = driver.task.buildCommand(prompt, opts);   // driver's own shape
    return `echo $$ > /tmp/paddock-task-${taskId}.pid; PADDOCK_TASK_ID=${taskId} exec ${inner}`;
  }
  ```
- `extractSummary(stdout)` is **removed** in favour of `driver.task.extractSummary`.
  After the stream cleanup we call it with the captured stdout.

### C. opencode driver task block

```js
task: {
  supported: true,
  buildCommand(prompt, { workspaceDir, model, agent, autoApprove }) {
    const parts = ['opencode run', '--format json'];
    if (workspaceDir) parts.push('--dir', sq(workspaceDir));
    if (model)         parts.push('--model', sq(model));
    if (agent)         parts.push('--agent', sq(agent));
    if (autoApprove)   parts.push('--auto');
    parts.push('--', sq(prompt));
    return parts.join(' ');
  },
  extractSummary(raw) { … plan 47's part.text logic verbatim … },
}
```

### D. codex driver task block

```js
task: {
  supported: true,
  buildCommand(prompt, { workspaceDir, model, autoApprove }) {
    const parts = ['codex exec', '--json', '--skip-git-repo-check'];
    if (workspaceDir) parts.push('-C', sq(workspaceDir));
    if (model)         parts.push('-m', sq(model));
    // autoApprove → the sandbox level that lets it actually do the work headless.
    if (autoApprove)   parts.push('--sandbox', 'danger-full-access');
    parts.push('--', sq(prompt));
    return parts.join(' ');
  },
  extractSummary(raw) {
    // last item.completed whose item.type/item.item_type is agent_message or
    // assistant_message, take item.text; fall back to raw when unparsable.
  },
}
```

(Exact codex sandbox/approval flags confirmed live before finalizing.)

### E. Live monitoring

**`tasks.last_output_at TEXT` column** (`db.js` migration + ALTER for old DBs,
same pattern as `owner_id`).

**Throttled flush in `attachProcess`**:
- keep the in-memory accumulator; add a ~1s `setInterval` that writes capped
  `stdout`/`stderr` + a *live* `result_summary` (driver extract of current
  accumulator) into the DB while `running`.
- set `last_output_at = datetime('now')` only when new bytes arrived since the
  last flush (so a silent-but-alive agent reads as "no heartbeat", which is
  exactly the stuck signal an orchestrator wants).
- the existing exit handler does the final flush + terminal status; a `migrate`
  guard means old rows just get NULL until they run again.

**`task_watch { task_id, wait? }`** (new MCP tool, **read bucket**):
- default `wait` 30s, max 120s; polls `getTask` every 1s; resolves early on a
  terminal status (`done|error|cancelled`); returns
  `{ task, output_tail }` at the end (freshest bytes via `last_output_at`).
- input: `task_id`, optional `wait`. Grant bucket: read (it is a pure observer,
  no mutation).

### F. MCP surface changes

- `READ_TOOLS` gains `task_watch`.
- `task_submit` description updated: "runs the agent's own task CLI (opencode
  `run`, codex `exec`) inside the named PAD".
- `TOOL_GRANT_FOR` unchanged (watch is read).
- Pool/pull path untouched — a worker *is* the agent and needs no driver.

### G. Out of scope (for Phases 1–3)

- Interactive/session resume (web terminal tab already covers that).
- Per-step event details (reasoning, tool calls) — out of the JSONL stream but
  beyond "what is it doing"; the tail + heartbeat answer the stuck-or-alive
  question. Revisit if the orchestrator needs it.

### H. Mid-run steering — PRIMARY REQUIREMENT (VibeKanban chat + Bernstein `approve-tool`)

The user requires REAL mid-steering and it is the primary feature: the user
never has a concrete idea and will change direction anytime; a task stuck a
long time must be told to do something differently. Hard constraint from the
user: **cancel + resubmit wastes tokens** (the new run rebuilds the full
context — file re-reads, discovery redo — everything already paid for is
burned again). So resubmit-redirect is the LAST resort, not the mechanism.

VibeKanban's model (verified live in-browser,
`docs/workspaces/chat-interface`): per-session chat where, while the agent is
Running, the operator can **Queue** a follow-up (lands when the step
finishes), **Stop** the execution, then redirect; plus a plan-approval card
(Approve / Request Changes with feedback → agent revises). Their agents run
as **conversational sessions**, not one-shot executions — that is what makes
queue-while-running possible, and it is what we copy: **every push task owns
a resumable CLI session, and steering continues that session instead of
starting a new one.**

#### H.1 Token-cost ladder (design around this, cheapest first)

| Steer | Token cost | When |
|---|---|---|
| `note` on a pull task | ~0 — worker reads one DB row | guidance, handoff context |
| `redirect` on a pull task | ~0 + worker's next steps | worker obeys immediately |
| `resume-redirect` on a push task | new instruction + continued turns ONLY — prior context NOT rebuilt | the standard push steer |
| `resubmit-redirect` on a push task | FULL context rebuild | last resort: driver has no resume, or session unrecoverable |
| early steer on stale heartbeat | minimizes burn BEFORE steering | `task_watch` + `last_output_at` (Phase 1–2) detect stuck/fast |

#### H.2 Schema (exact)

New `tasks` columns (Phase 4 migration, same ALTER pattern as
`last_output_at`):
```sql
steering    TEXT DEFAULT '[]',  -- JSON array of {at, by, mode, message}
steered_from TEXT,              -- task id this task was redirected from (chain A→B→C)
session_id  TEXT,               -- CLI session id owning this task's context
turn_count  INTEGER DEFAULT 0,  -- resume-steers applied (0 = first turn)
approval    TEXT,               -- JSON {state:'pending'|'approved'|'rejected', note, at, by}
```

`task_steer { task_id, message, mode }`, **write bucket**, `mode` default `note`:
- `note` — append `{at, by, mode:'note', message}` to `steering`. No process
  action. Returns `{ task, steering_tail, action_taken: 'noted' }`.
- `stop` — append `{mode:'stop'}` + run the existing cancel path (SIGTERM →
  SIGKILL, container sweep). No resubmit. Returns `action_taken: 'stopped'`.
  (Distinct from `task_cancel` only in that the steering log records WHY —
  implement as cancelTask + note, do not duplicate the kill code.)
- `redirect`, **pull task** (row claimed by / addressed to a worker, no live
  child): append `{mode:'redirect', redirect: true}`. The worker contract
  (`llm-guide.js` pull loop) is extended: *"re-read your claimed task row
  between work steps; obey the latest `redirect` steering immediately."*
  Returns `action_taken: 'noted-redirect'`. Cost ~0 tokens.
- `redirect`, **push task** (live child): the resume-steer —
  1. Append `{mode:'redirect'}` to `steering`.
  2. If `cap.supportsResume && row.session_id`: SIGTERM the child via the
     existing kill path **without flipping the row terminal** (new internal
     `detachChild(id)` — clears timers, kills, keeps status `running`), wait
     for exit (≤5s, then SIGKILL), spawn
     `cap.resumeCommand(session_id, message, opts)` attached to the SAME row,
     `turn_count++`. Returns `action_taken: 'resumed'`.
  3. Else (no resume support or session lost): cancel old row (reason notes
     the redirect target) + `submitTask` with amended prompt =
     `original prompt + "\n\n[Redirected by {by}: {message}]\n[Prior output tail:\n{tail}]"`,
     `steered_from = old_id`. Returns
     `action_taken: 'resubmitted:<new_id>'`. Documented as token-expensive.
- Empty `message` → throw (a steer with no direction is a no-op).

`task_approve { task_id, decision: 'approve'|'reject', note? }`, **write
bucket** — VibeKanban's plan-approval card:
- `task_submit` gains `needs_approval: true` → row starts with
  `approval = {state:'pending'}` and `task_watch` surfaces it; the child
  still runs (v1 documents: gate is advisory to the orchestrator loop, the
  headless CLI cannot be pre-paused — exactly like VibeKanban's approval
  timeouts, where silence means "send a new message").
- `approve` → `{state:'approved'}`. `reject` → `{state:'rejected'}` AND
  auto-appends a `redirect` steer carrying `note` (the Request Changes shape:
  feedback becomes the new direction).
- Valid only when `approval.state == 'pending'`; anything else throws
  `Task <id> has no pending approval (<state>)`.

#### H.3 Driver capability additions (exact)

```js
task: {
  supported: true,
  buildCommand(prompt, opts) { … },   // first turn (exists)
  extractSummary(raw) { … },          // (exists)
  // NEW — all three required together; absent = resubmit fallback.
  supportsResume: true,
  // Follow-up turn inside an EXISTING session. Must keep emitting the same
  // JSONL shape so extractSummary + live tail keep working.
  resumeCommand(sessionId, message, opts) { … },
  // How the runner learns the session id of turn 1. One of:
  //   { fromOutput: /re/ }  — first regex group in turn-1 stdout, or
  //   { fixed: (taskId) => `paddock-${taskId}` } — caller-supplied id flag.
  sessionId: { … },
}
```

Research checklist — confirm LIVE before coding `resumeCommand` (Phase 3,
exact commands; record findings here):
- [ ] `docker exec <opencode-pad> opencode run --help | grep -iE 'session|continue'` —
      find the continue-session flag; test: short turn 1, capture session id,
      turn 2 references turn-1 answer without restating it (proves context
      retained, no rebuild).
- [ ] `docker exec <codex-pad> codex exec --help | grep -iE 'resume|session'` —
      same round-trip test (`thread.started` id is the resume handle candidate).
- [ ] Record exact flags + session-id shapes in this file. If a driver has NO
      resume path, its `task` block ships WITHOUT the resume trio and the
      runner takes the resubmit fallback — no guessing, no dead flags.

#### H.4 Tests (exact list)

- note append round-trip (push + pull rows); empty message throws.
- pull redirect sets `redirect:true`; steering visible in `task_status`.
- push resume-redirect with fake `supportsResume` cap: child killed, SAME row
  stays `running`, `turn_count` 1, resume command carries session id +
  message; `last_output_at` keeps beating (no orphan).
- push redirect without resume trio → old row `cancelled`, new row linked
  via `steered_from`, amended prompt contains message + tail.
- stop mode: `cancelled`, no resubmit, reason recorded.
- approve/reject round-trip; reject auto-appends redirect steer; non-pending
  approve throws; watch surfaces pending approval; write-bucket scoping.

### I. Hooks + role fences (Bernstein: hooks, `role-adapter-policy`)

Bernstein gates *around* the agent: lifecycle hooks
(`pre_task/post_task/pre_spawn/post_spawn/pre_merge/post_merge`) and a
per-role adapter allow-list enforced at spawn. Paddock-sized port:

- **Task hooks (v1):** `pre_submit` / `post_complete` shell hooks, operator-set
  via `src/data/app.db` settings or env (`PADDOCK_TASK_PRE_SUBMIT`,
  `PADDOCK_TASK_POST_COMPLETE`), run with `TASK_ID/AGENT_NAME/STATUS` env.
  Failure of `pre_submit` (non-zero exit) **refuses the submit** with the
  hook's stderr as the reason (Bernstein's fail-closed shape). `post_complete`
  is fire-and-forget + logged. No plugin SDK, no per-event marketplace — one
  shell command per hook point.
- **Role fence (v1):** per-driver `task.roles` allow-list is overkill; instead
  the existing MCP tool-grant system already scopes *who* may call
  `task_submit`. What we add: `task_submit` rejects when the target PAD's
  driver has no `task` block (already Phase 1) **and** logs
  `claimed_by` vs `agent_name` mismatches on the pull path (detect a worker
  doing another PAD's pre-assigned task — warn in `task_list` output, don't
  hard-fail).
- Tests: pre_submit refuse path, post_complete fire-and-forget, grant scoping
  unchanged.


## Phases

- [x] Phase 0 — read driver registry, both drivers, runner, MCP tools, tests;
      capture codex JSONL shape live. Done 2026-09-24 (this file).
- [ ] Phase 1 — driver `task` capabilities (opencode + codex) + runner
      delegation + not-supported error; `last_output_at` migration + throttled
      flush + heartbeat. Tests: capability presence, codex command shape,
      not-supported throw, heartbeat/throttle, extractors.
- [ ] Phase 2 — `task_watch` MCP tool + read bucket, updated `task_submit`
      description. Tests: watch returns at terminal / honours wait, read scoping.
- [ ] Phase 3 — live verify: opencode task with watch (tail moves), stuck-ish
      heartbeat check, unsupported-type message via a non-task PAD, codex via
      harness (or real once a codex PAD is logged in). Restart paddock, run
      unit tests individually.
- [ ] Phase 4 — `task_steer` (note/stop/redirect) + `task_approve` + resume
      trio in driver caps; `steering/steered_from/session_id/turn_count/
      approval` migration; `detachChild` resume-steer path + resubmit
      fallback; worker re-read contract in `llm-guide.js`. Resume flags
      confirmed live FIRST (H.3 checklist) — no dead flags. Tests: H.4 list.
- [ ] Phase 5 — task hooks (`PADDOCK_TASK_PRE_SUBMIT` fail-closed,
      `PADDOCK_TASK_POST_COMPLETE` fire-and-forget) + pull-path
      claimed_by/agent_name mismatch warning. Tests: refuse path, f&f logging,
      mismatch warning.
- [ ] Phase 6 — absorb into `docs/` (`docs/backend/services.md` task-runner +
      driver capability + steer/approve + hooks) and delete this file. Gated
      on explicit user confirmation like plan 47.

### J. VibeKanban segment map (verified live in-browser 2026-09-24)

VibeKanban runs the SDLC as segments: **PLAN → PROMPT → REVIEW → MERGE**.
Homepage hero ("1. PLAN 2. PROMPT 3. REVIEW"), "End to end workflow" section,
per-agent chat with queue-while-running + Stop + plan-approval cards. Mapping
onto Paddock (what we copy vs what stays out):

| VibeKanban segment | Paddock equivalent | Status |
|---|---|---|
| PLAN — issues + sub-issues, human plans | pool tasks + `priority` ranks + orchestrator decomposition over MCP | have it (plan 47) |
| PROMPT — dispatch one background agent per issue, own git worktree each | `task_submit` push per PAD (PAD container + workspace = our worktree) | have it; multi-driver = this plan Phases 1–3 |
| REVIEW — diff review, comment on AI code, QA on dev servers, Approve / Request Changes | `task_watch` tail + `task_steer` note/redirect + `task_approve` gate | this plan Phases 2+4 |
| MERGE — PR create/merge, issue status auto-updates | statuses already auto-update pending→running→done/error | PR/merge OUT OF SCOPE — no git hosting in Paddock |
| Chat queue-while-running | pull-worker steering (free) + push resume-redirect (no rebuild) | this plan Phase 4 |

A Kanban BOARD UI for these states (columns pending/running/review/done) is
a future frontend plan, not this one — the backend states it needs already
exist here.

### K. Control principle (user requirement — aligned 2026-09-24 with plan 51)

ONE holder, no layer-skipping. The orchestrator (plan 51: an ordinary PAD
with the fleet MCP wired in — a role, not a type) is the ONLY caller of
worker tools. External LLMs (chat, Telegram, phone) get orchestrator-
namespace tools only and can never touch a worker directly. No lever in this
plan may require the web UI or a human click to close the loop. Concretely:

- Every §H lever is an ORCHESTRATOR-callable tool: `task_submit` (dispatch),
  `task_watch` + `task_status` (observe), `task_steer` note/stop/redirect
  (steer), `task_approve` (gate), `task_cancel` (kill), `task_priority`
  (rank the queue), `task_list`/`task_result` (audit). Steer + approve live
  in the **write/exec bucket** (same as `task_submit`), watch/status/result/
  list in **read** — the orchestrator's key holds both; external keys hold
  orchestrator-namespace verbs only (plan 51 §2).
- `needs_approval` parks in `task_watch`, and the ORCHESTRATOR approves (or
  rejects-with-redirect) — the human may use the same tool through the
  orchestrator, but the loop closes without one. Same for every steer:
  orchestrator sees stale heartbeat → orchestrator redirects, no human in
  the path.
- The pull loop is orchestrator-run too: orchestrator files pool tasks, ranks
  with `task_priority`, steers workers with `task_steer`, collects with
  `task_list`. Workers never need UI access.
- EXCEPTION (deliberate, safety): §I hooks (`PADDOCK_TASK_PRE_SUBMIT`,
  `PADDOCK_TASK_POST_COMPLETE`) are operator-set, server-side, fail-closed —
  the orchestrator can neither set nor bypass them. It sees a hook refusal
  only as a submit error carrying the hook's stderr. Control-plane safety
  stays above the orchestrator by design.
- `llm-guide.js` (the orchestrator's own playbook) is updated in Phase 4 with
  the steer loop: watch → stale heartbeat or wrong direction → note →
  redirect (resume) → verify new tail → approve/close.

## Build order (master — plans 48/49/50/51, re-sequenced 2026-09-24 per user:
homes first)

Building blocks first, one block's output is the next block's input. The
user's order: folder management and mounting come before task mechanics —
an agent needs its home before work can run in it. (The two tracks touch
disjoint code paths — `vm-manager.js` mounts vs `task-runner.js` — so this
costs nothing technically.) No block starts until the previous one's
verification is green:

- **Block 0 — homes backend (49 Phases 0–1).** Code verification (§6
  checklist) + `WORKSPACE_MODE` meta + compose emission per mode (bind
  byte-identical; worktree/copy/volume new) + nested-docker registry fields
  (port block, compose project name, volume prefix). No UI yet.
- **Block 1 — un-break + observe (48 Phases 1–3).** Task-runner fixes
  (exports crash, heartbeat column, cap-passing bug, timer leak, tests to
  the plan-48 API), then `task_watch` + read bucket + live verify on real
  PADs. INCLUDES the H.3 resume-flag research (opencode/codex
  session-continue round-trips) — its outcome determines Block 2's steering
  architecture (resume-steer vs resubmit-only).
- **Block 2 — hands (48 Phase 4).** `task_steer` + `task_approve` + resume
  trio + worker re-read contract + `llm-guide.js` steer loop. The primary
  feature, built on Blocks 0–1.
- **Block 3 — home UI (49 Phases 2–4 + plan 44 merged here).** Mode selector
  in create form, settings display/switches with rebuild warnings, volume
  lifecycle. Plan 44's workspace-card work happens HERE, once — never twice.
- **Block 4 — runbook (50 Phases 1–2).** Bootstrap checklist in
  `llm-guide.js` + only the backend gaps Phase 0 proves missing. Proves
  itself with a live manager walkthrough on a throwaway folder.
- **Block 5 — guardrails (48 Phase 5).** Hooks + fences, after the loop
  works — safety rails go on a road that exists.
- **Block 6 — capstone (51).** Confer the orchestrator role on a PAD,
  orchestrator namespace/grants, omni-client bridges, adversarial proving
  ("delete everything" must fail closed).
- **Closings.** Docs absorb + plan-file deletion per plan, each gated on
  explicit user confirmation (house rule). Order: 48 → 49 → 50 → 51.

## Verification

- `timeout 60 docker exec paddock node --test test/tasks.test.js`
- `timeout 60 docker exec paddock node --test test/mcp.test.js`
- `docker restart paddock` after every backend edit.