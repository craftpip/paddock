import { useCallback, useEffect, useState } from 'react'
import Splitter from '../components/Splitter'
import ProjectDialog from '../components/ProjectDialog'
import { useMission } from '../stores/mission'
import { useAgents } from '../stores/agents'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Mission — project → session → live agent TUI, in three columns.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  A project is an (agent, folder) pair. A session is the only unit of work: a
 *  tmux session inside the agent's PAD with the agent's TUI running in that
 *  folder, which the human and the agent type into alike. The three columns are
 *  that story left to right, and the third one is the real Terminal component
 *  (plan 53 §6 — never a second terminal).
 *
 *  Phase 2 is the skeleton: layout, resizable columns, empty states. Phase 3
 *  fills col 1 with live projects and the create/edit dialog. Sessions land
 *  next.
 *
 *  Column widths are persisted per browser (`pad-mission-col1` / `-col2`), so
 *  the page comes back the way you left it; double-click a divider to reset.
 */
const COL1_KEY = 'pad-mission-col1'
const COL2_KEY = 'pad-mission-col2'
const DEFAULT_COL1 = 260
const DEFAULT_COL2 = 220

function readWidth(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

function useStoredWidth(key, fallback) {
  const [width, setWidth] = useState(() => readWidth(key, fallback))
  const onResize = useCallback(
    (px) => {
      setWidth(px)
      try {
        localStorage.setItem(key, String(px))
      } catch {}
    },
    [key]
  )
  return [width, onResize]
}

function Column({ title, count, children, className = '' }) {
  return (
    <section className={`flex h-full min-h-0 flex-col bg-panel ${className}`}>
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line-faint px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          {title}
        </span>
        {count !== undefined && (
          <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-faint">
            {count}
          </span>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </section>
  )
}

function Empty({ title, children, action }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
      <p className="text-sm font-medium text-ink-dim">{title}</p>
      {children && <div className="max-w-[34ch] text-xs leading-relaxed text-ink-faint">{children}</div>}
      {action}
    </div>
  )
}

function ProjectRow({ project, selected, onSelect, onEdit, onDelete }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(project.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(project.id)
        }
      }}
      className={`group flex cursor-pointer flex-col gap-0.5 border-b border-line-faint px-3 py-2 text-left transition-colors ${
        selected ? 'bg-accent/10' : 'hover:bg-raised'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`truncate text-xs font-medium ${selected ? 'text-ink' : 'text-ink-dim'}`}>{project.name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(project)
            }}
            className="rounded px-1 text-[10px] text-ink-faint hover:text-ink"
          >
            edit
          </button>
          <button
            type="button"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              setConfirming(true)
            }}
            className="rounded px-1 text-[10px] text-ink-faint hover:text-error"
          >
            del
          </button>
        </span>
      </div>
      <span className="truncate font-mono text-[10px] text-ink-faint" title={project.folder}>
        {project.agent_name} · {project.folder}
      </span>
      {confirming && (
        <div className="mt-1.5 rounded-lg border border-error/40 bg-error/10 p-2 text-[11px] text-error">
          Delete this project{project.session_count ? ` and its ${project.session_count} session(s)` : ''}? The
          agent's tmux sessions are closed.
          <div className="mt-1.5 flex gap-1.5">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(project.id)
                setConfirming(false)
              }}
              className="rounded bg-error/20 px-1.5 py-0.5 font-medium"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setConfirming(false)
              }}
              className="rounded px-1.5 py-0.5 text-ink-faint"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function Mission() {
  const [col1, setCol1] = useStoredWidth(COL1_KEY, DEFAULT_COL1)
  const [col2, setCol2] = useStoredWidth(COL2_KEY, DEFAULT_COL2)
  const { projects, loading, error, selectedProjectId, fetchProjects, select, deleteProject } = useMission()
  const fetchAgents = useAgents((s) => s.fetchAgents)
  const [dialog, setDialog] = useState(null) // null | { project } — project set = edit

  useEffect(() => {
    document.title = 'Mission — Paddock'
  }, [])

  useEffect(() => {
    fetchProjects()
    // The project dialog offers agents, so the list has to be there too.
    if (!useAgents.getState().agents.length) fetchAgents()
  }, [fetchProjects, fetchAgents])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-line-faint px-4">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold text-ink">Mission</h1>
          <p className="truncate text-[11px] text-ink-faint">
            A project is an agent plus a folder. A session is the work.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialog({})}
          className="shrink-0 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-ink"
        >
          + New project
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div style={{ flexBasis: col1, minWidth: 0 }} className="flex min-w-0 flex-col">
          <Column title="Projects" count={projects.length}>
            {loading ? (
              <Empty title="Loading projects…">One moment.</Empty>
            ) : error ? (
              <Empty title="Could not load projects">
                {error}
                <div className="mt-2">
                  <button type="button" onClick={fetchProjects} className="rounded-lg bg-raised px-2 py-1 text-ink-dim">
                    Retry
                  </button>
                </div>
              </Empty>
            ) : projects.length === 0 ? (
              <Empty title="No projects yet">
                A project pairs an agent with the folder it works in. Create one, then open a session
                and the work happens in front of you.
              </Empty>
            ) : (
              projects.map((p) => (
                <ProjectRow
                  key={p.id}
                  project={p}
                  selected={p.id === selectedProjectId}
                  onSelect={select}
                  onEdit={(project) => setDialog({ project })}
                  onDelete={deleteProject}
                />
              ))
            )}
          </Column>
        </div>

        <Splitter onResize={setCol1} min={200} max={45} defaultWidth={DEFAULT_COL1} label="Resize projects column" />

        <div style={{ flexBasis: col2, minWidth: 0 }} className="flex min-w-0 flex-col">
          <Column title="Sessions" count={0}>
            {selectedProjectId ? (
              <Empty title="No sessions yet">Sessions arrive in the next phase.</Empty>
            ) : (
              <Empty title="No project selected">Pick a project to see its sessions.</Empty>
            )}
          </Column>
        </div>

        <Splitter onResize={setCol2} min={180} max={40} defaultWidth={DEFAULT_COL2} label="Resize sessions column" />

        <div className="flex min-w-0 flex-1 flex-col bg-sunken">
          <Column title="Agent">
            <Empty title="No session selected">
              Sessions run the agent's own interface in the project's folder. Open one and it appears
              here — the same terminal, the same TUI, the human and the agent typing into it alike.
            </Empty>
          </Column>
        </div>
      </div>

      {dialog && <ProjectDialog project={dialog.project} onClose={() => setDialog(null)} />}
    </div>
  )
}
