import { useEffect, useRef } from 'react'
import { cx } from '../../lib/cx'
import Button from './Button'

/**
 * Modal — the one dialog shell.
 *
 * The panel existed in 3 spellings (identical apart from a stray
 * `focus:outline-none` on the div, which does nothing on a div) and the
 * backdrop in 2 — one of which (`ProjectDialog`) used a raw `bg-black/50`
 * instead of the themed `bg-overlay`, so it did not follow the mode.
 *
 * `z` exists because the app stacks dialogs: a confirm (z-80) must sit above
 * the dialog that raised it (z-50), and Vault/SettingsTab used z-75 for
 * two-step flows. It is a prop, not a constant, so a caller can nest.
 *
 * Escape closes by default; pass onClose={null} for a dialog that must be
 * answered (a form the user is mid-way through).
 */
export function Modal({
  open = true,
  onClose,
  title,
  tone,
  width = 'max-w-md',
  z = 'z-50',
  role = 'dialog',
  closeLabel = 'Close',
  headerExtra,
  divided = false,
  bodyScroll = false,
  className,
  bodyClassName,
  panelClassName,
  footerClassName,
  children,
  footer,
}) {
  const panelRef = useRef(null)

  useEffect(() => {
    if (!open || !onClose) return
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  if (!open) return null

  const hasHeader = !!(title || headerExtra)

  return (
    <div
      className={cx('fixed inset-0 flex items-center justify-center bg-overlay backdrop-blur-sm p-4', z)}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && onClose) onClose()
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        className={cx(
          'bg-panel border border-line rounded-card shadow-modal w-full outline-none flex flex-col overflow-hidden',
          width,
          panelClassName
        )}
      >
        {hasHeader && (
          <div
            className={cx(
              'flex items-start justify-between gap-4 px-6 pt-5 pb-3 shrink-0',
              divided && 'border-b border-line'
            )}
          >
            <h3 className={cx('text-base font-semibold min-w-0 break-words', tone === 'danger' ? 'text-danger' : 'text-ink')}>
              {title}
            </h3>
            <div className="flex items-center gap-2 shrink-0">
              {headerExtra}
              {onClose && (
                <Button
                  variant="ghost"
                  size="sm"
                  icon
                  onClick={onClose}
                  aria-label={closeLabel}
                  className="-mr-1.5 text-lg leading-none"
                >
                  ×
                </Button>
              )}
            </div>
          </div>
        )}
        <div
          className={cx(
            hasHeader ? 'px-6 pb-5' : 'p-6',
            // bodyScroll needs the panel to be a flex column with a bounded
            // height (panelClassName, e.g. max-h-[90vh]) — see ContainerInfoModal
            bodyScroll && 'overflow-y-auto min-h-0 flex-1',
            className,
            bodyClassName
          )}
        >
          {children}
        </div>
        {footer && (
          <div
            className={cx(
              'flex items-center justify-end gap-3 px-6 pb-5 shrink-0',
              divided && 'border-t border-line pt-3',
              footerClassName
            )}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

export default Modal
