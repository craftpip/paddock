import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import Button from '../components/ui/Button'
import { Input, Select } from '../components/ui/Input'
import Card from '../components/ui/Card'
import Badge from '../components/ui/Badge'
import Switch from '../components/ui/Switch'
import { hostSourceIssue } from '../lib/workspace-guards'
import WorkspaceSourceSection from './create-agent/WorkspaceSourceSection'
import WorkspacePathSection from './create-agent/WorkspacePathSection'
import ContainerOptionsSection from './create-agent/ContainerOptionsSection'
import VolumesSection from './create-agent/VolumesSection'
import PortsSection from './create-agent/PortsSection'
import BuildCommandsSection from './create-agent/BuildCommandsSection'
import CreateProgress from './create-agent/CreateProgress'

const STEP_COMMANDS = {
  build: (name) => `docker compose -f instances/${name}/docker-compose.yml build`,
  up: (name) => `docker compose -f instances/${name}/docker-compose.yml up -d`,
  setup: (name) => `docker exec ${name} openclaw setup --baseline`,
}

function setupCmdFor(type, name) {
  if (!type || !type.setupSteps || type.setupSteps.length === 0) return ''
  return `docker exec ${name} ${type.setupSteps.map((s) => [s.cmd, ...(s.args || [])].join(' ')).join(' && ')}`
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString()
  } catch {
    return ''
  }
}

