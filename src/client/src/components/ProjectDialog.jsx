import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useMission } from '../stores/mission'
import { useAgents } from '../stores/agents'

// Create / edit a project. A project IS an (agent, folder) pair, so the dialog
// is exactly those two choices plus a name.
//
// Two things this deliberately does NOT do:
//   - it does not offer a personal agent (openclaw/picoclaw/hermes) — Mission
//     is the coding-model workspace, and the backend refuses them anyway;
//   - it does not block a duplicate. Many projects per agent is the normal
//     case, so an exact (agent, folder) pair is a WARNING, not an error.

function useCodingAgents() {
  const agents = useAgents((s) => s.agents)
  return useMemo(
    () => agents.filter((a) => a.mission?.supported || ['opencode', 'codex', 'claude'].includes(a.agent_type)),
    [agents]
  )
}

// The prefill is the agent's effective workspace inside the container: its
// custom workspace mount when it has one, else the driver's default. Both are
// already resolved server-side into `workspace_dir` (see SettingsTab, which
// reads the same value for the same reason).
function defaultFolderFor(agent) {
  return agent?.workspace_dir || agent?.mission?.workspaceDir || ''
}

export default function ProjectDialog({ project, onClose }) {
  const editing = !!project
  const allAgents = useCodingAgents()
  const { createProject, updateProject, probeFolder, folder, clearFolder } = useMission()

  const [name, setName] = useState(project?.name || '')
  const [agentName, setAgentName] = useState(project?.agent_name || '')
  const [folderPath, setFolderPath] = useState(project?.folder || '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const timer = useRef(null)
  const touchedFolder = useRef(!!project)

  // The agent's own workspace dir is the prefill; the user is free to point
  // somewhere else, which is how a second project on the same agent is made.
  useEffect(() => {
    if (editing || !agentName) return
    const agent = allAgents.find((a) => a.name === agentName)
    const df = defaultFolderFor(agent)
    if (df && !touchedFolder.current) setFolderPath(df)
  }, [agentName, allAgents, editing])

  // Debounced live probe. The PAD's own filesystem is the only honest answer
  // for "can I open a session here" — a host path can look fine and still not
  // be mounted in the agent.
  useEffect(() => {
    if (!agentName || !folderPath) {
      clearFolder()
      return
    }
    clearTimeout(timer.current)
    timer.current = setTimeout(() => probeFolder(agentName, folderPath), 250)
    return () => clearTimeout(timer.current)
  }, [agentName, folderPath, probeFolder, clearFolder])

  const runningAgents = allAgents.filter((a) => a.status === 'running')
  const stoppedAgents = allAgents.filter((a) => a.status !== 'running')

  const probe = folder && folder.req === folderPath ? folder : null
  const folderOk = !!probe && probe.exists && probe.isDir
  const duplicate = useMission((s) =>
    s.projects.some((p) => p.agent_name === agentName && p.folder === folderPath.replace(/\/+$/, '') && p.id !== project?.id)
  )

  const canSave = name.trim() && agentName && folderPath && folderOk && !busy

  const onFolderChange = (v) => {
    touchedFolder.current = true
    setFolderPath(v)
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    setError('')
    try {
      const payload = { name: name.trim(), agent: agentName, folder: folderPath.replace(/\/+$/, '') || '/' }
      if (editing) await updateProject(project.id, { name: payload.name, folder: payload.folder })
      else await createProject(payload)
      onClose()
    } catch (err) {
      setError(err?.error || err?.message || 'Could not save the project')
    } finally {
      setBusy(false)
    }
  }

  // A chip is either a child of what is typed, or — for ".." — the parent.
  const suggestions = useMemo(() => {
    if (!probe) return []
    const base = folderPath.replace(/\/+$/, '')
    const entries = (probe.entries || []).slice(0, 12)
    const kids = entries.map((e) => `${base}/${e}`)
    return base && base !== '/' ? ['..', ...kids] : kids
  }, [probe, folderPath])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line-faint px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{editing ? 'Edit project' : 'New project'}</h2>
          <button type="button" onClick={onClose} className="text-ink-faint hover:text-ink text-lg leading-none px-1">×</button>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Craftpip site"
              autoFocus
              className="rounded-lg border border-line bg-sunken px-2.5 py-1.5 text-sm text-ink outline-none focus:border-accent"
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Agent</span>
            {allAgents.length === 0 ? (
              <div className="rounded-lg border border-line bg-sunken px-3 py-2 text-xs text-ink-faint">
                No coding agent yet.{' '}
                <a href="/agents/create" className="text-accent hover:underline">Create an agent first</a>
                <div className="mt-1 text-ink-faint/80">Mission works with opencode, codex and claude.</div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {runningAgents.map((a) => (
                  <button
                    key={a.name}
                    type="button"
                    onClick={() => setAgentName(a.name)}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                      agentName === a.name
                        ? 'border-accent bg-accent/10 text-ink'
                        : 'border-line bg-sunken text-ink-dim hover:border-line-faint'
                    }`}
                  >
                    {a.name}
                    <span className="ml-1.5 text-ink-faint">{a.agent_type}</span>
                  </button>
                ))}
                {stoppedAgents.length > 0 && (
                  <span className="self-center text-[11px] text-ink-faint">
                    {stoppedAgents.length} stopped — start one to open a session
                  </span>
                )}
              </div>
            )}
            {editing && (
              <span className="text-[11px] text-ink-faint">The agent cannot be changed — a project is tied to its PAD.</span>
            )}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Folder inside the PAD</span>
            <input
              value={folderPath}
              onChange={(e) => onFolderChange(e.target.value)}
              placeholder="/www1/craftpip.com"
              spellCheck={false}
              className="rounded-lg border border-line bg-sunken px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:border-accent"
            />
            <span className={`text-[11px] ${folderOk ? 'text-ok' : probe?.checking ? 'text-ink-faint' : 'text-warn'}`}>
              {!agentName
                ? 'Pick an agent first.'
                : !folderPath
                  ? `Pick a folder inside the PAD${defaultFolderFor(allAgents.find((a) => a.name === agentName)) ? '.' : ' — this agent has no workspace folder.'}`
                  : probe?.checking
                    ? 'Checking inside the PAD…'
                    : folderOk
                      ? 'Openable in this PAD.'
                      : probe?.error || 'Not found inside the PAD — mount it in Settings → Extra volumes, or pick a path the PAD already sees.'}
            </span>
            {!folderPath && agentName && (
              <div className="mt-1 flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wider text-ink-faint">Mounted in this PAD</span>
                <FolderChips agentName={agentName} onPick={onFolderChange} />
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => onFolderChange(s === '..' ? folderPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/' : s)}
                    className="max-w-full truncate rounded-md bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-dim hover:text-ink"
                    title={s}
                  >
                    {s === '..' ? '..' : s.split('/').pop()}
                  </button>
                ))}
              </div>
            )}
          </label>

          {duplicate && (
            <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              This agent already has a project on that folder. That is allowed — the two would share the
              same working directory.
            </div>
          )}
          {error && <div className="rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">{error}</div>}

          <footer className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-ink-dim hover:bg-raised">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink disabled:opacity-40"
            >
              {busy ? 'Saving…' : editing ? 'Save' : 'Create project'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

/** The suggestion chips for a project folder are the whole trick that makes a
 *  second project on the same agent a two-click job, so they read the agent's
 *  real mounts (settings → workspace mount + extra volumes) when there is
 *  nothing typed yet. */
export function FolderChips({ agentName, onPick }) {
  const [hints, setHints] = useState([])
  useEffect(() => {
    if (!agentName) {
      setHints([])
      return
    }
    let live = true
    api(`/api/agents/${agentName}/settings`)
      .then((d) => {
        if (!live) return
        const out = []
        const ws = d?.workspaceMount?.container || d?.settings?.workspaceDir
        if (ws) out.push(ws)
        for (const v of d?.extraVolumes || []) if (v?.container) out.push(v.container)
        setHints([...new Set(out)].filter(Boolean))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [agentName])
  if (hints.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1">
      {hints.map((h) => (
        <button
          key={h}
          type="button"
          onClick={() => onPick(h)}
          className="max-w-full truncate rounded-md bg-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-dim hover:text-ink"
          title={h}
        >
          {h}
        </button>
      ))}
    </div>
  )
}
