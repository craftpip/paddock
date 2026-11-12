# UI primitives — the style contract

`src/client/src/components/ui/` is the only sanctioned way to render a
control. A page writes `<Button variant="primary" size="sm">`, never a class
string. If a control needs something these props do not cover, **add a variant**
— do not pass a className to re-implement the recipe.

## The three layers

| Layer | File | Owns |
|---|---|---|
| 1 palette | `styles/palette.css` | every color, as `--t-*`, both modes |
| 2 scale | `index.css` `@theme` / `@utility` | radius, control heights, focus ring, shadows |
| 3 primitives | `components/ui/*` | the recipe per control |

Change a **color** → layer 1. Change a **shape** → layer 2. Change a
**recipe** → layer 3. Nothing below layer 3 hardcodes a color or a dimension.

## Components

### `Button`
`variant`: `primary` (accent fill) · `secondary` (raised surface, **default**) ·
`ghost` (no fill until hover) · `danger` (solid) · `dangerGhost` (tinted) ·
`accentGhost` (accent-tinted, for tab/filter pills) ·
`link` / `dangerLink` (inline micro text action, no fill or height — a row's
`edit`/`del`) · `dangerSoft` (tinted danger chip, an inline confirm's "Delete") ·
`none` (**no recipe at all** — the caller supplies the fill conditionally, e.g.
a selected vs unselected list item; without this an unknown variant string falls
back to `secondary` and adds a border nobody asked for)

`size`: `sm` (28px) · `md` (36px, **default**) · `lg` (44px) ·
`bare` (**no control height, no font size** — the dense-listing scale, where a
28px control would make every row taller than its content; the caller's own
`h-8 w-8` / `py-1` governs, while shape — radius, focus ring, weight — stays
centralized)

flags: `icon` (square + no side padding; width is pinned from `size`, except on
`bare` where the caller's box governs) · `block` (`w-full`) ·
`loading` (disables + `aria-busy`)

`type` defaults to `"button"`. This is deliberate: a bare `<button>` inside a
`<form>` submits it, and this app has 9 forms. Pass `type="submit"` when you
mean it.

### `Input` · `Textarea` · `Select` (from `Input.jsx`)
`size`: `sm` · `md` · flags: `mono` (font-mono — IDs, paths, commands) ·
`invalid` (danger border, drops the focus ring's accent)

One surface (`bg-sunken`), one border (`border-line`), one focus treatment
(`focus-ring`) across all three. The old code had 25+ spellings that disagreed
on the surface alone — `bg-raised` in 8 places, `bg-sunken` in the rest.

`Select` wraps the native `<select>` in a `relative` span and draws its own
chevron with `select-chevron` (a **mask**, so its colour comes from
`--t-ink-dim` and follows the mode). A `background-image` data URI cannot do
this — it is an isolated document that cannot read `currentColor`, so it would
need a hardcoded hex and be wrong in one mode. Do not "simplify" it back.

### `Field`
`label` + `hint` + `error` + `required`. Owns the label's own markup, so the
`block`/`mb-1.5` cannot be forgotten again (it was: 7 of 19 labels were
missing both, which shrank their click target to the text).

### `Card`
`title` · `actions` · `plain` (recessed well — no shadow).

### `Badge`
`tone`: `neutral` · `accent` · `success` · `warning` · `danger` · `info` ·
`brand` · `variant`: `soft` (**default**) · `solid` · `outline` ·
`size`: `sm` · `md`

The tone→class table is not a template string on purpose. A **solid** status
fill must use its own `-ink` token, never `text-ink` — in dark mode
`bg-accent text-ink` is cream text on orange, which is how the whole Mission
page once ended up unreadable.

### `Modal`
`open` · `onClose` (omit for a dialog that must be answered) · `title` ·
`tone="danger"` · `width` · `z` · `footer`.
Escape and backdrop-click both close when `onClose` is set.

`z` is a prop because dialogs nest: a confirm (`z-[80]`) must sit above the
dialog that raised it (`z-50`). Vault and SettingsTab use `z-[75]` for two-step
flows.

### `Switch`
`checked` (controlled — the primitive never stores state) · `onChange(nextBoolean)` ·
`label` (→ `aria-label`, **required in practice**: these sit in a settings row
whose visible text is not associated with the button) · `disabled` · `title`.

Owns `type="button"`, `role="switch"`, `aria-checked`, the toggle, the focus
ring, and the geometry — 40×24 track, 20px knob, 16px travel. The primitive was
built from seven hand-written toggles that had drifted into two geometries
(Configs was 44×24 with a 16px knob), two knob colours, four missing focus
rings, and one (`Configs`) with no `role`/`aria-checked` at all.

**State comes from `checked`, never from the caller's classes.** The Web tab's
two switches only mount while the feature is on, so they used to hardcode
`bg-accent`; passing `checked={active}` looks the same today and cannot lie
tomorrow.

**The knob is `bg-white`, and that is a deliberate exception to the palette
layers.** Every light-looking surface token goes dark in dark mode, and a dark
knob on the dark `bg-raised` off-track nearly vanishes — `bg-panel` in
`CreateAgent` had exactly that bug. `--t-accent-ink` is white in light mode and
near-black in dark, so it fails the other way. A physical toggle cap stays light
in both modes. Do not "fix" this into a layer-1 token.

`onChange` receives the **next** value. A handler that ignores the argument and
recomputes from its own state (`const on = !sshEnabled`) is fine — the Settings
and Web tabs' three handlers do that.

## Rules

1. **`className` goes last and wins.** `cx()` runs `tailwind-merge`, so a
   caller's class beats the primitive's base instead of both being emitted and
   the winner decided by stylesheet order. That is what makes
   `<Button className="w-full">` legal.
2. **Never delete an `msn-*` class.** Those are pure browser-test hooks (see
   `docs/reference/pages/mission.md#element-hooks`). They carry no styles; they are how the
   tests find an element. Every primitive forwards `className` so a hook lands
   on the exact element that has it today. Losing one silently kills a check
   that otherwise looks fine.
3. **Never re-theme the terminal.** xterm keeps its DEFAULT colors; the themed
   `xtermTheme()` and its `paddock:theme` listener were removed by request.
4. **A missing color token is dropped SILENTLY** — no build error, no class in
   the CSS, and it fails only in dark mode. A new token must go in BOTH
   `palette.css` and the `@theme inline` block, then be verified by grepping
   the BUILT `src/public/assets/index-*.css`. Status families are named
   **success / warning / danger / info / brand** — never ok/warn/error — and
   there is no `-hover` shade for status fills, only for
   `raised`/`raised-hover` and `accent`.
5. **Do not migrate a control's look.** Fold the existing spelling in first;
   converge on one spelling per control, then judge appearance separately.
