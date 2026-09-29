const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const registry = require('./agent-registry');
const { ensureOwned } = require('./ownership');

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB

// Human-readable byte size ("313.4 MB") for the workspace file table.
function humanSize(n) {
  if (n == null || isNaN(n) || n < 0) return null;
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / Math.pow(1024, i);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + units[i];
}

// The pad container's OpenClaw data dir (agent's workspace inside the pad).
const CONTAINER_DATA_DIR = '/root/.openclaw';

// Resolves a path for HOST scope (browsing the paddock/management container).
// The user is restricted to this pad's workspace only — any path above
// workspaceRoot is clamped back to it, so other pads under
// /workspace/instances/ can never be reached.
function resolveHostPath(workspaceRoot, relativePath) {
  const raw = (relativePath || '/').trim();
  if (raw.startsWith('/')) {
    const normalized = path.normalize(raw);
    if (!normalized.startsWith('/')) throw new Error('Invalid path');
    if (normalized.includes('\0')) throw new Error('Invalid path');
    if (normalized !== workspaceRoot && !normalized.startsWith(workspaceRoot + path.sep)) {
      return workspaceRoot;
    }
    return normalized;
  }
  // Legacy relative paths still resolve under the workspace root.
  const cleaned = path.normalize(raw).replace(/^\/+/, '');
  const resolved = path.resolve(workspaceRoot, cleaned);
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new Error('Path traversal rejected');
  }
  return resolved;
}

function resolveSafePath(workspaceRoot, relativePath) {
  const raw = (relativePath || '/').trim();
  if (raw.includes('\0')) throw new Error('Invalid path');
  // Decode %XX before resolving so encoded traversal (`foo%2F..%2F..`) is
  // caught by the same checks as the plain form.
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new Error('Invalid path');
  }
  if (decoded.startsWith('/')) {
    // '/' (and empty) mean "the workspace root itself"; any other absolute
    // path is outside the workspace and rejected outright.
    if (decoded === '/' || decoded === '') return workspaceRoot;
    throw new Error('Path traversal rejected');
  }
  const cleaned = path.normalize(decoded).replace(/^\/+/, '');
  const resolved = path.resolve(workspaceRoot, cleaned);
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new Error('Path traversal rejected');
  }
  return resolved;
}

// ─── Container scope ────────────────────────────────────────────────────────
// Browsing the PAD container itself. Unrestricted — the pad only contains its
// own filesystem, so other pads are unreachable anyway. Operations run through
// `docker exec <pad> node -e "<helper>"` with the payload as JSON on stdin
// (no shell escaping of user paths needed).

/**
 * Source of the in-container history reader, injected into CONTAINER_HELPER
 * below. String.raw so every backslash reaches the PAD's node exactly as
 * written — a plain template literal would turn `\n` into a real newline and
 * break the inner script.
 *
 * The agent's OWN past conversations — the history that already lives in the
 * PAD, NOT the `mission_sessions` rows. Each coding agent stores its history
 * somewhere different and nothing exposes it uniformly, so this reads the store
 * directly and returns one common shape:
 *
 *   opencode — the `session` table of opencode.db (id/title/directory/time_*).
 *     The CLI (`opencode session list`) blocks behind a running TUI's lock and
 *     re-bootstraps the instance, so the table is the safe read, and
 *     `directory` is what scopes a conversation to a folder.
 *   codex    — one `rollout-*.jsonl` per conversation: line 1 is session_meta
 *     (session_id + cwd) and the first role=user response_item is the title.
 *     The CLI has no list command — the picker IS the list.
 *   claude   — one `.jsonl` per conversation under ~/.claude/projects/.
 *
 * Rows are filtered in JS, never in SQL: the folder is user-supplied and the
 * whole table is at most a few thousand rows.
 */
