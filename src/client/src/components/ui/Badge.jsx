import { cx } from '../../lib/cx'
import { TONES } from './tone'

/**
 * Badge — a status/label pill.
 *
 * Replaces ~14 ad-hoc spellings that mixed the four-shade status families with
 * raw `bg-accent/15` and three different font sizes (text-[9px], text-[10px],
 * text-xs). `variant`: `soft` (tinted, **default**) · `solid` (filled) ·
 * `outline` (bordered). See tone.js for why the fills are a table.
 */
const SIZES = {
  sm: 'text-[10px] px-1.5 py-0.5',
  md: 'text-xs px-2 py-0.5',
}

export function Badge({ tone = 'neutral', variant = 'soft', size = 'sm', className, children, ...rest }) {
  const t = TONES[tone] || TONES.neutral
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-pill font-medium whitespace-nowrap',
        SIZES[size] || SIZES.sm,
        t[variant] || t.soft,
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}

export default Badge
