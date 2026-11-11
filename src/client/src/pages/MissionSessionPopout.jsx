import { useDocumentTitle } from '../lib/useDocumentTitle'
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import MissionSessionView from '../components/MissionSessionView'
import MissionPopups from '../components/MissionPopups'
import { useMission } from '../stores/mission'
import { useAgents } from '../stores/agents'
import { useAuth } from '../stores/auth'
import { writePopoutGeometry } from '../lib/mission-popout'

export default function MissionSessionPopout() {
  const { sessionId = '' } = useParams()
  const [search, setSearch] = useSearchParams()
  const [sent, setSent] = useState(false)
  const userId = useAuth((s) => s.userId)
  const { projects, openSession, viewError, viewLoading, fetchProjects, restoreView } = useMission()
  const agents = useAgents((s) => s.agents)
  const fetchAgents = useAgents((s) => s.fetchAgents)
  const session = openSession?.id === sessionId ? openSession : null
  const project = session ? projects.find((p) => p.id === session.projectId) || null : null
  const queueExpanded = !!session?.runner && search.get('queue') !== 'closed'
  useDocumentTitle('Mission session')
  useEffect(() => {
    fetchProjects()
    if (!useAgents.getState().agents.length) fetchAgents()
    // Opening this window is the user asking for the session, so a dead pane is
    // restarted. RELOADING it is not: a reload must never start an agent
    // process on its own, the same rule the Mission page holds to.
    const reloaded = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload'
    restoreView({ session: sessionId }, { fresh: true, autoReopen: !reloaded })
  }, [sessionId, fetchProjects, fetchAgents, restoreView])
  useEffect(() => {
    if (sent || !window.opener) return
    if (session) {
      window.opener.postMessage({ type: 'paddock:mission-popout-ready', sessionId }, window.location.origin)
      setSent(true)
    } else if (!viewLoading && viewError) {
      window.opener.postMessage({ type: 'paddock:mission-popout-failed', sessionId, message: viewError }, window.location.origin)
      setSent(true)
    }
  }, [sent, session, sessionId, viewLoading, viewError])
  useEffect(() => {
    const save = () => writePopoutGeometry(userId)
    const interval = window.setInterval(save, 1000)
    window.addEventListener('resize', save)
    window.addEventListener('pagehide', save)
    return () => { window.clearInterval(interval); window.removeEventListener('resize', save); window.removeEventListener('pagehide', save); save() }
  }, [userId])
  if (!session) return <main className="flex h-screen items-center justify-center bg-sunken"><p className="text-sm text-ink-faint">{viewError || 'Loading session…'}</p></main>
  const agentRunning = (agents.find((a) => a.name === session.agentName)?.status ?? 'running') === 'running'
  return <main className="h-screen min-h-0"><MissionSessionView session={session} project={project} agentRunning={agentRunning} queueExpanded={queueExpanded} onQueueCollapsedChange={(closed) => setSearch((p) => { p.set('queue', closed ? 'closed' : 'open'); return p })} /><MissionPopups /></main>
}
