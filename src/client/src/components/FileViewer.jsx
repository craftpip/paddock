import { useCallback, useEffect, useRef, useState } from 'react'
import { useDirtyNavigation, useNavigation } from '../lib/navigation'
import { useConfirm } from '../lib/confirm'
import Button from './ui/Button'
import { Textarea } from './ui/Input'
import Modal from './ui/Modal'

/**
 * The app's one file viewer/editor (it began as the Workspace tab's modal).
 * The caller owns WHERE the file lives; this owns how it is shown and edited.
 *
 *   <FileViewer
 *     source={{
 *       key,                         // stable identity of this file (draft + guard key)
 *       load: async () => ({ name, content, size?, size_hr?, revision?,
 *                            media?: 'image'|'video', mediaUrl?, unavailable? }),
 *       save: async (content, loaded) => ({ revision? }),   // omit = read-only
 *       downloadUrl?,                // shows a Download link
 *       subtitle?,                   // e.g. the project, under the name
 *     }}
 *     identity={(location) => '…'}   // same value while the file stays open
 *     onClose={() => …}
 *     onError={(message) => …}       // optional: also surface a load/save error elsewhere
 *   />
 *
 *  Behaviour every caller gets: unsaved edits are kept as a navigation draft
 *  (so a reload or a popup swap does not lose them) and guarded on navigation;
 *  `.json` is validated before saving; a save that the source refuses with
 *  `code: '…_conflict'` keeps your text and offers Reload (the file changed
 *  underneath — e.g. the agent edited its plan); binary content is read-only.
 */
