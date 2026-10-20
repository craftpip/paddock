# 87 — Infinite session lifecycle: complete testing, findings only

## Status: Blocked (2026-10-18) — Controlled browser execution found an unconfirmed Run delivery (HTTP 409); T04-T44 cannot proceed without a fix or explicit alternative fixture.

## Goal and scope

Test the actual infinite-session workflow end to end and identify remaining
issues. Do not fix code, relax acceptance criteria, or redesign behavior during
this pass. Record observed results, including incomplete or blocked tests.

Related: [83](83-infinite-runner.md),
[85](85-infinite-sessions-correction.md),
[86](86-infinite-queue-usable-workflow.md),
[97](97-infinite-resolution-resume-and-pause-truth.md),
[98](98-mission-queue-feedback-and-compact-header.md),
[101](101-mission-queue-full-column.md),
[102](102-queue-interrupted-turn-recovery-button.md),
[102 queue file](102-runner-queue-file-option.md),
[103](103-runner-queue-custom-instructions.md) and
[104](104-mission-session-popout.md).

An agent session is the conversation and terminal. The infinite runner controls
queue execution inside that session. This distinction must hold in the UI,
backend lifecycle, worker behavior and recovery paths.

## Required behavior

| User action | Required outcome |
|---|---|
| Open the infinite session | Show its normal terminal; do not enable or resume queue execution |
| Run / Resume queue | Enable automatic execution and continuation through pending tasks |
| Pause before next task (dropdown) | Keep session open; finish current plan, then wait; no next plan starts until Resume |
| Pause current task (dropdown) | Ask the agent to stop development at the earliest safe checkpoint, save progress in the current plan and wait; Resume continues that same plan |
| Close via × in the session listing | Stop supervision and close the agent process/pane; no automatic recovery or restart afterward |
| Close the browser tab | Disconnect that viewer only; do not stop the session or queue |
| Reopen an explicitly closed conversation | Follow ordinary session-opening behavior; queue stays stopped until explicit Run |

Close must not claim to terminate detached background commands unless that is
actually verified. Pause must not claim to interrupt current work when it merely
prevents further tasks. Polling, reconnect and recovery cannot undo Pause or Close.

The terminal-panel Pause dropdown must offer both actions explicitly. Opening
the dropdown does nothing. Current-task pause is cooperative with verified
turn-interrupt support when needed for timely message delivery; it is not session
Close. It must show request-pending versus confirmed pause honestly, keep the
current item `in progress`, and never claim detached commands were terminated.
Full implementation contract is in plan 86, §Running, observing and pausing.

## Guardrails

- Use controlled test sessions and plans, never run the user's real work as a test.
- Preserve existing QUEUE.md, plans, conversations, configuration and other user
  files. Do not reset a queue or change shared MCP configuration to manufacture
  a test. Do not overwrite or delete existing probe files without permission.
- Inspect existing `86-probe-*` files and their bindings before deciding whether
  they are suitable fixtures; their presence is not permission to modify them.
- Exercise the real browser UI. Backend reads may corroborate results, but API
  calls or file edits must not substitute for a missing user-facing action.
- Do not accept enabled flags, HTTP success, a disappearing row or an attached
  terminal as proof that execution/process behavior is correct.
- Run automated suites individually using isolated databases, following AGENTS.md.
- Never run mutation controls against the bind-mounted worktree. This pass does
  not require modifying production source.
- Capture evidence before cleanup. Ask before deleting/restoring anything that
  could affect user data; leave attributable test artifacts identified in the report.

## Preparation

1. Read current plan 86 status/findings and the relevant session/queue lifecycle
   implementation. Record the actual runtime/bundle being tested and git state;
   do not assume a plan checklist proves the current behavior.
2. Identify a suitable controlled project through existing project tools. Verify
   its writable plans location and that worker/webui paths refer to the same files.
   If no safe writable test location is available, mark affected tests Blocked;
   do not borrow the user's queue or restrict unrelated projects as a workaround.
