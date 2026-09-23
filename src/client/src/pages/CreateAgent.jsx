import { useState, useEffect, useRef } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { api } from '../lib/api'
import Console from '../components/Console'

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
    probeAndDiscover(s)
  }

  function onWsHostChange(v) {
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

  async function probeAndDiscover(q) {
    if (!q.startsWith('/')) { setWsProbe(null); return }
    let p = null
    try {
      const r = await api(`/api/paths/probe?path=${encodeURIComponent(q)}`)
      if (String(r.path) === q.trim()) p = r
    } catch {}
    setWsProbe(p)
    if (!p || !p.exists || !p.compose) {
      // No compose project: still look for a devcontainer.json (plan 41) so the
      // post-create box can pre-fill from the workspace's own spec file.
      const foundDc = await probeDevContainer(q)
      if (!foundDc) autoFillWsDirFromHost(q)
      return
    }
    try {
      const d = await api(`/api/paths/volumes?path=${encodeURIComponent(q)}`)
      if (String(d.path) !== q.trim()) return
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
    const foundDc = await probeDevContainer(q)
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

  // ─── Plan 28: extra volumes / ports validation helpers ─────
  const SYSTEM_DIRS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/bin', '/sbin', '/usr', '/lib', '/home', '/root', '/opt', '/tmp', '/var/run']
  const PROTECTED_DIRS = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/usr', '/bin', '/sbin', '/lib', '/boot', '/tmp']

  function volHostIssue(h) {
    const v = (h || '').trim()
    if (!v) return 'Host source is required'
    if (v.startsWith('/')) {
      if (v === '/') return 'Cannot be the host root'
      for (const s of SYSTEM_DIRS) {
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
          <div className="bg-panel/60 border border-accent-line/60 rounded-xl p-5 space-y-5">
            <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Create your agent</h3>

            {/* Identity */}
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-ink-faint">{prefix}-</span>
                <select value={agentType} onChange={(e) => setAgentType(e.target.value)}
                        className="bg-raised border border-line-faint rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line w-36">
                  {agentTypes.length > 0
                    ? agentTypes.map((t) => <option key={t.type} value={t.type}>{t.type}</option>)
                    : <option value="openclaw">openclaw</option>}
                </select>
                <span className="text-sm text-ink-dim">-</span>
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
                       placeholder="my-agent"
                       autoFocus
                       className="flex-1 bg-raised border border-line-faint rounded-lg px-3 py-2.5 text-sm text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
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
              <div className="border-t border-line pt-4">
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="ws-host" className="block text-xs font-medium text-ink-faint uppercase tracking-wider">
                    Host workspace path
                  </label>
                  <span className="text-[11px] text-ink-faint">The project your agent works on</span>
                </div>
                <div className="relative">
                  <input id="ws-host" type="text" value={wsHost}
                         onChange={(e) => onWsHostChange(e.target.value)}
                         onKeyDown={onWsKeyDown}
                         onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                         placeholder={defaultWsHost}
                         className="w-full bg-raised border border-line-faint rounded-lg pl-3 pr-9 py-2.5 text-sm font-mono text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
                  {hostWorkspaceRoot && !wsHidden && !wsFixed && wsHost.trim().startsWith('/') && !wsHost.trim().startsWith('instances/') && (
                    <button type="button"
                            onClick={() => { wsDirTouched.current = true; setWsDir(wsHost.trim()) }}
                            title={wsDir === wsHost.trim() ? 'Paths are synced' : 'Sync container path to this path'}
                            className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded transition-colors ${
                              wsDir === wsHost.trim() && wsDir
                                ? 'bg-success text-white'
                                : 'text-ink-faint hover:bg-sunken hover:text-ink'
                            }`}>
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                      </svg>
                    </button>
                  )}
                  {suggestOpen && suggestions.length > 0 && (
                    <div className="absolute z-20 mt-1 w-full max-h-60 overflow-auto bg-raised border border-line rounded-lg shadow-xl">
                      {suggestions.map((s, i) => (
                        <button key={s} type="button"
                                onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s) }}
                                className={`block w-full text-left px-3 py-2 text-xs font-mono text-ink hover:bg-sunken transition-colors ${i === acIndex ? 'bg-sunken' : ''}`}>
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <p className="text-xs text-ink-dim mt-1.5">
                  This folder is where your agent's files live on this PC — open it directly from your file manager.
                </p>
                {wsHostErr && <p className="text-xs text-danger mt-1">{wsHostErr}</p>}
                {wsProbe && wsProbe.forbidden && (
                  <p className="text-xs text-danger mt-1">System directory — cannot be a workspace source.</p>
                )}
                {wsProbe && !wsProbe.forbidden && !wsProbe.exists && (
                  <p className="text-xs text-amber mt-1">Folder not found in paddock — mount the project folder one-to-one (same path in host and container) to use it.</p>
                )}
                {wsProbe && !wsProbe.forbidden && wsProbe.exists && !wsProbe.compose && (
                  <p className="text-xs text-success mt-1">Path resolves.</p>
                )}
                {discovered && (
                  <div className="mt-2 rounded-lg bg-success-soft border border-success-line px-3 py-2 text-xs text-success">
                    {discovered.count} volume{discovered.count === 1 ? '' : 's'} found in <code className="font-mono">{discovered.project}</code>'s compose file — pre-filled under <span className="font-medium">Advanced settings → Additional volumes</span>. Review, edit or remove them before creating.
                  </div>
                )}
              </div>
            )}

            {/* Advanced settings — switch toggle inside the create card */}
            <div className="border-t border-line pt-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-ink">Advanced settings</p>
                    {advancedCount > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full bg-accent/15 text-accent text-xs font-semibold leading-none">
                        {advancedCount}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-ink-dim mt-1 max-w-md">
                    Custom workspace path, docker access, network routing, extra volumes and ports.
                  </p>
                </div>
                <button type="button"
                        role="switch"
                        aria-checked={showAdvanced}
                        onClick={() => setShowAdvanced(!showAdvanced)}
                        className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${showAdvanced ? 'bg-accent' : 'bg-raised'}`}>
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${showAdvanced ? 'translate-x-4' : ''}`} />
                </button>
              </div>
            </div>

          {showAdvanced && (
            <div className="space-y-5">
          {/* Container workspace path — the host source is on the core card above */}
          {!wsHidden && (
            <div className="border-t border-line pt-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Container workspace path</h3>
                {wsFixed && (
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-sunken border border-line-faint text-ink-dim text-[11px] font-medium">
                    <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
                    </svg>
                    Fixed
                  </span>
                )}
              </div>
              <p className="text-xs text-ink-dim mb-2">
                The path inside the container where the agent sees the workspace folder. Leave empty to use the driver default.
              </p>
              <div className="relative">
                <input type="text" value={wsDir}
                       onChange={(e) => { if (!wsFixed) { wsDirTouched.current = true; setWsDir(e.target.value) } }}
                       readOnly={wsFixed}
                       tabIndex={wsFixed ? -1 : 0}
                       placeholder={defaultWsDir || '/root/.openclaw/workspace'}
                       className={`w-full rounded-lg text-sm font-mono focus:outline-none ${wsFixed
                         ? 'bg-sunken border border-dashed border-line-faint text-ink-dim cursor-not-allowed px-3 py-2'
                         : 'bg-raised border border-line-faint text-ink focus:border-accent-line pl-3 pr-9 py-2'}`} />
                {!wsFixed && wsHost.trim().startsWith('/') && !wsHost.trim().startsWith('instances/') && (
                  <button type="button"
                          onClick={() => { wsDirTouched.current = true; setWsDir(wsHost.trim()) }}
                          title={wsDir === wsHost.trim() ? 'Paths are synced' : 'Sync container path to this path'}
                          className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded transition-colors ${
                            wsDir === wsHost.trim() && wsDir
                              ? 'bg-success text-white'
                              : 'text-ink-faint hover:bg-sunken hover:text-ink'
                          }`}>
                    <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                  </button>
                )}
              </div>
              {wsFixed && (
                <p className="text-xs text-ink-dim mt-1">
                  <span className="text-ink-faint">Locked —</span> fixed by {agentType}, whose CLI requires the workspace at this path.
                </p>
              )}
              {wsDirErr && <p className="text-xs text-danger mt-1">{wsDirErr}</p>}
            </div>
          )}

          {/* Container options — docker + network */}
          <div className="border-t border-line pt-4">
            <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Container options</h3>

            <div className="mt-3 flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-ink">Allow docker in the container</p>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Mounts the host docker socket + installs the docker CLI. Rebuilds the image during creation.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={allowDocker}
                onClick={() => setAllowDocker(!allowDocker)}
                className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${allowDocker ? 'bg-accent' : 'bg-raised'}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${allowDocker ? 'translate-x-4' : ''}`} />
              </button>
            </div>
            {allowDocker && (
              <p className="text-xs text-warning/90 bg-warning-soft border border-warning-line/60 rounded-lg px-3 py-2">
                ⚠ The docker socket is host-root equivalent — this agent can control the entire host.
              </p>
            )}

            {/* Container user (plan 43 Phase 7): root vs the pad user */}
            <div className="mt-4">
              <div className="flex items-center justify-between">
                <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Container user</label>
                <span className="text-[11px] text-ink-dim">pad uid {prefix === 'vm' ? '1000:1000' : 'PUID:PGID'}</span>
              </div>
              <div className="inline-flex rounded-lg border border-line-faint bg-sunken p-0.5">
                <button type="button"
                        onClick={() => { userModeTouched.current = true; setUserMode('root') }}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${userMode === 'root' ? 'bg-accent text-white' : 'text-ink-dim hover:text-ink'}`}>
                  Root
                </button>
                <button type="button"
                        disabled={agentType === 'hermes'}
                        onClick={() => { userModeTouched.current = true; setUserMode('user') }}
                        className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${userMode === 'user' ? 'bg-accent text-white' : 'text-ink-dim hover:text-ink'} ${agentType === 'hermes' ? 'opacity-40 cursor-not-allowed' : ''}`}>
                  Local user
                </button>
              </div>
              {agentType === 'hermes' ? (
                <p className="text-xs text-ink-dim mt-1.5">
                  Hermes already runs its daemon as its own user (/opt/data) — the option does not apply.
                </p>
              ) : (
                <p className="text-xs text-ink-dim mt-1.5">
                  {userMode === 'user'
                    ? 'The agent daemon and terminal run as the pad user — every file they write is user-owned on the host. SSH stays the root admin door.'
                    : 'The agent daemon runs as root (legacy default). Choose Local user to run agent processes as the pad user.'}
                </p>
              )}
            </div>

            <div className="mt-4">
              <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Network</label>
              <select value={network} onChange={(e) => setNetwork(e.target.value)}
                      className="w-full sm:w-96 bg-raised border border-line-faint rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-accent-line">
                <option value="">Default (no override)</option>
                {networkOptions.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}{c.state !== 'running' ? '  (stopped)' : ''}
                  </option>
                ))}
              </select>
              <p className="text-xs text-ink-dim mt-1.5">
                Route the agent through another running container by joining its network namespace (e.g. gluetun for VPN).
              </p>
              <p className="text-xs text-ink-dim mt-1.5">
                In peer mode, published ports (web, additional ports) are forwarded through a socat door on the peer's bridge — no limitation.
              </p>
            </div>
          </div>

          {/* Plan 28 + 40: Additional volumes */}
          <div className="border-t border-line pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Additional volumes</h3>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Extra mounts beyond the data and workspace folders: host → container bind mounts or named Docker volumes. Changing them later requires a recreate.
                </p>
              </div>
            </div>

            {extraVolumes.length === 0 && (
              <p className="text-xs text-ink-dim">No additional volumes.</p>
            )}
            {extraVolumes.length > 0 && (
              <div className="rounded-lg overflow-hidden border border-line-faint">
                <div className="bg-sunken text-ink-faint uppercase tracking-wider text-[11px] px-2 py-2 flex items-center gap-2 font-medium">
                  <span className="w-32 shrink-0">Type</span>
                  <span className="flex-1 min-w-0">Host source / Volume name</span>
                  <span className="flex-1 min-w-0">Container path</span>
                  <span className="w-7 shrink-0 text-center" title="Read-only mount">Ro</span>
                  <span className="w-7 shrink-0"></span>
                </div>
                {extraVolumes.map((v, i) => (
                  <div key={i} className="border-t border-line-faint flex items-start gap-2 px-2 py-1.5">
                    <div className="w-32 shrink-0">
                      <select value={v.type || 'bind'}
                              onChange={(e) => updateVolume(i, { type: e.target.value })}
                              className="w-full h-7 bg-raised border border-line-faint rounded-lg px-1.5 text-xs text-ink focus:outline-none focus:border-accent-line">
                        <option value="bind">Bind mount</option>
                        <option value="volume">Named volume</option>
                      </select>
                    </div>
                    <div className="flex-1 min-w-0">
                      <input type="text" value={v.host}
                             onChange={(e) => updateVolume(i, { host: e.target.value })}
                             title={v.type === 'volume' ? (v.external ? `Attaches the existing volume ${v.external}` : 'Creates a fresh volume') : undefined}
                             placeholder={v.type === 'volume' ? 'e.g. mempalace-dbdata' : 'e.g. /mnt/shared'}
                             className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                      {volumeErrors[i].host && <p className="text-xs text-danger mt-0.5">{volumeErrors[i].host}</p>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <input type="text" value={v.container}
                             onChange={(e) => updateVolume(i, { container: e.target.value })}
                             placeholder="e.g. /data"
                             className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                      {volumeErrors[i].dir && <p className="text-xs text-danger mt-0.5">{volumeErrors[i].dir}</p>}
                    </div>
                    <div className="w-7 shrink-0 h-7 flex items-center justify-center" title="Read-only mount">
                      <input type="checkbox" checked={!!v.readonly}
                             onChange={(e) => updateVolume(i, { readonly: e.target.checked })}
                             title="Read-only mount"
                             className="w-3.5 h-3.5 accent-accent" />
                    </div>
                    <div className="w-7 shrink-0">
                      <button type="button" onClick={() => setExtraVolumes(prev => prev.filter((_, idx) => idx !== i))}
                              className="w-7 h-7 grid place-items-center rounded-md text-ink-dim hover:text-danger hover:bg-raised transition-colors"
                              title="Remove volume">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button type="button"
                    onClick={() => setExtraVolumes(prev => [...prev, { type: 'bind', host: '', container: '', readonly: false }])}
                    className="px-3 py-1.5 bg-raised hover:bg-raised-hover text-ink rounded-lg text-xs font-medium transition-colors">
              + Add volume
            </button>
            {hasVolumeErrors && (
              <p className="text-xs text-danger">Fix the invalid volume fields — the source and container path must both be valid.</p>
            )}
          </div>

          {/* Plan 28: Additional ports */}
          <div className="border-t border-line pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Additional ports</h3>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Host → container TCP port mappings, independent of the SSH port.
                </p>
              </div>
            </div>

            {extraPorts.length === 0 && (
              <p className="text-xs text-ink-dim">No port mappings.</p>
            )}
            {extraPorts.length > 0 && (
              <div className="rounded-lg overflow-hidden border border-line-faint">
                <div className="bg-sunken text-ink-faint uppercase tracking-wider text-[11px] px-2 py-2 flex items-center gap-2 font-medium">
                  <span className="flex-1 min-w-0">Host port</span>
                  <span className="flex-1 min-w-0">Container port</span>
                  <span className="w-7 shrink-0"></span>
                </div>
                {extraPorts.map((p, i) => (
                  <div key={i} className="border-t border-line-faint flex items-start gap-2 px-2 py-1.5">
                    <div className="flex-1 min-w-0">
                      <input type="number" min="1" max="65535" value={p.host}
                             onChange={(e) => updatePort(i, { host: e.target.value })}
                             placeholder="e.g. 9000"
                             className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                      {portErrors[i] && <p className="text-xs text-danger mt-0.5">{portErrors[i]}</p>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <input type="number" min="1" max="65535" value={p.container}
                             onChange={(e) => updatePort(i, { container: e.target.value })}
                             placeholder="e.g. 80"
                             className="w-full h-7 min-w-0 bg-raised border border-line-faint rounded-lg px-2 text-xs font-mono text-ink focus:outline-none focus:border-accent-line placeholder-ink-dim" />
                    </div>
                    <div className="w-7 shrink-0">
                      <button type="button" onClick={() => setExtraPorts(prev => prev.filter((_, idx) => idx !== i))}
                              className="w-7 h-7 grid place-items-center rounded-md text-ink-dim hover:text-danger hover:bg-raised transition-colors"
                              title="Remove port">✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <button type="button"
                    onClick={() => setExtraPorts(prev => [...prev, { host: '', container: '' }])}
                    className="px-3 py-1.5 bg-raised hover:bg-raised-hover text-ink rounded-lg text-xs font-medium transition-colors">
              + Add port
            </button>
            {hasPortErrors && (
              <p className="text-xs text-danger">Fix the invalid port fields.</p>
            )}
          </div>

          {/* Plan 41: Build & lifecycle commands */}
          <div className="border-t border-line pt-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Build &amp; lifecycle commands</h3>
                <p className="text-xs text-ink-dim mt-1 max-w-md">
                  Dockerfile lines inserted into this PAD's own image (run on every build), and bash lines run once after creation (post-create), on every start (post-start), and on every terminal attach (post-attach).
                </p>
              </div>
              {devContainer && (
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-sunken border border-line-faint text-ink-dim text-[11px] font-medium">
                  from .devcontainer/devcontainer.json
                </span>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Build commands (Dockerfile)</label>
              <textarea value={buildCommands} onChange={(e) => setBuildCommands(e.target.value)}
                        rows={3}
                        spellCheck={false}
                        placeholder={'RUN apt-get install -y vim\n# or an ARG line, picked up by the next build'}
                        className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
              <p className="text-xs text-ink-dim mt-1">
                Runs inside <code className="text-ink-faint font-mono">instances/&lt;name&gt;/build/Dockerfile</code> on every image build. A <code className="text-ink-faint font-mono">FROM</code> line here fails the build (the current container stays up).
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Post-create commands (bash)</label>
              <textarea value={postCreate} onChange={(e) => setPostCreate(e.target.value)}
                        rows={3}
                        spellCheck={false}
                        placeholder={'npm install\n# project setup, run once after the container boots'}
                        className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
              <p className="text-xs text-ink-dim mt-1">
                Runs once in the running container (project mounted, services up) after creation. Pre-filled from the workspace's <code className="text-ink-faint font-mono">devcontainer.json</code> when present — edit freely.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Post-start commands (bash)</label>
              <textarea value={postStart} onChange={(e) => setPostStart(e.target.value)}
                        rows={3}
                        spellCheck={false}
                        placeholder={'service cron start\n# runs on every container start'}
                        className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
              <p className="text-xs text-ink-dim mt-1">
                Runs on every container start (baked into <code className="text-ink-faint font-mono">start.sh</code>). Pre-filled from <code className="text-ink-faint font-mono">postStartCommand</code> in the workspace's devcontainer.
              </p>
            </div>

            <div>
              <label className="block text-xs font-medium text-ink-faint mb-1.5 uppercase tracking-wider">Post-attach commands (bash)</label>
              <textarea value={postAttach} onChange={(e) => setPostAttach(e.target.value)}
                        rows={3}
                        spellCheck={false}
                        placeholder={'echo "terminal attached"\n# runs on every terminal attach'}
                        className="w-full rounded-lg px-3 py-2 text-sm font-mono bg-raised border border-line-faint text-ink focus:outline-none focus:border-accent-line focus:ring-1 focus:ring-accent-line placeholder-ink-dim" />
              <p className="text-xs text-ink-dim mt-1">
                Runs on every terminal attach inside this PAD (workspace/project mounted). Pre-filled from <code className="text-ink-faint font-mono">postAttachCommand</code> in the workspace's devcontainer.
              </p>
            </div>

            {/* Plan 41 item 20: generate a devcontainer mirror in the workspace */}
            <label className="flex items-start gap-2.5 rounded-lg border border-line-faint bg-sunken/50 px-3 py-2.5 cursor-pointer select-none">
              <input type="checkbox"
                     checked={generateDevContainer}
                     onChange={(e) => setGenerateDevContainer(e.target.checked)}
                     className="mt-0.5 w-3.5 h-3.5 accent-accent" />
              <span>
                <span className="block text-xs font-medium text-ink">
                  Generate <code className="text-ink-faint font-mono">.devcontainer/devcontainer.json</code> for this workspace
                </span>
                <span className="block text-xs text-ink-dim mt-0.5">
                  When the workspace has no devcontainer, writes one mirroring this pad's settings (workspace folder, lifecycle commands, env, volumes, ports, user), marked <code className="text-ink-faint font-mono">x-paddock.generated</code>. {devContainer ? 'This workspace already ships a devcontainer — it is never overwritten.' : 'Leave on to keep the workspace openable as a dev container.'}
                </span>
              </span>
            </label>
          </div>
            </div>
          )}
          </div>

          <button type="submit" disabled={!name || !!nameIssue}
                  className="w-full bg-gradient-to-r from-accent to-accent-deep hover:from-accent-hover hover:to-accent-deep text-accent-ink font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-accent/25 disabled:opacity-50">
            {name && !nameIssue ? `Create ${fullName}` : 'Create my agent'}
          </button>
          <p className="text-xs text-ink-dim text-center -mt-2">
            {name && !nameIssue
              ? 'Your agent will be built and booted — this usually takes about a minute.'
              : 'Pick a name to get started.'}
          </p>
        </form>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-ink-faint">
              {phase === 'creating' && (
                <>
                  <span className="inline-block w-3 h-3 rounded-full border-2 border-accent-line border-t-transparent animate-spin mr-2 align-middle" />
                  Creating <span className="text-ink font-medium">{jobName}</span>…
                </>
              )}
              {phase === 'done' && (
                <span className="text-success font-medium">
                  Agent created! Setup complete.
                </span>
              )}
              {phase === 'failed' && (
                <span className="text-danger font-medium">Create failed</span>
              )}
            </div>
            {phase !== 'creating' && (
              <button onClick={resetForm}
                      className="text-sm text-ink-faint hover:text-ink transition-colors">
                ← Back to form
              </button>
            )}
          </div>

          {phase === 'failed' && (
            <div className="bg-danger-soft border border-danger-line rounded-xl p-4 text-sm text-danger">{error}</div>
          )}

          <Console
            label="Create log"
            runningCmd={runningCmd}
            lines={lines}
            emptyMessage="Waiting for output…"
            className="h-[60vh]"
          />

          {phase === 'done' && (
            <button onClick={() => navigate('/agents/' + jobName)}
                    className="w-full bg-gradient-to-r from-accent to-accent-deep hover:from-accent-hover hover:to-accent-deep text-accent-ink font-semibold py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-accent/25">
              Go to {jobName}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
