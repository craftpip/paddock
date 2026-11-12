# 2026-11-13 — Orchestrator runs a self-hosted Paddock project (plan 127)

Claude Code as the orchestrator, `paddock` MCP only, key `orchestrator`
(`tools:create,tools:exec,target:agent:pad-dev`). Project `paddock-self` on `pad-dev` (a clone
of this repo), three web-dev plans that each require a human decision, runner
`run_744c639e45735585`. Before the run the runner tools did not exist (plan 128 added them).

What worked first time: `help` recipe 0 was the exact path; `mission_project_create` →
`plan_write` ×3 → `runner_create` (one call) → `runner_start`; the worker marked plan 1
`need_input` with the right question; `runner_get` showed it under `blocked` with `next` naming
the exact answer call; `agent_queue_resolve_need_input {runner_id, item_id, answer}` delivered it
with a receipt and the worker resumed.

### A permission dialog strands the runner — no tool can get it going again

- **Tool:** `runner_get` + `mission_permission_answer` + `runner_start`
- **Severity:** blocker
- **What I asked:** answer the worker's permission dialog and let the queue continue.
- **What happened:** the watcher moved the runner to `waiting_input` ("Worker is waiting on a
  permission dialog…"). After `mission_permission_answer {choice: "reject"}` the dialog was gone
  and the worker was visibly working (`esc interrupt`), but the runner stayed `waiting_input`
  with the stale reason; `can.run` refused with that same reason; a watcher pass later, still
  stuck.
- **Why it hurts:** the run is dead from the orchestrator's side; only a human with a database
  could move it.
- **Fix:** a dialog is not a stop — keep the runner running and surface "waiting for
  permission"; lift any existing `permission_dialog` stop once the dialog is gone (watcher and
  Run).
- **Resolution (2026-11-13):** the watcher no longer stops on a dialog — it records
  `waiting_for_permission`, sends nothing, and carries on after the answer. A stale
  `permission_dialog` stop is lifted by the watcher (`observeQuotaStops`) once the dialog is gone,
  and Run refuses while it shows, naming the session. Proven live: the stranded runner lifted on
  the next pass after the dialog was answered.

### `next` says "Nothing can be done" and then names a tool, without its argument

- **Tool:** `runner_get`
- **Severity:** guessing
- **What happened:** `next: "Nothing can be done right now: Worker is waiting on a permission
  dialog: mission_permission_pending: … use mission_permission_answer {choice: ...}"` — the
  `session_id` the tool needs is missing, the label says "Needs input" though nobody asked a
  question, and `blocked` is empty.
- **Fix:** a permission case in the brief: label "Waiting for permission", `permission` with
  what is asked, `next` naming `mission_sessions {session_id}` then `mission_permission_answer
  {session_id, choice}`.
- **Resolution (2026-11-13):** label `Waiting for permission`, `waiting_for: "permission"`, and
  `next` names both calls with the real `session_id`.

### The parsed permission is empty though the screen shows it

- **Tool:** `mission_sessions` (detail)
- **Severity:** guessing
- **What happened:** screen: `△ Permission required ← Access external directory /proc/self
  Patterns - /proc/self/*`; parsed: `permission: {tool: "", path: ""}`.
- **Why it hurts:** the tool description tells the caller to "read the dialog's tool and path
  first"; the fields are blank, so it must parse raw TUI text to decide allow vs reject.
- **Fix:** parse the request line (`← <request>`) and the pattern list into `permission`.
- **Resolution (2026-11-13):** `detectPermission` reads `←`/`→` and the Patterns list; live:
  `{tool: "Access external directory /tmp", path: "/tmp/*"}`. Pinned by the real-screen fixture
  `permission-external-dir.txt`.

### `busy: false, busyKnown: true` while the turn is visibly running

- **Tool:** `mission_sessions`
- **Severity:** guessing
- **What happened:** twice during a working turn (`esc interrupt` on the same screen) the row
  said `busy: false, busyKnown: true` — "genuinely idle" per the guide.
