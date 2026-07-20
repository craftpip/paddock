const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, exec, spawn } = require('child_process');
const multer = require('multer');
const registry = require('../services/agent-registry');
const workspace = require('../services/workspace');
const vm = require('../services/vm-manager');
const backup = require('../services/backup-manager');
const { getDb } = require('../services/db');
const { csrfCheck } = require('../middleware/auth');

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const COMPOSE_PREFIX = ['compose', '-p', 'vm-friends', '--project-directory', WORKSPACE];
const BACKUPS_DIR = path.join(WORKSPACE, 'backups');

const router = express.Router();

const oauthProcesses = new Map();

const ALLOWED_UPLOAD_TYPES = new Set([
  'text/plain', 'text/html', 'text/css', 'text/javascript', 'text/xml',
  'text/csv', 'text/markdown', 'text/x-python', 'text/x-shellscript',
  'application/json', 'application/javascript', 'application/xml',
  'application/x-yaml', 'image/png', 'image/jpeg', 'image/gif', 'image/svg+xml',
  'application/pdf', 'application/zip',
]);

const upload = multer({
  storage: multer.memoryStorage(),
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
  const flash = req.session.flash || null;
  delete req.session.flash;
  res.render('agents/dashboard', { agents, stats, flash });
});

// ─── Create Agent ───────────────────────────────────────────────────────────

router.get('/create', (req, res) => {
  const existing = registry.discoverAgents().map(a => a.name);
  res.render('agents/create', { existing });
});

