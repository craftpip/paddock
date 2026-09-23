import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../lib/api'
import { useAgents } from '../../stores/agents'
import { useConfirm } from '../../lib/confirm'
import { useToast } from '../../lib/toast'
import CommandModal from '../../components/CommandModal'
import HealthCheckModal from '../../components/HealthCheckModal'
import ContainerInfoModal from '../../components/ContainerInfoModal'

// Minimal line diff for the Dev Container card preview (plan 41 item 20) —
// no diff library in the bundle. LCS-based, capped at 500 lines per side.
function lineDiff(a, b) {
  const cap = (s) => (s || '').replace(/\n$/, '').split('\n')
  let aLines = cap(a)
  let bLines = cap(b)
  const truncated = aLines.length > 500 || bLines.length > 500
  aLines = aLines.slice(0, 500)
  bLines = bLines.slice(0, 500)
  const m = aLines.length
  const n = bLines.length
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out = []
  let i = 0
  let j = 0
  let sameRun = 0
  const flush = () => {
    if (sameRun > 0) {
      out.push({ t: 'same', s: '', n: sameRun })
      sameRun = 0
    }
  }
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) { sameRun++; i++; j++ }
    else {
      flush()
      if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: 'del', s: aLines[i] }); i++ }
      else { out.push({ t: 'add', s: bLines[j] }); j++ }
    }
  }
  flush()
  while (i < m) { out.push({ t: 'del', s: aLines[i] }); i++ }
  while (j < n) { out.push({ t: 'add', s: bLines[j] }); j++ }
  if (truncated) out.push({ t: 'more', s: '' })
  return out
}

