import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useState, useEffect } from 'react'
import { usePopup, useDirtyNavigation, useNavigation, useDraftState, popupIdentity } from '../lib/navigation'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAuth } from '../stores/auth'
import { useConfirm } from '../lib/confirm'
import { useAlert } from '../lib/alert'
import Button from '../components/ui/Button'
import { Input, Select } from '../components/ui/Input'
import Field from '../components/ui/Field'
import Card from '../components/ui/Card'
import Badge from '../components/ui/Badge'
import Modal from '../components/ui/Modal'
import { TONES } from '../components/ui/tone'
import { cx } from '../lib/cx'

// Key scope presets (plan 52 Phase D). The API asks for a scope STRING, so each
// value is the exact comma-joined grant the key gets. Fine-grained presets are
// the least-privilege options for external clients (phone / second LLM / a
// status dashboard): the read bucket plus an opt-in `tools:exec` grant, never a
// broad `default`.
const SCOPES = [
  { value: 'default', label: 'Full access' },
  { value: 'control', label: 'Full access (control)' },
  { value: 'read', label: 'Read-only' },
  { value: 'read,target:owned', label: 'Client — read-only' },
  { value: 'target:owned,tools:exec', label: 'Client — with terminal' },
  { value: 'target:owned,tools:exec,tools:lifecycle', label: 'Operator — exec + lifecycle' },
]
const USERNAME_RE = /^[A-Za-z0-9]{3,32}$/
const KEY_NAME_RE = /^[A-Za-z0-9]{3,64}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function ErrorBanner({ children }) {
  return <div className={cx('rounded-card border px-4 py-3 text-sm mb-4', TONES.danger.panel)}>{children}</div>
}

