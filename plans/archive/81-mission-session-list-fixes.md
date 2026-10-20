# Plan 81 — Mission Session List Fixes

## Status: Complete — 3/3 phases verified live 2026-10-19. The dot got a visible
header legend (its per-row `title` already existed since `f54c17e`), and every
row action is now gated on the server's `open`, so shell/dead rows show none.

## Issues

### 1. Green dot meaning is unclear
The green dot (`.msn-session-dot`) in the session list indicates a session is "open" — meaning either:
- A tmux pane exists (`session.live === true`), OR
- The agent is actively working on the conversation (`session.busy === true`)

This is computed in `SessionList.jsx:51`:
```js
const open = session.open !== undefined ? session.open === true : session.live === true || session.busy === true
```

The dot is mounted only when `open` is true (`SessionList.jsx:119-121`). However, there's no tooltip or legend explaining what the dot means. Users see a green dot but don't know if it means "live TUI", "agent working", or something else.

### 2. Close/lock buttons appear on shell sessions
The hover action buttons (lock and close) in `LiveRow` (`SessionList.jsx:183-232`) are rendered for ALL live session rows, regardless of whether the session actually has a running agent TUI.

When `session.kind === 'shell'` (the agent TUI has exited, only a bare shell remains), the row shows a "shell" badge instead of the green dot, but the close/lock buttons still appear on hover. This is wrong because:
- **Close** on a shell session would kill the tmux pane but the conversation is already effectively closed
- **Lock** on a shell session is meaningless — there's no agent to lock out

The buttons should only appear when `open === true` (i.e., a real agent TUI is running).

## Root Cause

In `LiveRow`, the action buttons span (lines 183-232) is unconditionally rendered for every live row. It should be gated by `open` (or equivalently, `!shell`).

## Fix Plan

### Phase 1: Clarify the green dot
- [x] Add a tooltip/legend explaining the green dot meaning — the dot's native
      `title` already existed (added by plan 62, `f54c17e`), so the missing piece
      was a visible legend; added `● open` to the sticky `Sessions` header
      (`.msn-dot-legend`, wrapped in the app's `Tooltip`) whenever `openCount > 0`
- [x] Consider adding a column header hint or a help icon — header legend is the
      hint; no help icon needed

### Phase 2: Gate hover buttons on `open` state
- [x] In `LiveRow`, wrap the `msn-row-actions` span in `{open && ...}` — gates
      pop-out, lock, runner and close together; the timestamp's hover fade is
      gated by the same `open` (no buttons means it must not fade)
- [x] Verify shell sessions no longer show close/lock buttons on hover
- [x] Verify truly open sessions still show the buttons

### Phase 3: Verify behavior
- [x] Test with a live agent session (green dot + buttons on hover)
- [x] Test with a shell session ("shell" badge, NO buttons on hover)
- [x] Test with a dead session (no dot, no buttons)
- [x] Test keyboard navigation still works (focus-within on row)

## Files to Modify
- `src/client/src/components/SessionList.jsx` — `LiveRow` component

## Acceptance Criteria
1. Green dot has clear meaning (tooltip or legend)
2. Shell sessions show "shell" badge but NO close/lock buttons on hover
3. Live agent sessions show green dot AND close/lock buttons on hover
4. Dead sessions show neither dot nor buttons
5. Keyboard navigation (Tab to row → buttons reveal) still works for open sessions

## Outcome

`SessionList.jsx` now has one `sessionOpen(session)` helper (server `open`
first, `live || busy` only as the legacy fallback) used by both `LiveRow` and
the header's `openCount` (live rows via the helper; history rows via
`item.open === true`). The header reads `● open` in the existing
`.msn-group-sessions` bar, right-aligned via `.msn-dot-legend-wrap`, with
tooltip text `green dot = open — a live agent session is on it`. Comments were
corrected to state that the dot means a live agent TUI attached (idle or
busy), not "working".

Live evidence (2026-10-19, `cloakbrowser` — chromium reports
`(hover: none)` so it cannot exercise `group-hover`):
- A synthetic shell pane for the dead test session `msn_0a8c84e0aa62c2e9`
  (`tmux msn-3bc9d42f`, created then killed) rendered the `shell` badge, no
  dot, no `.msn-row-actions`, and its timestamp stayed at opacity `1` on hover.
- An open live row showed all four actions on hover (pop out, solo lock,
  configure infinite runner, close), its timestamp faded to `0`, and Tab from
  the row landed focus on the pop-out button with the actions visible.
- A non-hovered row's invisible actions were `pointer-events: none`; a click at
  the timestamp's coordinates hit the timestamp, not a hidden button.
- The legend appeared with the correct tooltip; after the shell pane was killed
  the row returned to dead state (no shell badge, dot, or actions).
- No console errors; `npm run build` succeeded and an esbuild `write:false`
  parse of the built source returned `parse ok`.

There is no component-test harness for `SessionList`; as the plan specifies,
this is browser-verified behavior, and the contract is documented in
`docs/reference/pages/overview.md` and `plans/53-mission-workspace.md` §6.
