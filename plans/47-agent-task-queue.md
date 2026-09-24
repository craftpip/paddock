# Plan 47 — Agent Task Queue over Paddock MCP

## Status: [SUPERSEDED by plan 52 — do not build from this file; remaining work tracked ONLY in plan 52]  In progress (2026-09-24) — 4/5 phases done. Phases 1–4 built,
unit-tested (`tasks` 38/38, `mcp` 27/27) **and live-verified end-to-end on a
real opencode PAD**, including a cancel-orphan bug found and fixed live.
Remaining: Phase 5 docs absorb — **gated on explicit user confirmation.**
Build deltas: explicit `enqueue` mode, `rowid` FIFO ordering, synchronous test
fakes, pidfile + env-tagged in-container kill, `part.text` extraction.

> Manager-agent assigns work to `opencode` PADs through Paddock's own `/mcp`
> server — **push and pull**:
> *Push:* `task_submit` runs `opencode run` inside the target PAD in the
> background; `task_status / task_result / task_cancel / task_list` manage it.
> *Pull:* a worker PAD self-serves from a ranked queue —
> `task_get_next` → does the work itself → `task_complete`, repeating until
> empty (TaskPeace loop).
> Backend only: `src/mcp.js`, `src/services/task-runner.js` (new),
> `src/services/db.js`, and one line in the opencode driver. **No React/SPA
> change** — the LLM drives the whole surface through MCP.

## Goal

Let one manager agent AND/OR the worker PADs themselves drive tasks over
`http(s)://<host>:6789/mcp` with a `pk_live_...` key:

**Push (manager dispatches):**
1. `task_submit { name, prompt, model?, agent?, timeout?, autoApprove? }` → `task_id` immediately.
2. `task_status { task_id }` → `pending / running / done / error / cancelled` + exit code + tail.
3. `task_result { task_id }` → extracted assistant text + capped raw stdout/stderr.
4. `task_list { name? }` + `task_cancel { task_id }`.

**Pull (worker self-serves, TaskPeace loop):**
1. `task_submit { name? , prompt, priority? }` — with `name` omitted the task
   lands in an **unassigned pool** at a `priority` rank.
2. `task_get_next { name }` → atomically claims the highest-priority pending
   task for this PAD (pre-assigned or from the pool), flips it `running`.
3. The worker does the work itself (it *is* opencode — no webui spawn), then
   `task_complete { task_id, status, summary? }`.
4. `task_priority { task_id, rank }` re-ranks the queue ("rank once, self-serve
   top-to-bottom").

## Background — what already exists

- PAD fleet for `opencode` works: lifecycle, tmux terminal, workspace,
  `opencode.json`, OpenCode Web publish — `src/services/drivers/opencode.js`,
  `docs/backend/drivers.md`.
- `/mcp` (Streamable HTTP, `src/mcp.js:registerTools`) already gives agents
  `list_agents, get_agent, exec, workspace_list/read/write, agent_commands`
  with per-user ownership + target/tool grants (`requireTool`, `keyGrants`).
- Missing: no task object, `exec` is synchronous (30s default, 600s max) and
  blocks the MCP request — unsuitable for real agent work.

## Research borrowings (2026-09-23, all MIT)

| Source | What we take | What we skip |
|---|---|---|
| `alejandro-technology/opencode-mcp` | The `task_id` umbrella + async lifecycle: start → status (`pending/running/done/failed`) → result, `wait` long-poll, `cancel`. | Their whole server/spawn registry (we spawn into PADs via docker). |
| `AlaeddineMessadi/opencode-mcp` v3 | Async engine shapes: `fire` (submit) → `check` (status) → `wait` (long-poll), job persistence, progress-not-timeout semantics. | Their per-PAD server install + Node 22 requirement (PADs are node:20-slim). |
| TaskPeace | The pull-loop: one ranked queue, `get_next_task` → work → `complete_task`, plus `priority` ranking. | Their cloud sync / localStorage UI / install.sh packaging. |

## Design

### Tasks table (`src/services/db.js:migrate`)

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  agent_name TEXT,                       -- executor PAD (NULL = unassigned pool)
  prompt TEXT NOT NULL,
  model TEXT,
  agent_type TEXT,                       -- --agent selection (NOT the agent kind)
  status TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|error|cancelled
  priority INTEGER NOT NULL DEFAULT 0,   -- lower = served first; ties break FIFO
  pid INTEGER,
  claimed_by TEXT,                       -- PAD that pulled this task
  exit_code INTEGER,
  stdout TEXT DEFAULT '',
  stderr TEXT DEFAULT '',
  result_summary TEXT DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_name);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, priority);
