import { useState, useEffect } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../stores/auth'
import { useConfirm } from '../lib/confirm'
import { useAlert } from '../lib/alert'

const SCOPES = ['default', 'read', 'control']
const USERNAME_RE = /^[A-Za-z0-9]{3,32}$/
const KEY_NAME_RE = /^[A-Za-z0-9]{3,64}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const inputBase = "w-full px-3 py-2 bg-slate-950 border rounded-lg text-white text-sm placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500/20"
const inputCls = inputBase + " border-slate-700"
const inputErrCls = inputBase + " border-red-600"
const cardCls = "border border-slate-800 rounded-xl bg-slate-900/50 p-5"
const btnCls = "px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-900/60 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
const btnGhost = "px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-sm font-medium transition-colors"

function Field({ label, hint, error, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-400 mb-1.5">{label}</label>
      {children}
      {error ? (
        <p className="text-xs text-red-400 mt-1.5">{error}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500 mt-1.5">{hint}</p>
      ) : null}
    </div>
  )
}

function Modal({ title, description, onClose, width = 'max-w-sm', children }) {
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-slate-800 rounded-xl p-6 ${width} w-full mx-4 border border-slate-700 shadow-2xl`} onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-white">{title}</h2>
        {description && <p className="text-sm text-slate-400 mt-1 mb-4">{description}</p>}
        {children}
      </div>
    </div>
  )
}

function ErrorBanner({ children }) {
  return <div className="bg-red-900/30 border border-red-700/60 text-red-200 px-4 py-3 rounded-lg text-sm mb-4">{children}</div>
}

export default function Profile() {
  const username = useAuth((s) => s.username)
  const role = useAuth((s) => s.role)
  const confirm = useConfirm()
  const alert = useAlert()
  const [tab, setTab] = useState(() => {
    const p = new URLSearchParams(window.location.search).get('tab')
    if (p === 'users' && role !== 'admin') return 'general'
    return ['general', 'keys', 'users'].includes(p) ? p : 'general'
  })

  function selectTab(id) {
    setTab(id)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', id)
    window.history.replaceState({}, '', url)
  }

  const [email, setEmail] = useState('')
  const [emailError, setEmailError] = useState('')
  const [account, setAccount] = useState(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwSaving, setPwSaving] = useState(false)
  const [pwMsg, setPwMsg] = useState('')

  const [keys, setKeys] = useState([])
  const [keysLoading, setKeysLoading] = useState(true)
  const [name, setName] = useState('')
  const [scope, setScope] = useState('default')
  const [creating, setCreating] = useState(false)
  const [keyMsg, setKeyMsg] = useState('')
  const [keyNameNote, setKeyNameNote] = useState('')
  const [revealed, setRevealed] = useState(null)
  const [copied, setCopied] = useState(false)

  const [users, setUsers] = useState([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'user' })
  const [usernameNote, setUsernameNote] = useState('')
  const [resetPwUser, setResetPwUser] = useState(null)
  const [resetPassword, setResetPassword] = useState('')
  const [usersError, setUsersError] = useState('')

  useEffect(() => {
    api('/api/profile')
      .then((d) => {
        if (d.user) {
          setEmail(d.user.email || '')
          setAccount(d.user)
        }
      })
      .catch(() => {})
    loadKeys()
    if (role === 'admin') loadUsers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role])

  async function loadKeys() {
    setKeysLoading(true)
    try { setKeys((await api('/api/profile/keys')).keys || []) } catch {}
    setKeysLoading(false)
  }

  async function saveEmail(e) {
    e.preventDefault()
    setMsg('')
    const em = email.trim()
    if (!em) { setEmailError('Email is required'); return }
    if (!EMAIL_RE.test(em)) { setEmailError('Enter a valid email address'); return }
    setSaving(true)
    try {
      await api('/api/profile', { method: 'PATCH', body: { email: em } })
      setEmail(em)
      setMsg('Email updated')
    } catch (err) { setMsg(err?.error || 'Failed to update email') }
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
    } catch (err) { setPwMsg(err?.error || 'Failed to change password') }
    setPwSaving(false)
  }

  async function createKey(e) {
    e.preventDefault()
    setKeyMsg('')
    const n = name.trim()
    if (!n) { setKeyMsg('Key name is required'); return }
    if (!KEY_NAME_RE.test(n)) { setKeyMsg('Key name must be 3-64 letters or numbers'); return }
    setCreating(true)
    try {
      const d = await api('/api/profile/keys', { method: 'POST', body: { name: n, scopes: [scope] } })
      setRevealed({ key: d.key, name: d.name })
      setName('')
      setKeyNameNote('')
      setCopied(false)
      loadKeys()
    } catch (err) { setKeyMsg(err?.error || 'Failed to create key') }
    setCreating(false)
  }

  async function revokeKey(id, n) {
    const ok = await confirm({
      title: 'Revoke API key',
      message: `Revoke API key '${n}'?`,
      danger: true,
      confirmText: 'Revoke',
    })
    if (!ok) return
    try { await api(`/api/profile/keys/${id}`, { method: 'DELETE' }); loadKeys() }
    catch (err) { setKeyMsg(err?.error || 'Failed to revoke key') }
  }

  async function loadUsers() {
    try {
      const data = await api('/api/users')
      setUsers(data.users || [])
    } catch {}
    setUsersLoading(false)
  }

  async function createUser() {
    setUsersError('')
    if (!USERNAME_RE.test(newUser.username)) { setUsersError('Username must be 3-32 letters or numbers'); return }
    if (newUser.password.length < 4) { setUsersError('Password must be at least 4 characters'); return }
    try {
      await api('/api/users', { method: 'POST', body: newUser })
      setShowCreate(false)
      setNewUser({ username: '', password: '', role: 'user' })
      setUsernameNote('')
      loadUsers()
    } catch (err) { setUsersError(err?.error || 'Failed to create user') }
  }

  async function resetUserPassword() {
    setUsersError('')
    if (!resetPassword || resetPassword.length < 4) { setUsersError('Password must be at least 4 characters'); return }
    try {
      await api(`/api/users/${resetPwUser.id}/reset-password`, { method: 'POST', body: { password: resetPassword } })
      setResetPwUser(null)
      setResetPassword('')
    } catch (err) { setUsersError(err?.error || 'Failed to reset password') }
  }

  async function deleteUser(id) {
    const ok = await confirm({
      title: 'Delete user',
      message: 'Delete this user? Their agents will become unowned.',
      danger: true,
      confirmText: 'Delete',
    })
    if (!ok) return
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' })
      loadUsers()
    } catch (err) { alert({ title: 'Failed to delete user', message: err?.error || 'Failed to delete user', danger: true }) }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text) }
    catch {
      const ta = document.createElement('textarea'); ta.value = text
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
    }
  }

  const fmt = (s) => (s ? new Date(s + 'Z').toLocaleString() : 'never')

  const usernameError =
    (newUser.username.length && newUser.username.length < 3 && !usernameNote)
      ? 'Username must be at least 3 characters'
      : usernameNote
  const canCreateUser = USERNAME_RE.test(newUser.username) && newUser.password.length >= 4

  const keyNameError =
    (name.length && name.length < 3 && !keyNameNote)
      ? 'Key name must be at least 3 characters'
      : keyNameNote
  const canCreateKey = KEY_NAME_RE.test(name)

  const navItems = [
    { id: 'general', label: 'General' },
    { id: 'keys', label: 'API Keys' },
    ...(role === 'admin' ? [{ id: 'users', label: 'Users' }] : []),
  ]

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-slate-400 text-sm">{username}</span>
          <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${role === 'admin' ? 'bg-purple-900/50 text-purple-300 border border-purple-800' : 'bg-slate-800 text-slate-300 border border-slate-700'}`}>
            {role}
          </span>
        </div>
      </div>

      <div className="flex gap-1 border-b border-slate-800 mb-6">
        {navItems.map((t) => (
          <button
            key={t.id}
            onClick={() => selectTab(t.id)}
            className={`px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${tab === t.id ? 'text-white border-cyan-500' : 'text-slate-400 border-transparent hover:text-slate-200'}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="min-w-0">
        {tab === 'general' && (
          <div className="space-y-6">
            <div className={cardCls}>
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-white">Account</h2>
                <p className="text-xs text-slate-500 mt-0.5">Basic information about your sign-in.</p>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-slate-500 mb-1">Username</dt>
                  <dd className="text-white font-medium">{account?.username || username}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500 mb-1">Role</dt>
                  <dd className="capitalize text-white font-medium">{role}</dd>
                </div>
                <div>
                  <dt className="text-xs text-slate-500 mb-1">Member since</dt>
                  <dd className="text-white font-medium">
                    {account?.created_at ? new Date(account.created_at + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                  </dd>
                </div>
              </dl>
            </div>

            <div className={cardCls}>
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-white">Email</h2>
                <p className="text-xs text-slate-500 mt-0.5">Used for account recovery and notifications.</p>
              </div>
              <form onSubmit={saveEmail} className="flex gap-2 items-start">
                <div className="flex-1">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setEmailError('') }}
                    placeholder="you@example.com"
                    className={emailError ? inputErrCls : inputCls}
                  />
                  {emailError && <p className="text-xs text-red-400 mt-1.5">{emailError}</p>}
                </div>
                <button type="submit" disabled={saving} className={`${btnCls} whitespace-nowrap`}>{saving ? 'Saving…' : 'Save'}</button>
              </form>
              {msg && !emailError && <p className={`text-xs mt-2 ${msg.includes('Failed') ? 'text-red-400' : 'text-emerald-400'}`}>{msg}</p>}
            </div>

            <div className={cardCls}>
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-white">Password</h2>
                <p className="text-xs text-slate-500 mt-0.5">Keep your account secure with a strong password.</p>
              </div>
              <form onSubmit={changePassword} className="space-y-3 max-w-md">
                <Field label="Current password">
                  <input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} placeholder="Current password" required autoComplete="current-password" className={inputCls} />
                </Field>
                <Field label="New password" hint="At least 4 characters.">
                  <input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} placeholder="New password" required autoComplete="new-password" className={inputCls} />
                </Field>
                <Field label="Confirm new password">
                  <input type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} placeholder="Confirm new password" required autoComplete="new-password" className={inputCls} />
                </Field>
                <div>
                  <button type="submit" disabled={pwSaving} className={btnCls}>{pwSaving ? 'Updating…' : 'Change Password'}</button>
                  {pwMsg && <p className={`text-xs mt-2 ${pwMsg.includes('incorrect') || pwMsg.includes('Failed') || pwMsg.includes('match') ? 'text-red-400' : 'text-emerald-400'}`}>{pwMsg}</p>}
                </div>
              </form>
            </div>
          </div>
        )}

        {tab === 'keys' && (
          <div className={cardCls}>
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-white">API Keys</h2>
              <p className="text-xs text-slate-500 mt-0.5">Bearer tokens that MCP clients use to authenticate with this server.</p>
            </div>

            <form onSubmit={createKey} className="flex flex-col sm:flex-row gap-2 mb-4 items-start">
              <div className="flex-1 w-full">
                <input
                  type="text"
                  value={name}
                  maxLength={64}
                  onChange={(e) => {
                    const v = e.target.value
                    const cleaned = v.replace(/[^A-Za-z0-9]/g, '')
                    setKeyNameNote(cleaned !== v ? 'Only letters and numbers are allowed' : '')
                    setKeyMsg('')
                    setName(cleaned)
                  }}
                  placeholder="Key name (e.g. opencode)"
                  className={keyNameError ? inputErrCls : inputCls}
                />
                <p className={`text-xs mt-1.5 ${keyNameError ? 'text-red-400' : 'text-slate-500'}`}>
                  {keyNameError || 'Letters and numbers only.'}
                </p>
              </div>
              <select value={scope} onChange={(e) => setScope(e.target.value)} className={`${inputCls} sm:w-40`}>
                {SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button type="submit" disabled={creating || !canCreateKey} className={`${btnCls} whitespace-nowrap`}>{creating ? 'Creating…' : 'Create Key'}</button>
            </form>
            {keyMsg && <p className="text-xs text-red-400 mb-3">{keyMsg}</p>}

            {keysLoading ? (
              <div className="text-sm text-slate-500 py-8 text-center">Loading keys…</div>
            ) : keys.length === 0 ? (
              <div className="text-sm text-slate-500 py-8 text-center border-t border-slate-800">No API keys yet. Create one to connect an MCP client.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-left text-xs text-slate-500 uppercase tracking-wide">
                    <th className="pb-2 pr-3 font-medium">Name</th>
                    <th className="pb-2 pr-3 font-medium">Prefix</th>
                    <th className="pb-2 pr-3 font-medium">Scope</th>
                    <th className="pb-2 pr-3 font-medium">Last used</th>
                    <th className="pb-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-slate-800">
                      <td className="py-3 pr-3 font-medium text-white">{k.name}</td>
                      <td className="py-3 pr-3">
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-slate-400 bg-slate-950 border border-slate-800 rounded-md px-2 py-0.5">
                          {k.prefix}
                          <button onClick={() => copy(k.prefix)} title="Copy prefix" className="text-slate-500 hover:text-cyan-400 transition-colors">
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          </button>
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-slate-800 text-slate-300">{k.scopes}</span>
                      </td>
                      <td className="py-3 pr-3 text-xs text-slate-500">{fmt(k.last_used_at)}</td>
                      <td className="py-3 text-right">
                        <button onClick={() => revokeKey(k.id, k.name)} className="px-2.5 py-1 bg-red-900/40 hover:bg-red-800/50 text-red-300 rounded-lg text-xs transition-colors">Revoke</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {tab === 'users' && (
          <div className={cardCls}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-white">Users</h2>
                <p className="text-xs text-slate-500 mt-0.5">People who can sign in to this dashboard.</p>
              </div>
              <button
                onClick={() => {
                  setUsersError(''); setUsernameNote('')
                  setNewUser({ username: '', password: '', role: 'user' })
                  setShowCreate(true)
                }}
                className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
              >
                + Create User
              </button>
            </div>

            {usersLoading ? (
              <div className="text-slate-500 text-sm py-8 text-center">Loading users…</div>
            ) : users.length === 0 ? (
              <div className="text-slate-500 text-sm py-8 text-center">No users yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700 text-left text-xs text-slate-500 uppercase tracking-wide">
                      <th className="pb-2 pr-4 font-medium">Username</th>
                      <th className="pb-2 pr-4 font-medium">Email</th>
                      <th className="pb-2 pr-4 font-medium">Role</th>
                      <th className="pb-2 pr-4 font-medium">Agents</th>
                      <th className="pb-2 pr-4 font-medium">Created</th>
                      <th className="pb-2 font-medium text-right">Actions</th>
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
                        <td className="py-3">
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => { setUsersError(''); setResetPassword(''); setResetPwUser(u) }}
                              className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs transition-colors"
                            >
                              Reset PW
                            </button>
                            {u.role !== 'admin' && (
                              <button onClick={() => deleteUser(u.id)} className="px-3 py-1 bg-red-900/40 hover:bg-red-800/50 text-red-300 rounded-lg text-xs transition-colors">
                                Delete
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {revealed && (
        <Modal title="API key created" description="Copy this key now — you will not be able to see it again." onClose={() => setRevealed(null)} width="max-w-lg">
          <div className="flex gap-2 mb-4">
            <code className="flex-1 px-3 py-2.5 bg-slate-950 border border-slate-700 rounded-lg text-xs text-emerald-300 font-mono break-all">{revealed.key}</code>
            <button onClick={() => { copy(revealed.key); setCopied(true) }} className={`${btnCls} whitespace-nowrap`}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
          <p className="text-xs font-medium text-slate-300 mb-2">Client config for “{revealed.name}”</p>
          <pre className="bg-slate-950 border border-slate-700 rounded-lg p-3 text-[11px] text-slate-300 overflow-x-auto mb-4">{`{
  "mcpServers": {
    "paddock": {
      "type": "http",
      "url": "http://10.69.1.164:6789/mcp",
      "headers": { "Authorization": "Bearer ${revealed.key}" }
    }
  }
}`}</pre>
          <button onClick={() => setRevealed(null)} className={`${btnCls} w-full`}>Done</button>
        </Modal>
      )}

      {showCreate && (
        <Modal
          title="Create User"
          description="Add a new person who can sign in to this dashboard."
          onClose={() => { setShowCreate(false); setUsersError(''); setUsernameNote('') }}
        >
          {usersError && <ErrorBanner>{usersError}</ErrorBanner>}
          <form onSubmit={(e) => { e.preventDefault(); createUser() }} className="space-y-4">
            <Field
              label="Username"
              hint={usernameError ? undefined : 'Letters and numbers only, 3–32 characters.'}
              error={usernameError || undefined}
            >
              <input
                type="text"
                value={newUser.username}
                maxLength={32}
                autoFocus
                onChange={(e) => {
                  const v = e.target.value
                  const cleaned = v.replace(/[^A-Za-z0-9]/g, '')
                  setUsernameNote(cleaned !== v ? 'Only letters and numbers are allowed' : '')
                  setUsersError('')
                  setNewUser((u) => ({ ...u, username: cleaned }))
                }}
                placeholder="e.g. janedoe"
                className={usernameError ? inputErrCls : inputCls}
              />
            </Field>
            <Field label="Password" hint="At least 4 characters.">
              <input
                type="password"
                value={newUser.password}
                onChange={(e) => { setUsersError(''); setNewUser((u) => ({ ...u, password: e.target.value })) }}
                placeholder="Password"
                autoComplete="new-password"
                className={inputCls}
              />
            </Field>
            <Field label="Role" hint="Admins can manage users, agents, and the vault.">
              <select value={newUser.role} onChange={(e) => setNewUser((u) => ({ ...u, role: e.target.value }))} className={inputCls}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <div className="flex gap-2 pt-2">
              <button type="button" onClick={() => { setShowCreate(false); setUsersError(''); setUsernameNote('') }} className={`${btnGhost} flex-1`}>Cancel</button>
              <button type="submit" disabled={!canCreateUser} className={`${btnCls} flex-1`}>Create User</button>
            </div>
          </form>
        </Modal>
      )}

      {resetPwUser && (
        <Modal
          title="Reset Password"
          description={`Set a new password for ${resetPwUser.username}.`}
          onClose={() => { setResetPwUser(null); setResetPassword(''); setUsersError('') }}
        >
          {usersError && <ErrorBanner>{usersError}</ErrorBanner>}
          <form onSubmit={(e) => { e.preventDefault(); resetUserPassword() }} className="space-y-4">
            <Field label="New password" hint="At least 4 characters.">
              <input
                type="password"
                value={resetPassword}
                onChange={(e) => { setUsersError(''); setResetPassword(e.target.value) }}
                placeholder="New password"
                autoFocus
                autoComplete="new-password"
                className={inputCls}
              />
            </Field>
            <div className="flex gap-2 pt-4">
              <button type="button" onClick={() => { setResetPwUser(null); setResetPassword(''); setUsersError('') }} className={`${btnGhost} flex-1`}>Cancel</button>
              <button type="submit" className={`${btnCls} flex-1`}>Reset</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
