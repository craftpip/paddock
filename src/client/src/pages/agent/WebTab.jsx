import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import { webUrlForPort } from '../../lib/web'
import CommandModal from '../../components/CommandModal'

function randomPassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = new Uint32Array(16)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => chars[n % chars.length]).join('')
}

/** Publish / unpublish the agent's built-in web app on a host port. Every
 *  change runs an SSE job (like Settings) and streams it in the Console popup. */
export default function WebTab({ agent }) {
  const confirm = useConfirm()
  const toast = useToast()
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
    setPortDraft(prev => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
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
        setData({ ...data, extraPorts: d.extraPorts })
        setPortDirty(false)
        toast.success('Additional ports applied')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update additional ports')
      setSaving(false)
    }
  }

  function renderPortsSection() {
    return (
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Additional ports</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Host → container TCP port mappings, independent of the web app and SSH port. Applying changes recreates the container.
          </p>
        </div>

        {data.networkMode && portDraft.length > 0 && (
          <div className="mt-3 rounded-lg bg-warning-soft border border-warning-line/70 px-3 py-2 text-xs text-warning">
            This agent joins <code className="text-ink">{data.networkMode}</code>'s network — Docker can't publish ports on it. Remove the extra ports or clear the network override in Settings.
          </div>
        )}

        <div className="mt-4 space-y-3">
          {portDraft.length === 0 && (
            <p className="text-xs text-ink-dim">No additional ports.</p>
          )}
          {portDraft.map((p, i) => (
            <div key={i} className="flex items-end gap-2 rounded-lg bg-sunken border border-line-faint p-3">
              <div className="w-40">
                <label className="block text-xs text-ink-dim mb-1">Host port</label>
                <input type="number" min="1" max="65535" value={p.host}
                       onChange={(e) => setPort(i, { host: e.target.value })}
                       className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                {portErrors[i].host && <p className="text-xs text-danger mt-1">{portErrors[i].host}</p>}
              </div>
              <div className="w-40">
                <label className="block text-xs text-ink-dim mb-1">Container port</label>
                <input type="number" min="1" max="65535" value={p.container}
                       onChange={(e) => setPort(i, { container: e.target.value })}
                       className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                {portErrors[i].container && <p className="text-xs text-danger mt-1">{portErrors[i].container}</p>}
              </div>
              <button type="button"
                      onClick={() => { setPortDraft(prev => prev.filter((_, idx) => idx !== i)); setPortDirty(true) }}
                      className="px-2 py-2 bg-raised hover:bg-raised-hover text-ink-dim rounded-lg text-xs shrink-0"
                      title="Remove port">✕</button>
            </div>
          ))}

          <button type="button"
                  onClick={() => { setPortDraft(prev => [...prev, { host: '', container: '' }]); setPortDirty(true) }}
                  disabled={saving || !!data.networkMode}
                  className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                  title={data.networkMode ? 'Not available while joining a network peer' : 'Add a port'}>
            + Add port
          </button>

          {portHasErrors && (
            <p className="text-xs text-danger">Fix the invalid port fields before saving.</p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handlePortsSave}
              disabled={saving || !portDirty || portHasErrors || !!data.networkMode}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
              title={data.networkMode ? 'Clear the network override in Settings to publish ports' : 'Apply port changes'}>
              Apply ports & recreate
            </button>
            {portDirty && !saving && (
              <span className="text-xs text-ink-dim">Unsaved port changes</span>
            )}
          </div>
        </div>
      </section>
    )
  }

  if (!data) {
    return (
      <div className="max-w-3xl">
        {loadError ? <p className="text-danger text-sm">{loadError}</p> : <p className="text-ink-dim text-sm">Loading…</p>}
      </div>
    )
  }

  if (!data.webApp) {
    return (
      <div className="max-w-3xl space-y-6">
        <section className="bg-panel/60 border border-line rounded-xl p-5">
          <h3 className="text-sm font-medium text-ink-muted">Web app</h3>
          <p className="text-xs text-ink-dim mt-2 max-w-md">
            This agent type doesn't ship a built-in web app, so there's nothing to publish.
          </p>
        </section>

        {renderPortsSection()}
      </div>
    )
  }

  const active = data.active
  const webApp = data.webApp
  const viaDoor = !!data.networkMode
  const accessUrl = data.webService ? webUrlForPort(data.webService.hostPort) : ''
  const published = (data.actualPorts || []).find(
    (p) => p.container === `${webApp.containerPort}/tcp` && p.host,
  )
  const live = active && published && published.host === data.webService.hostPort

  return (
    <div className="max-w-3xl space-y-6">
      {loadError && <p className="text-danger text-sm">{loadError}</p>}

      {/* Published via a forwarding door when routed through a network peer */}
      {viaDoor && (
        <section className="bg-panel/60 border border-line rounded-xl p-5">
          <h3 className="text-sm font-medium text-ink-muted">Published via a forwarding door</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-lg">
            This agent routes through <code className="text-ink">{data.networkMode}</code> (
            <code className="text-ink">network_mode: container:</code>), so Docker can't publish ports on
            it. The web app is exposed through a small <code className="text-ink">socat</code> door
            container on <code className="text-ink">{data.networkMode}</code>'s network that forwards to
            it — {data.networkMode} and its other tenants stay untouched.
          </p>
        </section>
      )}

      {/* Status */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">{webApp.label}</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              {active
                ? `Published at ${accessUrl}${data.passwordConfigured ? ' — password protected' : ''}.`
                : 'Not published. Pick a host port and apply to make it reachable.'}
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
      </section>

      {active ? (
        <>
          {/* Running service */}
          <section className="bg-panel/60 border border-line rounded-xl p-5 space-y-4">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              {[
                ['Host port', data.webService.hostPort],
                ['Container port', data.webService.containerPort],
                ['Auth', data.passwordConfigured ? 'password set' : 'none'],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-ink-dim">{k}</dt>
                  <dd className="text-ink font-mono text-xs mt-0.5 break-all">{v}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-3">
              <a
                href={accessUrl}
                target="_blank"
                rel="noreferrer"
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-accent-ink rounded-lg text-xs font-medium transition-colors"
              >
                Open {webApp.label}
              </a>
              <button
                onClick={handleApply}
                disabled={saving}
                className="px-3 py-1.5 bg-danger hover:bg-danger disabled:opacity-50 text-danger-ink rounded-lg text-xs font-medium transition-colors"
              >
                Unpublish
              </button>
            </div>
          </section>
        </>
      ) : (
        <>
          {/* Publish form */}
          <section className="bg-panel/60 border border-line rounded-xl p-5 space-y-4">
            <h3 className="text-sm font-medium text-ink-muted">Publish</h3>
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
          </section>
        </>
      )}

      {modal && (
        <CommandModal
          key={modal.key}
          name={agent.name}
          title={modal.title}
          onDone={modal.onDone}
          onClose={closeModal}
        />
      )}

      {renderPortsSection()}
    </div>
  )
}