export default function FileViewer({ source, identity, onClose, onError }) {
  const { drafts } = useNavigation()
  const confirm = useConfirm()
  const [file, setFile] = useState(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState('') // JSON error, save refusal or conflict
  const [conflict, setConflict] = useState(false)
  const draftKey = `file:${source.key}`
  const live = useRef(true)
  const latest = useRef(null)
  latest.current = { key: source.key, content: file?.content }

  useDirtyNavigation(dirty, identity, () => { drafts.delete(draftKey); setDirty(false) })

  const load = useCallback(async ({ keepDraft = true } = {}) => {
    setProblem('')
    setConflict(false)
    try {
      const d = await source.load()
      if (!live.current) return
      const draft = keepDraft && !d.media ? drafts.get(draftKey) : undefined
      setFile({ ...d, content: draft ?? d.content })
      setDirty(draft !== undefined && draft !== d.content)
    } catch (e) {
      if (!live.current) return
      const message = e?.error || e?.message || 'Failed to load file'
      onError?.(message)
      setFile({ name: source.name || '', unavailable: true, content: message })
      setDirty(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.key])

  useEffect(() => {
    live.current = true
    setFile(null)
    setDirty(false)
    load()
    return () => { live.current = false }
  }, [load])

  const name = file?.name || source.name || ''
  const ext = '.' + (name.split('.').pop() || '').toLowerCase()
  const editable = !!file && !!source.save && !file.unavailable && !file.media && !/[\u0000]/.test((file.content || '').slice(0, 4096))

  async function save() {
    if (!file || !editable || saving) return
    const content = file.content
    if (ext === '.json') {
      try { JSON.parse(content) } catch (e) { setProblem(jsonLine(content, e)); return }
    }
    setSaving(true)
    try {
      const r = await source.save(content, file)
      // The response must not clear a newer edit, or touch a different file
      // opened while it was in flight.
      if (drafts.get(draftKey) === content) drafts.delete(draftKey)
      if (latest.current?.key !== source.key || latest.current?.content !== content) return
      setFile((f) => ({ ...f, content, ...(r?.revision ? { revision: r.revision } : {}), ...(r?.size != null ? { size: r.size, size_hr: null } : {}) }))
      setDirty(false)
      setProblem('')
      setConflict(false)
      setSaved(true)
      setTimeout(() => live.current && setSaved(false), 2000)
    } catch (e) {
      const message = e?.error || e?.message || 'Save failed'
      setProblem(message)
      setConflict(/_conflict$/.test(e?.code || ''))
      onError?.(message)
    } finally {
      if (live.current) setSaving(false)
    }
  }

  async function reload() {
    if (dirty && !(await confirm({ title: 'Reload this file?', message: 'Your unsaved edits will be replaced by the version on disk.', confirmText: 'Reload', danger: true }))) return
    drafts.delete(draftKey)
    setDirty(false)
    await load({ keepDraft: false })
  }

  // Ctrl/Cmd+S saves while the editor is open.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const sizeText = file ? (file.size_hr || (file.size != null ? file.size + ' bytes' : '')) : ''
  return (
    <Modal
      open
      onClose={onClose}
      z="z-[60]"
      width="w-[80vw] max-w-[900px]"
      panelClassName="file-viewer h-[80vh]"
      divided
      className="flex-1 min-h-0 overflow-hidden p-4"
      title={
        <span className="flex min-w-0 items-center gap-3">
          <span className="text-ink-faint">📄</span>
          <span className="min-w-0">
            <span className="file-viewer-name block truncate text-sm font-medium text-ink">{name || 'Loading…'}</span>
            {source.subtitle && <span className="block truncate font-mono text-[11px] font-normal text-ink-faint">{source.subtitle}</span>}
          </span>
          <span className="shrink-0 text-xs font-normal text-ink-dim">
            {[sizeText, ext.length > 1 ? ext.slice(1).toUpperCase() : ''].filter(Boolean).join(' · ')}
          </span>
          {editable && (
            <span className={`file-viewer-state ml-2 shrink-0 text-xs font-normal ${problem ? 'text-danger' : saved ? 'text-success' : dirty ? 'text-warning' : 'text-ink-dim'}`}>
              {problem ? '' : saved ? 'Saved' : dirty ? 'Unsaved' : ''}
            </span>
          )}
          {file && !editable && !file.media && !file.unavailable && (
            <span className="ml-2 shrink-0 text-xs font-normal text-ink-dim">{source.save ? 'Binary file — read-only' : 'Read-only'}</span>
          )}
        </span>
      }
      headerExtra={
        <div className="flex items-center gap-2">
          {editable && (
            <Button variant="primary" size="md" disabled={saving} onClick={save} className="file-viewer-save" title="Save (Ctrl+S)">
              {saving ? 'Saving…' : 'Save'}
            </Button>
          )}
          {source.downloadUrl && (
            // An anchor, not a button: the browser owns the download.
            <a href={source.downloadUrl} className="rounded-control bg-raised px-3 py-2 text-sm text-ink transition-colors hover:bg-raised-hover" download>Download</a>
          )}
          <Button variant="secondary" size="md" onClick={onClose} className="file-viewer-close">Close</Button>
        </div>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        {problem && (
          <div className={`file-viewer-problem flex shrink-0 items-center gap-2 rounded-control px-3 py-2 text-xs ${conflict ? 'bg-warning-soft text-warning' : 'bg-danger/10 text-danger'}`}>
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{problem}</span>
            {conflict && <Button variant="secondary" size="bare" onClick={reload} className="file-viewer-reload shrink-0 px-2 py-1 text-[11px]">Reload</Button>}
          </div>
        )}
        {!file ? (
          <p className="text-xs text-ink-faint">Loading…</p>
        ) : file.media === 'image' ? (
          <div className="flex h-full w-full items-center justify-center">
            <img src={file.mediaUrl} alt={name} className="max-h-full max-w-full rounded-lg object-contain" />
          </div>
        ) : file.media === 'video' ? (
          <div className="flex h-full w-full items-center justify-center">
            <video src={file.mediaUrl} controls autoPlay className="max-h-full max-w-full rounded-lg" />
          </div>
        ) : editable ? (
          <Textarea
            id="file-editor"
            mono
            value={file.content}
            onChange={(e) => { const v = e.target.value; drafts.set(draftKey, v); setFile((f) => ({ ...f, content: v })); setDirty(true); setSaved(false); if (!conflict) setProblem('') }}
            className="file-viewer-editor min-h-0 flex-1 resize-none"
          />
        ) : (
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap font-mono text-xs text-ink-muted">{file.content}</pre>
        )}
      </div>
    </Modal>
  )
}

function jsonLine(content, error) {
  const match = error.message.match(/position\s+(\d+)/i)
  if (!match) return error.message
  const lines = content.substring(0, parseInt(match[1], 10)).split('\n')
  return 'Line ' + lines.length + ': ' + error.message
}