const AGENT_SESSIONS_FN = String.raw`
function agentSessions(q) {
  const type = q.type;
  const folder = String(q.folder || '').replace(/\/+$/, '');
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
  const iso = (v) => (v == null ? null : new Date(Number(v)).toISOString());
  const none = (reason) => ({ source: type, available: false, reason, exact: [], subfolders: [] });

  // Read the head of a jsonl without loading the whole rollout: these files get
  // large and the meta + first user message are at the top.
  const headLines = (file, max) => {
    const fd = fs.openSync(file, 'r');
    try {
      const size = Math.min(fs.fstatSync(fd).size, 128 * 1024);
      const buf = Buffer.alloc(size);
      fs.readSync(fd, buf, 0, size, 0);
      return buf.toString('utf8').split('\n').slice(0, max).filter(Boolean);
    } finally { fs.closeSync(fd); }
  };
  const firstUserText = (lines) => {
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch (e) { continue; }
      const p = o && o.payload;
      if (!p || (p.role !== 'user' && p.type !== 'user_message')) continue;
      let txt = '';
      if (typeof p.content === 'string') txt = p.content;
      else if (Array.isArray(p.content)) txt = p.content.map((c) => (c && (c.text || c.input_text)) || '').join(' ');
      else if (typeof p.message === 'string') txt = p.message;
      txt = txt.replace(/\s+/g, ' ').trim();
      // codex opens every session with a synthetic <environment_context> blob,
      // not a prompt from the human — that is not a title.
      if (!txt || txt.startsWith('<environment_context')) continue;
      return txt.slice(0, 120);
    }
    return '';
  };
  const walk = (dir, depth, acc) => {
    if (depth > 6) return;
    let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp, depth + 1, acc);
      else if (e.name.endsWith('.jsonl')) acc.push(fp);
    }
  };

  let rows = [];
  if (type === 'opencode') {
    const db = '/root/.opencode/data/opencode/opencode.db';
    if (!fs.existsSync(db)) return none('no-store');
    const sql = 'SELECT id,title,directory,time_created,time_updated FROM session ORDER BY time_updated DESC';
    let raw = '';
    try { raw = cp.execFileSync('sqlite3', ['-json', db, sql], { maxBuffer: 256 * 1024 * 1024 }).toString(); }
    catch (e) { return { source: type, available: false, reason: 'sqlite-failed', error: e.message, exact: [], subfolders: [] }; }
    const all = raw.trim() ? JSON.parse(raw) : [];
    rows = all.map((r) => ({
      id: r.id,
      title: r.title || '(untitled)',
      directory: r.directory || '',
      createdAt: iso(r.time_created),
      updatedAt: iso(r.time_updated),
    }));
  } else if (type === 'codex') {
    const base = '/root/.codex/sessions';
    if (!fs.existsSync(base)) return none('no-store');
    const files = []; walk(base, 0, files);
    for (const f of files) {
      const lines = headLines(f, 12);
      let meta = null;
      for (const l of lines) {
        try { const o = JSON.parse(l); if (o.type === 'session_meta') { meta = o.payload || {}; break; } } catch (e) {}
      }
      if (!meta) continue;
      let mtime = null;
      try { mtime = fs.statSync(f).mtimeMs; } catch (e) {}
      rows.push({
        id: meta.session_id || meta.id || path.basename(f, '.jsonl'),
        title: firstUserText(lines) || '(no prompt yet)',
        directory: meta.cwd || '',
        createdAt: meta.timestamp || iso(mtime),
        updatedAt: iso(mtime),
      });
    }
  } else if (type === 'claude') {
    // NOT verified against a PAD that has real history (the test PAD has none)
    // — see plan 53 §8. A wrong guess yields an empty list, never a crash.
    const base = '/root/.claude/projects';
    if (!fs.existsSync(base)) return none('no-store');
    const files = []; walk(base, 0, files);
    for (const f of files) {
      let mtime = null;
      try { mtime = fs.statSync(f).mtimeMs; } catch (e) {}
      // claude mangles the cwd into the directory name: /www1/craftpip.com
      // becomes -www1-craftpip-com. A cwd in the file itself wins if present.
      const slug = path.basename(path.dirname(f));
      let dir = '/' + slug.replace(/^-/, '').split('-').join('/');
      const lines = headLines(f, 12);
      for (const l of lines) {
        try { const o = JSON.parse(l); const c = o && (o.cwd || (o.payload && o.payload.cwd)); if (c) { dir = c; break; } } catch (e) {}
      }
      rows.push({
        id: path.basename(f, '.jsonl'),
        title: firstUserText(lines) || '(no prompt yet)',
        directory: dir,
        createdAt: iso(mtime),
        updatedAt: iso(mtime),
      });
    }
  } else {
    return none('unsupported');
  }

  rows.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const inBase = (d) => (folder ? d === folder : true);
  const underBase = (d) => !!(folder && folder !== '/' && d && d.startsWith(folder + '/'));
  return {
    source: type,
    available: true,
    folder,
    total: rows.length,
    exactCount: rows.filter((r) => inBase(r.directory)).length,
    subfolderCount: rows.filter((r) => underBase(r.directory)).length,
    exact: rows.filter((r) => inBase(r.directory)).slice(0, limit),
    subfolders: rows.filter((r) => underBase(r.directory)).slice(0, limit),
  };
}`;

