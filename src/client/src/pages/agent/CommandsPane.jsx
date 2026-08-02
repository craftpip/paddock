import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'

/**
 * Commands — the "home" mode of an agent page.
 *
 * Groups of one-click OpenClaw CLI commands that run in the docked terminal
 * below (tracked), plus compact live panels for Messaging, Models, MCP, Skills
 * and Backups. The `run`/`runningCmd`/`termRef` plumbing lives in AgentDetail.
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
      { cmd: 'openclaw channels status --probe', label: 'Channels Probe', desc: 'Per-channel health probe' },
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

function GroupCard({ title, color, children, className = '' }) {
  const c = COLORS[color] || COLORS.slate
  return (
    <div className={`border border-slate-800 rounded-xl p-4 ${className}`}>
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-1.5 h-4 rounded-full ${c.dot}`} />
        <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function SimpleGroupCard({ group, query, runningCmd, run }) {
  const c = COLORS[group.color] || COLORS.slate
  const visible = group.commands.filter((x) => matches(query, x.label, x.cmd, x.desc))
  if (query && visible.length === 0) return null
  return (
    <GroupCard title={group.title} color={group.color}>
      <div className="flex flex-wrap gap-1.5">
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
      </div>
    </GroupCard>
  )
}

// ─── Messaging card ──────────────────────────────────────────────

const CHANNEL_ICONS = {
  telegram: '✈', signal: '💬', whatsapp: '📱', discord: '🎮',
  gchat: '📧', matrix: '🔗', slack: '💼', nostr: '🌐',
  imessage: '🍎', tlon: '🐦',
}

function MessagingCard({ agent, query, runningCmd, run, termRef }) {
  const [channels, setChannels] = useState([])
  const [selected, setSelected] = useState('')
  const [creds, setCreds] = useState({ bot_tokens: {}, user_ids: {} })

  function loadChannels(force) {
    api(`/api/agents/${agent.name}/channels-list${force ? '?refresh=true' : ''}`).then((d) => {
      const entries = Object.entries(d.chat || {}).map(([id, v]) => ({ id, name: v.name || id }))
      setChannels(entries)
      if (!selected && entries.length > 0) setSelected(entries[0].id)
    }).catch(() => {})
  }
  function loadCreds() {
    api('/api/credentials').then((d) => {
      if (d) setCreds({ bot_tokens: d.bot_tokens || {}, user_ids: d.user_ids || {} })
    }).catch(() => {})
  }
  useEffect(() => { loadChannels(); loadCreds() }, [agent.name])

  const pills = [
    { cmd: 'openclaw channels status --probe', label: 'Status', desc: 'Live channel probe' },
    { cmd: 'openclaw channels list --all', label: 'List all', desc: 'All configured channels' },
    { cmd: 'openclaw channels logs --lines 100', label: 'Logs', desc: 'Channel runtime logs' },
    ...(selected ? [
      { cmd: `openclaw channels add --channel ${selected}`, label: `Add ${selected}`, desc: 'Interactive setup wizard' },
      { cmd: `openclaw channels login --channel ${selected}`, label: `Login ${selected}`, desc: 'Interactive login' },
      { cmd: `openclaw channels logout --channel ${selected}`, label: `Logout ${selected}`, desc: 'Logout + stop listener' },
      { cmd: `openclaw channels remove --channel ${selected} --delete`, label: `Remove ${selected}`, desc: 'Delete account', confirm: true, danger: true },
    ] : []),
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  if (query && visible.length === 0) return null

  const tokenCount = Object.keys(creds.bot_tokens).length + Object.keys(creds.user_ids).length

  return (
    <GroupCard title="Messaging" color="cyan">
      <div className="flex flex-wrap items-center gap-1.5">
        {channels.length > 0 && (
          <select value={selected} onChange={(e) => setSelected(e.target.value)}
                  className="px-1.5 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-cyan-500 focus:outline-none">
            {channels.map((ch) => <option key={ch.id} value={ch.id}>{CHANNEL_ICONS[ch.id] || '📡'} {ch.name}</option>)}
          </select>
        )}
        {visible.map((x) => (
          <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.cyan.pill} danger={x.danger}
                disabled={!!runningCmd} active={runningCmd === x.cmd} onClick={() => run(x.cmd, x)} />
        ))}
      </div>

      {/* Saved credentials — click to paste into whatever is running in the terminal */}
      <div className="mt-3 pt-3 border-t border-slate-800/70">
        <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider mb-1.5">
          Saved credentials {tokenCount > 0 ? `(${tokenCount})` : ''} — click to paste
        </p>
        {tokenCount === 0 ? (
          <p className="text-[11px] text-slate-600">None saved. Add them in the Credentials page.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(creds.bot_tokens).map(([name, data]) => (
              <button key={'b' + name}
                      onClick={() => termRef.current?.pasteSecret(typeof data === 'string' ? data : data.token)}
                      title="Paste bot token into terminal"
                      className="px-2 py-1 rounded text-[11px] font-mono border border-emerald-800/30 text-emerald-300 bg-emerald-950/20 hover:bg-emerald-900/30 hover:text-emerald-200 transition-colors whitespace-nowrap">
                {name}
              </button>
            ))}
            {Object.entries(creds.user_ids).map(([name, data]) => (
              <button key={'u' + name}
                      onClick={() => termRef.current?.pasteSecret(typeof data === 'string' ? data : data.uid)}
                      title="Paste user ID into terminal"
                      className="px-2 py-1 rounded text-[11px] font-mono border border-blue-800/30 text-blue-300 bg-blue-950/20 hover:bg-blue-900/30 hover:text-blue-200 transition-colors whitespace-nowrap">
                {name}
              </button>
            ))}
          </div>
        )}
      </div>
    </GroupCard>
  )
}

