import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../stores/auth'

export default function Users() {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' })
  const [resetPw, setResetPw] = useState(null)
  const [resetPassword, setResetPassword] = useState('')
  const [error, setError] = useState('')
  const role = useAuth((s) => s.role)

  async function loadUsers() {
    try {
      const data = await api('/api/users')
      setUsers(data.users || [])
    } catch {}
    setLoading(false)
  }

  useEffect(() => { loadUsers() }, [])

  async function createUser() {
    setError('')
    if (!newUser.username || !newUser.password) { setError('Username and password required'); return }
    if (newUser.password.length < 4) { setError('Password must be at least 4 characters'); return }
    try {
      await api('/api/users', { method: 'POST', body: newUser })
      setShowCreate(false)
      setNewUser({ username: '', password: '', role: 'user' })
      loadUsers()
    } catch (err) { setError(err?.error || 'Failed to create user') }
  }

  async function resetUserPassword() {
    setError('')
    if (!resetPassword || resetPassword.length < 4) { setError('Password must be at least 4 characters'); return }
    try {
      await api(`/api/users/${resetPw}/reset-password`, { method: 'POST', body: { password: resetPassword } })
      setResetPw(null)
      setResetPassword('')
    } catch (err) { setError(err?.error || 'Failed to reset password') }
  }

  async function deleteUser(id) {
    if (!confirm('Delete this user? Their agents will become unowned.')) return
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' })
      loadUsers()
    } catch (err) { alert(err?.error || 'Failed to delete user') }
  }

  if (role !== 'admin') return <div className="p-8 text-slate-400">Access denied.</div>

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-bold text-white">Users</h1>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors">
          + Create User
        </button>
      </div>

      {error && <div className="bg-red-900/30 border border-red-700 text-red-200 px-4 py-3 rounded-lg text-sm mb-4">{error}</div>}

      {loading ? (
        <div className="text-slate-500 text-sm">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-slate-500 text-sm">No users yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-slate-400 text-left">
                <th className="pb-3 pr-4 font-medium">Username</th>
                <th className="pb-3 pr-4 font-medium">Email</th>
                <th className="pb-3 pr-4 font-medium">Role</th>
                <th className="pb-3 pr-4 font-medium">Agents</th>
                <th className="pb-3 pr-4 font-medium">Created</th>
                <th className="pb-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-slate-800 text-slate-300">
                  <td className="py-3 pr-4 font-medium text-white">{u.username}</td>
                  <td className="py-3 pr-4 text-slate-400">{u.email || '—'}</td>
                  <td className="py-3 pr-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${u.role === 'admin' ? 'bg-purple-900/50 text-purple-300' : 'bg-slate-800 text-slate-300'}`}>
                      {u.role}
                    </span>
                  </td>
                  <td className="py-3 pr-4">{u.agent_count}</td>
                  <td className="py-3 pr-4 text-slate-400">{u.created_at ? new Date(u.created_at + 'Z').toLocaleDateString() : '—'}</td>
                  <td className="py-3 flex gap-2">
                    <button onClick={() => setResetPw(u.id)} className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition-colors">
                      Reset PW
                    </button>
                    {u.role !== 'admin' && (
                      <button onClick={() => deleteUser(u.id)} className="px-3 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-300 rounded-lg text-xs transition-colors">
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowCreate(false)}>
          <div className="bg-slate-800 rounded-xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-4">Create User</h2>
            <div className="space-y-3">
              <input type="text" placeholder="Username" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none" />
              <input type="password" placeholder="Password (min 4 chars)" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none" />
              <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm focus:border-cyan-500 focus:outline-none">
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
              <div className="flex gap-2 pt-2">
                <button onClick={() => setShowCreate(false)} className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors">Cancel</button>
                <button onClick={createUser} className="flex-1 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors">Create</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {resetPw && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => { setResetPw(null); setResetPassword('') }}>
          <div className="bg-slate-800 rounded-xl p-6 max-w-sm w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-white mb-4">Reset Password</h2>
            <input type="password" placeholder="New password (min 4 chars)" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)}
              className="w-full px-4 py-2.5 bg-slate-900 border border-slate-700 rounded-lg text-white text-sm mb-4 focus:border-cyan-500 focus:outline-none" />
            <div className="flex gap-2">
              <button onClick={() => { setResetPw(null); setResetPassword('') }} className="flex-1 px-4 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg text-sm transition-colors">Cancel</button>
              <button onClick={resetUserPassword} className="flex-1 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors">Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}