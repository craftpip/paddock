import { useEffect, useRef, useState } from 'react'

/**
 * Self-contained prompt dialog (replaces window.prompt).
 * Renders a single text input and resolves through onCancel / onSubmit.
 */
export default function PromptModal({ title, message, initialValue = '', placeholder, confirmText = 'OK', danger, onCancel, onSubmit }) {
  const [value, setValue] = useState(initialValue)
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  function handleBackdrop(e) {
    if (e.target === e.currentTarget) onCancel()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm"
      onClick={handleBackdrop}
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden focus:outline-none"
      >
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(value) }}>
          <div className="px-6 pt-5 pb-3">
            <h3 className={`text-base font-semibold ${danger ? 'text-danger' : 'text-ink'}`}>
              {title || 'Enter value'}
            </h3>
            {message && (
              <div className="mt-2 text-sm text-ink-faint leading-relaxed whitespace-pre-wrap">{message}</div>
            )}
          </div>
          <div className="px-6 pb-4">
            <input
              ref={inputRef}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              className="w-full px-3 py-2 text-sm bg-sunken border border-line rounded-lg text-ink focus:border-accent-line focus:outline-none placeholder-ink-dim"
            />
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
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                danger ? 'bg-danger hover:bg-danger text-danger-ink' : 'bg-accent hover:bg-accent-hover text-accent-ink'
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
