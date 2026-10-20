import { useEffect, useMemo, useState } from 'react'
import { useNavigation, useQueryInput, useDraftState, useDirtyNavigation, popupIdentity } from '../lib/navigation'
import Button from './ui/Button'
import Modal from './ui/Modal'
import { api } from '../lib/api'
import { cx } from '../lib/cx'

// Plan 86 §Phase 3: the "Add plans" picker. Lists the RUNNER'S OWN project
// folder's plans (server-scoped: never another project's), shows filename,
// title/status and the relative path, and preserves the caller's selection
// ORDER in the submission — the queue's `next` is the FIRST `new` in array
// order, so the order a human picks is the order work will be offered.
//
// Excluded from the DEFAULT view (but reachable via the toggle): archived
// plans and completed (`done`) plans — the common add-a-plan flow queues
// fresh work, and pasting finished items back into a run is a deliberate,
// separate act. INDEX/README/QUEUE are already excluded by the server and are
// filtered again here defensively. Nothing here starts work.

const RESERVED = new Set(['index.md', 'readme.md', 'queue.md'])

function isEligible(p) {
  return !p.done && !RESERVED.has(String(p.path).toLowerCase())
}

export default function PlanPicker({ runner, project, existing, onClose, onAdd }) {
  const { location, patch } = useNavigation()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')
  const showAll = new URLSearchParams(location.search).get('planAll') === '1'
  const setShowAll = (next) => patch({ planAll: (typeof next === 'function' ? next(showAll) : next) ? '1' : null })
  const [selected, setSelected] = useDraftState(`queue-add:${runner.id}`, [])
  const [query, setQuery] = useQueryInput('planQ')
  useDirtyNavigation(selected.length > 0, popupIdentity, () => setSelected([]))

  useEffect(() => {
    let live = true
    api(`/api/mission/runners/${runner.id}/plans`)
      .then((data) => {
        if (!live) return
        const all = (data.plans || []).slice()
        const eligible = all.filter(isEligible)
        setRows({ all, eligible })
      })
      .catch((e) => {
        if (live) setError(e?.error || e?.message || 'Could not load the plans')
      })
    return () => {
      live = false
    }
  }, [runner.id])

  const visible = useMemo(() => {
    if (!rows) return []
    const src = showAll ? rows.all : rows.eligible
    const chain = query.trim().toLowerCase()
    return src
      .filter((p) => !chain || `${p.path} ${p.title || ''}`.toLowerCase().includes(chain))
  }, [rows, showAll, query])

  const existingSet = useMemo(() => new Set((existing || []).map((p) => String(p))), [existing])

  const chain = query.trim()
  const toggle = (p) => {
    setSelected((cur) =>
      cur.some((s) => s.path === p.path) ? cur.filter((s) => s.path !== p.path) : cur.concat(p)
    )
  }

  const add = () => {
    if (!selected.length) return
    onAdd(selected.filter((p) => !existingSet.has(p.path)))
  }

  return (
    <Modal
      title={`Add plans — ${project?.name || 'project'}`}
      width="max-w-lg"
      z="z-60"
      bodyScroll
      panelClassName="max-h-[85vh]"
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-faint">
            {selected.length} selected{existing.size ? ` · ${existing.size} already queued` : ''}
          </span>
          <Button variant="ghost" size="bare" onClick={onClose} className="px-2 py-1 text-xs">
            Cancel
          </Button>
          <Button variant="primary" size="bare" disabled={!selected.length} onClick={add} className="msn-btn-queue-add-confirm px-2.5 py-1 text-xs">
            Add to queue
          </Button>
        </>
      }
    >
      {error ? (
        <p className="text-[11px] text-danger">{error}</p>
      ) : !rows ? (
        <p className="text-[11px] text-ink-faint">Loading plans…</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter plans…"
              className="msn-queue-picker-filter placeholder:ink-dim w-full rounded bg-sunken px-2 py-1 text-[11px] text-ink outline-none focus:ring-1 focus:ring-accent"
            />
            <label className="flex shrink-0 items-center gap-1 text-[10px] text-ink-faint">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(!e.target.checked)} className="accent-accent" />
              <span>Completed/archived</span>
            </label>
          </div>
          <ul className="msn-queue-picker-list mt-2 max-h-72 space-y-px overflow-y-auto">
            {visible.length === 0 && (
              <li className="px-1 py-2 text-[11px] text-ink-faint">No plans to show.</li>
            )}
            {visible.map((p) => {
              const checked = selected.some((s) => s.path === p.path)
              const inQueue = existingSet.has(p.path)
              const disabled = inQueue
              return (
                <li key={p.path}>
                  <label
                    className={cx(
                      'msn-queue-picker-row flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-raised',
                      disabled && 'cursor-default opacity-50 hover:bg-transparent'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="msn-queue-picker-check accent-accent"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggle(p)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="msn-queue-picker-title block truncate text-[11px] text-ink">{p.title || p.path}</span>
                      <span className="msn-queue-picker-meta block truncate font-mono text-[9px] text-ink-faint">
                        {p.path}
                        {inQueue ? ' · already queued' : p.status ? ` · ${String(p.status).slice(0, 40)}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              )
            })}
          </ul>
          {chain.trim() && visible.length === 0 && existing.size ? (
            <p className="mt-1 text-[10px] text-ink-faint">All plans already in the queue.</p>
          ) : null}
        </>
      )}
    </Modal>
  )
}
