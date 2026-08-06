import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { useAgents } from '../stores/agents'
import { api } from '../lib/api'
import { useConfirm } from '../lib/confirm'
import Terminal from '../components/Terminal'
import CommandsPane from './agent/CommandsPane'
import SettingsTab from './agent/SettingsTab'

const MODES = [
  { id: 'commands', label: 'Commands' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'config', label: 'Config' },
  { id: 'logs', label: 'Logs' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]

function AgentHeader({ agent }) {
  const startAgent = useAgents((s) => s.startAgent)
  const stopAgent = useAgents((s) => s.stopAgent)
  const restartAgent = useAgents((s) => s.restartAgent)
  const [stats, setStats] = useState(null)
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
  const memUsage = stats?.MemUsage ? stats.MemUsage.split('/')[0].trim() : ''

  return (
    <div className="flex items-center gap-4 px-6 py-3 border-b border-slate-800 bg-slate-900/40 flex-wrap">
      <Link to="/agents" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">&larr; Fleet</Link>
      <div className="w-9 h-9 rounded-xl bg-slate-800 flex items-center justify-center text-lg font-bold text-cyan-400 flex-shrink-0">
        {agent.display_name?.charAt(0) || '?'}
      </div>
      <div className="min-w-0">
        <h1 className="text-sm font-bold text-white truncate leading-tight">{agent.display_name || agent.name}</h1>
        <p className="text-xs text-slate-500 truncate leading-tight font-mono">{agent.name}</p>
      </div>
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${agent.status === 'running' ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800' : agent.status === 'exited' ? 'bg-red-900/50 text-red-400 border border-red-800' : 'bg-slate-800 text-slate-400 border border-slate-700'}`}>
        {isTransition ? (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-pulse" />
            {agent.status}
          </span>
        ) : agent.status}
      </span>
      <span className="w-px h-5 bg-slate-700" />
      <div className="flex items-center gap-3 text-xs">
        <span className="text-slate-500">CPU <span className="text-slate-200 font-mono ml-1">{agent.status === 'running' ? (cpuPct.toFixed(1) + '%') : '—'}</span></span>
        <span className="text-slate-500">MEM <span className="text-slate-200 font-mono ml-1">{agent.status === 'running' && stats ? memUsage : '—'}</span></span>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-2">
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
  const syncAgent = useAgents((s) => s.syncAgent)
  const agentsLoading = useAgents((s) => s.loading)
  const confirm = useConfirm()
  const termRef = useRef(null)
  const [termConnected, setTermConnected] = useState(false)
  const [termCollapsed, setTermCollapsed] = useState(false)
  const [termHeight, setTermHeight] = useState(null) // custom dock height (px); null = 50vh default
  const dockRef = useRef(null)

  useEffect(() => {
    fetchAgents()
    // Light poll so a transient "stopped" (e.g. right after a settings
    // change that stops/restarts the agent) self-corrects within a few
    // seconds instead of leaving a stale status stuck on screen.
    const t = setInterval(async () => {
      try {
        const a = await api(`/api/agents/${agentId}`)
        if (a) syncAgent(a)
      } catch {}
    }, 5000)
    return () => clearInterval(t)
  }, [agentId, fetchAgents, syncAgent])

  const agent = agents.find((a) => a.name === agentId)
  const currentMode = location.hash.replace('#', '') || 'commands'
  const mode = MODES.find((m) => m.id === currentMode) ? currentMode : 'commands'

  // Leaving the commands page minimizes the terminal by default; coming back
  // to it expands again. Custom drag-resize heights reset on every switch.
  useEffect(() => {
    setTermCollapsed(mode !== 'commands')
    setTermHeight(null)
  }, [mode])

  /** Drag the top edge of the dock to resize the terminal height. */
  const startTermResize = (e) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = dockRef.current ? dockRef.current.getBoundingClientRect().height : 320
    document.body.classList.add('select-none')
    document.body.style.cursor = 'ns-resize'
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch {}
    const onMove = (ev) => {
      const min = 320
      const max = Math.max(min, window.innerHeight - 140)
      const h = Math.round(Math.min(Math.max(startH - (ev.clientY - startY), min), max))
      setTermHeight(h)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('select-none')
      document.body.style.cursor = ''
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** Run a command in the docked terminal, fire-and-forget. opts: {confirm, danger}.
   *  No completion tracking/detection — the terminal just runs it. The command
   *  is recorded to the activity log immediately. No-op until the terminal is
   *  connected — buttons are disabled anyway. */
  const run = useCallback(async (cmd, opts = {}) => {
    if (!cmd) return
    if (!termConnected) return
    if (opts.confirm) {
      const ok = await confirm({
        title: 'Run command',
        message: `Run "${cmd}"?`,
        confirmText: 'Run',
      })
      if (!ok) return
    }
    if (opts.danger) {
      const ok = await confirm({
        title: 'Danger zone',
        message: `⚠ DANGER: "${cmd}" — are you sure?`,
        danger: true,
        confirmText: 'Run',
      })
      if (!ok) return
    }
    const sent = termRef.current?.runCommand(cmd)
    if (!sent || !agent?.name) return
    api(`/api/agents/${agent.name}/command-log`, {
      method: 'POST',
      body: { cmd, status: 'ok', ts: new Date().toISOString() },
    }).catch(() => {})
  }, [termRef, termConnected, confirm, agent?.name])

  if (!agent) {
    if (agentsLoading) {
      return (
        <div className="flex items-center justify-center h-64 text-slate-500">
          <span className="inline-block w-4 h-4 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin mr-3" />
          <p>Loading agent…</p>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-500 gap-4">
        <p>Agent not found — it may have been deleted.</p>
        <Link to="/agents" className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors">
          ← Back to fleet
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0" id="agent-layout">
      <AgentHeader agent={agent} />

      {/* Mode tabs */}
      <div className="flex items-center gap-1 px-6 py-2 border-b border-slate-800 overflow-x-auto flex-shrink-0">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => navigate(`/agents/${agent.name}#${m.id}`, { replace: true })}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${
              mode === m.id ? 'bg-slate-800' : 'hover:bg-slate-800/50'
            } ${
              m.id === 'commands'
                ? 'text-amber-300'
                : mode === m.id ? 'text-cyan-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {m.id === 'commands' ? (agent.agent_type ? agent.agent_type.charAt(0).toUpperCase() + agent.agent_type.slice(1) : 'Commands') : m.label}
          </button>
        ))}
      </div>

      {/* Mode content */}
      <div
        className={`min-h-0 overflow-y-auto p-6 ${
          termCollapsed || mode !== 'commands' ? 'flex-1' : 'shrink-0 max-h-[45vh]'
        }`}
        id="mode-content"
      >
        {mode === 'commands' && (
          <CommandsPane agent={agent} termRef={termRef} run={run} connected={termConnected} />
        )}
        {mode === 'workspace' && <WorkspaceTab agent={agent} />}
        {mode === 'config' && <ConfigTab agent={agent} />}
        {mode === 'logs' && <LogsTab agent={agent} />}
        {mode === 'sessions' && <SessionsTab agent={agent} />}
        {mode === 'activity' && <ActivityTab agent={agent} />}
        {mode === 'settings' && <SettingsTab agent={agent} />}
      </div>

      {/* Persistent docked terminal */}
      <div
        ref={dockRef}
        className={`shrink-0 px-6 pb-6 pt-2 ${
          termCollapsed
            ? ''
            : mode === 'commands'
              ? 'flex-1 min-h-[240px]'
              : termHeight
                ? 'min-h-[320px]'
                : 'h-[50vh] min-h-[320px]'
        }`}
        style={termHeight && mode !== 'commands' && !termCollapsed ? { height: termHeight + 'px' } : undefined}
        id="terminal-dock"
      >
        {mode !== 'commands' && !termCollapsed && (
          <div
            onPointerDown={startTermResize}
            title="Drag to resize terminal"
            className="group -mt-2 mb-1.5 flex h-2 items-center justify-center cursor-ns-resize select-none"
          >
            <div className="h-1 w-32 rounded-full bg-slate-700 group-hover:bg-cyan-500 transition-colors" />
          </div>
        )}
        <Terminal
          ref={termRef}
          name={agent.name}
          title={agent.display_name}
          height="100%"
          minHeight="300px"
          className="h-full"
          collapsed={termCollapsed}
          showCollapse={mode !== 'commands'}
          running={agent.status === 'running'}
          onToggleCollapse={() => setTermCollapsed((v) => !v)}
          onConnChange={setTermConnected}
        />
      </div>
    </div>
  )
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
    const ok = await confirm({
      title: 'Delete file',
      message: `Delete "${entryName}"? This cannot be undone.`,
      danger: true,
      confirmText: 'Delete',
    })
    if (!ok) return
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

  async function closeFileModal() {
    if (fileDirty) {
      const ok = await confirm({
        title: 'Discard changes',
        message: 'You have unsaved changes. Discard?',
        danger: true,
        confirmText: 'Discard',
      })
      if (!ok) return
    }
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
