import Button from './ui/Button'
import { Textarea } from './ui/Input'
import Switch from './ui/Switch'
import { callbackOutput } from '../lib/callback-output'

// Plan 92 §Phase 4: the reusable per-event shell-script editor. Controlled
// value/enabled; knows nothing about Mission, runners or API calls. The
// script is PLAIN TEXT — never template-expanded, never previewed as a
// prompt — and saving never executes it (server-enforced).
export default function CallbackScriptEditor({
  eventKey,
  meaning,
  value,
  onChange,
  enabled,
  onEnabledChange,
  recreateResume = false,
  onRecreateResumeChange,
  envVars = [],
  environment = null, // resolved execution environment { where, shell, cwd, timeoutSeconds }
  result = null, // latest history entry for this event, if any
}) {
  const switchId = `msn-callback-switch-${eventKey}`
  const display = result ? callbackOutput(result) : null
  return (
    <div className="msn-callback-editor flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Switch
          checked={!!enabled}
          onChange={onEnabledChange}
          id={switchId}
          label={`Enable ${eventKey} callback`}
        />
        <label htmlFor={switchId} className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          {eventKey} {enabled ? '— enabled' : '— disabled'}
        </label>
      </div>
      <p className="msn-callback-meaning text-[11px] text-ink-dim">{meaning}</p>
      {eventKey === 'usage_exhausted' && (
        <div className="msn-callback-recovery flex flex-col gap-1">
          <label className="flex items-center gap-2 text-xs text-ink">
            <Switch checked={recreateResume} onChange={onRecreateResumeChange} label="Resume queue after recovery script succeeds" />
            Resume queue after recovery script succeeds
          </label>
          <p className="text-[11px] text-ink-dim">Your script controls rotation and recreation. Use paddock pad recreate "$PADDOCK_AGENT_NAME" when ready. Exit 0 restores the same conversation after recreation; exit 75 keeps the queue paused.</p>
        </div>
      )}
      {environment && (
        <p className="msn-callback-environment text-[10px] text-ink-faint">
          Runs {environment.where} with <code className="font-mono">{environment.shell}</code> ·
          cwd {environment.cwd} · timeout {environment.timeoutSeconds}s
        </p>
      )}
      <Textarea
        mono
        rows={8}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={`${eventKey} callback script`}
        placeholder="#!/bin/sh&#10;# Runs in a system shell, outside the LLM conversation."
        className="msn-callback-script max-h-64 min-h-24 font-mono text-xs leading-relaxed"
      />
      {envVars.length > 0 && (
        <details className="msn-callback-env rounded-control border border-line-faint bg-sunken px-2 py-1.5">
          <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Environment variables available to the script
          </summary>
          <div className="mt-1 flex flex-wrap gap-1">
            {envVars.map((name) => (
              <code key={name} className="rounded bg-raised px-1 py-0.5 font-mono text-[10px] text-ink-dim">
                {name}
              </code>
            ))}
          </div>
        </details>
      )}
      {result && (
        <div className="msn-callback-result rounded-control border border-line-faint bg-raised px-2 py-1.5 text-[11px]">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
            Most recent run — {display.label}{result.exit_code != null ? ` (exit ${result.exit_code})` : ''}
          </div>
          <div className="mt-0.5 text-[10px] text-ink-faint">
            {[result.started_at && `started ${result.started_at}`, result.ended_at && `ended ${result.ended_at}`].filter(Boolean).join(' · ') || 'timestamps unavailable'}
            {result.truncated ? ' · output truncated' : ''}
          </div>
          {display.output && (
            <pre className="msn-callback-output mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink">Output: {display.output}</pre>
          )}
          {display.diagnostics && (
            <pre className={`msn-callback-diagnostics mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-[11px] ${display.failed ? 'text-danger' : 'text-ink'}`}>{display.failed ? 'Error details' : 'Additional output'}: {display.diagnostics}</pre>
          )}
          <p className="mt-1 text-[10px] text-ink-faint">
            Owner-scoped user-script output — it may contain whatever the script printed.
          </p>
        </div>
      )}
    </div>
  )
}

// Event-kind tab row, shared by the dialog's Callbacks section.
export function CallbackKindTabs({ kinds, kind, onKind, errors = {}, dirtyKinds = [] }) {
  return (
    <div role="tablist" aria-label="Callback events" className="msn-callback-kinds flex flex-wrap gap-1">
      {kinds.map((k) => (
        <Button
          key={k}
          type="button"
          variant={kind === k ? 'primary' : 'secondary'}
          size="sm"
          role="tab"
          aria-selected={kind === k}
          onClick={() => onKind(k)}
          className="msn-callback-kind"
        >
          {k}
          {(errors[k] && errors[k].length > 0) ? ' ⚠' : ''}
          {dirtyKinds.includes(k) ? ' •' : ''}
        </Button>
      ))}
    </div>
  )
}
