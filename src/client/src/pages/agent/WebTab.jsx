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
  function refresh() {
    api(`/api/agents/${agent.name}/web`)
      .then((d) => {
        setData(d)
        setLoadError('')
        if (d && d.webApp) {
          setContainerPort(String(d.webApp.containerPort))
          if (d.webService) setHostPort(d.webService.hostPort)
        }
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
    </div>
  )
}
