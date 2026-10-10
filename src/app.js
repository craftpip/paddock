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

// The webui is a control plane, not a worker: it supervises every PAD, holds
// every terminal WebSocket and every job log. Node's default is to PRINT AND
// EXIT on an unhandled rejection or an uncaught exception, which means one bad
// throw anywhere (a single MCP tool call by a single agent was enough — it took
// this process down every ~45s) costs every open terminal at once and looks to
// the user like a randomly glitching UI. Log loudly and stay up instead; the
// alternative is a crash loop that is far harder to diagnose than the original
// error.
process.on('unhandledRejection', (err) => {
  console.error('[fatal-guard] unhandled rejection (staying up):', err?.stack || err);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal-guard] uncaught exception (staying up):', err?.stack || err);
});

const dockerClient = new Docker({ socketPath: '/var/run/docker.sock' });

const vault = require('./services/vault');
const registry = require('./services/agent-registry');
const vm = require('./services/vm-manager');
const drivers = require('./services/drivers');
const { getPaddockMcpUrl } = require('./services/paddock-mcp');
const orchestrator = require('./services/orchestrator');
const jobLog = require('./services/job-log');
const apiKeys = require('./services/api-keys');
const containerHealth = require('./services/container-health');
const logStore = require('./services/log-store');
const mission = require('./services/mission');
const padTmux = require('./services/pad-tmux');
const { createTerminalInput } = require('./services/terminal-input');
const ownership = require('./services/ownership');
const { USER_UID, USER_GID } = ownership;
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

app.use(express.static('public', {
  // Hashed assets (/assets/*) are immutable — cache forever. index.html must
  // never be cached, otherwise a stale index.html references a deleted hash
  // after a rebuild and every script load returns HTML → MIME error → black screen.
  setHeaders(res, filePath) {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (filePath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Docs website at /website — VitePress build (base /website/). Served from
// src/public/website (copied from docs/.vitepress/dist) and also from the
// workspace dist as fallback so a host-only build is visible without a copy.
// cleanUrls: /website/foo → /website/foo.html, so extensions html.
app.use('/website', express.static(path.join(WORKSPACE, 'docs/.vitepress/dist'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));
app.use('/website', express.static(path.join(__dirname, 'public/website'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.includes('/assets/')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

// Missing hashed assets must 404, never fall through to the SPA catch-all.
// Otherwise a stale /assets/index-OLDHASH.js returns index.html (text/html)
// and the browser throws "Failed to load module script: MIME type text/html".
app.use('/assets', (req, res) => {
  res.status(404).type('text/plain').send('Not found');
});

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
  // Public paths — no auth needed (docs site is public)
  if (req.path === '/website' || req.path.startsWith('/website/')) return next();
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
  return runCmd('docker', ['exec', '-i', ...termUserArgs(vmName), vmName, 'sh', '-lc', cmd], { timeout });
}

// ─── User-mode (Container user) exec helpers (plan 43 Phase 7) ──────────────
// A pad with meta USER_MODE=user runs its daemon + terminal as the `pad` user
// (PUID:PGID=1000:1000) so every file it writes is user-owned by construction.
// Root-mode pads (the default) are unaffected. User-mode execs get
// `-u <uid>:<gid>` and keep HOME=/root — the agent CLIs (openclaw, opencode,
// ...) resolve their config/workspace via $HOME, and /root/.<agent> is the
// bind-mounted data dir. The hooks (.bashrc/.tmux.conf) stay at /root and are
// written by ROOT execs (they're root-owned config files); the pad-user shells
// read them via the chmod'd-755 /root. A HISTFILE guard in the PS1 hook keeps
// bash from whining about the unwritable /root/.bash_history for uid 1000.

/** Extra `docker exec` args ([] for root-mode pads) running a command as the
 *  pad user. */
function termUserArgs(vmName) {
  const meta = readMeta(vmName);
  return meta.USER_MODE === 'user' ? ['-u', `${USER_UID}:${USER_GID}`, '-e', 'HOME=/root'] : [];
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
 * tmux client per session, so scrollback survives.
 *
 * EXCEPTION — `msn-*` (Mission sessions): several clients attaching at once is
 * the entire point of that feature. The human has the session open in Mission
 * while the agent types into the same pane through `mission_send`, and the
 * agent-detail page's terminal is allowed to watch a session the user is
 * already driving. Kicking the user's tab because someone else looked would
 * make the shared workplace impossible, so mission sessions attach
 * multi-client and accept the tmux full-redraw trade-off. The kick AND the
 * attach sweep are both skipped for them — sweeping would kill the other
 * clients' tmux processes anyway. */
const activeTerminals = new Map();

/** Mission sessions opt out of the single-client terminal policy. */
const MISSION_SESSION_RE = /^msn-[A-Za-z0-9._-]+$/;

/** Live multi-client connections per `${vmName}/${session}`.
 *
 *  Multi-client sessions cannot sweep on every disconnect (that would kill the
 *  live clients), but a crashed client leaves an orphaned `tmux attach` process
 *  behind — destroying the hijacked stream does not reliably kill the exec, and
 *  those orphans pile up on a session nobody ever closes. Counting the real
 *  clients lets cleanup sweep exactly when the last one leaves, which is the
 *  only moment every remaining attach is garbage. */
const terminalClients = new Map();

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
    await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'sh', '-lc', `pkill -f '[t]mux attach-session -t ${session}' 2>/dev/null || true`], { timeout: 10000, check: false });
  } catch {}
}

/** Identifies this webui process's own attaches. The boot sweep must never
 *  touch one: it runs on the first mission attach, but the `await` before it
 *  reaches the container means later connects have already written their pid
 *  files by then, and sweeping by bare glob killed those live clients. A token
 *  in the filename separates "orphaned by a previous process" from "mine". */
const ATTACH_BOOT_TOKEN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Where a mission attach records its own PID. The mission attach runs as
 *  `sh -c 'echo $$ > <pidfile>; exec tmux attach-session -t <s>'`, so the PID
 *  is the tmux process's own (exec keeps it) and the file names that one
 *  connection. Regular terminals do not write one: they are swept by name. */
function attachPidPath(connId) {
  return `/tmp/paddock-at-${ATTACH_BOOT_TOKEN}-${connId}.pid`;
}

/** Kill exactly the attach client THIS connection started, and nothing else.
 *
 *  The broad `sweepStaleAttaches` cannot be used while other clients are live
 *  (it pkills every client of the session, which is exactly what would kick a
 *  second tab). Per-connection PIDs make targeted cleanup possible, which is
 *  what stops a session accumulating orphan clients while a tab stays open.
 *  The PID is re-verified against /proc before the kill: PIDs get reused, and a
 *  human's own `tmux attach` over SSH must never be swept up by mistake. */
async function reapAttachByPid(vmName, session, connId) {
  try {
    const r = await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'sh', '-c',
      `p=${attachPidPath(connId)}; pid=$(cat "$p" 2>/dev/null) || exit 0; rm -f "$p"; ` +
      `[ -n "$pid" ] || exit 0; ` +
      `case "$(tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null)" in ` +
      `*tmux*attach-session*-t\ ${session}*) kill "$pid" 2>/dev/null && echo "killed $pid" ;; esac; exit 0`
    ], { timeout: 10000, check: false });
    const killed = String(r?.stdout || '').trim();
    if (killed) console.log(`[wss/terminal] ${connId} reaped own attach on ${session} (${killed})`);
  } catch {}
}

const attachPidSwept = new Set(); // PAD names whose leftover pid files are swept

/** Kill attach clients orphaned by a previous webui process, once per PAD.
 *
 *  `activeTerminals` is in-memory, so a webui restart loses track of the exec'd
 *  `tmux attach` processes it started — they outlive it and stay attached
 *  forever, inflating the per-repaint fan-out (tmux pushes every repaint to
 *  every client). The pid files survive in the container, so the first mission
 *  attach after a boot reaps them. Two safety properties, both load-bearing:
 *  the file name carries ATTACH_BOOT_TOKEN, so only the PREVIOUS process's
 *  files are touched (this process's live clients are skipped even if they
 *  connected while the sweep was in flight), and each PID is re-verified
 *  against /proc before the kill, so PID reuse or a human's own
 *  `tmux attach` over SSH is never hit. */
async function sweepOrphanAttachPids(vmName) {
  if (attachPidSwept.has(vmName)) return;
  attachPidSwept.add(vmName);
  try {
    const r = await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'sh', '-c',
      'for f in /tmp/paddock-at-*.pid; do [ -e "$f" ] || continue; ' +
      `case "$f" in */paddock-at-${ATTACH_BOOT_TOKEN}-*) continue ;; esac; ` +
      'pid=$(cat "$f" 2>/dev/null); rm -f "$f"; [ -n "$pid" ] || continue; ' +
      'case "$(tr "\\0" " " < /proc/$pid/cmdline 2>/dev/null)" in ' +
      '*tmux*attach-session*) kill "$pid" 2>/dev/null && echo "$pid" ;; esac; done; exit 0'
    ], { timeout: 15000, check: false });
    const killed = String(r?.stdout || '').trim().split(/\s+/).filter(Boolean);
    if (killed.length) console.log(`[wss/terminal] reaped ${killed.length} attach client(s) orphaned by a previous webui in ${vmName}: ${killed.join(',')}`);
  } catch {}
}

async function containerHasTmux(vmName) {
  return padTmux.hasTmux(vmName);
}

const sqliteReady = new Set(); // PAD names where sqlite3 is confirmed present

async function containerHasSqlite(vmName) {
  const r = await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'sh', '-lc', 'command -v sqlite3'], { timeout: 15000, check: false });
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
  return padTmux.ensureTmux(vmName);
}

