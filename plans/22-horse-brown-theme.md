# 22 — Horse Brown Theme (CSS Variables, Light + Dark)

> Supersedes `21-horse-brown-theme.md`. Same goal, no new tooling: the palette
> is authored once as plain CSS custom properties, and exposed to components as
> semantic Tailwind tokens. **No Sass** — the project uses plain CSS (Tailwind
> v4), and CSS variables already do everything we need.

## What

1. **You own the palette.** One CSS file (`styles/palette.css`) holds every
   color in the panel, organized as horse-brown variables for two modes.
2. **Two modes.** Light ("Sunlit Barn") and dark ("Espresso Barn"), both brown.
   Toggle lives in the nav, choice persists, no flash on reload.
3. **Standardized colors.** Today the UI has ~618 raw Tailwind classes
   (`bg-slate-800`, `text-cyan-400`, `bg-red-900/50`, …) scattered across 23
   JSX files, with mixed roles. After this, components only ever use ~30
   semantic tokens (`bg-panel`, `text-ink`, `border-line`, `bg-accent`, …). The
   palette lives in exactly one place.

## How the layers stack

```
styles/palette.css      ← YOU write horse-brown values as CSS custom props
    --t-canvas, --t-panel, ... (dark values on :root / light values + dark block)
        │  (Tailwind v4 @theme inline maps them)
bg-canvas, text-ink, border-line, bg-accent/80, ...
        │  (components use ONLY these)
the rendered app
```

No SCSS needed: CSS custom properties ARE the variables. `@theme inline`
binds them to Tailwind utilities, and `[data-theme="dark"]` swaps the values at
runtime — components never change between modes.

## Files

```
src/client/src/styles/palette.css       NEW — the palette (yours)
src/client/src/index.css                EDIT — @theme inline mapping + tailwind import
src/client/src/lib/theme.js             NEW — mode read/write/toggle + event
src/client/index.html                   EDIT — no-flash data-theme script
src/client/src/components/DashboardLayout.jsx   EDIT — nav toggle button
src/client/src/pages/Login.jsx          EDIT — floating toggle (standalone page)
src/client/src/components/Terminal.jsx  EDIT — xterm theme follows the mode
src/client/src/**/*.jsx                 EDIT — class conversion to tokens
```

## The token set (what components will use)

Neutral surfaces & text:

| Token | Role |
|---|---|
| `bg-canvas` | page background |
| `bg-panel` | cards, nav, modals, inputs |
| `bg-sunken` | terminal, dropdowns, code |
| `bg-raised` / `bg-raised-hover` | hover fills, secondary buttons |
| `text-ink` / `text-ink-muted` / `text-ink-faint` / `text-ink-dim` | text scale |
| `border-line` / `border-line-faint` / `divide-line` | borders, dividers |
| `placeholder-ink-dim` | inputs |

Horse-brown accent:

| Token | Role |
|---|---|
| `bg-accent` / `hover:bg-accent-hover` | primary buttons, active states |
| `text-accent-text` | accent text, links, icons |
| `border-accent-line` / `ring-accent-line` | accent borders, focus rings |
| `bg-accent-soft` | tinted chips, selected rows |
| `text-accent-ink` | text ON accent buttons (dark on gold) |
| `from-accent` / `to-accent-deep` | gradients |

Status (semantic, both modes):

| Token | Was | Used for |
|---|---|---|
| `success` + `success-soft` + `success-line` | emerald-* | running, OK |
| `warning` + `warning-soft` + `warning-line` | amber-* | paused, stopping |
| `danger` + `danger-soft` + `danger-line` | red-* | exited, errors |
| `info` + `info-soft` + `info-line` | blue-* | created, restarting |
| `brand` + `brand-soft` + `brand-line` | violet/purple-* | admin badges, onboard |
| `bg-overlay` | black/60 | modal backdrops |

Every one of the ~618 current classes maps onto this set. The dozens of
`red-900/30`-style shades collapse into one `danger-soft` token.

