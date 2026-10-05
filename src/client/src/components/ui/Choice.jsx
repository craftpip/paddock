import { cx } from '../../lib/cx'

/**
 * Choice — a small clickable pill.
 *
 * Used wherever a compact pick-one-or-pick-a-path control appears: the agent
 * picker in the project dialog, the folder chips, the Mission project rail.
 * Distinct from Button because its defining feature is the `selected` state —
 * a Button cannot express "this group, one of them is on".
 *
 * `variant`:
 *   'option' (default) — bordered, sunken, for choosing between real options
 *   'chip'            — borderless raised fill, for quick path/type tags
 */
const SIZES = {
  sm: 'text-[10px] px-1.5 py-0.5',
  md: 'text-xs px-2.5 py-1',
}

export function Choice({
  selected = false,
  variant = 'option',
  size = 'md',
  mono = false,
  className,
  children,
  ...rest
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cx(
        'rounded-control font-medium transition-colors text-left',
        SIZES[size] || SIZES.md,
        mono && 'font-mono',
        variant === 'chip'
          ? cx(
              'truncate max-w-full',
              selected
                ? 'bg-accent-soft text-accent-text'
                : 'bg-raised text-ink-dim hover:bg-raised-hover hover:text-ink'
            )
          : selected
            ? 'border border-accent-line bg-accent/10 text-ink'
            : 'border border-line bg-sunken text-ink-dim hover:border-line-faint hover:text-ink-muted',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export default Choice
