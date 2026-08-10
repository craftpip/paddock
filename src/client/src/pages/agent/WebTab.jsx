import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { useAgents } from '../../stores/agents'
import { webUrlForPort } from '../../lib/web'
import Tooltip from '../../components/Tooltip'
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
export default function WebTab({ agent }) {
  const confirm = useConfirm()
  const toast = useToast()
  const updateAgentStatus = useAgents((s) => s.updateAgentStatus)
  const fetchAgents = useAgents((s) => s.fetchAgents)
  const [data, setData] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [modal, setModal] = useState(null)
  const [hostPort, setHostPort] = useState('')
  const [containerPort, setContainerPort] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [portDraft, setPortDraft] = useState([])
  const [portDirty, setPortDirty] = useState(false)
  const [sshEnabled, setSshEnabled] = useState(false)
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
          setContainerPort(String(d.webApp.containerPort))
          if (d.webService) setHostPort(d.webService.hostPort)
        }
        setPortDraft((d.extraPorts || []).map((p) => ({ ...p })))
        setPortDirty(false)
        setSshEnabled(!!d.sshPort)
        setSshPort(d.sshPort || '')
        setSshCport(d.sshContainerPort || '22')
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

  const portErrors = portDraft.map((p) => ({ host: portIssue(p.host), container: portIssue(p.container) }))
  const portHasErrors = portErrors.some((e) => e.host || e.container)

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

  const sshCportEffective = data?.sshContainerPort || '22'
  const sshDirty =
    sshEnabled !== !!data?.sshPort ||
    (sshEnabled && (sshPort.trim() || '') !== (data?.sshPort || '')) ||
    (sshEnabled && (sshCport.trim() || '22') !== sshCportEffective) ||
    (sshEnabled && sshPassword.trim() !== '')

  async function handleSshSave() {
    if (sshEnabled && sshPort.trim() && portIssue(sshPort)) {
      toast.error(portIssue(sshPort))
      return
    }
    if (sshEnabled && sshCport.trim() && portIssue(sshCport)) {
      toast.error(portIssue(sshCport))
      return
    }
    const on = sshEnabled
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
                    <span className="text-xs text-ink-dim whitespace-nowrap">
                      <span className="font-mono text-ink">{data.webService.hostPort}</span>
                      <span className="text-ink-faint mx-1">→</span>
                      <span className="font-mono text-ink">{data.webService.containerPort}</span>
                      <span className="text-ink-faint mx-1.5">·</span>
                      {data.passwordConfigured ? 'password protected' : 'no auth'}
                    </span>
                  </div>
                  <button
                    onClick={handleApply}
                    disabled={saving}
                    className="px-3 py-1.5 bg-danger hover:bg-danger disabled:opacity-50 text-danger-ink rounded-lg text-xs font-medium transition-colors"
                  >
                    Unpublish
                  </button>
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
                    <span className="text-xs text-ink-dim">Container port</span>
                    <input
                      type="number"
                      min="1"
                      max="65535"
                      value={containerPort}
                      onChange={(e) => setContainerPort(e.target.value)}
                      disabled={saving}
                      className="mt-1 w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line disabled:opacity-50"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="text-xs text-ink-dim">{webApp.auth?.label || 'Password'} (optional)</span>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      type={showPw ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={saving}
                      placeholder="Leave empty for no auth"
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
                <div>
                  <button
                    onClick={handleApply}
                    disabled={saving || !hostPort}
                    className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
                  >
                    {saving ? 'Applying…' : 'Publish & recreate'}
                  </button>
                </div>
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
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Expose OpenSSH on a host port</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Publishes the container's SSH server on a host port. The container
              port defaults to 22 (where sshd listens) — pick a distinct one for
              agents that share a network namespace, since they can't ALL bind
              port 22. Leave the host port empty to auto-allocate one (starting at 43817). Applying changes recreates the container.
            </p>
            <p className="text-xs text-ink mt-1.5 font-mono">
              {data?.sshPort
                ? `Currently published: host ${data.sshPort} → container ${sshCportEffective} (root login)`
                : 'Not exposed'}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={sshEnabled}
            onClick={() => setSshEnabled(!sshEnabled)}
            disabled={saving}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${sshEnabled ? 'bg-accent' : 'bg-raised'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${sshEnabled ? 'translate-x-4' : ''}`} />
          </button>
        </div>

        {(sshEnabled || sshDirty) && (
          <div className="mt-4 space-y-4">
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
                disabled={saving || !sshDirty || (sshEnabled && ((sshPort.trim() && !!portIssue(sshPort)) || (sshCport.trim() && !!portIssue(sshCport))))}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
              >
                Apply SSH & recreate
              </button>
              {sshDirty && !saving && (
                <span className="text-xs text-ink-dim">Unsaved SSH changes</span>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Additional ports */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Additional ports</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Host → container TCP port mappings, independent of the web app and SSH port. Applying changes recreates the container.
          </p>
        </div>

        <div className="mt-4 space-y-3">
          {portDraft.length === 0 && (
            <p className="text-xs text-ink-dim">No additional ports.</p>
          )}
          {portDraft.map((p, i) => (
            <div key={i} className="space-y-1">
              <div className="flex items-center gap-3">
                <span className="w-9 shrink-0" aria-hidden />
                <label className="w-44 block text-xs text-ink-dim">Host port</label>
                <span className="w-4 shrink-0" aria-hidden />
                <label className="w-44 block text-xs text-ink-dim">Container port</label>
                <span className="w-9 shrink-0" aria-hidden />
              </div>
              <div className="flex items-center gap-3">
                {portIssue(p.host) === '' ? (
                  <Tooltip text={`Open ${webUrlForPort(p.host)} in a new tab`}>
                    <a
                      href={webUrlForPort(p.host)}
                      target="_blank"
                      rel="noreferrer"
                      className="w-9 h-9 grid place-items-center rounded-lg text-accent-text hover:bg-raised shrink-0 transition-colors"
                    >
                      ↗
                    </a>
                  </Tooltip>
                ) : (
                  <span className="w-9 shrink-0" aria-hidden />
                )}
                <input type="number" min="1" max="65535" value={p.host}
                       onChange={(e) => setPort(i, { host: e.target.value })}
                       className="w-44 bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                <span className="text-ink-faint text-xs select-none" aria-hidden>→</span>
                <input type="number" min="1" max="65535" value={p.container}
                       onChange={(e) => setPort(i, { container: e.target.value })}
                       className="w-44 bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                <Tooltip text="Remove port">
                  <button type="button"
                          onClick={() => { setPortDraft((prev) => prev.filter((_, idx) => idx !== i)); setPortDirty(true) }}
                          className="w-9 h-9 grid place-items-center rounded-lg text-ink-dim hover:text-danger hover:bg-raised shrink-0 transition-colors">✕</button>
                </Tooltip>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-9 shrink-0" aria-hidden />
                <div className="w-44">{portErrors[i].host && <p className="text-xs text-danger">{portErrors[i].host}</p>}</div>
                <span className="w-4 shrink-0" aria-hidden />
                <div className="w-44">{portErrors[i].container && <p className="text-xs text-danger">{portErrors[i].container}</p>}</div>
              </div>
            </div>
          ))}

          <button type="button"
                  onClick={() => { setPortDraft((prev) => [...prev, { host: '', container: '' }]); setPortDirty(true) }}
                  disabled={saving}
                  className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                  title="Add a port">
            + Add port
          </button>

          {portHasErrors && (
            <p className="text-xs text-danger">Fix the invalid port fields before saving.</p>
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
