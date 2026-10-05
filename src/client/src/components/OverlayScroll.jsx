import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

const MIN_THUMB = 28
const EDGE = 2
const LANE = 12
const HIDE_AFTER = 900

/**
 * A scroll area whose scrollbar floats OVER the content instead of stealing a
 * 10px strip from it.
 *
 * Why this exists: a native scrollbar always reserves layout space, so a narrow
 * listing either loses that space permanently or — with `scrollbar-gutter:
 * stable` — reserves it invisibly and still loses it, which reads as a bar
 * "taking space in the listing" even when nothing is painted there. The only
 * way to genuinely give the content the full width is to switch the native bar
 * off (it then reserves nothing, at any overflow state, so the overflow
 * threshold causes no shift either) and draw the thumb ourselves.
 *
 * The wrapper keeps the exact box the scroller used to occupy, so dropping it
 * in place of a `flex-1 min-h-0 overflow-y-auto` div changes no layout: the
 * scroller fills the wrapper and the thumb is absolutely positioned over it.
 *
 * The thumb appears while the pointer is over the area, while it is being
 * dragged, and for a moment after any scroll, then fades. Dragging works from
 * the grab strip (a few pixels wider than the pill); a click on the track pages
 * the view, and a click on the thumb starts a drag.
 */
export default function OverlayScroll({ className = '', scrollerClassName = '', children }) {
  const wrapRef = useRef(null)
  const scrollRef = useRef(null)
  const hideTimer = useRef(null)
  const dragging = useRef(null)
  const hovered = useRef(false)
  const [visible, setVisible] = useState(false)
  const [thumb, setThumb] = useState({ top: 0, height: 0, scrollable: false })

  const measure = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    if (max <= 1) {
      setThumb((t) => (t.scrollable ? { top: 0, height: 0, scrollable: false } : t))
      return
    }
    const track = el.clientHeight
    const height = Math.max(MIN_THUMB, Math.round((el.clientHeight / el.scrollHeight) * track))
    const top = Math.round((el.scrollTop / max) * (track - height))
    setThumb((t) => (t.top === top && t.height === height ? t : { top, height, scrollable: true }))
  }, [])

  /* Shown while the pointer is over the area, while it is being dragged, and for
     a moment after any scroll — so a wheel or keyboard scroll still shows you
     where you are, but a parked pointer leaves nothing on screen. The idle
     timer must NOT hide it while the pointer is still there, hence hovered. */
  const flash = useCallback(() => {
    setVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      if (!dragging.current && !hovered.current) setVisible(false)
    }, HIDE_AFTER)
  }, [])

  useLayoutEffect(() => {
    measure()
    const el = scrollRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    for (const child of Array.from(el.children)) ro.observe(child)
    const mo = new MutationObserver(measure)
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [measure])

  /* A NATIVE scroll listener, not React's onScroll: scroll does not bubble, so a
     delegated handler never sees it and the thumb silently stops following the
     content the moment anything scrolls programmatically (a drag, an
     anchor jump, a poll reordering the rows). This one always fires. */
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return undefined
    const onScroll = () => {
      measure()
      flash()
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [measure, flash])

  useEffect(() => () => clearTimeout(hideTimer.current), [])

  const applyDrag = useCallback((clientY) => {
    const d = dragging.current
    const el = scrollRef.current
    if (!d || !el) return
    const max = el.scrollHeight - el.clientHeight
    if (max <= 1) return
    const travel = el.clientHeight - thumb.height
    const ratio = travel > 0 ? (clientY - EDGE - d.offset - thumb.height / 2) / travel : 0
    el.scrollTop = Math.min(max, Math.max(0, ratio * max))
  }, [thumb.height])

  const onGrabDown = useCallback((e) => {
    const el = scrollRef.current
    if (!el || !thumb.scrollable) return
    e.preventDefault()
    e.stopPropagation()
    const rect = el.getBoundingClientRect()
    const y = e.clientY - rect.top
    const hit = y >= thumb.top && y <= thumb.top + thumb.height
    if (hit) {
      dragging.current = { offset: y - thumb.top }
    } else {
      // A click on the track pages the view, the way a native bar does.
      el.scrollBy({ top: y < thumb.top ? -el.clientHeight : el.clientHeight })
      return
    }
    setVisible(true)
    clearTimeout(hideTimer.current)
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      /* pointer already gone — the drag still works off the window listeners */
    }
  }, [thumb])

  const onGrabMove = useCallback((e) => {
    if (!dragging.current) return
    e.preventDefault()
    applyDrag(e.clientY)
  }, [applyDrag])

  const onGrabUp = useCallback((e) => {
    if (!dragging.current) return
    dragging.current = null
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId)
    } catch {
      /* never captured */
    }
    flash()
  }, [flash])

  return (
    <div
      ref={wrapRef}
      className={`msn-ovsb relative min-h-0 flex-1 ${className}`}
      data-visible={visible ? 'true' : 'false'}
      onPointerEnter={(e) => {
        hovered.current = true
        flash()
      }}
      onPointerLeave={() => {
        hovered.current = false
        if (!dragging.current) {
          clearTimeout(hideTimer.current)
          setVisible(false)
        }
      }}
    >
      <div ref={scrollRef} className={`msn-ovsb-scroll h-full overflow-y-auto ${scrollerClassName}`}>
        {children}
      </div>
      {thumb.scrollable && (
        <div
          className="msn-ovsb-grab"
          style={{ top: thumb.top, height: thumb.height, right: 0 }}
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
          role="presentation"
        >
          <div className="msn-ovsb-thumb" style={{ top: 0, height: '100%' }} />
        </div>
      )}
    </div>
  )
}