```

**No FK on `agent_name`** — deliberately. An FK would (a) forbid the NULL pool
row and (b) cascade-delete a PAD's task history on
`registry.removeAgentFromDb` (`src/services/agent-registry.js:134`). Deleting a
PAD keeps its task log; the access checks in § MCP tools decide visibility.

**Timestamps are always SQL `datetime('now')`** — never `new Date().toISOString()`.
The whole DB uses `'YYYY-MM-DD HH:MM:SS'`; mixing in `'…T…Z'` breaks string
ordering (`' '` 0x20 sorts before `'T'` 0x54) and any `last_used_at`-style
comparison.

Cap `stdout/stderr` at 512KB (truncate + `\n...[output truncated]`, by *bytes*,
dropping a split multibyte char at the boundary).

### Command construction

`--dir` is mandatory — `opencode run` otherwise inherits the container CWD
(`/` for these tail-style entrypoints) and never sees the agent's project:

```bash
opencode run --format json --dir <getDriver(type).workspaceDir> \
  [--model <provider/model>] [--agent <name>] [--auto] -- "<prompt>"
```

- `--dir` comes from the driver (`opencode.js:27` → `/root/.opencode/workspace`),
  never hardcoded, so another type can reuse the runner.
- `--auto` auto-approves permissions not explicitly denied. Without it a task
  needing an approval prompt **hangs** headless (no TTY) until the timeout —
  see upstream `anomalyco/opencode#16367`. Default `autoApprove: true`, same
  trust level as the existing `exec` tool; expose the flag to turn it off.
- **Never route agent choice with `@mention`** — in `opencode run`, `@review
  <task>` silently runs on the *primary* agent's model with no error
  (`anomalyco/opencode#36764`). `task_submit { agent }` maps to `--agent`.
- Prompt is single-quote escaped for `sh -lc` (`'` → `'\''`).
- `--` separator keeps prompts starting with `-` from parsing as flags (confirm
  against the installed build in Phase 4).

### Execution engine (new `src/services/task-runner.js`) — push only

- `submitTask({ name?, prompt, model, agent, priority, timeout, autoApprove, user })`
  → insert row `pending`; when `name` is set: pre-checks (PAD exists, container
  `running` via `registry.dockerPsList()[runtime_ref]`, `getDriver(type).type
  === 'opencode'`) then spawn detached
  `docker exec -i <runtime_ref> sh -lc 'exec opencode run …'`.
- Stream stdout/stderr into memory, throttled flush to DB, final flush on exit.
  Exit code `0` → `done`, non-zero → `error`. Persist `exit_code` + capped output.
- `--format json` emits a **raw JSON event stream**; parse it line-by-line to
  extract the final assistant text into `result_summary`, keep the capped raw
  stream in `stdout`. Exact event shape gets captured live in Phase 4 — do not
  hardcode a guessed schema; fall back to raw text when parsing fails.
- Timeouts: default 10min, max 60min.
- Test seam: `_setForTests({ spawn, isRunning, resetRunning })` replaces the two
  heavy I/O defaults so tests never touch Docker.

### Boot reconciliation

The in-memory `running` map dies with the webui, and so does every `docker exec`
child — but the rows stay `running` forever. On module init:

```sql
UPDATE tasks SET status='error', finished_at=datetime('now'),
  result_summary='orphaned by webui restart' WHERE status='running';
```

Same class as the existing boot ownership sweep in `AGENTS.md`.

### Cancellation

`child.kill('SIGTERM')` only signals the local `docker exec` CLI; whether the
container-side `opencode run` dies is not guaranteed. Sequence: SIGTERM the
spawn → 5s grace → SIGKILL → a scoped in-container sweep
(`pkill -f 'opencode run'` limited to our own marker) as backstop. The DB row
moves to `cancelled` immediately; the exit handler is guarded
(`WHERE status IN ('pending','running')`) so a late exit cannot regress it.
Live-verified in Phase 4.

### MCP tools (`src/mcp.js:registerTools`)

