import { cx } from '../../lib/cx'

/**
 * Field — label + control + hint/error, in that order, with the spacing owned
 * here.
 *
 * The label existed in two spellings: `block text-xs font-medium text-ink-faint
 * mb-1.5 uppercase tracking-wider` (12x) and the same WITHOUT `block`/`mb-1.5`
 * (7x). Missing `block` is a real bug — the label stops being full width, so
 * the click target for a checkbox-style row shrinks to the text. Field makes
 * the correct version the only version.
 */
const LABELS = {
  /* settings pages: the uppercase section-label look */
  form: 'text-ink-faint uppercase tracking-wider',
  /* inside a dialog: sentence case, quieter — an uppercase label in a 320px
     modal wraps onto two lines and reads like a section header */
  compact: 'text-ink-muted normal-case tracking-normal',
}

export function Field({
  label,
  hint,
  error,
  required,
  htmlFor,
  labelVariant = 'form',
  children,
  className,
  labelClassName,
}) {
  return (
    <div className={cx('w-full', className)}>
      {label && (
        <label
          htmlFor={htmlFor}
          className={cx(
            'block text-xs font-medium mb-1.5',
            LABELS[labelVariant] || LABELS.form,
            labelClassName
          )}
        >
          {label}
          {required && <span className="text-danger ml-0.5">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <div className="text-xs text-danger mt-1">{error}</div>
      ) : (
        hint && <div className="text-xs text-ink-dim mt-1">{hint}</div>
      )}
    </div>
  )
}

export default Field