function DiffPreview({ from, to }) {
  const rows = lineDiff(from, to)
  const changes = rows.filter((r) => r.t === 'add' || r.t === 'del').length
  if (changes === 0) {
    return <p className="text-xs text-success mt-1">In sync — the file already matches the pad's settings.</p>
  }
  return (
    <div className="rounded-lg border border-line-faint bg-sunken overflow-hidden">
      <div className="max-h-64 overflow-y-auto">
        <pre className="text-[11px] leading-5 font-mono py-1.5 px-2">
          {rows.map((r, idx) =>
            r.t === 'same' ? (
              <span key={idx} className="block text-ink-dim/50">
                {r.n > 1 ? `⋯ ${r.n} identical lines` : r.n === 1 ? '…' : ''}
              </span>
            ) : r.t === 'more' ? (
              <span key={idx} className="block text-ink-dim italic">… truncated at 500 lines</span>
            ) : (
              <span key={idx} className={`block ${r.t === 'add' ? 'text-success' : 'text-danger'}`}>
                {r.t === 'add' ? '+' : '-'}{r.s}
              </span>
            ),
          )}
        </pre>
      </div>
    </div>
  )
}

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
  // Plan 41: build commands + post-create commands
  const [buildDraft, setBuildDraft] = useState('')
  const [postCreateDraft, setPostCreateDraft] = useState('')
  const [postStartDraft, setPostStartDraft] = useState('')
  const [postAttachDraft, setPostAttachDraft] = useState('')
  const [buildDirty, setBuildDirty] = useState(false)
  const [postCreateDirty, setPostCreateDirty] = useState(false)
  const [postStartDirty, setPostStartDirty] = useState(false)
  const [postAttachDirty, setPostAttachDirty] = useState(false)
  const [recreateInfo, setRecreateInfo] = useState(null)
  const [containerInfoModal, setContainerInfoModal] = useState(null)
  // Plan 41 item 20: the "Dev Container" card state
  const [dcInfo, setDcInfo] = useState(null)
  const [dcLoading, setDcLoading] = useState(false)
  const [dcAction, setDcAction] = useState('')

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

  function fetchDevContainer() {
    setDcLoading(true)
    api(`/api/agents/${agent.name}/devcontainer`)
      .then(setDcInfo)
      .catch(() => setDcInfo(null))
      .finally(() => setDcLoading(false))
  }

  useEffect(() => {
    refresh()
    refreshHealth()
    api('/api/containers')
      .then((d) => setContainers(d.containers || []))
      .catch(() => {})
    fetchDevContainer()
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
    // Sync the build/post-create/post-start/post-attach drafts once (do not clobber while editing).
    setBuildDraft(settings.buildCommands || '')
    setPostCreateDraft(settings.postCreate || '')
    setPostStartDraft(settings.postStart || '')
    setPostAttachDraft(settings.postAttach || '')
    setBuildDirty(false)
    setPostCreateDirty(false)
    setPostStartDirty(false)
    setPostAttachDirty(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, driverInfo, agent.name])

  function closeModal() {
    const wasRunning = saving
    setModal(null)
    setSaving(false)
    fetchAgents()
    refresh()
    if (wasRunning) {
      // The modal was closed before the job finished, so its SSE `done` event
      // (and the onDone → refresh) is lost on unmount and `settings` would
      // stay stale — e.g. the network select keeps showing the old value
      // until a page reload. Re-attach a background listener and refresh once
      // the job finally completes. Replay is safe: subscribe() re-sends
      // buffered events, so an already-finished job fires `done` immediately.
      const es = new EventSource(`/api/agents/${agent.name}/update-log`)
      const finalize = () => {
        try { es.close() } catch {}
        refresh()
        fetchAgents()
      }
      es.addEventListener('done', finalize)
      es.addEventListener('error', finalize)
      setTimeout(() => { try { es.close() } catch {} }, 120000)
    }
  }

  // ── Recreate Container (update / recreate / full user-data reset) ────

  const [recreateOpen, setRecreateOpen] = useState(false)
  const [recreatePull, setRecreatePull] = useState(false)
  const [recreateReset, setRecreateReset] = useState(false)

  async function openRecreate() {
    let info = null
    try {
      info = await api(`/api/agents/${agent.name}/update-info`)
    } catch {
      info = null
    }
    setRecreateInfo(info)
    setRecreatePull(false)
    setRecreateReset(false)
    setRecreateOpen(true)
  }

  async function runRecreate() {
    setRecreateOpen(false)
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      await api(`/api/agents/${agent.name}/recreate`, {
        method: 'POST',
        body: { pull: recreatePull, reset: recreateReset },
      })
      setModal({
        key: `recreate-${Date.now()}`,
        title: recreateReset
          ? `Recreating ${agent.name} with fresh user data`
          : recreatePull
            ? `Updating & recreating ${agent.name}`
            : `Recreating ${agent.name}`,
        onDone: () => {
          refresh()
          fetchAgents()
          toast.success(recreateReset ? 'Container recreated — user data reset' : 'Container recreated')
        },
      })
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to recreate container')
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

  // ── Container user (plan 43 Phase 7) ──────────────────────

  async function handleUserModeChange(mode) {
    if (mode === (settings.userMode || 'root')) return
    const toUser = mode === 'user'
    const ok = await confirm({
      title: toUser ? 'Run as the pad user' : 'Run as root',
      message: toUser
        ? `This will stop and recreate ${agent.name} so the agent daemon and terminal run as the pad user (${'PUID'}:${'PGID'}). Every file the agent writes becomes user-owned on the host. SSH stays the root admin door.`
        : `This will stop and recreate ${agent.name} so the agent daemon runs as root again (legacy default).`,
      confirmText: toUser ? 'Switch to pad user & recreate' : 'Switch to root & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/settings`, { method: 'POST', body: { userMode: mode } })
      if (d && d.streaming) {
        setModal({
          key: `usermode-${Date.now()}`,
          title: toUser ? `Switching ${agent.name} to the pad user` : `Switching ${agent.name} to root`,
          onDone: () => {
            refresh()
            fetchAgents()
            toast.success(toUser ? 'Agent now runs as the pad user' : 'Agent now runs as root')
          },
        })
      } else {
        setSettings(d)
        toast.success(toUser ? 'Agent now runs as the pad user' : 'Agent now runs as root')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to change the container user')
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

  const volErrors = volDraft.map((v) => ({
    host: v.type === 'volume'
      ? ((v.host || '').trim()
        ? (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test((v.host || '').trim())
          ? '' : 'Use letters, digits, dots, dashes or underscores — no slashes')
        : 'Volume name is required')
      : volHostIssue(v.host),
    dir: volDirIssue(v.container),
  }))
  const volHasErrors = volErrors.some((e) => e.host || e.dir)

  async function handleVolumesSave() {
    if (volHasErrors) {
      toast.error('Fix the highlighted volume fields before saving')
      return
    }
    const vols = volDraft
      .filter((v) => v.host && v.host.trim() && v.container && v.container.trim())
      .map((v) => {
        const row = { host: v.host.trim(), container: v.container.trim(), readonly: !!v.readonly }
        if (v.type === 'volume') {
          row.type = 'volume'
          if (v.external) row.external = v.external
        }
        return row
      })
    const ok = await confirm({
      title: 'Apply additional volumes',
      message: vols.length
        ? `This will stop and recreate ${agent.name} with ${vols.length} additional volume${vols.length === 1 ? '' : 's'}.\n\n${vols.map((v) => `${v.type === 'volume' ? `[volume ${v.host}]` : v.host} → ${v.container}${v.readonly ? ' (ro)' : ''}`).join('\n')}`
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

  // ── Build & post-create commands (plan 41) ─────────────────

  async function handleBuildPostCreateSave() {
    const bc = buildDraft
    const pc = postCreateDraft
    const ps = postStartDraft
    const pa = postAttachDraft
    const body = {}
    if (buildDirty) body.buildCommands = bc
    if (postCreateDirty) body.postCreate = pc
    if (postStartDirty) body.postStart = ps
    if (postAttachDirty) body.postAttach = pa
    if (Object.keys(body).length === 0) return
    const changes = []
    if (buildDirty) changes.push(bc ? 'build commands updated (image rebuild)' : 'build commands cleared (image rebuild)')
    if (postCreateDirty) changes.push(pc ? 'post-create updated (re-run after recreate)' : 'post-create cleared')
    if (postStartDirty) changes.push(ps ? 'post-start updated (runs on every container start)' : 'post-start cleared')
    if (postAttachDirty) changes.push(pa ? 'post-attach updated (runs on every terminal attach)' : 'post-attach cleared')
    const ok = await confirm({
      title: 'Apply build & lifecycle commands',
      message: `This will stop and recreate ${agent.name}.\n\n${changes.join('\n')}\n\nBuild commands are baked into the image (a rebuild), post-create re-runs in the finished container, post-start runs on every start, post-attach runs on every terminal attach.`,
      confirmText: 'Apply & recreate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setSaving(true)
    if (agent.status === 'running') updateAgentStatus(agent.name, 'restarting')
    try {
      const d = await api(`/api/agents/${agent.name}/settings`, { method: 'POST', body })
      if (d && d.streaming) {
        setModal({
          key: `build-${Date.now()}`,
          title: `Applying build & lifecycle commands for ${agent.name}`,
          onDone: () => {
            refresh()
            fetchAgents()
            toast.success('Build & lifecycle commands applied')
          },
        })
      } else {
        setSettings(d)
        toast.success('Build & lifecycle commands applied')
        setSaving(false)
      }
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to update build & lifecycle commands')
      setSaving(false)
    }
  }

  // ── Dev Container (plan 41 item 20) ───────────────────────

  async function handleDcSync() {
    const ok = await confirm({
      title: 'Sync dev container',
      message: dcInfo?.generated
        ? `Rewrites ${dcInfo.filePath} from ${agent.name}'s current settings (workspace folder, lifecycle commands, env, volumes, ports, user).`
        : `Writes the mapped fields (workspace folder, lifecycle commands, env, volumes, ports) from ${agent.name}'s settings into ${dcInfo?.filePath}, preserving every other field. The container is not recreated.`,
      confirmText: 'Sync',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setDcAction('sync')
    try {
      const d = await api(`/api/agents/${agent.name}/devcontainer/sync`, { method: 'POST' })
      setDcInfo(d)
      toast.success('Dev container synced')
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to sync dev container')
    } finally {
      setDcAction('')
    }
  }

  async function handleDcRegenerate() {
    const ok = await confirm({
      title: dcInfo?.found ? 'Regenerate dev container' : 'Generate dev container',
      message: dcInfo?.found
        ? dcInfo?.generated
          ? `Rewrites ${dcInfo.filePath} wholesale from ${agent.name}'s current settings, discarding any manual edits. The container is not recreated.`
          : `This file is project-authored. Regenerating OVERWRITES it entirely with a Paddock-generated mirror (marked x-paddock.generated) — your custom fields will be lost. The container is not recreated.`
        : `Creates ${dcInfo?.workspacePath || 'the workspace'}/.devcontainer/devcontainer.json as a mirror of ${agent.name}'s current settings. The container is not recreated.`,
      danger: !!dcInfo?.found && !dcInfo?.generated,
      confirmText: dcInfo?.found ? 'Regenerate' : 'Generate',
      cancelText: 'Cancel',
    })
    if (!ok) return
    setDcAction('regenerate')
    try {
      const d = await api(`/api/agents/${agent.name}/devcontainer/regenerate`, { method: 'POST' })
      setDcInfo(d)
      toast.success(dcInfo?.found ? 'Dev container regenerated' : 'Dev container generated')
    } catch (err) {
      toast.error(err.error || err.message || 'Failed to regenerate dev container')
    } finally {
      setDcAction('')
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
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-ink-muted">Container Info</h3>
          <button
            onClick={() => setContainerInfoModal({ key: `cinfo-${Date.now()}` })}
            disabled={saving}
            title="Inspect the live container (network, mounts, ports, raw docker inspect)"
            className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
          >
            Inspect details
          </button>
        </div>
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

      {/* 2. Recreate Container (update / recreate / full reset) */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Recreate Container</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Recreates the container. Use it to update the image to the latest, to simply recreate the container, or to reset the entire user folder (config, sessions, data) so it starts completely fresh — your bind-mounted workspace folder is preserved.
            </p>
          </div>
          <button
            onClick={openRecreate}
            disabled={saving}
            className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors whitespace-nowrap"
          >
            Recreate Container
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

      {/* 4b. Container user — root vs the pad user */}
      {agent.agent_type !== 'hermes' && (
        <section className="bg-panel/60 border border-line rounded-xl p-5">
          <h3 className="text-sm font-medium text-ink-muted">Container user</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            The agent daemon and terminal run as the pad user ({'PUID'}:{'PGID'}), so every file they write is
            user-owned on the host. SSH stays the root admin door.
          </p>
          <div className="mt-3 inline-flex rounded-lg border border-line-faint bg-sunken p-0.5">
            <button type="button"
                    onClick={() => handleUserModeChange('root')}
                    disabled={saving}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${(settings?.userMode || 'root') === 'root' ? 'bg-accent text-white' : 'text-ink-dim hover:text-ink'}`}>
              Root
            </button>
            <button type="button"
                    onClick={() => handleUserModeChange('user')}
                    disabled={saving}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors disabled:opacity-50 ${settings?.userMode === 'user' ? 'bg-accent text-white' : 'text-ink-dim hover:text-ink'}`}>
              Local user
            </button>
          </div>
          {settings?.userMode === 'user' && (
            <p className="mt-3 text-xs text-warning/90 bg-warning-soft border border-warning-line/60 rounded-lg px-3 py-2">
              Changing to root or to another setting below will stop and recreate the container.
            </p>
          )}
        </section>
      )}

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
          {volDraft.length > 0 && (
            <div className="rounded-lg overflow-hidden border border-line-faint">
              <div className="bg-sunken text-ink-faint uppercase tracking-wider text-[11px] px-2 py-2 flex items-center gap-2 font-medium">
                <span className="w-32 shrink-0">Type</span>
                <span className="flex-1 min-w-0">Host source / Volume name</span>
                <span className="flex-1 min-w-0">Container path</span>
                <span className="w-7 shrink-0 text-center" title="Read-only mount">Ro</span>
                <span className="w-7 shrink-0"></span>
              </div>
              {volDraft.map((v, i) => (
                <div key={i} className="border-t border-line-faint flex items-start gap-2 px-2 py-1.5">
                  <div className="w-32 shrink-0">
                    <select value={v.type || 'bind'}
                            onChange={(e) => setVol(i, { type: e.target.value })}
                            className="w-full h-7 bg-raised border border-line-faint rounded-lg px-1.5 text-xs text-ink focus:outline-none focus:border-accent-line">
                      <option value="bind">Bind mount</option>
                      <option value="volume">Named volume</option>
                    </select>
                  </div>
                  <div className="flex-1 min-w-0">
                    <input type="text" value={v.host}
                           onChange={(e) => setVol(i, { host: e.target.value })}
                           title={v.type === 'volume' ? (v.external ? `Attaches the existing volume ${v.external}` : 'Creates a fresh volume') : undefined}
                           placeholder={v.type === 'volume' ? 'e.g. mempalace-dbdata' : 'e.g. /mnt/shared'}
                           className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                    {volErrors[i].host && <p className="text-xs text-danger mt-0.5">{volErrors[i].host}</p>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <input type="text" value={v.container}
                           onChange={(e) => setVol(i, { container: e.target.value })}
                           placeholder="e.g. /data"
                           className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                    {volErrors[i].dir && <p className="text-xs text-danger mt-0.5">{volErrors[i].dir}</p>}
                  </div>
                  <div className="w-7 shrink-0 h-7 flex items-center justify-center" title="Read-only mount">
                    <input type="checkbox" checked={!!v.readonly}
                           onChange={(e) => setVol(i, { readonly: e.target.checked })}
                           title="Read-only mount"
                           className="w-3.5 h-3.5 accent-accent" />
                  </div>
                  <div className="w-7 shrink-0">
                    <button type="button"
                            onClick={() => { setVolDraft(prev => prev.filter((_, idx) => idx !== i)); setVolDirty(true) }}
                            className="w-7 h-7 grid place-items-center rounded-md text-ink-dim hover:text-danger hover:bg-raised transition-colors"
                            title="Remove volume">✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <button type="button"
                  onClick={() => { setVolDraft(prev => [...prev, { type: 'bind', host: '', container: '', readonly: false }]); setVolDirty(true) }}
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

      {/* 5e. Build & lifecycle commands (plan 41) */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Build &amp; lifecycle commands</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Dockerfile lines baked into this PAD's image (every rebuild) and bash lines run at the container lifecycle: once after recreate (post-create), on every start (post-start), and on every terminal attach (post-attach).
          </p>
        </div>

        <div className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Build commands (Dockerfile)</label>
            <textarea value={buildDraft}
                      onChange={(e) => { setBuildDraft(e.target.value); setBuildDirty(true) }}
                      rows={3}
                      spellCheck={false}
                      placeholder={'RUN apt-get install -y vim'}
                      className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
            <p className="text-xs text-ink-dim mt-1">
              Lives in <code className="text-ink-faint font-mono">instances/{agent.name}/build/Dockerfile</code>. A change rebuilds the image (a <code className="text-ink-faint font-mono">FROM</code> line here fails the build — the current container stays up).
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Post-create commands (bash)</label>
            <textarea value={postCreateDraft}
                      onChange={(e) => { setPostCreateDraft(e.target.value); setPostCreateDirty(true) }}
                      rows={3}
                      spellCheck={false}
                      placeholder={'npm install'}
                      className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
            <p className="text-xs text-ink-dim mt-1">
              Runs once in the running container (project mounted, services up) after a recreate.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Post-start commands (bash)</label>
            <textarea value={postStartDraft}
                      onChange={(e) => { setPostStartDraft(e.target.value); setPostStartDirty(true) }}
                      rows={3}
                      spellCheck={false}
                      placeholder={'service cron start'}
                      className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
            <p className="text-xs text-ink-dim mt-1">
              Runs on every container start (baked into <code className="text-ink-faint font-mono">start.sh</code>). Enabling it on an older image rebuilds it once so the hook is baked in.
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Post-attach commands (bash)</label>
            <textarea value={postAttachDraft}
                      onChange={(e) => { setPostAttachDraft(e.target.value); setPostAttachDirty(true) }}
                      rows={3}
                      spellCheck={false}
                      placeholder={'echo "attached"'}
                      className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
            <p className="text-xs text-ink-dim mt-1">
              Runs on every terminal attach inside this PAD (workspace/project mounted). No image change needed.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleBuildPostCreateSave}
              disabled={saving || (!buildDirty && !postCreateDirty && !postStartDirty && !postAttachDirty)}
              className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
            >
              Apply &amp; recreate
            </button>
            {(buildDirty || postCreateDirty || postStartDirty || postAttachDirty) && !saving && (
              <span className="text-xs text-ink-dim">Unsaved build/lifecycle changes</span>
            )}
          </div>
        </div>
      </section>

      {/* 5f. Dev Container (plan 41 item 20) */}
      <section className="bg-panel/60 border border-line rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Dev Container</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              The workspace's <code className="text-ink-faint font-mono">devcontainer.json</code> is the portable mirror of this pad. Settings changes (volumes, ports, env, lifecycle commands) are written back into it automatically — these buttons push them manually, no container recreate.
            </p>
          </div>
          {dcInfo && (
            <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-[11px] font-medium border whitespace-nowrap shrink-0 ${
              dcInfo.state === 'generated'
                ? 'bg-accent-soft text-accent-text border-accent-line/60'
                : dcInfo.state === 'project-authored'
                  ? 'bg-raised text-ink border-line'
                  : 'bg-sunken text-ink-dim border-line-faint'
            }`}>
              {dcInfo.state === 'generated'
                ? 'Generated'
                : dcInfo.state === 'project-authored'
                  ? 'Project-authored'
                  : 'Missing'}
            </span>
          )}
        </div>

        <div className="mt-4">
          <p className="text-xs text-ink-faint font-mono break-all">
            {dcInfo?.filePath || (dcInfo?.workspacePath ? `${dcInfo.workspacePath}/.devcontainer/devcontainer.json` : '—')}
          </p>

          {!dcInfo ? (
            <p className="text-xs text-ink-dim mt-2">{dcLoading ? 'Loading…' : 'Dev container info unavailable.'}</p>
          ) : !dcInfo.workspacePath ? (
            <p className="text-xs text-ink-dim mt-2">
              This agent has no custom workspace — the dev container mirror needs a workspace folder.
            </p>
          ) : !dcInfo.found ? (
            <p className="text-xs text-ink-dim mt-2">
              No devcontainer.json in the workspace yet. Generate one mirroring this pad's current settings.
            </p>
          ) : (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] uppercase tracking-wider text-ink-faint font-medium">
                  Diff — current file vs what Paddock would write now
                </span>
                <span className="text-[11px] text-ink-dim">red removed · green added</span>
              </div>
              <DiffPreview from={dcInfo.content} to={dcInfo.target} />
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={handleDcSync}
            disabled={saving || dcAction !== '' || !dcInfo?.sync || !dcInfo?.found}
            title={!dcInfo?.sync || !dcInfo?.found ? 'Nothing to sync — the pad never adopted this devcontainer' : undefined}
            className="px-3 py-1.5 bg-raised hover:bg-raised-hover disabled:opacity-50 text-ink rounded-lg text-xs font-medium transition-colors"
          >
            {dcAction === 'sync' ? 'Syncing…' : 'Sync'}
          </button>
          <button
            onClick={handleDcRegenerate}
            disabled={saving || dcAction !== '' || !dcInfo?.workspacePath}
            className="px-3 py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-50 text-accent-ink rounded-lg text-xs font-medium transition-colors"
          >
            {dcAction === 'regenerate' ? 'Working…' : dcInfo?.found ? 'Regenerate' : 'Generate'}
          </button>
          {dcInfo?.state === 'project-authored' && (
            <span className="text-xs text-ink-dim">Sync preserves your custom fields — Regenerate overwrites them.</span>
          )}
        </div>
      </section>

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

      {recreateOpen && (
        <div
          className="fixed inset-0 z-[75] flex items-center justify-center bg-overlay backdrop-blur-sm"
          onClick={() => setRecreateOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 pt-5 pb-3">
              <h3 className="text-base font-semibold text-ink">Recreate Container</h3>
              <p className="mt-2 text-sm text-ink-faint leading-relaxed">
                This recreates {agent.name}'s container. It can update the image, recreate the container as-is, and reset the entire user folder so the container starts completely fresh — tick the options you want.
              </p>

              {recreateInfo && (
                <div className="mt-3 text-xs text-ink-dim bg-sunken border border-line-faint rounded-lg px-3 py-2 space-y-0.5">
                  {recreateInfo.updateAvailable ? (
                    <p className="text-warning">
                      Update available: {recreateInfo.currentVersion || 'unknown'} → {recreateInfo.availableVersion || 'latest'}
                    </p>
                  ) : (
                    <p>
                      Already on the latest image{recreateInfo.currentVersion ? ` (${recreateInfo.currentVersion})` : ''}.
                    </p>
                  )}
                </div>
              )}

              <label className="mt-4 flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recreatePull}
                  onChange={(e) => setRecreatePull(e.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <span className="text-sm text-ink">
                  <span className="font-medium">Pull latest image update</span>
                  <span className="block text-xs text-ink-dim mt-0.5">
                    Re-downloads the base image and rebuilds it (update the container).
                  </span>
                </span>
              </label>

              <label className="mt-3 flex items-start gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recreateReset}
                  onChange={(e) => setRecreateReset(e.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <span className="text-sm text-ink">
                  <span className="font-medium text-danger">Reset the whole user folder</span>
                  <span className="block text-xs text-ink-dim mt-0.5">
                    Deletes the entire user data folder (config, sessions, data) so the container starts fresh. Your workspace is a separate bind-mounted folder and is NOT deleted. This cannot be undone.
                  </span>
                </span>
              </label>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 pb-5 pt-2">
              <button
                onClick={() => setRecreateOpen(false)}
                className="px-4 py-2 text-sm font-medium text-ink-muted hover:text-ink hover:bg-panel rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={runRecreate}
                disabled={saving}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
                  recreateReset
                    ? 'bg-danger hover:bg-danger text-danger-ink'
                    : 'bg-accent hover:bg-accent-hover text-accent-ink'
                }`}
              >
                Recreate Container
              </button>
            </div>
          </div>
        </div>
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

      {containerInfoModal && (
        <ContainerInfoModal
          key={containerInfoModal.key}
          name={agent.name}
          title={`Container Info — ${agent.name}`}
          onClose={() => setContainerInfoModal(null)}
        />
      )}
    </div>
  )
}
