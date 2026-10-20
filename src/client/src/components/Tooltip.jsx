import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const PAD = 8
const GAP = 7

/**
 * Tooltip — shows its text instantly on hover/focus, with no browser `title`
 * delay. The default is pure CSS (pseudo-elements), which themes with the
 * existing light/dark tokens and stays inside the viewport: when the centered
 * tooltip would spill past a window edge it is clamped via `--tt-shift`
 * (recomputed on hover, focus, scroll and resize).
 *
 * <Tooltip text="Copy URL" position="bottom">
 *   <button>⧉</button>
 * </Tooltip>
 *
 * position: 'top' | 'bottom' | 'left' | 'right' (default 'top')
 * Pass text={''} or omit it to render children without a wrapper.
 *
 * `portal` renders the bubble in `document.body` instead of a pseudo-element.
 * That is required when the trigger sits inside an `overflow: auto` scroller
 * (the collapsed project rail): a pseudo-element is clipped by the scrollport,
 * so a tooltip beside a 32px avatar would never be readable. The portal mounts
 * on the wrapper's mouseenter/focusin and is placed from the trigger's rect,
 * including viewport clamping.
 */
export default function Tooltip({ text, position = 'top', className = '', portal = false, children }) {
  const ref = useRef(null)
  const tipRef = useRef(null)
  const [anchor, setAnchor] = useState(null)
  const [offset, setOffset] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (portal || !el || !text) return

    const update = () => {
      const r = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const tip = getComputedStyle(el, '::after')
      const w = parseFloat(tip.width) || 0
      const h = parseFloat(tip.height) || 0
      let shift = 0
      if (position === 'top' || position === 'bottom') {
        const leftEdge = r.left + r.width / 2 - w / 2
        const rightEdge = leftEdge + w
        if (leftEdge < PAD) shift = PAD - leftEdge
        else if (rightEdge > vw - PAD) shift = vw - PAD - rightEdge
      } else {
        const topEdge = r.top + r.height / 2 - h / 2
        const bottomEdge = topEdge + h
        if (topEdge < PAD) shift = PAD - topEdge
        else if (bottomEdge > vh - PAD) shift = vh - PAD - bottomEdge
      }
      el.style.setProperty('--tt-shift', `${shift}px`)
    }

    update()
    el.addEventListener('mouseenter', update)
    el.addEventListener('focusin', update)
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => {
      el.removeEventListener('mouseenter', update)
      el.removeEventListener('focusin', update)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [text, position, portal])

  useEffect(() => {
    if (!portal || !anchor) return undefined
    const hide = () => setAnchor(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [portal, anchor])

  /* Measure the rendered bubble, then clamp it to the viewport. The second pass
     is stable: the anchor and the bubble's own size do not depend on `offset`. */
  useLayoutEffect(() => {
    if (!anchor || !tipRef.current) return
    const t = tipRef.current.getBoundingClientRect()
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    let next = 0
    if (position === 'left' || position === 'right') {
      const topEdge = anchor.cy - t.height / 2
      const bottomEdge = topEdge + t.height
      if (topEdge < PAD) next = PAD - topEdge
      else if (bottomEdge > vh - PAD) next = vh - PAD - bottomEdge
    } else {
      const leftEdge = anchor.cx - t.width / 2
      const rightEdge = leftEdge + t.width
      if (leftEdge < PAD) next = PAD - leftEdge
      else if (rightEdge > vw - PAD) next = vw - PAD - rightEdge
    }
    if (next !== offset) setOffset(next)
  }, [anchor, position, offset])

  if (!text) return children

  if (portal) {
    const show = () => {
      const r = ref.current?.getBoundingClientRect()
      if (!r) return
      setOffset(0)
      setAnchor({
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        cx: r.left + r.width / 2,
        cy: r.top + r.height / 2,
      })
    }
    const hide = () => setAnchor(null)
    const transforms = {
      top: `translate(calc(-50% + ${offset}px), -100%)`,
      bottom: `translate(calc(-50% + ${offset}px), 0)`,
      left: `translate(-100%, calc(-50% + ${offset}px))`,
      right: `translateY(calc(-50% + ${offset}px))`,
    }
    const styles = anchor && {
      top: position === 'top' ? anchor.top - GAP : position === 'bottom' ? anchor.bottom + GAP : anchor.cy,
      left: position === 'right' ? anchor.right + GAP : position === 'left' ? anchor.left - GAP : anchor.cx,
      transform: transforms[position] || transforms.top,
    }
    return (
      <span
        ref={ref}
        className={`inline-flex ${className}`}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={(e) => {
          /* A mouse click also focuses the button; without this check the
             tooltip would stick after the pointer leaves until something else
             takes focus. Keyboard focus keeps `:focus-visible` true. */
          if (e.target.matches(':focus-visible')) show()
        }}
        onBlur={hide}
      >
        {children}
        {anchor && createPortal(
          <div ref={tipRef} role="tooltip" className="tt-pop" data-pos={position} style={styles}>
            {text}
          </div>,
          document.body
        )}
      </span>
    )
  }

  return (
    <span ref={ref} className={`tt ${className}`} data-pos={position} data-tip={text}>
      {children}
    </span>
  )
}
