import Switch from '../../../components/ui/Switch'
import Card from '../../../components/ui/Card'
import { TONES } from '../../../components/ui/tone'
import { cx } from '../../../lib/cx'

export default function DockerAccessCard({ toggleDocker, handleToggleDocker, saving }) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Allow docker in the container</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Lets this agent run <code className="text-ink-faint">docker</code> commands (docker CLI + host socket). Rebuilds the image if it has no docker CLI.
          </p>
        </div>
        <Switch
          checked={toggleDocker}
          onChange={handleToggleDocker}
          disabled={saving}
          label="Allow docker in the container"
        />
      </div>
      {toggleDocker && (
        <p className={cx('mt-3 rounded-card border px-3 py-2 text-xs', TONES.warning.panel)}>
          ⚠ The docker socket is host-root equivalent. This agent can control the entire host.
        </p>
      )}
    </Card>
  )
}
