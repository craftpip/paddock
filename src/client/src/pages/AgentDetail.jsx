import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useEffect, useState, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useAgents } from '../stores/agents'
import { api } from '../lib/api'
import { statusMeta } from '../lib/status'
import { webUrlForAgent } from '../lib/web'
import { useConfirm } from '../lib/confirm'
import { useAlert } from '../lib/alert'
import Terminal from '../components/Terminal'
import CommandsPane from './agent/CommandsPane'
import SettingsTab from './agent/SettingsTab'
import WebTab from './agent/WebTab'
import Button from '../components/ui/Button'
import Badge from '../components/ui/Badge'
import { cx } from '../lib/cx'
import WorkspaceTab from './agent/WorkspaceTab'
import LogsTab from './agent/LogsTab'
import ActivityTab from './agent/ActivityTab'
import ConfigTab from './agent/ConfigTab'

const MODES = [
  { id: 'commands', label: 'Commands' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'config', label: 'Config' },
  { id: 'web', label: 'Web & Ports' },
  { id: 'logs', label: 'Logs' },
  { id: 'activity', label: 'Activity' },
  { id: 'settings', label: 'Settings' },
]

function AgentHeader({ agent }) {
  const startAgent = useAgents((s) => s.startAgent)
  const stopAgent = useAgents((s) => s.stopAgent)
  const restartAgent = useAgents((s) => s.restartAgent)
  const confirm = useConfirm()
  const alert = useAlert()
  const [stats, setStats] = useState(null)
  const intervalRef = useRef(null)
  const [orch, setOrch] = useState(null) // null = not yet loaded
  const [orchBusy, setOrchBusy] = useState(false)

  const loadOrch = useCallback(async () => {
    try { setOrch(await api(`/api/agents/${agent.name}/orchestrator`)) } catch { setOrch(null) }
  }, [agent.name])

  useEffect(() => { loadOrch() }, [loadOrch])

  async function makeOrchestrator() {
    setOrchBusy(true)
    try {
      await api(`/api/agents/${agent.name}/orchestrator`, { method: 'POST' })
      await loadOrch()
    } catch (err) {
      alert({ title: 'Failed to confer orchestrator', message: err?.error || 'Failed to confer', danger: true })
    }
    setOrchBusy(false)
  }

  async function removeOrchestrator() {
    const ok = await confirm({
      title: 'Remove orchestrator',
      message: `${agent.name} becomes an ordinary agent. Its orchestrator key is revoked and the paddock MCP server is un-wired.`,
      danger: true,
      confirmText: 'Remove',
    })
    if (!ok) return
    setOrchBusy(true)
    try {
      await api(`/api/agents/${agent.name}/orchestrator`, { method: 'DELETE' })
      await loadOrch()
    } catch (err) {
      alert({ title: 'Failed to remove orchestrator', message: err?.error || 'Failed to remove', danger: true })
    }
    setOrchBusy(false)
  }

  useEffect(() => {
    if (agent.status !== 'running') { setStats(null); return }
    async function load() {
      try { const d = await api(`/api/agents/${agent.name}/stats`); if (d.stats) setStats(d.stats) } catch {}
    }
    load()
    intervalRef.current = setInterval(load, 3000)
    return () => clearInterval(intervalRef.current)
  }, [agent.name, agent.status])

  const st = statusMeta(agent.status)
  const isTransition = ['starting', 'stopping', 'restarting'].includes(agent.status)
  const cpuPct = stats ? parseFloat(stats.CPUPerc) || 0 : 0
  const memUsage = stats?.MemUsage ? stats.MemUsage.split('/')[0].trim() : ''

  return (
    <div className="flex items-center gap-4 px-6 py-3 border-b border-line-faint bg-canvas/40 flex-wrap">
      <Link to="/agents" className="text-xs text-ink-dim hover:text-ink-muted transition-colors">&larr; Fleet</Link>
      <div className="w-9 h-9 rounded-card bg-panel flex items-center justify-center text-lg font-bold text-accent-text flex-shrink-0">
        {agent.display_name?.charAt(0) || '?'}
      </div>
      <div className="min-w-0">
        <h1 className="text-sm font-bold text-ink truncate leading-tight">{agent.display_name || agent.name}</h1>
        <p className="text-xs text-ink-dim truncate leading-tight font-mono">{agent.name}</p>
      </div>
      {/* Left alone: this pill's colours come from STATUS_META.pill in
          lib/status.js, which has no Badge `tone` field. Mapping status→tone
          here would be a second source of truth for the same colours. */}
      <span className={`px-2 py-0.5 rounded-pill text-xs font-medium flex items-center gap-1.5 ${st.pill}`}>
        {isTransition ? (
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${st.dot} animate-pulse`} />
            {st.label}
          </span>
        ) : (
          <>
            <span className={`w-2 h-2 rounded-full ${st.dot}`} />
            {st.label}
          </>
        )}
      </span>
      <span className="w-px h-5 bg-raised" />
      <div className="flex items-center gap-3 text-xs">
        <span className="text-ink-dim">CPU <span className="text-ink font-mono ml-1">{agent.status === 'running' ? (cpuPct.toFixed(1) + '%') : '—'}</span></span>
        <span className="text-ink-dim">MEM <span className="text-ink font-mono ml-1">{agent.status === 'running' && stats ? memUsage : '—'}</span></span>
      </div>
      <div className="flex-1" />
      {/* Orchestrator conferral (plan 52 Phase D). One click makes this ordinary
          pad an orchestrator; a conferred pad shows the badge + Remove. */}
      <div className="flex items-center gap-2" title={orch?.conferred ? 'This pad can manage your fleet' : 'Confer the orchestrator role'}>
        {!orch ? null : orch.conferred ? (
          <>
            <Badge tone="brand">Orchestrator</Badge>
            <Button variant="ghost" size="md" onClick={removeOrchestrator} disabled={orchBusy}>
              Remove
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="md" onClick={makeOrchestrator} disabled={orchBusy}>
            {orchBusy ? 'Conferring…' : 'Make orchestrator'}
          </Button>
        )}
      </div>
      {/* Stop is a solid warning fill and Start a solid success fill. Neither is
          a Button variant, so both ride on `primary` with the tone overridden —
          and the disabled look comes from the primitive, not per-button. */}
      <div className="flex items-center gap-2">
        {agent.status === 'running' ? (
          <>
            <Button
              variant="primary"
              size="md"
              onClick={() => stopAgent(agent.name)}
              className="bg-warning text-warning-ink hover:bg-warning"
            >
              Stop
            </Button>
            <Button variant="primary" size="md" onClick={() => restartAgent(agent.name)}>
              Restart
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={() => startAgent(agent.name)}
            className="bg-success text-success-ink hover:bg-success"
          >
            Start
          </Button>
        )}
      </div>
    </div>
  )
}

export default function AgentDetail() {
  useDocumentTitle(useParams().agentId)
  const loadError = useAgents((s) => s.loadError)
  const { agentId, tab } = useParams()
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
  const currentMode = tab || 'commands'
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
        <div className="flex items-center justify-center h-64 text-ink-dim">
          <span className="inline-block w-4 h-4 rounded-full border-2 border-accent-line border-t-transparent animate-spin mr-3" />
          <p>Loading agent…</p>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center justify-center h-64 text-ink-dim gap-4">
        <p>{loadError ? `Could not load this agent: ${loadError}` : 'Agent not found — it may have been deleted.'}</p>
        <Link to="/agents" className="px-4 py-2 bg-accent hover:bg-accent-hover text-accent-ink rounded-control text-sm font-medium transition-colors">
          ← Back to fleet
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0" id="agent-layout">
      <AgentHeader agent={agent} />

      {/* Mode tabs */}
      <div className="flex items-center gap-1 px-6 py-2 border-b border-line-faint overflow-x-auto flex-shrink-0">
        {MODES.map((m) => {
          const webUrl = m.id === 'web' ? webUrlForAgent(agent) : ''
          return (
            <Button
              key={m.id}
              variant="ghost"
              size="md"
              onClick={() => { if (m.id !== mode) navigate(`/agents/${agent.name}/${m.id}`) }}
              className={cx(
                mode === m.id ? 'bg-panel' : 'hover:bg-panel/50',
                m.id === 'commands'
                  ? 'text-warning'
                  : mode === m.id ? 'text-accent-text' : 'text-ink-faint hover:text-ink'
              )}
            >
              {m.id === 'commands' ? (agent.agent_type ? agent.agent_type.charAt(0).toUpperCase() + agent.agent_type.slice(1) : 'Commands') : m.label}
              {webUrl && (
                /* Still a bare <button>, and still nested inside the tab button —
                   invalid HTML that predates this migration. A Button here would
                   add ctl-sm's 28px min-height inside a 36px tab and break the
                   inline layout, and `icon` would force 28px via inline style.
                   Only the radius token is folded; focus gets the one focus-ring. */
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    window.open(webUrl, '_blank', 'noopener,noreferrer')
                  }}
                  title={`Open ${agent.web.label || 'web app'} at ${webUrl}`}
                  aria-label={`Open ${agent.web.label || 'web app'} in a new tab`}
                  className={cx(
                    'p-0.5 rounded-control focus-ring transition-colors',
                    mode === 'web' ? 'text-accent-text hover:bg-raised' : 'hover:bg-raised'
                  )}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5M19 5l-8 8M9 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
                  </svg>
                </button>
              )}
            </Button>
          )
        })}
      </div>

      {/* Mode content */}
      <div
        className={`min-h-0 overflow-y-auto px-6 pt-6 pb-3 ${
          termCollapsed || mode !== 'commands' ? 'flex-1' : 'shrink-0 max-h-[45vh]'
        }`}
        id="mode-content"
      >
        {mode === 'commands' && (
          <CommandsPane agent={agent} termRef={termRef} run={run} connected={termConnected} />
        )}
        {mode === 'workspace' && <WorkspaceTab agent={agent} />}
        {mode === 'config' && <ConfigTab agent={agent} />}
        {mode === 'web' &&           <WebTab agent={agent} run={run} connected={termConnected} expandTerminal={() => setTermCollapsed(false)} />}
        {mode === 'logs' && <LogsTab agent={agent} />}
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
            <div className="h-1 w-32 rounded-full bg-raised group-hover:bg-accent-hover transition-colors" />
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

// ─── Logs ────────────────────────────────────────────────────

// ─── Sessions ────────────────────────────────────────────────

// ─── Activity ────────────────────────────────────────────────

// ─── Config ──────────────────────────────────────────────────

