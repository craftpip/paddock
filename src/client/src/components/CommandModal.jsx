import { useEffect, useRef, useState } from 'react'
import Console from './Console'
import Modal from './ui/Modal'
import Button from './ui/Button'
import Badge from './ui/Badge'
import { TONES } from './ui/tone'
import { cx } from '../lib/cx'

const STEP_COMMANDS = {
  stop: (name) => `docker stop ${name}`,
  build: (name) => `docker compose -f instances/${name}/docker-compose.yml build --pull`,
  reset: (name) => `wipe user data folder (instances/${name}/<agent>)`,
  recreate: (name) => `docker compose -f instances/${name}/docker-compose.yml up -d --no-deps --force-recreate`,
  'web-hook': (name) => `write start-web.sh boot hook`,
  'web-compose': (name) => `update docker-compose.yml (publish port)`,
  'web-start': (name) => `start web server inside the container`,
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

  const PHASE_TONE = { running: 'accent', done: 'success', failed: 'danger' }
  const PHASE_LABEL = { running: 'Running…', done: 'Done', failed: 'Failed' }

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      width="max-w-2xl"
      headerExtra={<Badge tone={PHASE_TONE[phase]}>{PHASE_LABEL[phase]}</Badge>}
      footer={
        <>
          {busy && (
            <p className="mr-auto text-xs text-ink-dim">
              You can close this — the operation continues in the background.
            </p>
          )}
          <Button variant="secondary" size="lg" onClick={onClose}>
            {phase === 'done' ? 'Done' : 'Close'}
          </Button>
        </>
      }
    >
      <Console label="Command output" runningCmd={runningCmd} lines={lines} emptyMessage="Waiting for output…" className="h-72" />
      {phase === 'failed' && (
        <p className={cx('mt-3 rounded-card border p-3 text-xs whitespace-pre-wrap', TONES.danger.panel)}>{error}</p>
      )}
    </Modal>
  )
}
