import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

const PromptContext = createContext()

export function PromptProvider({ children }) {
  const [state, setState] = useState(null)
  const resolveRef = useRef(null)

  const showPrompt = useCallback(({ title, message, fields, confirmText, danger }) => {
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setState({ title, message, fields, confirmText, danger })
    })
  }, [])

  function close(value) {
    const resolve = resolveRef.current
    setState(null)
    resolveRef.current = null
    if (resolve) resolve(value)
  }

  function handleSubmit(values) {
    close(values)
  }

  function handleCancel() {
    close(null)
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) handleCancel()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') handleCancel()
  }

  return (
    <PromptContext.Provider value={showPrompt}>
      {children}
      {state && (
        <PromptModal
          title={state.title}
          message={state.message}
          fields={state.fields}
          confirmText={state.confirmText}
          danger={state.danger}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onBackdrop={handleBackdrop}
          onKeyDown={handleKeyDown}
        />
      )}
    </PromptContext.Provider>
  )
}

function PromptModal({ title, message, fields, confirmText, danger, onSubmit, onCancel, onBackdrop, onKeyDown }) {
  const [values, setValues] = useState(() => {
    const v = {}
    for (const f of fields || []) v[f.key] = f.defaultValue || ''
    return v
  })
  const firstRef = useRef(null)

  useEffect(() => { firstRef.current?.focus() }, [])

  function set(key, value) {
    setValues((v) => ({ ...v, [key]: value }))
  }

  function handleSubmit(e) {
    e.preventDefault()
    onSubmit(values)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm"
      onClick={onBackdrop}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div
        className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
        role="dialog"
        aria-modal="true"
      >
        <form onSubmit={handleSubmit}>
          <div className="px-6 pt-5 pb-3">
            <h3 className={`text-base font-semibold ${danger ? 'text-danger' : 'text-ink'}`}>
              {title || 'Enter value'}
            </h3>
            {message && (
              <div className="mt-2 text-sm text-ink-faint leading-relaxed whitespace-pre-wrap">{message}</div>
            )}
          </div>
          <div className="px-6 pb-4 space-y-4">
            {(fields || []).map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-ink-muted mb-1.5">{f.label}</label>
                <input
                  ref={f.key === fields[0].key ? firstRef : null}
                  type={f.type || 'text'}
                  value={values[f.key] || ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="w-full px-3 py-2 text-sm bg-sunken border border-line rounded-lg text-ink focus:border-accent-line focus:outline-none placeholder-ink-dim"
                />
                {f.hint && <p className="mt-1.5 text-xs text-ink-dim leading-relaxed">{f.hint}</p>}
              </div>
            ))}
          </div>
          <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-panel rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className={`px-4 py-2 text-sm font-medium text-ink rounded-lg transition-colors ${
                danger ? 'bg-danger hover:bg-danger' : 'bg-accent hover:bg-accent-hover'
              }`}
            >
              {confirmText || 'OK'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

export function usePrompt() {
  return useContext(PromptContext)
}
