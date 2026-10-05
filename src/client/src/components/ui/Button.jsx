import { forwardRef } from 'react'
import { cx } from '../../lib/cx'

/**
 * Button — the only way to render a button in this app.
 *
 * Before this existed the same primary button appeared in ~20 spellings
 * (px-3 py-1.5 / px-4 py-2 / px-6 py-3, rounded-lg / rounded-xl / rounded,
 * four different disabled treatments). Everything below is the standardized
 * version; anything a caller needs beyond these props is a missing variant,
 * not a className.
 *
 * type defaults to "button" on purpose: a bare <button> inside a <form>
 * submits it, and this app has 9 forms.
 */

const VARIANTS = {
  /* solid accent — the one "do it" action per view */
  primary: 'bg-accent text-accent-ink hover:bg-accent-hover',
  /* raised surface — the second action, and the default for neutral buttons */
  secondary: 'bg-raised text-ink hover:bg-raised-hover border border-line-faint',
  /* no fill until hover — toolbar / row actions */
  ghost: 'text-ink-muted hover:bg-raised hover:text-ink',
  /* solid danger — destructive confirms */
  danger: 'bg-danger text-danger-ink hover:brightness-110',
  /* tinted danger — destructive row actions that are not the primary action */
  dangerGhost: 'text-danger hover:bg-danger-soft',
  /* accent-tinted ghost — tab/filter pills */
  accentGhost: 'text-accent-text hover:bg-accent-soft',
  /* inline micro text action — no fill, no border, no height. For the
     `edit`/`del`/`Cancel` affordances inside a dense listing row, where a
     28px control would make every row taller than its content. */
  link: 'text-ink-faint hover:text-ink',
  /* the same, pointing at danger (a row's delete) */
  dangerLink: 'text-ink-faint hover:text-danger',
  /* a small tinted danger chip — "Delete" inside an inline confirm block */
  dangerSoft: 'bg-danger-soft text-danger',
  /* no recipe at all — the caller supplies the fill conditionally (a selected
     vs unselected list item). Without this, an unknown variant string silently
     falls back to `secondary` and adds a border the caller never asked for. */
  none: '',
}

const SIZES = {
  sm: { ctl: 'ctl-sm', text: 'text-[11px]', px: 'px-2', w: '1.75rem' },
  md: { ctl: 'ctl-md', text: 'text-xs', px: 'px-3', w: '2.25rem' },
  lg: { ctl: 'ctl-lg', text: 'text-sm', px: 'px-4', w: '2.75rem' },
  /* no control height and no font size — the caller's box governs. This is
     the dense-listing scale (32px rail affordances, 10px row actions). It
     still centralizes shape: radius, focus ring, font weight, type default. */
  bare: { ctl: '', text: '', px: 'px-1.5', w: undefined },
}

const Button = forwardRef(function Button(
  {
    variant = 'secondary',
    size = 'md',
    icon = false,
    block = false,
    loading = false,
    disabled = false,
    type = 'button',
    className,
    style,
    children,
    ...rest
  },
  ref
) {
  const s = SIZES[size] || SIZES.md
  const isDisabled = disabled || loading
  /* `icon` means "square, no side padding". It normally also pins the width
     from the size table — but on `bare` there is no size to pin it from, so the
     caller's own box (h-8 w-8 on a 56px rail) governs and only px-0 applies. */
  const pinWidth = icon && s.w

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      style={pinWidth ? { ...style, width: s.w, minWidth: s.w } : style}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap',
        'rounded-control font-medium transition-colors select-none',
        s.ctl,
        s.text,
        VARIANTS[variant] || VARIANTS.secondary,
        icon ? 'px-0' : s.px,
        block && 'w-full',
        isDisabled && 'opacity-50 pointer-events-none',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
})

export default Button
