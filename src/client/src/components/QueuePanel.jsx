import { useState, useEffect } from 'react'
import { useNavigation, useDraftState, useDirtyNavigation, popupIdentity } from '../lib/navigation'
import { parsePopups } from '../lib/url-state'
import Button from './ui/Button'
import { Input } from './ui/Input'
import Modal from './ui/Modal'
import PlanPicker from './PlanPicker'
import RunnerSchedulerStatus from './RunnerSchedulerStatus'
import RunnerHistory from './RunnerHistory'
import { api } from '../lib/api'
import { cx } from '../lib/cx'
import { useMission } from '../stores/mission'
import { useConfirm } from '../lib/confirm'

// Plan 86 §Phase 3: the visible queue panel for an infinite session, mounted
// in column 3 directly under the terminal header, above the terminal. It is a
// READ + guidance surface: it never opens anything, and opening a session
// never enables automatic work. Run/Pause live in RunnerControls; what lives
// here is the state map (current/next/counts/blocked/completed), the Add/SETUP
// actions, the Resolve-blocker flow, and the errors that say WHICH queue
// condition the Run control is disabled for.
//
// Every hook carries a stable msn-queue-* class (plan §3) so the states are
// testable and the labels never re-guessed.
//
// All runner state/actions come from the canonical execution snapshot. Queue item
// progress and worker observation are displayed separately from authorization.

const ITEM_WORD = {
  new: 'Queued',
  'in progress': 'Working',
  'need input': 'Needs input',
  done: 'Done',
}
const ITEM_TONE = {
  new: 'bg-accent-soft text-accent-text',
  'in progress': 'bg-warning-soft text-warning',
  'need input': 'bg-danger-soft text-danger',
  done: 'bg-success-soft text-success',
}

function normItem(it) {
  // Rewriting the queue writes the STRICT persisted fields only — the
  // enriched title/planStatus/statusRaw/exists are read-side decorations and
  // are not part of the file's item schema (plans.js validateQueueItems).
  return { id: it.id, plan: it.plan, status: it.status, reason: it.reason || '' }
}

function titleOf(items, id) {
  const it = items.find((x) => x.id === id)
  return it ? it.title || it.plan : null
}

function ItemRow({ item, current, index, total, busy, locked, canReviewStatus, onMove, onRemove, onEditStatus }) {
  const tone = ITEM_TONE[item.status] || 'bg-raised text-ink-faint'
  return (
    <li
      className={cx(
        'msn-queue-item flex items-center gap-2 px-3 py-1 text-[11px]',
        current && 'bg-warning/10'
      )}
    >
      <button type="button" disabled={!canReviewStatus || busy} onClick={() => onEditStatus(item)}
        title={canReviewStatus ? `Review status for ${item.title || item.plan}` : 'Pause the runner before reviewing queue statuses'}
        className={cx('msn-queue-item-status w-[4.5rem] shrink-0 rounded px-1 py-0.5 text-center text-[9px] font-medium disabled:cursor-not-allowed', tone)}>
        {ITEM_WORD[item.status] || item.status}
      </button>
      <span className="msn-queue-item-title min-w-0 flex-1 truncate" title={item.plan}>
        {item.title || item.plan}
      </span>
      <span className="msn-queue-item-path hidden shrink-0 font-mono text-[9px] text-ink-faint lg:inline" title={item.plan}>
        {item.plan}
      </span>
      <span className="msn-queue-item-actions flex shrink-0 items-center gap-0.5">
        <Button variant="ghost" size="bare" disabled={busy || locked || index === 0} onClick={() => onMove(index, -1)} className="msn-btn-queue-up px-1 py-0.5 text-[9px]" title={`Move ${item.title || item.plan} up`}>
          Up
        </Button>
        <Button variant="ghost" size="bare" disabled={busy || locked || index === total - 1} onClick={() => onMove(index, 1)} className="msn-btn-queue-down px-1 py-0.5 text-[9px]" title={`Move ${item.title || item.plan} down`}>
          Down
        </Button>
        <Button variant="dangerLink" size="bare" disabled={busy || locked || item.status === 'in progress'} onClick={() => onRemove(item)} className="msn-btn-queue-remove px-1 py-0.5 text-[9px]" title={item.status === 'in progress' ? `Cannot remove ${item.title || item.plan} while it is working` : `Remove ${item.title || item.plan} from the queue`}>
          Remove
        </Button>
      </span>
    </li>
  )
}