function Snippet({ label, code }) {
  const [copied, setCopied] = useState(false)
  async function copyCode() {
    try { await navigator.clipboard.writeText(code) }
    catch {
      const ta = document.createElement('textarea'); ta.value = code
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <p className="text-xs font-medium text-ink-muted">{label}</p>
        <Button
          variant="ghost"
          size="sm"
          onClick={copyCode}
          style={{ minHeight: 0 }}
          className="text-xs py-0 px-1.5 text-ink-dim hover:bg-transparent hover:text-accent-text"
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="bg-sunken border border-line-faint rounded-card p-3 text-[11px] text-ink-muted overflow-x-auto">{code}</pre>
    </div>
  )
}

export default function Profile() {
  useDocumentTitle('Settings')
  const username = useAuth((s) => s.username)
  const role = useAuth((s) => s.role)
  const userId = useAuth((s) => s.userId)
  const confirm = useConfirm()
  const alert = useAlert()
  const { tab: tabParam } = useParams()
  const navigate = useNavigate()
  let tab = tabParam === 'users' ? 'users' : tabParam === 'mcp-keys' ? 'keys' : 'general'
  if (tab === 'users' && role !== 'admin') tab = 'general'

  // Legacy ?tab=keys / ?tab=users links redirect to the slash routes.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('tab')
    if (!q) return
    navigate(q === 'users' ? '/profile/users' : q === 'keys' ? '/profile/mcp-keys' : '/profile', { replace: true })
  }, [navigate])

  function selectTab(id) {
    if (id === tab) return
    navigate(id === 'general' ? '/profile' : `/profile/${id === 'keys' ? 'mcp-keys' : id}`)
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
  const [showUrlNote, setShowUrlNote] = useState(false)

  const [users, setUsers] = useState([])
  const [usersLoading, setUsersLoading] = useState(true)
  const [usersReadError, setUsersReadError] = useState('')
  const [createPopup, openCreate, closeCreate] = usePopup('user-new')
  const showCreate = !!createPopup && role === 'admin'
  const setShowCreate = (on) => on ? openCreate() : closeCreate()
  const [newUser, setNewUser] = useDraftState('profile:user-new', { username: '', password: '', role: 'user' })
  const [usernameNote, setUsernameNote] = useState('')
  const [passwordPopup, openPassword, closePassword] = usePopup('user-password')
  const resetPwUser = passwordPopup && users.find((u) => String(u.id) === passwordPopup.args[0]) || null
  const setResetPwUser = (user) => user ? openPassword(String(user.id)) : closePassword()
  const [resetPassword, setResetPassword] = useDraftState(`profile:password:${passwordPopup?.args[0] || ''}`, '')
  const [resetCurrentPassword, setResetCurrentPassword] = useDraftState(`profile:current-password:${passwordPopup?.args[0] || ''}`, '')
  const [usersError, setUsersError] = useState('')
  const { drafts: profileDrafts } = useNavigation()
  useEffect(() => {
    if (createPopup && role !== 'admin') {
      closeCreate({ saved: true })
      setUsersError('User creation is unavailable for this account.')
      alert({ title: 'View unavailable', message: 'User creation is unavailable for this account.' })
    }
    if (passwordPopup && ((role !== 'admin') || (!usersLoading && !usersReadError && !resetPwUser))) {
      closePassword({ saved: true })
      setUsersError('This user is unavailable.')
      alert({ title: 'View unavailable', message: 'This user is unavailable.' })
    }
  }, [role, createPopup?.value, passwordPopup?.value, usersLoading, usersReadError, resetPwUser])
  useDirtyNavigation((showCreate && !!(newUser.username || newUser.password)) || (resetPwUser && !!(resetPassword || resetCurrentPassword)), popupIdentity, () => {
    profileDrafts.delete('profile:user-new'); setNewUser({ username: '', password: '', role: 'user' }); setResetPassword(''); setResetCurrentPassword('')
  })

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
      const d = await api('/api/profile/keys', { method: 'POST', body: { name: n, scopes: scope } })
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
      setUsersReadError('')
    } catch (e) { setUsersReadError(e?.error || 'Could not load users') }
    setUsersLoading(false)
  }

  async function createUser() {
    setUsersError('')
    if (!USERNAME_RE.test(newUser.username)) { setUsersError('Username must be 3-32 letters or numbers'); return }
    if (newUser.password.length < 4) { setUsersError('Password must be at least 4 characters'); return }
    try {
      await api('/api/users', { method: 'POST', body: newUser })
      closeCreate({ saved: true })
      setNewUser({ username: '', password: '', role: 'user' })
      setUsernameNote('')
      loadUsers()
    } catch (err) { setUsersError(err?.error || 'Failed to create user') }
  }

  async function resetUserPassword() {
    setUsersError('')
    if (!resetPassword || resetPassword.length < 4) { setUsersError('Password must be at least 4 characters'); return }
    const isSelf = resetPwUser && resetPwUser.id === userId
    if (isSelf && !resetCurrentPassword) { setUsersError('Current password is required'); return }
    try {
      await api(`/api/users/${resetPwUser.id}/reset-password`, { method: 'POST', body: { password: resetPassword, current_password: isSelf ? resetCurrentPassword : undefined } })
      closePassword({ saved: true })
      setResetPassword('')
      setResetCurrentPassword('')
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
        <h1 className="text-2xl font-bold text-ink">Settings</h1>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="text-ink-faint text-sm">{username}</span>
          <Badge tone={role === 'admin' ? 'brand' : 'neutral'} size="md" className="capitalize">
            {role}
          </Badge>
        </div>
      </div>

      <div className="flex gap-1 border-b border-line-faint mb-6">
        {navItems.map((t) => (
          <Button
            key={t.id}
            variant="ghost"
            onClick={() => selectTab(t.id)}
            className={cx(
              'rounded-none px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap hover:bg-transparent',
              tab === t.id ? 'text-ink border-accent-line' : 'text-ink-faint border-transparent hover:text-ink'
            )}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <div className="min-w-0">
        {tab === 'general' && (
          <div className="space-y-6">
            <Card className="p-5">
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-ink">Account</h2>
                <p className="text-xs text-ink-dim mt-0.5">Basic information about your sign-in.</p>
              </div>
              <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <dt className="text-xs text-ink-dim mb-1">Username</dt>
                  <dd className="text-ink font-medium">{account?.username || username}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-dim mb-1">Role</dt>
                  <dd className="capitalize text-ink font-medium">{role}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-dim mb-1">Member since</dt>
                  <dd className="text-ink font-medium">
                    {account?.created_at ? new Date(account.created_at + 'Z').toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                  </dd>
                </div>
              </dl>
            </Card>

            <Card className="p-5">
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-ink">Email</h2>
                <p className="text-xs text-ink-dim mt-0.5">Used for account recovery and notifications.</p>
              </div>
              <form onSubmit={saveEmail} className="flex gap-2 items-start">
                <div className="flex-1">
                  <Field error={emailError || undefined}>
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); setEmailError('') }}
                      placeholder="you@example.com"
                      invalid={!!emailError}
                    />
                  </Field>
                </div>
                <Button type="submit" variant="primary" size="md" disabled={saving} className="whitespace-nowrap">
                  {saving ? 'Saving…' : 'Save'}
                </Button>
              </form>
              {msg && !emailError && <p className={`text-xs mt-2 ${msg.includes('Failed') ? 'text-danger' : 'text-success'}`}>{msg}</p>}
            </Card>

            <Card className="p-5">
              <div className="mb-4">
                <h2 className="text-sm font-semibold text-ink">Password</h2>
                <p className="text-xs text-ink-dim mt-0.5">Keep your account secure with a strong password.</p>
              </div>
              <form onSubmit={changePassword} className="space-y-3 max-w-md">
                <Field label="Current password">
                  <Input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} placeholder="Current password" required autoComplete="current-password" />
                </Field>
                <Field label="New password" hint="At least 4 characters.">
                  <Input type="password" value={pwNew} onChange={(e) => setPwNew(e.target.value)} placeholder="New password" required autoComplete="new-password" />
                </Field>
                <Field label="Confirm new password">
                  <Input type="password" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} placeholder="Confirm new password" required autoComplete="new-password" />
                </Field>
                <div>
                  <Button type="submit" variant="primary" size="md" disabled={pwSaving}>{pwSaving ? 'Updating…' : 'Change Password'}</Button>
                  {pwMsg && <p className={`text-xs mt-2 ${pwMsg.includes('incorrect') || pwMsg.includes('Failed') || pwMsg.includes('match') ? 'text-danger' : 'text-success'}`}>{pwMsg}</p>}
                </div>
              </form>
            </Card>
          </div>
        )}

        {tab === 'keys' && (
          <>
          <Card className="p-5">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-ink">API Keys</h2>
              <p className="text-xs text-ink-dim mt-0.5">Bearer tokens that MCP clients use to authenticate with this server.</p>
            </div>

            <form onSubmit={createKey} className="flex flex-col sm:flex-row gap-2 mb-4 items-start">
              <div className="flex-1 w-full">
                <Field
                  error={keyNameError || undefined}
                  hint="Letters and numbers only."
                >
                  <Input
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
                    invalid={!!keyNameError}
                  />
                </Field>
              </div>
              <div className="sm:w-40">
                <Select value={scope} onChange={(e) => setScope(e.target.value)}>
                  {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </Select>
              </div>
              <Button type="submit" variant="primary" size="md" disabled={creating || !canCreateKey} className="whitespace-nowrap">{creating ? 'Creating…' : 'Create Key'}</Button>
            </form>
            {keyMsg && <p className="text-xs text-danger mb-3">{keyMsg}</p>}

            {keysLoading ? (
              <div className="text-sm text-ink-dim py-8 text-center">Loading keys…</div>
            ) : keys.length === 0 ? (
              <div className="text-sm text-ink-dim py-8 text-center border-t border-line-faint">No API keys yet. Create one to connect an MCP client.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-dim uppercase tracking-wide">
                    <th className="pb-2 pr-3 font-medium">Name</th>
                    <th className="pb-2 pr-3 font-medium">Prefix</th>
                    <th className="pb-2 pr-3 font-medium">Scope</th>
                    <th className="pb-2 pr-3 font-medium">Last used</th>
                    <th className="pb-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} className="border-b border-line-faint">
                      <td className="py-3 pr-3 font-medium text-ink">{k.name}</td>
                      <td className="py-3 pr-3">
                        <span className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-faint bg-sunken border border-line-faint rounded-control px-2 py-0.5">
                          {k.prefix}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => copy(k.prefix)}
                            title="Copy prefix"
                            style={{ minHeight: 0 }}
                            className="h-4 w-4 min-w-4 p-0 text-ink-dim hover:bg-transparent hover:text-accent-text"
                          >
                            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          </Button>
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        <Badge tone="neutral" size="md">{k.scopes}</Badge>
                      </td>
                      <td className="py-3 pr-3 text-xs text-ink-dim">{fmt(k.last_used_at)}</td>
                      <td className="py-3 text-right">
                        <Button variant="dangerGhost" size="sm" onClick={() => revokeKey(k.id, k.name)}>Revoke</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <div className="mt-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="text-sm font-semibold text-ink">Connect an MCP client</h2>
                <p className="text-xs text-ink-dim mt-0.5">Paddock serves a Streamable HTTP MCP server. Coding agents can use it to control the fleet — list/start/stop PADs, read & write workspace files, manage backups, view configs and logs, and run in-container commands.</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowUrlNote((v) => !v)}
                title="Why does the URL change?"
                className={cx(
                  'shrink-0 rounded-pill gap-1',
                  showUrlNote && 'bg-accent-soft text-accent-text border-accent-line'
                )}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
                Info
              </Button>
            </div>
            {showUrlNote && (
              <div className="mb-5 border border-line bg-sunken rounded-card p-3.5 text-xs text-ink-faint leading-relaxed">
                <p className="font-medium text-ink mb-1">About the server URL</p>
                The URL in the snippets below always matches the address you are currently using to reach Paddock. If you opened it through <code className="text-ink-muted">localhost</code>, the snippets will say <code className="text-ink-muted">localhost</code> — that only works for clients running on this same machine. To let clients on other machines connect, open Paddock via its LAN address or hostname instead and the snippets update automatically.
              </div>
            )}
            <ol className="text-sm text-ink-muted space-y-1.5 list-decimal list-inside mb-5">
              <li>Create an API key with the form above — it is shown only once.</li>
              <li>Add the server to your client config using the matching snippet below.</li>
              <li>Every request authenticates with the key as a Bearer token.</li>
            </ol>
            <div className="space-y-4">
              <Snippet
                label="Generic MCP clients — Claude Code, Cursor, Cline, etc. (add to the mcpServers block)"
                code={`{
  "mcpServers": {
    "paddock": {
      "type": "http",
      "url": "${window.location.origin}/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`}
              />
              <Snippet
                label="opencode (opencode.json)"
                code={`{
  "mcp": {
    "paddock": {
      "type": "remote",
      "url": "${window.location.origin}/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}`}
              />
              <Snippet
                label="Test the endpoint with curl (replace YOUR_API_KEY)"
                code={`curl -X POST ${window.location.origin}/mcp \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'`}
              />
            </div>
          </div>
          </>
        )}

        {tab === 'users' && (
          <Card className="p-5">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-sm font-semibold text-ink">Users</h2>
                <p className="text-xs text-ink-dim mt-0.5">People who can sign in to this dashboard.</p>
              </div>
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  setUsersError(''); setUsernameNote('')
                  setNewUser({ username: '', password: '', role: 'user' })
                  setShowCreate(true)
                }}
                className="whitespace-nowrap"
              >
                + Create User
              </Button>
            </div>

            {usersLoading ? (
              <div className="text-ink-dim text-sm py-8 text-center">Loading users…</div>
            ) : users.length === 0 ? (
              <div className="text-ink-dim text-sm py-8 text-center">No users yet.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-xs text-ink-dim uppercase tracking-wide">
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
                      <tr key={u.id} className="border-b border-line-faint text-ink-muted">
                        <td className="py-3 pr-4 font-medium text-ink">{u.username}</td>
                        <td className="py-3 pr-4 text-ink-faint">{u.email || '—'}</td>
                        <td className="py-3 pr-4">
                          <Badge tone={u.role === 'admin' ? 'brand' : 'neutral'} size="md">
                            {u.role}
                          </Badge>
                        </td>
                        <td className="py-3 pr-4">{u.agent_count}</td>
                        <td className="py-3 pr-4 text-ink-faint">{u.created_at ? new Date(u.created_at + 'Z').toLocaleDateString() : '—'}</td>
                        <td className="py-3">
                          <div className="flex gap-2 justify-end">
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={() => { setUsersError(''); setResetPwUser(u) }}
                            >
                              Reset PW
                            </Button>
                            {u.role !== 'admin' && (
                              <Button variant="dangerGhost" size="sm" onClick={() => deleteUser(u.id)}>
                                Delete
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        )}
      </div>

      {revealed && (
        <Modal
          open
          title="API key created"
          onClose={() => setRevealed(null)}
          width="max-w-lg"
        >
          <p className="text-sm text-ink-faint mb-4">Copy this key now — you will not be able to see it again.</p>
          <div className="flex gap-2 mb-4">
            <code className="flex-1 px-3 py-2.5 bg-sunken border border-line rounded-control text-xs text-success font-mono break-all">{revealed.key}</code>
            <Button
              variant="primary"
              size="lg"
              className="whitespace-nowrap"
              onClick={() => { copy(revealed.key); setCopied(true) }}
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="text-xs font-medium text-ink-muted mb-2">Client config for “{revealed.name}”</p>
          <pre className="bg-sunken border border-line rounded-card p-3 text-[11px] text-ink-muted overflow-x-auto mb-4">{`{
  "mcpServers": {
    "paddock": {
      "type": "http",
      "url": "${window.location.origin}/mcp",
      "headers": { "Authorization": "Bearer ${revealed.key}" }
    }
  }
}`}</pre>
          <Button variant="primary" size="lg" block onClick={() => setRevealed(null)}>Done</Button>
        </Modal>
      )}

      {showCreate && (
        <Modal
          open
          title="Create User"
          onClose={() => { setShowCreate(false); setUsersError(''); setUsernameNote('') }}
        >
          <p className="text-sm text-ink-faint mb-4">Add a new person who can sign in to this dashboard.</p>
          {usersError && <ErrorBanner>{usersError}</ErrorBanner>}
          <form onSubmit={(e) => { e.preventDefault(); createUser() }} className="space-y-4">
            <Field
              label="Username"
              labelVariant="compact"
              hint={usernameError ? undefined : 'Letters and numbers only, 3–32 characters.'}
              error={usernameError || undefined}
            >
              <Input
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
                invalid={!!usernameError}
              />
            </Field>
            <Field label="Password" hint="At least 4 characters." labelVariant="compact">
              <Input
                type="password"
                value={newUser.password}
                onChange={(e) => { setUsersError(''); setNewUser((u) => ({ ...u, password: e.target.value })) }}
                placeholder="Password"
                autoComplete="new-password"
              />
            </Field>
            <Field label="Role" hint="Admins can manage users, agents, and the vault." labelVariant="compact">
              <Select value={newUser.role} onChange={(e) => setNewUser((u) => ({ ...u, role: e.target.value }))}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>
            {/* Strategy (a): the submit button stays INSIDE the form, so
                Enter-to-submit works without a form= attribute. */}
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" size="lg" className="flex-1" onClick={() => { setShowCreate(false); setUsersError(''); setUsernameNote('') }}>Cancel</Button>
              <Button type="submit" variant="primary" size="lg" disabled={!canCreateUser} className="flex-1">Create User</Button>
            </div>
          </form>
        </Modal>
      )}

      {passwordPopup && role === 'admin' && !resetPwUser && (
        <Modal title={usersReadError ? 'Could not load this user' : 'Loading user…'} onClose={() => closePassword()}>
          {usersReadError ? <><p>{usersReadError}</p><Button onClick={loadUsers}>Retry</Button></> : 'Loading authorized user records…'}
        </Modal>
      )}
      {resetPwUser && (
        <Modal
          open
          title="Reset Password"
          onClose={() => setResetPwUser(null)}
        >
          <p className="text-sm text-ink-faint mb-4">
            {resetPwUser.id === userId ? `Set a new password for your account.` : `Set a new password for ${resetPwUser.username}.`}
          </p>
          {usersError && <ErrorBanner>{usersError}</ErrorBanner>}
          <form onSubmit={(e) => { e.preventDefault(); resetUserPassword() }} className="space-y-4">
            {resetPwUser.id === userId && (
              <Field label="Current password" hint="Confirm your current password to change your own password." labelVariant="compact">
                <Input
                  type="password"
                  value={resetCurrentPassword}
                  onChange={(e) => { setUsersError(''); setResetCurrentPassword(e.target.value) }}
                  placeholder="Current password"
                  autoFocus
                  autoComplete="current-password"
                />
              </Field>
            )}
            <Field label="New password" hint="At least 4 characters." labelVariant="compact">
              <Input
                type="password"
                value={resetPassword}
                onChange={(e) => { setUsersError(''); setResetPassword(e.target.value) }}
                placeholder="New password"
                autoFocus={resetPwUser.id !== userId}
                autoComplete="new-password"
              />
            </Field>
            {/* Strategy (a): the submit button stays INSIDE the form. */}
            <div className="flex gap-2 pt-4">
              <Button variant="ghost" size="lg" className="flex-1" onClick={() => setResetPwUser(null)}>Cancel</Button>
              <Button type="submit" variant="primary" size="lg" className="flex-1">Reset</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  )
}
