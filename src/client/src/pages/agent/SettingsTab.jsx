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
  const [hostWorkspaceRoot, setHostWorkspaceRoot] = useState('')
  const [driverInfo, setDriverInfo] = useState(null)
  const [wsEnabled, setWsEnabled] = useState(false)
  const [wsHost, setWsHost] = useState('')
  const [wsDir, setWsDir] = useState('')
  const [volDraft, setVolDraft] = useState([])
  const [volDirty, setVolDirty] = useState(false)
  const [portDraft, setPortDraft] = useState([])
  const [portDirty, setPortDirty] = useState(false)

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
    api('/api/config')
      .then((c) => {
        if (c.hostWorkspaceRoot) setHostWorkspaceRoot(c.hostWorkspaceRoot)
      })
      .catch(() => {})
    api('/api/agent-types')
      .then((d) => {
        const t = d.types?.find((x) => x.type === agent.agent_type)
        if (t) setDriverInfo(t)
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.name])

  // Sync the Workspace card with the stored mount (after settings load, and
  // whenever driver info arrives so the fixed/editable defaults are available).
  useEffect(() => {
    if (!settings) return
    const m = settings.workspaceMount
    setWsEnabled(!!m)
    setWsHost(m ? m.host : '')
    setWsDir(m ? m.container : (driverInfo?.workspaceDir || agent.workspace_dir || ''))
    // Sync the additional volumes draft once (do not clobber while editing).
    setVolDraft((settings.extraVolumes || []).map((v) => ({ ...v })))
    setVolDirty(false)
    // Sync the additional ports draft once (do not clobber while editing).
    setPortDraft((settings.extraPorts || []).map((p) => ({ ...p })))
    setPortDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, driverInfo, agent.name])

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

  // ── Custom workspace (plan 24) ────────────────────────────

  const wsCapability = driverInfo?.workspaceCapability || agent.workspace_capability || 'fixed'
  const wsHidden = wsCapability === 'none'
  const wsFixed = wsCapability === 'fixed'
  const defaultWsHost = `instances/${agent.name}/${agent.agent_type}/workspace`
  const agentDataHost = hostWorkspaceRoot
    ? `${hostWorkspaceRoot}/instances/${agent.name}/${agent.agent_type}`
    : ''
  // An empty Host field means the default `instances/…` path (shown as the
  // placeholder) is used on save — never pre-fill it, so it stays obvious
  // whether the user edited the field.
  const wsHostEff = wsEnabled ? (wsHost.trim() || defaultWsHost) : ''
  const wsBrowsable = agentDataHost && wsHostEff.startsWith(agentDataHost + '/')

  function wsHostIssue(h) {
    const v = (h || '').trim()
    if (!v) return ''
    if (v.startsWith('/')) {
      if (v === '/') return 'Cannot be the host root'
      const sys = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/home', '/root', '/opt', '/tmp', '/var/run']
      for (const s of sys) {
        if (v === s || v.startsWith(s + '/')) return `System directory (${s}) cannot be a workspace source`
      }
    } else if (!v.startsWith('instances/')) {
      return 'Must be an absolute path or start with instances/'
    }
    return ''
  }

  function wsDirIssue(d) {
    const v = (d || '').trim()
    if (!v) return ''
    if (!v.startsWith('/')) return 'Container path must be absolute'
    if (v === '/') return 'Container path cannot be /'
    const prot = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp']
    for (const p of prot) {
      if (v === p || v.startsWith(p + '/')) return `Cannot mount a workspace at the system path ${p}`
    }
    return ''
  }

  async function handleWorkspaceSave() {
    const on = wsEnabled
    const host = on ? (wsHost.trim() || defaultWsHost) : ''
    const dir = on ? wsDir.trim() : ''
    if (on) {
      const he = wsHostIssue(host)
      const de = wsDirIssue(dir)
      if (he || de) {
        toast.error(he || de)
        return
      }
    }
    const ok = await confirm({
      title: on ? 'Apply custom workspace' : 'Remove custom workspace',
      message: on
        ? `This will stop and recreate ${agent.name} to mount:\n\nHost: ${host}\nContainer: ${dir}\n\nExisting files are NOT moved — the old folder is left on disk untouched. Move files yourself before or after the change.`
        : `This will stop and recreate ${agent.name} to remove the custom workspace mount. Files are NOT deleted — the folder stays on disk.`,
      confirmText: on ? 'Apply & recreate' : 'Remove & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/settings`, {
        method: 'POST',
        body: { workspaceHost: host, workspaceDir: dir },
      })
      if (d && d.streaming) {
        setModal({
          key: `ws-${Date.now()}`,
          title: on ? `Applying custom workspace for ${agent.name}` : `Removing custom workspace from ${agent.name}`,
          onDone: () => {
            refresh()
            fetchAgents()
            toast.success(on ? 'Workspace mount applied' : 'Workspace mount removed')
          },
        })
      } else {
        setSettings(d)
        toast.success(on ? 'Workspace mount applied' : 'Workspace mount removed')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update workspace')
      setSaving(false)
    }
  }

  // ── Additional volumes (plan 28) ──────────────────────────

  const VOL_SYSTEM = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/home', '/root', '/opt', '/tmp', '/var/run']
  const VOL_PROTECTED = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp']

  function volHostIssue(h) {
    const v = (h || '').trim()
    if (!v) return 'Host source is required'
    if (v.startsWith('/')) {
      if (v === '/') return 'Cannot be the host root'
      for (const s of VOL_SYSTEM) {
        if (v === s || v.startsWith(s + '/')) return `System directory (${s}) cannot be a host source`
      }
    } else if (!v.startsWith('instances/')) {
      return 'Must be an absolute path or start with instances/'
    }
    if (v.includes(':')) return 'Host source cannot contain ":"'
    if (/['"\\]/.test(v)) return 'Quotes and backslashes not allowed'
    return ''
  }

  function volDirIssue(d) {
    const v = (d || '').trim()
    if (!v) return 'Container path is required'
    if (!v.startsWith('/')) return 'Container path must be absolute'
    if (v === '/') return 'Container path cannot be /'
    for (const p of VOL_PROTECTED) {
      if (v === p || v.startsWith(p + '/')) return `Cannot mount at the system path ${p}`
    }
    return ''
  }

  function setVol(i, patch) {
    setVolDraft(prev => prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))
    setVolDirty(true)
  }

  const volErrors = volDraft.map((v) => ({ host: volHostIssue(v.host), dir: volDirIssue(v.container) }))
  const volHasErrors = volErrors.some((e) => e.host || e.dir)

  async function handleVolumesSave() {
    if (volHasErrors) {
      toast.error('Fix the highlighted volume fields before saving')
      return
    }
    const vols = volDraft
      .filter((v) => v.host && v.host.trim() && v.container && v.container.trim())
      .map((v) => ({ host: v.host.trim(), container: v.container.trim(), readonly: !!v.readonly }))
    const ok = await confirm({
      title: 'Apply additional volumes',
      message: vols.length
        ? `This will stop and recreate ${agent.name} with ${vols.length} additional bind mount${vols.length === 1 ? '' : 's'}.\n\n${vols.map((v) => `${v.host} → ${v.container}${v.readonly ? ' (ro)' : ''}`).join('\n')}`
        : `This will stop and recreate ${agent.name} to remove all additional volumes.`,
      confirmText: 'Apply & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/settings`, { method: 'POST', body: { extraVolumes: vols } })
      if (d && d.streaming) {
        setModal({
          key: `vols-${Date.now()}`,
          title: `Applying additional volumes for ${agent.name}`,
          onDone: () => {
            refresh()
            fetchAgents()
            toast.success('Additional volumes applied')
          },
        })
      } else {
        setSettings(d)
        toast.success('Additional volumes applied')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update additional volumes')
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
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/ports`, { method: 'POST', body: { extraPorts: ports } })
      if (d && d.streaming) {
        setModal({
          key: `ports-${Date.now()}`,
          title: `Applying additional ports for ${agent.name}`,
          onDone: () => {
            refresh()
            fetchAgents()
            toast.success('Additional ports applied')
          },
        })
      } else {
        setSettings({ ...settings, extraPorts: d.extraPorts })
        setPortDirty(false)
        toast.success('Additional ports applied')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update additional ports')
      setSaving(false)
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      {loadError && <p className="text-danger text-sm">{loadError}</p>}

      {/* 0. Stale network peer warning */}
      {networkBroken && (
        <section className="bg-warning-soft border border-warning-line/70 rounded-xl p-5">
          <h3 className="text-sm font-medium text-warning">
            {networkStale ? 'Network peer is stale — container can\u2019t start' : 'Network peer is stopped'}
          </h3>
          <p className="text-xs text-warning/90 mt-1 max-w-lg">
            {networkStale
              ? `This agent routes through ${networkPeerLabel}, which has been recreated since this container was created. Docker still points at the old (now-deleted) container, so starting fails with "No such container". This is not a Paddock issue — the peer moved.`
              : `This agent routes through ${networkPeerLabel}, which exists but is currently stopped. The agent can't start until the peer is running. Start ${networkPeerLabel} first, then recreate this agent.`}
          </p>
          {networkStale && (
            <button
              onClick={handleRecreateNetwork}
              disabled={saving}
              className="mt-3 px-3 py-1.5 bg-warning hover:bg-warning disabled:opacity-50 text-warning-ink rounded-lg text-xs font-medium transition-colors"
            >
              Recreate to fix
            </button>
          )}
        </section>
      )}

      {/* 1. Container Info */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <h3 className="text-sm font-medium text-ink-muted mb-4">Container Info</h3>
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
              <dt className="text-xs text-ink-dim">{k}</dt>
              <dd className="text-ink font-mono text-xs mt-0.5 break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* 2. Update */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Update</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Redownloads the image, rebuilds it, and recreates the container. The container restarts automatically when it's done.
            </p>
          </div>
          <button
            onClick={handleUpdate}
            disabled={saving}
            className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
          >
            Update
          </button>
        </div>
      </section>

      {/* 3. Container Health Checkup */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Container Health Checkup</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Inspects the actual Docker container against the compose file — status, restart policy, network peer, mounts, ports, env. Each check streams live with a pass/fail.
            </p>
            {healthError && <p className="text-xs text-danger mt-1">{healthError}</p>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {healthLoading ? (
              <span className="text-xs text-ink-dim">Checking…</span>
            ) : healthStatus ? (
              <button
                onClick={openHealthCheck}
                title="Open full checkup report"
                className={`text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
                  healthStatus === 'ok'
                    ? 'bg-success-soft text-success hover:bg-success-soft'
                    : healthStatus === 'warn'
                      ? 'bg-warning-soft text-warning hover:bg-warning-soft'
                      : 'bg-danger-soft text-danger hover:bg-danger-soft'
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
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
            >
              Run Health Check
            </button>
          </div>
        </div>
      </section>

      {/* 4. Allow docker in the container */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Allow docker in the container</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Lets this agent run <code className="text-ink-faint">docker</code> commands (docker CLI + host socket). Rebuilds the image if it has no docker CLI.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={toggleDocker}
            onClick={handleToggleDocker}
            disabled={saving}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${toggleDocker ? 'bg-accent' : 'bg-raised'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${toggleDocker ? 'translate-x-4' : ''}`} />
          </button>
        </div>
        {toggleDocker && (
          <p className="mt-3 text-xs text-warning/90 bg-warning-soft border border-warning-line/60 rounded-lg px-3 py-2">
            ⚠ The docker socket is host-root equivalent. This agent can control the entire host.
          </p>
        )}
      </section>

      {/* 5. Network */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <h3 className="text-sm font-medium text-ink-muted">Network</h3>
        <p className="text-xs text-ink-dim mt-1 max-w-md">
          Route this agent's traffic through another running container by joining its network namespace (e.g. gluetun for VPN).
        </p>
        <select
          value={currentNetwork}
          onChange={(e) => handleNetworkChange(e.target.value)}
          disabled={saving}
          className="mt-3 w-full sm:w-96 bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line disabled:opacity-50"
        >
          <option value="">Default (no override)</option>
          {networkOptions.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}{c.state !== 'running' ? '  (stopped)' : ''}
            </option>
          ))}
        </select>
        <p className="mt-3 text-xs text-ink-dim">
          ⚠ Joining a container's network means the agent shares its network stack. If the target stops, the agent loses its network.
        </p>
      </section>

      {/* 5b. Additional volumes */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Additional volumes</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Extra host → container bind mounts beyond the data and workspace folders. Applying changes recreates the container.
            </p>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {volDraft.length === 0 && (
            <p className="text-xs text-ink-dim">No additional volumes.</p>
          )}
          {volDraft.map((v, i) => (
            <div key={i} className="space-y-3 rounded-lg bg-sunken border border-line-faint p-3">
              <div className="flex items-end gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-ink-dim mb-1">Host source</label>
                  <input type="text" value={v.host}
                         onChange={(e) => setVol(i, { host: e.target.value })}
                         className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                  {volErrors[i].host && <p className="text-xs text-danger mt-1">{volErrors[i].host}</p>}
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-ink-dim mb-1">Container path</label>
                  <input type="text" value={v.container}
                         onChange={(e) => setVol(i, { container: e.target.value })}
                         className="w-full bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                  {volErrors[i].dir && <p className="text-xs text-danger mt-1">{volErrors[i].dir}</p>}
                </div>
                <button type="button"
                        onClick={() => { setVolDraft(prev => prev.filter((_, idx) => idx !== i)); setVolDirty(true) }}
                        className="px-2 py-2 bg-raised hover:bg-raised-hover text-ink-dim rounded-lg text-xs shrink-0"
                        title="Remove volume">✕</button>
              </div>
              <label className="flex items-center gap-2 text-xs text-ink-dim cursor-pointer select-none">
                <input type="checkbox" checked={!!v.readonly}
                       onChange={(e) => setVol(i, { readonly: e.target.checked })}
                       className="w-3.5 h-3.5 accent-accent" />
                Read-only mount
              </label>
            </div>
          ))}

          <button type="button"
                  onClick={() => { setVolDraft(prev => [...prev, { host: '', container: '', readonly: false }]); setVolDirty(true) }}
                  disabled={saving}
                  className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors">
            + Add volume
          </button>

          {volHasErrors && (
            <p className="text-xs text-danger">Fix the invalid volume fields before saving.</p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handleVolumesSave}
              disabled={saving || !volDirty || volHasErrors}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
            >
              Apply volumes & recreate
            </button>
            {volDirty && !saving && (
              <span className="text-xs text-ink-dim">Unsaved volume changes</span>
            )}
          </div>
        </div>
      </section>

      {/* 5c. Additional ports */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Additional ports</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Host → container TCP port mappings, independent of the web app and SSH port. Applying changes recreates the container.
          </p>
        </div>

        {currentNetwork && portDraft.length > 0 && (
          <div className="mt-3 rounded-lg bg-warning-soft border border-warning-line/70 px-3 py-2 text-xs text-warning">
            This agent joins <code className="text-ink">{currentNetwork}</code>'s network — Docker can't publish ports on it. Remove the extra ports or clear the network override above.
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
                  disabled={saving || !!currentNetwork}
                  className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
                  title={currentNetwork ? 'Not available while joining a network peer' : 'Add a port'}>
            + Add port
          </button>

          {portHasErrors && (
            <p className="text-xs text-danger">Fix the invalid port fields before saving.</p>
          )}

          <div className="flex items-center gap-3">
            <button
              onClick={handlePortsSave}
              disabled={saving || !portDirty || portHasErrors || !!currentNetwork}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
              title={currentNetwork ? 'Clear the network override above to publish ports' : 'Apply port changes'}>
              Apply ports & recreate
            </button>
            {portDirty && !saving && (
              <span className="text-xs text-ink-dim">Unsaved port changes</span>
            )}
          </div>
        </div>
      </section>

      {/* 5d. Custom workspace */}
      {!wsHidden && (
        <section className="bg-panel/60 border border-line rounded-xl p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-medium text-ink-muted">Custom workspace folder</h3>
              <p className="text-xs text-ink-dim mt-1 max-w-md">
                Mounts an independent host folder at a container workspace path. Changing it recreates the container; files are never moved or deleted.
              </p>
            </div>
            <button
              role="switch"
              aria-checked={wsEnabled}
              onClick={() => setWsEnabled(!wsEnabled)}
              disabled={saving}
              className={`relative w-10 h-6 rounded-full transition-colors shrink-0 disabled:opacity-50 ${wsEnabled ? 'bg-accent' : 'bg-raised'}`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${wsEnabled ? 'translate-x-4' : ''}`} />
            </button>
          </div>

          {wsEnabled && (
            <div className="mt-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">
                  Host workspace source
                </label>
                <input type="text" value={wsHost} onChange={(e) => setWsHost(e.target.value)}
                       placeholder={defaultWsHost}
                       className="w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono" />
                {wsHostIssue(wsHost) && (
                  <p className="text-xs text-danger mt-1">{wsHostIssue(wsHost)}</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">
                  Container workspace path
                </label>
                <input type="text" value={wsDir}
                       onChange={(e) => !wsFixed && setWsDir(e.target.value)}
                       readOnly={wsFixed}
                       className={`w-full bg-sunken border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line font-mono ${wsFixed ? 'opacity-70 cursor-not-allowed' : ''}`} />
                {wsFixed && (
                  <p className="text-xs text-ink-dim mt-1">
                    Fixed by {agent.agent_type} — its CLI requires the workspace at this path
                  </p>
                )}
                {wsDirIssue(wsDir) && (
                  <p className="text-xs text-danger mt-1">{wsDirIssue(wsDir)}</p>
                )}
              </div>

              {hostWorkspaceRoot && !wsBrowsable && (
                <div className="rounded-lg bg-warning-soft border border-warning-line/70 px-3 py-2 text-xs text-warning">
                  Custom workspace → the host file browser won't be available for this agent. Use the running container workspace instead.
                </div>
              )}
              <p className="text-xs text-ink-dim">
                A custom workspace is a separate bind mount, outside the agent's data folder.
              </p>
              <button
                onClick={handleWorkspaceSave}
                disabled={saving}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
              >
                Apply workspace & recreate
              </button>
            </div>
          )}
        </section>
      )}

      {/* 6. Danger Zone */}
      <section className="bg-danger-soft border border-danger-line/60 rounded-xl p-5">
        <h3 className="text-sm font-medium text-danger">Danger Zone</h3>
        <p className="text-xs text-ink-dim mt-1 max-w-md">
          Permanently delete this agent, its container, and all files. This cannot be undone.
        </p>
        <button
          onClick={handleDelete}
          disabled={saving}
          className="mt-3 px-3 py-1.5 bg-danger hover:bg-danger disabled:opacity-50 text-danger-ink rounded-lg text-xs font-medium transition-colors"
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
