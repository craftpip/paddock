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
 *
 *  `axis="y"` is the same divider laid horizontally between two STACKED panels:
 *  it resizes the previous sibling's HEIGHT from `clientY`, `max` is a % of the
 *  container's height, and the keys are ↑/↓. (The Mission queue over its
 *  terminal uses it.)
 */
export default function Splitter({
  onResize,
  min = 200,
  max = 60,          // % of the container, so a column can never eat the next one
  defaultWidth = null, // what double-click resets to
  openAt = null,     // width a keyboard nudge jumps to when the panel is on its floor
  label = 'Resize panel',
  storageKey = null,  // persist the width under this localStorage key
  axis = 'x',         // 'x': resize width (side by side); 'y': resize height (stacked)
  className = '',
}) {
  const vertical = axis === 'y'
  const sizeOf = (el) => (el ? (vertical ? el.getBoundingClientRect().height : el.getBoundingClientRect().width) : 0)
  const posOf = (e) => (vertical ? e.clientY : e.clientX)
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
      const room = vertical ? parent?.clientHeight : parent?.clientWidth
      const cap = room ? (room * max) / 100 : Infinity
      return Math.max(min, Math.min(cap, Math.round(px)))
    },
    [min, max, vertical]
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
    startRef.current = { x: posOf(e), width: sizeOf(panel) }
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
    const next = clamp(startRef.current.width + (posOf(e) - startRef.current.x))
    onResizeRef.current?.(next)
  }

  const endDrag = (e) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    const panel = containerRef.current?.previousElementSibling
    if (panel) persist(Math.round(sizeOf(panel)))
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
    const current = panel ? sizeOf(panel) : min
    // A nudge is a delta from the current width, so a panel sitting on its
    // floor can only ever ask for `min + step` — which the floor clamps back to
    // `min`, and a collapsed column would be unreachable by keyboard for ever.
    // Jumping straight to `openAt` (the width the parent considers open) makes
    // the first press reopen it and every press after that a normal step.
    const atFloor = openAt ? current <= min + 1 : false
    let next = null
    const less = vertical ? 'ArrowUp' : 'ArrowLeft'
    const more = vertical ? 'ArrowDown' : 'ArrowRight'
    if (e.key === less) next = atFloor ? current : current - step
    else if (e.key === more) next = atFloor ? openAt : current + step
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
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize'
    return () => {
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = prevCursor
    }
  }, [dragging, vertical])

  return (
    <div
      ref={containerRef}
      role="separator"
      aria-orientation={vertical ? 'horizontal' : 'vertical'}
      aria-label={label}
      aria-valuenow={Math.round(sizeOf(containerRef.current?.previousElementSibling))}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={handleDoubleClick}
      className={`group relative shrink-0 outline-none ${
        vertical ? 'h-1.5 w-full cursor-row-resize' : 'w-1.5 cursor-col-resize'
      } ${dragging ? 'z-10' : ''} ${className}`}
    >
      {/* 6px invisible hit area, 1px line that only shows on hover/focus. */}
      <span className={vertical ? 'absolute inset-x-0 -top-1 h-3.5' : 'absolute inset-y-0 -left-1 w-3.5'} aria-hidden="true" />
      <span
        aria-hidden="true"
        className={`absolute transition-colors ${
          vertical ? 'inset-x-0 top-1/2 h-px -translate-y-1/2' : 'inset-y-0 left-1/2 w-px -translate-x-1/2'
        } ${
          dragging
            ? 'bg-accent-text'
            : 'bg-line group-hover:bg-accent-text group-focus-visible:bg-accent-text'
        }`}
      />
    </div>
  )
}
