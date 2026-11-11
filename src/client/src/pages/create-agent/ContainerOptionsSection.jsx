import Button from '../../components/ui/Button'
import { Select } from '../../components/ui/Input'
import Field from '../../components/ui/Field'
import Switch from '../../components/ui/Switch'
import { TONES } from '../../components/ui/tone'
import { cx } from '../../lib/cx'

export default function ContainerOptionsSection({
  allowDocker,
  setAllowDocker,
  prefix,
  userMode,
  userModeTouched,
  setUserMode,
  agentType,
  network,
  setNetwork,
  networkOptions,
}) {
  return (
    <div className="border-t border-line pt-4">
      <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Container options</h3>

      <div className="mt-3 flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink">Allow docker in the container</p>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Mounts the host docker socket + installs the docker CLI. Rebuilds the image during creation.
          </p>
        </div>
        <Switch
          checked={allowDocker}
          onChange={setAllowDocker}
          label="Allow docker in the container"
        />
      </div>
      {allowDocker && (
        <p className={cx('mt-3 rounded-card border px-3 py-2 text-xs', TONES.warning.panel)}>
          ⚠ The docker socket is host-root equivalent — this agent can control the entire host.
        </p>
      )}

      {/* Container user (plan 43 Phase 7): root vs the pad user */}
      <div className="mt-4">
        <Field
          labelClassName="flex items-center justify-between"
          label={
            <>
              Container user
              <span className="text-[11px] font-normal normal-case tracking-normal text-ink-dim">pad uid {prefix === 'vm' ? '1000:1000' : 'PUID:PGID'}</span>
            </>
          }
        >
          <div className="inline-flex rounded-control border border-line-faint bg-sunken p-0.5">
            <Button size="sm"
                    variant={userMode === 'root' ? 'primary' : 'ghost'}
                    className="px-3 rounded-control"
                    onClick={() => { userModeTouched.current = true; setUserMode('root') }}>
              Root
            </Button>
            <Button size="sm"
                    variant={userMode === 'user' ? 'primary' : 'ghost'}
                    disabled={agentType === 'hermes'}
                    className="px-3 rounded-control"
                    onClick={() => { userModeTouched.current = true; setUserMode('user') }}>
              Local user
            </Button>
          </div>
        </Field>
        {agentType === 'hermes' ? (
          <p className="text-xs text-ink-dim mt-1.5">
            Hermes already runs its daemon as its own user (/opt/data) — the option does not apply.
          </p>
        ) : (
          <p className="text-xs text-ink-dim mt-1.5">
            {userMode === 'user'
              ? 'The agent daemon and terminal run as the pad user — every file they write is user-owned on the host. SSH stays the root admin door.'
              : 'The agent daemon runs as root (legacy default). Choose Local user to run agent processes as the pad user.'}
          </p>
        )}
      </div>

      <div className="mt-4">
        <Field label="Network">
          <div className="sm:w-96">
            <Select value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option value="">Default (no override)</option>
              {networkOptions.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}{c.state !== 'running' ? '  (stopped)' : ''}
                </option>
              ))}
            </Select>
          </div>
        </Field>
        <p className="text-xs text-ink-dim mt-1.5">
          Route the agent through another running container by joining its network namespace (e.g. gluetun for VPN).
        </p>
        <p className="text-xs text-ink-dim mt-1.5">
          In peer mode, published ports (web, additional ports) are forwarded through a socat door on the peer's bridge — no limitation.
        </p>
      </div>
    </div>
  )
}
