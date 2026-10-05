import { forwardRef } from 'react'
import { cx } from '../../lib/cx'

/**
 * Input / Textarea — one surface, one border, one focus ring.
 *
 * The 25+ existing spellings disagreed on the *surface color* alone
 * (bg-raised in 8 places, bg-sunken in the rest), so "an input" was not one
 * thing. `sunken` is the standard: it is the recessed surface, it reads as a
 * field against the panel it sits on, and it is already what most of the app
 * uses. Callers that genuinely need a raised field pass className="bg-raised".
 */

const SIZES = {
  sm: { ctl: 'ctl-sm', text: 'text-xs', px: 'px-2' },
  md: { ctl: 'ctl-md', text: 'text-sm', px: 'px-3' },
}

// `base` deliberately does NOT take className. Every component must end its own
// cx() with the caller's className, because twMerge resolves a conflict in
// favour of the LAST occurrence. Folding className in here and then appending
// more structural classes (as `py-2 resize-y` or `pr-8` did) silently makes the
// primitive win over the caller — `resize-none` on a Textarea became a no-op.
function base({ size, mono, invalid }) {
  const s = SIZES[size] || SIZES.md
  return cx(
    'w-full min-w-0 bg-sunken text-ink placeholder-ink-dim',
    'border rounded-control transition-colors',
    invalid ? 'border-danger' : 'border-line',
    !invalid && 'focus-ring',
    s.ctl,
    s.text,
    s.px,
    mono && 'font-mono'
  )
}

export const Input = forwardRef(function Input(
  { size = 'md', mono = false, invalid = false, className, ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      className={cx(base({ size, mono, invalid }), className)}
      {...rest}
    />
  )
})

export const Textarea = forwardRef(function Textarea(
  { size = 'md', mono = false, invalid = false, className, rows = 4, ...rest },
  ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cx(base({ size, mono, invalid }), 'py-2 resize-y leading-relaxed', className)}
      {...rest}
    />
  )
})

export const Select = forwardRef(function Select(
  { size = 'md', mono = false, invalid = false, className, children, ...rest },
  ref
) {
  return (
    <span className="relative block w-full min-w-0">
      <select
        ref={ref}
        className={cx(
          base({ size, mono, invalid }),
          'cursor-pointer appearance-none pr-8',
          className
        )}
        {...rest}
      >
        {children}
      </select>
      {/* The chevron is a CSS mask, not a background-image data URI: a URI
          cannot read currentColor, so it would need a hardcoded hex and
          would be the wrong colour in one of the two modes. A mask takes its
          colour from background-color, so it themes for free. */}
      <span
        aria-hidden="true"
        className="select-chevron pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2"
      />
    </span>
  )
})

export const Checkbox = forwardRef(function Checkbox(
  { size = 'md', indeterminate = false, className, ...rest },
  ref
) {
  const box = { sm: 'w-3.5 h-3.5', md: 'w-4 h-4' }[size] || 'w-4 h-4'
  return (
    <input
      ref={(el) => {
        if (el) el.indeterminate = indeterminate
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      type="checkbox"
      className={cx(
        'shrink-0 accent-accent bg-sunken border border-line rounded',
        'focus-ring',
        box,
        className
      )}
      {...rest}
    />
  )
})

export default Input
