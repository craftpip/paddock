import { Link } from 'react-router-dom'
import { useAgents } from '../stores/agents'
import { statusMeta } from '../lib/status'
import { webUrlForAgent } from '../lib/web'
import Button from './ui/Button'

export default function AgentCard({ agent }) {
  const st = statusMeta(agent.status)
  const start = useAgents((s) => s.startAgent)
  const stop = useAgents((s) => s.stopAgent)
  const restart = useAgents((s) => s.restartAgent)

  return (
    <div className="border border-line-faint rounded-card p-5 hover:border-line-faint transition-all group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-panel flex items-center justify-center text-lg font-bold text-accent-text flex-shrink-0">
            {agent.display_name?.charAt(0) || '?'}
          </div>
          <div className="min-w-0">
            <Link
              to={`/agents/${agent.name}`}
              className="font-semibold text-ink hover:text-accent-text transition-colors block truncate"
            >
              {agent.display_name || agent.name}
            </Link>
            <p className="text-xs text-ink-dim truncate">{agent.name}</p>
          </div>
        </div>
        <span
          className={`px-2 py-0.5 rounded-pill text-xs font-medium flex-shrink-0 ml-3 flex items-center gap-1.5 ${st.pill}`}
        >
          <span className={`w-2 h-2 rounded-full ${st.dot} ${st.pulse ? 'animate-pulse' : ''}`} />
          {st.label}
        </span>
      </div>
      <div className="text-xs text-ink-dim space-y-1 mb-4">
        <div className="flex justify-between">
          <span>Type</span>
          <span className="text-ink-muted">{agent.agent_type}</span>
        </div>
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-line-faint">
        <Link
          to={`/agents/${agent.name}`}
          className="text-xs font-medium text-ink-faint hover:text-accent-text transition-colors"
        >
          Details &rarr;
        </Link>
        <div className="flex items-center gap-1">
          {webUrlForAgent(agent) && (
            <a
              href={webUrlForAgent(agent)}
              target="_blank"
              rel="noreferrer"
              className="p-2 rounded-control text-accent-text hover:text-ink hover:bg-accent-soft transition-colors"
              title={`Open ${agent.web.label || 'web app'} at ${webUrlForAgent(agent)}`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5M19 5l-8 8M9 5H5a 2 2 0 0 0 -2 2v12a 2 2 0 0 0 2 2h12a 2 2 0 0 0 2 -2v-4" />
              </svg>
            </a>
          )}
          {agent.status === 'running' ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                icon
                onClick={() => stop(agent.name)}
                className="text-warning hover:bg-warning-soft"
                title="Stop agent"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
              </Button>
              <Button
                variant="accentGhost"
                size="sm"
                icon
                onClick={() => restart(agent.name)}
                title="Restart agent"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A 8.001 8.0 0 1 0 4.582 9m0 0H9m11 11v-5h-.581m0 0a 8.003 8.003 0 0 1 -15.357 -2m15.357 2H15" />
                </svg>
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              icon
              onClick={() => start(agent.name)}
              className="text-success hover:bg-success-soft"
              title="Start agent"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
