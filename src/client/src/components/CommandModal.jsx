import { useEffect, useRef, useState } from 'react'
import Console from './Console'

const STEP_COMMANDS = {
  stop: (name) => `docker stop ${name}`,
  build: (name) => `docker compose -f instances/${name}/docker-compose.yml build --pull`,
  recreate: (name) => `docker compose -f instances/${name}/docker-compose.yml up -d --no-deps --force-recreate`,
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

/**
 * Modal that streams the live output of a job (update, settings change) from
 * `/api/agents/:name/update-log` in a console. The job keeps running server-side
 * even if the popup is closed.
 */
export default function CommandModal({ name, title, onDone, onClose }) {
  const [phase, setPhase] = useState('running') // running | done | failed
  const [runningCmd, setRunningCmd] = useState('')
  const [lines, setLines] = useState([])
  const [error, setError] = useState('')
  const esRef = useRef(null)

  useEffect(() => {
    const es = new EventSource(`/api/agents/${name}/update-log`)
    esRef.current = es

    es.addEventListener('step', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.state === 'start') {
          const cmd = STEP_COMMANDS[data.step] ? STEP_COMMANDS[data.step](name) : data.step
          setLines((prev) => [...prev, { type: 'cmd', cmd, ts: fmtTime(data.ts) }])
          setRunningCmd(cmd)
        } else if (data.state === 'end' || data.state === 'error') {
          setRunningCmd('')
        }
      } catch {}
    })

    es.addEventListener('line', (e) => {
      try {
        const data = JSON.parse(e.data)
        const type = data.stream === 'stderr' ? 'err' : data.stream === 'system' ? 'sys' : 'out'
        const text = data.text.replace(/\n$/, '')
        if (!text) return
        setLines((prev) => [...prev, { type, text }])
      } catch {}
    })

    es.addEventListener('done', () => {
      try { es.close() } catch {}
      esRef.current = null
      setRunningCmd('')
      setPhase('done')
      onDone()
    })

    es.addEventListener('error', (e) => {
      if (e.data) {
        try {
          const data = JSON.parse(e.data)
          setError(data.message || 'Operation failed')
        } catch {
          setError('Operation failed')
        }
      } else {
        setError('Connection lost — the operation continues in the background.')
      }
      setRunningCmd('')
      setPhase('failed')
    })

    return () => {
      try { es.close() } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const busy = phase === 'running'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="bg-slate-900 border border-slate-700 rounded-xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden focus:outline-none"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              phase === 'running'
                ? 'bg-cyan-900/60 text-cyan-300'
                : phase === 'done'
                  ? 'bg-emerald-900/60 text-emerald-300'
                  : 'bg-red-900/60 text-red-300'
            }`}
          >
            {phase === 'running' ? 'Running…' : phase === 'done' ? 'Done' : 'Failed'}
          </span>
        </div>

        <div className="px-5">
          <Console label="Command output" runningCmd={runningCmd} lines={lines} emptyMessage="Waiting for output…" className="h-72" />
          {phase === 'failed' && (
            <p className="mt-3 bg-red-900/50 border border-red-800 rounded-lg p-3 text-xs text-red-400 whitespace-pre-wrap">{error}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-5 py-4">
          {busy && <p className="mr-auto text-xs text-slate-500">You can close this — the operation continues in the background.</p>}
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-white bg-slate-700 hover:bg-slate-600 rounded-lg transition-colors"
          >
            {phase === 'done' ? 'Done' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
