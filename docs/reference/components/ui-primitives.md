# UI Primitives

`src/client/src/components/ui/` is the only sanctioned way to render a control.
A page writes `<Button variant="primary" size="sm">`, never a class string. If a
control needs something the props do not cover, **add a variant** — do not pass a
`className` to re-implement the recipe.

`src/client/src/components/ui/README.md` is the same contract at the point of
use, next to the code. This page is the reference for what each primitive owns
and why.

> Last updated: 2026-09-28

## The three layers

| Layer | File | Owns |
|---|---|---|
| 1 palette | `src/client/src/styles/palette.css` | every color, as `--t-*`, both modes |
| 2 scale | `src/client/src/index.css` `@theme` / `@utility` | radius, control heights, focus ring, shadows |
| 3 primitives | `src/client/src/components/ui/` | the recipe per control |

Change a **color** → layer 1. Change a **shape** → layer 2. Change a
**recipe** → layer 3. Nothing below layer 3 hardcodes a color or a dimension.

`cx()` (`src/client/src/lib/cx.js`) is `clsx` + `tailwind-merge@3.7.0`, and it
decides which conflicting utility survives. Layer 2 defines the scale tokens —
`rounded-control` / `rounded-card` / `rounded-pill`, `ctl-sm` / `ctl-md` /
`ctl-lg`, and the `focus-ring` utility (a `box-shadow` on `--t-accent-line` that
applies on `:focus`, not only `:focus-visible`).

## The primitives

### `Button`

