# 21 — Horse Brown Theme: Standardized Tokens + Light/Dark Modes

## Why

The UI colors are raw Tailwind utility classes (`slate-*`, `cyan-*`, status
colors) scattered across ~23 JSX files (~618 occurrences). Roles are mixed —
`bg-slate-800` is a card in one place and a hover fill in another, `slate-50` is
never even used. The app is dark-only, so nothing is theme-aware.

Two asks, one fix:

1. **Standardize all colors** into a small semantic token set so intent is in
   the code (`bg-panel`, `text-ink`, `border-line`) and the palette lives in ONE
   place.
2. **Both light and dark themes in horse brown** — this is only sane on top of
   the token system. Dark = "Espresso Barn", Light = "Sunlit Barn".

## Current State (measured, 2026-08-07)

- Tailwind v4 (`@import "tailwindcss"` in `index.css`), no config file, no
  `@theme` block yet.
- ~618 color-class occurrences in 23 files. Biggest files: AgentDetail (147),
  CommandsPane (136), Profile (133), Vault (98), SettingsTab (65), Terminal (63).
- Neutral surface/text tokens used (by prefix):
  - `bg`: slate-900 (24), slate-950 (29), slate-800 (59), slate-700 (51),
    slate-600 (7), slate-500 (2)
  - `text`: white (135), slate-100 (10), slate-200 (21), slate-300 (71),
    slate-400 (61), slate-500 (104), slate-600 (11)
  - `border`: slate-700 (66), slate-800 (41), slate-600 (11), divide-slate-700
  - `placeholder`: slate-600 (11), slate-500 (5)
- Accent is cyan: bg-cyan-500/600 (buttons), bg-cyan-900/950/800 (soft chips),
  text-cyan-400/300/200, border-cyan-500 (focus rings), ring-cyan-500.
- Status colors use many shades: red/amber/emerald 200–950 with assorted
  opacities, plus some blue/violet/rose/purple/teal in status maps.
- Non-class hexes: `Terminal.jsx:344` xterm theme, `Terminal.jsx:896`
  `bg-[#0f172a]`, `index.css` skeleton shimmer (`#1e293b`/`#334155`).
- Modal backdrops: `bg-black/60` (9 places).
- Color maps as JS objects: `lib/status.js` STATUS_META, `CommandsPane.jsx`
  COLORS, `Console.jsx` line-type colors.

## Design

### Theme switching mechanism

