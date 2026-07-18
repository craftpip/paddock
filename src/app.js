const express = require('express');
const layouts = require('express-ejs-layouts');
const { WebSocketServer } = require('ws');
const cookieParser = require('cookie-parser');
const { execFile, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const creds = require('./creds');
const agentRoutes = require('./routes/agents');
const vm = require('./services/vm-manager');
const backup = require('./services/backup-manager');
const { getDb } = require('./services/db');
const { setupSession, requireAuth, handleLogin, handleLogout, csrfToken, AUTH_PASSWORD } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

const WORKSPACE = '/workspace';
const BACKUPS_DIR = path.join(WORKSPACE, 'backups');
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const SCRIPTS_DIR = path.join(WORKSPACE, 'scripts');
const ENV_FILE = path.join(WORKSPACE, '.env');
const VM_NAME_RE = /^vm-[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

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
app.set('view engine', 'ejs');
app.set('views', './views');
app.use(layouts);
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

setupSession(app);
app.use(csrfToken);
app.use(rateLimit);

// ─── Auth (session-based, replaces Basic Auth) ──────────────

app.get('/login', (req, res) => {
  if (!AUTH_PASSWORD) return res.redirect('/agents');
  if (req.session && req.session.authenticated) return res.redirect('/agents');
  res.render('login', { error: null });
});

app.post('/login', handleLogin);
app.get('/logout', handleLogout);

app.use((req, res, next) => {
  if (!AUTH_PASSWORD) return next();
  if (req.path === '/login' || req.path === '/logout') return next();
  if (req.path.startsWith('/ws/')) return next();
  requireAuth(req, res, next);
});

app.use((req, res, next) => {
  if (req.headers['hx-request']) {
    if (!res.__origRender) res.__origRender = res.render;
    res.render = function(view, options, fn) {
      options = options || {};
      options.layout = false;
      return res.__origRender(view, options, fn);
    };
  }
  next();
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
  const { timeout = 120, check = false, input } = options;
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
    if (!d.startsWith('vm-')) continue;
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
  const pattern = vmName ? `${vmName}_*.tar.gz` : '*.tar.gz';
  let files;
  try {
    const all = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.tar.gz'));
    if (vmName) {
      files = all.filter(f => f.startsWith(vmName + '_'));
    } else {
      files = all;
    }
    files.sort().reverse();
  } catch (e) {
    return [];
  }
  return files.map(f => {
    const p = path.join(BACKUPS_DIR, f);
    const parts = f.split('_');
    const vm = parts[0];
    const ts = parts.slice(1, 3).join('_').replace('.tar.gz', '');
    const stat = fs.statSync(p);
    return {
      file: f,
      path: p,
      vm,
      timestamp: ts,
      size: stat.size,
      size_hr: fmtSize(stat.size),
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

async function dockerExec(vmName, cmd, timeout = 30000) {
  return runCmd('docker', ['exec', '-i', vmName, 'sh', '-lc', cmd], { timeout });
}

async function dockerLogs(vmName, tail = 100) {
  const r = await runCmd('docker', ['logs', '--tail', String(tail), vmName], { timeout: 15000, check: false });
  return r.stdout + r.stderr;
}

// ─── Routes: Dashboard ──────────────────────────────────────

app.get('/', (req, res) => {
  res.redirect('/agents');
});

app.get('/hx/vm-status/:name', async (req, res) => {
  const vms = await getAllVms();
  const vm = vms.find(v => v.name === req.params.name);
  if (!vm) return res.send('<span class="text-red-400">unknown</span>');
  res.render('partials/status_badge', { vm });
});

// ─── Routes: VM Create ──────────────────────────────────────

app.get('/vm/create', (req, res) => {
  res.redirect('/agents/create');
});

app.post('/vm/create', async (req, res) => {
  let name = (req.body.name || '').trim();
  if (!name) return res.status(400).render('partials/error', { msg: 'VM name is required' });
  if (!name.startsWith('vm-')) name = 'vm-' + name;
  const agent = req.body.agent || 'openclaw';
  const mode = req.body.mode || 'fresh';
  const cloneSource = req.body.clone_source || '';
  const sshEnabled = req.body.ssh_enabled === 'yes';
  const port = (req.body.port || '').trim();
  const password = (req.body.password || '').trim();

  const botToken = (req.body.bot_token || '').trim();
  const userId = (req.body.user_id || '').trim();
  const apiKeyProvider = (req.body.api_key_provider || '').trim();
  const apiKeyValue = (req.body.api_key_value || '').trim();
  const savedBot = req.body.saved_bot_token || '';
  const savedUser = req.body.saved_user_id || '';
  const savedApikey = req.body.saved_api_key || '';

  const defaultConfig = !!(botToken || savedBot || userId || savedUser || apiKeyValue || savedApikey);
  const token = botToken || creds.botTokens()[savedBot] || '';
  const uid = userId || creds.userIDs()[savedUser] || '';

  if (defaultConfig && !token && !uid && !apiKeyValue && !savedApikey) {
    return res.status(400).render('partials/error', { msg: 'Provide a bot token, user ID, or API key' });
  }

  try {
    await vm.createVm(name, {
      agent, mode, cloneSource, sshEnabled, port, password,
      botToken: token,
      allowFrom: uid || undefined,
      defaultConfig,
    });

    let finalProvider = apiKeyProvider;
    let finalValue = apiKeyValue;
    const savedKeyData = creds.apiKeys()[savedApikey];
    if (savedKeyData) {
      finalProvider = savedKeyData.provider;
      finalValue = savedKeyData.key;
    }

    if (finalProvider && finalValue) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        await runCmd('docker', ['exec', '-i', name, 'openclaw', 'models', 'auth', 'paste-api-key', '--provider', finalProvider], { input: finalValue, timeout: 30000 });
      } catch (e) {
        console.error(`API key setup failed for ${finalProvider}:`, e.message);
      }
    }

    dockerCache.ts = 0;
    res.redirect('/agents');
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

// ─── Routes: VM Detail ──────────────────────────────────────

app.get('/vm/:name', (req, res) => {
  res.redirect('/agents/' + req.params.name);
});

app.post('/vm/:name/start', async (req, res) => {
  await runCmd('docker', ['start', req.params.name], { timeout: 30000, check: false });
  dockerCache.ts = 0;
  res.status(204).end();
});

app.post('/vm/:name/stop', async (req, res) => {
  await runCmd('docker', ['stop', req.params.name], { timeout: 30000, check: false });
  dockerCache.ts = 0;
  res.status(204).end();
});

app.post('/vm/:name/restart', async (req, res) => {
  await runCmd('docker', ['restart', req.params.name], { timeout: 30000, check: false });
  dockerCache.ts = 0;
  res.status(204).end();
});

app.post('/vm/:name/remove', async (req, res) => {
  try {
    await vm.removeVm(req.params.name);
    dockerCache.ts = 0;
    res.status(204).end();
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

app.post('/vm/:name/reset', async (req, res) => {
  try {
    await vm.resetVm(req.params.name);
    res.status(204).end();
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

function stripSensitiveMeta(meta) {
  const sanitized = { ...meta };
  delete sanitized.ROOT_PASSWORD;
  return sanitized;
}

function stripSensitiveConfig(data) {
  if (!data || typeof data !== 'object') return data;
  const sanitized = JSON.parse(JSON.stringify(data));
  if (sanitized.api_keys) sanitized.api_keys = '[REDACTED]';
  if (sanitized.telegram && sanitized.telegram.bot_token) sanitized.telegram.bot_token = '[REDACTED]';
  if (sanitized.plugins) {
    for (const key of Object.keys(sanitized.plugins)) {
      if (sanitized.plugins[key] && sanitized.plugins[key].key) sanitized.plugins[key].key = '[REDACTED]';
    }
  }
  return sanitized;
}

app.get('/vm/:name/meta', (req, res) => {
  res.json(stripSensitiveMeta(readMeta(req.params.name)));
});

app.get('/vm/:name/config', (req, res) => {
  const meta = readMeta(req.params.name);
  const agent = meta.AGENT || 'openclaw';
  const configPath = path.join(INSTANCES_DIR, req.params.name, agent, 'openclaw.json');
  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return res.json(stripSensitiveConfig(data));
    } catch (e) {
      return res.type('text/plain').send(fs.readFileSync(configPath, 'utf8'));
    }
  }
  res.status(404).send('No config file');
});

app.get('/vm/:name/logs', async (req, res) => {
  const tail = Math.min(parseInt(req.query.tail) || 200, 5000);
  const logs = await dockerLogs(req.params.name, tail);
  res.type('text/plain; charset=utf-8').send(logs);
});

app.get('/vm/:name/logs/hx', async (req, res) => {
  const tail = Math.min(parseInt(req.query.tail) || 100, 5000);
  const logs = await dockerLogs(req.params.name, tail);
  const escaped = logs.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  res.send(`<pre class="text-xs leading-tight overflow-auto max-h-96">${escaped}</pre>`);
});

// ─── Routes: Backups ────────────────────────────────────────

app.get('/backups', async (req, res) => {
  const allBackups = getBackups();
  const vms = await getAllVms();
  const grouped = {};
  for (const b of allBackups) {
    if (!grouped[b.vm]) grouped[b.vm] = [];
    grouped[b.vm].push(b);
  }
  res.render('backups', { grouped, vms });
});

app.post('/backups/:name/create', async (req, res) => {
  if (!safeVmName(req.params.name)) return res.status(400).render('partials/error', { msg: 'Invalid VM name' });
  try {
    await backup.backupAgent(req.params.name);
    dockerCache.ts = 0;
    res.status(204).end();
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

app.post('/backups/:name/restore', async (req, res) => {
  if (!safeVmName(req.params.name)) return res.status(400).render('partials/error', { msg: 'Invalid VM name' });
  try {
    await backup.restoreAgent(req.params.name);
    res.status(204).end();
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

app.post('/backups/:file/delete', (req, res) => {
  try {
    const f = safeBackupPath(req.params.file);
    if (!f) return res.status(400).render('partials/error', { msg: 'Invalid backup file' });
    if (fs.existsSync(f)) fs.unlinkSync(f);
    res.status(204).end();
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

app.get('/backups/:file/download', (req, res) => {
  const f = safeBackupPath(req.params.file);
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  const content = fs.readFileSync(f);
  res.set('Content-Type', 'application/gzip');
  res.set('Content-Disposition', `attachment; filename="${path.basename(f)}"`);
  res.send(content);
});

// ─── Routes: Onboard ────────────────────────────────────────

app.get('/onboard/:name', async (req, res) => {
  const vms = await getAllVms();
  const vm = vms.find(v => v.name === req.params.name);
  if (!vm) return res.status(404).render('partials/error', { msg: 'VM not found' });
  res.render('onboard', {
    vm,
    api_keys: creds.apiKeys(),
    bot_tokens: creds.botTokens(),
    user_ids: creds.userIDs(),
  });
});

app.post('/onboard/:name/run', async (req, res) => {
  let botToken = req.body.bot_token || '';
  const botTokenName = req.body.bot_token_name || '';
  let userId = req.body.user_id || '';
  const userIdName = req.body.user_id_name || '';
  let apiKeyProv = req.body.api_key_provider || '';
  let apiKeyVal = req.body.api_key_value || '';
  const apiKeyName = req.body.api_key_name || '';

  if (botTokenName && !botToken) botToken = creds.botTokens()[botTokenName] || '';
  if (userIdName && !userId) userId = creds.userIDs()[userIdName] || '';
  if (apiKeyName && !apiKeyVal) {
    const ak = creds.apiKeys()[apiKeyName];
    if (ak) { apiKeyProv = ak.provider; apiKeyVal = ak.key; }
  }

  if (!botToken && !apiKeyVal) {
    return res.status(400).render('partials/error', { msg: 'Provide at least a bot token or API key' });
  }

  const name = req.params.name;
  res.type('text/plain');
  try {
    let output = '';

    if (botToken) {
      await runCmd('docker', ['exec', name, 'openclaw', 'channels', 'add', '--channel', 'telegram', '--token', botToken], { timeout: 30000 });
      await runCmd('docker', ['exec', name, 'openclaw', 'config', 'set', 'channels.telegram.allowFrom', JSON.stringify([userId || process.env.DEFAULT_ALLOW_FROM || '532156945'])], { timeout: 15000 });
      await runCmd('docker', ['exec', name, 'openclaw', 'config', 'set', 'channels.telegram.dmPolicy', 'allowlist'], { timeout: 15000 });
      output += 'Telegram configured.\n';
    }

    if (apiKeyProv && apiKeyVal) {
      const r = await runCmd('docker', ['exec', '-i', name, 'openclaw', 'models', 'auth', 'paste-api-key', '--provider', apiKeyProv], { input: apiKeyVal, timeout: 30000 });
      if (r.stdout.toLowerCase().includes('auth profile')) {
        const currentModel = await runCmd('docker', ['exec', name, 'openclaw', 'config', 'get', 'agents.defaults.model.primary'], { timeout: 15000 }).catch(() => ({ stdout: '' }));
        if (!currentModel.stdout.trim() || currentModel.stdout.trim() === 'openai/gpt-5.5') {
          const sugg = { 'ollama-cloud': 'ollama-cloud/gemma4:31b', 'openrouter': 'openrouter/deepseek/deepseek-v4-flash' }[apiKeyProv];
          if (sugg) {
            await runCmd('docker', ['exec', name, 'openclaw', 'config', 'set', 'agents.defaults.model.primary', sugg], { timeout: 15000 });
          }
        }
        output += `API key configured for ${apiKeyProv}.\n`;
      } else {
        output += `Warning: ${r.stdout}\n`;
      }
    }

    output += 'Done.\n';
    res.send(output);
  } catch (e) {
    res.send(`\nError: ${e.message}\n`);
  }
});

// ─── Routes: Credentials ────────────────────────────────────

app.get('/credentials', (req, res) => {
  res.render('credentials', {
    api_keys: creds.apiKeys(),
    bot_tokens: creds.botTokens(),
    user_ids: creds.userIDs(),
    mask_key: creds.maskKey,
  });
});

app.post('/credentials/api-keys', (req, res) => {
  const name = (req.body.name || '').trim();
  const provider = (req.body.provider || '').trim();
  const key = (req.body.key || '').trim();
  if (!name || !provider || !key) {
    return res.status(400).render('partials/error', { msg: 'Name, provider, and key are required' });
  }
  try {
    creds.addApiKey(name, provider, key);
    res.render('partials/api_key_row', { name, ak: { provider, key }, mask_key: creds.maskKey });
  } catch (e) {
    res.status(400).render('partials/error', { msg: e.message });
  }
});

app.post('/credentials/api-keys/:name/delete', (req, res) => {
  creds.deleteApiKey(req.params.name);
  res.status(204).end();
});

app.post('/credentials/bot-tokens', (req, res) => {
  const name = (req.body.name || '').trim();
  const token = (req.body.token || '').trim();
  if (!name || !token) {
    return res.status(400).render('partials/error', { msg: 'Name and token are required' });
  }
  try {
    creds.addBotToken(name, token);
    res.render('partials/bot_token_row', { name, token, mask_key: creds.maskKey });
  } catch (e) {
    res.status(400).render('partials/error', { msg: e.message });
  }
});

app.post('/credentials/bot-tokens/:name/delete', (req, res) => {
  creds.deleteBotToken(req.params.name);
  res.status(204).end();
});

app.post('/credentials/user-ids', (req, res) => {
  const name = (req.body.name || '').trim();
  const uid = (req.body.uid || '').trim();
  if (!name || !uid) {
    return res.status(400).render('partials/error', { msg: 'Name and user ID are required' });
  }
  try {
    creds.addUserId(name, uid);
    res.render('partials/user_id_row', { name, uid });
  } catch (e) {
    res.status(400).render('partials/error', { msg: e.message });
  }
});

app.post('/credentials/user-ids/:name/delete', (req, res) => {
  creds.deleteUserId(req.params.name);
  res.status(204).end();
});

app.post('/credentials/import', (req, res) => {
  const changed = creds.importFromBotPrefixes();
  if (!changed) return res.status(204).end();
  res.send('<div class="text-green-400 text-sm">Imported credentials from bot-prefixes.json</div>');
});

// ─── Routes: Terminal ───────────────────────────────────────

app.get('/terminal/:name', (req, res) => {
  res.redirect('/agents/' + req.params.name);
});

// ─── Routes: API ────────────────────────────────────────────

app.get('/api/vms', async (req, res) => {
  res.json(await getAllVms());
});

app.get('/api/backups', (req, res) => {
  res.json(getBackups());
});

// ─── Agent Routes (new) ─────────────────────────────────────

app.use('/agents', agentRoutes);

// ─── Error Handlers ─────────────────────────────────────────

app.use((req, res) => {
  res.status(404).render('partials/error', { msg: 'Page not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('partials/error', { msg: err.message || 'Internal server error' });
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

  if (parts[0] !== 'ws' || parts[1] !== 'terminal' || !safeVmName(vmName) || !containers[vmName]) {
    ws.close();
    return;
  }

  const docker = spawn('docker', [
    'exec',
    '-e',
    'TERM=xterm-256color',
    '-i',
    vmName,
    'script',
    '-qfec',
    `stty cols ${cols} rows ${rows}; exec bash -i`,
    '/dev/null',
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
    docker.stdin.write(msg);
  });

  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

// ─── Init ───────────────────────────────────────────────────

// Initialize app metadata database
try { getDb(); console.log('App metadata database initialized'); } catch (e) { console.error('DB init error:', e.message); }

// Expose fmtSize to all EJS templates
app.locals.fmtSize = function(size) {
  if (!size || size === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let s = size;
  while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
  return s.toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
};

creds.importFromBotPrefixes();
