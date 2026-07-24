import { create } from 'zustand'
import { api } from '../lib/api'

export const useAgents = create((set, get) => ({
  agents: [],
  stats: { total: 0, running: 0, stopped: 0, unknown: 0 },
  loading: true,
  pollTimers: {},

  fetchAgents: async () => {
    try {
      const data = await api('/api/agents')
      set({ agents: data.agents, stats: data.stats, loading: false })
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

  startAgent: async (name) => {
    get().updateAgentStatus(name, 'starting')
    try {
      await api(`/api/agents/${name}/start`, { method: 'POST' })
      get().updateAgentStatus(name, 'running')
    } catch {
      get().fetchAgents()
    }
  },

  stopAgent: async (name) => {
    get().updateAgentStatus(name, 'stopping')
    try {
      await api(`/api/agents/${name}/stop`, { method: 'POST' })
      get().updateAgentStatus(name, 'exited')
    } catch {
      get().fetchAgents()
    }
  },

  restartAgent: async (name) => {
    get().updateAgentStatus(name, 'restarting')
    try {
      await api(`/api/agents/${name}/restart`, { method: 'POST' })
      get().updateAgentStatus(name, 'running')
    } catch {
      get().fetchAgents()
    }
  },
}))

function calcStats(agents) {
  const running = agents.filter((a) => a.status === 'running').length
  const stopped = agents.filter((a) => a.status === 'exited').length
  return { total: agents.length, running, stopped, unknown: agents.length - running - stopped }
}
