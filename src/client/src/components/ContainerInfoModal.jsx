import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { cx } from '../lib/cx'
import Modal from './ui/Modal'
import Button from './ui/Button'
import Badge from './ui/Badge'
import { TONES } from './ui/tone'

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
    <Modal
      open
      onClose={onClose}
      title={title || `Container Info — ${name}`}
      width="max-w-3xl"
      z="z-[75]"
      divided
      bodyScroll
      panelClassName="max-h-[90vh]"
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={load} loading={loading}>
            Refresh
          </Button>
          <Button variant="primary" size="lg" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {loading && <div className="py-10 text-center text-sm text-ink-dim">Loading container info…</div>}

      {!loading && error && (
        <div>
          <p className={cx('rounded-card border p-3 text-xs whitespace-pre-wrap', TONES.danger.panel)}>{error}</p>
          <div className="flex justify-end mt-4">
            <Button variant="primary" size="lg" onClick={load}>
              Retry
            </Button>
          </div>
        </div>
      )}

      {!loading && !error && data && (
        <div className="space-y-6">
          <section>
            <dl className="flex flex-wrap gap-2">
              {overviewRows.map(([label, value, mono]) => (
                <div key={label} className="min-w-[9rem] flex-1 rounded-card bg-sunken border border-line-faint px-3 py-2">
                  <dt className="text-[10px] uppercase tracking-wider text-ink-dim">{label}</dt>
                  <dd className={cx('mt-1 text-xs text-ink break-words min-w-0', mono && 'font-mono')}>{value}</dd>
                </div>
              ))}
            </dl>
          </section>

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
                        <Badge tone={m.type === 'bind' ? 'accent' : m.type === 'volume' ? 'warning' : 'neutral'}>
                          {m.type}
                        </Badge>
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-ink-muted break-all">
                        {m.type === 'volume' ? m.name || m.destination : m.source}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-ink break-all">{m.destination}</td>
                      <td className="py-1.5 text-right">
                        <Badge tone={m.rw ? 'success' : 'danger'}>{m.rw ? 'rw' : 'ro'}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

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
                  <div key={n.name} className="flex flex-wrap items-center gap-x-4 gap-y-0.5 rounded-card bg-sunken border border-line-faint px-3 py-1.5 text-xs font-mono">
                    <span className="font-medium text-ink">{n.name}</span>
                    <span className="text-ink-muted">{n.ipAddress || 'no IP'}</span>
                    <span className="text-ink-dim">gw {n.gateway || '—'}</span>
                    {n.aliases.length > 0 && <span className="text-ink-dim">aliases: {n.aliases.join(', ')}</span>}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
              Published ports{' '}
              {data.ports.published.length > 0 && <span className="normal-case">({data.ports.published.length})</span>}
            </h4>
            {data.ports.published.length === 0 ? (
              <div>
                <p className="text-xs text-ink-dim">No host-published ports.</p>
                {data.ports.exposed.length > 0 && (
                  <p className={cx('mt-1.5 rounded-card border px-3 py-1.5 text-[11px]', TONES.warning.panel)}>
                    <span className="font-semibold">Not published:</span> {data.ports.exposed.join(', ')} — declared by
                    the image ({'EXPOSE'}) but never bound to the host. Nothing is reachable.
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                {data.ports.published.map((p, i) => (
                  <div key={i} className="rounded-card bg-sunken border border-line-faint px-3 py-1.5 text-xs font-mono">
                    <span className="text-success">{p.host}</span>
                    <span className="text-ink-dim mx-1.5">→</span>
                    <span className="text-ink">{p.container}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
              Environment <span className="normal-case">({data.envCount})</span>
            </h4>
            <div className="rounded-card bg-sunken border border-line-faint px-3 py-2 text-xs font-mono text-ink-dim break-all">
              {data.envKeys.length > 0 ? data.envKeys.join(', ') : '—'}
            </div>
          </section>

          <section>
            <details className="group rounded-card border border-line-faint bg-sunken">
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
    </Modal>
  )
}
