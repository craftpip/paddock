import { useCallback, useEffect, useState } from 'react'
import Splitter from '../components/Splitter'
import OverlayScroll from '../components/OverlayScroll'
import ProjectDialog from '../components/ProjectDialog'
import SessionList from '../components/SessionList'
import Terminal from '../components/Terminal'
import Button from '../components/ui/Button'
import { useConfirm } from '../lib/confirm'
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
 *  Col 1 is this file (projects). Col 2 is <SessionList/> — the live tmux
 *  sessions AND the agent's own past conversations in the project folder.
 *  Col 3 is the real Terminal component, pinned to the selected row.
 *
 *  The distinction that matters: attaching a Terminal auto-creates the tmux
 *  session if it is missing, so col 3 must never be pointed at a row whose
 *  pane is gone — that would show a live-looking empty shell instead of the
 *  conversation the row claims to be. Hence the explicit "gone" state below,
 *  driven by paneState.
 *
 *  Column widths are persisted per browser (`pad-mission-col1` / `-col2`), so
 *  the page comes back the way you left it; double-click a divider to reset.
 *  Whether col 1 is collapsed is persisted the same way
 *  (`pad-mission-col1-collapsed`).
 */
const COL1_KEY = 'pad-mission-col1'
const COL2_KEY = 'pad-mission-col2'
const COL1_COLLAPSED_KEY = 'pad-mission-col1-collapsed'
const DEFAULT_COL1 = 260
const DEFAULT_COL2 = 220
const RAIL_W = 56
/* The narrowest the projects listing can be and still be a listing. This is the
   hinge of the whole fold: drag the splitter under it and the column collapses
   to the rail, drag the rail out to it and the listing comes back. */
const COL1_MIN = 200
/* Below this the three columns squeeze the terminal, which is the one that
   cannot shrink (it is the actual work). Col 1 folds itself into the avatar
   rail and gives the 260px back. Widen the window and it returns to whatever
   the manual toggle last said — the narrow state overrides the preference, it
   does not overwrite it. */
const NARROW_MAX = 1024

function useNarrowViewport() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < NARROW_MAX)
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < NARROW_MAX)
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return narrow
}

function readWidth(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    const n = parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

function useStoredFlag(key) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return false
    }
  })
  const set = useCallback(
    (v) => {
      setOn(v)
      try {
        localStorage.setItem(key, v ? '1' : '0')
      } catch {}
    },
    [key]
  )
  return [on, set]
}

/* The avatar mark: the first two characters of the name, which is what the
   collapsed rail identifies a project by. Uppercased because it is a logo, and
   a 1-character name gets a second character from itself so the circle never
   holds a single lonely letter. */
function initials(name) {
  const t = (name || '').trim()
  if (!t) return '?'
  const two = t.slice(0, 2)
  return (two.length === 1 ? two + two : two).toUpperCase()
}

/* The fold arrows used to be the `‹`/`›` characters, which render 5px wide in
   a 32px button — a hairline you have to aim at. A stroked chevron at 20px is
   four times the visual weight, and one shape used for both directions so the
   control cannot drift between the two states. */
/* 14px, not 20 (too big next to a 32px target) and not a `‹`/`›` character
   glyph — one of those renders ~5px of hairline, which is genuinely hard to hit.
   `strokeWidth` is scaled to match so the chevron keeps one optical weight. */
