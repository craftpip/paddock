# Mission Queue and Runner

This page describes the server-owned Mission queue, runner lifecycle, delivery guarantees and
generated worker projection.

> Last updated: 2026-11-11

## Queue Authority

`runner-queue.js` stores queue metadata, ordered items, numeric revisions and durable events in
SQLite. `runner_queues` owns the revision and custom instructions; `runner_queue_items` owns
stable item IDs, order, plan path, status and reason; `runner_queue_events` records accepted
mutations. Writers submit the revision they read. A stale revision returns
`queue_revision_conflict`; the server never silently retries or overwrites a draft.

`QUEUE.md` is generated worker output, not queue authority. Workers read and update through
`agent_queue_read` and `agent_queue_update_item`; they never edit the file. A changed projection
sets `projection_error`, keeps canonical rows visible and blocks dispatch. Regenerate rewrites
the output from canonical rows, invalidates the old operation and leaves the runner Paused. It
does not import file statuses. A human may correct one reviewed item through the status-review
operation, which publishes the canonical change under the same revision check.

The numeric queue revision and the projection content hash answer different questions. The
revision detects a competing canonical mutation; the hash detects generated-file drift. The
write-boundary guard compares the current canonical revision with the revision read for the
dispatch, then independently checks projection integrity.

## Execution State

`runner_runtime` is the only authorization state. `runner_operations` owns each durable attempt;
`runner-transition.js` checks its state, generation and operation identity transactionally.
The UI consumes the server's `execution` and `scheduler` snapshot instead of reconstructing a
verdict from legacy columns or item progress.

| State | Meaning | Available action |
|---|---|---|
| `setup_required` | Canonical runtime or queue setup is absent | Set up; Run is unavailable |
| `paused` | No work is authorized to dispatch | Run explicitly or edit/review the queue |
| `dispatching` | One durable send attempt owns the runner | Pause or Close |
| `awaiting_receipt` | A write may have landed, but its exact receipt is absent | Reconcile, Hold, Pause or Close |
| `running` | The exact instruction receipt is confirmed | Pause or Close |
| `waiting_input` | A specific queue item or provider blocker needs a person | Resolve or review, or Close |
| `held` | An uncertain operation is stopped after its deadline | Inspect, Reconcile or Run fresh |
| `complete` | All queue items are done | Add work; the runner returns to Paused |
| `projection_error` | Generated output differs from its acknowledged version | Regenerate; Run is disabled |

`execution.canRun`, `canPause`, `canReconcile` and `canRegenerate` are the action verdicts.
When an interrupted turn is verified idle, `scheduler.recoveryRequired` is true, `canRun` is
true and `canPause` is false: the page offers an explicit recovery Run. A normal active turn
keeps Pause available. `working`, `idle` and `unknown` describe worker observation separately
from authorization; an unreadable or unknown observation never means idle.

### Operation Delivery

Before sending, Mission persists an operation ID, generation, conversation ID, item assignment,
queue revision, normalized prompt hash, baseline input ID and deadline. A unique runtime CAS
gives concurrent Run, watcher and recovery attempts one owner. Immediately before the terminal
write, Mission rechecks the operation lease, runner/session binding, lock, worker turn and queue
revision after asynchronous preflight. Pause, Close, solo lock, a new human turn or a changed
binding cancels the reserved send.

A receipt is a new user-message ID in the bound conversation after the baseline, with the exact
normalized prompt hash. A pane repaint alone is not a receipt. Unknown delivery stays
`awaiting_receipt` and is never automatically resent. Reconcile may confirm only that operation
in that conversation; a verified-idle operation past its deadline becomes `held`. Hold retires
receipt eligibility. Run fresh creates a new operation; a late receipt cannot revive the old
one. A confirmed instruction remains outstanding through its complete turn, not merely a tool
step, before another item can be dispatched.

