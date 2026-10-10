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
  (Both re-confirmed 2026-10-09.)
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
  two tools retired. **Still open:** `exec` false-greens on an empty *and* a
  whitespace-only command (re-confirmed 2026-10-09).
- `2026-09-28-pm-portfolio-intake.md` — the `networkHealth` "stale and running"
  findings, and a false negative about a session named "Starting infinite queue"
  that was in fact present. **Resolved** — the `networkHealth` self-contradiction
  closed and was re-verified 2026-10-09 (`state: "staleBinding"` plus a
  self-explaining `reason`); the false negative was corrected earlier.
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
  `list-plans.md` predicted before it shipped. **Re-verified 2026-10-09:** its
  `task_*`-undocumented-in-`help` finding closed (`help` recipe 15 documents the
  gated loop); the `plan_*` bind-mount refusal and the doubled `workspace_write`
  refusal are still open.
- `2026-10-08-plan69-pipeline-proof.md` — running plan 69's server-side
  pipeline against a real session. Findings 1 (zero MCP tools from a root-owned
  state dir) and 2 (`friction/` `root:root`) were reproduced live and **fixed on
  2026-10-11** (both chowned to uid 1000; `opencode mcp list` connected).
  Finding 3 (`pad_workspace_write` refusal) is still open.
- `2026-10-11-mcp-drop.md` — the `pad_*` tools dropped mid-session; the API-key
  hypothesis was false. Two independent causes separated by client-log evidence:
  a root/uid-1000 state-dir collision (`locks/` owned by root) that broke the
  CLI registration path — **fixed** (chowned to uid 1000), and opencode's
  running-session rule that a `failed` remote MCP server is never re-fetched
  until process restart (no reload action exists; config hot-reload does not
  fire). Fresh sessions verify `pad_*` works.

## Still open as of 2026-10-09

Re-verified live in a verify pass on 2026-10-09 (MCP only). Two items from the
2026-09-29 list closed (see the **Closed** line below); the three `2026-10-08`
findings are folded in after them.

1. `create_agent`'s `agent` enum omits `claude`
   ([`craftpip-status.md`](2026-09-27-craftpip-status.md)) — one word, survived
   four sessions.
2. `plan_*` is gated on `hostBrowsable` and refuses on every opencode pad whose
   workspace is a bind mount
   ([`recheck-friction-log.md`](2026-09-29-recheck-friction-log.md) finding 2) —
   re-confirmed 2026-10-09: `plan_list {agent: "pad-opencode-proj"}` still returns
   `plan_workspace_not_host_visible`, and every pad in the fleet reads
   `hostBrowsable: false`.
3. `plan_list {folder}` cannot be reached while (2) holds (finding 3).
4. `workspace_write` resolves relative paths against the agent's data dir, not
   the workspace (finding 4) — untestable while the host-browse gate refuses
   every pad here.
5. `exec` still reports success for a whitespace-only command — and for an empty
   one too ([`tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md)).
6. No `list_containers` (non-PAD containers are only recognisable, not
   lookable-up), no `mission_project_delete`, no plan delete.
7. The `workspace_write` refusal still prints its explanation twice, and still
   does not name `exec`
   ([`recheck-friction-log.md`](2026-09-29-recheck-friction-log.md),
   [`2026-10-08-plan69-pipeline-proof.md`](2026-10-08-plan69-pipeline-proof.md)).
8. ~~`friction/` still `root:root drwxr-xr-x`~~ — **closed 2026-10-11**: chowned
   to uid 1000 and touch-probe verified
   ([`2026-10-08-plan69-pipeline-proof.md`](2026-10-08-plan69-pipeline-proof.md)).
9. ~~A session minted with no MCP tools keeps zero tools~~ — **closed 2026-10-11**:
   the root cause (a root-owned `locks/` in the shared opencode state dir) was
   reproduced live and fixed. The caller-side rule survives: a *running* zero-tool
   conversation stays that way — restart the session
   ([`2026-10-08-plan69-pipeline-proof.md`](2026-10-08-plan69-pipeline-proof.md),
   [`2026-10-11-mcp-drop.md`](2026-10-11-mcp-drop.md)).

**Closed on 2026-10-09:** `settings_get.networkHealth`'s self-contradiction (now
`state: "staleBinding"` plus a `reason` that states its own condition), and
`help`'s silence about the `task_*` family (recipe 15 documents the gated loop).

**Closed on 2026-10-11:** plan69 findings 1 and 2 (see their entries) — the
harness's state dir and the fleet's `friction/` are uid-1000 owned, and the node
TUI registers `browser` / `paddock` / `pad` (`opencode mcp list` connected).
The unrelated `pad_workspace_write` refusal (plan69 finding 3) is still open.

## See Also

- [`docs/` reference](../docs/README.md) — how the tools actually work.
- [`AGENTS.md`](../AGENTS.md) — the "chat test" mode this log comes from.
