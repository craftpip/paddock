# Terminal Component — Unify All Terminals

## Status: In Progress (2026-08-02)

## Goal

There are multiple terminal implementations scattered across the app:

| Where | Tech | Interactive? |
|-------|------|:------------:|
| **Terminal tab** | xterm.js + WebSocket (`/ws/terminal/:name`) | ✅ full shell |
| **Health tab** | SSE (`/api/agents/:name/exec-stream`) + `Console` | ❌ one-shot output |
| **Messaging tab** | WS `credential-paste` + `Console` | ⚠ interactive-ish |
| **Backups / Models / etc.** | `Console` (button → command → text output) | ❌ |

The **Terminal tab's** xterm.js + WebSocket shell is the good one. Everything
else is a plain text console. We are extracting the xterm.js shell into a
**single reusable component** and using it everywhere a shell belongs, so the
terminal code is written once and never duplicated.

## What We Did

- Created **`src/client/src/components/Terminal.jsx`** — the full xterm.js +
  WebSocket interactive shell, extracted verbatim from the Terminal tab.
- **Terminal tab** now renders `<Terminal name={agent.name} title={agent.display_name} />`.
- **Health tab** now renders the same `<Terminal>` and its preset buttons feed
  commands into the shell via `termRef.runCommand(cmd)` (queued until connected).
- **Backend rewritten**: the interactive terminal now uses **dockerode** +
  the Docker Engine API (`exec` with `Tty: true`), replacing the hand-rolled
  `docker exec -i` + `script` + `\r`→`\n` hack. This gives a real PTY (Enter,
  arrows, raw-mode TUI apps all work) and working live resize.

## Decisions

- **dockerode** (`npm install dockerode` in `src/`) over ttyd-in-container:
  keeps everything in the webui container, reuses the already-mounted
  `/var/run/docker.sock`, no extra binaries in PAD images.
- Messaging tab's WS command runner still uses `docker exec` + `script` — it is a
  separate one-shot command feature, not an interactive shell. Revisit later if
  its interactive prompts ever misbehave.

## Component API

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | string | — | PAD/agent name used in the WebSocket URL (required) |
| `title` | string | `name` | Label shown in the header bar |
| `height` | string | `'70vh'` | Terminal area height (CSS value) |
| `minHeight` | string | `'480px'` | Minimum terminal area height |
| `disabled` | boolean | `false` | Lock the terminal from outside (declarative; see timing gotcha below) |
| `onCommandStart` | fn | — | Fired when an injected command starts (locked mode only) |
| `onCommandDone` | fn | — | Fired when an injected command finishes (locked mode only) |

### Imperative handle (via `ref`)

| Method | Returns | Description |
|--------|---------|-------------|
| `runCommand(cmd)` | `boolean` | Sends a command to the shell (`cmd` + newline). **Queued** until the WebSocket is open. Returns whether it was sent immediately. |
| `write(text)` | `boolean` | Raw write to shell stdin. Queued when disconnected. |
| `clear()` | — | Clears the visible scrollback. |
| `reconnect()` | — | Tears down the session and starts a fresh shell. |
| `focus()` | — | Focuses the terminal. |
| `isConnected()` | `boolean` | Current WebSocket state. |
| `setLocked(v)` | — | Lock/unlock the terminal imperatively (synchronous). |
| `lock()` | — | Lock the terminal (shorthand for `setLocked(true)`). |
| `unlock()` | — | Unlock the terminal (shorthand for `setLocked(false)`). |
| `isLocked()` | `boolean` | Current lock state (refs, so safe to read from an event handler). |

## Locked / Read-only Mode (operator-driven)

The terminal can be locked so the user cannot type — only commands injected via
`runCommand()` execute. While an injected command runs the user can type again
(to answer prompts), then the terminal **auto-locks** when the command finishes.

- In locked mode `runCommand()` appends a completion sentinel:
  `bash -c "<cmd>; echo; echo __PAD_DONE_<id>__"`. bash parses the whole line
  first, so the echoes run only after `<cmd>` exits; the empty `echo` keeps the
  sentinel on a fresh line.
- The output is scanned for `\n__PAD_DONE_<id>__` via a rolling 512-char tail,
  so a sentinel split across WS frames is still found, and the PTY-echoed copy
  of the injected line (sentinel mid-line after `echo `) can never false-trigger.
