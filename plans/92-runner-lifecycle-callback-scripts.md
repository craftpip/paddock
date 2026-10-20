# 92 — Runner lifecycle callback scripts

## Status: Complete (2026-10-13) — all 5 phases done. Phases 1–4 as before (rw socket proven, outbox + bounded executor + init/destroy triggers, queue start/completion observation with attempt identity, usage-exhaustion detector per plan 75 row 8 — built, unit-tested and live-proven). Phase 5 browser end-to-end verification complete 2026-10-13: storage round-trip, real plan_started/plan_completed execution (ok and error/exit-3) with result panel, in-container execution, both themes, 390px, focus/Escape, clean console/network, controlled runner, 11 projects unchanged. Three real UI defects found and fixed during Phase 5 (dead Save button outside the form; plan 91 preview effect clearing its own timer; callback tab warning glyph). Tests: runner-callbacks 31/31, runner-turn 9/9. Absorption into docs pending the existing review hold.

## Goal and dependencies

Run optional user-configured system-shell scripts on usage exhaustion, plan start,
plan completion, runner init and runner destroy. Store script bodies as persistent
Paddock application data, not source code or worker prompts.

Implement after [90 — reliable idle-only dispatch](90-runner-duplicate-continuation-dispatch.md)
and [91 — prompt setup and reusable dialog](91-runner-prompt-templates-and-idle-gating.md).
Reuse their event/operation identity and dialog primitives, not a parallel scheduler.
See [the grouped implementation order](archive/94-runner-and-navigation-plan-groups.md).

## User journey

Open runner setup → Callbacks. Select one of five events, enable it, edit its
multiline shell script and save. Disabled scripts retain their text. Empty enabled
scripts fail validation. Saving or previewing never executes a script.

Show each event's meaning, execution environment, cwd, timeout and available event
environment variables next to the editor. Show recent executions with status,
timestamps, exit code and bounded stdout/stderr. Script failures are visible without
blocking Pause or sending another LLM prompt. On narrow screens stack help/results
below the editor; keep the large dialog footer accessible in both themes.

## Execution location — needs the user's call

Scripts run in a system shell, outside the LLM conversation. They must never be
typed into a worker's terminal, interpreted as a prompt or run inside an agent PAD
by default. Clarify whether "system terminal" means the Docker host shell or the
Paddock control-plane container shell before implementing execution. Those environments
have different paths and commands. Do not silently substitute one for the other.
The UI must display the resolved environment and cwd.

## Events and precise triggers

| Event key | Trigger |
|---|---|
| `init` | Successful creation of a runner after configuration/scripts are persisted; not opening setup, Run, resume or webui restart |
| `plan_started` | A queued item first transitions into `in progress`; first and next items, not each continuation or resume of the same attempt |
| `plan_completed` | An item is observed transitioning to valid `done` under the queue completion contract; not assistant turn end or delivery receipt |
| `usage_exhausted` | Evidence-backed provider usage exhaustion for the exact conversation; once per exhaustion episode, not every poll/transient rate limit |
| `destroy` | Explicit removal of runner configuration/designation using saved script/context; not Pause, worker exit, terminal Close or webui shutdown |

`init`/`destroy` are runner-record lifecycle events; label this meaning in setup.
Usage detection follows plan 75: silence, empty replies, unreadable state, 429 or
an error name alone cannot prove exhaustion. Preserve the actual evidence. Unknown
state withholds this callback and reports uncertainty. A new episode requires measured
recovery followed by a new confirmed exhaustion.

Use stable queue-item/attempt identity, not plan path alone. Explicit requeue for
a new execution may emit new start/completion events; continuing the same attempt
or restarting supervision cannot. Persist queue observations by item identity.
The first observation of an existing runner establishes a baseline without replaying
historical events; new runner creation uses the current queue as its baseline too.

A snapshot cannot reconstruct transitions that both started and ended between
polls. Instrument existing queue mutation operations with durable transition events
where possible; for direct external edits, emit only transitions actually observed
and document that limitation. Never invent a start event just to fill an unseen gap.
Completion means an observed valid queue transition, not independent proof of work;
keep existing done/verification rules without a new LLM confirmation round.

