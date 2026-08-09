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
  accent:  { dot: 'bg-accent',  pill: 'border-accent-line/30 text-accent-text bg-accent-soft hover:bg-accent/15 hover:text-accent-text' },
  warning: { dot: 'bg-warning', pill: 'border-warning-line/30 text-warning bg-warning-soft hover:bg-warning/15 hover:text-warning' },
  danger:  { dot: 'bg-danger',  pill: 'border-danger-line/30 text-danger bg-danger-soft hover:bg-danger/15 hover:text-danger' },
  brand:   { dot: 'bg-brand',   pill: 'border-brand-line/30 text-brand bg-brand-soft hover:bg-brand/15 hover:text-brand' },
  success: { dot: 'bg-success', pill: 'border-success-line/30 text-success bg-success-soft hover:bg-success/15 hover:text-success' },
  info:    { dot: 'bg-info',    pill: 'border-info-line/30 text-info bg-info-soft hover:bg-info/15 hover:text-info' },
  slate:   { dot: 'bg-line',    pill: 'border-line/50 text-ink-faint bg-panel/50 hover:bg-raised hover:text-ink' },
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

/** Shell-quote a value so it survives the shell in the terminal. */
function sq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** Run a driver command. Commands that declare `fields` open the prompt modal
 *  first; `{key}` placeholders in `cmd` are replaced with the (shell-quoted)
 *  entered values, then the built command is pasted into the terminal. Plain
 *  commands run as-is, still through the terminal. */
async function onClickCommand(x, prompt, run) {
  if (x.fields?.length) {
    const v = await prompt({
      title: x.label,
      message: x.desc || 'Enter the arguments for this command.',
      confirmText: x.label,
      fields: x.fields,
    })
    if (!v) return
    let cmd = x.cmd
    for (const f of x.fields) {
      const val = v[f.key] === undefined || v[f.key] === null ? '' : String(v[f.key])
      cmd = cmd.split(`{${f.key}}`).join(val ? sq(val) : '')
    }
    run(cmd, x)
    return
  }
  run(x.cmd, x)
}

/** Small inline group label chip, sits in the flow before its buttons. */
function GroupLabel({ color, title }) {
  const c = COLORS[color] || COLORS.slate
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0 ml-1 first:ml-0">
      <span className={`w-1.5 h-3 rounded-full ${c.dot}`} />
      <span className="text-[10px] font-semibold text-ink-faint uppercase tracking-wider">{title}</span>
    </span>
  )
}

function FlowGroup({ group, query, run, prompt, connected }) {
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
          onClick={() => onClickCommand(x, prompt, run)}
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
      <GroupLabel color="accent" title="Messaging" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.accent.pill} danger={x.danger}
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
      <GroupLabel color="info" title="Models" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.info.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
    </>
  )
}

// ─── MCP ─────────────────────────────────────────────────────────

