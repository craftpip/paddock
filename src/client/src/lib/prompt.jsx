import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'
import Modal from '../components/ui/Modal'
import Button from '../components/ui/Button'
import Field from '../components/ui/Field'
import { Input, Select, Checkbox } from '../components/ui/Input'

const PromptContext = createContext()

const FORM_ID = 'paddock-prompt-form'

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
        />
      )}
    </PromptContext.Provider>
  )
}

function PromptModal({ title, message, fields, confirmText, danger, onSubmit, onCancel }) {
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

  // Modal renders its footer OUTSIDE the children, so the confirm button is
  // not inside the <form> — it carries form={FORM_ID} to submit it anyway.
  // (A nested <form> is invalid HTML, and an onClick handler would bypass
  // Enter-to-submit.)
  return (
    <Modal
      open
      onClose={onCancel}
      title={title || 'Enter value'}
      tone={danger ? 'danger' : undefined}
      footer={
        <>
          <Button variant="ghost" size="lg" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={FORM_ID}
            variant={danger ? 'danger' : 'primary'}
            size="lg"
          >
            {confirmText || 'OK'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit}>
        {message && (
          <div className="text-sm text-ink-faint leading-relaxed whitespace-pre-wrap mb-4">{message}</div>
        )}
        <div className="space-y-4">
          {(fields || []).map((f) => {
            if (typeof f.when === 'function' && !f.when(values)) return null
            const opts = Array.isArray(f.options)
              ? f.options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o))
              : []
            const first = f.key === fields[0].key
            return (
              <Field key={f.key} label={f.label} hint={f.hint} labelVariant="compact">
                {f.type === 'select' ? (
                  <Select
                    ref={first ? firstRef : null}
                    value={values[f.key] || ''}
                    onChange={(e) => set(f.key, e.target.value)}
                  >
                    {opts.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                ) : f.type === 'checkbox' ? (
                  <label className="flex items-center gap-2 select-none cursor-pointer">
                    <Checkbox
                      ref={first ? firstRef : null}
                      checked={!!values[f.key]}
                      onChange={(e) => set(f.key, e.target.checked)}
                    />
                    {f.checkLabel && <span className="text-sm text-ink">{f.checkLabel}</span>}
                  </label>
                ) : (
                  <Input
                    ref={first ? firstRef : null}
                    type={f.type || 'text'}
                    value={values[f.key] || ''}
                    onChange={(e) => set(f.key, e.target.value)}
                    placeholder={f.placeholder}
                  />
                )}
              </Field>
            )
          })}
        </div>
      </form>
    </Modal>
  )
}

export function usePrompt() {
  return useContext(PromptContext)
}