function Chevron({ dir, className = '' }) {
  return (
    <svg
      className={`h-3.5 w-3.5 ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === 'left' ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'} />
    </svg>
  )
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

function Column({ title, count, children, className = '', toolbar = null, toolbarClassName = 'px-2 py-1.5' }) {
  return (
    <section className={`msn-col flex h-full min-h-0 flex-col bg-panel ${className}`}>
      {/* Toolbar above the group header, so a column can carry its own action
          (New session, New project) in the same place every time. */}
      {toolbar && (
        <div className={`msn-col-toolbar flex shrink-0 items-center gap-1.5 border-b border-line-faint ${toolbarClassName}`}>
          {toolbar}
        </div>
      )}
      <header className="msn-col-header flex h-9 shrink-0 items-center justify-between gap-2 border-b border-line-faint px-3">
        <span className="msn-col-title text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
          {title}
        </span>
        {count !== undefined && (
          <span className="msn-col-count rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-ink-faint">
            {count}
          </span>
        )}
      </header>
      {/* OverlayScroll, not a bare `overflow-y-auto` div: a native scrollbar
          reserves 10px of the column, which is a tenth of a 260px listing, and
          the old `scrollbar-gutter: stable` only made that space invisible
          rather than giving it back. The floating thumb costs the rows nothing.
          It fills this box exactly, so the column keeps its flex-1 height.
          Double-click a divider to reset a column width. */}
      <OverlayScroll scrollerClassName="msn-col-body">{children}</OverlayScroll>
    </section>
  )
}

function Empty({ title, children, action }) {
  return (
    <div className="msn-empty flex h-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
      <p className="msn-empty-title text-sm font-medium text-ink-dim">{title}</p>
      {children && <div className="msn-empty-text max-w-[34ch] text-xs leading-relaxed text-ink-faint">{children}</div>}
      {action}
    </div>
  )
}

/* Col 1 collapsed: the projects reduce to a rail of circular avatars, two
   characters each, which is all the identification a 56px strip can carry. The
   "New project" button loses its label and becomes a plus, and the splitter
   goes away with the width it was resizing. Selection is unchanged — an avatar
   is the same button as the row was, so col 2 and col 3 follow it exactly as
   before. */
function ProjectRail({ projects, selectedId, onSelect, onNew, onExpand }) {
  return (
    <section className="msn-col msn-col-rail flex h-full min-h-0 flex-col bg-panel">
      {/* ONE 12px gutter for the whole column: the header, the rows, the rail
          avatars and this head. It has to be 12 and not the toolbar's old 8 —
          a 32px control inset 8px in a 56px rail leaves 8 left and 16 right,
          which reads as a lopsided column. At 12 it is symmetric in the rail,
          still on the same pixels in both states, and flush with the row label
          beside it when expanded. The `+` is the one thing that has to move:
          beside a labelled button in a 260px toolbar, stacked under the arrow in
          a 56px rail. Same 32px target either way. */}
      <div className="msn-rail-head flex shrink-0 flex-col items-start gap-1.5 border-b border-line-faint px-3 py-1">
        <Button
          variant="ghost"
          size="bare"
          icon
          title="Expand projects column"
          onClick={onExpand}
          className="msn-btn-expand h-8 w-8 text-ink-faint"
        >
          <Chevron dir="right" />
        </Button>
        <Button
          variant="primary"
          size="bare"
          icon
          title="New project"
          onClick={onNew}
          className="msn-btn-new-project-mini h-8 w-8 rounded-pill text-[17px] leading-none"
        >
          +
        </Button>
      </div>
      {/* `px-3 py-2` mirrors the expanded row's 12px/8px inset, so an avatar
          sits exactly where its row's content did. */}
      <OverlayScroll scrollerClassName="msn-rail-body flex flex-col items-center gap-2 px-3 py-2">
        {projects.map((p) => {
          const on = p.id === selectedId
          return (
            <Button
              key={p.id}
              variant="none"
              size="bare"
              icon
              title={p.name}
              onClick={() => onSelect(p.id)}
              className={`msn-avatar msn-rail-btn h-8 w-8 rounded-pill text-[11px] leading-none ${
                on ? 'msn-avatar-on bg-accent text-accent-ink' : 'bg-raised text-ink-dim hover:bg-raised-hover hover:text-ink'
              }`}
            >
              {initials(p.name)}
            </Button>
          )
        })}
      </OverlayScroll>
    </section>
  )
}

function ProjectRow({ project, selected, onSelect, onEdit, onDelete }) {
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
      className={`msn-project-row group flex cursor-pointer flex-col gap-0.5 border-b border-line-faint px-3 py-2 text-left transition-colors ${
        selected ? 'msn-row-selected bg-accent/10' : 'hover:bg-raised'
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`msn-project-name truncate text-xs font-medium ${selected ? 'text-ink' : 'text-ink-dim'}`}>{project.name}</span>
        {/* The actions are revealed by `opacity-0` + `group-hover` /
            `focus-within` on the wrapper above, NOT by `hidden`. That matters:
            `display: none` children cannot take focus, so a keyboard user
            tabbing into this row would blur the wrapper and the reveal would
            vanish before the control was ever reachable. A real <button> with
            opacity 0 stays in the tab order, so both paths still work. */}
        <span className="msn-project-actions ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            variant="link"
            size="bare"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation()
              onEdit(project)
            }}
            className="msn-btn-edit px-1 text-[10px]"
          >
            edit
          </Button>
          <Button
            variant="dangerLink"
            size="bare"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(project)
            }}
            className="msn-btn-delete px-1 text-[10px]"
          >
            del
          </Button>
        </span>
      </div>
      <span className="msn-project-meta truncate font-mono text-[10px] text-ink-faint" title={project.folder}>
        {project.agent_name} · {project.folder}
      </span>
      {project.sessionCount !== undefined && (
        <span className="msn-project-counts flex items-center gap-1 text-[10px]">
          <span className={`msn-live-dot h-1 w-1 rounded-full ${(project.liveCount || 0) > 0 ? 'bg-success' : 'bg-ink-faint'}`} />
          <span className={project.liveCount ? 'text-ink-dim' : 'text-ink-faint'}>
            {project.liveCount || 0} live · {project.sessionCount} session{project.sessionCount === 1 ? '' : 's'}
          </span>
        </span>
      )}
    </div>
  )
}

