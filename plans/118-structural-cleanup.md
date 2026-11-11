# Plan 118 — Structural cleanup: one runner view, split files, instant dispatch

## Status: In progress — 2026-11-11 — 6/7 phases done, Phase 7 half done. Open: untracking `src/public` (Phase 7 steps 2–3, needs the user's go-ahead), the `AGENTS.md` trim and the SVG check (Phase 6, deliberately not done)

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
| Test files that read source text instead of running code | 4 of 63 (24 reads). First written here as "22 of 63": that count came from a loose grep and was wrong |
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
- [x] Phase 2 — Split `mission.js` (2026-11-11, see "Phase 2 — as built")
- [x] Phase 3 — Dispatch the next plan when the worker reports done (2026-11-11, see "Phase 3 — as built")
- [x] Phase 4 — One test command that finishes (2026-11-11, see "Phase 4 — as built")
- [x] Phase 5 — Split `app.js` routes (2026-11-11, see "Phase 5 — as built")
- [x] Phase 6 — Turn `AGENTS.md` lessons into tools (2026-11-11; the `AGENTS.md` trim and the SVG check were NOT done, see "Phase 6 — as built")
- [ ] Phase 7 — Stop tracking `src/public` (the stale-bundle guard is built, as a test; untracking waits for the user)

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

### Phase 2 — as built

- 4676-line `mission.js` → 12 modules + `index.js` in `services/mission/`,
  largest 685 lines. `mission.js` itself is deleted: `require('./mission')`
  resolves to the directory's index, so no facade file is needed.
- The move was done by a script over the syntax tree (scope-resolved
  references), not by hand: every function body is byte-identical to before.
- Session code is two files, not one (`session-lifecycle.js`, `session-io.js`),
  and prompts/callback config got its own (`runner-prompts.js`), to stay under
  the size limit.
- The modules are cyclic. Each exports its hoisted functions before requiring
  siblings; cross-module constants live in `errors.js` / `internal.js`. Making
  the graph acyclic means changing behaviour (sessions should not know about
  runners) and is left for a later plan.
- `mission-exports.test.js` (4): same 107 exports in the same order, each
  module loaded first in its own process, every identifier bound, 900-line cap.
  Mutation control (drop one import in a `/tmp` copy): the file still passes
  `node --check` and exactly the binding test goes red.
- Suites after the move, counts unchanged: mission 129, mcp 141, queue 49,
  runner-canonical-queue 27, runner-callbacks 42, runner-state-sequence 34,
  plan-mcp 56, task-pipeline 22, plus 20 smaller ones.
- Browser: a running queue finished across the restart onto the split code
  (13/13, Complete); new session started, a sent line was answered, session
  closed with its confirm; console clean.

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

### Phase 3 — as built

- No new send path. The decision changed in one place
  (`computeSchedulerState`): when the plan the last instruction assigned is
  `done` and the turn has ended, dispatch without the idle grace or nudge
  interval. Both timers still gate a worker that went quiet without reporting.
- `kickRunnerWatch` (fast watch) is started by the worker's `done`: it polls
  the worker's turn in the agent store every 750 ms for up to 90 s and runs an
  ordinary `runnerWatchOnce` pass when the turn is idle. Completion needs no
  special case: the pass already applies `complete` when every plan is done.
- The 2-second "wait for the pane to be ready" step in the design was dropped:
  the pass already checks the pane, permission prompts and the send verdict.
- `watchRunner` keeps passes for one runner from overlapping; a pass that
  loses the dispatch compare-and-swap returns quietly.
- Found by the tests, fixed: a report for the next plan was dropped while the
  previous plan's fast watch was still winding down (now one loop per runner
  generation); and plans could not be appended between two plans, when the
  queue runs with no operation outstanding.
- The page re-reads a running queue every 3 s (was the 15 s page poll).
  Configure explains that the two timers are for a quiet worker only.
- Tests: 7 new in `runner-dispatch-invariants.test.js` (20 total), stable over
  three runs. Controls in `/tmp/mut`: removing the assigned-done rule reds the
  two dispatch tests; removing the kick reds the two fast-watch tests.
- Live, default 120 s timers on `devrunner`: three plans in 97 s end to end
  (would have been over four minutes). `done` 12:44:49.5 → turn ended
  12:44:52.038 → `dispatch_next` 12:44:52.041. `complete` shared the last
  turn-end timestamp.
- Not measured: the page's lag with the 3 s refresh over a full run. The
  check run hit OpenCode's free-usage limit on its first plan (captured in
  plan 75; that capture found and fixed a blind spot in the quota detector).

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

### Phase 4 — as built

- The hang was never a leaked handle in one suite. Every file exits on its own
  when it has a process to itself: 63 files, 1170 tests, 89 seconds, none
  hung. What hangs is `node --test test/` sharing one process between suites
  that each set `PAD_DB_PATH`/`WORKSPACE_ROOT` and replace module functions.
  So steps 1–2 (find and fix the leak) had nothing to fix.
- `src/test/run-all.mjs` + `"test": "node test/run-all.mjs"`:
  `docker exec paddock npm test`. A file that outlives the timeout is killed,
  reported `HUNG` and fails the run.
