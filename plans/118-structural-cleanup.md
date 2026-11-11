# Plan 118 — Structural cleanup: one runner view, split files, instant dispatch

## Status: In progress — 2026-11-11 — 1/7 phases done (Phase 1); next: Phase 2

## Why

The design of Paddock is sound (canonical runner state machine, driver
registry, honest "unknown" answers). The structure around it is not. Measured
on 2026-11-11:

| Fact | Number |
|---|---|
| `src/services/mission.js` | 4676 lines, 145 top-level functions |
| `src/services/vm-manager.js` | 5002 lines |
| `src/app.js` | 4161 lines, 158 routes (49 under `/api/mission`) |
| `src/mcp.js` | 2999 lines |
| Test files that read source text instead of running code | 22 of 63 |
| Wait between two queue plans by default | up to 120 s + 20 s tick |
| `src/public` (build output) tracked in git | 7 files, rebuilt by hand |

Every bug found in the 2026-11-11 browser pass (commit `aa966b7`) was two
layers disagreeing about runner state: the service returned a pre-mutation
runner, the client re-derived a label the server already had, an error
rendered behind its own dialog. This plan removes the places where they can
disagree, then makes the files small enough to read.

## Rules for whoever executes this

- One phase per commit. Do not start a phase until the previous one is
  committed and its checks pass.
- **No behaviour change in Phases 2, 5 and 6** — they move code. If a test
  needs a behaviour edit to pass, stop: the move was wrong.
- Run tests one file at a time inside the container:
  `timeout 120 docker exec paddock node --test test/<file>.test.js`.
- Backend edit → `docker restart paddock`. Client edit →
  `cd src/client && npm run build` then `docker restart paddock`.
- Mutation controls run in a `/tmp` copy, never in `/app` (bind-mounted).
- Each phase ends with a browser check on `http://10.69.1.131:6789/mission`
  using a real runner on a `pad-*` we created. Click the control, then assert
  on the resulting DOM in a second evaluate.
- Update this file's `## Status:` line and checklist before leaving a phase.

## Progress

- [x] Phase 1 — One server-computed runner view (2026-11-11, see "Phase 1 — as built")
- [ ] Phase 2 — Split `mission.js`
- [ ] Phase 3 — Dispatch the next plan when the worker reports done
- [ ] Phase 4 — One test command that finishes
- [ ] Phase 5 — Split `app.js` routes
- [ ] Phase 6 — Turn `AGENTS.md` lessons into tools
- [ ] Phase 7 — Stop tracking `src/public`

---

## Phase 1 — One server-computed runner view

**Goal:** the client renders runner state; it never works it out.

**Today:** the queue read returns `execution` (state, reason, allowedActions)
and `scheduler` (a `decision(...)` from `computeSchedulerState`,
`mission.js:4174`). `QueuePanel.jsx` and `stores/mission.js` then combine
those with `runner.pause_mode`, item statuses and their own strings to decide
the header label, the banner text and which buttons are enabled.

**Contract.** Add one object, `view`, to every response that carries a runner
or its queue (`GET /api/mission/runners`, `GET /api/mission/runners/:id`,
`GET /api/mission/runners/:id/queue`, and every mutation that returns the
queue):

```js
view: {
  state,            // canonical runtime state, unchanged vocabulary
  label,            // header word: "Running", "Paused", "Sending plan", "Needs input", "Complete", "Held", "Setup required"
  tone,             // "ok" | "warn" | "danger" | "idle"  (client maps to colour only)
  detail,           // one sentence under the label, or null
  banner,           // { kind: "paused"|"blocked"|"held"|"error", text } or null
  currentItemId,    // item the worker holds, or null
  nextItemId,       // item the next Run/dispatch will take, or null
  nextDispatchAt,   // ISO time the scheduler will next act, or null
  actions: {        // every control the panel shows
    run:          { allowed, reason },
    pauseNext:    { allowed, reason },
    pauseCurrent: { allowed, reason },
    resolve:      { allowed, reason },
    addItems:     { allowed, reason },
    reorder:      { allowed, reason },
    removeItem:   { allowed, reason },
    configure:    { allowed, reason },
  },
}
```

`reason` is the sentence shown as the disabled control's tooltip and is
`null` when `allowed` is true.

**Steps**

1. Create `src/services/runner-view.js` exporting a **pure**
   `buildRunnerView({ runner, runtime, operation, queue, scheduler, now })`.
   No database access inside it.
2. Move every user-facing string about runner state into it: the reasons in
   `computeSchedulerState`, the paused-banner variants in `QueuePanel.jsx`
   (current_task / finishing / part-way), the "Pause the queue to change its
   order or remove plans" tooltip, the Run-disabled reasons.
