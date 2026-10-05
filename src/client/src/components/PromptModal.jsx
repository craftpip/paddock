import { useEffect, useRef, useState } from 'react'
import Modal from './ui/Modal'
import Button from './ui/Button'
import { Input } from './ui/Input'

const FORM_ID = 'paddock-prompt-modal-form'

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
          <Button type="submit" form={FORM_ID} variant={danger ? 'danger' : 'primary'} size="lg">
            {confirmText || 'OK'}
          </Button>
        </>
      }
    >
      {/* the confirm button lives in Modal's footer, outside this <form>, so it
          carries form={FORM_ID} to submit it — same trick as lib/prompt.jsx */}
      <form
        id={FORM_ID}
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(value)
        }}
      >
        {message && (
          <div className="text-sm text-ink-faint leading-relaxed whitespace-pre-wrap mb-4">{message}</div>
        )}
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
      </form>
    </Modal>
  )
}