## Suggested starting palette (horse brown)

Dark — **Espresso Barn** (default mode, keeps today's look):

```css
:root /* light values below */ ;

/* dark */
[data-theme="dark"] {
  --t-canvas:        #19120a;   /* deep espresso  page bg */
  --t-panel:         #211710;   /* card / nav / modal */
  --t-sunken:        #100b05;   /* terminal / code / dropdown */
  --t-raised:        #332416;   /* hover fills */
  --t-raised-hover:  #453221;
  --t-line:          #45301f;
  --t-line-faint:    #2b1d11;
  --t-ink:           #f1e7cf;   /* cream primary text */
  --t-ink-muted:     #d9c49a;
  --t-ink-faint:     #b0946c;
  --t-ink-dim:       #8d7350;   /* placeholders */
  --t-accent:        #c98a1c;   /* saddle-gold buttons */
  --t-accent-hover:  #dd9f2a;
  --t-accent-deep:   #8a5a12;
  --t-accent-soft:   #4a2f12;
  --t-accent-line:   #d99e33;
  --t-accent-text:   #e2a832;
  --t-accent-ink:    #1c1409;   /* text on gold buttons */
}
```

Light — **Sunlit Barn**:

```css
:root {
  --t-canvas:        #f6eeda;   /* cream walls */
  --t-panel:         #fffdf6;   /* cards */
  --t-sunken:        #efe4c8;
  --t-raised:        #e8dbb9;
  --t-raised-hover:  #dccb9f;
  --t-line:          #d5c196;
  --t-line-faint:    #e6d9b8;
  --t-ink:           #2a1d0e;   /* espresso text */
  --t-ink-muted:     #5c4426;
  --t-ink-faint:     #7c613e;
  --t-ink-dim:       #97794f;
  --t-accent:        #a86a12;   /* deep saddle brown */
  --t-accent-hover:  #94590d;
  --t-accent-deep:   #7d4c0d;
  --t-accent-soft:   #f2d493;
  --t-accent-line:   #c07d1d;
  --t-accent-text:   #94590d;
  --t-accent-ink:    #22160a;
}
```

Status colors (one table, two shades): light mode uses darker 600-ish shades for
contrast on cream, dark mode keeps bright 400-ish shades.

## Phase plan

1. **Palette + tokens.** Create `styles/palette.css` (the `--t-*` custom
   properties above); import it into `index.css` alongside
   `@import "tailwindcss"` and the `@theme inline` token mapping. Skeleton
   shimmer in `index.css` switches to tokens. No new dependencies.
2. **Mode plumbing.** `lib/theme.js` (read/write/toggle + `paddock:theme`
   event), no-flash script + `data-theme` default in `index.html`.
3. **Class conversion.** Scripted `from-class → to-class` pass across all JSX
   files using the mapping above, then manual review of context-sensitive spots
   (`bg-slate-900` page-vs-modal, gold buttons getting `text-accent-ink`, the
   JS color maps in `lib/status.js`, `CommandsPane.jsx`, `Console.jsx`).
4. **Toggle UI.** Nav button in `DashboardLayout`, floating toggle on `Login`.
5. **Terminal.** xterm theme reads the CSS vars and re-applies on mode change;
   `bg-[#0f172a]` → `bg-sunken`.
6. **Verify.** Build (`npm run build` inside the webui container), restart,
   walk every page in both modes via browser MCP (contrast, gold buttons,
   status pills, terminal follows toggle, no leftovers — `rg` sweep for
   `slate|cyan-|red-900` etc. across src and the built CSS).

## Rules while doing it

- Pure class swaps only — no layout or markup changes.
- If something looks off after conversion, fix the token value in
  `styles/palette.css`, not the component class.
- Default mode is dark, so day-one visuals stay close to today.
- Gold accent buttons carry dark text (`accent-ink`) — white-on-gold fails
  contrast.
