import Console from '../../components/Console'
import Button from '../../components/ui/Button'
import { TONES } from '../../components/ui/tone'
import { cx } from '../../lib/cx'

export default function CreateProgress({
  phase,
  jobName,
  resetForm,
  error,
  runningCmd,
  lines,
  navigate,
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm text-ink-faint">
          {phase === 'creating' && (
            <>
              <span className="inline-block w-3 h-3 rounded-full border-2 border-accent-line border-t-transparent animate-spin mr-2 align-middle" />
              Creating <span className="text-ink font-medium">{jobName}</span>…
            </>
          )}
          {phase === 'done' && (
            <span className="text-success font-medium">
              Agent created! Setup complete.
            </span>
          )}
          {phase === 'failed' && (
            <span className="text-danger font-medium">Create failed</span>
          )}
        </div>
        {phase !== 'creating' && (
          <Button variant="ghost" size="sm" onClick={resetForm}>
            ← Back to form
          </Button>
        )}
      </div>

      {phase === 'failed' && (
        <div className={cx('rounded-card border px-4 py-3 text-sm', TONES.danger.panel)}>{error}</div>
      )}

      <Console
        label="Create log"
        runningCmd={runningCmd}
        lines={lines}
        emptyMessage="Waiting for output…"
        className="h-[60vh]"
      />

      {phase === 'done' && (
        <Button variant="primary" size="lg" block onClick={() => navigate('/agents/' + jobName)}>
          Go to {jobName}
        </Button>
      )}
    </div>
  )
}
