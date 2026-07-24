const express = require('express');
const { WebSocketServer } = require('ws');
const cookieParser = require('cookie-parser');
const { execFile, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const creds = require('./creds');
const registry = require('./services/agent-registry');
const vm = require('./services/vm-manager');
const backup = require('./services/backup-manager');
const { getDb } = require('./services/db');
const { setupSession, requireAuth, csrfToken, AUTH_PASSWORD } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

const WORKSPACE = '/workspace';
const BACKUPS_DIR = path.join(WORKSPACE, 'backups');
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const SCRIPTS_DIR = path.join(WORKSPACE, 'scripts');
const ENV_FILE = path.join(WORKSPACE, '.env');
const PREFIX = process.env.CONTAINER_PREFIX || 'vm';
const VM_NAME_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-zA-Z0-9][a-zA-Z0-9_-]*$');
const PREFIX_DASH = PREFIX + '-';

function safeVmName(name) {
  if (!name || !VM_NAME_RE.test(name)) return null;
  return name;
}

function safeBackupPath(fileParam) {
  const resolved = path.resolve(path.join(BACKUPS_DIR, path.basename(fileParam)));
  if (!resolved.startsWith(BACKUPS_DIR)) return null;
  return resolved;
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

setupSession(app);
app.use(csrfToken);
app.use(rateLimit);

// ─── Auth (session-based) ────────────────────────────────────

app.use((req, res, next) => {
  if (!AUTH_PASSWORD) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
  requireAuth(req, res, next);
});

let envCache = null;
function loadEnv() {
  if (envCache) return envCache;
  const env = {};
  if (fs.existsSync(ENV_FILE)) {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
        const idx = trimmed.indexOf('=');
        env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
      }
    }
  }
  envCache = env;
  return env;
}

let dockerCache = { ts: 0, data: {} };

function runCmd(cmd, args, options = {}) {
  const { timeout = 30000, check = false, input } = options;
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args || [], { timeout, input }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          reject(new Error(`Command timed out after ${timeout}s: ${cmd} ${(args || []).join(' ')}`));
        } else if (err.code === 'ENOENT') {
          reject(new Error(`Command not found: ${cmd}`));
        } else if (check && err.code !== 0) {
          reject(new Error(`Command failed: ${cmd} ${(args || []).join(' ')}\n${stderr}`));
        } else {
          resolve({ stdout: stdout || '', stderr: stderr || '', code: err.code });
        }
      } else {
        resolve({ stdout, stderr, code: 0 });
      }
    });
  });
}

async function dockerPsList(force = false) {
  const now = Date.now();
  if (!force && now - dockerCache.ts < 3000) return dockerCache.data;
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 15000 });
  const containers = {};
  for (const line of r.stdout.trim().split('\n')) {
    if (line) {
      try {
        const c = JSON.parse(line);
        containers[c.Names || c.ID] = c;
      } catch (e) {}
    }
  }
  dockerCache = { ts: now, data: containers };
  return containers;
}

function getVmStatus(vmName) {
  const c = dockerCache.data[vmName];
  return c ? (c.State || 'stopped').toLowerCase() : 'stopped';
}