## Storage and API

Files: `src/services/db.js`, runner create/update/read and lifecycle in `mission.js`,
runner routes in `src/app.js`, `src/client/src/stores/mission.js`, `RunnerDialog.jsx`,
new `src/services/runner-callbacks.js` or an equivalent existing executor service.
Check current route/schema names and plan 88/90 work before editing.

- Store runtime script files in the persistent Paddock data mount, proposed
  `src/data/runner-callbacks/<runner-id>/<event-key>.sh` (webui:
  `/app/data/runner-callbacks/...`). Confirm the actual data mount. Keep this data
  ignored by Git and outside services/source, plans, client bundles and PAD workspaces.
- Database stores enable flags, script revision/hash and execution settings. Authorized
  settings APIs load/save scripts by validated runner ID and allowlisted event key;
  callers cannot choose arbitrary files. Omitted callback settings preserve saved values.
- Save atomically with normal Paddock ownership handling. Enforce 64KiB UTF-8 per script,
  surface storage failures honestly, and ensure a script revision only becomes active
  after both its file and associated metadata are durably saved.
- Existing runners receive disabled callbacks through an idempotent migration;
  their prompts/running state stay intact. Saved scripts survive restarts.
- Before destroy, capture a durable script snapshot/context. Preserve history and
  script data after runner removal. Callback history must not depend on a foreign key
  to a row that destroy deletes. Do not add operational-data deletion to this feature.

## Execution and event ownership

Use the selected environment's shell with a script file argument, never interpolated
shell commands. No template expansion of script bodies. Provide event values through
environment variables, with an allowlisted base environment instead of inheriting
unrelated Paddock credentials:

```text
PADDOCK_EVENT_ID, PADDOCK_EVENT, PADDOCK_EVENT_AT
PADDOCK_RUNNER_ID, PADDOCK_RUNNER_NAME, PADDOCK_PROJECT_ID
PADDOCK_PROJECT_NAME, PADDOCK_AGENT_NAME, PADDOCK_SESSION_ID
PADDOCK_ITEM_ID, PADDOCK_ITEM_ATTEMPT, PADDOCK_PLAN_PATH
PADDOCK_QUEUE_PATH, PADDOCK_USAGE_REASON
```

Document path namespaces: a worker-container plan path may be inaccessible in the
system shell. Keep cwd/environment explicit. Audit metadata only, not script bodies.

- Persist event/outbox records transactionally with lifecycle and controlled queue
  writes, and with persisted observation updates for externally edited queues.
  Deduplicate with a unique runner/event/item-attempt or exhaustion-episode key.
- Snapshot the script revision when recording the event. Settings edits cannot change
  an already recorded event. Acquire atomic ownership before process launch.
- Run asynchronously, serially per runner, with bounded fleet concurrency. Slow
  scripts cannot hold up supervision/Pause/settings. Do not automatically retry a script
  that may have caused side effects. A crash after launch yields an honest unknown
  result and read-only reconciliation, not a second execution.
- Configurable timeout: default 60 seconds. Stop the owned process group on timeout.
  Capture start/end, exit code and up to 64KiB per stdout/stderr stream; mark truncation.
  Failed/timed-out/unknown results do not undo transitions or generate repeat prompts.
- Owner-scoped results clearly show output is user-script output and may contain whatever
  the script prints. Use existing redaction where supported; no automatic cleanup added.
- Callback exit codes do not mark plans done, reset exhaustion, resume supervision
  or bypass idle/pause gates. Explicit actions performed by a user's script remain
  that script's own behavior; callbacks themselves are event actions, not scheduler verdicts.

## Implementation order and progress

