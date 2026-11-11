import { Textarea, Checkbox } from '../../components/ui/Input'
import Field from '../../components/ui/Field'
import Badge from '../../components/ui/Badge'

export default function BuildCommandsSection({
  devContainer,
  buildCommands,
  setBuildCommands,
  postCreate,
  setPostCreate,
  postStart,
  setPostStart,
  postAttach,
  setPostAttach,
  generateDevContainer,
  setGenerateDevContainer,
}) {
  return (
    <div className="border-t border-line pt-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xs font-medium text-ink-faint uppercase tracking-wider">Build &amp; lifecycle commands</h3>
          <p className="text-xs text-ink-dim mt-1 max-w-md">
            Dockerfile lines inserted into this PAD's own image (run on every build), and bash lines run once after creation (post-create), on every start (post-start), and on every terminal attach (post-attach).
          </p>
        </div>
        {devContainer && (
          <Badge tone="neutral" variant="outline" size="sm">
            from .devcontainer/devcontainer.json
          </Badge>
        )}
      </div>

      <Field label="Build commands (Dockerfile)">
        <Textarea mono value={buildCommands} onChange={(e) => setBuildCommands(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder={'RUN apt-get install -y vim\n# or an ARG line, picked up by the next build'} />
        <p className="text-xs text-ink-dim mt-1">
          Runs inside <code className="text-ink-faint font-mono">instances/&lt;name&gt;/build/Dockerfile</code> on every image build. A <code className="text-ink-faint font-mono">FROM</code> line here fails the build (the current container stays up).
        </p>
      </Field>

      <Field label="Post-create commands (bash)">
        <Textarea mono value={postCreate} onChange={(e) => setPostCreate(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder={'npm install\n# project setup, run once after the container boots'} />
        <p className="text-xs text-ink-dim mt-1">
          Runs once in the running container (project mounted, services up) after creation. Pre-filled from the workspace's <code className="text-ink-faint font-mono">devcontainer.json</code> when present — edit freely.
        </p>
      </Field>

      <Field label="Post-start commands (bash)">
        <Textarea mono value={postStart} onChange={(e) => setPostStart(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder={'service cron start\n# runs on every container start'} />
        <p className="text-xs text-ink-dim mt-1">
          Runs on every container start (baked into <code className="text-ink-faint font-mono">start.sh</code>). Pre-filled from <code className="text-ink-faint font-mono">postStartCommand</code> in the workspace's devcontainer.
        </p>
      </Field>

      <Field label="Post-attach commands (bash)">
        <Textarea mono value={postAttach} onChange={(e) => setPostAttach(e.target.value)}
                  rows={3}
                  spellCheck={false}
                  placeholder={'echo "terminal attached"\n# runs on every terminal attach'} />
        <p className="text-xs text-ink-dim mt-1">
          Runs on every terminal attach inside this PAD (workspace/project mounted). Pre-filled from <code className="text-ink-faint font-mono">postAttachCommand</code> in the workspace's devcontainer.
        </p>
      </Field>

      {/* Plan 41 item 20: generate a devcontainer mirror in the workspace */}
      <label className="flex items-start gap-2.5 rounded-control border border-line-faint bg-sunken/50 px-3 py-2.5 cursor-pointer select-none">
        <Checkbox size="sm" className="mt-0.5"
               checked={generateDevContainer}
               onChange={(e) => setGenerateDevContainer(e.target.checked)} />
        <span>
          <span className="block text-xs font-medium text-ink">
            Generate <code className="text-ink-faint font-mono">.devcontainer/devcontainer.json</code> for this workspace
          </span>
          <span className="block text-xs text-ink-dim mt-0.5">
            When the workspace has no devcontainer, writes one mirroring this pad's settings (workspace folder, lifecycle commands, env, volumes, ports, user), marked <code className="text-ink-faint font-mono">x-paddock.generated</code>. {devContainer ? 'This workspace already ships a devcontainer — it is never overwritten.' : 'Leave on to keep the workspace openable as a dev container.'}
          </span>
        </span>
      </label>
    </div>
  )
}
