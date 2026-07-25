import { createContext, useContext, useState, useCallback, useRef } from 'react'

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

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) handleCancel()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') handleCancel()
  }

  return (
    <ConfirmContext.Provider value={showConfirm}>
      {children}
      {state && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={handleBackdrop}
          onKeyDown={handleKeyDown}
          tabIndex={-1}
        >
          <div
            className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
            role="dialog"
            aria-modal="true"
          >
            <div className="px-6 pt-5 pb-3">
              <h3 className={`text-base font-semibold ${state.danger ? 'text-red-400' : 'text-slate-100'}`}>
                {state.title || 'Confirm'}
              </h3>
              {state.message && (
                <div className="mt-2 text-sm text-slate-400 leading-relaxed whitespace-pre-wrap">{state.message}</div>
              )}
            </div>
            <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-2">
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800 rounded-lg transition-colors"
              >
                {state.cancelText || 'Cancel'}
              </button>
              <button
                onClick={handleConfirm}
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors ${
                  state.danger
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-cyan-600 hover:bg-cyan-500'
                }`}
              >
                {state.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  return useContext(ConfirmContext)
}
