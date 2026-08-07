import { create } from 'zustand'
import { api } from '../lib/api'

// How long a transition status (starting/stopping/restarting) is held against
// polls before the real status wins again. Matches the backend's stop timeout
// (docker stop -t 30 + margin) so the UI keeps waiting while the container is
// still stopping.
const TRANSITION_TTL = 60000

function activeTransition(transitions, name) {
  const t = transitions[name]
  if (!t) return null
  if (Date.now() - t.at > TRANSITION_TTL) return null
  return t
}

// A poll must never flip a card back to "running" mid-stop. While a transition
// is active for an agent, keep its transition status.
function mergeTransitions(agents, transitions) {
  return agents.map((a) => {
    const t = activeTransition(transitions, a.name)
    return t ? { ...a, status: t.status } : a
  })
}

export const useAgents = create((set, get) => ({
  agents: [],
  stats: { total: 0, running: 0, stopped: 0, unknown: 0 },
  loading: true,
  pollTimers: {},
  transitions: {},

  fetchAgents: async () => {
    try {
      const data = await api('/api/agents')
      const agents = mergeTransitions(data.agents, get().transitions)
      set({ agents, stats: calcStats(agents), loading: false })
    } catch {
      set({ loading: false })
    }
  },

  getAgent: (name) => {
    return get().agents.find((a) => a.name === name) || null
  },

  updateAgentStatus: (name, status) => {
    const agents = get().agents.map((a) =>
      a.name === name ? { ...a, status } : a
    )
    const stats = calcStats(agents)
    set({ agents, stats })
  },

  markTransition: (name, status) => {
    set((s) => ({ transitions: { ...s.transitions, [name]: { status, at: Date.now() } } }))
    get().updateAgentStatus(name, status)
  },

  clearTransition: (name) => {
    set((s) => {
      const next = { ...s.transitions }
      delete next[name]
      return { transitions: next }
    })
  },

  syncAgent: (agent) => {
    if (!agent) return
    const t = activeTransition(get().transitions, agent.name)
    const merged = t ? { ...agent, status: t.status } : agent
    const agents = get().agents.map((a) =>
      a.name === merged.name ? { ...a, ...merged } : a
    )
    set({ agents, stats: calcStats(agents) })
  },

  startAgent: async (name) => {
    get().markTransition(name, 'starting')
    try {
      const d = await api(`/api/agents/${name}/start`, { method: 'POST' })
      get().clearTransition(name)
      get().updateAgentStatus(name, d.status || 'running')
    } catch {
      get().clearTransition(name)
      get().fetchAgents()
    }
  },

  stopAgent: async (name) => {
    get().markTransition(name, 'stopping')
    try {
      const d = await api(`/api/agents/${name}/stop`, { method: 'POST' })
      get().clearTransition(name)
      get().updateAgentStatus(name, d.status || 'exited')
    } catch {
      get().clearTransition(name)
      get().fetchAgents()
    }
  },

  restartAgent: async (name) => {
    get().markTransition(name, 'restarting')
    try {
      const d = await api(`/api/agents/${name}/restart`, { method: 'POST' })
      get().clearTransition(name)
      get().updateAgentStatus(name, d.status || 'running')
    } catch {
      get().clearTransition(name)
      get().fetchAgents()
    }
  },
}))

function calcStats(agents) {
  const running = agents.filter((a) => a.status === 'running').length
  const stopped = agents.filter((a) => a.status === 'exited').length
  return { total: agents.length, running, stopped, unknown: agents.length - running - stopped }
}