// ─── Models card ─────────────────────────────────────────────────

function ModelsCard({ agent, query, runningCmd, run }) {
  const [config, setConfig] = useState(null)
  const [provider, setProvider] = useState('')
  const [msg, setMsg] = useState('')

  function load() {
    api(`/api/agents/${agent.name}/config`).then((d) => {
      if (d.config) { setConfig(d.config); setProvider((p) => p || Object.keys(d.config.models?.providers || {})[0] || '') }
    }).catch(() => {})
  }
  useEffect(load, [agent.name])

  const providers = Object.keys(config?.models?.providers || {})
  const primary = config?.agents?.defaults?.model?.primary || ''
  const fallback = config?.agents?.defaults?.model?.fallback || ''

  function askKey(actionLabel, cmdTemplate) {
    const value = window.prompt(`${actionLabel} — paste the value:`)
    if (!value) return
    run(cmdTemplate(provider), { secret: value })
  }

  const pills = [
    { label: 'API key', desc: 'Paste an API key for the selected provider', click: () => askKey('API key', (p) => `openclaw models auth paste-api-key --provider ${p}`) },
    { label: 'Token', desc: 'Paste a token for the selected provider', click: () => askKey('Token', (p) => `openclaw models auth paste-token --provider ${p}`) },
    { label: 'OAuth', desc: 'Interactive OAuth/device login', cmd: (p) => `openclaw models auth login --provider ${p} --device-code` },
    { label: 'Logout', desc: 'Log out the selected provider profile', click: () => {
      const prof = window.prompt('Profile ID to log out (see Auth list):')
      if (!prof) return
      run(`openclaw models auth logout ${prof} --yes`, { confirm: true })
    } },
    { label: 'Auth list', desc: 'Configured auth profiles', cmd: () => 'openclaw models auth list' },
    { label: 'Model list', desc: 'All catalog models', cmd: () => 'openclaw models list --all' },
    { label: 'Status', desc: 'Auth + model status', cmd: () => 'openclaw models status' },
    { label: 'Set default', desc: 'Set primary model by id', click: () => {
      const m = window.prompt('Model id (provider/model), e.g. openai/gpt-5.6-sol:')
      if (!m) return
      run(`openclaw models set ${m}`)
    } },
  ]
  const visible = pills.filter((x) => matches(query, x.label))
  if (query && visible.length === 0 && !primary && !fallback) return null

  return (
    <GroupCard title="Models" color="blue">
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {providers.length > 0 ? (
          <select value={provider} onChange={(e) => setProvider(e.target.value)}
                  className="px-1.5 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-cyan-500 focus:outline-none">
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        ) : (
          <input type="text" value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="provider (e.g. openai)"
                 className="px-1.5 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white w-36 focus:border-cyan-500 focus:outline-none placeholder-slate-600" />
        )}
        {!provider && <span className="text-[10px] text-slate-600">no provider configured</span>}
        {visible.map((x) => (
          <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.blue.pill}
                disabled={!!runningCmd} active={runningCmd === (typeof x.cmd === 'function' ? x.cmd(provider) : x.cmd)}
                onClick={() => (x.click ? x.click() : run(x.cmd(provider)))}
          />
        ))}
      </div>
      {(primary || fallback) && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {primary && (
            <span className="px-2 py-1 rounded border border-cyan-800/40 text-cyan-300 bg-cyan-950/20 font-mono">
              ★ {primary}
            </span>
          )}
          {fallback && (
            <span className="px-2 py-1 rounded border border-amber-800/40 text-amber-300 bg-amber-950/20 font-mono">
              ⤵ {fallback}
            </span>
          )}
        </div>
      )}
    </GroupCard>
  )
}

