import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { cx } from '../lib/cx'
import { useMission } from '../stores/mission'
import { useAgents } from '../stores/agents'
import Button from './ui/Button'
import Choice from './ui/Choice'
import { Input } from './ui/Input'
import Switch from './ui/Switch'
import { TONES } from './ui/tone'

function useCodingAgents() {
  const agents = useAgents((s) => s.agents)
  return useMemo(
    () => agents.filter((a) => a.mission?.supported || ['opencode', 'codex', 'claude'].includes(a.agent_type)),
    [agents]
  )
}

const CONTROL_STATES = ['enabled', 'paused', 'waiting', 'need_input', 'finished']
const HEALTH_STATES = ['working', 'waiting_for_tool', 'compacting', 'recovering', 'suspected_stuck', 'usage_exhausted', 'auth_expired', 'rate_limited', 'observation_unavailable', 'invalid_queue']

export default function RunnerDialog({ runner, project, onClose }) {
  const editing = !!runner
  const allAgents = useCodingAgents()
  const { createRunner, updateRunner, startRunner, pauseRunner, resumeRunner, removeRunner, fetchRunners } = useMission()

  const [name, setName] = useState(runner?.name || '')
  const [sessionId, setSessionId] = useState(runner?.session_id || '')
  const [queueFile, setQueueFile] = useState(runner?.queue_file || 'QUEUE.md')
  const [idleGraceMs, setIdleGraceMs] = useState(runner?.idle_grace_ms || 120000)
  const [minNudgeIntervalMs, setMinNudgeIntervalMs] = useState(runner?.min_nudge_interval_ms || 120000)
  const [noProgressBudget, setNoProgressBudget] = useState(runner?.no_progress_budget || 3)
  const [compactionGraceMs, setCompactionGraceMs] = useState(runner?.compaction_grace_ms || 300000)
  const [longCommandThresholdMs, setLongCommandThresholdMs] = useState(runner?.long_command_threshold_ms || 1800000)
  const [recoverExited, setRecoverExited] = useState(runner?.recover_exited ?? true)
  const [recoveryBudget, setRecoveryBudget] = useState(runner?.recovery_budget || 3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionBusy, setActionBusy] = useState(null)
  const [actionError, setActionError] = useState('')

  const canSave = name.trim() && !busy

  const submit = async (e) => {
    e.preventDefault()
    if (!canSave) return
    setBusy(true)
    setError('')
    try {
      const payload = {
        name: name.trim(),
        sessionId: sessionId || undefined,
        queueFile: queueFile.trim(),
        idleGraceMs: Number(idleGraceMs),
        minNudgeIntervalMs: Number(minNudgeIntervalMs),
        noProgressBudget: Number(noProgressBudget),
        compactionGraceMs: Number(compactionGraceMs),
        longCommandThresholdMs: Number(longCommandThresholdMs),
        recoverExited,
        recoveryBudget: Number(recoveryBudget),
      }
      if (editing) await updateRunner(runner.id, payload)
      else await createRunner(payload)
      onClose()
    } catch (err) {
      setError(err?.error || err?.message || 'Could not save the runner')
    } finally {
      setBusy(false)
    }
  }

  const handleAction = async (action, runnerId) => {
    setActionBusy(runnerId)
    setActionError('')
    try {
      if (action === 'start') await startRunner(runnerId)
      else if (action === 'pause') await pauseRunner(runnerId)
      else if (action === 'resume') await resumeRunner(runnerId)
      else if (action === 'remove') await removeRunner(runnerId)
      await fetchRunners()
    } catch (err) {
      setActionError(err?.error || err?.message || `Could not ${action} runner`)
    } finally {
      setActionBusy(null)
    }
  }

  const isPaused = runner?.control_state === 'paused'
  const isEnabled = runner?.control_state === 'enabled'
  const isWaiting = runner?.control_state === 'waiting'
  const isNeedInput = runner?.control_state === 'need_input'
  const isFinished = runner?.control_state === 'finished'
  const canStart = editing && (isPaused || isWaiting || isNeedInput)
  const canResume = editing && isPaused
  const canPause = editing && isEnabled
  const canRemove = editing

  return (
    <div
      className="msn-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
      onMouseDown={onClose}
    >
      <div
        className="msn-dialog w-full max-w-xl rounded-card border border-line bg-panel shadow-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="msn-dialog-header flex items-center justify-between border-b border-line-faint px-4 py-3">
          <h2 className="msn-dialog-title text-sm font-semibold text-ink">{editing ? `Runner: ${runner.name}` : 'New infinite runner'}</h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            icon
            onClick={onClose}
            aria-label="Close"
            className="msn-btn-close-dialog text-lg leading-none"
          >
            ×
          </Button>
        </header>

        <form onSubmit={submit} className="msn-dialog-form flex flex-col gap-3 p-4">
          <label className="msn-field msn-field-name flex flex-col gap-1">
            <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My runner"
              autoFocus={!editing}
              className="msn-input-name"
            />
          </label>

          <label className="msn-field msn-field-queue flex flex-col gap-1">
            <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Queue file</span>
            <Input
              mono
              size="sm"
              value={queueFile}
              onChange={(e) => setQueueFile(e.target.value)}
              placeholder="QUEUE.md"
              spellCheck={false}
              className="msn-input-queue"
            />
            <span className="msn-field-note text-[11px] text-ink-dim">
              Relative to the project's plans folder. Default: QUEUE.md
            </span>
          </label>

          <div className="msn-field msn-field-timing flex flex-col gap-1">
            <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Timing</span>
            <div className="grid grid-cols-2 gap-2">
              <label className="msn-field msn-field-idle flex flex-col gap-1">
                <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Idle grace (ms)</span>
                <Input
                  type="number"
                  min="1000"
                  value={idleGraceMs}
                  onChange={(e) => setIdleGraceMs(e.target.value)}
                  className="msn-input-idle"
                />
              </label>
              <label className="msn-field msn-field-nudge flex flex-col gap-1">
                <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Min nudge interval (ms)</span>
                <Input
                  type="number"
                  min="1000"
                  value={minNudgeIntervalMs}
                  onChange={(e) => setMinNudgeIntervalMs(e.target.value)}
                  className="msn-input-nudge"
                />
              </label>
              <label className="msn-field msn-field-budget flex flex-col gap-1">
                <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Nudge budget</span>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={noProgressBudget}
                  onChange={(e) => setNoProgressBudget(e.target.value)}
                  className="msn-input-budget"
                />
              </label>
              <label className="msn-field msn-field-compaction flex flex-col gap-1">
                <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Compaction grace (ms)</span>
                <Input
                  type="number"
                  min="1000"
                  value={compactionGraceMs}
                  onChange={(e) => setCompactionGraceMs(e.target.value)}
                  className="msn-input-compaction"
                />
              </label>
              <label className="msn-field msn-field-long flex flex-col gap-1">
                <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Long command threshold (ms)</span>
                <Input
                  type="number"
                  min="60000"
                  value={longCommandThresholdMs}
                  onChange={(e) => setLongCommandThresholdMs(e.target.value)}
                  className="msn-input-long"
                />
              </label>
              <label className="msn-field msn-field-recovery flex flex-col gap-1">
                <span className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Recovery budget</span>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={recoveryBudget}
                  onChange={(e) => setRecoveryBudget(e.target.value)}
                  className="msn-input-recovery"
                />
              </label>
            </div>
          </div>

          <div className="msn-field msn-field-recovery flex items-center gap-2">
            <Switch
              checked={recoverExited}
              onChange={setRecoverExited}
              id="msn-recover-exited"
            />
            <label htmlFor="msn-recover-exited" className="msn-field-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
              Recover exited worker
            </label>
          </div>

          {editing && (
            <div className="msn-runner-actions border-t border-line-faint pt-2 mt-2">
              <span className="msn-runner-state-label text-[11px] font-semibold uppercase tracking-wider text-ink-muted mb-2">Control</span>
              <div className="flex flex-wrap gap-2">
                {canStart && (
                  <Button
                    type="button"
                    variant={isEnabled ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => handleAction('start', runner.id)}
                    loading={actionBusy === runner.id}
                    className="msn-btn-runner-start"
                  >
                    {isEnabled ? 'Running…' : isPaused ? 'Start' : 'Resume'}
                  </Button>
                )}
                {canPause && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => handleAction('pause', runner.id)}
                    loading={actionBusy === runner.id}
                    className="msn-btn-runner-pause"
                  >
                    Pause
                  </Button>
                )}
                {canResume && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => handleAction('resume', runner.id)}
                    loading={actionBusy === runner.id}
                    className="msn-btn-runner-resume"
                  >
                    Resume
                  </Button>
                )}
                {canRemove && (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => handleAction('remove', runner.id)}
                    loading={actionBusy === runner.id}
                    className="msn-btn-runner-remove"
                  >
                    Remove as runner
                  </Button>
                )}
              </div>
              {actionError && (
                <p className={cx('msn-error-bar rounded-control border px-3 py-2 text-xs', TONES.danger.panel)}>{actionError}</p>
              )}
            </div>
          )}

          {error && (
            <p className={cx('msn-error-bar rounded-control border px-3 py-2 text-xs', TONES.danger.panel)}>{error}</p>
          )}

          <footer className="msn-dialog-footer flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={onClose} className="msn-btn-cancel">
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={!canSave}
              loading={busy}
              className="msn-btn-submit"
            >
              {busy ? 'Saving…' : editing ? 'Save' : 'Create runner'}
            </Button>
          </footer>
        </form>
      </div>
    </div>
  )
}