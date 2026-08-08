import { useEffect, useRef, useState } from 'react'

/**
 * Workspace toolbar — a single navigation row.
 *
 * The "+" button (left of "Workspace folder") opens a popup to create a
 * file/folder (single input, dot-based auto-detect) or upload a file, folder
 * or dragged-in files/folders. Upload progress renders as an ephemeral second
 * row that disappears when done, leaving the one-row toolbar behind.
 */
export default function WorkspaceToolbar({
  agentName,
  scope,
  path,
  pathDraft,
  setPathDraft,
  pathInputRef,
  containerAvailable,
  hostBrowsable = true,
  isNavRoot,
  onSwitchScope,
  onGoUp,
  onGo,
  onHome,
  onCreate,
  onUpload,
  uploading,
  uploadPct,
}) {
  const [open, setOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [anchor, setAnchor] = useState(null)
  const wrapRef = useRef(null)
  const btnRef = useRef(null)
  const createInputRef = useRef(null)
  const fileInputRef = useRef(null)
  const folderInputRef = useRef(null)

  function toggle() {
    const next = !open
    setOpen(next)
    if (next) {
      setAnchor(btnRef.current?.getBoundingClientRect() || null)
      setCreateName('')
    }
  }

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    function onDoc(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false)
    }
    function onKey(e) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) createInputRef.current?.focus()
  }, [open])

  function submitCreate(e) {
    e.preventDefault()
    if (!createName.trim()) return
    onCreate(createName.trim())
    setCreateName('')
    setOpen(false)
  }

  function pickFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    onUpload(files.map((f) => ({ file: f, relPath: f.name })))
  }

  function pickFolder(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    if (!files.length) return
    onUpload(files.map((f) => ({ file: f, relPath: f.webkitRelativePath || f.name })))
  }

  // Walk dropped items; directories (webkitGetAsEntry) are walked recursively.
  async function collectDropped(dataTransfer) {
    const entries = Array.from(dataTransfer.items || [])
      .map((it) => it.webkitGetAsEntry?.())
      .filter(Boolean)
    const out = []
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const file = await new Promise((resolve) => entry.file(resolve))
        out.push({ file, relPath: prefix ? `${prefix}/${entry.name}` : entry.name })
      } else if (entry.isDirectory) {
        const reader = entry.createReader()
        const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name
        let batch = await new Promise((resolve) => reader.readEntries(resolve))
        while (batch.length) {
          for (const child of batch) await walk(child, nextPrefix)
          batch = await new Promise((resolve) => reader.readEntries(resolve))
        }
      }
    }
    for (const entry of entries) await walk(entry, '')
    return out
  }

  async function handleDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    let items = []
    const dt = e.dataTransfer
    if (dt?.items?.length && typeof dt.items[0].webkitGetAsEntry === 'function') {
      items = await collectDropped(dt)
    } else {
      items = Array.from(dt?.files || []).map((f) => ({ file: f, relPath: f.name }))
    }
    if (items.length) {
      setOpen(false)
      onUpload(items)
    }
  }

  return (
    <div className="rounded-lg bg-panel p-1.5 w-full mb-2" title="Browse (Container/Host), create files/folders, or upload">
      {/* Row 1 — navigation */}
      <div ref={wrapRef} className="flex items-center gap-1.5 min-w-0">
        <div className="flex items-center rounded-md bg-sunken/60 p-0.5 shrink-0">
          <button onClick={() => onSwitchScope('container')} disabled={!containerAvailable}
                  className={`inline-flex items-center h-7 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${scope === 'container' ? 'bg-accent text-accent-ink' : 'text-ink-muted hover:text-ink'} ${!containerAvailable ? 'opacity-40 cursor-not-allowed' : ''}`}>
            Container
          </button>
          {hostBrowsable && (
            <button onClick={() => onSwitchScope('host')}
                    className={`inline-flex items-center h-7 px-3 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${scope === 'host' ? 'bg-accent text-accent-ink' : 'text-ink-muted hover:text-ink'}`}>
              Host
            </button>
          )}
        </div>
        <span className="w-px h-7 bg-raised mx-0.5 shrink-0" />
        <button onClick={onGoUp} disabled={isNavRoot}
                title="Go up one level"
                className="flex items-center justify-center w-7 h-7 rounded-md text-ink-faint hover:text-ink hover:bg-raised disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors shrink-0">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" /></svg>
        </button>
        <form onSubmit={(e) => { e.preventDefault(); onGo(pathDraft) }}
              className="flex flex-1 items-center gap-1.5 min-w-0 px-1">
          <svg className="w-5 h-5 text-ink-dim shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
          <input
            ref={pathInputRef}
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            spellCheck={false}
            placeholder="/"
            className="flex-1 min-w-0 bg-transparent text-xs text-ink font-mono placeholder-ink-dim focus:outline-none"
          />
          <button type="submit"
                  className="inline-flex items-center h-7 px-3 bg-accent hover:bg-accent-hover text-accent-ink rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0">
            Go
          </button>
        </form>
        <span className="w-px h-7 bg-raised mx-0.5 shrink-0" />
        <div className="flex items-center rounded-md bg-sunken/60 p-0.5 shrink-0">
          <button ref={btnRef} onClick={toggle}
                  title="Create a file/folder or upload"
                  className={`flex items-center justify-center w-7 h-7 rounded-md transition-colors shrink-0 ${open ? 'bg-accent-soft text-accent-text' : 'text-ink-muted hover:text-ink hover:bg-raised'}`}>
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button onClick={onHome}
                  title="Go to the workspace"
                  className="inline-flex items-center h-7 gap-1.5 pl-1.5 pr-3 rounded-md text-xs text-ink-muted hover:text-ink hover:bg-raised transition-colors whitespace-nowrap">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20C12 13 15 9.5 19 5" /><path d="M19 5L14.5 6.5" /><path d="M19 5L18.5 10" /></svg>
            Workspace
          </button>
        </div>

        {/* "+" popup */}
        {open && anchor && (
          <div
            className="fixed z-50 w-80 rounded-lg border border-line bg-sunken shadow-xl overflow-hidden"
            style={{ top: anchor.bottom + 6, right: Math.max(8, window.innerWidth - anchor.right) }}
          >
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line-faint">
              <span className="text-xs font-medium text-ink-muted whitespace-nowrap">New entry</span>
              <span className="text-[10px] text-ink-dim font-mono truncate">into {path}</span>
            </div>

            <form onSubmit={submitCreate} className="flex items-center gap-1.5 px-2 py-2 border-b border-line-faint"
                  title="Name with a dot (e.g. notes.md) creates a file; a name without a dot creates a folder">
              <input ref={createInputRef} type="text" value={createName} onChange={(e) => setCreateName(e.target.value)}
                     placeholder="notes.md = file · notes = folder"
                     className="flex-1 min-w-0 px-2 py-1.5 rounded-lg text-xs bg-sunken border border-line text-ink focus:border-accent-line focus:outline-none placeholder-ink-dim" />
              <button type="submit" disabled={!createName.trim()}
                      className="px-3 py-1.5 rounded-lg text-xs bg-accent hover:bg-accent-hover disabled:bg-raised disabled:text-ink-dim text-accent-ink transition-colors whitespace-nowrap">
                Create
              </button>
            </form>

            <div className="px-2 py-2 space-y-1"
                 onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true) }}
                 onDragLeave={(e) => { e.stopPropagation(); setDragOver(false) }}
                 onDrop={handleDrop}>
              <button onClick={() => fileInputRef.current?.click()}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-panel transition-colors">
                <svg className="w-4 h-4 text-ink-dim shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
                Upload file
              </button>
              <button onClick={() => folderInputRef.current?.click()}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-ink-muted hover:text-ink hover:bg-panel transition-colors">
                <svg className="w-4 h-4 text-ink-dim shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /></svg>
                Upload folder
              </button>
              <div className={`mt-1.5 px-2.5 py-3 rounded-lg border border-dashed text-center text-[11px] transition-colors ${dragOver ? 'border-accent-line bg-accent-soft text-accent-text' : 'border-line text-ink-dim'}`}>
                Drag &amp; drop files or folders here
              </div>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={pickFiles} />
              <input ref={folderInputRef} type="file" {...{ webkitdirectory: '', directory: '' }} className="hidden" onChange={pickFolder} />
            </div>
          </div>
        )}
      </div>

      {/* Row 2 — ephemeral upload progress (bar only, hides when done) */}
      {uploading && (
        <div className="mt-1.5 pt-1.5 border-t border-line/60">
          <div className="h-1.5 bg-raised rounded-full overflow-hidden">
            <div className="h-full bg-accent rounded-full transition-all" style={{ width: (uploadPct || 0) + '%' }} />
          </div>
        </div>
      )}
    </div>
  )
}
