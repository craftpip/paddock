# Plan 71 — Terminal session tabs: true tab look, overlay close, matched + / × sizing

## Status: Complete (2026-10-19) — 5/5 items done and live-verified. Item 4 was resolved by the user as a stray keystroke (no fourth issue).

## 1. Request (user verbatim, 2026-09-29)

> note down few bugs in the terminal component,
> in the tabs / terminal sessions UI
> 1. show tabs but the current tab role="tab" sits in a eleemnt that has its own padding, -> i want the tab to stick to the bottom of the div, like howtabs do, make it look like tabs
> 2. show close button as overlay  it should not take space in the div,
> 3. the close button and the plus button should be same size and make it little bigger,
> 4.

Update 2026-09-29:

> the terimal bar where the tabs are make it leaner, currently its height is too much, the tabs added its own padding and theres padding in the parent too

Item 4 arrived as an empty trailing bullet, so it is recorded below as TBD and
confirmed with the user before building.

## 2. Current shape (read 2026-09-29, not guessed)

- Strip lives in `src/client/src/components/Terminal.jsx:1045-1134`: header row
  is `flex items-center gap-3 px-4 py-2 border-b`, tablist is
  `flex flex-1 min-w-0 items-center gap-1 overflow-x-auto` (`tabListRef`).
- Each tab is a `div role="tab"` at `:1074`:
  `group flex max-w-40 shrink-0 cursor-pointer items-center gap-1 px-2.5 py-1
  text-xs font-mono`, active state is only
  `text-ink shadow-[inset_0_-2px_0_0_var(--t-accent)]`, inactive is
  `text-ink-dim hover:text-ink hover:bg-raised/40`.
- Close is a `Button variant="ghost" size="sm" icon` at `:1098-1108` with literal
  `×`, classes `shrink-0 … opacity-0 group-hover:opacity-100 … leading-none` —
  in-flow flex child, so it reserves width (the complaint in item 2) and is
  keyboard-unreachable until revealed (same trap as AGENTS.md "Hidden has three
  meanings": `display:none` can't take focus; `opacity-0` in-flow still reserves
  space and still takes clicks).
- New-tab `+` is a sibling `Button variant="ghost" size="sm" icon` at
  `:1112-1122` — same `size="sm"` recipe as close today, `sm.icon` pins
  `width: 1.75rem` via `SIZES` (`src/client/src/components/ui/Button.jsx:44-52`),
  so "same size but bigger" means growing both together, not restyling one.
- Header `py-2` on the outer bar (`:1045`) is the padding item 1 complains about:
  the tab's `py-1` + bar's `py-2` leaves the active underline floating above the
  `border-b`, instead of sitting on it like a real tab. The 2026-09-29 update
  folds into the same cause: bar height = parent `py-2` + tab `py-1` stacked, so
  the fix is one shared height, not two paddings.

## 3. Build

- [x] Item 1 — true tabs: make the active `role="tab"` stick to the bottom of
      the header bar so its accent underline sits on the bar's `border-b`.
      Remove the gap between tab bottom and bar bottom (header `py-2` /
      `items-center` vs tab `py-1` is the current offset), keep inactive tabs on
      the same baseline. Verify visually in the browser, not by reading JSX.
- [x] Item 2 — overlay close: take the `×` out of flow (`absolute`, no reserved
      width) so the label never reflows on hover/focus reveal; keep it
      focusable (never `display:none`), keep `pointer-events-none` while
      invisible so clicks aimed at the label don't hit the invisible button,
      and fade the covered label end instead of overlapping it. Assert with
      `document.elementFromPoint` at the label's coordinates in idle state, on a
      row without `:hover`/`:focus` (per the AGENTS.md overlay rule).
- [x] Item 3 — matched, slightly bigger `×` / `+`: give close and plus the same
      box (same `Button` size/variant + same explicit `h-* w-*`), bump one step
      above today's `size="sm" icon` (1.75rem) while staying inside the header
      height; keep both as `ghost icon` so hover treatment matches. Check the
      two boxes measure equal in `getBoundingClientRect`.
- [x] Item 4 — resolved 2026-10-19: the user confirmed the empty bullet was a stray keystroke, so there was no fourth issue.
- [x] Item 5 (update 2026-09-29) — leaner tab bar: collapse the double padding
      (bar `py-2` + tab `py-1`) into a single tab-owned height so the bar is only
      as tall as the tabs need. Bar keeps `px-4` sides but no vertical padding;
      tabs own the height (`py-*` on the tab only, stretched to bar bottom via
      `items-stretch` / `self-end`). Measure bar height before/after in the
      browser; tabs must still stick to the bottom (item 1) after the shrink.

## 4. Verify

- `cd src/client && npm run build` + `docker restart paddock`, then load the
  agent-detail terminal tab live (per AGENTS.md golden rule: prove it in the
  browser at `http://10.69.1.164:6789`).
- Click every affected control after any refactor that moves state/handlers
  across components (AGENTS.md: free variables in JSX throw only on click).
- Run the relevant test file individually (`timeout 60 docker exec paddock node
  --test test/<file>.test.js`), never the combined suite.
- On absorb: file under `docs/reference/tabs/terminal.md`, remove this file.
