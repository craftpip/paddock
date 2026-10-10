import { useState, useEffect } from 'react'
import OverlayScroll from './OverlayScroll'
import Button from './ui/Button'
import { useConfirm } from '../lib/confirm'
import { useMission } from '../stores/mission'
import { translateHistoryError } from '../lib/error-text'
import RunnerDialog from './RunnerDialog'
import { cx } from '../lib/cx'

// Col 2 — every conversation in this project, in ONE list.
//
// A row is a conversation, and the only thing that makes it different from its
// neighbour is a DOT: lit when the conversation is open — a tmux session on it,
// or the agent working on it from any client (the opencode web UI included,
// which never creates a tmux session for us) — and unlit when it is not. No
// "running" group, no "history" group, no resumed badge, no resume button: the
// two kinds used to be listed separately, which said the same thing twice and
// made a conversation that was actively working in the web UI look closed
// because we had no pane of our own on it.
//
// Clicking a row opens that conversation either way — a live one attaches to its
// pane, and a closed one resumes it into a new live session — so the row is the
// only control a row needs.

function when(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d)) return ''
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`
  if (mins < 60 * 24 * 30) return `${Math.round(mins / (60 * 24))}d ago`
  return d.toISOString().slice(0, 10)
}

function LiveRow({ session, selected, onSelect, onClose, onLock }) {
  // The list is deliberately cheap: it only knows whether the session is there
  // (one `list-sessions` call for the whole project). Whether a TUI is running
  // inside it is one call per session, and col 3 spends that on the one session
  // that is actually open — so a row never claims more than it knows.
  //
  // A row is a CONVERSATION, and it is open or it is not. `open` is the STORE's
  // word for "a `mission_send` would be accepted": live, and not a bare shell.
  //
  // It used to be re-derived here as `live || busy`, which quietly undid the
  // server's correction (plan 62): a live pane running only `bash` is not open
  // in any sense a user means, and OR-ing `live` back in lit the dot for exactly
  // the trap the server had just refused. The client's own re-derivation of a
  // server verdict is a second source of truth, and it was the wrong one. So
  // the store's field is used when it stamped one, and the fallback exists only
  // for a row that predates it.
  const open = session.open !== undefined ? session.open === true : session.live === true || session.busy === true
  // A shell pane is a real distinction to the user: something IS running, it is
  // just not the agent, and typing into it runs commands. It gets a word, not a
  // second dot, so the dot keeps meaning exactly one thing.
  const shell = session.kind === 'shell'
  // Everything below the dot is the same on every row: the time it was last
  // used. There used to be a third state here — "gone — the pane is no longer
  // there" — for a row whose tmux pane had died. That is a fact about our
  // implementation, not about the conversation, and printing it made the page
  // explain itself in a language the user never asked for. What they need to
  // know is simply that the conversation is not open, which the unlit dot and
  // the age already say. Clicking the row still gets them back in.
  const dotTitle = shell
    ? `only a shell is running here (${session.command || 'sh'}) — the agent is not up`
    : session.busy
      ? 'the agent is working on this conversation right now'
      : 'open — a session is on it'
  // The name on the row is the agent's OWN title for the conversation (plan 80),
  // falling back to the operator's label and only then to the tmux id. A live
  // row and its history twin are one item, so they must read the same name: the
  // history row has always shown `item.title`, and a live row that showed
  // `label || tmux_id` is why a fresh session read as `msn-…` and then
  // "renamed" the moment it was closed.
  const name = session.title || session.label || session.tmux_id
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(session.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(session.id)
        }
      }}
      className={`msn-session-row group relative flex cursor-pointer flex-col gap-0.5 border-b border-line-faint px-3 py-2 ${
        selected ? 'msn-row-selected bg-accent/10' : 'hover:bg-raised'
      }`}
    >
      {/* Line 1 is the NAME and nothing else (user, 2026-09-27) — no state dot,
          no project badge, no hover buttons. A long session name gets the full
          width of the column to itself, and names scan down a single axis. The
          weight is the SAME as a history title's (500, below): the two row types
          are one list, and they used to disagree by 100 on the very line that
          identifies the row. */}
      <span
        className={`msn-session-label min-w-0 truncate text-xs font-medium ${selected ? 'text-ink' : 'text-ink-dim'}`}
        title={name}
      >
        {name}
      </span>
      {/* Line 2 is the state line: the dot, the project name, the "when" text
          flush RIGHT, then the hover buttons (user, 2026-09-27). Two things
          make the right alignment real rather than approximate:
          (1) the TIME takes `ml-auto`, so it is pushed to the content edge
          instead of trailing the badge by however wide the badge happens to be;
          (2) the buttons are `hidden` until hover rather than `opacity-0` —
          an invisible flex child still RESERVES its 41px, which is what left the
          time 41px short of the edge on every row. Hence hovering nudges the
          time left by exactly the buttons' width, and idle is flush. `relative`
          because the buttons anchor to THIS box, not to the row's corner (see
          them below). */}
      <div className="relative flex items-center gap-1.5">
        {/* The dot is MOUNTED only while the row is active — an inactive row has
            no dot and must not reserve one either (user, 2026-09-27): a 6px
            circle plus its 6px gap of blank space is a hole where the state
            would be, and it is what made a closed row look half-erased. Green is
            the only fill, so there is nothing to say when it is not there. */}
        {open && (
          <span className="msn-session-dot h-1.5 w-1.5 shrink-0 rounded-full bg-success" title={dotTitle} />
        )}
        {/* Only when the list spans multiple projects — the store sets `.project`
            only on the aggregated rows, so this never duplicates the project
            name a single-project view already shows elsewhere. This is an
            IDENTITY label, not a state marker: without it two rows from
            different folders are indistinguishable in one list. */}
        {session.project && (
          <span
            className="msn-row-project shrink-0 truncate rounded bg-accent/15 px-1 text-[9px] font-medium text-accent"
            title={`${session.project.name} — ${session.project.folder}`}
          >
            {session.project.name}
          </span>
        )}
        {/* A shell pane gets a WORD, not a dot. The dot is reserved for "this
            conversation is open" and stays that way; a live pane whose agent
            exited is a different fact, and it is the one that decides whether
            typing would run a command, so it has to be readable at a glance
            (plan 62 1b). */}
        {shell && (
          <span
            className="msn-row-shell shrink-0 truncate rounded bg-warning/15 px-1 text-[9px] font-medium text-warning"
            title={`Only a shell is running (${session.command || 'sh'}) — relaunch the TUI before typing`}
          >
            shell
          </span>
        )}
        {/* The "when it was last used" text. `font-mono` at 10px is this
            column's meta type, and the history row's meta line uses the exact
            same one — a row type that quietly restyles its second line reads as
            a different kind of thing rather than the same thing, closed. */}
        <span
          className="msn-session-id ml-auto min-w-0 shrink truncate text-right font-mono text-[10px] text-ink-faint transition-opacity group-hover:opacity-0 group-focus:opacity-0"
          title={session.tmux_id}
        >
          {when(session.last_seen_at || session.created_at)}
          {session.locked ? ' · locked' : ''}
        </span>
        {/* The hover buttons are ABSOLUTE, not in flow, and that is the whole
            point of this arrangement (user, 2026-09-27). Three ways to get
            "flush right" wrong, all tried:
            (1) `hidden`/`group-hover:flex` reserves nothing but `display: none`
                children cannot take focus — tabbing onto the row revealed them,
                the next Tab blurred the row, the reveal vanished and focus fell
                to <body>. The button could never be reached by keyboard.
            (2) `opacity-0` in flow keeps them focusable but an invisible flex
                child still RESERVES its 41px, leaving the time 41px short of
                the edge on every row — the "you are hiding it but it still takes
                space" complaint, one element over.
            (3) absolute + opacity: no reserved space, the time is flush right at
                rest, and the buttons keep focusability because they are never
                `display: none`.
            They are anchored to the META LINE's box (`right-0 top-0 h-full`
                inside the `relative` line above) rather than to the row's corner,
                because they are supposed to replace the time: anchored to the
                corner they sat 5px above it and 4px below its baseline, so the
                swap read as two layers of text instead of one box changing. The
                line and the buttons now agree on top, left and height.
            `pointer-events-none` while invisible is REQUIRED, not tidiness: an
            `opacity: 0` element still takes clicks, so without it a click on the
            time — meant to select the row — would hit the invisible Close button
            and kill the user's session. */}
        <span className="msn-row-actions pointer-events-none absolute right-0 top-0 flex h-full shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
          {/* The two icon buttons share one geometry — identical 16px boxes,
              identical 12px stroked SVGs, `leading-none` — because glyphs do
              not align by themselves (user, 2026-09-27): a 🔒 emoji renders
              12px tall next to a 5px ×, each with its own font metrics and
              built-in bearing, so two buttons with the same padding still read
              as crooked. Same lesson as the 14px row chevron: for a control's
              only icon, use a stroked SVG at a looked-at size, never a glyph.
              The lock keeps its two states as closed vs open shackle. */}
          <Button
            variant="none"
            size="bare"
            icon
            title={session.locked ? 'Unlock — let agents type here' : 'Solo lock — read only'}
            aria-pressed={session.locked}
            onClick={(e) => {
              e.stopPropagation()
              onLock(session.id, !session.locked)
            }}
            className={`msn-btn-lock h-4 w-4 leading-none ${session.locked ? 'text-warning' : 'text-ink-faint hover:text-ink'}`}
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="5" y="10" width="14" height="10" rx="2" />
              {session.locked
                ? <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                : <path d="M8 10V7a4 4 0 0 1 8-1" />}
            </svg>
          </Button>
          <Button
            variant="none"
            size="bare"
            icon
            title="Close"
            onClick={(e) => {
              e.stopPropagation()
              // The question is asked in a MODAL, by the list above this row —
              // never inline here. An inline prompt inside a row moves every row
              // under it down, is clipped by the scroller, and is per-row state
              // that has already outlived the row it belonged to once (plan 53
              // §6/§9a). `onClose` is async and returns a promise the row does
              // not need, so it is deliberately not awaited here.
              onClose(session.id)
            }}
            className="msn-btn-close h-4 w-4 leading-none text-ink-faint hover:text-danger"
          >
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Button>
        </span>
      </div>
    </div>
  )
}

function HistoryRow({ item, projectFolder, onResume, busy, selected }) {
  // In the 'all' scope each row carries its OWN project, so the directory is
  // compared against that project's folder — otherwise every subfolder row
  // would print the same folder and the project badge would be the only thing
  // telling the rows apart.
  const own = item.project
  const folder = own?.folder || projectFolder
  // Only spell out the directory when it is NOT the project folder — every
  // exact row would otherwise repeat the folder the header already shows.
  const where = item.directory && item.directory !== folder ? item.directory.split('/').pop() : ''
  // The WHOLE row opens the conversation, like a live session row does. It used
  // to be a plain div with a small `resume` button in the corner, so clicking a
  // conversation did nothing at all and the button was the only way in — one
  // small target, repeated 100 times down the column, for the action the row
  // name already implies.
  const open = () => {
    if (busy) return
    onResume(item)
  }
  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={busy || undefined}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open()
        }
      }}
      className={`msn-history-row group flex flex-col gap-0.5 border-b border-line-faint px-3 py-2 ${
        busy ? 'cursor-default opacity-60' : 'cursor-pointer'
      } ${selected ? 'msn-row-selected bg-accent/10' : busy ? '' : 'hover:bg-raised'}`}
    >
      {/* Line 1 is the conversation title and nothing else, exactly like a live
          session row — the two row types are one list, so they are one shape:
          same height, same padding, same inset, and the SAME 500 weight on the
          name line. A 400 here and 500 there said "these are different kinds of
          thing" in the one column where they are not. */}
      <span className={`msn-history-title min-w-0 truncate text-xs font-medium ${selected ? 'text-ink' : 'text-ink-dim'}`} title={item.title}>
        {item.title || '(untitled)'}
      </span>
      <div className="relative flex items-center gap-1.5">
        {/* The same mounted-only dot a live session row has, and for the same
            reason. A conversation the user is driving in the opencode web UI has
            no tmux session for us to see, so the agent's own status is the ONLY
            thing that can light this row — without it, work in progress reads as
            closed. Mounted only when active, so a closed conversation reserves
            no space for a dot it does not have. */}
        {item.open && (
          <span
            className="msn-session-dot h-1.5 w-1.5 shrink-0 rounded-full bg-success"
            title={item.busy
              ? 'the agent is working on this conversation right now'
              : 'open — a session of yours is on this conversation'}
          />
        )}
        {own && (
          <span
            className="msn-row-project shrink-0 truncate rounded bg-accent/15 px-1 text-[9px] font-medium text-accent"
            title={`${own.name} — ${own.folder}`}
          >
            {own.name}
          </span>
        )}
        {/* Nothing here says "resume". The row IS the action, and a label
            repeating it down the column 160 times is the "different open button"
            this row replaced. The only text that ever appears is `opening…`, for
            as long as this specific row's click is in flight — without it the row
            just dims and looks broken. */}
        {busy && (
          <span className="msn-history-hint shrink-0 text-[10px] text-ink-faint/70">opening…</span>
        )}
        <span className="msn-history-meta ml-auto min-w-0 shrink truncate text-right font-mono text-[10px] text-ink-faint">
          {when(item.updatedAt)}
          {where ? ` · ${where}` : ''}
        </span>
      </div>
    </div>
  )
}

/* Col 2's empty states. The inset is the COLUMN's inset (12px, same as every
   row, every band and the scope switch) and not a `px-4` of its own — a centred
   empty state whose text block starts 4px left of the listings above it reads as
   a different column. The vertical padding stays generous: this is the only thing
   in the scroller, not a band in a list, so it keeps its air. */
function Empty({ children, className = '' }) {
  return <div className={`msn-empty msn-empty-inline px-3 py-6 text-center text-xs leading-relaxed text-ink-faint ${className}`}>{children}</div>;
}


export default function SessionList() {
  const {
    sessions, sessionsLoading, sessionsError,
    history, historyLoading, historyError, historyErrors, includeSubfolders, loadedFor,
    selectedProjectId, allLoaded, allError, selectedConversationId, startingKey, projects,
    selectSession, startSession, closeSession, toggleSessionLock, setSubfolders,
    // Runners (plan 83)
    runners, runnersLoading, runnersError,
    fetchRunners, createRunner, updateRunner, startRunner, pauseRunner, resumeRunner, removeRunner,
  } = useMission()

  const [actionError, setActionError] = useState('')
  const [runnerDialog, setRunnerDialog] = useState(null) // { runner, project }
  const [runnerActionError, setRunnerActionError] = useState('')
  const project = useMission((s) => s.projects.find((p) => p.id === s.selectedProjectId))
  const confirm = useConfirm()
  // Plan 68: there is no `scope` — the selection IS the scope. `''` = the
  // ALL-projects view; a project id = that project's view.
  const isAll = !selectedProjectId

  // Fetch runners when project changes
  useEffect(() => {
    if (project) fetchRunners(project.id)
  }, [project?.id, fetchRunners])

  // In 'all' the column still needs a project for `+ New session` and for
  // resuming a history row that predates the aggregate, but there is nothing to
  // show if there are no projects at all.
  if (!project && !projects.length) return <Empty className="msn-no-project">Pick a project to see its sessions.</Empty>

  const run = async (fn, msg) => {
    setActionError('')
    try {
      await fn()
    } catch (e) {
      setActionError(e?.error || e?.message || msg)
    }
  }

  const handleRunnerAction = async (action, runnerId) => {
    setRunnerActionError('')
    try {
      if (action === 'start') await startRunner(runnerId)
      else if (action === 'pause') await pauseRunner(runnerId)
      else if (action === 'resume') await resumeRunner(runnerId)
      else if (action === 'remove') await removeRunner(runnerId)
      await fetchRunners()
    } catch (e) {
      setRunnerActionError(e?.error || e?.message || `Could not ${action} runner`)
    }
  }

  /* Closing a session is the one destructive action in this column, and the
   *  question is asked in the app's own confirm MODAL (`useConfirm` → `Modal` at
   *  z-80), not inline in the row it came from. The inline version was the
   *  wrong shape three ways over: it pushed every row under it down, the
   *  scroller clipped it, and it was per-row state (`confirmClose`) that had
   *  already outlived the row it belonged to once (plan 53 §6/§9a) — the prompt
   *  stayed on screen with nothing under it until you happened to click a button
   *  on some other row. A modal cannot outlive anything: it is the app's single
   *  confirm surface, already carrying Escape, backdrop-click and Enter.
   *
   *  The copy names no implementation. "kill its tmux pane" is a fact about how
   *  we run the agent, not something the person closing a conversation needs;
   *  what they need to know is that the agent stops and that anything unwritten
   *  is lost. */
  const askClose = async (id) => {
    const ok = await confirm({
      title: 'Close this session?',
      message: 'This closes the session and stops the agent. Anything the agent has not written down is lost.',
      danger: true,
      confirmText: 'Close it',
      cancelText: 'Keep',
    })
    if (!ok) return
    // A refused close has to surface: the dialog is gone either way, so the
    // error goes in the same error bar the column already has.
    await run(() => closeSession(id), 'Could not close the session')
  }

  const hist = history
  const subCount = hist?.subfolderCount || 0
  // Per-scope "has this list ever loaded" flag — the placeholder must not show
  // on a 15s refresh, and must still show on a first load.
  const listLoaded = isAll ? allLoaded : loadedFor === project?.id
  // startSession already parks its failure in `sessionsError` (rendered below),
  // so the click handler only has to swallow the rejection to keep it out of
  // the console — re-reporting it here would print the same message twice.
  //
  // A history row is resumed in ITS OWN project, not in the one col 1 happens to
  // have selected — in the 'all' scope those differ, and resuming a conversation
  // in the wrong folder is the one mistake this view cannot make.
  const start = (opts, projectId) =>
    startSession(projectId || project?.id || '', opts).catch(() => {})
  // The key a start is filed under, so the column can tell WHOSE click is still
  // in flight. It has to include the project: the same conversation key can sit
  // in two projects in the 'all' scope, and a shared key would light up both.
  const rowKey = (item) => `${item.project?.id || project?.id || ''}::${item.id || item.key || ''}`
  const resume = (item) =>
    start(
      {
        agentSessionId: item.id,
        label: (item.title || 'Resumed session').slice(0, 60),
        sourceKey: rowKey(item),
      },
      item.project?.id
    )
  // The new-session button is its own action, so it gets its own busy state
  // instead of borrowing the global one — otherwise opening a conversation
  // would relabel an untouched "+ New session" as "Opening…".
  const newKey = `new:${project?.id || ''}`
  const newBusy = startingKey === newKey

  // THE MERGE — one list, newest activity first, live sessions and the agent's
  // own past conversations interleaved.
  //
  // These used to be two stacked groups ("Running" / "History"), which made the
  // list say the same thing twice in two shapes. The user asked for one list
  // whose only per-row signal is a dot, and the dot is the one signal that is
  // actually meaningful: a conversation is either open (live tmux session, or the
  // agent working on it from any client) or it is not.
  //
  // Two rows that are the SAME conversation are collapsed into one. A resumed
  // conversation is in both sources at once — a live mission session row keyed
  // by tmux id, and a history row keyed by the agent's session id — and as two
  // groups that was invisible, but merged it would print the conversation twice
  // with two dots. The live row wins: it carries the tmux id the terminal needs.
  //
  // `conversationId` is the row's IDENTITY (plan 80) and it is what the
  // highlight compares: a live row and its history twin share it
  // (`agent_session_id` === the history row's `id`), so selecting the live row
  // and then closing it keeps the SAME row selected — as its history twin, not a
  // differently-named item. A legacy live row with no conversation falls back to
  // its own stable key so it can still be highlighted.
  const liveAgentIds = new Set(sessions.map((s) => s.agent_session_id).filter(Boolean))
  const histRows = [
    ...(hist?.exact || []),
    ...(includeSubfolders ? hist?.subfolders || [] : []),
  ]
  const rows = [
    ...sessions.map((s) => ({
      kind: 'live',
      key: `live:${s.id}`,
      conversationId: s.agent_session_id || `live:${s.id}`,
      // `last_seen_at` is touched by the terminal while you are actually talking
      // to the session, so an in-use session rises in the list on its own
      // instead of being pinned to the top by state.
      at: s.last_seen_at || s.created_at || '',
      session: s,
    })),
    ...histRows
      .filter((h) => !liveAgentIds.has(h.id))
      .map((h) => ({ kind: 'history', key: `hist:${h.id}`, conversationId: h.id, at: h.updatedAt || '', item: h })),
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))

  return (
    <div className="msn-sessions flex min-h-0 flex-1 flex-col">
      <div className="msn-col-toolbar flex shrink-0 items-center gap-1.5 border-b border-line-faint px-3 py-1.5">
        <Button
          variant="primary"
          size="bare"
          disabled={newBusy || !project}
          onClick={() => start()}
          className="msn-btn-new-session py-1 text-[11px]"
          title={project ? `New session in ${project.name}` : 'Pick a project first'}
        >
          {newBusy ? 'Opening…' : '+ New session'}
        </Button>
        {/* Infinite runner button (plan 83) */}
        <Button
          variant="secondary"
          size="bare"
          disabled={!project}
          onClick={() => setRunnerDialog({ runner: null, project })}
          className="msn-btn-new-runner py-1 text-[11px]"
          title={project ? `Create infinite runner in ${project.name}` : 'Pick a project first'}
        >
          ∞ Infinite runner
        </Button>
        <span
          className="msn-project-folder ml-auto truncate font-mono text-[10px] text-ink-faint"
          title={isAll ? `${projects.length} projects` : project?.folder}
        >
          {isAll ? `${projects.length} projects` : project?.folder}
        </span>
      </div>

      {/* No scope switch (plan 68): the col-1 selection IS the scope, so the
          choice lives in the rail — click a project avatar for that project's
          view, click it again (or pick nothing) for all projects. A second,
          independent switch inside the column was where the two scopes could
          disagree with each other. */}

      {actionError && (
        <div className="msn-error-bar border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">{actionError}</div>
      )}
      {sessionsError && (
        <div className="msn-error-bar border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">{sessionsError}</div>
      )}
      {allError && (
        <div className="msn-error-bar border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">{allError}</div>
      )}
      {/* Per-project probe failures (plan 68 Idea 6), moved OUT of the scroller
          into the column's error band: they are not rows and never were, and a
          stopped PAD's line must not ride the scroll of the listing above it.
          The raw reason stays one `title` hover away — the machine string a
          caller can act on, exactly the phrase the backend sent. */}
      {historyErrors.length > 0 && (
        <div className="msn-history-errors border-b border-line-faint px-3 py-1.5 text-[10px] text-ink-faint">
          {historyErrors.map((e) => (
            <div key={e.project?.id || e.project?.name || e.error} className="msn-history-error truncate" title={e.error}>
              <span className="msn-history-error-project text-ink-dim">{e.project?.name || 'a project'}</span>
              {' — '}
              {translateHistoryError(e.error)}
            </div>
          ))}
        </div>
      )}

      {/* OverlayScroll for the same reason as col 1: a native scrollbar would
          take 10px out of a 260px listing. The floating thumb is drawn over the
          rows instead, so the folder path and the row actions get the width. */}
      <OverlayScroll scrollerClassName="msn-sessions-body">
        {/* Pinned infinite runners (plan 83) — appear at the top of the listing,
            above the Sessions group, across both project and all views. */}
        {project && runners.length > 0 && (
          <div className="msn-runners-pinned">
            {runners.map((r) => (
              <RunnerRow
                key={r.id}
                runner={r}
                project={project}
                selected={selectedConversationId === `runner:${r.id}`}
                onSelect={() => {}}
                onStart={() => handleRunnerAction('start', r.id)}
                onPause={() => handleRunnerAction('pause', r.id)}
                onResume={() => handleRunnerAction('resume', r.id)}
                onRemove={() => handleRunnerAction('remove', r.id)}
                onConfigure={() => setRunnerDialog({ runner: r, project })}
                busy={runnersLoading}
              />
            ))}
            <div className="msn-runners-divider border-b border-line-faint my-1" />
          </div>
        )}

        {/* ONE header, ONE list. The two groups this replaced ("Running" and
            "History") listed the same thing two ways, and the only difference
            the user cares about — is this conversation open right now — is a
            single dot on the row. Also sticky at top-0 with nothing above it,
            which is what the History bar had to fake an offset for. Its `py-1.5`
            is the column's ONE band padding (error band, expander, cap note all
            use it too): four different gaps around four kinds of non-row was
            four decisions where there is one. */}
        <div className="msn-group msn-group-sessions sticky top-0 z-10 bg-panel px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          Sessions
          {rows.length > 0 && <span className="msn-group-count ml-1 text-ink-faint/70">({rows.length})</span>}
        </div>
        {/* A placeholder may only appear while there is genuinely nothing to
            show. Every 15s poll and every session action flips
            `sessionsLoading`, and a "Loading…" line that appears and vanishes
            pushes the whole listing down a line and back — the flicker. Once
            the scope has loaded once, refresh in place instead. `listLoaded` is
            the per-scope equivalent of `loadedFor`, set on SUCCESS. */}
        {!listLoaded && !hist && rows.length === 0 && <Empty>{isAll ? 'Loading every project…' : 'Loading…'}</Empty>}
        {historyLoading && !hist && <Empty>Reading the agent's history…</Empty>}
        {historyError && <Empty>{historyError}</Empty>}
        {/* One empty state for the whole column, and it only claims "nothing
            anywhere" when nothing FAILED — if every project was unreadable the
            error band above is the story, and an empty-state line would blame the
            agent for a stopped PAD. */}
        {rows.length === 0 && (listLoaded || hist) && historyErrors.length === 0 && (
          <Empty>
            {isAll
              ? 'No conversations in any project yet — start one to begin.'
              : `No conversations in ${project?.folder} yet — start one to begin.`}
          </Empty>
        )}
        {rows.map((row) => (
          <div key={row.key} className="msn-row-slot">
            {row.kind === 'live' ? (
              <LiveRow
                session={row.session}
                selected={row.conversationId === selectedConversationId}
                onSelect={selectSession}
                onClose={askClose}
                onLock={(id, locked) => run(() => toggleSessionLock(id, locked), 'Could not change the lock')}
              />
            ) : (
              <HistoryRow
                item={row.item}
                projectFolder={project?.folder}
                busy={startingKey === rowKey(row.item)}
                selected={row.conversationId === selectedConversationId}
                onResume={resume}
              />
            )}
          </div>
        ))}

        {subCount > 0 &&
          (!includeSubfolders ? (
            <Button
              variant="none"
              size="bare"
              block
              onClick={() => setSubfolders(true)}
              className="msn-btn-subfolders w-full justify-start px-3 py-1.5 text-left text-[11px] text-ink-faint hover:bg-raised hover:text-ink-dim"
            >
              ▸ {subCount} more in subfolders{isAll ? ' across all projects' : ''}
            </Button>
          ) : (
            <>
              <Button
                variant="none"
                size="bare"
                block
                onClick={() => setSubfolders(false)}
                className="msn-btn-subfolders w-full justify-start px-3 py-1.5 text-left text-[11px] text-ink-faint hover:bg-raised hover:text-ink-dim"
              >
                ▾ hide {subCount} conversations in subfolders
              </Button>
              {/* The list is capped server-side, so say what is actually on
                  screen instead of implying all 693 are loaded. */}
              {(hist?.subfolders?.length || 0) < subCount && (
                <div className="msn-cap-note px-3 py-1.5 text-[10px] text-ink-faint">
                  showing the {hist?.subfolders?.length || 0} most recent of {subCount}
                </div>
              )}
            </>
          ))}
</OverlayScroll>
      {runnerDialog && (
        <RunnerDialog
          runner={runnerDialog.runner}
          project={runnerDialog.project}
          onClose={() => setRunnerDialog(null)}
        />
      )}
      </div>
    )
  }

/** Pinned runner row (plan 83). Shows at the top of the session listing. */
function RunnerRow({ runner, project, onSelect, onStart, onPause, onResume, onRemove, onConfigure, busy }) {
  const isEnabled = runner.control_state === 'enabled'
  const isPaused = runner.control_state === 'paused'
  const isWaiting = runner.control_state === 'waiting'
  const isNeedInput = runner.control_state === 'need_input'
  const isFinished = runner.control_state === 'finished'
  const health = runner.last_reason || ''

  const canStart = isPaused || isWaiting || isNeedInput
  const canPause = runner.control_state === 'enabled'
  const canResume = isPaused

  const stateColor = isEnabled ? 'text-success' : isPaused ? 'text-warning' : isWaiting ? 'text-info' : isNeedInput ? 'text-warning' : 'text-ink-faint'
  const stateLabel = isEnabled ? 'Enabled' : isPaused ? 'Paused' : isWaiting ? 'Waiting' : isNeedInput ? 'Need input' : 'Finished'

  return (
    <div
      className={`msn-runner-row group relative flex cursor-pointer flex-col gap-0.5 border-b border-line-faint px-3 py-2 ${busy ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="msn-runner-badge shrink-0 rounded bg-accent/15 px-1.5 text-[9px] font-medium text-accent">∞</span>
        <span className="msn-runner-name min-w-0 truncate text-xs font-medium text-ink">{runner.name}</span>
        <span className={`msn-runner-state shrink-0 text-[10px] font-medium ${stateColor}`}>{stateLabel}</span>
        {health && (
          <span className="msn-runner-health shrink-0 truncate text-[9px] text-ink-faint" title={health}>
            {health}
          </span>
        )}
      </div>
      <div className="msn-runner-meta flex items-center gap-1.5 text-[10px] text-ink-faint">
        <span className="msn-runner-project shrink-0 truncate" title={project.folder}>{project.name}</span>
        <span className="msn-runner-queue shrink-0 truncate text-ink-faint/70">{runner.queue_file || 'QUEUE.md'}</span>
        {runner.session_id && (
          <span className="msn-runner-session shrink-0 truncate font-mono" title={runner.session_id}>
            {runner.session_id.slice(0, 8)}…
          </span>
        )}
        {runner.run_generation > 0 && (
          <span className="msn-runner-gen shrink-0 text-ink-faint/70">gen {runner.run_generation}</span>
        )}
      </div>
      <div className="msn-runner-actions pointer-events-none absolute right-0 top-0 flex h-full shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <Button
          variant="none"
          size="bare"
          icon
          title={runner.control_state === 'enabled' ? 'Pause' : 'Start'}
          onClick={() => runner.control_state === 'enabled' ? onPause() : onStart()}
          disabled={busy}
          className={`msn-btn-runner msn-btn-runner-start h-4 w-4 leading-none ${runner.control_state === 'enabled' ? 'text-warning hover:text-warning/80' : 'text-success hover:text-success/80'}`}
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {runner.control_state === 'enabled'
              ? <>
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </>
              : <polygon points="5 3 19 12 5 21" />}
          </svg>
        </Button>
        <Button
          variant="none"
          size="bare"
          icon
          title="Configure"
          onClick={() => onConfigure()}
          className="msn-btn-runner msn-btn-runner-config h-4 w-4 leading-none text-ink-faint hover:text-ink"
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </Button>
        <Button
          variant="none"
          size="bare"
          icon
          title="Remove as runner"
          onClick={() => onRemove()}
          className="msn-btn-runner msn-btn-runner-remove h-4 w-4 leading-none text-ink-faint hover:text-danger"
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </Button>
      </div>
    </div>
  )
}
