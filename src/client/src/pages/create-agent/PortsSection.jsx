import Button from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'

export default function PortsSection({
  extraPorts,
  updatePort,
  portErrors,
  setExtraPorts,
  hasPortErrors,
}) {
  return (
    <div className="border-t border-line pt-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Additional ports</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Host → container TCP port mappings, independent of the SSH port.
          </p>
        </div>
      </div>

      {extraPorts.length === 0 && (
        <p className="text-xs text-ink-dim">No port mappings.</p>
      )}
      {extraPorts.length > 0 && (
        <div className="rounded-card overflow-hidden border border-line-faint">
          <div className="bg-sunken text-ink-faint uppercase tracking-wider text-[11px] px-2 py-2 flex items-center gap-2 font-medium">
            <span className="flex-1 min-w-0">Host port</span>
            <span className="flex-1 min-w-0">Container port</span>
            <span className="w-7 shrink-0"></span>
          </div>
          {extraPorts.map((p, i) => (
            <div key={i} className="border-t border-line-faint flex items-start gap-2 px-2 py-1.5">
              <div className="flex-1 min-w-0">
                <Input size="sm" mono type="number" min="1" max="65535" value={p.host}
                       onChange={(e) => updatePort(i, { host: e.target.value })}
                       placeholder="e.g. 9000" />
                {portErrors[i] && <p className="text-xs text-danger mt-0.5">{portErrors[i]}</p>}
              </div>
              <div className="flex-1 min-w-0">
                <Input size="sm" mono type="number" min="1" max="65535" value={p.container}
                       onChange={(e) => updatePort(i, { container: e.target.value })}
                       placeholder="e.g. 80" />
              </div>
              <div className="w-7 shrink-0">
                <Button variant="ghost" size="sm" icon
                        onClick={() => setExtraPorts(prev => prev.filter((_, idx) => idx !== i))}
                        className="hover:text-danger hover:bg-raised"
                        title="Remove port">✕</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button variant="secondary" size="sm" className="px-3"
              onClick={() => setExtraPorts(prev => [...prev, { host: '', container: '' }])}>
        + Add port
      </Button>
      {hasPortErrors && (
        <p className="text-xs text-danger">Fix the invalid port fields.</p>
      )}
    </div>
  )
}
