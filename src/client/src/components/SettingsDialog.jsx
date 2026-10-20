import { useState } from 'react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { cx } from '../lib/cx'

// Plan 91 §Phase 3: the reusable large-dialog shell (plan 92 reuses it for
// callbacks). A thin wrapper over the sanctioned Modal: wide bounded body,
// section navigation, focus trap + restoration, and dirty-close confirmation.
//
// Modal owns focus, its trap/restoration, Escape and backdrop-close. The
// standalone dirty-close fallback lives here; URL-backed forms use the router
// blocker so Back/Forward, Cancel and Escape all take the same path.
// `onClose` fires only for a CONFIRMED close — dirty state routes through the
// inline confirm bar first.

export default function SettingsDialog({
  title,
  sections, // [{ id, label }]
  section,
  onSection,
  dirty = false,
  dirtyText = 'You have unsaved changes.',
  onClose,
  footer,
  children,
}) {
  const [confirming, setConfirming] = useState(false)

  const requestClose = () => {
    if (dirty && !confirming) {
      setConfirming(true)
      return
    }
    onClose()
  }

  return (
    <Modal
      onClose={requestClose}
      title={title}
      width="max-w-[1040px]"
      panelClassName="max-h-[90dvh]"
      bodyScroll
      divided
      className="msn-settings-dialog"
      footer={footer}
    >
      <div>
        {sections && sections.length > 1 && (
          <div role="tablist" aria-label="Dialog sections" className="msn-dialog-sections mb-3 flex flex-wrap gap-1">
            {sections.map((s) => (
              <Button
                key={s.id}
                type="button"
                variant={section === s.id ? 'primary' : 'secondary'}
                size="sm"
                role="tab"
                aria-selected={section === s.id}
                onClick={() => onSection(s.id)}
                className="msn-dialog-section"
              >
                {s.label}
              </Button>
            ))}
          </div>
        )}
        {children}
        {confirming && (
          <div className="msn-dialog-discard-confirm mt-3 flex flex-wrap items-center gap-2 rounded-control border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-ink">
            <span className={cx('flex-1')}>{dirtyText} Discard them?</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              autoFocus
              onClick={() => setConfirming(false)}
              className="msn-dialog-discard-keep"
            >
              Keep editing
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={onClose}
              className="msn-dialog-discard-drop"
            >
              Discard
            </Button>
          </div>
        )}
      </div>
    </Modal>
  )
}
