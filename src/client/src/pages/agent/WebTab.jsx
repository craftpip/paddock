import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { useAgents } from '../../stores/agents'
import { webUrlForPort } from '../../lib/web'
import CommandModal from '../../components/CommandModal'

function randomPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = new Uint32Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => chars[n % chars.length]).join('')
}

/** Publish the agent's built-in web app, expose OpenSSH, and manage extra
 *  TCP port mappings. Every change runs an SSE job (like Settings) and streams
 *  it in the Console popup. */
export default function WebTab({ agent, run, connected, expandTerminal }) {
  const confirm = useConfirm()
  const toast = useToast()
  const updateAgentStatus = useAgents((s) => s.updateAgentStatus)
  const fetchAgents = useAgents((s) => s.fetchAgents)
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [startBusy, setStartBusy] = useState(false)
  const [modal, setModal] = useState(null)
  const [hostPort, setHostPort] = useState('')
  const [containerPort, setContainerPort] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [portDraft, setPortDraft] = useState([])
  const [portDirty, setPortDirty] = useState(false)
  const [sshPort, setSshPort] = useState('')
  const [sshCport, setSshCport] = useState('22')
  const [sshPassword, setSshPassword] = useState('')
  const [showSshPw, setShowSshPw] = useState(false)
  function refresh() {
    api(`/api/agents/${agent.name}/web`)
      .then((d) => {
        setData(d)
        setLoadError('')
        if (d && d.webApp) {
          setContainerPort(
            d.draft?.webContainerPort && d.webApp.containerPortEditable !== false
              ? d.draft.webContainerPort
              : String(d.webApp.containerPort),
          )
          setHostPort(d.draft?.webHostPort || d.webService?.hostPort || '')
        }
        setPortDraft((d.extraPorts || []).map((p) => ({ ...p })))
        setPortDirty(false)
        setSshPort(d.draft?.sshHostPort || d.sshPort || '')
        setSshCport(d.draft?.sshContainerPort || d.sshContainerPort || '22')
        setSshPassword('')
        setShowSshPw(false)
      })
      .catch((err) => setLoadError(err.error || err.message || 'Failed to load web config'))
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.name])

  function closeModal() {
    setModal(null)
    setSaving(false)
    refresh()
    fetchAgents()
  }

  async function handleApply() {
    const turningOn = !data?.active
    const ok = await confirm({
      title: turningOn ? 'Publish web app' : 'Unpublish web app',
      message: turningOn
        ? `Publish the web app on host port ${hostPort || '…'}?${
            data.networkMode
              ? ` It will be exposed via a forwarding door on ${data.networkMode}'s network.`
              : ' The container is recreated and the server starts inside it.'
          }`
        : `Stop publishing the web app on host port ${data.webService?.hostPort}? The container is recreated without the port and the server stops.`,
      danger: !turningOn,
      confirmText: turningOn ? 'Publish & recreate' : 'Unpublish & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    try {
      const body = turningOn
        ? { active: true, hostPort, containerPort: parseInt(containerPort, 10) || undefined, password }
        : { active: false }
      await api(`/api/agents/${agent.name}/web`, { method: 'POST', body })
      setModal({
        key: `web-${Date.now()}`,
        title: turningOn ? `Publishing web app for ${agent.name}` : `Unpublishing web app for ${agent.name}`,
        onDone: () => {
          refresh()
          toast.success(turningOn ? 'Web app published' : 'Web app unpublished')
        },
      })
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to apply web settings')
      setSaving(false)
    }
  }

  /** Paste the console's start command into the docked terminal (CommandsPane
   *  rule: actions run as commands, never a backend action API). The command
   *  is built server-side from the driver's startCommand with the current
   *  draft container port + password, so the user can try the console without
   *  a recreate. */
  async function startInTerminal() {
    if (!connected || startBusy || !data?.webApp?.startable) return
    setStartBusy(true)
    try {
      // The terminal auto-collapses in non-commands modes, and the flush
      // poll that would deliver a queued command only runs while expanded —
      // a collapsed terminal silently swallows the paste. Pop it open first.
      expandTerminal?.()
      // Published console: the API already carries the live start command (real
      // password baked in). Unpublished: build one from the draft port/password.
      let cmd = data.active ? data.startCommand : ''
      if (!cmd) {
        const q = new URLSearchParams()
        if (containerPort) q.set('containerPort', containerPort)
        if (password) q.set('password', password)
        const d = await api(`/api/agents/${agent.name}/web?${q}`)
        cmd = d && d.startCommand
      }
      if (!cmd) throw new Error('No start command for this console')
      run(cmd)
      toast.success(`Pasted "${data.webApp.label}" start command into the terminal`)
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to build the start command')
    } finally {
      setStartBusy(false)
    }
  }

  // ── Additional ports (plan 28) ────────────────────────────
  function setPort(i, patch) {
    setPortDraft((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
    setPortDirty(true)
  }

  function portIssue(n) {
    const v = String(n ?? '').trim()
    if (!v) return 'Port is required'
    if (!/^\d+$/.test(v) || +v < 1 || +v > 65535) return 'Must be an integer 1–65535'
    return ''
  }

  const portErrors = portDraft.map((p) => portIssue(p.host))
  const portHasErrors = portErrors.some(Boolean)

  async function handlePortsSave() {
    if (portHasErrors) {
      toast.error('Fix the highlighted port fields before saving')
      return
    }
    const ports = portDraft
      .filter((p) => p.host && String(p.host).trim())
      .map((p) => ({ host: String(p.host).trim(), container: String(p.container).trim() }))
    const ok = await confirm({
      title: 'Apply additional ports',
      message: ports.length
        ? `This will stop and recreate ${agent.name} with ${ports.length} additional port mapping${ports.length === 1 ? '' : 's'}.\n\n${ports.map((p) => `${p.host} → ${p.container}`).join('\n')}`
        : `This will stop and recreate ${agent.name} to remove all additional ports.`,
      confirmText: 'Apply & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/ports`, { method: 'POST', body: { extraPorts: ports } })
      if (d && d.streaming) {
        setModal({
          key: `ports-${Date.now()}`,
          title: `Applying additional ports for ${agent.name}`,
          onDone: () => {
            refresh()
            toast.success('Additional ports applied')
          },
        })
      } else {
        refresh()
        toast.success('Additional ports applied')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update additional ports')
      setSaving(false)
    }
  }

  // ── Expose OpenSSH (create parity) ────────────────────────

  const sshEnabled = !!data?.sshPort
  const sshCportEffective = data?.sshContainerPort || '22'

  async function handleSshSave() {
    const on = !sshEnabled
    if (on && sshPort.trim() && portIssue(sshPort)) {
      toast.error(portIssue(sshPort))
      return
    }
    if (on && sshCport.trim() && portIssue(sshCport)) {
      toast.error(portIssue(sshCport))
      return
    }
    const port = on ? sshPort.trim() : ''
    const cport = on ? sshCport.trim() || '22' : ''
    const ok = await confirm({
      title: on ? 'Expose OpenSSH' : 'Remove SSH access',
      message: on
        ? `This will stop and recreate ${agent.name} to publish the container's SSH server (port ${cport} inside) on host port ${
            port || 'the next free one (43817+)'
          }.${sshPassword.trim() ? ' A new root/SSH password is set.' : ' The current root password is kept.'}`
        : `This will stop and recreate ${agent.name} to remove its published SSH port.`,
      confirmText: on ? 'Expose & recreate' : 'Remove & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const body = { sshEnabled: on, sshPort: port }
      if (on) {
        if (cport !== sshCportEffective) body.sshContainerPort = cport
        if (sshPassword.trim()) body.sshPassword = sshPassword.trim()
      }
      const d = await api(`/api/agents/${agent.name}/settings`, {
        method: 'POST',
        body,
      })
      if (d && d.streaming) {
        setModal({
          key: `ssh-${Date.now()}`,
          title: on ? `Exposing SSH for ${agent.name}` : `Removing SSH from ${agent.name}`,
          onDone: () => {
            refresh()
            toast.success(on ? 'SSH exposed' : 'SSH removed')
          },
        })
      } else {
        refresh()
        toast.success(on ? 'SSH exposed' : 'SSH removed')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update SSH')
      setSaving(false)
    }
  }

  if (!data) {
    return (
      <div className="max-w-3xl">
        {loadError ? <p className="text-danger text-sm">{loadError}</p> : <p className="text-ink-dim text-sm">Loading…</p>}
      </div>
    )
  }

  const active = data.active
  const webApp = data.webApp
  const startable = !!webApp && webApp.startable !== false && !!run
  const viaDoor = !!data.networkMode
  const accessUrl = data.webService ? webUrlForPort(data.webService.hostPort, data.authToken || '') : ''
  const publishedPort = (data.webService && data.webService.containerPort) || webApp?.containerPort
  const published = (data.actualPorts || []).find(
    (p) => p.container === `${publishedPort}/tcp` && p.host,
  )
  const live = active && published && published.host === data.webService.hostPort

  return (
    <div className="max-w-3xl space-y-6">
      {loadError && <p className="text-danger text-sm">{loadError}</p>}

      {/* Web app */}
      {webApp ? (
        <>
          {/* Published via a forwarding door when routed through a network peer */}
          {viaDoor && (
            <section className="bg-panel/60 border border-line rounded-xl p-5">
              <h3 className="text-sm font-medium text-ink-muted">Published via a forwarding door</h3>
              <p className="text-xs text-ink-dim mt-1 max-w-lg">
                This agent routes through <code className="text-ink">{data.networkMode}</code> (
                <code className="text-ink">network_mode: container:</code>), so it shares that container's
                network stack. All published ports (web app, SSH, additional ports) are exposed through a
                small <code className="text-ink">socat</code> door container on{' '}
                <code className="text-ink">{data.networkMode}</code>'s network that forwards to it —{' '}
                {data.networkMode} and its other tenants stay untouched.
              </p>
            </section>
          )}

          {/* Peer-mode collision — fixed container port already bound on the same door */}
          {data.collision && (
            <section className="bg-warning-soft border border-warning-line/40 rounded-xl p-4">
              <h3 className="text-sm font-medium text-warning">Container port collision</h3>
              <p className="text-xs text-ink-dim mt-1 max-w-lg">
                This console listens on a fixed container port ({webApp.containerPort}) that can't be changed, and{' '}
                <code className="text-ink">{data.collision.name}</code> on the same network already publishes it
                (host port <code className="text-ink">{data.collision.hostPort}</code>). Two agents sharing a
                network can't bind the same container port — unpublish one of them before recreating this one.
              </p>
            </section>
          )}

          {/* Status + publish form / running service — one card */}
          <section className="bg-panel/60 border border-line rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h3 className="text-sm font-medium text-ink-muted">{webApp.label}</h3>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  {active ? (
                    <>
                      Published at{' '}
                      <a
                        href={accessUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-accent-text hover:underline break-all"
                      >
                        {accessUrl}
                      </a>
                      {data.passwordConfigured ? ' — password protected' : ''}.
                    </>
                  ) : (
                    'Not published. Pick a host port and apply to make it reachable.'
                  )}
                </p>
                {webApp.docs && (
                  <a
                    href={webApp.docs}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-accent-text hover:underline inline-block mt-2"
                  >
                    Docs ↗
                  </a>
                )}
              </div>
              {active && (
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                    live ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'
                  }`}
                >
                  {live ? '● Live' : '○ Published — waiting for server'}
                </span>
              )}
            </div>

            {active ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-line/60">
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={accessUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-accent-ink rounded-lg text-xs font-medium transition-colors"
                    >
                      Open {webApp.label}
                    </a>
                    {startable && (
                      <button
                        onClick={startInTerminal}
                        disabled={!connected || startBusy}
                        title={connected ? `Run ${webApp.label} in the docked terminal` : 'Waiting for the terminal to connect'}
                        className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                      >
                        {startBusy ? 'Building…' : 'Start in terminal'}
                      </button>
                    )}
                    <span className="text-xs text-ink-dim whitespace-nowrap">
                      <span className="font-mono text-ink">{data.webService.hostPort}</span>
                      <span className="text-ink-faint mx-1">→</span>
                      <span className="font-mono text-ink">{data.webService.containerPort}</span>
                      <span className="text-ink-faint mx-1.5">·</span>
                      {data.passwordConfigured ? 'password protected' : 'no auth'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-ink-dim">Published</span>
                    <button
                      role="switch"
                      aria-checked={active}
                      onClick={handleApply}
                      disabled={saving}
                      title="Turn off to unpublish the web app (the form comes back pre-filled)"
                      className="relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 bg-accent"
                    >
                      <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform translate-x-4" />
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <label className="block">
                    <span className="text-xs text-ink-dim">Host port *</span>
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={hostPort}
                      onChange={(e) => setHostPort(e.target.value)}
                      disabled={saving}
                      placeholder="e.g. 8081"
                      className="mt-1 w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line disabled:opacity-50"
                    />
                  </label>
                  <label className="block">
                    <span className="text-xs text-ink-dim">
                      Container port{webApp.containerPortEditable === false ? ' (fixed)' : ''}
                    </span>
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={containerPort}
                      onChange={(e) => setContainerPort(e.target.value)}
                      disabled={saving}
                      readOnly={webApp.containerPortEditable === false}
                      title={webApp.containerPortEditable === false ? `Fixed — ${webApp.label} always listens on ${webApp.containerPort} inside the container` : ''}
                      className="mt-1 w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line disabled:opacity-50"
                    />
                    {webApp.containerPortEditable === false && (
                      <span className="block text-xs text-ink-dim mt-1">
                        Fixed — {webApp.label} always listens on {webApp.containerPort} inside.
                      </span>
                    )}
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs text-ink-dim">
                    {webApp.auth?.label || 'Password'} ({webApp.auth?.required ? 'required' : 'optional'})
                  </span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={saving}
                      placeholder={webApp.auth?.required ? 'Required to bind outside loopback' : 'Leave empty to keep the current password'}
                      className="w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line disabled:opacity-50"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPw((v) => !v)}
                      disabled={saving}
                      className="px-2 py-2 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                      title={showPw ? 'Hide password' : 'Show password'}
                    >
                      {showPw ? 'Hide' : 'Show'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPassword(randomPassword())}
                      disabled={saving}
                      className="px-2 py-2 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                      title="Generate a random password"
                    >
                      Generate
                    </button>
                  </div>
                  {webApp.auth?.hint && <span className="block text-xs text-ink-dim mt-1">{webApp.auth.hint}</span>}
                </label>
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleApply}
                    disabled={saving || !hostPort}
                    className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
                  >
                    {saving ? 'Applying…' : 'Publish & recreate'}
                  </button>
                  {startable && (
                    <button
                      onClick={startInTerminal}
                      disabled={!connected || startBusy}
                      title={connected ? `Run ${webApp.label} in the docked terminal (no recreate)` : 'Waiting for the terminal to connect'}
                      className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                    >
                      {startBusy ? 'Building…' : 'Start in terminal'}
                    </button>
                  )}
                </div>
                {startable && (
                  <p className="text-xs text-ink-dim">
                    Prefer to try it first? "Start in terminal" pastes the launch command into the docked terminal
                    without recreating the container.
                  </p>
                )}
              </>
            )}
          </section>
        </>
      ) : (
        <section className="bg-panel/60 border border-line rounded-xl p-5">
          <h3 className="text-sm font-medium text-ink-muted">Web app</h3>
          <p className="text-xs text-ink-dim mt-2 max-w-md">
            This agent type doesn't ship a built-in web app. Use the port mappings below to expose anything
            running inside the container.
          </p>
        </section>
      )}

      {/* Expose OpenSSH */}
      <section className="bg-panel/60 border border-line rounded-xl p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Expose OpenSSH on a host port</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Publishes the container's SSH server on a host port. The container
              port defaults to 22 (where sshd listens) — pick a distinct one for
              agents that share a network namespace, since they can't ALL bind
              port 22. Leave the host port empty to auto-allocate one (starting at 43817). Applying changes recreates the container.
            </p>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              {sshEnabled ? (
                <>
                  Published at host <span className="font-mono text-ink">{data.sshPort}</span>
                  {' → '}
                  container <span className="font-mono text-ink">{sshCportEffective}</span>
                  {' — '}root login.
                </>
              ) : (
                'Not exposed. Fill in the fields and apply to make it reachable.'
              )}
            </p>
          </div>
        </div>

        {sshEnabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-line/60">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs text-ink-dim whitespace-nowrap">
                <span className="font-mono text-ink">{data.sshPort}</span>
                <span className="text-ink-faint mx-1">→</span>
                <span className="font-mono text-ink">{sshCportEffective}</span>
                <span className="text-ink-faint mx-1.5">·</span>
                root login
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-dim">Exposed</span>
              <button
                role="switch"
                aria-checked={sshEnabled}
                onClick={handleSshSave}
                disabled={saving}
                title="Turn off to stop publishing SSH (the form comes back pre-filled)"
                className="relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 bg-accent"
              >
                <span className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform translate-x-4" />
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="text-xs text-ink-dim">Host port</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={sshPort}
                  onChange={(e) => setSshPort(e.target.value)}
                  disabled={saving}
                  placeholder="auto (43817+)"
                  className="mt-1 w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono disabled:opacity-50"
                />
                {sshPort.trim() && portIssue(sshPort) && (
                  <span className="block text-xs text-danger mt-1">{portIssue(sshPort)}</span>
                )}
              </label>
              <label className="block">
                <span className="text-xs text-ink-dim">Container port (sshd in the container)</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={sshCport}
                  onChange={(e) => setSshCport(e.target.value)}
                  disabled={saving}
                  placeholder="22"
                  className="mt-1 w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono disabled:opacity-50"
                />
                {sshCport.trim() && portIssue(sshCport) && (
                  <p className="text-xs text-danger mt-1">{portIssue(sshCport)}</p>
                )}
                {!sshCport.trim() && (
                  <p className="text-xs text-ink-dim mt-1">Empty = 22 (the sshd default).</p>
                )}
              </label>
            </div>

            <label className="block">
              <span className="text-xs text-ink-dim">Root / SSH password (optional)</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type={showSshPw ? 'text' : 'password'}
                  value={sshPassword}
                  onChange={(e) => setSshPassword(e.target.value)}
                  disabled={saving}
                  placeholder="Leave empty to keep the current password"
                  className="w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => setShowSshPw((v) => !v)}
                  disabled={saving}
                  className="px-2 py-2 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                  title={showSshPw ? 'Hide password' : 'Show password'}
                >
                  {showSshPw ? 'Hide' : 'Show'}
                </button>
                <button
                  type="button"
                  onClick={() => setSshPassword(randomPassword())}
                  disabled={saving}
                  className="px-2 py-2 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                  title="Generate a random password"
                >
                  Generate
                </button>
              </div>
              <span className="block text-xs text-ink-dim mt-1">
                This is the password for <code className="text-ink">root</code> logins via SSH. Empty keeps the current one.
              </span>
            </label>

            <div className="flex items-center gap-3">
              <button
                onClick={handleSshSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
              >
                Expose & recreate
              </button>
            </div>
          </>
        )}
      </section>

      {/* Additional ports (create-parity table) */}
      <section className="bg-raised border border-line-faint rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Additional ports</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Host → container TCP port mappings, independent of the web app and SSH port. Applying changes recreates the container.
            </p>
          </div>
        </div>

        {portDraft.length === 0 && (
          <p className="text-xs text-ink-dim">No additional ports.</p>
        )}
        {portDraft.length > 0 && (
          <div className="rounded-lg overflow-hidden border border-line-faint">
            <div className="bg-sunken text-ink-faint uppercase tracking-wider text-[11px] px-2 py-2 flex items-center gap-2 font-medium">
              <span className="flex-1 min-w-0">Host port</span>
              <span className="flex-1 min-w-0">Container port</span>
              <span className="w-7 shrink-0"></span>
            </div>
            {portDraft.map((p, i) => (
              <div key={i} className="border-t border-line-faint flex items-start gap-2 px-2 py-1.5">
                <div className="flex-1 min-w-0">
                  <input type="number" min="1" max="65535" value={p.host}
                         onChange={(e) => setPort(i, { host: e.target.value })}
                         placeholder="e.g. 9000"
                         className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                  {portErrors[i] && <p className="text-xs text-danger mt-0.5">{portErrors[i]}</p>}
                </div>
                <div className="flex-1 min-w-0">
                  <input type="number" min="1" max="65535" value={p.container}
                         onChange={(e) => setPort(i, { container: e.target.value })}
                         placeholder="e.g. 80"
                         className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                </div>
                <div className="w-7 shrink-0">
                  <button type="button" onClick={() => { setPortDraft((prev) => prev.filter((_, idx) => idx !== i)); setPortDirty(true) }}
                          className="w-7 h-7 grid place-items-center rounded-md text-ink-dim hover:text-danger hover:bg-raised transition-colors"
                          title="Remove port">✕</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <button type="button"
                onClick={() => { setPortDraft((prev) => [...prev, { host: '', container: '' }]); setPortDirty(true) }}
                disabled={saving}
                className="px-3 py-1.5 bg-raised hover:bg-raised-hover text-ink rounded-lg text-xs font-medium transition-colors">
          + Add port
        </button>
        {portHasErrors && (
          <p className="text-xs text-danger">Fix the invalid port fields.</p>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handlePortsSave}
            disabled={saving || !portDirty || portHasErrors}
            className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
            title="Apply port changes">
            Apply ports & recreate
          </button>
          {portDirty && !saving && (
            <span className="text-xs text-ink-dim">Unsaved port changes</span>
          )}
        </div>
      </section>

      {modal && (
        <CommandModal
          key={modal.key}
          name={agent.name}
          title={modal.title}
          onDone={modal.onDone}
          onClose={closeModal}
        />
      )}
    </div>
  )
}
