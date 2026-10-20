# 113 — One Queue Authority And A Complete Runner State Machine

## Status: In progress — 2026-10-20

1/8 phases complete. The authority service and pure transition table now exist
behind focused tests. Mission queue setup/read and add/reorder/remove/instruction
mutations now use canonical rows and regenerate `QUEUE.md`; runner resolution,
callbacks, watcher state transitions, MCP and the full UI state model remain in
the next integration phases. Mission queues currently split truth between editable
`QUEUE.md`, persisted runner stop fields, marker files, agent prompts, the
scheduler, and client snapshots. This plan replaces that arrangement with one
server-owned queue model and proves every transition in the browser.

## Goal

Make an infinite Mission queue manageable from one place without hidden state,
stale diagnoses, duplicate IDs, raw-file corruption, or a UI that disappears
when it is needed for recovery.

For every queue and runner, a user must be able to answer from the Mission page:

1. What is the canonical queue and its exact revision?
2. What is executing, blocked, paused, awaiting a receipt, held, or complete?
3. What action is allowed now, what will it do, and why are other actions
   disabled?
4. If anything is broken, what data is preserved and how is it repaired without
   guessing or editing hidden state?

This is development-only work. Do not write migrations, compatibility readers,
legacy fallbacks, or data-preservation shims. Replace the current queue format
and state model decisively. Existing development queues may be reset or imported
once through an explicit developer command; the finished code must have exactly
one authoritative path.

## Non-Negotiable Rules

- The server owns queue identity, item identity, ordering, status, reasons,
  revisions, runner control state, operation ownership, receipt state and pause
  state. The browser and worker never manufacture durable queue IDs or infer
  verdicts from separate fields.
- Queue writes go through one service and one transactional persistence boundary.
  The service assigns an ID, validates the state transition, records the change,
  and returns the complete canonical queue. No feature writes queue JSON directly.
- `QUEUE.md` is a generated, read-only worker-facing projection, not a source of
  truth. Its content must say this plainly. On every server mutation it is
  regenerated atomically from the authority. Changes an agent makes to it do not
  become queue state and must be detected and surfaced as an external-edit error,
  never silently imported.
- The runner is a state machine, not a combination of `enabled`, `control_state`,
  `stop_cause`, marker existence, last reason, and client guesses. Store one
  canonical state plus only the immutable facts needed to transition it.
- The marker is derived output. The service creates or removes it from the
  canonical runner state; no caller independently syncs it. A test must prove
  marker and state cannot disagree after every transition.
- A malformed or externally changed projection never hides data. Mission shows
  the last canonical queue, the projection problem, and a safe repair/regenerate
  action. It never renders a blank queue, a stale invalid diagnosis, or an
  editable raw JSON dump as the only recovery route.
- Do not rebuild `src/public` from the shared dirty worktree during verification.
  Build a controlled snapshot only after the intended frontend source is known.

## Canonical Model

Replace file-backed queue parsing in `src/services/plans.js` with a dedicated
queue service, for example `src/services/runner-queue.js`, backed by new
development-only tables. Use normal schema creation, not migrations.

### Queue Facts

Each runner has one queue row and ordered item rows.

| Fact | Meaning |
|---|---|
| `queue.id`, `runner_id`, `revision` | identity and compare-and-swap version |
| `item.id`, `position`, `plan` | server-generated stable item identity and order |
| `item.status` | `new`, `in_progress`, `need_input`, `done` |
| `item.reason` | optional status note; nonblank only mandatory for `need_input` |
| `item.created_at`, `updated_at` | durable audit/debug facts |
| event row | append-only actor, action, prior/new state and timestamp |

- Enforce `UNIQUE(queue_id, position)` and `UNIQUE(queue_id, item.id)` in the
  database. Do not rely on a client-generated timestamp/random string for either.
- Use a numeric or UUID server-generated item ID. The server alone allocates it.
- Keep plan paths scoped to the runner's project plans root. Reject absolute,
  escaping, reserved and non-Markdown paths before insertion.
- The queue summary is one pure projection from these rows. No client or runner
  recomputes current, next, blocked, counts or completion independently.

### Runner States

Replace the existing overlapping state fields with exactly these canonical states:

| State | Meaning | Allowed user action |
|---|---|---|
| `paused` | no work is authorized | Run |
| `dispatching` | one instruction is being delivered | Pause/Close only |
| `awaiting_receipt` | write may have landed; no duplicate send | Reconcile, Hold, Pause/Close |
| `running` | exact instruction receipt observed | Pause |
| `waiting_input` | a queue item requires a human answer | Resolve, Pause/Close |
| `held` | delivery/work outcome cannot be inferred safely | Reconcile, Run fresh, Pause/Close |
| `complete` | every item is done | Add plans, Run after adding |
| `projection_error` | generated worker file differs from canonical state | Regenerate projection |

