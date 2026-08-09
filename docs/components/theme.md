# Design Guidelines — Horse Brown Theme (light + dark)

## The one rule

Every color in the panel lives in `src/client/src/styles/palette.css` as a
`--t-*` custom property, in two modes: **Sunlit Barn** (light) and
**Espresso Barn** (dark). Components use only semantic Tailwind tokens
(`bg-panel`, `text-ink`, `border-line`, `bg-accent`, …). To change the look of
the whole app, edit hex values in `palette.css` only — never a component class.

## How the layers stack

```
styles/palette.css       ← the palette, --t-* custom props, both modes
    │  (Tailwind v4 @theme inline in index.css maps them)
bg-canvas, text-ink, border-line, bg-accent/80, ...
    │  (components use ONLY these)
the rendered app
```

- `src/client/src/styles/palette.css` — the palette (owned here).
- `src/client/src/index.css` — `@theme inline` mapping + `@import "tailwindcss"`.
- `src/client/src/lib/theme.js` — mode read/write/toggle + `paddock:theme` event.
- `src/client/index.html` — no-flash `data-theme` script (reads
  `localStorage['paddock-theme']`, default dark).
- `DashboardLayout.jsx` — nav toggle (sun/moon). `Login.jsx` — floating toggle
  (renders without the layout).

## Mode mechanism

- `data-theme="dark" | "light"` attribute on `<html>`.
- Default is **dark** (day-one visuals stay close to the old slate look).
- `applyTheme()` sets the attribute, persists to
  `localStorage['paddock-theme']`, and dispatches a `paddock:theme` window
  event so listeners can restyle live.
- `@theme inline` references runtime CSS vars, so light/dark is a pure CSS
  switch — no component changes per theme. Opacity modifiers
  (`bg-panel/80`) compile to `color-mix()`.

## Typography

- UI font is **Bitter** (classic warm slab serif — the "horse" feel), loaded
  from Google Fonts at the top of `src/client/src/index.css`
  (`@import url('https://fonts.googleapis.com/css2?family=Bitter:wght@400;500;600;700&display=swap')`).
- `--font-sans` in `@theme inline` maps Bitter to Tailwind's `font-sans`, and
  a `body { font-family: ... }` rule sets it as the base UI font.
- To change the font, swap all three spots (the `@import`, `--font-sans`, and
  the `body` rule) to the new family — keep weights 400/500/600/700, matching
  what components use (`font-medium`, `font-semibold`, `font-bold`).
- `font-mono` stays Tailwind's default stack for code/terminal/IDs — never
  theme the terminal, including its font.

## Semantic tokens

| Token | Role |
|---|---|
| `bg-canvas` | page background |
| `bg-panel` | cards, nav, modals, inputs |
| `bg-sunken` | terminal, code, dropdowns |
| `bg-raised` / `bg-raised-hover` | hover fills, secondary buttons |
| `text-ink` / `text-ink-muted` / `text-ink-faint` / `text-ink-dim` | text scale |
| `border-line` / `border-line-faint` / `divide-line` | borders, dividers |
| `placeholder-ink-dim` | inputs |
| `bg-accent` / `hover:bg-accent-hover` | primary buttons, active states |
| `text-accent-text` | accent text, links, icons |
| `border-accent-line` / `ring-accent-line` | accent borders, focus rings |
| `bg-accent-soft` | tinted chips, selected rows |
| `text-accent-ink` | text ON accent buttons |
| `from-accent` / `to-accent-deep` | gradients |
| `success` + `-soft` + `-line` + `-ink` | running, OK |
| `warning` + `-soft` + `-line` + `-ink` | paused, stopping |
| `danger` + `-soft` + `-line` + `-ink` | exited, errors |
| `info` + `-soft` + `-line` + `-ink` | created, restarting |
| `brand` + `-soft` + `-line` + `-ink` | admin badges, onboard |
| `bg-overlay` | modal backdrops |

Status families come in four shades: the solid color (`-ink` text on it), a
`-soft` tinted chip, a `-line` border, and an `-ink` foreground color for text
on the solid fill.

## Contrast rules

- **Gold accent buttons carry dark text** (`text-accent-ink`) in dark mode —
  white-on-gold fails contrast. (Light mode currently uses `--t-accent-ink:
  #ffffff`.) Accent buttons: `bg-accent text-accent-ink hover:bg-accent-hover`.
- Status solid colors get **darker 600-ish shades in light mode** and bright
  400-ish shades in dark mode so they keep contrast on cream vs. espresso.
  Soft chips flip from dark-tinted (dark) to pale-tinted (light).
- Danger buttons keep light text — `ink` works on both red shades.

## Don'ts

- **No raw Tailwind color utilities** (`slate-*`, `cyan-*`, `red-*`,
  `emerald-*`, …) in components. The old raw-class pass (~618 occurrences in
  23 files) was the whole problem. If a needed shade is missing, add a token.
- **Never re-theme the terminal.** xterm keeps its DEFAULT colors — it does
  NOT follow the theme toggle. The themed `xtermTheme()` and the
  `paddock:theme` listener were removed from `Terminal.jsx` by request; the
  shell stays black-on-white in both modes. Do not re-add it.
- **No Sass.** The project uses plain CSS (Tailwind v4); CSS variables already
  do everything.
- If something looks off, fix the token value in `palette.css`, not the
  component class.

## Skeleton shimmer + scrollbars

- `.skeleton` shimmer uses `var(--t-panel)` / `var(--t-raised)` (in
  `index.css`), so it themes automatically.
- Custom scrollbars are token-driven too (`--t-raised` /
  `--t-raised-hover`), theme-aware in both modes.
