import { useRef } from 'react'
import Button from './ui/Button'
import { Textarea } from './ui/Input'
import { cx } from '../lib/cx'

// Plan 91 §Phase 3: the reusable prompt-template editor. Controlled
// value/onChange; knows nothing about Mission, runners, API calls or
// sessions — the dialog supplies the catalogue, validation errors, preview
// and reset behavior as props. One instance edits one dispatch kind.
//
// Insert-at-caret never replaces the draft: the token is spliced at the
// current selection and the caret lands after it. Validation errors arrive
// with line/column from the server renderer (the authority); this component
// never reimplements the engine.
export default function PromptTemplateEditor({
  value,
  onChange,
  catalogue,
  errors = [],
  preview = null, // { text, sources, pending } | null
  onPreview,
  onReset,
  id,
}) {
  const areaRef = useRef(null)

  const insertAtCaret = (name) => {
    const el = areaRef.current
    const token = `{{${name}}}`
    if (!el) {
      onChange(value ? `${value}${token}` : token)
      return
    }
    const start = el.selectionStart ?? value.length
    const end = el.selectionEnd ?? value.length
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`
    onChange(next)
    // Restore focus and park the caret after the inserted token.
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + token.length
      el.setSelectionRange(pos, pos)
    })
  }

  const varNames = Object.keys(catalogue || {})
  const sampleVars = preview && preview.sources
    ? varNames.filter((n) => preview.sources[n] === 'sample')
    : []

  return (
    <div className="msn-prompt-editor flex min-w-0 flex-1 flex-col gap-2">
      <Textarea
        ref={areaRef}
        mono
        rows={10}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        invalid={errors.length > 0}
        spellCheck={false}
        aria-label="Prompt template source"
        className="msn-prompt-textarea max-h-72 min-h-32 font-mono text-xs leading-relaxed"
      />
      {errors.length > 0 && (
        <ul className="msn-prompt-errors flex flex-col gap-1">
          {errors.map((e, i) => (
            <li key={i} className="msn-prompt-error rounded-control border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
              {e.message}
              {typeof e.line === 'number' && ` (line ${e.line}${typeof e.column === 'number' ? `, col ${e.column}` : ''})`}
            </li>
          ))}
        </ul>
      )}
      <div className="msn-prompt-vars rounded-control border border-line-faint bg-sunken px-2 py-1.5">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Variables — insert at caret
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {varNames.map((name) => (
            <Button
              key={name}
              type="button"
              variant="secondary"
              size="bare"
              onClick={() => insertAtCaret(name)}
              title={`${name} — ${catalogue[name]?.description || ''}${catalogue[name]?.required === false ? ' (optional; empty when absent)' : ''}`}
              className="msn-prompt-insert px-1.5 py-0.5 font-mono text-[10px]"
            >
              {name}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onPreview}
          loading={!!preview?.pending}
          className="msn-prompt-preview-btn"
        >
          {preview?.pending ? 'Rendering…' : 'Preview rendered prompt'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReset}
          className="msn-prompt-reset"
          title="Restore the shipped default into this draft (needs Save to persist)"
        >
          Reset this prompt
        </Button>
      </div>
      {preview && !preview.pending && preview.text != null && (
        <div className="msn-prompt-preview rounded-control border border-line-faint bg-raised px-2 py-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Rendered — exactly what would be sent
          </div>
          {sampleVars.length > 0 && (
            <div className="msn-prompt-preview-samples mt-0.5 text-[10px] text-ink-faint">
              Sample values: {sampleVars.join(', ')}
            </div>
          )}
          <pre className={cx('msn-prompt-preview-text mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink')}>
            {preview.text}
          </pre>
        </div>
      )}
    </div>
  )
}