| Tool | Input | Grant bucket |
|---|---|---|
| `task_submit` | `{ name?, prompt, model?, agent?, enqueue?, priority?, timeout?, autoApprove? }` | exec |
| `task_get_next` | `{ name }` | exec (it **mutates** — claims) |
| `task_complete` | `{ task_id, status: done\|failed, summary? }` | exec |
| `task_priority` | `{ task_id, rank }` | exec |
| `task_cancel` | `{ task_id, confirm: true }` | exec |
| `task_status` | `{ task_id, tail? }` | read |
| `task_result` | `{ task_id }` | read |
| `task_list` | `{ name?, limit? }` | read |

`task_complete` maps the LLM-facing `failed` onto the stored `error` so the
schema vocabulary and the DB vocabulary cannot drift.

**No `tasks/<id>.md` workspace write.** `workspace.writeFile` creates no parent
dirs (`src/services/workspace.js:196-214`) so the write would throw, it cannot
work for pool tasks (no PAD), and a `tasks/` dir could collide with the user's
project. The DB row is the audit record.

### Grants (validated)

Two facts make the obvious wiring wrong:

1. `TOOL_GRANTS = ['lifecycle','recreate','create','delete','reset']`
   (`src/services/api-keys.js:27`) — **there is no `tools:exec` scope**, and
   `validateScopes` would reject one. Do not add a scope.
2. `toolAllowed` gives base fine-grained keys `exec` through a *literal*
   `tool === 'exec'` branch (`src/mcp.js:152-158`). Merely adding
   `task_submit: 'exec'` to `TOOL_GRANT_FOR` falls through to
   `g.tools.has('exec')` → always false → **every worker key is denied**.

So the exec-bucket task tools join the same branch explicitly:

```js
if (READ_TOOLS.has(tool) || tool === 'exec' || tool === 'workspace_write'
    || TOOL_GRANT_FOR[tool] === 'exec') {
  return targetAllowed(user, agentName);
}
```

`READ_TOOLS` gains only `task_status`, `task_result`, `task_list`.
`TOOL_GRANT_FOR` gains the five exec-bucket tools → `'exec'`.
A `read`-scoped key therefore sees status/result/list and nothing else;
`task_get_next` is deliberately *not* read, or a read key could claim and strand
work.

**Pool-task grants.** An unclaimed pool task has no owning PAD, and
`requireTool` → `requireAccess('')` would throw "Access denied". Add a
`requireTaskGrant(user, tool, task)` helper that resolves
`claimed_by || agent_name`; when that is empty it enforces `toolAllowed` only
(no owner check), because the pool is shared.

### Guide + catalog

- Extend `src/services/llm-guide.js:GENERAL_GUIDE` with both recipes: push
  (submit → status → result) and pull (get_next → work → complete), plus the
  `@mention`-does-not-route warning.
- Add `opencode run` to the opencode driver's `llmCommands`
  (`src/services/drivers/opencode.js:118-162`) so `agent_commands` stays
  truthful for LLM callers. Needs a `docker restart paddock` (driver is
  `require()`-cached).

## Validation findings (2026-09-24)

Checked against `opencode.ai/docs/cli/` (updated Sep 23 2026), `package.json`,
`api-keys.js`, `agent-registry.js`, `workspace.js`, `mcp.js`.

Confirmed sound: `opencode run` + `--format/--model/--agent/--session/--auto/--dir`
all exist; `UPDATE … RETURNING` is available (better-sqlite3 `^11.7.0` bundles
SQLite ≥3.45); `dockerPsList`/`getAgent` reuse matches the `exec` tool
(`src/mcp.js:619-622`); no UI change is required.

| # | Defect | Severity | Resolution |
|---|---|---|---|
| 1 | no `--dir` → tasks run in the container CWD | critical | driver-driven `--dir` |
| 2 | no `--auto` → headless approval hangs | critical | default `autoApprove: true` |
| 3 | exec-bucket grants denied for every worker key | critical | explicit clause in `toolAllowed` |
| 4 | `task_get_next` as `read` mutates state | critical | exec bucket; 3 read tools only |
| 5 | ISO vs `datetime('now')` timestamp mix | real | SQL-only timestamps |
| 6 | `running` rows orphaned on webui restart | real | boot reconciliation sweep |
| 7 | cancel may not reach the container process | real | `exec` + grace + sweep, live-verified |
| 8 | `tasks/<id>.md` write throws / collides | gap | dropped |
| 9 | `@agent` mis-routes headless | gap | `--agent` only, documented |
| 10 | `--format json` stream never parsed | gap | `result_summary`, shape captured live |
| 11 | FK cascade would wipe task history | gap | no FK by choice |
| 12 | `opencode run` missing from `llmCommands` | gap | added in Phase 2 |

