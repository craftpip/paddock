import { useCallback, useState, useRef, useEffect, useLayoutEffect } from 'react'
import { useNavigation } from '../../lib/navigation'
import { parsePopups } from '../../lib/url-state'
import { useSearchParams } from 'react-router-dom'
import { api, getCsrfToken } from '../../lib/api'
import { useConfirm } from '../../lib/confirm'
import WorkspaceToolbar from './WorkspaceToolbar'
import PromptModal from '../../components/PromptModal'
import Button from '../../components/ui/Button'
import Badge from '../../components/ui/Badge'
import FileViewer from '../../components/FileViewer'

export default function WorkspaceTab({ agent }) {
  const { location, openPopup, closePopup, patch } = useNavigation()
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

  // The viewer itself is the shared FileViewer; this tab only says where the
  // file lives (agent, scope, path) and how to load, save and download it.
  // The draft key (`file:<agent>:<scope>:<path>`) is unchanged, so an unsaved
  // edit from before survives.
  const filePath = filePopup?.args[0] || ''
  const fileIdentity = (l) => `${l.pathname}:${new URLSearchParams(l.search).get('scope') || scope}:${parsePopups(l.search, l.pathname).find((p) => p.type === 'file')?.value || ''}`
  const fileSource = filePath ? {
    key: `${agent.name}:${scope}:${filePath}`,
    name: filePath.split('/').pop(),
    downloadUrl: `/api/agents/${agent.name}/workspace/download?path=${encodeURIComponent(filePath)}&scope=${scope}`,
    load: async () => {
      const name = filePath.split('/').pop()
      const media = mediaTypeOf(name)
      // Revalidate even media links using the authorized listing endpoint.
      const d = media
        ? await api(`/api/agents/${agent.name}/workspace?path=${encodeURIComponent(filePath.split('/').slice(0, -1).join('/') || '/')}&scope=${scope}`)
        : await api(`/api/agents/${agent.name}/workspace/file?path=${encodeURIComponent(filePath)}&scope=${scope}`)
      if (d.error) throw { error: d.error }
      if (media && !(d.entries || []).some((e) => e.name === name)) throw { error: 'File not found' }
      return media
        ? { name, path: filePath, media, mediaUrl: `/api/agents/${agent.name}/workspace/media?path=${encodeURIComponent(filePath)}&scope=${scope}` }
        : { ...d, path: filePath }
    },
    save: async (content) => {
      await api(`/api/agents/${agent.name}/workspace/save`, { method: 'POST', body: { path: filePath, content, scope } })
      return {}
    },
  } : null

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

      {fileSource && (
        <FileViewer source={fileSource} identity={fileIdentity} onClose={() => closePopup()} onError={setError} />
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
