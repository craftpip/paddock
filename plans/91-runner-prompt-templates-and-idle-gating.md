# 91 — Runner prompt templates and reusable setup dialog

## Status: Complete — 2026-10-20 — Phases 1–4 implemented; Phase 5 PARTIAL: automated proofs green plus a live-fire finding that shipped a fix (no-response watchdog). Custom-template live worker proof did NOT complete — the worker never took its startup; evidence preserved, runner paused. Browser proofs still need a browser-capable turn. Idle-only dispatch belongs to plan 90; callbacks belong to plan 92.

## Goal

Let the user edit the prompts the infinite runner sends to the LLM, using
`{{variable}}` templates. Give those editors room in a large, well-arranged setup
dialog, with reusable dialog/editor components. Fix automatic nudges so they never
interrupt a worker that is already working or making progress.

System-shell callback requirements now live in [plan 92](92-runner-lifecycle-callback-scripts.md).
URL/session/popup history lives in [plan 93](93-url-app-state-and-popup-history.md).
See [the grouped implementation order](archive/94-runner-and-navigation-plan-groups.md).

This plan includes the user's idle/progress requirement. Use [plan 90](90-runner-duplicate-continuation-dispatch.md)
for the shared no-spam dispatch implementation and proofs, and [plan 88](88-runner-start-delivery-reconciliation.md)
for delivery receipts. Do not build another competing scheduler or receipt system.
Recheck those plans and the worktree before implementation: both are evolving.

## Findings checked before planning

- The live Configure dialog is 576px wide on a 1920px desktop. It contains Name,
  queue location, six timing/budget fields and recovery controls, but no prompt editor.
- `src/client/src/components/RunnerDialog.jsx` owns a custom `max-w-xl` modal shell
  and submits runner configuration through the Mission store.
- `src/services/mission.js` embeds startup, current-task resume suffix,
  continuation/nudge, recovery and current-task pause messages directly in code.
- `runnerWatchOnce` suppresses dispatch when the latest tool is running, but the
  absence of a running tool is not proof of idle. The LLM can be reasoning,
  streaming or between tools. A queue revision can change during that same turn.
- The watcher currently stamps progress at polling time for a running tool. This
  cannot distinguish new progress from repeatedly observing one unchanged tool.
- Mission text delivery submits each line with Enter. A multiline editor must not
  accidentally send several user turns. Rendering and delivery are separate contracts.
- User-reported symptom: repeated Continue prompts make the worker check
  `QUEUE.paused` again and again while it is already working. Each current Continue
  prompt explicitly requests that check, so duplicate instructions repeatedly divert
  the worker back to the pause marker instead of letting its current work proceed.
  Preserve the legitimate pause-marker check before starting an item; fix the duplicate
  dispatch, rather than removing the check or asking the worker to ignore repeated input.

These code findings explain risk; trace controlled ticks and turn signals before
claiming the exact cause of a particular duplicate nudge, as required by plan 90.

## User journey and layout

1. Open New infinite runner or Configure on an existing runner. Show a large dialog
   titled New infinite runner / Runner: <name>, with Settings and Prompts sections.
2. Settings contains name, project/worker context, resolved queue location and
   grouped timing/recovery controls. Keep Run/Pause in the terminal header.
3. Prompts contains a selector for Start, Resume current task, Continue / idle nudge,
   Recovery and Pause current task. Each has a plain explanation of when it is sent.
4. Select a prompt to edit a generous multiline, monospace textarea. Show available
   variables beside it, with descriptions and Insert controls that insert at the
   caret without replacing the draft. On narrow screens put help below the editor.
5. Show Rendered preview using this runner's real project/container paths and queue
   context; label sample values when a new runner has no worker/current item yet.
   Preview never sends, starts a session or changes queue state.
6. Show inline syntax/unknown-variable errors with the affected prompt and location.
   Save is disabled while invalid; server validation enforces the same rule.
7. Reset this prompt restores its shipped default into the draft. Reset all is a
   deliberate separate action. Both require Save to persist and can be cancelled.
8. Save keeps the runner/session identity and current execution state. Reopen loads
   saved prompts. Cancel leaves saved settings untouched; dirty close/Escape/backdrop
   offers discard or keep editing through the existing confirmation pattern.
9. A running runner uses newly saved templates only for its next eligible dispatch.
   Saving cannot nudge, restart or resend an outstanding instruction.
