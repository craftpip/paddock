import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import Console from '../components/Console'

const STEP_COMMANDS = {
  build: (name) => `docker compose -f instances/${name}/docker-compose.yml build`,
  up: (name) => `docker compose -f instances/${name}/docker-compose.yml up -d`,
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

function randomPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = new Uint32Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => chars[n % chars.length]).join('')
}

export default function CreateAgent() {
  const navigate = useNavigate()
  const { name: urlName } = useParams()
  const [name, setName] = useState('')
  const [agentType, setAgentType] = useState('openclaw')
  const [agentTypes, setAgentTypes] = useState([])
  const [prefix, setPrefix] = useState('vm')
  const [hostWorkspaceRoot, setHostWorkspaceRoot] = useState('')
  const [wsHost, setWsHost] = useState('')
  const [wsDir, setWsDir] = useState('')

  // Plan 28 options
  const [containers, setContainers] = useState([])
  const [allowDocker, setAllowDocker] = useState(false)
  const [network, setNetwork] = useState('')
  const [extraVolumes, setExtraVolumes] = useState([])
  const [extraPorts, setExtraPorts] = useState([])
  const [showAdvanced, setShowAdvanced] = useState(false)

  // SSH expose
  const [sshEnabled, setSshEnabled] = useState(false)
  const [sshPort, setSshPort] = useState('')
  const [sshCport, setSshCport] = useState('22')
  const [sshPassword, setSshPassword] = useState('')
  const [showSshPw, setShowSshPw] = useState(false)

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
    api('/api/agent-types').then(d => {
      if (d.types?.length) setAgentTypes(d.types)
    }).catch(() => {})
    api('/api/containers').then(d => {
      setContainers(d.containers || [])
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

  const currentType = agentTypes.find((t) => t.type === agentType)

  const fullName = `${prefix}-${agentType}-${name || '...'}`

  // Friendly name validation: lowercase letters, digits and dashes only.
  const nameIssue = name.trim()
    ? (/^[a-z0-9][a-z0-9-]*$/.test(name.trim()) ? '' : 'Use lowercase letters, numbers and dashes only')
    : ''

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

  // ─── Plan 28: extra volumes / ports validation helpers ─────
  const SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/home', '/root', '/opt', '/tmp', '/var/run']
  const PROTECTED_DIRS = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp']

  function volHostIssue(h) {
    const v = (h || '').trim()
    if (!v) return 'Host source is required'
    if (v.startsWith('/')) {
      if (v === '/') return 'Cannot be the host root'
      for (const s of SYSTEM_DIRS) {
        if (v === s || v.startsWith(s + '/')) return `System directory (${s}) cannot be a host source`
      }
    } else if (!v.startsWith('instances/')) {
      return 'Must be an absolute path or start with instances/'
    }
    if (v.includes(':')) return 'Host source cannot contain ":"'
    if (/['"\\]/.test(v)) return 'Quotes and backslashes not allowed'
    return ''
  }

  function volDirIssue(d) {
    const v = (d || '').trim()
    if (!v) return 'Container path is required'
    if (!v.startsWith('/')) return 'Container path must be absolute'
    if (v === '/') return 'Container path cannot be /'
    for (const p of PROTECTED_DIRS) {
      if (v === p || v.startsWith(p + '/')) return `Cannot mount at the system path ${p}`
    }
    return ''
  }

  function portIssue(n) {
    const v = String(n || '').trim()
    if (!v) return 'Port is required'
    if (!/^\d+$/.test(v) || +v < 1 || +v > 65535) return 'Must be an integer 1–65535'
    return ''
  }

  function updateVolume(i, patch) {
    setExtraVolumes(prev => prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))
  }
  function updatePort(i, patch) {
    setExtraPorts(prev => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
  }

  const volumeErrors = extraVolumes.map((v) => ({
    host: volHostIssue(v.host),
    dir: volDirIssue(v.container),
  }))
  const portErrors = extraPorts.map((p) => portIssue(p.host))
  const hasVolumeErrors = volumeErrors.some((e) => e.host || e.dir)
  const hasPortErrors = portErrors.some(Boolean)
  const networkOptions = containers
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  // Trade-off notice: the host file browser only works while the source stays
  // inside this agent's data folder (instances/<name>/<agent>/…). An empty
  // field means the default `instances/…` path is used (resolved on submit).
  const agentDataHost = hostWorkspaceRoot ? `${hostWorkspaceRoot}/instances/${prefix}-${agentType}-${name || ''}/${agentType}` : ''
  const wsHostEff = wsHost.trim()
  const wsBrowsable = agentDataHost && wsHostEff.startsWith(agentDataHost + '/')
  const wsHostErr = wsHostIssue(wsHost)
  const wsDirErr = wsDirIssue(wsDir)
  const wsActive = !!wsHostEff

  // Number of optional settings currently active, shown as a badge on the
  // disclosure toggle so it's obvious the form isn't empty when collapsed.
  const advancedCount = [
    wsActive,
    allowDocker,
    network,
    sshEnabled,
    extraVolumes.some((v) => v.host && v.container),
    extraPorts.some((p) => p.host),
  ].filter(Boolean).length

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

    // Client-side validation for the new plan 28 options before POSTing.
    if (hasVolumeErrors || hasPortErrors) {
      setError('Fix the highlighted additional volume / port fields before creating')
      return
    }
    if (sshEnabled) {
      if (sshPort.trim() && portIssue(sshPort)) {
        setError(portIssue(sshPort) + ' (SSH host port)')
        return
      }
      if (sshCport.trim() && portIssue(sshCport)) {
        setError(portIssue(sshCport) + ' (SSH container port)')
        return
      }
    }
    const vols = extraVolumes
      .filter((v) => v.host && v.host.trim() && v.container && v.container.trim())
      .map((v) => ({
        host: v.host.trim(),
        container: v.container.trim(),
        readonly: !!v.readonly,
      }))
    const ports = extraPorts
      .filter((p) => p.host && p.host.trim())
      .map((p) => ({ host: p.host.trim(), container: p.container.trim() }))
    const sshCportTrim = sshCport.trim()

    try {
      const result = await api('/api/agents/create', {
        method: 'POST',
        body: {
          name: `${prefix}-${agentType}-${name}`,
          agent: agentType,
          workspace_host: wsHost.trim(),
          workspace_dir: wsHost.trim() ? (wsDir.trim() || defaultWsDir) : '',
          allowDocker,
          network,
          sshEnabled,
          port: sshEnabled ? sshPort.trim() : '',
          sshContainerPort: sshEnabled && sshCportTrim ? sshCportTrim : '',
          password: sshEnabled ? sshPassword.trim() : '',
          extraVolumes: vols,
          extraPorts: ports,
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

      <h1 className="text-2xl font-bold mb-2">Create Agent</h1>
      <p className="text-sm text-ink-dim mb-8">
        Only a name is required — everything else is optional and can be changed later from the agent's settings.
      </p>

      {phase === 'idle' ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Name */}
          <div className="bg-panel/60 border border-line rounded-xl p-5">
            <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider mb-3">Name</h3>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-ink-faint">{prefix}-</span>
              <select value={agentType} onChange={(e) => setAgentType(e.target.value)}
                      className="bg-raised border border-line-faint rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-accent-line w-36">
                {agentTypes.length > 0
                  ? agentTypes.map((t) => <option key={t.type} value={t.type}>{t.type}</option>)
                  : <option value="openclaw">openclaw</option>}
              </select>
              <span className="text-sm text-ink-dim">-</span>
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
                     placeholder="my-agent"
                     autoFocus
                     className="flex-1 bg-raised border border-line-faint rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
            </div>

            {nameIssue && <p className="text-xs text-danger mt-2">{nameIssue}</p>}

            <div className="mt-3 flex items-center gap-2 text-xs text-ink-dim">
              <span className={`inline-block w-2 h-2 rounded-full ${name && !nameIssue ? 'bg-success' : 'bg-line-faint'}`} />
              {name && !nameIssue ? (
                <>Looks good — <code className="text-ink-faint font-mono">{fullName}</code> will be your agent's name.</>
              ) : (
                <>The container will be named <code className="text-ink-faint font-mono">{fullName}</code>.</>
              )}
            </div>
          </div>

          {/* Optional settings — collapsed by default */}
          <button type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  aria-expanded={showAdvanced}
                  className={`w-full flex items-center justify-between bg-panel/60 border border-line rounded-xl px-5 py-3.5 text-left hover:border-accent-line transition-colors ${showAdvanced ? 'rounded-b-none border-b-0' : ''}`}>
            <span className="flex items-center gap-2">
              <span className="text-sm font-medium text-ink">Optional settings</span>
              {advancedCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-accent/15 text-accent text-xs font-semibold leading-none">
                  {advancedCount}
                </span>
              )}
            </span>
            <svg className={`w-4 h-4 text-ink-dim transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                 viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
          {!showAdvanced && (
            <p className="text-xs text-ink-dim -mt-3 px-1">
              Custom workspace, docker access, network routing, SSH expose, extra volumes and ports.
            </p>
          )}

          {showAdvanced && (
            <div className="bg-panel/60 border border-line border-t-0 rounded-b-xl p-5 space-y-4">
          {/* Workspace — leave both empty to use the default workspace */}
          {!wsHidden && (
            <div className="bg-raised border border-line-faint rounded-xl p-5 space-y-4">
              <div>
                <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Workspace</h3>
                <p className="text-xs text-ink-dim mt-1">
                  Leave both fields empty to use the default workspace. Point the agent at a folder outside it only if you want it to work on a specific project on this host.
                </p>
              </div>

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
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-xs font-medium text-ink-faint uppercase tracking-wider">
                    Container workspace path
                  </label>
                  {wsFixed && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-sunken border border-line-faint text-ink-dim text-[11px] font-medium">
                      <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                        <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                      </svg>
                      Fixed
                    </span>
                  )}
                </div>
                <input type="text" value={wsDir}
                       onChange={(e) => !wsFixed && setWsDir(e.target.value)}
                       readOnly={wsFixed}
                       tabIndex={wsFixed ? -1 : 0}
                       placeholder={defaultWsDir || '/root/.openclaw/workspace'}
                       className={`w-full rounded-lg px-3 py-2 text-sm font-mono focus:outline-none ${wsFixed
                         ? 'bg-sunken border border-dashed border-line-faint text-ink-dim cursor-not-allowed'
                         : 'bg-raised border border-line-faint text-ink focus:border-accent-line'}`} />
                {wsFixed && (
                  <p className="text-xs text-ink-dim mt-1">
                    <span className="text-ink-faint">Locked —</span> fixed by {agentType}, whose CLI requires the workspace at this path.
                  </p>
                )}
                {wsDirErr && <p className="text-xs text-danger mt-1">{wsDirErr}</p>}
              </div>

              {hostWorkspaceRoot && wsActive && !wsBrowsable && (
                <div className="rounded-lg bg-amber-soft border border-amber-line px-3 py-2 text-xs text-amber">
                  Custom workspace → the host file browser won't be available for this agent. Use the running container workspace instead.
                </div>
              )}
            </div>
          )}

          {/* Container options — docker + network */}
          <div className="bg-raised border border-line-faint rounded-xl p-5 space-y-5">
            <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Container options</h3>

            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-ink">Allow docker in the container</p>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Mounts the host docker socket + installs the docker CLI. Rebuilds the image during creation.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={allowDocker}
                onClick={() => setAllowDocker(!allowDocker)}
                className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${allowDocker ? 'bg-accent' : 'bg-raised'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${allowDocker ? 'translate-x-4' : ''}`} />
              </button>
            </div>
            {allowDocker && (
              <p className="text-xs text-warning/90 bg-warning-soft border border-warning-line/60 rounded-lg px-3 py-2">
                ⚠ The docker socket is host-root equivalent — this agent can control the entire host.
              </p>
            )}

            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Network</label>
              <select value={network} onChange={(e) => setNetwork(e.target.value)}
                      className="w-full sm:w-96 bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line">
                <option value="">Default (no override)</option>
                {networkOptions.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}{c.state !== 'running' ? '  (stopped)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-ink-dim mt-1.5">
                Route the agent through another running container by joining its network namespace (e.g. gluetun for VPN).
              </p>
              <p className="text-xs text-ink-dim mt-1.5">
                In peer mode, published ports (web, additional ports) are forwarded through a socat door on the peer's bridge — no limitation.
              </p>
            </div>
          </div>

          {/* Expose OpenSSH */}
          <div className="bg-raised border border-line-faint rounded-xl p-5 space-y-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-medium text-ink">Expose OpenSSH on a host port</h3>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Publishes the container's SSH server on a host port. The container
                  port defaults to 22 (where sshd listens) — pick a distinct one for
                  agents that share a network namespace, since they can't ALL bind
                  port 22. Leave the host port empty to auto-allocate one (starting at 43817).
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={sshEnabled}
                onClick={() => setSshEnabled(!sshEnabled)}
                className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${sshEnabled ? 'bg-accent' : 'bg-raised'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${sshEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {sshEnabled && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-xs text-ink-dim">Host port</span>
                    <input type="number" min="1" max="65535" value={sshPort}
                           onChange={(e) => setSshPort(e.target.value)}
                           placeholder="auto (43817+)"
                           className="mt-1 w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                    {sshPort.trim() && portIssue(sshPort) && (
                      <span className="block text-xs text-danger mt-1">{portIssue(sshPort)}</span>
                    )}
                  </label>
                  <label className="block">
                    <span className="text-xs text-ink-dim">Container port (sshd in the container)</span>
                    <input type="number" min="1" max="65535" value={sshCport}
                           onChange={(e) => setSshCport(e.target.value)}
                           placeholder="22"
                           className="mt-1 w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                    {sshCport.trim() && portIssue(sshCport) && (
                      <p className="text-xs text-danger mt-1">{portIssue(sshCport)}</p>
                    )}
                    {!sshCport.trim() && (
                      <p className="text-xs text-ink-dim mt-1">Empty = 22 (the sshd default).</p>
                    )}
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs text-ink-dim">Root / SSH password (optional)</span>
                  <div className="mt-1 flex items-center gap-2">
                    <input type={showSshPw ? 'text' : 'password'} value={sshPassword}
                           onChange={(e) => setSshPassword(e.target.value)}
                           placeholder="Optional — set the root password"
                           className="w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line" />
                    <button type="button" onClick={() => setShowSshPw(!showSshPw)}
                            className="px-2 py-2 bg-raised hover:bg-raised-hover text-ink rounded-lg text-xs font-medium transition-colors shrink-0"
                            title={showSshPw ? 'Hide password' : 'Show password'}>
                      {showSshPw ? 'Hide' : 'Show'}
                    </button>
                    <button type="button" onClick={() => setSshPassword(randomPassword())}
                            className="px-2 py-2 bg-raised hover:bg-raised-hover text-ink rounded-lg text-xs font-medium transition-colors shrink-0"
                            title="Generate a random password">
                      Generate
                    </button>
                  </div>
                  <span className="block text-xs text-ink-dim mt-1">
                    This is the password for <code className="text-ink">root</code> logins via SSH.
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* Plan 28: Additional volumes */}
          <div className="bg-raised border border-line-faint rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Additional volumes</h3>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Extra host → container bind mounts beyond the data and workspace folders. Changing them later requires a recreate.
                </p>
              </div>
            </div>

            {extraVolumes.map((v, i) => (
              <div key={i} className="space-y-3 rounded-lg bg-sunken border border-line-faint p-3">
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="block text-xs text-ink-dim mb-1">Host source</label>
                    <input type="text" value={v.host}
                           onChange={(e) => updateVolume(i, { host: e.target.value })}
                           placeholder="e.g. /mnt/shared"
                           className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                    {volumeErrors[i].host && <p className="text-xs text-danger mt-1">{volumeErrors[i].host}</p>}
                  </div>
                  <div className="flex-1">
                    <label className="block text-xs text-ink-dim mb-1">Container path</label>
                    <input type="text" value={v.container}
                           onChange={(e) => updateVolume(i, { container: e.target.value })}
                           placeholder={`e.g. /root/.openclaw/data/extra`}
                           className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                    {volumeErrors[i].dir && <p className="text-xs text-danger mt-1">{volumeErrors[i].dir}</p>}
                  </div>
                  <button type="button" onClick={() => setExtraVolumes(prev => prev.filter((_, idx) => idx !== i))}
                          className="px-2 py-2 bg-raised hover:bg-raised-hover text-ink-dim rounded-lg text-xs shrink-0"
                          title="Remove volume">✕</button>
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-dim cursor-pointer select-none">
                  <input type="checkbox" checked={!!v.readonly}
                         onChange={(e) => updateVolume(i, { readonly: e.target.checked })}
                         className="w-3.5 h-3.5 accent-accent" />
                  Read-only mount
                </label>
              </div>
            ))}

            <button type="button"
                    onClick={() => setExtraVolumes(prev => [...prev, { host: '', container: '', readonly: false }])}
                    className="px-3 py-1.5 bg-raised hover:bg-raised-hover text-ink rounded-lg text-xs font-medium transition-colors">
              + Add volume
            </button>
            {hasVolumeErrors && (
              <p className="text-xs text-danger">Fix the invalid volume fields — the host source and container path must both be valid.</p>
            )}
          </div>

          {/* Plan 28: Additional ports */}
          <div className="bg-raised border border-line-faint rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Additional ports</h3>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Host → container TCP port mappings, independent of the SSH port.
                </p>
              </div>
            </div>

            {extraPorts.map((p, i) => (
              <div key={i} className="flex items-end gap-2 rounded-lg bg-sunken border border-line-faint p-3">
                <div className="w-40">
                  <label className="block text-xs text-ink-dim mb-1">Host port</label>
                  <input type="number" min="1" max="65535" value={p.host}
                         onChange={(e) => updatePort(i, { host: e.target.value })}
                         placeholder="e.g. 9000"
                         className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                  {portErrors[i] && <p className="text-xs text-danger mt-1">{portErrors[i]}</p>}
                </div>
                <div className="w-40">
                  <label className="block text-xs text-ink-dim mb-1">Container port</label>
                  <input type="number" min="1" max="65535" value={p.container}
                         onChange={(e) => updatePort(i, { container: e.target.value })}
                         placeholder="e.g. 80"
                         className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                </div>
                <button type="button" onClick={() => setExtraPorts(prev => prev.filter((_, idx) => idx !== i))}
                        className="px-2 py-2 bg-raised hover:bg-raised-hover text-ink-dim rounded-lg text-xs shrink-0"
                        title="Remove port">✕</button>
              </div>
            ))}

            <button type="button"
                    onClick={() => setExtraPorts(prev => [...prev, { host: '', container: '' }])}
                    className="px-3 py-1.5 bg-raised hover:bg-raised-hover text-ink rounded-lg text-xs font-medium transition-colors">
              + Add port
            </button>
            {hasPortErrors && (
              <p className="text-xs text-danger">Fix the invalid port fields.</p>
            )}
          </div>
            </div>
          )}

          <button type="submit" disabled={!name || !!nameIssue}
                  className="w-full bg-gradient-to-r from-accent to-accent-deep hover:from-accent-hover hover:to-accent-deep text-accent-ink font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-accent/25 disabled:opacity-50">
            {name && !nameIssue ? `Create ${fullName}` : 'Create my agent'}
          </button>
          <p className="text-xs text-ink-dim text-center -mt-2">
            {name && !nameIssue
              ? 'Your agent will be built and booted — this usually takes about a minute.'
              : 'Pick a name to get started.'}
          </p>
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
                  Agent created! Setup complete.
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

          {phase === 'done' && (
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
