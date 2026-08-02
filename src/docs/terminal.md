# Terminal — The Interactive Shell

The terminal is the app's one interactive shell. It runs a real bash session
inside a PAD container and shows it in the browser with xterm.js. Everything
you type in the pane runs live in that container — Enter, arrows, and
raw-mode TUI apps (opencode, fzf, htop) behave exactly like a local terminal.

## Where the code lives

| Piece | File | What it does |
|-------|------|--------------|
| Frontend component | `src/client/src/components/Terminal.jsx` | The one-and-only shell component (xterm.js + WebSocket). |
| Backend WS handler | `src/app.js` — "Terminal WebSocket" block (`wsType === 'terminal'`) | Talks to Docker and runs the real PTY. |
| Used by | `src/client/src/pages/AgentDetail.jsx` | Terminal tab + Health tab both render `<Terminal>`. |

There is exactly one terminal component in the app. If a page needs a shell,
use `<Terminal>`. Do not copy the xterm/WebSocket setup elsewhere.

## How it works

Two halves: a React component that owns xterm.js, and an Express WebSocket
handler that owns a Docker exec session. They talk over one socket.

```
Browser (Terminal.jsx)  ──ws://host/ws/terminal/<name>──▶  Express (app.js)
     xterm.js  ◀── raw PTY output (text frames) ────  dockerode hijack stream
     keystrokes ──▶ raw bytes ───────────────────────────▶ docker exec PTY
     resize JSON ──▶ { type:'resize', cols, rows } ──────▶ /exec/:id/resize
```

### Backend — real PTY via Docker Engine API

The old approach ran `docker exec -i` with a `script -qfec` wrapper and then
mangled `\r` → `\n` on the way in, because there was no PTY line discipline.
That made raw-mode TUI apps hang on Enter in popups. It's gone.

Now the handler uses **dockerode** against `/var/run/docker.sock` and lets
Docker allocate the PTY (`Tty: true`):

```js
const container = dockerClient.getContainer(name);
const exec = await container.exec({
  AttachStdin: true, AttachStdout: true, AttachStderr: true,
  Tty: true,
  Env: ['TERM=xterm-256color'],
  Cmd: ['bash', '-i'],
});
const stream = await exec.start({ hijack: true, stdin: true, stdout: true, stderr: true });
await exec.resize({ h: rows, w: cols });   // initial size from ?cols=&rows=
```

No `\r` → `\n` conversion, no `script` wrapper. The PTY line discipline
handles CR/LF. Output is decoded with `StringDecoder('utf8')` so a multibyte
character split across two chunks doesn't garble.

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

### Frontend — `<Terminal>` component

Props:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | string | — | PAD/agent name for the WS URL. Required. |
| `title` | string | `name` | Label in the header bar. |
| `height` | string | `'70vh'` | CSS height of the terminal area. |
| `minHeight` | string | `'480px'` | CSS min-height of the terminal area. |

Imperative API through `ref`:

| Method | Returns | Description |
|--------|---------|-------------|
| `runCommand(cmd)` | boolean | Sends `cmd` + newline to the shell. Queued until the WS opens. True if sent immediately. |
| `write(text)` | boolean | Raw write to shell stdin. Queued when disconnected. |
| `clear()` | — | Clears visible scrollback. |
| `reconnect()` | — | Tears down and starts a fresh session. |
| `focus()` | — | Focuses the terminal. |
| `isConnected()` | boolean | True when the WebSocket is OPEN. |

Preset-button pattern (Health tab uses this):

```jsx
<Terminal ref={termRef} name={agent.name} />
<button onClick={() => termRef.current?.runCommand('openclaw health')}>
```

Commands written while the socket is down are queued (capped at 64) and
flushed on `onopen`.

## WebSocket protocol

Endpoint: `ws://<host>/ws/terminal/<name>?cols=<n>&rows=<n>`

- **Client → server:** raw keystroke bytes, plus JSON frames:
  `{ type: 'resize', cols: <n>, rows: <n> }`
- **Server → client:** raw PTY output as text frames (rendered verbatim by
  xterm.js).

The connection is only accepted when the container is `running`
(`dockerPsList` + `State` check) — otherwise `ws.close()`.

## Resize

- **Initial size** comes from the `?cols=&rows=` URL params and is applied
  right after `exec.start()` via `exec.resize({ h, w })`.
- **Live resize:** the client sends `{ type: 'resize', cols, rows }` after
  every `fit()` (a `ResizeObserver` on the pane) and after font-size changes.
  The server calls the official `POST /exec/:id/resize`, which resizes the
  actual running PTY. The old `docker exec stty` approach never worked because
  it targeted a brand-new process, not the real PTY.

## Lifecycle & robustness

- **Mount:** dynamically imports xterm + FitAddon, opens the terminal, opens
  the WebSocket, attaches a ResizeObserver.
- **`name` change:** full teardown + fresh session.
- **Unmount:** WebSocket closed, xterm disposed, ResizeObserver disconnected,
  all refs cleared. No setState after unmount.
