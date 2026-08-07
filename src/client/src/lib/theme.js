const KEY = 'paddock-theme'

export function getStoredTheme() {
  try {
    return localStorage.getItem(KEY) || 'dark'
  } catch {
    return 'dark'
  }
}

export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark'
}

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', t)
  try {
    localStorage.setItem(KEY, t)
  } catch {}
  window.dispatchEvent(new CustomEvent('paddock:theme', { detail: t }))
  return t
}

export function toggleTheme() {
  return applyTheme(getTheme() === 'dark' ? 'light' : 'dark')
}
