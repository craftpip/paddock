import { useEffect, useRef, useState } from 'react'
import { cx } from '../lib/cx'
import Modal from './ui/Modal'
import Button from './ui/Button'
import Badge from './ui/Badge'
import { TONES } from './ui/tone'

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

  const badgeTone = overall === 'ok' ? 'success' : overall === 'warn' ? 'warning' : 'danger'
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
    <Modal
      open
      onClose={onClose}
      title={title || 'Health Check'}
      width="max-w-2xl"
      headerExtra={<Badge tone={badgeTone}>{badgeText}</Badge>}
      footer={
        <>
          <p className="mr-auto text-xs text-ink-dim">
            {counts.ok} ✓ · {counts.warn} ~ · {counts.error} ✗
          </p>
          <Button variant="secondary" size="lg" onClick={onClose}>
            {phase === 'running' ? 'Close' : 'Done'}
          </Button>
        </>
      }
    >
      <ul className="mt-2 space-y-2.5 max-h-96 overflow-y-auto pr-1">
        {checks.map((c, i) => {
          const ic = STATUS_ICON[c.status] || STATUS_ICON.running
          const showDetail = c.status !== 'ok' && (c.expected || c.actual)
          return (
            <li key={`${c.key}-${i}`} className="flex items-center gap-2.5">
              <span className={cx('text-sm leading-none font-bold shrink-0', ic.cls)}>{ic.sym}</span>
              <div className="min-w-0">
                <p className="text-xs text-ink-muted">{c.label}</p>
                {showDetail && (
                  <p className="text-xs font-mono text-ink-dim mt-0.5 break-all">
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
        <p className={cx('mt-3 rounded-card border p-3 text-xs whitespace-pre-wrap', TONES.danger.panel)}>{error}</p>
      )}
    </Modal>
  )
}