- [x] Phase 1 complete 2026-10-12 — execution location framed as an explicit
  question (see "Pending decision"); all other contracts inventoried, no code
  touched.
  - Rechecked 88/90/91: durable identity to reuse is `operation_id` /
    `operation_generation` + `operation_receipt_user_id` (exact input hash),
    `run_generation` (Pause/Close invalidation), and the persisted scheduler
    truth (`worker_state`, `idle_since`, `last_progress_at`). No parallel
    scheduler will be built; callbacks key off these plus queue observations.
  - Queue mutation ops: `plans.writeQueue` (CAS + atomic + prose-preserving;
    used by `updateRunnerQueue` and the MCP plan tool) and `ensureQueue`
    (create-only) are the ONLY instrumentable writers. Workers edit QUEUE.md
    directly with their own tools — those writes bypass every gate, so
    plan_started/completed for worker-driven transitions can only be OBSERVED
    by diffing consecutive reads by stable item `id`, never instrumented.
    Snapshot gaps (start+end between polls) are unobservable by construction.
  - Attempt identity: items carry stable unique `id`s but there is NO attempt
    concept today. Explicit requeue (back to `new` after progress) needs one:
    candidate is a per-(runner,item) attempt counter advanced on requeue, or a
    hash of (item id + revision at the in-progress transition). Deferred to
    Phase 3 design; Phase 2 storage must leave room for it.
  - Usage-exhaustion evidence (plan 75, measured rule): `failed = newest
    message is user AND not busy AND tokens_output == 0` (with the busy
    disambiguator — a thinking worker also ends in `user`). Gap: `usage_exhausted`
    exists only as a `RUNNER_HEALTH_STATES` word — NO detector sets it, and
    `tokens_output` is read nowhere in `agent-store.js`/`mission.js`. Phase 3
    must add a store reader for the rule; 429/`FreeUsageLimitError`/silence alone
    stay non-proving per plan 75's controls.
  - Data mount confirmed: `./src:/app:rw` bind — `src/data/` persists with the
    project (same as `app.db`). `src/data/runner-callbacks/` will persist, but
    needs its own `.gitignore` line: today only `app.db*`, bot-prefixes and
    credentials are ignored (the `runner90/91-verification-*` dirs show as
    untracked). Outbox precedent: `activity_events` (+ `audit()`, metadata-only)
    is the established durable-event table shape.
  - Executor options: container-shell execution has precedent (`cmd.js`
    spawn wrapper; `execFile`+timeout in container-health/log-store/net-peer,
    with the spawn-vs-execFile stdin warning in AGENTS.md). Docker-host shell
    has NO mechanism: the webui's docker.sock mount is `:ro`, so host-side
    `docker exec` is unavailable from this codebase. A host-shell choice needs
    a new privileged channel, not a flag flip.
  - UI foundation ready: plan 91's `SettingsDialog` takes a `sections` array —
    Callbacks slots in as a third tab with zero shell changes; `Field`/`Switch`/
    `Textarea`/`Badge` cover the editor; `msn-*` hooks required on all new
    elements.
- [x] Phase 2 complete 2026-10-12 — script data storage, migration and
  owner-scoped settings/result APIs. No executor: saving/reading creates zero
  executions (pinned by test).
  - `src/services/runner-callbacks.js` (new): allowlisted event keys (path
    traversal impossible by construction — paths are built only from the
    allowlist + server-minted runner id), 64KiB cap, empty-when-enabled
    refusal, disabled scripts retain text, atomic file+row save (tmp+rename,
    `ensureOwned`, row is the activation record), absent row/file reads as
    disabled, catalogue (meanings, 14 env vars, limits).
  - `db.js`: `runner_callbacks` ((runner_id, event) PK) and
    `runner_callback_history` (plain-text identity, deliberately NO FK to
    `infinite_runners` so history survives destroy); `src/data/runner-callbacks/`
    added to `.gitignore` (dir persists via the existing `./src:/app:rw` bind).
  - Routes behind the existing runner gate: `GET/PUT /:id/callbacks` (partial
    saves preserve omitted events), `GET /:id/callbacks/history`,
    `GET /projects/:id/callbacks/history?runnerId=` (post-destroy owner path —
    does not require the deleted runner row).
  - `src/test/runner-callbacks.test.js` 9/9 (round-trip all five, partial
    preservation, retained-text, six rejection codes, traversal creates
    nothing, restart survival, zero-execution, history/outlives-removal,
    unscoped refusal). Two defects caught proving it (both fixed): the history
    owner path still required the deleted row, and sync wrappers need
    `assert.throws` (test bugs).
  - Regression green (each run individually): db-migration 12/12, mission
    128/128, infinite-runner 33/33, mcp 141/141. Webui restarted; live
    round-trip on the finished proof runner (read all-off, save disabled init
    script with revision hash, history empty) — that disabled script is inert
    (no executor) and stays as evidence.
