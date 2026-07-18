const express = require('express');
const layouts = require('express-ejs-layouts');
const { WebSocketServer } = require('ws');
const cookieParser = require('cookie-parser');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { once } = require('events');

const creds = require('./creds');
const agentRoutes = require('./routes/agents');
const { getDb } = require('./services/db');
const { setupSession, requireAuth, handleLogin, handleLogout, csrfToken, AUTH_PASSWORD } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

const WORKSPACE = '/workspace';
const BACKUPS_DIR = path.join(WORKSPACE, 'backups');
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const SCRIPTS_DIR = path.join(WORKSPACE, 'scripts');
const USAGE_CSV = path.join(WORKSPACE, 'usage_data.csv');
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
  if (!AUTH_PASSWORD) return res.redirect('/');
  if (req.session && req.session.authenticated) return res.redirect('/');
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

function stripContainerCheck(content) {
  const lines = content.split('\n');
  const result = [];
  let skip = false;
  let depth = 0;
  for (const line of lines) {
    const stripped = line.trim();
    if (!skip && stripped.includes('if') && stripped.includes('/.dockerenv') && stripped.includes('/proc/1/cgroup')) {
      skip = true;
      depth = 1;
      continue;
    }
    if (skip) {
      if (stripped.startsWith('if ') || stripped.startsWith('elif ')) depth++;
      if (stripped === 'fi' || stripped === 'fi;' || stripped === 'fi') {
        depth--;
        if (depth <= 0) skip = false;
      }
      continue;
    }
    result.push(line);
  }
  return result.join('\n');
}

async function runWorkspaceScript(scriptRel, args, timeout = 120) {
  const scriptPath = path.join(WORKSPACE, scriptRel);
  if (!fs.existsSync(scriptPath)) throw new Error(`Script not found: ${scriptPath}`);
  let content = fs.readFileSync(scriptPath, 'utf8');
  content = stripContainerCheck(content);
  const tmpDir = fs.mkdtempSync('/tmp/vmwebui-');
  const tmp = path.join(tmpDir, 'script.sh');
  fs.writeFileSync(tmp, content);
  fs.chmodSync(tmp, 0o755);
  try {
    return await runCmd('bash', [tmp, ...args], { timeout });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}
  }
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

function readUsageCsv() {
  if (!fs.existsSync(USAGE_CSV)) return [];
  try {
    const content = fs.readFileSync(USAGE_CSV, 'utf8').trim();
    if (!content) return [];
    const lines = content.split('\n');
    const headers = lines[0].split(',');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const row = {};
      headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] || '').trim(); });
      rows.push(row);
    }
    return rows;
  } catch (e) {
    return [];
  }
}

async function dockerExec(vmName, cmd, timeout = 30000) {
  return runCmd('docker', ['exec', '-i', vmName, 'sh', '-lc', cmd], { timeout });
}

async function dockerLogs(vmName, tail = 100) {
  const r = await runCmd('docker', ['logs', '--tail', String(tail), vmName], { timeout: 15000, check: false });
  return r.stdout + r.stderr;
}

// ─── Routes: Dashboard ──────────────────────────────────────

app.get('/', async (req, res) => {
  const vms = await getAllVms();
  const running = vms.filter(v => v.status === 'running').length;
  res.render('dashboard', { vms, running, total: vms.length });
});

app.get('/hx/vm-status/:name', async (req, res) => {
  const vms = await getAllVms();
  const vm = vms.find(v => v.name === req.params.name);
  if (!vm) return res.send('<span class="text-red-400">unknown</span>');
  res.render('partials/status_badge', { vm });
});

// ─── Routes: VM Create ──────────────────────────────────────