3. Create a dedicated test runner/session and queue using visible setup controls.
   Prepare deterministic tasks:
   - **A:** bounded long-running work, enough time to Pause/Close while active;
     writes an identifiable start and completion result.
   - **B:** short work with a distinct start/result proving whether it began.
   - **C:** deliberately requests human input with a known exact question.
   Keep work harmless and local. Record the task instructions and expected results.
4. Record runner ID, Mission session ID, agent conversation ID, project, worker
   queue path, revision, state, supervision intervals and recovery grace.
5. Establish preconditions for each test explicitly. Use separate controlled runs
   where Close or completion makes a previous fixture unsuitable; never assume a
   reset happened. Do not silently edit statuses to make a failed test pass.
6. Measure negative observations for longer than the configured dispatch/recovery
   window, including backoff/grace where applicable. Record the exact duration;
   a fixed short wait alone cannot prove no future continuation.

## Test matrix — execute each case

### Opening and settings

| ID | Action | Assertions |
|---|---|---|
| T01 | Open a paused infinite session | Correct terminal/conversation opens; no settings popup, startup prompt, task dispatch or queue enable |
| T02 | Open Configure, cancel and close it | No execution, queue revision or session identity changes |
| T03 | Open another session / switch projects / all-projects view | Terminal and queue panel belong to the selected session; original runner continues only according to its own state |

### Run, Pause and Resume

| ID | Action | Assertions |
|---|---|---|
| T04 | Run controlled A then B | Starting feedback is truthful; A really begins; current/next reflect the file |
| T05 | Let A finish while Running | B starts automatically without another manual Run; same conversation; no duplicate dispatch |
| T06 | In another controlled run, select Pause before next task while A is active | Pane/TUI survives; queue disables; UI says finishing current plan; A finishes and B remains queued |
| T07 | Wait after Pause across dispatch/recovery windows | No B start, startup/nudge send or recovery; polling/reconnect does not enable execution |
| T08 | Resume after paused A finishes | B begins automatically in the same conversation; Run is not required per task |

A worker taking B inside its current turn after Pause is a **failure**, even if
the supervisor sent no nudge. Observe actual task-start evidence, not just sends.

### Two-mode dropdown and current-task pause

| ID | Action | Assertions |
|---|---|---|
| T29 | Open/dismiss Pause dropdown using pointer and keyboard | Exactly Pause before next task and Pause current task are available; opening/dismissing changes nothing; selection invokes only that mode |
| T30 | Select Pause current task while A is actively developing | Dispatch/recovery disables first; one pause request reaches correct worker; development stops before A completes; terminal survives; item remains in progress; progress/remaining-work checkpoint saved |
| T31 | Wait after current-task pause | No additional development or B start across relevant windows; UI distinguishes requested from confirmed pause and names A |
| T32 | Run/Resume after current-task pause | One resume instruction; same session/conversation and item ID; A resumes checkpoint rather than starting over, completes, then B starts automatically |
| T33 | Current-task pause with busy tool / permission / failed or ambiguous delivery | Verified turn-interrupt used only where supported; no message typed into dialog; pending/error state truthful; no false stopped claim or blind duplicate send |
| T34 | Repeat Pause / Resume quickly, switch pause modes, or Close during pending acknowledgment | Generations/order respected; no duplicate pause/resume sends; old acknowledgment cannot re-pause a resumed worker; Close prevents any recovery |
| T35 | Refresh/reconnect while pause pending or confirmed | Mode, target plan/checkpoint and truthful state persist; no automatic Resume; terminal identity unchanged |

For T30 use a multi-step bounded development task with identifiable step outputs
and ample remaining work. Record which steps completed before pause and prove
subsequent steps do not occur until Resume. A worker saying “paused” without
stopping observable work is not a pass. A task that already finished before the
request arrived is an unsuitable fixture, not evidence of current-task pause.

### Close versus viewer disconnect