10. Add a Callbacks section with five event choices, each with an enable switch,
    multiline shell-script editor, event explanation and recent execution result.
    Callbacks are optional and disabled initially. Saving edits never executes them.
    Show where scripts run and their working directory explicitly, plus available
    event environment variables. Use the reusable large dialog/editor layout.

Desktop target: approximately 1000–1100px maximum width, bounded by viewport width
and `90dvh`, with fixed header/footer and a scrollable body. Prompts uses a compact
type selector, editor and help/preview area, rather than five stacked giant fields.
At 390px wide use near-full-screen layout, wrapping controls and one-column content;
no clipped footer, horizontal page scrolling or textarea expanding outside the shell.
Respect existing theme tokens in light/dark modes and normal control scales.

Extract a reusable `SettingsDialog` shell (or extend the existing equivalent after
checking UI primitives): title, labelled content, optional navigation, bounded body,
footer, focus trap, initial focus, Escape, dirty-close handling and focus restoration.
Extract `PromptTemplateEditor`: controlled value/onChange, variable catalogue,
validation, insert-at-caret, preview and reset callback. It knows nothing about
Mission, runners, API calls or sessions. RunnerDialog supplies that domain state.
Keep stable `msn-*` hooks for runner controls and prompt selection/editor/preview.

## Template engine and prompt contract

Use a real template engine with double-brace syntax, not ad-hoc string replacement
or JavaScript evaluation. Prefer a small Mustache engine after checking existing
dependencies. Expose a deliberately limited plain-text interpolation contract:

```text
[Infinite runner {{runner_name}}] Read {{queue_path}} and {{index_path}}.
Continue {{current_plan}} from its saved checkpoint. Check {{paused_path}} first.
```

- Support `{{ variable_name }}` and repeated variables. Reject unknown variables,
  malformed braces and unsupported sections/partials/helpers/triple braces at Save.
  No template execution, filesystem access or recursive rendering of substituted values.
- Render plain text, not HTML: names/paths containing `&`, quotes or `<` must reach
  the terminal unchanged. Validate with the engine's parser and an allowlisted token
  walk; use one shared validation/rendering module for preview and delivery.
- Catalogue: `runner_name`, `project_name`, `project_path`, `plans_path`, `queue_path`,
  `index_path`, `paused_path`, `current_plan`, `current_item_status`, `blocker_reason`.
  Paths are worker-container paths from existing project/path resolvers, never host paths.
- Required context missing at dispatch is an actionable error, not `undefined` in a
  sent prompt. Optional no-current-item/no-blocker values are documented empty strings.
  Preview distinguishes sample context from actual dispatch context.
- Keep five complete, editable defaults matching current one-item-per-turn,
  checkpoint, blocker, pause-marker and verification rules. Resume is a full template,
  not an invisible hardcoded suffix. Inventory every runner-to-LLM send and route it
  through the selected template; do not retain hidden prompt fragments.
- Users may rewrite wording and workflow instructions. Explain that prompt edits
  change LLM instructions; backend queue validation, pause/lock/permission gates,
  dispatch ownership and idle eligibility remain enforced independently of wording.
- Reject empty/whitespace-only prompt values; cap each source and rendered prompt at
  16KiB UTF-8 and the complete template set at 80KiB. Preserve source formatting on save.
- First implementation renders multiline source then normalizes line breaks to
  spaces for ONE logical terminal submission, preserving other text. Preview shows
  the exact submitted text and explains the normalization. If true multiline paste
  replaces this approach, it must be proven as one accepted turn on every supported
  driver first; never pass raw multiline text to the line-by-line writer.

## Persistence and API

Files: `src/services/db.js`, runner create/update/read in `mission.js`, runner routes
in `src/app.js`, `src/client/src/stores/mission.js`, and existing runner MCP adapters
if registered by implementation time. Inspect route/schema names before editing.

- Add nullable `prompt_templates_json` on `infinite_runners` through an idempotent
  migration. NULL means the shipped default set; do not rewrite existing runner rows.
- API input `promptTemplates` is a complete object keyed `start`, `resume`,
  `continue`, `recovery`, `pause`. Omitted input preserves current values. Reject
  unknown keys/types/missing keys with a field-specific 400 error. Explicit null
  resets the whole saved set to defaults.
- Responses expose effective `promptTemplates`, `promptTemplateVersion` and default/
  custom status. Provide the engine catalogue/defaults and read-only preview through
  the authenticated runner configuration surface. Preview validates supplied drafts
  without persisting; server renderer remains authoritative.
