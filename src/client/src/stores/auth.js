import { create } from 'zustand'
import { api, setCsrfToken } from '../lib/api'

export const useAuth = create((set) => ({
  authenticated: false,
  loading: true,
  error: null,

  checkSession: async () => {
    try {
      const data = await api('/api/session')
      setCsrfToken(data.csrfToken)
      set({ authenticated: data.authenticated, loading: false, error: null })
    } catch {
      set({ authenticated: false, loading: false, error: null })
    }
  },

  login: async (password) => {
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: { password },
      })
      if (data.csrfToken) setCsrfToken(data.csrfToken)
      set({ authenticated: true, error: null })
      return true
    } catch (err) {
      const msg = err?.error || 'Login failed'
      set({ error: msg })
      return false
    }
  },

  logout: async () => {
    await api('/api/logout', { method: 'POST' })
    set({ authenticated: false, csrfToken: null })
  },
}))
