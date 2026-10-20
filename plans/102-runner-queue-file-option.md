# Mission — Configurable Runner Queue File

## Status: Complete — 2026-10-15

3/4 steps complete. Queue-file persistence, validation and the runner settings
input are implemented. Remaining: the requested full browser acceptance pass and
documentation absorption.

## Requested outcome

In the runner options popup, add a **Queue file** input. Default to `QUEUE.md`; the user can specify another file. Save and reopen the popup to see the selected file, and use that file for the runner's actual queue operations.

## User journey and behavior

1. Open runner options → Settings. Replace the static “Queue: QUEUE.md…” note in `RunnerDialog.jsx` with a labeled input, initially `QUEUE.md` for new and legacy runners. Show the base directory: the project's plans folder.
2. Enter a Markdown filename or relative path within that folder, for example `release-queue.md` or `queues/release.md`. An empty/whitespace-only value resolves to the default `QUEUE.md`; display the normalized value after save.
3. Save options. Reopening shows the persisted path; the queue panel shows data from that file. Save never starts the runner.
4. If the target file does not exist, show the existing missing-queue/setup flow for that exact path. Do not silently copy, move, delete or overwrite the previous queue. Setup creates the chosen file through the normal queue setup action.
5. Invalid paths and unreadable/malformed files produce actionable feedback naming the selected relative path. Cancel leaves the saved path unchanged; failed Save retains the draft.

## Contracts and edge cases

- Store one runner-level queue-file setting, with `QUEUE.md` as the effective default when absent. Follow existing runner settings naming and migration conventions; do not create competing stored spellings.
- Resolve paths inside the project's plans directory using the existing workspace/path safety helpers. Reject absolute paths, traversal outside that directory, symlink escapes and non-Markdown targets. Validate on the server as well as in the popup.
- Every consumer must use the same resolved setting: read/setup/write, Add plans, reorder/remove (plan 101), blocker resolution, summaries, scheduler selection, worker prompts, callbacks or tools that expose/use the queue path. Audit hardcoded `QUEUE.md` references; do not ship an input that only changes a label.
- Changing the file while supervision is enabled or work/delivery is in flight must be refused with a clear instruction to pause and resolve active work first. Pausing alone is not proof that work has ended. Gate on actual runner state and use the existing serialization/conflict mechanism so a scheduler tick cannot race the switch.
- Existing runners continue using the same `QUEUE.md` without migrating or rewriting its content. Two runners selecting one file must share file-level revision/conflict protection; do not give each an independent revision that permits lost updates.
- If runner-scoped queue APIs exist, derive the path from the authorized runner, not a second client-supplied path. Keep direct queue tools' behavior explicit and compatible.

## Ordered implementation

1. Trace `RunnerDialog.jsx`, `src/client/src/stores/mission.js`, runner create/update routes and service, `src/services/plans.js`, scheduler/prompt generation and MCP queue adapters. Identify the current filename assumptions and file revision scope.
2. Add persisted runner setting/default and a shared path resolver; thread it through all queue operations. Implement validation, switch guards and missing-file behavior before exposing the field.
3. Add the Settings input, draft/dirty tracking, save payload, validation feedback and effective-path display. Refresh the queue after a successful change without changing the conversation or runner control state.
4. Run relevant service/API tests individually, build/restart, and verify the real popup and queue workflow in the browser. Document the completed setting in `docs/` before retiring this plan.

## Verification

- Test legacy/default, blank default, custom filename/subdirectory and persisted reload. Assert actual reads/writes target the selected file and leave the old file untouched.
- Reject traversal, absolute paths and symlink escapes; exercise missing, unreadable and malformed targets, active-work switch refusal and a concurrent switch/scheduler attempt.
- In the browser create/configure a test runner through project tools, select a custom queue, set it up, add/reorder/remove tasks and inspect the resulting file. Verify the scheduler and generated worker instruction reference that same path using a controlled test runner.
- Verify Cancel, failed Save, dirty-navigation handling and reopening. Check desktop/narrow layout, console errors and failed requests. Preserve user sessions and compare Mission project counts before/after.

## Progress

- [x] Trace filename consumers and define the persisted setting/path contract.
- [x] Implement shared resolution, persistence and guarded queue operations.
- [x] Add the runner-options field and end-to-end refresh behavior.
- [x] Complete tests/browser verification and absorb into docs.
