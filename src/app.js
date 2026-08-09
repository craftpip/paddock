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
const drivers = require('./services/drivers');
const jobLog = require('./services/job-log');
const apiKeys = require('./services/api-keys');
const containerHealth = require('./services/container-health');
const logStore = require('./services/log-store');
const { getDb } = require('./services/db');
const { runCmdStream } = require('./services/cmd');
const { setupSession, getSessionFromCookie, requireAuth, requireAdmin, csrfToken, csrfCheck, hashPassword, verifyPassword, checkNeedsSetup } = require('./middleware/auth');
const { rateLimit } = require('./middleware/rateLimit');

const WORKSPACE = '/workspace';
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

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

app.use(express.static('public'));

setupSession(app);
app.use(csrfToken);
app.use(rateLimit);

// Autologin on every request (AUTO_LOGIN mode) so a fresh session never hits
// requireAdmin/requireAuth without a role (e.g. after a container restart
// wipes the in-memory session store while a browser tab stays open).
function ensureAutoLogin(req) {
  if (!AUTO_LOGIN || !req.session || req.session.userId) return;
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
app.use((req, res, next) => { ensureAutoLogin(req); next(); });

// ─── Auth: public paths, then enforce on everything else ───

app.use(checkNeedsSetup);

app.use((req, res, next) => {
  if (AUTO_LOGIN) return next();
  // Public paths — no auth needed
  const publicPaths = ['/api/setup', '/api/login', '/api/session', '/login', '/setup', '/mcp'];
  if (publicPaths.includes(req.path)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    return requireAuth(req, res, next);
  }
  return requireAuth(req, res, next);
});

// ─── MCP server (API-key auth, see src/mcp.js) ───────────────
if (process.env.MCP_ENABLED !== 'false') {
  require('./mcp').mountMcp(app);
}

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

async function dockerExec(vmName, cmd, timeout = 30000) {
  return runCmd('docker', ['exec', '-i', vmName, 'sh', '-lc', cmd], { timeout });
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

const sqliteReady = new Set(); // PAD names where sqlite3 is confirmed present

async function containerHasSqlite(vmName) {
  const r = await runCmd('docker', ['exec', vmName, 'sh', '-lc', 'command -v sqlite3'], { timeout: 15000, check: false });
  return r.code === 0;
}

/** Lazy-install sqlite3 once per PAD (images that predate the Dockerfile
 *  change). Needed to read opencode's session DB for the terminal title. */
async function ensureSqlite3(vmName) {
  if (sqliteReady.has(vmName)) return;
  if (await containerHasSqlite(vmName)) {
    sqliteReady.add(vmName);
    return;
  }
  const inst = await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc', 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends sqlite3'],
    { timeout: 240000, check: false }
  );
  if (inst.code !== 0) throw new Error(`sqlite3 install failed: ${String(inst.stderr || inst.stdout || '').trim()}`);
  if (!(await containerHasSqlite(vmName))) throw new Error('sqlite3 still missing after install');
  sqliteReady.add(vmName);
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
    // Prefer bash over the image's default shell: busybox ash (Alpine images,
    // e.g. picoclaw) echoes `^C` with an extra newline on Ctrl+C, leaving a
    // blank line before the next prompt. bash emits a clean single newline.
    const bash = await runCmd('docker', ['exec', vmName, 'sh', '-lc', 'command -v bash'], { timeout: 15000, check: false });
    const shellCmd = bash.code === 0 && bash.stdout.trim() ? bash.stdout.trim() : null;
    const args = ['tmux', 'new-session', '-d', '-s', session, '-x', String(c), '-y', String(r)];
    if (shellCmd) args.push(shellCmd);
    await runCmd('docker', ['exec', vmName, ...args], { timeout: 20000, check: false });
  }
  // Keep enough history that a fresh attach has something real to replay.
  await runCmd('docker', ['exec', vmName, 'sh', '-lc', `tmux set-option -g history-limit ${TMUX_HISTORY} 2>/dev/null || true`], { timeout: 15000, check: false });
  // The webui draws its own session chrome — a tmux status bar in the pane
  // would only duplicate it (the green `[main] 0:bash` line). Kill it globally
  // so the pane shows pure app output. Idempotent: no-op on later connects.
  await runCmd('docker', ['exec', vmName, 'sh', '-lc', 'tmux set-option -g status off 2>/dev/null || true'], { timeout: 15000, check: false });
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

/** Title of the opencode session the TUI is showing, e.g. `Casual greeting`.
 *  Read straight from opencode's SQLite store (cheap, works while the TUI
 *  runs — the `opencode session list` CLI re-bootstraps the whole instance
 *  and blocks behind the TUI's lock). The webui mirrors the TUI's prompt
 *  `OC | <title>` in the terminal header. Empty string when there's no
 *  session yet (or this isn't an opencode agent). */
async function opencodeSessionTitle(vmName) {
  const r = await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc',
      'sqlite3 /root/.opencode/data/opencode/opencode.db "SELECT title FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 1" 2>/dev/null'],
    { timeout: 10000, check: false }
  );
  if (r.code !== 0) return '';
  return String(r.stdout || '').trim();
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

