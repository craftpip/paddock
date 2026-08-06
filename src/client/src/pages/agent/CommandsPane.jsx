import { useEffect, useState, useRef, useCallback } from 'react'
import { api } from '../../lib/api'
import { usePrompt } from '../../lib/prompt'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'

/**
 * Commands — the "home" mode of an agent page.
 *
 * The whole pane is ONE continuous wrapped flow of pill buttons (float-left):
 * every group's commands sit inline in a single line that wraps, no cards, no
 * rows. Group labels are small chips inline before their buttons. Data
 * (servers, skills, backups) shows as compact chips in the same flow.
 * Commands run in the docked terminal below. The `run`/`termRef`
 * plumbing lives in AgentDetail.
 */

const COLORS = {
  cyan:    { dot: 'bg-cyan-500',    pill: 'border-cyan-800/30 text-cyan-300 bg-cyan-950/20 hover:bg-cyan-900/30 hover:text-cyan-200' },
  amber:   { dot: 'bg-amber-500',   pill: 'border-amber-800/30 text-amber-300 bg-amber-950/20 hover:bg-amber-900/30 hover:text-amber-200' },
  rose:    { dot: 'bg-rose-500',    pill: 'border-rose-800/30 text-rose-300 bg-rose-950/20 hover:bg-rose-900/30 hover:text-rose-200' },
  violet:  { dot: 'bg-violet-500',  pill: 'border-violet-800/30 text-violet-300 bg-violet-950/20 hover:bg-violet-900/30 hover:text-violet-200' },
  emerald: { dot: 'bg-emerald-500', pill: 'border-emerald-800/30 text-emerald-300 bg-emerald-950/20 hover:bg-emerald-900/30 hover:text-emerald-200' },
  teal:    { dot: 'bg-teal-500',    pill: 'border-teal-800/30 text-teal-300 bg-teal-950/20 hover:bg-teal-900/30 hover:text-teal-200' },
  blue:    { dot: 'bg-blue-500',    pill: 'border-blue-800/30 text-blue-300 bg-blue-950/20 hover:bg-blue-900/30 hover:text-blue-200' },
  slate:   { dot: 'bg-slate-500',   pill: 'border-slate-700/50 text-slate-400 bg-slate-800/50 hover:bg-slate-700 hover:text-slate-200' },
}

const SIMPLE_GROUPS = [
  {
    title: 'Memory', color: 'violet',
    commands: [
      { cmd: 'openclaw memory status', label: 'Status', desc: 'Index health' },
      { cmd: 'openclaw memory promote --apply', label: 'Promote', desc: 'Short-term → MEMORY.md', confirm: true },
    ],
  },
  {
    title: 'Config', color: 'teal',
    commands: [
      { cmd: 'openclaw config validate', label: 'Validate', desc: 'Check config against schema' },
      { cmd: 'openclaw config file', label: 'File path', desc: 'Show active config path' },
      { cmd: 'openclaw config get agents.defaults.model --json', label: 'Model config', desc: 'Primary + fallback models' },
      { cmd: 'openclaw config schema', label: 'Schema', desc: 'Dump JSON schema' },
    ],
  },
  {
    title: 'Other', color: 'slate',
    commands: [
      { cmd: 'openclaw backup create', label: 'Backup', desc: 'Create a backup archive', confirm: true },
      { cmd: 'openclaw update status', label: 'Check updates', desc: 'Update channel + availability' },
      { cmd: 'openclaw mcp doctor', label: 'MCP Doctor', desc: 'Check MCP servers' },
    ],
  },
  {
    title: 'Security', color: 'rose',
    commands: [
      { cmd: 'openclaw security audit', label: 'Audit', desc: 'Cold security audit' },
      { cmd: 'openclaw security audit --deep', label: 'Audit (deep)', desc: 'Live probes' },
      { cmd: 'openclaw security audit --fix', label: 'Audit & Fix', desc: 'Auto-fix issues', confirm: true },
    ],
  },
  {
    title: 'Doctor', color: 'amber',
    commands: [
      { cmd: 'openclaw doctor', label: 'Doctor', desc: 'Diagnose issues' },
      { cmd: 'openclaw doctor --fix', label: 'Fix', desc: 'Auto-repair issues', confirm: true },
      { cmd: 'openclaw doctor --lint', label: 'Lint', desc: 'Read-only CI-style checks' },
      { cmd: 'openclaw doctor --deep', label: 'Deep', desc: 'Scan for extra gateways' },
      { cmd: 'openclaw doctor --state-sqlite compact', label: 'SQLite Compact', desc: 'Compact SQLite state (stop first)', confirm: true, danger: true },
    ],
  },
  {
    title: 'Diagnostics', color: 'cyan',
    commands: [
      { cmd: 'openclaw status', label: 'Status', desc: 'Overview + gateway state' },
      { cmd: 'openclaw gateway status', label: 'Gateway status', desc: 'Bind, port + connectivity' },
    ],
  },
]

