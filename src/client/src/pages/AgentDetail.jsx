import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useAgents } from '../stores/agents'
import { api } from '../lib/api'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'logs', label: 'Logs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'config', label: 'Config' },
  { id: 'models', label: 'Models' },
  { id: 'messaging', label: 'Messaging' },
  { id: 'backups', label: 'Backups' },
  { id: 'health', label: 'Health' },
  { id: 'activity', label: 'Activity' },
]

function SidebarStatus({ agent }) {
  const startAgent = useAgents((s) => s.startAgent)
  const stopAgent = useAgents((s) => s.stopAgent)
  const restartAgent = useAgents((s) => s.restartAgent)
  const [stats, setStats] = useState(null)
  const [hover, setHover] = useState(false)
  const intervalRef = useRef(null)

  useEffect(() => {
    if (agent.status !== 'running') { setStats(null); return }
    async function load() {
      try { const d = await api(`/api/agents/${agent.name}/stats`); if (d.stats) setStats(d.stats) } catch {}
    }
    load()
    intervalRef.current = setInterval(load, 3000)
    return () => clearInterval(intervalRef.current)
  }, [agent.name, agent.status])

  const isTransition = ['starting', 'stopping', 'restarting'].includes(agent.status)
  const cpuPct = stats ? parseFloat(stats.CPUPerc) || 0 : 0
  const memUsage = stats?.MemUsage || ''
  const netIO = stats?.NetIO || ''
  const blockIO = stats?.BlockIO || ''

  return (
    <div id="sidebar-status-block" className="mb-6">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-10 h-10 rounded-2xl bg-slate-800 flex items-center justify-center text-xl font-bold text-cyan-400 flex-shrink-0">
          {agent.display_name?.charAt(0) || '?'}
        </div>
        <div className="min-w-0 flex-1 text-right">
          <h2 className="text-sm font-bold text-white truncate leading-tight">{agent.display_name || agent.name}</h2>
          <p className="text-xs text-slate-500 truncate leading-tight">{agent.name}</p>
        </div>
      </div>

      <div className="mb-3">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${agent.status === 'running' ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800' : agent.status === 'exited' ? 'bg-red-900/50 text-red-400 border border-red-800' : 'bg-slate-800 text-slate-400 border border-slate-700'}`}>
          {isTransition ? (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
              {agent.status}
            </span>
          ) : agent.status}
        </span>
      </div>

      {agent.status === 'running' && stats && (
        <div className="relative space-y-1"
             onMouseEnter={() => setHover(true)}
             onMouseLeave={() => setHover(false)}>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">CPU</span>
            <span className="text-xs text-slate-200 font-mono">{cpuPct.toFixed(1)}%</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">MEM</span>
            <span className="text-xs text-slate-200 font-mono">{memUsage}</span>
          </div>

          {hover && (
            <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-slate-900 border border-slate-700 rounded-lg p-3 shadow-xl text-xs space-y-1.5">
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">Network I/O</span>
                <span className="text-slate-200 font-mono">{netIO}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-slate-500">Disk I/O</span>
                <span className="text-slate-200 font-mono">{blockIO}</span>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex justify-start gap-2 mt-3">
        {agent.status === 'running' ? (
          <>
            <button onClick={() => stopAgent(agent.name)} className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-medium transition-colors">Stop</button>
            <button onClick={() => restartAgent(agent.name)} className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors">Restart</button>
          </>
        ) : (
          <button onClick={() => startAgent(agent.name)} className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors">Start</button>
        )}
      </div>
    </div>
  )
}

export default function AgentDetail() {
  const { agentId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const agents = useAgents((s) => s.agents)
  const fetchAgents = useAgents((s) => s.fetchAgents)

  useEffect(() => {
    if (agents.length === 0) fetchAgents()
  }, [])

  const agent = agents.find((a) => a.name === agentId)
  const currentTab = location.hash.replace('#', '') || 'overview'

  if (!agent) {
    return (
      <div className="flex items-center justify-center h-64 text-slate-500">
        <p>Agent not found or loading...</p>
    </div>
  )
}

// ─── Health ──────────────────────────────────────────────────

const HEALTH_GROUPS = [
  {
    title: 'Diagnostics',
    commands: [
      { cmd: 'openclaw health', label: 'Health', desc: 'Cached health snapshot', flags: ['--json', '--verbose'] },
      { cmd: 'openclaw status', label: 'Status', desc: 'Quick channels + sessions', flags: ['--all', '--usage'] },
      { cmd: 'openclaw logs --tail 50', label: 'Logs', desc: 'Recent gateway logs (50 lines)' },
    ],
  },
  {
    title: 'Doctor',
    commands: [
      { cmd: 'openclaw doctor', label: 'Doctor', desc: 'Diagnose issues' },
      { cmd: 'openclaw doctor --fix', label: 'Doctor & Fix', desc: 'Auto-repair issues', confirm: true },
      { cmd: 'openclaw doctor --lint', label: 'Doctor Lint', desc: 'Read-only CI-style checks' },
      { cmd: 'openclaw doctor --deep', label: 'Doctor Deep', desc: 'Scan system for extra gateways' },
      { cmd: 'openclaw doctor --state-sqlite compact', label: 'SQLite Compact', desc: 'Compact SQLite state (stop gateway first)', confirm: true, danger: true },
    ],
  },
  {
    title: 'Security',
    commands: [
      { cmd: 'openclaw security audit', label: 'Security Audit', desc: 'Cold security audit' },
      { cmd: 'openclaw security audit --deep', label: 'Security Audit (deep)', desc: 'Live probes' },
      { cmd: 'openclaw security audit --fix', label: 'Security Audit & Fix', desc: 'Auto-fix issues', confirm: true },
    ],
  },
  {
    title: 'Memory',
    commands: [
      { cmd: 'openclaw memory status', label: 'Memory Status', desc: 'Index health', flags: ['--deep'] },
      { cmd: 'openclaw memory index', label: 'Reindex', desc: 'Incremental index rebuild' },
      { cmd: 'openclaw memory index --force', label: 'Force Reindex', desc: 'Full vector index rebuild', confirm: true, danger: true },
      { cmd: 'openclaw memory promote --apply', label: 'Promote', desc: 'Promote short-term to MEMORY.md', confirm: true },
    ],
  },
  {
    title: 'Gateway',
    commands: [
      { cmd: 'openclaw gateway status', label: 'Gateway Status', desc: 'Daemon status' },
      { cmd: 'openclaw gateway restart', label: 'Gateway Restart', desc: 'Restart the gateway daemon', confirm: true },
      { cmd: 'openclaw gateway stop', label: 'Gateway Stop', desc: 'Stop the gateway daemon', confirm: true, danger: true },
    ],
  },
  {
    title: 'Other',
    commands: [
      { cmd: 'openclaw backup create', label: 'Backup', desc: 'Create a new backup', confirm: true },
      { cmd: 'openclaw update', label: 'Update', desc: 'Check for updates', confirm: true },
      { cmd: 'openclaw channels status --probe', label: 'Channels Probe', desc: 'Per-channel health probe' },
    ],
  },
]

function HealthTab({ agent }) {
  const [consoleLines, setConsoleLines] = useState([])
  const [runningCmd, setRunningCmd] = useState('')
  const consoleRef = useRef(null)

  useEffect(() => {
    if (consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight
  }, [consoleLines])

  async function run(cmd, opts = {}) {
    if (opts.confirm && !confirm(`Run "${cmd}"?`)) return
    if (opts.danger && !confirm(`⚠ DANGER: "${cmd}" — Are you sure?`)) return

    const ts = new Date().toLocaleTimeString()
    setRunningCmd(cmd)
    setConsoleLines((p) => [...p, { ts, cmd, type: 'cmd' }])

    try {
      const d = await api(`/api/agents/${agent.name}/exec`, { method: 'POST', body: { command: cmd, timeout: 60000 } })
      if (d.error) {
        setConsoleLines((p) => [...p, { ts, text: d.error, type: 'err' }])
      } else {
        if (d.stdout) setConsoleLines((p) => [...p, { ts, text: d.stdout, type: 'out' }])
        if (d.stderr) setConsoleLines((p) => [...p, { ts, text: d.stderr, type: 'err' }])
      }
    } catch (e) {
      setConsoleLines((p) => [...p, { ts, text: e.error || e.message, type: 'err' }])
    }
    setRunningCmd('')
  }

  function clearConsole() {
    setConsoleLines([])
  }

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Toolbox */}
      <div className="grid grid-cols-2 gap-3">
        {HEALTH_GROUPS.map((group) => (
          <div key={group.title} className="border border-slate-800 rounded-xl p-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2.5">{group.title}</h3>
            <div className="flex flex-wrap gap-1.5">
              {group.commands.map((c) => (
                <button
                  key={c.label}
                  onClick={() => run(c.cmd, c)}
                  disabled={!!runningCmd}
                  className={`px-2 py-1 rounded-lg text-xs font-medium transition-colors whitespace-nowrap
                    ${c.danger
                      ? 'bg-red-900/30 text-red-400 border border-red-800/50 hover:bg-red-800/50 hover:text-red-300'
                      : 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-700 hover:text-slate-200'}
                    ${runningCmd ? 'opacity-50 cursor-not-allowed' : ''}`}
                  title={c.desc}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Console */}
      <div className="flex-1 min-h-0 flex flex-col border border-slate-800 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/50">
          <span className="text-xs text-slate-500 font-medium">
            Console {runningCmd && <span className="text-cyan-400 ml-2">⏳ {runningCmd}</span>}
          </span>
          <button onClick={clearConsole} className="text-xs text-slate-500 hover:text-slate-300 transition-colors">Clear</button>
        </div>
        <div ref={consoleRef} className="flex-1 overflow-y-auto p-3 bg-slate-950 font-mono text-[11px] leading-relaxed">
          {consoleLines.length === 0 && (
            <p className="text-slate-600">Click a button above to run a command. Output appears here.</p>
          )}
          {consoleLines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line.type === 'cmd' ? (
                <span><span className="text-slate-500">{line.ts}</span> <span className="text-cyan-400">$ {line.cmd}</span></span>
              ) : line.type === 'err' ? (
                <span className="text-red-400">{line.text}</span>
              ) : (
                <span className="text-slate-300">{line.text}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

  return (
    <div className="flex gap-0 flex-1 min-h-0 h-full" id="agent-layout">
      <aside className="w-56 flex-shrink-0 border-r border-slate-800 overflow-y-auto py-6 px-4" id="agent-sidebar">
        <Link to="/agents" className="text-xs text-slate-500 hover:text-slate-300 transition-colors block mb-4">&larr; Back to fleet</Link>
        <SidebarStatus agent={agent} />
        <div className="space-y-0.5">
          {TABS.map((tab) => (
            <a
              key={tab.id}
              href={`#${tab.id}`}
              onClick={(e) => {
                e.preventDefault()
                navigate(`/agents/${agent.name}#${tab.id}`, { replace: true })
              }}
              className={`w-full text-left px-3 py-2 text-sm font-medium rounded-lg border-l-2 whitespace-nowrap block ${currentTab === tab.id ? 'border-cyan-400 text-cyan-400 bg-slate-800/50' : 'border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
            >
              {tab.label}
            </a>
          ))}
        </div>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto p-6" id="tab-content">
        {currentTab === 'overview' && <OverviewTab agent={agent} />}
        {currentTab === 'workspace' && <WorkspaceTab agent={agent} />}
        {currentTab === 'terminal' && <TerminalTab agent={agent} />}
        {currentTab === 'logs' && <LogsTab agent={agent} />}
        {currentTab === 'sessions' && <SessionsTab agent={agent} />}
        {currentTab === 'config' && <ConfigTab agent={agent} />}
        {currentTab === 'models' && <ModelsTab agent={agent} />}
        {currentTab === 'messaging' && <MessagingTab agent={agent} />}
        {currentTab === 'backups' && <BackupsTab agent={agent} />}
        {currentTab === 'health' && <HealthTab agent={agent} />}
        {currentTab === 'activity' && <ActivityTab agent={agent} />}
      </div>
    </div>
  )
}

// ─── Overview ────────────────────────────────────────────────

function OverviewTab({ agent }) {
  const [activity, setActivity] = useState([])

  useEffect(() => {
    api(`/api/agents/${agent.name}/activity?limit=5`).then((d) => {
      if (d?.activity) setActivity(d.activity)
    }).catch(() => {})
  }, [agent.name])

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <StatBox label="Type" value={agent.agent_type} />
        <StatBox label="Runtime" value={agent.runtime_type} />
        <StatBox label="Model" value={agent.default_model || 'Not configured'} small />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <QuickLink href="#workspace" icon="folder" title="Workspace" desc="Browse and manage files" />
        <QuickLink href="#terminal" icon="terminal" title="Terminal" desc="Open a shell session" />
      </div>

      {activity.length > 0 && (
        <div className="border border-slate-800 rounded-xl p-4">
          <h3 className="text-sm font-medium text-slate-300 mb-3">Recent Activity</h3>
          <div className="space-y-2">
            {activity.slice(0, 5).map((event, i) => (
              <div key={i} className="flex items-center justify-between text-xs gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${event.status === 'ok' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                  <span className="text-slate-300">{event.action}</span>
                  {event.details && <span className="text-slate-500 truncate">{event.details}</span>}
                </div>
                <span className="text-slate-600 flex-shrink-0">{event.timestamp ? new Date(event.timestamp).toLocaleDateString() : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

function StatBox({ label, value, small }) {
  return (
    <div className="border border-slate-800 rounded-xl p-4">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className={`text-lg font-semibold text-white ${small ? 'truncate text-sm' : ''}`} title={value}>{value}</p>
    </div>
  )
}

function QuickLink({ href, icon, title, desc }) {
  return (
    <a
      href={href}
      onClick={(e) => { e.preventDefault(); window.location.hash = href.replace('#', '') }}
      className="border border-slate-800 rounded-xl p-4 hover:border-slate-600 transition-colors group block"
    >
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${icon === 'folder' ? 'bg-cyan-900/30 text-cyan-400' : 'bg-emerald-900/30 text-emerald-400'}`}>
          {icon === 'folder' ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          )}
        </div>
        <div>
          <p className="font-medium text-white group-hover:text-cyan-400 transition-colors">{title}</p>
          <p className="text-xs text-slate-500">{desc}</p>
        </div>
      </div>
    </a>
  )
}

// ─── Terminal ────────────────────────────────────────────────

function TerminalTab({ agent }) {
  const containerRef = useRef(null)
  const termRef = useRef(null)
  const wsRef = useRef(null)
  const [connected, setConnected] = useState(false)
  const [fontSize, setFontSize] = useState(14)

  useEffect(() => {
    if (!containerRef.current) return

    let term, fitAddon, ws

    async function init() {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      await import('@xterm/xterm/css/xterm.css')

      fitAddon = new FitAddon()
      term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: '"Cascadia Code", "Fira Code", monospace',
        scrollback: 10000,
        theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#22d3ee', selectionBackground: '#334155' },
      })
      term.loadAddon(fitAddon)
      term.open(containerRef.current)
      fitAddon.fit()
      termRef.current = term

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const host = window.location.host
      ws = new WebSocket(`${protocol}//${host}/ws/terminal/${agent.name}?cols=${term.cols}&rows=${term.rows}`)
      wsRef.current = ws
      setConnected(true)

      term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data) })

      ws.onmessage = (evt) => term.write(evt.data)
      ws.onclose = () => {
        setConnected(false)
        term.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n')
      }
      ws.onerror = () => setConnected(false)

      const ro = new ResizeObserver(() => { try { fitAddon.fit() } catch {} })
      ro.observe(containerRef.current)

      term.attachCustomKeyEventHandler((e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) return true
        return true
      })

      return () => { ro.disconnect() }
    }

    let cleanup
    init().then((c) => { cleanup = c })

    return () => {
      if (ws) { ws.close(); wsRef.current = null }
      if (term) { term.dispose(); termRef.current = null }
      if (cleanup) cleanup()
    }
  }, [agent.name])

  useEffect(() => {
    if (termRef.current) termRef.current.options.fontSize = fontSize
  }, [fontSize])

  function reconnect() {
    if (wsRef.current) wsRef.current.close()
    termRef.current?.dispose()
    termRef.current = null

    async function reconnectAsync() {
      const { Terminal } = await import('@xterm/xterm')
      const { FitAddon } = await import('@xterm/addon-fit')
      await import('@xterm/xterm/css/xterm.css')

      const fitAddon = new FitAddon()
      const term = new Terminal({
        cursorBlink: true,
        fontSize,
        fontFamily: '"Cascadia Code", "Fira Code", monospace',
        scrollback: 10000,
        theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#22d3ee', selectionBackground: '#334155' },
      })
      term.loadAddon(fitAddon)
      term.open(containerRef.current)
      fitAddon.fit()
      termRef.current = term

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${protocol}//${host}/ws/terminal/${agent.name}?cols=${term.cols}&rows=${term.rows}`)
      wsRef.current = ws
      setConnected(true)

      term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data) })
      ws.onmessage = (evt) => term.write(evt.data)
      ws.onclose = () => { setConnected(false); term.write('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n') }
      ws.onerror = () => setConnected(false)
    }
    reconnectAsync()
  }

  function clearTerm() { termRef.current?.clear() }

  return (
    <div className="flex flex-col border border-slate-800 rounded-xl overflow-hidden bg-[#0f172a]">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/80 select-none">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            <span className="text-xs text-slate-400 font-medium">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
          <span className="w-px h-4 bg-slate-700" />
          <span className="text-xs text-slate-300 font-mono">{agent.display_name}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setFontSize((s) => Math.max(10, s - 1))} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">A-</button>
          <span className="text-xs text-slate-600 w-6 text-center">{fontSize}</span>
          <button onClick={() => setFontSize((s) => Math.min(24, s + 1))} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">A+</button>
          <span className="w-px h-4 bg-slate-700" />
          <button onClick={clearTerm} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Clear</button>
          <button onClick={reconnect} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Reconnect</button>
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height: '70vh', minHeight: '480px' }} />
    </div>
  )
}

// ─── Workspace ───────────────────────────────────────────────

function WorkspaceTab({ agent }) {
  const [path, setPath] = useState('/')
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [fileModal, setFileModal] = useState(null)
  const [newFileName, setNewFileName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const fileInputRef = useRef(null)

  const load = useCallback((p) => {
    setError('')
    api(`/api/agents/${agent.name}/workspace?path=${encodeURIComponent(p)}`).then((d) => {
      if (d.entries) setListing(d)
      else if (d.error) setError(d.error)
    }).catch(() => setError('Failed to load workspace'))
  }, [agent.name])

  useEffect(() => { load(path) }, [path, load])

  const parts = path.split('/').filter(Boolean)
  const breadcrumbs = [{ name: 'root', path: '/' }, ...parts.map((p, i) => ({ name: p, path: '/' + parts.slice(0, i + 1).join('/') }))]

  function goToDir(p) { setPath(p) }

  async function createFile(e) {
    e.preventDefault()
    if (!newFileName) return
    try {
      await api(`/api/agents/${agent.name}/workspace/create-file`, { method: 'POST', body: { path, name: newFileName } })
      setNewFileName('')
      load(path)
    } catch (err) { setError(err.error || err.message) }
  }

  async function createFolder(e) {
    e.preventDefault()
    if (!newFolderName) return
    try {
      await api(`/api/agents/${agent.name}/workspace/folder`, { method: 'POST', body: { path, name: newFolderName } })
      setNewFolderName('')
      load(path)
    } catch (err) { setError(err.error || err.message) }
  }

  async function handleUpload(evt) {
    const file = evt.target.files?.[0] || evt.dataTransfer?.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadPct(0)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('path', path)
    try {
      const xhr = new XMLHttpRequest()
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100))
      })
      await new Promise((resolve, reject) => {
        xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Upload failed'))
        xhr.onerror = () => reject(new Error('Upload failed'))
        xhr.open('POST', `/api/agents/${agent.name}/workspace/upload`)
        xhr.send(fd)
      })
      setUploading(false)
      load(path)
    } catch (err) {
      setError(err.message || 'Upload failed')
      setUploading(false)
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function renameEntry(entryPath) {
    const currentName = entryPath.split('/').pop()
    const newName = prompt('Rename "' + currentName + '" to:', currentName)
    if (newName && newName !== currentName) {
      try {
        await api(`/api/agents/${agent.name}/workspace/rename`, { method: 'POST', body: { path: entryPath, new_name: newName } })
        load(path)
      } catch (err) { setError(err.error || err.message) }
    }
  }

  async function deleteEntry(entryPath, entryName) {
    if (!confirm(`Delete "${entryName}"? This cannot be undone.`)) return
    try {
      await api(`/api/agents/${agent.name}/workspace/delete`, { method: 'POST', body: { path: entryPath } })
      load(path)
    } catch (err) { setError(err.error || err.message) }
  }

  async function openFile(entryPath) {
    try {
      const d = await api(`/api/agents/${agent.name}/workspace/file?path=${encodeURIComponent(entryPath)}`)
      if (d.error) { setError(d.error); return }
      setFileModal(d)
    } catch (err) { setError('Failed to load file') }
  }

  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaved, setFileSaved] = useState(false)

  async function saveFile() {
    if (!fileModal) return
    const textarea = document.getElementById('file-editor')
    if (!textarea) return
    const content = textarea.value
    try {
      await api(`/api/agents/${agent.name}/workspace/save`, { method: 'POST', body: { path: fileModal.path || fileModal.name, content } })
      setFileModal({ ...fileModal, content })
      setFileDirty(false)
      setFileSaved(true)
      setTimeout(() => setFileSaved(false), 2000)
    } catch (err) { setError(err.error || err.message) }
  }

  function closeFileModal() {
    if (fileDirty && !confirm('You have unsaved changes. Discard?')) return
    setFileModal(null)
    setFileDirty(false)
    setFileSaved(false)
  }

  const ext = fileModal ? '.' + (fileModal.name || '').split('.').pop()?.toLowerCase() : ''
  const editable = ['.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.css', '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.conf', '.sh', '.bash', '.env', '.log', '.csv', '.sql', '.ejs', '.vue', '.svelte', '.gitignore'].includes(ext)

  return (
    <div>
      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 text-sm text-slate-500 mb-4 overflow-x-auto flex-wrap">
        {breadcrumbs.map((b, i) => (
          <span key={b.path} className="flex items-center gap-1 whitespace-nowrap">
            {i > 0 && <span className="text-slate-600">/</span>}
            {i < breadcrumbs.length - 1 ? (
              <button onClick={() => goToDir(b.path)} className="hover:text-slate-300 transition-colors">{b.name}</button>
            ) : (
              <span className="text-white">{b.name}</span>
            )}
          </span>
        ))}
      </div>

      {/* Actions Bar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <form onSubmit={createFile} className="flex items-center gap-2">
          <input type="text" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} placeholder="new-file.md"
                 className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white w-36 focus:border-cyan-500 focus:outline-none" />
          <button type="submit" className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm transition-colors whitespace-nowrap">+ File</button>
        </form>
        <form onSubmit={createFolder} className="flex items-center gap-2">
          <input type="text" value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} placeholder="new-folder"
                 className="px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white w-36 focus:border-cyan-500 focus:outline-none" />
          <button type="submit" className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm transition-colors whitespace-nowrap">+ Folder</button>
        </form>
        <span className="w-px h-5 bg-slate-700" />
        <div
          className="flex items-center gap-2 px-3 py-1.5 border border-dashed border-slate-600 rounded-lg hover:border-cyan-500 hover:bg-slate-800/50 transition-colors cursor-pointer"
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-cyan-400', 'bg-slate-800/50') }}
          onDragLeave={(e) => { e.currentTarget.classList.remove('border-cyan-400', 'bg-slate-800/50') }}
          onDrop={(e) => { e.preventDefault(); e.currentTarget.classList.remove('border-cyan-400', 'bg-slate-800/50'); handleUpload(e) }}
        >
          <svg className="w-4 h-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
          <span className="text-sm text-slate-400">Upload</span>
          <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} />
        </div>
        {uploading && (
          <div className="flex items-center gap-2">
            <div className="w-32 h-1.5 bg-slate-700 rounded-full overflow-hidden">
              <div className="h-full bg-cyan-500 rounded-full transition-all" style={{ width: uploadPct + '%' }} />
            </div>
            <span className="text-xs text-slate-400">{uploadPct}%</span>
          </div>
        )}
      </div>

      {error && <p className="text-red-400 text-sm mb-4">{error}</p>}

      {/* File Table */}
      {listing && (
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-slate-500">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium w-24 hidden sm:table-cell">Size</th>
                  <th className="px-4 py-2 font-medium w-40 hidden md:table-cell">Modified</th>
                  <th className="px-4 py-2 font-medium w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {path !== '/' && (
                  <tr className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer" onClick={() => goToDir(path.split('/').slice(0, -1).join('/') || '/')}>
                    <td className="px-4 py-2 text-cyan-400" colSpan={4}>&larr; Up</td>
                  </tr>
                )}
                {listing.entries?.filter((e) => !e.name.startsWith('.')).map((entry) => {
                  const entryPath = path === '/' ? '/' + entry.name : path + '/' + entry.name
                  return (
                    <tr key={entry.name} className="border-b border-slate-800/50 hover:bg-slate-800/30 group">
                      <td className="px-4 py-2">
                        {entry.type === 'directory' ? (
                          <button onClick={() => goToDir(entryPath)} className="text-cyan-400 hover:text-cyan-300 transition-colors text-left">
                            <span className="mr-1.5 text-slate-500">📁</span>{entry.name}
                          </button>
                        ) : (
                          <button onClick={() => openFile(entryPath)} className="text-slate-200 hover:text-cyan-300 transition-colors text-left">
                            <span className="mr-1.5 text-slate-500">📄</span>{entry.name}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-500 hidden sm:table-cell">{entry.size_hr || entry.size || '-'}</td>
                      <td className="px-4 py-2 text-slate-500 hidden md:table-cell text-xs">{entry.modified ? new Date(entry.modified).toLocaleString() : '-'}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                          {entry.type === 'file' && (
                            <a href={`/api/agents/${agent.name}/workspace/download?path=${encodeURIComponent(entryPath)}`}
                               className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors" title="Download" download>DL</a>
                          )}
                          <button onClick={() => renameEntry(entryPath)}
                                  className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors" title="Rename">MV</button>
                          <button onClick={() => deleteEntry(entryPath, entry.name)}
                                  className="px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-slate-700 rounded transition-colors" title="Delete">RM</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {listing.entries?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center">
                      <svg className="w-8 h-8 mx-auto mb-2 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                      <p className="text-slate-500">Empty directory</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* File Viewer/Editor Modal */}
      {fileModal && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center"
             onClick={(e) => { if (e.target === e.currentTarget) closeFileModal() }}
             onKeyDown={(e) => { if (e.key === 'Escape') closeFileModal() }}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl flex flex-col" style={{ width: '80vw', maxWidth: '900px', height: '80vh' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-slate-400">📄</span>
                <span className="text-sm font-medium text-white truncate">{fileModal.name}</span>
                <span className="text-xs text-slate-500">{fileModal.size} bytes · {ext.replace('.', '').toUpperCase()}</span>
                {editable && (
                  <span className={`text-xs ml-2 ${fileSaved ? 'text-emerald-400' : fileDirty ? 'text-amber-400' : 'text-slate-600'}`}>
                    {fileSaved ? 'Saved' : fileDirty ? 'Unsaved' : ''}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {editable && <button onClick={saveFile} className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded text-sm transition-colors">Save</button>}
                <a href={`/api/agents/${agent.name}/workspace/download?path=${encodeURIComponent(fileModal.path || fileModal.name)}`}
                   className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm transition-colors" download>Download</a>
                <button onClick={closeFileModal} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded text-sm transition-colors">Close</button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {editable ? (
                <textarea id="file-editor" value={fileModal.content}
                          onChange={(e) => { setFileModal({ ...fileModal, content: e.target.value }); setFileDirty(true); setFileSaved(false) }}
                          className="w-full h-full bg-slate-900 text-slate-200 font-mono text-sm p-4 rounded-lg border border-slate-700 focus:border-cyan-500 focus:outline-none resize-none"
                          style={{ minHeight: '100%' }} />
              ) : (
                <pre className="text-xs text-slate-300 font-mono whitespace-pre-wrap">{fileModal.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Logs ────────────────────────────────────────────────────

function LogsTab({ agent }) {
  const [logs, setLogs] = useState('')
  const [tail, setTail] = useState(100)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    api(`/api/agents/${agent.name}/logs?tail=${tail}`).then((d) => {
      if (d.logs) setLogs(d.logs)
    }).catch(() => {})
  }, [agent.name, tail])

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-slate-300">Container Logs</h3>
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
        </div>
        <div className="flex items-center gap-2">
          <select value={tail} onChange={(e) => setTail(parseInt(e.target.value))}
                  className="px-2 py-1 bg-slate-950 border border-slate-700 rounded text-xs text-white">
            <option value={50}>50</option><option value={100}>100</option><option value={500}>500</option><option value={1000}>1000</option>
          </select>
          <button onClick={() => setAutoScroll(!autoScroll)}
                  className={`px-2 py-1 rounded text-xs ${autoScroll ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-400'}`}>Auto-scroll</button>
        </div>
      </div>
      <pre className="text-xs leading-tight overflow-auto max-h-96 bg-slate-950 border border-slate-800 rounded-xl p-4 text-slate-300 font-mono"
           ref={(el) => { if (el && autoScroll) el.scrollTop = el.scrollHeight }}>
        {logs || 'No logs available'}
      </pre>
    </div>
  )
}

// ─── Sessions ────────────────────────────────────────────────

function SessionsTab({ agent }) {
  const [sessions, setSessions] = useState([])

  useEffect(() => {
    api(`/api/agents/${agent.name}/sessions`).then((d) => {
      if (d.sessions) setSessions(d.sessions)
    }).catch(() => {})
  }, [agent.name])

  if (sessions.length === 0) return <p className="text-slate-500 text-sm">No sessions recorded yet.</p>
  return (
    <div className="border border-slate-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-xs border-b border-slate-800">
              <th className="text-left px-4 py-2">ID</th>
              <th className="text-left px-4 py-2">Kind</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Model</th>
              <th className="text-right px-4 py-2">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-b border-slate-800/50">
                <td className="px-4 py-2 text-slate-400 font-mono text-xs">{s.id?.slice(0, 12)}...</td>
                <td className="px-4 py-2"><span className="px-2 py-0.5 rounded text-xs bg-slate-800 text-slate-300">{s.kind}</span></td>
                <td className="px-4 py-2"><span className={`px-2 py-0.5 rounded text-xs ${s.status === 'active' ? 'bg-emerald-900/50 text-emerald-400' : 'bg-slate-800 text-slate-400'}`}>{s.status}</span></td>
                <td className="px-4 py-2 text-slate-300">{s.model || '-'}</td>
                <td className="px-4 py-2 text-right text-slate-400">{s.tokens_in || 0}/{s.tokens_out || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Activity ────────────────────────────────────────────────

function ActivityTab({ agent }) {
  const [activity, setActivity] = useState([])

  useEffect(() => {
    api(`/api/agents/${agent.name}/activity`).then((d) => {
      if (d.activity) setActivity(d.activity)
    }).catch(() => {})
  }, [agent.name])

  if (activity.length === 0) return <p className="text-slate-500 text-sm">No activity recorded yet.</p>
  return (
    <div className="border border-slate-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-xs border-b border-slate-800">
              <th className="text-left px-4 py-2">Action</th>
              <th className="text-left px-4 py-2">Details</th>
              <th className="text-right px-4 py-2">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((e, i) => {
              const colors = { start: 'text-emerald-400', stop: 'text-amber-400', restart: 'text-cyan-400' }
              return (
                <tr key={i} className="border-b border-slate-800/50">
                  <td className="px-4 py-2">
                    <span className={`w-1.5 h-1.5 rounded-full inline-block mr-2 ${e.status === 'ok' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                    <span className={colors[e.action] || 'text-slate-300'}>{e.action}</span>
                  </td>
                  <td className="px-4 py-2 text-slate-500 text-xs">{e.details || '-'}</td>
                  <td className="px-4 py-2 text-right text-slate-500 text-xs">{e.timestamp ? new Date(e.timestamp).toLocaleString() : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Config ──────────────────────────────────────────────────

function ConfigTab({ agent }) {
  const [raw, setRaw] = useState('')
  const [saved, setSaved] = useState(true)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api(`/api/agents/${agent.name}/config`).then((d) => {
      if (d.configRaw) { setRaw(d.configRaw); setSaved(true) }
    }).catch(() => {})
  }, [agent.name])

  async function handleSave() {
    try {
      JSON.parse(raw)
      await api(`/api/agents/${agent.name}/config`, { method: 'POST', body: { config: raw } })
      setSaved(true)
      setMsg('Configuration saved. Restart the agent to apply.')
    } catch (err) {
      setMsg(err.message || 'Invalid JSON')
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-medium text-slate-300">Agent Configuration</h3>
          <p className="text-xs text-slate-500">openclaw.json</p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${saved ? 'text-slate-500' : 'text-amber-400'}`}>{saved ? 'Saved' : 'Unsaved changes'}</span>
          <button onClick={handleSave}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors">Save</button>
        </div>
      </div>
      {msg && <div className="mb-4 text-xs text-cyan-400">{msg}</div>}
      <textarea value={raw} onChange={(e) => { setRaw(e.target.value); setSaved(false); setMsg('') }}
                className="w-full h-[500px] bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 resize-none"
                spellCheck={false} />
    </div>
  )
}

// ─── Backups (agent-specific) ────────────────────────────────

function BackupsTab({ agent }) {
  const [backups, setBackups] = useState([])
  const [msg, setMsg] = useState('')

  function load() {
    api(`/api/agents/${agent.name}/backups`).then((d) => {
      if (d.backups) setBackups(d.backups)
    }).catch(() => {})
  }
  useEffect(load, [agent.name])

  async function create() {
    setMsg('Creating backup...')
    try {
      await api(`/api/agents/${agent.name}/backups/create`, { method: 'POST' })
      setMsg('Backup created.')
      load()
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
  }

  async function restore() {
    if (!confirm('Restore latest backup? Container will restart.')) return
    setMsg('Restoring...')
    try {
      await api(`/api/agents/${agent.name}/backups/restore`, { method: 'POST' })
      setMsg('Backup restored.')
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
  }

  async function deleteBak(file) {
    if (!confirm('Delete backup?')) return
    await api(`/api/agents/_/backups/delete`, { method: 'POST', body: { file } })
    load()
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button onClick={create}
                className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors">Create Backup</button>
        <button onClick={restore}
                className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-medium transition-colors">Restore Latest</button>
        {msg && <span className="text-xs text-slate-400">{msg}</span>}
      </div>
      {backups.length === 0 && <p className="text-slate-500 text-sm">No backups yet.</p>}
      {backups.length > 0 && (
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs border-b border-slate-800">
                  <th className="text-left px-4 py-2">File</th>
                  <th className="text-right px-4 py-2 hidden sm:table-cell">Size</th>
                  <th className="text-right px-4 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {backups.map((b) => (
                  <tr key={b.name} className="border-b border-slate-800/50">
                    <td className="px-4 py-2 text-slate-300">{b.name}</td>
                    <td className="px-4 py-2 text-right text-slate-500 hidden sm:table-cell">{b.size_hr}</td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => deleteBak(b.name)}
                              className="text-xs text-red-400 hover:text-red-300 transition-colors">Delete</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Models ──────────────────────────────────────────────────

function ModelsTab({ agent }) {
  const [config, setConfig] = useState(null)
  const [msg, setMsg] = useState('')

  function load() {
    api(`/api/agents/${agent.name}/config`).then((d) => {
      if (d.config) setConfig(d.config)
    }).catch(() => {})
  }
  useEffect(load, [agent.name])

  const providers = config?.models?.providers || {}
  const primary = config?.agents?.defaults?.model?.primary || ''
  const fallback = config?.agents?.defaults?.model?.fallback || ''

  async function setPrimary(model) {
    await api(`/api/agents/${agent.name}/models/set-primary`, { method: 'POST', body: { model } })
    setMsg(`Primary model set to ${model}`)
    load()
  }

  async function setFallback(model) {
    await api(`/api/agents/${agent.name}/models/set-fallback`, { method: 'POST', body: { model } })
    setMsg(model ? `Fallback model set to ${model}` : 'Fallback cleared')
    load()
  }

  async function removeProvider(provider) {
    if (!confirm(`Remove provider ${provider}?`)) return
    await api(`/api/agents/${agent.name}/models/remove-provider`, { method: 'POST', body: { provider } })
    setMsg(`Provider ${provider} removed`)
    load()
  }

  if (Object.keys(providers).length === 0) return <p className="text-slate-500 text-sm">No model providers configured.</p>

  return (
    <div>
      {msg && <div className="mb-4 text-xs text-cyan-400">{msg}</div>}
      {primary && <div className="border border-slate-800 rounded-xl p-4 mb-4"><p className="text-xs text-slate-500 mb-1">Primary Model</p><p className="text-white font-medium">{primary}</p></div>}
      {fallback && <div className="border border-slate-800 rounded-xl p-4 mb-4"><p className="text-xs text-slate-500 mb-1">Fallback Model</p><p className="text-white font-medium">{fallback}</p></div>}
      {Object.entries(providers).map(([name, prov]) => (
        <div key={name} className="border border-slate-800 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-white">{name}</h3>
            <button onClick={() => removeProvider(name)} className="text-xs text-red-400 hover:text-red-300 transition-colors">Remove</button>
          </div>
          {prov.models?.length > 0 && (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-xs border-b border-slate-700">
                  <th className="text-left px-2 py-1">Model</th>
                  <th className="text-right px-2 py-1">Actions</th>
                </tr>
              </thead>
              <tbody>
                {prov.models.map((m) => {
                  const fullId = name + '/' + m.id
                  const isPrimary = primary === fullId
                  const isFallback = fallback === fullId
                  return (
                    <tr key={m.id} className="border-b border-slate-800/50">
                      <td className="px-2 py-1 text-slate-300">{m.name || m.id}</td>
                      <td className="px-2 py-1 text-right flex gap-1 justify-end">
                        <button onClick={() => setPrimary(fullId)}
                                className={`px-2 py-0.5 rounded text-xs ${isPrimary ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>★</button>
                        <button onClick={() => setFallback(isFallback ? '' : fullId)}
                                className={`px-2 py-0.5 rounded text-xs ${isFallback ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>⤵</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Messaging ───────────────────────────────────────────────

function MessagingTab({ agent }) {
  const [config, setConfig] = useState(null)
  const [raw, setRaw] = useState('')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    api(`/api/agents/${agent.name}/config`).then((d) => {
      if (d.configRaw) { setRaw(d.configRaw); try { setConfig(JSON.parse(d.configRaw)) } catch {} }
    }).catch(() => {})
  }, [agent.name])

  const channels = config?.channels

  async function save() {
    try {
      const parsed = JSON.parse(raw)
      await api(`/api/agents/${agent.name}/config`, { method: 'POST', body: { config: raw } })
      setConfig(parsed)
      setMsg('Configuration saved.')
    } catch (err) {
      setMsg('Invalid JSON: ' + err.message)
    }
  }

  return (
    <div>
      {msg && <div className="mb-4 text-xs text-cyan-400">{msg}</div>}
      {channels?.telegram ? (
        <div className="border border-slate-800 rounded-xl p-4 mb-4">
          <h3 className="text-sm font-medium text-white mb-3">Telegram</h3>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Bot Token</span><span className="text-slate-300">{channels.telegram.botToken?.slice(0, 8)}...{channels.telegram.botToken?.slice(-4)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">DM Policy</span><span className="text-slate-300">{channels.telegram.dmPolicy || 'allowlist'}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">Allowlist</span><span className="text-slate-300">{channels.telegram.allowFrom?.join(', ') || 'none'}</span></div>
          </div>
        </div>
      ) : <p className="text-slate-500 text-sm mb-4">No Telegram channel configured.</p>}
      <div className="border border-slate-800 rounded-xl p-4">
        <h3 className="text-sm font-medium text-white mb-3">Raw Config</h3>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)}
                  className="w-full h-64 bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs font-mono text-slate-200 focus:outline-none focus:border-cyan-500 resize-none" spellCheck={false} />
        <button onClick={save} className="mt-2 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors">Save</button>
      </div>
    </div>
  )
}