function McpFlow({ agent, query, run, prompt, connected }) {
  const [servers, setServers] = useState([])
  const confirm = useConfirm()
  const toast = useToast()

  function load() {
    api(`/api/agents/${agent.name}/mcp`).then((d) => setServers(d.servers || [])).catch(() => {})
  }
  useEffect(load, [agent.name])

  const serverHint = servers.length
    ? 'Configured servers: ' + servers.map((s) => s.name).join(', ')
    : 'No servers configured — run "List" first.'

  // Single-quote a value so it survives the shell in the terminal.
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

  const pills = [
    { cmd: 'openclaw mcp list', label: 'List servers', desc: 'List configured MCP servers' },
    { label: 'Add server', desc: 'Paste an "openclaw mcp add" command into the terminal', click: async () => {
      const v = await prompt({
        title: 'Add MCP server',
        message: 'Name the server, pick how the agent should connect, then give it a URL (remote) or command (local).\n\nThis pastes the openclaw command into the terminal for you to run.',
        confirmText: 'Add server',
        fields: [
          { key: 'name', label: 'Server name', placeholder: 'e.g. filesystem', hint: 'Name used in config and tools (mcp__<name>__*).' },
          { key: 'transport', label: 'Transport', type: 'select', defaultValue: 'streamable-http', options: [
            { value: 'streamable-http', label: 'Streamable HTTP — remote server URL' },
            { value: 'sse', label: 'SSE — remote server URL' },
            { value: 'stdio', label: 'Stdio — local command' },
          ], hint: 'How the agent connects to the server.' },
          { key: 'url', label: 'URL', placeholder: 'https://mcp.example.com/mcp', hint: 'HTTP/HTTPS endpoint of the remote MCP server.', when: (v) => v.transport !== 'stdio' },
          { key: 'command', label: 'Command', placeholder: 'npx -y @modelcontextprotocol/server-filesystem /path', hint: 'Command plus arguments that start a local server process.', when: (v) => v.transport === 'stdio' },
          { key: 'testConnection', label: 'Test MCP connection', type: 'checkbox', defaultValue: true, checkLabel: 'Run a connectivity check after adding', hint: 'When checked, openclaw probes the new server after adding so you see if it connects.' },
        ],
      })
      if (!v?.name) return
      let cmd = `openclaw mcp add ${v.name}`
      if (v.testConnection === false) cmd += ' --no-probe'
      if (v.transport === 'stdio') {
        if (!v.command) { toast.error('A command is required for stdio servers.'); return }
        cmd += ` --command ${sq(v.command)}`
      } else {
        if (!v.url) { toast.error('A URL is required for HTTP servers.'); return }
        cmd += ` --url ${sq(v.url)} --transport ${sq(v.transport)}`
      }
      run(cmd)
    } },
    { label: 'Remove server', desc: 'Paste an "openclaw mcp unset" command into the terminal', click: async () => {
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
    { cmd: 'openclaw mcp reload', label: 'Reload servers', desc: 'Refresh — reload server config' },
    { label: 'List tools', desc: 'Probe a server\'s tools — or all servers if left blank', click: async () => {
      const v = await prompt({
        title: 'List MCP tools',
        message: 'Which MCP server should we probe? Leave blank to probe all configured servers.',
        confirmText: 'Probe',
        fields: [{
          key: 'name', label: 'Server name (optional)', placeholder: 'e.g. filesystem',
          hint: serverHint,
        }],
      })
      if (v?.name) run(`openclaw mcp probe ${v.name}`)
      else run('openclaw mcp probe')
    } },
    { cmd: 'openclaw mcp doctor', label: 'Check server health', desc: 'Health check — diagnose MCP server setup' },
  ]
  const groupHit = matches(query, 'MCP', 'mcp', 'server')
  const visible = pills.filter((x) => groupHit || matches(query, x.label, x.cmd, x.desc))
  if (query && !groupHit && visible.length === 0) return null

  async function removeServer(name) {
    const ok = await confirm({
      title: 'Remove MCP server',
      message: `Remove "${name}"?`,
      danger: true,
      confirmText: 'Remove',
    })
    if (!ok) return
    run(`openclaw mcp unset ${name}`)
  }

  return (
    <>
      <GroupLabel color="success" title="MCP" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.success.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd))} />
      ))}
    </>
  )
}

// ─── Skills ──────────────────────────────────────────────────────

function SkillsFlow({ agent, query, run, prompt, connected }) {
  const [showInstall, setShowInstall] = useState(false)
  const [installRef, setInstallRef] = useState('')
  const [installing, setInstalling] = useState(false)

  // Single-quote a value so it survives the shell in the terminal.
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

  const pills = [
    { cmd: 'openclaw skills list', label: 'List installed skills', desc: 'Show all skills currently installed / visible to this agent' },
    { cmd: 'openclaw skills check', label: 'Check skills', desc: 'Report which skills are ready vs missing requirements' },
    { cmd: 'openclaw configure --section skills', label: 'Configure skills', desc: 'Edit skills configuration' },
    { label: 'Install skill', desc: 'Open the install box', click: () => setShowInstall(!showInstall) },
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
  ]
  const groupHit = matches(query, 'Skills', 'skill')
  const visible = pills.filter((x) => groupHit || matches(query, x.label, x.cmd, x.desc))
  if (query && !groupHit && visible.length === 0) return null

  async function doInstall(e) {
    e.preventDefault()
    if (!installRef || installing) return
    setInstalling(true)
    run(`openclaw skills install ${sq(installRef)}`)
    setInstallRef(''); setShowInstall(false)
    setTimeout(() => setInstalling(false), 1000)
  }

  return (
    <>
      <GroupLabel color="brand" title="Skills" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.brand.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
      {showInstall && (
        <form onSubmit={doInstall} className="inline-flex items-center gap-2">
          <input type="text" value={installRef} onChange={(e) => setInstallRef(e.target.value)}
                 placeholder="@owner/slug or owner/repo@ref"
                 className="w-56 px-2.5 py-1.5 rounded-lg text-xs bg-sunken border border-line text-ink focus:border-accent-line focus:outline-none placeholder-ink-dim" />
          <button type="submit" disabled={installing}
                  className="px-2.5 py-1.5 rounded-lg text-xs bg-accent hover:bg-accent-hover disabled:bg-raised text-accent-ink transition-colors">
            {installing ? '…' : 'Install'}
          </button>
        </form>
      )}
    </>
  )
}

