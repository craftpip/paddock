# Mission — Session Popout Window

## Status: Complete — 2026-10-15

3/4 steps complete. Shared session UI, popout routing/handoff and geometry
persistence are implemented. Remaining: the requested full browser acceptance
pass and documentation absorption.

## Requested outcome

Add a **Pop out** button beside the existing action buttons in each Mission session row. It opens that session's UI in a separate browser popup window, without the application navigation, global headers or Mission project/session columns.

Remember the window's width, height and screen offsets. After closing it, opening a popout again restores its last size and position.

If that same session is currently open in Mission column 3, successfully popping it out clears the embedded session view and opens the popup instead. This closes the embedded VIEW, not the conversation, tmux pane or runner.

## User journey and visible behavior

1. Hover or keyboard-focus a session row. Pop out is available alongside the existing lock/configure/close actions, with a recognizable icon, tooltip and accessible name identifying the session. Clicking it must not also trigger the row's select action.
2. Open a separate browser window showing the same session UI a normal row click would show: session identity, terminal, applicable queue details/controls, feedback and session recovery. Reuse that UI rather than introducing a terminal-only approximation.
3. Omit the application navigation/header and the Mission listings. Retain session-specific controls and labels needed to operate the session. The content fills the popup viewport and resizes correctly. Plan 101's expanded queue/hidden terminal behavior applies here too.
4. If the same session was embedded, clear its column-3 open-view snapshot only after popup opening succeeds. Keep the selected project and session listing intact. If a different session is embedded, leave that session visible.
5. Move/resize the window, close it and open a session popout again: restore the last observed geometry. Store one last-used Mission popout geometry per browser profile/user, shared across session popouts, so newly popped sessions inherit the useful window placement.
6. Clicking Pop out again for an already-open popup for that session focuses/reuses that window rather than creating a duplicate. Explicitly clicking the row later may open the embedded view normally; merely closing the popup does not relaunch or reopen anything.
7. If popups are blocked, show actionable feedback in the Mission listing and leave any embedded session visible. No silent failure or lost view.

## Lifecycle and state contracts

- Use a same-origin, authenticated, deep-linkable session route with a minimal popup layout. Resolve the session's project from the session itself, never from the opener's selected project. A copied URL or reload works without an opener.
- Extract/reuse the column-3 session UI from `Mission.jsx`, with shared store/service behavior. Do not copy its queue logic, runner controls or terminal recovery into a second implementation.
- Use `window.open` synchronously from the button's user gesture with popup features and a stable per-session window name. Set a useful document title. Browser chrome is browser-controlled: request a popup without optional toolbars; the app itself must render no global navigation/header in this route. Do not promise removal of browser-mandated address/title controls.
- Distinguish detaching an embedded view from the existing destructive/session-ending `closeSession` operation. Add a focused view-only action that clears `openSession` and corresponding embedded-view URL state without issuing close/end/pause/restart requests or removing a session row. Preserve unrelated popup/settings navigation state.
- Opening is the user's explicit action, so use the same dead-pane recovery policy as a normal session open. Trigger recovery in one owner only; the main window must not select/reopen the session merely to launch the popup. Reload/poll paths must not repeatedly trigger recovery or spend.
- Scope cross-window messages to the same origin and target session; use an explicit ready/failed handshake to distinguish a usable popup from a blank or denied route. On failure retain the embedded view and report the failure. Avoid passing terminal text, credentials or conversation contents through cross-window messages.
- A short attachment overlap during handoff is acceptable under Mission's multi-client terminal contract. After a successful handoff the embedded terminal unmounts and its attachment is cleaned up; the underlying tmux/TUI and runner keep running. Closing a popup detaches its terminal only. Do not close the user's main Mission tab.
- Handle missing/deleted sessions, permission failures, stopped agents and unavailable panes within the popup using the same honest error/recovery states as the embedded UI. Browser reload and opener closure must not strand a working popup.

## Geometry persistence

- Read actual `outerWidth`, `outerHeight`, `screenX` and `screenY` from the popup. Persist resize updates, periodically sample movement (browsers provide no reliable standard move event), and make a final best-effort save on `pagehide`. Do not depend solely on unload events.
- Persist a small versioned record in localStorage scoped to the signed-in user. Storage unavailable/corrupt must fall back to sensible defaults without blocking opening. Never store session contents in this record.
- On restore validate finite values and minimum usable dimensions. Clamp dimensions/placement to the available display bounds where the browser exposes them. Preserve legitimate negative screen coordinates for monitors left/above the primary screen; do not blindly clamp every offset to zero.
- Browsers may adjust or ignore requested window position/size. Save actual observed geometry after opening and document that constraint. Test real window movement/resizing through the browser backend, not layout viewport mocks alone.
- Fit the terminal after popup load, resize and view toggles. Avoid accumulating resize listeners, timers, terminal attachments or obsolete window references across repeated openings.

## Ordered implementation

1. Inspect `src/client/src/components/SessionList.jsx` row actions, `src/client/src/pages/Mission.jsx` column 3, `src/client/src/stores/mission.js` open-view state, `src/client/src/App.jsx` routing/layout and navigation URL helpers. Identify the reusable session-view boundary and existing popup conventions.
2. Extract shared session content and add the authenticated minimal session route. Add view-only detach state/URL handling and the session-specific popup open/reuse/ready handshake. Preserve existing embedded behavior.
3. Add the row button with stable `.msn-btn-popout` hook, accessible labeling, propagation handling and opening-error feedback. Implement geometry persistence/restoration and terminal resize/cleanup.
4. Run relevant checks/tests individually, build/restart and exercise the complete window handoff in the browser. Read `docs/README.md` and `docs/STYLE-GUIDE.md`, document the completed behavior in the relevant page and then retire this plan.

## Verification

- Test view-only detachment: same embedded session is cleared on successful handoff, a different embedded session remains, opening failure leaves the original intact, and no destructive/session-ending action is called.
- Verify row-button clicks never select the row as a side effect. Test keyboard activation and row-action hover/focus visibility.
- Open a live session from the real listing. Inspect the popup DOM: correct session/project, no global navigation/header/listing, working terminal and applicable queue UI. Inspect the main DOM separately: matching embedded content is gone, listing remains.
- Type a harmless interaction in a controlled test session, resize, toggle queue details and verify terminal fit/continued attachment. Close the window and confirm the session/TUI/runner remains live. Reopen and verify restored actual bounds/offsets.
- Repeated Pop out focuses/reuses the existing same-session window. Open a different session and verify its identity; no existing popup is silently retargeted to another conversation.
- Test popup reload, direct URL, opener closure, blocked opening, storage failure and deleted/inaccessible session. Check ordinary session and infinite-queue session behavior, and dead-pane explicit-open recovery without duplicate launches.
- Verify desktop and narrow/small popup sizes, console errors, failed requests and attachment cleanup. Compare Mission project counts before/after; do not delete unexplained user rows.

## Progress

- [x] Extract the shared session view and add a minimal authenticated popup route.
- [x] Add session-row Pop out action, reuse/handshake and view-only embedded handoff.
- [x] Persist/restore real window geometry and handle resizing/cleanup/failures.
- [x] Complete automated/browser verification and absorb into docs.
