# Plan 128 — Run Paddock through MCP alone: the runner surface

## Status: In progress (2026-11-13) — 4/5 phases done (tools, resolve defaults, guide, tests: mcp-runners 10/10, mutation-controlled; 47 tools live for the orchestrator key). Remaining: Phase 5, the live orchestrator run (plan 127), which needs a Claude Code restart to load the MCP tools.

## Why

User (2026-11-13): "fix the gaps, you should be able to run paddock via mcp alone … write down
plans and execute, make it solid." Plan 127 makes Claude Code an orchestrator that may use only
the `paddock` MCP tools. Today an orchestrator can create a project, start a session, write plans
and answer a blocker, but it cannot run a queue:

- No tool lists runners, so `runner_id` (required by `queue_read`, `queue_write`, every
  `agent_queue_*` tool) cannot be discovered. `queue_read` even says "Runner id from the Mission
  runner list", which does not exist.
- No tool creates a runner, presses Run, pauses, reconciles or removes one. `mcp.js`'s grant map
  already names `runner_create/start/pause/resume/remove/update` and `READ_TOOLS` names
  `runner_list/runner_get`, but none is registered (plan 83 leftovers).
- No tool removes a queue item.
- `help` (`llm-guide.js`) says nothing about runners or queues, so an LLM cannot learn the loop.

## The journey this must support (MCP only)

1. `help` → learns the runner loop in one section.
2. `mission_project_create` → project. `plan_write` → plans.
3. `runner_create {project_id, name, plans}` → a runner with its worker session, queue set up,
   plans queued — one call, response says what to do next ("call runner_start").
4. `runner_start` → Run; response = the runner brief (state, current plan, what happens next).
5. Poll `runner_get` → the brief shows `blocked: [{item_id, plan, question}]` and
   `next: "answer with agent_queue_resolve_need_input {runner_id, item_id, answer, revision}"`.
6. `agent_queue_resolve_need_input` → worker continues; `runner_get` shows it in progress.
7. `runner_pause` / `runner_remove` / `runner_reconcile` / `agent_queue_remove_item` for control.

## Design

New module `src/mcp/tools-runners.js`, registered through the same `registerToolBound` wrapper
(source-hygiene pins this). Every handler resolves the runner, then `missionRequireProject(user,
<tool>, runner.project_id)` — the same visibility + target + grant gate as the queue tools. All
call the SAME service functions as the REST routes (no second implementation).

One response shape, `runnerBrief(runnerId)`, for runner_get and every write's result:

```
{ runner_id, name, project: {id, name, folder}, session: {id, tmux_id, live},
  state, label, reason, banner, revision,
  counts: {total, done, in_progress, new, need_input},
  current: {item_id, plan} | null,
  blocked: [{item_id, plan, question}],
  items: [{item_id, plan, title, status, reason}],
  can: {run, pause, resolve, reconcile, add_plans, remove_item: true | "why not"},
  next: "<one sentence: the single most useful next call>" }
```

`can.*` comes from the server's own `execution.actions` (never re-derived, lesson S20).

| Tool | Grant | Service call |
|---|---|---|
| `runner_list {project_id?}` | read | `listRunnersForProject` / all visible |
| `runner_get {runner_id}` | read | brief |
| `runner_create {project_id, name, session_id?, plans?}` | create | `createRunner` + `setupRunnerQueue` + `addRunnerQueueItems` |
| `runner_start {runner_id}` | exec | `startRunner` (also the way out of a quota stop) |
| `runner_pause {runner_id, mode?}` | exec | `pauseRunner` |
| `runner_reconcile {runner_id}` | exec | `reconcileRunnerOperation` |
| `runner_remove {runner_id}` | exec | `removeRunner` |
| `agent_queue_remove_item {runner_id, item_id, revision}` | exec | `removeRunnerQueueItem` |

`agent_queue_resolve_need_input`: `revision` and `idempotency_key` become optional (current
revision read server-side; key defaults to a hash of runner+item+answer), because both are
bookkeeping an LLM gets wrong, and the server already guards the race.

## Phases

- [x] 1. `tools-runners.js` + brief + grants (`runner_reconcile`, `agent_queue_remove_item`
  added to the exec map), wired in `mcp.js`.
- [x] 2. `agent_queue_resolve_need_input` defaults; `queue_read` description fixed.
- [x] 3. `help`: a "Running a queue of plans" section in `llm-guide.js` (the loop above, the
  blocker answer, quota stop = runner_start after reset).
- [x] 4. Tests (`test/mcp-runners.test.js`): every tool through the real MCP server with stubbed
  tmux/store; grant refusals (read key cannot start; target grant enforced); brief shows a
  blocked item with its question and `next` naming the resolve call; resolve without revision
  works; mutation control. `mcp.test.js` tool-count pins updated.
- [ ] 5. Live: plan 127's orchestrator run uses only these tools (after a Claude Code restart).
  Docs: `docs/reference/backend/services.md` § MCP Tools, `tabs/mcp.md`.