`variant`: `primary` (accent fill) · `secondary` (raised surface, **default**) ·
`ghost` (no fill until hover) · `danger` (solid) · `dangerGhost` (tinted) ·
`accentGhost` (accent-tinted, for tab/filter pills) · `link` / `dangerLink`
(inline micro text action, no fill or height — a row's `edit`/`del`) ·
`dangerSoft` (tinted danger chip, an inline confirm's "Delete") · `none`
(**no recipe at all** — the caller supplies the fill conditionally, e.g. a
selected vs unselected list item).

`size`: `sm` (28px) · `md` (36px, **default**) · `lg` (44px) · `bare` (**no
control height and no font size** — the dense-listing scale, where a 28px
control would make every row taller than its content).

Flags: `icon` (square, no side padding) · `block` (`w-full`) · `loading`
(disables the button and sets `aria-busy`).

`type` defaults to `"button"`. A bare `<button>` inside a `<form>` submits it,
and this app has 9 forms. Pass `type="submit"` when you mean it.

Two variants exist because of specific failures, not for symmetry:

- `none` — an unknown variant string falls back to `secondary` and adds a
  `border` nobody asked for. A conditional fill needs no recipe.
- `bare` — `icon` pins a width from the size table, which overrides a caller's
  own `h-8 w-8`. On `bare` there is no size to pin from, so the caller's box
  governs and only `px-0` applies.

### `Input` · `Textarea` · `Select`

Exported from `Input.jsx`. `size`: `sm` · `md` · flags: `mono` (IDs, paths,
commands) · `invalid` (danger border, drops the focus ring's accent).

One surface (`bg-sunken`), one border (`border-line`) and one focus treatment
(`focus-ring`) across all three.

`Select` wraps the native `<select>` in a `relative` span and draws its own
chevron with `select-chevron`, a **mask**, so the chevron's color comes from
`--t-ink-dim` and follows the mode. A `background-image` data URI cannot do
this — it is an isolated document that cannot read `currentColor`, so it would
need a hardcoded hex and be wrong in one mode.

### `Checkbox`

Also from `Input.jsx`. A real `<input type="checkbox">` styled with
`accent-accent`, so the native keyboard and form behavior is untouched. `size`:
`sm` (14px) · `md` (16px) · `indeterminate` (sets the DOM property through the
ref, which markup cannot express).

### `Field`

`label` + `hint` + `error` + `required`. It owns the label's own markup so the
`block`/`mb-1.5` cannot be forgotten — 7 of 19 labels were missing both, which
shrank their click target to the text.

### `Card`

`title` · `actions` · `plain` (recessed well, no shadow).

### `Badge`

`tone`: `neutral` · `accent` · `success` · `warning` · `danger` · `info` ·
`brand` · `variant`: `soft` (**default**) · `solid` · `outline` · `size`:
`sm` · `md`.

`src/client/src/components/ui/tone.js` holds the tone→class table, shared with
toasts and the inline error/warning banners. It is a table and not a template
string on purpose: a **solid** fill must use its own `-ink` token, never
`text-ink`, because in dark mode `bg-accent text-ink` is cream text on orange.

### `Choice`

A compact pick-one-or-pick-a-path control: the agent picker in the project
dialog, folder chips, the Mission project rail. `selected` sets `aria-pressed`.
`variant`: `option` (bordered, sunken — choosing between real options) · `chip`
(borderless raised fill — quick path/type tags) · `size`: `sm` · `md` · `mono`.

It exists because its defining feature is the `selected` state, which a `Button`
cannot express.

### `Modal`

`open` · `onClose` (omit it for a dialog that must be answered) · `title` ·
`tone="danger"` · `width` · `z` · `footer`. Escape and backdrop-click both close
when `onClose` is set.

`z` is a prop because dialogs nest: a confirm (`z-[80]`) must sit above the
dialog that raised it (`z-50`). Vault and SettingsTab use `z-[75]` for two-step
flows.

### `Switch`

The on/off toggle for a settings row. `checked` (controlled — the primitive
never stores state) · `onChange(nextBoolean)` · `label` (→ `aria-label`) ·
`disabled` · `title`.

It owns `type="button"`, `role="switch"`, `aria-checked`, the toggle, the focus
ring, and the geometry: a 40×24 track, a 20px knob, 16px of travel. `onChange`
receives the **next** value, so `onChange={setAllowDocker}` is the whole
handler. A handler that ignores the argument and recomputes from its own state
(`const on = !sshEnabled`) is equally fine.

`label` is effectively required. These sit in a settings row whose visible text
is not associated with the button, so without it the control has no accessible
name. Configs passes `LABELS[key].label`; the label prop in `Field` is a
different thing and does not reach it.

The state comes from `checked`, never from the caller's classes. The Web tab's
two switches only mount while the feature is on, so they hardcoded `bg-accent`;
passing `checked={active}` looks identical today and cannot lie later.

Callers:

| Site | Switch |
|---|---|
| `pages/CreateAgent.jsx` | Advanced settings, Allow docker |
| `pages/agent/SettingsTab.jsx` | Allow docker, Custom workspace folder |
| `pages/agent/WebTab.jsx` | Published, Exposed |
| `pages/Configs.jsx` | every `type: 'toggle'` config row (4 today) |

## Rules

1. **`className` goes last and wins.** `cx()` runs `tailwind-merge`, so a
   caller's class beats the primitive's base instead of both being emitted and
   the winner decided by stylesheet order. That is what makes
   `<Button className="w-full">` legal. A primitive's `base()` must not accept
   `className`; each component ends its own `cx(base(...), structure, className)`.
2. **Never delete an `msn-*` class.** Those are pure browser-test hooks. They
   carry no styles; they are how the tests find an element. Every primitive
   forwards `className` so a hook lands on the exact element that has it today.
3. **Never re-theme the terminal.** xterm keeps its default colors; the themed
   `xtermTheme()` and its `paddock:theme` listener were removed by request.
4. **A missing color token is dropped SILENTLY** — no build error, no class in
   the CSS, and it fails only in dark mode. A new token goes in BOTH
   `palette.css` and the `@theme inline` block, then gets verified by grepping
   the built `src/public/assets/index-*.css`.
5. **Do not migrate a control's look.** Fold the existing spelling in first;
   converge on one spelling per control, then judge appearance separately.
6. **A dense listing gets its own control scale.** Do not force the form scale
   onto it: `Button`'s `ctl-sm`/`ctl-md` min-heights would make every Mission
   project row taller than its content. That is what `size="bare"` is for.

## See Also

- [Horse Brown theme](theme.md) — the palette, both modes, and the contrast
  rules behind the tokens
- [Shared UX utilities](ux.md) — confirm, alert, and prompt dialogs, toasts,
  keyboard shortcuts
- `plans/53-mission-workspace.md` §6 — the canonical `msn-*` hook list that
  rule 2 protects; that plan is the Mission workspace's own reference
