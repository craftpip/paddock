import Button from '../../../components/ui/Button'
import { Select, Input, Checkbox } from '../../../components/ui/Input'
import Card from '../../../components/ui/Card'

export default function VolumesCard({
  volDraft,
  setVol,
  volErrors,
  setVolDraft,
  setVolDirty,
  saving,
  volHasErrors,
  handleVolumesSave,
  volDirty,
}) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Additional volumes</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Extra host → container bind mounts beyond the data and workspace folders. Applying changes recreates the container.
          </p>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        {volDraft.length === 0 && (
          <p className="text-xs text-ink-dim">No additional volumes.</p>
        )}
        {volDraft.length > 0 && (
          <div className="rounded-card overflow-hidden border border-line-faint">
            <div className="bg-sunken text-ink-faint uppercase tracking-wider text-[11px] px-2 py-2 flex items-center gap-2 font-medium">
              <span className="w-32 shrink-0">Type</span>
              <span className="flex-1 min-w-0">Host source / Volume name</span>
              <span className="flex-1 min-w-0">Container path</span>
              <span className="w-7 shrink-0 text-center" title="Read-only mount">Ro</span>
              <span className="w-7 shrink-0"></span>
            </div>
            {volDraft.map((v, i) => (
              <div key={i} className="border-t border-line-faint flex items-start gap-2 px-2 py-1.5">
                <div className="w-32 shrink-0">
                  <Select size="sm" className="bg-raised" value={v.type || 'bind'}
                          onChange={(e) => setVol(i, { type: e.target.value })}>
                    <option value="bind">Bind mount</option>
                    <option value="volume">Named volume</option>
                  </Select>
                </div>
                <div className="flex-1 min-w-0">
                  <Input size="sm" mono className="bg-raised" type="text" value={v.host}
                         onChange={(e) => setVol(i, { host: e.target.value })}
                         title={v.type === 'volume' ? (v.external ? `Attaches the existing volume ${v.external}` : 'Creates a fresh volume') : undefined}
                         placeholder={v.type === 'volume' ? 'e.g. mempalace-dbdata' : 'e.g. /mnt/shared'} />
                  {volErrors[i].host && <p className="text-xs text-danger mt-0.5">{volErrors[i].host}</p>}
                </div>
                <div className="flex-1 min-w-0">
                  <Input size="sm" mono className="bg-raised" type="text" value={v.container}
                         onChange={(e) => setVol(i, { container: e.target.value })}
                         placeholder="e.g. /data" />
                  {volErrors[i].dir && <p className="text-xs text-danger mt-0.5">{volErrors[i].dir}</p>}
                </div>
                <div className="w-7 shrink-0 h-7 flex items-center justify-center" title="Read-only mount">
                  <Checkbox size="sm" checked={!!v.readonly}
                            onChange={(e) => setVol(i, { readonly: e.target.checked })}
                            title="Read-only mount" />
                </div>
                <div className="w-7 shrink-0">
                  <Button variant="dangerGhost" size="sm" icon
                          onClick={() => { setVolDraft(prev => prev.filter((_, idx) => idx !== i)); setVolDirty(true) }}
                          title="Remove volume">✕</Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <Button variant="secondary" size="sm"
                onClick={() => { setVolDraft(prev => [...prev, { type: 'bind', host: '', container: '', readonly: false }]); setVolDirty(true) }}
                disabled={saving}>
          + Add volume
        </Button>

        {volHasErrors && (
          <p className="text-xs text-danger">Fix the invalid volume fields before saving.</p>
        )}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleVolumesSave}
            disabled={saving || !volDirty || volHasErrors}
          >
            Apply volumes & recreate
          </Button>
          {volDirty && !saving && (
            <span className="text-xs text-ink-dim">Unsaved volume changes</span>
          )}
        </div>
      </div>
    </Card>
  )
}
