import { api } from '../../lib/api'
import { errText } from './shared'

/** Project actions of the Mission store: create, update, delete, and the folder probe the project dialog uses. */
export function projectActions(set, get) {
  return {
  createProject: async (payload) => {
    const data = await api('/api/mission/projects', { method: 'POST', body: payload })
    await get().fetchProjects()
    if (data?.project?.id) {
      // Selecting the new project makes it the col-1 selection — and since the
      // selection IS the scope (plan 68), that also makes col 2 show it and
      // gives `+ New session` a target. A new project is immediately usable
      // without re-navigating.
      set({ selectedProjectId: data.project.id, selectedConversationId: '', sessions: [], history: null, loadedFor: '' })
      get().fetchSessions(data.project.id)
      get().fetchHistory(data.project.id, get().includeSubfolders)
      get().navigateView?.({ project: data.project.id }, { replace: true })
    }
    return data.project
  },

  updateProject: async (id, payload) => {
    const before = get().projects.find((p) => p.id === id)
    const data = await api(`/api/mission/projects/${id}`, { method: 'PATCH', body: payload })
    // A new folder is a new scope: the history we loaded belongs to the old
    // one, so drop the cache key and re-read instead of leaving stale rows up.
    const folderChanged = before && data?.project && before.folder !== data.project.folder
    await get().fetchProjects()
    if (folderChanged) {
      set({ history: null, loadedFor: '' })
      if (!get().selectedProjectId) get().fetchAll()
      else if (get().selectedProjectId === id) {
        get().fetchSessions(id)
        get().fetchHistory(id, get().includeSubfolders)
      }
    }
    return data.project
  },

  deleteProject: async (id) => {
    await api(`/api/mission/projects/${id}`, { method: 'DELETE' })
    // The highlight clears, and with it the row — but `openSession` does NOT.
    // Deleting a project kills the sessions running on it, so col 3 is about to
    // find out from its own pane poll that nothing is running there and say so
    // in its own words, with a Reopen button. Snapping the terminal to a
    // neighbour instead would throw away the conversation the user was looking
    // at, at the exact moment they are told it is gone.
    set({ selectedConversationId: '', sessions: [], history: null, loadedFor: '' })
    await get().fetchProjects()
    // The aggregate list held rows from the project that is now gone; the
    // project list re-read above already reset the selection to whatever
    // exists (possibly `''`), so re-read the visible list too or col 2 would
    // keep showing a project that is not there.
    if (!get().selectedProjectId) get().fetchAll()
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
    // normalized path against a raw request would drop valid answers. The agent
    // is part of the key: the same path probed for a different PAD is a
    // different question, and the late answer must not overwrite the new one.
    set({ folder: { agent, req: path, path, checking: true, exists: false, isDir: false, entries: [], error: '' } })
    try {
      const data = await api(`/api/agents/${agent}/mission-folders?path=${encodeURIComponent(path)}`)
      set((s) => (s.folder?.agent === agent && s.folder?.req === path
        ? { folder: { ...s.folder, ...data, path: data.path || path, checking: false, error: '' } }
        : s))
      return data
    } catch (e) {
      set((s) => (s.folder?.agent === agent && s.folder?.req === path
        ? { folder: { ...s.folder, checking: false, exists: false, isDir: false, entries: [], error: errText(e) } }
        : s))
      return null
    }
  },
  }
}