- **Why it hurts:** the guide says to wait while busy; an LLM trusting the field would type into
  a live turn.
- **Fix:** busy = a tool part running OR the conversation's current turn still open (recent
  progress), from the same store read.
- **Resolution (2026-11-13):** `busyForSessions` also counts the conversation's turn while it is
  open and moved within 2 min (an abandoned turn does not read busy for ever).

### `can.run` on a running runner blames an unacknowledged plan

- **Tool:** `runner_start` / `runner_get`
- **Severity:** guessing
- **What happened:** while `state: running` (receipt confirmed), `can.run: "A plan was sent and
  has not been acknowledged; reconcile or pause before running again"`, while `can.reconcile:
  "No instruction is waiting for a receipt"` — the two contradict.
- **Fix:** an active runner's Run verdict is "The queue is already running".
- **Resolution (2026-11-13):** done (`runner-view.js`), seen live.

### The blocker answer returns bookkeeping, not the runner's state

- **Tool:** `agent_queue_resolve_need_input`
- **Severity:** noise
- **What happened:** `{delivered, requeued, resumed, operationId, receiptInputId}` — no brief, no
  `next`; the caller must call `runner_get` to learn what happens now.
- **Fix:** return the runner brief alongside the receipt.
- **Resolution (2026-11-13):** the answer returns `{answered, …receipt, runner: <brief>}`.

### Two "stop" vocabularies

- **Tool:** `help`
- **Severity:** guessing
- **What happened:** plan files have `blocked` / `need clarification` (in the file), the queue
  has `need_input` (on the item). The guide says both are stop states without saying which one
  makes the RUNNER stop and surface the question.
- **Fix:** one sentence in the runner paragraph: the runner reads the QUEUE item; `need_input`
  with the question as reason is what it surfaces.
- **Resolution (2026-11-13):** `help` says so, and describes the permission wait.

### A fresh runner reads "Queue paused"

- **Tool:** `runner_create`
- **Severity:** noise
- **What happened:** a runner that never ran: `reason: "Queue paused"`, `banner: "Queue paused"`.
- **Fix:** the `next` line already says "call runner_start"; the banner could say "Ready — not run
  yet". Left for later.

### Paths in results are the webui's, not the PAD's

- **Tool:** `mission_project_create`, `plan_write`
- **Severity:** noise
- **What happened:** `plansInit.dir` / `abs` are `/workspace/instances/pad-dev/opencode/...`
  (the control plane's view), next to `folder: /root/.opencode/workspace/...` (the PAD's).
- **Fix:** label them (`hostPath`) or add the PAD-side path. Left for later.

### An adopted turn owned nothing, so the worker could not close its plan

- **Tool:** (runner internals, seen through `mission_sessions`)
- **Severity:** blocker
- **What happened:** after the stale permission stop was lifted, Run adopted the worker's live
  turn; the worker finished plan 1 and its `agent_queue_update_item {status: done}` was refused:
  `operation=none, assigned=none`. It stopped with the item stuck `in_progress` (the runner's
  idle nudge recovered it a few minutes later).
- **Fix:** `adopt_active_turn` creates its own operation (`operation_kind: adopted`, status
  `running`) assigned to the plan in progress.
- **Resolution (2026-11-13):** done in `runner-transition.js` + `startRunner`; test
  `an adopted turn owns its plan…`, mutation-controlled.

### `next` says "working on" while the reason says the worker is idle

- **Tool:** `runner_get`
- **Severity:** noise
- **What happened:** `reason: "Worker idle — grace 87s remaining"`, `next: "The worker is
  working on self-01…"`. The runner nudges after the grace; `next` could say so. Left for later.

## Outcome

All three plans done by the worker; three blocker questions answered over MCP, two permission
dialogs rejected over MCP, one steer sent with `mission_send`. The clone's diff matches each
answer (`DashboardLayout.jsx` v{version} from package.json, the friendly empty state in
`SessionList.jsx`, Alt+Q in `shortcuts.js`).