- [x] Phase 3 — Add durable transitions/outbox, deduplication, snapshots and bounded executor.
  - [x] Executor core + init/destroy triggers done 2026-10-12:
    - Socket remount (`docker.sock:ro` → `:rw`, privilege recorded in
      `docker-compose.yml` + plan): webui recreated, mutating proof from
      inside (`network create/rm paddock-proof-92`, throwaway removed).
    - `runner_callback_outbox` (UNIQUE dedup_key, rows never deleted) +
      `cwd` on history; `spawn('sh')` with snapshot tempfile, allowlisted env
      + `PADDOCK_*` contract, 60s process-group kill, 64KiB stream caps,
      crash→`unknown` boot reconcile (pending stays pending), serial per
      runner + fleet cap 4, pump on record-destroy/record-init + 20s tick.
    - Triggers: init via first-observation baseline for ALL runners (save
      stays sterile — the Phase-2 zero-execution test still passes);
      destroy via snapshot-before-delete in `removeRunner` (never blocks
      removal; withdraws the pending row if the delete fails).
    - `runner-callbacks.test.js` 22/22 (ok/error/timeout/truncation/env
      allowlist/cwd/claim-race/serial/fleet-gate/reconcile/dedup/baseline/
      destroy-snapshot). Three test bugs + one real template-literal bug
      (backticks in a SQL comment) caught proving it. Regression:
      db-migration 12, mission 128, infinite-runner 33, mcp 141 — green.
    - LIVE destroy proof (throwaway project `prj_462cc65eec74e605`, kept as
      the history anchor): runner removed → destroy ran async → history
      `ok`, exit 0, stdout carried the exact runner id + event; marker file
      created in the container (side effects work); history readable by
      project scope after the row was gone. Marker cleaned up.
  - [x] Plan started/completed observation + usage-exhaustion detector + attempt identity (done 2026-10-12):
    - Queue-transition observer: `runner_queue_observations` (PK `runner_id,item_id`);
      first sight = baseline (no replay); `attempt`++ on each observed entry to
      `in progress`; `in progress→done` emits `plan_completed`; requeue
      (`in progress→new→in progress`) earns a new attempt and a fresh
      `plan_started`; start+end between polls = completion-only (no fabricated
      start); observation advances even while a callback is disabled. Recorded via
      `recordTransition`; wired into `observeRunnerQueues` → the 20s tick.
    - Usage-exhaustion detector (plan 75 row 8, measured): new
      `agent-store.readUsageEvidence(agent, sessionId)` is TRI-STATE
      (`ok`/`exhausted`/`unknown`) — exhausted iff newest message overall is an
      unanswered `user` AND the last assistant's `tokens.output` is a finite 0
      (or no assistant); an unreadable token field or unsupported driver is
      `unknown`, never folded into exhausted. New `runner_usage_state` episode
      store (PK `runner_id`, `episode_seq`/`state`/`reason`/`evidence`) and
      `observeUsage(runner, project, evidence, {busy,busyKnown})`: a confirmed
      exhaustion (`exhausted` AND a busy probe that answered NOT busy) records
      `usage_exhausted` ONCE per episode (`episodeKey` = seq); a live turn arms
      nothing; an unreadable store OR unanswerable busy probe WITHHOLDS and never
      clears an armed episode; only a measured `ok` clears and re-arms the seq so
      a later exhaustion is a new episode. `mission.observeRunnerUsage()` wires it
      for every runner with a bound session (own store + the same `busyForSessions`
      probe the Mission lists use) into the 20s tick.
    - Tests: `runner-turn.test.js` 9/9 (adds 6 usage-evidence cases, incl. the
      captured failing shape `[user, assistant(out=0), user]` → exhausted vs the
      healthy control out=669 → ok, and the unreadable-token → unknown refusal);
      `runner-callbacks.test.js` 31/31 (adds 6 usage-episode cases: confirm-once,
      same-episode no-repeat, live-turn no-arm, withhold-never-arms,
      recovery-rearms-then-new-episode, disabled-still-advances). Regression
      green (individually): db-migration 12, mission 128, infinite-runner 33,
      mcp 141 (`env -u PADDOCK_TASK_QUEUE`).
    - LIVE proof: `readUsageEvidence` reproduced the captured failing session
      `ses_f12b8a757ffeyOtFZyNoZiTYRw` as `exhausted` (assistant out=0) and the
      healthy control as `ok` (out=669). After restart the 20s tick ran
      `observeRunnerUsage` live and wrote 6 `runner_usage_state` rows from 6 real
      runner conversations (7 runners, 1 unbound) — all `clear` with real reasons.
