import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { toggleTheme, getTheme } from '../lib/theme'

export default function Setup() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [theme, setTheme] = useState(getTheme())
  const navigate = useNavigate()

  function handleToggleTheme() {
    setTheme(toggleTheme())
  }

  useEffect(() => {
    api('/api/setup').then((data) => {
      if (!data.needsSetup) navigate('/login', { replace: true })
    }).catch(() => {})
  }, [navigate])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (password !== confirm) { setError('Passwords do not match'); return }
    if (password.length < 4) { setError('Password must be at least 4 characters'); return }
    setSubmitting(true)
    try {
      await api('/api/setup', { method: 'POST', body: { username, password } })
      setDone(true)
    } catch (err) {
      setError(err?.error || 'Failed to create admin')
    }
    setSubmitting(false)
  }

  if (done) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas">
        <button onClick={handleToggleTheme} className="absolute top-4 right-4 px-2.5 py-1.5 rounded-lg text-ink-faint hover:text-accent-text hover:bg-panel transition-colors" title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark' ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
          )}
        </button>
        <div className="w-full max-w-sm mx-auto px-4 text-center">
          <div className="text-success text-5xl mb-4">✓</div>
          <h1 className="text-xl font-bold text-ink mb-2">Admin Created</h1>
          <p className="text-ink-faint text-sm mb-6">Now you can log in with your new account.</p>
          <button onClick={() => navigate('/login')} className="px-6 py-3 bg-accent hover:bg-accent-hover text-accent-ink rounded-xl text-sm font-medium transition-colors">
            Go to Login
          </button>
        </div>
      </div>
    )
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
            <img src="/paddock-logo.svg" alt="Paddock" className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-ink">Welcome to Paddock</h1>
          <p className="text-sm text-ink-dim mt-1">Create your admin account to get started</p>
        </div>

        {error && (
          <div className="bg-danger-soft border border-danger-line text-danger px-4 py-3 rounded-lg text-sm mb-4">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-muted mb-2">Admin Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required
              className="w-full px-4 py-3 bg-sunken border border-line rounded-xl text-ink text-sm focus:border-accent-line focus:outline-none focus:ring-1 focus:ring-accent-line"
              placeholder="e.g. admin" />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-muted mb-2">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full px-4 py-3 bg-sunken border border-line rounded-xl text-ink text-sm focus:border-accent-line focus:outline-none focus:ring-1 focus:ring-accent-line"
              placeholder="Min 4 characters" />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-muted mb-2">Confirm Password</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required
              className="w-full px-4 py-3 bg-sunken border border-line rounded-xl text-ink text-sm focus:border-accent-line focus:outline-none focus:ring-1 focus:ring-accent-line"
              placeholder="Repeat password" />
          </div>
          <button type="submit" disabled={submitting}
            className="w-full px-4 py-3 bg-accent hover:bg-accent-hover disabled:bg-accent-soft disabled:cursor-not-allowed text-accent-ink rounded-xl text-sm font-medium transition-colors">
            {submitting ? 'Creating…' : 'Create Admin Account'}
          </button>
        </form>
      </div>
    </div>
  )
}