- Persist only validated source; render immediately before the eligible dispatch
  using fresh context. Corrupt stored JSON is an explicit configuration failure that
  withholds sends and leaves editing/repair available, never a silent default fallback.
- Carry template key/version or content hash as operation metadata so an outstanding
  send remains identifiable across edits/restarts. Never log template bodies or rendered
  prompts into the audit trail; preserve its metadata-only contract.
- Keep existing ownership/grant checks and resolve-then-gate behavior. Settings
  PATCH/preview must not create sessions, alter queue files or enable supervision.

## Idle/progress gate — integrated with plan 90

All automatic continuation, revision-change, retry and recovery sends share the
same serialized eligibility decision. A custom prompt cannot bypass it.

| Observation | Automatic behavior |
|---|---|
| Confirmed working turn, thinking/streaming, pending/running tool, compaction | Withhold nudge, show Waiting for current turn |
| New meaningful worker progress | Withhold nudge; advance genuine progress clock and reset applicable backoff |
| Confirmed completed turn / known idle | Start idle grace from the measured idle transition; dispatch only after all gates pass |
| Unreadable, stale, unmatched or unsupported observation | Withhold nudge; show observation unavailable/unknown |
| Permission, solo lock, pause, blocker, all done | Existing refusal/control behavior; no automatic send |

Measure exact conversation turn signals in the worker's own store/process; the
published web server's status and Mission's tool-only busy flag are not idle proof.
Record `working / idle / unknown`, `idle_since`, latest meaningful progress and
reason server-side. Tool completion alone does not end an assistant turn. Silence
alone never establishes idle, and repeatedly seeing one running tool is not new progress.
Idle grace restarts after work resumes. Queue claims/progress updates select work
but cannot authorize a mid-turn nudge or bypass the minimum interval.

Use plan 88/90's durable outstanding instruction, atomic ownership, run-generation
and final pre-send checks. Pause/Close, manual human turns and concurrent ticks must
win over stale eligibility. An unconfirmed delivery stays outstanding until reconciled;
neither elapsed timeout nor editable template wording authorizes a blind resend.
Expose truthful working/idle/unknown and why a nudge is withheld in runner controls.

## Related callback and navigation work

Plan 92 owns callback storage, events, execution and result tests. This plan provides
the reusable dialog/editor foundation and the Callbacks section extension point;
do not implement shell execution in the prompt renderer.

Plan 93 owns URL/history state for this dialog and its section/prompt selections.
Keep section/selection inputs controlled so navigation can restore them without
resetting drafts or starting a runner. Until plan 93 lands, normal setup still works.

## Implementation order and progress

