import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

const AlertContext = createContext()

export function AlertProvider({ children }) {
  const [state, setState] = useState(null)
  const resolveRef = useRef(null)
  const dialogRef = useRef(null)

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

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) handleCancel()
  }

  useEffect(() => {
    if (!state) return
    dialogRef.current?.focus()
    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault()
        handleOk()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return (
    <AlertContext.Provider value={showAlert}>
      {children}
      {state && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm"
          onClick={handleBackdrop}
        >
          <div
            ref={dialogRef}
            tabIndex={-1}
            className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden focus:outline-none"
            role="alertdialog"
            aria-modal="true"
          >
            <div className="px-6 pt-5 pb-3">
              <h3 className={`text-base font-semibold ${state.danger ? 'text-danger' : 'text-ink'}`}>
                {state.title || 'Alert'}
              </h3>
              {state.message && (
                <div className="mt-2 text-sm text-ink-faint leading-relaxed whitespace-pre-wrap">{state.message}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-2">
              {state.cancelText && (
                <button
                  onClick={handleCancel}
                  className="px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-panel rounded-lg transition-colors"
                >
                  {state.cancelText}
                </button>
              )}
              <button
                onClick={handleOk}
                className={`px-4 py-2 text-sm font-medium text-ink rounded-lg transition-colors ${
                  state.danger ? 'bg-danger hover:bg-danger' : 'bg-accent hover:bg-accent-hover'
                }`}
              >
                {state.okText || 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </AlertContext.Provider>
  )
}

export function useAlert() {
  return useContext(AlertContext)
}
