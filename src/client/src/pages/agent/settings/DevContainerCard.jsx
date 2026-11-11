import Button from '../../../components/ui/Button'
import Card from '../../../components/ui/Card'
import Badge from '../../../components/ui/Badge'
import DiffPreview from './DiffPreview'

export default function DevContainerCard({
  dcInfo,
  dcLoading,
  handleDcSync,
  saving,
  dcAction,
  handleDcRegenerate,
}) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Dev Container</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            The workspace's <code className="text-ink-faint font-mono">devcontainer.json</code> is the portable mirror of this pad. Settings changes (volumes, ports, env, lifecycle commands) are written back into it automatically — these buttons push them manually, no container recreate.
          </p>
        </div>
        {dcInfo && (
          <Badge
            tone={dcInfo.state === 'generated' ? 'accent' : 'neutral'}
            variant="soft"
            size="md"
            className="shrink-0"
          >
            {dcInfo.state === 'generated'
              ? 'Generated'
              : dcInfo.state === 'project-authored'
                ? 'Project-authored'
                : 'Missing'}
          </Badge>
        )}
      </div>

      <div className="mt-4">
        <p className="text-xs text-ink-faint font-mono break-all">
          {dcInfo?.filePath || (dcInfo?.workspacePath ? `${dcInfo.workspacePath}/.devcontainer/devcontainer.json` : '—')}
        </p>

        {!dcInfo ? (
          <p className="text-xs text-ink-dim mt-2">{dcLoading ? 'Loading…' : 'Dev container info unavailable.'}</p>
        ) : !dcInfo.workspacePath ? (
          <p className="text-xs text-ink-dim mt-2">
            This agent has no custom workspace — the dev container mirror needs a workspace folder.
          </p>
        ) : !dcInfo.found ? (
          <p className="text-xs text-ink-dim mt-2">
            No devcontainer.json in the workspace yet. Generate one mirroring this pad's current settings.
          </p>
        ) : (
          <div className="mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] uppercase tracking-wider text-ink-faint font-medium">
                Diff — current file vs what Paddock would write now
              </span>
              <span className="text-[11px] text-ink-dim">red removed · green added</span>
            </div>
            <DiffPreview from={dcInfo.content} to={dcInfo.target} />
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleDcSync}
          disabled={saving || dcAction !== '' || !dcInfo?.sync || !dcInfo?.found || dcInfo?.writable === false}
          title={dcInfo?.writable === false
            ? 'The mirror cannot be written from this workspace'
            : !dcInfo?.sync || !dcInfo?.found ? 'Nothing to sync — the pad never adopted this devcontainer' : undefined}
        >
          {dcAction === 'sync' ? 'Syncing…' : 'Sync'}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={handleDcRegenerate}
          disabled={saving || dcAction !== '' || !dcInfo?.workspacePath || dcInfo?.writable === false}
          title={dcInfo?.writable === false ? dcInfo?.writeNote || 'The mirror cannot be written from this workspace' : undefined}
        >
          {dcAction === 'regenerate' ? 'Working…' : dcInfo?.found ? 'Regenerate' : 'Generate'}
        </Button>
        {dcInfo?.writableVia === 'pad' && (
          <span className="text-[11px] text-ink-faint">{dcInfo?.writeNote}</span>
        )}
        {dcInfo?.state === 'project-authored' && (
          <span className="text-xs text-ink-dim">Sync preserves your custom fields — Regenerate overwrites them.</span>
        )}
      </div>
    </Card>
  )
}
