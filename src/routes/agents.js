const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const registry = require('../services/agent-registry');
const workspace = require('../services/workspace');
const { getDb } = require('../services/db');
const { csrfCheck } = require('../middleware/auth');

const router = express.Router();

const ALLOWED_UPLOAD_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/xml',
  'text/csv', 'text/markdown', 'text/x-python', 'text/x-shellscript',
  'application/json', 'application/javascript', 'application/xml',
  'application/x-yaml', 'image/png', 'image/jpeg', 'image/gif', 'image/svg+xml',
  'application/pdf', 'application/zip',
]);

const upload = multer({
  limits: { fileSize: workspace.MAX_UPLOAD_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const dangerousExts = ['.sh', '.bash', '.exe', '.bat', '.cmd', '.ps1', '.dll', '.so', '.dylib'];
    if (dangerousExts.includes(ext) && ext !== '.sh') {
      return cb(new Error(`File type ${ext} is not allowed`));
    }
    cb(null, true);
  },
});

function validateAgent(req, res, next) {
  const agentId = req.params.agentId || req.params.name;
  if (!agentId || !registry.VM_NAME_RE.test(agentId)) {
    return res.status(400).render('partials/error', { message: 'Invalid agent name', code: 400 });
  }
  const agent = registry.getAgent(agentId);
  if (!agent) {
    return res.status(404).render('partials/error', { message: 'Agent not found', code: 404 });
  }
  req.agent = agent;
  next();
}

function audit(agentId, category, action, status, details, resourceRef) {
  try {
    registry.recordActivity(agentId, category, action, status || 'ok', details, resourceRef);
  } catch {}
}

// ─── Agent Dashboard ────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const agents = registry.discoverAgents();
  const stats = registry.getAgentStats();
  res.render('agents/dashboard', { agents, stats });
});

// ─── Create Agent ───────────────────────────────────────────────────────────

router.get('/create', (req, res) => {
  const existing = registry.discoverAgents().map(a => a.name);
  res.render('agents/create', { existing });
});

router.post('/create', csrfCheck, async (req, res) => {
  const { agent_name, agent_type, clone_source, password } = req.body;
  const name = agent_name ? `vm-${agent_name.replace(/^vm-/, '')}` : '';
  if (!name || !registry.VM_NAME_RE.test(name)) {
    return res.status(400).render('partials/error', { message: 'Invalid agent name', code: 400 });
  }
  const existing = registry.getAgent(name);
  if (existing) {
    return res.status(409).render('partials/error', { message: 'Agent already exists', code: 409 });
  }

  const args = [name];
  if (clone_source) args.push('--clone', clone_source);
  else args.push('--fresh');
  if (agent_type) args.push('--agent', agent_type);
  if (password) args.push('--password', password);

  try {
    await runWorkspaceScript('add-vm.sh', args, 120000);
    audit(name, 'lifecycle', 'create', 'ok', `Agent created (type=${agent_type || 'openclaw'})`);
    req.session.flash = { type: 'success', message: `Agent ${name} created successfully.` };
    res.redirect(`/agents/${name}`);
  } catch (err) {
    audit(name, 'lifecycle', 'create', 'error', err.message);
    res.status(500).render('partials/error', { message: `Failed to create agent: ${err.message}`, code: 500 });
  }
});

// ─── Agent Detail ───────────────────────────────────────────────────────────

router.get('/:agentId', validateAgent, (req, res) => {
  const agent = req.agent;
  const activity = registry.getActivity(agent.name, 20);
  const backups = getBackups(agent.name);
  const config = readAgentConfig(agent);
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('agents/detail', { agent, activity, backups, config, flash });
});

// ─── Runtime Actions ────────────────────────────────────────────────────────

