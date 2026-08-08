import { Link } from 'react-router-dom'
import { useAgents } from '../stores/agents'
import { statusMeta } from '../lib/status'
import { webUrlForAgent } from '../lib/web'

export default function AgentCard({ agent }) {
  const st = statusMeta(agent.status)
  const start = useAgents((s) => s.startAgent)
  const stop = useAgents((s) => s.stopAgent)
  const restart = useAgents((s) => s.restartAgent)

  return (
    <div className="border border-line-faint rounded-xl p-5 hover:border-line-faint transition-all group">
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
          className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ml-3 flex items-center gap-1.5 ${st.pill}`}
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
              className="p-2 rounded-lg text-accent-text hover:text-ink hover:bg-accent-soft transition-colors"
              title={`Open ${agent.web.label || 'web app'} at ${webUrlForAgent(agent)}`}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M14 5h5v5M19 5l-8 8M9 5H5a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2v-4" />
              </svg>
            </a>
          )}
          {agent.status === 'running' ? (
            <>
              <button
                onClick={() => stop(agent.name)}
                className="p-2 rounded-lg text-warning hover:text-ink hover:bg-warning-soft transition-colors"
                title="Stop agent"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
              </button>
              <button
                onClick={() => restart(agent.name)}
                className="p-2 rounded-lg text-accent-text hover:text-ink hover:bg-accent-soft transition-colors"
                title="Restart agent"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </>
          ) : (
            <button
              onClick={() => start(agent.name)}
              className="p-2 rounded-lg text-success hover:text-ink hover:bg-success-soft transition-colors"
              title="Start agent"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
