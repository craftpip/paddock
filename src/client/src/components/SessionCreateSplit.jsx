import { useEffect, useRef, useState } from 'react'
import Button from './ui/Button'

/* The sessions toolbar's single creation control (plan 96): one joined button,
 *  `[ + New session | ▾ ]`. The left half starts an ordinary session — exactly
 *  what the old standalone button did — and the chevron opens a dropdown whose
 *  only item is the infinite session, so the two creation entry points read as
 *  one action with a variant instead of two buttons of unequal weight.
 *
 *  The menu is local state on purpose: a 15s listing poll re-renders this
 *  component but must not close an open menu, and the toolbar must not remount
 *  (a store-backed `open` would survive a scope change too).
 *
 *  The chevron is a stroked SVG, not a `▾`/`‹`/`›` character: those render ~5px
 *  of hairline inside a 28px control (plan 53 §6), which is genuinely hard to
 *  hit. 14px with a scaled stroke is the same rule the col-1 fold arrows use. */
function CaretDown() {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export default function SessionCreateSplit({ project, newBusy = false, onNewSession, onNewInfinite }) {
  const [open, setOpen] = useState(false)
  const groupRef = useRef(null)
  const caretRef = useRef(null)
  const disabled = !project
  const disabledAll = disabled || newBusy

  const close = (refocus) => {
    setOpen(false)
    if (refocus) caretRef.current?.focus()
  }

  // Click outside the group closes the menu. `mousedown` (not `click`) so the
  // menu is gone before the click lands on whatever is behind it — a `click`
  // listener would let the outline's target act first.
  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!groupRef.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const title = project ? `New session in ${project.name}` : 'Pick a project first'

  return (
    <span
      ref={groupRef}
      className="msn-new-split relative inline-flex"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          close(true)
        }
      }}
      // `onBlur` bubbles (focusout), so this fires when ANY descendant loses
      // focus; moving between the two halves or onto the menu item is not
      // leaving, so the check is against the group, not the element.
      onBlur={(e) => {
        if (open && !groupRef.current?.contains(e.relatedTarget)) setOpen(false)
      }}
    >
      <Button
        variant="primary"
        size="bare"
        disabled={disabledAll}
        onClick={() => onNewSession?.()}
        className="msn-btn-new-session rounded-r-none py-1 text-[11px]"
        title={title}
      >
        {newBusy ? 'Opening…' : '+ New session'}
      </Button>
      <Button
        ref={caretRef}
        variant="primary"
        size="bare"
        disabled={disabledAll}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More session types"
        onClick={() => setOpen((o) => !o)}
        className="msn-btn-new-caret rounded-l-none border-l border-accent-ink/25 px-1.5 py-1"
        title={title}
      >
        <CaretDown />
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Session types"
          className="msn-new-menu absolute top-full left-0 z-20 mt-1 min-w-full rounded-control border border-line bg-panel py-1 whitespace-nowrap text-left shadow-tooltip"
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              close(true)
              onNewInfinite?.()
            }}
            className="msn-new-menu-infinite block w-full px-3 py-1.5 text-left text-[11px] text-ink hover:bg-raised"
          >
            <span className="font-medium">∞ New infinite session</span>
            <span className="mt-0.5 block text-[11px] text-ink-faint">Runs QUEUE.md until done</span>
          </button>
        </div>
      )}
    </span>
  )
}
