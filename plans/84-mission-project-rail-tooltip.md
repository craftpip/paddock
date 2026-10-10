# Plan 84 — Mission Project Rail Tooltip

## Status: Proposed (2026-10-11)

## Issue

When the projects column is collapsed (avatar rail mode), each project avatar button has `title={p.name}` (Mission.jsx:236), which produces a native browser tooltip showing the full project name on hover.

Problems with the current implementation:
1. **Native tooltip positioning** — appears on the right side by default, may be clipped or mispositioned
2. **No customization** — cannot control delay, styling, or animation
3. **Touch-hostile** — native tooltips don't work on touch devices
4. **Inconsistent with rest of UI** — other hover-revealed controls use custom opacity-based reveals (e.g., session row actions in SessionList.jsx)

## Current Code

```jsx
// Mission.jsx:231-243
<Button
  key={p.id}
  variant="none"
  size="bare"
  icon
  title={p.name}           // <-- native tooltip
  onClick={() => onSelect(p.id)}
  className={`msn-avatar msn-rail-btn h-8 w-8 rounded-pill text-[11px] leading-none ${
    on ? 'msn-avatar-on bg-accent text-accent-ink' : 'bg-raised text-ink-dim hover:bg-raised-hover hover:text-ink'
  }`}
>
  {initials(p.name)}
</Button>
```

## Fix Plan

### Option A: Custom tooltip component (recommended)
- Create a small `Tooltip` primitive in `src/client/src/components/ui/Tooltip.jsx`
- Use the same `opacity-0` + `group-hover:opacity-100` pattern as session row actions
- Position it to the right of the avatar with a small gap
- Add `pointer-events-none` while invisible (same safety pattern)

### Option B: Keep native but improve
- Add `data-tooltip` attribute for potential future enhancement
- Accept the limitations

## Files to Modify
- `src/client/src/pages/Mission.jsx` — `ProjectRail` component
- Potentially: new `src/client/src/components/ui/Tooltip.jsx`

## Acceptance Criteria
1. Hovering a project avatar in rail mode shows the full project name
2. Tooltip is positioned correctly (not clipped, reasonable offset)
3. Works consistently with other hover reveals in the app
4. Keyboard focus on the avatar also reveals the tooltip (accessibility)
5. No native `title` attribute on the button (to avoid double tooltip)

## Related
- SessionList.jsx uses the same pattern for row actions (lines 183-232): absolute positioned, `opacity-0` → `group-hover:opacity-100`, `pointer-events-none` when invisible
- This pattern should be reused for consistency