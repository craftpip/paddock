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
    pill: 'bg-emerald-900/50 text-emerald-400 border border-emerald-800',
    dot: 'bg-emerald-400',
    pulse: false,
  },
  exited: {
    label: 'exited',
    pill: 'bg-red-900/50 text-red-400 border border-red-800',
    dot: 'bg-red-400',
    pulse: false,
  },
  created: {
    label: 'created',
    pill: 'bg-blue-900/50 text-blue-400 border border-blue-800',
    dot: 'bg-blue-400',
    pulse: false,
  },
  paused: {
    label: 'paused',
    pill: 'bg-amber-900/50 text-amber-400 border border-amber-800',
    dot: 'bg-amber-400',
    pulse: false,
  },
  restarting: {
    label: 'restarting',
    pill: 'bg-cyan-900/50 text-cyan-400 border border-cyan-800',
    dot: 'bg-cyan-400',
    pulse: true,
  },
  removing: {
    label: 'removing',
    pill: 'bg-violet-900/50 text-violet-400 border border-violet-800',
    dot: 'bg-violet-400',
    pulse: false,
  },
  dead: {
    label: 'dead',
    pill: 'bg-rose-900/50 text-rose-400 border border-rose-800',
    dot: 'bg-rose-400',
    pulse: false,
  },
  starting: {
    label: 'starting',
    pill: 'bg-cyan-900/50 text-cyan-400 border border-cyan-800',
    dot: 'bg-cyan-400',
    pulse: true,
  },
  stopping: {
    label: 'stopping',
    pill: 'bg-amber-900/50 text-amber-400 border border-amber-800',
    dot: 'bg-amber-400',
    pulse: true,
  },
  missing: {
    label: 'missing',
    pill: 'bg-slate-800 text-slate-400 border border-slate-700',
    dot: 'bg-slate-500',
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