router.post('/create', csrfCheck, async (req, res) => {
  const { agent_name, agent_type, clone_source } = req.body;
  const name = agent_name ? `vm-${agent_name.replace(/^vm-/, '')}` : '';
  if (!name || !registry.VM_NAME_RE.test(name)) {
    return res.status(400).render('partials/error', { message: 'Invalid agent name', code: 400 });
  }
  const existing = registry.getAgent(name);
  if (existing) {
    return res.status(409).render('partials/error', { message: 'Agent already exists', code: 409 });
  }

  const args = [name];
  if (clone_source && !registry.VM_NAME_RE.test(clone_source)) {
    return res.status(400).render('partials/error', { message: 'Invalid clone source', code: 400 });
  }
  if (clone_source) args.push('--clone', clone_source);
  else args.push('--fresh');
  if (agent_type) args.push('--agent', agent_type);

  try {
    await vm.createVm(name, {
      agent: agent_type || 'openclaw',
      mode: clone_source ? 'clone' : 'fresh',
      cloneSource: clone_source,
    });
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
  res.locals.fullHeight = true;
  res.render('agents/detail', { agent, activity, backups, config, flash, workspacePath: req.query.workspacePath || null });
});

// ─── Runtime Actions ────────────────────────────────────────────────────────

function renderAgentPartial(agent, req, res, extra) {
  const hxTarget = req.headers['hx-target'];
  const partial = hxTarget === 'sidebar-status-block' ? 'agents/partials/sidebar_status' : 'agents/partials/card';
  res.render(partial, { agent, csrfToken: req.session.csrfToken, layout: false, ...extra });
}

router.get('/:agentId/card', validateAgent, (req, res) => {
  const expect = req.query.expect;
  const agent = req.agent;
  if (expect && agent.status !== expect) {
    return renderAgentPartial(agent, req, res, { poll: expect });
  }
  renderAgentPartial(agent, req, res);
});

router.get('/:agentId/sidebar-status', validateAgent, (req, res) => {
  const expect = req.query.expect;
  const agent = req.agent;
  if (expect && agent.status !== expect) {
    return res.render('agents/partials/sidebar_status', { agent, csrfToken: req.session.csrfToken, layout: false, poll: expect });
  }
  res.render('agents/partials/sidebar_status', { agent, csrfToken: req.session.csrfToken, layout: false });
});

function lifecycleCmdBg(action, name, runtimeRef, auditFn) {
  const run = action === 'start'
    ? runCmd('docker', ['start', runtimeRef]).catch(() => runCmd('docker', [...COMPOSE_PREFIX, 'up', '-d', runtimeRef]))
    : runCmd('docker', [action, runtimeRef]);
  run.then(() => {
    registry.dockerPsList(true);
    auditFn(null);
  }).catch((err) => {
    registry.dockerPsList(true);
    auditFn(err);
  });
}

router.post('/:agentId/start', validateAgent, csrfCheck, async (req, res) => {
  const isHx = !!req.headers['hx-request'];
  const agentName = req.agent.name;
  const runtimeRef = req.agent.runtime_ref;
  lifecycleCmdBg('start', agentName, runtimeRef, (err) => {
    audit(agentName, 'lifecycle', 'start', err ? 'error' : 'ok', err ? err.message : 'Agent started');
  });
  if (isHx) {
    return renderAgentPartial(registry.getAgent(req.agent.name), req, res, { poll: 'running' });
  }
  req.session.flash = { type: 'success', message: 'Agent started.' };
  res.redirect(`/agents/${req.agent.name}`);
});

router.post('/:agentId/stop', validateAgent, csrfCheck, async (req, res) => {
  const isHx = !!req.headers['hx-request'];
  const agentName = req.agent.name;
  const runtimeRef = req.agent.runtime_ref;
  lifecycleCmdBg('stop', agentName, runtimeRef, (err) => {
    audit(agentName, 'lifecycle', 'stop', err ? 'error' : 'ok', err ? err.message : 'Agent stopped');
  });
  if (isHx) {
    return renderAgentPartial(registry.getAgent(req.agent.name), req, res, { poll: 'exited' });
  }
  req.session.flash = { type: 'success', message: 'Agent stopped.' };
  res.redirect(`/agents/${req.agent.name}`);
});

router.post('/:agentId/restart', validateAgent, csrfCheck, async (req, res) => {
  const isHx = !!req.headers['hx-request'];
  const agentName = req.agent.name;
  const runtimeRef = req.agent.runtime_ref;
  lifecycleCmdBg('restart', agentName, runtimeRef, (err) => {
    audit(agentName, 'lifecycle', 'restart', err ? 'error' : 'ok', err ? err.message : 'Agent restarted');
  });
  if (isHx) {
    return renderAgentPartial(registry.getAgent(req.agent.name), req, res, { poll: 'running' });
  }
  req.session.flash = { type: 'success', message: 'Agent restarted.' };
  res.redirect(`/agents/${req.agent.name}`);
});

// ─── Workspace Browser ──────────────────────────────────────────────────────

router.get('/:agentId/workspace', validateAgent, (req, res) => {
  const agent = req.agent;
  const relativePath = req.query.path || '/';
  const isHx = !!req.headers['hx-request'];
  try {
    const listing = workspace.listDir(agent.name, relativePath);
    const breadcrumbs = workspace.getBreadcrumbs(relativePath);
    res.render('agents/workspace', { agent, listing, breadcrumbs, currentPath: relativePath, layout: isHx ? false : undefined });
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

router.post('/:agentId/workspace/upload', validateAgent, upload.single('file'), csrfCheck, (req, res) => {
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
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(targetDir)}`);
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
    const parentDir = relativePath || '/';
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(parentDir)}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(relativePath || '/')}`);
  }
});

router.post('/:agentId/workspace/rename', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: relativePath, new_name } = req.body;
  try {
    workspace.renameEntry(agent.name, relativePath, new_name);
    audit(agent.name, 'workspace', 'rename', 'ok', `Renamed to ${new_name}`);
    req.session.flash = { type: 'success', message: `Renamed to "${new_name}".` };
    const parentDir = path.dirname(relativePath) || '/';
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(parentDir)}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(path.dirname(relativePath || '/'))}`);
  }
});

router.post('/:agentId/workspace/delete', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: relativePath } = req.body;
  try {
    workspace.deleteEntry(agent.name, relativePath);
    audit(agent.name, 'workspace', 'delete', 'ok', `Deleted ${relativePath}`);
    req.session.flash = { type: 'success', message: `Deleted "${path.basename(relativePath)}".` };
    const parentDir = path.dirname(relativePath) || '/';
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(parentDir)}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(path.dirname(relativePath || '/'))}`);
  }
});

