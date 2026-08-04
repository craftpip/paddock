const express = require('express');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const cookieParser = require('cookie-parser');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const { StringDecoder } = require('string_decoder');
const { Writable } = require('stream');
const Docker = require('dockerode');

const dockerClient = new Docker({ socketPath: '/var/run/docker.sock' });

const vault = require('./services/vault');
const registry = require('./services/agent-registry');
const vm = require('./services/vm-manager');
const backup = require('./services/backup-manager');
const jobLog = require('./services/job-log');
const { getDb } = require('./services/db');
const { setupSession, getSessionFromCookie, requireAuth, requireAdmin, csrfToken, csrfCheck, hashPassword, verifyPassword, checkNeedsSetup } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

const WORKSPACE = '/workspace';
const BACKUPS_DIR = path.join(WORKSPACE, 'backups');
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');
const SCRIPTS_DIR = path.join(WORKSPACE, 'scripts');
const ENV_FILE = path.join(WORKSPACE, '.env');
const AUTO_LOGIN = process.env.AUTO_LOGIN === 'true';
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

// ─── Auth: public paths, then enforce on everything else ───

app.use(checkNeedsSetup);

app.use((req, res, next) => {
  if (AUTO_LOGIN) return next();
  // Public paths — no auth needed
  const publicPaths = ['/api/setup', '/api/login', '/api/session', '/login', '/setup'];
  if (publicPaths.includes(req.path)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    return requireAuth(req, res, next);
  }
  return requireAuth(req, res, next);
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

function getBackups(vmName, userId, role) {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  let all = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.tar.gz'));
  let files = vmName ? all.filter(f => f.startsWith(vmName + '_')) : all;

  if (role !== 'admin' && userId && !vmName) {
    const db = getDb();
    const myAgents = db.prepare('SELECT name FROM agents WHERE owner_id = ?').all(userId).map(r => r.name);
    files = files.filter(f => myAgents.some(name => f.startsWith(name + '_')));
  }
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

// ─── Terminal sessions (persistent tmux shells inside the PAD) ─────────────
// Each terminal session is a tmux session living inside the PAD container, so
// it survives WebSocket disconnects and page reloads. The WS handler only
// attaches to it; closing a WS kills the attach client (a clean detach), never
// the session itself. Sessions die only when the PAD container stops or the
// user kills them from the sessions dropdown.

const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const tmuxReady = new Set(); // PAD names where tmux is confirmed present
// tmux history depth to keep + replay on fresh connections (matches xterm's
// 10000-line scrollback so the terminal behaves like a real terminal: the
// scroll survives reloads and re-attaches).
const TMUX_HISTORY = 10000;

/** One live terminal WebSocket per `${vmName}/${session}` key.
 *
 * tmux supports multiple attached clients, but each extra client makes tmux
 * full-redraw the pane from home instead of scrolling output incrementally,
 * which silently destroys xterm's scrollback. Worse, when two browser tabs (or
 * two users) have the terminal open, every connect sweeps the other's attach,
 * killing its stream and triggering a reconnect loop that fights forever.
 *
 * Single-client policy: the NEWEST connection wins. Any older connection for
 * the same key is kicked with close code 4001 (`replaced`), and the client
 * treats 4001 as "do not auto-reconnect". This guarantees exactly one attached
 * tmux client per session, so scrollback survives. */
const activeTerminals = new Map();

function safeSessionName(s) {
  if (typeof s === 'string' && SESSION_NAME_RE.test(s)) return s;
  return 'main';
}

/** Kill every `tmux attach-session -t <session>` client in the PAD.
 *
 * The dockerode hijacked stream's destroy() does NOT reliably terminate the
 * docker exec process, so every WebSocket close used to leave an orphaned
 * tmux client attached. With many clients of different sizes attached, tmux
 * full-redraws the pane from the home position instead of scrolling output
 * incrementally, so xterm's scrollback never grows (the wheel then has
 * nothing to scroll). Sweeping on connect AND close guarantees a single
 * sized client stays attached and output scrolls like a real terminal.
 * `[t]mux` avoids pkill matching its own wrapping shell command line. */
async function sweepStaleAttaches(vmName, session) {
  try {
    await runCmd('docker', ['exec', vmName, 'sh', '-lc', `pkill -f '[t]mux attach-session -t ${session}' 2>/dev/null || true`], { timeout: 10000, check: false });
  } catch {}
}

async function containerHasTmux(vmName) {
  const r = await runCmd('docker', ['exec', vmName, 'sh', '-lc', 'command -v tmux'], { timeout: 15000, check: false });
  return r.code === 0;
}

/** Lazy-install tmux once per PAD (images that predate the Dockerfile change). */
async function ensureTmux(vmName) {
  if (tmuxReady.has(vmName)) return;
  if (await containerHasTmux(vmName)) {
    tmuxReady.add(vmName);
    return;
  }
  const inst = await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc', 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends tmux'],
    { timeout: 240000, check: false }
  );
  if (inst.code !== 0) throw new Error(`tmux install failed: ${String(inst.stderr || inst.stdout || '').trim()}`);
  if (!(await containerHasTmux(vmName))) throw new Error('tmux still missing after install');
  tmuxReady.add(vmName);
}

/** Make sure a tmux session exists (create it if missing). Colored prompt is
 *  hooked into /root/.bashrc because tmux-created shells inherit the tmux
 *  server env, not the attach exec env, so the old PS1-on-exec trick is moot. */
async function ensureTmuxSession(vmName, session, cols, rows) {
  await ensureTmux(vmName);
  await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc',
      `grep -q '__PAD_PS1__' /root/.bashrc 2>/dev/null || echo "export PS1='\\[\\e[1;36m\\]\\u@\\h\\[\\e[0m\\]:\\w\\$ '  # __PAD_PS1__" >> /root/.bashrc`],
    { timeout: 15000, check: false }
  );
  // tmux attach switches the client to the alternate screen, which has no
  // scrollback — xterm.js then maps the mouse wheel to up/down arrow keys (the
  // shell recalls history instead of scrolling). Strip smcup/rmcup from the
  // attach terminal so tmux stays on the normal screen: output lands in the
  // terminal's real scrollback and the wheel scrolls it natively.
  await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc',
      `grep -q '__PAD_TMUX_V2__' /root/.tmux.conf 2>/dev/null || echo "set -ga terminal-overrides ',xterm-256color:smcup@:rmcup@'  # __PAD_TMUX_V2__" >> /root/.tmux.conf`],
    { timeout: 15000, check: false }
  );
  const has = await runCmd('docker', ['exec', vmName, 'tmux', 'has-session', '-t', session], { timeout: 15000, check: false });
  if (has.code !== 0) {
    const c = Math.max(40, Math.min(400, parseInt(cols, 10) || 120));
    const r = Math.max(12, Math.min(120, parseInt(rows, 10) || 32));
    await runCmd('docker', ['exec', vmName, 'tmux', 'new-session', '-d', '-s', session, '-x', String(c), '-y', String(r)], { timeout: 20000, check: false });
  }
  // Keep enough history that a fresh attach has something real to replay.
  await runCmd('docker', ['exec', vmName, 'sh', '-lc', `tmux set-option -g history-limit ${TMUX_HISTORY} 2>/dev/null || true`], { timeout: 15000, check: false });
  await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc',
      `tmux show-options -gqv terminal-overrides | grep -Fq 'xterm-256color:smcup@:rmcup@' || tmux set-option -ga terminal-overrides ',xterm-256color:smcup@:rmcup@'`],
    { timeout: 15000, check: false }
  );
}

