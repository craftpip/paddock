import Button from './ui/Button'

export default function TerminalHeader({
  connState,
  uiLocked,
  cmdRunning,
  showSessions,
  tabListRef,
  sessions,
  activeSessionId,
  sessionTitles,
  switchSession,
  closeSession,
  sessionsLoading,
  sessionsLoaded,
  newSession,
  shellBusy,
  collapsed,
  sendToShell,
  setFontSize,
  fontSize,
  controlled,
  termRef,
  reconnect,
  onToggleCollapse,
  showCollapse,
  fullscreen,
  setFullscreen,
}) {
  return (
    <div className="terminal-header flex flex-wrap sm:flex-nowrap items-stretch border-b border-line-faint bg-panel select-none">
        <div className="order-2 flex items-center gap-2 px-2 shrink-0">
          <span
            title={connState === 'connected' ? 'Terminal Connected' : connState === 'connecting' ? 'Terminal Connecting' : 'Terminal Disconnected'}
            className={`w-2 h-2 rounded-full ${connState === 'connected' ? 'bg-success' : connState === 'connecting' ? 'bg-warning' : 'bg-line'}`}
          />
          {uiLocked && !cmdRunning && (
            <span title="Locked — only injected commands run" className="flex items-center text-warning">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
          )}
        </div>
        {showSessions && (
        <div className="terminal-tab-bar order-1 flex flex-1 basis-full sm:basis-auto min-h-9 min-w-0 items-stretch">
        <div ref={tabListRef} role="tablist" aria-label="Terminal sessions" className="terminal-tabs flex flex-initial min-w-0 items-stretch overflow-x-auto overflow-y-hidden">
          {(sessions.some((s) => s.name === activeSessionId) ? sessions : [...sessions, { name: activeSessionId }]).map((s) => {
            const isCur = s.name === activeSessionId
            const tabTitle = sessionTitles[s.name] ?? s.title ?? ''
            return (
              <div
                key={s.name}
                role="tab"
                aria-selected={isCur}
                tabIndex={0}
                data-active={isCur ? 'true' : 'false'}
                onClick={() => switchSession(s.name)}
                onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return
                  e.preventDefault()
                  e.stopPropagation()
                  closeSession(s.name)
                }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchSession(s.name) } }}
                title={tabTitle ? `${s.name} — ${tabTitle}` : `Session ${s.name}`}
                className={`terminal-tab group relative -mb-px first:ml-2 flex min-w-24 max-w-48 shrink-0 cursor-pointer items-center border-b-2 pl-3 pr-2 text-xs font-mono transition-colors outline-none ${isCur ? 'bg-sunken text-ink border-accent' : 'text-ink-dim border-transparent hover:text-ink hover:bg-raised'}`}
              >
                <span className={`terminal-tab-label min-w-0 flex-1 truncate ${sessionsLoading && !sessionsLoaded ? 'animate-pulse' : ''} ${isCur ? '[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.25rem),transparent)]' : 'group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.25rem),transparent)] group-focus-within:[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.25rem),transparent)]'}`}>
                  {tabTitle || s.name}
                </span>
                <Button
                  variant="ghost"
                  size="bare"
                  onClick={(e) => { e.stopPropagation(); closeSession(s.name) }}
                  title={`Close session ${s.name}`}
                  aria-label={`Close session ${s.name}`}
                  className={`absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 shrink-0 rounded-full p-0 leading-none ${isCur ? '' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'}`}
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                    <path d="m5 5 14 14M19 5 5 19" />
                  </svg>
                </Button>
              </div>
            )
          })}
        </div>
          <Button
            variant="ghost"
            size="bare"
            onClick={newSession}
            title="New terminal tab"
            aria-label="New terminal tab"
            className="self-center mx-2 h-8 w-8 shrink-0 rounded-full border border-line-faint p-0 text-lg leading-none text-ink-dim hover:text-accent-text hover:bg-raised"
          >
            +
          </Button>
          {shellBusy && !collapsed && (
            <Button
              variant="dangerGhost"
              size="sm"
              onClick={() => sendToShell('\x03')}
              title="Send Ctrl+C to interrupt the running command"
              aria-label="Stop command"
              className="self-center mx-1 my-1 shrink-0"
            >
              Stop Command
            </Button>
          )}
        </div>
        )}
        <div className="order-3 relative ml-auto flex shrink-0 items-center gap-1.5 px-2 py-1">
          <span className="w-px h-4 bg-raised" />
          <Button variant="ghost" size="sm" onClick={() => setFontSize((s) => Math.max(10, s - 1))} className="text-ink-faint">A-</Button>
          <span className="text-xs text-ink-dim w-6 text-center">{fontSize}</span>
          <Button variant="ghost" size="sm" onClick={() => setFontSize((s) => Math.min(24, s + 1))} className="text-ink-faint">A+</Button>
          <span className="w-px h-4 bg-raised" />
          {/* A pinned session (Mission) is an agent's own screen, not a shell: typing
              `clear` there would be SENT TO THE AGENT as a prompt. Clear only the
              local scrollback in that case. */}
          <Button variant="ghost" size="sm" onClick={() => (controlled ? termRef.current?.clear() : sendToShell('clear\n'))} title={controlled ? 'Clear the scrollback shown here' : 'Run clear in the shell'} className="msn-term-clear text-ink-faint">Clear</Button>
          <Button variant="ghost" size="sm" onClick={reconnect} className="text-ink-faint">Reconnect</Button>

          {onToggleCollapse && showCollapse && !fullscreen && (
            <>
              <span className="w-px h-4 bg-raised" />
              <Button
                variant="ghost"
                size="sm"
                icon
                onClick={onToggleCollapse}
                title={collapsed ? 'Expand terminal' : 'Collapse terminal'}
                className="text-ink-faint"
              >
                {collapsed ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 15l6-6 6 6" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                )}
              </Button>
            </>
          )}

          {fullscreen ? (
            <Button
              variant="ghost"
              size="sm"
              icon
              onClick={() => setFullscreen(false)}
              title="Exit fullscreen (Esc)"
              className="text-ink-faint"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14h6v6" />
                <path d="M20 10h-6V4" />
                <path d="M14 10l7-7" />
                <path d="M3 21l7-7" />
              </svg>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              icon
              onClick={() => setFullscreen(true)}
              title="Fullscreen"
              className="text-ink-faint"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            </Button>
          )}
        </div>
      </div>
  )
}
