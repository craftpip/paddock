import { useEffect, useState, useCallback, useRef } from 'react'
import { useAgents } from '../stores/agents'
import AgentCard from '../components/AgentCard'
import { api } from '../lib/api'

export default function Dashboard() {
  const agents = useAgents((s) => s.agents)
  const stats = useAgents((s) => s.stats)
  const loading = useAgents((s) => s.loading)
  const fetchAgents = useAgents((s) => s.fetchAgents)
  const [query, setQuery] = useState('')
  const [fleetStats, setFleetStats] = useState([])
  const [fleetLoading, setFleetLoading] = useState(true)
  const fleetIntervalRef = useRef(null)

  useEffect(() => {
    fetchAgents()
  }, [fetchAgents])

  useEffect(() => {
    async function load() {
      try { const d = await api('/api/agents/stats/fleet'); if (d.stats) setFleetStats(d.stats) } catch {}
      setFleetLoading(false)
    }
    load()
    // Refetch the fleet too so transient statuses (e.g. a settings change that
    // stopped/restarted an agent) self-correct instead of sticking as "Stopped".
    fetchAgents()
    fleetIntervalRef.current = setInterval(() => {
      load()
      fetchAgents()
    }, 5000)
    return () => clearInterval(fleetIntervalRef.current)
  }, [fetchAgents])

  const avgCpu = fleetStats.length ? (fleetStats.reduce((s, c) => s + (parseFloat(c.CPUPerc) || 0), 0) / fleetStats.length).toFixed(1) : '0'

  // Parse a docker MemUsage string like "1.012GiB / 15.5GiB" into bytes.
  function parseMemUsage(s) {
    const toBytes = (p) => {
      const m = /([\d.]+)\s*([KMGTP]?i?B)/i.exec(p)
      if (!m) return null
      const units = { B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 }
      return parseFloat(m[1]) * (units[m[2].toUpperCase()] || 1)
    }
    const parts = String(s || '').split('/').map((p) => p.trim()).filter(Boolean)
    const used = toBytes(parts[0])
    const total = toBytes(parts[1])
    if (used == null && total == null) return null
    return { used: used || 0, total: total || 0 }
  }

  function fmtBytes(b) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
    let i = 0
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++ }
    return `${b.toFixed(2)}${units[i]}`
  }

  const mem = fleetStats.reduce(
    (acc, c) => {
      const m = parseMemUsage(c.MemUsage)
      if (m) { acc.used += m.used; acc.total += m.total }
      return acc
    },
    { used: 0, total: 0 }
  )
  const memText = mem.used ? fmtBytes(mem.used) : '0'

  const filtered = query
    ? agents.filter(
        (a) =>
          (a.display_name || '').toLowerCase().includes(query.toLowerCase()) ||
          a.name.toLowerCase().includes(query.toLowerCase())
      )
    : agents

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
        <div className="skeleton h-8 w-48 mb-8 rounded-lg" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="skeleton h-48 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <div id="agents-header" className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-ink">Agent Fleet</h1>
          <p className="text-ink-faint text-sm mt-1">
            {stats.total} agents &middot; {stats.running} running &middot; {stats.stopped} stopped
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            id="global-search"
            placeholder="Search agents..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="px-3 py-2 bg-sunken border border-line rounded-lg text-sm text-ink w-48 focus:border-accent-line focus:outline-none focus:ring-1 focus:ring-accent-line"
          />
          <a
            href="/agents/create"
            className="px-4 py-2 bg-accent hover:bg-accent-hover text-accent-ink rounded-lg text-sm font-medium transition-colors whitespace-nowrap"
          >
            + New Agent
          </a>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 mb-6 px-4 py-3 border border-line-faint rounded-xl bg-canvas/50">
        <span className="text-xs text-ink-dim font-medium">Fleet Resources</span>
        <span className="w-px h-4 bg-raised" />
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-accent" />
          <span className="text-xs text-ink-faint">CPU avg</span>
          {fleetLoading
            ? <span className="skeleton h-5 w-10 rounded" />
            : <span className="text-sm font-mono text-ink">{avgCpu}%</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-success" />
          <span className="text-xs text-ink-faint">Mem</span>
          {fleetLoading
            ? <span className="skeleton h-5 w-24 rounded" />
            : <span className="text-sm font-mono text-ink">{memText}</span>}
        </span>
        <span className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-warning" />
          <span className="text-xs text-ink-faint">Containers</span>
          {fleetLoading
            ? <span className="skeleton h-5 w-10 rounded" />
            : <span className="text-sm font-mono text-ink">{fleetStats.length}</span>}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.map((agent) => (
          <AgentCard key={agent.name} agent={agent} />
        ))}
      </div>

      {agents.length === 0 && (
        <div className="text-center py-20 text-ink-dim">
          <svg className="w-12 h-12 mx-auto mb-4 text-ink-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <p className="text-lg mb-2">No agents yet</p>
          <p className="text-sm mb-4">Create your first agent to get started.</p>
          <a
            href="/agents/create"
            className="inline-block px-4 py-2 bg-accent hover:bg-accent-hover text-accent-ink rounded-lg text-sm transition-colors"
          >
            + New Agent
          </a>
        </div>
      )}

      {agents.length > 0 && filtered.length === 0 && (
        <div className="text-center py-20 text-ink-dim">
          <p className="text-lg mb-2">No matching agents</p>
          <p className="text-sm">Try a different search term.</p>
        </div>
      )}
    </div>
  )
}