Current-task Pause sends one cooperative stop request and remains `requested` until the worker
is observed idle. It keeps the current item `in_progress` at its checkpoint. Polling does not
repeat the request. Quota recovery and pane-loss recovery use the same generation and operation
ownership rules; a superseded callback cannot restart or send into a newer runner state.

## Projection Publication

`runner-publication.js` owns filesystem output, marker writes, acknowledgement and publisher
leases. Queue mutations record the desired projection revision/hash in the same transaction as
canonical rows and events; runtime transitions record the desired marker with the state event.
The publisher writes atomically, checks that the desired version still matches, then acknowledges
that exact version. The lease serializes publishers across webui processes, and a runner cannot
claim another runner's projection or marker path.

A publication failure remains visible and withholds dispatch. Boot retries an unacknowledged
desired version, but never overwrites an external edit to an already acknowledged projection.
Queue-path changes invalidate the old acknowledgement through the publisher service. The additive
schema update adds `operation_kind` and `queue_revision`; historical operation rows keep NULL
values rather than receiving guessed data.

## Worker and Mission APIs

Worker tools require the exact `runner_id`, target grant, project ownership and assigned item.
`agent_queue_update_item` accepts `new`, `in_progress`, `need_input` or `done` under a numeric
revision. A worker cannot resolve its own blocker. Every prompt includes the mandatory server
queue protocol, including saved custom prompts; unavailable tools mean stop, never file editing.

## Worker Readiness and Delivery

Run checks the worker before it types anything, and refuses with a code that names the fix:

| Code | Meaning |
|---|---|
| `runner_worker_tools_missing` | The pad has no connected `paddock` MCP server (`driver.paddockMcpStatus`, via `opencode mcp list`). Without it the worker cannot read or update the queue. An unreadable probe (`unknown`) does not block. |
| `runner_worker_identity_unavailable` | The worker session has no conversation id, or the runner is bound to another session. Close the worker and Run again. |
| `runner_worker_locked` | A human has solo-locked the worker session. |
| `runner_worker_not_idle` | The worker is mid-turn. |

Every session carries a conversation id from its first read. On a published pad the id is minted
through the pad's web server; on an unpublished pad (the default) the driver starts a short-lived
`opencode serve` on a random loopback port as the pad user, `POST`s `/session` for the folder, and
stops it (~4 s). It logs to stderr because the running TUI holds the log file.

`sendText` waits for the driver's `tuiReadyPattern` (opencode: `ctrl+p commands`, shown both idle
and mid-turn) before writing, for up to 15 s. A freshly launched TUI drops input for its first ~5 s,
and that is where every new worker's startup instruction used to go. A TUI that never becomes ready
gets `mission_tui_not_ready` with `attempted: false`, meaning nothing was written and a retry is safe.

After the write, the runner polls for 5 s for the exact receipt: a new user message whose text
hashes to the instruction. It stops early if Pause, Close or a newer operation takes ownership.
`sendText` confirms on new store activity, which can land before the user message's parts can be
read, so a single read reported delivered instructions as unconfirmed.

`publicRunner` (served by `/api/mission/runners`) never contradicts the canonical runtime. When no
session is bound, the worker fields read `unknown`. When the runtime is inactive, the
`scheduler_*` fields follow `execution.state`, so a stale idle-grace countdown does not outlive
its run. Internal scheduling still reads the raw columns.

## Runner REST Surface

`GET /api/mission/runners/:id/queue` returns canonical rows/revision, `execution` and `scheduler`.
`POST /api/mission/runners/:id/start`, `/pause`, `/resolve` and `/reconcile` use the transition
service and return the refreshed snapshot. Public runner payloads expose one `execution` object;
transition-era flat aliases remain internal and are derived from `runner_runtime` and
`runner_operations`, never used as fallback authority.

## See Also

- [Backend services](services.md)
- [Mission page](../pages/overview.md)
- [Runner History](../components/runner-history.md)
