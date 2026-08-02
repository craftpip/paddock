import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { usePrompt } from '../../lib/prompt'

/**
 * Commands — the "home" mode of an agent page.
 *
 * The whole pane is ONE continuous wrapped flow of pill buttons (float-left):
 * every group's commands sit inline in a single line that wraps, no cards, no
 * rows. Group labels are small chips inline before their buttons. Data
 * (servers, skills, backups, creds) shows as compact chips in the same flow.
 * Commands run in the docked terminal below. The `run`/`runningCmd`/`termRef`
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
    title: 'Diagnostics', color: 'cyan',
    commands: [
      { cmd: 'openclaw health', label: 'Health', desc: 'Cached health snapshot' },
      { cmd: 'openclaw status', label: 'Status', desc: 'Quick channels + sessions' },
      { cmd: 'openclaw logs --tail 50', label: 'Logs', desc: 'Recent gateway logs (50 lines)' },
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
    title: 'Security', color: 'rose',
    commands: [
      { cmd: 'openclaw security audit', label: 'Audit', desc: 'Cold security audit' },
      { cmd: 'openclaw security audit --deep', label: 'Audit (deep)', desc: 'Live probes' },
      { cmd: 'openclaw security audit --fix', label: 'Audit & Fix', desc: 'Auto-fix issues', confirm: true },
    ],
  },
  {
    title: 'Memory', color: 'violet',
    commands: [
      { cmd: 'openclaw memory status', label: 'Status', desc: 'Index health' },
      { cmd: 'openclaw memory index', label: 'Reindex', desc: 'Incremental rebuild' },
      { cmd: 'openclaw memory index --force', label: 'Force Reindex', desc: 'Full vector rebuild', confirm: true, danger: true },
      { cmd: 'openclaw memory promote --apply', label: 'Promote', desc: 'Short-term → MEMORY.md', confirm: true },
    ],
  },
  {
    title: 'Config', color: 'teal',
    commands: [
      { cmd: 'openclaw config validate', label: 'Validate', desc: 'Check config against schema' },
      { cmd: 'openclaw config file', label: 'File path', desc: 'Show active config path' },
      { cmd: 'openclaw config get agents.defaults.model --json', label: 'Model config', desc: 'Primary + fallback models' },
      { cmd: 'openclaw config schema --json', label: 'Schema', desc: 'Dump JSON schema' },
    ],
  },
  {
    title: 'Other', color: 'slate',
    commands: [
      { cmd: 'openclaw backup create', label: 'Backup', desc: 'Create a backup archive', confirm: true },
      { cmd: 'openclaw update', label: 'Update', desc: 'Check for updates', confirm: true },
      { cmd: 'openclaw mcp doctor', label: 'MCP Doctor', desc: 'Check MCP servers' },
    ],
  },
]

function matches(q, ...fields) {
  if (!q) return true
  const needle = q.toLowerCase()
  return fields.some((f) => (f || '').toLowerCase().includes(needle))
}

function Pill({ label, onClick, desc, color, disabled, active, danger }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={desc}
      className={`px-2 py-1 rounded text-[11px] font-medium transition-colors whitespace-nowrap border shrink-0 disabled:opacity-40 disabled:cursor-not-allowed
        ${danger ? 'bg-red-900/30 text-red-400 border-red-800/50 hover:bg-red-800/50 hover:text-red-300' : color}
        ${active ? 'ring-1 ring-cyan-500/60' : ''}`}
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

function FlowGroup({ group, query, runningCmd, run }) {
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
          disabled={!!runningCmd}
          active={runningCmd === x.cmd}
          onClick={() => run(x.cmd, x)}
        />
      ))}
    </>
  )
}

// ─── Messaging ───────────────────────────────────────────────────

function MessagingFlow({ agent, query, runningCmd, run, termRef }) {
  const [creds, setCreds] = useState({ bot_tokens: {}, user_ids: {} })

  function loadCreds() {
    api('/api/credentials').then((d) => {
      if (d) setCreds({ bot_tokens: d.bot_tokens || {}, user_ids: d.user_ids || {} })
    }).catch(() => {})
  }
  useEffect(() => { loadCreds() }, [agent.name])

  const pills = [
    { cmd: 'openclaw configure --section channels', label: 'Configure channel', desc: 'Interactive wizard — add, update, login or remove channel accounts' },
    { cmd: 'openclaw channels list --all', label: 'List channels', desc: 'Configured + available channels' },
    { cmd: 'openclaw channels status --probe', label: 'Status probe', desc: 'Live transport + audit check per account' },
    { cmd: 'openclaw channels capabilities', label: 'Capabilities', desc: 'What each channel supports (intents/scopes)' },
    { cmd: 'openclaw channels logs --lines 100', label: 'Channel logs', desc: 'Recent channel runtime logs' },
    { cmd: 'openclaw agents bindings', label: 'Routing', desc: 'Which agent owns which channel' },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  const tokenEntries = [
    ...Object.entries(creds.bot_tokens).map(([name, data]) => ({ key: 'b' + name, name, value: typeof data === 'string' ? data : data.token, hint: 'Paste bot token' })),
    ...Object.entries(creds.user_ids).map(([name, data]) => ({ key: 'u' + name, name, value: typeof data === 'string' ? data : data.uid, hint: 'Paste user ID' })),
  ]
  if (query && visible.length === 0 && tokenEntries.length === 0) return null

  return (
    <>
      <GroupLabel color="cyan" title="Messaging" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.cyan.pill} danger={x.danger}
              disabled={!!runningCmd} active={runningCmd === x.cmd}
              onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
      ))}
      {tokenEntries.map((t) => (
        <button key={t.key}
                onClick={() => termRef.current?.pasteSecret(t.value)}
                title={t.hint}
                className="px-2 py-1 rounded text-[11px] font-mono border border-emerald-800/30 text-emerald-300 bg-emerald-950/20 hover:bg-emerald-900/30 hover:text-emerald-200 transition-colors whitespace-nowrap">
          {t.name}
        </button>
      ))}
    </>
  )
}

// ─── Models ──────────────────────────────────────────────────────

function ModelsFlow({ agent, query, runningCmd, run, prompt }) {
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
    { cmd: 'openclaw configure --section model', label: 'Add provider', desc: 'Interactive setup — API key, token or OAuth' },
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
              disabled={!!runningCmd} active={runningCmd === x.cmd}
              onClick={() => (x.click ? x.click() : run(x.cmd))} />
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

function McpFlow({ agent, query, runningCmd, run }) {
  const [servers, setServers] = useState([])
  const [removing, setRemoving] = useState('')
  const [msg, setMsg] = useState('')

  function load() {
    api(`/api/agents/${agent.name}/mcp`).then((d) => setServers(d.servers || [])).catch(() => {})
  }
  useEffect(load, [agent.name])

  const pills = [
    { cmd: 'openclaw mcp list', label: 'List', desc: 'Configured MCP servers' },
    { cmd: 'openclaw mcp status', label: 'Status', desc: 'Server status' },
    { cmd: 'openclaw mcp doctor', label: 'Doctor', desc: 'Check server health' },
    { cmd: 'openclaw mcp probe', label: 'Probe', desc: 'Probe all servers' },
    { cmd: 'openclaw mcp reload', label: 'Reload', desc: 'Reload server config' },
    { cmd: 'openclaw mcp tools', label: 'Tools', desc: 'List available tools' },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  const shown = servers.filter((s) => matches(query, s.name))
  if (query && visible.length === 0 && shown.length === 0) return null

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

  return (
    <>
      {msg && <span className="text-[11px] text-cyan-400">{msg}</span>}
      <GroupLabel color="emerald" title="MCP" />
      {visible.map((x) => (
        <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.emerald.pill}
              disabled={!!runningCmd} active={runningCmd === x.cmd} onClick={() => run(x.cmd)} />
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

function SkillsFlow({ agent, query, runningCmd, run, prompt }) {
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
              disabled={!!runningCmd} active={runningCmd === x.cmd}
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

// ─── Main CommandsPane ───────────────────────────────────────────

export default function CommandsPane({ agent, termRef, run, runningCmd }) {
  const [query, setQuery] = useState('')
  const prompt = usePrompt()

  return (
    <div className="space-y-4">
      {/* Search */}
      <div className="flex items-center gap-2">
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
               placeholder="Filter commands…"
               className="flex-1 max-w-md px-3 py-1.5 bg-slate-950 border border-slate-700 rounded-lg text-sm text-white focus:border-cyan-500 focus:outline-none placeholder-slate-600" />
        {runningCmd && (
          <span className="flex items-center gap-1.5 text-xs text-cyan-300 font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
            Running
          </span>
        )}
      </div>

      {/* Everything flows in one wrapped line, float-left, no cards */}
      <div className="flex flex-wrap items-center gap-1.5">
        {SIMPLE_GROUPS.map((g) => (
          <FlowGroup key={g.title} group={g} query={query} runningCmd={runningCmd} run={run} />
        ))}
        <MessagingFlow agent={agent} query={query} runningCmd={runningCmd} run={run} termRef={termRef} />
        <ModelsFlow agent={agent} query={query} runningCmd={runningCmd} run={run} prompt={prompt} />
        <McpFlow agent={agent} query={query} runningCmd={runningCmd} run={run} />
        <SkillsFlow agent={agent} query={query} runningCmd={runningCmd} run={run} prompt={prompt} />
      </div>
    </div>
  )
}