- Multiple injected commands queue: a marker Set is tracked; the terminal only
  re-locks when the last sentinel resolves.
- `onCommandStart` / `onCommandDone` fire around the run so the host can show a
  busy state.

> **Prop-change timing gotcha:** `disabled` reaches the lock via a React effect,
> so it is **not** visible if you call `runCommand()` in the same tick you set
> `disabled={true}` — the command runs unlocked (no sentinel). For operator
> flows that lock and inject in one handler, use the imperative API:
> `termRef.current?.lock(); termRef.current?.runCommand(cmd);`

(An earlier draft hid the injected line with `stty -echo` — dropped because the
echo change races with the next line's bytes. Sentinels stay visible; treat them
as "command finished" indicators.)

## Backend Contract (dockerode / Docker Engine API)

- **Endpoint:** `ws://<host>/ws/terminal/<name>?cols=<n>&rows=<n>`
- Backend uses **dockerode** against `/var/run/docker.sock`:
  `container.exec({ Tty: true, Cmd: ['bash', '-i'] })` → `exec.start({ hijack: true, ... })`.
  Docker allocates a **real PTY**.
- Client → server: raw keystroke bytes, plus JSON `{ type: 'resize', cols, rows }`.
- Server → client: raw PTY output (UTF-8 decoded via `StringDecoder`).
- **No `\r` → `\n` conversion** — the PTY line discipline handles CR/LF, so Enter works in
  canonical shells AND raw-mode TUI apps (opencode popups no longer hang).
- Resize uses the official `POST /exec/:id/resize` API — the old `docker exec stty` on a
  separate process never resized the real PTY.

## Backend Contract (OLD — replaced)

- The old `script -qfec ...` + `msg.replace(/\r/g, '\n')` approach is gone.
  The `\r`→`\n` mangling was the root cause of TUI apps hanging on Enter in popups.

## Robustness Checklist (component)

- [x] One `Terminal` source of truth, no duplicated xterm init (old code had the init duplicated between mount and reconnect).
- [x] Commands sent before the WebSocket opens are **queued and flushed** on `onopen`.
- [x] `setState` guarded against unmount (`mountedRef`).
- [x] Async init race guarded: a **generation token** invalidates stale in-flight init (e.g. reconnect during load, or unmount before the dynamic import resolves).
- [x] ResizeObserver re-fits AND sends a `{ type: 'resize', cols, rows }` message to the backend so the PTY tracks the pane.
- [x] Font size changes re-fit + re-send resize (old code updated `fontSize` but never told the backend).
- [x] Init failure renders an error line inside the terminal instead of silently dying.
- [x] `name` prop validated; missing name aborts init with a message.
- [x] Pending queue capped (avoids unbounded memory if the shell never connects).
- [x] Cleanup disposes xterm + closes WS + disconnects ResizeObserver.
- [x] Reconnect is idempotent (safe to call repeatedly).
- [x] Ctrl/Cmd+C with a selection copies instead of killing the shell (custom key handler).
- [x] Locked/read-only mode: keystrokes, paste, and Ctrl+C dropped while locked; `runCommand()`/`write()` bypass the lock; sentinel-based completion detection; auto re-lock; Locked/Running badges; cursor stops blinking when locked.
- [x] Fully documented JSDoc block on the component + this plan.

## Adoption Rules

- New pages that need a shell **must** import `Terminal` from
  `../components/Terminal` — never copy the xterm/WS logic.
- Pages that only need "run this command and show text output" (no interactivity,
  no shell persistence) may keep `Console` — it is the display-only sibling.
- If a page needs both preset buttons AND a live shell, follow the **Health tab
  pattern**: buttons call `termRef.current?.runCommand(cmd)`.

## Next Steps

- [ ] Verify Messaging tab still works (it keeps `Console`, untouched).
- [ ] Decide whether Messaging should adopt the interactive `Terminal` (creds panel would paste via `write()` instead of `credential-paste` WS message).
- [ ] Consider a shared `CommandButton`/`CommandGroups` component so Health-style button rows are also not duplicated.
- [ ] Rebuild SPA + browser-test Terminal tab, Health tab, and one Console page.
