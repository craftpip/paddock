import { useState, useEffect, useRef } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../lib/api'
import Console from '../components/Console'

const STEP_COMMANDS = {
  build: (name) => `docker compose -f instances/${name}/docker-compose.yml build`,
  up: (name) => `docker compose -f instances/${name}/docker-compose.yml up -d`,
  restore: (name) => `Restoring backup into ${name}…`,
  setup: (name) => `docker exec ${name} openclaw setup --baseline`,
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

export default function CreateAgent() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [agentType, setAgentType] = useState('openclaw')
  const [backupFile, setBackupFile] = useState('')
  const [backups, setBackups] = useState([])
  const [prefix, setPrefix] = useState('vm')

  const [phase, setPhase] = useState('idle') // idle | creating | done | failed
  const [lines, setLines] = useState([])
  const [runningCmd, setRunningCmd] = useState('')
  const [error, setError] = useState('')
  const [jobName, setJobName] = useState('')

  const esRef = useRef(null)

  useEffect(() => {
    api('/api/config').then(cfg => {
      if (cfg.containerPrefix) setPrefix(cfg.containerPrefix)
    }).catch(() => {})
    api('/api/backups').then(setBackups).catch(() => {})
    return () => closeStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const filteredBackups = backups.filter(b => {
    if (!b.agentType) return true
    return b.agentType === agentType
  })

  const fullName = `${prefix}-${agentType}-${name || '...'}`
  const isClone = !!backupFile

  function closeStream() {
    if (esRef.current) {
      try { esRef.current.close() } catch {}
      esRef.current = null
    }
  }

  function startStream(job) {
    closeStream()
    const es = new EventSource(`/api/agents/${job}/create-log`)
    esRef.current = es

    es.addEventListener('step', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.state === 'start') {
          const cmd = STEP_COMMANDS[data.step] ? STEP_COMMANDS[data.step](job) : data.step
          setLines(prev => [...prev, { type: 'cmd', cmd, ts: fmtTime(data.ts) }])
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
        setLines(prev => [...prev, { type, text }])
      } catch {}
    })

    es.addEventListener('done', () => {
      closeStream()
      setRunningCmd('')
      setPhase('done')
      if (isClone) {
        setTimeout(() => navigate('/agents/' + job), 1800)
      }
    })

    // Server-sent error event (has data) vs connection loss (no data — the
    // EventSource auto-reconnects with Last-Event-ID and we replay from there).
    es.addEventListener('error', (e) => {
      if (e.data) {
        try {
          const data = JSON.parse(e.data)
          failCreate(data.message || 'Create failed')
        } catch {
          failCreate('Create failed')
        }
      }
    })
  }

  function failCreate(message) {
    closeStream()
    setRunningCmd('')
    setError(message)
    setPhase('failed')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLines([])
    setRunningCmd('')
    setJobName('')
    setPhase('creating')

    try {
      const result = await api('/api/agents/create', {
        method: 'POST',
        body: {
          name: `${prefix}-${agentType}-${name}`,
          agent: agentType,
          backup_file: backupFile || '',
        },
      })
      const job = result.job
      setJobName(job)
      startStream(job)
    } catch (err) {
      setError(err.error || err.message || 'Failed to create agent')
      setPhase('failed')
    }
  }

  function resetForm() {
    closeStream()
    setPhase('idle')
    setError('')
    setLines([])
    setRunningCmd('')
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <nav className="flex items-center gap-2 text-sm text-slate-400 mb-6">
        <Link to="/agents" className="hover:text-white transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-white">Create Agent</span>
      </nav>

      <h1 className="text-2xl font-bold mb-8">Create Agent</h1>

      {phase === 'idle' ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-400">{prefix}-</span>
              <select value={agentType} onChange={(e) => setAgentType(e.target.value)}
                      className="bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 w-36">
                <option value="openclaw">openclaw</option>
                <option value="picoclaw">picoclaw</option>
                <option value="hermes">hermes</option>
              </select>
              <span className="text-sm text-slate-500">-</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
                     placeholder="my-agent"
                     className="flex-1 bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 placeholder-slate-500" />
            </div>
          </div>

          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5">
            <label className="block text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">Clone from backup (optional)</label>
            <select value={backupFile} onChange={(e) => setBackupFile(e.target.value)}
                    className="w-full bg-slate-700 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500">
              <option value="">No clone — Fresh install</option>
              {filteredBackups.map((b) => (
                <option key={b.file} value={b.file}>
                  {b.vm} — {b.displayDate} {b.displayTime} ({b.size_hr})
                </option>
              ))}
            </select>
            {!isClone && (
              <p className="text-xs text-slate-500 mt-2">
                Fresh installs run <code className="text-slate-400">openclaw setup --baseline</code> as part of creation.
              </p>
            )}
          </div>

          <button type="submit" disabled={!name}
                  className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-cyan-900/30 disabled:opacity-50">
            Create {fullName}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-400">
              {phase === 'creating' && (
                <>
                  <span className="inline-block w-3 h-3 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin mr-2 align-middle" />
                  Creating <span className="text-white font-medium">{jobName}</span>…
                </>
              )}
              {phase === 'done' && (
                <span className="text-emerald-400 font-medium">
                  {isClone ? 'Agent created! Taking you to the dashboard…' : 'Agent created! Setup complete.'}
                </span>
              )}
              {phase === 'failed' && (
                <span className="text-red-400 font-medium">Create failed</span>
              )}
            </div>
            {phase !== 'creating' && (
              <button onClick={resetForm}
                      className="text-sm text-slate-400 hover:text-white transition-colors">
                ← Back to form
              </button>
            )}
          </div>

          {phase === 'failed' && (
            <div className="bg-red-900/50 border border-red-800 rounded-xl p-4 text-sm text-red-400">{error}</div>
          )}

          <Console
            label="Create log"
            runningCmd={runningCmd}
            lines={lines}
            emptyMessage="Waiting for output…"
            className="h-[60vh]"
          />

          {phase === 'done' && !isClone && (
            <button onClick={() => navigate('/agents/' + jobName)}
                    className="w-full bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-emerald-900/30">
              Go to Commands
            </button>
          )}
        </div>
      )}
    </div>
  )
}
