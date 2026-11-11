import Button from '../../components/ui/Button'
import { Select, Input, Checkbox } from '../../components/ui/Input'

export default function VolumesSection({
  extraVolumes,
  updateVolume,
  volumeErrors,
  setExtraVolumes,
  hasVolumeErrors,
}) {
  return (
    <div className="border-t border-line pt-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Additional volumes</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Extra mounts beyond the data and workspace folders: host → container bind mounts or named Docker volumes. Changing them later requires a recreate.
          </p>
        </div>
      </div>

      {extraVolumes.length === 0 && (
        <p className="text-xs text-ink-dim">No additional volumes.</p>
      )}
      {extraVolumes.length > 0 && (
        <div className="rounded-card overflow-hidden border border-line-faint">
          <div className="bg-sunken text-ink-faint uppercase tracking-wider text-[11px] px-2 py-2 flex items-center gap-2 font-medium">
            <span className="w-32 shrink-0">Type</span>
            <span className="flex-1 min-w-0">Host source / Volume name</span>
            <span className="flex-1 min-w-0">Container path</span>
            <span className="w-7 shrink-0 text-center" title="Read-only mount">Ro</span>
            <span className="w-7 shrink-0"></span>
          </div>
          {extraVolumes.map((v, i) => (
            <div key={i} className="border-t border-line-faint flex items-start gap-2 px-2 py-1.5">
              <div className="w-32 shrink-0">
                <Select size="sm" className="px-1.5" value={v.type || 'bind'}
                        onChange={(e) => updateVolume(i, { type: e.target.value })}>
                  <option value="bind">Bind mount</option>
                  <option value="volume">Named volume</option>
                </Select>
              </div>
              <div className="flex-1 min-w-0">
                <Input size="sm" mono value={v.host}
                       onChange={(e) => updateVolume(i, { host: e.target.value })}
                       title={v.type === 'volume' ? (v.external ? `Attaches the existing volume ${v.external}` : 'Creates a fresh volume') : undefined}
                       placeholder={v.type === 'volume' ? 'e.g. mempalace-dbdata' : 'e.g. /mnt/shared'} />
                {volumeErrors[i].host && <p className="text-xs text-danger mt-0.5">{volumeErrors[i].host}</p>}
              </div>
              <div className="flex-1 min-w-0">
                <Input size="sm" mono value={v.container}
                       onChange={(e) => updateVolume(i, { container: e.target.value })}
                       placeholder="e.g. /data" />
                {volumeErrors[i].dir && <p className="text-xs text-danger mt-0.5">{volumeErrors[i].dir}</p>}
              </div>
              <div className="w-7 shrink-0 h-7 flex items-center justify-center" title="Read-only mount">
                <Checkbox size="sm" checked={!!v.readonly}
                         onChange={(e) => updateVolume(i, { readonly: e.target.checked })}
                         title="Read-only mount" />
              </div>
              <div className="w-7 shrink-0">
                <Button variant="ghost" size="sm" icon
                        onClick={() => setExtraVolumes(prev => prev.filter((_, idx) => idx !== i))}
                        className="hover:text-danger hover:bg-raised"
                        title="Remove volume">✕</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Button variant="secondary" size="sm" className="px-3"
              onClick={() => setExtraVolumes(prev => [...prev, { type: 'bind', host: '', container: '', readonly: false }])}>
        + Add volume
      </Button>
      {hasVolumeErrors && (
        <p className="text-xs text-danger">Fix the invalid volume fields — the source and container path must both be valid.</p>
      )}
    </div>
  )
}
