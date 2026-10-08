# MCP Friction Log

Friction that LLM clients hit while driving Paddock through the MCP surface
(`/mcp`). This is a **raw findings log**, not documentation: it records what a
caller could not understand, could not do, or had to guess — and what the fix
would be. Once a finding is fixed, the entry stays and gets a
**Resolution** line, so the history of what confused callers survives.

Business logic and the real reference for the tools live in `docs/`. Only
findings go here.

## How to add an entry

1. One file per chat-test session: `friction/YYYY-MM-DD-<slug>.md`.
2. Date is the day the session ran. The slug names the task, not the tool
   ("clone-proj", not "create-agent-bug").
3. Newest file last in the folder listing; the **Entries** list below is a
   convenience index of status, not the source of truth — the Resolution lines
   in each file are.
4. One H3 per finding, in the shape below.

### Entry shape

```markdown
### <short title>

- **Tool:** `tool_name` (or `tool_a` + `tool_b`)
- **Severity:** blocker | guessing | noise
- **What I asked:** the request in one line
- **What happened:** what the tool returned, verbatim where it matters
- **Why it hurts:** the cost to a caller that has only the tool surface
- **Fix:** the smallest change that removes the guess
```

Severity meanings:

| Severity | Means |
|----------|-------|
| `blocker` | the caller cannot complete the task at all |
| `guessing` | the caller completes it, but had to infer a rule that wasn't stated |
| `noise` | the answer is right, but oversized or misleading alongside the truth |

## Entries

Newest last. Read the **Resolution** lines before re-filing anything: most of
what this log complained about in September 2026 has since been fixed, and a few
entries were retired rather than fixed.

- `2026-09-27-clone-proj.md` — cloning `pad-opencode-proj` into a second pad.
  **All resolved** (naming, `availableNetworks` cap, `workspaceDevcontainer`,
  the ports check).
- `2026-09-27-craftpip-status.md` — listing open sessions, and looking up a
  non-PAD container (`craftpip`). **Mostly resolved** — `networkFilter` and the
  non-PAD near-miss hint both landed. **Still open:** `create_agent`'s enum omits
  `claude`, unchanged since 2026-09-27; and there is still no `list_containers`.
- `2026-09-27-run-task-in-project.md` — running agent work in a Mission
  project: the task queue cannot address a project, and the Mission route loses
  both the prompt and the answer. **Superseded** — the task queue was retired on
  2026-09-29 and the conversation-loss half was fixed by `plan_activity`.
- `2026-09-27-tool-surface-sweep.md` — trying every tool end to end: the
  `workspace_*` trio is dead (missing `await`), `config_get` and `get_agent`
  leak live secrets, `list_agents` lists a pad that does not exist, and
  `mission_session_start` can time out and succeed. **Resolved** (plans 60, 61,
  65) except `config_get`'s outstanding *token rotation*, which is an operator
  action and still open. `workspace_write` itself was later fixed and the other
  two tools retired.
- `2026-09-28-pm-portfolio-intake.md` — the `networkHealth` "stale and running"
  findings, and a false negative about a session named "Starting infinite queue"
  that was in fact present. **Open** — now owned by `plans/66-network-peer-truth.md`
  (Draft, 0/4).
- `2026-09-29-task-queue.md` — building a task queue. **Every finding RETIRED,
  not fixed**: all eight `task_*` tools were removed from the surface. Kept for
  history.
- `2026-09-29-list-plans.md` — "list plans in paddock": the plans facility did
  not exist, the only write path was dead, and "the workspace" was ambiguous
  across a 13-pad fleet. **Resolved** (plan 64) — `plan_list` / `plan_write` /
  `plan_activity` shipped and work. Its prediction that they would refuse on the
  real pads came true; see the re-check below.
- `2026-09-29-exec-ls.md` — `exec`'s cwd reporting and the shared name
  resolver. **Resolved.**
- `2026-09-29-task-session-status.md` — "what's going on now, what tasks?", and
  why 28 of 29 sessions are dead. **Resolved** (plan 65) — `endedAt` /
  `endedBy`, a live `last_seen_at`, populated `get_agent` timestamps, and
  `plan_activity` to read a conversation.
- `2026-09-29-project-progress.md` — "what is the progress in the paddock
  project". **Half resolved** (plan 67) — project filters, `agentStatus`,
  `include_sessions` and `createdBy` all landed, and `mission_projects` now says
  *"These counts are LIVENESS, not progress"*. Progress itself is answerable
  only through `plan_list`, and `plan_list {folder}` does not work.
- `2026-09-29-recheck-friction-log.md` — a full re-verification of every open
  finding above. **14 fixed, 1 still open (`claude` enum), 8 `task_*` tools
  retired, 7 new findings.** The sharpest new one: the plans facility refuses on
  every opencode pad with a bind-mounted workspace, which is the failure
  `list-plans.md` predicted before it shipped.
- `2026-10-08-plan69-pipeline-proof.md` — running plan 69's server-side
  pipeline against a real session. **3 new findings, all open:** a session
  minted while opencode's state dir was unwritable keeps zero MCP tools even
  after the cause is fixed (the step prompt then parks at timeout);
  `friction/` is `root:root` so uid-1000 sessions cannot file into it; and
  `pad_workspace_write`'s refusal does not point at `exec`, which works.

## Still open as of 2026-09-29

1. `create_agent`'s `agent` enum omits `claude`
   ([`craftpip-status.md`](2026-09-27-craftpip-status.md)) — one word, survived
   three sessions.
2. `plan_*` is gated on `hostBrowsable` and refuses on 4 of the 6 opencode pads —
   every one whose workspace is a bind mount
   ([`recheck-friction-log.md`](2026-09-29-recheck-friction-log.md) finding 2).
3. `plan_list {folder}` returns zero for the folder the plans live in (finding 3).
4. `workspace_write` resolves relative paths against the agent's data dir, not
   the workspace (finding 4).
5. The retired `task_*` family is undocumented in `help` (finding 1).
6. `exec` still reports success for a whitespace-only command
   ([`tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md)).
7. `settings_get.networkHealth` still says `state: "stale"` where `health`
   explains the same condition perfectly — `plans/66-network-peer-truth.md`,
   Draft, 0/4.
8. No `list_containers` (non-PAD containers are only recognisable, not
   lookable-up), no `mission_project_delete`, no plan delete.

## See Also

- [`docs/` reference](../docs/README.md) — how the tools actually work.
- [`AGENTS.md`](../AGENTS.md) — the "chat test" mode this log comes from.