`data-theme="dark" | "light"` attribute on `<html>`. No-flash inline script in
`index.html` reads `localStorage['paddock-theme']` before paint (default dark,
preserving today's look). Toggle button lives in the `DashboardLayout` nav
(+ small floating toggle on the standalone Login page). A tiny `lib/theme.js`
module owns read/write/`toggleTheme()` and dispatches a `paddock:theme` window
event so the Terminal can restyle itself live.

### Token layer — `@theme inline` in `index.css`

Tailwind v4 pattern: utilities reference runtime CSS vars, so light/dark is a
pure CSS switch, no component changes per theme:

```css
@theme inline {
  --color-canvas:      var(--t-canvas);
  --color-panel:       var(--t-panel);
  ...
}

:root              { --t-canvas: #f6eeda; ... }        /* light */
[data-theme="dark"] { --t-canvas: #19120a; ... }        /* dark */
```

`@theme inline` gives us `bg-canvas`, `text-ink`, `border-line`,
`bg-accent/80`, etc. Opacity modifiers work via `color-mix()`.

### Token set

| Token | Was (dark) | Role |
|---|---|---|
| `canvas` | slate-900 | page background |
| `panel` | slate-800/900 | cards, nav, modals, inputs |
| `sunken` | slate-950 | terminal, dropdowns, code |
| `raised` | slate-700 | hover fills, secondary buttons, badges |
| `raised-hover` | slate-600 | hover on secondary |
| `line` | slate-700 | borders |
| `line-faint` | slate-800/600 | subtle borders, dividers |
| `ink` | white/slate-100/200 | primary text |
| `ink-muted` | slate-300 | secondary text |
| `ink-faint` | slate-400 | muted text |
| `ink-dim` | slate-500/600 | faintest text, placeholders |
| `accent` | cyan-500/600 | primary buttons, active states |
| `accent-hover` | cyan-400/500 | accent hover |
| `accent-deep` | blue-600 (gradient end) | gradient accent end |
| `accent-soft` | cyan-900/950/800 | tinted chips, selected rows |
| `accent-line` | cyan-400/500, ring-cyan-500 | accent borders, focus rings |
| `accent-text` | cyan-400/300/200 | accent text, links, icons |
| `accent-ink` | — (was white on cyan) | text ON accent buttons |
| `success` / `success-soft` / `success-line` | emerald-* | running/OK |
| `warning` / `warning-soft` / `warning-line` | amber-* | paused/stopping |
| `danger` / `danger-soft` / `danger-line` | red-* | exited/errors |
| `info` / `info-soft` / `info-line` | blue-* | created/restarting |
| `brand` / `brand-soft` / `brand-line` | violet/purple-* | admin badges, onboard |
| `overlay` | black/60 | modal backdrops |

Neutral `slate-*` surface/text/border tokens collapse to 10; status scales
(emerald/amber/red/blue/violet/rose/teal) collapse to the 4 `-soft/-line`
families above. `rose`/`teal` used only in command-group pills fold into
`danger`/`success` or stay as small named variants if needed — decide during
conversion, keep the token count low.

### Palettes

Dark — **Espresso Barn** (default):
```
canvas #19120a  panel #211710  sunken #100b05  raised #332416  raised-hover #453221
line #45301f    line-faint #2b1d11
ink #f1e7cf  ink-muted #d9c49a  ink-faint #b0946c  ink-dim #8d7350
accent #c98a1c  accent-hover #dd9f2a  accent-deep #8a5a12
accent-soft #4a2f12  accent-line #d99e33  accent-text #e2a832  accent-ink #1c1409
success #34d399 / soft #0d3329 / line #10b981
warning #fbbf24 / soft #3a2805 / line #a86a10
danger #f87171 / soft #3d1210 / line #b91c1c
info #60a5fa / soft #12263f / line #2563eb
brand #c4b5fd / soft #31224e / line #8b5cf6
overlay rgba(10,6,2,0.6)
```

Light — **Sunlit Barn**:
```
canvas #f6eeda  panel #fffdf6  sunken #efe4c8  raised #e8dbb9  raised-hover #dccb9f
line #d5c196    line-faint #e6d9b8
ink #2a1d0e  ink-muted #5c4426  ink-faint #7c613e  ink-dim #97794f
accent #a86a12  accent-hover #94590d  accent-deep #7d4c0d
accent-soft #f2d493  accent-line #c07d1d  accent-text #94590d  accent-ink #22160a
success #059669 / soft #d1fae5 / line #059669
warning #b45309 / soft #fef3c7 / line #b45309
danger #dc2626 / soft #fee2e2 / line #dc2626
info #2563eb / soft #dbeafe / line #2563eb
brand #6d28d9 / soft #ede9fe / line #7c3aed
overlay rgba(42,30,18,0.55)
```

Notes:
- **Gold accent buttons get dark text** (`accent-ink`) instead of white —
  white-on-gold fails contrast (~2.4:1), espresso-on-gold passes (~8:1). This is
  the one place where the visual identity intentionally shifts.
- Status solid colors get **darker shades in light mode** (emerald-400 → 600,
  amber-400 → 600, red-400 → 600) so they keep contrast on cream. Soft chips
  flip from dark-tinted (dark mode) to pale-tinted (light mode).
- Danger buttons keep light text (`ink` works on both red shades).

## Implementation

### Phase 0 — prep (done: inventory above)

### Phase 1 — `index.css` + `lib/theme.js` + `index.html`

1. Add the `@theme inline` block, `:root` light vars, `[data-theme="dark"]`
   vars to `index.css`. Convert the skeleton shimmer to vars.
2. Add no-flash script + `data-theme` default to `index.html`.
3. Add `lib/theme.js` (`getStoredTheme/applyTheme/initTheme/toggleTheme`,
   `paddock:theme` event).

### Phase 2 — scripted class conversion

Per-file `sed`-style replacement using the exact mapping below, ordered so
prefixes don't clobber (longer/specific strings first). Then manual review of
the context-sensitive buckets. All files under `src/client/src/**/*.jsx`.

Mapping (from-class → to-class):
```
text-white            text-ink
text-slate-100        text-ink
text-slate-200        text-ink
text-slate-300        text-ink-muted
text-slate-400        text-ink-faint
text-slate-500        text-ink-dim
text-slate-600        text-ink-dim
placeholder-slate-500 placeholder-ink-dim
placeholder-slate-600 placeholder-ink-dim
border-slate-700      border-line
border-slate-800      border-line-faint
border-slate-600      border-line-faint
divide-slate-700      divide-line
ring-offset-slate-900 ring-offset-canvas
bg-slate-950          bg-sunken
bg-slate-800          bg-panel
bg-slate-700          bg-raised
hover:bg-slate-600    hover:bg-raised-hover   (before plain bg-slate-600)
bg-slate-600          bg-raised
bg-slate-500          bg-line                  (status dots, manual)
bg-slate-900          → canvas or sunken       (manual, 24 spots: page/nav=canvas, modals=panel, dropdowns/terminal=sunken)
bg-cyan-500/600/400   bg-accent
hover:bg-cyan-400/500 hover:bg-accent-hover
bg-cyan-700/800/900/950 bg-accent-soft
disabled:bg-cyan-800  disabled:bg-accent-soft
text-cyan-400/300/200 text-accent-text
border-cyan-400/500   border-accent-line
border-cyan-700/800   border-accent-line
ring-cyan-500         ring-accent-line
from-cyan-600         from-accent        to-blue-600   to-accent-deep
hover:from-cyan-500   hover:from-accent-hover
shadow-cyan-900/30    shadow-accent/25
text-emerald-200/300/400  text-success
bg-emerald-400/500/600    bg-success
bg-emerald-8*/9*/95* (any opacity)  bg-success-soft
border-emerald-700/800    border-success-line
text-amber-200/300/400    text-warning
bg-amber-400/500/600      bg-warning
bg-amber-7*/8*/9*/95*     bg-warning-soft
border-amber-*            border-warning-line
text-red-200/300/400      text-danger
bg-red-400/500/600        bg-danger
bg-red-7*/8*/9*/95*       bg-danger-soft
border-red-*              border-danger-line
bg-black/60               bg-overlay
purple/violet/rose/teal/blue in status maps → brand/info/danger/success families
```

Context-sensitive buckets to eyeball after the scripted pass:
1. `bg-slate-900` (24) — decide canvas/panel/sunken per spot.
2. Accent buttons — add `text-accent-ink` (replacing the auto-mapped `text-ink`)
   on gold submit buttons (Login, CreateAgent gradient, Onboard submit uses
   brand).
3. `lib/status.js` STATUS_META — rewrite pills/dots with semantic tokens
   (running→success, exited→danger, paused→warning, created/restarting→info,
   removing→brand, dead→danger, missing→neutral `bg-line`).
4. `CommandsPane.jsx` COLORS map — map groups to the closest semantic family.
5. `Console.jsx` line colors — cmd→accent-text, err→danger, out→ink-muted,
   ts/sys→ink-dim.
6. Toggle knob `bg-white` in SettingsTab — keep (white reads on both accent
   tracks).
7. `bg-slate-500`/`bg-slate-600` dots → `bg-line`.

### Phase 3 — theme toggle UI

1. `DashboardLayout.jsx`: sun/moon toggle button in the nav (top-right),
   `useState` mirror of current theme, calls `toggleTheme()`.
2. `Login.jsx`: small floating toggle (it renders without DashboardLayout).
3. Root div in DashboardLayout switches `text-slate-100` → `text-ink` and
   `bg-slate-900` → `bg-canvas` (part of Phase 2).

### Phase 4 — Terminal + misc

1. `Terminal.jsx:344` xterm theme reads the CSS vars
   (`getComputedStyle(document.documentElement)` on `--t-canvas/ink/accent-text/...`),
   listens to `paddock:theme` and applies `term.options.theme` + refresh.
2. `Terminal.jsx:896` `bg-[#0f172a]` → `bg-sunken`.
3. `index.css` skeleton shimmer → `var(--t-panel)` / `var(--t-raised)`.

### Phase 5 — build, verify, ship

```bash
docker exec paddock-webui sh -c 'cd /app/client && npm run build'
docker restart paddock-webui   # or compose up -d --force-recreate
```

Test plan (browser MCP at http://10.69.1.164:6789):
- Toggle light/dark, confirm localStorage + no flash on reload.
- Walk the main pages in BOTH themes: Dashboard, Agent detail (all tabs —
  terminal, console, commands, settings), Create, Vault, Backups, Profile,
  Login, Onboard, Setup.
- Verify: text contrast on canvas/panel, gold buttons readable, status pills
  in both modes, xterm theme follows the toggle, modal overlays visible,
  skeleton shimmer, no leftover `slate-*`/`cyan-*`/`red-*` classes in the build
  (`rg` sweep over src, then `rg 'slate|cyan-' public/assets/*.css`).
- Run `node --test test/` (services.test.js) to confirm nothing backend broke
  (should be untouched).

## Risks / gotchas

- **Tailwind v4 + `@theme inline`**: opacity modifiers (`bg-panel/80`) compile
  to `color-mix()` against the runtime var — works, but verify a couple of
  translucent spots (nav blur, overlays).
- **`text-ink` on accent buttons**: the global `text-white → text-ink` pass
  makes gold buttons wrong; the manual `text-accent-ink` fix must not be
  skipped.
- **Status shade collapse**: dozens of `red-900/30`-style chips collapse to one
  `danger-soft` token. Dark-mode look changes slightly (was alpha-tinted, now a
  solid soft tone). Acceptable — it's the "standardization" trade.
- **Live theme on terminal**: xterm re-theme needs `term.options.theme = {...}`
  then a refresh; do it on the `paddock:theme` event, not a re-mount.
- **Node caches `require()`**: frontend is Vite-bundled so no webui restart
  needed for JSX changes, but a build + restart is still the safe end-to-end
  verification.
- **Keep scope tight**: no layout/markup changes, pure class swaps. Anything
  that looks broken after conversion should be fixed with a token tweak in
  `index.css`, not a class rewrite.
