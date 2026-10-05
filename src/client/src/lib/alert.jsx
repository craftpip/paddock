import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import Modal from '../components/ui/Modal'
import Button from '../components/ui/Button'

const AlertContext = createContext()

export function AlertProvider({ children }) {
  const [state, setState] = useState(null)
  const resolveRef = useRef(null)

  const showAlert = useCallback(({ title, message, danger, okText, cancelText }) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setState({ title, message, danger, okText, cancelText })
    })
  }, [])

  function close(result) {
    const resolve = resolveRef.current
    setState(null)
    resolveRef.current = null
    if (resolve) resolve(result)
  }

  function handleOk() {
    close(true)
  }

  function handleCancel() {
    close(false)
  }

  // Modal already closes on Escape and on a backdrop click. This adds only the
  // Enter shortcut, and only when focus is not already on a button — otherwise
  // Enter would fire the focused button AND resolve the dialog.
  useEffect(() => {
    if (!state) return
    function onKeyDown(e) {
      if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault()
        handleOk()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [state])

  return (
    <AlertContext.Provider value={showAlert}>
      {children}
      <Modal
        open={!!state}
        onClose={handleCancel}
        title={state?.title || 'Alert'}
        tone={state?.danger ? 'danger' : undefined}
        role="alertdialog"
        footer={
          <>
            {state?.cancelText && (
              <Button variant="ghost" size="lg" onClick={handleCancel}>
                {state.cancelText}
              </Button>
            )}
            <Button variant={state?.danger ? 'danger' : 'primary'} size="lg" onClick={handleOk}>
              {state?.okText || 'OK'}
            </Button>
          </>
        }
      >
        {state?.message && (
          <div className="text-sm text-ink-faint leading-relaxed whitespace-pre-wrap">{state.message}</div>
        )}
      </Modal>
    </AlertContext.Provider>
  )
}

export function useAlert() {
  return useContext(AlertContext)
}