/** Make sure a tmux session exists (create it if missing, rooted at `cwd`).
 *  Colored prompt is hooked into /root/.bashrc because tmux-created shells
 *  inherit the tmux server env, not the attach exec env, so the old
 *  PS1-on-exec trick is moot.
 *
 *  The primitives live in services/pad-tmux.js so the Mission page and the MCP
 *  tools can do the same thing without requiring this file (mcp.js must not pull
 *  in Express). `cwd` is optional — the terminal's own sessions pass none. */
async function ensureTmuxSession(vmName, session, cols, rows, cwd = '') {
  await padTmux.createSession(vmName, session, { cwd, cols, rows });
}

async function listTmuxSessions(vmName, agentType = '') {
  // The tmux call itself is pad-tmux's (one implementation, tested); only the
  // opencode title-stamping below is terminal-specific.
  const sessions = await padTmux.listSessions(vmName);
  // Only sessions actually running the opencode TUI carry the `OC | …` title.
  // opencode_web creates sessions too, so the "latest session" title must
  // never be stamped onto a pane that isn't running the TUI (see opencodePanes).
  if (agentType === 'opencode') {
    try {
      const openPanes = await opencodePanes(vmName);
      let t = '';
      if (openPanes.size) t = await opencodeSessionTitle(vmName) || '';
      if (t) t = 'OC | ' + t;
      for (const s of sessions) if (openPanes.has(s.name)) s.title = t;
    } catch {}
  }
  return sessions;
}

// Sessions whose pane is currently running an opencode process (the TUI).
// `pane_pid` is the shell inside the pane; launching `opencode` makes it a
// descendant, so a flat process dump lets us match pane→TUI with no tty
// bookkeeping (opencode's DB has no tty column). `opencode web` sits on pid 1
// and is never a pane descendant, so it can't leak its session title into tabs.
async function opencodePanes(vmName) {
  const panes = await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'tmux', 'list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'], { timeout: 15000, check: false });
  const procs = await runCmd('docker', ['exec', vmName, 'ps', '-eo', 'pid=,ppid=,args='], { timeout: 15000, check: false });
  const ppidOf = new Map();
  const openPids = [];
  for (const line of (procs.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    ppidOf.set(+m[1], +m[2]);
    if (m[3].includes('opencode')) openPids.push(+m[1]);
  }
  if (!openPids.length || ppidOf.size === 0) return new Set();
  const ancestorsOf = (pid, seen = []) => {
    let cur = pid, guard = 0;
    while (cur && !seen.includes(cur) && guard++ < 32) { seen.push(cur); cur = ppidOf.get(cur) || 0; }
    return seen;
  };
  const res = new Set();
  for (const line of (panes.stdout || '').split('\n')) {
    const [sname, panePid] = line.split('|');
    if (!sname) continue;
    const pp = +panePid;
    const hasTui = openPids.some((o) => ancestorsOf(o).includes(pp));
    if (hasTui) res.add(sname);
  }
  return res;
}