- [x] Phase 4 implemented 2026-10-12 — Callbacks editor/results in plan 91's
  reusable setup dialog (third `SettingsDialog` tab, zero shell changes).
  Saving still never executes (no executor).
  - `CallbackScriptEditor.jsx` (new, pure) + `CallbackKindTabs`: per-event
    enable switch, meaning text, mono shell editor (plain text — no template
    expansion, no prompt preview), collapsible env-var list, latest-run result
    block (status/exit/timestamps/bounded stdout-stderr + truncation +
    owner-scoped-output note).
  - `RunnerDialog.jsx`: Callbacks section with the undecided-execution notice
    (shell/cwd honestly unclaimed — no invented environment), five event tabs
    with ⚠/• markers, client-side enabled-needs-script validation disabling
    Save, dirty tracking folded into the shared dirty-close confirm, partial
    save of changed events only, half-saved dialog stays open with the exact
    error pinned to its event.
  - Store: `getRunnerCallbacks`, `saveRunnerCallbacks`,
    `getRunnerCallbackHistory`, `getProjectCallbackCatalogue` (create dialog
    gets catalogue with no runner via the new project route).
  - Verified: client builds clean; all `msn-callback-*` / `msn-runner-callbacks`
    hooks in the served bundle; callbacks suite 9/9; webui restarted; project
    catalogue + runner callbacks routes live-verified. Two build-breaking
    mistakes caught by the build (bracket mismatch, a dropped line — both
    repaired, build green).
  - Gap (needs the location call): per-event execution environment, cwd and
    timeout lines are not shown — they cannot be truthfully stated until the
    shell is chosen.