const CONTAINER_HELPER = `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
const fs=require('fs'),path=require('path'),cp=require('child_process');let out={};
${AGENT_SESSIONS_FN}
const hr=n=>{if(n==null||isNaN(n)||n<0)return null;if(n===0)return'0 B';const u=['B','KB','MB','GB','TB'];const i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),u.length-1);const v=n/Math.pow(1024,i);return(v>=100?v.toFixed(0):v.toFixed(1))+' '+u[i]};
try{
  const q=JSON.parse(s),p=q.path;
  const st=p=>{try{return fs.statSync(p)}catch{return null}};
  const lst=p=>{const stat=st(p);if(!stat)throw new Error('Path not found');if(!stat.isDirectory())throw new Error('Not a directory');
    return fs.readdirSync(p,{withFileTypes:true}).map(e=>{const es=st(path.join(p,e.name))||{};
      return{name:e.name,type:e.isDirectory()?'directory':'file',size:es.size||0,size_hr:hr(es.size),modified:es.mtime?new Date(es.mtime).toISOString():null};})
      .sort((a,b)=>a.type!==b.type?(a.type==='directory'?-1:1):a.name.localeCompare(b.name));};
  switch(q.op){
    case 'list':out={path:p,entries:lst(p)};break;
    case 'folders':{const stat=st(p);
      if(!stat){out={path:p,exists:false,isDir:false,entries:[]};break;}
      if(!stat.isDirectory()){out={path:p,exists:true,isDir:false,entries:[]};break;}
      out={path:p,exists:true,isDir:true,entries:fs.readdirSync(p,{withFileTypes:true})
        .filter(e=>e.isDirectory()&&!e.name.startsWith('.'))
        .map(e=>e.name).sort((a,b)=>a.localeCompare(b)).slice(0,200)};break;}
    case 'read':{const stat=st(p);if(!stat)throw new Error('File not found');if(stat.isDirectory())throw new Error('Cannot read directory');
      out={content:fs.readFileSync(p,'utf8'),size:stat.size,size_hr:hr(stat.size),modified:new Date(stat.mtime).toISOString(),name:path.basename(p)};break;}
    case 'save':{fs.writeFileSync(p,q.content||'','utf8');const stat=fs.statSync(p);
      out={ok:true,name:path.basename(p),size:Buffer.byteLength(q.content||'','utf8'),modified:new Date(stat.mtime).toISOString()};break;}
    case 'mkdir':fs.mkdirSync(path.join(p,q.name),{recursive:false});out={ok:true};break;
    case 'mkdirp':fs.mkdirSync(p,{recursive:true});out={ok:true};break;
    case 'create':fs.writeFileSync(path.join(p,q.name),'');out={ok:true};break;
    case 'rename':{const t=path.join(path.dirname(p),q.name);if(st(t))throw new Error('Name already taken');fs.renameSync(p,t);out={ok:true};break;}
    case 'move':{const dp=st(path.dirname(q.to));if(st(q.to))throw new Error('Destination already exists');if(!dp||!dp.isDirectory())throw new Error('Destination directory not found');fs.renameSync(p,q.to);out={ok:true};break;}
    case 'delete':fs.rmSync(p,{recursive:true,force:true});out={ok:true};break;
    case 'readB64':{const stat=st(p);if(!stat)throw new Error('File not found');if(stat.isDirectory())throw new Error('Cannot download directory');
      out={content:fs.readFileSync(p).toString('base64'),name:path.basename(p),size:stat.size};break;}
    case 'writeB64':fs.writeFileSync(p,Buffer.from(q.content||'','base64'));out={ok:true};break;
    case 'agentSessions':out=agentSessions(q);break;
    default:throw new Error('Unknown op');
  }
}catch(e){out={error:e.message};}
process.stdout.write(JSON.stringify(out));
});`;

