import { cx } from '../../lib/cx'

/**
 * Card — the one panel surface.
 *
 * `rounded-xl` (cards/modals) is now the `card` radius token, so the shape of
 * every panel in the app is one edit. `plain` drops the border+shadow for
 * surfaces that sit on a card already and only need a recessed well.
 */
export function Card({ title, actions, plain = false, className, children, ...rest }) {
  return (
    <div
      className={cx(
        plain
          ? 'bg-sunken border border-line-faint rounded-card'
          : 'bg-panel border border-line rounded-card shadow-card',
        className
      )}
      {...rest}
    >
      {title && (
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}

export default Card
