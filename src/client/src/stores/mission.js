import { create } from 'zustand'
import { api } from '../lib/api'

// Mission (plan 53) — projects are (agent, folder) pairs; a session is the only
// unit of work. This store owns col 1 (the projects) and the folder probe the
// create/edit dialog needs. Sessions arrive in Phase 4.
//
// The backend is the authority on every rule here (coding-models only, running
// PADs only, absolute container paths). The store's job is to call it and hold
// what came back — including the `code`, so the dialog can explain a refusal
// instead of showing a bare string.

function errText(e, fallback = 'Something went wrong') {
  return e?.message || e?.error || fallback
}

export const useMission = create((set, get) => ({
  projects: [],
  loading: true,
  error: '',
  selectedProjectId: '',
  // Folder probe for the dialog: { agent, path, exists, isDir, entries, checking, error }
  folder: null,

  fetchProjects: async () => {
    try {
      const data = await api('/api/mission/projects')
      const projects = data.projects || []
      set((s) => ({
        projects,
        loading: false,
        error: '',
        // Keep the selection if it survived the refresh, else fall back to the
        // first project — an empty col 2 is a dead end.
        selectedProjectId: projects.some((p) => p.id === s.selectedProjectId)
          ? s.selectedProjectId
          : projects[0]?.id || '',
      }))
    } catch (e) {
      set({ loading: false, error: errText(e, 'Could not load projects') })
    }
  },

  select: (projectId) => set({ selectedProjectId: projectId }),

  createProject: async (payload) => {
    const data = await api('/api/mission/projects', { method: 'POST', body: payload })
    await get().fetchProjects()
    if (data?.project?.id) set({ selectedProjectId: data.project.id })
    return data.project
  },

  updateProject: async (id, payload) => {
    const data = await api(`/api/mission/projects/${id}`, { method: 'PATCH', body: payload })
    await get().fetchProjects()
    return data.project
  },

  deleteProject: async (id) => {
    await api(`/api/mission/projects/${id}`, { method: 'DELETE' })
    await get().fetchProjects()
  },

  /** Probe a container folder inside the PAD. Never throws: a missing folder is
   *  a normal state while typing, and the sibling entries are the useful part. */
  probeFolder: async (agent, path) => {
    if (!agent || !path) {
      set({ folder: null })
      return null
    }
    // `req` is the raw input and is what the guard compares — the backend
    // normalizes (a trailing slash goes away), so comparing the response's
    // normalized path against a raw request would drop valid answers.
    set({ folder: { agent, req: path, path, checking: true, exists: false, isDir: false, entries: [], error: '' } })
    try {
      const data = await api(`/api/agents/${agent}/mission-folders?path=${encodeURIComponent(path)}`)
      set((s) => (s.folder?.req === path
        ? { folder: { ...s.folder, ...data, path: data.path || path, checking: false, error: '' } }
        : s))
      return data
    } catch (e) {
      set((s) => (s.folder?.req === path
        ? { folder: { ...s.folder, checking: false, exists: false, isDir: false, entries: [], error: errText(e) } }
        : s))
      return null
    }
  },

  clearFolder: () => set({ folder: null }),
}))
