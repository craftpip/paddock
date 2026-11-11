import { useEffect, useMemo, useRef, useState } from 'react'
import { useDirtyNavigation, useDraftState, useNavigation, popupIdentity } from '../lib/navigation'
import { api } from '../lib/api'
import { cx } from '../lib/cx'
import { useMission } from '../stores/mission'
import { useAgents } from '../stores/agents'
import Button from './ui/Button'
import Choice from './ui/Choice'
import { Input } from './ui/Input'
import { TONES } from './ui/tone'
import Modal from './ui/Modal'

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
  const { drafts } = useNavigation()
  const prefix = `project:${project?.id || 'new'}:`
  const saved = useRef(false)
  const clearDrafts = () => { for (const key of drafts.keys()) if (key.startsWith(prefix)) drafts.delete(key) }
  const editing = !!project
  const allAgents = useCodingAgents()
  const { createProject, updateProject, probeFolder, folder, clearFolder } = useMission()

  const [name, setName] = useDraftState(prefix + 'name', project?.name || '')
  const [agentName, setAgentName] = useDraftState(prefix + 'agent', project?.agent_name || '')
  const [folderPath, setFolderPath] = useDraftState(prefix + 'folder', project?.folder || '')
  const [plansFolder, setPlansFolder] = useDraftState(prefix + 'plans', project?.plans_folder || 'plans')
  const dirty = name !== (project?.name || '') || agentName !== (project?.agent_name || '') || folderPath !== (project?.folder || '') || plansFolder !== (project?.plans_folder || 'plans')
  useDirtyNavigation(() => dirty && !saved.current, popupIdentity, clearDrafts)
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
  // The plans folder is RELATIVE to the project folder, so an absolute path or
  // a `..` segment is the one thing it must never be — the server refuses both,
  // and a client that let them through would surface the refusal only on save.
  const plansFolderNorm = plansFolder.trim().replace(/\/+$/, '')
  const plansFolderOk =
    plansFolderNorm.length > 0 &&
    plansFolderNorm.length <= 120 &&
    !plansFolderNorm.startsWith('/') &&
    !plansFolderNorm.split('/').includes('..')
  const duplicate = useMission((s) =>
    s.projects.some((p) => p.agent_name === agentName && p.folder === folderPath.replace(/\/+$/, '') && p.id !== project?.id)
  )

  const canSave = name.trim() && agentName && folderPath && folderOk && plansFolderOk && !busy

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
      const payload = { name: name.trim(), agent: agentName, folder: folderPath.replace(/\/+$/, '') || '/', plansFolder: plansFolderNorm }
      if (editing) await updateProject(project.id, { name: payload.name, folder: payload.folder, plansFolder: payload.plansFolder })
      else await createProject(payload)
      saved.current = true
      clearDrafts()
      onClose({ saved: true })
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
    <Modal onClose={onClose} width="max-w-lg" backdropClassName="msn-dialog-backdrop"
      panelClassName="msn-dialog max-h-[90dvh]" bodyClassName="p-0" bodyScroll>
        <header className="msn-dialog-header flex items-center justify-between border-b border-line-faint px-4 py-3">
          <h2 className="msn-dialog-title text-sm font-semibold text-ink">{editing ? 'Edit project' : 'New project'}</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon
            onClick={onClose}
            aria-label="Close"
            className="msn-btn-close-dialog text-lg leading-none"
          >
            ×
          </Button>
        </header>

        {/* Every msn-* class below is a browser-test hook (plans/53 §6). The
            styles come from the primitives; the hooks stay on the exact element
            they are on today. Do not merge one away. */}
        <form onSubmit={submit} className="msn-dialog-form flex flex-col gap-3 p-4">
          <label className="msn-field msn-field-name flex flex-col gap-1">
            <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Craftpip site"
              autoFocus
              className="msn-input-name"
            />
          </label>

          <div className="msn-field msn-field-agent flex flex-col gap-1">
            <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Agent</span>
            {allAgents.length === 0 ? (
              <div className="msn-no-agent rounded-control border border-line bg-sunken px-3 py-2 text-xs text-ink-faint">
                No coding agent yet.{' '}
                <a href="/agents/create" className="msn-link-create-agent text-accent-text hover:underline">
                  Create an agent first
                </a>
                <div className="msn-no-agent-note mt-1 text-ink-dim">Mission works with opencode, codex and claude.</div>
              </div>
            ) : (
              <div className="msn-agent-options flex flex-wrap gap-1.5">
                {runningAgents.map((a) => (
                  <Choice
                    key={a.name}
                    selected={agentName === a.name}
                    onClick={() => setAgentName(a.name)}
                    // msn-selected is a browser-test hook on the SELECTED option
                    className={cx('msn-agent-option', agentName === a.name && 'msn-selected')}
                  >
                    {a.name}
                    <span className="msn-agent-type ml-1.5 text-ink-faint">{a.agent_type}</span>
                  </Choice>
                ))}
                {stoppedAgents.length > 0 && (
                  <span className="msn-stopped-note self-center text-[11px] text-ink-faint">
                    {stoppedAgents.length} stopped — start one to open a session
                  </span>
                )}
              </div>
            )}
            {editing && (
              <span className="msn-field-note text-[11px] text-ink-dim">
                The agent cannot be changed — a project is tied to its PAD.
              </span>
            )}
          </div>

          <label className="msn-field msn-field-folder flex flex-col gap-1">
            <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Folder inside the PAD
            </span>
            <Input
              mono
              size="sm"
              value={folderPath}
              onChange={(e) => onFolderChange(e.target.value)}
              placeholder="/www1/craftpip.com"
              spellCheck={false}
              className="msn-input-folder"
            />
            <span
              className={cx(
                'msn-folder-status text-[11px]',
                folderOk ? 'msn-ok text-success' : probe?.checking ? 'text-ink-faint' : 'msn-warn text-warning'
              )}
            >
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
              <div className="msn-folder-chips mt-1 flex flex-col gap-1">
                <span className="msn-field-label text-[10px] uppercase tracking-wider text-ink-faint">
                  Mounted in this PAD
                </span>
                <FolderChips agentName={agentName} onPick={onFolderChange} />
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="msn-suggestions mt-1 flex flex-wrap gap-1">
                {suggestions.map((s) => (
                  <Choice
                    key={s}
                    variant="chip"
                    mono
                    onClick={() =>
                      onFolderChange(
                        s === '..' ? folderPath.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/' : s
                      )
                    }
                    className="msn-suggestion-chip"
                    title={s}
                  >
                    {s === '..' ? '..' : s.split('/').pop()}
                  </Choice>
                ))}
              </div>
            )}
          </label>

          <label className="msn-field msn-field-plans-folder flex flex-col gap-1">
            <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Plans folder
            </span>
            <Input
              mono
              size="sm"
              value={plansFolder}
              onChange={(e) => setPlansFolder(e.target.value)}
              placeholder="plans"
              spellCheck={false}
              className="msn-input-plans-folder"
            />
            <span
              className={cx(
                'msn-plans-folder-status text-[11px]',
                plansFolderOk ? 'text-ink-faint' : 'msn-warn text-warning'
              )}
            >
              {plansFolderOk
                ? `Relative to the project folder — ${folderPath.trim() ? `${folderPath.replace(/\/+$/, '')}/` : ''}${plansFolderNorm}/`
                : 'A relative folder name only — no absolute paths or "..".'}
            </span>
          </label>

          {duplicate && (
            <p className={cx('msn-dup-warning rounded-control border px-3 py-2 text-xs', TONES.warning.panel)}>
              This agent already has a project on that folder. That is allowed — the two would share the same working
              directory.
            </p>
          )}
          {error && (
            <p className={cx('msn-error-bar rounded-control border px-3 py-2 text-xs', TONES.danger.panel)}>{error}</p>
          )}

          <footer className="msn-dialog-footer flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="msn-btn-cancel">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!canSave}
              loading={busy}
              className="msn-btn-submit"
            >
              {busy ? 'Saving…' : editing ? 'Save' : 'Create project'}
            </Button>
          </footer>
        </form>
    </Modal>
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
    <div className="msn-folder-chips-list flex flex-wrap gap-1">
      {hints.map((h) => (
        <Choice
          key={h}
          variant="chip"
          mono
          onClick={() => onPick(h)}
          className="msn-folder-chip"
          title={h}
        >
          {h}
        </Choice>
      ))}
    </div>
  )
}