3. `actions.*.allowed` must be derived from the **same predicates the write
   path uses**. Export the predicates from `runner-queue.js` (`canAppend`,
   `canReorder`, `canRemove`) and from `runner-state.js` (`allowedActions`)
   and call them from both the gate and the view. Do not copy the conditions.
4. Attach `view` in `readRunnerQueueFor` and the runner list/detail
   projections in `mission.js`.
5. Client: `QueuePanel.jsx`, `RunnerSchedulerStatus` and `stores/mission.js`
   read `view.*` only. Delete the local derivations. Keep a fallback to the
   old fields only if `view` is absent, and delete that fallback at the end
   of the phase.
6. Errors raised inside a modal (PlanPicker, Resolve, status review,
   Configure) render inside that modal. Add one shared `DialogError`
   component and use it in all four.

**Tests** (`src/test/runner-view.test.js`, new, behaviour only)

- One table-driven test: for each of the ten runtime states × {empty queue,
  queued items, item in progress, blocked item}, assert `label`, `banner.kind`
  and all eight `actions.*.allowed`.
- Parity test: for every state, call the real write (`mutate` add / reorder /
  remove, `applyRun`, `applyPause`) on a throwaway DB (`PAD_DB_PATH`) and
  assert it succeeds exactly when `view.actions.<x>.allowed` is true.
- Mutation control: change one predicate in the view only → parity test red.

**Browser assertions**

- Paused, running, needs-input and complete each show the label from the API
  response (compare `.msn-queue-*` text with `view.label` fetched in the same
  evaluate).
- While running, reorder/remove buttons are disabled and their `title` equals
  `view.actions.reorder.reason`.
- Force a refusal inside each of the four dialogs; the message is visible
  inside the dialog element.

**Done when:** the client holds no runner-state derivation of its own.

### Phase 1 — as built

- The server already had a partial verdict named `execution`, so the view **is**
  `execution`, extended, rather than a second object called `view`. One name.
- `services/runner-view.js` → pure `buildExecution`. Old flat fields
  (`canRun`, `canPause`, `canReconcile`, `canRegenerate`, `canReviewStatuses`,
  `runReason`, `setupRequired`) are gone; `actions.<name>.{allowed,reason}`
  replaces them. `currentItemId`/`nextItemId` were not added: `queue.summary`
  already carries current/next/blocked.
- Shared predicates live in `runner-state.js`: `queueEditVerdict`,
  `REVIEWABLE_STATES`. `runner-queue.mutate` and `updateRunnerQueueItem` call them.
- Two behaviour changes, both pinned by the parity test: a hand status
  correction is now **refused by the server** while the queue runs (it was only
  disabled in the page), and plans can be appended while the queue waits for input.
- Labels in plain words: "Sending plan", "Waiting for worker", "Held",
  "Setup required", "Queue file out of sync".
- `components/ui/DialogError.jsx` used by the plan picker, status review and
  resolve dialogs. Configure already showed its errors in place.
- Tests: `runner-view.test.js` (8). Mutation control (view ignores the edit
  predicate) → 2 red, 6 green, run in `/tmp/mut`.
- Browser (devrunner): Complete, Paused, Sending plan, Running, Needs input
  labels and tones match the API; row controls disabled with the server's
  sentence while running; status-review and resolve refusals render inside
  their dialogs; real resolve resumed the queue.

---

## Phase 2 — Split `mission.js`

**Goal:** no service file over ~900 lines; `mission.js` stays as a facade so
no caller changes.

**Target layout** (`src/services/mission/`):

| File | Holds |
|---|---|
| `errors.js` | `MissionError`, codes |
| `projects.js` | project CRUD, folders, `agentRow` |
| `sessions.js` | start/relaunch/restart/close, `sendVerdict`, `sendText`, screen |
| `liveness.js` | `withLive*`, `withAgentBusy*`, `stampTruth` |
| `runners.js` | runner CRUD, settings, prompts, public projections |
| `runner-queue-api.js` | `readRunnerQueueFor`, `mutateCanonicalQueue`, `updateRunnerQueueItem`, resolve |
| `scheduler.js` | `computeSchedulerState`, `runnerWatchTick`, dispatch, receipts |
| `index.js` | re-exports the exact current `module.exports` list |

`src/services/mission.js` becomes `module.exports = require('./mission/index')`.

**Steps**

1. Before moving anything, write the export list to a test:
   `src/test/mission-exports.test.js` asserts
   `Object.keys(require('../services/mission')).sort()` equals a literal
   array captured from the current file. This is the guard for the phase.
