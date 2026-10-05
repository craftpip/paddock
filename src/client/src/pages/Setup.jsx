import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { toggleTheme, getTheme } from '../lib/theme'
import Button from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import Field from '../components/ui/Field'
import { TONES } from '../components/ui/tone'
import { cx } from '../lib/cx'

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
        <Button variant="ghost" size="md" icon
                className="absolute top-4 right-4 text-ink-faint hover:text-accent-text"
                onClick={handleToggleTheme}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          {theme === 'dark' ? (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a 4 4 0 1 1 -8 0 4 4 0 018 0z" /></svg>
          ) : (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A 9 9 0 0 1 8.646 3.646 9.003 9.003 0 0012 21a 9.003 9.003 0 0 0 8.354 -5.646z" /></svg>
          )}
        </Button>
        <div className="w-full max-w-sm mx-auto px-4 text-center">
          <div className="text-success text-5xl mb-4">✓</div>
          <h1 className="text-xl font-bold text-ink mb-2">Admin Created</h1>
          <p className="text-ink-faint text-sm mb-6">Now you can log in with your new account.</p>
          <Button variant="primary" size="lg" onClick={() => navigate('/login')}>
            Go to Login
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-canvas">
      <Button variant="ghost" size="md" icon
              className="absolute top-4 right-4 text-ink-faint hover:text-accent-text"
              onClick={handleToggleTheme}
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
        {theme === 'dark' ? (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a 4 4 0 1 1 -8 0 4 4 0 018 0z" /></svg>
        ) : (
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A 9 9 0 0 1 8.646 3.646 9.003 9.003 0 0012 21a 9.003 9.003 0 0 0 8.354 -5.646z" /></svg>
        )}
      </Button>
      <div className="w-full max-w-sm mx-auto px-4">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-panel border border-line mb-4">
            <img src="/paddock-logo.svg" alt="Paddock" className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-ink">Welcome to Paddock</h1>
          <p className="text-sm text-ink-dim mt-1">Create your admin account to get started</p>
        </div>

        {error && (
          <div className={cx('rounded-card border px-4 py-3 text-sm mb-4', TONES.danger.panel)}>{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Admin Username" labelVariant="compact">
            <Input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required
              placeholder="e.g. admin" />
          </Field>
          <Field label="Password" labelVariant="compact">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              placeholder="Min 4 characters" />
          </Field>
          <Field label="Confirm Password" labelVariant="compact">
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required
              placeholder="Repeat password" />
          </Field>
          <Button type="submit" variant="primary" size="lg" block disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Admin Account'}
          </Button>
        </form>
      </div>
    </div>
  )
}
