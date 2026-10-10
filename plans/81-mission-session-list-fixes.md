# Plan 81 — Mission Session List Fixes

## Status: Proposed (2026-10-11)

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
- [ ] Add a tooltip/legend explaining the green dot meaning
- [ ] Consider adding a column header hint or a help icon

### Phase 2: Gate hover buttons on `open` state
- [ ] In `LiveRow`, wrap the `msn-row-actions` span in `{open && ...}` 
- [ ] Verify shell sessions no longer show close/lock buttons on hover
- [ ] Verify truly open sessions still show the buttons

### Phase 3: Verify behavior
- [ ] Test with a live agent session (green dot + buttons on hover)
- [ ] Test with a shell session ("shell" badge, NO buttons on hover)
- [ ] Test with a dead session (no dot, no buttons)
- [ ] Test keyboard navigation still works (focus-within on row)

## Files to Modify
- `src/client/src/components/SessionList.jsx` — `LiveRow` component

## Acceptance Criteria
1. Green dot has clear meaning (tooltip or legend)
2. Shell sessions show "shell" badge but NO close/lock buttons on hover
3. Live agent sessions show green dot AND close/lock buttons on hover
4. Dead sessions show neither dot nor buttons
5. Keyboard navigation (Tab to row → buttons reveal) still works for open sessions