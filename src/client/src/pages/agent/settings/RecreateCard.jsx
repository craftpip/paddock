import Button from '../../../components/ui/Button'
import Card from '../../../components/ui/Card'

export default function RecreateCard({ openRecreate, saving }) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Recreate Container</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Recreates the container. Use it to update the image to the latest, to simply recreate the container, or to reset the entire user folder (config, sessions, data) so it starts completely fresh — your bind-mounted workspace folder is preserved.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={openRecreate} disabled={saving}>
          Recreate Container
        </Button>
      </div>
    </Card>
  )
}