- [x] Phase 5 complete 2026-10-13 — browser end-to-end verification, all checks green.
  - Storage round-trip proven by the user's own UI flow on `run_9e972939037a6168`
    (`usage_exhausted`): type script + enable → Save → reopen shows script and
    `enabled:true`, tabs clean, no warning; revert → disabled + empty persists.
    Captured `PATCH /api/mission/runners/:id` + `PUT .../callbacks` on save.
  - Real execution proven on the controlled runner `run_b9d0bedd159b8c6c`:
    flipped a controlled `QUEUE.md` item `done`→`in progress` → the observer fired
    `plan_started` (history: `ok`, exit 0, stdout carried `PADDOCK_ITEM_ID` /
    `PADDOCK_ITEM_ATTEMPT`, stderr separate); flipped back → `plan_completed` with
    `exit 3` (history: `error`, stdout+stderr captured). The dialog's result panel
    rendered both — `Most recent run — ok (exit 0)` and `— error (exit 3)` — with
    stdout pane `text-ink` and stderr pane `text-danger`.
  - In-container execution confirmed: the script wrote `/tmp/msn92-plan-started-proof`
    INSIDE the paddock control-plane container (content matched), matching the
    resolved execution location; marker + callback rows then reverted.
  - Tokens verified in BOTH themes: dark stdout `rgb(241,231,207)`, stderr
    `rgb(248,113,113)`; light stdout `rgb(42,29,14)`, stderr `rgb(220,38,38)`.
  - 390px (`Emulation.setDeviceMetricsOverride` 390×844): no horizontal overflow
    (body 390, dialog 358, tabs Settings/Prompts/Callbacks intact).
  - Focus/footer: panel auto-focused on open; Escape closes; backdrop mousedown closes.
  - Console + network: only the pre-existing stale-session 404
    (`GET /api/mission/sessions/msn_baca0d709c176cbe`, polled ~15s) — nothing from the
    dialog or callbacks endpoints.
  - Controlled runners used throughout (never the user's live queue); Mission project
    count unchanged at 11 afterwards.
  - Defects found and fixed DURING Phase 5 (would not have surfaced otherwise):
    (a) Save was dead for every runner — the submit button lives in the dialog
    `footer`, rendered OUTSIDE `SettingsDialog`'s form; fixed with a `form=`/`id=`
    link. (b) plan 91's prompt auto-preview effect cleared its own 400ms timer
    (`previews` in its own deps), so preview never POSTed and Save stayed disabled;
    fixed by reading refs and trimming deps. (c) `CallbackScriptEditor` tab warning
    glyph used `errors[k] ? ' ⚠' : ''` (empty array truthy → every tab warned).

## Pending decision (for the human — execution location)

**RESOLVED 2026-10-12: inside the Paddock control-plane container.** Outside
communication (restarting containers, rotating IP, network changes, anything
beyond the container) is the script's own job — the platform hands the script
a shell, nothing more.
**Script language: POSIX shell.** Scripts are stored as `<event>.sh` and run
with the system shell (`sh <file>`); write them `sh`-compatible (`bash` also
exists in the image, but the runner invokes `sh`, so a bash shebang alone
does not buy bash).
**Follow-through required:** the webui's docker socket is mounted read-only
(`docker.sock:ro`), so container restart / network / IP changes from a script
fail today. Phase 3 prerequisites: remount the socket read-write in
`docker-compose.yml` and recreate the webui (brief control-plane restart),
then the executor. That remount is a privilege escalation (rw socket ≈ host
root) — recorded here deliberately, not slipped into a compose edit.

Original question (kept for the record): **Where must a lifecycle callback
script's system shell run: the Docker HOST shell, or the Paddock control-plane
container shell?**

**Command scope, clarified 2026-10-12:** scripts may call ANY command available
in the container — no command allowlist (e.g. curl a URL). Verified present in
the image: `curl`, `node`, `python3`, `docker` CLI, `sh`/`bash`. Network egress
for URL calls to be proven in Phase 5. Env allowlist still applies to what the
platform INJECTS (no unrelated Paddock credentials leak in); it never restricts
what the script itself invokes.

## Verification

Run isolated suites individually with throwaway databases. Use harmless scripts
writing event IDs/context into a dedicated test-data directory in the chosen environment.

- Save/reopen all five scripts and enable flags, restart and prove data survives outside
  tracked code. Preview/Save causes zero execution. Invalid/unauthorized/path traversal fails.
- Actually execute each event: init/destroy once per lifecycle, first/next plan start
  once per attempt, no start on resume/continuation, valid completion once, explicit requeue
  gets a new attempt. Concurrent ticks/restart do not duplicate or replay old queue events.
- Unknown/429/transient limits emit no exhaustion callback; confirmed exhaustion emits
  once per episode, and measured recovery permits a later distinct episode.
- Record a direct-edit observation gap honestly; controlled mutations preserve their
  durable events even when multiple transitions occur between watcher polls.
- Quoted/Unicode values remain data. Event snapshots survive edits and runner removal.
  Nonzero exit, timeout/process-group termination, truncated output and crash uncertainty
  are visible. No automatic replay of an uncertain execution.
- Slow/failed scripts leave supervision/Pause responsive and generate no extra LLM input.
  Destroy results remain accessible only to the owner; preserve script/history files.
- Browser desktop/390px, light/dark: select/edit/disable/save/reopen scripts, inspect real
  event output and errors. Check footer/focus behavior, console and failed requests.
  Use controlled runners, not the user's live queue; count Mission projects afterwards.

Update status/checklist before leaving work. Absorption into docs remains subject
to the existing review hold. This plan is queued in QUEUE.md by user request.
