import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { callbackOutput } from '../lib/callback-output'
import Button from './ui/Button'

const FILTERS = [['all', 'All activity'], ['plans', 'Plans'], ['input', 'Input'], ['recovery', 'Recovery'], ['problems', 'Problems']]
const actorName = (actor) => actor === 'recovery-script' ? 'Recovery script' : ['runner', 'system', 'quota-recovery'].includes(actor) ? 'Runner' : actor.startsWith('user:') || actor === 'user' ? 'User' : actor
const time = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const dateLabel = (at) => new Date(at).toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })

function ScriptOutput({ runnerId, groupId }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = async () => {
    setLoading(true); setError('')
    try { setData(await api(`/api/mission/runners/${runnerId}/history/output/${groupId}`)) }
    catch (e) { setError(e.error || 'Could not load script output') }
    finally { setLoading(false) }
  }
  if (!data) return <div className="mt-2"><Button size="bare" variant="ghost" className="msn-history-script-output text-[11px] px-1" disabled={loading} onClick={load}>{loading ? 'Loading output…' : 'View script output'}</Button>{error && <p role="alert" className="text-xs text-danger">{error}</p>}</div>
  const display = callbackOutput(data)
  return <div className="mt-2 text-[11px]">
    <p>{display.label}{data.exit_code != null ? ` · exit ${data.exit_code}` : ''}{data.truncated ? ' · output truncated' : ''}</p>
    <pre className={`mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2 ${display.failed ? 'text-danger' : 'text-ink-dim'}`}>{[display.output, display.diagnostics].filter(Boolean).join('\n') || 'No script output.'}</pre>
  </div>
}

function Event({ event }) {
  return <div className="msn-history-event flex min-w-0 gap-3 py-1.5">
    <time className="shrink-0 font-mono text-[10px] text-ink-faint" dateTime={event.createdAt} title={new Date(event.createdAt).toString()}>{time(event.createdAt)}</time>
    <div className="min-w-0 flex-1">
      <p className={`break-words text-xs font-medium ${event.severity === 'error' ? 'text-danger' : event.severity === 'warning' ? 'text-warning' : 'text-ink'}`}>
        {event.title}{event.details.plan ? ` — ${event.details.plan}` : ''}
      </p>
      <p className="mt-0.5 text-[10px] text-ink-faint">{actorName(event.actor)}{event.details.exitCode != null ? ` · exit ${event.details.exitCode}` : ''}{event.details.code ? ` · ${event.details.code}` : ''}</p>
      {event.details.reason && <p className="mt-1 whitespace-pre-wrap break-words text-[11px] text-ink-dim">{event.details.reason}</p>}
    </div>
  </div>
}

