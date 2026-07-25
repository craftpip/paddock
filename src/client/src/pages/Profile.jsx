import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../stores/auth'

export default function Profile() {
  const username = useAuth((s) => s.username)
  const role = useAuth((s) => s.role)
  const [email, setEmail] = useState('')
  const [savedEmail, setSavedEmail] = useState('')
  const [saving, setSaving] = useState(false)
  const [emailMsg, setEmailMsg] = useState('')
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState('')

  useEffect(() => {
    api('/api/profile').then((data) => {
      if (data.user) {
        setEmail(data.user.email || '')
        setSavedEmail(data.user.email || '')
      }
    }).catch(() => {})
  }, [])

  async function saveEmail(e) {
    e.preventDefault()
    setSaving(true)
    setEmailMsg('')
    try {
      await api('/api/profile', { method: 'PATCH', body: { email } })
      setSavedEmail(email)
      setEmailMsg('Email updated')
    } catch (err) {
      setEmailMsg(err?.error || 'Failed to update email')
    }
    setSaving(false)
  }

  async function changePassword(e) {
    e.preventDefault()
    setPwMsg('')
    if (pwNew !== pwConfirm) { setPwMsg('Passwords do not match'); return }
    if (pwNew.length < 4) { setPwMsg('Password must be at least 4 characters'); return }
    setPwSaving(true)
    try {
      await api('/api/profile/change-password', { method: 'POST', body: { current_password: pwCurrent, new_password: pwNew } })
      setPwMsg('Password changed successfully')
      setPwCurrent(''); setPwNew(''); setPwConfirm('')
    } catch (err) {
      setPwMsg(err?.error || 'Failed to change password')
    }
    setPwSaving(false)
  }

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
      <h1 className="text-xl font-bold text-white mb-6">My Profile</h1>

      <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-6 mb-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-14 h-14 rounded-full bg-cyan-900/50 border border-cyan-700 flex items-center justify-center text-cyan-400 text-xl font-bold">
            {(username || '?').charAt(0).toUpperCase()}
          </div>
          <div>
            <div className="text-white font-medium text-lg">{username}</div>
            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${role === 'admin' ? 'bg-purple-900/50 text-purple-300' : 'bg-slate-800 text-slate-300'}`}>
              {role}
            </span>
          </div>
        </div>

        <form onSubmit={saveEmail} className="space-y-3 mb-2">
          <label className="block text-sm font-medium text-slate-300">Email</label>
          <div className="flex gap-2">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com"
              className="flex-1 px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none" />
            <button type="submit" disabled={saving || email === savedEmail}
              className="px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {emailMsg && <p className={`text-xs ${emailMsg.includes('Failed') ? 'text-red-400' : 'text-emerald-400'}`}>{emailMsg}</p>}
        </form>
      </div>

      <div className="bg-slate-800/50 rounded-xl border border-slate-700 p-6">
        <h2 className="text-base font-semibold text-white mb-4">Change Password</h2>
        <form onSubmit={changePassword} className="space-y-3">
          <input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} placeholder="Current password" required
            className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none" />
          <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} placeholder="New password (min 4 chars)" required
            className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none" />
          <input type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} placeholder="Confirm new password" required
            className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none" />
          <button type="submit" disabled={pwSaving}
            className="px-4 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-800 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors">
            {pwSaving ? 'Changing…' : 'Change Password'}
          </button>
          {pwMsg && <p className={`text-xs ${pwMsg.includes('incorrect') || pwMsg.includes('Failed') || pwMsg.includes('match') ? 'text-red-400' : 'text-emerald-400'}`}>{pwMsg}</p>}
        </form>
      </div>
    </div>
  )
}