function readMeta(vmName) {
  const meta = {};
  const metaFile = path.join(INSTANCES_DIR, vmName, 'meta.env');
  if (fs.existsSync(metaFile)) {
    for (const line of fs.readFileSync(metaFile, 'utf8').split('\n')) {
      if (line.includes('=')) {
        const idx = line.indexOf('=');
        meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    }
  }
  return meta;
}

async function getAllVms() {
  const vms = [];
  if (!fs.existsSync(INSTANCES_DIR)) return vms;
  const dirs = fs.readdirSync(INSTANCES_DIR).sort();
  for (const d of dirs) {
    if (!d.startsWith(PREFIX_DASH)) continue;
    const stat = fs.statSync(path.join(INSTANCES_DIR, d));
    if (!stat.isDirectory()) continue;
    const meta = readMeta(d);
    const agent = meta.AGENT || 'openclaw';
    const containers = await dockerPsList();
    const cinfo = containers[d] || {};
    vms.push({
      name: d,
      agent,
      password: meta.ROOT_PASSWORD || '',
      port: meta.PORT || '',
      status: getVmStatus(d),
      container_status: cinfo.Status || '',
      config_exists: fs.existsSync(path.join(INSTANCES_DIR, d, agent, 'openclaw.json')),
    });
  }
  return vms;
}

function getBackups(vmName) {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  const all = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.tar.gz'));
  const files = vmName ? all.filter(f => f.startsWith(vmName + '_')) : all;
  files.sort().reverse();
  const meta = backup.loadMeta();
  return files.map(f => {
    const p = path.join(BACKUPS_DIR, f);
    const parts = f.split('_');
    const vm = parts[0];
    const ts = parts.slice(1, 3).join('_').replace('.tar.gz', '');
    const stat = fs.statSync(p);
    const type = backup.getBackupType(f);
    const containerExists = fs.existsSync(path.join(INSTANCES_DIR, vm));
    const formatted = formatBackupTimestamp(ts);
    const metaEntry = meta[f] || {};
    return {
      file: f,
      path: p,
      vm,
      timestamp: ts,
      displayDate: formatted.date,
      displayTime: formatted.time,
      relativeTime: formatted.relative,
      size: stat.size,
      size_hr: fmtSize(stat.size),
      type,
      containerExists,
      agentType: metaEntry.agentType || metaEntry.type || '',
    };
  });
}

function fmtSize(size) {
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (size < 1024) return `${size.toFixed(1)}${unit}`;
    size /= 1024;
  }
  return `${size.toFixed(1)}TB`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatBackupTimestamp(ts) {
  const nums = ts.match(/\d+/g);
  if (!nums || nums.length < 6) return { date: 'unknown', time: '', relative: '' };
  const y = parseInt(nums[0]);
  const mo = parseInt(nums[1]) - 1;
  const d = parseInt(nums[2]);
  const h = parseInt(nums[3] || 0);
  const mi = parseInt(nums[4] || 0);
  const s = parseInt(nums[5] || 0);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  const pad = n => String(n).padStart(2, '0');
  const date = new Date(y, mo, d, h, mi, s);
  const now = new Date();
  const diffMs = now - date;
  const mins = Math.floor(diffMs / 60000);
  const hours = Math.floor(diffMs / 3600000);
  const days = Math.floor(diffMs / 86400000);
  let relative;
  if (mins < 1) relative = 'just now';
  else if (mins < 60) relative = `${mins}m ago`;
  else if (hours < 24) relative = `${hours}h ago`;
  else if (days < 30) relative = `${days}d ago`;
  else relative = `${Math.floor(days / 30)}mo ago`;
  return {
    date: `${MONTHS[mo]} ${d}, ${y}`,
    time: `${h12}:${pad(mi)}:${pad(s)} ${ampm}`,
    relative,
  };
}

async function dockerExec(vmName, cmd, timeout = 30000) {
  return runCmd('docker', ['exec', '-i', vmName, 'sh', '-lc', cmd], { timeout });
}

async function dockerLogs(vmName, tail = 100) {
  const r = await runCmd('docker', ['logs', '--tail', String(tail), vmName], { timeout: 15000, check: false });
  return r.stdout + r.stderr;
}

// ─── Routes: Auth API ───────────────────────────────────────

app.get('/api/session', (req, res) => {
  res.json({
    authenticated: AUTH_PASSWORD ? !!req.session?.authenticated : true,
    csrfToken: req.session?.csrfToken || '',
  });
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!AUTH_PASSWORD) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  if (!password || password !== AUTH_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  req.session.authenticated = true;
  req.session.loginTime = Date.now();
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ─── Routes: API ────────────────────────────────────────────

app.get('/api/vms', async (req, res) => {
  res.json(await getAllVms());
});

app.get('/api/agents', (req, res) => {
  const agents = registry.discoverAgents();
  const stats = registry.getAgentStats();
  res.json({ agents, stats });
});

app.post('/api/agents/:name/start', async (req, res) => {
  await runCmd('docker', ['start', req.params.name], { timeout: 30000, check: false });
  registry.dockerPsList(true);
  const agent = registry.getAgent(req.params.name);
  res.json({ ok: true, status: agent ? agent.status : 'running' });
});

app.post('/api/agents/:name/stop', async (req, res) => {
  await runCmd('docker', ['stop', req.params.name], { timeout: 30000, check: false });
  registry.dockerPsList(true);
  const agent = registry.getAgent(req.params.name);
  res.json({ ok: true, status: agent ? agent.status : 'exited' });
});

app.post('/api/agents/:name/restart', async (req, res) => {
  await runCmd('docker', ['restart', req.params.name], { timeout: 30000, check: false });
  registry.dockerPsList(true);
  const agent = registry.getAgent(req.params.name);
  res.json({ ok: true, status: agent ? agent.status : 'running' });
});

app.get('/api/config', (req, res) => {
  res.json({ containerPrefix: PREFIX });
});

app.get('/api/backups', (req, res) => {
  res.json(getBackups());
});

// ─── Agent API ──────────────────────────────────────────────

app.get('/api/agents/:name', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

app.get('/api/agents/:name/workspace', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const relativePath = req.query.path || '/';
  try {
    const listing = require('./services/workspace').listDir(agent.name, relativePath);
    res.json(listing);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agents/:name/workspace/file', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!req.query.path) return res.status(400).json({ error: 'path required' });
  try {
    const file = require('./services/workspace').readFile(agent.name, req.query.path);
    res.json(file);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/save', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const result = require('./services/workspace').writeFile(agent.name, filePath, content || '');
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/folder', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: parentPath, name: folderName } = req.body;
  try {
    require('./services/workspace').createFolder(agent.name, parentPath, folderName);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/rename', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: entryPath, new_name } = req.body;
  try {
    require('./services/workspace').renameEntry(agent.name, entryPath, new_name);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/delete', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: entryPath } = req.body;
  try {
    require('./services/workspace').deleteEntry(agent.name, entryPath);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/upload', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const multer = require('multer');
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const targetDir = req.body.path || '/';
    try {
      const destDir = require('./services/workspace').resolveSafePath(agent.workspace_root, targetDir);
      const safeName = path.basename(req.file.originalname);
      if (!safeName || safeName.startsWith('.')) return res.status(400).json({ error: 'Invalid filename' });
      fs.writeFileSync(path.join(destDir, safeName), req.file.buffer);
      res.json({ ok: true, name: safeName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

app.post('/api/agents/:name/workspace/create-file', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: relativePath, name: fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: 'File name required' });
  try {
    const dir = relativePath || '/';
    const filePath = dir === '/' ? '/' + fileName : dir + '/' + fileName;
    require('./services/workspace').writeFile(agent.name, filePath, '');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:name/workspace/download', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const relativePath = req.query.path;
  if (!relativePath) return res.status(400).send('path required');
  try {
    const absPath = require('./services/workspace').resolveSafePath(agent.workspace_root, relativePath);
    if (!fs.existsSync(absPath)) return res.status(404).send('Not found');
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) return res.status(400).send('Cannot download directory');
    if (stat.size > 50 * 1024 * 1024) return res.status(413).send('File too large');
    res.download(absPath);
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.get('/api/agents/stats/fleet', async (req, res) => {
  try {
    const r = await runCmd('docker', ['stats', '--no-stream', '--format', '{{json .}}']);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    const all = lines.map(l => JSON.parse(l));
    const prefix = process.env.CONTAINER_PREFIX || 'vm';
    const stats = all.filter(s => s.Name && s.Name.startsWith(prefix + '-'));
    res.json({ stats });
  } catch { res.json({ stats: [] }); }
});

app.get('/api/agents/:name/stats', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    const r = await runCmd('docker', ['stats', agent.runtime_ref, '--no-stream', '--format', '{{json .}}']);
    res.json({ stats: JSON.parse(r.stdout.trim()) });
  } catch { res.json({ stats: null }); }
});

app.get('/api/agents/:name/logs', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const tail = Math.min(parseInt(req.query.tail) || 100, 5000);
  try {
    const logs = await dockerLogs(agent.runtime_ref, tail);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:name/config', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const configPath = path.join(agent.config_root, 'openclaw.json');
  if (!fs.existsSync(configPath)) return res.json({ config: null });
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
    res.json({ config: redacted, configRaw: JSON.stringify(raw, null, 2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:name/config', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { config: configStr } = req.body;
  if (!configStr) return res.status(400).json({ error: 'config required' });
  try {
    const newConfig = JSON.parse(configStr);
    const configPath = path.join(agent.config_root, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2) + '\n');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agents/:name/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const activity = registry.getActivity(req.params.name, limit);
  res.json({ activity });
});

app.get('/api/agents/:name/sessions', (req, res) => {
  const db = getDb();
  const sessions = db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50').all(req.params.name);
  res.json({ sessions });
});

app.get('/api/agents/:name/backups', (req, res) => {
  const backups = getBackups(req.params.name);
  res.json({ backups });
});

app.post('/api/agents/:name/backups/create', async (req, res) => {
  try {
    await backup.backupAgent(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:name/backups/restore', async (req, res) => {
  try {
    await backup.restoreAgent(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agents/:name/backups/delete', (req, res) => {
  const file = req.body.file;
  if (!file) return res.status(400).json({ error: 'file required' });
  const safeName = path.basename(file);
  const backupPath = path.join(BACKUPS_DIR, safeName);
  if (fs.existsSync(backupPath)) {
    fs.unlinkSync(backupPath);
  }
  res.json({ ok: true });
});

// ─── API: Credentials ───────────────────────────────────────

function scanCredentialUsage() {
  const apiKeys = creds.apiKeys();
  const botTokens = creds.botTokens();
  const userIds = creds.userIDs();

  const usedBy = { apiKeys: {}, botTokens: {}, userIds: {} };
  for (const k of Object.keys(apiKeys)) usedBy.apiKeys[k] = [];
  for (const k of Object.keys(botTokens)) usedBy.botTokens[k] = [];
  for (const k of Object.keys(userIds)) usedBy.userIds[k] = [];

  const containerStates = registry.dockerPsList();

  if (!fs.existsSync(INSTANCES_DIR)) return usedBy;
  for (const dir of fs.readdirSync(INSTANCES_DIR)) {
    const configPath = path.join(INSTANCES_DIR, dir, 'openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const status = (containerStates[dir] || 'stopped').toLowerCase();

      // API keys: match by provider name
      for (const [name, ak] of Object.entries(apiKeys)) {
        const prov = ak.provider;
        if (config.models?.providers?.[prov]) {
          usedBy.apiKeys[name].push({ name: dir, status });
          continue;
        }
        for (const p of Object.values(config.auth?.profiles || {})) {
          if (p.provider === prov) {
            usedBy.apiKeys[name].push({ name: dir, status });
            break;
          }
        }
      }

      // Bot tokens: match by value
      for (const [name, bt] of Object.entries(botTokens)) {
        const tokenVal = typeof bt === 'string' ? bt : bt.token;
        for (const ch of Object.values(config.channels || {})) {
          if (ch.botToken === tokenVal || ch.token === tokenVal) {
            usedBy.botTokens[name].push({ name: dir, status });
            break;
          }
        }
      }

      // User IDs: match by value
      for (const [name, uid] of Object.entries(userIds)) {
        const uidVal = typeof uid === 'string' ? uid : (uid.uid || uid.token);
        for (const ch of Object.values(config.channels || {})) {
          if (ch.allowFrom?.includes(uidVal)) {
            usedBy.userIds[name].push({ name: dir, status });
            break;
          }
        }
      }
    } catch (e) {
      console.error(`Failed to parse ${configPath}:`, e.message);
    }
  }
  return usedBy;
}

function enrichUsedBy(credsFn, usedByKey) {
  const items = credsFn();
  const usage = scanCredentialUsage()[usedByKey] || {};
  const out = {};
  for (const [name, val] of Object.entries(items)) {
    out[name] = { ...(typeof val === 'object' ? val : { token: val, platform: 'telegram' }), used_by: usage[name] || [] };
  }
  return out;
}

app.get('/api/credentials', (req, res) => {
  res.json({
    api_keys: enrichUsedBy(creds.apiKeys, 'apiKeys'),
    bot_tokens: enrichUsedBy(creds.botTokens, 'botTokens'),
    user_ids: enrichUsedBy(creds.userIDs, 'userIds'),
  });
});

app.post('/api/credentials/api-key', (req, res) => {
  const { name, provider, key } = req.body;
  if (!name || !provider || !key) return res.status(400).json({ error: 'Name, provider, and key are required' });
  try {
    creds.addApiKey(name.trim(), provider.trim(), key.trim());
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/credentials/bot-token', (req, res) => {
  const { name, token } = req.body;
  if (!name || !token) return res.status(400).json({ error: 'Name and token are required' });
  try {
    creds.addBotToken(name.trim(), token.trim(), 'telegram');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/credentials/user-id', (req, res) => {
  const { name, uid } = req.body;
  if (!name || !uid) return res.status(400).json({ error: 'Name and user ID are required' });
  try {
    creds.addUserId(name.trim(), uid.trim(), 'telegram');
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/credentials/delete', (req, res) => {
  const { type, name } = req.body;
  if (!type || !name) return res.status(400).json({ error: 'type and name are required' });
  try {
    if (type === 'api_key') creds.deleteApiKey(name);
    else if (type === 'bot_token') creds.deleteBotToken(name);
    else if (type === 'user_id') creds.deleteUserId(name);
    else return res.status(400).json({ error: 'Invalid type' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── API: Create Agent ──────────────────────────────────────

app.post('/api/agents/create', async (req, res) => {
  const { name, agent, backup_file } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });

  try {
    await vm.createVm(name, {
      agent: agent || 'openclaw',
      mode: 'fresh',
    });
    registry.dockerPsList(true);

    // Optionally restore from backup
    if (backup_file) {
      try {
        await backup.restoreAgent(name, backup_file);
      } catch (e) { console.error('Backup restore error:', e.message); }
    }

    res.json({ ok: true, name });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── API: Onboard Agent ─────────────────────────────────────

app.post('/api/agents/:name/onboard', async (req, res) => {
  const name = req.params.name;
  const { bot_token, user_id, api_key_provider, api_key_value } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });

  try {
    if (bot_token) {
      await runCmd('docker', ['exec', name, 'openclaw', 'channels', 'add', '--channel', 'telegram', '--token', bot_token], { timeout: 30000 });
      await runCmd('docker', ['exec', name, 'openclaw', 'config', 'set', 'channels.telegram.allowFrom', JSON.stringify([user_id || process.env.DEFAULT_ALLOW_FROM || '532156945'])], { timeout: 15000 });
      await runCmd('docker', ['exec', name, 'openclaw', 'config', 'set', 'channels.telegram.dmPolicy', 'allowlist'], { timeout: 15000 });
    }
    if (api_key_provider && api_key_value) {
      await runCmd('docker', ['exec', '-i', name, 'openclaw', 'models', 'auth', 'paste-api-key', '--provider', api_key_provider], { input: api_key_value, timeout: 30000 });
    }
    res.json({ ok: true, message: 'Onboard complete' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── SPA Catch-all — serve index.html for client-side routing ─

// Redirect /new/* to /* (legacy compat)
app.use((req, res, next) => {
  if (req.path.startsWith('/new/')) {
    return res.redirect(301, req.path.slice(4) || '/');
  }
  next();
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
  res.status(200).send('<!DOCTYPE html><html><body><h1>React app not built yet. Run: cd client && npm run build</h1></body></html>');
});

// ─── Error Handlers ─────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── WebSocket Terminal ─────────────────────────────────────

const server = app.listen(5050, () => {
  console.log('VM WebUI listening on port 5050');
});

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const vmName = parts[2] || '';
  const cols = Math.max(40, Math.min(400, parseInt(url.searchParams.get('cols') || '120', 10) || 120));
  const rows = Math.max(12, Math.min(120, parseInt(url.searchParams.get('rows') || '32', 10) || 32));
  const containers = await dockerPsList(true);

  if (parts[0] !== 'ws' || parts[1] !== 'terminal' || !safeVmName(vmName) || (containers[vmName]?.State || '').toLowerCase() !== 'running') {
    ws.close();
    return;
  }

  const docker = spawn('docker', [
    'exec', '-e', 'TERM=xterm-256color', '-i', vmName,
    'sh', '-c',
    `if command -v script >/dev/null 2>&1; then exec script -qfec 'stty cols ${cols} rows ${rows}; export COLUMNS=${cols} LINES=${rows}; exec bash -i' /dev/null; else exec env COLUMNS=${cols} LINES=${rows} bash -i; fi`
  ]);
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    docker.kill();
  };

  docker.stdout.on('data', (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data.toString());
  });

  docker.stderr.on('data', (data) => {
    if (ws.readyState === ws.OPEN) ws.send(data.toString());
  });

  docker.on('close', () => {
    if (ws.readyState === ws.OPEN) ws.close();
    cleanup();
  });

  docker.on('error', () => {
    if (ws.readyState === ws.OPEN) ws.send('Connection failed');
    cleanup();
  });

  ws.on('message', (data) => {
    if (docker.stdin.destroyed) return;
    const msg = data.toString();
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
        try { execSync(`docker exec ${vmName} stty cols ${parsed.cols} rows ${parsed.rows}`, { timeout: 2000 }); } catch {}
        return;
      }
    } catch {}
    docker.stdin.write(msg.replace(/\r/g, '\n'));
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// ─── Init ───────────────────────────────────────────────────

// Initialize app metadata database
try { getDb(); console.log('App metadata database initialized'); } catch (e) { console.error('DB init error:', e.message); }

creds.importFromBotPrefixes();
