import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

const ToastContext = createContext()

let toastId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timersRef = useRef({})

  const addToast = useCallback((message, opts = {}) => {
    const id = ++toastId
    const toast = {
      id,
      message,
      type: opts.type || 'info',
      duration: opts.duration ?? 4000,
      action: opts.action || null,
      actionLabel: opts.actionLabel || null,
    }
    setToasts((prev) => [...prev, toast])
    if (toast.duration > 0) {
      timersRef.current[id] = setTimeout(() => removeToast(id), toast.duration)
    }
    return id
  }, [])

  function removeToast(id) {
    if (timersRef.current[id]) {
      clearTimeout(timersRef.current[id])
      delete timersRef.current[id]
    }
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  useEffect(() => {
    return () => {
      Object.values(timersRef.current).forEach(clearTimeout)
    }
  }, [])

  const toast = useCallback((msg, opts) => addToast(msg, opts), [addToast])
  toast.success = useCallback((msg, opts) => addToast(msg, { ...opts, type: 'success' }), [addToast])
  toast.error = useCallback((msg, opts) => addToast(msg, { ...opts, type: 'error', duration: opts?.duration ?? 6000 }), [addToast])
  toast.info = useCallback((msg, opts) => addToast(msg, { ...opts, type: 'info' }), [addToast])
  toast.warning = useCallback((msg, opts) => addToast(msg, { ...opts, type: 'warning', duration: opts?.duration ?? 5000 }), [addToast])

  function handleAction(id, action) {
    removeToast(id)
    if (action) action()
  }

  const TYPE_STYLES = {
    success: 'bg-success-soft border-success-line text-success',
    error: 'bg-danger-soft border-danger-line text-danger',
    warning: 'bg-warning-soft border-warning-line text-warning',
    info: 'bg-panel/90 border-line-faint text-ink',
  }

  const TYPE_ICONS = {
    success: (
      <svg className="w-4 h-4 text-success flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg className="w-4 h-4 text-danger flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    warning: (
      <svg className="w-4 h-4 text-warning flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
    ),
    info: (
      <svg className="w-4 h-4 text-accent-text flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  }

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="fixed top-4 right-4 z-[70] flex flex-col gap-2 w-80 pointer-events-none" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg border shadow-xl backdrop-blur-sm transition-all animate-slide-in ${TYPE_STYLES[t.type]}`}
          >
            {TYPE_ICONS[t.type]}
            <p className="text-sm flex-1 min-w-0">{t.message}</p>
            {t.action && (
              <button
                onClick={() => handleAction(t.id, t.action)}
                className="text-xs font-medium text-accent-text hover:text-accent-text whitespace-nowrap flex-shrink-0"
              >
                {t.actionLabel || 'Undo'}
              </button>
            )}
            <button
              onClick={() => removeToast(t.id)}
              className="text-ink-dim hover:text-ink flex-shrink-0 ml-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