function containerExec(agentName, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', agentName, 'node', '-e', CONTAINER_HELPER],
      { timeout, maxBuffer: 512 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error('Container is not running'));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('Unexpected container response')); }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function requireAgent(agentId) {
  const agent = registry.getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  return agent;
}

// The directory every host-scope operation is clamped to. It is the agent's
// data dir by default, and the workspace mount's own source for a pad that has
// opted in (meta HOST_BROWSE=1). The two must be read from ONE place: clearing
// `hostBrowsable` without moving this root produced a pad that passed the gate
// and was then rejected as a path traversal — the gate-then-act split, one
// level down.
function hostBrowseRoot(agent) {
  return agent.host_browse_root || agent.workspace_root;
}

// "Go up one level" for the host browser. When the browse root IS the workspace
// mount's own source (HOST_BROWSE=1) its parent is outside everything the
// webui mounts — /www2/paddock → /www2 — so honouring "up" there would browse
// the host filesystem beyond this project. The clamp root is the edge of what
// host scope may read, so up is clamped to it and returns the root's own
// listing instead of a directory the pad was never granted.
function hostParentDir(agent) {
  const root = hostBrowseRoot(agent);
  if (root !== agent.workspace_root) return root;
  return path.resolve(root, '..');
}

// Central host-scope authorization (plan 24). The host file browser is clamped
// to the agent's data dir on the host. A custom workspace mount whose source
// sits OUTSIDE that folder cannot be reached by the clamp — either the source
// is in another project folder (reachable by the webui but outside the clamp)
// or completely outside the webui's bind mounts. In both cases every host
// operation must be rejected up front with a clear message; container scope
// (docker exec) remains the way to browse that workspace while the agent runs.
//
// The message now carries the mount's OWN reason (plan 64 3b). The old text
// asserted one cause ("outside the agent folder") for two very different
// situations, and said nothing about a pad the webui can plainly reach — so a
// caller could not tell a policy decision from a capability limit, and the two
// need different next moves.
function requireHostBrowsable(agent) {
  const mount = agent.workspace_mount;
  if (mount && !mount.hostBrowsable) {
    throw new Error(
      `Host file browser is not available for this agent — ${mount.hostBrowseReason || 'its workspace is mounted from a folder outside the agent folder'}. ` +
      'Use the container workspace while the agent is running.'
    );
  }
  return agent;
}

