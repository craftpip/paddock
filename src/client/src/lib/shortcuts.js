import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/** True when the key belongs to whatever the user is typing in: a text field,
 *  an editable element, or a terminal (xterm). Shortcuts never fire there. */
export function isTypingTarget(target) {
  if (!target) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable || !!target.closest?.('.xterm')
}

/** The global shortcuts, as a plain function so a test can drive it with a fake
 *  event and document. `doc` defaults to the page. */
export function handleShortcut(e, navigate, doc = document) {
  if (isTypingTarget(e.target)) return

  // Alt+Q: open/close the Mission queue panel. e.code too, because macOS
  // Option+Q types "œ" into e.key.
  if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'KeyQ' || e.key?.toLowerCase() === 'q')) {
    const queueToggle = doc.querySelector('.msn-queue-toggle')
    if (queueToggle) {
      e.preventDefault()
      queueToggle.click()
    }
    return
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault()
    const searchInput = doc.getElementById('global-search')
    if (searchInput) { searchInput.focus(); return }
    const input = doc.querySelector('input[type="text"]')
    if (input) input.focus()
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
    e.preventDefault()
    navigate('/agents/create')
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    const saveBtn = doc.querySelector('[data-shortcut="save"]')
    if (saveBtn) {
      e.preventDefault()
      saveBtn.click()
    }
  }
}

export function useKeyboardShortcuts() {
  const navigate = useNavigate()

  useEffect(() => {
    const handler = (e) => handleShortcut(e, navigate)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate])
}