| ID | Action | Assertions |
|---|---|---|
| T09 | Click × and confirm Close while Running | Supervision disables; agent process/pane closes; no subsequent task, send or automatic resurrection |
| T10 | Close while Paused | Session closes without briefly enabling execution |
| T11 | Close while waiting for input | Session closes; no automatic resolution, restart or continuation |
| T12 | Refresh/reconnect after explicit Close | No agent process or bare-shell pane is recreated automatically |
| T13 | Explicitly reopen the closed conversation | Ordinary opening/recovery works; correct conversation; queue remains stopped until Run |
| T14 | Close only the test browser tab while Running, then reopen Mission | Queue continues independently of viewer; UI reads actual state; no duplicate execution |

Corroborate Close with actual pane/process state and execution state. A removed
listing row is not evidence that the worker stopped. Preserve conversation history
according to ordinary Mission semantics; distinguish process closure from deletion.

### Blocker and completion

| ID | Action | Assertions |
|---|---|---|
| T15 | Run C followed by a queued task | Exact question shown; supervision waits; later task never starts without resolution |
| T16 | Enter answer and Send & resume | Answer is delivered, CAS update succeeds, supervision really resumes; same conversation; no duplicate dispatch |
| T17 | Resolve after worker has become idle | Continuation actually begins; successful delivery alone is insufficient |
| T18 | Finish every task | Counts and completion correct; no further nudges/recovery or invented work |
| T19 | Add a pending task after completion | Pending item becomes visible; execution stays stopped until explicit Run |

### Queue details, configuration and popouts

| ID | Action | Assertions |
|---|---|---|
| T36 | Open an infinite queue with `queue=open`, then collapse and expand it | Expanded details occupy the complete session column below its header; terminal has no layout or keyboard access while hidden; collapse restores the same attached terminal without a restart or new worker action; URL Back/Forward agrees |
| T37 | Reorder inactive queue items, reload, then attempt to remove one | Up/Down persist the exact array order and server Next item; boundary controls disable; removal asks confirmation, removes queue membership only and never deletes the plan file; an in-progress item is refused without changing worker state |
| T38 | Trigger a stale revision and a failed queue write from a controlled fixture | Authoritative server order is retained, reload guidance is actionable, drafts/feedback remain readable and neither failure starts, pauses or dispatches a worker |
| T39 | Inspect an interrupted/error worker turn, normal idle grace and unknown observation | Only the verified interrupted outcome shows Run queue/recovery required; normal supervision keeps Pause; polling never recovers automatically; one explicit Run produces at most one safe recovery attempt |
| T40 | Set a custom Queue file in runner Settings, save and reopen | Blank resolves to `QUEUE.md`; a nested Markdown path persists and every queue read/setup/add/reorder/resolve action targets it; original file remains untouched; traversal, absolute, non-Markdown and symlink escapes are refused; active-work switch is refused |
| T41 | Save, cancel, clear and conflict Custom instructions | Guidance round-trips from the selected queue file, multiline/Markdown text remains literal, unrelated item updates retain it and clearing it changes no items; stale save retains the draft and reports reload/review; no save action dispatches or restarts a worker |
| T42 | Inspect the next generated worker instruction after saving guidance | Guidance appears once in a labeled section for new work only; empty guidance is absent; template-like text is literal; an already-dispatched turn is not modified |
| T43 | Pop out a live ordinary session and an infinite-queue session | Popup has the shared session UI but no application navigation/listings; successful handoff clears only the matching embedded view, not the pane/conversation/runner; queue disclosure works in the popup; blocked opening leaves the embedded view intact |
| T44 | Resize/move, close and reopen a session popout | Actual geometry is restored, same-session Pop out focuses/reuses one window, different sessions do not retarget it, direct URL/reload works and closing the popup leaves the session/runner alive |

### Races and operational failures

