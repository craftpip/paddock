import { useEffect, useState } from 'react'

export default function RunnerSchedulerStatus({ runner, scheduler }) {
  const [seconds, setSeconds] = useState(null)
  const timed = ['wait_idle_grace', 'wait_nudge_interval'].includes(scheduler?.schedulerDecision)
  const deadline = scheduler?.deadline
  const observedAt = scheduler?.observedAt

  useEffect(() => {
    const duration = Date.parse(deadline) - Date.parse(observedAt)
    if (!timed || !Number.isFinite(duration)) {
      setSeconds(null)
      return undefined
    }
    // Use elapsed client time against the server's remaining duration so a
    // different clock on the user's laptop cannot shift the grace countdown.
    const receivedAt = Date.now()
    const remaining = () => Math.max(0, Math.ceil((duration - (Date.now() - receivedAt)) / 1000))
    setSeconds(remaining())
    const timer = setInterval(() => {
      const value = remaining()
      setSeconds(value)
      if (value === 0) clearInterval(timer)
    }, 1000)
    return () => clearInterval(timer)
  }, [timed, deadline, observedAt])

  const word = scheduler?.workerState || runner.worker_state || 'unknown'
  let reason = scheduler?.reason || runner.scheduler_reason || 'Waiting for worker observation'
  if (runner.control_state === 'finished') reason = 'Queue is done'
  if (timed && seconds !== null) {
    const label = scheduler.schedulerDecision === 'wait_idle_grace' ? 'Idle grace' : 'Nudge interval'
    const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    reason = seconds > 0 ? `${label}: ${clock} remaining` : `${label} elapsed — waiting for next check`
  }
  return (
    <p className="msn-runner-scheduler mb-1 break-words text-[10px] text-ink-faint">
      <span className="msn-runner-worker-state" title="Worker state at the last observation">{word}</span>
      {' · '}<span className="msn-runner-scheduler-reason">{reason}</span>
    </p>
  )
}