router.post('/:agentId/start', validateAgent, csrfCheck, async (req, res) => {
  try {
    await runCmd('docker', ['compose', 'up', '-d', req.agent.runtime_ref]);
    audit(req.agent.name, 'lifecycle', 'start', 'ok', 'Agent started');
    req.session.flash = { type: 'success', message: 'Agent started.' };
    res.redirect(`/agents/${req.agent.name}`);
  } catch (err) {
    audit(req.agent.name, 'lifecycle', 'start', 'error', err.message);
    req.session.flash = { type: 'error', message: `Failed to start: ${err.message}` };
    res.redirect(`/agents/${req.agent.name}`);
  }
});

router.post('/:agentId/stop', validateAgent, csrfCheck, async (req, res) => {
  try {
    await runCmd('docker', ['compose', 'stop', req.agent.runtime_ref]);
    audit(req.agent.name, 'lifecycle', 'stop', 'ok', 'Agent stopped');
    req.session.flash = { type: 'success', message: 'Agent stopped.' };
    res.redirect(`/agents/${req.agent.name}`);
  } catch (err) {
    audit(req.agent.name, 'lifecycle', 'stop', 'error', err.message);
    req.session.flash = { type: 'error', message: `Failed to stop: ${err.message}` };
    res.redirect(`/agents/${req.agent.name}`);
  }
});

router.post('/:agentId/restart', validateAgent, csrfCheck, async (req, res) => {
  try {
    await runCmd('docker', ['compose', 'restart', req.agent.runtime_ref]);
    audit(req.agent.name, 'lifecycle', 'restart', 'ok', 'Agent restarted');
    req.session.flash = { type: 'success', message: 'Agent restarted.' };
    res.redirect(`/agents/${req.agent.name}`);
  } catch (err) {
    audit(req.agent.name, 'lifecycle', 'restart', 'error', err.message);
    req.session.flash = { type: 'error', message: `Failed to restart: ${err.message}` };
    res.redirect(`/agents/${req.agent.name}`);
  }
});

// ─── Workspace Browser ──────────────────────────────────────────────────────

router.get('/:agentId/workspace', validateAgent, (req, res) => {
  const agent = req.agent;
  const relativePath = req.query.path || '/';
  try {
    const listing = workspace.listDir(agent.name, relativePath);
    const breadcrumbs = workspace.getBreadcrumbs(relativePath);
    res.render('agents/workspace', { agent, listing, breadcrumbs, currentPath: relativePath });
  } catch (err) {
    res.status(400).render('partials/error', { message: err.message, code: 400 });
  }
});