function matches(q, ...fields) {
  if (!q) return true
  const needle = q.toLowerCase()
  return fields.some((f) => (f || '').toLowerCase().includes(needle))
}

function Pill({ label, onClick, desc, color, disabled, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={desc}
      className={`px-2 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap border shrink-0 disabled:opacity-40 disabled:cursor-not-allowed
        ${danger ? 'bg-red-900/30 text-red-400 border-red-800/50 hover:bg-red-800/50 hover:text-red-300' : color}`}
    >
      {label}
    </button>
  )
}

/** Small inline group label chip, sits in the flow before its buttons. */
function GroupLabel({ color, title }) {
  const c = COLORS[color] || COLORS.slate
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0 ml-1 first:ml-0">
      <span className={`w-1.5 h-3 rounded-full ${c.dot}`} />
      <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{title}</span>
    </span>
  )
}

/** Neutral chip for data items (servers, skills, backups) in the flow. */
function DataChip({ children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] border border-slate-700/60 bg-slate-800/40 text-slate-300 shrink-0 ${className}`}>
      {children}
    </span>
  )
}

/** Small destructive inline action button used inside data chips. */
function MiniBtn({ label, onClick, color = 'text-slate-400 hover:text-slate-200', disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
            className={`px-1 rounded text-[10px] ${color} hover:bg-slate-700/60 transition-colors disabled:opacity-40`}>
      {label}
    </button>
  )
}

function FlowGroup({ group, query, run, connected }) {
  const c = COLORS[group.color] || COLORS.slate
  const visible = group.commands.filter((x) => matches(query, x.label, x.cmd, x.desc))
  if (query && visible.length === 0) return null
  return (
    <>
      <GroupLabel color={group.color} title={group.title} />
      {visible.map((x) => (
        <Pill
          key={x.label}
          label={x.label}
          desc={x.desc}
          color={c.pill}
          danger={x.danger}
          disabled={!connected}
          onClick={() => run(x.cmd, x)}
        />
      ))}
    </>
  )
}

// ─── Messaging ───────────────────────────────────────────────────

function MessagingFlow({ query, run, connected }) {
  const pills = [
    { cmd: 'openclaw configure --section channels', label: 'Configure channel', desc: 'Interactive wizard — add, update, login or remove channel accounts' },
    { cmd: 'openclaw channels list --all', label: 'List channels', desc: 'Configured + available channels' },
    { cmd: 'openclaw channels status --probe', label: 'Status probe', desc: 'Live transport + audit check per account' },
    { cmd: 'openclaw channels capabilities', label: 'Capabilities', desc: 'What each channel supports (intents/scopes)' },
    { cmd: 'openclaw channels logs --lines 100', label: 'Channel logs', desc: 'Recent channel runtime logs' },
    { cmd: 'openclaw agents bindings', label: 'Routing', desc: 'Which agent owns which channel' },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  if (query && visible.length === 0) return null

  return (
    <>
      <GroupLabel color="cyan" title="Messaging" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.cyan.pill} danger={x.danger}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
    </>
  )
}

// ─── Models ──────────────────────────────────────────────────────

function ModelsFlow({ agent, query, run, prompt, connected }) {
  const [config, setConfig] = useState(null)

  function load() {
    api(`/api/agents/${agent.name}/config`).then((d) => {
      if (d.config) setConfig(d.config)
    }).catch(() => {})
  }
  useEffect(load, [agent.name])

  const primary = config?.agents?.defaults?.model?.primary || ''
  const fallback = config?.agents?.defaults?.model?.fallback || ''

  const pills = [
    { cmd: 'openclaw configure --section model', label: 'Configure models', desc: 'Interactive setup — API key, token or OAuth' },
    { label: 'Logout profile', desc: 'Log out one saved auth profile', click: async () => {
      const v = await prompt({
        title: 'Logout model provider',
        message: 'Log out one auth profile. Run "Auth profiles" first to see the exact profile IDs.',
        confirmText: 'Logout',
        danger: true,
        fields: [{
          key: 'profile', label: 'Profile ID', placeholder: 'e.g. openai:work',
          hint: 'Found in "Auth profiles" — each row has an id like openai:manual or openai:work.',
        }],
      })
      if (!v?.profile) return
      run(`openclaw models auth logout ${v.profile} --yes`, { confirm: true })
    } },
    { cmd: 'openclaw models auth list', label: 'Auth profiles', desc: 'List saved auth profiles' },
    { cmd: 'openclaw models list', label: 'Available models', desc: 'Models you are logged in to (no --all)' },
    { cmd: 'openclaw models status', label: 'Model status', desc: 'Auth + model status overview' },
    { label: 'Set default model', desc: 'Pick the primary model by id', click: async () => {
      const v = await prompt({
        title: 'Set default model',
        message: 'Set the primary model used by this agent.',
        confirmText: 'Set model',
        fields: [{
          key: 'model', label: 'Model id', placeholder: 'e.g. openai/gpt-5.5',
          hint: 'Format: provider/model. Pick from "Available models" or use any catalog id.',
        }],
      })
      if (!v?.model) return
      run(`openclaw models set ${v.model}`)
    } },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  if (query && visible.length === 0 && !primary && !fallback) return null

  return (
    <>
      <GroupLabel color="blue" title="Models" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.blue.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
      {primary && (
        <DataChip className="border-cyan-800/40 text-cyan-300 bg-cyan-950/20 font-mono">★ {primary}</DataChip>
      )}
      {fallback && (
        <DataChip className="border-amber-800/40 text-amber-300 bg-amber-950/20 font-mono">⤵ {fallback}</DataChip>
      )}
    </>
  )
}

// ─── MCP ─────────────────────────────────────────────────────────

function McpFlow({ agent, query, run, prompt, connected }) {
  const [servers, setServers] = useState([])
  const [removing, setRemoving] = useState('')
  const [msg, setMsg] = useState('')
  const confirm = useConfirm()

  function load() {
    api(`/api/agents/${agent.name}/mcp`).then((d) => setServers(d.servers || [])).catch(() => {})
  }
  useEffect(load, [agent.name])

  const serverHint = servers.length
    ? 'Configured servers: ' + servers.map((s) => s.name).join(', ')
    : 'No servers configured — run "List" first.'

  const pills = [
    { cmd: 'openclaw mcp list', label: 'List', desc: 'Configured MCP servers' },
    { cmd: 'openclaw mcp status', label: 'Status', desc: 'Server status' },
    { cmd: 'openclaw mcp doctor', label: 'Doctor', desc: 'Check server health' },
    { cmd: 'openclaw mcp probe', label: 'Probe', desc: 'Probe all servers' },
    { cmd: 'openclaw mcp reload', label: 'Reload', desc: 'Reload server config' },
    { label: 'Tools', desc: 'List one server\'s available tools', click: async () => {
      const v = await prompt({
        title: 'List MCP tools',
        message: 'Which MCP server should we connect to?',
        confirmText: 'Probe',
        fields: [{
          key: 'name', label: 'Server name', placeholder: 'e.g. filesystem',
          hint: serverHint,
        }],
      })
      if (!v?.name) return
      run(`openclaw mcp probe ${v.name}`)
    } },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  const shown = servers.filter((s) => matches(query, s.name))
  if (query && visible.length === 0 && shown.length === 0) return null

  async function removeServer(name) {
    const ok = await confirm({
      title: 'Remove MCP server',
      message: `Remove "${name}"?`,
      danger: true,
      confirmText: 'Remove',
    })
    if (!ok) return
    setRemoving(name)
    try {
      await api(`/api/agents/${agent.name}/mcp/remove`, { method: 'POST', body: { name } })
      setMsg(`"${name}" removed.`)
      load()
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
    setRemoving('')
  }

  return (
    <>
      {msg && <span className="text-[11px] text-cyan-400">{msg}</span>}
      <GroupLabel color="emerald" title="MCP" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.emerald.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd))} />
      ))}
      {shown.map((s) => (
        <DataChip key={s.name} title={s.command || s.url || ''}>
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.ok === true ? 'bg-emerald-400' : s.ok === false ? 'bg-red-400' : 'bg-cyan-400'}`} />
          <span className="font-medium text-slate-200">{s.name}</span>
          {s.transport && <span className="text-[10px] text-slate-500">{s.transport}</span>}
          <MiniBtn label={removing === s.name ? '…' : '×'} color="text-red-400 hover:text-red-300" disabled={removing === s.name}
                   onClick={() => removeServer(s.name)} />
        </DataChip>
      ))}
    </>
  )
}

