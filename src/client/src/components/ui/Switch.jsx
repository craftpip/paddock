import { forwardRef } from 'react'
import { cx } from '../../lib/cx'

/**
 * Switch — the on/off toggle for a settings row.
 *
 * There were seven of these, hand-written, and they had drifted apart:
 *
 *   - two geometries: 40x24 with a 20px knob (six sites) and 44x24 with a
 *     16px knob (Configs), so the same control looked like two controls;
 *   - two knob colours: `bg-white` (four sites) and `bg-panel` (CreateAgent)
 *     — and `bg-panel` is a DARK-mode bug, see the note on the knob below;
 *   - four of the seven had no `focus-ring` at all, so they were the only
 *     focusable control in the app with no visible focus state;
 *   - Configs' had no `role="switch"` / `aria-checked`, so it announced as a
 *     plain button and a screen reader could not read its state.
 *
 * The state is driven by `checked`, never by the caller's own classes, so a
 * switch that renders "always on" (the Web tab's Published/Exposed pair, which
 * only mounts while the feature is on) stays correct if that ever changes.
 *
 * The knob is `bg-white` and that is deliberate. Every palette token that
 * looks like a light surface goes DARK in dark mode, and a dark knob on the
 * dark `bg-raised` track of the off state nearly disappears. The one token that
 * is white in light mode (`--t-accent-ink`) is near-black in dark mode, which
 * is exactly wrong here. The knob is a physical cap: it stays light in both
 * themes. Do not "fix" this into a palette token.
 */

const Switch = forwardRef(function Switch(
  { checked = false, onChange, disabled = false, label, className, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={cx(
        'relative inline-flex shrink-0 items-center',
        'w-10 h-6 rounded-pill transition-colors select-none',
        'focus-ring disabled:opacity-50 disabled:pointer-events-none',
        checked ? 'bg-accent' : 'bg-raised',
        className
      )}
      {...rest}
    >
      <span
        aria-hidden="true"
        className={cx(
          'pointer-events-none absolute top-0.5 left-0.5 w-5 h-5',
          'rounded-pill bg-white transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0'
        )}
      />
    </button>
  )
})

export default Switch
