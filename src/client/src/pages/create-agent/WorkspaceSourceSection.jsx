import Button from '../../components/ui/Button'
import { Input } from '../../components/ui/Input'
import Field from '../../components/ui/Field'
import { TONES } from '../../components/ui/tone'
import { cx } from '../../lib/cx'

export default function WorkspaceSourceSection({
  wsHost,
  onWsHostChange,
  onWsKeyDown,
  setSuggestOpen,
  defaultWsHost,
  hostWorkspaceRoot,
  wsHidden,
  wsFixed,
  wsDirTouched,
  setWsDir,
  wsDir,
  suggestOpen,
  suggestions,
  pickSuggestion,
  acIndex,
  wsHostProblem,
  wsProbe,
  discovered,
}) {
  return (
    <div className="border-t border-line pt-4">
                <Field
                  htmlFor="ws-host"
                  labelClassName="flex items-center justify-between"
                  label={
                    <>
                      Host workspace path
                      <span className="text-[11px] font-normal normal-case tracking-normal text-ink-faint">The project your agent works on</span>
                    </>
                  }
                >
                <div className="relative">
                  <Input id="ws-host" type="text" value={wsHost} mono
                         onChange={(e) => onWsHostChange(e.target.value)}
                         onKeyDown={onWsKeyDown}
                         onBlur={() => setTimeout(() => setSuggestOpen(false), 150)}
                         placeholder={defaultWsHost}
                         className="pr-9" />
                  {hostWorkspaceRoot && !wsHidden && !wsFixed && wsHost.trim().startsWith('/') && !wsHost.trim().startsWith('instances/') && (
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
                  {suggestOpen && suggestions.length > 0 && (
                    <div className="absolute z-20 mt-1 w-full max-h-60 overflow-auto bg-raised border border-line rounded-card shadow-xl">
                      {suggestions.map((s, i) => (
                        <Button key={s} size="sm"
                                onMouseDown={(e) => { e.preventDefault(); pickSuggestion(s) }}
                                className={cx('block w-full px-3 py-2 text-left font-mono text-ink hover:bg-sunken', i === acIndex && 'bg-sunken')}>
                          {s}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
                </Field>
                <p className="text-xs text-ink-dim mt-1.5">
                  This folder is where your agent's files live on this PC — open it directly from your file manager.
                </p>
                {wsHostProblem && <p className="text-xs text-danger mt-1">{wsHostProblem}</p>}
                {wsProbe && !wsProbe.forbidden && !wsProbe.exists && (
                  <p className="text-xs text-warning mt-1">Folder not found in paddock — mount the project folder one-to-one (same path in host and container) to use it.</p>
                )}
                {wsProbe && !wsProbe.forbidden && wsProbe.exists && !wsProbe.compose && (
                  <p className="text-xs text-success mt-1">Path resolves.</p>
                )}
                {wsProbe && !wsProbe.forbidden && wsProbe.exists && wsProbe.outsideProject && (
                  /* Plan 72. Two facts that are easy to state wrongly, so they
                     are stated from what the code does: the webui does NOT
                     chown an outside-project source (that `ensureOwned` call is
                     gated on `webuiVisible`), so ownership there belongs to
                     whoever runs the agent; and `removeVm` only deletes a source
                     under the project root, so deleting this agent leaves the
                     folder alone. */
                  <p className="text-xs text-ink-dim mt-1">
                    Outside the Paddock folder, so this project&rsquo;s file browser and autocomplete stay
                    container-only until the folder is mounted one-to-one. Files here are owned by whoever runs
                    the agent (root, or the PAD user in user mode) &mdash; deleting the agent does <strong>not</strong>{' '}
                    delete this folder.
                  </p>
                )}
                {discovered && (
                  <div className={cx('mt-2 rounded-card border px-3 py-2 text-xs', TONES.success.panel)}>
                    {discovered.count} volume{discovered.count === 1 ? '' : 's'} found in <code className="font-mono">{discovered.project}</code>'s compose file — pre-filled under <span className="font-medium">Advanced settings → Additional volumes</span>. Review, edit or remove them before creating.
                  </div>
                )}
              </div>
  )
}
