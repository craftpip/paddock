import Button from '../../../components/ui/Button'
import Card from '../../../components/ui/Card'
import { TONES } from '../../../components/ui/tone'
import { cx } from '../../../lib/cx'

export default function ContainerUserCard({ settings, handleUserModeChange, saving }) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <h3 className="text-sm font-medium text-ink-muted">Container user</h3>
      <p className="text-xs text-ink-dim mt-1 max-w-md">
        The agent daemon and terminal run as the pad user ({'PUID'}:{'PGID'}), so every file they write is
        user-owned on the host. SSH stays the root admin door.
      </p>
      <div className="mt-3 inline-flex rounded-control border border-line-faint bg-sunken p-0.5">
        <Button
          variant={(settings?.userMode || 'root') === 'root' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => handleUserModeChange('root')}
          disabled={saving}
        >
          Root
        </Button>
        <Button
          variant={settings?.userMode === 'user' ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => handleUserModeChange('user')}
          disabled={saving}
        >
          Local user
        </Button>
      </div>
      {settings?.userMode === 'user' && (
        <p className={cx('mt-3 rounded-card border px-3 py-2 text-xs', TONES.warning.panel)}>
          Changing to root or to another setting below will stop and recreate the container.
        </p>
      )}
    </Card>
  )
}