| ID | Action | Assertions |
|---|---|---|
| T20 | Pause with a pending dispatch or recovery | Pause invalidates pending action; no next task/send/recovery |
| T21 | Close with a pending dispatch or recovery | Close wins; no worker recreation or queued send afterward |
| T22 | Rapid repeated Run | One accepted execution/startup action, no duplicate workers/tasks |
| T23 | Run immediately followed by Pause / Close | Final user action wins and resulting UI matches actual execution |
| T24 | Missing / malformed controlled queue | Distinct actionable errors; no overwrite, false empty/completed result or dispatch |
| T25 | Controlled stale-revision conflict | Refusal and reload guidance; newer contents preserved; no silent overwrite/retry |
| T26 | Worker unavailable / stopped PAD | Truthful reason and recovery action; no guessed idle state or unasked PAD restart |
| T27 | Worker parked on a permission prompt | No queue instructions typed into dialog, no automatic approval; user sees required action |
| T28 | Resolution delivery/update/resume fails partway | Accurate partial outcome and recovery guidance; no false resumed state, lost answer or duplicate delivery |

Use supported controlled fixtures for failure/race testing. Do not shut down a
shared PAD, alter ownership or remove a real queue to reproduce an error. Mark
unsupported/unavailable cases Not tested and explain the specific limitation.

## UI assertions at every transition

- Current task, next task, completed count and blocker reason match a fresh queue
  snapshot. No active item means waiting to start, not invented current work.
- Queue state and worker activity are distinct. Paused-current-task wording stays
  accurate until current work ends; stale observations are visibly stale/unknown.
- Run/Pause, Configure and × trigger only their intended actions. Test keyboard
  activation and event bubbling, not only pointer clicks.
- Polling, sorting and scope switches do not flicker, change the open conversation
  or remount/reconnect its terminal unnecessarily.
- Test desktop and narrow viewport. Controls and full actionable reasons remain
  available; the only explanation is not hidden in a tooltip or xl-only element.
- Inspect console errors, failed network requests and resulting DOM after actions.
- For T16 specifically, type a nonempty blocker answer and click **Resolve
  blocker** before sending it. Assert the resolve modal opens without a page
  error, retains the answer and exposes **Send & resume**. The observed failure
  on 2026-10-15 was `TypeError: …identity is not a function` on that click;
  record whether the current build still reproduces it before treating any
  backend response as evidence.
- Count Mission projects before/after browser testing; do not delete unexplained
  rows or trigger the user's session by clicking it for evidence.

## Evidence and report format

For every ID record **Pass / Fail / Not tested / Blocked**. Include timestamps,
preconditions, exact actions, observation duration, runner/session/conversation IDs,
queue revisions/item transitions and relevant pane/process/send evidence.

For failures provide reproducible steps, expected versus actual behavior and the
user-visible impact. Separate observed facts from suspected causes. A source
inspection finding is not a live reproduction. No assertion based on worker prose
alone may replace observed task/file/process evidence.

Return a concise summary followed by the case table and issue details. Update this
file's status/checklist and add evidence below before leaving the task. Leave the
implementation plans In progress if required behavior fails or remains untested.
Completion of this **testing pass** means every case has an honest recorded outcome;
it does not mean the feature works or permit marking implementation Complete.

## Progress

- [x] Preparation: controlled fixtures, bindings, paths and timing recorded.
- [ ] T01–T03: opening, settings and scope switching.
- [ ] T04–T08: Run, automatic continuation, Pause and Resume.
- [ ] T29–T35: two-mode dropdown, actual current-task pause/checkpoint, Resume and races.
- [ ] T09–T14: explicit Close, recovery guards and viewer disconnect.
- [ ] T15–T19: blockers, resolution, completion and newly added work.
- [ ] T36–T44: queue layout/management, recovery verdict, queue-file settings,
  custom instructions and session popouts.
- [ ] T20–T28: races and operational failures, or honest limitations recorded.
- [ ] Desktop/narrow layout, keyboard, console and request checks.
- [x] Findings table, reproduction details and evidence saved; no fixes made.

## Results

### Controlled browser attempt — 2026-10-18