export default function QueuePanel({ runner, project, sessionId, expanded = false, onCollapsedChange }) {
  const { location, patch, openPopup, closePopup, drafts } = useNavigation()
  const popup = parsePopups(location.search, location.pathname).at(-1)
  const historyRequested = new URLSearchParams(location.search).get('runnerTab') === 'history'
  const queue = useMission((s) => s.queue)
  const queueForRunner = useMission((s) => s.queueForRunner)
  const queueLoading = useMission((s) => s.queueLoading)
  const queueError = useMission((s) => s.queueError)
  const queueStale = useMission((s) => s.queueStale)
  const queueAction = useMission((s) => s.queueAction)
  const setupRunnerQueue = useMission((s) => s.setupRunnerQueue)
  const addRunnerQueueItems = useMission((s) => s.addRunnerQueueItems)
  const reorderRunnerQueue = useMission((s) => s.reorderRunnerQueue)
  const removeRunnerQueueItem = useMission((s) => s.removeRunnerQueueItem)
  const resolveRunnerQueue = useMission((s) => s.resolveRunnerQueue)
  const reloadRunnerQueue = useMission((s) => s.reloadRunnerQueue)
  const reconcileRunnerOperation = useMission((s) => s.reconcileRunnerOperation)
  const confirm = useConfirm()
  const sessions = useMission((s) => s.sessions)
  // Centralized operation feedback (plan 98 §Phase 1)
  const operationFeedback = useMission((s) => s.operationFeedback?.[runner?.id])

  // A malformed queue is recoverable user data. Never let a persisted collapsed
  // view hide the only evidence needed to repair it.
  const repairRequired = queueForRunner === runner?.id && (
    (queue?.condition && queue.condition !== 'ok') || ['projection_error', 'awaiting_receipt', 'held'].includes(queue?.execution?.state)
  )
  const historyOpen = historyRequested && !repairRequired
  const panelExpanded = expanded || repairRequired
  const collapsed = !panelExpanded
  const setCollapsed = (next) => {
    const value = typeof next === 'function' ? next(collapsed) : next
    if (repairRequired && value) return
    if (onCollapsedChange) onCollapsedChange(value)
    else patch({ queue: value ? 'closed' : 'open' })
  }
  const pickerOpen = popup?.type === 'queue-add' && popup.args[0] === runner?.id
  const setPickerOpen = (on) => on ? openPopup('queue-add', runner.id) : closePopup()
  const resolve = popup?.type === 'queue-resolve' && popup.args[0] === runner?.id
    ? (queue?.items || []).find((it) => it.id === popup.args[1] && it.status === 'need input') || null : null
  const setResolve = (item) => item ? openPopup('queue-resolve', runner.id, item.id) : closePopup()
  useEffect(() => {
    if (popup?.type !== 'queue-resolve' || popup.args[0] !== runner?.id || !queue || queueForRunner !== runner?.id || queueStale || queueError || queue.condition !== 'ok') return
    if (!(queue.items || []).some((it) => it.id === popup.args[1] && it.status === 'need input')) {
      // Feedback is handled by centralized operationFeedback
      closePopup({ saved: true, expected: popup.value })
    }
  }, [popup?.value, runner?.id, queue, queueForRunner, queueStale, queueError])

  if (!runner) return null

  const id = runner.id
  const landed = queue && queueForRunner === id
  const condition = landed ? queue.condition : null
  const items = landed ? queue.items || [] : []
  const summary = landed ? queue.summary : null
  const state = landed ? queue.state : null
  const scheduler = landed ? queue.scheduler : null
  const execution = landed ? queue.execution : null
  const counts = summary?.counts || null
  const current = summary?.current || null
  const next = summary?.next || null
  const blocked = summary?.blocked || null
  // The server owns this verdict; the client never reconstructs runner state.
  const running = execution?.active === true
  const busy = !!queueAction
  const doneCount = counts?.done || 0
  // Stable draft key: item id from popup args when open, else from blocked summary.
  // This must follow `summary`'s declaration: reading it earlier throws during render.
  const resolveItemId = popup?.type === 'queue-resolve' ? popup.args[1] : (summary?.blocked?.id || '')
  const [resolveText, setResolveText] = useDraftState(`queue-resolve:${runner?.id}:${resolveItemId}`, '')
  const [statusItem, setStatusItem] = useState(null)
  const [statusValue, setStatusValue] = useState('')
  const [statusReason, setStatusReason] = useState('')
  const updateRunnerQueueItem = useMission((s) => s.updateRunnerQueueItem)
  const draftIdentity = location.pathname + ':' + (new URLSearchParams(location.search).get('session') || '')
  useDirtyNavigation(!!resolveText && (!!resolve || !!blocked), () => draftIdentity, () => setResolveText(''))

  const doSetup = async () => {
    try {
      const replacingExistingProjection = ['setup_required', 'projection_error'].includes(condition)
      if (replacingExistingProjection) {
        const ok = await confirm({
          title: 'Regenerate worker queue file?',
          message: 'This replaces QUEUE.md with the server-owned queue shown here. No item statuses will be imported from that file, and the runner will remain paused until you press Run. Review any differences before continuing.',
          danger: condition === 'projection_error',
          confirmText: 'Regenerate',
          cancelText: 'Keep current file',
        })
        if (!ok) return
      }
      await setupRunnerQueue(id, { confirmProjectionReset: replacingExistingProjection })
    } catch (e) {
      // Feedback is set by the store action
    }
  }

  const editItemStatus = (item) => {
    setStatusItem(item)
    setStatusValue(item.status.replaceAll(' ', '_'))
    setStatusReason(item.reason || '')
  }

  const saveItemStatus = async () => {
    if (!statusItem || !queue || (statusValue === 'need_input' && !statusReason.trim())) return
    try {
      await updateRunnerQueueItem(id, statusItem.id, {
        status: statusValue,
        reason: statusReason,
      }, queue.revision)
      setStatusItem(null)
    } catch {
      // Keep the review modal and the person's correction draft open on conflict.
    }
  }

  const doAdd = (chosen) => {
    const existing = new Set(items.map((it) => it.plan))
    const fresh = chosen.filter((c) => !existing.has(c.path)).map((c) => c.path)
    addRunnerQueueItems(id, fresh, queue.revision).then(
      () => { drafts.delete(`queue-add:${id}`); closePopup({ saved: true, expected: popup?.value }) },
      // Feedback is set by the store action
    )
  }

  const moveItem = (index, delta) => {
    const target = index + delta
    if (busy || target < 0 || target >= items.length) return
    const reordered = items.map((item) => item.id)
    ;[reordered[index], reordered[target]] = [reordered[target], reordered[index]]
    reorderRunnerQueue(id, reordered, queue.revision).catch(() => {})
  }

  const removeItem = async (item) => {
    if (busy) return
    if (item.status === 'in progress') {
      useMission.getState().setOperationFeedback(id, { severity: 'warning', message: 'Working tasks cannot be removed. Resolve the active execution first.' })
      return
    }
    const ok = await confirm({
      title: `Remove ${item.title || item.plan}?`,
      message: 'This removes it from the queue only. Its plan file stays in place.',
      danger: true,
      confirmText: 'Remove',
      cancelText: 'Keep',
    })
    if (!ok) return
    removeRunnerQueueItem(id, item.id, queue.revision).catch(() => {})
  }

  // The resolution is delivered through the new atomic resolve endpoint
  // which atomically: delivers answer, requeues item, lifts marker, enables supervision.
  const doResolve = async () => {
    if (!resolve || !resolveText.trim()) return
    try {
      await resolveRunnerQueue(id, { itemId: resolve.id, answer: resolveText.trim(), revision: queue.revision })
      closePopup({ saved: true, expected: popup?.value })
      setResolveText('')
    } catch {
      // Feedback is set by the store action
    }
  }

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(queue.workerPath || queue.path || '')
    } catch {
      /* clipboard unavailable (headless / permissions): the path stays visible text */
    }
  }

  const headerWord = execution?.label || 'Loading runner state'

  return (
    <section className={cx('msn-queue-panel border-b border-line-faint bg-panel/50', historyOpen && 'msn-history-overlay', panelExpanded ? 'flex min-h-0 flex-1 flex-col' : 'shrink-0')}>
      {/* Header row: state + counts + collapse. Always visible, even collapsed. */}
      <div className="msn-queue-header flex items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={repairRequired ? 'Runner recovery details stay visible until repaired' : undefined}
          className="msn-queue-toggle flex min-w-0 items-center gap-1.5 text-[10px] font-medium text-ink-dim hover:text-ink"
        >
          <span className="text-ink-faint">{collapsed ? '▸' : '▾'}</span>
          <span className="msn-queue-title">Infinite queue</span>
          <span className={cx('msn-queue-state rounded px-1 py-0.5 text-[9px] font-medium', running ? 'bg-accent/15 text-accent' : 'bg-raised text-ink-muted')}>
            {headerWord}
          </span>
          {counts && items.length > 0 && (
            <span className="msn-queue-counts text-ink-faint">
              {counts.done}/{counts.total} done
            </span>
          )}
        </button>
        <span className="msn-queue-actions ml-auto flex shrink-0 items-center gap-1">
          {landed && condition === 'ok' && (
            <Button
              variant="secondary"
              size="bare"
              disabled={busy}
              onClick={(e) => {
                e.stopPropagation()
                setPickerOpen(true)
              }}
              className="msn-btn-queue-add py-0.5 text-[10px]"
              title="Add plans from this project's plans directory to the queue"
            >
              Add plans
            </Button>
          )}
          {execution?.setupRequired && (
            <Button variant="primary" size="bare" disabled={busy} onClick={doSetup}
              className="msn-btn-runner-runtime-setup py-0.5 text-[10px]" title="Explicitly initialize this runner's canonical execution state">
              {queueAction === 'setup' ? 'Setting up…' : 'Set up runner'}
            </Button>
          )}
          {(queueStale || queueError) && (
            <Button
              variant="secondary"
              size="bare"
              onClick={reloadRunnerQueue}
              className="msn-btn-queue-reload py-0.5 text-[10px]"
              title="Reload the queue from the file"
            >
              Reload queue
            </Button>
          )}
        </span>
      </div>

      <div className="msn-runner-status-strip shrink-0 border-t border-line-faint px-3 py-1.5" aria-live="polite">
        <RunnerSchedulerStatus execution={execution} scheduler={landed ? queue.scheduler : null} />
        {current && <p className="truncate text-[10px] text-ink-dim" title={current.plan}>Current: {titleOf(items, current.id) || current.plan}</p>}
      </div>
      <div className="msn-runner-tabs flex shrink-0 gap-1 px-1 pb-1" role="tablist" aria-label="Infinite runner views" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'))
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (tabs.indexOf(event.target) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
        tabs[next].focus(); tabs[next].click()
      }}>
        <Button id="msn-queue-tab" role="tab" tabIndex={!historyOpen ? 0 : -1} aria-selected={!historyOpen} aria-controls="msn-runner-queue" variant={!historyOpen ? 'primary' : 'ghost'} size="bare" className="msn-runner-tab min-w-0 flex-1 px-1 py-1 text-[10px]" onClick={() => patch({ runnerTab: null, queue: 'open' })}>Queue</Button>
        <Button id="msn-history-tab" role="tab" tabIndex={historyOpen ? 0 : -1} aria-selected={historyOpen} aria-controls="msn-runner-history" variant={historyOpen ? 'primary' : 'ghost'} size="bare" className="msn-runner-tab min-w-0 flex-1 px-1 py-1 text-[10px]" onClick={() => patch({ runnerTab: 'history', queue: 'open' })}>History</Button>
      </div>
      {(!collapsed || historyOpen) && <RunnerHistory key={runner.id} runnerId={runner.id} active={historyOpen} expanded={expanded} />}

      {collapsed || historyOpen ? null : (
        <div id="msn-runner-queue" role="tabpanel" aria-labelledby="msn-queue-tab" className={cx('msn-queue-body border-t border-line/50 px-3 pb-2 pt-1.5', panelExpanded && 'flex min-h-0 flex-1 flex-col')}>
          {/* Centralized operation feedback (plan 98 §Phase 1) */}
          {operationFeedback && (
            <div className={cx('msn-queue-feedback mt-1.5 p-2 rounded-control text-[10px] flex gap-2',
              operationFeedback.severity === 'error' ? 'bg-danger/10 text-danger' :
              operationFeedback.severity === 'warning' ? 'bg-warning/10 text-warning' :
              'bg-accent/10 text-accent')}>
              <span className="flex-1 whitespace-pre-wrap break-words">{operationFeedback.message}</span>
              <Button
                variant="ghost"
                size="bare"
                onClick={() => { useMission.getState().clearOperationFeedback(runner.id) }}
                className="msn-queue-feedback-dismiss text-[9px] shrink-0"
              >
                Dismiss
              </Button>
            </div>
          )}
          {/* Queue warnings (e.g. multiple in-progress items) */}
          {summary?.warnings?.length > 0 && (
            <div className="msn-queue-warning mt-1.5 p-2 rounded-control text-[10px] bg-warning/10 text-warning flex gap-2" data-testid="queue-warning">
              {summary.warnings.map((w, i) => (
                <span key={i} className="flex-1 whitespace-pre-wrap break-words">
                  {w.message}
                </span>
              ))}
            </div>
          )}
          {/* Canonical execution state and server-provided reason */}
          {execution?.state === 'paused' && (
            <>
              <p className={cx('msn-queue-paused mt-1.5 text-[10px]', (sessions.find((s) => s.id === sessionId)?.busy ? 'text-warning' : 'text-ink-dim'))}>
                {sessions.find((s) => s.id === sessionId)?.busy
                  ? 'Queue paused — current task is finishing; no next task will start.'
                  : execution.reason || 'Queue paused.'}
              </p>
            </>
          )}
          {execution?.canReconcile && (
            <div className="msn-queue-reconcile mt-1.5 flex items-center gap-2">
              <p className="msn-queue-reconcile-text text-[10px] text-ink-dim">Instruction delivery is awaiting its exact receipt. No resend will be made.</p>
              <Button variant="secondary" size="bare" disabled={busy} onClick={() => reconcileRunnerOperation(id)} className="msn-btn-queue-reconcile px-2 py-1 text-xs">Reconcile</Button>
            </div>
          )}
          {execution?.state === 'projection_error' && (
            <div className="msn-queue-projection-error py-1">
              <p className="msn-queue-invalid-reason text-[11px] text-danger">{queue.error || execution.reason || 'The projection must be reconciled with canonical queue state.'}</p>
              <p className="msn-queue-invalid-next text-[10px] text-ink-faint">
                The server queue is preserved below. Regeneration restores the worker file and leaves the queue paused until you press Run.
              </p>
              <Button variant="primary" size="bare" disabled={busy} onClick={doSetup} className="msn-btn-queue-regenerate mt-1.5 px-2.5 py-1 text-xs">
                {queueAction === 'setup' ? 'Regenerating…' : 'Regenerate projection'}
              </Button>
            </div>
          )}
          {queueLoading && !landed ? (
            <p className="msn-queue-loading py-1 text-[11px] text-ink-faint">Loading queue…</p>
          ) : !landed && queueError ? (
            <p className="msn-queue-read-error py-1 text-[11px] text-danger">{queueError}</p>
          ) : !landed ? null : condition === 'missing' ? (
            <div className="msn-queue-empty py-1">
              <p className="msn-queue-setup-text text-[11px] text-ink-dim">
                No queue yet. Add plans then Run — opening this session does not run them.
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <Button
                  variant="primary"
                  size="bare"
                  disabled={busy}
                  onClick={doSetup}
                  className="msn-btn-queue-setup px-2.5 py-1 text-xs"
                >
                  {queueAction === 'setup' ? 'Setting up…' : 'Set up queue'}
                </Button>
              </div>
            </div>
          ) : condition === 'unreadable' || condition === 'malformed' ? (
            <div className="msn-queue-invalid py-1">
              <p className="msn-queue-invalid-reason text-[11px] text-danger">
                {queue.error || `Queue is ${condition}.`}
              </p>
              <p className="msn-queue-invalid-next text-[10px] text-ink-faint">
                Open {queue.path} to repair it, then Reload queue. It will never be overwritten automatically.
              </p>
              {queue.repairItems?.length > 0 && (
                <ul className="msn-queue-repair-items mt-2 space-y-px rounded border border-danger/30 bg-danger-soft/30 p-1" aria-label="Queue items available for repair">
                  {queue.repairItems.map((item) => {
                    const duplicate = item.id && queue.repairDuplicateIds?.includes(item.id)
                    return (
                      <li key={`${item.index}:${item.id || 'missing'}`} className="msn-queue-repair-item flex min-w-0 items-center gap-2 px-1.5 py-1 text-[10px] text-ink-dim">
                        <span className="shrink-0 font-mono text-ink-faint">#{item.index + 1}</span>
                        <span className="min-w-0 flex-1 truncate" title={item.plan || ''}>{item.plan || '(missing plan path)'}</span>
                        <span className="shrink-0 font-mono text-[9px] text-ink-faint" title={item.id || ''}>{item.id || '(missing id)'}</span>
                        {duplicate && <span className="msn-queue-repair-duplicate shrink-0 rounded bg-danger/15 px-1 py-0.5 text-[8px] font-medium text-danger">Duplicate ID</span>}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : condition === 'ok' && !items.length ? (
            <div className="msn-queue-empty py-1">
              <p className="msn-queue-empty-text text-[11px] text-ink-dim">
                No plans queued. Add plans, then Run queue.
              </p>
            </div>
          ) : ['ok', 'projection_error', 'setup_required'].includes(condition) ? (
            <>
              {/* Always-visible summary (plan §Running,3): current/next/completed
                  verified against the queue's own summary, not re-derived. */}
              <dl className="msn-queue-summary grid grid-cols-[8.5rem_1fr] gap-x-2 gap-y-0.5 text-[11px]">
                <dt className="text-ink-faint">Current</dt>
                <dd className="msn-queue-current min-w-0 truncate text-ink" title={current?.plan}>
                  {current
                    ? titleOf(items, current.id) || current.plan
                    : next
                      ? `Waiting to start ${titleOf(items, next.id) || next.plan}`
                      : '—'}
                </dd>
                <dt className="text-ink-faint">Next</dt>
                <dd className={cx('msn-queue-next min-w-0 truncate', blocked ? 'text-danger' : 'text-ink-dim')} title={next?.plan}>
                  {blocked
                    ? `Next (blocked) — ${titleOf(items, blocked.id) || blocked.plan}`
                    : next
                      ? titleOf(items, next.id) || next.plan
                      : '—'}
                </dd>
                <dt className="text-ink-faint">Completed</dt>
                <dd className="msn-queue-counts-line text-ink-dim">
                  {doneCount} / {counts.total} plans done
                  {counts.new ? ` · ${counts.new} queued` : ''}
                  {counts.needInput ? ` · ${counts.needInput} needs input` : ''}
                </dd>
              </dl>

              {/* Blocked plan + exact question. A blocker takes precedence over
                  Current/Next both above and in what Run/RunnerControls allow. */}
              {blocked && (
                <div className="msn-queue-blocker mt-1.5 rounded border border-danger/30 bg-danger-soft/40 px-2 py-1.5 text-[11px]">
                  <p className="msn-queue-blocker-plan font-medium text-danger">
                    Blocked on {titleOf(items, blocked.id) || blocked.plan}
                  </p>
                  <p className="msn-queue-blocker-reason mt-0.5 whitespace-pre-wrap break-words text-ink-dim">
                    {blocked.reason}
                  </p>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Input
                      size="sm"
                      value={resolveText}
                      onChange={(e) => setResolveText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent?.isComposing && resolveText.trim() && !busy) {
                          e.preventDefault()
                          setResolve(blocked)
                        }
                      }}
                      placeholder="Your answer for the agent…"
                      className="msn-queue-resolve-input"
                    />
                    <Button
                      variant="primary"
                      size="bare"
                      disabled={busy || !resolveText.trim()}
                      onClick={() => setResolve(blocked)}
                      className="msn-btn-queue-resolve-open px-2 py-1 text-[10px]"
                    >
                      Resolve blocker
                    </Button>
                  </div>
                </div>
              )}

              {/* Ordered item list; completed items stay visible (archive has no
                  hide-by-default in the panel — the counts already summarize). */}
              {items.length > 0 && (
                <ul className={cx('msn-queue-items mt-1.5 space-y-px overflow-y-auto', panelExpanded && 'min-h-0 flex-1')}>
                  {items.map((it, index) => (
                    <ItemRow key={it.id} item={it} current={current?.id === it.id} index={index} total={items.length} busy={busy} locked={condition !== 'ok'} canReviewStatus={execution?.canReviewStatuses === true} onEditStatus={editItemStatus} onMove={moveItem} onRemove={removeItem} />
                  ))}
                </ul>
              )}

              {/* Worker-visible location, readable and copyable */}
              <p className="msn-queue-path mt-1.5 flex items-center gap-1.5 font-mono text-[9px] text-ink-faint">
                <span className="truncate" title={queue.workerPath || queue.path}>
                  {queue.workerPath || queue.path}
                </span>
                <button
                  type="button"
                  onClick={copyPath}
                  className="msn-queue-path-copy shrink-0 text-ink-faint hover:text-ink"
                  title="Copy the queue location the agent reads"
                >
                  copy
                </button>
              </p>
            </>
          ) : null}

          {(queueError && !operationFeedback) && (
            <p className="msn-queue-error mt-1.5 text-[10px] text-danger">{queueError}</p>
          )}
        </div>
      )}

      {pickerOpen && (
        <PlanPicker runner={runner} project={project} existing={items.map((it) => it.plan)} onClose={() => setPickerOpen(false)} onAdd={doAdd} />
      )}
      {resolve && (
        <Modal
          title="Resolve blocker"
          z="z-80"
          width="max-w-md"
          onClose={() => setResolve(null)}
          footer={
            <>
              <Button variant="ghost" size="bare" onClick={() => setResolve(null)} className="px-2 py-1 text-xs">
                Cancel
              </Button>
              <Button variant="primary" size="bare" disabled={busy || !resolveText.trim()} onClick={doResolve} className="msn-btn-queue-resolve px-2.5 py-1 text-xs">
                {queueAction === 'update' || queueAction === 'resolve' ? 'Resolving…' : 'Send & resume'}
              </Button>
            </>
          }
        >
          <p className="text-xs text-ink-dim">
            Send this answer to the agent, then requeue{' '}
            <span className="font-medium text-ink">{titleOf(items, resolve.id) || resolve.plan}</span> to continue.
          </p>
          <Input
            value={resolveText}
            onChange={(e) => setResolveText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent?.isComposing && resolveText.trim() && !busy) {
                e.preventDefault()
                doResolve()
              }
            }}
            placeholder="Your answer…"
            className="msn-queue-resolve-text mt-2"
            autoFocus
          />
        </Modal>
      )}
      {statusItem && (
        <Modal
          title="Review queue item status"
          z="z-80"
          width="max-w-md"
          onClose={() => setStatusItem(null)}
          footer={(
            <>
              <Button variant="ghost" size="bare" onClick={() => setStatusItem(null)} className="px-2 py-1 text-xs">Cancel</Button>
              <Button variant="primary" size="bare" disabled={busy || (statusValue === 'need_input' && !statusReason.trim())} onClick={saveItemStatus} className="msn-btn-queue-status-save px-2.5 py-1 text-xs">
                {queueAction === 'status' ? 'Saving…' : 'Save reviewed status'}
              </Button>
            </>
          )}
        >
          <p className="text-xs text-ink-dim">This is a human correction to the server queue; saving also regenerates QUEUE.md from the reviewed server state. No file status is imported. Mark Done only when the plan's work and verification are actually complete.</p>
          <p className="mt-2 truncate font-mono text-[11px] text-ink" title={statusItem.plan}>{statusItem.plan}</p>
          <label className="mt-3 block text-xs text-ink-dim">Status
            <select value={statusValue} onChange={(event) => setStatusValue(event.target.value)} className="msn-queue-status-select mt-1 block w-full rounded border border-line bg-panel px-2 py-1 text-ink">
              <option value="new">Queued</option>
              <option value="in_progress">Working</option>
              <option value="need_input">Needs input</option>
              <option value="done">Done</option>
            </select>
          </label>
          <label className="mt-3 block text-xs text-ink-dim">Reason or review note{statusValue === 'need_input' ? ' (required)' : ''}
            <Input value={statusReason} onChange={(event) => setStatusReason(event.target.value)} className="msn-queue-status-reason mt-1" placeholder="Optional note; explain the blocker if Needs input" />
          </label>
        </Modal>
      )}
    </section>
  )
}
