import { useState } from 'react'
import QueuePanel from './QueuePanel'
import Splitter from './Splitter'
import RunnerControls from './RunnerControls'
import Terminal from './Terminal'
import Button from './ui/Button'
import { useMission } from '../stores/mission'
import { useToast } from '../lib/toast'

// The open queue and the terminal share column 3 as a drag-resizable split
// (the queue used to REPLACE the terminal while open). The queue's height is
// the one number that moves; the terminal takes the rest and re-fits itself
// through its ResizeObserver. Stored in px per browser; the CSS max keeps a
// stored height from swallowing the terminal on a shorter window.
const QUEUE_SPLIT_KEY = 'pad-mission-queue-split-h'
const QUEUE_MIN_PX = 120
const TERMINAL_MIN_PX = 120
function readQueueHeight() {
  try {
    const n = parseInt(localStorage.getItem(QUEUE_SPLIT_KEY), 10)
    return Number.isFinite(n) && n >= QUEUE_MIN_PX ? n : null
  } catch { return null }
}

function Empty({ title, children, action }) {
  return <div className="msn-empty flex h-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center"><p className="text-sm font-medium text-ink-dim">{title}</p>{children && <div className="max-w-[34ch] text-xs leading-relaxed text-ink-faint">{children}</div>}{action}</div>
}

export default function MissionSessionView({ session, project, agentRunning, queueExpanded, onQueueCollapsedChange, onConfigure, error = '' }) {
  const sessionState = useMission((s) => s.sessionState)
  const reopenFor = useMission((s) => s.reopenFor)
  const reopenError = useMission((s) => s.reopenError)
  const relaunch = useMission((s) => s.relaunch)
  const restart = useMission((s) => s.restart)
  const toast = useToast()
  const [queueHeight, setQueueHeight] = useState(readQueueHeight)
  // What the queue panel itself reports: open by the URL, or forced open
  // because the queue needs repair.
  const [queueOpen, setQueueOpen] = useState(queueExpanded)
  const split = !!session?.runner && (queueExpanded || queueOpen)
  // A refused relaunch or reopen (the folder is gone, the PAD is stopped) used
  // to be swallowed here, so the button looked dead.
  const action = async (fn) => { try { await fn() } catch (e) { toast.error(e?.error || e?.message || 'That did not work. Try again.', { duration: 10000 }) } }
  if (!session?.agentName) return <Empty title="Session unavailable">This session no longer has an available agent.</Empty>
  const title = session.runner?.name || session.title || session.label || session.tmux_id
  return <div className="msn-session-view flex h-full min-h-0 flex-col bg-sunken">
    <header className="msn-agent-header flex h-11 shrink-0 items-center gap-2.5 border-b border-line-faint bg-panel px-3">
      <span className={`msn-agent-dot h-2 w-2 shrink-0 rounded-full ${sessionState?.live ? 'bg-success' : 'bg-ink-faint'}`} />
      {project && <span className="msn-agent-project shrink-0 truncate rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent-text" title={session.folder}>{project.name}</span>}
      <span className="msn-agent-label truncate text-[13px] font-semibold text-ink" title={title}>{title}</span>
      <span className="msn-agent-cwd hidden truncate font-mono text-[11px] text-ink-faint md:inline" title={sessionState?.cwd || session.folder}>{sessionState?.cwd || session.folder}</span>
      {session.locked && <span className="msn-badge-solo shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning">solo</span>}
      <span className="msn-agent-actions ml-auto flex shrink-0 items-center gap-1.5">
        {session.runner && <RunnerControls runner={session.runner} onConfigure={onConfigure} />}
        {session.live !== false && !sessionState?.tuiAlive && <Button variant="secondary" size="bare" onClick={() => action(() => relaunch(session.id))} className="msn-btn-relaunch px-2.5 py-1 text-xs text-ink-dim hover:border-accent">{sessionState ? 'Relaunch TUI' : '...'}</Button>}
      </span>
    </header>
    {error && <div className="msn-error-bar border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">{error}</div>}
    {/* Queue, divider and terminal share this body box, so the split's limits
        are measured against the space they actually divide (not the header). */}
    <div className="msn-col3-body flex min-h-0 flex-1 flex-col">
    {/* One wrapper in both states, so toggling never remounts the queue panel
        (its picker, drafts and history would reset). */}
    {session.runner && <div
      className="msn-queue-split flex min-h-0 shrink-0 flex-col"
      style={split ? { height: queueHeight ? `${queueHeight}px` : '45%', minHeight: `${QUEUE_MIN_PX}px`, maxHeight: `calc(100% - ${TERMINAL_MIN_PX + 6}px)` } : undefined}
    >
      <QueuePanel runner={session.runner} project={project} sessionId={session.id} expanded={queueExpanded} onCollapsedChange={onQueueCollapsedChange} onOpenChange={setQueueOpen} />
    </div>}
    {split && <Splitter axis="y" onResize={setQueueHeight} min={QUEUE_MIN_PX} max={100} storageKey={QUEUE_SPLIT_KEY} label="Resize queue and terminal" className="msn-queue-splitter" />}
    <div className="msn-terminal-view flex min-h-0 flex-1 flex-col">
      {reopenFor === session.id ? <Empty title="Reopening…">Starting this conversation again.</Empty>
        : sessionState && !sessionState.live ? <Empty title={reopenError ? 'Could not reopen this conversation' : 'This session is closed'}>{reopenError || 'Nothing is running here any more.'}<div className="mt-2.5"><Button variant="primary" size="bare" onClick={() => action(() => restart(session.id))} className="msn-btn-restart px-2.5 py-1 text-xs">Reopen this conversation</Button></div></Empty>
        : !sessionState ? <Empty title="Checking session…">The terminal attaches only after its pane has been verified.</Empty>
        : <div className="msn-terminal-wrap min-h-0 flex-1 overflow-hidden"><Terminal name={session.agentName} sessionId={session.tmux_id} showSessions={false} running={agentRunning} height="100%" minHeight="0" bordered={false} className="msn-terminal h-full" /></div>}
    </div>
    </div>
  </div>
}
