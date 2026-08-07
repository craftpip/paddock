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

function matches(q, ...fields) {
  if (!q) return true
  const text = fields.filter(Boolean).join(' ').toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w))
}

function Pill({ label, onClick, cmd, desc, color, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={cmd || desc}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap border shrink-0 disabled:opacity-40 disabled:cursor-not-allowed ${color}`}
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
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border border-slate-700/60 bg-slate-800/40 text-slate-300 shrink-0 ${className}`}>
      {children}
    </span>
  )
}

/** Small destructive inline action button used inside data chips. */
function MiniBtn({ label, onClick, color = 'text-slate-400 hover:text-slate-200', disabled }) {
  return (
    <button onClick={onClick} disabled={disabled}
            className={`px-1.5 py-0.5 rounded-lg text-[10px] ${color} hover:bg-slate-700/60 transition-colors disabled:opacity-40`}>
      {label}
    </button>
  )
}

function FlowGroup({ group, query, run, connected }) {
  const c = COLORS[group.color] || COLORS.slate
  const groupHit = matches(query, group.title)
  const visible = group.commands.filter((x) => groupHit || matches(query, x.label, x.cmd, x.desc))
  if (query && !groupHit && visible.length === 0) return null
  return (
    <>
      <GroupLabel color={group.color} title={group.title} />
      {visible.map((x) => (
        <Pill
          key={x.label}
          label={x.label}
          desc={x.desc}
          cmd={x.cmd}
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
    { cmd: 'openclaw configure --section channels', label: 'Add/Remove channel', desc: 'Add, update, login or remove channel accounts (Telegram, WhatsApp, Signal, Discord, GChat)' },
    { cmd: 'openclaw channels list --all', label: 'List added channels', desc: 'List configured + available channels' },
    { cmd: 'openclaw channels status --probe', label: 'Check channel status', desc: 'Health check — live transport + audit check per account' },
    { cmd: 'openclaw channels capabilities', label: 'Check channel capabilities', desc: 'What each channel supports (intents/scopes)' },
    { cmd: 'openclaw channels logs --lines 100', label: 'View channel logs', desc: 'Recent channel runtime logs' },
    { cmd: 'openclaw agents bindings', label: 'View channel routing', desc: 'Which agent owns which channel' },
  ]
  const groupHit = matches(query, 'Messaging', 'channels')
  const visible = pills.filter((x) => groupHit || matches(query, x.label, x.cmd, x.desc))
  if (query && !groupHit && visible.length === 0) return null

  return (
    <>
      <GroupLabel color="cyan" title="Messaging" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.cyan.pill} danger={x.danger}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
    </>
  )
}

// ─── Models ──────────────────────────────────────────────────────

function ModelsFlow({ agent, query, run, prompt, connected }) {
  const pills = [
    { cmd: 'openclaw configure --section model', label: 'Add provider', desc: 'Add a provider — login, API key, token or OAuth (openrouter, ollama, openai, ...)' },
    { cmd: 'openclaw models auth list', label: 'List added providers', desc: 'List saved auth profiles / added providers' },
    { cmd: 'openclaw gateway call models.authLogout --params \'{"provider":"<id>"}\' --json', label: 'Remove provider', desc: 'Remove / delete a provider\'s saved auth profiles (logout)', danger: true, click: async () => {
      const v = await prompt({
        title: 'Remove provider',
        message: 'Removes the saved auth profiles for a provider (authLogout RPC).',
        confirmText: 'Remove provider',
        danger: true,
        fields: [{
          key: 'provider', label: 'Provider id', placeholder: 'e.g. openrouter',
          hint: 'Deletes the stored credentials for this provider (no way back unless you re-add).',
        }],
      })
      if (!v?.provider) return
      run(`openclaw gateway call models.authLogout --params '{"provider":"${v.provider}"}' --json`)
    } },
    { cmd: 'openclaw models list', label: 'Check available models', desc: 'Models you are logged in to (no --all)' },
    { cmd: 'openclaw models status', label: 'Check model status', desc: 'Health check — auth + model status overview' },
    { cmd: 'openclaw models set <model>', label: 'Set default model', desc: 'Set the primary model used by this agent', click: async () => {
      const v = await prompt({
        title: 'Set default model',
        message: 'Set the primary model used by this agent.',
        confirmText: 'Set model',
        fields: [{
          key: 'model', label: 'Model id', placeholder: 'e.g. openai/gpt-5.5',
          hint: 'Format: provider/model. Pick from "Check available models" or use any catalog id.',
        }],
      })
      if (!v?.model) return
      run(`openclaw models set ${v.model}`)
    } },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd, x.desc))
  const groupHit = matches(query, 'Models', 'provider', 'model')
  if (query && !groupHit && visible.length === 0) return null

  return (
    <>
      <GroupLabel color="blue" title="Models" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.blue.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
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
    { cmd: 'openclaw mcp list', label: 'List servers', desc: 'List configured MCP servers' },
    { label: 'Add server', desc: 'Add a new MCP server (stdio or HTTP)', click: async () => {
      const v = await prompt({
        title: 'Add MCP server',
        message: 'Name the server and give its transport. HTTP servers use a URL; stdio servers use a command.',
        confirmText: 'Add server',
        fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem', hint: 'Name used in config and tools (mcp__<name>__*).' },
          { key: 'transport', label: 'Transport', defaultValue: 'streamable-http', placeholder: 'streamable-http | stdio', hint: 'streamable-http (URL) or stdio (command).' },
          { key: 'url', label: 'URL (HTTP only)', placeholder: 'https://mcp.example.com', hint: 'Leave blank for stdio servers.' },
          { key: 'command', label: 'Command (stdio only)', placeholder: 'npx -y @modelcontextprotocol/server-filesystem /path', hint: 'Leave blank for HTTP servers.' },
        ],
      })
      if (!v?.name) return
      setMsg('Adding…')
      try {
        await api(`/api/agents/${agent.name}/mcp/add`, { method: 'POST', body: {
          name: v.name, transport: v.transport, url: v.url || '', command: v.command || '',
        }})
        setMsg(`"${v.name}" added.`)
        load()
      } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
    } },
    { label: 'Remove server', desc: 'Remove an MCP server', click: async () => {
      const v = await prompt({
        title: 'Remove MCP server',
        message: 'Which MCP server should we remove?',
        confirmText: 'Remove server',
        danger: true,
        fields: [{ key: 'name', label: 'Server name', placeholder: 'e.g. filesystem', hint: serverHint }],
      })
      if (!v?.name) return
      removeServer(v.name)
    } },
    { cmd: 'openclaw mcp doctor', label: 'Check server health', desc: 'Health check — diagnose MCP server setup' },
    { cmd: 'openclaw mcp probe', label: 'Probe servers', desc: 'Health check — connect and list live capabilities' },
    { cmd: 'openclaw mcp reload', label: 'Reload servers', desc: 'Refresh — reload server config' },
    { label: 'List tools', desc: 'List one server\'s available tools', click: async () => {
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
  const groupHit = matches(query, 'MCP', 'mcp', 'server')
  const visible = pills.filter((x) => groupHit || matches(query, x.label, x.cmd, x.desc))
  const shown = servers.filter((s) => groupHit || matches(query, s.name))
  if (query && !groupHit && visible.length === 0 && shown.length === 0) return null

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
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.emerald.pill}
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
    { label: 'Search skills', desc: 'Search the skill catalog', click: async () => {
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
    { cmd: 'openclaw skills update --all', label: 'Update all skills', desc: 'Update every installed skill', confirm: true },
    { label: 'Install skill', desc: 'Open the install box', click: () => setShowInstall(!showInstall) },
  ]
  const groupHit = matches(query, 'Skills', 'skill')
  const visible = pills.filter((x) => groupHit || matches(query, x.label, x.cmd, x.desc))
  if (query && !groupHit && visible.length === 0) return null

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
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.violet.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
      {showInstall && (
        <form onSubmit={doInstall} className="inline-flex items-center gap-2">
          <input type="text" value={installRef} onChange={(e) => setInstallRef(e.target.value)}
                 placeholder="@owner/slug or owner/repo@ref"
                 className="w-56 px-2.5 py-1.5 rounded-lg text-xs bg-slate-950 border border-slate-700 text-white focus:border-cyan-500 focus:outline-none placeholder-slate-600" />
          <button type="submit" disabled={installing}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 text-white transition-colors">
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
  const [locked, setLocked] = useState(false)
  const [loading, setLoading] = useState(false)
  const [pastingId, setPastingId] = useState('')
  const [filter, setFilter] = useState('')
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [saving, setSaving] = useState(false)
  // inline PIN gate — asked at the moment of use; the vault has no unlocked state
  const [pinMode, setPinMode] = useState(null) // null | { type:'paste', item } | { type:'add' }
  const [pastePin, setPastePin] = useState('')
  const [pinErr, setPinErr] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const wrapRef = useRef(null)
  const btnRef = useRef(null)
  const filterRef = useRef(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const d = await api('/api/vault')
      setItems(d?.items || [])
      setLocked(!!d?.meta?.locked)
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

  /** Fetch the decrypted value and paste it into the terminal.
   *  No trailing newline — the value sits in the shell input buffer and the
   *  user presses Enter themselves. Requires the PIN when the vault is locked. */
  async function pasteItem(item) {
    if (locked) {
      setPinMode({ type: 'paste', item })
      setPastePin('')
      setPinErr('')
      return
    }
    await doPaste(item)
  }

  async function doPaste(item, pin) {
    setPastingId(item.id)
    try {
      const d = await api(`/api/vault/${item.id}/decrypt?pin=${encodeURIComponent(pin || '')}`)
      if (!d?.value) throw new Error('Empty vault value')
      termRef.current?.write(d.value)
      toast.success(`"${item.name}" pasted to terminal`)
    } catch (err) {
      throw err
    } finally {
      setPastingId('')
    }
  }

  async function addItem(e) {
    e.preventDefault()
    if (!name.trim() || !value.trim()) return
    if (locked) {
      setPinMode({ type: 'add' })
      setPastePin('')
      setPinErr('')
      return
    }
    await doAdd(name.trim(), value.trim())
  }

  async function doAdd(addName, addValue, pin) {
    setSaving(true)
    try {
      await api('/api/vault', { method: 'POST', body: { name: addName, value: addValue, pin } })
      setName('')
      setValue('')
      toast.success('Vault item added')
      load()
    } finally {
      setSaving(false)
    }
  }

  async function submitPin(e) {
    e.preventDefault()
    if (!/^\d{4}$|^\d{6}$/.test(pastePin)) return setPinErr('PIN must be 4 or 6 digits')
    setPinBusy(true)
    setPinErr('')
    try {
      if (pinMode?.type === 'paste') {
        await doPaste(pinMode.item, pastePin)
        toast.success(`"${pinMode.item.name}" pasted to terminal`)
      } else if (pinMode?.type === 'add') {
        await doAdd(name.trim(), value.trim(), pastePin)
      }
      setPinMode(null)
      setPastePin('')
      load()
    } catch (err) {
      setPinErr(err.error || err.message || 'Wrong PIN')
    } finally {
      setPinBusy(false)
    }
  }

  return (
    <div ref={wrapRef} className="relative shrink-0 ml-auto">
      <button
        ref={btnRef}
        onClick={toggle}
        disabled={!connected}
        title={connected ? 'Vault — paste a saved secret into the terminal' : 'Vault — waiting for the terminal to connect'}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap border shrink-0 disabled:opacity-40 disabled:cursor-not-allowed
          ${open ? 'border-amber-500/70 bg-amber-950/40 text-amber-200' : 'border-amber-800/40 text-amber-300 bg-amber-950/20 hover:bg-amber-900/30 hover:text-amber-200'}`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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

          {locked && (
            <div className="px-3 py-2 text-[11px] text-amber-300/90 border-b border-slate-800 flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-amber-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span className="font-medium">Vault is locked</span>
              <span className="text-amber-500/70">— enter your PIN to use a value</span>
            </div>
          )}

          {pinMode && (
            <form onSubmit={submitPin} className="flex items-center gap-1.5 border-b border-slate-800 p-2">
              <input
                type="password"
                inputMode="numeric"
                value={pastePin}
                onChange={(e) => { setPastePin(e.target.value.replace(/\D/g, '').slice(0, 6)); setPinErr('') }}
                placeholder="••••••"
                autoFocus
                autoComplete="current-password"
                className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-amber-500 focus:outline-none placeholder-slate-600 text-center tracking-[0.25em] font-mono"
              />
              <button type="submit" disabled={pinBusy}
                      className="px-2 py-1 rounded text-[11px] bg-amber-600 hover:bg-amber-500 disabled:bg-slate-700 text-white transition-colors whitespace-nowrap">
                {pinBusy ? '…' : (pinMode.type === 'paste' ? 'Unlock & paste' : 'Unlock & add')}
              </button>
              <button type="button" onClick={() => { setPinMode(null); setPastePin(''); setPinErr('') }} disabled={pinBusy}
                      className="px-1.5 py-1 rounded text-[11px] text-slate-400 hover:text-white hover:bg-slate-700 transition-colors whitespace-nowrap">
                ✕
              </button>
              {pinErr && <span className="text-[10px] text-red-400">{pinErr}</span>}
            </form>
          )}

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
                title={locked ? 'Enter your PIN to paste this value' : 'Fetch value and paste into terminal'}
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
  const [showCommands, setShowCommands] = useState(true)
  const [driverGroups, setDriverGroups] = useState([])
  const [tuiCommand, setTuiCommand] = useState('openclaw')
  const prompt = usePrompt()

  // The Messaging/Models/MCP/Skills flows below are openclaw-only (their
  // commands and backing APIs are openclaw's). Other agent types render only
  // their driver-provided groups.
  const isOpenclaw = agent?.agent_type === 'openclaw'

  // The command groups ("buttons") live in the agent driver, served over the
  // API — not hardcoded here.
  useEffect(() => {
    if (!agent?.agent_type) return
    api(`/api/agent-types/${agent.agent_type}/commands`)
      .then((d) => {
        setDriverGroups(d.commands || [])
        setTuiCommand(d.tuiCommand || 'openclaw')
      })
      .catch(() => setDriverGroups([]))
  }, [agent?.agent_type])

  /** Launch the agent's interactive TUI (openclaw / opencode / …) in the terminal. */
  function runTool() {
    run(tuiCommand)
  }

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex items-center gap-2">
        <button
          onClick={runTool}
          disabled={!connected}
          title={connected ? `Run ${tuiCommand} interactively in the terminal` : 'Waiting for the terminal to connect'}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Run TUI
        </button>
        <input type="text" value={query}
               onChange={(e) => { setQuery(e.target.value); if (e.target.value) setShowCommands(true) }}
               placeholder="Filter commands…"
               className="flex-1 max-w-md px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white focus:border-cyan-500 focus:outline-none placeholder-slate-600" />
        <button
          onClick={() => setShowCommands((v) => !v)}
          title={showCommands ? 'Hide command buttons' : 'Show command buttons'}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap border shrink-0 ${showCommands ? 'border-slate-700 bg-slate-800/60 text-slate-300 hover:bg-slate-700 hover:text-slate-200' : 'border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200'}`}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {showCommands ? (
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 10 8 10 8a18.5 18.5 0 0 1-2.16 3.19M6.61 6.61A18.5 18.5 0 0 0 2 12s3 8 10 8a9.12 9.12 0 0 0 4.1-.9" />
            ) : (
              <path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8Z" />
            )}
            {showCommands && <path d="m2 2 20 20" />}
          </svg>
          {showCommands ? 'Hide' : 'Show'}
        </button>
        <VaultDropdown termRef={termRef} connected={connected} />
      </div>

      {/* Everything flows in one wrapped line, float-left, no cards */}
      {showCommands && (
        <div className="flex flex-wrap items-center gap-1.5">
          {isOpenclaw && <MessagingFlow query={query} run={run} connected={connected} />}
          {isOpenclaw && <ModelsFlow agent={agent} query={query} run={run} prompt={prompt} connected={connected} />}
          {isOpenclaw && <McpFlow agent={agent} query={query} run={run} prompt={prompt} connected={connected} />}
          {isOpenclaw && <SkillsFlow agent={agent} query={query} run={run} prompt={prompt} connected={connected} />}
          {driverGroups.map((g) => (
            <FlowGroup key={g.title} group={g} query={query} run={run} connected={connected} />
          ))}
        </div>
      )}
    </div>
  )
}
