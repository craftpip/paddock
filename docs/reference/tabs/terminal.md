# Terminal Tab

The terminal is the agent page's one interactive shell. It runs a **persistent
tmux session** inside the PAD container and shows it in the browser with
xterm.js. Everything typed in the pane runs live in that container — Enter,
arrows, and raw-mode TUI apps (opencode, fzf, htop) behave exactly like a local
terminal. The session survives page reloads, mode switches, and even webui
restarts; the only thing that kills it is stopping the PAD itself.

## Core concept

The agent page is a **terminal emulator with a GUI command picker**. The
terminal is mounted **once per agent** at the page level and stays alive the
whole time you're on that agent's page. It is docked at the bottom of every
mode; Commands mode is the default landing mode and lets the terminal take the
full remaining height. GUI elements (tables, cards, lists) are for **displaying
information**; for **entering things, setting things up, configuring** the
terminal flow takes over — clicking a button types the CLI command into the
terminal and executes it, so the user sees every command, every output, every
prompt.

## Where the code lives

| Piece | File | What it does |
|-------|------|--------------|
| Frontend component | `src/client/src/components/Terminal.jsx` | The one-and-only shell component (xterm.js + WebSocket + sessions dropdown). |
| Backend WS handler | `src/app.js` — "Terminal WebSocket" block (`wsType === 'terminal'`) | tmux session setup, scrollback replay, real PTY attach. |
| Sessions API | `src/app.js` — `GET/DELETE /api/agents/:name/terminal-sessions[/:id]` | List, switch, create, kill tmux sessions. |
| Command log | `src/app.js` — `POST /api/agents/:name/command-log` | Records run commands for the Activity tab. |
| Used by | `src/client/src/pages/AgentDetail.jsx` | The agent page — docked terminal, always mounted, one per agent. |

There is exactly one terminal component in the app. If a page needs a shell,
use `&lt;Terminal&gt;`. Do not copy the xterm/WebSocket setup elsewhere.

## How it works

Two halves: a React component that owns xterm.js, and an Express WebSocket
handler that owns a tmux attach over Docker's real PTY. They talk over one
socket, and each tmux session is bound to one shell that keeps running between
connections.

```
Browser (Terminal.jsx)  ──ws://host/ws/terminal/&lt;name&gt;?session=&lt;id&gt;──▶  Express (app.js)
     xterm.js  ◀── capture-pane replay + raw PTY output ───────  dockerode hijack stream
     keystrokes ──▶ raw bytes ────────────────────────────────▶  tmux attach -t &lt;session&gt;
     resize \x00\x00{...} ──▶ control frame ─────────────────▶  /exec/:id/resize
```

### Backend — persistent tmux sessions via Docker Engine API

Each terminal session is a **tmux session** inside the PAD container (default
`main`, more via the dropdown: `term-1`, `term-2`, ...). The WS handler only
**attaches**; closing the WebSocket detaches the client and leaves the session
running. The next connection reattaches and replays the pane history.

Setup is idempotent and runs on every connect (`ensureTmuxSession`):

1. **Lazy tmux install** — tmux is in the base image, and installed on demand
   for older images (`apt-get install -y tmux`), cached in a `tmuxReady` set.
2. **Shell choice** — `tmux new-session` runs `bash` when the image has it,
   falling back to the default shell otherwise (busybox-ash emits a doubled
   blank line on Ctrl+C; bash does not).
3. **Colored PS1** — appended to `/root/.bashrc` (idempotent) because
   tmux-created shells inherit the tmux server env, not the attach exec env.
4. **`/root/.tmux.conf`** — `set -ga terminal-overrides ',xterm-256color:smcup@:rmcup@'`
   strips the alternate-screen enter/exit from the attach terminal, so output
   lands on the normal screen and accumulates in the scrollback instead of
   being discarded.
5. **Create if missing** — `tmux new-session -d -s &lt;session&gt; -x &lt;cols&gt; -y &lt;rows&gt;`.
6. **history-limit** — bumped to **10000** (`TMUX_HISTORY`) so the pane
   history matches xterm's scrollback.

Then it attaches with a real PTY allocated by Docker:

```js
const container = dockerClient.getContainer(name);
const exec = await container.exec({
  AttachStdin: true, AttachStdout: true, AttachStderr: true,
  Tty: true,
  Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'],
  Cmd: ['tmux', 'attach-session', '-t', session],
});
const stream = await exec.start({ hijack: true, stdin: true, stdout: true, stderr: true });
await exec.resize({ h: rows, w: cols });   // initial size from ?cols=&rows=
```

