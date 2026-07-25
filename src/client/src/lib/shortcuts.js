import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

export function useKeyboardShortcuts() {
  const navigate = useNavigate()

  useEffect(() => {
    function handler(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return

      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        const searchInput = document.getElementById('global-search')
        if (searchInput) { searchInput.focus(); return }
        const input = document.querySelector('input[type="text"]')
        if (input) input.focus()
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault()
        navigate('/agents/create')
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        const saveBtn = document.querySelector('[data-shortcut="save"]')
        if (saveBtn) {
          e.preventDefault()
          saveBtn.click()
        }
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [navigate])
}