app.get('/api/session', (req, res) => {
  ensureAutoLogin(req);
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
  const uname = String(username || '').trim();
  if (!uname || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!/^[A-Za-z0-9]{3,32}$/.test(uname)) return res.status(400).json({ error: 'Username must be 3-32 letters or numbers' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const db = getDb();
    const id = 'admin_' + Date.now();
    const passwordHash = hashPassword(password);
    db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, uname, 'Admin', 'admin', passwordHash);
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
  const { password, role } = req.body;
  const username = String(req.body.username || '').trim();
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (!/^[A-Za-z0-9]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-32 letters or numbers' });
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const db = getDb();
    const id = 'user_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
    const passwordHash = hashPassword(password);
    db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run(id, username, username, role === 'admin' ? 'admin' : 'user', passwordHash);
    res.json({ ok: true, id });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
  const { password, current_password } = req.body;
  if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  try {
    const db = getDb();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Resetting your own password requires the current password, like the
    // profile change-password flow. Admins resetting another user's password
    // do not need it.
    if (user.id === req.session.userId) {
      if (!current_password) return res.status(400).json({ error: 'Current password required' });
      if (!verifyPassword(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
    }

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
  const email = String(req.body.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Email is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
  try {
    const db = getDb();
    db.prepare('UPDATE users SET email = ?, updated_at = datetime(\'now\') WHERE id = ?').run(email, req.session.userId);
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

// ─── Routes: Profile API Keys (MCP bearer tokens) ───────────

app.get('/api/profile/keys', (req, res) => {
  try {
    res.json({ keys: apiKeys.listForUser(req.session.userId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/profile/keys', csrfCheck, (req, res) => {
  const { name, scopes } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  const trimmedName = String(name).trim().slice(0, 64);
  if (!/^[A-Za-z0-9]{3,64}$/.test(trimmedName)) return res.status(400).json({ error: 'Key name must be 3-64 letters or numbers' });

  try {
    const allowedScopes = ['default', 'read', 'control'];
    let scopesStr = 'default';
    if (scopes) {
      const list = Array.isArray(scopes) ? scopes : String(scopes).split(',').map((s) => s.trim());
      const unknown = list.filter((s) => !allowedScopes.includes(s));
      if (unknown.length) return res.status(400).json({ error: `Unknown scope(s): ${unknown.join(', ')}` });
      if (!list.length) return res.status(400).json({ error: 'At least one scope required' });
      scopesStr = [...new Set(list)].join(',');
    }
    const { key, row } = apiKeys.create(req.session.userId, trimmedName, scopesStr);
    res.json({ key, ...row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/profile/keys/:id', csrfCheck, (req, res) => {
  try {
    if (!apiKeys.remove(req.params.id, req.session.userId)) {
      return res.status(404).json({ error: 'Key not found' });
    }
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
  const name = req.params.name;
  registry.setLifecycle(name, 'starting');
  try {
    await vm.startAgent(name);
  } finally {
    registry.setLifecycle(name, null);
  }
  registry.dockerPsList(true);
  const agent = registry.getAgent(req.params.name);
  res.json({ ok: true, status: agent ? agent.status : 'running' });
});

app.post('/api/agents/:name/stop', async (req, res) => {
  const name = req.params.name;
  registry.setLifecycle(name, 'stopping');
  try {
    await vm.stopAgent(name);
  } finally {
    registry.setLifecycle(name, null);
  }
  registry.dockerPsList(true);
  const agent = registry.getAgent(req.params.name);
  res.json({ ok: true, status: agent ? agent.status : 'exited' });
});

app.post('/api/agents/:name/restart', async (req, res) => {
  const name = req.params.name;
  registry.setLifecycle(name, 'restarting');
  try {
    await vm.restartAgent(name);
  } finally {
    registry.setLifecycle(name, null);
  }
  registry.dockerPsList(true);
  const agent = registry.getAgent(req.params.name);
  res.json({ ok: true, status: agent ? agent.status : 'running' });
});

app.post('/api/agents/:name/delete', async (req, res) => {
  if (!safeVmName(req.params.name)) return res.status(400).json({ error: 'Invalid name' });
  try {
    await logStore.capture(req.params.name);
    await vm.removeVm(req.params.name);
    registry.removeAgentFromDb(req.params.name);
    jobLog.clearJob(req.params.name);
    jobLog.clearJob('update:' + req.params.name);
    registry.dockerPsList(true);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Agent Settings / Update ────────────────────────────────

/** All containers visible to the webui — the Network dropdown source. */
app.get('/api/containers', async (req, res) => {
  try {
    const containers = await dockerPsList();
    const list = Object.values(containers)
      .map((c) => ({
        name: Array.isArray(c.Names) ? String(c.Names[0] || '').replace(/^\//, '') : String(c.Names || c.ID || '').replace(/^\//, ''),
        image: c.Image || '',
        state: (c.State || '').toLowerCase(),
      }))
      .filter((c) => c.name);
    res.json({ containers: list });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Path probing (plan 40) ──────────────────────────────────
// Read-only filesystem probes for the Create Agent workspace source field:
// existence/writability/compose detection plus autocomplete suggestions. The
// one-to-one mount rule means "exists in the container" ≈ "valid host source".

const pathProbe = require('./services/path-probe');

app.get('/api/paths/probe', (req, res) => {
  try {
    res.json(pathProbe.probe(String(req.query.path || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/paths/autocomplete', (req, res) => {
  try {
    res.json(pathProbe.autocomplete(String(req.query.q || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Volumes exposed by a workspace folder's project (compose file + running
 *  container supplement), normalized for the Create Agent form's volume
 *  pre-fill (plan 40, D2/D4/D6). */
app.get('/api/paths/volumes', async (req, res) => {
  try {
    res.json(await pathProbe.discoverVolumes(String(req.query.path || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/agents/:name/settings', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
    res.json(await vm.readSettings(name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Lazy-loaded raw container info for the Settings → Container Info popup.
 *  Runs `docker inspect <name>` on demand (never on page load) and returns a
 *  summarized view + the (env-redacted) raw inspect object. Shared with the MCP
 *  `settings_get` surface via `vm.containerInfo`. */
app.get('/api/agents/:name/container-info', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    res.json(await vm.containerInfo(name));
  } catch (e) {
    res.status(/not found/i.test(e.message) ? 404 : 500).json({ error: e.message });
  }
});

/** Version info for the Update confirm dialog: current vs available (latest
 *  base image). Lets the user judge whether an update actually exists before
 *  committing to a rebuild. */
app.get('/api/agents/:name/update-info', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
    const driver = drivers.getDriver(meta.AGENT || 'openclaw');
    const current = (await driver.currentVersion(name)) || meta.OPENCLAW_VERSION || '';
    const available = await driver.availableVersion();
    const updateAvailable = !!(current && available && current !== available);
    res.json({ currentVersion: current, availableVersion: available, updateAvailable });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/settings', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const body = req.body || {};
  try {
    // Shared validation + change detection (plan 30) — the same
    // `prepareAgentChanges` the MCP recreate tool uses. An invalid request
    // returns 400 immediately instead of starting an SSE job.
    const ctx = await vm.prepareAgentChanges(name, body);
    if (!ctx.changed) {
      return res.json({
        allowDocker: ctx.newAllow,
        network: ctx.newNetwork,
        sshPort: ctx.newSshPort,
        sshContainerPort: ctx.newSshCport,
        image: vm.imageFor(name),
        workspaceMount: ctx.oldMount,
        extraVolumes: ctx.newVols,
      });
    }

    // Persist the requested docker state in the instance build.env — the toggle
    // is self-describing: the next rebuild reads INSTALL_DOCKER from the
    // env-file, no ad-hoc --build-arg needed. Turning docker off writes
    // INSTALL_DOCKER=0 for the next rebuild (the CLI stays in the current image
    // until then); the socket mount is controlled immediately by the compose
    // regen inside applyAgentChanges.
    vm.setBuildEnv(name, { INSTALL_DOCKER: ctx.newAllow ? '1' : '0' });

    // Any change that needs a recreate runs as an SSE job (like Update) so the
    // frontend can stream the live command output in a popup console.
    const jobKey = 'update:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state) => jobLog.setStep(job, stepName, state);

    res.status(202).json({ ok: true, job: jobKey, streaming: true, reason: ctx.reason });

    setImmediate(async () => {
      registry.setRestarting(name, true);
      try {
        await logStore.capture(name);
        // The consolidated flow (shared with MCP recreate): validate → web hook
        // → applySettings (regenerate compose) → validateInstanceCompose →
        // stop → rebuild (docker-CLI / custom SSH cport / pull) or recreate →
        // door reconcile → web re-exec + verify → restore stopped state, with
        // rollback on failure.
        await vm.applyAgentChanges(name, body, { onLog: log, onStep: step });
        registry.dockerPsList(true);
        registry.discoverAgents();
        try {
          registry.recordActivity(name, 'settings', 'update', 'ok', `Settings updated (${ctx.summary.join(', ')})`);
        } catch {}
        log('system', 'Done — container recreated');
        jobLog.finish(job, true);
      } catch (e) {
        console.error(`Settings change failed for ${name}:`, e.message);
        try {
          registry.recordActivity(name, 'settings', 'update', 'error', e.message);
        } catch {}
        jobLog.fail(job, e.message);
      } finally {
        registry.setRestarting(name, false);
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Web publishing (built-in web app) ─────────────────────

function readHookPassword(hookPath) {
  if (!fs.existsSync(hookPath)) return '';
  const content = fs.readFileSync(hookPath, 'utf8');
  const m = /OPENCODE_SERVER_PASSWORD='([^']*)'/.exec(content);
  return m ? m[1] : '';
}

/** True when the given host port is published by any OTHER agent — either a
 *  declared compose port (other instances) or a live docker published port. */
/** Boot-time sweep: drop any <name>-door / <name>-web forwarding containers
 *  whose agent (instances/<name>) no longer exists. Door containers survive
 *  `removeVm` of the agent in older code, so a deleted agent's door keeps
 *  holding its host port forever and blocks other agents from reusing it. */
async function cleanOrphanDoors() {
  const all = await dockerPsList();
  for (const cname of Object.keys(all)) {
    const m = /^(.*)-(door|web)$/.exec(cname);
    if (!m) continue;
    const base = m[1];
    if (fs.existsSync(path.join(INSTANCES_DIR, base))) continue;
    console.log(`[orphan-door] removing ${cname} (agent ${base} gone)`);
    await runCmd('docker', ['rm', '-f', cname], { timeout: 30000 }).catch(() => {});
  }
}

/** Effective network peer name of an agent — meta.NETWORK, falling back to the
 *  compose file (legacy agents predate the meta flag). Empty = default network. */
function currentNetworkPeer(name) {
  const meta = readMeta(name);
  if (meta.NETWORK) return meta.NETWORK;
  try {
    const cf = path.join(INSTANCES_DIR, name, 'docker-compose.yml');
    const m = /network_mode:\s*container:(\S+)/.exec(fs.readFileSync(cf, 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

app.get('/api/agents/:name/web', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
    const agentType = meta.AGENT || 'openclaw';
    const driver = drivers.getDriver(agentType);
    // Extra Docker ports (plan 28) are independent of the built-in web app and
    // always reported — even for agent types with no web app to publish.
    const extraPorts = vm.readExtraPorts(name);
    if (!driver.webApp) return res.json({ webApp: null, extraPorts, sshPort: meta.PORT || '', sshContainerPort: vm.readSshCport(name) });

    const webService = vm.readWebService(name);
    const active = !!webService;
    let password = '';
    if (active) {
      password = readHookPassword(vm.webHookPath(name, agentType));
    }

    // The published port lives on the agent itself on the default network, but
    // on the socat door container when the agent routes through a network peer
    // (the agent can't publish ports in that mode).
    const netPeer = currentNetworkPeer(name);
    const portContainer = netPeer ? vm.doorName(name) : name;
    let actualPorts = [];
    try {
      const p = await runCmd('docker', ['inspect', portContainer, '--format', '{{json .NetworkSettings.Ports}}'], { timeout: 15000 });
      const ports = JSON.parse(p.stdout || '{}');
      actualPorts = Object.keys(ports).map((k) => {
        const pub = ports[k] && ports[k][0];
        return { container: k, host: pub ? pub.HostPort : null };
      });
    } catch {}

    res.json({
      webApp: {
        label: driver.webApp.label,
        docs: driver.webApp.docs || '',
        containerPort: driver.webApp.containerPort,
        auth: driver.webApp.auth
          ? { label: driver.webApp.auth.label, hint: driver.webApp.auth.hint || '' }
          : null,
      },
      active,
      networkMode: netPeer,
      webService: active ? webService : null,
      passwordConfigured: active && !!password,
      startCommand: active ? driver.webApp.startCommand({ password, containerPort: webService.containerPort }) : '',
      actualPorts,
      extraPorts,
      sshPort: meta.PORT || '',
      sshContainerPort: vm.readSshCport(name),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/web', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const { active, hostPort, containerPort, password } = req.body || {};
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
    const agentType = meta.AGENT || 'openclaw';
    const driver = drivers.getDriver(agentType);
    if (!driver.webApp) return res.status(400).json({ error: 'This agent type has no web app to publish' });

    const turningOn = !!active;
    // Shared flow (plan 30): the web POST maps onto the `web` option of the
    // consolidated applyAgentChanges — write web.json + boot hook, regenerate
    // the compose, recreate, reconcile the socat door, exec the start hook and
    // verify. Invalid bindings return 400 immediately.
    const body = { web: { active: turningOn } };
    if (turningOn) {
      body.web.hostPort = hostPort;
      if (containerPort) body.web.containerPort = containerPort;
      if (typeof password === 'string') body.web.password = password;
    }
    await vm.prepareAgentChanges(name, body);

    const jobKey = 'update:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state) => jobLog.setStep(job, stepName, state);

    res.status(202).json({ ok: true, job: jobKey, streaming: true, action: turningOn ? 'activate' : 'deactivate' });

    setImmediate(async () => {
      registry.setRestarting(name, true);
      try {
        await logStore.capture(name);
        const result = await vm.applyAgentChanges(name, body, { onLog: log, onStep: step });
        registry.dockerPsList(true);
        registry.discoverAgents();
        const published = result.webService ? result.webService.hostPort : hostPort;
        try {
          registry.recordActivity(name, 'web', turningOn ? 'publish' : 'unpublish', 'ok',
            turningOn ? `Web app published on host port ${published}` : 'Web app unpublished');
        } catch {}
        log('system', turningOn ? `Done — web app live at http://10.69.1.164:${published}` : 'Done — web app removed');
        jobLog.finish(job, true);
      } catch (e) {
        console.error(`Web change failed for ${name}:`, e.message);
        try {
          registry.recordActivity(name, 'web', turningOn ? 'publish' : 'unpublish', 'error', e.message);
        } catch {}
        jobLog.fail(job, e.message);
      } finally {
        registry.setRestarting(name, false);
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ─── Additional Docker ports (plan 28) ──────────────────────

/** Full-replace the agent's declared extra ports (independent of the built-in
 *  web app). Same SSE-job shape as settings: validate → stop → applySettings
 *  (regenerates the compose, preserving web/workspace/volumes) → recreate.
 *  Never touches web.json. */
app.post('/api/agents/:name/ports', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const { extraPorts } = req.body || {};
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

    // Shared flow (plan 30): validate + full-replace the extra ports through
    // the consolidated change set (peer mode included — extra ports ride the
    // agent's socat door, never its own ports).
    const body = { extraPorts: extraPorts || [] };
    const ctx = await vm.prepareAgentChanges(name, body);
    if (!ctx.changed) return res.json({ extraPorts: ctx.newPorts });

    const jobKey = 'update:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state) => jobLog.setStep(job, stepName, state);

    res.status(202).json({ ok: true, job: jobKey, streaming: true, action: 'ports' });

    setImmediate(async () => {
      registry.setRestarting(name, true);
      const portsChanged = ctx.newPorts.length
        ? `extraPorts=${ctx.newPorts.map((p) => `${p.host}→${p.container}`).join(', ')}`
        : 'extraPorts=none';
      try {
        await logStore.capture(name);
        await vm.applyAgentChanges(name, body, { onLog: log, onStep: step });
        registry.dockerPsList(true);
        registry.discoverAgents();
        try {
          registry.recordActivity(name, 'ports', 'update', 'ok', portsChanged);
        } catch {}
        log('system', 'Done — container recreated with the new ports');
        jobLog.finish(job, true);
      } catch (e) {
        console.error(`Ports change failed for ${name}:`, e.message);
        try {
          registry.recordActivity(name, 'ports', 'update', 'error', e.message);
        } catch {}
        jobLog.fail(job, e.message);
      } finally {
        registry.setRestarting(name, false);
      }
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/agents/:name/recreate', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const { pull = false, reset = false } = req.body || {};
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

    const containers = await dockerPsList();
    const current = containers[name];
    const wasRunning = current && (current.State || '').toLowerCase() === 'running';

    const jobKey = 'update:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state) => jobLog.setStep(job, stepName, state);

    res.status(202).json({ ok: true, job: jobKey, streaming: true, reason: 'recreate' });

    setImmediate(async () => {
      registry.setRestarting(name, true);
      try {
        await logStore.capture(name);
        // Validate the compose BEFORE stopping — a malformed document aborts
        // with the container still running instead of stranding it stopped.
        await vm.validateInstanceCompose(name);
        if (pull || reset) {
          // Settings "Recreate Container": optional latest-image pull + optional
          // full user-data wipe, always ending with a force-recreate.
          await vm.recreateAgent(name, { pull, reset, onLog: log, onStep: step });
          if (pull) {
            try {
              const v = await drivers.getDriver(meta.AGENT || 'openclaw').currentVersion(name);
              if (v) vm.setMetaFlag(name, 'OPENCLAW_VERSION', v);
            } catch {}
          }
        } else {
          // Plain recreate (e.g. network peer re-resolve from the health tab).
          if (wasRunning) {
            step('stop', 'start');
            await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 });
            step('stop', 'end');
          }
          log('system', 'Recreating container to re-resolve the network peer…');
          step('recreate', 'start');
          await vm.runCompose(name, ['up', '-d', '--no-deps', '--force-recreate', name], { stream: true, onLog: log, timeout: 300000 });
          step('recreate', 'end');
          if (!wasRunning) {
            try { await runCmd('docker', ['stop', '-t', '30', name], { timeout: 60000 }); } catch {}
          }
        }
        registry.dockerPsList(true);
        registry.discoverAgents();
        try {
          const reason = reset
            ? 'User data reset and container recreated'
            : pull
              ? 'Image updated and container recreated'
              : 'Container recreated (network peer re-resolved)';
          registry.recordActivity(name, 'settings', 'recreate', 'ok', reason);
        } catch {}
        log('system', 'Done — container recreated');
        jobLog.finish(job, true);
      } catch (e) {
        console.error(`Recreate failed for ${name}:`, e.message);
        try {
          registry.recordActivity(name, 'settings', 'recreate', 'error', e.message);
        } catch {}
        jobLog.fail(job, e.message);
      } finally {
        registry.setRestarting(name, false);
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/agents/:name/update', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const meta = readMeta(name);
  if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

  const jobKey = 'update:' + name;
  const job = jobLog.getOrCreateJob(jobKey);
  const log = (stream, text) => jobLog.line(job, stream, text);
  const step = (stepName, state) => jobLog.setStep(job, stepName, state);

  res.status(202).json({ ok: true, job: jobKey, streaming: true });

  setImmediate(async () => {
    try {
      await logStore.capture(name);
      await vm.updateAgent(name, {
        onLog: log,
        onStep: (stepName, state) => {
          step(stepName, state);
          // The old container stays up through the build; only during the
          // recreate is it actually down. Report `restarting` for that window.
          if (stepName === 'recreate') {
            if (state === 'start') registry.setRestarting(name, true);
            else if (state === 'end' || state === 'error') registry.setRestarting(name, false);
          }
        },
      });
      registry.dockerPsList(true);
      registry.discoverAgents();
      try {
        const meta = readMeta(name);
        const v = await drivers.getDriver(meta.AGENT || 'openclaw').currentVersion(name);
        if (v) vm.setMetaFlag(name, 'OPENCLAW_VERSION', v);
      } catch {}
      jobLog.line(job, 'system', 'Done — container recreated');
      jobLog.finish(job, true);
      try {
        registry.recordActivity(name, 'lifecycle', 'update', 'ok', 'Image updated and container recreated');
      } catch {}
    } catch (e) {
      console.error(`Update failed for ${name}:`, e.message);
      try {
        registry.recordActivity(name, 'lifecycle', 'update', 'error', e.message);
      } catch {}
      jobLog.fail(job, e.message);
    } finally {
      registry.setRestarting(name, false);
    }
  });
});

app.get('/api/agents/:name/update-log', (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const since = parseInt(req.headers['last-event-id'], 10) || Math.max(0, parseInt(req.query.since, 10) || 0);
  const job = jobLog.getJob('update:' + name);

  if (!job) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Update job not found (server may have restarted)' })}\n\n`);
    res.end();
    return;
  }

  jobLog.subscribe(job, res, since);
});

// ─── Container health checkup ──────────────────────────────

/** Passive report (no job) — powers the health pill on the Settings tab. */
app.get('/api/agents/:name/health', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const report = await containerHealth.checkContainerHealth(name);
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Run the checkup as a job so each check streams live to the popup. */
app.post('/api/agents/:name/health-check', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });

    const jobKey = 'health:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const onCheck = (c) => jobLog.check(job, c);

    res.status(202).json({ ok: true, job: jobKey, streaming: true });

    setImmediate(async () => {
      try {
        const report = await containerHealth.checkContainerHealth(name, onCheck);
        jobLog.finish(job, true, { status: report.status, counts: report.counts });
      } catch (e) {
        console.error(`Health check failed for ${name}:`, e.message);
        jobLog.fail(job, e.message);
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** SSE stream for the health-check job (mirrors update-log). */
app.get('/api/agents/:name/health-log', (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  const since = parseInt(req.headers['last-event-id'], 10) || Math.max(0, parseInt(req.query.since, 10) || 0);
  const job = jobLog.getJob('health:' + name);

  if (!job) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: error\ndata: ${JSON.stringify({ message: 'Health check job not found (run a health check first)' })}\n\n`);
    res.end();
    return;
  }

  jobLog.subscribe(job, res, since);
});

app.get('/api/config', (req, res) => {
  res.json({
    containerPrefix: PREFIX,
    hostWorkspaceRoot: vm.HOST_WORKSPACE || process.env.HOST_WORKSPACE_ROOT || '',
    workspaceRoot: vm.WORKSPACE || process.env.WORKSPACE_ROOT || '/workspace',
    host: process.env.HOST_NAME || '',
    hostProtocol: process.env.HOST_PROTO || 'http',
  });
});

// ─── Agent type registry (drivers) ─────────────────────────────

/** All known agent types — feeds the CreateAgent select and anything that
 *  needs a per-type list. Includes each type's setup steps so the create
 *  console can show the real command instead of a hardcoded one. */
app.get('/api/agent-types', (req, res) => {
  res.json({ types: drivers.listDrivers() });
});

/** Command groups for one agent type — the "buttons" on the Commands tab
 *  live in the driver, not in the frontend bundle. tuiCommand is the command
 *  that launches the agent's interactive TUI (openclaw / opencode / …). */
app.get('/api/agent-types/:type/commands', (req, res) => {
  const driver = drivers.getDriver(req.params.type);
  res.json({ type: driver.type, commands: driver.commands, tuiCommand: driver.tuiCommand || 'openclaw' });
});

// ─── Agent API ──────────────────────────────────────────────

app.get('/api/agents/:name', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
});

app.get('/api/agents/:name/workspace', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const relativePath = req.query.path || '/';
  const scope = req.query.scope || 'host';
  try {
    const listing = await require('./services/workspace').listDir(agent.name, relativePath, scope);
    res.json(listing);
  } catch (err) {
    const status = err.message === 'Container is not running' ? 503 : 400;
    res.status(status).json({ error: err.message });
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

app.get('/api/agents/:name/workspace/file', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (!req.query.path) return res.status(400).json({ error: 'path required' });
  try {
    const file = await require('./services/workspace').readFile(agent.name, req.query.path, req.query.scope || 'host');
    res.json(file);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/save', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: filePath, content } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  try {
    const result = await require('./services/workspace').writeFile(agent.name, filePath, content || '', req.body.scope || 'host');
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

app.post('/api/agents/:name/workspace/folder', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: parentPath, name: folderName } = req.body;
  try {
    await require('./services/workspace').createFolder(agent.name, parentPath, folderName, req.body.scope || 'host');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/rename', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: entryPath, new_name } = req.body;
  try {
    await require('./services/workspace').renameEntry(agent.name, entryPath, new_name, req.body.scope || 'host');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/delete', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: entryPath } = req.body;
  try {
    await require('./services/workspace').deleteEntry(agent.name, entryPath, req.body.scope || 'host');
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/agents/:name/workspace/move', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: fromPath, to } = req.body;
  try {
    await require('./services/workspace').moveEntry(agent.name, fromPath, to, req.body.scope || 'host');
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
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const targetDir = req.body.path || '/';
    const scope = req.body.scope || 'host';
    try {
      await require('./services/workspace').writeFileB64(agent.name, targetDir, req.file.originalname, req.file.buffer, scope);
      res.json({ ok: true, name: path.basename(req.file.originalname) });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  });
});

app.post('/api/agents/:name/workspace/upload-multiple', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const multer = require('multer');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: require('./services/workspace').MAX_UPLOAD_SIZE },
  });
  upload.array('files', 2000)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
    const targetDir = req.body.path || '/';
    const scope = req.body.scope || 'host';
    const ws = require('./services/workspace');
    const relPaths = Array.isArray(req.body.paths) ? req.body.paths : (req.body.paths ? [req.body.paths] : []);
    try {
      let uploaded = 0;
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        const rel = String(relPaths[i] || file.originalname || '').replace(/\\/g, '/');
        const safeName = path.posix.basename(rel);
        if (!safeName || safeName.startsWith('.') || rel.split('/').includes('..')) continue;
        const sub = path.posix.dirname(rel);
        const destDir = sub === '.' ? targetDir : path.posix.join(targetDir, sub);
        await ws.createDirectories(agent.name, destDir, scope);
        await ws.writeFileB64(agent.name, destDir, safeName, file.buffer, scope);
        uploaded++;
      }
      res.json({ ok: true, uploaded });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  });
});

app.post('/api/agents/:name/workspace/create-file', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const { path: relativePath, name: fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: 'File name required' });
  try {
    const dir = relativePath || '/';
    const filePath = dir === '/' ? '/' + fileName : dir + '/' + fileName;
    await require('./services/workspace').writeFile(agent.name, filePath, '', req.body.scope || 'host');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:name/workspace/download', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const relativePath = req.query.path;
  if (!relativePath) return res.status(400).send('path required');
  try {
    const file = await require('./services/workspace').readFileB64(agent.name, relativePath, req.query.scope || 'host');
    if (file.error) return res.status(404).send(file.error);
    if (file.size > 50 * 1024 * 1024) return res.status(413).send('File too large');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name || 'download')}"`);
    res.send(Buffer.from(file.content, 'base64'));
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
    await logStore.capture(agent.name);
    const logs = logStore.readLogs(agent.name, tail);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/agents/:name/config', (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    res.json(vm.readAgentConfig(agent));
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
    const driver = drivers.getDriver(agent.agent_type);
    const configPath = path.join(agent.config_root, driver.configFile || 'openclaw.json');
    if ((driver.configFormat || 'json') !== 'json') {
      // YAML/text config: write verbatim, no JSON validation.
      fs.writeFileSync(configPath, configStr.endsWith('\n') ? configStr : configStr + '\n');
      return res.json({ ok: true });
    }
    const newConfig = JSON.parse(configStr);
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

// ─── API: Vault (encrypted key-value store) ────────────────

app.get('/api/vault', (req, res) => {
  try {
    res.json({ items: vault.list(), meta: vault.status() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/vault/pin', csrfCheck, (req, res) => {
  const { pin, reset, oldPin, password } = req.body;
  try {
    if (reset) {
      if (!password) return res.status(400).json({ error: 'Your password is required to reset the PIN' });
      const user = req.session.userId
        ? getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
        : null;
      if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ error: 'Password is incorrect' });
      }
    }
    res.json({ ok: true, meta: vault.setPin(pin, { reset: !!reset, oldPin }) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/vault', csrfCheck, (req, res) => {
  const { name, description, value, pin } = req.body;
  if (!name || !value) return res.status(400).json({ error: 'Name and value are required' });
  try {
    const item = vault.create(name.trim(), description, value, pin);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/vault/:id', csrfCheck, (req, res) => {
  const { name, description, value, pin } = req.body;
  try {
    const item = vault.update(Number(req.params.id), { name, description, value }, pin);
    res.json({ ok: true, item });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/vault/:id', csrfCheck, (req, res) => {
  const { pin } = req.body;
  try {
    vault.remove(Number(req.params.id), pin);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/vault/:id/decrypt', requireAdmin, (req, res) => {
  try {
    res.json({ value: vault.getValue(Number(req.params.id), req.query.pin || '') });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


// ─── API: Create Agent ──────────────────────────────────────

app.post('/api/agents/create', async (req, res) => {
  const { name, agent, assign_to, workspace_host, workspace_dir, allowDocker, network, sshEnabled, port, sshContainerPort, password, extraVolumes, extraPorts } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!safeVmName(name)) return res.status(400).json({ error: 'Invalid VM name' });
  if (registry.getAgent(name)) return res.status(409).json({ error: 'Agent already exists' });

  // Shared pre-flight (plan 30): the same vm.validateAgentCreate that backs the
  // MCP create_agent tool — network peer exists/running, extra volumes/ports,
  // SSH container port, workspace mount, and cross-agent host-port availability
  // all abort with 400 BEFORE the 202 is emitted.
  const agentType = agent || 'openclaw';
  try {
    await vm.validateAgentCreate(name, {
      agent: agentType,
      sshEnabled: !!sshEnabled,
      port,
      sshContainerPort,
      workspaceHost: workspace_host,
      workspaceDir: workspace_dir,
      network: network || '',
      extraVolumes,
      extraPorts,
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const job = jobLog.getOrCreateJob(name);
  const log = (stream, text) => jobLog.line(job, stream, text);
  const step = (stepName, state) => jobLog.setStep(job, stepName, state);

  // Respond immediately; the create runs in the background and streams its
  // output to the SSE endpoint (GET /api/agents/:name/create-log).
  res.status(202).json({ ok: true, job: name, streaming: true });

  setImmediate(async () => {
    try {
      await vm.createAgent(name, {
        agent: agentType,
        workspaceHost: workspace_host,
        workspaceDir: workspace_dir,
        allowDocker: !!allowDocker,
        network: network || '',
        sshEnabled: !!sshEnabled,
        port,
        sshContainerPort,
        password: typeof password === 'string' ? password : '',
        extraVolumes,
        extraPorts,
        onLog: log,
        onStep: step,
      });
      registry.discoverAgents();

      // Set owner_id in DB (admin may re-assign to another user)
      try {
        const db = getDb();
        let ownerId = req.session.userId;
        if (assign_to && req.session.role === 'admin') {
          const user = db.prepare('SELECT id FROM users WHERE id = ?').get(assign_to);
          if (user) ownerId = assign_to;
        }
        registry.assignOwner(name, ownerId);
      } catch {}

      registry.recordActivity(name, 'lifecycle', 'create', 'ok', `Agent created (type=${agentType})`);
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

// ─── One-time migration: per-instance build files + image tags ─

/** Run the build-file migration manually (also runs on boot). Idempotent. */
app.get('/api/admin/migrate-builds', requireAdmin, async (req, res) => {
  try {
    const results = await vm.ensureInstanceBuilds({ onLog: (stream, text) => console.log(text) });
    res.json(results);
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

// Periodic capture of every existing container's logs into its persistent
// file, so container logs survive a recreate/delete even if the Logs page was
// never opened. Capture is also done on every logs fetch and right before any
// backend-driven recreate/delete — this sweep just closes the gap for changes
// made outside Paddock (docker CLI, compose, crash loops).
(async function logSweep() {
  try {
    const containers = await dockerPsList();
    await logStore.captureAll(Object.keys(containers).filter((n) => safeVmName(n)));
  } catch {}
  setTimeout(logSweep, 30000);
})();

// Boot-time cleanup of forwarding-door containers whose agent was deleted.
(async function orphanDoorSweep() {
  try { await cleanOrphanDoors(); } catch {}
})();

// One-time migration to per-instance build files (plan 25). Runs in the
// background so the webui is up immediately; existing PADs get a build dir,
// their image retagged to `paddock-vm-<name>:latest` and their compose
// regenerated/recreated. Idempotent — every later boot skips straight past it.
(async function migrateBuilds() {
  try {
    const results = await vm.ensureInstanceBuilds({ onLog: (stream, text) => console.log(text) });
    console.log(`[migrate-builds] seeded=${results.seeded.length} skipped=${results.skipped.length} errors=${results.errors.length}`);
    for (const e of results.errors) console.error('[migrate-builds] error:', e.name, e.error);
  } catch (e) {
    console.error('[migrate-builds] failed:', e.message);
  }
})();

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
    // 4002 = the PAD is stopped/not running. The client stops auto-retrying on
    // this code and instead waits for the agent to come back up.
    ws.close(4002, 'agent not running');
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
    let titleIv = null; // polls the tmux window title for the terminal header
    let lastTitle = ''; // last title frame sent to this client
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
      if (titleIv) { clearInterval(titleIv); titleIv = null; }
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

    // Feed a live title to the client as NUL-NUL-prefixed JSON control frames
    // (the same framing the client uses for resize), so the terminal header
    // can show what the agent is actually running instead of the static
    // display name. For opencode agents that's the TUI session name, e.g.
    // `OC | Casual greeting`. Other agent types send nothing and keep the
    // display name. Polled (a cheap exec) rather than parsing escape
    // sequences out of the byte stream.
    let agentType = 'openclaw';
    try {
      const ag = registry.getAgent(vmName);
      if (ag && ag.agent_type) agentType = ag.agent_type;
    } catch {}
    if (agentType === 'opencode') {
      // Make sqlite3 available for the title query (no-op on modern images).
      try { await ensureSqlite3(vmName); } catch {}
    }
    const sendTitle = async () => {
      if (closed || ws.readyState !== ws.OPEN) return;
      let t = '';
      if (agentType === 'opencode') {
        try { t = await opencodeSessionTitle(vmName); } catch {}
        if (t) t = 'OC | ' + t;
      }
      if (t && t !== lastTitle && ws.readyState === ws.OPEN) {
        lastTitle = t;
        ws.send('\x00\x00' + JSON.stringify({ type: 'title', title: t }));
      }
    };
    sendTitle();
    titleIv = setInterval(sendTitle, 3000);

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
