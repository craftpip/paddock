# 81-mission-close-clears-open-session

## Status:
Complete

## Problem statement
In the Missions page, when opening a session the terminal opens and a green dot is shown for it; when closing it, the green dot is not removed and it remains. Also the item shifts location in the listing when closing (needs verification of whether that is a visual shift in the rendered list or in the opencode output itself; clarify on inspection).

## Root cause hypothesis (to verify)
- On close, the UI does not clear `openSession` (or does not set `selectedSessionId` to `''` and `openSession` to `null`) when the closed session is the one currently open in col 3.
- The "green dot" (open indicator) is likely tied to `openSession?.id` or a derived field that remains true after close.
- The location shift could be a re-sort of the list on refresh (sessions may reorder) or a DOM reflow; distinguish from "opencode output" itself shifting.

## Reproduction
1. Open Missions page for a project with at least one session.
2. Click a session row to open it (col 3 terminal appears, row shows green dot/open marker).
3. Close that session from col 3 / via the close control (or the existing close flow).
4. Observe: green dot remains; row may shift position.

## Acceptance criteria
- When the currently open session is closed, `openSession` is cleared and `selectedSessionId` is cleared (or handled so col 3 shows nothing / returns to the no-session state). The green dot is removed.
- If a different session remains open, state remains correct.
- No persistent stale `openSession` after closing the session that owns it.
- Location shift is explained (or fixed if it is a layout bug). If it is due to list reordering (e.g. by `last_seen_at`/`live`), that is acceptable but the open marker must still clear.

## Investigation tasks
- [ ] Read `src/client/src/pages/Mission.jsx` around `closeSession`, `selectSession`, `openSession`, and how the dot is computed (look for classes like `msn-selected`, `open`, or green indicator).
- [ ] Trace when `openSession` is set/cleared: `selectSession` sets it; `closeSession` must clear it if `id === openSession.id`.
- [ ] Check `store` state updates in `missionStore` (`src/client/src/lib/missionStore.js` or the store module) — does closing update `openSession`?
- [ ] Reproduce in browser (if available) and inspect DOM/state.
- [ ] Fix in UI/store as appropriate.
- [ ] Add/adjust a small test if present (`mission.test.js` client or server) to assert open marker clears.

## Notes
- Col 3 renders from `openSession` snapshot (per earlier learnings); only `selectSession`/`startSession` write `openSession`, only `closeSession` clears it. The bug suggests `closeSession` is not clearing it in this case, or the row click path leaves a stale reference.
- Also verify the "item shifts location" is not the list re-sorting after a session state change.

## Expected behavior (clarification)
When closing a session from the Missions page, the terminal window in col 3 should close (go back to the "no session open" state). That means: end/close the tmux session which is our terminal tab (kill the tmux pane/session backing that Mission terminal), clear `openSession` and `selectedSessionId` if that session was open, and remove the row's open/green-dot marker. The list should update accordingly (row may disappear or be marked closed depending on existing semantics).

**Status update**: Done. Fixed client store to clear  and  when closing the currently open session. Also confirmed the backend closes the tmux session (Mission DELETE ends the session).

- **Green dot remains after close:** The store's `closeSession` clears `openSession` only if it matches the closed id (`s.openSession?.id === sessionId`). That should be correct. However, the row's "open" indicator is computed from `session.open` (server-stamped) or falls back to `live || busy`. After closing via the API, the list/row data may still reflect the old state until `refreshActive()` re-reads sessions. If `refreshActive()` does not update the row for that session in time, or if the row is showing cached data, the dot could remain. Also ensure `selectedSessionId` is not left pointing at a closed session (it is not cleared by closeSession except indirectly via refresh). The UI must treat a closed session as not open: clearing `openSession` means col 3 closes, and the row's dot must reflect `open === false` after the list refresh.