router.post('/:agentId/workspace/move', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: fromPath, to_dir } = req.body;
  try {
    workspace.moveEntry(agent.name, fromPath, to_dir);
    audit(agent.name, 'workspace', 'move', 'ok', `Moved ${fromPath} to ${to_dir}`);
    req.session.flash = { type: 'success', message: 'File moved.' };
    const parentDir = path.dirname(fromPath) || '/';
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(parentDir)}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(path.dirname(fromPath || '/'))}`);
  }
});

router.post('/:agentId/workspace/save', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: relativePath, content } = req.body;
  if (!relativePath) return res.status(400).json({ error: 'path required' });
  try {
    const result = workspace.writeFile(agent.name, relativePath, content || '');
    audit(agent.name, 'workspace', 'save', 'ok', `Saved ${relativePath}`);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:agentId/workspace/create-file', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { path: relativePath, name: fileName } = req.body;
  if (!fileName) {
    req.session.flash = { type: 'error', message: 'File name required.' };
    return res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(relativePath || '/')}`);
  }
  try {
    const dir = relativePath || '/';
    const filePath = dir === '/' ? '/' + fileName : dir + '/' + fileName;
    workspace.writeFile(agent.name, filePath, '');
    audit(agent.name, 'workspace', 'create_file', 'ok', `Created file ${fileName}`);
    req.session.flash = { type: 'success', message: `File "${fileName}" created.` };
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(dir)}`);
  } catch (err) {
    req.session.flash = { type: 'error', message: err.message };
    res.redirect(`/agents/${agent.name}?workspacePath=${encodeURIComponent(dir)}`);
  }
});

// ─── Terminal ───────────────────────────────────────────────────────────────

router.get('/:agentId/terminal', validateAgent, (req, res) => {
  res.render('agents/terminal', { agent: req.agent });
});

// ─── Logs ───────────────────────────────────────────────────────────────────

router.get('/:agentId/logs', validateAgent, async (req, res) => {
  const agent = req.agent;
  const tail = parseInt(req.query.tail) || 100;
  try {
    const logs = await dockerLogs(agent.runtime_ref, tail);
    if (req.query.raw === '1') return res.type('text').send(logs);
    res.render('agents/logs', { agent, logs });
  } catch (err) {
    res.status(500).render('partials/error', { message: err.message, code: 500 });
  }
});

// ─── Config ─────────────────────────────────────────────────────────────────

function readRawAgentConfig(agent) {
  const configPath = path.join(agent.config_root, 'openclaw.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function preserveSecrets(oldConfig, newConfig) {
  if (!oldConfig || !newConfig) return newConfig;
  const result = JSON.parse(JSON.stringify(newConfig));
  // Preserve redacted api_keys
  if (oldConfig.api_keys && result.api_keys === '[REDACTED]') {
    result.api_keys = oldConfig.api_keys;
  }
  // Preserve redacted telegram botToken
  if (oldConfig.channels?.telegram?.botToken && result.channels?.telegram?.botToken === '[REDACTED]') {
    result.channels.telegram.botToken = oldConfig.channels.telegram.botToken;
  }
  // Preserve redacted plugin keys
  if (oldConfig.plugins && result.plugins) {
    for (const key of Object.keys(result.plugins)) {
      if (result.plugins[key]?.key === '[REDACTED]' && oldConfig.plugins[key]?.key) {
        result.plugins[key].key = oldConfig.plugins[key].key;
      }
    }
  }
  return result;
}

router.get('/:agentId/config', validateAgent, (req, res) => {
  const agent = req.agent;
  const config = readAgentConfig(agent);
  if (req.query.raw === '1') return res.json(config);
  const configRaw = readRawAgentConfig(agent);
  const configRawStr = configRaw ? JSON.stringify(configRaw, null, 2) : '';
  res.render('agents/config', { agent, config, configRaw: configRawStr });
});

router.get('/:agentId/messaging', validateAgent, (req, res) => {
  const agent = req.agent;
  const config = readAgentConfig(agent);
  const configRaw = readRawAgentConfig(agent);
  const configRawStr = configRaw ? JSON.stringify(configRaw, null, 2) : '';
  res.render('agents/messaging', { agent, config, configRaw: configRawStr });
});

async function getCatalogProviders(agentName, configuredProvidersList) {
  const oauthProviders = ['openai', 'google', 'github-copilot'];
  const result = [];
  try {
    const r = await runCmd('docker', ['exec', agentName, 'openclaw', 'models', 'list', '--all', '--json']);
    const catalog = JSON.parse(r);
    if (catalog.models && Array.isArray(catalog.models)) {
      const seen = new Map();
      for (const m of catalog.models) {
        const p = m.key.split('/')[0];
        seen.set(p, (seen.get(p) || 0) + 1);
      }
      for (const [id, count] of seen.entries()) {
        if (!configuredProvidersList.includes(id)) {
          result.push({ id, modelCount: count, type: oauthProviders.includes(id) ? 'oauth' : 'api_key' });
        }
      }
    }
  } catch (e) {}
  for (const id of oauthProviders) {
    if (!configuredProvidersList.includes(id) && !result.find(r => r.id === id)) {
      result.push({ id, modelCount: 0, type: 'oauth' });
    }
  }
  return result;
}

async function renderModels(agent, req, res) {
  const config = readAgentConfig(agent);
  const configRaw = readRawAgentConfig(agent);
  const configRawStr = configRaw ? JSON.stringify(configRaw, null, 2) : '';
  const configuredProviders = (config && config.models && config.models.providers) ? Object.keys(config.models.providers) : [];
  const catalogProviders = await getCatalogProviders(agent.name, configuredProviders);
  res.render('agents/models', { agent, config, configRaw: configRawStr, catalogProviders, configuredProviders });
}

router.get('/:agentId/models', validateAgent, async (req, res) => {
  await renderModels(req.agent, req, res);
});

router.post('/:agentId/models/set-primary', validateAgent, csrfCheck, async (req, res) => {
  const agent = req.agent;
  const { model } = req.body;
  if (!model) return res.status(400).send('model required');
  const configPath = path.join(agent.config_root, 'openclaw.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw.agents) raw.agents = {};
    if (!raw.agents.defaults) raw.agents.defaults = {};
    if (!raw.agents.defaults.model) raw.agents.defaults.model = {};
    raw.agents.defaults.model.primary = model;
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    audit(agent.name, 'config', 'set-primary', 'ok', 'Primary model: ' + model);
  } catch (e) {
    audit(agent.name, 'config', 'set-primary', 'error', e.message);
  }
  await renderModels(agent, req, res);
});

router.post('/:agentId/models/set-fallback', validateAgent, csrfCheck, async (req, res) => {
  const agent = req.agent;
  const { model } = req.body;
  const configPath = path.join(agent.config_root, 'openclaw.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!raw.agents) raw.agents = {};
    if (!raw.agents.defaults) raw.agents.defaults = {};
    if (!raw.agents.defaults.model) raw.agents.defaults.model = {};
    if (model) {
      raw.agents.defaults.model.fallback = model;
    } else {
      delete raw.agents.defaults.model.fallback;
    }
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    audit(agent.name, 'config', 'set-fallback', 'ok', model ? 'Fallback: ' + model : 'Fallback cleared');
  } catch (e) {
    audit(agent.name, 'config', 'set-fallback', 'error', e.message);
  }
  await renderModels(agent, req, res);
});

router.post('/:agentId/models/remove-provider', validateAgent, csrfCheck, async (req, res) => {
  const agent = req.agent;
  const { provider } = req.body;
  if (!provider) return res.status(400).send('provider required');
  const configPath = path.join(agent.config_root, 'openclaw.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const prefix = provider + '/';
    const model = raw.agents && raw.agents.defaults && raw.agents.defaults.model;
    if (model && model.primary && model.primary.startsWith(prefix)) delete model.primary;
    if (model && model.fallback && model.fallback.startsWith(prefix)) delete model.fallback;
    if (raw.auth && raw.auth.profiles) {
      for (const key of Object.keys(raw.auth.profiles)) {
        if (raw.auth.profiles[key].provider === provider) delete raw.auth.profiles[key];
      }
    }
    if (raw.models && raw.models.providers && raw.models.providers[provider]) {
      delete raw.models.providers[provider];
    }
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n');
    audit(agent.name, 'config', 'remove-provider', 'ok', 'Removed provider: ' + provider);
  } catch (e) {
    audit(agent.name, 'config', 'remove-provider', 'error', e.message);
  }
  await renderModels(agent, req, res);
});

// ─── OAuth Login Flow ─────────────────────────────────────────────────────

router.post('/:agentId/models/oauth-login', validateAgent, csrfCheck, async (req, res) => {
  const agent = req.agent;
  const { provider } = req.body;
  if (!provider) return res.status(400).json({ error: 'provider required' });

  const key = agent.name + ':' + provider;
  if (oauthProcesses.has(key)) {
    try { oauthProcesses.get(key).kill(); } catch (e) {}
    oauthProcesses.delete(key);
  }

  const child = spawn('docker', ['exec', agent.name, 'script', '-q', '-c', `openclaw models auth login --provider ${provider} --device-code`, '/dev/null'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 120000
  });

  let output = '';
  let url = '';
  let code = '';

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    if (!url || !code) {
      const urlMatch = output.match(/URL:\s*(\S+)/);
      const codeMatch = output.match(/Code:\s*(\S+)/);
      if (urlMatch) url = urlMatch[1];
      if (codeMatch) code = codeMatch[1];
    }
  });

  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  // Wait up to 10s for URL+code to appear, then return
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (url && code) {
        clearInterval(check);
        resolve();
      }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(); }, 10000);
  });

  if (!url) {
    child.kill();
    return res.json({ error: 'Failed to get OAuth URL. Server response: ' + output.slice(-200) });
  }

  oauthProcesses.set(key, child);
  child.on('exit', () => { oauthProcesses.delete(key); });

  res.json({ url, code, status: 'waiting' });
});

router.get('/:agentId/models/oauth-status', validateAgent, (req, res) => {
  const agent = req.agent;
  const { provider } = req.query;
  const key = agent.name + ':' + provider;
  const child = oauthProcesses.get(key);

  if (child) {
    try {
      const alive = child.exitCode === null;
      if (alive) return res.json({ status: 'waiting' });
    } catch (e) {}
  }

  // Process gone — check if auth succeeded
  const config = readAgentConfig(agent);
  const configured = (config && config.models && config.models.providers) ? Object.keys(config.models.providers) : [];
  const done = configured.includes(provider);
  return res.json({ status: done ? 'complete' : 'expired' });
});

router.post('/:agentId/models/oauth-cancel', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { provider } = req.body;
  const key = agent.name + ':' + provider;
  if (oauthProcesses.has(key)) {
    try { oauthProcesses.get(key).kill(); } catch (e) {}
    oauthProcesses.delete(key);
  }
  res.json({ ok: true });
});

router.post('/:agentId/config', validateAgent, csrfCheck, (req, res) => {
  const agent = req.agent;
  const { config: configStr } = req.body;
  if (!configStr) return res.status(400).json({ error: 'config required' });
  let newConfig;
  try {
    newConfig = JSON.parse(configStr);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON: ' + e.message });
  }
  const configPath = path.join(agent.config_root, 'openclaw.json');
  const oldConfig = readRawAgentConfig(agent);
  const merged = preserveSecrets(oldConfig, newConfig);
  try {
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n');
    audit(agent.name, 'config', 'update', 'ok', 'Updated openclaw.json');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
    await backup.backupAgent(req.agent.name);
    audit(req.agent.name, 'backup', 'create', 'ok', 'Backup created');
    console.error('BACKUP CREATE: setting flash, sessID:', req.sessionID);
    req.session.flash = { type: 'success', message: 'Backup created.' };
    req.session.save(() => {
      console.error('BACKUP CREATE: save callback, redirecting');
      res.redirect(`/agents/${req.agent.name}#backups`);
    });
  } catch (err) {
    audit(req.agent.name, 'backup', 'create', 'error', err.message);
    req.session.flash = { type: 'error', message: `Backup failed: ${err.message}` };
    req.session.save(() => res.redirect(`/agents/${req.agent.name}#backups`));
  }
});

