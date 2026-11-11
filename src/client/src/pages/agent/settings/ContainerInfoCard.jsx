import Button from '../../../components/ui/Button'
import Card from '../../../components/ui/Card'

export default function ContainerInfoCard({ setContainerInfoModal, saving, agent, settings }) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-medium text-ink-muted">Container Info</h3>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => setContainerInfoModal({ key: `cinfo-${Date.now()}` })}
          disabled={saving}
          title="Inspect the live container (network, mounts, ports, raw docker inspect)"
        >
          Inspect details
        </Button>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
        {[
          ['Name', agent.name],
          ['Agent type', agent.agent_type || '—'],
          ['Runtime', agent.runtime_type || 'docker'],
          ['Status', agent.status || '—'],
          ['Image', settings?.image || '—'],
          ['Version', settings?.version || '—'],
        ].map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-ink-dim">{k}</dt>
            <dd className="text-ink font-mono text-xs mt-0.5 break-all">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  )
}