router.get('/:agentId/workspace/tree', validateAgent, (req, res) => {
  const agent = req.agent;
  const relativePath = req.query.path || '/';
  try {
    const listing = workspace.listDir(agent.name, relativePath);
    res.json(listing);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:agentId/workspace/file', validateAgent, (req, res) => {
  const agent = req.agent;
  const relativePath = req.query.path;
  if (!relativePath) return res.status(400).json({ error: 'path required' });
  try {
    const file = workspace.readFile(agent.name, relativePath);
    if (req.query.raw === '1') {
      return res.type(workspace.getMimeType(file.name)).send(file.content);
    }
    res.json(file);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.get('/:agentId/workspace/download', validateAgent, (req, res) => {
  const agent = req.agent;
  const relativePath = req.query.path;
  if (!relativePath) return res.status(400).send('path required');
  try {
    const absPath = workspace.resolveSafePath(agent.workspace_root, relativePath);
    if (!fs.existsSync(absPath)) return res.status(404).send('Not found');
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) return res.status(400).send('Cannot download directory');
    if (stat.size > 50 * 1024 * 1024) return res.status(413).send('File too large for download (>50MB)');
    res.download(absPath);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

router.post('/:agentId/workspace/upload', validateAgent, csrfCheck, upload.single('file'), (req, res) => {
  const agent = req.agent;
  const targetDir = req.body.path || '/';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const destDir = workspace.resolveSafePath(agent.workspace_root, targetDir);
    const safeName = path.basename(req.file.originalname);
    if (!safeName || safeName.startsWith('.')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    const destPath = path.join(destDir, safeName);
    fs.writeFileSync(destPath, req.file.buffer);
    audit(agent.name, 'workspace', 'upload', 'ok', `Uploaded ${safeName} (${req.file.size} bytes) to ${targetDir}`);
    req.session.flash = { type: 'success', message: `Uploaded ${safeName}` };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(targetDir)}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:agentId/workspace/folder', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: relativePath, name: folderName } = req.body;
  try {
    workspace.createFolder(agent.name, relativePath, folderName);
    audit(agent.name, 'workspace', 'create_folder', 'ok', `Created folder ${folderName}`);
    req.session.flash = { type: 'success', message: `Folder "${folderName}" created.` };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(relativePath || '/')}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(relativePath || '/')}`);
  }
});

router.post('/:agentId/workspace/rename', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: relativePath, new_name } = req.body;
  try {
    workspace.renameEntry(agent.name, relativePath, new_name);
    audit(agent.name, 'workspace', 'rename', 'ok', `Renamed to ${new_name}`);
    req.session.flash = { type: 'success', message: `Renamed to "${new_name}".` };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(path.dirname(relativePath))}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(path.dirname(relativePath))}`);
  }
});

router.post('/:agentId/workspace/delete', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: relativePath } = req.body;
  try {
    workspace.deleteEntry(agent.name, relativePath);
    audit(agent.name, 'workspace', 'delete', 'ok', `Deleted ${relativePath}`);
    req.session.flash = { type: 'success', message: `Deleted "${path.basename(relativePath)}".` };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(path.dirname(relativePath))}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(path.dirname(relativePath))}`);
  }
});

router.post('/:agentId/workspace/move', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: fromPath, to_dir } = req.body;
  try {
    workspace.moveEntry(agent.name, fromPath, to_dir);
    audit(agent.name, 'workspace', 'move', 'ok', `Moved ${fromPath} to ${to_dir}`);
    req.session.flash = { type: 'success', message: 'File moved.' };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(to_dir || '/')}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}/workspace?path=${encodeURIComponent(to_dir || '/')}`);
  }
});

// ─── Terminal ───────────────────────────────────────────────────────────────

router.get('/:agentId/terminal', validateAgent, (req, res) => {
  res.render('agents/terminal', { agent: req.agent });
});

// ─── Logs ───────────────────────────────────────────────────────────────────

router.get('/:agentId/logs', validateAgent, (req, res) => {
  const agent = req.agent;
  const tail = parseInt(req.query.tail) || 100;
  try {
    const logs = dockerLogs(agent.runtime_ref, tail);
    if (req.query.raw === '1') return res.type('text').send(logs);
    res.render('agents/logs', { agent, logs });
  } catch (err) {
    res.status(500).render('partials/error', { message: err.message, code: 500 });
  }
});

// ─── Config ─────────────────────────────────────────────────────────────────

router.get('/:agentId/config', validateAgent, (req, res) => {
  const agent = req.agent;
  const config = readAgentConfig(agent);
  if (req.query.raw === '1') return res.json(config);
  res.render('agents/config', { agent, config });
});

// ─── Activity ───────────────────────────────────────────────────────────────

router.get('/:agentId/activity', validateAgent, (req, res) => {
  const activity = registry.getActivity(req.agent.name, 100);
  if (req.query.raw === '1') return res.json(activity);
  res.render('agents/activity', { agent: req.agent, activity });
});

// ─── Backups ────────────────────────────────────────────────────────────────

router.get('/:agentId/backups', validateAgent, (req, res) => {
  const backups = getBackups(req.agent.name);
  res.render('agents/backups', { agent: req.agent, backups });
});

router.post('/:agentId/backups/create', validateAgent, csrfCheck, async (req, res) => {
  try {
    await runWorkspaceScript('manage_backups.sh', ['backup', req.agent.name], 120000);
    audit(req.agent.name, 'backup', 'create', 'ok', 'Backup created');
    req.session.flash = { type: 'success', message: 'Backup created.' };
    res.redirect(`/agents/${req.agent.name}/backups`);
  } catch (err) {
    audit(req.agent.name, 'backup', 'create', 'error', err.message);
    req.session.flash = { type: 'error', message: `Backup failed: ${err.message}` };
    res.redirect(`/agents/${req.agent.name}/backups`);
  }
});

