import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/auth'
import { toggleTheme, getTheme } from '../lib/theme'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [theme, setTheme] = useState(getTheme())
  const error = useAuth((s) => s.error)
  const login = useAuth((s) => s.login)
  const navigate = useNavigate()

  function handleToggleTheme() {
    setTheme(toggleTheme())
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    const ok = await login(username, password)
    setSubmitting(false)
    if (ok) navigate('/agents', { replace: true })
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <button onClick={handleToggleTheme} className="absolute top-4 right-4 px-2.5 py-1.5 rounded-lg text-ink-faint hover:text-accent-text hover:bg-panel transition-colors" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
        {theme === 'dark' ? (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
        ) : (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
        )}
      </button>
      <div className="w-full max-w-sm mx-auto px-4">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-panel border border-line mb-4">
            <svg className="w-8 h-8 text-accent-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-ink">Paddock</h1>
          <p className="text-sm text-ink-dim mt-1">Agent Management System</p>
        </div>

        {error && (
          <div className="bg-danger-soft border border-danger-line text-danger px-4 py-3 rounded-lg text-sm mb-4">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-muted mb-2">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
              className="w-full px-4 py-3 bg-sunken border border-line rounded-xl text-ink text-sm focus:border-accent-line focus:outline-none focus:ring-1 focus:ring-accent-line"
              placeholder="Enter username"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-muted mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-4 py-3 bg-sunken border border-line rounded-xl text-ink text-sm focus:border-accent-line focus:outline-none focus:ring-1 focus:ring-accent-line"
              placeholder="Enter password"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full px-4 py-3 bg-accent hover:bg-accent-hover disabled:bg-accent-soft disabled:cursor-not-allowed text-accent-ink rounded-xl text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-accent-line focus:ring-offset-2 focus:ring-offset-canvas"
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
