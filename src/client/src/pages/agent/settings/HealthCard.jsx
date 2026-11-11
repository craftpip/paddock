import Button from '../../../components/ui/Button'
import Card from '../../../components/ui/Card'
import { TONES } from '../../../components/ui/tone'
import { cx } from '../../../lib/cx'

export default function HealthCard({
  healthError,
  healthLoading,
  healthStatus,
  openHealthCheck,
  healthCounts,
  runHealthCheck,
  saving,
}) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium text-ink-muted">Container Health Checkup</h3>
            <p className="text-xs text-ink-dim mt-1 max-w-md">
              Inspects the actual Docker container against the compose file — status, restart policy, network peer, mounts, ports, env. Each check streams live with a pass/fail.
            </p>
            {healthError && <p className="text-xs text-danger mt-1">{healthError}</p>}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {healthLoading ? (
              <span className="text-xs text-ink-dim">Checking…</span>
            ) : healthStatus ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={openHealthCheck}
                title="Open full checkup report"
                className={
                  healthStatus === 'ok'
                    ? cx(TONES.success.soft, 'hover:bg-success-soft')
                    : healthStatus === 'warn'
                      ? cx(TONES.warning.soft, 'hover:bg-warning-soft')
                      : cx(TONES.danger.soft, 'hover:bg-danger-soft')
                }
              >
                {healthStatus === 'ok'
                  ? '✓ Healthy'
                  : healthStatus === 'warn'
                    ? `~ ${healthCounts?.warn || 0} issue${healthCounts?.warn === 1 ? '' : 's'}`
                    : `✗ ${healthCounts?.error || 0} problem${healthCounts?.error === 1 ? '' : 's'}`}
              </Button>
            ) : null}
            <Button variant="primary" size="sm" onClick={runHealthCheck} disabled={saving}>
              Run Health Check
            </Button>
          </div>
        </div>
      </Card>
  )
}