// ─── Skills ──────────────────────────────────────────────────────

function SkillsFlow({ agent, query, run, prompt, connected }) {
  const [msg, setMsg] = useState('')
  const [showInstall, setShowInstall] = useState(false)
  const [installRef, setInstallRef] = useState('')
  const [installing, setInstalling] = useState(false)

  const pills = [
    { label: 'Search', desc: 'Search the skill catalog', click: async () => {
      const v = await prompt({
        title: 'Search skills',
        message: 'Find skills on the ClawHub catalog.',
        confirmText: 'Search',
        fields: [{
          key: 'query', label: 'Search query', placeholder: 'e.g. redis, kubernetes',
          hint: 'Keywords match skill names, descriptions and tags.',
        }],
      })
      if (!v?.query) return
      run(`openclaw skills search ${v.query}`)
    } },
    { cmd: 'openclaw skills update --all', label: 'Update all', desc: 'Update every installed skill', confirm: true },
    { label: 'Install', desc: 'Open the install box', click: () => setShowInstall(!showInstall) },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  if (query && visible.length === 0) return null

  async function doInstall(e) {
    e.preventDefault()
    if (!installRef || installing) return
    setInstalling(true)
    try {
      await api(`/api/agents/${agent.name}/skills/install`, { method: 'POST', body: { ref: installRef, source: 'clawhub', as: '', force: false } })
      setInstallRef(''); setShowInstall(false)
      setMsg(`"${installRef}" installed.`)
    } catch (err) { setMsg('Failed: ' + (err.error || err.message)) }
    setInstalling(false)
  }

  return (
    <>
      {msg && <span className="text-[11px] text-cyan-400">{msg}</span>}
      <GroupLabel color="violet" title="Skills" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.violet.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
      {showInstall && (
        <form onSubmit={doInstall} className="inline-flex items-center gap-2">
          <input type="text" value={installRef} onChange={(e) => setInstallRef(e.target.value)}
                 placeholder="@owner/slug or owner/repo@ref"
                 className="w-56 px-2 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-cyan-500 focus:outline-none placeholder-slate-600" />
          <button type="submit" disabled={installing}
                  className="px-2.5 py-1 rounded text-[11px] bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 text-white transition-colors">
            {installing ? '…' : 'Install'}
          </button>
        </form>
      )}
    </>
  )
}

// ─── Vault dropdown ───────────────────────────────────────────

/**
 * VaultDropdown — right-aligned vault button at the end of the command flow.
 * Opens a backdrop-less dropdown (fixed-position popover anchored to the
 * button) listing saved vault items. Only names/descriptions are fetched from
 * `/api/vault`; the decrypted value is fetched per-click via
 * `/api/vault/:id/decrypt` and pasted straight into the terminal. A small form
 * at the bottom adds a new vault item.
 */
function VaultDropdown({ termRef, connected }) {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState(null)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [pastingId, setPastingId] = useState('')
  const [filter, setFilter] = useState('')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  const wrapRef = useRef(null)
  const btnRef = useRef(null)
  const filterRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api('/api/vault')
      setItems(d?.items || [])
    } catch (err) {
      toast.error('Failed to load vault: ' + (err.error || err.message))
    } finally {
      setLoading(false)
    }
  }, [toast])

  const filtered = items.filter((it) => {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    return (it.name || '').toLowerCase().includes(q) || (it.description || '').toLowerCase().includes(q)
  })

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) {
      setAnchor(btnRef.current?.getBoundingClientRect() || null)
      setFilter('')
      load()
    }
  }

  // Close on outside click or Escape (Escape clears the filter first).
  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        if (filter) setFilter('')
        else setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, filter])

  // Focus the filter input when the dropdown opens.
  useEffect(() => {
    if (open) filterRef.current?.focus()
  }, [open])

  /** Fetch the decrypted value ONLY on click, then paste it into the terminal.
   *  No trailing newline — the value sits in the shell input buffer and the
   *  user presses Enter themselves. */
  async function pasteItem(item) {
    setPastingId(item.id)
    try {
      const d = await api(`/api/vault/${item.id}/decrypt`)
      if (!d?.value) throw new Error('Empty vault value')
      termRef.current?.write(d.value)
      toast.success(`"${item.name}" pasted to terminal`)
    } catch (err) {
      toast.error((err.error || err.message) || 'Failed to fetch vault value')
    } finally {
      setPastingId('')
    }
  }

  async function addItem(e) {
    e.preventDefault()
    if (!name.trim() || !value.trim()) return
    setSaving(true)
    try {
      await api('/api/vault', { method: 'POST', body: { name: name.trim(), value: value.trim() } })
      setName('')
      setValue('')
      toast.success('Vault item added')
      load()
    } catch (err) {
      toast.error((err.error || err.message) || 'Failed to add vault item')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative ml-auto">
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={!connected}
        title={connected ? 'Vault — paste a saved secret into the terminal' : 'Vault — waiting for the terminal to connect'}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap border shrink-0 disabled:opacity-40 disabled:cursor-not-allowed
          ${open ? 'border-amber-500/70 bg-amber-950/40 text-amber-200' : 'border-amber-800/40 text-amber-300 bg-amber-950/20 hover:bg-amber-900/30 hover:text-amber-200'}`}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Vault
        {items.length > 0 && <span className="text-[10px] text-amber-500/80">{items.length}</span>}
        <svg className="w-3 h-3 text-amber-500/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && anchor && (
        <div
          className="fixed z-50 w-80 rounded-lg border border-slate-700 bg-slate-900 shadow-xl overflow-hidden"
          style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
            <span className="text-xs font-medium text-slate-300">Vault</span>
            <button onClick={load} title="Refresh vault list" className="text-slate-500 hover:text-white text-xs px-1">
              ↻
            </button>
          </div>

          <div className="px-2 py-1.5 border-b border-slate-800">
            <div className="relative">
              <svg className="w-3 h-3 text-slate-500 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={filterRef}
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter vault…"
                className="w-full pl-6 pr-6 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-amber-500 focus:outline-none placeholder-slate-600"
              />
              {filter && (
                <button onClick={() => setFilter('')} title="Clear filter"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white text-xs px-0.5">
                  ×
                </button>
              )}
            </div>
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {loading && items.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-slate-500">
                {items.length === 0 ? 'No vault items yet.' : `No matches for "${filter}".`}
              </div>
            )}
            {filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => pasteItem(item)}
                disabled={!!pastingId || !connected}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-slate-800 hover:text-cyan-300 transition-colors group disabled:opacity-40"
                title="Fetch value and paste into terminal"
              >
                <svg className="w-3 h-3 text-amber-500/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
                <span className="min-w-0">
                  <span className="block font-medium text-slate-200 group-hover:text-cyan-300 truncate">{item.name}</span>
                  {item.description && (
                    <span className="block text-[10px] text-slate-500 truncate">{item.description}</span>
                  )}
                </span>
                {pastingId === item.id && <span className="ml-auto text-[10px] text-cyan-400">fetching…</span>}
              </button>
            ))}
          </div>

          <form onSubmit={addItem} className="flex flex-col gap-1.5 border-t border-slate-800 p-2">
            <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider px-1">Add vault item</span>
            <div className="flex gap-1.5">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="name"
                     className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-amber-500 focus:outline-none placeholder-slate-600" />
              <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value"
                     autoComplete="new-password"
                     className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-amber-500 focus:outline-none placeholder-slate-600 font-mono" />
            </div>
            <button type="submit" disabled={saving || !name.trim() || !value.trim()}
                    className="px-2 py-1 rounded text-[11px] bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 disabled:text-slate-500 text-white transition-colors">
              {saving ? 'Adding…' : '+ Add'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

// ─── Main CommandsPane ───────────────────────────────────────────

export default function CommandsPane({ agent, termRef, run, connected }) {
  const [query, setQuery] = useState('')
  const prompt = usePrompt()

  /** Launch the openclaw interactive TUI directly in the terminal. */
  function runTool() {
    run('openclaw')
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex items-center gap-2">
        <button
          onClick={runTool}
          disabled={!connected}
          title={connected ? 'Run openclaw interactively in the terminal' : 'Waiting for the terminal to connect'}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Run TUI
        </button>
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
               placeholder="Filter commands…"
               className="flex-1 max-w-md px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white focus:border-cyan-500 focus:outline-none placeholder-slate-600" />
      </div>

      {/* Everything flows in one wrapped line, float-left, no cards */}
      <div className="flex flex-wrap items-center gap-1.5">
        <MessagingFlow query={query} run={run} connected={connected} />
        <ModelsFlow agent={agent} query={query} run={run} prompt={prompt} connected={connected} />
        <McpFlow agent={agent} query={query} run={run} prompt={prompt} connected={connected} />
        <SkillsFlow agent={agent} query={query} run={run} prompt={prompt} connected={connected} />
        {SIMPLE_GROUPS.map((g) => (
          <FlowGroup key={g.title} group={g} query={query} run={run} connected={connected} />
        ))}
        <VaultDropdown termRef={termRef} connected={connected} />
      </div>
    </div>
  )
}