// ─── Memory ────────────────────────────────────────────────────

function MemoryFlow({ agent, query, run, prompt, connected }) {
  // Single-quote a value so it survives the shell in the terminal.
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"

  const pills = [
    { cmd: 'openclaw memory status', label: 'Memory status', desc: 'Check index status and memory availability' },
    { cmd: 'openclaw memory status --deep', label: 'Deep status', desc: 'Probe vector-store, embedding-provider and semantic-search readiness' },
    { cmd: 'openclaw memory index', label: 'Index memory', desc: 'Run incremental indexing for all agents' },
    { cmd: 'openclaw memory index --force', label: 'Reindex (force)', desc: 'Full reindex, dropping and rebuilding the vector store', danger: true },
    { label: 'Search memory', desc: 'Semantic search of indexed memory', click: async () => {
      const v = await prompt({
        title: 'Search memory',
        message: 'Semantic search over the agent\'s indexed memory.',
        confirmText: 'Search',
        fields: [
          { key: 'query', label: 'Query', placeholder: 'e.g. release checklist', hint: 'Free-text semantic query.' },
          { key: 'max', label: 'Max results (optional)', placeholder: 'e.g. 10', hint: 'Cap the number of results returned.' },
        ],
      })
      if (!v?.query) return
      run(`openclaw memory search ${sq(v.query)}${v.max ? ` --max-results ${v.max}` : ''}`)
    } },
    { cmd: 'openclaw memory promote --apply', label: 'Promote memories', desc: 'Rank short-term memories and append top entries to MEMORY.md', confirm: true },
  ]
  const groupHit = matches(query, 'Memory', 'memory')
  const visible = pills.filter((x) => groupHit || matches(query, x.label, x.cmd, x.desc))
  if (query && !groupHit && visible.length === 0) return null

  return (
    <>
      <GroupLabel color="slate" title="Memory" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} cmd={x.cmd} color={COLORS.slate.pill}
              disabled={!connected}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
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
          ${open ? 'border-warning-line/70 bg-warning-soft text-warning' : 'border-warning-line/40 text-warning bg-warning-soft hover:bg-warning-soft hover:text-warning'}`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Vault
        {items.length > 0 && <span className="text-[10px] text-warning/80">{items.length}</span>}
        <svg className="w-3 h-3 text-warning/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && anchor && (
        <div
          className="fixed z-50 w-80 rounded-lg border border-line bg-sunken shadow-xl overflow-hidden"
          style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) }}
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-line-faint">
            <span className="text-xs font-medium text-ink-muted">Vault</span>
            <button onClick={load} title="Refresh vault list" className="text-ink-dim hover:text-ink text-xs px-1">
              ↻
            </button>
          </div>

          <div className="px-2 py-1.5 border-b border-line-faint">
            <div className="relative">
              <svg className="w-3 h-3 text-ink-dim absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={filterRef}
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter vault…"
                className="w-full pl-6 pr-6 py-1 rounded text-[11px] bg-sunken border border-line text-ink focus:border-warning-line focus:outline-none placeholder-ink-dim"
              />
              {filter && (
                <button onClick={() => setFilter('')} title="Clear filter"
                        className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-dim hover:text-ink text-xs px-0.5">
                  ×
                </button>
              )}
            </div>
          </div>

          {locked && (
            <div className="px-3 py-2 text-[11px] text-warning/90 border-b border-line-faint flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 text-warning shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span className="font-medium">Vault is locked</span>
              <span className="text-warning/70">— enter your PIN to use a value</span>
            </div>
          )}

          {pinMode && (
            <form onSubmit={submitPin} className="flex items-center gap-1.5 border-b border-line-faint p-2">
              <input
                type="password"
                inputMode="numeric"
                value={pastePin}
                onChange={(e) => { setPastePin(e.target.value.replace(/\D/g, '').slice(0, 6)); setPinErr('') }}
                placeholder="••••••"
                autoFocus
                autoComplete="current-password"
                className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] bg-sunken border border-line text-ink focus:border-warning-line focus:outline-none placeholder-ink-dim text-center tracking-[0.25em] font-mono"
              />
              <button type="submit" disabled={pinBusy}
                      className="px-2 py-1 rounded text-[11px] bg-warning hover:bg-warning disabled:bg-raised text-warning-ink transition-colors whitespace-nowrap">
                {pinBusy ? '…' : (pinMode.type === 'paste' ? 'Unlock & paste' : 'Unlock & add')}
              </button>
              <button type="button" onClick={() => { setPinMode(null); setPastePin(''); setPinErr('') }} disabled={pinBusy}
                      className="px-1.5 py-1 rounded text-[11px] text-ink-faint hover:text-ink hover:bg-raised transition-colors whitespace-nowrap">
                ✕
              </button>
              {pinErr && <span className="text-[10px] text-danger">{pinErr}</span>}
            </form>
          )}

          <div className="max-h-56 overflow-y-auto py-1">
            {loading && items.length === 0 && (
              <div className="px-3 py-2 text-xs text-ink-dim">Loading…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-ink-dim">
                {items.length === 0 ? 'No vault items yet.' : `No matches for "${filter}".`}
              </div>
            )}
            {filtered.map((item) => (
              <button
                key={item.id}
                onClick={() => pasteItem(item)}
                disabled={!!pastingId || !connected}
                className="w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs hover:bg-panel hover:text-accent-text transition-colors group disabled:opacity-40"
                title={locked ? 'Enter your PIN to paste this value' : 'Fetch value and paste into terminal'}
              >
                <svg className="w-3 h-3 text-warning/70 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
                </svg>
                <span className="min-w-0">
                  <span className="block font-medium text-ink group-hover:text-accent-text truncate">{item.name}</span>
                  {item.description && (
                    <span className="block text-[10px] text-ink-dim truncate">{item.description}</span>
                  )}
                </span>
                {pastingId === item.id && <span className="ml-auto text-[10px] text-accent-text">fetching…</span>}
              </button>
            ))}
          </div>

          <form onSubmit={addItem} className="flex flex-col gap-1.5 border-t border-line-faint p-2">
            <span className="text-[10px] font-semibold text-ink-dim uppercase tracking-wider px-1">Add vault item</span>
            <div className="flex gap-1.5">
              <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="name"
                     className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] bg-sunken border border-line text-ink focus:border-warning-line focus:outline-none placeholder-ink-dim" />
              <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value"
                     autoComplete="new-password"
                     className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] bg-sunken border border-line text-ink focus:border-warning-line focus:outline-none placeholder-ink-dim font-mono" />
            </div>
            <button type="submit" disabled={saving || !name.trim() || !value.trim()}
                    className="px-2 py-1 rounded text-[11px] bg-warning hover:bg-warning disabled:bg-raised disabled:text-ink-dim text-warning-ink transition-colors">
              {saving ? 'Adding…' : '+ Add'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}

// ─── Main CommandsPane ───────────────────────────────────────────

const SHOW_COMMANDS_KEY = 'paddock.commands.showCommands'

export default function CommandsPane({ agent, termRef, run, connected }) {
  const [query, setQuery] = useState('')
  const [showCommands, setShowCommands] = useState(() => localStorage.getItem(SHOW_COMMANDS_KEY) !== '0')
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
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent-hover text-accent-ink rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          Run TUI
        </button>
        <input type="text" value={query}
               onChange={(e) => { setQuery(e.target.value); if (e.target.value) { setShowCommands(true); localStorage.setItem(SHOW_COMMANDS_KEY, '1') } }}
               placeholder="Filter commands…"
               className="flex-1 max-w-md px-3 py-1.5 bg-sunken border border-line rounded-lg text-sm text-ink focus:border-accent-line focus:outline-none placeholder-ink-dim" />
        <button
          onClick={() => setShowCommands((v) => {
            const next = !v
            localStorage.setItem(SHOW_COMMANDS_KEY, next ? '1' : '0')
            return next
          })}
          title={showCommands ? 'Hide command buttons' : 'Show command buttons'}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap border shrink-0 ${showCommands ? 'border-line bg-panel/60 text-ink-muted hover:bg-raised hover:text-ink' : 'border-line bg-panel text-ink-faint hover:bg-raised hover:text-ink'}`}
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
          {isOpenclaw && <MemoryFlow agent={agent} query={query} run={run} prompt={prompt} connected={connected} />}
          {driverGroups.map((g) => (
            <FlowGroup key={g.title} group={g} query={query} run={run} prompt={prompt} connected={connected} />
          ))}
        </div>
      )}
    </div>
  )
}
