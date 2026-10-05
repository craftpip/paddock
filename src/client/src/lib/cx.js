import { twMerge } from 'tailwind-merge'

/**
 * cx — the ONE class-name joiner for the app.
 *
 * Conditional-join (falsy args drop) + Tailwind conflict resolution: when a
 * caller's class collides with a primitive's base class, the caller's wins
 * instead of both being emitted and the winner decided by stylesheet order.
 * That is what lets `<Button className="w-full">` work without the primitive
 * needing to know about widths.
 *
 * Usage: cx('a', cond && 'b', className)   — always pass className LAST.
 */
export function cx(...parts) {
  const flat = []
  for (const p of parts) {
    if (!p) continue
    if (Array.isArray(p)) flat.push(cx(...p))
    else if (typeof p === 'object') {
      for (const k of Object.keys(p)) if (p[k]) flat.push(k)
    } else flat.push(p)
  }
  return twMerge(flat.filter(Boolean).join(' '))
}

export default cx