Adjacent, **out of scope** (pre-existing, not introduced here):
`create_agent`'s enum in `src/mcp.js:412` omits `claude` even though the driver
registry has six types — so a `claude` PAD cannot be created over MCP.

## Phases

- [x] Phase 1 — persistence + engine: `tasks` migration (no FK, SQL timestamps),
      boot reconciliation, `task-runner.js` (build command with `--dir`/`--auto`,
      spawn, stream, cap, kill) + `_setForTests` seam. Tests: schema, pre-checks,
      push happy path, non-zero exit, 512KB cap, cancel, timeout, boot sweep.
      Built 2026-09-24: `enqueue` flag added (address a task without starting it —
      required for pull of pre-assigned tasks); ordering uses monotonic `rowid`,
      not `created_at` (second resolution breaks FIFO ties).
- [x] Phase 2 — push MCP surface: 5 tools, `READ_TOOLS`/`TOOL_GRANT_FOR`
      updates, the `toolAllowed` exec-bucket clause, `requireTaskGrant`,
      `opencode run` in the driver's `llmCommands`. Tests: tool list, schemas,
      the grant matrix (read / base / lifecycle-only), pool-task grant path.
      Built 2026-09-24 (`tasks` 37/37 ×6 clean, `mcp` 27/27; paddock restarted,
      live `tasks` table verified).
- [x] Phase 3 — pull loop: `task_get_next` (atomic claim via
      `UPDATE … RETURNING`), `task_complete`, `task_priority`. Tests: two workers
      never claim the same task, priority ordering, pre-assigned isolation,
      complete/transition rules. Test fakes emit `exit` synchronously —
      `setImmediate` in the fake flaked ~50% under the test runner.
- [x] Phase 4 — live verified 2026-09-24 on `pad-opencode-jake-man` (root-mode
      opencode PAD, real model via env credentials):
      push `task_submit` → `running` → `done` exit 0, real `opencode run` wrote
      `hello-phase4.txt` **into the workspace** while the container CWD is
      `/jake` (proves `--dir`); `task_result` returned the extracted `"Done."`
      (proves the `part.text` event shape); a write-tool task completed headless
      with no hang (consistent with `--auto`; no-missing-approval control not
      run by design). Full MCP path proven with a minted `default` key:
      initialize → 27 tools incl. all 8 task tools → `task_submit` → `running`
      → `task_result` `done` + file `mango-phase4.txt` containing `mango`;
      key revoked after (401 confirmed). **Cancel bug found + fixed live:**
      first cancel left the container-side `opencode run` (PID 5976, 81% CPU)
      alive — SIGTERM only reached the `docker exec` CLI. Fix: pidfile +
      `PADDOCK_TASK_ID` env tag in the spawn, verified-by-environ in-container
      sweep (TERM now, KILL after grace) on every cancel/timeout; re-tested
      live with zero orphan processes. Pull loop live: pool submit → claim →
      `done`. Boot sweep live: planted `running` row flipped to `error` /
      `orphaned by webui restart` across a `docker restart paddock`.
      Cleanup done: 4 test files + 4 opencode sessions + test key + all task
      rows removed; live PAD left untouched.
- [ ] Phase 5 — absorb into `docs/` (`docs/overview/business-logic.md` MCP
      section + `docs/backend/services.md` task-runner) and delete this file.
      **Gate: do not absorb until the user explicitly confirms.**

## Verification

- `timeout 60 docker exec paddock node --test test/tasks.test.js` and
  `… node --test test/mcp.test.js` — individually, never the combined `test/`
  suite (it hangs).
- `docker restart paddock` after every backend edit (Node caches `require()`).
- Ownership: pre-assigned tasks resolve `claimed_by || agent_name` for
  `requireAccess`; unclaimed pool tasks are grant-scoped with an atomic claim.

## Open questions

- Exact `--format json` event shape (for `result_summary` extraction) — capture
  live in Phase 4, no guessed schema.
- Whether SIGTERM through `docker exec` reaches `opencode run` on this host —
  Phase 4; the in-container sweep is the backstop.
- Whether `--` before the prompt is accepted by the installed build.
- Whether pool tasks should carry owner scope once claimed.
- Multi-type support (codex `codex exec`, claude `claude --bg`) — deferred;
  the runner is already driver-driven.
