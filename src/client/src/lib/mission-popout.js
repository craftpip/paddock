const PREFIX = 'pad-mission-popout-v1:'
const defaults = { width: 980, height: 720, left: 80, top: 60 }

export function popoutStorageKey(userId) {
  return `${PREFIX}${userId || 'anonymous'}`
}

/** The screen a popup can use, or null when none is readable. `availLeft` /
 *  `availTop` are where a non-primary display starts, so a display left of the
 *  primary has a negative origin and that is a legal position. */
function availableArea(scr) {
  if (!scr || !Number.isFinite(scr.availWidth) || !Number.isFinite(scr.availHeight)) return null
  if (scr.availWidth <= 0 || scr.availHeight <= 0) return null
  return {
    left: Number.isFinite(scr.availLeft) ? scr.availLeft : 0,
    top: Number.isFinite(scr.availTop) ? scr.availTop : 0,
    width: scr.availWidth,
    height: scr.availHeight,
  }
}

/** Fit saved bounds inside the screen the popup opens on: a size bigger than
 *  the screen shrinks to it, and a position that would put the window off the
 *  screen (a monitor that was unplugged, a resolution that shrank) moves back
 *  onto it. With no readable screen the bounds are returned as saved. */
export function clampToScreen(geometry, scr) {
  const area = availableArea(scr)
  if (!area) return geometry
  const width = Math.min(geometry.width, area.width)
  const height = Math.min(geometry.height, area.height)
  const left = Math.min(Math.max(geometry.left, area.left), area.left + area.width - width)
  const top = Math.min(Math.max(geometry.top, area.top), area.top + area.height - height)
  return { width, height, left, top }
}

export function readPopoutGeometry(userId, scr = typeof window !== 'undefined' ? window.screen : undefined) {
  let saved = defaults
  try {
    const value = JSON.parse(localStorage.getItem(popoutStorageKey(userId)) || 'null')
    if (value && ['width', 'height', 'left', 'top'].every((key) => Number.isFinite(value[key]))) {
      saved = {
        width: Math.max(480, Math.round(value.width)),
        height: Math.max(360, Math.round(value.height)),
        left: Math.round(value.left),
        top: Math.round(value.top),
      }
    }
  } catch {
    saved = defaults
  }
  return clampToScreen(saved, scr)
}

export function writePopoutGeometry(userId, win = window) {
  const value = { width: win.outerWidth, height: win.outerHeight, left: win.screenX, top: win.screenY }
  if (!['width', 'height', 'left', 'top'].every((key) => Number.isFinite(value[key]))) return
  try { localStorage.setItem(popoutStorageKey(userId), JSON.stringify(value)) } catch {}
}

const windows = new Map()

export function openMissionPopout(sessionId, userId) {
  const existing = windows.get(sessionId)
  if (existing && !existing.closed) {
    existing.focus()
    return Promise.resolve({ reused: true })
  }
  const geometry = readPopoutGeometry(userId)
  const name = `paddock-mission-session-${sessionId}`
  const features = `popup=yes,noopener=no,toolbar=no,location=no,menubar=no,status=no,resizable=yes,width=${geometry.width},height=${geometry.height},left=${geometry.left},top=${geometry.top}`
  const popup = window.open(`/mission/session/${encodeURIComponent(sessionId)}`, name, features)
  if (!popup) return Promise.reject(new Error('Your browser blocked the popup. Allow popups for Paddock and try again.'))
  windows.set(sessionId, popup)
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => finish(new Error('The popup did not finish loading.')), 10000)
    const finish = (error, result) => {
      window.clearTimeout(timeout)
      window.removeEventListener('message', receive)
      if (error) {
        if (windows.get(sessionId) === popup) windows.delete(sessionId)
        reject(error)
      } else resolve(result)
    }
    const receive = (event) => {
      if (event.origin !== window.location.origin || event.source !== popup || event.data?.sessionId !== sessionId) return
      if (event.data.type === 'paddock:mission-popout-ready') finish(null, { popup })
      if (event.data.type === 'paddock:mission-popout-failed') finish(new Error(event.data.message || 'The popup could not open this session.'))
    }
    window.addEventListener('message', receive)
  })
}
