const fs = require('fs');
const path = require('path');
const { getAgent } = require('./agent-registry');

const MAX_UPLOAD_SIZE = 100 * 1024 * 1024; // 100MB

function resolveSafePath(workspaceRoot, relativePath) {
  if (!relativePath || relativePath === '/') return workspaceRoot;
  const cleaned = path.normalize(relativePath).replace(/^\/+/, '');
  const resolved = path.resolve(workspaceRoot, cleaned);
  if (!resolved.startsWith(workspaceRoot + path.sep) && resolved !== workspaceRoot) {
    throw new Error('Path traversal rejected');
  }
  return resolved;
}

function listDir(agentId, relativePath) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const absPath = resolveSafePath(agent.workspace_root, relativePath || '');

  if (!fs.existsSync(absPath)) {
    return { path: relativePath || '/', entries: [] };
  }

  const stat = fs.statSync(absPath);
  if (!stat.isDirectory()) {
    throw new Error('Not a directory');
  }

  const raw = fs.readdirSync(absPath, { withFileTypes: true });
  const entries = raw
    .filter(e => !e.name.startsWith('.'))
    .map(e => {
      const entryPath = path.join(absPath, e.name);
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
    path: relativePath || '/',
    entries,
  };
}

function readFile(agentId, relativePath) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const absPath = resolveSafePath(agent.workspace_root, relativePath);

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

function writeFile(agentId, relativePath, content) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const absPath = resolveSafePath(agent.workspace_root, relativePath);

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

function createFolder(agentId, relativePath, folderName) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const parentPath = resolveSafePath(agent.workspace_root, relativePath || '');
  const safeName = path.basename(folderName);
  if (!safeName || safeName.startsWith('.')) throw new Error('Invalid folder name');
  const target = path.join(parentPath, safeName);
  if (fs.existsSync(target)) throw new Error('Folder already exists');
  fs.mkdirSync(target, { recursive: true });
  return { path: path.join(relativePath || '/', safeName) };
}

function renameEntry(agentId, relativePath, newName) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const absPath = resolveSafePath(agent.workspace_root, relativePath);
  if (!fs.existsSync(absPath)) throw new Error('Entry not found');
  const safeName = path.basename(newName);
  if (!safeName || safeName.startsWith('.')) throw new Error('Invalid name');
  const target = path.join(path.dirname(absPath), safeName);
  if (fs.existsSync(target)) throw new Error('Name already taken');
  fs.renameSync(absPath, target);
  return { path: path.join(path.dirname(relativePath), safeName) };
}

function deleteEntry(agentId, relativePath) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const absPath = resolveSafePath(agent.workspace_root, relativePath);
  if (!fs.existsSync(absPath)) throw new Error('Entry not found');
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    fs.rmSync(absPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(absPath);
  }
}

function moveEntry(agentId, fromRelativePath, toRelativeDir) {
  const agent = getAgent(agentId);
  if (!agent) throw new Error('Agent not found');
  const srcPath = resolveSafePath(agent.workspace_root, fromRelativePath);
  const destDir = resolveSafePath(agent.workspace_root, toRelativeDir || '');
  if (!fs.existsSync(srcPath)) throw new Error('Source not found');
  if (!fs.existsSync(destDir) || !fs.statSync(destDir).isDirectory()) {
    throw new Error('Destination directory not found');
  }
  const destPath = path.join(destDir, path.basename(srcPath));
  if (fs.existsSync(destPath)) throw new Error('Destination already exists');
  fs.renameSync(srcPath, destPath);
  return { path: path.join(toRelativeDir || '/', path.basename(srcPath)) };
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

module.exports = {
  listDir,
  readFile,
  writeFile,
  statFile,
  createFolder,
  renameEntry,
  deleteEntry,
  moveEntry,
  getBreadcrumbs,
  isPreviewable,
  getMimeType,
  resolveSafePath,
  MAX_UPLOAD_SIZE,
};
