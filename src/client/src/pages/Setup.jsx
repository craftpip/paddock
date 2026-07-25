import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'

export default function Setup() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()

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
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <div className="w-full max-w-sm mx-auto px-4 text-center">
          <div className="text-emerald-400 text-5xl mb-4">✓</div>
          <h1 className="text-xl font-bold text-white mb-2">Admin Created</h1>
          <p className="text-slate-400 text-sm mb-6">Now you can log in with your new account.</p>
          <button onClick={() => navigate('/login')} className="px-6 py-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-sm font-medium transition-colors">
            Go to Login
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900">
      <div className="w-full max-w-sm mx-auto px-4">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 mb-4">
            <img src="/paddock-logo.svg" alt="Paddock" className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-white">Welcome to Paddock</h1>
          <p className="text-sm text-slate-500 mt-1">Create your admin account to get started</p>
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-700 text-red-200 px-4 py-3 rounded-lg text-sm mb-4">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Admin Username</label>
            <input type="text" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required
              className="w-full px-4 py-3 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="e.g. admin" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required
              className="w-full px-4 py-3 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="Min 4 characters" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-300 mb-2">Confirm Password</label>
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required
              className="w-full px-4 py-3 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              placeholder="Repeat password" />
          </div>
          <button type="submit" disabled={submitting}
            className="w-full px-4 py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors">
            {submitting ? 'Creating…' : 'Create Admin Account'}
          </button>
        </form>
      </div>
    </div>
  )
}