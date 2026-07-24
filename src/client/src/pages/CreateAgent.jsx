import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { api } from '../lib/api'

export default function CreateAgent() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [agentType, setAgentType] = useState('openclaw')
  const [backupFile, setBackupFile] = useState('')
  const [backups, setBackups] = useState([])
  const [error, setError] = useState('')
  const [status, setStatus] = useState('idle')
  const [progressStep, setProgressStep] = useState(0)
  const [prefix, setPrefix] = useState('vm')

  useEffect(() => {
    api('/api/config').then(cfg => {
      if (cfg.containerPrefix) setPrefix(cfg.containerPrefix)
    }).catch(() => {})
    api('/api/backups').then(setBackups).catch(() => {})
  }, [])

  const filteredBackups = backups.filter(b => {
    if (!b.agentType) return true
    return b.agentType === agentType
  })

  const fullName = `${prefix}-${agentType}-${name || '...'}`

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setStatus('creating')
    setProgressStep(0)

    setProgressStep(1)
    await new Promise(r => setTimeout(r, 400))

    try {
      const body = {
        name: `${prefix}-${agentType}-${name}`,
        agent: agentType,
        backup_file: backupFile || '',
      }
      const result = await api('/api/agents/create', { method: 'POST', body })

      setProgressStep(3)
      await new Promise(r => setTimeout(r, 600))
      setStatus('done')
      await new Promise(r => setTimeout(r, 800))
      navigate(`/agents/${result.name}#overview`)
    } catch (err) {
      setStatus('idle')
      setProgressStep(0)
      setError(err.error || err.message || 'Failed to create agent')
    }
  }

  const progressSteps = [
    'Creating container\u2026',
    'Running setup\u2026',
    'Done!',
  ]

  return (
    <div className="max-w-xl mx-auto">
      <nav className="flex items-center gap-2 text-sm text-slate-400 mb-6">
        <Link to="/agents" className="hover:text-white transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-white">Create Agent</span>
      </nav>

      <h1 className="text-2xl font-bold mb-8">Create Agent</h1>

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
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-800 rounded-xl p-4 text-sm text-red-400">{error}</div>
        )}

        {status === 'idle' && (
          <button type="submit" disabled={!name}
                  className="w-full bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-cyan-900/30 disabled:opacity-50">
            Create {fullName}
          </button>
        )}

        {status === 'creating' && (
          <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-5 space-y-3">
            {progressSteps.map((step, i) => (
              <div key={i} className="flex items-center gap-3 text-sm">
                {i < progressStep ? (
                  <span className="w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center text-xs text-white">&#10003;</span>
                ) : i === progressStep ? (
                  <span className="w-5 h-5 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
                ) : (
                  <span className="w-5 h-5 rounded-full border border-slate-600" />
                )}
                <span className={i <= progressStep ? 'text-slate-200' : 'text-slate-600'}>{step}</span>
              </div>
            ))}
          </div>
        )}

        {status === 'done' && (
          <div className="bg-emerald-900/30 border border-emerald-800 rounded-xl p-5 text-center">
            <p className="text-emerald-400 font-semibold">Agent created! Redirecting\u2026</p>
          </div>
        )}
      </form>
    </div>
  )
}