No `\r` → `\n` conversion, no `script` wrapper. The PTY line discipline
handles CR/LF. Output is decoded with `StringDecoder('utf8')` so a multibyte
character split across two chunks doesn't garble.

### Scrollback survives refresh

On every fresh connection the handler replays tmux's persistent history into
the new xterm before attaching, so output from before the reload is still
scrollable:

```js
const hist = await runCmd('docker', [
  'exec', vmName, 'sh', '-lc',
  `tmux capture-pane -t ${session} -p -e -S -${TMUX_HISTORY}`,
]);
ws.send(hist.stdout.replace(/\r?\n/g, '\r\n'));   // LF → CRLF, lines land at col 0
```

`capture-pane -S` grabs the whole history + current screen; the attach repaint
that follows redraws the same visible screen over it. If the pane is mid-TUI
(alternate screen) there is no history to replay and the capture is just the
current screen, which is still correct. The LF→CRLF conversion matters: xterm
treats a bare LF as "move down, keep column", which renders replayed lines
diagonally ("waterfall") instead of at column 0.

### Single-client policy

tmux allows multiple attached clients, but every extra client makes tmux
full-redraw the pane from home instead of scrolling output incrementally —
which silently destroys xterm's scrollback. Two open browser tabs also fight
each other (each connect sweeps the other's attach → reconnect loop).

So there is **exactly one attached client per session**: the newest connection
wins, older ones are kicked with close code 4001 (`replaced`), and the client
treats 4001 as "do not auto-reconnect". `sweepStaleAttaches()` (`pkill -f
'[t]mux attach-session -t &lt;session&gt;'`) runs on connect **and** close so
orphaned attach processes never pile up.

### Demuxing (why output needs a demux step)

The hijacked stream from Docker is **multiplexed**: stdout and stderr arrive as
8-byte frames `[streamType:1][reserved:3][length:4 BE]`. Sending those bytes
straight to the WebSocket leaks header bytes — a printable length byte shows up
as a stray character in the terminal. The handler therefore runs the stream
through dockerode's demuxer, which strips the headers and routes each frame to
the matching writer:

```js
const stdoutW = new Writable({ write(c, _e, cb) { if (ws.OPEN) ws.send(decoder.write(c)); cb(); } });
dockerClient.modem.demuxStream(stream, stdoutW, stderrW);
```

dockerode's demux falls back to raw passthrough if the stream turns out not to
be multiplexed (e.g. TTY-only streams).

### Authentication

The WS handler resolves the session cookie and requires a valid authenticated
session **before** any container inspection or Docker exec. Non-admin users
must own the PAD. Skipped only when `AUTO_LOGIN=true`. Anonymous WS connections
get `ws.close(1008)`.

## Frontend — `&lt;Terminal&gt;` component

Props (current — see `Terminal.jsx` header for the full table):

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | string | — | PAD/agent name for the WS URL. Required. |
| `title` | string | `name` | Label in the header bar. |
| `height` | string | `'70vh'` | CSS height of the terminal area. |
| `minHeight` | string | `'480px'` | CSS min-height of the terminal area. |
| `collapsed` | boolean | `false` | Hide the body; only the header bar shows. Session stays alive. |
| `showCollapse` | boolean | `true` | Show the collapse chevron (needs `onToggleCollapse`). |
| `onToggleCollapse` | fn | — | Fired when the chevron is clicked. |
| `onCommandStart` / `onCommandDone` | fn | — | Fired when a tracked/locked injected command starts/finishes. |
| `onConnChange` | fn | — | Called `true`/`false` as the WS connects/disconnects. AgentDetail gates every command button on it. |
| `disabled` | boolean | `false` | Lock input from outside. Injected commands still run. |

Imperative API through `ref`:

| Method | Returns | Description |
|--------|---------|-------------|
| `runCommand(cmd, {track})` | boolean | Sends `cmd` + newline. With `{track:true}` appends a completion sentinel and fires `onCommandStart`/`onCommandDone`. **No queue** — returns `false` if the WS isn't open. |
| `write(text)` | boolean | Raw write to shell stdin. **No queue** — drops when disconnected. |
| `clear()` | — | Sends `clear` to the shell — clears the real pane, survives refresh. |
| `reconnect()` | — | Confirms, tears down, and starts a fresh session. Scrollback is preserved (tmux). |
| `focus()` | — | Focuses the terminal. |
| `isConnected()` | boolean | True when the WebSocket is OPEN. |
| `setLocked(v)` / `lock()` / `unlock()` | — | Imperative lock control (independent of the `disabled` prop). |

### Docked layout (AgentDetail)

The terminal dock is **always mounted** on the agent page, one per agent. It
never unmounts while the page is open. On non-Commands modes it auto-collapses
to its header bar (session stays alive); Commands mode takes the full remaining
height. A drag handle resizes the dock outside Commands, and the header has a
fullscreen overlay toggle.

### Session dropdown

The header dropdown lists the PAD's active tmux sessions (`GET
/api/agents/:name/terminal-sessions`) and lets you switch, create
("+ New session" → next free `term-N`), or close (DELETE) a session. The
selected session is persisted in `localStorage` (`pad-term-session-&lt;name&gt;`), so
a page reload returns to the same session. Closing the current session falls
back to `main`. Session names are validated against
`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` (`safeSessionName`).

## WebSocket protocol

Endpoint: `ws://&lt;host&gt;/ws/terminal/&lt;name&gt;?session=&lt;id&gt;&cols=&lt;n&gt;&rows=&lt;n&gt;`
(`session` optional → `main`).

- **Client → server:** raw keystroke bytes, plus control frames framed with a
  double-NUL prefix — `\x00\x00{ type: 'resize', cols, rows }`. The prefix
  can't be typed or pasted, so it never collides with shell input. The server
  only parses JSON after the prefix; everything else goes to the shell as raw
  bytes (no `JSON.parse` on keystrokes). A pasted value that merely *looks like*
  a resize frame reaches the shell.
- **Server → client:** raw PTY output as text frames (rendered verbatim by
  xterm.js), prefixed on a fresh connection by the tmux scrollback replay.

The connection is only accepted when the container is `running` and the
session cookie passes auth — otherwise `ws.close()`.

## Resize

- **Initial size** comes from the `?cols=&rows=` URL params (clamped) and is
  applied right after `exec.start()` via `exec.resize({ h, w })`.
- **Live resize:** the client sends `\x00\x00{ type: 'resize', cols, rows }`
  after every `fit()` (a `ResizeObserver` on the pane) and after font-size
  changes. The server calls the official `POST /exec/:id/resize`, which resizes
  the actual running PTY. The old `docker exec stty` approach never worked
  because it targeted a brand-new process, not the real PTY.

## Lifecycle & robustness

- **Mount:** dynamically imports xterm + FitAddon, opens the terminal, opens
  the WebSocket, attaches a ResizeObserver.
- **`name` change:** full teardown + fresh session.
- **Unmount:** WebSocket closed, xterm disposed, ResizeObserver disconnected,
  all refs cleared. No setState after unmount.
- **Reconnect:** safe to call repeatedly. A generation counter invalidates
  stale in-flight init, so a reconnect during a slow import can never
  double-mount a terminal.
- **Auto-reconnect:** on an unexpected close, retries with backoff that doubles
  to a 30s cap and resets on a successful open. Close code **4001** means
  "replaced by a newer connection" — no auto-reconnect, the user clicks
  Reconnect to retake.
- **Cleanup on the server:** closing/erroring either side destroys the
  hijacked docker stream and sweeps orphaned `tmux attach-session` processes.
  A `closed` guard makes cleanup run once.
- **Init failures** (bad name, xterm load error) render a visible error inside
  the terminal area instead of failing silently.
- **Ctrl/Cmd+C with a selection** is left to the browser (copy), not sent to
  the shell.
- **Wheel policy:** the wheel never becomes arrow-key input inside a TUI. In
  alternate-screen mode xterm's arrow-key alternate-scroll is suppressed; in
  normal mode xterm's viewport scrolls the scrollback natively. Apps with mouse
  reporting still get real wheel events and scroll themselves.
- **Scrollback:** 10,000 lines on both sides (xterm `scrollback` option +
  tmux `history-limit`).

## Tracked commands ("command is done")

A PTY has no "command finished" signal, so `runCommand(cmd, {track:true})`
appends a unique sentinel to the injected line:

```bash
&lt;cmd&gt;; echo; echo __PAD_DONE_&lt;id&gt;__
```

- bash parses the whole line first, so the `echo`s run only after `&lt;cmd&gt;`
  finishes (and are never fed to an interactive app's stdin).
- The empty `echo` prints a newline, so the sentinel always starts on a fresh
  line even when `&lt;cmd&gt;` output ends without a trailing newline.
- The output stream is scanned for `\n__PAD_DONE_&lt;id&gt;__` (sentinel at the start
  of a line) through a rolling tail, so a sentinel split across WebSocket
  frames is still found. The PTY echoes the injected line too, but there the
  sentinel sits mid-line after `echo `, so it can never false-trigger a
  premature "done".
- Multiple injected commands queue: a sentinel set is tracked and `onCommandDone`
  fires only when the last sentinel resolves.

## Locked / read-only mode

The terminal can be locked from outside so the viewer cannot type their own
commands — only commands injected through `runCommand()` execute. While an
injected command is running the user can type again (to answer prompts); when
it finishes, the terminal auto-locks.

- Keystrokes, paste, and Ctrl+C from the user are dropped entirely (selection
  copy via Ctrl/Cmd+C still works in the browser).
- `runCommand()` and `write()` are unaffected — they bypass the lock.
- A `Locked` badge shows in the header and the cursor stops blinking; a
  `Running` pulse shows while an injected command runs.

> **Prop-change timing gotcha:** the `disabled` prop reaches the lock via React's
> effect lifecycle, so it is **not** visible if you call `runCommand()` in the
> *same* tick that you set `disabled={true}`. For operator-driven flows that
> lock and inject in one handler, use the imperative API — it is synchronous:
>
> ```jsx
> <button onClick={() => {
>   termRef.current?.lock();
>   termRef.current?.runCommand('git pull');
> }}>
> ```

## Command flow (CommandsPane.jsx)

Buttons are hardcoded per group in `src/client/src/pages/agent/CommandsPane.jsx`
— not a config file. Every group's pills sit inline on one wrapped float-left
flow; group labels are small chips, live data (primary/fallback model, MCP
servers, skills) shows as neutral chips, and a search box filters all pills.
Pill properties: `cmd`, `label`, `desc`, `confirm`, `danger`, plus dynamic
`click()` handlers.

- **Run TUI** — runs bare `openclaw` in the terminal.
- **Prompt modal** (`usePrompt`) — for buttons that need an argument (logout
  profile id, set model, MCP tools, skill search, etc.). Input + hint text,
  confirm, then the command is injected.
- **Vault dropdown** — right-aligned. Lists vault item names (`/api/vault`); on
  click it fetches the decrypted value (`/api/vault/:id/decrypt`) and
  `term.write()`s it into the terminal **without a newline** — the user presses
  Enter. No echo, no timer, not logged.

**Rule: action buttons paste commands, not APIs.** Every action button in the
Commands pane runs an `openclaw ...` (or per-driver CLI) command through the
terminal via `run(cmd)`. It must NOT call a backend action API — the terminal
is the interface. Read-only GETs are fine (MCP server chips,
`/agent-types/:type/commands` button groups). The Vault dropdown is the
exception on purpose (secrets live server-side).

## Verifying it works

Browser E2E: open a PAD → Commands mode → type `echo ok`, press Enter → you
should see `ok` echo back and a fresh prompt. Also try a raw-mode app like
`opencode` — popups that used to hang on Enter should now work. Then reload the
page: the same output should come back (scrollback replay) and the wheel should
scroll it.

Check a PAD's tmux state directly:

```bash
docker exec &lt;pad&gt; tmux list-sessions
docker exec &lt;pad&gt; tmux show-options -gqv history-limit   # 10000
docker exec &lt;pad&gt; tmux capture-pane -t main -p -e -S -20  # last 20 lines
```

## Troubleshooting

- **"Terminal error: ..." printed in red in the pane** — the backend could not
  exec into the container. Usually the container stopped between the check and
  the exec. Restart the PAD and reconnect.
- **`[Connection closed]` appears immediately** — the container is not in
  `running` state, or the WS handshake was rejected (auth). Check the PAD
  status and your session.
- **`[Terminal taken over by another connection]`** — another tab/session
  attached to the same PAD/session and the single-client policy kicked this
  one. Click Reconnect to retake.
- **Replayed history renders diagonally / "waterfall"** — a stale backend
  without the LF→CRLF conversion. Recreate the `webui` container with the
  current `src/app.js`.
- **TUI app hangs on Enter** — you are almost certainly running the OLD
  backend (pre-dockerode `bash -i`). Rebuild/redeploy `webui` with the current
  `src/app.js`.