function fsList(absPath) {
  if (!fs.existsSync(absPath)) return { path: absPath, entries: [] };
  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) throw new Error('Not a directory');
  const raw = fs.readdirSync(absPath, { withFileTypes: true });
  const entries = raw
    .map(e => {
      const entryPath = path.join(absPath, e.name);
      let entryStat;
      try { entryStat = fs.statSync(entryPath); } catch { entryStat = null; }
      return {
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: entryStat ? entryStat.size : 0,
        size_hr: entryStat ? humanSize(entryStat.size) : null,
        modified: entryStat ? entryStat.mtime.toISOString() : null,
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return { path: absPath, entries };
}

async function listDir(agentId, relativePath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'list', path: relativePath || '/' });
  }
  requireHostBrowsable(agent);
  return fsList(resolveHostPath(hostBrowseRoot(agent), relativePath || ''));
}

// Mission folder picker (plan 53). Unlike `listDir` this NEVER throws for a
// missing path — the dialog needs to say "Not found inside the PAD" and still
// offer the sibling folders, which is a normal state while typing. Returns
// {path, exists, isDir, entries} with dir names only, hidden entries dropped
// and the list capped at 200 inside the container helper.
async function listFolders(agentName, absPath) {
  const result = await containerExec(agentName, { op: 'folders', path: absPath || '/' });
  if (result && result.error) throw new Error(result.error);
  return result;
}

/** The agent's own conversation history, scoped to a folder (see
 *  AGENT_SESSIONS_FN). `agentType` picks the store; the folder only ever
 *  filters rows, it can never widen the read. */
async function listAgentSessions(agentName, agentType, folder, limit = 50) {
  const result = await containerExec(
    agentName,
    { op: 'agentSessions', type: agentType, folder: folder || '', limit },
    60000
  );
  if (result && result.error) throw new Error(result.error);
  return result;
}

async function readFile(agentId, relativePath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'read', path: relativePath });
  }
  requireHostBrowsable(agent);
  const absPath = resolveHostPath(hostBrowseRoot(agent), relativePath);
  if (!fs.existsSync(absPath)) throw new Error('File not found');
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error('Cannot read directory');
  return {
    content: fs.readFileSync(absPath, 'utf8'),
    size: stat.size,
    size_hr: humanSize(stat.size),
    modified: stat.mtime.toISOString(),
    name: path.basename(absPath),
  };
}

async function writeFile(agentId, relativePath, content, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'save', path: relativePath, content });
  }
  requireHostBrowsable(agent);
  const absPath = resolveHostPath(hostBrowseRoot(agent), relativePath);
  if (fs.existsSync(absPath)) {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) throw new Error('Cannot write to directory');
  }
  fs.writeFileSync(absPath, content, 'utf8');
  ensureOwned(absPath);
  return {
    name: path.basename(absPath),
    size: Buffer.byteLength(content, 'utf8'),
    modified: fs.statSync(absPath).mtime.toISOString(),
  };
}

async function readFileB64(agentId, relativePath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'readB64', path: relativePath });
  }
  requireHostBrowsable(agent);
  const absPath = resolveHostPath(hostBrowseRoot(agent), relativePath);
  if (!fs.existsSync(absPath)) throw new Error('File not found');
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error('Cannot download directory');
  return {
    content: fs.readFileSync(absPath).toString('base64'),
    name: path.basename(absPath),
    size: stat.size,
  };
}

async function writeFileB64(agentId, dirPath, fileName, buffer, scope) {
  const agent = requireAgent(agentId);
  const safeName = path.basename(fileName);
  if (!safeName || safeName.startsWith('.')) throw new Error('Invalid filename');
  if (scope === 'container') {
    const target = path.posix ? path.posix.join(dirPath, safeName) : `${dirPath}/${safeName}`;
    return containerExec(agent.name, { op: 'writeB64', path: target, content: buffer.toString('base64') });
  }
  requireHostBrowsable(agent);
  const destDir = resolveHostPath(hostBrowseRoot(agent), dirPath || '/');
  fs.writeFileSync(path.join(destDir, safeName), buffer);
  ensureOwned(path.join(destDir, safeName));
  return { ok: true };
}

