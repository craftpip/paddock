import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import Console from '../components/Console'

const STEP_COMMANDS = {
  build: (name) => `docker compose -f instances/${name}/docker-compose.yml build`,
  up: (name) => `docker compose -f instances/${name}/docker-compose.yml up -d`,
  restore: (name) => `Restoring backup into ${name}…`,
  setup: (name) => `docker exec ${name} openclaw setup --baseline`,
}

function setupCmdFor(type, name) {
  if (!type || !type.setupSteps || type.setupSteps.length === 0) return ''
  return `docker exec ${name} ${type.setupSteps.map((s) => [s.cmd, ...(s.args || [])].join(' ')).join(' && ')}`
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
  const { name: urlName } = useParams()
  const [name, setName] = useState('')
  const [agentType, setAgentType] = useState('openclaw')
  const [agentTypes, setAgentTypes] = useState([])
  const [backupFile, setBackupFile] = useState('')
  const [backups, setBackups] = useState([])
  const [prefix, setPrefix] = useState('vm')
  const [hostWorkspaceRoot, setHostWorkspaceRoot] = useState('')
  const [wsEnabled, setWsEnabled] = useState(false)
  const [wsHost, setWsHost] = useState('')
  const [wsDir, setWsDir] = useState('')

  const [phase, setPhase] = useState(() => (urlName ? 'creating' : 'idle')) // idle | creating | done | failed
  const [lines, setLines] = useState([])
  const [runningCmd, setRunningCmd] = useState('')
  const [error, setError] = useState('')
  const [jobName, setJobName] = useState(urlName || '')

  const esRef = useRef(null)

  useEffect(() => {
    api('/api/config').then(cfg => {
      if (cfg.containerPrefix) setPrefix(cfg.containerPrefix)
      if (cfg.hostWorkspaceRoot) setHostWorkspaceRoot(cfg.hostWorkspaceRoot)
    }).catch(() => {})
    api('/api/backups').then(setBackups).catch(() => {})
    api('/api/agent-types').then(d => {
      if (d.types?.length) setAgentTypes(d.types)
    }).catch(() => {})
    return () => closeStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // /agents/create and /agents/create/:name render the same component, so
  // React reuses the instance and the `phase`/`jobName` initializers never
  // re-run on navigation. Flip to 'creating' + sync the name whenever a
  // progress URL appears.
  useEffect(() => {
    if (urlName) {
      setPhase('creating')
      setJobName(urlName)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlName])

  // Progress URL (/agents/create/:name): resume the create job stream on
  // refresh — the job events live server-side, so reconnect and replay.
  useEffect(() => {
    if (!urlName) return
    setLines([])
    setRunningCmd('')
    startStream(urlName)
    return () => closeStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlName])

  const filteredBackups = backups.filter(b => {
    if (!b.agentType) return true
    return b.agentType === agentType
  })

  const currentType = agentTypes.find((t) => t.type === agentType)
  const hasSetup = !!currentType && currentType.setupSteps.length > 0

  const fullName = `${prefix}-${agentType}-${name || '...'}`
  const isClone = !!backupFile

  // ─── Custom workspace (plan 24) ────────────────────────────
  const wsCapability = currentType?.workspaceCapability || 'fixed'
  const wsHidden = wsCapability === 'none'
  const wsFixed = wsCapability === 'fixed'
  const driverWsDir = currentType?.workspaceDir || ''
  // Defaults = today's location: the `workspace` subfolder of the driver's data
  // dir on the host, mounted at the driver's container workspace path. The
  // relative `instances/…` form resolves under the project root on submit.
  const defaultWsHost = `instances/${prefix}-${agentType}-${name || '<name>'}/${agentType}/workspace`
  const defaultWsDir = driverWsDir

  function toggleWs(on) {
    setWsEnabled(on)
    if (on) {
      // Host field starts EMPTY — the default path is shown as its placeholder
      // (live-updating with the typed name), never pre-filled. An empty field
      // submits the default; a typed value overrides it. This keeps it obvious
      // whether the user edited the field or not.
      setWsHost('')
      setWsDir(defaultWsDir)
    }
  }

  function wsHostIssue(h) {
    const v = (h || '').trim()
    if (!v) return ''
    if (v.startsWith('/')) {
      if (v === '/') return 'Cannot be the host root'
      const sys = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/home', '/root', '/opt', '/tmp', '/var/run']
      for (const s of sys) {
        if (v === s || v.startsWith(s + '/')) return `System directory (${s}) cannot be a workspace source`
      }
    } else if (!v.startsWith('instances/')) {
      return 'Must be an absolute path or start with instances/'
    }
    return ''
  }

  function wsDirIssue(d) {
    const v = (d || '').trim()
    if (!v) return ''
    if (!v.startsWith('/')) return 'Container path must be absolute'
    if (v === '/') return 'Container path cannot be /'
    const prot = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp']
    for (const p of prot) {
      if (v === p || v.startsWith(p + '/')) return `Cannot mount a workspace at the system path ${p}`
    }
    return ''
  }

  // Trade-off notice: the host file browser only works while the source stays
  // inside this agent's data folder (instances/<name>/<agent>/…). An empty
  // field means the default `instances/…` path is used (resolved on submit).
  const agentDataHost = hostWorkspaceRoot ? `${hostWorkspaceRoot}/instances/${prefix}-${agentType}-${name || ''}/${agentType}` : ''
  const wsHostEff = wsEnabled ? (wsHost.trim() || defaultWsHost) : ''
  const wsBrowsable = agentDataHost && wsHostEff.startsWith(agentDataHost + '/')
  const wsHostErr = wsEnabled ? wsHostIssue(wsHost) : ''
  const wsDirErr = wsEnabled ? wsDirIssue(wsDir) : ''

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
          let cmd
          if (data.step === 'setup') {
            // The real setup command lives in the agent driver; fall back to
            // the openclaw default only if the registry hasn't loaded yet.
            cmd = setupCmdFor(currentType, job) || STEP_COMMANDS.setup(job)
          } else {
            cmd = STEP_COMMANDS[data.step] ? STEP_COMMANDS[data.step](job) : data.step
          }
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

    try {
      const result = await api('/api/agents/create', {
        method: 'POST',
        body: {
          name: `${prefix}-${agentType}-${name}`,
          agent: agentType,
          backup_file: backupFile || '',
          workspace_host: !isClone && wsEnabled ? (wsHost.trim() || defaultWsHost) : '',
          workspace_dir: !isClone && wsEnabled ? wsDir.trim() : '',
        },
      })
      setPhase('creating')
      navigate('/agents/create/' + result.job, { replace: true })
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
    navigate('/agents/create')
  }

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <nav className="flex items-center gap-2 text-sm text-ink-faint mb-6">
        <Link to="/agents" className="hover:text-ink transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-ink">Create Agent</span>
      </nav>

      <h1 className="text-2xl font-bold mb-8">Create Agent</h1>

      {phase === 'idle' ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="bg-panel/60 border border-line rounded-xl p-5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-ink-faint">{prefix}-</span>
              <select value={agentType} onChange={(e) => setAgentType(e.target.value)}
                      className="bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line w-36">
                {agentTypes.length > 0
                  ? agentTypes.map((t) => <option key={t.type} value={t.type}>{t.type}</option>)
                  : <option value="openclaw">openclaw</option>}
              </select>
              <span className="text-sm text-ink-dim">-</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
                     placeholder="my-agent"
                     className="flex-1 bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
            </div>
          </div>

          <div className="bg-panel/60 border border-line rounded-xl p-5">
            <label className="block text-xs font-medium text-ink-faint mb-2 uppercase tracking-wider">Clone from backup (optional)</label>
            <select value={backupFile} onChange={(e) => setBackupFile(e.target.value)}
                    className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line">
              <option value="">No clone — Fresh install</option>
              {filteredBackups.map((b) => (
                <option key={b.file} value={b.file}>
                  {b.vm} — {b.displayDate} {b.displayTime} ({b.size_hr})
                </option>
              ))}
            </select>
            {!isClone && (
              <p className="text-xs text-ink-dim mt-2">
                {hasSetup
                  ? <>Fresh installs run <code className="text-ink-faint">{currentType.setupSteps.map((s) => s.cmd).join(', ')}</code> as part of creation.</>
                  : 'Fresh installs skip any setup step — the container just boots.'}
              </p>
            )}
          </div>

          {!wsHidden && !isClone && (
            <div className="bg-panel/60 border border-line rounded-xl p-5">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={wsEnabled} onChange={(e) => toggleWs(e.target.checked)}
                       className="w-4 h-4 accent-accent" />
                <span className="text-sm font-medium text-ink">Use a custom workspace folder</span>
              </label>

              {wsEnabled && (
                <div className="mt-4 space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">
                      Host workspace source
                    </label>
                    <input type="text" value={wsHost}
                           onChange={(e) => setWsHost(e.target.value)}
                           placeholder={defaultWsHost}
                           className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                    <p className="text-xs text-ink-dim mt-1">
                      Absolute path or <code className="text-ink-faint">instances/…</code> (resolved under the project root)
                    </p>
                    {wsHostErr && <p className="text-xs text-danger mt-1">{wsHostErr}</p>}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">
                      Container workspace path
                    </label>
                    <input type="text" value={wsDir}
                           onChange={(e) => !wsFixed && setWsDir(e.target.value)}
                           readOnly={wsFixed}
                           placeholder="/root/.openclaw/workspace"
                           className={`w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono ${wsFixed ? 'opacity-70 cursor-not-allowed' : ''}`} />
                    {wsFixed && (
                      <p className="text-xs text-ink-dim mt-1">
                        Fixed by {agentType} — its CLI requires the workspace at this path
                      </p>
                    )}
                    {wsDirErr && <p className="text-xs text-danger mt-1">{wsDirErr}</p>}
                  </div>

                  {hostWorkspaceRoot && !wsBrowsable && (
                    <div className="rounded-lg bg-amber-soft border border-amber-line px-3 py-2 text-xs text-amber">
                      Custom workspace → the host file browser won't be available for this agent. Use the running container workspace instead.
                    </div>
                  )}
                  <p className="text-xs text-ink-dim">
                    A custom workspace is a separate bind mount and is <strong>not</strong> included in agent-data backups.
                  </p>
                </div>
              )}
            </div>
          )}

          <button type="submit" disabled={!name}
                  className="w-full bg-gradient-to-r from-accent to-accent-deep hover:from-accent-hover hover:to-accent-deep text-accent-ink font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-accent/25 disabled:opacity-50">
            Create {fullName}
          </button>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-ink-faint">
              {phase === 'creating' && (
                <>
                  <span className="inline-block w-3 h-3 rounded-full border-2 border-accent-line border-t-transparent animate-spin mr-2 align-middle" />
                  Creating <span className="text-ink font-medium">{jobName}</span>…
                </>
              )}
              {phase === 'done' && (
                <span className="text-success font-medium">
                  {isClone ? 'Agent created! Taking you to the dashboard…' : 'Agent created! Setup complete.'}
                </span>
              )}
              {phase === 'failed' && (
                <span className="text-danger font-medium">Create failed</span>
              )}
            </div>
            {phase !== 'creating' && (
              <button onClick={resetForm}
                      className="text-sm text-ink-faint hover:text-ink transition-colors">
                ← Back to form
              </button>
            )}
          </div>

          {phase === 'failed' && (
            <div className="bg-danger-soft border border-danger-line rounded-xl p-4 text-sm text-danger">{error}</div>
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
                    className="w-full bg-gradient-to-r from-accent to-accent-deep hover:from-accent-hover hover:to-accent-deep text-accent-ink font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-accent/25">
              Go to {jobName}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