export default function CreateAgent() {
  useDocumentTitle('New agent')
  const navigate = useNavigate()
  const { name: urlName } = useParams()

  const DRAFT_KEY = 'createAgentDraft'
  const [name, setName] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.name || '' } catch {}
    return ''
  })
  const [agentType, setAgentType] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.agentType || 'openclaw' } catch {}
    return 'openclaw'
  })
  const [agentTypes, setAgentTypes] = useState([])
  const [prefix, setPrefix] = useState('vm')
  const [hostWorkspaceRoot, setHostWorkspaceRoot] = useState('')
  const [wsHost, setWsHost] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.wsHost || '' } catch {}
    return ''
  })
  const [wsDir, setWsDir] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.wsDir || '' } catch {}
    return ''
  })
  // Plan 40: path autocomplete + compose volume pre-fill
  const [wsProbe, setWsProbe] = useState(null) // {exists, writable, forbidden, compose}
  const [suggestions, setSuggestions] = useState([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [acIndex, setAcIndex] = useState(-1)
  const [discovered, setDiscovered] = useState(null) // {project, compose, count, named}

  // Plan 28 options
  const [containers, setContainers] = useState([])
  const [allowDocker, setAllowDocker] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.allowDocker || false } catch {}
    return false
  })
  const [network, setNetwork] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.network || '' } catch {}
    return ''
  })
  const [extraVolumes, setExtraVolumes] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.extraVolumes || [] } catch {}
    return []
  })
  const [extraPorts, setExtraPorts] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.extraPorts || [] } catch {}
    return []
  })
  const [showAdvanced, setShowAdvanced] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.showAdvanced || false } catch {}
    return false
  })
  // Plan 43 Phase 7: Container user (root | user) — daemon + terminal run as
  // the pad user (PUID:PGID) so agent-written files are user-owned.
  const [userMode, setUserMode] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.userMode || 'root' } catch {}
    return 'root'
  })
  // Plan 41: build commands + post-create commands (devcontainer pre-fill)
  const [buildCommands, setBuildCommands] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.buildCommands || '' } catch {}
    return ''
  })
  const [postCreate, setPostCreate] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.postCreate || '' } catch {}
    return ''
  })
  const [postStart, setPostStart] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.postStart || '' } catch {}
    return ''
  })
  const [postAttach, setPostAttach] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.postAttach || '' } catch {}
    return ''
  })
  const [devContainer, setDevContainer] = useState(null) // {found, filePath, name, ...}
  // Plan 41 item 20: generate a `.devcontainer/devcontainer.json` mirror in the
  // workspace when it has none (default on).
  const [generateDevContainer, setGenerateDevContainer] = useState(() => {
    if (!urlName) try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY))?.generateDevContainer ?? true } catch {}
    return true
  })

  const [phase, setPhase] = useState(() => (urlName ? 'creating' : 'idle')) // idle | creating | done | failed
  const [submitting, setSubmitting] = useState(false)
  const [lines, setLines] = useState([])
  const [runningCmd, setRunningCmd] = useState('')
  const [error, setError] = useState('')
  const [jobName, setJobName] = useState(urlName || '')

  const esRef = useRef(null)
  const acTimer = useRef(null)
  const discTimer = useRef(null)
  const acIndexRef = useRef(-1)
  // Plan 41 item 17: whether the user has manually picked the Container user
  // toggle. The devcontainer probe may default it to 'user' for a non-root
  // workspace, but only while untouched — an explicit pick always wins.
  const userModeTouched = useRef(false)
  // Whether the user has manually typed into the Container workspace path input.
  // Prevents auto-fill logic from overwriting their edit.
  const wsDirTouched = useRef(false)

  useEffect(() => {
    api('/api/config').then(cfg => {
      if (cfg.containerPrefix) setPrefix(cfg.containerPrefix)
      if (cfg.hostWorkspaceRoot) setHostWorkspaceRoot(cfg.hostWorkspaceRoot)
    }).catch(() => {})
    api('/api/agent-types').then(d => {
      if (d.types?.length) setAgentTypes(d.types)
    }).catch(() => {})
    api('/api/containers').then(d => {
      setContainers(d.containers || [])
    }).catch(() => {})
    return () => closeStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // /agents/create and /agents/create/:name render the same component, so
  // React reuses the instance and the `phase`/`jobName` initializers never
  // re-run on navigation. Flip to 'creating' + sync the name whenever a
  // progress URL appears.
  useEffect(() => {
    if (urlName) {
      setPhase('creating')
      setJobName(urlName)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlName])

  // Reset wsDir manual-edit flag when agent type changes so auto-fill logic
  // re-runs with the new type's defaults (devcontainer workspaceFolder or same-path).
  useEffect(() => {
    wsDirTouched.current = false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType])

  // Clear lifecycle drafts and re-probe when agent type changes — the
  // previous agent's translated commands would be wrong for the new agent
  // (plan 45). Skips the initial mount so sessionStorage drafts survive.
  const agentTypeInitRef = useRef(true)
  useEffect(() => {
    if (agentTypeInitRef.current) { agentTypeInitRef.current = false; return }
    setPostCreate('')
    setPostStart('')
    setPostAttach('')
    if (wsHost.trim()) probeDevContainer(wsHost.trim())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType])

  // Progress URL (/agents/create/:name): resume the create job stream on
  // refresh — the job events live server-side, so reconnect and replay.
  useEffect(() => {
    if (!urlName) return
    setLines([])
    setRunningCmd('')
    startStream(urlName)
    return () => closeStream()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlName])

  const currentType = agentTypes.find((t) => t.type === agentType)

  const fullName = `${prefix}-${agentType}-${name || '...'}`

  // Friendly name validation: lowercase letters, digits and dashes only.
  const nameIssue = name.trim()
    ? (/^[a-z0-9][a-z0-9-]*$/.test(name.trim()) ? '' : 'Use lowercase letters, numbers and dashes only')
    : ''

  // ─── Custom workspace (plan 24) ────────────────────────────
  const wsCapability = currentType?.workspaceCapability || 'fixed'
  const wsHidden = wsCapability === 'none'
  const wsFixed = wsCapability === 'fixed'
  const driverWsDir = currentType?.workspaceDir || ''
  // Defaults = today's location: the `workspace` subfolder of the driver's data
  // dir on the host, mounted at the driver's container workspace path. The
  // relative `instances/…` form resolves under the project root on submit.
  const defaultWsHost = `instances/${prefix}-${agentType}-${name || '<name>'}/${agentType}/workspace`
  const defaultWsDir = driverWsDir

  // ─── Plan 40: path autocomplete + compose volume pre-fill ──
  // Typing in the workspace source field triggers (debounced) autocomplete
  // suggestions and, once the path settles, a probe + volume discovery. A
  // project's volumes pre-fill the "Additional volumes" rows for review —
  // never applied without the user submitting the form (D4).
  function pickSuggestion(s) {
    setWsHost(s)
    setSuggestOpen(false)
    setSuggestions([])
    setDiscovered(null)
    clearTimeout(acTimer.current)
    clearTimeout(discTimer.current)
    probeAndDiscover(s)
  }

  function onWsHostChange(v) {
    probeSeq.current += 1 // anything still in flight is for a path that is no longer shown
    setWsHost(v)
    setSuggestOpen(false)
    setDiscovered(null)
    clearTimeout(acTimer.current)
    clearTimeout(discTimer.current)
    const q = (v || '').trim()
    if (!q) { setSuggestions([]); setWsProbe(null); return }
    acTimer.current = setTimeout(async () => {
      try {
        const d = await api(`/api/paths/autocomplete?q=${encodeURIComponent(q)}`)
        setSuggestions((d.dirs || []).filter((s) => s.startsWith(q)).slice(0, 12))
        setSuggestOpen(true)
        acIndexRef.current = -1
        setAcIndex(-1)
      } catch { setSuggestions([]) }
    }, 220)
    discTimer.current = setTimeout(() => probeAndDiscover(q), 550)
  }

  // Each probe belongs to the path that was current when it started. A reply
  // that comes back after the user has typed something else is dropped: it
  // used to fill the volumes and the "discovered" badge from the OLD path.
  const probeSeq = useRef(0)
  async function probeAndDiscover(q) {
    const mine = ++probeSeq.current
    const stale = () => mine !== probeSeq.current
    if (!q.startsWith('/')) { setWsProbe(null); return }
    let p = null
    try {
      const r = await api(`/api/paths/probe?path=${encodeURIComponent(q)}`)
      if (String(r.path) === q.trim()) p = r
    } catch {}
    if (stale()) return
    setWsProbe(p)
    if (!p || !p.exists || !p.compose) {
      // No compose project: still look for a devcontainer.json (plan 41) so the
      // post-create box can pre-fill from the workspace's own spec file.
      const foundDc = await probeDevContainer(q)
      if (stale()) return
      if (!foundDc) autoFillWsDirFromHost(q)
      return
    }
    try {
      const d = await api(`/api/paths/volumes?path=${encodeURIComponent(q)}`)
      if (String(d.path) !== q.trim() || stale()) return
      if (d.volumes && d.volumes.length) {
        setExtraVolumes(d.volumes.map((v) => ({
          type: v.type === 'volume' ? 'volume' : 'bind',
          host: v.source,
          container: v.target,
          readonly: !!v.readonly,
          ...(v.type === 'volume' ? { external: v.external } : {}),
        })))
        setDiscovered({
          project: d.project,
          compose: d.compose,
          count: d.volumes.length,
          named: d.volumes.filter((v) => v.type === 'volume').length,
        })
      }
    } catch {}
    if (stale()) return
    const foundDc = await probeDevContainer(q)
    if (stale()) return
    if (!foundDc) autoFillWsDirFromHost(q)
  }

  // Plan 41: when the picked workspace ships a devcontainer.json, pre-fill the
  // post-create box from its lifecycle commands (spec order onCreate →
  // updateContent → postCreate) with a badge. Only when the user hasn't typed
  // into the box yet — an edit keeps their text.
  async function probeDevContainer(q) {
    setDevContainer(null)
    if (!q.startsWith('/')) return false
    let d = null
    try {
      const r = await api(`/api/paths/devcontainer?path=${encodeURIComponent(q)}`)
      if (r.found) d = r
    } catch {}
    if (!d) return false
    setDevContainer(d)
    // Devcontainer lifecycle commands are authored against the devcontainer's
    // workspace mount (its `workspaceFolder`, or the `/workspace` convention).
    // The PAD mounts the same project at its OWN container workspace path
    // (driver-fixed, e.g. openclaw's /root/.openclaw/workspace) — so translate
    // the workspace-root paths in the pre-filled commands, or they fail inside
    // the container (e.g. `cd /workspace/app` → ENOENT).
    const padWs = (driverWsDir || (wsFixed ? wsDir : (wsDir || wsHost)) || '').trim()
    // Whole-token translation: replace a workspace root ONLY when it starts a
    // path token (preceded by start/whitespace/quote/;/&/|/(/= — never by a
    // path char). Without the "not preceded by /.-word" guard, re-probing an
    // already-synced mirror would match the /workspace INSIDE an already
    // translated path (e.g. /root/.openclaw/workspace/app) and double it into
    // /root/.openclaw/root/.openclaw/workspace/app (plan 45).
    const translateRoot = (cmd, root) => {
      const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return cmd.replace(new RegExp(`(^|[^/.\\w-])${esc}(?=[/\\s"';&|)$])`, 'g'), `$1${padWs}`)
    }
    const dcCmdForPad = (cmd) => {
      if (!cmd || !padWs || padWs === '/workspace') return cmd
      let out = cmd
      if (d.workspaceFolder && d.workspaceFolder !== '/workspace' && d.workspaceFolder !== padWs) {
        out = translateRoot(out, d.workspaceFolder)
      }
      out = out.replace(/(^|[^/.\w-])\/workspace(?=[/\s"';&|)$])/g, `$1${padWs}`)
      return out
    }
    const joined = [d.onCreateCommand, d.updateContentCommand, d.postCreateCommand]
      .filter(Boolean)
      .join('\n')
    if (joined.trim()) {
      setPostCreate((prev) => (prev.trim() ? prev : dcCmdForPad(joined.trim())))
    }
    if ((d.postStartCommand || '').trim()) {
      setPostStart((prev) => (prev.trim() ? prev : dcCmdForPad(d.postStartCommand)))
    }
    if ((d.postAttachCommand || '').trim()) {
      setPostAttach((prev) => (prev.trim() ? prev : dcCmdForPad(d.postAttachCommand)))
    }
    // item 17: a devcontainer declaring a non-root remoteUser/containerUser
    // means the pad should run as the pad user. Seed the Container user toggle
    // to 'user' — only while the user hasn't manually picked one.
    if (!userModeTouched.current && d.userMode === 'user') {
      setUserMode('user')
    }
    // Auto-fill the container workspace path from the driver's default when
    // the user hasn't manually typed into it. Use the driver's workspaceDir
    // (not the mirror's workspaceFolder which is agent-specific from the last
    // sync and would give the wrong path for a different agent type — plan 45).
    if (!wsFixed && !wsDirTouched.current && driverWsDir) {
      setWsDir(driverWsDir)
    }
    // Auto-fill additional ports from the devcontainer's forwardPorts.
    // Format: "8080", "host:container", "ip:host:container" (with optional /proto).
    if (d.forwardPorts && d.forwardPorts.length) {
      const parsed = d.forwardPorts.map((fp) => {
        const raw = String(fp).split('/')[0]; // strip /tcp /udp
        const parts = raw.split(':');
        if (parts.length >= 2) {
          return { host: parts[parts.length - 2], container: parts[parts.length - 1] };
        }
        return { host: parts[0], container: parts[0] };
      }).filter((p) => p.host && p.container);
      if (parsed.length) {
        setExtraPorts((prev) => (prev.length ? prev : parsed))
      }
    }
    return true
  }

  // Auto-fill the container workspace path from the host source when no
  // devcontainer declared a workspaceFolder. Uses the one-to-one mount
  // convention (container path = host path) for absolute paths outside
  // the instances folder.
  function autoFillWsDirFromHost(hostPath) {
    if (wsFixed || wsDirTouched.current) return
    const h = (hostPath || '').trim()
    if (!h.startsWith('/') || h.startsWith('instances/')) return
    setWsDir(h)
  }

  function onWsKeyDown(e) {
    if (e.key === 'Escape') { setSuggestOpen(false); return }
    if (!suggestOpen || !suggestions.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = Math.min(acIndexRef.current + 1, suggestions.length - 1)
      acIndexRef.current = next
      setAcIndex(next)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      const next = Math.max(acIndexRef.current - 1, 0)
      acIndexRef.current = next
      setAcIndex(next)
    } else if (e.key === 'Enter' && acIndexRef.current >= 0) {
      e.preventDefault()
      pickSuggestion(suggestions[acIndexRef.current])
    }
  }

  function wsHostIssue(h) {
    const v = (h || '').trim()
    if (!v) return ''
    if (v.startsWith('/')) return hostSourceIssue(v)?.message || ''
    if (!v.startsWith('instances/')) return 'Must be an absolute path or start with instances/'
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

  // ─── Plan 28: extra volumes / ports validation helpers ─────
  const PROTECTED_DIRS = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp']

  function volHostIssue(h) {
    const v = (h || '').trim()
    if (!v) return 'Host source is required'
    if (v.startsWith('/')) {
      const issue = hostSourceIssue(v, { noun: 'host source' })
      if (issue) return issue.message
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
    for (const p of PROTECTED_DIRS) {
      if (v === p || v.startsWith(p + '/')) return `Cannot mount at the system path ${p}`
    }
    return ''
  }

  function portIssue(n) {
    const v = String(n || '').trim()
    if (!v) return 'Port is required'
    if (!/^\d+$/.test(v) || +v < 1 || +v > 65535) return 'Must be an integer 1–65535'
    return ''
  }

  function updateVolume(i, patch) {
    setExtraVolumes(prev => prev.map((v, idx) => (idx === i ? { ...v, ...patch } : v)))
  }
  function updatePort(i, patch) {
    setExtraPorts(prev => prev.map((p, idx) => (idx === i ? { ...p, ...patch } : p)))
  }

  const volumeErrors = extraVolumes.map((v) => ({
    host: v.type === 'volume'
      ? ((v.host || '').trim()
        ? (/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test((v.host || '').trim())
          ? '' : 'Use letters, digits, dots, dashes or underscores — no slashes')
        : 'Volume name is required')
      : volHostIssue(v.host),
    dir: volDirIssue(v.container),
  }))
  const portErrors = extraPorts.map((p) => portIssue(p.host))
  const hasVolumeErrors = volumeErrors.some((e) => e.host || e.dir)
  const hasPortErrors = portErrors.some(Boolean)
  const networkOptions = containers
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))

  // Trade-off notice: the host file browser only works while the source stays
  // inside this agent's data folder (instances/<name>/<agent>/…). An empty
  // field means the default `instances/…` path is used (resolved on submit).
  const agentDataHost = hostWorkspaceRoot ? `${hostWorkspaceRoot}/instances/${prefix}-${agentType}-${name || ''}/${agentType}` : ''
  const wsHostEff = wsHost.trim()
  const wsBrowsable = agentDataHost && wsHostEff.startsWith(agentDataHost + '/')
  const wsHostErr = wsHostIssue(wsHost)
  /* One message per problem, not two. The local check answers instantly while
     the probe is still in flight, so both were rendering for the same path —
     the inline sentence AND "System directory — cannot be a workspace source."
     under it. The probe is the authoritative one (it read the policy where it
     lives), so its `reason` replaces ours when it arrives. */
  const wsHostProblem = (wsProbe?.issue?.message)
    || (wsProbe?.forbidden ? wsProbe.reason : '')
    || wsHostErr
  const wsDirErr = wsDirIssue(wsDir)
  const wsActive = !!wsHostEff

  // Number of optional settings currently active, shown as a badge on the
  // disclosure toggle so it's obvious the form isn't empty when collapsed.
  const advancedCount = [
    wsActive,
    allowDocker,
    userMode === 'user',
    network,
    extraVolumes.some((v) => v.host && v.container),
    extraPorts.some((p) => p.host),
    buildCommands.trim() ? true : false,
    postCreate.trim() ? true : false,
  ].filter(Boolean).length

  function closeStream() {
    if (esRef.current) {
      try { esRef.current.close() } catch {}
      esRef.current = null
    }
  }

  function startStream(job) {
    closeStream()
    const es = new EventSource(`/api/agents/${job}/create-log`)
    esRef.current = es

    es.addEventListener('step', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data.state === 'start') {
          let cmd
          if (data.cmd) {
            cmd = data.cmd
          } else if (data.step === 'setup') {
            // The real setup command lives in the agent driver; fall back to
            // the openclaw default only if the registry hasn't loaded yet.
            cmd = setupCmdFor(currentType, job) || STEP_COMMANDS.setup(job)
          } else {
            cmd = STEP_COMMANDS[data.step] ? STEP_COMMANDS[data.step](job) : data.step
          }
          setLines(prev => [...prev, { type: 'cmd', cmd, ts: fmtTime(data.ts) }])
          setRunningCmd(cmd)
        } else if (data.state === 'end' || data.state === 'error') {
          setRunningCmd('')
        }
      } catch {}
    })

    es.addEventListener('line', (e) => {
      try {
        const data = JSON.parse(e.data)
        const type = data.stream === 'stderr' ? 'err' : data.stream === 'system' ? 'sys' : 'out'
        const text = data.text.replace(/\n$/, '')
        if (!text) return
        setLines(prev => [...prev, { type, text }])
      } catch {}
    })

    es.addEventListener('done', () => {
      closeStream()
      setRunningCmd('')
      setPhase('done')
      try { sessionStorage.removeItem(DRAFT_KEY) } catch {}
    })

    // Server-sent error event (has data) vs connection loss (no data — the
    // EventSource auto-reconnects with Last-Event-ID and we replay from there).
    es.addEventListener('error', (e) => {
      if (e.data) {
        try {
          const data = JSON.parse(e.data)
          failCreate(data.message || 'Create failed')
        } catch {
          failCreate('Create failed')
        }
      }
    })
  }

  function failCreate(message) {
    closeStream()
    setRunningCmd('')
    setError(message)
    setPhase('failed')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    // One create at a time: a double click (or Enter twice) used to send two
    // requests, and the second one's refusal overwrote the first one's progress.
    if (submitting) return
    setError('')

    // Client-side validation for the new plan 28 options before POSTing.
    if (hasVolumeErrors || hasPortErrors) {
      setError('Fix the highlighted additional volume / port fields before creating')
      return
    }
    const vols = extraVolumes
      .filter((v) => v.host && v.host.trim() && v.container && v.container.trim())
      .map((v) => {
        const row = { host: v.host.trim(), container: v.container.trim(), readonly: !!v.readonly }
        if (v.type === 'volume') {
          row.type = 'volume'
          if (v.external) row.external = v.external
        }
        return row
      })
    const ports = extraPorts
      .filter((p) => p.host && p.host.trim())
      .map((p) => ({ host: p.host.trim(), container: p.container.trim() }))

    setSubmitting(true)
    try {
      const result = await api('/api/agents/create', {
        method: 'POST',
        body: {
          name: `${prefix}-${agentType}-${name}`,
          agent: agentType,
          workspace_host: wsHost.trim(),
          workspace_dir: wsHost.trim() ? (wsDir.trim() || defaultWsDir) : '',
          allowDocker,
          network,
          extraVolumes: vols,
          extraPorts: ports,
          userMode,
          buildCommands: buildCommands.trim(),
          postCreate: postCreate.trim(),
          postStart: postStart.trim(),
          postAttach: postAttach.trim(),
          generateDevContainer,
        },
      })
      setPhase('creating')
      try {
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({
          name, agentType, prefix, wsHost, wsDir, allowDocker, network,
          extraVolumes, extraPorts, showAdvanced, userMode,
          buildCommands, postCreate, postStart, postAttach, generateDevContainer,
        }))
      } catch {}
      navigate('/agents/create/' + result.job, { replace: true })
    } catch (err) {
      setError(err.error || err.message || 'Failed to create agent')
      setPhase('failed')
    } finally {
      setSubmitting(false)
    }
  }

  function resetForm() {
    closeStream()
    setPhase('idle')
    setError('')
    setLines([])
    setRunningCmd('')
    userModeTouched.current = false
    try { sessionStorage.removeItem(DRAFT_KEY) } catch {}
    navigate('/agents/create')
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
      <nav className="flex items-center gap-2 text-sm text-ink-faint mb-6">
        <Link to="/agents" className="hover:text-ink transition-colors">Dashboard</Link>
        <span>/</span>
        <span className="text-ink">Create Agent</span>
      </nav>

      <h1 className="text-2xl font-bold mb-2">Create Agent</h1>
      <p className="text-sm text-ink-dim mb-8">
        Only a name is required — everything else is optional and can be changed later from the agent's settings.
      </p>

      {phase === 'idle' ? (
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Core card — agent identity + workspace source folder */}
          <Card className="border-accent-line/60 p-5 space-y-5">
            <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Create your agent</h3>

            {/* Identity */}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink-faint">{prefix}-</span>
                <div className="w-36 shrink-0">
                  <Select value={agentType} onChange={(e) => setAgentType(e.target.value)}>
                    {agentTypes.length > 0
                      ? agentTypes.map((t) => <option key={t.type} value={t.type}>{t.type}</option>)
                      : <option value="openclaw">openclaw</option>}
                  </Select>
                </div>
                <span className="text-sm text-ink-dim">-</span>
                <Input type="text" value={name} onChange={(e) => setName(e.target.value)} required
                       className="flex-1"
                       placeholder="my-agent"
                       autoFocus />
              </div>

              {nameIssue && <p className="text-xs text-danger mt-2">{nameIssue}</p>}

              <div className="mt-2 flex items-center gap-2 text-xs text-ink-dim">
                <span className={`inline-block w-2 h-2 rounded-full ${name && !nameIssue ? 'bg-success' : 'bg-line-faint'}`} />
                {name && !nameIssue ? (
                  <>Looks good — <code className="text-ink-faint font-mono">{fullName}</code> will be your agent's name.</>
                ) : (
                  <>The container will be named <code className="text-ink-faint font-mono">{fullName}</code>.</>
                )}
              </div>
            </div>

            {/* Workspace source folder — the heart of the form */}
            {!wsHidden && (
              <WorkspaceSourceSection
                wsHost={wsHost}
                onWsHostChange={onWsHostChange}
                onWsKeyDown={onWsKeyDown}
                setSuggestOpen={setSuggestOpen}
                defaultWsHost={defaultWsHost}
                hostWorkspaceRoot={hostWorkspaceRoot}
                wsHidden={wsHidden}
                wsFixed={wsFixed}
                wsDirTouched={wsDirTouched}
                setWsDir={setWsDir}
                wsDir={wsDir}
                suggestOpen={suggestOpen}
                suggestions={suggestions}
                pickSuggestion={pickSuggestion}
                acIndex={acIndex}
                wsHostProblem={wsHostProblem}
                wsProbe={wsProbe}
                discovered={discovered}
              />
            )}

            {/* Advanced settings — switch toggle inside the create card */}
            <div className="border-t border-line pt-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink">Advanced settings</p>
                    {advancedCount > 0 && (
                      <Badge tone="accent" size="md" className="font-semibold leading-none">
                        {advancedCount}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-ink-dim mt-1 max-w-md">
                    Custom workspace path, docker access, network routing, extra volumes and ports.
                  </p>
                </div>
                <Switch
                  checked={showAdvanced}
                  onChange={setShowAdvanced}
                  label="Advanced settings"
                />
              </div>
            </div>

          {showAdvanced && (
            <div className="space-y-5">
          {/* Container workspace path — the host source is on the core card above */}
          {!wsHidden && (
            <WorkspacePathSection
              wsFixed={wsFixed}
              wsDir={wsDir}
              wsDirTouched={wsDirTouched}
              setWsDir={setWsDir}
              defaultWsDir={defaultWsDir}
              wsHost={wsHost}
              agentType={agentType}
              wsDirErr={wsDirErr}
            />
          )}

          {/* Container options — docker + network */}
          <ContainerOptionsSection
            allowDocker={allowDocker}
            setAllowDocker={setAllowDocker}
            prefix={prefix}
            userMode={userMode}
            userModeTouched={userModeTouched}
            setUserMode={setUserMode}
            agentType={agentType}
            network={network}
            setNetwork={setNetwork}
            networkOptions={networkOptions}
          />

          {/* Plan 28 + 40: Additional volumes */}
          <VolumesSection
            extraVolumes={extraVolumes}
            updateVolume={updateVolume}
            volumeErrors={volumeErrors}
            setExtraVolumes={setExtraVolumes}
            hasVolumeErrors={hasVolumeErrors}
          />

          {/* Plan 28: Additional ports */}
          <PortsSection
            extraPorts={extraPorts}
            updatePort={updatePort}
            portErrors={portErrors}
            setExtraPorts={setExtraPorts}
            hasPortErrors={hasPortErrors}
          />

          {/* Plan 41: Build & lifecycle commands */}
          <BuildCommandsSection
            devContainer={devContainer}
            buildCommands={buildCommands}
            setBuildCommands={setBuildCommands}
            postCreate={postCreate}
            setPostCreate={setPostCreate}
            postStart={postStart}
            setPostStart={setPostStart}
            postAttach={postAttach}
            setPostAttach={setPostAttach}
            generateDevContainer={generateDevContainer}
            setGenerateDevContainer={setGenerateDevContainer}
          />
            </div>
          )}
          </Card>

          <Button type="submit" variant="primary" size="lg" block disabled={!name || !!nameIssue || submitting}>
            {name && !nameIssue ? `Create ${fullName}` : 'Create my agent'}
          </Button>
          <p className="text-xs text-ink-dim text-center -mt-2">
            {name && !nameIssue
              ? 'Your agent will be built and booted — this usually takes about a minute.'
              : 'Pick a name to get started.'}
          </p>
        </form>
      ) : (
        <CreateProgress
          phase={phase}
          jobName={jobName}
          resetForm={resetForm}
          error={error}
          runningCmd={runningCmd}
          lines={lines}
          navigate={navigate}
        />
      )}
    </div>
  )
}