- An explicit transition table in the service owns every legal edge. Reject every
  other edge with a typed error that names the current state and allowed actions.
- `Run` reads the canonical queue and either enters `dispatching` for one server
  operation or answers why it cannot. It never infers state from `QUEUE.md`.
- `awaiting_receipt` has one persisted operation with conversation ID, prompt hash,
  baseline message ID and deadline. It cannot generate a second prompt. Exact
  receipt moves it to `running`; an explicit hold/deadline moves it to `held`.
- `Pause`, `Close`, lock, changed conversation and a newer operation invalidate
  the owned operation transactionally. A later receipt cannot resurrect it.
- The generated marker exists in `paused`, `waiting_input`, `held`, `complete` and
  `projection_error`; it is absent only in `dispatching`, `awaiting_receipt` and
  `running`. The service is the only marker writer.

## User Journey

1. Open any infinite session. The queue panel always displays the canonical item
   list, current state, revision, current/next item and all available actions.
   A URL state such as `queue=closed` may collapse healthy details but never hides
   an error, held operation or recovery control.
2. Add plans. The server rejects already-queued paths and assigns item IDs. The
   UI uses the returned queue, not optimistic IDs. A stale revision offers Reload
   and preserves the user's selected plans for review.
3. Press Run. The panel shows `Dispatching`, then `Awaiting receipt` or `Running`.
   If delivery cannot be confirmed, it says exactly that and offers Reconcile and
   Hold. It never says `Needs input`, `Paused`, or `Queue invalid` unless those
   are the canonical states.
4. An agent changes a queue item through the server queue action/API. The event,
   queue rows, generated `QUEUE.md`, marker and UI all advance together. A direct
   edit to the generated file is detected; the panel keeps the canonical list
   visible and offers Regenerate projection.
5. If a worker needs a person, it records `need_input` through the queue service.
   The page shows the exact item and reason with one Resolve flow. Resolving
   changes that item back to `new` and continues the same owned operation only
   when receipt rules make it safe.
6. A queue becomes complete only when every canonical item is `done`. It remains
   readable and editable; adding a plan moves it back to `paused`, never leaves a
   stale complete banner.

## Scope

- Backend: `src/services/runner-queue.js` (new), `src/services/mission.js`,
  `src/services/db.js`, runner dispatch/callback services, `src/app.js`, and the
  existing plans service only where it generates the worker projection.
- API: replace raw queue read/write routes with queue-service routes. Keep route
  names only when their meaning remains canonical; delete dead file-parser routes
  rather than adding compatibility branches.
- Worker interface: add explicit queue operations to the agent-facing service/MCP
  surface and rewrite runner prompts to require those operations. Remove prompt
  instructions that tell the worker to edit JSON in `QUEUE.md`.
- Client: `src/client/src/stores/mission.js`, `QueuePanel.jsx`,
  `RunnerControls.jsx`, `RunnerSchedulerStatus.jsx`, `PlanPicker.jsx`, runner
  dialogs and any shared status projection. Client state uses server values only.
- Tests: replace parser-centric tests with service/state-machine, API, client-store
  and browser transition tests. Retire tests that pin the old file-authority
  contract.
- Documentation: after implementation, document the canonical queue model once in
  `docs/reference/backend/services.md` and link Mission behavior from its page.

## Ordered Implementation

1. **Inventory and freeze the old paths.** Enumerate every `QUEUE.md` read/write,
   marker mutation, queue prompt, scheduler decision, REST route, MCP tool and
   client-derived state. Add a temporary source-level guard test that fails when
   any non-projection code writes `QUEUE.md` or `QUEUE.paused` directly.
2. **Build the authority.** Add development-only queue/event tables and one
   `runner-queue` service. Implement creation, read, add, reorder, remove,
   status-note update, resolve, queue summary, revision CAS and projection
   generation. Make all writes transactional and return one canonical response.
3. **Build the runner transition table.** Replace existing runner state decisions
   with explicit events (`run`, `delivery_unknown`, `receipt`, `hold`, `pause`,
   `close`, `need_input`, `complete`, `projection_mismatch`). Centralize operation
   ownership and make marker generation part of the same transition boundary.
4. **Move dispatch and workers.** Route scheduler, watcher, callback and receipt
   observation through the transition service. Give workers an authenticated queue
   mutation action; regenerate the projection after each accepted mutation. Remove
   direct-file instructions from all runner templates.
