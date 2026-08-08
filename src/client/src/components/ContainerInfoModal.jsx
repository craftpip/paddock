import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  if (isNaN(d.getTime()) || d.getUTCFullYear() <= 1) return '—'
  return d.toLocaleString()
}

function fmtUptime(secs) {
  if (!secs || secs < 1) return '0s'
  const d = Math.floor(secs / 86400)
  const h = Math.floor((secs % 86400) / 3600)
  const m = Math.floor((secs % 3600) / 60)
  const s = secs % 60
  if (d) return `${d}d ${h}h ${m}m`
  if (h) return `${h}h ${m}m ${s}s`
  return `${m}m ${s}s`
}

function shortId(id) {
  if (!id) return '—'
  return id.replace(/^sha256:/, '').slice(0, 12)
}

/**
 * Container Info popup for the Settings tab. Lazily fetches
 * `/api/agents/:name/container-info` only when the popup opens (never on page
 * load). Live uptime is derived from State.StartedAt and ticks every second.
 */
export default function ContainerInfoModal({ name, title, onClose }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    setError('')
    setData(null)
    api(`/api/agents/${name}/container-info`)
      .then((d) => {
        setData(d)
        setNow(Date.now())
      })
      .catch((err) => setError(err.error || err.message || 'Failed to load container info'))
      .finally(() => setLoading(false))
  }, [name])

  useEffect(() => {
    load()
  }, [load])

  const running = !!data?.state?.running
  const uptimeSecs = running
    ? Math.max(0, Math.floor((now - new Date(data.state.startedAt).getTime()) / 1000))
    : 0
  const uptime = running ? fmtUptime(uptimeSecs) : '—'

  const netMode = data?.network?.mode || ''
  const isPeer = netMode.startsWith('container:')
  const netLabel = isPeer
    ? `container: ${data.network.peerName || netMode.slice('container:'.length)}`
    : netMode || '—'

  const overviewRows = data
    ? [
        ['Network', netLabel, true],
        ['Image', `${shortId(data.image.id)} · ${data.image.tag || ''}`, true],
        ['Restart policy', data.restartPolicy?.Name || '—', false],
        ['Status', running ? 'running' : (data.state.status || 'stopped'), false],
        ['Uptime', uptime, true],
        ['Created', fmtTime(data.created), false],
        ['Started', fmtTime(data.state.startedAt), false],
        ...(!running && data.state.finishedAt
          ? [['Finished', fmtTime(data.state.finishedAt), false]]
          : []),
      ]
    : []

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center bg-overlay backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="bg-panel border border-line rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[90vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3 border-b border-line shrink-0">
          <h3 className="text-base font-semibold text-ink break-all min-w-0">{title || `Container Info — ${name}`}</h3>
          <button onClick={onClose} title="Close" className="text-ink-dim hover:text-ink text-sm px-1 leading-none shrink-0">✕</button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 overflow-y-auto">
          {loading && (
            <div className="py-10 text-center text-sm text-ink-dim">Loading container info…</div>
          )}

          {!loading && error && (
            <div>
              <div className="bg-danger-soft border border-danger-line rounded-lg p-3 text-xs text-danger whitespace-pre-wrap">
                {error}
              </div>
              <div className="flex justify-end mt-4">
                <button
                  onClick={load}
                  className="px-4 py-2 text-sm font-medium text-accent-ink bg-accent hover:bg-accent-hover rounded-lg transition-colors"
                >
                  Retry
                </button>
              </div>
            </div>
          )}

          {!loading && !error && data && (
            <div className="space-y-6">
              {/* Overview */}
              <section>
                <dl className="flex flex-wrap gap-2">
                  {overviewRows.map(([label, value, mono]) => (
                    <div key={label} className="min-w-[9rem] flex-1 rounded-lg bg-sunken border border-line-faint px-3 py-2">
                      <dt className="text-[10px] uppercase tracking-wider text-ink-dim">{label}</dt>
                      <dd className={`mt-1 text-xs text-ink break-words min-w-0 ${mono ? 'font-mono' : ''}`}>{value}</dd>
                    </div>
                  ))}
                </dl>
              </section>

              {/* Mounts */}
              <section>
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Mounts</h4>
                  <span className="text-[11px] text-ink-dim">
                    {data.counts.total} total · {data.counts.binds} bind · {data.counts.volumes} volume
                    {data.counts.tmpfs ? ` · ${data.counts.tmpfs} tmpfs` : ''} · {data.counts.readWrite} rw · {data.counts.readOnly} ro
                  </span>
                </div>
                {data.mounts.length === 0 ? (
                  <p className="text-xs text-ink-dim">No mounts.</p>
                ) : (
                  <table className="w-full text-xs border-collapse">
                    <thead>
                      <tr className="text-left text-[10px] uppercase tracking-wider text-ink-dim border-b border-line-faint">
                        <th className="py-1.5 pr-2 font-medium">Type</th>
                        <th className="py-1.5 pr-2 font-medium">Source</th>
                        <th className="py-1.5 pr-2 font-medium">Destination</th>
                        <th className="py-1.5 font-medium text-right">Access</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.mounts.map((m, i) => (
                        <tr key={i} className="border-b border-line-faint/60 align-top">
                          <td className="py-1.5 pr-2">
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${m.type === 'bind' ? 'bg-accent/20 text-accent' : m.type === 'volume' ? 'bg-warning/20 text-warning' : 'bg-raised text-ink-dim'}`}
                            >
                              {m.type}
                            </span>
                          </td>
                          <td className="py-1.5 pr-2 font-mono text-ink-muted break-all">{m.type === 'volume' ? m.name || m.destination : m.source}</td>
                          <td className="py-1.5 pr-2 font-mono text-ink break-all">{m.destination}</td>
                          <td className="py-1.5 text-right">
                            <span
                              className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${m.rw ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`}
                            >
                              {m.rw ? 'rw' : 'ro'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              {/* Network */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
                  Network <span className="font-mono normal-case">{netMode}</span>
                </h4>
                {data.network.networks.length === 0 ? (
                  <p className="text-xs text-ink-dim">
                    {isPeer
                      ? `Shares the network namespace of ${data.network.peerName || 'the network peer'} — no own endpoint.`
                      : 'No network endpoints.'}
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {data.network.networks.map((n) => (
                      <div key={n.name} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 rounded-lg bg-sunken border border-line-faint px-3 py-1.5 text-xs font-mono">
                        <span className="font-medium text-ink">{n.name}</span>
                        <span className="text-ink-muted">{n.ipAddress || 'no IP'}</span>
                        <span className="text-ink-dim">gw {n.gateway || '—'}</span>
                        {n.aliases.length > 0 && <span className="text-ink-dim">aliases: {n.aliases.join(', ')}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Ports */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
                  Published ports {data.ports.published.length > 0 && <span className="normal-case">({data.ports.published.length})</span>}
                </h4>
                {data.ports.published.length === 0 ? (
                  <div>
                    <p className="text-xs text-ink-dim">No host-published ports.</p>
                    {data.ports.exposed.length > 0 && (
                      <p className="mt-1.5 rounded-lg bg-warning-soft border border-warning-line/60 px-3 py-1.5 text-[11px] text-warning">
                        <span className="font-semibold">Not published:</span> {data.ports.exposed.join(', ')} — declared by the image ({'EXPOSE'})
                        {' '}but never bound to the host. Nothing is reachable.
                      </p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    {data.ports.published.map((p, i) => (
                      <div key={i} className="rounded-lg bg-sunken border border-line-faint px-3 py-1.5 text-xs font-mono">
                        <span className="text-success">{p.host}</span>
                        <span className="text-ink-dim mx-1.5">→</span>
                        <span className="text-ink">{p.container}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Environment */}
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
                  Environment <span className="normal-case">({data.envCount})</span>
                </h4>
                <div className="rounded-lg bg-sunken border border-line-faint px-3 py-2 text-xs font-mono text-ink-dim break-all">
                  {data.envKeys.length > 0 ? data.envKeys.join(', ') : '—'}
                </div>
              </section>

              {/* Raw inspect */}
              <section>
                <details className="group rounded-lg border border-line-faint bg-sunken">
                  <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-ink-muted hover:text-ink">
                    Raw docker inspect JSON <span className="text-ink-dim font-normal">(secrets redacted)</span>
                  </summary>
                  <pre className="px-3 pb-3 pt-1 text-[11px] leading-relaxed text-ink-faint font-mono overflow-x-auto whitespace-pre-wrap break-words max-h-72 overflow-y-auto">
                    {JSON.stringify(data.raw, null, 2)}
                  </pre>
                </details>
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-3 border-t border-line shrink-0">
          <button
            onClick={load}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-ink bg-raised hover:bg-raised-hover rounded-lg transition-colors disabled:opacity-50"
          >
            Refresh
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-accent-ink bg-accent hover:bg-accent-hover rounded-lg transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
