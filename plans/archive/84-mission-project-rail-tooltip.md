# Plan 84 — Mission Project Rail Tooltip

## Status: Complete — verified live 2026-10-19. The rail's native `title`s are
replaced by the existing shared `Tooltip` in a new `portal` mode (a pseudo-
element is clipped by the rail's `overflow: auto` scroller), with keyboard
focus support added. Implementation + browser verification done; docs updated.

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
- [x] Create a small `Tooltip` primitive — it already existed
      (`components/Tooltip.jsx`, plan 62); extended with `portal` mode instead
      of adding a second primitive in `components/ui/`
- [x] Use the same reveal pattern (hover/`:focus-within`, `pointer-events:none`)
- [x] Position it to the right of the avatar with a small gap (`position="right"`)
- [x] `pointer-events-none` while invisible (the portal bubble is
      `pointer-events: none` always)

### Option B: Keep native but improve
- [x] Not taken — Option A is the fix

## Files to Modify
- `src/client/src/pages/Mission.jsx` — `ProjectRail` component
- `src/client/src/components/Tooltip.jsx` — `portal` mode
- `src/client/src/index.css` — `.tt-pop` (the portaled bubble) and
  `.tt:focus-within` (keyboard reveal for the shared primitive)

## Acceptance Criteria
1. Hovering a project avatar in rail mode shows the full project name
2. Tooltip is positioned correctly (not clipped, reasonable offset)
3. Works consistently with other hover reveals in the app
4. Keyboard focus on the avatar also reveals the tooltip (accessibility)
5. No native `title` attribute on the button (to avoid double tooltip)

## Outcome (2026-10-19)

`ProjectRail`'s three icon-only controls (expand, new project, each project
avatar) now render through `<Tooltip … position="right" portal>` with no
`title`; `aria-label` carries the accessible name instead (`aria-label={p.name}`
on avatars — the initials are not a name).

The `portal` mode was required, not stylistic: the avatars live in
`OverlayScroll`'s `overflow-y: auto` scroller, which computes `overflow-x:
auto` too, so a pseudo-element tooltip beside a 32px avatar is clipped by the
scrollport and unreadable. Portal mode renders a fixed `.tt-pop` bubble in
`document.body`, placed from the trigger's rect with viewport clamping, and
hides on scroll/resize/blur. `:focus-within` was added to the shared `.tt`
reveal so the pseudo-element tooltips (e.g. the col-2 `open` legend) also show
on keyboard focus; the portal's `onFocus` checks `:focus-visible` so a mouse
click does not leave the bubble stuck.

Live verification (chromium, 1440×900, `/mission` with col 1 collapsed):
- All 11 rail `title` attributes are `null`; avatars carry `aria-label`s.
- Hover on an avatar renders exactly one `.tt-pop` in `BODY`, `role="tooltip"`,
  text "Runner 91 prompts proof", rect `[51,147,199,173]` against avatar
  `[12,144,44,176]` — 7px gap, vertically centered, fully inside the viewport
  (col 2 is overlapped by design, not by clipping).
- A real mouse click keeps the bubble while hovered and, after moving the
  pointer away, removes it (no sticky tooltip despite the click focusing the
  button).
- Tab from the head controls to the first avatar: `:focus-visible` true and the
  bubble shows the full name.
- Zero console messages; `npm run build` clean.


## Related
- SessionList.jsx uses the same pattern for row actions (lines 183-232): absolute positioned, `opacity-0` → `group-hover:opacity-100`, `pointer-events-none` when invisible
- This pattern should be reused for consistency