- The client parse and unbound-reference checks already existed in
  `client-navigation-parse.test.js` but covered 22 hand-listed files. They now
  walk all 73. No real unbound reference was found; only browser globals were
  missing from the allow-list.
- Source-text tests were **not** rewritten. There are 24 such reads in 4 files
  (not the 22 files the plan first claimed). Each pins wiring that needs a
  container to run for real (an argument passed to docker, a resolved name
  reaching the action), and each is documented as deliberate. Left as they are.

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

### Phase 5 — as built

- `app.js` 4161 → 1188 lines. 157 API routes moved to nine files in
  `src/routes/`: `auth`, `agents`, `agent-settings`, `agent-workspace`,
  `agent-integrations`, `system`, `mission`, `mission-runners`, `vault`
  (largest 519 lines). The page catch-all, middleware, timers and the terminal
  WebSocket stay in `app.js`.
- Shape: each file exports `register(app, ctx)` and keeps the original
  `app.get(...)` calls, rather than an `express.Router()` per area. A router
  would have needed every path rewritten; this way the handlers are moved
  byte-for-byte (scripted over the syntax tree, as in Phase 2).
- A helper used by one area moved with it (26 moved). A helper used by several
  areas, or one that reads or writes a reassignable top-level variable
  (`dockerCache`, `envCache`), stays in `app.js` and is handed over in `ctx`:
  a `let` passed to another module would be a stale copy.
- The dead EJS `routes/agents.js` is gone (replaced by the new file of that name).
- Guard is static, not a booted app: requiring `app.js` starts the server.
  `route-table.test.js` (5) reads the table by following the registrations:
  same 158 routes, no duplicate, every overlapping pair in its original order
  (only the catch-all overlaps anything, and it is still last), no unbound
  name in `app.js` or any route file, and each `ctx` matches what its file
  destructures.
- Live: all 72 GET routes called against `pad-dev` and `devrunner` (61 × 200,
  the rest ordinary validation replies, nothing in the server log); every page
  and agent tab loaded with no failed request; terminal attached.
- `npm test`: 64 files, 1175 tests.

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

### Phase 6 — as built

| Lesson | Tool | Seen to fail on a broken input |
|---|---|---|
| Mutation control must run in a copy | `scripts/mutate.sh` | all four outcomes exercised: bites (0), does not bite (1), expression matched nothing (2), mutant does not parse (2) |
| Test the staged tree | `scripts/test-staged.sh` | ran three suites against the index |
| Free variable in plain JS | `source-hygiene.test.js`: every identifier in every backend file resolves to a binding | dropping one import → red |
| JSX missing import / free variable | `client-navigation-parse.test.js` now walks all 73 client files | (Phase 4) |
| MCP tools must use the wrapper | `source-hygiene.test.js`: exactly one direct SDK registration, inside the wrapper | one direct `server.registerTool(` → red |
| Colour utility not in `@theme` | `source-hygiene.test.js`: every colour-shaped class names a token | `bg-ok text-warn` in a copy → red, naming both |

- ESLint was not added. The binding checks use `@babel/parser`, which the
  client already installs, so there is no new dependency and nothing to
  configure.
- **Not done: the SVG path check.** `AGENTS.md` records two hand-written path
  validators that were both wrong; a third without a real path grammar would
  repeat that. The browser console remains the oracle.
- **Not done: cutting `AGENTS.md` to 400 lines.** It is 1300+ lines of the
  project's recorded lessons and other agents read it as their instructions.
  Only a short tools section was added. Shrinking it means deciding which
  lessons to drop or move, and that is the owner's call.

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

### Phase 7 — as built so far

- The guard is a **test**, not a boot check that replaces the page. A boot
  check would have to compare times, and a git checkout rewrites file times
  in no useful order, so it would lock the page on a healthy tree. Instead the
  build writes a content hash of its inputs to `src/public/build-stamp.json`
  and `client-bundle-fresh.test.js` recomputes it (2 tests, in `npm test`).
  Control: a comment appended to `App.jsx` in a copy, no rebuild → red.
- With that test, the reason to untrack `src/public` is weaker: a bundle that
  does not match its source can no longer be committed unnoticed, as long as
  `npm test` or `scripts/test-staged.sh` is run.
- **Not done, waiting for the user:** `git rm --cached src/public`, building
  the client in the image, and the fresh-clone check. It changes how a
  checkout is brought up.

## Out of scope

- `mcp.js` (2999 lines). Its bulk is one 1880-line function registering 46
  tools, and 13 tests read its source; it needs its own plan.
- `vm-manager.js` was done as a follow-up on 2026-11-11: 5002 lines → 12
  modules + index in `services/vm-manager/` (largest 802), by the same script
  as Phase 2. Guard: `vm-manager-exports.test.js` (4). Tests that re-read the
  environment now evict the whole directory (`test/helpers/evict.js`). Live:
  a throwaway PAD was created, given an extra port (prepare/apply/recreate),
  stopped, started and deleted through the app, leaving no container,
  network, image or directory.
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
