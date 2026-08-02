import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useAgents } from '../stores/agents'
import { api } from '../lib/api'
import Terminal from '../components/Terminal'
import Console from '../components/Console'

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'logs', label: 'Logs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'config', label: 'Config' },
  { id: 'mcp', label: 'MCP' },
  { id: 'skills', label: 'Skills' },
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
    title: 'Other',
    commands: [
      { cmd: 'openclaw backup create', label: 'Backup', desc: 'Create a new backup', confirm: true },
      { cmd: 'openclaw update', label: 'Update', desc: 'Check for updates', confirm: true },
      { cmd: 'openclaw channels status --probe', label: 'Channels Probe', desc: 'Per-channel health probe' },
    ],
  },
]

function HealthTab({ agent }) {
  const termRef = useRef(null)

  function run(cmd, opts = {}) {
    if (opts.confirm && !confirm(`Run "${cmd}"?`)) return
    if (opts.danger && !confirm(`⚠ DANGER: "${cmd}" — Are you sure?`)) return
    termRef.current?.runCommand(cmd)
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Toolbox */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {HEALTH_GROUPS.map((group) => {
          const dotColor = group.title === 'Diagnostics' ? 'bg-cyan-500' : group.title === 'Doctor' ? 'bg-amber-500' : group.title === 'Security' ? 'bg-rose-500' : group.title === 'Memory' ? 'bg-violet-500' : 'bg-slate-600'
          const colors = {
            Diagnostics: 'border-cyan-800/30 text-cyan-300 bg-cyan-950/20 hover:bg-cyan-900/30 hover:text-cyan-200',
            Doctor: 'border-amber-800/30 text-amber-300 bg-amber-950/20 hover:bg-amber-900/30 hover:text-amber-200',
            Security: 'border-rose-800/30 text-rose-300 bg-rose-950/20 hover:bg-rose-900/30 hover:text-rose-200',
            Memory: 'border-violet-800/30 text-violet-300 bg-violet-950/20 hover:bg-violet-900/30 hover:text-violet-200',
            Other: 'border-slate-700/50 text-slate-400 bg-slate-800/50 hover:bg-slate-700 hover:text-slate-200',
          }
          const accent = colors[group.title] || colors.Other
          return (
          <div key={group.title} className="flex items-baseline gap-1.5">
            <div className="flex items-center gap-1 shrink-0">
              <div className={`w-1 h-2.5 rounded-full ${dotColor}`} />
              <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{group.title}:</span>
            </div>
            <div className="flex flex-nowrap gap-1">
              {group.commands.map((c) => (
                <button
                  key={c.label}
                  onClick={() => run(c.cmd, c)}
                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap border shrink-0
                    ${c.danger ? 'bg-red-900/30 text-red-400 border-red-800/50 hover:bg-red-800/50 hover:text-red-300' : accent}`}
                  title={c.desc}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
          )
        })}
      </div>

      {/* Interactive terminal */}
      <Terminal ref={termRef} name={agent.name} title={agent.display_name} height="55vh" minHeight="360px" />
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
              className={`w-full text-left px-3 py-2 text-sm font-medium border-l-2 whitespace-nowrap block ${currentTab === tab.id ? 'rounded-none border-cyan-400 text-cyan-400 bg-slate-800/50' : 'rounded-lg border-transparent text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'}`}
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
        {currentTab === 'mcp' && <McpTab agent={agent} />}
        {currentTab === 'skills' && <SkillsTab agent={agent} />}
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
  return <Terminal name={agent.name} title={agent.display_name} />
}

// ─── Workspace ───────────────────────────────────────────────

function WorkspaceTab({ agent }) {
  const storageKey = `workspace-state-${agent.name}`
  function restoreState() {
    const raw = sessionStorage.getItem(storageKey)
    if (!raw) return {}
    try { return JSON.parse(raw) } catch {}
    return {}
  }
  const saved = restoreState()
  const [path, setPath] = useState(saved.path || '/workspace')
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [fileModal, setFileModal] = useState(null)
  const [newFileName, setNewFileName] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef(null)

  const load = useCallback((p) => {
    setError('')
    setLoading(true)
    api(`/api/agents/${agent.name}/workspace?path=${encodeURIComponent(p)}`).then((d) => {
      if (d.entries) setListing(d)
      else if (d.error) setError(d.error)
    }).catch(() => setError('Failed to load workspace'))
    .finally(() => setLoading(false))
  }, [agent.name])

  useEffect(() => { load(path) }, [path, load])
  useEffect(() => { sessionStorage.setItem(storageKey, JSON.stringify({ path })) }, [path, storageKey])

  const parts = path.split('/').filter(Boolean)
  const breadcrumbs = [{ name: 'openclaw', path: '/' }, ...parts.map((p, i) => ({ name: p, path: '/' + parts.slice(0, i + 1).join('/') }))]

  function goToDir(p) { setPath(p) }
  function goUp() {
    if (path === '/') return
    setPath(path.split('/').slice(0, -1).join('/') || '/')
  }

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
      const d = await api(`/api/agents/${agent.name}/workspace/file?path=` + encodeURIComponent(entryPath))
      if (d.error) { setError(d.error); return }
      setFileModal(d)
    } catch (err) { setError('Failed to load file') }
  }

  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaved, setFileSaved] = useState(false)
  const [jsonError, setJsonError] = useState('')

  function getJsonLine(content, error) {
    const match = error.message.match(/position\s+(\d+)/i)
    if (!match) return error.message
    const pos = parseInt(match[1])
    const lines = content.substring(0, pos).split('\n')
    return 'Line ' + lines.length + ': ' + error.message
  }

  async function saveFile() {
    if (!fileModal) return
    const textarea = document.getElementById('file-editor')
    if (!textarea) return
    const content = textarea.value
    const ext = '.' + (fileModal.name || '').split('.').pop()?.toLowerCase()
    if (ext === '.json') {
      try { JSON.parse(content); setJsonError('') }
      catch (e) { setJsonError(getJsonLine(content, e)); return }
    }
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

  useEffect(() => {
    if (!fileModal) return
    function onKey(e) { if (e.key === 'Escape') closeFileModal() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fileModal])

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

      {/* Loading Spinner */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="flex items-center gap-3 text-slate-400">
            <span className="w-5 h-5 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin" />
            <span className="text-sm">Loading...</span>
          </div>
        </div>
      )}

      {/* File Table */}
      {listing && !loading && (
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
                  <tr className="border-b border-slate-800/50 hover:bg-slate-800/30 cursor-pointer" onClick={goUp}>
                    <td className="px-4 py-2 text-cyan-400" colSpan={4}>&larr; Up</td>
                  </tr>
                )}
                {listing.entries?.filter((e) => !e.name.startsWith('.')).map((entry) => {
                  const entryPath = path === '/' ? '/' + entry.name : path + '/' + entry.name
                  return (
                    <tr key={entry.name} className="border-b border-slate-800/50 hover:bg-slate-800/30 group">
                      <td className="px-4 py-3 cursor-pointer"
                          onClick={() => {
                            if (entry.type !== 'directory') openFile(entryPath)
                            else goToDir(entryPath)
                          }}>
                        {entry.type === 'directory' ? (
                          <span className="text-cyan-400">
                            <span className="mr-1.5 text-slate-500">📁</span>{entry.name}
                            {entry.name === 'workspace' && <span className="ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium bg-cyan-900/50 text-cyan-300 border border-cyan-800/50 align-middle">workspace</span>}
                          </span>
                        ) : (
                          <span className="text-slate-200">
                            <span className="mr-1.5 text-slate-500">📄</span>{entry.name}
                          </span>
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
             onClick={(e) => { if (e.target === e.currentTarget) closeFileModal() }}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl flex flex-col" style={{ width: '80vw', maxWidth: '900px', height: '80vh' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-slate-400">📄</span>
                <span className="text-sm font-medium text-white truncate">{fileModal.name}</span>
                <span className="text-xs text-slate-500">{fileModal.size} bytes · {ext.replace('.', '').toUpperCase()}</span>
{editable && (
                    <span className={`text-xs ml-2 ${jsonError ? 'text-red-400' : fileSaved ? 'text-emerald-400' : fileDirty ? 'text-amber-400' : 'text-slate-600'}`}>
                      {jsonError || (fileSaved ? 'Saved' : fileDirty ? 'Unsaved' : '')}
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
            <div className="flex-1 overflow-hidden p-4">
              {editable ? (
                <textarea id="file-editor" value={fileModal.content}
                          onChange={(e) => { setFileModal({ ...fileModal, content: e.target.value }); setFileDirty(true); setFileSaved(false); setJsonError('') }}
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

// ─── MCP ─────────────────────────────────────────────────────

function McpTab({ agent }) {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState({ name: '', transport: 'stdio', command: '', args: '', url: '', cwd: '' })
  const [probeResult, setProbeResult] = useState(null)
  const [probing, setProbing] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [removing, setRemoving] = useState('')
  const [testUrlStatus, setTestUrlStatus] = useState(null)

  function load() {
    setLoading(true)
    api(`/api/agents/${agent.name}/mcp`).then((d) => {
      setServers(d.servers || [])
    }).catch(() => setMsg('Failed to load'))
      .finally(() => setLoading(false))
  }
  useEffect(load, [agent.name])

  function testUrl() {
    if (!addForm.url) return
    setTestUrlStatus('testing')
    api(`/api/agents/${agent.name}/mcp/test-url`, { method: 'POST', body: { url: addForm.url } })
      .then((r) => setTestUrlStatus(r.ok ? 'ok' : 'fail'))
      .catch(() => setTestUrlStatus('fail'))
  }

  async function addServer(e) {
    e.preventDefault()
    if (!addForm.name || submitting) return
    setSubmitting(true)
    const body = { name: addForm.name, transport: addForm.transport }
    if (addForm.transport === 'stdio') {
      body.command = addForm.command
      body.args = addForm.args ? addForm.args.split(',').map(s => s.trim()).filter(Boolean) : []
      if (addForm.cwd) body.cwd = addForm.cwd
    } else {
      body.url = addForm.url
    }
    try {
      await api(`/api/agents/${agent.name}/mcp/add`, { method: 'POST', body })
      setMsg(`"${addForm.name}" added.`)
      setAddForm({ name: '', transport: 'stdio', command: '', args: '', url: '', cwd: '' })
      setShowAdd(false)
      setSubmitting(false)
      load()
    } catch (e) { setSubmitting(false); setMsg('Failed: ' + (e.error || e.message)) }
  }

  async function removeServer(name) {
    if (!confirm(`Remove "${name}"?`)) return
    setRemoving(name)
    try {
      await api(`/api/agents/${agent.name}/mcp/remove`, { method: 'POST', body: { name } })
      setMsg(`"${name}" removed.`)
      load()
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
    setRemoving('')
  }

  async function toggleServer(name, enabled) {
    try {
      await api(`/api/agents/${agent.name}/mcp/toggle`, { method: 'POST', body: { name, enabled } })
      setServers((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s))
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
  }

  async function probeServer(name) {
    setProbing(name)
    try {
      const result = await api(`/api/agents/${agent.name}/mcp/probe`, { method: 'POST', body: { name } })
      setProbeResult({ name, ...result })
    } catch (e) { setMsg('Probe failed: ' + (e.error || e.message)) }
    setProbing('')
  }

  if (loading) return <div className="flex items-center gap-2 text-slate-500 text-sm"><span className="w-4 h-4 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin" /> Loading MCP servers...</div>

  return (
    <div>
      {msg && <div className="mb-4 text-xs text-cyan-400">{msg}</div>}

      {servers.length === 0 && !showAdd ? (
        <div className="text-center py-12">
          <svg className="w-10 h-10 mx-auto mb-3 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14M12 5l7 7-7 7" /></svg>
          <p className="text-slate-500 text-sm mb-3">No MCP servers configured.</p>
          <button onClick={() => setShowAdd(true)} className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors">+ Add Server</button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-slate-300">{servers.length} server{servers.length !== 1 ? 's' : ''}</h3>
            <button onClick={() => setShowAdd(!showAdd)} className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors">{showAdd ? 'Cancel' : '+ Add Server'}</button>
          </div>

          {showAdd && (
            <form onSubmit={addServer} className="border border-slate-700 rounded-xl p-4 mb-4 bg-slate-900/50">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Name</label>
                  <input type="text" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                         className="w-full px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none" placeholder="my-server" required />
                </div>
                <div>
                  <label className="block text-xs text-slate-500 mb-1">Transport</label>
                  <select value={addForm.transport} onChange={(e) => setAddForm({ ...addForm, transport: e.target.value })}
                          className="w-full px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none">
                    <option value="stdio">stdio</option>
                    <option value="streamable-http">streamable-http</option>
                  </select>
                </div>
              </div>
              {addForm.transport === 'stdio' ? (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Command</label>
                    <input type="text" value={addForm.command} onChange={(e) => setAddForm({ ...addForm, command: e.target.value })}
                           className="w-full px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none" placeholder="npx" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">Args (comma-separated)</label>
                    <input type="text" value={addForm.args} onChange={(e) => setAddForm({ ...addForm, args: e.target.value })}
                           className="w-full px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none" placeholder="-y, @modelcontextprotocol/server-filesystem" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">CWD (optional)</label>
                    <input type="text" value={addForm.cwd} onChange={(e) => setAddForm({ ...addForm, cwd: e.target.value })}
                           className="w-full px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none" placeholder="/data" />
                  </div>
                </div>
              ) : (
                <div className="mb-3">
                  <label className="block text-xs text-slate-500 mb-1">URL</label>
                  <div className="flex items-center gap-2">
                    <input type="text" value={addForm.url} onChange={(e) => { setAddForm({ ...addForm, url: e.target.value }); setTestUrlStatus(null) }}
                           className="flex-1 px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none" placeholder="http://localhost:3001" required />
                    <button type="button" onClick={testUrl} disabled={testUrlStatus === 'testing' || !addForm.url}
                            className="px-3 py-1.5 border border-slate-600 hover:border-cyan-500 disabled:border-slate-700 text-xs text-slate-300 hover:text-white disabled:text-slate-600 rounded-lg transition-colors whitespace-nowrap">
                      {testUrlStatus === 'testing' ? '...' : 'Test URL'}
                    </button>
                    {testUrlStatus === 'ok' && <span className="text-xs text-emerald-400 flex-shrink-0">OK</span>}
                    {testUrlStatus === 'fail' && <span className="text-xs text-red-400 flex-shrink-0">Fail</span>}
                  </div>
                </div>
              )}
              <div className="flex justify-end">
                <button type="submit" disabled={submitting}
                        className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 text-white rounded-lg text-xs font-medium transition-colors">{submitting ? 'Adding...' : 'Add Server'}</button>
              </div>
            </form>
          )}

          <div className="space-y-3">
            {servers.map((s) => (
              <div key={s.name} className="border border-slate-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-white">{s.name}</span>
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${s.ok === true ? 'bg-emerald-400' : s.ok === false ? 'bg-red-400' : 'bg-cyan-400'}`} />
                      <span className="text-xs text-slate-500">{s.ok === true ? 'ok' : s.ok === false ? 'error' : 'configured'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">{s.transport}</span>
                      {s.command && <span className="font-mono text-slate-400 truncate max-w-xs">{s.command}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" checked={s.enabled} onChange={(e) => toggleServer(s.name, e.target.checked)} className="sr-only peer" />
                      <div className="w-9 h-5 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-600" />
                    </label>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-2">
                  <button onClick={() => probeServer(s.name)} disabled={probing === s.name}
                          className="px-2 py-1 text-xs text-cyan-400 hover:text-white hover:bg-slate-700 rounded transition-colors disabled:opacity-40">
                    {probing === s.name ? 'Testing...' : 'Test'}
                  </button>
                  <button onClick={() => removeServer(s.name)} disabled={removing === s.name}
                          className="px-2 py-1 text-xs text-red-400 hover:text-red-300 disabled:text-slate-600 disabled:cursor-not-allowed hover:bg-slate-700 rounded transition-colors">{removing === s.name ? 'Removing...' : 'Remove'}</button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {probeResult && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center"
             onClick={(e) => { if (e.target === e.currentTarget) setProbeResult(null) }}
             onKeyDown={(e) => { if (e.key === 'Escape') setProbeResult(null) }}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-white">{probeResult.name}</h3>
                <span className={`w-2 h-2 rounded-full ${probeResult.ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
              </div>
              <button onClick={() => setProbeResult(null)} className="text-slate-400 hover:text-white text-lg">&times;</button>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto">
              {probeResult.error ? (
                <p className="text-red-400 text-sm">{probeResult.error}</p>
              ) : (
                <>
                  {probeResult.diagnostics?.length > 0 && (
                    <div className="mb-3">
                      <p className="text-xs text-slate-500 mb-1">Issues</p>
                      {probeResult.diagnostics.map((d, i) => <p key={i} className="text-xs text-amber-400">{d}</p>)}
                    </div>
                  )}
                  {probeResult.tools?.length > 0 && (
                    <div>
                      <p className="text-xs text-slate-500 mb-1">{probeResult.tools.length} tools</p>
                      <div className="flex flex-wrap gap-1">
                        {probeResult.tools.map((t) => (
                          <span key={t} className="px-1.5 py-0.5 text-[10px] font-mono bg-slate-900 text-slate-400 rounded">{t.replace(/^[^_]+__/, '')}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {probeResult.servers && Object.entries(probeResult.servers).map(([name, info]) => (
                    <div key={name} className="mb-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-sm font-medium text-white">{name}</span>
                        <span className="text-xs text-slate-500">{info.tools} tools</span>
                      </div>
                      <p className="text-xs text-slate-500 font-mono">{info.launch}</p>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="flex justify-end px-4 py-3 border-t border-slate-700">
              <button onClick={() => setProbeResult(null)} className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-xs font-medium transition-colors">Close</button>
            </div>
          </div>
        </div>
      )}
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
                      <td className="px-2 py-1 text-right">
                        <div className="flex flex-col gap-1 items-end">
                        <button onClick={() => setPrimary(fullId)}
                                className={`px-2 py-0.5 rounded text-xs ${isPrimary ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>★</button>
                        <button onClick={() => setFallback(isFallback ? '' : fullId)}
                                className={`px-2 py-0.5 rounded text-xs ${isFallback ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-400 hover:text-white'}`}>⤵</button>
                        </div>
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

const CHANNEL_ICONS = {
  telegram: '✈', signal: '💬', whatsapp: '📱', discord: '🎮',
  gchat: '📧', matrix: '🔗', slack: '💼', nostr: '🌐',
  imessage: '🍎', tlon: '🐦',
}

function MessagingTab({ agent }) {
  const [selected, setSelected] = useState('')
  const [available, setAvailable] = useState([])
  const [consoleLines, setConsoleLines] = useState([])
  const [runningCmd, setRunningCmd] = useState('')
  const wsRef = useRef(null)
  const [creds, setCreds] = useState({ bot_tokens: {}, user_ids: {} })

  function loadChannels(force) {
    api(`/api/agents/${agent.name}/channels-list${force ? '?refresh=true' : ''}`).then((d) => {
      const entries = Object.entries(d.chat || {}).map(([id, v]) => ({ id, name: v.name || id }))
      setAvailable(entries)
    }).catch(() => {})
  }

  function loadCreds() {
    api('/api/credentials').then((d) => {
      if (d) setCreds({ bot_tokens: d.bot_tokens || {}, user_ids: d.user_ids || {} })
    }).catch(() => {})
  }

  useEffect(() => { loadChannels(); loadCreds() }, [agent.name])

  function connectAndRun(cmd) {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null }
    setConsoleLines([])
    setRunningCmd('')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/messaging/${agent.name}`)
    wsRef.current = socket

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'run', cmd }))
      const ts = new Date().toLocaleTimeString()
      setConsoleLines([{ ts, cmd, type: 'cmd' }])
      setRunningCmd(cmd)
    }

    socket.onmessage = (evt) => {
      try {
        const d = JSON.parse(evt.data)
        if (d.type === 'stdout') {
          setConsoleLines((p) => [...p, { text: d.text, type: 'out' }])
        } else if (d.type === 'stderr') {
          setConsoleLines((p) => [...p, { text: d.text, type: 'err' }])
        } else if (d.type === 'close' || d.type === 'error') {
          setRunningCmd('')
          loadChannels(true)
          loadCreds()
        }
      } catch {}
    }

    socket.onclose = () => { setRunningCmd(''); wsRef.current = null }
    socket.onerror = () => { setRunningCmd(''); wsRef.current = null }
  }

  function pasteCredential(value) {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && runningCmd) {
      wsRef.current.send(JSON.stringify({ type: 'credential-paste', value }))
    }
  }

  function startSetup(id) {
    setSelected(id)
    connectAndRun(`openclaw channels add --channel ${id}`)
  }

  return (
    <div className="flex flex-col gap-3">
      {/* ── Create Channel buttons ── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1 shrink-0">
          <div className="w-1 h-2.5 rounded-full bg-cyan-500" />
          <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Create:</span>
        </div>
        <div className="flex flex-wrap gap-1">
          {available.map((ch) => (
            <button
              key={ch.id}
              onClick={() => startSetup(ch.id)}
              disabled={!!runningCmd}
              title={ch.name}
              className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap border shrink-0
                border-cyan-800/30 text-cyan-300 bg-cyan-950/20 hover:bg-cyan-900/30 hover:text-cyan-200
                ${runningCmd ? 'opacity-40 cursor-not-allowed' : ''}`}
            >
              {CHANNEL_ICONS[ch.id] || '📡'} Create {ch.name}
            </button>
          ))}
        </div>
      </div>

      {/* ── Terminal + Creds (always visible) ── */}
      <div className="border border-slate-700 rounded-xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 bg-slate-900/50">
          <div className="flex items-center gap-2">
            <span className="text-cyan-400 text-sm">{CHANNEL_ICONS[selected] || '📡'}</span>
            <span className="text-sm font-medium text-white">{selected || 'Terminal'}</span>
            {runningCmd && <span className="text-[10px] text-cyan-400 ml-2">Running: {runningCmd}</span>}
            {!runningCmd && consoleLines.length > 0 && <span className="text-[10px] text-slate-500 ml-2">Done</span>}
          </div>
        </div>

        {/* Body: Console + Creds */}
        <div className="flex">
          {/* Console (3/4) */}
          <div className="w-3/4 border-r border-slate-700" style={{ height: '400px' }}>
            <Console
              lines={consoleLines}
              runningCmd={runningCmd}
              onClear={() => setConsoleLines([])}
              emptyMessage="Click a Create button above to set up a channel. Output appears here."
              className="h-full border-0 rounded-none"
            />
          </div>

          {/* Credentials (1/4) */}
          <div className="w-1/4 flex flex-col" style={{ height: '400px' }}>
            <div className="px-3 py-1.5 border-b border-slate-700 bg-slate-900/30">
              <span className="text-[10px] text-slate-500 font-medium">Credentials</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {Object.keys(creds.bot_tokens).length === 0 && Object.keys(creds.user_ids).length === 0 ? (
                <p className="text-slate-600 text-[10px]">No credentials saved. Add them in the Credentials page.</p>
              ) : (
                <div className="space-y-3">
                  {Object.keys(creds.bot_tokens).length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 font-medium mb-1">Bot Tokens</p>
                      {Object.entries(creds.bot_tokens).map(([name, data]) => (
                        <button
                          key={name}
                          onClick={() => pasteCredential(typeof data === 'string' ? data : data.token)}
                          disabled={!runningCmd}
                          className="block w-full text-left px-2 py-1 text-[10px] text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed truncate"
                          title={typeof data === 'string' ? data.slice(0, 8) + '...' : data.token?.slice(0, 8) + '...'}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  )}
                  {Object.keys(creds.user_ids).length > 0 && (
                    <div>
                      <p className="text-[10px] text-slate-500 font-medium mb-1">User IDs</p>
                      {Object.entries(creds.user_ids).map(([name, data]) => (
                        <button
                          key={name}
                          onClick={() => pasteCredential(typeof data === 'string' ? data : data.uid)}
                          disabled={!runningCmd}
                          className="block w-full text-left px-2 py-1 text-[10px] text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed truncate"
                          title={typeof data === 'string' ? data : data.uid}
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function sourceLabel(source) {
  if (source === 'openclaw-bundled' || source === 'openclaw-extra') return { label: 'Bundled', color: 'bg-slate-600' }
  if (source === 'clawhub') return { label: 'Global', color: 'bg-cyan-700' }
  return { label: source || 'User', color: 'bg-emerald-700' }
}

function SkillsTab({ agent }) {
  const [skills, setSkills] = useState([])
  const [check, setCheck] = useState(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [infoModal, setInfoModal] = useState(null)
  const [showInstall, setShowInstall] = useState(false)

  function load() {
    setLoading(true)
    api(`/api/agents/${agent.name}/skills`).then((d) => {
      setSkills(d.skills || [])
      setCheck(d.check || null)
    }).catch(() => setMsg('Failed to load skills'))
      .finally(() => setLoading(false))
  }
  useEffect(load, [agent.name])

  async function removeSkill(slug) {
    if (!confirm(`Remove skill "${slug}"?`)) return
    try {
      await api(`/api/agents/${agent.name}/skills/remove`, { method: 'POST', body: { slug } })
      setMsg(`"${slug}" removed.`)
      load()
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
  }

  async function updateSkill(slug) {
    try {
      await api(`/api/agents/${agent.name}/skills/update`, { method: 'POST', body: { slug } })
      setMsg(`"${slug}" updated.`)
      load()
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
  }

  async function verifySkill(slug) {
    try {
      const r = await api(`/api/agents/${agent.name}/skills/verify`, { method: 'POST', body: { slug } })
      setMsg(`Verify: ${r.verified ? 'Verified' : 'Not verified'} (${r.publisher || 'unknown'})`)
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
  }

  function showInfo(slug) {
    api(`/api/agents/${agent.name}/skills/info?name=${encodeURIComponent(slug)}`)
      .then((d) => setInfoModal(d))
      .catch(() => setMsg('Failed to load skill info'))
  }

  if (loading) return <div className="flex items-center gap-2 text-slate-500 text-sm"><span className="w-4 h-4 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin" /> Loading skills...</div>

  const userSkills = skills.filter((s) => s.source !== 'openclaw-bundled' && s.source !== 'openclaw-extra')
  const bundledSkills = skills.filter((s) => s.source === 'openclaw-bundled' || s.source === 'openclaw-extra')

  return (
    <div>
      {msg && <div className="mb-4 text-xs text-cyan-400">{msg}</div>}
      {check && !check.ok && <div className="mb-4 text-xs text-amber-400">Skills check: {check.warnings?.join(', ') || 'issues found'}</div>}

      {userSkills.length > 0 && (
        <>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-slate-300">User Skills ({userSkills.length})</h3>
          </div>
          <div className="space-y-2 mb-6">
            {userSkills.map((s) => (
              <SkillCard key={s.name} skill={s} agent={agent} onInfo={showInfo} onUpdate={updateSkill} onRemove={removeSkill} onVerify={verifySkill} />
            ))}
          </div>
        </>
      )}

      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-slate-300">Bundled Skills ({bundledSkills.length})</h3>
        <button onClick={() => setShowInstall(!showInstall)} className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors">{showInstall ? 'Cancel' : '+ Install'}</button>
      </div>

      {showInstall && (
        <InstallForm agent={agent} onDone={() => { setShowInstall(false); load() }} />
      )}

      <div className="space-y-2">
        {bundledSkills.map((s) => (
          <SkillCard key={s.name} skill={s} agent={agent} onInfo={showInfo} onUpdate={updateSkill} onRemove={null} onVerify={verifySkill} />
        ))}
      </div>

      {infoModal && (
        <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center"
             onClick={(e) => { if (e.target === e.currentTarget) setInfoModal(null) }}>
          <div className="bg-slate-800 border border-slate-700 rounded-xl shadow-2xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
              <h3 className="text-sm font-medium text-white">{infoModal.name}</h3>
              <button onClick={() => setInfoModal(null)} className="text-slate-400 hover:text-white text-lg">&times;</button>
            </div>
            <div className="p-4 max-h-96 overflow-y-auto text-xs text-slate-300 space-y-3">
              <p className="text-slate-500">{infoModal.description}</p>
              {infoModal.source && <p><span className="text-slate-500">Source:</span> {infoModal.source}</p>}
              {infoModal.eligible !== undefined && <p><span className="text-slate-500">Eligible:</span> {infoModal.eligible ? 'Yes' : 'No'}</p>}
              {infoModal.missing?.bins?.length > 0 && <p><span className="text-slate-500">Missing bins:</span> {infoModal.missing.bins.join(', ')}</p>}
              {infoModal.requirements?.bins?.length > 0 && <p><span className="text-slate-500">Requires:</span> {infoModal.requirements.bins.join(', ')}</p>}
              {infoModal.filePath && <pre className="text-[10px] text-slate-600 mt-2">{infoModal.filePath}</pre>}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SkillCard({ skill, onInfo, onUpdate, onRemove, onVerify }) {
  const sl = sourceLabel(skill.source)
  return (
    <div className="border border-slate-800 rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-medium text-white">{skill.name}</span>
            {skill.version && <span className="text-[10px] text-slate-500 font-mono">{skill.version}</span>}
            <span className={`px-1.5 py-0.5 rounded text-[10px] text-white ${sl.color}`}>{sl.label}</span>
            {skill.eligible !== undefined && (
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${skill.eligible ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            )}
          </div>
          <p className="text-xs text-slate-500 truncate">{skill.description}</p>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={() => onInfo(skill.name)} className="px-2 py-1 text-[10px] text-cyan-400 hover:bg-slate-700 rounded transition-colors">Info</button>
          {skill.source === 'clawhub' && <button onClick={() => onVerify(skill.name)} className="px-2 py-1 text-[10px] text-amber-400 hover:bg-slate-700 rounded transition-colors">Verify</button>}
          {skill.bundled !== true && <button onClick={() => onUpdate(skill.name)} className="px-2 py-1 text-[10px] text-emerald-400 hover:bg-slate-700 rounded transition-colors">Update</button>}
          {onRemove && skill.bundled !== true && <button onClick={() => onRemove(skill.name)} className="px-2 py-1 text-[10px] text-red-400 hover:bg-slate-700 rounded transition-colors">&times;</button>}
        </div>
      </div>
    </div>
  )
}

function InstallForm({ agent, onDone }) {
  const [ref, setRef] = useState('')
  const [source, setSource] = useState('clawhub')
  const [as, setAs] = useState('')
  const [force, setForce] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [err, setErr] = useState('')

  async function install(e) {
    e.preventDefault()
    if (!ref) return
    setInstalling(true)
    setErr('')
    try {
      await api(`/api/agents/${agent.name}/skills/install`, { method: 'POST', body: { ref, source, as, force } })
      onDone()
    } catch (e) { setErr(e.error || e.message) }
    setInstalling(false)
  }

  return (
    <form onSubmit={install} className="border border-slate-700 rounded-xl p-4 mb-4 bg-slate-900/50 space-y-3">
      <div className="flex gap-4">
        {['clawhub', 'git', 'local'].map((s) => (
          <label key={s} className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer">
            <input type="radio" name="skill-source" checked={source === s} onChange={() => setSource(s)} className="accent-cyan-500" />
            {s === 'clawhub' ? 'ClawHub' : s === 'git' ? 'Git' : 'Local'}
          </label>
        ))}
      </div>
      <div>
        <input type="text" value={ref} onChange={(e) => setRef(e.target.value)}
               className="w-full px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none"
               placeholder={source === 'clawhub' ? '@owner/slug' : source === 'git' ? 'owner/repo@ref' : './path/to/skill'} />
      </div>
      <div className="flex items-center gap-4">
        <input type="text" value={as} onChange={(e) => setAs(e.target.value)} placeholder="Custom name (--as)"
               className="flex-1 px-2 py-1.5 bg-slate-950 border border-slate-700 rounded text-sm text-white focus:border-cyan-500 focus:outline-none" />
        <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer whitespace-nowrap">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="accent-cyan-500" />
          Force
        </label>
      </div>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex justify-end">
        <button type="submit" disabled={installing}
                className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 text-white rounded-lg text-xs font-medium transition-colors">{installing ? 'Installing...' : 'Install'}</button>
      </div>
    </form>
  )
}