- **Reconnect:** safe to call repeatedly. A generation counter invalidates
  stale in-flight init, so a reconnect during a slow import can never
  double-mount a terminal.
- **Cleanup on the server:** closing/erroring either side destroys the
  hijacked docker stream (which makes the Docker daemon kill the exec
  process) and closes the WebSocket. A `closed` guard makes cleanup run once.
- **Init failures** (bad name, xterm load error) render a visible error inside
  the terminal area instead of failing silently.
- **Ctrl/Cmd+C with a selection** is left to the browser (copy), not sent to
  the shell.
- **Scrollback:** 10,000 lines.

## Locked / read-only mode

The terminal can be locked from outside so the viewer cannot type their own
commands — only commands injected through `runCommand()` execute. While an
injected command is running the user can type again (to answer prompts or poke
the command); when it finishes, the terminal auto-locks.

### Props / API

| Prop             | Type    | Description |
|------------------|---------|-------------|
| `disabled`       | boolean | Lock the terminal from outside. Default `false`. |
| `onCommandStart` | fn      | Fired when an injected command starts (locked mode only). |
| `onCommandDone`  | fn      | Fired when an injected command finishes (locked mode only). |

Imperative: `setLocked(v)`, `lock()`, `unlock()`, `isLocked()`.

```jsx
<Terminal ref={termRef} name={agent.name} disabled
         onCommandStart={() => setBusy(true)}
         onCommandDone={() => setBusy(false)} />
<button onClick={() => termRef.current?.runCommand('git pull')}>
```

> **Prop-change timing gotcha:** the `disabled` prop reaches the lock via React's
> effect lifecycle, so it is **not** visible if you call `runCommand()` in the
> *same* tick that you set `disabled={true}` — the command runs unlocked (no
> sentinel). For operator-driven flows that lock and inject in one handler, use
> the imperative API instead — it is synchronous:
>
> ```jsx
> <button onClick={() => {
>   termRef.current?.lock();
>   termRef.current?.runCommand('git pull');
> }}>
> ```

### How "command is done" is detected

A PTY has no "command finished" signal, so in locked mode `runCommand()` appends
a unique sentinel to the injected line:

```bash
<cmd>; echo; echo __PAD_DONE_<id>__
```

- bash parses the whole line first, so the `echo`s run only after `<cmd>`
  finishes (and are never fed to an interactive app's stdin).
- The empty `echo` prints a newline, so the sentinel always starts on a fresh
  line even when `<cmd>` output ends without a trailing newline.
- The output stream is scanned for `\n__PAD_DONE_<id>__` (sentinel at the start
  of a line) through a rolling tail, so a sentinel split across WebSocket
  frames is still found. The PTY echoes the injected line too, but there the
  sentinel sits mid-line after `echo `, so it can never false-trigger a
  premature "done".
- Multiple injected commands queue: a sentinel set is tracked and the terminal
  only re-locks when the last sentinel resolves.

(An earlier draft used `stty -echo` to hide the injected line — dropped because
the echo change races with the next line's bytes. The sentinel stays visible in
the output; treat it as a "command finished" indicator.)

### Behavior while locked

- Keystrokes, paste, and Ctrl+C from the user are dropped entirely (selection
  copy via Ctrl/Cmd+C still works in the browser).
- `runCommand()` and `write()` are unaffected — they bypass the lock.
- A `Locked` badge shows in the header and the cursor stops blinking.
- While an injected command runs, a `Running` pulse shows instead.

## What it is NOT

The **Messaging tab** has its own one-shot WS command runner (`wsType ===
'messaging'`) that still uses `docker exec` + `script`. That is a separate
"run one command, show output" feature, not an interactive shell. If its
interactive prompts ever misbehave, revisit it separately — do not confuse it
with this terminal.

## Verifying it works

Quick protocol test against a running PAD (run inside the webui container or
on a host that can reach the published WS port):

```js
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:5051/ws/terminal/<pad>?cols=120&rows=32');
ws.on('open', () => {
  ws.send('echo hi\r');                     // Enter goes straight through
  ws.send(JSON.stringify({ type: 'resize', cols: 60, rows: 12 })); // live resize
  ws.send('stty size\r');                   // should report "12 60"
});
ws.on('message', (d) => console.log(String(d)));
```

Browser E2E: open the PAD → Terminal tab → type `echo ok`, press Enter → you
should see `ok` echo back and a fresh prompt. Also try a raw-mode app like
`opencode` — popups that used to hang on Enter should now work.

## Troubleshooting

- **"Terminal error: ..." printed in red in the pane** — the backend could not
  exec into the container. Usually the container stopped between the check and
  the exec. Restart the PAD and reconnect.
- **`[Connection closed]` appears immediately** — the container is not in
  `running` state, or the WS handshake was rejected. Check the PAD status.
- **TUI app hangs on Enter** — you are almost certainly running the OLD
  backend (pre-dockerode). Rebuild/redeploy `webui` with the current
  `src/app.js`.
