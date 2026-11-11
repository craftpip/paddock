const { execFile } = require('child_process');
const path = require('path');

const { readMeta } = require('./vm-manager');
const { USER_UID, USER_GID } = require('./ownership');

// tmux primitives that run INSIDE a PAD container.
//
// Why this is a service and not part of app.js: the Mission page (plan 53) and
// the MCP tools (plan 52) both need to create a tmux session with a working
// directory, launch a TUI into it, type into it and read the screen back. app.js
// already had all of this for the terminal WebSocket, but mcp.js must never
// require app.js (it would drag Express + the whole route table in). So the
// primitives live here and app.js delegates to them — one implementation, one
// set of hooks, no second copy of the bashrc/tmux.conf setup.

const WORKSPACE = process.env.WORKSPACE_ROOT || '/workspace';
const INSTANCES_DIR = path.join(WORKSPACE, 'instances');

/** tmux history depth to keep + replay on fresh connections (matches xterm's
 *  10000-line scrollback so the terminal behaves like a real terminal). */
const TMUX_HISTORY = 10000;

const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TMUX_READY = new Set();

function runCmd(cmd, args, options = {}) {
  const { timeout = 20000, check = true } = options;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      const r = { code: err ? (err.code || 1) : 0, stdout: stdout || '', stderr: stderr || '' };
      if (err && check) reject(new Error(String(r.stderr || r.stdout || err.message).trim()));
      else resolve(r);
    });
  });
}

/** `docker exec` args that run as the pad user. A pad with meta USER_MODE=user
 *  runs its daemon + terminal as PUID:PGID; tmux is user-scoped there, so its
 *  socket lives in /tmp/tmux-<uid> and every create/attach/exec must run as that
 *  same user or we create a session the terminal can never find. HOME stays
 *  /root so the agent CLIs resolve their config through it. */
function termUserArgs(vmName) {
  let meta = {};
  try {
    meta = readMeta(path.join(INSTANCES_DIR, vmName)) || {};
  } catch {}
  return meta.USER_MODE === 'user' ? ['-u', `${USER_UID}:${USER_GID}`, '-e', 'HOME=/root'] : [];
}

/** Run a shell command string inside the PAD (as the pad user when user-mode). */
function padExec(vmName, cmd, { timeout = 30000, check = true } = {}) {
  return runCmd('docker', ['exec', '-i', ...termUserArgs(vmName), vmName, 'sh', '-lc', cmd], { timeout, check });
}

/** Run tmux inside the PAD with an argv (no shell). Used for anything carrying
 *  user text — `send-keys` must never go through `sh -lc`, or a prompt
 *  containing a quote or a `$(…)` would be mangled or executed by the shell. */
function tmuxExec(vmName, args, { timeout = 20000, check = true } = {}) {
  return runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'tmux', ...args], { timeout, check });
}

async function hasTmux(vmName) {
  const r = await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'sh', '-lc', 'command -v tmux'], { timeout: 15000, check: false });
  return r.code === 0;
}

/** The PAD-wide tmux options, applied once per PAD per webui process.
 *
 *  Not the create path on purpose: `createSession` returns early when the
 *  session already exists — which is what an attach to a live terminal does —
 *  so options set after that check never reached a session that was already
 *  there, and the Terminal tab kept tmux's defaults for the whole life of the
 *  PAD. `ensureTmux` is the one chokepoint every tmux path goes through
 *  (create, attach-through-create, list, kill) and it is already memoised per
 *  PAD, so the options land on the first touch no matter which path that is.
 *  The tmux server outlives the webui, so a restart re-applies harmlessly.
 *
 *  `escape-time` is the one that was user-visible. tmux holds an ambiguous ESC
 *  for up to that many ms waiting to see whether it starts a key sequence
 *  (`\x1b[A`); at the 500ms default a quick ESC press is held, and a second
 *  press 100ms later falls INSIDE the same window — so the first press reads as
 *  lost and only the later one lands. That is the whole "I have to press it
 *  twice" report, and it is not a client-side debounce: nothing on the
 *  keystroke path batches (plan 58 §6). 10ms is far below human key-repeat and
 *  still lets an arrow key arrive as one sequence; 0 would disable the window
 *  entirely and break arrows on a slow link, so 10 is the conservative choice.
 *
 *  `status off` because the webui draws its own session chrome — a tmux status
 *  bar in the pane would only duplicate it. */
