import { Link } from 'react-router-dom'
import { useAgents } from '../stores/agents'
import { statusMeta } from '../lib/status'

export default function AgentCard({ agent }) {
  const st = statusMeta(agent.status)
  const start = useAgents((s) => s.startAgent)
  const stop = useAgents((s) => s.stopAgent)
  const restart = useAgents((s) => s.restartAgent)

  return (
    <div className="border border-slate-800 rounded-xl p-5 hover:border-slate-600 transition-all group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-slate-800 flex items-center justify-center text-lg font-bold text-cyan-400 flex-shrink-0">
            {agent.display_name?.charAt(0) || '?'}
          </div>
          <div className="min-w-0">
            <Link
              to={`/agents/${agent.name}`}
              className="font-semibold text-white hover:text-cyan-400 transition-colors block truncate"
            >
              {agent.display_name || agent.name}
            </Link>
            <p className="text-xs text-slate-500 truncate">{agent.name}</p>
          </div>
        </div>
        <span
          className={`px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 ml-3 flex items-center gap-1.5 ${st.pill}`}
        >
          <span className={`w-2 h-2 rounded-full ${st.dot} ${st.pulse ? 'animate-pulse' : ''}`} />
          {st.label}
        </span>
      </div>
      <div className="text-xs text-slate-500 space-y-1 mb-4">
        <div className="flex justify-between">
          <span>Type</span>
          <span className="text-slate-300">{agent.agent_type}</span>
        </div>
      </div>
      <div className="flex items-center justify-between pt-3 border-t border-slate-800">
        <Link
          to={`/agents/${agent.name}`}
          className="text-xs font-medium text-slate-400 hover:text-cyan-400 transition-colors"
        >
          Details &rarr;
        </Link>
        <div className="flex items-center gap-1">
          {agent.status === 'running' ? (
            <>
              <button
                onClick={() => stop(agent.name)}
                className="p-2 rounded-lg text-amber-400 hover:text-white hover:bg-amber-900/30 transition-colors"
                title="Stop agent"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
              </button>
              <button
                onClick={() => restart(agent.name)}
                className="p-2 rounded-lg text-cyan-400 hover:text-white hover:bg-cyan-900/30 transition-colors"
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
              className="p-2 rounded-lg text-emerald-400 hover:text-white hover:bg-emerald-900/30 transition-colors"
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
