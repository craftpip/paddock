import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Splitter — a mouse/touch/keyboard resizable divider between two panels.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Used by the Mission page's three columns. Three things this gets right that
 *  a `border` + ad-hoc onMouseDown does not:
 *
 *  - The hit area is 6px but the *visual* line only appears on hover/focus, so
 *    the layout stays quiet until you go looking for the divider.
 *  - Dragging is tracked from `clientX` deltas, so the divider keeps following
 *    the pointer even when it leaves the 6px strip.
 *  - It is keyboard reachable: focus the divider and press ←/→. A mouse-only
 *    resizer is a dead end for anyone not using a mouse.
 *
 *  The parent owns the width. This component only reports a new one:
 *
 *    const [w, setW] = useState(260)
 *    <Splitter onResize={setW} min={200} max={60} />   // max: % of container
 *
 *  `aria-valuenow`/`role="separator"` mean a screen reader announces the
 *  position, and `double-click` resets to the default width.
 */
export default function Splitter({
  onResize,
  min = 200,
  max = 60,          // % of the container, so a column can never eat the next one
  defaultWidth = null, // what double-click resets to
  label = 'Resize panel',
  storageKey = null,  // persist the width under this localStorage key
  className = '',
}) {
  const [dragging, setDragging] = useState(false)
  // The drag flag is a REF, not just state: pointermove can arrive before the
  // re-render that flips `dragging` commits, and a fast real drag would then
  // lose its first pixels. State drives the styling; the ref drives the logic.
  const draggingRef = useRef(false)
  const startRef = useRef({ x: 0, width: 0 })
  const containerRef = useRef(null)
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  const clamp = useCallback(
    (px) => {
      const parent = containerRef.current?.parentElement
      const cap = parent?.clientWidth ? (parent.clientWidth * max) / 100 : Infinity
      return Math.max(min, Math.min(cap, Math.round(px)))
    },
    [min, max]
  )

  const persist = useCallback(
    (px) => {
      if (!storageKey) return
      try {
        localStorage.setItem(storageKey, String(px))
      } catch {}
    },
    [storageKey]
  )

  // Pointer capture on the divider itself: the browser keeps sending moves even
  // when the cursor is outside the 6px strip, so the drag cannot "escape".
  // One onPointerDown covers mouse, touch and pen — a MouseEvent/TouchEvent has
  // no pointerId to capture with.
  const handleDown = (e) => {
    e.preventDefault()
    // Measure the panel being resized (the previous sibling) rather than
    // guessing a width: the pointer delta is applied to its real width.
    const panel = e.currentTarget.previousElementSibling
    startRef.current = { x: e.clientX, width: panel ? panel.getBoundingClientRect().width : 0 }
    draggingRef.current = true
    setDragging(true)
    if (e.pointerId !== undefined) {
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId)
      } catch {}
    }
  }

  const handleMove = (e) => {
    if (!draggingRef.current) return
    const next = clamp(startRef.current.width + (e.clientX - startRef.current.x))
    onResizeRef.current?.(next)
  }

  const endDrag = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    const panel = containerRef.current?.previousElementSibling
    if (panel) persist(panel.getBoundingClientRect().width)
    if (e.pointerId !== undefined) {
      try {
        e.currentTarget.releasePointerCapture?.(e.pointerId)
      } catch {}
    }
  }

  // Keyboard nudge. Step 16px, 64px with shift.
  const handleKeyDown = (e) => {
    const step = e.shiftKey ? 64 : 16
    const panel = containerRef.current?.previousElementSibling
    const current = panel ? panel.getBoundingClientRect().width : min
    let next = null
    if (e.key === 'ArrowLeft') next = current - step
    else if (e.key === 'ArrowRight') next = current + step
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = clamp(current * 2)
    else if (e.key === 'Enter' && defaultWidth) next = defaultWidth
    else return
    e.preventDefault()
    const clamped = clamp(next)
    onResizeRef.current?.(clamped)
    persist(clamped)
  }

  const handleDoubleClick = () => {
    if (!defaultWidth) return
    const next = clamp(defaultWidth)
    onResizeRef.current?.(next)
    persist(next)
  }

  // Keep the divider from being a scroll/selection magnet mid-drag.
  useEffect(() => {
    if (!dragging) return
    const prevUserSelect = document.body.style.userSelect
    const prevCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    return () => {
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
    }
  }, [dragging])

  return (
    <div
      ref={containerRef}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(
        containerRef.current?.previousElementSibling?.getBoundingClientRect().width || 0
      )}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      className={`group relative w-1.5 shrink-0 cursor-col-resize outline-none ${
        dragging ? 'z-10' : ''
      } ${className}`}
    >
      {/* 6px invisible hit area, 1px line that only shows on hover/focus. */}
      <span className="absolute inset-y-0 -left-1 w-3.5" aria-hidden="true" />
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${
          dragging
            ? 'bg-accent-text'
            : 'bg-line group-hover:bg-accent-text group-focus-visible:bg-accent-text'
        }`}
      />
    </div>
  )
}
