import { useState, useEffect } from 'react'
import { api } from '../../lib/api'

export default function ActivityTab({ agent }) {
  const [activity, setActivity] = useState([])

  useEffect(() => {
    api(`/api/agents/${agent.name}/activity`).then((d) => {
      if (d.activity) setActivity(d.activity)
    }).catch(() => {})
  }, [agent.name])

  if (activity.length === 0) return <p className="text-ink-dim text-sm">No activity recorded yet.</p>
  return (
    <div className="border border-line-faint rounded-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-ink-dim text-xs border-b border-line-faint">
              <th className="text-left px-4 py-2">Action</th>
              <th className="text-left px-4 py-2">Details</th>
              <th className="text-right px-4 py-2">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {activity.map((e, i) => {
              const colors = { start: 'text-success', stop: 'text-warning', restart: 'text-accent-text' }
              return (
                <tr key={i} className="border-b border-line-faint/50">
                  <td className="px-4 py-2">
                    <span className={`w-1.5 h-1.5 rounded-full inline-block mr-2 ${e.status === 'ok' ? 'bg-success' : 'bg-danger'}`} />
                    <span className={colors[e.action] || 'text-ink-muted'}>{e.action}</span>
                  </td>
                  <td className="px-4 py-2 text-ink-dim text-xs">{e.details || '-'}</td>
                  <td className="px-4 py-2 text-right text-ink-dim text-xs">{e.timestamp ? new Date(e.timestamp).toLocaleString() : '-'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