async function listTmuxSessions(vmName) {
  await ensureTmux(vmName);
  // tmux 3.3a converts `\t` inside `-F` formats into `_`, so use a `|`
  // delimiter (session names are restricted to [a-zA-Z0-9._-], never `|`).
  const r = await runCmd('docker', ['exec', vmName, 'tmux', 'list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_created}'], { timeout: 15000, check: false });
  const sessions = [];
  for (const line of (r.stdout || '').split('\n')) {
    const [name, attached, created] = line.split('|');
    if (!name) continue;
    sessions.push({ name, attached: attached === '1', created: parseInt(created, 10) || 0 });
  }
  return sessions;
}

async function killTmuxSession(vmName, session) {
  await ensureTmux(vmName);
  const r = await runCmd('docker', ['exec', vmName, 'tmux', 'kill-session', '-t', session], { timeout: 15000, check: false });
  if (r.code !== 0 && !/can't find|no such|no server/i.test(String(r.stderr))) {
    throw new Error(String(r.stderr || 'tmux kill-session failed').trim());
  }
}


function requireAgentAccess(req, res, next) {
  if (req.session.role === 'admin') return next();
  const name = req.params.name;
  if (!name) return next();
  try {
    const db = getDb();
    const row = db.prepare('SELECT owner_id FROM agents WHERE name = ?').get(name);
    if (!row || row.owner_id !== req.session.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.param('name', (req, res, next, name) => {
  if (req.path.startsWith('/api/users')) return next();
  if (req.path === '/api/agents/create') return next();
  if (req.session.role === 'admin') return next();
  const db = getDb();
  const row = db.prepare('SELECT owner_id FROM agents WHERE name = ?').get(name);
  if (!row || row.owner_id !== req.session.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
});

// ─── Routes: Auth API ───────────────────────────────────────

app.get('/api/session', async (req, res) => {
  if (AUTO_LOGIN && (!req.session || !req.session.userId)) {
    try {
      const db = getDb();
      let admin = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1").get();
      if (!admin) {
        const id = 'admin_' + Date.now();
        const passwordHash = hashPassword('admin');
        db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, 'admin', 'Admin', 'admin', passwordHash);
        admin = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      }
      req.session.userId = admin.id;
      req.session.username = admin.username;
      req.session.role = admin.role;
      req.session.loginTime = Date.now();
    } catch (e) {
      console.error('Auto-login error:', e.message);
    }
  }
  res.json({
    authenticated: !!req.session?.userId,
    userId: req.session?.userId || null,
    username: req.session?.username || null,
    role: req.session?.role || null,
    csrfToken: req.session?.csrfToken || '',
  });
});

app.get('/api/setup', (req, res) => {
  try {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    res.json({ needsSetup: count === 0 });
  } catch {
    res.json({ needsSetup: true });
  }
});

app.post('/api/setup', (req, res) => {
  try {
    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
    if (count > 0) return res.status(400).json({ error: 'Admin already exists' });
  } catch { return res.status(500).json({ error: 'DB error' }); }

  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const db = getDb();
    const id = 'admin_' + Date.now();
    const passwordHash = hashPassword(password);
    db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, username.trim(), 'Admin', 'admin', passwordHash);
    res.json({ ok: true });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    if (!user) return res.status(401).json({ error: 'Invalid username or password' });
    if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });

    req.session.authenticated = true;
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    req.session.loginTime = Date.now();
    res.json({ ok: true, username: user.username, role: user.role });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

// ─── Routes: User Management (admin only) ───────────────────

app.get('/api/users', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.email, u.role, u.created_at,
        (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id) as agent_count
      FROM users u ORDER BY u.created_at ASC
    `).all();
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const db = getDb();
    const id = 'user_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const passwordHash = hashPassword(password);
    db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, username.trim(), username.trim(), role === 'admin' ? 'admin' : 'user', passwordHash);
    res.json({ ok: true, id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const passwordHash = hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(passwordHash, req.params.id);
    db.prepare('DELETE FROM user_sessions WHERE sid IN (SELECT sid FROM user_sessions WHERE json_extract(data, \'$.userId\') = ?)').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.role === 'admin') {
      const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the only admin' });
    }
    db.prepare("UPDATE agents SET owner_id = NULL WHERE owner_id = ?").run(req.params.id);
    db.prepare('DELETE FROM user_sessions WHERE sid IN (SELECT sid FROM user_sessions WHERE json_extract(data, \'$.userId\') = ?)').run(req.params.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Routes: Profile ────────────────────────────────────────

app.get('/api/profile', (req, res) => {
  try {
    const db = getDb();
    const user = db.prepare('SELECT id, username, display_name, email, role, created_at FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/profile', (req, res) => {
  const { email } = req.body;
  try {
    const db = getDb();
    db.prepare('UPDATE users SET email = ?, updated_at = datetime(\'now\') WHERE id = ?').run(email || null, req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/profile/change-password', (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
  if (new_password.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!verifyPassword(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });

    const passwordHash = hashPassword(new_password);
    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(passwordHash, req.session.userId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Routes: API ────────────────────────────────────────────

app.get('/api/vms', async (req, res) => {
  res.json(await getAllVms());
});

app.get('/api/agents', (req, res) => {
  const ownerId = req.session.role === 'admin' ? null : req.session.userId;
  const agents = registry.discoverAgents(ownerId);
  const stats = registry.getAgentStats(ownerId);
  const orphans = req.session.role === 'admin' ? registry.getOrphanCount() : 0;
  res.json({ agents, stats, orphans });
});

app.post('/api/agents/:name/assign', (req, res) => {
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const { owner_id } = req.body;
  if (!owner_id) return res.status(400).json({ error: 'owner_id required' });
  try {
    const db = getDb();
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(owner_id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE agents SET owner_id = ? WHERE name = ?').run(owner_id, req.params.name);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

app.post('/api/agents/:name/delete', async (req, res) => {
  if (!safeVmName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    await vm.removeVm(req.params.name);
    registry.removeAgentFromDb(req.params.name);
    registry.dockerPsList(true);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config', (req, res) => {
  res.json({ containerPrefix: PREFIX });
});

app.get('/api/backups', (req, res) => {
  res.json(getBackups(null, req.session.userId, req.session.role));
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

app.get('/api/agents/:name/workspace/parent', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    const listing = require('./services/workspace').listParentDir(agent.name, req.query.subpath || '');
    res.json(listing);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agents/:name/workspace/parent/file', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!req.query.path) return res.status(400).json({ error: 'path required' });
  try {
    const file = require('./services/workspace').readParentFile(agent.name, req.query.path);
    res.json(file);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/agents/:name/workspace/parent/download', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const relativePath = req.query.path;
  if (!relativePath) return res.status(400).send('path required');
  try {
    const absPath = require('./services/workspace').downloadParentFile(agent.name, relativePath);
    if (!fs.existsSync(absPath)) return res.status(404).send('Not found');
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) return res.status(400).send('Cannot download directory');
    if (stat.size > 50 * 1024 * 1024) return res.status(413).send('File too large');
    res.download(absPath);
  } catch (err) {
    res.status(400).send(err.message);
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

app.post('/api/agents/:name/workspace/parent/save', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const result = require('./services/workspace').writeParentFile(agent.name, filePath, content || '');
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

// ─── API: MCP Servers ────────────────────────────────────────

app.get('/api/agents/:name/mcp', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const agent = registry.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  try {
    const { stdout, code } = await dockerExec(name, 'cat /root/.openclaw/openclaw.json', 5000);
    if (code !== 0) return res.json({ servers: [] });
    const raw = JSON.parse(stdout);
    const mcpServers = (raw.mcp && raw.mcp.servers) || {};
    const entries = Object.entries(mcpServers).map(([name, cfg]) => ({
      name, cfg,
      transport: cfg.transport || (cfg.url ? 'streamable-http' : 'stdio'),
      command: cfg.url || [cfg.command, ...(cfg.args || [])].filter(Boolean).join(' '),
      enabled: cfg.enabled !== false,
    }));

    // Quick curl reachability check for HTTP servers
    const httpServers = entries.filter((e) => e.cfg.url);
    const statusMap = {};
    if (httpServers.length > 0) {
      const results = await Promise.all(
        httpServers.map((s) =>
          dockerExec(name, `curl -sI --connect-timeout 5 ${s.cfg.url}`, 10000)
            .then((r) => ({ name: s.name, ok: r.code === 0 }))
            .catch(() => ({ name: s.name, ok: false }))
        )
      );
      for (const r of results) statusMap[r.name] = r.ok;
    }

    const servers = entries.map(({ name, transport, command, enabled }) => ({
      name, transport, command, enabled,
      ok: name in statusMap ? statusMap[name] : null,
    }));
    res.json({ servers });
  } catch (e) {
    res.json({ servers: [], error: e.message });
  }
});

app.post('/api/agents/:name/mcp/add', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const agent = registry.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { name: serverName, command, args, url, transport, cwd, env, auth, timeout } = req.body;
  if (!serverName) return res.status(400).json({ error: 'name required' });

  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  let cmdStr = `openclaw mcp add --no-probe ${sq(serverName)}`;
  if (transport === 'streamable-http' || url) {
    cmdStr += ` --url ${sq(url || '')}`;
    if (transport) cmdStr += ` --transport ${sq(transport)}`;
  } else {
    if (command) cmdStr += ` --command ${sq(command)}`;
    if (args && Array.isArray(args)) {
      for (const a of args) cmdStr += ` --arg ${sq(a)}`;
    }
  }
  if (cwd) cmdStr += ` --cwd ${sq(cwd)}`;
  if (env && typeof env === 'object') {
    for (const [k, v] of Object.entries(env)) cmdStr += ` --env ${sq(`${k}=${v}`)}`;
  }
  if (auth === 'oauth') cmdStr += ` --auth oauth`;
  if (timeout) cmdStr += ` --timeout ${sq(String(timeout))}`;
  try {
    const { code, stderr } = await dockerExec(name, cmdStr, 30000);
    if (code !== 0) {
      return res.status(500).json({ error: stderr || 'Server add command failed' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/mcp/remove', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const { name: serverName } = req.body;
  if (!serverName) return res.status(400).json({ error: 'name required' });
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  try {
    const { code, stderr } = await dockerExec(name, `openclaw mcp unset ${sq(serverName)}`);
    if (code !== 0) {
      return res.status(500).json({ error: stderr || 'Remove command failed' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/mcp/toggle', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const agent = registry.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { name: serverName, enabled } = req.body;
  if (!serverName || typeof enabled !== 'boolean') return res.status(400).json({ error: 'name and enabled required' });
  try {
    const flag = enabled ? '--enable' : '--disable';
    await dockerExec(name, `openclaw mcp configure ${serverName} ${flag}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lightweight URL reachability check for MCP add form
app.post('/api/agents/:name/mcp/test-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    res.json({ ok: true, status: response.status });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/api/agents/:name/mcp/probe', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const { name: serverName } = req.body;
  let cmd = 'openclaw mcp probe --json';
  if (serverName) cmd = `openclaw mcp probe ${serverName} --json`;
  try {
    const { stdout, code } = await dockerExec(name, cmd, 30000);
    if (code !== 0) return res.status(500).json({ error: 'Probe failed' });
    const data = JSON.parse(stdout);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Skills ──────────────────────────────────────────

const skillsCache = { ts: 0, data: {} };

app.get('/api/agents/:name/skills', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const agent = registry.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const now = Date.now();
  const cached = skillsCache.data[name];
  if (cached && now - skillsCache.ts < 30000) return res.json(cached);

  try {
    const [listR, checkR] = await Promise.all([
      dockerExec(name, 'openclaw skills list --json', 30000),
      dockerExec(name, 'openclaw skills check --json', 30000),
    ]);
    const skills = listR.code === 0 ? JSON.parse(listR.stdout).skills || [] : [];
    const check = checkR.code === 0 ? JSON.parse(checkR.stdout) : { ok: false };
    skillsCache.data[name] = { skills, check };
    skillsCache.ts = now;
    res.json({ skills, check });
  } catch (e) {
    res.json(cached || { skills: [], check: { ok: false }, error: e.message });
  }
});

app.get('/api/agents/:name/skills/info', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const slug = req.query.name;
  if (!slug) return res.status(400).json({ error: 'name query param required' });
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  try {
    const { stdout, code } = await dockerExec(name, `openclaw skills info ${sq(slug)} --json`, 15000);
    if (code !== 0) return res.status(500).json({ error: 'Skill not found' });
    res.json(JSON.parse(stdout));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agents/:name/skills/install', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const { ref, source, as, force } = req.body;
  if (!ref) return res.status(400).json({ error: 'ref required' });
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  let cmd = `openclaw skills install ${sq(ref)}`;
  if (source === 'git') cmd = `openclaw skills install git:${sq(ref)}`;
  else if (source === 'local') cmd = `openclaw skills install ${sq(ref)}`;
  if (as) cmd += ` --as ${sq(as)}`;
  if (force) cmd += ' --force';
  try {
    const { code, stderr } = await dockerExec(name, cmd, 30000);
    if (code !== 0) return res.status(500).json({ error: stderr || 'Install failed' });
    skillsCache.data[name] = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agents/:name/skills/remove', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  try {
    const { code, stderr } = await dockerExec(name, `rm -rf /root/.openclaw/workspace/skills/${sq(slug)}`, 10000);
    if (code !== 0) return res.status(500).json({ error: stderr || 'Remove failed' });
    skillsCache.data[name] = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agents/:name/skills/update', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const { slug } = req.body;
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const cmd = slug ? `openclaw skills update ${sq(slug)}` : 'openclaw skills update --all';
  try {
    const { code, stderr } = await dockerExec(name, cmd, 30000);
    if (code !== 0) return res.status(500).json({ error: stderr || 'Update failed' });
    skillsCache.data[name] = null;
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/agents/:name/skills/verify', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  const { slug } = req.body;
  if (!slug) return res.status(400).json({ error: 'slug required' });
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  try {
    const { stdout, code } = await dockerExec(name, `openclaw skills verify ${sq(slug)} --json`, 30000);
    if (code !== 0) return res.status(500).json({ error: 'Verify failed' });
    res.json(JSON.parse(stdout));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agents/:name/activity', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const activity = registry.getActivity(req.params.name, limit);
  res.json({ activity });
});

app.post('/api/agents/:name/command-log', (req, res) => {
  const { cmd, status, ts } = req.body || {};
  if (!cmd || typeof cmd !== 'string' || !cmd.trim()) {
    return res.status(400).json({ error: 'cmd required' });
  }
  try {
    registry.recordActivity(
      req.params.name,
      'command',
      'run',
      status === 'error' ? 'error' : 'ok',
      cmd.trim(),
      ts || null
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:name/sessions', (req, res) => {
  const db = getDb();
  const sessions = db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50').all(req.params.name);
  res.json({ sessions });
});

app.get('/api/agents/:name/terminal-sessions', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid name' });
  const containers = await dockerPsList();
  if ((containers[name]?.State || '').toLowerCase() !== 'running') {
    return res.json({ sessions: [] });
  }
  try {
    res.json({ sessions: await listTmuxSessions(name) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/agents/:name/terminal-sessions/:id', async (req, res) => {
  const name = req.params.name;
  const id = safeSessionName(req.params.id);
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    await killTmuxSession(name, id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.get('/api/agents/:name/backups/download', (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'file required' });
  const safeName = path.basename(file);
  const filePath = path.join(BACKUPS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found' });
  res.download(filePath, safeName);
});

app.post('/api/agents/:name/backups/restore', async (req, res) => {
  try {
    const { file } = req.body;
    if (!file) return res.status(400).json({ error: 'file required' });
    await backup.restoreAgent(req.params.name, file);
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

// ─── API: Vault (encrypted key-value store) ────────────────

app.get('/api/vault', (req, res) => {
  try {
    res.json({ items: vault.list() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vault', csrfCheck, (req, res) => {
  const { name, description, value } = req.body;
  if (!name || !value) return res.status(400).json({ error: 'Name and value are required' });
  try {
    const item = vault.create(name.trim(), description, value);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/vault/:id', csrfCheck, (req, res) => {
  const { name, description, value } = req.body;
  try {
    const item = vault.update(Number(req.params.id), { name, description, value });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/vault/:id', csrfCheck, (req, res) => {
  try {
    vault.remove(Number(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/vault/:id/decrypt', requireAdmin, (req, res) => {
  try {
    res.json({ value: vault.getValue(Number(req.params.id)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// ─── API: Create Agent ──────────────────────────────────────

app.post('/api/agents/create', async (req, res) => {
  const { name, agent, backup_file, assign_to } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  if (registry.getAgent(name)) return res.status(409).json({ error: 'Agent already exists' });
  if (backup_file && !safeBackupPath(backup_file)) return res.status(400).json({ error: 'Invalid backup file' });

  const job = jobLog.getOrCreateJob(name);
  const log = (stream, text) => jobLog.line(job, stream, text);
  const step = (stepName, state) => jobLog.setStep(job, stepName, state);

  // Respond immediately; the create runs in the background and streams its
  // output to the SSE endpoint (GET /api/agents/:name/create-log).
  res.status(202).json({ ok: true, job: name, streaming: true });

  setImmediate(async () => {
    try {
      const isClone = !!backup_file;
      await vm.createVm(name, {
        agent: agent || 'openclaw',
        mode: 'fresh',
        skipSetup: isClone,
        onLog: log,
        onStep: step,
      });
      registry.discoverAgents();

      // Set owner_id in DB
      try {
        const db = getDb();
        let ownerId = req.session.userId;
        if (assign_to && req.session.role === 'admin') {
          const user = db.prepare('SELECT id FROM users WHERE id = ?').get(assign_to);
          if (user) ownerId = assign_to;
        }
        if (ownerId) {
          db.prepare('UPDATE agents SET owner_id = ? WHERE name = ?').run(ownerId, name);
        }
      } catch {}

      // Clone from backup: import the archive into the container
      if (isClone) {
        step('restore', 'start');
        await backup.restoreAgent(name, backup_file, log);
        step('restore', 'end');
      }

      registry.recordActivity(name, 'lifecycle', 'create', 'ok', `Agent created (type=${agent || 'openclaw'})`);
      jobLog.finish(job, true);
    } catch (e) {
      console.error(`Create failed for ${name}:`, e.message);
      // The agent may not exist in the agents table yet (createVm failed before
      // the registry sync), so recordActivity can hit an FK violation and crash
      // the whole process. Guard it.
      try {
        registry.dockerPsList(true);
        registry.discoverAgents();
        registry.recordActivity(name, 'lifecycle', 'create', 'error', e.message);
      } catch (auditErr) {
        console.error('Failed to record create error activity:', auditErr.message);
      }
      jobLog.fail(job, e.message);
    }
  });
});

// ─── API: Create Agent — live log stream (SSE) ──────────────

app.get('/api/agents/:name/create-log', (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });

  const since = parseInt(req.headers['last-event-id'], 10) || Math.max(0, parseInt(req.query.since, 10) || 0);
  const job = jobLog.getJob(name);

  if (!job) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // No job (or already cleaned up): send a terminal "gone" event.
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Create job not found (server may have restarted)' })}\n\n`);
    res.end();
    return;
  }

  jobLog.subscribe(job, res, since);
});

// ─── API: Create Agent — status poll (fallback) ─────────────

app.get('/api/agents/:name/create-status', (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const status = jobLog.getStatus(name);
  if (!status) return res.json({ done: false, found: false });
  res.json({ found: true, ...status });
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

// ─── API: Channels ──────────────────────────────────────────

app.get('/api/agents/:name/channels-status', async (req, res) => {
  const name = req.params.name;
  const agent = registry.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    const { stdout, code } = await dockerExec(name, 'openclaw channels status --json', 15000);
    if (code !== 0) return res.json({ channels: {} });
    try { res.json(JSON.parse(stdout)); } catch { res.json({ channels: {} }); }
  } catch (e) {
    res.json({ channels: {}, error: e.message });
  }
});

const channelsCache = { ts: 0, data: {} };
const CHANNELS_CACHE_TTL = 600000; // 10 minutes

app.get('/api/agents/:name/channels-list', async (req, res) => {
  const name = req.params.name;
  const agent = registry.getAgent(name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const now = Date.now();
  const force = req.query.refresh === 'true';
  const cached = channelsCache.data[name];
  if (!force && cached && now - channelsCache.ts < CHANNELS_CACHE_TTL) return res.json(cached);

  try {
    const { stdout, code } = await dockerExec(name, 'openclaw channels list --all --json', 15000);
    if (code !== 0) return res.json(cached || { channels: [] });
    const data = JSON.parse(stdout);
    channelsCache.data[name] = data;
    channelsCache.ts = now;
    res.json(data);
  } catch (e) {
    res.json(cached || { channels: [], error: e.message });
  }
});

app.post('/api/agents/:name/channels/remove', async (req, res) => {
  const name = req.params.name;
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid name' });
  const { channel } = req.body;
  if (!channel) return res.status(400).json({ error: 'channel required' });
  const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  try {
    const { code, stderr } = await dockerExec(name, `openclaw channels remove --channel ${sq(channel)} --delete`, 30000);
    if (code !== 0) return res.status(500).json({ error: stderr || 'Remove failed' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Exec ──────────────────────────────────────────────

app.post('/api/agents/:name/exec', async (req, res) => {
  const name = req.params.name;
  const { command, timeout } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  if (!command) return res.status(400).json({ error: 'Command is required' });

  try {
    const containers = await dockerPsList();
    if ((containers[name]?.State || '').toLowerCase() !== 'running')
      return res.status(400).json({ error: 'Container is not running' });

    const r = await dockerExec(name, command, timeout || 30000);
    res.json({ stdout: r.stdout, stderr: r.stderr });
  } catch (e) {
    res.status(500).json({ error: e.message, stderr: e.stderr || '' });
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

// SPA catch-all — serve index.html for client-side routing
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

// ─── Boot ───────────────────────────────────────────────────

const server = app.listen(6789, () => console.log('VM WebUI listening on port 6789'));

const wss = new WebSocketServer({ server });

wss.on('connection', async (ws, req) => {
  console.log('[wss] connection:', req.url);
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts[0] !== 'ws' || parts[1] !== 'terminal' || !safeVmName(parts[2] || '')) {
    ws.close();
    return;
  }

  const wsType = parts[1];
  const vmName = parts[2];

  // Authenticate before inspecting Docker or revealing whether the PAD exists.
  if (!AUTO_LOGIN) {
    try {
      const session = await getSessionFromCookie(req.headers.cookie || '');
      if (!session?.authenticated || !session.userId) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      if (session.role !== 'admin') {
        const agentRow = getDb().prepare('SELECT owner_id FROM agents WHERE name = ?').get(vmName);
        if (!agentRow || agentRow.owner_id !== session.userId) {
          ws.close(1008, 'Unauthorized');
          return;
        }
      }
    } catch (e) {
      console.error('WS auth error:', e.message);
      ws.close(1008, 'Unauthorized');
      return;
    }
  }

  const containers = await dockerPsList(true);

  if ((containers[vmName]?.State || '').toLowerCase() !== 'running') {
    ws.close();
    return;
  }

  // ─── Terminal WebSocket (full interactive shell via Docker Engine API) ───
  // Docker allocates a REAL PTY (`Tty: true`), so Enter, arrow keys, and
  // raw-mode TUI apps (opencode, fzf, htop, ...) behave exactly like a local
  // terminal. Resize goes through the official exec resize API instead of a
  // broken `docker exec stty` on a different process. No `\r` mangling needed:
  // the PTY line discipline handles CR/LF itself.
  if (wsType === 'terminal') {
    const cols = Math.max(40, Math.min(400, parseInt(url.searchParams.get('cols') || '120', 10) || 120));
    const rows = Math.max(12, Math.min(120, parseInt(url.searchParams.get('rows') || '32', 10) || 32));
    const session = safeSessionName(url.searchParams.get('session') || 'main');

    const termKey = `${vmName}/${session}`;
    let dockerExec = null;
    let dockerStream = null;
    let closed = false;
    const connId = Math.random().toString(36).slice(2, 6);

    const cleanup = (reason) => {
      if (closed) return;
      closed = true;
      console.log(`[wss/terminal] cleanup ${connId} ${session} reason=${reason}`);
      // Destroying the hijacked stream makes the Docker daemon kill the exec
      // process. That process is only the `tmux attach` client — the tmux
      // session inside the PAD keeps running, so state survives the disconnect.
      if (dockerStream) { try { dockerStream.destroy(); } catch {} dockerStream = null; }
      dockerExec = null;
      // destroy() does not reliably kill the exec, so sweep the session's
      // tmux clients as a backstop. Otherwise orphaned attach processes pile
      // up (multi-client redraws kill scrollback). Skipped when this
      // connection was superseded — the newer connection has already attached
      // (or is about to) and a sweep here would kill ITS tmux client too.
      if (entry.replaced) {
        console.log(`[wss/terminal] ${connId} replaced — skipping sweep`);
      } else {
        sweepStaleAttaches(vmName, session);
      }
      if (activeTerminals.get(termKey)?.cleanup === cleanup) activeTerminals.delete(termKey);
    };

    const entry = { ws, cleanup, connId, replaced: false };

    // Single-client policy: this connection replaces any older one for the
    // same PAD/session. Kicking it with 4001 makes its client stop retrying,
    // so two attached clients can never fight each other again.
    const prev = activeTerminals.get(termKey);
    if (prev && prev.ws && prev.ws.readyState === ws.OPEN) {
      console.log(`[wss/terminal] ${connId} supersedes ${prev.connId} (${termKey})`);
      prev.replaced = true;
      try { prev.ws.close(4001, 'replaced by a newer terminal connection'); } catch {}
    }
    activeTerminals.set(termKey, entry);

    try {
      // Make sure the tmux session exists (lazily installs tmux on old images).
      // Sweep stale attaches from crashed connections first so exactly one
      // client attaches below.
      await sweepStaleAttaches(vmName, session);
      await ensureTmuxSession(vmName, session, cols, rows);
    } catch (err) {
      console.error('[wss/terminal] tmux setup error:', err.message);
      if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m[Terminal error: ${err.message}]\x1b[0m\r\n`);
      ws.close();
      return;
    }

    // Fresh connection → replay tmux's persistent scrollback into the new
    // xterm first, so the terminal behaves like a real one: output from before
    // this connection (reload, PAD switch, reconnect) is still scrollable.
    // capture-pane -S grabs the whole history + current screen; the attach
    // repaint that follows redraws the same visible screen over it. If the
    // pane is mid-TUI (alternate screen) there is no history to replay and the
    // capture is just the current screen, which is still correct.
    try {
      const hist = await runCmd(
        'docker',
        ['exec', vmName, 'sh', '-lc', `tmux capture-pane -t ${session} -p -e -S -${TMUX_HISTORY} 2>/dev/null`],
        { timeout: 20000, check: false }
      );
      if (hist.code === 0 && hist.stdout && ws.readyState === ws.OPEN) {
        // capture-pane emits LF-only lines. xterm needs CRLF to return to
        // column zero; otherwise each restored line starts after the last.
        ws.send(hist.stdout.replace(/\r?\n/g, '\r\n'));
      }
    } catch (err) {
      console.error('[wss/terminal] scrollback replay error:', err.message);
    }

    try {
      const container = dockerClient.getContainer(vmName);
      dockerExec = await container.exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        // LANG is required: without a UTF-8 locale tmux assumes the client
        // cannot do Unicode and substitutes every non-ASCII glyph with `_`
        // (TUI bullets ● ◆ ○ ↑/↓ • all arrive as underscores).
        Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'],
        // Attach to the persistent tmux session instead of spawning a throwaway
        // `bash -i`. On WS close the attach client dies but the session stays,
        // so reloads and tab switches pick up exactly where they left off.
        Cmd: ['tmux', 'attach-session', '-t', session],
      });
      dockerStream = await dockerExec.start({ hijack: true, stdin: true, stdout: true, stderr: true });
    } catch (err) {
      console.error('[wss/terminal] start error:', err.message);
      if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m[Terminal error: ${err.message}]\x1b[0m\r\n`);
      ws.close();
      return;
    }

    // Set the initial PTY size (Docker allocates the exec TTY at start).
    try { await dockerExec.resize({ h: rows, w: cols }); } catch {}

    const decoder = new StringDecoder('utf8');

    // Docker multiplexes stdout+stderr as 8-byte frames:
    //   [streamType:1][reserved:3][length:4 (BE)]
    // demuxStream() strips those headers and routes each frame to the matching
    // writer. (Without this, the header bytes — including a printable length
    // byte — leak into the WebSocket and show up as stray characters.)
    const forward = () => new Writable({
      write(chunk, _enc, cb) {
        if (ws.readyState === ws.OPEN) {
          ws.send(decoder.write(chunk));
        }
        cb();
      },
    });
    const stdoutW = forward();
    const stderrW = forward();
    try {
      dockerClient.modem.demuxStream(dockerStream, stdoutW, stderrW);
    } catch (err) {
      // Fallback for non-multiplexed streams: treat the stream as raw stdout.
      dockerStream.on('data', (data) => {
        if (ws.readyState === ws.OPEN) ws.send(decoder.write(data));
      });
    }

    dockerStream.on('end', () => {
      console.log(`[wss/terminal] stream end ${connId} ${session}`);
      if (ws.readyState === ws.OPEN) { ws.send(decoder.end()); ws.close(); }
      cleanup('stream-end');
    });
    dockerStream.on('error', (err) => {
      console.error(`[wss/terminal] stream error ${connId}:`, err.message);
      if (ws.readyState === ws.OPEN) { ws.send(`\r\n\x1b[31m[Terminal error: ${err.message}]\x1b[0m\r\n`); ws.close(); }
      cleanup('stream-error');
    });

    ws.on('message', (data) => {
      if (closed || !dockerStream || dockerStream.destroyed) return;
      // Control frames are NUL-NUL-prefixed JSON:
      //   `\x00\x00{"type":"resize","cols":n,"rows":n}`
      // Raw shell bytes never start with two NULs — browsers cannot paste a
      // NUL, and a lone Ctrl+Space (single \x00) still passes through to the
      // shell. So there is no JSON.parse on keystrokes and a pasted document
      // that happens to look like a resize frame goes straight to the shell.
      const msg = data.toString();
      if (msg.charCodeAt(0) === 0 && msg.charCodeAt(1) === 0) {
        try {
          const parsed = JSON.parse(msg.slice(2));
          if (parsed.type === 'resize' && parsed.cols && parsed.rows) {
            const w = Math.max(2, parseInt(parsed.cols, 10) || 0);
            const h = Math.max(2, parseInt(parsed.rows, 10) || 0);
            if (w && h && dockerExec) dockerExec.resize({ h, w }).catch(() => {});
          }
        } catch {
          // Malformed control frame — drop it rather than corrupting the shell.
        }
        return;
      }
      dockerStream.write(data);
    });

    ws.on('close', () => cleanup('ws-close'));
    ws.on('error', cleanup);
    return;
  }
});

try { getDb(); console.log('App metadata database initialized'); } catch (e) { console.error('DB init error:', e.message); }
