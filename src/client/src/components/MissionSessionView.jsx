import QueuePanel from './QueuePanel'
import RunnerControls from './RunnerControls'
import Terminal from './Terminal'
import Button from './ui/Button'
import { useMission } from '../stores/mission'

function Empty({ title, children, action }) {
  return <div className="msn-empty flex h-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center"><p className="text-sm font-medium text-ink-dim">{title}</p>{children && <div className="max-w-[34ch] text-xs leading-relaxed text-ink-faint">{children}</div>}{action}</div>
}

export default function MissionSessionView({ session, project, agentRunning, queueExpanded, onQueueCollapsedChange, onConfigure, error = '' }) {
  const sessionState = useMission((s) => s.sessionState)
  const reopenFor = useMission((s) => s.reopenFor)
  const reopenError = useMission((s) => s.reopenError)
  const relaunch = useMission((s) => s.relaunch)
  const restart = useMission((s) => s.restart)
  const action = async (fn) => { try { await fn() } catch {} }
  if (!session?.agentName) return <Empty title="Session unavailable">This session no longer has an available agent.</Empty>
  const title = session.runner?.name || session.title || session.label || session.tmux_id
  return <div className="msn-session-view flex h-full min-h-0 flex-col bg-sunken">
    <header className="msn-agent-header flex h-9 shrink-0 items-center gap-2 border-b border-line-faint px-3">
      <span className={`msn-agent-dot h-1.5 w-1.5 shrink-0 rounded-full ${sessionState?.live ? 'bg-success' : 'bg-ink-faint'}`} />
      {project && <span className="msn-agent-project shrink-0 truncate rounded bg-accent/15 px-1 text-[9px] font-medium text-accent" title={session.folder}>{project.name}</span>}
      <span className="msn-agent-label truncate text-[11px] font-medium text-ink-dim" title={title}>{title}</span>
      <span className="msn-agent-cwd truncate font-mono text-[10px] text-ink-faint" title={sessionState?.cwd || session.folder}>{sessionState?.cwd || session.folder}</span>
      {session.locked && <span className="msn-badge-solo shrink-0 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] text-warning">solo</span>}
      <span className="msn-agent-actions ml-auto flex shrink-0 items-center gap-1.5">
        {session.runner && <RunnerControls runner={session.runner} onConfigure={onConfigure} />}
        {session.live !== false && !sessionState?.tuiAlive && <Button variant="secondary" size="bare" onClick={() => action(() => relaunch(session.id))} className="msn-btn-relaunch py-0.5 text-[10px] text-ink-dim hover:border-accent">{sessionState ? 'Relaunch TUI' : '...'}</Button>}
      </span>
    </header>
    {error && <div className="msn-error-bar border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-[11px] text-danger">{error}</div>}
    {session.runner && <QueuePanel runner={session.runner} project={project} sessionId={session.id} expanded={queueExpanded} onCollapsedChange={onQueueCollapsedChange} />}
    <div className={`msn-terminal-view min-h-0 flex-1 ${queueExpanded ? 'hidden' : 'flex flex-col'}`} aria-hidden={queueExpanded}>
      {reopenFor === session.id ? <Empty title="Reopening…">Starting this conversation again.</Empty>
        : sessionState && !sessionState.live ? <Empty title={reopenError ? 'Could not reopen this conversation' : 'This session is closed'}>{reopenError || 'Nothing is running here any more.'}<div className="mt-2.5"><Button variant="primary" size="bare" onClick={() => action(() => restart(session.id))} className="msn-btn-restart px-2.5 py-1 text-xs">Reopen this conversation</Button></div></Empty>
        : !sessionState ? <Empty title="Checking session…">The terminal attaches only after its pane has been verified.</Empty>
        : <div className="msn-terminal-wrap min-h-0 flex-1 overflow-hidden"><Terminal name={session.agentName} sessionId={session.tmux_id} showSessions={false} running={agentRunning} height="100%" minHeight="0" bordered={false} className="msn-terminal h-full" /></div>}
    </div>
  </div>
}
