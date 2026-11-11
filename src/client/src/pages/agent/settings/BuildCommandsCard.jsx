import Button from '../../../components/ui/Button'
import { Textarea } from '../../../components/ui/Input'
import Field from '../../../components/ui/Field'
import Card from '../../../components/ui/Card'

export default function BuildCommandsCard({
  agent,
  buildDraft,
  setBuildDraft,
  setBuildDirty,
  postCreateDraft,
  setPostCreateDraft,
  setPostCreateDirty,
  postStartDraft,
  setPostStartDraft,
  setPostStartDirty,
  postAttachDraft,
  setPostAttachDraft,
  setPostAttachDirty,
  handleBuildPostCreateSave,
  saving,
  buildDirty,
  postCreateDirty,
  postStartDirty,
  postAttachDirty,
}) {
  return (
    <Card plain className="bg-panel/60 border-line p-5">
      <div>
        <h3 className="text-sm font-medium text-ink-muted">Build &amp; lifecycle commands</h3>
        <p className="text-xs text-ink-dim mt-1 max-w-md">
          Dockerfile lines baked into this PAD's image (every rebuild) and bash lines run at the container lifecycle: once after recreate (post-create), on every start (post-start), and on every terminal attach (post-attach).
        </p>
      </div>

      <div className="mt-4 space-y-4">
        <Field
          label="Build commands (Dockerfile)"
          hint={
            <>
              Lives in <code className="text-ink-faint font-mono">instances/{agent.name}/build/Dockerfile</code>. A change rebuilds the image (a <code className="text-ink-faint font-mono">FROM</code> line here fails the build — the current container stays up).
            </>
          }
        >
          <Textarea mono className="bg-raised" value={buildDraft}
                    onChange={(e) => { setBuildDraft(e.target.value); setBuildDirty(true) }}
                    rows={3}
                    spellCheck={false}
                    placeholder={'RUN apt-get install -y vim'} />
        </Field>

        <Field
          label="Post-create commands (bash)"
          hint="Runs once in the running container (project mounted, services up) after a recreate."
        >
          <Textarea mono className="bg-raised" value={postCreateDraft}
                    onChange={(e) => { setPostCreateDraft(e.target.value); setPostCreateDirty(true) }}
                    rows={3}
                    spellCheck={false}
                    placeholder={'npm install'} />
        </Field>

        <Field
          label="Post-start commands (bash)"
          hint={
            <>
              Runs on every container start (baked into <code className="text-ink-faint font-mono">start.sh</code>). Enabling it on an older image rebuilds it once so the hook is baked in.
            </>
          }
        >
          <Textarea mono className="bg-raised" value={postStartDraft}
                    onChange={(e) => { setPostStartDraft(e.target.value); setPostStartDirty(true) }}
                    rows={3}
                    spellCheck={false}
                    placeholder={'service cron start'} />
        </Field>

        <Field
          label="Post-attach commands (bash)"
          hint="Runs on every terminal attach inside this PAD (workspace/project mounted). No image change needed."
        >
          <Textarea mono className="bg-raised" value={postAttachDraft}
                    onChange={(e) => { setPostAttachDraft(e.target.value); setPostAttachDirty(true) }}
                    rows={3}
                    spellCheck={false}
                    placeholder={'echo "attached"'} />
        </Field>

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleBuildPostCreateSave}
            disabled={saving || (!buildDirty && !postCreateDirty && !postStartDirty && !postAttachDirty)}
          >
            Apply &amp; recreate
          </Button>
          {(buildDirty || postCreateDirty || postStartDirty || postAttachDirty) && !saving && (
            <span className="text-xs text-ink-dim">Unsaved build/lifecycle changes</span>
          )}
        </div>
      </div>
    </Card>
  )
}
