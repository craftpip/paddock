import Button from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import Badge from '../../components/ui/Badge'
import { cx } from '../../lib/cx'

export default function WorkspacePathSection({
  wsFixed,
  wsDir,
  wsDirTouched,
  setWsDir,
  defaultWsDir,
  wsHost,
  agentType,
  wsDirErr,
}) {
  return (
    <div className="border-t border-line pt-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Container workspace path</h3>
        {wsFixed && (
          <Badge tone="neutral" variant="outline" size="sm">
            <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M10 1a 4.5 4.5 0 0 0 -4.5 4.5V9H5a 2 2 0 0 0 -2 2v6a 2 2 0 0 0 2 2h10a 2 2 0 0 0 2 -2v-6a 2 2 0 0 0 -2 -2h-.5V5.5A 4.5 4.5 0 0 0 10 1zm3 8V5.5a 3 3 0 1 0 -6 0V9h6z" clipRule="evenodd" />
            </svg>
            Fixed
          </Badge>
        )}
      </div>
      <p className="text-xs text-ink-dim mb-2">
        The path inside the container where the agent sees the workspace folder. Leave empty to use the driver default.
      </p>
      <div className="relative">
        <Input type="text" value={wsDir} mono
               onChange={(e) => { if (!wsFixed) { wsDirTouched.current = true; setWsDir(e.target.value) } }}
               readOnly={wsFixed}
               tabIndex={wsFixed ? -1 : 0}
               placeholder={defaultWsDir || '/root/.openclaw/workspace'}
               className={wsFixed
                 ? 'border-dashed border-line-faint text-ink-dim cursor-not-allowed'
                 : 'pr-9'} />
        {!wsFixed && wsHost.trim().startsWith('/') && !wsHost.trim().startsWith('instances/') && (
          <Button
                  onClick={() => { wsDirTouched.current = true; setWsDir(wsHost.trim()) }}
                  title={wsDir === wsHost.trim() ? 'Paths are synced' : 'Sync container path to this path'}
                  variant="ghost"
                  size="sm"
                  icon
                  className={cx(
                    'absolute right-1.5 top-1/2 h-6 w-6 -translate-y-1/2',
                    wsDir === wsHost.trim() && wsDir
                      ? 'bg-success text-success-ink hover:bg-success'
                      : 'text-ink-faint hover:bg-sunken hover:text-ink'
                  )}>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </Button>
        )}
      </div>
      {wsFixed && (
        <p className="text-xs text-ink-dim mt-1">
          <span className="text-ink-faint">Locked —</span> fixed by {agentType}, whose CLI requires the workspace at this path.
        </p>
      )}
      {wsDirErr && <p className="text-xs text-danger mt-1">{wsDirErr}</p>}
    </div>
  )
}
