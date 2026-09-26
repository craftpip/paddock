import { useCallback, useEffect, useState } from 'react'
import Splitter from '../components/Splitter'

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
 *  Phase 2 is the skeleton: layout, resizable columns, empty states. Data,
 *  the create dialog and the session rows land in the following phases.
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

export default function Mission() {
  const [col1, setCol1] = useStoredWidth(COL1_KEY, DEFAULT_COL1)
  const [col2, setCol2] = useStoredWidth(COL2_KEY, DEFAULT_COL2)

  // Phase 2 keeps no selection yet — the empty states are the feature. Clearing
  // the stored widths is how a user resets after a bad drag; the double-click
  // on a divider does the same thing.
  useEffect(() => {
    document.title = 'Mission — Paddock'
  }, [])

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
          disabled
          title="Arrives with the create-project dialog"
          className="shrink-0 cursor-not-allowed rounded-lg bg-raised px-2.5 py-1.5 text-xs font-medium text-ink-faint"
        >
          + New project
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div style={{ flexBasis: col1, minWidth: 0 }} className="flex min-w-0 flex-col">
          <Column title="Projects" count={0}>
            <Empty title="No projects yet">
              A project pairs an agent with the folder it works in. Create one, then open a session
              and the work happens in front of you.
            </Empty>
          </Column>
        </div>

        <Splitter onResize={setCol1} min={200} max={45} defaultWidth={DEFAULT_COL1} label="Resize projects column" />

        <div style={{ flexBasis: col2, minWidth: 0 }} className="flex min-w-0 flex-col">
          <Column title="Sessions" count={0}>
            <Empty title="No project selected">Pick a project to see its sessions.</Empty>
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
    </div>
  )
}