// ─── MCP card ────────────────────────────────────────────────────

function McpCard({ agent, query, runningCmd, run }) {
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
  if (query && visible.length === 0 && servers.length === 0) return null

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
    <GroupCard title="MCP" color="emerald">
      {msg && <div className="mb-2 text-[11px] text-cyan-400">{msg}</div>}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {visible.map((x) => (
          <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.emerald.pill}
                disabled={!!runningCmd} active={runningCmd === x.cmd} onClick={() => run(x.cmd)} />
        ))}
      </div>
      {servers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {servers.map((s) => (
            <div key={s.name} className="flex items-center gap-2 text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.ok === true ? 'bg-emerald-400' : s.ok === false ? 'bg-red-400' : 'bg-cyan-400'}`} />
              <span className="text-slate-200 font-medium">{s.name}</span>
              <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]">{s.transport}</span>
              <span className="text-slate-500 truncate font-mono flex-1 min-w-0">{s.command || s.url || ''}</span>
              <button onClick={() => removeServer(s.name)} disabled={removing === s.name}
                      className="px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:text-red-300 hover:bg-slate-800 transition-colors disabled:opacity-40">
                {removing === s.name ? '...' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
    </GroupCard>
  )
}

// ─── Skills card ─────────────────────────────────────────────────

function sourceLabel(source) {
  if (source === 'openclaw-bundled' || source === 'openclaw-extra') return { label: 'Bundled', color: 'bg-slate-600' }
  if (source === 'clawhub') return { label: 'Global', color: 'bg-cyan-700' }
  return { label: source || 'User', color: 'bg-emerald-700' }
}

function SkillsCard({ agent, query, runningCmd, run }) {
  const [skills, setSkills] = useState([])
  const [msg, setMsg] = useState('')
  const [showInstall, setShowInstall] = useState(false)
  const [installRef, setInstallRef] = useState('')
  const [installing, setInstalling] = useState(false)

  function load() {
    api(`/api/agents/${agent.name}/skills`).then((d) => setSkills(d.skills || [])).catch(() => {})
  }
  useEffect(load, [agent.name])

  const pills = [
    { label: 'Search', desc: 'Search the skill catalog', click: () => {
      const q = window.prompt('Search query:')
      if (!q) return
      run(`openclaw skills search ${q}`)
    } },
    { cmd: 'openclaw skills update --all', label: 'Update all', desc: 'Update every installed skill', confirm: true },
    { label: 'Install', desc: 'Open the install box', click: () => setShowInstall(!showInstall) },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  if (query && visible.length === 0 && skills.length === 0) return null

  async function doInstall(e) {
    e.preventDefault()
    if (!installRef || installing) return
    setInstalling(true)
    try {
      await api(`/api/agents/${agent.name}/skills/install`, { method: 'POST', body: { ref: installRef, source: 'clawhub', as: '', force: false } })
      setInstallRef(''); setShowInstall(false); load()
    } catch (err) { setMsg('Failed: ' + (err.error || err.message)) }
    setInstalling(false)
  }

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
      setMsg(`Verify ${slug}: ${r.verified ? 'verified' : 'not verified'}`)
    } catch (e) { setMsg('Failed: ' + (e.error || e.message)) }
  }

  return (
    <GroupCard title="Skills" color="violet">
      {msg && <div className="mb-2 text-[11px] text-cyan-400">{msg}</div>}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {visible.map((x) => (
          <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.violet.pill}
                disabled={!!runningCmd} active={runningCmd === x.cmd}
                onClick={() => (x.click ? x.click() : run(x.cmd, x))} />
        ))}
      </div>
      {showInstall && (
        <form onSubmit={doInstall} className="flex items-center gap-2 mb-3">
          <input type="text" value={installRef} onChange={(e) => setInstallRef(e.target.value)}
                 placeholder="@owner/slug or owner/repo@ref"
                 className="flex-1 px-2 py-1 rounded text-[11px] bg-slate-950 border border-slate-700 text-white focus:border-cyan-500 focus:outline-none placeholder-slate-600" />
          <button type="submit" disabled={installing}
                  className="px-2.5 py-1 rounded text-[11px] bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-700 text-white transition-colors">
            {installing ? '...' : 'Install'}
          </button>
        </form>
      )}
      {skills.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {skills.slice(0, 12).map((s) => {
            const sl = sourceLabel(s.source)
            return (
              <div key={s.name} className="flex items-center gap-2 text-[11px]">
                <span className="text-slate-200 font-medium">{s.name}</span>
                {s.version && <span className="text-[10px] text-slate-500 font-mono">{s.version}</span>}
                <span className={`px-1.5 py-0.5 rounded text-[10px] text-white ${sl.color}`}>{sl.label}</span>
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.eligible ? 'bg-emerald-400' : 'bg-slate-600'}`} />
                <span className="text-slate-500 truncate flex-1 min-w-0">{s.description}</span>
                {s.source === 'clawhub' && (
                  <button onClick={() => verifySkill(s.name)} className="px-1.5 py-0.5 rounded text-[10px] text-amber-400 hover:bg-slate-800 transition-colors">Verify</button>
                )}
                {s.bundled !== true && (
                  <>
                    <button onClick={() => updateSkill(s.name)} className="px-1.5 py-0.5 rounded text-[10px] text-emerald-400 hover:bg-slate-800 transition-colors">Update</button>
                    <button onClick={() => removeSkill(s.name)} className="px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:bg-slate-800 transition-colors">×</button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </GroupCard>
  )
}

// ─── Backups card ────────────────────────────────────────────────

function BackupsCard({ agent, query, runningCmd, run }) {
  const [backups, setBackups] = useState([])
  const [msg, setMsg] = useState('')

  function load() {
    api(`/api/agents/${agent.name}/backups`).then((d) => setBackups(d.backups || [])).catch(() => {})
  }
  useEffect(load, [agent.name])

  const pills = [
    { cmd: 'openclaw backup create', label: 'Create', desc: 'Full backup archive', confirm: true },
    { cmd: 'openclaw backup create --no-include-workspace', label: 'No workspace', desc: 'Skip workspace files', confirm: true },
    { cmd: 'openclaw backup create --only-config', label: 'Config only', desc: 'Just openclaw.json', confirm: true },
  ]
  const visible = pills.filter((x) => matches(query, x.label, x.cmd))
  if (query && visible.length === 0 && backups.length === 0) return null

  async function deleteBak(file) {
    if (!confirm('Delete backup?')) return
    await api(`/api/agents/_/backups/delete`, { method: 'POST', body: { file } })
    load()
  }

  return (
    <GroupCard title="Backups" color="amber">
      {msg && <div className="mb-2 text-[11px] text-cyan-400">{msg}</div>}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {visible.map((x) => (
          <Pill key={x.label} label={x.label} desc={x.desc} color={COLORS.amber.pill}
                disabled={!!runningCmd} active={runningCmd === x.cmd} onClick={() => run(x.cmd, x)} />
        ))}
      </div>
      {backups.length > 0 && (
        <div className="flex flex-col gap-1">
          {backups.slice(0, 10).map((b) => (
            <div key={b.name} className="flex items-center gap-2 text-[11px]">
              <span className="text-slate-300 font-mono truncate flex-1 min-w-0">{b.name}</span>
              {b.size_hr && <span className="text-slate-500">{b.size_hr}</span>}
              <button onClick={() => deleteBak(b.name)} className="px-1.5 py-0.5 rounded text-[10px] text-red-400 hover:bg-slate-800 transition-colors">Delete</button>
            </div>
          ))}
        </div>
      )}
    </GroupCard>
  )
}

// ─── Main CommandsPane ───────────────────────────────────────────

export default function CommandsPane({ agent, termRef, run, runningCmd, refreshKey }) {
  const [query, setQuery] = useState('')
  const [activity, setActivity] = useState([])

  function reloadAll() {
    api(`/api/agents/${agent.name}/activity?limit=6`).then((d) => setActivity(d.activity || [])).catch(() => {})
  }
  useEffect(reloadAll, [agent.name])
  useEffect(() => { if (refreshKey > 0) reloadAll() }, [refreshKey])

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

      {/* Recent activity */}
      {activity.length > 0 && (
        <div className="border border-slate-800 rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Recent activity</h3>
          </div>
          <div className="flex flex-col gap-1.5">
            {activity.slice(0, 6).map((e, i) => (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${e.status === 'ok' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                <span className="text-slate-300">{e.action}</span>
                {e.details && <span className="text-slate-500 font-mono truncate flex-1 min-w-0">{e.details}</span>}
                <span className="text-slate-600 flex-shrink-0">{e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Command groups */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {SIMPLE_GROUPS.map((g) => (
          <SimpleGroupCard key={g.title} group={g} query={query} runningCmd={runningCmd} run={run} />
        ))}
        <MessagingCard agent={agent} query={query} runningCmd={runningCmd} run={run} termRef={termRef} />
        <ModelsCard agent={agent} query={query} runningCmd={runningCmd} run={run} />
        <McpCard agent={agent} query={query} runningCmd={runningCmd} run={run} />
        <SkillsCard agent={agent} query={query} runningCmd={runningCmd} run={run} />
        <BackupsCard agent={agent} query={query} runningCmd={runningCmd} run={run} />
      </div>
    </div>
  )
}
