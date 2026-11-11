import Button from '../../../components/ui/Button'
import Switch from '../../../components/ui/Switch'
import { Input } from '../../../components/ui/Input'
import Field from '../../../components/ui/Field'
import Card from '../../../components/ui/Card'
import { cx } from '../../../lib/cx'

export default function WorkspaceFolderCard({
  wsEnabled,
  setWsEnabled,
  saving,
  wsHostIssue,
  wsHost,
  setWsHost,
  defaultWsHost,
  wsDir,
  wsFixed,
  setWsDir,
  agent,
  wsDirIssue,
  handleWorkspaceSave,
}) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium text-ink-muted">Custom workspace folder</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Mounts an independent host folder at a container workspace path. Changing it recreates the container; files are never moved or deleted.
          </p>
        </div>
        <Switch
          checked={wsEnabled}
          onChange={setWsEnabled}
          disabled={saving}
          label="Custom workspace folder"
        />
      </div>

      {wsEnabled && (
        <div className="mt-4 space-y-4">
          <Field label="Host workspace source" error={wsHostIssue(wsHost)}>
            <Input mono type="text" value={wsHost} onChange={(e) => setWsHost(e.target.value)}
                   placeholder={defaultWsHost} />
          </Field>
          <Field label="Container workspace path">
            <Input mono type="text" value={wsDir}
                   onChange={(e) => !wsFixed && setWsDir(e.target.value)}
                   readOnly={wsFixed}
                   className={cx(wsFixed && 'opacity-70 cursor-not-allowed')} />
            {wsFixed && (
              <p className="text-xs text-ink-dim mt-1">
                Fixed by {agent.agent_type} — its CLI requires the workspace at this path
              </p>
            )}
            {wsDirIssue(wsDir) && (
              <p className="text-xs text-danger mt-1">{wsDirIssue(wsDir)}</p>
            )}
          </Field>

          <p className="text-xs text-ink-dim">
            A custom workspace is a separate bind mount, outside the agent's data folder.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={handleWorkspaceSave}
            disabled={saving}
          >
            Apply workspace & recreate
          </Button>
        </div>
      )}
    </Card>
  )
}
