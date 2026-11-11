import { useState, useRef, useEffect } from 'react'
import { useNavigation } from '../../lib/navigation'
import { api } from '../../lib/api'
import Button from '../../components/ui/Button'
import { Select } from '../../components/ui/Input'

export default function LogsTab({ agent }) {
  const { location, patch } = useNavigation()
  const [logs, setLogs] = useState('')
  const requestedTail = Number(new URLSearchParams(location.search).get('tail'))
  const tail = [50, 100, 500, 1000].includes(requestedTail) ? requestedTail : 100
  const setTail = (value) => patch({ tail: value })
  const [autoScroll, setAutoScroll] = useState(true)
  const preRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    const load = () => {
      api(`/api/agents/${agent.name}/logs?tail=${tail}`).then((d) => {
        if (d.logs && !cancelled) setLogs(d.logs)
      }).catch(() => {})
    }
    load()
    const iv = setInterval(() => {
      if (document.visibilityState !== 'hidden') load()
    }, 5000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [agent.name, tail])

  useEffect(() => {
    const el = preRef.current
    if (el && autoScroll) el.scrollTop = el.scrollHeight
  }, [logs, autoScroll])

  const onScroll = () => {
    const el = preRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30
    if (autoScroll && !atBottom) setAutoScroll(false)
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-medium text-ink-muted">Container Logs</h3>
          <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
        </div>
        <div className="flex items-center gap-2">
          {/* The w-20 wrapper keeps the select shrink-to-fit: Select's own
              wrapper span is `w-full`, which inside a flex row would eat the
              row and squeeze the button next to it. */}
          <div className="w-20 shrink-0">
            <Select size="sm" value={tail} onChange={(e) => setTail(parseInt(e.target.value))}>
              <option value={50}>50</option><option value={100}>100</option><option value={500}>500</option><option value={1000}>1000</option>
            </Select>
          </div>
          <Button
            variant={autoScroll ? 'primary' : 'ghost'}
            size="sm"
            onClick={() => { setAutoScroll(true); if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight }}
            className={autoScroll ? undefined : 'bg-panel text-ink-faint'}
          >
            Auto-scroll
          </Button>
        </div>
      </div>
      <pre ref={preRef} onScroll={onScroll}
           className="flex-1 min-h-0 text-xs leading-tight overflow-auto bg-sunken border border-line-faint rounded-card p-4 text-ink-muted font-mono">
        {logs || 'No logs available'}
      </pre>
    </div>
  )
}