app.get('/vm/create', async (req, res) => {
  const existing = await getAllVms();
  res.render('vm_create', { existing, bots: creds.botTokens(), users: creds.userIDs(), apikeys: creds.apiKeys() });
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
  const password = (req.body.password || '').trim() || name.slice(3);

  const botToken = (req.body.bot_token || '').trim();
  const userId = (req.body.user_id || '').trim();
  const apiKeyProvider = (req.body.api_key_provider || '').trim();
  const apiKeyValue = (req.body.api_key_value || '').trim();
  const savedBot = req.body.saved_bot_token || '';
  const savedUser = req.body.saved_user_id || '';
  const savedApikey = req.body.saved_api_key || '';

  const defaultConfig = !!(botToken || savedBot || userId || savedUser || apiKeyValue || savedApikey);

  const args = [name, '--agent', agent];
  if (mode === 'clone' && cloneSource) {
    args.push('--clone', cloneSource);
  } else {
    args.push('--fresh');
  }
  if (sshEnabled) {
    args.push('--ssh');
    if (port) args.push('--port', port);
  }
  if (password) args.push('--password', password);

  const token = botToken || creds.botTokens()[savedBot] || '';
  const uid = userId || creds.userIDs()[savedUser] || '';

  if (defaultConfig) {
    if (token) args.push('--bot-token', token);
    if (uid) args.push('--allow-from', uid);
    args.push('--default-config');
    if (!token && !uid && !apiKeyValue && !savedApikey) {
      return res.status(400).render('partials/error', { msg: 'Provide a bot token, user ID, or API key' });
    }
  }

  try {
    const result = await runWorkspaceScript('add-vm.sh', args, 180000);
    if (result.code !== 0) {
      return res.status(500).render('partials/error', { msg: result.stderr || result.stdout || 'add-vm.sh failed' });
    }

    let finalProvider = apiKeyProvider;
    let finalValue = apiKeyValue;
    const savedKeyData = creds.apiKeys()[savedApikey];
    if (savedKeyData) {
      finalProvider = savedKeyData.provider;
      finalValue = savedKeyData.key;
    }

    if (finalProvider && finalValue) {
      await new Promise(r => setTimeout(r, 3000));
      await runWorkspaceScript('scripts/onboard-bot.sh', [name, '--api-key', `${finalProvider}=${finalValue}`], 60000);
    }

    dockerCache.ts = 0;
    res.redirect('/');
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

// ─── Routes: VM Detail ──────────────────────────────────────

app.get('/vm/:name', async (req, res) => {
  const vms = await getAllVms();
  const vm = vms.find(v => v.name === req.params.name);
  if (!vm) return res.status(404).render('partials/error', { msg: 'VM not found' });
  const meta = readMeta(req.params.name);
  const agent = meta.AGENT || 'openclaw';
  const configPath = path.join(INSTANCES_DIR, req.params.name, agent, 'openclaw.json');
  let configContent = '';
  if (fs.existsSync(configPath)) {
    try {
      configContent = JSON.stringify(JSON.parse(fs.readFileSync(configPath, 'utf8')), null, 2);
    } catch (e) {
      configContent = fs.readFileSync(configPath, 'utf8');
    }
  }
  const backups = getBackups(req.params.name);
  const logPreview = await dockerLogs(req.params.name, 50);
  res.render('vm_detail', { vm, meta, configContent, backups, logPreview });
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
    const result = await runWorkspaceScript('remove-vm.sh', [req.params.name], 60000);
    if (result.code !== 0) {
      return res.status(500).render('partials/error', { msg: result.stderr || 'remove-vm.sh failed' });
    }
    dockerCache.ts = 0;
    res.status(204).end();
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

app.post('/vm/:name/reset', async (req, res) => {
  try {
    const result = await runWorkspaceScript('reset-vm.sh', [req.params.name], 120000);
    if (result.code !== 0) {
      return res.status(500).render('partials/error', { msg: result.stderr || 'reset-vm.sh failed' });
    }
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
    const result = await runWorkspaceScript('manage_backups.sh', ['backup', req.params.name], 180000);
    if (result.code !== 0 && result.stdout.includes('Failed')) {
      return res.status(500).render('partials/error', { msg: result.stdout });
    }
    dockerCache.ts = 0;
    res.status(204).end();
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
  }
});

app.post('/backups/:name/restore', async (req, res) => {
  if (!safeVmName(req.params.name)) return res.status(400).render('partials/error', { msg: 'Invalid VM name' });
  try {
    const result = await runWorkspaceScript('manage_backups.sh', ['restore', req.params.name], 180000);
    if (result.code !== 0) {
      return res.status(500).render('partials/error', { msg: result.stdout || result.stderr || 'restore failed' });
    }
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
    if (ak) {
      apiKeyProv = ak.provider;
      apiKeyVal = ak.key;
    }
  }

  const args = [req.params.name];
  if (botToken) args.push('--bot-token', botToken);
  if (userId) args.push('--allow-from', userId);
  if (apiKeyProv && apiKeyVal) args.push('--api-key', `${apiKeyProv}=${apiKeyVal}`);

  if (!botToken && !apiKeyVal) {
    return res.status(400).render('partials/error', { msg: 'Provide at least a bot token or API key' });
  }

  res.type('text/plain');
  try {
    const result = await runWorkspaceScript('scripts/onboard-bot.sh', args, 120000);
    let output = 'Starting onboard process...\n';
    output += result.stdout;
    if (result.stderr) output += result.stderr;
    if (result.code !== 0) {
      output += `\nOnboard finished with exit code ${result.code}\n`;
    } else {
      output += '\nOnboard completed successfully!\n';
    }
    res.send(output);
  } catch (e) {
    res.send(`\nError: ${e.message}\n`);
  }
});

// ─── Routes: Usage ──────────────────────────────────────────

app.get('/usage', (req, res) => {
  const rows = readUsageCsv();
  const latest = rows.length > 0 ? rows[rows.length - 1] : {};
  const chartLabels = [];
  const chartWeekly = [];
  const chartHourly = [];
  const chartTokens = [];
  const recent = rows.slice(-168);
  for (const row of recent) {
    chartLabels.push((row.timestamp || '').slice(-5));
    const w = row.weekly_pct_left;
    chartWeekly.push(w ? parseFloat(w) : null);
    const h = row.hourly_pct_left;
    chartHourly.push(h ? parseFloat(h) : null);
    const t = row.total_tokens_k;
    chartTokens.push(t ? parseFloat(t) : null);
  }
  res.render('usage', {
    rows, latest,
    chart_labels: JSON.stringify(chartLabels),
    chart_weekly: JSON.stringify(chartWeekly),
    chart_hourly: JSON.stringify(chartHourly),
    chart_tokens: JSON.stringify(chartTokens),
  });
});

app.post('/usage/refresh', async (req, res) => {
  try {
    await runWorkspaceScript('scripts/record-usage.sh', [], 60000);
    const rows = readUsageCsv();
    const latest = rows.length > 0 ? rows[rows.length - 1] : {};
    res.render('partials/usage_stats', { latest, rows });
  } catch (e) {
    res.status(500).render('partials/error', { msg: e.message });
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

app.get('/terminal/:name', async (req, res) => {
  const vms = await getAllVms();
  const vm = vms.find(v => v.name === req.params.name);
  if (!vm) return res.status(404).render('partials/error', { msg: 'VM not found' });
  res.render('terminal', { vm, fullWidth: true });
});

// ─── Routes: API ────────────────────────────────────────────

app.get('/api/vms', async (req, res) => {
  res.json(await getAllVms());
});

app.get('/api/backups', (req, res) => {
  res.json(getBackups());
});

app.get('/api/usage', (req, res) => {
  res.json(readUsageCsv());
});

app.get('/api/usage/stats', (req, res) => {
  const rows = readUsageCsv();
  res.json(rows.length > 0 ? rows[rows.length - 1] : {});
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
    if (!docker.stdin.destroyed) {
      docker.stdin.write(data.toString());
    }
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