router.post('/:agentId/backups/restore', validateAgent, csrfCheck, async (req, res) => {
  try {
    await runWorkspaceScript('manage_backups.sh', ['restore', req.agent.name], 120000);
    audit(req.agent.name, 'backup', 'restore', 'ok', 'Backup restored');
    req.session.flash = { type: 'success', message: 'Backup restored. Container will restart.' };
    res.redirect(`/agents/${req.agent.name}/backups`);
  } catch (err) {
    audit(req.agent.name, 'backup', 'restore', 'error', err.message);
    req.session.flash = { type: 'error', message: `Restore failed: ${err.message}` };
    res.redirect(`/agents/${req.agent.name}/backups`);
  }
});

router.get('/:agentId/backups/download', validateAgent, (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).send('file required');
  const safeName = path.basename(file);
  const backupPath = path.join(__dirname, '..', '..', 'backups', safeName);
  if (!fs.existsSync(backupPath)) return res.status(404).send('Not found');
  res.download(backupPath);
});

router.post('/:agentId/backups/delete', validateAgent, csrfCheck, (req, res) => {
  const file = req.body.file;
  if (!file) return res.status(400).send('file required');
  const safeName = path.basename(file);
  const backupPath = path.join(__dirname, '..', '..', 'backups', safeName);
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
    audit(req.agent.name, 'backup', 'delete', 'ok', `Deleted backup ${safeName}`);
  }
  req.session.flash = { type: 'success', message: 'Backup deleted.' };
  res.redirect(`/agents/${req.agent.name}/backups`);
});

// ─── Sessions ───────────────────────────────────────────────────────────────

router.get('/:agentId/sessions', validateAgent, (req, res) => {
  const db = getDb();
  const sessions = db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50').all(req.agent.name);
  res.render('agents/sessions', { agent: req.agent, sessions });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function readAgentConfig(agent) {
  const configPath = path.join(agent.config_root, 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const redacted = JSON.parse(JSON.stringify(raw));
    if (redacted.api_keys) redacted.api_keys = '[REDACTED]';
    if (redacted.telegram?.bot_token) redacted.telegram.bot_token = '[REDACTED]';
    if (redacted.plugins) {
      for (const key of Object.keys(redacted.plugins)) {
        if (redacted.plugins[key]?.key) redacted.plugins[key].key = '[REDACTED]';
      }
    }
    return redacted;
  } catch {
    return null;
  }
}

function getBackups(vmName) {
  const backupsDir = path.join(__dirname, '..', '..', 'backups');
  if (!fs.existsSync(backupsDir)) return [];
  return fs.readdirSync(backupsDir)
    .filter(f => f.startsWith(vmName + '_') && f.endsWith('.tar.gz'))
    .map(f => {
      const stat = fs.statSync(path.join(backupsDir, f));
      return { name: f, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

function dockerLogs(vmName, tail = 100) {
  const { execSync } = require('child_process');
  try {
    return execSync(`docker logs --tail ${tail} ${vmName} 2>&1`, { timeout: 10000 }).toString();
  } catch {
    return 'Unable to fetch logs.';
  }
}

function runCmd(cmd, args, timeout = 30000) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

function runWorkspaceScript(scriptName, args = [], timeout = 60000) {
  const os = require('os');
  const scriptPath = path.join(__dirname, '..', '..', scriptName);
  if (!fs.existsSync(scriptPath)) {
    return Promise.reject(new Error(`Script ${scriptName} not found`));
  }
  let content = fs.readFileSync(scriptPath, 'utf8');
  content = content.replace(/\/\.dockerenv/g, '/.dockerenv-dummy');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const tmpScript = path.join(tmpDir, scriptName);
  fs.writeFileSync(tmpScript, content);
  fs.chmodSync(tmpScript, '755');
  return runCmd('bash', [tmpScript, ...args], timeout).finally(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });
}

module.exports = router;