function statFile(agentId, relativePath) {
  const agent = registry.getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const absPath = resolveSafePath(hostBrowseRoot(agent), relativePath);

  if (!fs.existsSync(absPath)) return null;
  const stat = fs.statSync(absPath);
  return {
    name: path.basename(absPath),
    type: stat.isDirectory() ? 'directory' : 'file',
    size: stat.size,
    modified: stat.mtime.toISOString(),
  };
}

// Recursively ensures a directory exists in the given scope (used by folder
// uploads). Container scope goes through docker exec (mkdir -p), host scope
// writes directly with path clamping.
async function createDirectories(agentId, dirPath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'mkdirp', path: dirPath });
  }
  requireHostBrowsable(agent);
  const absPath = resolveHostPath(hostBrowseRoot(agent), dirPath || '/');
  fs.mkdirSync(absPath, { recursive: true });
  ensureOwned(absPath);
  return { ok: true };
}

async function createFolder(agentId, relativePath, folderName, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'mkdir', path: relativePath || '/', name: folderName });
  }
  requireHostBrowsable(agent);
  const parentPath = resolveHostPath(hostBrowseRoot(agent), relativePath || '');
  const safeName = path.basename(folderName);
  if (!safeName || safeName.startsWith('.')) throw new Error('Invalid folder name');
  const target = path.join(parentPath, safeName);
  if (fs.existsSync(target)) throw new Error('Folder already exists');
  fs.mkdirSync(target, { recursive: true });
  ensureOwned(target);
  return { path: path.join(relativePath || '/', safeName) };
}

async function renameEntry(agentId, relativePath, newName, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'rename', path: relativePath, name: newName });
  }
  requireHostBrowsable(agent);
  const absPath = resolveHostPath(hostBrowseRoot(agent), relativePath);
  if (!fs.existsSync(absPath)) throw new Error('Entry not found');
  const safeName = path.basename(newName);
  if (!safeName || safeName.startsWith('.')) throw new Error('Invalid name');
  const target = path.join(path.dirname(absPath), safeName);
  if (fs.existsSync(target)) throw new Error('Name already taken');
  fs.renameSync(absPath, target);
  return { path: path.join(path.dirname(relativePath), safeName) };
}

async function deleteEntry(agentId, relativePath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'delete', path: relativePath });
  }
  requireHostBrowsable(agent);
  const absPath = resolveHostPath(hostBrowseRoot(agent), relativePath);
  if (!fs.existsSync(absPath)) throw new Error('Entry not found');
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    fs.rmSync(absPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(absPath);
  }
}

async function moveEntry(agentId, fromPath, toPath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'move', path: fromPath, to: toPath });
  }
  requireHostBrowsable(agent);
  const src = resolveHostPath(hostBrowseRoot(agent), fromPath);
  const dst = resolveHostPath(hostBrowseRoot(agent), toPath);
  if (src === dst) return { path: toPath };
  if (!fs.existsSync(src)) throw new Error('Source not found');
  if (fs.statSync(src).isDirectory() && dst.startsWith(src + path.sep)) throw new Error('Cannot move a folder into itself');
  const dstParent = path.dirname(dst);
  if (!fs.existsSync(dstParent) || !fs.statSync(dstParent).isDirectory()) throw new Error('Destination directory not found');
  if (fs.existsSync(dst)) throw new Error('Destination already exists');
  fs.renameSync(src, dst);
  return { path: toPath };
}

function getBreadcrumbs(relativePath) {
  const parts = (relativePath || '/').split('/').filter(Boolean);
  const crumbs = [{ name: 'workspace', path: '/' }];
  let current = '';
  for (const part of parts) {
    current = current ? current + '/' + part : part;
    crumbs.push({ name: part, path: '/' + current });
  }
  return crumbs;
}

