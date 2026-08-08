import { useEffect, useRef } from 'react'

/**
 * Tooltip — shows its text instantly on hover/focus, with no browser `title`
 * delay. Pure CSS (pseudo-elements), themes with the existing light/dark
 * tokens. Stays inside the viewport: when the centered tooltip would spill
 * past a window edge it is clamped via `--tt-shift` (recomputed on hover,
 * focus, scroll and resize).
 *
 * <Tooltip text="Copy URL" position="bottom">
 *   <button>⧉</button>
 * </Tooltip>
 *
 * position: 'top' | 'bottom' | 'left' | 'right' (default 'top')
 * Pass text={''} or omit it to render children without a wrapper.
 */
export default function Tooltip({ text, position = 'top', className = '', children }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el || !text) return

    const update = () => {
      const r = el.getBoundingClientRect()
      const vw = document.documentElement.clientWidth
      const vh = document.documentElement.clientHeight
      const tip = getComputedStyle(el, '::after')
      const w = parseFloat(tip.width) || 0
      const h = parseFloat(tip.height) || 0
      const pad = 8
      let shift = 0
      if (position === 'top' || position === 'bottom') {
        const leftEdge = r.left + r.width / 2 - w / 2
        const rightEdge = leftEdge + w
        if (leftEdge < pad) shift = pad - leftEdge
        else if (rightEdge > vw - pad) shift = vw - pad - rightEdge
      } else {
        const topEdge = r.top + r.height / 2 - h / 2
        const bottomEdge = topEdge + h
        if (topEdge < pad) shift = pad - topEdge
        else if (bottomEdge > vh - pad) shift = vh - pad - bottomEdge
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
  }, [text, position])

  if (!text) return children
  return (
    <span ref={ref} className={`tt ${className}`} data-pos={position} data-tip={text}>
      {children}
    </span>
  )
}
