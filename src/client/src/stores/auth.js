import { create } from 'zustand'
import { api, setCsrfToken } from '../lib/api'

export const useAuth = create((set) => ({
  authenticated: false,
  username: null,
  role: null,
  userId: null,
  loading: true,
  error: null,

  checkSession: async () => {
    try {
      const data = await api('/api/session')
      setCsrfToken(data.csrfToken)
      set({
        authenticated: data.authenticated,
        username: data.username || null,
        role: data.role || null,
        userId: data.userId || null,
        loading: false,
        error: null,
      })
    } catch {
      set({ authenticated: false, username: null, role: null, userId: null, loading: false, error: null })
    }
  },

  login: async (username, password) => {
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: { username, password },
      })
      if (data.csrfToken) setCsrfToken(data.csrfToken)
      set({ authenticated: true, username: data.username || username, role: data.role || null, error: null })
      return true
    } catch (err) {
      const msg = err?.error || 'Login failed'
      set({ error: msg })
      return false
    }
  },

  logout: async () => {
    await api('/api/logout', { method: 'POST' })
    set({ authenticated: false, username: null, role: null, userId: null, csrfToken: null })
  },
}))