function isPreviewable(filename) {
  let ext = path.extname(filename).toLowerCase();
  // Dotfiles like `.gitignore` / `.env` have no trailing extension —
  // `path.extname` returns '' for them. Treat the whole name as the extension
  // so they match the previewable list the same way `name.ext` does.
  if (!ext && filename.startsWith('.') && filename.length > 1) {
    ext = filename.toLowerCase();
  }
  const previewable = [
    '.txt', '.md', '.json', '.js', '.ts', '.jsx', '.tsx', '.py', '.rb',
    '.go', '.rs', '.java', '.c', '.cpp', '.h', '.hpp', '.css', '.scss',
    '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.sh', '.bash', '.zsh', '.fish', '.env', '.log', '.csv', '.sql',
    '.dockerfile', '.gitignore', '.makefile', '.readme', '.license',
    '.ejs', '.hbs', '.pug', '.vue', '.svelte',
  ];
  if (previewable.includes(ext)) return true;
  if (['Dockerfile', 'Makefile', 'README', 'LICENSE', 'Vagrantfile'].includes(filename)) return true;
  return false;
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = {
    '.json': 'application/json',
    '.js': 'application/javascript',
    '.ts': 'application/typescript',
    '.py': 'text/x-python',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.css': 'text/css',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.sh': 'text/x-shellscript',
    '.txt': 'text/plain',
    '.log': 'text/plain',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.sql': 'text/x-sql',
    '.toml': 'text/plain',
  };
  return map[ext] || 'text/plain';
}

function listParentDir(agentId) {
  const agent = registry.getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const parentDir = hostParentDir(agent);

  if (!fs.existsSync(parentDir)) {
    return { path: '/', entries: [] };
  }

  const stat = fs.statSync(parentDir);
  if (!stat.isDirectory()) {
    throw new Error('Not a directory');
  }

  const raw = fs.readdirSync(parentDir, { withFileTypes: true });
  const entries = raw
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const entryPath = path.join(parentDir, e.name);
      let entryStat;
      try {
        entryStat = fs.statSync(entryPath);
      } catch {
        entryStat = null;
      }
      return {
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: entryStat ? entryStat.size : 0,
        modified: entryStat ? entryStat.mtime.toISOString() : null,
      };
    })
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    path: '/',
    entries,
  };
}

function resolveParentSafePath(agentId, relativePath) {
  const agent = registry.getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const parentDir = hostParentDir(agent);
  if (!relativePath || relativePath === '/') return parentDir;
  const cleaned = path.normalize(relativePath).replace(/^\/+/, '');
  const resolved = path.resolve(parentDir, cleaned);
  if (!resolved.startsWith(parentDir + path.sep) && resolved !== parentDir) {
    throw new Error('Path traversal rejected');
  }
  return resolved;
}

function readParentFile(agentId, relativePath) {
  const absPath = resolveParentSafePath(agentId, relativePath);
  if (!fs.existsSync(absPath)) throw new Error('File not found');
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error('Cannot read directory');
  return {
    content: fs.readFileSync(absPath, 'utf8'),
    size: stat.size,
    modified: stat.mtime.toISOString(),
    name: path.basename(absPath),
  };
}

function downloadParentFile(agentId, relativePath) {
  return resolveParentSafePath(agentId, relativePath);
}

module.exports = {
  listDir,
  listFolders,
  listAgentSessions,
  readFile,
  writeFile,
  readFileB64,
  writeFileB64,
  statFile,
  createFolder,
  createDirectories,
  renameEntry,
  deleteEntry,
  moveEntry,
  getBreadcrumbs,
  isPreviewable,
  getMimeType,
  resolveSafePath,
  resolveHostPath,
  requireHostBrowsable,
  hostBrowseRoot,
  CONTAINER_DATA_DIR,
  listParentDir,
  readParentFile,
  downloadParentFile,
  MAX_UPLOAD_SIZE,
};
