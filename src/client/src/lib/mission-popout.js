const PREFIX = 'pad-mission-popout-v1:'
const defaults = { width: 980, height: 720, left: 80, top: 60 }

export function popoutStorageKey(userId) {
  return `${PREFIX}${userId || 'anonymous'}`
}

export function readPopoutGeometry(userId) {
  try {
    const value = JSON.parse(localStorage.getItem(popoutStorageKey(userId)) || 'null')
    if (!value || !['width', 'height', 'left', 'top'].every((key) => Number.isFinite(value[key]))) return defaults
    return {
      width: Math.max(480, Math.round(value.width)),
      height: Math.max(360, Math.round(value.height)),
      left: Math.round(value.left),
      top: Math.round(value.top),
    }
  } catch {
    return defaults
  }
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