export default function Mission() {
  const [col1, setCol1] = useStoredWidth(COL1_KEY, DEFAULT_COL1)
  const [col2, setCol2] = useStoredWidth(COL2_KEY, DEFAULT_COL2)
  const [col1Collapsed, setCol1Collapsed] = useStoredFlag(COL1_COLLAPSED_KEY)
  const narrow = useNarrowViewport()
  /* A narrow window folds the column on its own, but an explicit open — the
     chevron or a drag out to COL1_MIN — has to win, or the fold would spring
     back the instant you let go. The override is dropped again when the window
     actually crosses the breakpoint, so shrinking it still folds you. */
  const [narrowOverride, setNarrowOverride] = useState(false)
  useEffect(() => {
    setNarrowOverride(false)
  }, [narrow])
  const col1Folded = col1Collapsed || (narrow && !narrowOverride)

  /* Drag is the collapse, the chevron is the shortcut (both, on purpose).
     `Splitter` is given `RAIL_W` as its floor so it will REPORT a width under
     COL1_MIN instead of quietly stopping there, and this is where that width
     becomes a decision:
       - dragging an open column below COL1_MIN  → collapse to the rail
       - dragging the rail out to COL1_MIN       → open at that width
     Without this the splitter's own `min` made the column uncollapsible by
     hand: it stopped dead at 200px and the rail was reachable only by button. */
  const resizeCol1 = useCallback(
    (px) => {
      // `col1Folded`, NOT `col1Collapsed`: on a narrow viewport the rail shows
      // without `col1Collapsed` ever being set, and branching on that left the
      // auto-folded rail a dead end — dragging (or `openAt`) to COL1_MIN called
      // setCol1 and the column stayed folded, because the fold was still being
      // driven by `narrow && !narrowOverride`.
      if (col1Folded) {
        if (px >= COL1_MIN) {
          setCol1Collapsed(false)
          setNarrowOverride(true)
          setCol1(px)
        }
        return
      }
      if (px < COL1_MIN) {
        setCol1Collapsed(true)
        return
      }
      setCol1(px)
    },
    [col1Folded, setCol1, setCol1Collapsed]
  )
  const {
    projects, loading, error, selectedProjectId,
    openSession, sessionState,
    reopenFor, reopenError,
    fetchProjects, select, deleteProject, refreshActive,
    relaunch, restart,
  } = useMission()
  const fetchAgents = useAgents((s) => s.fetchAgents)
  const agents = useAgents((s) => s.agents)
  const [dialog, setDialog] = useState(null) // null | { project } — project set = edit
  const [actionError, setActionError] = useState('')
  const confirm = useConfirm()

  /* Col 3 renders from the store's `openSession` — a snapshot taken when the
   *  user opened a session, NOT from `sessions.find(…)`. That distinction is
   *  the whole of plan 58 item 1: the list col 2 shows is refetched, cleared and
   *  re-pointed for reasons that have nothing to do with the conversation you
   *  are looking at, and while the terminal rendered from it, switching "This
   *  project" ↔ "All projects" emptied the array for ~200ms, so col 3 rendered
   *  its empty state, `<Terminal>` UNMOUNTED, the WebSocket closed, and a new
   *  xterm + `tmux attach` was built for the same conversation the user never
   *  let go of. Col 1/col 2 may now point at a different project than col 3,
   *  which is why the header carries the open session's own project name.
   *
   *  The project is looked up by the snapshot's own id, and the agent/folder
   *  fall back to the snapshot's copies, so a session opened in the all view
   *  keeps rendering against ITS project even if col 1 has moved on — and even
   *  after that project is deleted from the list (col 3 then correctly shows the
   *  closed state, because its sessions really are). */
  const project = projects.find((p) => p.id === selectedProjectId) || null
  const session = openSession
  const sessionProject = session ? projects.find((p) => p.id === session.projectId) || null : null
  const sessionAgent = session?.agentName || sessionProject?.agent_name || null
  const sessionFolder = session?.folder || sessionProject?.folder || ''
  const agentRunning = sessionAgent
    ? agents.find((a) => a.name === sessionAgent)?.status !== 'stopped'
    : false

  useEffect(() => {
    document.title = 'Mission — Paddock'
  }, [])

  useEffect(() => {
    fetchProjects()
    // The project dialog offers agents, so the list has to be there too.
    if (!useAgents.getState().agents.length) fetchAgents()
  }, [fetchProjects, fetchAgents])

  // Keep the open session honest without spamming tmux: one list call plus one
  // pane call every 15s, and only while the tab is actually being looked at.
  // A TUI exiting inside its tmux session is invisible otherwise — the terminal
  // keeps showing the last frame, so the pane state is the only truth.
  //
  // `refreshActive` re-reads whatever col 2 is actually showing: the poll used to
  // call fetchSessions(projectId) directly, which in the all view would refresh
  // a list nobody is looking at and leave the visible one frozen. Since plan 68
  // the selection IS the scope, so the call is simply unconditional — the store
  // branches on `selectedProjectId` itself (`''` → the aggregate re-read).
  useEffect(() => {
    const tick = () => {
      if (document.hidden) return
      // The project list too, not just the sessions: a project created in
      // another tab would otherwise never appear here, and a page with no
      // project selected has no other way to notice one. The list refresh
      // already re-reads the pane state of whatever session ends up open.
      fetchProjects()
      refreshActive()
    }
    const t = setInterval(tick, 15000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [fetchProjects, refreshActive])

  const act = (fn, msg) => async () => {
    setActionError('')
    try {
      await fn()
    } catch (e) {
      setActionError(e?.error || e?.message || msg)
    }
  }

  /* Deleting a project asks in the same MODAL the session close does, for the
   *  same reason: the inline version was per-row state inside a row, it moved
   *  the rows under it, and the scroller clipped it. The copy says what actually
   *  happens — the sessions on this project stop — without naming tmux, and it
   *  says the one thing that is NOT obvious: several projects can share an
   *  agent, so this also ends sessions that are on OTHER projects. That is not
   *  a detail to hide behind a technical noun; it is the reason to hesitate. */
  const askDeleteProject = async (p) => {
    const ok = await confirm({
      title: `Delete ${p.name}?`,
      message: [
        p.session_count
          ? `This closes its ${p.session_count} session${p.session_count === 1 ? '' : 's'} and the agent stops working on them.`
          : 'This removes the project. The folder itself is not touched.',
        'Other projects can share this agent, so their sessions close too.',
      ].join('\n\n'),
      danger: true,
      confirmText: 'Delete it',
      cancelText: 'Keep',
    })
    if (!ok) return
    setActionError('')
    try {
      await deleteProject(p.id)
    } catch (e) {
      setActionError(e?.error || e?.message || 'Could not delete the project')
    }
  }

  return (
    <div className="msn-page flex h-full min-h-0 flex-col">
      <div className="msn-cols flex min-h-0 flex-1">
        {col1Folded ? (
          <div style={{ flexBasis: RAIL_W, flexShrink: 0 }} className="msn-col-shell msn-col-projects-rail flex min-w-0 flex-col">
            <ProjectRail
              projects={projects}
              selectedId={selectedProjectId}
              onSelect={select}
              onNew={() => setDialog({})}
              onExpand={() => {
                setCol1Collapsed(false)
                setNarrowOverride(true)
              }}
            />
          </div>
        ) : (
          <div style={{ flexBasis: col1, minWidth: 0 }} className="msn-col-shell msn-col-projects flex min-w-0 flex-col">
            {/* The New-project button lives in the column, the same way the
                New-session button lives in col 2 — a page-wide header strip
                above the three columns only stole vertical space from the
                listing it describes. The chevron beside it folds the whole
                column into the avatar rail. */}
            <Column
              title="Projects"
              count={projects.length}
               toolbarClassName="px-3 py-1"
              toolbar={
                <>
                  <Button
                    variant="ghost"
                    size="bare"
                    icon
                    title="Collapse projects column"
                    onClick={() => setCol1Collapsed(true)}
                    className="msn-btn-collapse h-8 w-8 text-ink-faint"
                  >
                    <Chevron dir="left" />
                  </Button>
                  <Button
                    variant="primary"
                    size="bare"
                    onClick={() => setDialog({})}
                    className="msn-btn-new-project py-1 text-[11px]"
                  >
                    + New project
                  </Button>
                </>
              }
            >
              {loading ? (
                <Empty title="Loading projects…">One moment.</Empty>
              ) : error ? (
                <Empty title="Could not load projects">
                  {error}
                  <div className="mt-2">
                    <Button variant="secondary" size="bare" onClick={fetchProjects} className="msn-btn-retry py-1 text-ink-dim">
                      Retry
                    </Button>
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
                    onDelete={askDeleteProject}
                  />
                ))
              )}
            </Column>
          </div>
        )}

        {/* The divider is mounted in BOTH states — it is what makes the column
            collapsible by hand at all. `min` is the RAIL width, not COL1_MIN, so
            a drag past the minimum is reported to `resizeCol1` and can be turned
            into the fold instead of being silently clamped. Drag it right from
            the rail and the listing reopens the moment it reaches COL1_MIN. */}
        <Splitter onResize={resizeCol1} min={RAIL_W} openAt={COL1_MIN} max={45} defaultWidth={DEFAULT_COL1} label="Resize projects column" className="msn-splitter msn-splitter-1" />

        <div style={{ flexBasis: col2, minWidth: 0 }} className="msn-col-shell msn-col-sessions flex min-w-0 flex-col">
          {/* Col 2 owns its own scroll (sticky group headers), so it is not the
              generic <Column> — that one wraps children in its own scroller. */}
          <SessionList />
        </div>

        <Splitter onResize={setCol2} min={180} max={40} defaultWidth={DEFAULT_COL2} label="Resize sessions column" className="msn-splitter msn-splitter-2" />

        <div className="msn-col-shell msn-col-agent flex min-w-0 flex-1 flex-col bg-sunken">
          {session && sessionAgent ? (
            <>
              <header className="msn-agent-header flex h-9 shrink-0 items-center gap-2 border-b border-line-faint px-3">
                <span className={`msn-agent-dot h-1.5 w-1.5 shrink-0 rounded-full ${sessionState?.live ? 'bg-success' : 'bg-ink-faint'}`} />
                {/* The project badge is here for the case plan 58 item 1 makes
                    possible: col 1 and col 2 follow the project you click, col 3
                    follows the session you opened, and the two can now be
                    different projects. Without the name, an 'all projects' row
                    from another folder looked like it belonged to whatever col 1
                    had highlighted. It is the same badge the row wears. */}
                {sessionProject && (
                  <span
                    className="msn-agent-project shrink-0 truncate rounded bg-accent/15 px-1 text-[9px] font-medium text-accent"
                    title={sessionFolder}
                  >
                    {sessionProject.name}
                  </span>
                )}
                <span className="msn-agent-label truncate text-[11px] font-medium text-ink-dim">
                  {session.label || session.tmux_id}
                </span>
                <span className="msn-agent-cwd truncate font-mono text-[10px] text-ink-faint" title={sessionState?.cwd || sessionFolder}>
                  {sessionState?.cwd || sessionFolder}
                </span>
                {session.locked && (
                  <span className="msn-badge-solo shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning" title="Solo lock — agents may read but not type here">
                    🔒 solo
                  </span>
                )}
                <span className="msn-agent-actions ml-auto flex shrink-0 items-center gap-1.5">
                  {/* Relaunch TUI vs Restart is the distinction paneState makes:
                      a live pane running a shell means the TUI exited (start it
                      again in the same conversation), while nothing running under
                      the session at all means the row is a leftover and the TUI
                      has to be launched from scratch — which is what relaunch does
                      too. */}
                  {session.live !== false && !sessionState?.tuiAlive && (
                    <Button
                      variant="secondary"
                      size="bare"
                      onClick={act(() => relaunch(session.id), 'Could not relaunch the TUI')}
                      className="msn-btn-relaunch py-0.5 text-[10px] text-ink-dim hover:border-accent"
                    >
                      {sessionState ? 'Relaunch TUI' : '…'}
                    </Button>
                  )}
                  <span className="msn-agent-command text-[10px] text-ink-faint">
                    {sessionState?.tuiAlive
                      ? sessionState.command
                      : sessionState
                        ? 'TUI not running'
                        : ''}
                  </span>
                </span>
              </header>
              {actionError && (
                <div className="msn-error-bar border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">
                  {actionError}
                </div>
              )}
              {/* Nothing is running here any more — attaching would silently
                  CREATE an empty shell under the same session name, which looks
                  like a working session and isn't. Say it in the user's terms
                  and offer the one action that is actually useful here: reopen
                  the SAME conversation, not start a new one.
                  Plan 68: when the pane was found dead at the moment the user
                  OPENED this session, the store has already restarted it, so
                  that moment shows a "Reopening…" state instead of a dead end
                  they have to click out of. A pane that dies later (the poll)
                  deliberately still lands here — the button stays, because
                  relaunching an agent process unasked is the human's call. */}
              {reopenFor === session.id ? (
                <Empty title="Reopening…">Starting this conversation again.</Empty>
              ) : sessionState && !sessionState.live ? (
                <Empty title={reopenError ? 'Could not reopen this conversation' : 'This session is closed'}>
                  {reopenError || (
                    <>
                      Nothing is running here any more — the agent's container may
                      have been restarted, or the session ended.
                    </>
                  )}
                  <div className="mt-2.5 flex justify-center">
                    <Button
                      variant="primary"
                      size="bare"
                      onClick={act(() => restart(session.id), 'Could not restart the session')}
                      className="msn-btn-restart px-2.5 py-1 text-xs"
                    >
                      Reopen this conversation
                    </Button>
                  </div>
                </Empty>
              ) : (
                <div className="msn-terminal-wrap min-h-0 flex-1 overflow-hidden">
                  <Terminal
                    name={sessionAgent}
                    sessionId={session.tmux_id}
                    showSessions={false}
                    running={agentRunning}
                    height="100%"
                    minHeight="0"
                    bordered={false}
                    className="msn-terminal h-full"
                  />
                </div>
              )}
            </>
          ) : (
            <Column title="Agent">
              <Empty title={selectedProjectId ? 'No session selected' : 'No project selected'}>
                {selectedProjectId
                  ? 'Open a session from the middle column and the agent’s own interface appears here — the same terminal, the same TUI, the human and the agent typing into it alike. Switching what the middle column lists leaves this alone.'
                  : 'Pick a project to see its sessions and the conversations the agent already had in that folder.'}
              </Empty>
            </Column>
          )}
        </div>
      </div>

      {dialog && <ProjectDialog project={dialog.project} onClose={() => setDialog(null)} />}
    </div>
  )
}
