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
const { writeFileOwned } = require('./services/ownership');
const plans = require('./services/plans');
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
const PREFIX = process.env.CONTAINER_PREFIX || 'pad';
const VM_NAME_RE = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-[a-zA-Z0-9][a-zA-Z0-9_-]*$');

function safeVmName(name) {
  if (!name || !VM_NAME_RE.test(name)) return null;
  return name;
}

const app = express();

// Express 4 ignores the promise an async handler returns: when it rejects, the
// request never gets an answer and the client waits until it times out. Every
// handler registered on the app is wrapped once, here, so a rejection (or a
// throw) reaches the JSON error handler at the bottom instead. Error handlers
// (four arguments) are left alone.
function answerOnFailure(fn) {
  if (typeof fn !== 'function' || fn.length >= 4) return fn;
  return function guarded(req, res, next) {
    try {
      const result = fn.call(this, req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
      return result;
    } catch (err) {
      return next(err);
    }
  };
}
for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
  const original = app[method].bind(app);
  app[method] = (...args) => original(...args.map(answerOnFailure));
}

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

// CSRF: every state-changing API request must carry the session's token. It is
// enforced here, once, not per route: a route that forgot the check used to be
// writable by any page that could make the browser send a form (and under
// AUTO_LOGIN no cookie is even needed). Login and first-run setup are exempt
// because no token exists yet; /mcp is not under /api and authenticates with a
// bearer key instead of a cookie.
const CSRF_EXEMPT = new Set(['/login', '/setup']);
app.use('/api', (req, res, next) => {
  if (CSRF_EXEMPT.has(req.path)) return next();
  return csrfCheck(req, res, next);
});

// ─── Auth: public paths, then enforce on everything else ───

app.use(checkNeedsSetup);

app.use((req, res, next) => {
  if (AUTO_LOGIN) return next();
  // Public paths — no auth needed (docs site is public)
  if (req.path === '/website' || req.path.startsWith('/website/')) return next();
  const publicPaths = ['/api/setup', '/api/login', '/api/session', '/login', '/setup', '/mcp', '/mcp/runner'];
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
  // Error text names the program and its subcommand only. The full argument
  // list can carry a secret (a bot token, an API key passed as a flag) and
  // these messages are returned to the browser.
  const what = [cmd, ...(args || []).filter((a) => typeof a === 'string' && /^[a-z][a-z0-9-]*$/i.test(a)).slice(0, 3)].join(' ');
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args || [], { timeout }, (err, stdout, stderr) => {
      if (err) {
        if (err.killed) {
          reject(new Error(`Command timed out after ${Math.round(timeout / 1000)}s: ${what}`));
        } else if (err.code === 'ENOENT') {
          reject(new Error(`Command not found: ${cmd}`));
        } else if (check && err.code !== 0) {
          reject(new Error(`Command failed: ${what}\n${stderr}`));
        } else {
          resolve({ stdout: stdout || '', stderr: stderr || '', code: err.code });
        }
      } else {
        resolve({ stdout, stderr, code: 0 });
      }
    });
    // execFile has no `input` option (only the sync variants do), so stdin is
    // written and closed here. Leaving it open made a command that reads
    // stdin wait until the timeout: onboarding's key paste never worked.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (input !== undefined && input !== null) child.stdin.write(String(input));
      child.stdin.end();
    }
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
  // While a create is running the creator owns it by claim (see agent-registry).
  if ((!row || !row.owner_id) && registry.pendingOwner(name) === req.session.userId) return next();
  if (!row || row.owner_id !== req.session.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
});

// ─── Path probing (plan 40) ──────────────────────────────────
// Read-only filesystem probes for the Create Agent workspace source field:
// existence/writability/compose detection plus autocomplete suggestions. The
// one-to-one mount rule means "exists in the container" ≈ "valid host source".

const pathProbe = require('./services/path-probe');

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

function writeEnvFile(lines) {
  writeFileOwned(ENV_FILE, lines.join('\n') + '\n', { boundary: WORKSPACE });
  envCache = null;
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
  // Plan 88 §Phase 2: a delivery outcome is a three-state, not a boolean, so a
  // caller can offer recovery instead of guessing from the message text.
  // `attempted` = a write reached the pane; `acceptance` = 'confirmed' |
  // 'unknown' | 'refused'. Emitted only when the error carries them.
  const body = { error: e.message, code: e.code || 'mission_error' };
  if (e.attempted !== undefined) body.attempted = e.attempted;
  if (e.acceptance !== undefined) body.acceptance = e.acceptance;
  res.status(status).json(body);
}

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

