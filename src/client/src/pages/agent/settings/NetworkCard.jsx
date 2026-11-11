import { Select } from '../../../components/ui/Input'
import Card from '../../../components/ui/Card'

export default function NetworkCard({ currentNetwork, handleNetworkChange, saving, networkOptions }) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <h3 className="text-sm font-medium text-ink-muted">Network</h3>
      <p className="text-xs text-ink-dim mt-1 max-w-md">
        Route this agent's traffic through another running container by joining its network namespace (e.g. gluetun for VPN).
      </p>
      <div className="mt-3 sm:w-96">
        <Select
          value={currentNetwork}
          onChange={(e) => handleNetworkChange(e.target.value)}
          disabled={saving}
        >
          <option value="">Default (no override)</option>
          {networkOptions.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}{c.state !== 'running' ? '  (stopped)' : ''}
            </option>
          ))}
        </Select>
      </div>
      <p className="mt-3 text-xs text-ink-dim">
        ⚠ Joining a container's network means the agent shares its network stack. If the target stops, the agent loses its network.
      </p>
    </Card>
  )
}