async function applyGlobalOptions(vmName) {
  await tmuxExec(vmName, ['set-option', '-g', 'history-limit', String(TMUX_HISTORY)], { timeout: 15000, check: false });
  await tmuxExec(vmName, ['set-option', '-g', 'status', 'off'], { timeout: 15000, check: false });
  await tmuxExec(vmName, ['set-option', '-g', 'escape-time', '10'], { timeout: 15000, check: false });
}

/** Lazy-install tmux once per PAD (images that predate the Dockerfile change). */
async function ensureTmux(vmName) {
  if (TMUX_READY.has(vmName)) return;
  if (await hasTmux(vmName)) {
    await applyGlobalOptions(vmName);
    TMUX_READY.add(vmName);
    return;
  }
  const inst = await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc', 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y --no-install-recommends tmux'],
    { timeout: 240000, check: false }
  );
  if (inst.code !== 0) throw new Error(`tmux install failed: ${String(inst.stderr || inst.stdout || '').trim()}`);
  if (!(await hasTmux(vmName))) throw new Error('tmux still missing after install');
  await applyGlobalOptions(vmName);
  TMUX_READY.add(vmName);
}

function safeSessionName(s) {
  return typeof s === 'string' && SESSION_NAME_RE.test(s) ? s : null;
}

function assertSessionName(s) {
  const name = safeSessionName(s);
  if (!name) throw new Error(`Refusing an unsafe tmux session name: ${JSON.stringify(s)}`);
  return name;
}

/** The host-side hooks a tmux pane needs, written as ROOT into /root (the
 *  pad-user shells read them: /root is chmod 755 in user-mode images).
 *   - the colored PS1 prompt, so an idle shell is readable;
 *   - `smcup/rmcup` stripped from the attach terminal: tmux attach switches the
 *     client to the alternate screen, which has no scrollback, so xterm.js maps
 *     the wheel to arrow keys (the shell recalls history instead of scrolling).
 *     Staying on the normal screen keeps the wheel working — for a TUI pane too,
 *     which is why Mission panes get these hooks as well. */
async function applyHooks(vmName) {
  await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc',
      // Debian's dash does not support echo -e and wrote a literal `-e` into
      // older .bashrc files. Remove that broken managed line before adding the
      // portable printf form, leaving every user-owned line untouched.
      `grep -v '^[-]e export PS1=' /root/.bashrc 2>/dev/null > /tmp/pad-bashrc && mv /tmp/pad-bashrc /root/.bashrc; grep -q '__PAD_PROMPT_V2__' /root/.bashrc 2>/dev/null || printf '%s\\n' "export PS1='\\[\\e[1;36m\\]\\u@\\h\\[\\e[0m\\]:\\w\\$ '  # __PAD_PROMPT_V2__" >> /root/.bashrc; grep -q '__PAD_PS1__' /root/.bashrc 2>/dev/null || printf '%s\\n' '[ -w "\${HOME}/.bash_history" ] || HISTFILE=/tmp/pad_history  # __PAD_PS1__' >> /root/.bashrc`],
    { timeout: 15000, check: false }
  );
  await runCmd(
    'docker',
    ['exec', vmName, 'sh', '-lc',
      `grep -q '__PAD_TMUX_V2__' /root/.tmux.conf 2>/dev/null || echo "set -ga terminal-overrides ',xterm-256color:smcup@:rmcup@'  # __PAD_TMUX_V2__" >> /root/.tmux.conf`],
    { timeout: 15000, check: false }
  );
}

/** Does `folder` exist as a directory INSIDE the PAD?
 *
 *  Not cosmetic: `tmux new-session -c <dir>` does not fail on a missing
 *  directory — it silently falls back to the parent and starts the pane there.
 *  Verified live: asked for /www1/craftpip (gone), got a session whose
 *  `pane_current_path` was /www1, with the agent happily running in the wrong
 *  folder. So every folder is checked before a session is created, and the
 *  answer is what the page shows as a missing-folder badge. */
