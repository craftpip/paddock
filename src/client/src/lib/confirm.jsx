import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import Modal from '../components/ui/Modal'
import Button from '../components/ui/Button'

const ConfirmContext = createContext()

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const resolveRef = useRef(null)

  const showConfirm = useCallback(({ title, message, danger, confirmText, cancelText }) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setState({ title, message, danger, confirmText, cancelText })
    })
  }, [])

  function handleConfirm() {
    const resolve = resolveRef.current
    setState(null)
    resolveRef.current = null
    if (resolve) resolve(true)
  }

  function handleCancel() {
    const resolve = resolveRef.current
    setState(null)
    resolveRef.current = null
    if (resolve) resolve(false)
  }

  // Modal handles Escape and backdrop-click. This adds only the Enter shortcut,
  // and only when focus is not already on a button — otherwise Enter would
  // fire the focused button AND resolve the dialog. Enter means CONFIRM here.
  useEffect(() => {
    if (!state) return
    function onKeyDown(e) {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault()
        handleConfirm()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state])

  return (
    <ConfirmContext.Provider value={showConfirm}>
      {children}
      <Modal
        open={!!state}
        onClose={handleCancel}
        title={state?.title || 'Confirm'}
        tone={state?.danger ? 'danger' : undefined}
        z="z-[80]"
        footer={
          <>
            <Button variant="ghost" size="lg" onClick={handleCancel}>
              {state?.cancelText || 'Cancel'}
            </Button>
            <Button variant={state?.danger ? 'danger' : 'primary'} size="lg" onClick={handleConfirm}>
              {state?.confirmText || 'Confirm'}
            </Button>
          </>
        }
      >
        {state?.message && (
          <div className="text-sm text-ink-faint leading-relaxed whitespace-pre-wrap">{state.message}</div>
        )}
      </Modal>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmContext)
}