router.post('/:agentId/backups/restore', validateAgent, csrfCheck, async (req, res) => {
  try {
    await backup.restoreAgent(req.agent.name);
    audit(req.agent.name, 'backup', 'restore', 'ok', 'Backup restored');
    req.session.flash = { type: 'success', message: 'Backup restored. Container will restart.' };
    req.session.save(() => res.redirect(`/agents/${req.agent.name}#backups`));
  } catch (err) {
    audit(req.agent.name, 'backup', 'restore', 'error', err.message);
    req.session.flash = { type: 'error', message: `Restore failed: ${err.message}` };
    req.session.save(() => res.redirect(`/agents/${req.agent.name}#backups`));
  }
});

router.get('/:agentId/backups/download', validateAgent, (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).send('file required');
  const safeName = path.basename(file);
  const backupPath = path.join(BACKUPS_DIR, safeName);
  if (!fs.existsSync(backupPath)) return res.status(404).send('Not found');
  res.download(backupPath);
});

router.post('/:agentId/backups/delete', validateAgent, csrfCheck, (req, res) => {
  const file = req.body.file;
  if (!file) return res.status(400).send('file required');
  const safeName = path.basename(file);
  const backupPath = path.join(BACKUPS_DIR, safeName);
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
    audit(req.agent.name, 'backup', 'delete', 'ok', `Deleted backup ${safeName}`);
  }
  req.session.flash = { type: 'success', message: 'Backup deleted.' };
  res.redirect(`/agents/${req.agent.name}#backups`);
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
    if (redacted.channels?.telegram?.botToken) redacted.channels.telegram.botToken = '[REDACTED]';
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
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.startsWith(vmName + '_') && f.endsWith('.tar.gz'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { name: f, size: stat.size, created: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.created) - new Date(a.created));
}

function dockerLogs(vmName, tail = 100) {
  return new Promise((resolve) => {
    exec(`docker logs --tail ${tail} ${vmName} 2>&1`, { timeout: 10000 }, (err, stdout) => {
      resolve(stdout || '');
    });
  });
}

function runCmd(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(stdout.toString());
    });
  });
}

module.exports = router;