export default function RunnerHistory({ runnerId, active }) {
  const [filter, setFilter] = useState('all')
  const [snapshot, setSnapshot] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [moreLoading, setMoreLoading] = useState(false)
  const [pending, setPending] = useState(null)
  const scroller = useRef(null)
  const request = useRef(0)
  const shown = useRef(null)

  const refresh = async (force = false) => {
    const token = ++request.current
    if (!shown.current) setLoading(true)
    try {
      const data = await api(`/api/mission/runners/${runnerId}/history?category=${filter}`)
      if (token !== request.current) return
      setError('')
      // Hold the rendered tree while the user is reading older entries. This
      // preserves scroll position and open recovery details on every poll.
      if (!force && shown.current && (scroller.current?.scrollTop || 0) > 32) {
        if (data.latest > shown.current.latest) setPending(data)
      } else {
        shown.current = data; setSnapshot(data); setPending(null)
      }
    } catch (e) {
      if (token === request.current) setError(e.error || 'Could not load runner history')
    } finally { if (token === request.current) setLoading(false) }
  }

  useEffect(() => {
    shown.current = null; setSnapshot(null); setPending(null); setError('')
    if (scroller.current) scroller.current.scrollTop = 0
    return () => { request.current++ }
  }, [runnerId, filter])

  useEffect(() => {
    if (!active) return
    refresh()
    const timer = setInterval(() => refresh(), 15000)
    return () => { clearInterval(timer); request.current++ }
  }, [runnerId, filter, active])

  const older = async () => {
    if (!snapshot?.nextCursor || moreLoading) return
    const token = ++request.current
    setMoreLoading(true)
    try {
      const data = await api(`/api/mission/runners/${runnerId}/history?category=${filter}&before=${snapshot.nextCursor}`)
      if (token !== request.current) return
      const ids = new Set(snapshot.groups.map((g) => g.id))
      const combined = { ...snapshot, groups: [...snapshot.groups, ...data.groups.filter((g) => !ids.has(g.id))], nextCursor: data.nextCursor }
      shown.current = combined; setSnapshot(combined); setError('')
    } catch (e) { if (token === request.current) setError(e.error || 'Could not load older activity') }
    finally { setMoreLoading(false) }
  }

  let lastDay = ''
  return <div className={`msn-history-panel min-h-0 flex-1 flex-col ${active ? 'flex' : 'hidden'}`} id="msn-runner-history" role="tabpanel" aria-labelledby="msn-history-tab">
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-line-faint px-3 py-2" aria-label="History filters">
      {FILTERS.map(([key, label]) => <Button key={key} size="bare" variant={filter === key ? 'primary' : 'ghost'} aria-pressed={filter === key} onClick={() => setFilter(key)} className="msn-history-filter px-2 py-1 text-[11px]">{label}</Button>)}
      <Button size="bare" variant="ghost" onClick={() => refresh(true)} className="msn-history-refresh ml-auto px-2 py-1 text-[11px]" disabled={loading}>Refresh</Button>
    </div>
    {pending && <button type="button" className="msn-history-new shrink-0 bg-accent-soft px-3 py-2 text-xs text-accent-text" onClick={() => {
      shown.current = pending; setSnapshot(pending); setPending(null); if (scroller.current) scroller.current.scrollTop = 0
    }}>{pending.groups.reduce((count, group) => count + group.events.filter((event) => event.id > (snapshot?.latest || 0)).length, 0) || 'New'} activity updates — show latest</button>}
    {error && <p role="alert" className="msn-history-error px-3 py-2 text-xs text-danger">{error} <button type="button" className="underline" onClick={() => refresh(true)}>Retry</button>{snapshot ? ' · Showing previously loaded activity.' : ''}</p>}
    <div ref={scroller} className="msn-history-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-3" tabIndex={0} aria-label="Runner activity timeline">
      {loading && !snapshot && <p className="py-4 text-xs text-ink-faint">Loading history…</p>}
      {snapshot && !snapshot.groups.length && <p className="msn-history-empty py-4 text-xs text-ink-dim">{filter === 'all' ? 'No activity recorded yet. New runner activity will appear here.' : 'No activity matches this filter.'}</p>}
      {snapshot?.groups.map((group) => {
        const day = dateLabel(group.createdAt)
        const heading = day !== lastDay; lastDay = day
        const latest = group.events.at(-1)
        const grouped = group.events.length > 1 || group.groupId?.startsWith('cb_')
        return <div key={group.id} className="msn-history-group">
          {heading && <h4 className="mt-3 mb-1 border-b border-line-faint pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{day}</h4>}
          {grouped ? <details className="msn-history-attempt my-2 rounded-control border border-line-faint bg-panel px-2 py-1">
            <summary className="cursor-pointer break-words py-1 text-xs text-ink-dim">
              <time className="mr-2 font-mono text-[10px] text-ink-faint" dateTime={group.createdAt} title={new Date(group.createdAt).toString()}>{time(group.createdAt)}</time>
              {group.groupId?.startsWith('answer:') ? 'Input response' : 'Recovery / callback'}
              <span className={`ml-2 ${latest?.severity === 'error' ? 'text-danger' : latest?.severity === 'warning' ? 'text-warning' : 'text-ink'}`}>— {latest?.title}</span>
            </summary>
            {group.events.map((event) => <Event key={event.id} event={event} />)}
            {group.truncated && <p className="text-xs text-ink-faint">Showing the first 100 steps.</p>}
            {group.groupId?.startsWith('cb_') && <ScriptOutput runnerId={runnerId} groupId={group.groupId} />}
          </details> : <Event event={group.events[0]} />}
        </div>
      })}
      {snapshot?.nextCursor && <Button size="bare" variant="secondary" onClick={older} disabled={moreLoading} className="msn-history-older mt-3 px-3 py-1.5 text-xs">{moreLoading ? 'Loading…' : 'Load older activity'}</Button>}
      {snapshot?.since && <p className="mt-4 text-[10px] text-ink-faint">Recorded activity since {new Date(snapshot.since).toLocaleString()}. Earlier activity is not reconstructed.</p>}
    </div>
  </div>
}
