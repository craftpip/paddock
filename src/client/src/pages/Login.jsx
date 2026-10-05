import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../stores/auth'
import { toggleTheme, getTheme } from '../lib/theme'
import Button from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { TONES } from '../components/ui/tone'
import { cx } from '../lib/cx'

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
      <Button
        variant="ghost"
        size="sm"
        icon
        onClick={handleToggleTheme}
        className="absolute top-4 right-4 text-ink-faint hover:text-accent-text hover:bg-panel"
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a 4 4 0 1 1 -8 0 4 4 0 018 0z" /></svg>
        ) : (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A 9 9 0 0 1 8.646 3.646 9.003 9.003 0 0012 21a 9.003 9.003 0 0 0 8.354 -5.646z" /></svg>
        )}
      </Button>
      <div className="w-full max-w-sm mx-auto px-4">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-panel border border-line mb-4">
            <svg className="w-8 h-8 text-accent-text" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a 2 2 0 0 0 2 -2V5a 2 2 0 0 0 -2 -2H5a 2 2 0 0 0 -2 2v10a 2 2 0 0 0 2 2z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-ink">Paddock</h1>
          <p className="text-sm text-ink-dim mt-1">Agent Management System</p>
        </div>

        {error && (
          <div className={cx('rounded-card border px-4 py-3 text-sm mb-4', TONES.danger.panel)}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-ink-muted mb-2">Username</label>
            <Input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
              placeholder="Enter username"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink-muted mb-2">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Enter password"
            />
          </div>
          <Button type="submit" variant="primary" size="lg" block disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign In'}
          </Button>
        </form>
      </div>
    </div>
  )
}
