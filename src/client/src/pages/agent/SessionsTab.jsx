import { useState, useEffect } from 'react'
import { api } from '../../lib/api'
import Badge from '../../components/ui/Badge'

export default function SessionsTab({ agent }) {
  const [sessions, setSessions] = useState([])

  useEffect(() => {
    api(`/api/agents/${agent.name}/sessions`).then((d) => {
      if (d.sessions) setSessions(d.sessions)
    }).catch(() => {})
  }, [agent.name])

  if (sessions.length === 0) return <p className="text-ink-dim text-sm">No sessions recorded yet.</p>
  return (
    <div className="border border-line-faint rounded-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-ink-dim text-xs border-b border-line-faint">
              <th className="text-left px-4 py-2">ID</th>
              <th className="text-left px-4 py-2">Kind</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="text-left px-4 py-2">Model</th>
              <th className="text-right px-4 py-2">Tokens</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id} className="border-b border-line-faint/50">
                <td className="px-4 py-2 text-ink-faint font-mono text-xs">{s.id?.slice(0, 12)}...</td>
                  <td className="px-4 py-2"><Badge tone="neutral" size="md" className="bg-panel">{s.kind}</Badge></td>
                  <td className="px-4 py-2">
                    {s.status === 'active'
                      ? <Badge tone="success" size="md">{s.status}</Badge>
                      : <Badge tone="neutral" size="md" className="bg-panel">{s.status}</Badge>}
                  </td>
                <td className="px-4 py-2 text-ink-muted">{s.model || '-'}</td>
                <td className="px-4 py-2 text-right text-ink-faint">{s.tokens_in || 0}/{s.tokens_out || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
