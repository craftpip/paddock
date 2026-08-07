import { useEffect, useRef, useState } from 'react'

const STATUS_ICON = {
  ok: { sym: '✓', cls: 'text-success' },
  error: { sym: '✗', cls: 'text-danger' },
  warn: { sym: '~', cls: 'text-warning' },
  running: { sym: '·', cls: 'text-ink-dim' },
}

/**
 * Live container health checkup popup. Streams each check from
 * `/api/agents/:name/health-log` as a checklist row (✓ pass / ✗ fail / ~ warn),
 * then shows a summary. Mirrors CommandModal's SSE plumbing.
 */
export default function HealthCheckModal({ name, title, onDone, onClose }) {
  const [phase, setPhase] = useState('running') // running | done | failed
  const [checks, setChecks] = useState([])
  const [summary, setSummary] = useState(null)
  const [error, setError] = useState('')
  const esRef = useRef(null)

  useEffect(() => {
    const es = new EventSource(`/api/agents/${name}/health-log`)
    esRef.current = es

    es.addEventListener('check', (e) => {
      try {
        const d = JSON.parse(e.data)
        setChecks((prev) => [
          ...prev,
          { key: d.key, label: d.label, status: d.status, expected: d.expected, actual: d.actual, hint: d.hint },
        ])
      } catch {}
    })

    es.addEventListener('done', (e) => {
      try { es.close() } catch {}
      esRef.current = null
      try {
        const d = JSON.parse(e.data)
        if (d.counts) setSummary(d.counts)
      } catch {}
      setPhase('done')
      if (onDone) onDone()
    })

    es.addEventListener('error', (e) => {
      if (!esRef.current) return // closed normally after done
      if (e.data) {
        try {
          const d = JSON.parse(e.data)
          setError(d.message || 'Health check failed')
        } catch {
          setError('Health check failed')
        }
      } else {
        setError('Connection lost — re-run the check.')
      }
      setPhase('failed')
    })

    return () => {
      try { es.close() } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  const counts = { ok: 0, warn: 0, error: 0 }
  for (const c of checks) if (counts[c.status] !== undefined) counts[c.status]++

  const overall = phase === 'failed'
    ? 'failed'
    : phase === 'running'
      ? 'running'
      : summary
        ? summary.error ? 'error' : summary.warn ? 'warn' : 'ok'
        : 'ok'

  const badgeCls =
    overall === 'ok'
      ? 'bg-success-soft text-success'
      : overall === 'warn'
        ? 'bg-warning-soft text-warning'
        : 'bg-danger-soft text-danger'
  const badgeText =
    phase === 'running'
      ? 'Running…'
      : phase === 'failed'
        ? 'Failed'
        : overall === 'ok'
          ? 'Healthy'
          : overall === 'warn'
            ? 'Issues found'
            : 'Problems found'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h3 className="text-base font-semibold text-ink">{title || 'Health Check'}</h3>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${badgeCls}`}>{badgeText}</span>
        </div>

        <div className="px-5">
          <ul className="mt-2 space-y-2.5 max-h-96 overflow-y-auto pr-1">
            {checks.map((c, i) => {
              const ic = STATUS_ICON[c.status] || STATUS_ICON.running
              const showDetail = c.status !== 'ok' && (c.expected || c.actual)
              return (
                <li key={`${c.key}-${i}`} className="flex items-center gap-2.5">
                  <span className={`text-sm leading-none font-bold shrink-0 ${ic.cls}`}>{ic.sym}</span>
                  <div className="min-w-0">
                    <p className="text-xs text-ink-muted">{c.label}</p>
                    {showDetail && (
                      <p className="text-xs font-mono text-ink-faint mt-0.5 break-all">
                        expected: {c.expected} · found: {c.actual}
                      </p>
                    )}
                    {c.hint && <p className="text-xs text-ink-dim mt-0.5">{c.hint}</p>}
                  </div>
                </li>
              )
            })}
            {phase === 'running' && checks.length === 0 && (
              <li className="text-xs text-ink-dim py-3">Running checkup…</li>
            )}
          </ul>

          {phase === 'failed' && error && (
            <p className="mt-3 bg-danger-soft border border-danger-line rounded-lg p-3 text-xs text-danger whitespace-pre-wrap">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4">
          <p className="mr-auto text-xs text-ink-dim">
            {counts.ok} ✓ · {counts.warn} ~ · {counts.error} ✗
          </p>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-ink bg-raised hover:bg-raised-hover rounded-lg transition-colors"
          >
            {phase === 'running' ? 'Close' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