5. **Replace API and client state.** Make Mission fetch one queue snapshot. Remove
   client ID generation, client aggregate derivation, stale reason rendering and
   raw file repair as a normal workflow. Render the server transition state and
   allowed actions verbatim.
6. **Add projection integrity.** Hash the generated `QUEUE.md` and validate it on
   queue reads and before worker dispatch. A mismatch becomes `projection_error`,
   retains canonical rows, blocks dispatch and offers one Regenerate action. Do
   not import a changed projection into canonical state.
7. **Replace tests with state-sequence coverage.** Cover every transition and each
   invalid transition in service/API tests. Add mutation controls that remove a
   state guard, marker update, revision check or receipt identity check and prove
   the targeted test fails in a `/tmp` copy.
8. **Browser acceptance and cleanup.** Test all states in a controlled Mission
   project through the browser, inspect console/network failures, then remove old
   parser/state code and absorb the finished model into docs.

## Verification Matrix

Every row is an end-to-end acceptance test, not a source-text assertion.

| Scenario | Required result |
|---|---|
| Add plans from two tabs | one CAS winner; loser reloads; no duplicate ID/path |
| Reorder/remove/status update | canonical response, event row and projection agree |
| Direct `QUEUE.md` edit | canonical queue stays visible; `projection_error`; Regenerate restores projection |
| Valid queue after a prior invalid state | stale diagnosis cannot survive; queue is paused until explicit Run |
| Run accepted | one operation, one prompt, marker absent, state progresses to running only on exact receipt |
| Run unconfirmed | awaiting-receipt state, no duplicate prompt, marker remains absent, Reconcile/hold work |
| Receipt mismatch | remains awaiting receipt; no state change or dispatch |
| Pause/Close during delivery | operation invalidated; marker present; late receipt cannot resume |
| Need input | exact item/reason visible; resolve changes canonical item once and preserves queue order |
| Complete then add plan | complete clears; new queue is paused and runnable |
| Refresh/restart | snapshot rehydrates from database with the same queue and legal actions |
| `queue=closed` with any error | panel remains expanded with canonical rows and recovery controls visible |

### Required Test Commands

- Run each focused backend suite individually with `timeout 60 docker exec paddock
  node --test test/<file>.test.js`; never run the combined test directory.
- Add a client-store suite through the existing ESM resolver hook and test
  transition rendering from actual server-shaped snapshots.
- Build only the intentional frontend snapshot. Before the build, inspect the
  intended frontend diff; after it, verify generated assets belong to that
  snapshot. Do not use a dirty shared worktree as an implicit release source.
- Restart `paddock` after backend changes. Test Mission in Chromium at
  `http://10.69.1.164:6789/mission` on desktop and a narrow viewport.
- For each browser scenario, assert the resulting DOM, console and network state:
  exact status label, listed canonical rows, enabled/disabled action, no request
  failure, and the generated projection/marker state read through the server.

## Completion Criteria

- There is one queue authority and one runner transition service.
- No normal code path treats editable `QUEUE.md` as canonical state.
- No UI surface derives a runner verdict or queue summary locally.
- Duplicate IDs cannot be written by any server or UI path; external projection
  edits are visible and recoverable without hiding the canonical queue.
- Every state in the matrix has a passing focused test and browser proof.
- The active served bundle is intentionally built, not accidentally rebuilt from
  unrelated work.

## Progress

- [x] Inventory old queue/state/marker writers and freeze direct writes.
- Inventory: `plans.js` owns parser/template/projection/marker writes; `mission.js`
  reads and writes it from setup, detail reads, start/resume, pause/resolve,
  observer and scheduler paths; `app.js` and `mcp.js` expose raw queue writes;
  `runner-callbacks.js` observes file mutations; QueuePanel still generates IDs.
- [ ] Implement database-backed canonical queues, events, CAS and projection.
- Authority foundation: `runner-queue.js` now persists server-generated queue/item
  IDs, ordered rows, revision CAS, status updates, queue instructions and append-only
  events. `runner-state.js` defines the legal canonical state transitions and marker
  derivation. Mission setup/read plus add/reorder/remove/instructions now use this
  authority and write a deterministic read-only `QUEUE.md` projection; direct edits
  are detected and block Run. Remaining work is watcher/callback/resolve/MCP and
  full state-machine integration.
- [ ] Implement the explicit runner transition table and receipt ownership.
- [ ] Move scheduler, prompts, worker actions and APIs to the authority.
- [ ] Replace client derivations with one canonical queue snapshot.
- [ ] Add projection-integrity recovery without hiding queue data.
- [ ] Prove all state transitions with focused suites and mutation controls.
- [ ] Build an intentional SPA snapshot, browser-test every matrix row, document and absorb.
