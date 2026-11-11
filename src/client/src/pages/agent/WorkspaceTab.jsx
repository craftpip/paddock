import { useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useNavigation, useDirtyNavigation } from '../../lib/navigation'
import { parsePopups } from '../../lib/url-state'
import { useSearchParams } from 'react-router-dom'
import { api, getCsrfToken } from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import WorkspaceToolbar from './WorkspaceToolbar'
import PromptModal from '../../components/PromptModal'
import Button from '../../components/ui/Button'
import { Textarea } from '../../components/ui/Input'
import Badge from '../../components/ui/Badge'
import Modal from '../../components/ui/Modal'

export default function WorkspaceTab({ agent }) {
  const { location, openPopup, closePopup, patch, drafts } = useNavigation()
  const stack = parsePopups(location.search, location.pathname)
  const filePopup = stack.find((p) => p.type === 'file')
  const movePopup = stack.find((p) => p.type === 'file-move')
  const confirm = useConfirm()
  const [searchParams] = useSearchParams()
  const normalizePath = (p) => {
    if (!p) return '/'
    const clean = String(p).replace(/\/+/g, '/').replace(/\/+$/, '')
    return clean || '/'
  }
  const containerAvailable = agent.status === 'running'
  // Host scope starts wherever the SERVER says host scope starts. For most pads
  // that is the data dir (`workspace_root`), but a pad that mounted a workspace
  // elsewhere browses that folder instead, and the server moved the root to
  // `host_browse_root` when it granted it. Deriving it here from
  // `workspace_root` made the browser show the data dir while every write went
  // to the mounted workspace — a client disagreeing with the gate about which
  // folder "the host" is, which is the same split that produces a refusal on
  // one surface and a success on the other.
  const hostRoot = normalizePath(agent.host_browse_root || agent.workspace_root || `/workspace/instances/${agent.name}/openclaw`)
  // Container-side roots come from the agent driver (data_dir = data dir,
  // workspace_dir = the workspace inside it).
  const containerRoot = normalizePath(agent.data_dir || '/root/.openclaw')
  const workspaceDir = normalizePath(agent.workspace_dir || `${containerRoot}/workspace`)
  // The host instance dir and the container data dir are the same folder (bind
  // mount), so a host path maps 1:1 onto a container path and back again.
  const hostToContainer = (p) => {
    if (!p || p === hostRoot) return containerRoot
    if (p.startsWith(hostRoot + '/')) return normalizePath(containerRoot + p.slice(hostRoot.length))
    return containerRoot
  }
  const containerToHost = (p) => {
    if (!p || p === containerRoot) return hostRoot
    if (p.startsWith(containerRoot + '/')) return normalizePath(hostRoot + p.slice(containerRoot.length))
    return hostRoot
  }

  // Custom workspace mounts can be outside the webui's reach (hostBrowsable
  // false) — then the Host scope is unavailable entirely, and when the
  // container is down there is nothing to browse at all.
  const wsMount = agent.workspace_mount
  const hostBrowsable = !wsMount || wsMount.hostBrowsable
  const wsBrowseBlocked = !hostBrowsable && !containerAvailable

  // Scope and path live in the URL (?scope=container|host&path=...) so the
  // browser back/forward buttons step through the workspace history and the
  // current folder is shareable/restorable.
  const urlScope = searchParams.get('scope')
  const urlPath = searchParams.get('path')
  let scope = urlScope === 'host' || urlScope === 'container' ? urlScope : null
  let path = urlPath ? normalizePath(urlPath) : null
  if (wsBrowseBlocked) {
    scope = 'container'
    path = path || containerRoot
  } else {
    if (!hostBrowsable && containerAvailable && scope === 'host') scope = 'container'
    if (!containerAvailable) {
      // Container is down: force host scope and mirror the container folder to
      // the matching host folder so we never leave a dead container listing up.
      if (scope === 'container') path = containerToHost(path)
      scope = 'host'
    }
    if (!scope) scope = containerAvailable ? 'container' : 'host'
    if (!path) path = scope === 'container' ? containerRoot : hostRoot
    if (scope === 'container' && !path.startsWith('/')) path = containerRoot
    if (scope === 'host' && path !== hostRoot && !path.startsWith(hostRoot + '/')) path = hostRoot
  }

  const navigateWorkspace = useCallback((sc, p, { replace = false } = {}) => {
    patch({ scope: sc, path: p }, { replace })
  }, [patch])
  const [pathDraft, setPathDraft] = useState('')
  const [listing, setListing] = useState(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadPct, setUploadPct] = useState(0)
  const [fileModal, setFileModal] = useState(null)
  const moveTarget = movePopup ? { path: movePopup.args[0] } : null
  const setMoveTarget = (target) => target ? openPopup('file-move', target.path) : closePopup({ saved: true })
  const [loading, setLoading] = useState(false)
  const pathInputRef = useRef(null)
  const navScrollRef = useRef(false)
  const pathDraftRef = useRef('')
  const listingToken = useRef(0)

  const homePath = scope === 'container' ? workspaceDir : `${hostRoot}/workspace`
  const isNavRoot = scope === 'container' ? path === '/' : path === hostRoot

  const load = useCallback((p, sc) => {
    const token = ++listingToken.current
    setError('')
    setLoading(true)
    api(`/api/agents/${agent.name}/workspace?path=${encodeURIComponent(p)}&scope=${sc}`).then((d) => {
      if (token !== listingToken.current) return
      if (d.entries) {
        setListing(d)
        if (d.path && normalizePath(d.path) !== normalizePath(p)) navigateWorkspace(sc, d.path, { replace: true })
      }
      else if (d.error) setError(d.error)
    }).catch(() => { if (token === listingToken.current) setError('Failed to load workspace') })
    .finally(() => { if (token === listingToken.current) setLoading(false) })
  }, [agent.name, navigateWorkspace])

  useEffect(() => {
    if (wsBrowseBlocked) { setListing(null); setError(''); return }
    load(path, scope)
  }, [path, scope, load, wsBrowseBlocked])

  // When the container drops, rewrite the URL to host scope at the mirrored
  // folder so the browser never shows a dead container listing (and the URL
  // always reflects what is on screen). Coming back online keeps the URL as-is.
  // Non-browsable mounts have no host scope, so stay on container scope (the
  // tab shows the empty state instead).
  const prevAvailableRef = useRef(containerAvailable)
  useEffect(() => {
    const prev = prevAvailableRef.current
    prevAvailableRef.current = containerAvailable
    if (prev === containerAvailable) return
    if (!containerAvailable && hostBrowsable) navigateWorkspace('host', containerToHost(path), { replace: true })
  }, [containerAvailable, navigateWorkspace, path, hostBrowsable])
  useEffect(() => {
    pathDraftRef.current = pathDraft
  }, [pathDraft])

  useEffect(() => {
    if (pathDraftRef.current === path) {
      const el = pathInputRef.current
      if (el) el.scrollLeft = el.scrollWidth + 100
      return
    }
    setPathDraft(path)
    navScrollRef.current = true
  }, [path])

  useLayoutEffect(() => {
    if (!navScrollRef.current) return
    navScrollRef.current = false
    const el = pathInputRef.current
    if (el) el.scrollLeft = el.scrollWidth + 100
  }, [pathDraft])

  function switchScope(next) {
    if (next === scope) return
    if (next === 'host' && !hostBrowsable) return
    navigateWorkspace(next, next === 'container' ? hostToContainer(path) : containerToHost(path))
  }
  function goToDir(p) { navigateWorkspace(scope, normalizePath(p)) }
  function goUp() {
    if (isNavRoot) return
    navigateWorkspace(scope, normalizePath(path.split('/').slice(0, -1).join('/')))
  }
  function goTo(p) {
    const target = normalizePath((p || '/').trim() || '/')
    if (scope === 'host' && target !== hostRoot && !target.startsWith(hostRoot + '/')) {
      navigateWorkspace('host', hostRoot)
      return
    }
    navigateWorkspace(scope, target)
  }

  function toMsg(err) {
    const e = err?.error || err?.message || err
    if (typeof e === 'string') return e
    try { return JSON.stringify(e) } catch { return String(e) }
  }

  async function createEntry(name) {
    const n = (name || '').trim()
    if (!n) return
    // Dot in the name (e.g. "notes.md") → file, otherwise → folder.
    const isFile = n.indexOf('.') > 0
    try {
      const url = isFile
        ? `/api/agents/${agent.name}/workspace/create-file`
        : `/api/agents/${agent.name}/workspace/folder`
      await api(url, { method: 'POST', body: { path, name: n, scope } })
      load(path, scope)
    } catch (err) { setError(toMsg(err)) }
  }

  /** Upload any number of files/folders. items = [{ file, relPath }] where
   *  relPath is relative to the selected folder root (folder uploads keep
   *  their directory structure). Single upload with progress bar. */
  async function uploadItems(items) {
    if (!items.length) return
    const fd = new FormData()
    fd.append('path', path)
    fd.append('scope', scope)
    for (const it of items) {
      fd.append('files', it.file, it.relPath)
      fd.append('paths', it.relPath)
    }
    setUploading(true)
    setUploadPct(0)
    setError('')
    try {
      const xhr = new XMLHttpRequest()
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100))
      })
      const result = await new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try { resolve(JSON.parse(xhr.responseText)) } catch { resolve({}) }
          } else {
            let msg = 'Upload failed'
            try { const d = JSON.parse(xhr.responseText); if (d.error) msg = d.error } catch {}
            reject(new Error(msg))
          }
        }
        xhr.onerror = () => reject(new Error('Upload failed'))
        xhr.open('POST', `/api/agents/${agent.name}/workspace/upload-multiple`)
        xhr.setRequestHeader('X-CSRF-Token', getCsrfToken() || '')
        xhr.send(fd)
      })
      setUploading(false)
      load(path, scope)
    } catch (err) {
      setError(err.message || 'Upload failed')
      setUploading(false)
    }
  }

  async function renameEntry(entryPath) {
    setMoveTarget({ path: entryPath })
  }

  async function doMove(newPath) {
    if (!moveTarget) return
    const src = moveTarget.path
    const dst = normalizePath(newPath)
    if (!dst || dst === src) { setMoveTarget(null); return }
    try {
      await api(`/api/agents/${agent.name}/workspace/move`, { method: 'POST', body: { path: src, to: dst, scope } })
      patch({ popup: null }, { replace: true, saved: true, expectedPopup: movePopup?.value })
      load(path, scope)
    } catch (err) { setError(toMsg(err)) }
  }

  async function deleteEntry(entryPath, entryName) {
    const ok = await confirm({
      title: 'Delete file',
      message: `Delete "${entryName}"? This cannot be undone.`,
      danger: true,
      confirmText: 'Delete',
    })
    if (!ok) return
    try {
      await api(`/api/agents/${agent.name}/workspace/delete`, { method: 'POST', body: { path: entryPath, scope } })
      load(path, scope)
    } catch (err) { setError(toMsg(err)) }
  }

  const MEDIA_IMAGE = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif']
  const MEDIA_VIDEO = ['mp4', 'webm', 'ogv', 'mov']
  function mediaTypeOf(name) {
    const ext = (name || '').split('.').pop()?.toLowerCase()
    if (MEDIA_IMAGE.includes(ext)) return 'image'
    if (MEDIA_VIDEO.includes(ext)) return 'video'
    return null
  }

  function openFile(entry, entryPath) { openPopup('file', entryPath) }

  const [fileDirty, setFileDirty] = useState(false)
  const [fileSaved, setFileSaved] = useState(false)
  const [jsonError, setJsonError] = useState('')
  const fileKey = `file:${agent.name}:${scope}:${filePopup?.args[0] || ''}`
  const activeFile = useRef(null)
  activeFile.current = { key: fileKey, content: fileModal?.content }
  const fileIdentity = (l) => `${l.pathname}:${new URLSearchParams(l.search).get('scope') || scope}:${parsePopups(l.search, l.pathname).find((p) => p.type === 'file')?.value || ''}`
  useDirtyNavigation(fileDirty, fileIdentity, () => { drafts.delete(fileKey); setFileDirty(false) })
  useEffect(() => {
    let live = true
    setFileModal(null)
    setFileDirty(false)
    if (!filePopup) return
    const entryPath = filePopup.args[0]
    const loadFile = async () => {
      try {
        const media = mediaTypeOf(entryPath.split('/').pop())
        // Revalidate even media links using the authorized listing endpoint.
        const d = media
          ? await api(`/api/agents/${agent.name}/workspace?path=${encodeURIComponent(entryPath.split('/').slice(0, -1).join('/') || '/')}&scope=${scope}`)
          : await api(`/api/agents/${agent.name}/workspace/file?path=${encodeURIComponent(entryPath)}&scope=${scope}`)
        if (!live) return
        if (d.error) throw { error: d.error }
        if (media && !(d.entries || []).some((e) => e.name === entryPath.split('/').pop())) throw { error: 'File not found' }
        const draft = drafts.get(fileKey)
        setFileModal(media
          ? { name: entryPath.split('/').pop(), path: entryPath, media, mediaUrl: `/api/agents/${agent.name}/workspace/media?path=${encodeURIComponent(entryPath)}&scope=${scope}` }
          : { ...d, path: entryPath, content: draft ?? d.content })
        setFileDirty(!media && draft !== undefined && draft !== d.content)
      } catch (e) {
        if (live) {
          const message = e?.error || e?.message || 'Failed to load file'
          setError(message)
          setFileModal({ name: entryPath.split('/').pop(), path: entryPath, unavailable: true, content: message })
        }
      }
    }
    loadFile()
    return () => { live = false }
  }, [filePopup?.value, agent.name, scope])

  function getJsonLine(content, error) {
    const match = error.message.match(/position\s+(\d+)/i)
    if (!match) return error.message
    const pos = parseInt(match[1])
    const lines = content.substring(0, pos).split('\n')
    return 'Line ' + lines.length + ': ' + error.message
  }

  async function saveFile() {
    if (!fileModal) return
    const textarea = document.getElementById('file-editor')
    if (!textarea) return
    const content = textarea.value
    const ext = '.' + (fileModal.name || '').split('.').pop()?.toLowerCase()
    if (ext === '.json') {
      try { JSON.parse(content); setJsonError('') }
      catch (e) { setJsonError(getJsonLine(content, e)); return }
    }
    try {
      await api(`/api/agents/${agent.name}/workspace/save`, { method: 'POST', body: { path: fileModal.path || fileModal.name, content, scope } })
      // The write was explicit, but its response must not clear a newer edit or
      // replace a different file selected while it was in flight.
      if (drafts.get(fileKey) === content) drafts.delete(fileKey)
      if (activeFile.current?.key !== fileKey || activeFile.current?.content !== content) return
      setFileModal({ ...fileModal, content })
      setFileDirty(false)
      setFileSaved(true)
      setTimeout(() => setFileSaved(false), 2000)
    } catch (err) { setError(toMsg(err)) }
  }

  async function closeFileModal() {
    closePopup()
  }

  const ext = fileModal ? '.' + (fileModal.name || '').split('.').pop()?.toLowerCase() : ''
  const editable = !!fileModal && !fileModal.unavailable && !fileModal.media && !/[\u0000]/.test((fileModal.content || '').slice(0, 4096))

  // No window Escape listener here any more: Modal owns Escape and routes it to
  // onClose (= closeFileModal). Leaving both in place would call closeFileModal
  // twice on one keypress, and with unsaved changes that is two stacked
  // "Discard changes" confirms.

  return (
    <div>
      {wsBrowseBlocked ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <svg className="w-10 h-10 text-ink-dim mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" /></svg>
          <p className="text-sm text-ink-faint max-w-md leading-relaxed">
            This agent's workspace is mounted from a folder outside the webui's reach, and the container is not running, so there's nothing to browse right now.
          </p>
          <p className="text-xs text-ink-dim mt-2 max-w-md leading-relaxed">
            Start the agent to access its container workspace at <code className="font-mono">{containerRoot}</code>.
          </p>
        </div>
      ) : (
        <>
      {/* Container down banner — pad not running, browsing from host */}
      {agent.status !== 'running' && (
        <p className="-mt-2 mb-4 text-sm text-ink-faint leading-relaxed">The pad container is not running, so the workspace is being browsed from the host. You can still access your files here.</p>
      )}

      {/* Toolbar — single navigation row; "+" popup handles create/upload */}
      <WorkspaceToolbar
        agentName={agent.name}
        scope={scope}
        path={path}
        pathDraft={pathDraft}
        setPathDraft={setPathDraft}
        pathInputRef={pathInputRef}
        containerAvailable={containerAvailable}
        hostBrowsable={hostBrowsable}
        isNavRoot={isNavRoot}
        onSwitchScope={switchScope}
        onGoUp={goUp}
        onGo={goTo}
        onHome={() => navigateWorkspace(scope, homePath)}
        onCreate={createEntry}
        onUpload={uploadItems}
        uploading={uploading}
        uploadPct={uploadPct}
      />

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      {/* Loading Spinner */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <div className="flex items-center gap-3 text-ink-faint">
            <span className="w-5 h-5 border-2 border-line-faint border-t-accent-text rounded-full animate-spin" />
            <span className="text-sm">Loading...</span>
          </div>
        </div>
      )}

      {/* File Table */}
      {listing && !loading && (
        <div className="border border-line-faint rounded-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line-faint text-left text-ink-dim">
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium w-24 hidden sm:table-cell">Size</th>
                  <th className="px-4 py-2 font-medium w-40 hidden md:table-cell">Modified</th>
                  <th className="px-4 py-2 font-medium w-32">Actions</th>
                </tr>
              </thead>
              <tbody>
                {!isNavRoot && (
                  <tr className="border-b border-line-faint/50 hover:bg-panel/30 cursor-pointer" onClick={goUp}
                      tabIndex={0} role="button" aria-label="Up one folder"
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goUp() } }}>
                    <td className="px-4 py-2 text-accent-text" colSpan={4}>&larr; Up</td>
                  </tr>
                )}
                {listing.entries?.map((entry) => {
                  const entryPath = path === '/' ? '/' + entry.name : path + '/' + entry.name
                  return (
                    <tr key={entry.name} className="border-b border-line-faint/50 hover:bg-panel/30 group">
                      {/* Reachable and operable from the keyboard: opening a file
                          or folder used to be a mouse-only click on a table cell. */}
                      <td className="px-4 py-3 cursor-pointer"
                          tabIndex={0} role="button"
                          aria-label={`${entry.type === 'directory' ? 'Open folder' : 'Open file'} ${entry.name}`}
                          onKeyDown={(e) => {
                            if (e.key !== 'Enter' && e.key !== ' ') return
                            e.preventDefault()
                            if (entry.type !== 'directory') openFile(entry, entryPath)
                            else goToDir(entryPath)
                          }}
                          onClick={() => {
                            if (entry.type !== 'directory') openFile(entry, entryPath)
                            else goToDir(entryPath)
                          }}>
                        {entry.type === 'directory' ? (
                          <span className="text-accent-text">
                            <span className="mr-1.5 text-ink-dim">📁</span>{entry.name}
                            {scope === 'container' && entry.name === 'workspace' && (
                              <Badge tone="accent" size="sm" className="ml-2 border border-accent-line/50 align-middle">
                                workspace
                              </Badge>
                            )}
                          </span>
                        ) : (
                          <span className="text-ink">
                            <span className="mr-1.5 text-ink-dim">📄</span>{entry.name}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-ink-dim hidden sm:table-cell">{entry.size_hr || entry.size || '-'}</td>
                      <td className="px-4 py-2 text-ink-dim hidden md:table-cell text-xs">{entry.modified ? new Date(entry.modified).toLocaleString() : '-'}</td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1 opacity-50 group-hover:opacity-100 transition-opacity">
                          {entry.type === 'file' && (
                            <a href={`/api/agents/${agent.name}/workspace/download?path=${encodeURIComponent(entryPath)}&scope=${scope}`}
                               className="px-2 py-1 text-xs text-ink-faint hover:text-ink hover:bg-raised rounded-control transition-colors" title="Download" download>DL</a>
                          )}
                          <Button variant="ghost" size="sm" onClick={() => renameEntry(entryPath)} title="Move">
                            MV
                          </Button>
                          <Button variant="dangerGhost" size="sm" onClick={() => deleteEntry(entryPath, entry.name)} title="Delete">
                            RM
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {listing.entries?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center">
                      <svg className="w-8 h-8 mx-auto mb-2 text-ink-dim" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5"><path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" /></svg>
                      <p className="text-ink-dim">Empty directory</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
        </>
      )}

      {/* File Viewer/Editor Modal.
          This is a plain backdrop+panel with no msn-* hooks, so it is the shared
          Modal now. The two header clusters map onto Modal's `title` (icon,
          name, size·ext, dirty/saved state) and `headerExtra` (Save, Download,
          Close); the editor itself is Modal's body, so `className` there is the
          body — it must carry `flex-1 min-h-0` for the panel's flex column. */}
      {fileModal && (
        <Modal
          open
          onClose={closeFileModal}
          z="z-[60]"
          width="w-[80vw] max-w-[900px]"
          panelClassName="h-[80vh]"
          divided
          className="flex-1 min-h-0 overflow-hidden p-4"
          title={
            <span className="flex items-center gap-3 min-w-0">
              <span className="text-ink-faint">📄</span>
              <span className="text-sm font-medium text-ink truncate">{fileModal.name}</span>
              <span className="text-xs font-normal text-ink-dim">
                {fileModal.size_hr || (fileModal.size != null ? fileModal.size + ' bytes' : '')} · {ext.replace('.', '').toUpperCase()}
              </span>
              {editable && (
                <span className={`text-xs font-normal ml-2 ${jsonError ? 'text-danger' : fileSaved ? 'text-success' : fileDirty ? 'text-warning' : 'text-ink-dim'}`}>
                  {jsonError || (fileSaved ? 'Saved' : fileDirty ? 'Unsaved' : '')}
                </span>
              )}
              {!editable && !fileModal.media && !fileModal.unavailable && (
                <span className="text-xs font-normal text-ink-dim ml-2">Binary file — read-only</span>
              )}
            </span>
          }
          headerExtra={
            <div className="flex items-center gap-2">
              {editable && (
                <Button variant="primary" size="md" onClick={saveFile}>
                  Save
                </Button>
              )}
              {/* An anchor, not a button: the browser owns the download, so it
                  stays an <a download> — only the radius is tokenised. */}
              <a href={`/api/agents/${agent.name}/workspace/download?path=${encodeURIComponent(fileModal.path || fileModal.name)}&scope=${scope}`}
                 className="px-3 py-2 bg-raised hover:bg-raised-hover text-ink rounded-control text-sm transition-colors" download>Download</a>
              <Button variant="secondary" size="md" onClick={closeFileModal}>
                Close
              </Button>
            </div>
          }
        >
          {fileModal.media === 'image' ? (
            <div className="w-full h-full flex items-center justify-center">
              <img src={fileModal.mediaUrl} alt={fileModal.name} className="max-w-full max-h-full object-contain rounded-lg" />
            </div>
          ) : fileModal.media === 'video' ? (
            <div className="w-full h-full flex items-center justify-center">
              <video src={fileModal.mediaUrl} controls autoPlay className="max-w-full max-h-full rounded-lg" />
            </div>
          ) : editable ? (
            /* id="file-editor" is load-bearing: saveFile() reads the textarea
               through document.getElementById, not through a ref. */
            <Textarea
              id="file-editor"
              mono
              value={fileModal.content}
              onChange={(e) => { drafts.set(fileKey, e.target.value); setFileModal({ ...fileModal, content: e.target.value }); setFileDirty(true); setFileSaved(false); setJsonError('') }}
              className="h-full resize-none"
              style={{ minHeight: '100%' }}
            />
          ) : (
            <pre className="text-xs text-ink-muted font-mono whitespace-pre-wrap">{fileModal.content}</pre>
          )}
        </Modal>
      )}

      {moveTarget && (
        <PromptModal
          z="z-[75]"
          title="Move"
          message={`Current location:\n${moveTarget.path}`}
          initialValue={moveTarget.path}
          confirmText="Move"
          onCancel={() => setMoveTarget(null)}
          onSubmit={(value) => doMove(value)}
        />
      )}
    </div>
  )
}
