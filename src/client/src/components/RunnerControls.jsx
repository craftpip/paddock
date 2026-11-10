import { useEffect, useRef, useState } from 'react'
import Button from './ui/Button'
import { useMission } from '../stores/mission'

// Plan 85 §Phase 3 + plan 86 §Phase 3/4b: the queue controls for an infinite
// session live in THAT session's terminal header — [Run queue / Pause queue ▾]
// [Configure] — next to the queue state and the concise reason. Opening the
// conversation and running its queue are separate actions: this never opens
// anything, and reopening a paused conversation leaves its queue paused.
//
// Pause is a dropdown with exactly two explicit actions —
// "Pause before next task" (finish the current plan, then wait) and
// "Pause current task" (ask the worker to stop at the earliest safe
// checkpoint). Execution labels and action permission come from the server's
// canonical queue snapshot; no client flag reconstruction is allowed.
//
// The Run queue control is disabled until the queue is actually runnable
// (plan 86: a missing/empty/malformed queue can't run, and the panel explains
// why). The verdict comes from the queue the panel landed for THIS runner —
// never from `runners` metadata alone, which can be fresh while the queue is
// unusable. `queue` is the store's unwrapped queue object (see queueOf).
//
// Busy state is PER RUNNER, in this component: a background
// metadata fetch (`runnersLoading`) must not disable every control, and a
// failed Run must read next to the button that caused it, not in a column
// error bar about something else. Clicks stop propagation so they never
// trigger a row open through bubbling.
//
// Per plan 98: error display is centralized in the QueuePanel via
// `operationFeedback`. This component is action controls only.
export function requiresExplicitRecovery(runner, queue, queueForRunner) {
  return queueForRunner === runner?.id && queue?.execution?.state === 'running'
    && queue?.scheduler?.recoveryRequired === true
}

export function runnerIsRunning(runner, queue, queueForRunner) {
  return queueForRunner === runner?.id && queue?.execution?.canPause === true
}

export default function RunnerControls({ runner, onConfigure }) {
  const startRunner = useMission((s) => s.startRunner)
  const pauseRunner = useMission((s) => s.pauseRunner)
  const queue = useMission((s) => s.queue)
  const queueForRunner = useMission((s) => s.queueForRunner)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)

  // Close the Pause dropdown on an outside click or Escape. Kept off the button
  // so a click on a menu item (which stops propagation) is never mistaken for
  // an outside click.
  useEffect(() => {
    if (!menuOpen) return undefined
    const onDoc = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  const recoveryRequired = requiresExplicitRecovery(runner, queue, queueForRunner)
  useEffect(() => {
    if (recoveryRequired) setMenuOpen(false)
  }, [recoveryRequired])

  if (!runner) return null
  const landed = queue && queueForRunner === runner.id
  const execution = landed ? queue.execution : null
  const running = execution ? execution.canPause : runnerIsRunning(runner, queue, queueForRunner)
  const stateWord = execution?.label || 'Loading runner state'
  // Run needs a queue that parses AND has work: `ok` with zero items is an
  // empty queue (Run does nothing), `missing` needs setup, `unreadable` /
  // `malformed` need repair. Only judge the queue actually landed for this
  // runner; before it lands, keep Run clickable and let the server validate.
  const runDisabled =
    busy || (execution ? !execution.canRun : (landed && (queue.condition !== 'ok' || !(queue.items || []).length)))
  const runTitle = execution?.runReason || (landed && !runDisabled
    ? 'Run the queue on this session'
    : landed && queue.condition !== 'ok'
      ? `The queue ${queue.condition} — see the queue panel`
      : landed
        ? 'Add plans to the queue before running'
        : 'Run the queue on this session')

  const act = async (fn) => {
    if (busy) return
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const pauseWith = (mode) => {
    setMenuOpen(false)
    act(() => pauseRunner(runner.id, mode))
  }

  return (
    <span className="msn-runner-controls flex shrink-0 items-center gap-1.5">
      <span
        className="msn-runner-state shrink-0 rounded bg-accent/15 px-1 text-[9px] font-medium text-accent"
        title={execution?.reason || `Queue ${stateWord}`}
      >
        ∞ {stateWord}
      </span>
      {running ? (
        <span className="relative" ref={menuRef}>
          <Button
            variant="secondary"
            size="bare"
            disabled={busy}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((o) => !o)
            }}
            className="msn-btn-runner-toggle py-0.5 text-[10px]"
            title="Pause the queue — choose when it stops"
          >
            {busy ? '…' : 'Pause queue ▾'}
          </Button>
          {menuOpen && (
            <div
              role="menu"
              className="msn-runner-pause-menu absolute right-0 z-20 mt-1 min-w-44 rounded border border-line bg-panel py-1 text-left shadow-card"
            >
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={(e) => {
                  e.stopPropagation()
                  pauseWith('before_next_task')
                }}
                className="msn-runner-pause-before block w-full px-3 py-1.5 text-left text-[11px] text-ink hover:bg-raised"
              >
                Pause before next task
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation()
                  pauseWith('current_task')
                }}
                className="msn-runner-pause-current block w-full px-3 py-1.5 text-left text-[11px] text-ink hover:bg-raised"
              >
                Pause current task
              </button>
            </div>
          )}
        </span>
      ) : (
        <Button
          variant="secondary"
          size="bare"
          disabled={runDisabled}
          onClick={(e) => {
            e.stopPropagation()
            act(() => startRunner(runner.id))
          }}
          className="msn-btn-runner-toggle py-0.5 text-[10px]"
          title={runTitle}
        >
          {busy ? '…' : execution?.setupRequired ? 'Set up first' : 'Run queue'}
        </Button>
      )}
      <Button
        variant="none"
        size="bare"
        onClick={(e) => {
          e.stopPropagation()
          onConfigure?.()
        }}
        className="msn-btn-runner-config py-0.5 text-[10px] text-ink-faint hover:text-ink"
        title="Configure this infinite runner"
      >
        Configure
      </Button>
    </span>
  )
}

function pauseWith(mode) {
  act(() => pauseRunner(runner.id, mode))
}