- [x] Phase 1 — Recheck plans 88/90; inventory all prompt paths, UI primitives and
  actual per-driver turn/progress signals. Record measured eligibility contract.
  - Plans rechecked 2026-10-12: 88 is Complete (delivery receipts, operation
    tracking, Pause/Close invalidation; phases 4–5 browser-deferred). 90 is
    Complete (exact turn verdicts, serialized leases, `beforeWrite` pre-send
    checks, scheduler persistence + header display, index repair). 94's order
    table still lists 90 as "In progress" — stale index, not a queue change.
  - All five runner-to-LLM sends inventoried in `mission.js` (no templates yet,
    no `prompt_templates_json` column anywhere):
    `start` 2392 (+ hardcoded resume SUFFIX 2404–2406 — must become a full
    template per this plan), `continue` 2597, `recovery` 2850, `pause`
    2507 — all except `pause` flow through `deliverRunnerInstruction` (lease +
    `beforeWrite`); the current-task pause `sendText` (2510) is direct, with no
    ownership or eligibility gate. All sends use the line-by-line writer, so the
    multiline→single-submission normalization contract stands.
  - UI primitives (`components/ui/` + README contract): Modal exists (title,
    footer, width, Escape/backdrop, initial focus, `bodyScroll` bounded-body
    pattern) but has NO focus trap or focus restoration, and RunnerDialog owns a
    custom `max-w-xl` shell instead of using it; no dirty-close confirmation
    exists on RunnerDialog today. Button/Input/Textarea/Select/Field/Switch/Badge
    cover the editor's controls; `msn-*` hooks must be kept on every touched
    element.
  - Per-driver turn signals: `agent-store.readTurn` is opencode-only (reads the
    conversation's own sqlite store); every other driver returns `unknown`
    (contract 8: unsupported certainty stays unknown). Progress comes from
    `observeRunnerTurn` (measured `progressAt`, retry reset on advancement only).
  - Measured eligibility contract (plan 90, consumed as-is): turn
    working/idle/unknown/error × queue invalid/done/need-input × outstanding
    lease × run generation × QUEUE.paused marker × idle grace from the measured
    idle transition × minimum interval on every kind × retry budget →
    dispatch / wait_turn_end / wait_idle_grace / wait_nudge_interval /
    observation_unavailable / paused / blocked / no_work / finished / need_input,
    persisted as `worker_state`/`scheduler_decision`/`scheduler_reason`. A custom
    prompt word cannot bypass any of it; Phase 4 only swaps message TEXT.
- [x] Phase 2 complete 2026-10-12 — shared engine/catalogue/defaults, validation,
  migration, configuration/preview API and isolated renderer/persistence tests.
  - [x] Engine done: `src/services/prompt-templates.js` (pure, no
    deps) — single-pass `{{ name }}` parser with allowlisted token walk, five
    shipped defaults transcribed from the live sends, 10-variable catalogue with
    required/optional contract, located validation errors, non-recursive plain-
    text render, 16KiB/16KiB/80KiB budgets. `src/test/prompt-templates.test.js`
    22/22 (repeated/spaced vars, Unicode, JSON brace literals, no-HTML-escape,
    no-recursion, unknown/malformed/unsupported rejections, missing-context and
    budget failures, set shape, defaults render fully).
  - [x] Persistence/API done: `prompt_templates_json` idempotent migration (NULL
    = shipped defaults, existing rows untouched); create validates before any
    session is minted (a bad set leaves no row); update honors
    omitted-preserves / null-resets / complete-replaces with field-specific 400s
    (`prompt_unknown_key`, `prompt_missing_key`, `prompt_not_string`,
    `prompt_unknown_variable`); effective set + content-hash version + custom
    flag surfaced on create/update/lists/session-detail/queue-detail; corrupt
    stored JSON is an explicit `prompt_templates_corrupt`/validation error, never
    a silent default; `GET /:id/prompts` (catalogue/defaults/effective) and
    `POST /:id/prompts/preview` (validates + renders drafts, persists nothing)
    behind the existing runner gate. `src/test/prompt-templates-persistence.test.js`
    13/13 (defaults, custom create/update/reopen, preservation, reset, three
    rejection codes with stored set untouched, both corruption shapes, migration
    re-run, config/preview behavior + side-effect freedom).
  - [x] Regression + live: infinite-runner 33/33, mission 125/125,
    runner-dispatch 22/22, runner-turn 10/10, queue 42/42, mission-queue 11/11,
    mcp 141/141, plan-mcp 57/57, db-migration 12/12 (each run individually);
    webui restarted; `GET /:id/prompts` and preview verified live against the
    proof runner (defaults served, located unknown-variable error).
  - [ ] Nothing yet reads the engine at dispatch — all five sends still use
    their hardcoded strings (Phase 4).
- [x] Phase 3 implemented 2026-10-12 — reusable large dialog and template
  editor; all five prompts, previews, errors, resets and draft/dirty-close
  behavior in RunnerDialog. Browser interaction proofs deferred (see boundary).
  - `SettingsDialog.jsx` (new, reusable for plan 92): Modal-based wide shell
    (`max-w-[1040px]`, `90dvh` bounded scrolling body), section tabs, focus trap
    + opener restoration, dirty-close inline confirm. Modal itself untouched.
  - `PromptTemplateEditor.jsx` (new, pure): controlled mono textarea,
    variable catalogue with insert-at-caret (caret preserved), server-returned
    errors with line/col, rendered preview pane with sample-value labels, reset.
    No Mission/API knowledge; the server stays the validation authority.
  - `RunnerDialog.jsx` reworked on the shell with Settings/Prompts sections:
    per-kind explanations, debounced server auto-preview of the active kind
    (runner route for edits with real context, project route + typed-name
    override for creates), Save disabled while preview is pending/errored/stale,
    per-prompt reset + deliberate reset-all (saves explicit null), dirty-close
    confirm, save-error pinned to its kind. Save sends the full draft set only
    when prompts are dirty (omitted otherwise, preserving custom sets byte for
    byte); saving never dispatches (pinned by test: enabled runner keeps
    binding/enablement/operation while prompts save).
  - Store: `getPromptConfig`, `previewRunnerPrompts`, `previewProjectPrompts`,
    `getProjectPromptCatalogue`; create/update payloads pass `promptTemplates`
    straight through.
  - Server preview refactor: both preview routes build REAL context
    (container paths from the existing resolver, current/blocker from the live
    queue summary, best-effort) with caller overrides labeled
    real/sample/empty via `contextSources`; required-but-absent still errors
    actionably instead of rendering a hole.
  - Verified: client builds clean; all `msn-prompt-*` / `msn-dialog-*` hooks
    present in the served bundle; persistence suite 14/14; regression
    (mission 125, infinite-runner 33, mcp 141, runner-dispatch 22) green;
    webui restarted; live preview renders real paths with correct
    sample/real labels on both routes.
  - Boundary: no interactive click-through from this shell (no browser tool;
    CDP unreachable) — desktop/390px layout, focus trap/keyboard behavior,
    footer visibility and overflow still need a browser-capable turn.
- [x] Phase 4 implemented 2026-10-12 — every runner message routed through
  templates under plan 90's shared idle/progress/ownership gate; saved edits
  never dispatch by construction. Live browser/worker proofs remain Phase 5.
  - `renderRunnerPrompt` (mission.js) is the ONE producer: effective set →
    real dispatch context → normalize-to-one-submission. All five sends
    (start/resume/continue/recovery/pause) render through it; zero hardcoded
    `Infinite runner …` fragments remain in mission.js. `resume` is the full
    resume template with the pause target's plan as `current_plan`.
  - Withholds: corrupt set refuses start with `runner_prompts_misconfigured`
    (explicit pre-check, so an idle worker is never blamed), parks the watcher
    on `need_input` with the Configure repair named, withholds recovery sends,
    and keeps Pause usable (dispatch still disabled + marker set; only the
    cooperative message is withheld with a reason). Missing required context
    (e.g. `{{current_plan}}` with no current item) refuses as
    `prompt_missing_context` with no send.
  - Operation identity across edits/restarts rides the existing
    `operation_prompt_hash` content hash — no new columns; an edit mid-turn
    cannot match (and therefore cannot release or duplicate) the outstanding
    send.
  - Preview shows the exact submitted text: drafts normalize in preview too,
    with `normalizedKeys` so the dialog explains the fold.
  - `src/test/runner-prompts-dispatch.test.js` 11/11 against the real
    watcher/writer: exact rendered text per kind (full-string equality),
    multiline→single-submission with confirmed operation, all four withhold
    shapes, edit-during-outstanding never resends. Two defects caught while
    proving it (both fixed): create bound the preserve sentinel into the
    INSERT (Phase 2b), and the recovery test stubbed a permanently-dead pane
    that failed the send's own post-restart liveness gate — paneState now
    follows createSession like a real restart.
  - Regression green (each run individually): mission 125/125,
    infinite-runner 33/33, runner-dispatch 22/22, prompt engine 24/24,
    persistence 14/14, queue 42/42, mission-queue 11/11, mcp 141/141,
    plan-mcp 57/57, db-migration 12/12. Webui restarted; live start on the
    finished proof queue returns send-free `empty_queue`; prompts route still
    serves defaults.
- [ ] Phase 5 — Complete automated and live browser/worker proofs below. Update this
  status/checklist; docs absorption remains subject to the existing review hold.
  - [x] Live-fire finding + fix 2026-10-12 (the user's "it dont seem to be
    working / how long are u gonna keep this running"): a controlled proof
    runner (`run_6793fe915bf6c672`, project `prj_6dc3afcee3edf30b`, custom
    `[T91-*]` templates, 45s grace/interval) started cleanly at 00:18:15Z and
    then sat 12+ minutes in `wait_turn_end` with an idle worker and an
    untouched queue. Diagnosis: the `[T91-START]` text never reached the
    conversation — absent from the pad's prompt-history while the pane showed a
    freshly booted TUI, so the "confirmed" send was a false positive (the
    repaint was the boot banner on a fresh conversation id, and the store
    fallback accepts repaint when no transcript exists yet). Nothing bounded
    the wait: the retry budget never exhausts while an operation is
    outstanding. Fix shipped: `RUNNER_NO_RESPONSE_TIMEOUT_MS` (10 min) in
    `computeSchedulerState` — outstanding + verified-idle + no receipt + stale
    send escalates to `need_input` with no resend and no silent release; a
    working worker is exempt. `runner-prompts-dispatch.test.js` 14/14 (3 new:
    stale parks, working stays, fresh stays). Regression: mission 125,
    infinite-runner 33, runner-dispatch 22, persistence 14 — green; webui
    restarted with the fix live. Proof runner paused (enabled=0, evidence
    intact, worker TUI left alone); proof project/queue/plans preserved under
    `src/data/runner91-verification-20261012/`. The custom-template live
    completion proof itself is still open — retry only after the startup
    false-positive is addressed.
  - [x] Acceptance false-positive fix 2026-10-12 (unblocks the live retry):
    `sendText` no longer accepts a repaint when the store layout is known but
    holds no transcript for the conversation — that repaint is most often the
    TUI boot banner, and it is now `mission_send_unconfirmed` instead of a
    false `confirmed`. Only a store layout the webui cannot see at all keeps
    the repaint fallback (codex/claude behavior preserved). The store poll also
    gets its own 15s budget instead of the repaint wait's leftovers (which
    false-negatived slow store writes both ways). `mission.test.js` 128/128
    (3 new: fresh-conversation unconfirmed, landing-twin confirms, unknown
    layout confirms). Regression: infinite-runner 33, runner-dispatch 22,
    prompts-dispatch 14, mcp 141 — green; webui restarted, page 200, prompts
    route serves the proof runner's custom set.
  - [x] Custom-template live completion proof 2026-10-12 (~00:44–00:48Z):
    retried the paused proof runner with both fixes live. Timeline: startup
    taken at once (op confirmed via store, not repaint); p91-a claimed
    00:45:36, done + DONE-A 00:46:21 with the turn ended by exact receipt;
    continuation auto-dispatched, p91-b in progress 00:47:06, done + DONE-B
    00:47:51; supervisor finished the queue with no further touch. Transcript
    (`prompt-history.jsonl`): exactly one `[T91-START]`, exactly one
    `[T91-CONTINUE]` — the saved custom templates arrived verbatim, zero
    duplicates, zero prompt-driven `QUEUE.paused` repeats. Operation receipts
    recorded for both turns. No manual Run/Resume after the initial start.
  - [ ] Browser at desktop and 390px, both themes (needs a browser-capable
    turn; same standing boundary as plan 90 — strings served verified,
    pixels not).

## Verification required

Run suites individually with throwaway databases. Extend `src/test/infinite-runner.test.js`
and add focused template behavior tests; use migration tests derived from real schema.

- Templates: repeated/spaced variables, Unicode, literal values containing braces,
  quotes/ampersands/path spaces, no recursive interpolation; unknown/malformed/
  unsupported tokens, missing context, byte limits and empty values fail usefully.
- Persistence: old runner defaults, custom create/update/reopen, omitted-field
  preservation, reset, corruption feedback, migration twice and ownership refusal.
- Every prompt kind sends the exact rendered saved text to the exact conversation;
  multiline source produces one accepted input, including terminal receipt evidence.
- Long controlled turn spanning multiple watcher checks: claim queue, read files,
  reasoning between tools, streaming and code edits receive ZERO extra nudges.
  Queue revisions and manual human work also receive zero mid-turn prompts.
- Reproduce the reported `QUEUE.paused` loop in the controlled transcript: the initial
  instruction may trigger its required pause-marker check, but subsequent watcher
  ticks must inject no repeated Continue instruction and cause no prompt-driven repeat
  checks during that active turn. Legitimate checks before a new item and checks the
  worker independently needs remain valid; do not assert a blanket ban on file reads.
- Unknown observation never sends. Positive twin on the same fixture: confirmed
  idle with pending work and expired grace sends exactly once. Completed unfinished
  turn resumes its item; completed item advances only after actual turn completion.
- Interval applies to every reason; repeated observations do not fabricate progress.
  Concurrent ticks, edit-during-work, delayed receipt, pause/close and restart obey
  outstanding operation/generation rules. Reuse plan 90's mutation proofs in copies.
- Browser at desktop and 390px, both themes: open Create/Configure, select all prompt
  kinds, type, insert at caret, preview, fail validation, reset, save/reopen and cancel.
  Assert focus trap/Escape/restoration, footer visibility, body scrolling and no
  horizontal overflow. Preview and Save generate zero terminal input.
- Use a controlled test queue/worker, never execute the user's live plans to prove
  prompts. Inspect actual worker transcript/input counts, console and failed requests;
  parse/build client as appropriate and restart backend after code changes.
- Count Mission projects at the end and preserve any row that cannot be attributed.
  Review final diff for unintended changes and keep status honest if any proof fails.
