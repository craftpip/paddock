import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAgents } from '../../stores/agents'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import CommandModal from '../../components/CommandModal'
import HealthCheckModal from '../../components/HealthCheckModal'

export default function SettingsTab({ agent }) {
  const navigate = useNavigate()
  const confirm = useConfirm()
  const toast = useToast()
  const updateAgentStatus = useAgents((s) => s.updateAgentStatus)
  const fetchAgents = useAgents((s) => s.fetchAgents)

  const [settings, setSettings] = useState(null)
  const [containers, setContainers] = useState([])
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [modal, setModal] = useState(null)
  const [healthModal, setHealthModal] = useState(null)
  const [healthStatus, setHealthStatus] = useState(null)
  const [healthCounts, setHealthCounts] = useState(null)
  const [healthLoading, setHealthLoading] = useState(false)
  const [healthError, setHealthError] = useState('')

  function refresh() {
    api(`/api/agents/${agent.name}/settings`)
      .then(setSettings)
      .catch((err) => setLoadError(err.error || err.message || 'Failed to load settings'))
  }

  function refreshHealth() {
    setHealthLoading(true)
    api(`/api/agents/${agent.name}/health`)
      .then((h) => {
        setHealthStatus(h.status || null)
        setHealthCounts(h.counts || null)
        setHealthError('')
      })
      .catch((err) => {
        setHealthStatus(null)
        setHealthCounts(null)
        setHealthError(err.error || err.message || 'Failed to run health check')
      })
      .finally(() => setHealthLoading(false))
  }

  useEffect(() => {
    refresh()
    refreshHealth()
    api('/api/containers')
      .then((d) => setContainers(d.containers || []))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.name])

  function closeModal() {
    setModal(null)
    setSaving(false)
    fetchAgents()
  }

  // ── Update (image refresh) ────────────────────────────────

  async function handleUpdate() {
    setSaving(true)
    let info = null
    try {
      info = await api(`/api/agents/${agent.name}/update-info`)
    } catch {
      info = null
    }
    const current = info?.currentVersion || settings?.version || 'unknown'
    const available = info?.availableVersion || 'unknown'
    const hasUpdate = info?.updateAvailable
    const ok = await confirm({
      title: 'Update container',
      message: hasUpdate
        ? `An update is available for ${agent.name}.\n\nCurrent version: ${current}\nAvailable: ${available}\n\nThis will redownload the image, rebuild it, and recreate the container. The container restarts automatically when it's done.`
        : `No update available — ${agent.name} is already on the latest version (${current}).\n\nRunning update anyway will redownload the image, rebuild it, and recreate the container.`,
      danger: false,
      confirmText: 'Update',
      cancelText: 'Cancel',
    })
    if (!ok) {
      setSaving(false)
      return
    }
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      await api(`/api/agents/${agent.name}/update`, { method: 'POST' })
      setModal({
        key: `update-${Date.now()}`,
        title: `Updating ${agent.name}`,
        onDone: () => {
          refresh()
          fetchAgents()
          toast.success('Container updated and restarted')
        },
      })
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to start update')
      setSaving(false)
    }
  }

  // ── Allow docker toggle ───────────────────────────────────

  async function handleToggleDocker() {
    const on = !settings.allowDocker
    const ok = await confirm({
      title: on ? 'Allow docker in the container' : 'Remove docker access',
      message: on
        ? `This will stop and recreate ${agent.name} to apply the change.\n\n⚠ The docker socket is host-root equivalent — ${agent.name} would be able to control the entire host.`
        : `This will stop and recreate ${agent.name} to apply the change.\n\nDocker access will be removed.`,
      danger: on,
      confirmText: on ? 'Allow docker & recreate' : 'Remove docker & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/settings`, { method: 'POST', body: { allowDocker: on } })
      if (d && d.streaming) {
        setModal({
          key: `docker-${Date.now()}`,
          title: on ? `Enabling docker for ${agent.name}` : `Removing docker access from ${agent.name}`,
          onDone: () => {
            refresh()
            fetchAgents()
            toast.success(on ? 'Docker access enabled' : 'Docker access removed')
          },
        })
      } else {
        setSettings(d)
        toast.success(on ? 'Docker access enabled' : 'Docker access removed')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update docker access')
      setSaving(false)
    }
  }

  // ── Network ───────────────────────────────────────────────

  async function handleNetworkChange(network) {
    const current = settings.network || ''
    if (network === current) return
    const ok = await confirm({
      title: network ? 'Change network' : 'Clear network override',
      message: network
        ? `This will stop and recreate ${agent.name} to route its traffic through ${network}.\n\n⚠ The agent joins the target container's network stack. If the target stops, the agent loses its network.`
        : `This will stop and recreate ${agent.name} to return it to the default network.`,
      confirmText: network ? 'Change & recreate' : 'Clear & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/settings`, { method: 'POST', body: { network } })
      if (d && d.streaming) {
        setModal({
          key: `network-${Date.now()}`,
          title: network ? `Routing ${agent.name} through ${network}` : `Returning ${agent.name} to the default network`,
          onDone: () => {
            refresh()
            fetchAgents()
            toast.success(network ? `Network set to ${network}` : 'Network override cleared')
          },
        })
      } else {
        setSettings(d)
        toast.success(network ? `Network set to ${network}` : 'Network override cleared')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update network')
      setSaving(false)
    }
  }

  // ── Danger Zone ───────────────────────────────────────────

  async function handleDelete() {
    const ok = await confirm({
      title: 'Delete container',
      message: `Permanently delete ${agent.name}, its container, and all files. This cannot be undone.`,
      danger: true,
      confirmText: 'Delete',
      cancelText: 'Cancel',
    })
    if (!ok) return
    try {
      await api(`/api/agents/${agent.name}/delete`, { method: 'POST' })
      toast.success('Agent deleted')
      navigate('/agents')
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to delete agent')
    }
  }

  // ── Stale network peer fix ────────────────────────────────

  async function handleRecreateNetwork() {
    const ok = await confirm({
      title: 'Recreate container to fix network?',
      message: `This agent routes through ${networkPeerLabel}, which has been recreated or stopped. The container can't start until it re-joins the current peer.\n\nRecreating will stop and recreate ${agent.name} so it rebinds to the current network peer. No settings change — the compose file already points at ${settings?.network || 'the peer'} by name.`,
      confirmText: 'Recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      await api(`/api/agents/${agent.name}/recreate`, { method: 'POST' })
      setModal({
        key: `recreate-${Date.now()}`,
        title: `Recreating ${agent.name}`,
        onDone: () => {
          refresh()
          fetchAgents()
          toast.success('Container recreated — network peer re-resolved')
        },
      })
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to recreate container')
      setSaving(false)
    }
  }

  // ── Container health checkup ───────────────────────────────

  async function runHealthCheck() {
    try {
      await api(`/api/agents/${agent.name}/health-check`, { method: 'POST' })
      setHealthModal({ key: `health-${Date.now()}` })
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to start health check')
    }
  }

  function openHealthCheck() {
    setHealthModal({ key: `health-${Date.now()}` })
  }

  const toggleDocker = !!settings?.allowDocker
  const currentNetwork = settings?.network || ''
  const networkHealth = settings?.networkHealth || {}
  const networkStale = networkHealth.state === 'stale'
  const networkPeerStopped = networkHealth.state === 'peer-stopped'
  const networkBroken = networkStale || networkPeerStopped
  const networkPeerLabel = networkHealth.peerName || networkHealth.peerId || currentNetwork || 'the network peer'
  const networkOptions = (containers.some((c) => c.name === currentNetwork) || !currentNetwork
    ? containers
    : [{ name: currentNetwork, image: '', state: 'missing' }, ...containers])
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="max-w-3xl space-y-6">
      {loadError && <p className="text-red-400 text-sm">{loadError}</p>}

      {/* 0. Stale network peer warning */}
      {networkBroken && (
        <section className="bg-amber-900/20 border border-amber-700/70 rounded-xl p-5">
          <h3 className="text-sm font-medium text-amber-300">
            {networkStale ? 'Network peer is stale — container can\u2019t start' : 'Network peer is stopped'}
          </h3>
          <p className="text-xs text-amber-200/90 mt-1 max-w-lg">
            {networkStale
              ? `This agent routes through ${networkPeerLabel}, which has been recreated since this container was created. Docker still points at the old (now-deleted) container, so starting fails with "No such container". This is not a Paddock issue — the peer moved.`
              : `This agent routes through ${networkPeerLabel}, which exists but is currently stopped. The agent can't start until the peer is running. Start ${networkPeerLabel} first, then recreate this agent.`}
          </p>
          {networkStale && (
            <button
              onClick={handleRecreateNetwork}
              disabled={saving}
              className="mt-3 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
            >
              Recreate to fix
            </button>
          )}
        </section>
      )}

      {/* 1. Container Info */}
      <section className="bg-slate-800/60 border border-slate-700 rounded-xl p-5">
        <h3 className="text-sm font-medium text-slate-300 mb-4">Container Info</h3>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          {[
            ['Name', agent.name],
            ['Agent type', agent.agent_type || '—'],
            ['Runtime', agent.runtime_type || 'docker'],
            ['Status', agent.status || '—'],
            ['Image', settings?.image || '—'],
            ['Version', settings?.version || '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="text-xs text-slate-500">{k}</dt>
              <dd className="text-slate-200 font-mono text-xs mt-0.5 break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* 2. Update */}
      <section className="bg-slate-800/60 border border-slate-700 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-slate-300">Update</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              Redownloads the image, rebuilds it, and recreates the container. The container restarts automatically when it's done.
            </p>
          </div>
          <button
            onClick={handleUpdate}
            disabled={saving}
            className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
          >
            Update
          </button>
        </div>
      </section>

      {/* 3. Container Health Checkup */}
      <section className="bg-slate-800/60 border border-slate-700 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-slate-300">Container Health Checkup</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              Inspects the actual Docker container against the compose file — status, restart policy, network peer, mounts, ports, env. Each check streams live with a pass/fail.
            </p>
            {healthError && <p className="text-xs text-red-400 mt-1">{healthError}</p>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {healthLoading ? (
              <span className="text-xs text-slate-500">Checking…</span>
            ) : healthStatus ? (
              <button
                onClick={openHealthCheck}
                title="Open full checkup report"
                className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
                  healthStatus === 'ok'
                    ? 'bg-emerald-900/60 text-emerald-300 hover:bg-emerald-800/60'
                    : healthStatus === 'warn'
                      ? 'bg-amber-900/60 text-amber-300 hover:bg-amber-800/60'
                      : 'bg-red-900/60 text-red-300 hover:bg-red-800/60'
                }`}
              >
                {healthStatus === 'ok'
                  ? '✓ Healthy'
                  : healthStatus === 'warn'
                    ? `~ ${healthCounts?.warn || 0} issue${healthCounts?.warn === 1 ? '' : 's'}`
                    : `✗ ${healthCounts?.error || 0} problem${healthCounts?.error === 1 ? '' : 's'}`}
              </button>
            ) : null}
            <button
              onClick={runHealthCheck}
              disabled={saving}
              className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
            >
              Run Health Check
            </button>
          </div>
        </div>
      </section>

      {/* 4. Allow docker in the container */}
      <section className="bg-slate-800/60 border border-slate-700 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-slate-300">Allow docker in the container</h3>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              Lets this agent run <code className="text-slate-400">docker</code> commands (docker CLI + host socket). Rebuilds the image if it has no docker CLI.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={toggleDocker}
            onClick={handleToggleDocker}
            disabled={saving}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${toggleDocker ? 'bg-cyan-600' : 'bg-slate-700'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${toggleDocker ? 'translate-x-4' : ''}`} />
          </button>
        </div>
        {toggleDocker && (
          <p className="mt-3 text-xs text-amber-400/90 bg-amber-900/20 border border-amber-800/60 rounded-lg px-3 py-2">
            ⚠ The docker socket is host-root equivalent. This agent can control the entire host.
          </p>
        )}
      </section>

      {/* 5. Network */}
      <section className="bg-slate-800/60 border border-slate-700 rounded-xl p-5">
        <h3 className="text-sm font-medium text-slate-300">Network</h3>
        <p className="text-xs text-slate-500 mt-1 max-w-md">
          Route this agent's traffic through another running container by joining its network namespace (e.g. gluetun for VPN).
        </p>
        <select
          value={currentNetwork}
          onChange={(e) => handleNetworkChange(e.target.value)}
          disabled={saving}
          className="mt-3 w-full sm:w-96 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-cyan-500 disabled:opacity-50"
        >
          <option value="">Default (no override)</option>
          {networkOptions.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}{c.state !== 'running' ? '  (stopped)' : ''}
            </option>
          ))}
        </select>
        <p className="mt-3 text-xs text-slate-500">
          ⚠ Joining a container's network means the agent shares its network stack. If the target stops, the agent loses its network.
        </p>
      </section>

      {/* 6. Danger Zone */}
      <section className="bg-red-950/20 border border-red-900/60 rounded-xl p-5">
        <h3 className="text-sm font-medium text-red-400">Danger Zone</h3>
        <p className="text-xs text-slate-500 mt-1 max-w-md">
          Permanently delete this agent, its container, and all files. This cannot be undone.
        </p>
        <button
          onClick={handleDelete}
          disabled={saving}
          className="mt-3 px-3 py-1.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
        >
          Delete Container
        </button>
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

      {healthModal && (
        <HealthCheckModal
          key={healthModal.key}
          name={agent.name}
          title={`Health check — ${agent.name}`}
          onDone={() => {
            refreshHealth()
            fetchAgents()
          }}
          onClose={() => setHealthModal(null)}
        />
      )}
    </div>
  )
}
