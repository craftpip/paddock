import Button from '../../../components/ui/Button'
import { TONES } from '../../../components/ui/tone'
import { cx } from '../../../lib/cx'

export default function DangerZone({ handleDelete, saving }) {
  return (
    <section className={cx('rounded-card border p-5', TONES.danger.panel)}>
      <h3 className="text-sm font-medium text-danger">Danger Zone</h3>
      <p className="text-xs text-ink-dim mt-1 max-w-md">
        Permanently delete this agent, its container, and all files. This cannot be undone.
      </p>
      <Button
        variant="danger"
        size="sm"
        onClick={handleDelete}
        disabled={saving}
        className="mt-3"
      >
        Delete Container
      </Button>
    </section>
  )
}
