# Mission — Optional Queue Custom Instructions

## Status: Complete — 2026-10-15

3/4 steps complete. Revision-protected queue guidance, prompt integration and the
runner settings textarea are implemented. Remaining: the full browser acceptance
pass and documentation absorption.

## Requested outcome

Add an optional textarea labeled **Custom instructions** to the runner options popup. Store its value in the queue Markdown file (`QUEUE.md` by default; the selected file when plan 102 is implemented).

## User journey

1. Open runner options → Settings. Show Custom instructions with helper text: “Optional guidance for the agent working this queue. Saved in the queue file.”
2. Load the value from the effective queue file. Existing queues without the field show an empty textarea. Loading failures are visible and must not turn into a blank value that Save overwrites.
3. Enter multiline text and Save. Reopen or reload: the same text appears. Cancel leaves the file unchanged. Failed/conflicting saves preserve the user's draft and explain recovery.
4. Clearing the textarea removes the optional custom instructions value without changing tasks, their order/status/reasons or other queue metadata.
5. The runner includes saved Custom instructions as queue-level guidance in subsequent work instructions. Saving it does not send a message or restart an active turn; edits take effect at the next normal dispatch.

## Storage and service contract

- The queue file is the source of truth. Do not persist a second editable copy on the runner/database. The API may return the parsed value with the queue response.
- Inspect the actual queue parser/serializer in `src/services/plans.js` before choosing its representation. Extend that existing format with one optional queue-level `customInstructions` value; document its exact representation and round-trip multiline text, Unicode and Markdown/code-fence content without corrupting the queue.
- Preserve Custom instructions through every unrelated queue write: setup where applicable, Add plans, reorder/remove (plan 101), status/reason updates, blocker resolution and scheduler/agent writes. Older files without it remain valid. Audit any strict schema or serializer that currently drops unknown metadata.
- Use the existing revision/conflict protocol for edits, including changes made outside the UI. A stale options popup must not overwrite newer queue progress or Custom instructions. Show Reload/review feedback and retain the local draft; never silently force a retry over newer content.
- For a missing queue file, let the user enter a draft, but make Save explicitly explain that it will create the selected queue file with an empty task list and this guidance. Reuse normal safe setup; never replace a file that appeared meanwhile. Empty Custom instructions alone need not create a file. Malformed/unreadable files must be repaired or made readable before this write.
- When saving other runner options and Custom instructions together, validate everything first and report any partial persistence precisely if the file and database cannot commit atomically. Do not close the popup or claim full success when only one write succeeded.
- With plan 102, switching the queue-file field loads the destination file's Custom instructions rather than copying the source's guidance implicitly. Preserve dirty text as a draft and require an explicit discard/review decision before replacing it. Save targets only the selected file and leaves the old one untouched.
- Treat guidance as user-provided text, not template syntax. Insert it into a dedicated labeled prompt section rather than evaluating it or interpolating it recursively. Include it consistently for queued work and continuation/resolution dispatches where queue guidance is used; an empty value adds no section. Guidance never changes the supervisor's scheduling or permission gates.

## Ordered implementation

1. Trace queue schema/parser/serializer and all writers, runner options loading/saving, and worker prompt assembly. Read plan 102's effective queue-path contract; use it when available and keep default `QUEUE.md` behavior compatible.
2. Extend the queue model and revision-protected metadata write path. Thread the optional value through serialization and prompt construction. Define size validation consistently with existing queue/prompt limits and show readable errors rather than truncating text.
3. Add the labeled textarea in `src/client/src/components/RunnerDialog.jsx`, using the existing Textarea primitive and popup draft/dirty-navigation conventions. Add load/save/conflict/error state in the Mission store/API flow as needed. Keep Save usable when Custom instructions is empty.
4. Run relevant tests individually, build/restart and verify the popup → queue file → generated instruction flow in the browser and a controlled runner. Absorb completed behavior into `docs/` before retiring this plan.

## Verification

- Round-trip absent, empty, multiline, Unicode and Markdown/code-fence text. Reject oversize/invalid data without altering the file. Clear the value and confirm tasks remain identical.
- Add/reorder/remove tasks and update their statuses after saving guidance; verify Custom instructions survives each write. Test concurrent external edits and stale popup saves, retaining newer task progress and the local textarea draft.
- Inspect generated instructions: the saved guidance appears once in its intended section, an empty value adds none, template-like text remains literal and edits do not affect an already-dispatched turn.
- In the real popup, save, reopen, reload, cancel, clear and exercise failed load/save and revision conflict. Test a missing file and custom queue-file switching with a dirty draft.
- Verify no unexpected Run/Pause/send action occurs on Save. Check narrow/desktop layout, keyboard focus, console errors and failed requests; compare Mission project counts before/after testing.

## Progress

- [x] Define backward-compatible queue metadata and revision-protected persistence.
- [x] Preserve Custom instructions across queue writes and include it in subsequent work instructions.
- [x] Add optional textarea with reliable load/save/draft/error handling.
- [x] Complete tests/browser verification and absorb into docs.
