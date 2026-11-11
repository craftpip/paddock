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

Two writers are exempt from hand-resolving that conflict, because their writes commute with
whatever moved the revision. The page's **Add plans** re-reads the queue once and retries, and
the worker tool `agent_queue_update_item` retries once against the current revision. The
worker's write is guarded by ownership instead (its assigned item, a legal status step): a
running worker bumps the revision on every status update, and a human adding a plan mid-turn
bumps it under the worker.

Membership and order change only while the runner is `paused` or `complete`
(`queue_runtime_busy` otherwise), with one exception: plans may be **appended** while an ordinary
queue operation is dispatching or running, and while the queue waits for input, since an append
never disturbs the item the worker holds. Reorder and removal still need a pause, and the page
disables those controls with the reason. The rule is one function,
`runner-state.queueEditVerdict`, called by both the write and the view. Nothing may be changed during a blocker resolution, which is pinned to the revision
it was sent against.

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

### The view the page renders

`services/runner-view.js` builds `execution` with one pure function, `buildExecution`. It reads
no database: the caller passes the runtime state, queue condition, items, scheduler decision,
active operation, pause mode and whether the worker is mid-turn. The page renders the result
and derives nothing.

| Field | Meaning |
|---|---|
| `state` | Runtime state; a queue repair condition (`projection_error`, `setup_required`) wins |
| `label`, `tone` | Header word and its colour family (`active`, `success`, `danger`, `idle`) |
| `reason` | One sentence for the status strip |
| `banner` | `{ kind, tone, text }` shown above the list, or `null`. Paused only, today |
| `operation` | The operation that owns the runner, or `null` |
| `actions` | One `{ allowed, reason }` per control; `reason` is the disabled tooltip |

`actions` carries `setup`, `run`, `pause`, `regenerate`, `reconcile`, `reviewStatus`,
`resolve`, `addItems`, `reorder` and `removeItem`. Each is computed from the predicate the
write path enforces, so an offered control is an accepted write:

- `run` uses the state machine's `EVENTS.run`.
- `addItems`, `reorder` and `removeItem` use `runner-state.queueEditVerdict`, the same call
  `runner-queue.mutate` makes before any change.
- `reviewStatus` uses `REVIEWABLE_STATES`, which `updateRunnerQueueItem` also enforces
  (`runner_invalid_state` otherwise).

`runner-view.test.js` pins the parity by attempting each write in every state on a throwaway
database and comparing the outcome with the verdict.

When an interrupted turn is verified idle, `scheduler.recoveryRequired` is true, `actions.run`
is allowed and `actions.pause` is not: the page offers an explicit recovery Run. A normal active
turn keeps Pause available. `working`, `idle` and `unknown` describe worker observation
separately from authorization; an unreadable or unknown observation never means idle.
`scheduler.countdownLabel` names a running countdown (idle grace, nudge interval) so the page
only keeps the clock.

A refusal raised by an action taken inside a dialog renders inside that dialog
(`components/ui/DialogError.jsx`): plan picker, status review and resolve.

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

Worker tools require the exact `runner_id` and the assigned item. `agent_queue_update_item`
accepts `new`, `in_progress`, `need_input` or `done` under a numeric revision. A worker cannot
resolve its own blocker. Every prompt includes the mandatory server queue protocol, including
saved custom prompts; unavailable tools mean stop, never file editing.

## Two MCP Surfaces

| Server (in the pad) | Endpoint | Credential | Tools | For |
|---|---|---|---|---|
| `paddock` | `/mcp` | user API key (grants) | the full control surface, including all five `agent_queue_*` tools | humans, orchestrators |
| `paddock_runner` | `/mcp/runner` | per-pad runner token (`prk_…`) | `agent_queue_read`, `agent_queue_update_item` only | infinite-queue workers |

A runner token (`runner_mcp_tokens`, sha256 only, one per pad; minting replaces the old one)
identifies a **pad**, not a user. It reaches only runners whose project lives on that pad; anything
else returns `runner_not_on_this_pad`. User API keys are refused on `/mcp/runner` with a JSON 401.
Queue events written through it carry the actor `runner-mcp:<pad>`. In opencode the tools appear as
`paddock_runner_agent_queue_read` / `paddock_runner_agent_queue_update_item`, which is how the
prompts name them.

Nobody wires it by hand. On Run, `ensureRunnerMcp` probes `paddock_runner` (`opencode mcp list`, as
the pad user). If it's connected, nothing happens. If it's absent or failed, Run mints a token,
removes any stale entry, runs `opencode mcp add` with the token read from stdin (never argv), and
re-probes. MCP servers load when a TUI starts, so if the wiring changed and the bound worker TUI
is live and idle, Run restarts it into the same conversation (`worker_restarted`). If the worker is
mid-turn, Run refuses rather than interrupting it.

## Worker Readiness and Delivery

Run checks the worker before it types anything, and refuses with a code that names the fix:

| Code | Meaning |
|---|---|
| `runner_worker_tools_missing` | Automatic wiring of `paddock_runner` didn't connect; the message quotes opencode's reason and points at `HOST_NAME` (the pad must reach this host). An unreadable probe (`unknown`) neither wires nor blocks. |
| `runner_worker_identity_unavailable` | The worker session has no conversation id, or the runner is bound to another session. Close the worker and Run again. |
| `runner_worker_locked` | A human has solo-locked the worker session. |
| `runner_worker_not_idle` | The worker is mid-turn. |

Every session carries a conversation id from its first read. On a published pad the id is minted
through the pad's web server; on an unpublished pad (the default) the driver starts a short-lived
`opencode serve` on a random loopback port as the pad user, `POST`s `/session` for the folder, and
stops it (~4 s). It logs to stderr because the running TUI holds the log file.

`sendText` waits for the driver's `tuiReadyPattern` (opencode: the `ctrl+p commands` footer hint,
or a footer line ending in `commands` on a pane too narrow for the hint; shown both idle and
mid-turn; a pane of 120+ columns puts sidebar text after the hint on the same line) before writing, for up to 15 s. A freshly launched TUI drops input for its first ~5 s,
and that is where every new worker's startup instruction used to go. A TUI that never becomes ready
gets `mission_tui_not_ready` with `attempted: false`, meaning nothing was written and a retry is safe.

After the write, the runner polls for 5 s for the exact receipt: a new user message whose text
hashes to the instruction. It stops early if Pause, Close or a newer operation takes ownership.
`sendText` confirms on new store activity, which can land before the user message's parts can be
read, so a single read reported delivered instructions as unconfirmed.

Pause invalidates the owned operation immediately, but the item it interrupted may still be
**closed** by the worker while the runner is paused (`in_progress` to `done` or `need_input`).
That is what lets "Pause before next task" finish the plan in flight; before it, the worker's
closing write was refused with `queue_item_not_assigned` and the row stayed Working until the
next Run. Starting any item while paused is still refused.

An automatic dispatch withheld at the write boundary (lock, queue revision moved, projection
drift, a new human turn) pauses the runner once and logs one `dispatch_failed`. Later watcher
ticks do not retry it; only an explicit Run resumes. Pre-113 code retried such a refusal every
nudge interval indefinitely.

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