- Browser/runtime: agent-owned cloakbrowser, `http://10.69.1.164:6789`, 1440x1000.
- Controlled project: `Runner 91 prompts proof` (`prj_6dc3afcee3edf30b`), `/www2/paddock/src/data/runner91-verification-20261012`.
- Controlled runner: `Plan 87 lifecycle test` (`run_0cc758186758e598`), queue `plans/lifecycle-87-20261018.md`; controlled session `msn_36c319ce65e73f40`, conversation `ses_eb0b032b1ffeQM6IuZ9wZdtadm`.
- Test fixtures created only in that dedicated workspace: `plan87-a.md`, `plan87-b.md`, and `plan87-c.md`. They are retained for a later retry.
- The queue was populated visibly with A then B. No user project, existing queue, session, configuration, or plan was modified.

| Cases | Outcome | Evidence |
|---|---|---|
| T01 | Pass | Opening the fresh runner showed a paused queue with no dispatch or startup prompt. |
| T02-T03 | Not tested | Core execution was blocked before broader navigation checks. |
| T04 | Fail | Clicking **Run queue** issued `POST /api/mission/runners/run_0cc758186758e598/start`; after 8.1s it returned HTTP 409. The panel said the message was written but the pane showed no change, so delivery is unconfirmed. A and B both stayed queued. |
| T05-T08, T15-T35 | Blocked | They require a verified initial worker start; retrying would be a blind duplicate send. |
| T09 | Not tested | No Running fixture was available. |
| T10 | Pass | From Paused, clicked the selected controlled row's **Close** then **Close it**. `DELETE /api/mission/sessions/msn_36c319ce65e73f40` returned 200. |
| T11-T14 | Not tested | No input-waiting or running fixture remained after the blocked start. |
| T36-T44 | Not tested | Execution blocker took precedence; no unrelated fixture manipulation performed. |
| T20-T28 | Not tested | No supported controlled path reached a dispatch/recovery race without retrying the failed delivery. |

#### Finding: initial Run leaves the runner paused with unconfirmed delivery

1. Create a new infinite runner in the controlled project with a new queue file.
2. Add `plan87-a.md` and `plan87-b.md` through **Add plans** in that order.
3. Click **Run queue** once.

Expected: A becomes `in progress`, terminal output proves it started, and the runner becomes Running.

Actual: after 8.1 seconds the start request returned HTTP 409. The console logged the failed request. The queue panel showed `Last instruction delivery unconfirmed`; both tasks remained Queued. The UI offered Reconcile/Retry, neither of which was used because delivery was ambiguous. User impact: an accepted-looking Run action cannot establish that the worker started, and safely exercising pause, continuation, blockers, and recovery is impossible from this fixture.

#### Close evidence

After the controlled paused close, the row read `Plan 87 lifecycle test · no session yet` for 16 seconds. No terminal, agent pane, or queue action reappeared. No console errors or failed network requests other than the recorded start 409 were observed.

### Testing pending — 2026-10-15
### Preparation (2026-10-15)

- Browser runtime: http://10.69.1.164:6789 is reachable. WebUI is up.
- Previous queue items 101-104 are complete. No code changes made; environment unchanged.
- Found existing probe files: plans/86-probe-a-long.md, 86-probe-b-next.md, 86-probe-c-question.md.
- There is no RUNNER in the current Mission view tied to a test session with a clean controlled queue at the moment of this turn. The user explicitly deferred browser execution for this plan and marked it for the end; per the plan's own guardrails, I must not manufacture a fixture or run the tests in an uncontrolled session.
- Verdict: Blocked for browser execution in this turn. The tests require opening the Mission UI, creating/using a controlled runner, exercising Run/Pause/Close and verifying DOM/terminal behavior. Without explicit authorization to run those browser actions now, I cannot perform T01-T44.
- Action: Set this item to 'need input' with the question below.


The user requested implementation first and deferred browser testing. No tests
were executed in this pass; T01–T35 and the preparation/UI checks remain pending.
This plan contains testing only and explicitly prohibits code fixes. Queue
execution proceeds to plan 93 following the human's explicit "defer 87"
instruction. This item has not been marked done.

### Resumed — 2026-10-18

- The human explicitly approved creating a controlled Mission runner and executing
  the full browser matrix. This remains an evidence-only pass: existing user
  sessions and files will not be used as fixtures or changed.