// ── Routes ─────────────────────────────────────────────────────────────────
// Each area lives in routes/<area>.js and registers itself here, in the order
// its first route used to appear in this file. `ctx` hands over the helpers
// this file owns; modules require services themselves.
require('./routes/auth')(app, {
  ensureAutoLogin,
});
require('./routes/agents')(app, {
  PREFIX, readMeta, dockerPsList, safeVmName, runCmd, termUserArgs, dockerExec,
});
require('./routes/system')(app, {
  PREFIX, ENV_FILE, writeEnvFile, dockerClient, runCmd,
});
require('./routes/agent-settings')(app, {
  safeVmName, readMeta, INSTANCES_DIR, runCmd,
});
require('./routes/agent-workspace')(app, {});
require('./routes/agent-integrations')(app, {
  opencodePanes, opencodeSessionTitle, safeVmName, dockerExec, dockerPsList, ensureSqlite3,
  safeSessionName, canTouchAgent, missionFail,
});
require('./routes/mission')(app, {
  canTouchAgent, missionFail, missionActorFor,
});
require('./routes/mission-runners')(app, {
  canTouchAgent, missionFail, missionActorFor,
});
require('./routes/vault')(app, {});


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
  // Machine endpoints must never get the SPA. An MCP client that receives a
  // 401 from /mcp runs OAuth discovery (`/.well-known/oauth-*`, also under
  // `/mcp/`); a 200 index.html there surfaced in the agent as
  // "JSON Parse error: Unrecognized token '<'" instead of "bad key".
  if (req.path.startsWith('/.well-known/') || req.path.startsWith('/mcp/')) return next();
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
  if (res.headersSent) return next(err);
  // A service error that names its own status and machine code keeps them.
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  res.status(status).json({ error: err.message || 'Internal server error', ...(err.code && typeof err.code === 'string' ? { code: err.code } : {}) });
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
  // Plan 89: a PAD's web start hook lives on disk, not in its image, so an
  // already-published user-mode PAD keeps its root-launching hook until it is
  // rewritten. Regenerate on boot so the fix lands on restart, no apply needed.
  try {
    const fixed = vm.migrateWebHooks();
    if (fixed.length) console.log(`[plan 89] web start hook now drops to the pad user: ${fixed.join(', ')}`);
  } catch {}
});

const server = app.listen(6789, () => console.log('VM WebUI listening on port 6789'));

// Infinite-runner supervisor (plan 85 §Phase 4): one non-overlapping tick at
// app startup. `reconcileRunners` only logs runners left enabled across the
// restart (no auto-resume — the human presses Run). `runnerWatchTick` then
// supervises enabled runners every 20s; the `watchRunning` flag keeps ticks
// from overlapping, and each tick re-checks the run generation before any
// send, so a Pause that lands mid-tick still wins.
// 20s interval chosen to keep A→B continuation snappy while avoiding
// unnecessary wake-ups. RevChanged path dispatches immediately on queue change
// regardless of interval.
mission.reconcileRunners().catch((e) => console.error('[runner reconcile]', e.message));
try {
  const result = mission.reconcileQueuePublications();
  if (result.published || result.blocked) {
    console.log(`[runner publications] republished ${result.published}; external edits blocked ${result.blocked}`);
  }
} catch (e) {
  console.error('[runner publication reconcile]', e.message);
}
// Plan 92 §Phase 3: callback rows caught `running` across the restart never
// launched to completion — finalize them `unknown` (honest, no replay), then
// pump whatever is pending. `pending` rows never launched, so launching them
// now is a first launch, not a replay.
try {
  const orphans = mission.reconcileCallbackOutbox();
  if (orphans) console.log(`[callbacks reconcile] ${orphans} interrupted execution(s) finalized as unknown`);
} catch (e) {
  console.error('[callbacks reconcile]', e.message);
}
mission.pumpCallbackOutbox().catch((e) => console.error('[callbacks]', e.message));
let runnerWatchRunning = false;
setInterval(() => {
  if (runnerWatchRunning) return;
  runnerWatchRunning = true;
  mission.runnerWatchTick()
    .catch((e) => console.error('[runner watch]', e.message))
    .finally(() => { runnerWatchRunning = false; });
}, 20000);
// Callback baseline + pump on the same cadence, independently guarded: a slow
// script must never hold up supervision, and supervision must never hold up a
// due callback.
let callbacksTickRunning = false;
setInterval(() => {
  if (callbacksTickRunning) return;
  callbacksTickRunning = true;
  (async () => {
    await mission.baselineRunnerCallbacks();
    await mission.observeRunnerQueues();
    await mission.observeRunnerUsage();
    await mission.pumpCallbackOutbox();
  })()
    .catch((e) => console.error('[callbacks tick]', e.message))
    .finally(() => { callbacksTickRunning = false; });
}, 20000);

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
  // A browser sends Origin on a WebSocket handshake and does NOT apply the
  // same-origin policy to it, so a page on another origin could otherwise open
  // a shell with the user's cookie. A request with no Origin is not a browser.
  const origin = req.headers.origin;
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* malformed → refused below */ }
    if (!originHost || originHost !== req.headers.host) {
      console.warn(`[wss] refused cross-origin handshake from ${origin}`);
      ws.close(1008, 'Cross-origin connection refused');
      return;
    }
  }
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
