/**
 * Container state → label + tailwind classes for status pills and dots.
 *
 * Docker states (from `docker ps --format {{.State}}`):
 *   running, exited, created, paused, restarting, removing, dead
 * Synthetic transitions injected by the agents store while an action runs:
 *   starting, stopping, restarting
 * Fallback when docker has no record for the agent:
 *   missing
 *
 * `pulse` states (starting/stopping/restarting) animate their dot so an
 * in-flight action is visually distinct from a settled state.
 */

export const STATUS_META = {
  running: {
    label: 'running',
    pill: 'bg-success-soft text-success border border-success-line',
    dot: 'bg-success',
    pulse: false,
  },
  exited: {
    label: 'exited',
    pill: 'bg-danger-soft text-danger border border-danger-line',
    dot: 'bg-danger',
    pulse: false,
  },
  created: {
    label: 'created',
    pill: 'bg-info-soft text-info border border-info-line',
    dot: 'bg-info',
    pulse: false,
  },
  paused: {
    label: 'paused',
    pill: 'bg-warning-soft text-warning border border-warning-line',
    dot: 'bg-warning',
    pulse: false,
  },
  restarting: {
    label: 'restarting',
    pill: 'bg-accent-soft text-accent-text border border-accent-line',
    dot: 'bg-accent',
    pulse: true,
  },
  removing: {
    label: 'removing',
    pill: 'bg-brand-soft text-brand border border-brand-line',
    dot: 'bg-brand',
    pulse: false,
  },
  dead: {
    label: 'dead',
    pill: 'bg-danger-soft text-danger border border-danger-line',
    dot: 'bg-danger',
    pulse: false,
  },
  starting: {
    label: 'starting',
    pill: 'bg-accent-soft text-accent-text border border-accent-line',
    dot: 'bg-accent',
    pulse: true,
  },
  stopping: {
    label: 'stopping',
    pill: 'bg-warning-soft text-warning border border-warning-line',
    dot: 'bg-warning',
    pulse: true,
  },
  missing: {
    label: 'missing',
    pill: 'bg-panel text-ink-faint border border-line',
    dot: 'bg-line',
    pulse: false,
  },
}

export function statusMeta(status) {
  return (
    STATUS_META[status] || {
      label: status || 'unknown',
      pill: STATUS_META.missing.pill,
      dot: STATUS_META.missing.dot,
      pulse: false,
    }
  )
}