async function folderExists(vmName, folder) {
  if (!folder) return false;
  // Single-quote for the shell inside the PAD; `'` becomes '\'' so a hostile
  // folder string cannot break out and run anything.
  const q = `'${String(folder).replace(/'/g, `'\\''`)}'`;
  const r = await padExec(vmName, `test -d ${q}`, { timeout: 15000, check: false });
  return r.code === 0;
}

async function hasSession(vmName, session) {
  const r = await tmuxExec(vmName, ['has-session', '-t', assertSessionName(session)], { timeout: 15000, check: false });
  return r.code === 0;
}

/** Create a detached tmux session, optionally rooted at `cwd`.
 *
 *  `cwd` is the whole point for Mission: a project's folder must be the pane's
 *  working directory, so `opencode` / `codex` / `claude` start there and the
 *  user's files are the ones they see. A folder that does not exist inside the
 *  container makes tmux fail — which is exactly the feedback the page wants
 *  before it offers the project.
 *
 *  Creates nothing when the session already exists: reattaching must never
 *  restart a TUI the user is working in. */
async function createSession(vmName, session, { cwd = '', cols = 0, rows = 0 } = {}) {
  const name = assertSessionName(session);
  await ensureTmux(vmName);
  if (await hasSession(vmName, name)) return { created: false, session: name };
  await applyHooks(vmName);
  const c = Math.max(40, Math.min(400, parseInt(cols, 10) || 120));
  const r = Math.max(12, Math.min(120, parseInt(rows, 10) || 32));
  // Prefer bash over the image's default shell: busybox ash (Alpine images,
  // e.g. picoclaw) echoes `^C` with an extra newline on Ctrl+C, leaving a
  // blank line before the next prompt. bash emits a clean single newline.
  const bash = await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, 'sh', '-lc', 'command -v bash'], { timeout: 15000, check: false });
  const shellCmd = bash.code === 0 && bash.stdout.trim() ? bash.stdout.trim() : null;
  // The PAD-wide options are set in the SAME tmux invocation, before the
  // session's window exists. `set-option -g` cannot start a server, so setting
  // them ahead of time (applyGlobalOptions, from ensureTmux) fails silently on
  // a PAD with no session yet, and the PAD was then remembered as done: the
  // first session came up with tmux's defaults, 500 ms ESC delay included.
  // `start-server` first makes the options land on a fresh server too, and
  // history-limit only applies to windows created after it is set.
  const args = ['tmux', 'start-server', ';',
    'set-option', '-g', 'history-limit', String(TMUX_HISTORY), ';',
    'set-option', '-g', 'status', 'off', ';',
    'set-option', '-g', 'escape-time', '10', ';',
    'new-session', '-d', '-s', name];
  if (cwd) args.push('-c', cwd);
  args.push('-x', String(c), '-y', String(r));
  if (shellCmd) args.push(shellCmd);
  const out = await runCmd('docker', ['exec', ...termUserArgs(vmName), vmName, ...args], { timeout: 20000, check: false });
  if (out.code !== 0) {
    const err = String(out.stderr || out.stdout || '').trim();
    // tmux reports a bad -c directory as "no such file or directory"; say so in
    // terms of the folder the page asked for.
    if (/no such file or directory/i.test(err)) {
      throw new Error(`The folder ${cwd} does not exist inside ${vmName}`);
    }
    throw new Error(err || 'tmux new-session failed');
  }
  // Enough history that a fresh attach has something real to replay, and a
  // bare ESC that is not held for half a second: both are PAD-wide tmux options
  // and are applied by `ensureTmux` above, on the first tmux touch of any kind.
  return { created: true, session: name };
}

/** Type `text` into the session's pane as literal keystrokes, then Enter.
 *
 *  `-l` disables tmux's key-name lookup so the text lands verbatim (a prompt
 *  containing "C-c" or "Enter" must not be read as key names). `send-keys` is
 *  run as argv, never through a shell, so quotes and `$(…)` in the prompt are
 *  inert. Multi-line text is sent line by line, each followed by Enter.
 *  Returns the line count so the caller can record it. */
async function sendText(vmName, session, text, { enter = true, paste = false } = {}) {
  const name = assertSessionName(session);
  if (typeof text !== 'string' || !text) return { lines: 0 };
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (line && paste) {
      const buffer = `paddock-${require('crypto').randomUUID()}`;
      await tmuxExec(vmName, ['set-buffer', '-b', buffer, '--', line], { timeout: 15000 });
      await tmuxExec(vmName, ['paste-buffer', '-p', '-d', '-b', buffer, '-t', name], { timeout: 15000 });
    } else if (line) await tmuxExec(vmName, ['send-keys', '-t', name, '-l', '--', line], { timeout: 15000, check: false });
    if (enter) await tmuxExec(vmName, ['send-keys', '-t', name, 'Enter'], { timeout: 15000, check: false });
  }
  return { lines: lines.length };
}

/** Send raw tmux key names (Home, End, Escape, Enter, Left …) — how a
 *  permission dialog gets answered explicitly. Unlike sendText, these are NOT
 *  literal: each entry is a tmux key name. */
async function sendKeys(vmName, session, keys = []) {
  const name = assertSessionName(session);
  for (const k of keys) {
    await tmuxExec(vmName, ['send-keys', '-t', name, String(k)], { timeout: 15000, check: false });
  }
  return { keys: keys.length };
}

/** Run a shell command inside the pane — how a TUI gets launched. Literal
 *  argv, so nothing in the command is re-parsed. */
async function sendCommand(vmName, session, command, { enter = true } = {}) {
  const name = assertSessionName(session);
  await tmuxExec(vmName, ['send-keys', '-t', name, '-l', '--', command], { timeout: 15000 });
  if (enter) await tmuxExec(vmName, ['send-keys', '-t', name, 'Enter'], { timeout: 15000 });
  return true;
}

/** The pane's visible text, last `lines` lines. Backs the session screen the
 *  LLM reads with `mission_sessions(session_id)`. */
async function captureScreen(vmName, session, lines = 40) {
  const name = assertSessionName(session);
  const n = Math.max(1, Math.min(2000, parseInt(lines, 10) || 40));
  const r = await tmuxExec(vmName, ['capture-pane', '-p', '-t', name, '-S', `-${n}`], { timeout: 15000, check: false });
  if (r.code !== 0) return { text: '', live: false };
  const all = String(r.stdout || '').replace(/\s+$/, '').split('\n');
  return { text: all.slice(-n).join('\n'), live: true };
}

/** What is the pane doing right now?
 *
 *  `pane_current_command` is the foreground process of the pane, which is
 *  exactly the distinction the Mission page needs: a TUI pane reports the
 *  agent's binary (or `node` for opencode/codex, which ship as node scripts)
 *  while a TUI that exited dropped back to the shell. So `tuiAlive` is "not a
 *  shell", and the page offers Relaunch TUI in the shell case and Restart when
 *  the tmux session itself is gone. */
async function paneState(vmName, session) {
  const name = assertSessionName(session);
  if (!(await hasSession(vmName, name))) {
    return { live: false, tuiAlive: false, command: '', cwd: '', reason: 'no-session' };
  }
  const r = await tmuxExec(
    vmName,
    ['display-message', '-p', '-t', name, '#{pane_current_command}|#{pane_current_path}'],
    { timeout: 15000, check: false }
  );
  if (r.code !== 0) return { live: false, tuiAlive: false, command: '', cwd: '', reason: 'no-pane' };
  const [command = '', cwd = ''] = String(r.stdout || '').trim().split('|');
  return { live: true, tuiAlive: !isShellCommand(command), command, cwd };
}

async function killSession(vmName, session) {
  const name = assertSessionName(session);
  await ensureTmux(vmName);
  const r = await tmuxExec(vmName, ['kill-session', '-t', name], { timeout: 15000, check: false });
  if (r.code !== 0 && !/can't find|no such|no server/i.test(String(r.stderr))) {
    throw new Error(String(r.stderr || 'tmux kill-session failed').trim());
  }
  return true;
}

async function listSessions(vmName) {
  await ensureTmux(vmName);
  // tmux 3.3a converts `\t` inside `-F` formats into `_`, so use a `|`
  // delimiter (session names are restricted to [a-zA-Z0-9._-], never `|`).
  const r = await tmuxExec(vmName, ['list-sessions', '-F', '#{session_name}|#{session_attached}|#{session_created}'], { timeout: 15000, check: false });
  // "No tmux server" is a real answer: there are no sessions. Any other
  // failure (the container is unreachable, docker timed out) is NOT an empty
  // list, and returning one made every caller conclude the sessions had died.
  if (r.code !== 0 && r.code !== undefined) {
    const said = String(r.stderr || '');
    // Docker and tmux both explain a real failure on stderr; silence with a
    // non-zero exit is tmux having nothing to list.
    if (said.trim() && !/no server running|no sessions|error connecting to|No such file or directory/i.test(said)) {
      throw new Error(`Could not list tmux sessions in ${vmName}: ${said.trim().split('\n').pop() || `exit ${r.code}`}`);
    }
  }
  const sessions = [];
  for (const line of (r.stdout || '').split('\n')) {
    const [name, attached, created] = line.split('|');
    if (!name) continue;
    sessions.push({ name, attached: attached === '1', created: parseInt(created, 10) || 0 });
  }
  return sessions;
}

/** One-call-per-PAD pane map: session name → { command, cwd }.
 *  `list-sessions` tells us a tmux session exists; it cannot tell a live agent
 *  TUI from a pane that dropped back to a shell, or where that pane is rooted.
 *  `list-panes -a` answers both in the same O(PADs) budget — never one
 *  `paneState` per row — so list mode can carry `kind`/`cwd` without scaling
 *  with the session count. A PAD that cannot be listed yields an empty map. */
async function listPanes(vmName) {
  const map = new Map();
  try {
    await ensureTmux(vmName);
    const r = await tmuxExec(
      vmName,
      ['list-panes', '-a', '-F', '#{session_name}|#{pane_current_command}|#{pane_current_path}'],
      { timeout: 15000, check: false }
    );
    if (r.code !== 0) return map;
    for (const line of String(r.stdout || '').split('\n')) {
      if (!line.trim()) continue;
      const idx1 = line.indexOf('|');
      if (idx1 < 0) continue;
      const idx2 = line.indexOf('|', idx1 + 1);
      if (idx2 < 0) continue;
      const name = line.slice(0, idx1);
      const command = line.slice(idx1 + 1, idx2);
      const cwd = line.slice(idx2 + 1).trim();
      if (!name) continue;
      if (!map.has(name)) map.set(name, { command, cwd });
    }
  } catch {
    /* empty map — same soft failure as listSessions */
  }
  return map;
}

/** Shell test shared by paneState + list-mode kind stamping.
 *  Fails CLOSED: anything that is not recognisably an agent's process counts as
 *  a shell. This gates a destructive action — `mission_send` types text, and
 *  text typed into a bash pane runs as a command. A wrong 'shell' refuses a
 *  send the caller can retry; a wrong 'agent' executes whatever it sent. The
 *  reachable states are unaffected (a live pane's command is never empty), so
 *  this only decides the case where we did not really look. */
function isShellCommand(command) {
  const c = String(command || '').trim();
  if (!c) return true;
  // Every shell a pane can fall back to, including a login shell's leading
  // dash. Only shells: a pane running vim or ssh is deliberately NOT a shell
  // here, because `tuiAlive` is also what stops a relaunch from typing a
  // launch command into whatever the human has open.
  return /^-?((ba|z|da|a|k|c|tc|fi)?sh|busybox)$/.test(c);
}

module.exports = {
  TMUX_HISTORY,
  SESSION_NAME_RE,
  termUserArgs,
  padExec,
  tmuxExec,
  hasTmux,
  ensureTmux,
  safeSessionName,
  assertSessionName,
  applyHooks,
  hasSession,
  folderExists,
  createSession,
  sendText,
  sendKeys,
  sendCommand,
  captureScreen,
  paneState,
  killSession,
  listSessions,
  listPanes,
  isShellCommand,
  _setForTests: (opts = {}) => {
    if (opts.runCmd) runCmd = opts.runCmd;
    if (opts.resetReady) TMUX_READY.clear();
  },
};
