const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getAgent } = require('./agent-registry');

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB

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
  if (raw.startsWith('/')) {
    const normalized = path.normalize(raw);
    if (!normalized.startsWith('/')) throw new Error('Invalid path');
    if (normalized.includes('\0')) throw new Error('Invalid path');
    return normalized;
  }
  const cleaned = path.normalize(raw).replace(/^\/+/, '');
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

const CONTAINER_HELPER = `let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
const fs=require('fs'),path=require('path');let out={};
try{
  const q=JSON.parse(s),p=q.path;
  const st=p=>{try{return fs.statSync(p)}catch{return null}};
  const lst=p=>{const stat=st(p);if(!stat)throw new Error('Path not found');if(!stat.isDirectory())throw new Error('Not a directory');
    return fs.readdirSync(p,{withFileTypes:true}).map(e=>{const es=st(path.join(p,e.name))||{};
      return{name:e.name,type:e.isDirectory()?'directory':'file',size:es.size||0,modified:es.mtime?new Date(es.mtime).toISOString():null};})
      .filter(e=>!e.name.startsWith('.')).sort((a,b)=>a.type!==b.type?(a.type==='directory'?-1:1):a.name.localeCompare(b.name));};
  switch(q.op){
    case 'list':out={path:p,entries:lst(p)};break;
    case 'read':{const stat=st(p);if(!stat)throw new Error('File not found');if(stat.isDirectory())throw new Error('Cannot read directory');
      out={content:fs.readFileSync(p,'utf8'),size:stat.size,modified:new Date(stat.mtime).toISOString(),name:path.basename(p)};break;}
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
    default:throw new Error('Unknown op');
  }
}catch(e){out={error:e.message};}
process.stdout.write(JSON.stringify(out));
});`;

function containerExec(agentName, payload, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', ['exec', '-i', agentName, 'node', '-e', CONTAINER_HELPER], { timeout }, (err, stdout) => {
      if (err) return reject(new Error('Container is not running'));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('Unexpected container response')); }
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

function requireAgent(agentId) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  return agent;
}

function fsList(absPath) {
  if (!fs.existsSync(absPath)) return { path: absPath, entries: [] };
  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) throw new Error('Not a directory');
  const raw = fs.readdirSync(absPath, { withFileTypes: true });
  const entries = raw
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const entryPath = path.join(absPath, e.name);
      let entryStat;
      try { entryStat = fs.statSync(entryPath); } catch { entryStat = null; }
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
  return { path: absPath, entries };
}

async function listDir(agentId, relativePath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'list', path: relativePath || '/' });
  }
  return fsList(resolveHostPath(agent.workspace_root, relativePath || ''));
}

async function readFile(agentId, relativePath, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'read', path: relativePath });
  }
  const absPath = resolveHostPath(agent.workspace_root, relativePath);
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

async function writeFile(agentId, relativePath, content, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'save', path: relativePath, content });
  }
  const absPath = resolveHostPath(agent.workspace_root, relativePath);
  if (fs.existsSync(absPath)) {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) throw new Error('Cannot write to directory');
  }
  fs.writeFileSync(absPath, content, 'utf8');
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
  const absPath = resolveHostPath(agent.workspace_root, relativePath);
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
  const destDir = resolveHostPath(agent.workspace_root, dirPath || '/');
  fs.writeFileSync(path.join(destDir, safeName), buffer);
  return { ok: true };
}

function statFile(agentId, relativePath) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const absPath = resolveSafePath(agent.workspace_root, relativePath);

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
  const absPath = resolveHostPath(agent.workspace_root, dirPath || '/');
  fs.mkdirSync(absPath, { recursive: true });
  return { ok: true };
}

async function createFolder(agentId, relativePath, folderName, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'mkdir', path: relativePath || '/', name: folderName });
  }
  const parentPath = resolveHostPath(agent.workspace_root, relativePath || '');
  const safeName = path.basename(folderName);
  if (!safeName || safeName.startsWith('.')) throw new Error('Invalid folder name');
  const target = path.join(parentPath, safeName);
  if (fs.existsSync(target)) throw new Error('Folder already exists');
  fs.mkdirSync(target, { recursive: true });
  return { path: path.join(relativePath || '/', safeName) };
}

async function renameEntry(agentId, relativePath, newName, scope) {
  const agent = requireAgent(agentId);
  if (scope === 'container') {
    return containerExec(agent.name, { op: 'rename', path: relativePath, name: newName });
  }
  const absPath = resolveHostPath(agent.workspace_root, relativePath);
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
  const absPath = resolveHostPath(agent.workspace_root, relativePath);
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
  const src = resolveHostPath(agent.workspace_root, fromPath);
  const dst = resolveHostPath(agent.workspace_root, toPath);
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
  const ext = path.extname(filename).toLowerCase();
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
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const parentDir = path.resolve(agent.workspace_root, '..');

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
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const parentDir = path.resolve(agent.workspace_root, '..');
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
  CONTAINER_DATA_DIR,
  listParentDir,
  readParentFile,
  downloadParentFile,
  MAX_UPLOAD_SIZE,
};
