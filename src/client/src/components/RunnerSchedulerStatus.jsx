import { useEffect, useState } from 'react'

export default function RunnerSchedulerStatus({ execution, scheduler }) {
  const [seconds, setSeconds] = useState(null)
  // The server names the countdown (scheduler.countdownLabel); this component
  // only keeps the clock ticking between polls.
  const timed = !!scheduler?.countdownLabel
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

  const word = scheduler?.workerState || 'unknown'
  let reason = execution?.reason || scheduler?.reason || 'Waiting for worker observation'
  if (timed && seconds !== null) {
    const label = scheduler.countdownLabel
    const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    reason = seconds > 0 ? `${label}: ${clock} remaining` : `${label} elapsed — waiting for next check`
  }
  return (
    <p className="msn-runner-scheduler min-w-0 truncate text-[11px] text-ink-faint" title={`${word} · ${reason}`}>
      <span className="msn-runner-worker-state" title="Worker state at the last observation">{word}</span>
      {' · '}<span className="msn-runner-scheduler-reason">{reason}</span>
    </p>
  )
}