2. Move one file at a time in the table's order. After each move: `node
   --check` every touched file, run `mission.test.js`, `mission-queue.test.js`,
   `runner-canonical-queue.test.js`, `runner-dispatch-invariants.test.js`,
   `mcp.test.js`.
3. Shared private helpers used by more than one new file go to
   `mission/internal.js`. No circular requires: `scheduler.js` may require
   `runner-queue-api.js`, never the reverse.
4. Add a static check to the exports test: every identifier passed to
   `audit(` is declared in its enclosing function's signature (the
   free-variable trap recorded in `AGENTS.md`).
5. Source-text tests that pin a path (`readFileSync('…/mission.js')`) are
   re-pointed at the fact's new file with a comment; never loosened.

**Browser assertions:** start a session, send a line, run a two-plan queue to
Complete. Console has no errors.

**Done when:** `wc -l src/services/mission/*.js` shows none over 900 and the
suites above are green with unchanged pass counts.

---

## Phase 3 — Dispatch the next plan when the worker reports done

**Goal:** the next plan starts within about two seconds of the previous one
finishing, instead of waiting for the 20 s tick plus two 120 s timers.

**Today:** `agent_queue_update_item {status: done}` records the item. The
next dispatch waits for `runnerWatchTick` (`app.js:3702`, every 20 s) to see
the pane idle for `idle_grace_ms` and `min_nudge_interval_ms` since the last
dispatch (`mission.js:4210-4213`).

**Design**

- The worker's own "done" is positive evidence the plan ended, which is what
  the idle grace was approximating. So after a worker `done` on the assigned
  item, schedule `dispatchAfterDone(runnerId, generation)`:
  1. wait for the pane to be ready (reuse the driver's `tuiReadyPattern`
     gate), polling every 500 ms for at most 15 s;
  2. re-read the runtime; if `generation` changed or state is not `running`,
     do nothing;
  3. call the existing dispatch function with `{ explicit: false, cause:
     'worker_done' }`.
- `idle_grace_ms` and `min_nudge_interval_ms` keep applying to the **tick
  path only** (a worker that ended its turn without reporting). Reword both in
  Configure: "If the worker goes quiet without reporting, wait this long
  before nudging."
- The tick stays as the safety net and must be idempotent against the fast
  path: both go through `applyDispatchNext`, whose compare-and-swap on
  state/generation/operation already lets only one win. The loser gets
  `runner_transition_conflict` and must swallow it.
- Complete: when the worker's `done` closes the last item, apply `complete`
  right there so the header does not read "Running" for 20 more seconds.
- Not on the fast path: `need_input`, a `done` accepted under
  `finishingPaused`, any state other than `running`.

**Files:** `mission/scheduler.js`, `mission/runner-queue-api.js`,
`services/agent-queue-mcp.js`, `RunnerDialog.jsx` (wording),
`docs/reference/backend/mission-queue.md`.

**Tests** (`src/test/runner-fast-dispatch.test.js`, fake pane + throwaway DB)

- done on item 1 of 2 → a `dispatch_next` transition exists within the test's
  wait, with `details.cause === 'worker_done'`, and no clock advance past
  either timer.
- done on the last item → state `complete`, no dispatch.
- pause between done and the delayed dispatch → no dispatch (generation
  changed).
- tick and fast path fired together → exactly one new `runner_operations` row.
- worker ends its turn without reporting → still dispatched by the tick after
  the timers (existing behaviour, pinned).
- Mutation control: remove the generation re-check → the pause test goes red.

**Browser assertions:** queue three trivial plans on a runner with **default**
timers (restore `devrunner` idle grace to 120000 first). Time from row 1
"Done" to row 2 "Working" is under 5 s; header reads "Complete" within 3 s of
the last row turning Done.

---

## Phase 4 — One test command that finishes

**Goal:** `npm test` inside the container runs every suite and exits.

**Steps**

1. Find the hang. Run each file with
   `node --test --test-timeout=120000 test/<file>` and list the ones that only
   exit under `--test-force-exit`. Likely causes, in order: `app.js` timers
   pulled in by a require, open `better-sqlite3` handles, `setInterval` in
   `task-runner.js` / `job-log.js` without `.unref()`.
2. Fix at the source: `.unref()` every background interval; give modules that
   start timers an explicit `start()` called from `app.js` instead of starting
   at require time; close the DB in `after()` hooks.
3. Add `src/test/run-all.mjs`: runs each file in its own process with a
   timeout, prints a pass/fail table, exits non-zero on any failure or
   timeout. Point `"test"` in `src/package.json` at it. Give it
   `env -u PADDOCK_TASK_QUEUE` for `mcp.test.js`.
4. Add `src/test/client-parse.test.js`: esbuild with `write: false` (resolved
   through `createRequire(client/package.json)`) over every `.jsx`, so a file
   that stops parsing fails a test.
5. Replace source-text tests where the behaviour is reachable. For each of the
   22 files: if it asserts a fact that a call can check, rewrite it to call
   the function; if it truly pins wiring that cannot be run (a route's
   middleware order, an argv passed to docker), keep it and add a one-line
   comment saying why. Record the before/after count here.

**Done when:** `docker exec paddock npm test` exits 0 in under 10 minutes,
twice in a row.

---

## Phase 5 — Split `app.js` routes

**Goal:** `app.js` holds boot, middleware, the terminal WebSocket and timers.
Routes live in routers.

**Layout** (`src/routes/`): `mission.js` (49 routes), `runners.js`,
`agents.js`, `agent-web.js`, `settings.js`, `vault.js`, `tasks.js`,
`session.js`. Each exports `function (deps) → express.Router()`; `deps`
carries the few shared helpers so a router never requires `app.js`. Remove
the dead EJS `routes/agents.js` first.

**Steps**

1. Guard first: `src/test/route-table.test.js` boots the app on an ephemeral
   port with `PAD_DB_PATH`, walks `app._router.stack`, and asserts the sorted
   list of `METHOD path` equals a literal captured before the move (158
   entries).
2. Move one router per commit-sized step; run the route-table test and that
   area's suites after each.
3. Middleware order is part of behaviour: mount each router at the position
   its first route occupied.

**Browser assertions:** load every top-level page (dashboard, agent detail
with each tab, Mission, Configs, Vault, Profile); no 404 in the network log,
no console errors.

**Done when:** `app.js` is under 1200 lines and the route table is unchanged.

---

## Phase 6 — Turn `AGENTS.md` lessons into tools

**Goal:** the mistakes recorded as prose become things that cannot happen.

| Lesson in `AGENTS.md` | Tool |
|---|---|
| Mutation control must run in a copy | `scripts/mutate.sh <file> <sed-expr> <test-file>`: copies to `/tmp`, verifies the mutant is in the copy and absent from the original, runs the test, reports red/green, cleans up |
| Test the staged tree, not the worktree | `scripts/test-staged.sh <test-file…>`: `git checkout-index` to `/tmp`, link `node_modules`, run |
| JSX missing import / free variable builds fine | ESLint `no-undef` + `react/jsx-no-undef` over `src/client/src`, run by `npm test` |
| Free variable in plain JS | ESLint `no-undef` over `src/services`, `src/*.js` |
| Colour utility not in `@theme` is dropped silently | `src/test/tailwind-tokens.test.js`: every `bg-/text-/border-<token>` used in JSX exists in `index.css` `@theme` |
| MCP tools must use the `registerTool` wrapper | test asserting no direct `server.tool(` / `server.registerTool(` outside the wrapper |
| Malformed SVG path kills an icon | test running each `d=` string through a path parser |

After each tool lands, cut the matching entry in `AGENTS.md` down to two
lines: the rule and the command. Target: `AGENTS.md` under 400 lines, with the
how-it-works material moved to `docs/reference/`.

**Done when:** each tool has been seen to fail on a deliberately broken input
(recorded in this file) and `npm test` runs the lint and token checks.

---

## Phase 7 — Stop tracking `src/public`

**Goal:** the browser can only ever run a bundle built from the code on disk.

**Steps**

1. Boot check in `app.js`: compare the newest mtime under `src/client/src`
   with a `build-stamp.json` written by the Vite build into `src/public`. If
   the bundle is missing or older, log one loud line and serve a plain page
   saying "client bundle is stale — run `npm run build` in `src/client`"
   instead of the old bundle.
2. `git rm -r --cached src/public`, add it to `.gitignore`.
3. Dockerfile for the webui image: build the client in a build stage and copy
   it to `/app/public` so a fresh clone works with no host Node. The dev
   bind-mount keeps overriding it, which is why step 1 exists.
4. Update `docs/reference/operations/overview.md` and the workflow commands
   in `AGENTS.md`.

**Check with the user before step 2** — it changes how a fresh checkout is
brought up, and they may deploy by `git pull` + restart.

**Done when:** a fresh clone + `docker compose up -d --build` serves the app,
and editing a `.jsx` without rebuilding shows the stale-bundle page.

---

## Out of scope

- `vm-manager.js` (5002 lines) and `mcp.js` (2999 lines). Same treatment
  applies, but they are not where current bugs come from. Follow-up plan once
  Phases 1–5 hold.
- codex / claude runner workers (no auto-wiring or ready gate yet). Phase 1
  and 3 make that easier; it is its own plan.
- Any visual redesign.

## Risks

- **Phase 3 double dispatch.** Mitigated by the existing compare-and-swap; the
  "tick and fast path together" test is the proof and must not be skipped.
- **Phases 2 and 5 are large diffs.** One file per step, export/route-table
  guard written first, no behaviour edits mixed in.
- **Phase 1 wording drift.** Strings move from client to server; the
  table-driven test is the single place they are pinned.