async function killTmuxSession(vmName, session) {
  return padTmux.killSession(vmName, session);
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
    const scopesStr = apiKeys.validateScopes(scopes === undefined ? 'default' : scopes);
    const { key, row } = apiKeys.create(req.session.userId, trimmedName, scopesStr);
    res.json({ key, ...row });
  } catch (e) {
    res.status(400).json({ error: e.message });
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
      .filter((c) => c.name && !vm.isManagedDoorContainer(c.name));
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

/** The workspace folder's devcontainer.json (plan 41), parsed into the spec's
 *  field set so the Create Agent form can pre-fill the post-create box. */
app.get('/api/paths/devcontainer', async (req, res) => {
  try {
    const dir = String(req.query.path || '');
    if (!dir) return res.status(400).json({ error: 'path is required' });
    const dc = require('./services/devcontainer');
    const probed = pathProbe.containerPathOf(dir);
    const parsed = dc.readDevContainer(probed);
    if (!parsed) return res.json({ found: false, path: probed });
    res.json({
      found: true,
      path: probed,
      filePath: parsed.filePath,
      name: parsed.name,
      generated: parsed.generated,
      postCreateCommand: parsed.postCreateCommand,
      onCreateCommand: parsed.onCreateCommand,
      updateContentCommand: parsed.updateContentCommand,
      postStartCommand: parsed.postStartCommand,
      postAttachCommand: parsed.postAttachCommand,
      workspaceFolder: parsed.workspaceFolder,
      forwardPorts: parsed.forwardPorts || [],
      image: parsed.image,
      hasBuild: !!(parsed.dockerFile || parsed.buildContext),
      remoteUser: parsed.remoteUser,
      containerUser: parsed.containerUser,
      // item 17: the devcontainer's declared user → the pad Container user
      // default (non-root → 'user'). The explicit toggle in the form wins.
      userMode: parsed.preferredUserMode || '',
    });
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

/** The Settings "Dev Container" card state (plan 41 item 20): file path,
 *  state badge, and both sides of the diff preview (current file vs what
 *  Paddock would write now from the pad's effective config). */
app.get('/api/agents/:name/devcontainer', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const status = vm.devContainerStatus(name);
    if (!status) return res.status(404).json({ error: 'Agent not found' });
    res.json(status);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Write back the pad's 1:1 mapped fields into the workspace devcontainer.json
 *  in place (project-authored files keep every non-mapped field; generated
 *  files regenerate wholesale). No container change. */
app.post('/api/agents/:name/devcontainer/sync', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
    const agentType = meta.AGENT || 'openclaw';
    const wsMount = vm.readWorkspaceMount(name, agentType);
    if (!wsMount) return res.status(400).json({ error: 'This agent has no custom workspace to sync' });
    const filePath = vm.syncDevContainer(name, agentType, wsMount);
    if (!filePath) return res.status(400).json({ error: 'Nothing to sync — the pad never adopted this devcontainer' });
    res.json(vm.devContainerStatus(name));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Rewrite (or create) the workspace devcontainer.json as the pad's full
 *  generated mirror (marked `x-paddock.generated`). No container change. */
app.post('/api/agents/:name/devcontainer/regenerate', async (req, res) => {
  const name = safeVmName(req.params.name);
  if (!name) return res.status(400).json({ error: 'Invalid agent name' });
  try {
    const meta = readMeta(name);
    if (!meta.AGENT && !meta.ROOT_PASSWORD) return res.status(404).json({ error: 'Agent not found' });
    const filePath = vm.regenerateDevContainer(name, meta.AGENT || 'openclaw');
    if (!filePath) return res.status(400).json({ error: 'This agent has no custom workspace to write to' });
    res.json(vm.devContainerStatus(name));
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
    // Lenient by design: a pad whose meta.env has no AGENT line has NO type
    // to look up, and three live pads are in that state. getDriverOr falls
    // back only for that case — an AGENT line naming a type that is not a
    // driver still throws, instead of being answered with openclaw's fields.
    const driver = drivers.getDriverOr(meta.AGENT);
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
    const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

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
    // Never remove a real agent whose name happens to end in -door/-web.
    if (fs.existsSync(path.join(INSTANCES_DIR, cname))) continue;
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
    const driver = drivers.getDriverOr(meta.AGENT); // see the note in update-info
    // Extra Docker ports (plan 28) are independent of the built-in web app and
    // always reported — even for agent types with no web app to publish.
    const extraPorts = vm.readExtraPorts(name);
    if (!driver.webApp) return res.json({ webApp: null, extraPorts, sshPort: meta.PORT || '', sshContainerPort: vm.readSshCport(name) });

    const webService = vm.readWebService(name);
    const active = !!webService;
    let password = '';
    if (active) {
      password = vm.readWebAuth(driver, name);
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
        // Fixed-port consoles (openclaw gateway 18789) can't be retargeted —
        // the Web tab renders the container port read-only and warns about
        // peer-mode collisions.
        containerPortEditable: driver.webApp.containerPortEditable !== false,
        startable: driver.webApp.startable !== false,
        auth: driver.webApp.auth
          ? {
              label: driver.webApp.auth.label,
              hint: driver.webApp.auth.hint || '',
              required: !!driver.webApp.auth.required,
            }
          : null,
      },
      active,
      networkMode: netPeer,
      webService: active ? webService : null,
      passwordConfigured: active && !!password,
      // Token for the tokenized console URL (#token=...) — only for drivers
      // whose web console accepts it (openclaw Control UI). Others get ''.
      authToken: active && driver.webApp.auth && driver.webApp.auth.urlToken ? password : '',
      // Shell command that starts the console in the docked terminal (Start
      // button). When published it uses the live binding; otherwise it honors
      // draft ?containerPort&password query params (defaults: driver port, no
      // password) so the user can try the console without a recreate.
      startCommand: active
        ? driver.webApp.startCommand({ password, containerPort: webService.containerPort })
        : driver.webApp.startCommand({
            password: typeof req.query.password === 'string' ? req.query.password : '',
            containerPort: parseInt(req.query.containerPort, 10) || driver.webApp.containerPort,
          }),
      // Peer-mode collision: peer-shared agents share the door's network, so a
      // fixed container port can't be bound twice. Reported when another agent
      // on the same peer already publishes this container port.
      collision: netPeer && driver.webApp.containerPortEditable === false
        ? vm.findWebCollision(name, netPeer, driver.webApp.containerPort)
        : null,
      actualPorts,
      extraPorts,
      sshPort: meta.PORT || '',
      sshContainerPort: vm.readSshCport(name),
      // Remembered form drafts (plan 39) — last-used ports survive a toggle-off
      // so the re-published form is pre-filled. Passwords are never returned.
      draft: vm.readDrafts(name),
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
    const driver = drivers.getDriverOr(meta.AGENT); // see the note in update-info
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
      // Empty password = keep the saved one (plan 39): omit the key so
      // prepareAgentChanges falls back to the existing token/password instead
      // of clearing optional auth.
      if (typeof password === 'string' && password.trim()) body.web.password = password;
    }
    await vm.prepareAgentChanges(name, body);

    const jobKey = 'update:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

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
    const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

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

    const jobKey = 'update:' + name;
    const job = jobLog.getOrCreateJob(jobKey);
    const log = (stream, text) => jobLog.line(job, stream, text);
    const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

    res.status(202).json({ ok: true, job: jobKey, streaming: true, reason: 'recreate' });

    setImmediate(async () => {
      registry.setRestarting(name, true);
      try {
        await logStore.capture(name);
        // Reuse the consolidated mutation flow so every persisted option and
        // the owned forwarding door survive a Settings recreate. `force: true`
        // makes a bare recreate (nothing changed) still stop + force-recreate
        // the container and its door — otherwise it would be a no-op.
        await vm.applyAgentChanges(name, { pull, reset, force: true }, { onLog: log, onStep: step });
        if (pull) {
          try {
            const v = await drivers.getDriverOr(meta.AGENT).currentVersion(name);
            if (v) vm.setMetaFlag(name, 'OPENCLAW_VERSION', v);
          } catch {}
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
  const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

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
        const v = await drivers.getDriverOr(meta.AGENT).currentVersion(name);
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

// ─── Environment config management ──────────────────────────────

const ENV_SECRET_KEYS = new Set(['SESSION_SECRET', 'VAULT_KEY', 'AUTH_PASSWORD']);
const ENV_LOCKED_KEYS = new Set(['VAULT_KEY']);
const ENV_RECREATE_KEYS = new Set([
  'CONTAINER_PREFIX', 'HOST_NAME', 'HOST_PROTO', 'HOST_WORKSPACE_ROOT',
]);
const ENV_RESTART_KEYS = new Set([
  'AUTO_LOGIN', 'SESSION_SECRET', 'AUTH_PASSWORD',
  'PUID', 'PGID', 'DOCKER_GID',
  'GUARD_PROJECT_ROOT', 'GUARD_INSTANCES_PARENT', 'GUARD_AGENT_DATA',
]);
const ENV_AGENT_KEYS = new Set([
  'DEFAULT_MODEL_BASE_URL', 'DEFAULT_MODEL_NAME', 'DEFAULT_CONTEXT_LENGTH',
  'DEFAULT_ALLOW_FROM',
]);
const ENV_READONLY_KEYS = new Set(['TZ']);

function readEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return [];
  return fs.readFileSync(ENV_FILE, 'utf8').split('\n');
}

function writeEnvFile(lines) {
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
  envCache = null;
}

function envVarImpact(key) {
  if (ENV_RECREATE_KEYS.has(key)) return 'recreate';
  if (ENV_RESTART_KEYS.has(key)) return 'restart';
  if (ENV_LOCKED_KEYS.has(key)) return 'locked';
  if (ENV_READONLY_KEYS.has(key)) return 'readonly';
  if (ENV_AGENT_KEYS.has(key)) return 'agent';
  return 'agent';
}

app.get('/api/env', (req, res) => {
  const lines = readEnvFile();
  const vars = [];
  let pendingComment = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { pendingComment = null; continue; }
    if (trimmed.startsWith('#')) {
      const text = trimmed.replace(/^#+\s*/, '');
      if (text && !text.includes('=') && text.length < 120) pendingComment = text;
      else pendingComment = null;
      continue;
    }
    if (!trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    const rawValue = trimmed.slice(idx + 1).trim();
    vars.push({
      key,
      value: ENV_SECRET_KEYS.has(key) ? '••••••••' : rawValue,
      rawValue,
      isSecret: ENV_SECRET_KEYS.has(key),
      isLocked: ENV_LOCKED_KEYS.has(key),
      isReadonly: ENV_READONLY_KEYS.has(key),
      impact: envVarImpact(key),
      description: pendingComment || '',
    });
    pendingComment = null;
  }

  res.json({ vars });
});

app.post('/api/env', (req, res) => {
  const { vars = {} } = req.body || {};
  const locked = Object.keys(vars).filter((k) => ENV_LOCKED_KEYS.has(k));
  if (locked.length) {
    return res.status(400).json({ error: `Cannot modify locked variables: ${locked.join(', ')}` });
  }

  const lines = readEnvFile();
  const updatedKeys = new Set();
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) {
      result.push(lines[i]);
      continue;
    }
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    if (key in vars) {
      const newValue = String(vars[key]).trim();
      const comment = lines[i].match(/#\s*(.+)$/);
      const suffix = comment ? `  # ${comment[1]}` : '';
      result.push(`${key}=${newValue}${suffix}`);
      updatedKeys.add(key);
    } else {
      result.push(lines[i]);
    }
  }

  for (const [key, value] of Object.entries(vars)) {
    if (!updatedKeys.has(key)) {
      result.push(`${key}=${String(value).trim()}`);
    }
  }

  writeEnvFile(result);

  const impacts = new Set();
  for (const key of Object.keys(vars)) {
    const impact = envVarImpact(key);
    if (impact !== 'locked' && impact !== 'readonly') impacts.add(impact);
  }

  res.json({ ok: true, updated: Object.keys(vars), impacts: [...impacts] });
});

app.post('/api/env/restart', async (req, res) => {
  // Logged loudly: this tears down every open terminal WebSocket and orphans
  // every tmux attach client, so an unexplained call needs to be attributable.
  console.warn(`[env/restart] CALLED by ${req.socket.remoteAddress} ua=${(req.headers['user-agent'] || '?').slice(0, 60)}`);
  res.json({ ok: true, message: 'Webui restarting in 1s…' });
  setTimeout(async () => {
    console.warn('[env/restart] executing docker restart paddock (t=1)');
    try {
      const c = await dockerClient.getContainer('paddock');
      await c.restart({ t: 1 });
    } catch (e) {
      console.error('Env restart failed:', e.message);
    }
  }, 500);
});

app.post('/api/env/recreate', async (req, res) => {
  // Same as /api/env/restart — an unexplained recreate is just as destructive.
  console.warn(`[env/recreate] CALLED by ${req.socket.remoteAddress} ua=${(req.headers['user-agent'] || '?').slice(0, 60)}`);
  res.json({ ok: true, message: 'Webui recreating in 1s…' });
  setTimeout(async () => {
    console.warn('[env/recreate] executing docker compose up -d --force-recreate webui');
    try {
      await runCmd('docker', ['compose', '-f', '/workspace/docker-compose.yml', 'up', '-d', '--force-recreate', 'webui'], { timeout: 120000 });
    } catch (e) {
      console.error('Env recreate failed, falling back to restart:', e.message);
      try {
        const c = await dockerClient.getContainer('paddock');
        await c.restart({ t: 1 });
      } catch {}
    }
  }, 500);
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
 *  that launches the agent's interactive TUI (openclaw / opencode / …). Also
 *  serves the Paddock MCP connect/disconnect block (plan 35b). */
app.get('/api/agent-types/:type/commands', (req, res) => {
  // Validate BEFORE resolving, and answer 404. This route takes the type
  // straight from the URL, and while getDriver used to fall back to openclaw a
  // typo here answered 200 with another agent's commands, MCP connect block and
  // tui command — measured live: `/api/agent-types/opencodee/commands` reported
  // `type: "openclaw"` and 4 commands. A not-found and a wrong-but-complete
  // answer look nothing alike to a caller, so this must be a refusal.
  if (!drivers.hasDriver(req.params.type)) {
    return res.status(404).json({
      error: `Unknown agent type '${req.params.type}'`,
      known: drivers.listDrivers().map((d) => d.type),
    });
  }
  const driver = drivers.getDriver(req.params.type);
  const paddockMcpUrl = getPaddockMcpUrl();
  res.json({
    type: driver.type,
    commands: driver.commands,
    tuiCommand: driver.tuiCommand || 'openclaw',
    mcp: drivers.getMcp(req.params.type, paddockMcpUrl),
  });
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

app.get('/api/agents/:name/workspace/media', async (req, res) => {
  const agent = registry.getAgent(req.params.name);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const relativePath = req.query.path;
  if (!relativePath) return res.status(400).send('path required');
  const MEDIA_MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  };
  try {
    const file = await require('./services/workspace').readFileB64(agent.name, relativePath, req.query.scope || 'host');
    if (file.error) return res.status(404).send(file.error);
    if (file.size > 100 * 1024 * 1024) return res.status(413).send('File too large');
    const ext = (file.name || '').split('.').pop().toLowerCase();
    const mime = MEDIA_MIME[ext];
    if (!mime) return res.status(415).send('Unsupported media type');
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name || 'media')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(file.content, 'base64'));
  } catch (err) {
    res.status(400).send(err.message);
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
    let agentType = '';
    try { agentType = (registry.getAgent(name) || {}).agent_type || ''; } catch {}
    if (agentType === 'opencode') {
      // Make sqlite3 available for the title query (no-op on modern images).
      try { await ensureSqlite3(name); } catch {}
    }
    res.json({ sessions: await listTmuxSessions(name, agentType) });
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

// ─── API: Mission (plan 53) ─────────────────────────────────────────────────
// A project is an (agent, folder) pair; a session is the only unit of work —
// one live tmux session per row running the agent's TUI in the project's folder,
// typed into by the human and the agent alike. Phase 0: the store + validation.
// The tmux half (launch TUI / send keys / capture) lands in Phase 1, so the CRUD
// surface is testable on its own.

/** PAD names the caller may touch. Admins get null (= no filter). */
function missionAllowedAgents(req) {
  if (req.session.role === 'admin') return null;
  return getDb().prepare('SELECT name FROM agents WHERE owner_id = ?').all(req.session.userId).map((r) => r.name);
}

/** Load a project the caller is allowed to see, or answer 403/404 for them. */
function missionProject(req, res) {
  let project;
  try {
    project = mission.getProject(req.params.id);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
    return null;
  }
  if (!canTouchAgent(req, project.agent_name)) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return project;
}

/** A session plus its project, access-checked. Returns { session, project }. */
function missionSession(req, res) {
  let session;
  try {
    session = mission.getSession(req.params.id);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
    return null;
  }
  let project;
  try {
    project = mission.getProject(session.project_id);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message, code: e.code });
    return null;
  }
  if (!canTouchAgent(req, project.agent_name)) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return { session, project };
}

function canTouchAgent(req, agentName) {
  if (req.session.role === 'admin') return true;
  const row = getDb().prepare('SELECT owner_id FROM agents WHERE name = ?').get(agentName);
  return !!row && row.owner_id === req.session.userId;
}

/** Errors from the service carry a machine code the UI and the LLM both branch
 *  on (mission_unsupported_agent, mission_session_locked, …). */
function missionFail(res, e) {
  const status = e.status || 400;
  res.status(status).json({ error: e.message, code: e.code || 'mission_error' });
}

app.get('/api/agents/:name/mission-folders', async (req, res) => {
  // Folder picker for the project dialog. Read-only (a GET), but still
  // owner-checked: it runs a container command on a named agent.
  if (!canTouchAgent(req, req.params.name)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    res.json(await mission.projectFolders(req.params.name, req.query.path || ''));
  } catch (e) {
    missionFail(res, e);
  }
});

// ─── Routes: Orchestrator conferral (plan 52 Phase D) ─────────

/** Ownership gate for orchestra routes: 404 when the pad does not exist, 403
 *  when the caller neither owns it nor is an admin. */
function requireOwnedAgent(req, res) {
  const row = getDb().prepare('SELECT owner_id FROM agents WHERE name = ?').get(req.params.name);
  if (!row) {
    res.status(404).json({ error: `Agent not found: ${req.params.name}` });
    return false;
  }
  if (req.session.role === 'admin') return true;
  if (row.owner_id === req.session.userId) return true;
  res.status(403).json({ error: 'Access denied' });
  return false;
}

function orchestratorFail(res, e) {
  res.status(e.status || 500).json({ error: e.message, code: e.code || 'orchestrator_error' });
}

app.get('/api/agents/:name/orchestrator', (req, res) => {
  if (!requireOwnedAgent(req, res)) return;
  try {
    res.json(orchestrator.getOrchestrator(req.params.name, req.session.userId));
  } catch (e) {
    orchestratorFail(res, e);
  }
});

app.post('/api/agents/:name/orchestrator', csrfCheck, async (req, res) => {
  if (!requireOwnedAgent(req, res)) return;
  try {
    res.json(await orchestrator.confer(req.params.name, req.session.userId));
  } catch (e) {
    orchestratorFail(res, e);
  }
});

app.delete('/api/agents/:name/orchestrator', csrfCheck, async (req, res) => {
  if (!requireOwnedAgent(req, res)) return;
  try {
    res.json(await orchestrator.removeConferral(req.params.name, req.session.userId));
  } catch (e) {
    orchestratorFail(res, e);
  }
});

app.get('/api/mission/projects', (req, res) => {
  try {
    const projects = mission.listProjects({ agent: req.query.agent || '', agents: missionAllowedAgents(req) });
    // liveness, then the agent's own "is this conversation working" view. Both
    // are decoration on the list: neither is allowed to fail it.
    mission
      .withLive(projects)
      .then((live) => mission.withAgentBusyProjects(live))
      .then(
        (live) => res.json({ projects: live }),
        () => res.json({ projects }) // liveness is decoration; never fail the list on it
      );
  } catch (e) {
    missionFail(res, e);
  }
});

app.post('/api/mission/projects', csrfCheck, (req, res) => {
  try {
    const project = mission.createProject({
      name: req.body.name,
      agent: req.body.agent,
      folder: req.body.folder,
      createdBy: req.session.userId || null,
    });
    if (!canTouchAgent(req, project.agent_name)) {
      mission.deleteProject(project.id);
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ project });
  } catch (e) {
    missionFail(res, e);
  }
});

app.get('/api/mission/projects/:id', (req, res) => {
  const project = missionProject(req, res);
  if (!project) return;
  try {
    mission
      .withLiveSessions(mission.listSessions({ projectId: project.id }), project.agent_name)
      // The per-session busy probe reads each row's OWN conversation in the
      // agent's store (plan 52 R8(a)) — no folder is involved, because the id
      // is the key and the process that drives it is irrelevant.
      .then((sessions) => mission.withAgentBusy(sessions, () => project.agent_name))
      .then(
        (sessions) => res.json({ project, sessions }),
        () => res.json({ project, sessions: mission.listSessions({ projectId: project.id }) })
      );
  } catch (e) {
    missionFail(res, e);
  }
});

app.patch('/api/mission/projects/:id', csrfCheck, (req, res) => {
  const project = missionProject(req, res);
  if (!project) return;
  try {
    res.json({ project: mission.updateProject(project.id, { name: req.body.name, folder: req.body.folder }) });
  } catch (e) {
    missionFail(res, e);
  }
});

app.delete('/api/mission/projects/:id', csrfCheck, (req, res) => {
  const project = missionProject(req, res);
  if (!project) return;
  try {
    // Kill the project's tmux sessions before the rows go, so deleting a
    // project can never leave an orphan TUI running in the PAD. A PAD that is
    // already gone makes killSession a no-op by design.
    Promise.all(
      mission.listSessions({ projectId: project.id }).map((s) =>
        // No actor passed: this is the PLATFORM tearing a project's sessions
        // down as a side effect of deleting it, not a human closing each one.
        // 'system' is the honest value, and it is a real distinction — a
        // `user:` row here would put a name on a decision the user never made.
        mission.closeSession(s.id).catch(() => {})
      )
    ).then(() => {
      mission.deleteProject(project.id);
      res.json({ ok: true });
    }, (e) => missionFail(res, e));
  } catch (e) {
    missionFail(res, e);
  }
});

/** Every live session across every project, each tagged with its project — the
 *  backend half of the page's "All projects" scope (plan 53 Phase 6). Same
 *  shape as the per-project list plus a `project` object per row, because a
 *  session label on its own cannot say which folder it belongs to. The tmux
 *  check is grouped per AGENT (one `list-sessions` per PAD), not per project. */
app.get('/api/mission/sessions', (req, res) => {
  const allow = (agentName) => canTouchAgent(req, agentName);
  let all;
  try {
    all = mission.listAllSessions({ allow });
  } catch (e) {
    return missionFail(res, e);
  }
  mission
    .withLiveSessionsByAgent(all.sessions, (s) => s.project?.agent_name)
    // Each row is asked about in ITS OWN conversation (the store read keys on
    // the row's agent_session_id, so a one-list-spans-folders scope needs no
    // folder) — plan 52 R8(a).
    .then((sessions) => mission.withAgentBusy(sessions, (s) => s.project?.agent_name))
    .then((sessions) => res.json({ sessions, projects: all.projects }),
      () => res.json({ sessions: all.sessions, projects: all.projects }));
});

/** The same "All projects" scope for the agent's own history: every project's
 *  conversations merged and date-sorted. A project that cannot be read is
 *  reported in `errors` instead of failing the whole read — one stopped PAD
 *  must not blank the column. */
app.get('/api/mission/history', (req, res) => {
  mission
    .allAgentHistory({
      limit: parseInt(req.query.limit, 10) || 50,
      includeSubfolders: req.query.subfolders === '1',
      allow: (agentName) => canTouchAgent(req, agentName),
    })
    .then((h) => res.json(h), (e) => missionFail(res, e));
});

app.get('/api/mission/projects/:id/sessions', (req, res) => {
  const project = missionProject(req, res);
  if (!project) return;
  try {
    mission
      .withLiveSessions(mission.listSessions({ projectId: project.id }), project.agent_name)
      .then((sessions) => mission.withAgentBusy(sessions, () => project.agent_name))
      .then(
        (sessions) => res.json({ sessions }),
        () => res.json({ sessions: mission.listSessions({ projectId: project.id }) })
      );
  } catch (e) {
    missionFail(res, e);
  }
});

/** The conversations that already happened in this project's folder, read from
 *  the agent's OWN store (opencode.db / codex rollouts / claude jsonl) — not
 *  from `mission_sessions`. This is what makes a project that points at a
 *  folder you have already worked in show that work instead of an empty column.
 *  `?subfolders=1` widens it to conversations that ran in nested folders. */
app.get('/api/mission/projects/:id/history', (req, res) => {
  const project = missionProject(req, res);
  if (!project) return;
  mission
    .agentHistory(project.id, {
      limit: parseInt(req.query.limit, 10) || 50,
      includeSubfolders: req.query.subfolders === '1',
    })
    .then((h) => res.json(h), (e) => missionFail(res, e));
});

/** Open a session: create the tmux session rooted at the project's folder and
 *  launch the agent's TUI into it. No headless variant by design — the work
 *  must be visible. `agentSessionId` resumes a conversation from the agent's
 *  own history instead of starting a fresh one. */
app.post('/api/mission/projects/:id/sessions', csrfCheck, (req, res) => {
  const project = missionProject(req, res);
  if (!project) return;
  mission
    .startSession(project.id, {
      label: req.body.label,
      origin: req.body.origin,
      agentSessionId: req.body.agentSessionId,
      // Same actor stamp as the MCP path (`key:<id>` there, `user:<id>` here) so
      // a `human` row can be audited later instead of resting on the caller's
      // memory (plan 67, 67.3).
      createdBy: req.session && req.session.userId ? `user:${req.session.userId}` : null,
    })
    .then(({ session, state }) => res.json({ session, state }), (e) => missionFail(res, e));
});

/** One session in full: metadata + the pane's live/tuiAlive/cwd state + the
 *  last lines of its screen. This is the shape both the page and
 *  `mission_sessions(session_id)` want. */
app.get('/api/mission/sessions/:id', (req, res) => {
  const found = missionSession(req, res);
  if (!found) return;
  mission
    .screen(found.session.id, parseInt(req.query.lines, 10) || 40)
    .then((r) => res.json(r), (e) => missionFail(res, e));
});

/** Type into a live session. The human mostly types in the attached terminal
 *  instead; this is the API the MCP `mission_send` tool calls, kept here so both
 *  go through the same solo-lock check. The response mirrors the MCP tool's:
 *  where the write landed (project + session id) and the pane's screen after
 *  it, because a bare `ok: true` is a success for keystrokes that went nowhere
 *  (plan 62 1h/1i). */
/** WHO is acting, for the activity_events audit row (plan 52 E1). Same spelling
 *  as the MCP side's missionActor() and as a row's `created_by`, so all three
 *  are queryable with one pattern. The web UI is always a user: there is no key
 *  on this side of the wire, and auto-login still lands on a real user row. */
function missionActorFor(req) {
  return req.session && req.session.userId ? `user:${req.session.userId}` : 'system';
}

app.post('/api/mission/sessions/:id/send', csrfCheck, (req, res) => {
  const found = missionSession(req, res);
  if (!found) return;
  mission.sendText(found.session.id, req.body.text, { actor: missionActorFor(req) }).then(
    (r) => res.json({ ok: true, sent: r.sent, project: r.project, session_id: r.session_id, session: r.session, screen: r.screen }),
    (e) => missionFail(res, e)
  );
});

/** Answer a permission dialog the pane is parked on (plan 62 1c). The HUMAN's
 *  route, so `always` is allowed here — the durable-policy refusal is the MCP
 *  tool's rule, because that is the machine caller. */
app.post('/api/mission/sessions/:id/permission', csrfCheck, (req, res) => {
  const found = missionSession(req, res);
  if (!found) return;
  const choice = String(req.body.choice || '');
  if (!['once', 'always', 'reject'].includes(choice)) {
    return res.status(400).json({ error: 'Bad choice', code: 'mission_bad_permission_choice' });
  }
  mission.answerPermission(found.session.id, choice, { allowAlways: true }).then(
    (r) => res.json(r),
    (e) => missionFail(res, e)
  );
});

/** Re-launch the TUI in a session whose agent exited (the pane is back at a
 *  shell). Refuses when one is already running. */
app.post('/api/mission/sessions/:id/relaunch', csrfCheck, (req, res) => {
  const found = missionSession(req, res);
  if (!found) return;
  mission.relaunchTui(found.session.id, { actor: missionActorFor(req) }).then((r) => res.json(r), (e) => missionFail(res, e));
});

/** Restart a session whose tmux pane is GONE. Separate from relaunch, which
 *  refuses a dead session: a restart re-creates the same pane rooted at the
 *  project folder and brings back the same agent conversation, keeping the
 *  mission session id. */
app.post('/api/mission/sessions/:id/restart', csrfCheck, (req, res) => {
  const found = missionSession(req, res);
  if (!found) return;
  mission.restartSession(found.session.id, { actor: missionActorFor(req) }).then((r) => res.json(r), (e) => missionFail(res, e));
});

app.patch('/api/mission/sessions/:id', csrfCheck, (req, res) => {
  const found = missionSession(req, res);
  if (!found) return;
  try {
    res.json({ session: mission.updateSession(found.session.id, { label: req.body.label, locked: req.body.locked }) });
  } catch (e) {
    missionFail(res, e);
  }
});

app.delete('/api/mission/sessions/:id', csrfCheck, (req, res) => {
  const found = missionSession(req, res);
  if (!found) return;
  mission.closeSession(found.session.id, { actor: missionActorFor(req) }).then(
    () => res.json({ ok: true }),
    (e) => missionFail(res, e)
  );
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
  const { name, agent, assign_to, workspace_host, workspace_dir, allowDocker, network, sshEnabled, port, sshContainerPort, password, extraVolumes, extraPorts, userMode, buildCommands, postCreate, postStart, postAttach, generateDevContainer } = req.body;
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
      userMode: userMode === 'user' ? 'user' : '',
    });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const job = jobLog.getOrCreateJob(name);
  const log = (stream, text) => jobLog.line(job, stream, text);
  const step = (stepName, state, cmd) => jobLog.setStep(job, stepName, state, cmd);

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
        userMode: userMode === 'user' ? 'user' : '',
        buildCommands: typeof buildCommands === 'string' ? buildCommands : '',
        postCreate: typeof postCreate === 'string' ? postCreate : '',
        postStart: typeof postStart === 'string' ? postStart : '',
        postAttach: typeof postAttach === 'string' ? postAttach : '',
        generateDevContainer: generateDevContainer !== false,
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
      await runCmd('docker', ['exec', ...termUserArgs(name), name, 'openclaw', 'channels', 'add', '--channel', 'telegram', '--token', bot_token], { timeout: 30000 });
      await runCmd('docker', ['exec', ...termUserArgs(name), name, 'openclaw', 'config', 'set', 'channels.telegram.allowFrom', JSON.stringify([user_id || process.env.DEFAULT_ALLOW_FROM || '532156945'])], { timeout: 15000 });
      await runCmd('docker', ['exec', ...termUserArgs(name), name, 'openclaw', 'config', 'set', 'channels.telegram.dmPolicy', 'allowlist'], { timeout: 15000 });
    }
    if (api_key_provider && api_key_value) {
      await runCmd('docker', ['exec', '-i', ...termUserArgs(name), name, 'openclaw', 'models', 'auth', 'paste-api-key', '--provider', api_key_provider], { input: api_key_value, timeout: 30000 });
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
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/') || req.path === '/website' || req.path.startsWith('/website/')) return next();
  // File-like paths (e.g. stale /assets/*.js, .css, .map, .svg) must 404 —
  // otherwise a deleted hashed chunk returns index.html (text/html) and the
  // browser throws "Failed to load module script: MIME type text/html".
  // The /assets 404 above already handles /assets/*, this is the safety net
  // for any other dotted path.
  if (/\.[a-zA-Z0-9]{1,8}$/.test(req.path)) {
    return res.status(404).type('text/plain').send('Not found');
  }
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    return res.sendFile(indexPath);
  }
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

// Plan 43: the webui container runs as root, so ownership of user files must
// be normalized at boot — BEFORE the db is opened (a fresh db created by a
// root process would be root-owned; db.js also re-chowns after open).
ownership.ensureDataOwned();
getDb();
// Idempotent background sweep over instances/ — heals any historical
// root-owned pad data without blocking startup (replaces the manual
// `chown -R node:node instances/` runbook).
setImmediate(() => {
  try {
    ownership.normalizeTree(INSTANCES_DIR, (dir) =>
      ownership.isSelfManagedAgentData(dir, INSTANCES_DIR));
  } catch {}
});

const server = app.listen(6789, () => console.log('VM WebUI listening on port 6789'));

// Periodic capture of every existing container's logs into its persistent
// file, so container logs survive a recreate/delete even if the Logs page was
// never opened. Capture is also done on every logs fetch and right before any
// backend-driven recreate/delete — this sweep just closes the gap for changes
// made outside Paddock (docker CLI, compose, crash loops).
//
// Forwarding doors are excluded: they are socat forwarders, not agents, so
// nothing ever reads their log file — but capturing one creates
// `instances/<pad>-door/logs/`, which resurrects the very instance directory
// the boot sweep below quarantines, every 30 seconds.
(async function logSweep() {
  try {
    const containers = await dockerPsList();
    await logStore.captureAll(Object.keys(containers)
      .filter((n) => safeVmName(n) && !vm.isManagedDoorContainer(n)));
  } catch {}
  setTimeout(logSweep, 30000);
})();

// Boot-time cleanup of forwarding-door containers whose agent was deleted,
// then of the legacy `<pad>-door` instance DIRECTORIES the same feature left
// behind (plan 59). The dir sweep is the one that matters beyond tidiness:
// each stale dir kept a `SUBNET=` pool reservation that nothing freed, so the
// same /24 ended up on two pads' books and the second one to create its
// `default` network failed with "Pool overlaps with other one on this address
// space".
//
// The "is this a real agent?" veto is the CURRENT agent list (disk-derived, and
// it already excludes doors) rather than a bare `agents` table lookup: the
// table is a cache that keeps a row for every pad that ever existed — including
// `pad-opencode-user1-door`, promoted before the door filter existed — so
// trusting it would veto exactly the dirs this sweep exists to clean, and would
// still miss a dir whose meta lost its `AGENT=` line.
(async function orphanDoorSweep() {
  try { await cleanOrphanDoors(); } catch {}
  try {
    const live = new Set(registry.discoverAgents().map((a) => a.name));
    const moved = await vm.cleanStaleDoorDirs({ isRegisteredAgent: (n) => live.has(n) });
    if (moved.length) console.log(`[stale-door-dir] quarantined ${moved.length} legacy door dirs`);
  } catch (e) {
    console.error('[stale-door-dir] sweep failed:', e.message);
  }
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
  // Register BEFORE any await (authentication, Docker, tmux, history). The
  // page can finish laying out and send its real size while those run.
  const terminalInput = createTerminalInput({
    cols: Math.max(40, Math.min(400, parseInt(url.searchParams.get('cols') || '120', 10) || 120)),
    rows: Math.max(12, Math.min(120, parseInt(url.searchParams.get('rows') || '32', 10) || 32)),
  });
  ws.on('message', terminalInput.onMessage);
  ws.on('close', () => terminalInput.close());

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
    const { cols, rows } = terminalInput.size;
    const session = safeSessionName(url.searchParams.get('session') || 'main');
    // A client that is SWITCHING between sessions on one page already holds a
    // rendered buffer, and the attach repaint below overwrites the screen
    // anyway — so replaying the scrollback into it is redundant work that also
    // lands the new session's history *under* the outgoing session's output.
    // It costs two `docker exec` round trips (~700ms here) before the first
    // byte, which is the whole "switching sessions takes a moment" pause. Such a
    // client sends `history=0`; a first connect / reload (the case the replay
    // exists for) keeps the default and still gets its scrollback.
    const wantHistory = url.searchParams.get('history') !== '0';

    const termKey = `${vmName}/${session}`;
    const multiClient = MISSION_SESSION_RE.test(session);
    let dockerExec = null;
    let dockerStream = null;
    let closed = false;
    let titleIv = null; // polls the tmux window title for the terminal header
    let lastTitle = null; // last title frame sent to this client (null = unsent, force first frame)
    const connId = Math.random().toString(36).slice(2, 6);

    const cleanup = (reason) => {
      if (closed) return;
      closed = true;
      terminalInput.close();
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
      // (or is about to) and a sweep here would kill ITS tmux client too. For
      // multi-client (mission) sessions the sweep is deferred until the LAST
      // client leaves, so live clients are never killed but orphans still go.
      if (entry.replaced) {
        console.log(`[wss/terminal] ${connId} replaced — skipping sweep`);
      } else if (multiClient) {
        // Always reap THIS connection's own attach client, even while other
        // clients remain: the sweep below cannot run in that case, and that
        // gap is what let a session a user left open accumulate orphans.
        reapAttachByPid(vmName, session, connId);
        const set = terminalClients.get(termKey);
        if (set) set.delete(connId);
        if (set && set.size > 0) {
          console.log(`[wss/terminal] ${connId} left ${termKey} — ${set.size} client(s) still attached, skipping sweep`);
        } else {
          terminalClients.delete(termKey);
          console.log(`[wss/terminal] ${connId} was the last client on ${termKey} — sweeping orphans`);
          sweepStaleAttaches(vmName, session);
        }
      } else {
        sweepStaleAttaches(vmName, session);
      }
      if (activeTerminals.get(termKey)?.cleanup === cleanup) activeTerminals.delete(termKey);
      if (titleIv) { clearInterval(titleIv); titleIv = null; }
    };

    const entry = { ws, cleanup, connId, replaced: false };

    // Single-client policy: this connection replaces any older one for the
    // same PAD/session. Kicking it with 4001 makes its client stop retrying,
    // so two attached clients can never fight each other again. Mission
    // sessions keep every client (see the note on activeTerminals).
    if (multiClient) {
      // The session is identified by tmux id here, but its truth lives in the
      // DB row. If the row is gone the session was closed: refuse to attach
      // instead of letting the lazy tmux ensure below resurrect it as a bare
      // shell, which would make "Close" un-do itself for every attached client
      // (each one reconnects and re-creates it).
      if (!mission.getSessionByTmux(session)) {
        console.log(`[wss/terminal] ${connId} refused ${termKey} — mission session is closed`);
        if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m[Session closed — it is no longer on the Mission page]\x1b[0m\r\n`);
        // 4003, NOT 4002. 4002 means "the PAD is stopped" and the client retries
        // it with backoff until the PAD comes back — correct there, but this
        // session is CLOSED and will never return, so retrying turned one close
        // into an endless refusal storm against the server (measured: 29
        // refusals in 90s, still going). 4003 tells the client to stop.
        ws.close(4003, 'mission session closed');
        return;
      }
    }

    const prev = activeTerminals.get(termKey);
    if (!multiClient && prev && prev.ws && prev.ws.readyState === ws.OPEN) {
      console.log(`[wss/terminal] ${connId} supersedes ${prev.connId} (${termKey})`);
      prev.replaced = true;
      try { prev.ws.close(4001, 'replaced by a newer terminal connection'); } catch {}
    } else if (multiClient) {
      console.log(`[wss/terminal] ${connId} joins ${termKey} (multi-client, ${prev ? 'a client is already attached' : 'first client'})`);
      if (!terminalClients.has(termKey)) terminalClients.set(termKey, new Set());
      terminalClients.get(termKey).add(connId);
    }
    activeTerminals.set(termKey, entry);

    try {
      // Make sure the tmux session exists (lazily installs tmux on old images).
      // Sweep stale attaches from crashed connections first so exactly one
      // client attaches below — but never for a multi-client (mission)
      // session, where the attaches it would kill are LIVE clients: doing it
      // anyway makes every new tab drop the previous one and the two reconnect
      // forever, which is the exact loop this policy exists to prevent.
      if (!multiClient) await sweepStaleAttaches(vmName, session);
      // …and the same goes for the ensure, on the mission path only.
      // `createSession` costs two `docker exec` round trips (`ensureTmux` +
      // `hasSession`) before it can conclude what is already true for a mission
      // session: Mission created that tmux session itself, and the DB row was
      // verified a few lines above. Paying for it on every attach is what made
      // switching rows in col 2 pause for ~1s before the first pixel arrived
      // (measured: first byte at 1013–1159ms, of which ~700ms was these two
      // execs and the rest the attach itself).
      //
      // Skipping it is also the safer behaviour for a session whose tmux pane has
      // died: `createSession` used to silently RE-CREATE it as a bare shell, so
      // "Close" appeared to un-do itself and the pane looked alive when it was
      // not. Now the attach below simply fails, and the page's own pane state
      // (paneState().live) drives the dead-pane Restart affordance.
      if (!multiClient) await ensureTmuxSession(vmName, session, cols, rows);
    } catch (err) {
      console.error('[wss/terminal] tmux setup error:', err.message);
      if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m[Terminal error: ${err.message}]\x1b[0m\r\n`);
      ws.close();
      return;
    }

    // Post-attach command (plan 41): if the webui wrote a post-attach.sh (bound
    // via the build-dir /build mount), run it when this terminal attaches so
    // the hook's output lands in the session. Best-effort and non-blocking — a
    // failure must never take the terminal down.
    try {
      if (vm.postAttachScriptPath && fs.existsSync(vm.postAttachScriptPath(vmName))) {
        runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'sh', '-lc', '[ -f /build/post-attach.sh ] && bash /build/post-attach.sh || true'], { timeout: 60000 }).catch((e) => {
          console.error(`[wss/terminal] post-attach error for ${vmName}:`, e.message);
        });
      }
    } catch (e) {
      console.error(`[wss/terminal] post-attach probe error for ${vmName}:`, e.message);
    }

    // Fresh connection → replay tmux's persistent scrollback into the new
    // xterm first, so the terminal behaves like a real one: output from before
    // this connection (reload, PAD switch, reconnect) is still scrollable.
    // With no scrollback, capture-pane contains only the current screen plus
    // unused rows below the cursor. The tmux attach repaint already provides
    // that screen, so replaying it would make a refresh look like blank lines
    // were entered after the prompt.
    try {
      if (wantHistory) {
        const history = await runCmd(
          'docker',
          ['exec', ...termUserArgs(vmName), vmName, 'tmux', 'display-message', '-p', '-t', session, '#{history_size}'],
          { timeout: 15000, check: false }
        );
        const historySize = Math.max(0, parseInt(history.stdout, 10) || 0);
        if (historySize > 0) {
          const hist = await runCmd(
            'docker',
            ['exec', ...termUserArgs(vmName), vmName, 'sh', '-lc', `tmux capture-pane -t ${session} -p -e -S -${TMUX_HISTORY} 2>/dev/null`],
            { timeout: 20000, check: false }
          );
          if (hist.code === 0 && hist.stdout && ws.readyState === ws.OPEN) {
            // capture-pane emits LF-only lines. xterm needs CRLF to return to
            // column zero; otherwise each restored line starts after the last.
            // It also includes every unused row below the cursor. Replaying those
            // viewport blanks as history makes reconnects look like random Enter
            // presses after the prompt, so preserve content but drop that padding.
            const replay = hist.stdout.replace(/(?:\r?\n)+$/, '');
            if (replay) ws.send(replay.replace(/\r?\n/g, '\r\n'));
          }
        }
      }
    } catch (err) {
      console.error('[wss/terminal] scrollback replay error:', err.message);
    }

    try {
      const container = dockerClient.getContainer(vmName);
      const userMeta = readMeta(vmName);
      // Reap clients orphaned by a previous webui process before this attach
      // claims a pid file of its own (mission sessions only).
      if (multiClient) await sweepOrphanAttachPids(vmName);
      dockerExec = await container.exec({
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Tty: true,
        // LANG is required: without a UTF-8 locale tmux assumes the client
        // cannot do Unicode and substitutes every non-ASCII glyph with `_`
        // (TUI bullets ● ◆ ○ ↑/↓ • all arrive as underscores).
        // User-mode pads (plan 43 Phase 7) attach as the `pad` user so the
        // tmux socket/user match the session created by ensureTmuxSession.
        ...(userMeta.USER_MODE === 'user' ? { User: `${USER_UID}:${USER_GID}` } : {}),
        Env: ['TERM=xterm-256color', 'LANG=C.UTF-8', ...(userMeta.USER_MODE === 'user' ? ['HOME=/root'] : [])],
        // Attach to the persistent tmux session instead of spawning a throwaway
        // `bash -i`. On WS close the attach client dies but the session stays,
        // so reloads and tab switches pick up exactly where they left off.
        //
        // Mission sessions wrap the attach in `sh -c` so it records its own PID
        // (targeted cleanup, and a boot sweep of the previous process's
        // orphans). `sh -c` not `-lc`: a login shell would print profile output
        // into the user's terminal. `exec` keeps the same PID, so the file
        // names the tmux process itself.
        Cmd: multiClient
          ? ['sh', '-c', `echo $$ > ${attachPidPath(connId)}; exec tmux attach-session -t ${session}`]
          : ['tmux', 'attach-session', '-t', session],
      });
      dockerStream = await dockerExec.start({ hijack: true, stdin: true, stdout: true, stderr: true });
    } catch (err) {
      console.error('[wss/terminal] start error:', err.message);
      if (ws.readyState === ws.OPEN) ws.send(`\r\n\x1b[31m[Terminal error: ${err.message}]\x1b[0m\r\n`);
      ws.close();
      return;
    }

    // Apply the newest size, including updates received during setup. A
    // transport-open socket is not yet a shell-ready socket.
    try {
      if (!await terminalInput.attach(dockerExec, dockerStream)) {
        cleanup('closed-during-attach');
        return;
      }
    } catch (err) {
      console.error('[wss/terminal] initial resize error:', err.message);
      cleanup('initial-resize-error');
      ws.close();
      return;
    }

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

    if (ws.readyState === ws.OPEN) ws.send('\x00\x00' + JSON.stringify({ type: 'ready' }));

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
        // Only the tab whose pane actually runs the opencode TUI gets the
        // title. `opencode web` sessions would otherwise leak into every tab
        // (see opencodePanes). An empty title frame clears a stale dynTitle.
        try {
          const openPanes = await opencodePanes(vmName);
          if (openPanes.has(session)) t = await opencodeSessionTitle(vmName) || '';
        } catch {}
        if (t) t = 'OC | ' + t;
        if (t !== lastTitle && ws.readyState === ws.OPEN) {
          lastTitle = t;
          ws.send('\x00\x00' + JSON.stringify({ type: 'title', title: t }));
        }
      } else if (t !== lastTitle && ws.readyState === ws.OPEN) {
        lastTitle = t;
        ws.send('\x00\x00' + JSON.stringify({ type: 'title', title: '' }));
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

    ws.on('close', () => cleanup('ws-close'));
    ws.on('error', cleanup);
    return;
  }
});

try { getDb(); console.log('App metadata database initialized'); } catch (e) { console.error('DB init error:', e.message); }
