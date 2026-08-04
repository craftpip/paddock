# Terminal — Unified Plan

All terminal-related work in one place: UI design, component, sessions, review, and migration.

> **Last updated:** 2026-08-05. The old per-topic plans (`terminal-component.md`,
> `terminal-sessions.md`, `terminal-first-ui.md`, `terminal-first-ui-WIP.md`,
> `terminal-component-review.md`) were deleted and folded into this one file.

---

## Status

| Area | Status |
|------|--------|
| Terminal component (`Terminal.jsx`) | **Done** — the one shell component; docked on every agent page |
| dockerode real-PTY backend (`/ws/terminal/:name`) | **Done** — real PTY, demux, resize API |
| tmux persistent sessions | **Done** — create/switch/kill dropdown, localStorage, lazy tmux install |
| Terminal-first UI (6 modes + docked terminal) | **Done** — Commands is the default landing mode |
| Command logging + history popover | **History button removed (2026-08-04)** — logging stays for the Activity tab |
| Code review fixes | **Done** — 9/9 fixed (see §Review Findings) |

---

## Core Concept

The agent page is a **terminal emulator with a GUI command picker**.

The terminal is the home. Mounted **once per agent** at the page level, stays alive the whole time you're on that agent's page. Docked at the bottom in every mode. The old 13 tabs collapsed to **6**: one **Commands** home (all terminal-driven tabs merged into grouped buttons) plus 5 GUI modes that genuinely need real GUIs (workspace, config, logs, sessions, activity).

GUI elements (tables, cards, lists) are for **displaying information**. For **entering things, setting things up, configuring** — the terminal flow takes over.

Click a button → the CLI command gets typed into the terminal and executed. The user sees every command, every output, every prompt. Interactive flows happen live in the terminal. The user can also type straight into the shell — it is a real bash session.

Every command run for this agent accumulates in that one terminal. **One terminal per agent, it remembers everything.**

### Implementation note on "always visible"

The dock is **always mounted** — switching modes never kills the shell or the scrollback. But outside Commands mode it **auto-collapses to its header bar** (a chevron re-expands it), and on Commands mode it takes the full remaining height. So "always visible" = always present and alive, not always expanded. There's also a drag handle to resize the dock on non-Commands modes, and a fullscreen overlay toggle.

### Scope

- **Phase 1**: OpenClaw
- **Phase 2**: Nanopot
- **Phase 3**: Hermes PAD

---

## Terminal Component

File: `src/client/src/components/Terminal.jsx`

Single reusable xterm.js + WebSocket interactive shell. One component, one page, one instance. Talks to persistent tmux sessions inside the PAD container.

### Props (current)

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `name` | string | — | PAD/agent name used in the WebSocket URL (required) |
| `title` | string | `name` | Label shown in the header bar |
| `height` | string | `'70vh'` | Terminal area height (CSS value); AgentDetail passes `'100%'` |
| `minHeight` | string | `'480px'` | Minimum terminal area height |
| `disabled` | boolean | `false` | Lock input from outside. Injected commands still run |
| `collapsed` | boolean | `false` | Hide the body; only the header shows. Session stays alive |
| `showCollapse` | boolean | `true` | Show the collapse chevron (needs `onToggleCollapse`) |
| `onToggleCollapse` | fn | — | Fired when the chevron is clicked |
| `onCommandStart` | fn | — | Fired when a tracked/locked injected command starts |
| `onCommandDone` | fn | — | Fired with the command string when it finishes |
| `onConnChange` | fn | — | Called with `true`/`false` as the terminal WS connects/disconnects; AgentDetail uses it to disable command buttons until ready |
| `className` | string | `''` | Extra classes on the wrapper |

### Imperative handle (via `ref`)

| Method | Returns | Description |
|--------|---------|-------------|
| `runCommand(cmd, {track})` | `boolean` | Sends a command + newline. With `{track:true}` (or when locked) appends a completion sentinel and fires `onCommandStart`/`onCommandDone` — does **not** lock input in track mode. **No queue** — returns `false` if the WS isn't open (command buttons are disabled until it is) |
| `pasteSecret(value)` | `boolean` | Raw write + newline. **Echo suppression is the caller's job** (`stty -echo; <cmd>; stty echo` wrapper) — the component does not touch the buffer |
| `write(text)` | `boolean` | Raw write to shell stdin. **No queue** — drops and returns `false` when disconnected |
| `clear()` | — | Sends `clear` to the shell (like typing it) — clears the pane screen, survives refresh |
| `reconnect()` | — | Confirms, then tears down and starts a fresh shell. Scrollback is preserved (tmux) |
| `focus()` | — | Focuses the terminal |
| `isConnected()` | `boolean` | Current WebSocket state |
| `setLocked(v)` / `lock()` / `unlock()` | — | Imperative lock control (independent of `disabled` prop) |
| `isLocked()` | `boolean` | Current lock state (refs, safe from event handlers) |

### Implemented (was "Changes Needed")

1. **Tracked `runCommand(cmd, {track: true})`** — appends a completion sentinel (`__PAD_DONE_<id>__`), fires `onCommandStart`/`onCommandDone`, shows the "Running" indicator, does not lock input. ✓
2. **`pasteSecret(value)`** — raw paste; secret flow redesigned (see review #2). ✓
3. **Lock toggle** — persisted per agent via `localStorage['pad-term-lock-<name>']`, restored on mount. **Note: there is no visible Lock button in the header** — locking is imperative only (or via the `disabled` prop). The plan's header `[lock]` button was never built.
4. ~~**History button**~~ — clock icon → popover of past commands. **Removed 2026-08-04** (review #7): redundant with shell history + Activity tab. `POST /command-log` recording stays.

### Backend Contract (current — tmux attach, not `bash -i`)

- **Endpoint:** `ws://<host>/ws/terminal/<name>?session=<id>&cols=<n>&rows=<n>` (`session` optional → `main`)
- **Auth is enforced** (review #1 fixed): the handler resolves the session cookie (`getSessionFromCookie`) and does an admin/owner check **before** any Docker inspection or exec. Skipped only when `AUTO_LOGIN=true`.
- Backend uses **dockerode** against `/var/run/docker.sock`:
  1. `ensureTmuxSession(vmName, session, cols, rows)` — lazy tmux install on old images, create session if missing, hook colored PS1 into `/root/.bashrc`.
  2. `container.exec({ Tty: true, Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'], Cmd: ['tmux', 'attach-session', '-t', <id>] })` → `exec.start({ hijack: true })`. Docker allocates a **real PTY**.
- Client → server: raw keystroke bytes, plus JSON `{ type: 'resize', cols, rows }`.
- Server → client: raw PTY output, **demuxed** (`dockerClient.modem.demuxStream`) and UTF-8 decoded via `StringDecoder` (the 8-byte multiplex headers otherwise leak as stray chars).
- **No `\r` → `\n` conversion** — PTY line discipline handles CR/LF.
- Sessions API: `GET/DELETE /api/agents/:name/terminal-sessions[/:id]`.
- Command log: `POST /api/agents/:name/command-log` `{ cmd, status, ts }`.

---

## Persistent Sessions (tmux) — IMPLEMENTED

### How it works now

- Each terminal session = one **tmux session** inside the PAD container. The WS handler only attaches; closing the WebSocket kills the attach client, not the session. Reloads and tab switches reattach and replay the pane history.
- Sessions live in the PAD container, survive **webui restarts**. Die when the PAD is stopped/restarted (dropdown degrades to `main`).
- **Lazy install**: tmux is in the base Dockerfile (`src/vm-builds/openclaw/Dockerfile`) AND installed on demand for older images (`apt-get install -y tmux`), cached in a `tmuxReady` set per PAD.
- **Colored PS1** is appended to `/root/.bashrc` (idempotent) at first session setup.
- **history-limit** is set to 10000 (`TMUX_HISTORY`) at every session setup, so the pane history matches xterm's 10000-line scrollback.
- **Scrollback survives refresh:** a fresh WS connection runs `tmux capture-pane -t <session> -p -e -S -10000` and replays the pane history into the new xterm before attaching (`LF` → `CRLF` so restored lines land at column 0). Committed `9acacbd`.
- **Single-client policy:** one attached tmux client per session (`activeTerminals` map) — the newest connection kicks older ones with close code 4001 and sweeps orphaned `tmux attach-session` processes, so multi-client full-redraws never destroy xterm's scrollback.

### Gotchas solved along the way

- **Unicode glyphs:** without `LANG=C.UTF-8` tmux substitutes every non-ASCII glyph (● ◆ ↑/↓ •) with `_`. Set in the exec `Env`.
- **Alternate screen:** tmux attach switches to the alternate screen, which has no scrollback. Fix: `set -ga terminal-overrides ',xterm-256color:smcup@:rmcup@'` written to `/root/.tmux.conf` (idempotent), so output lands on the normal screen and accumulates.
- **tmux 3.3a `-F` quirk:** `#{session_created}` with `\t` separators converts tabs to `_`. `list-sessions` uses `-F '#{session_name}|#{session_attached}|#{session_created}'`.
- **Create-then-attach is TOCTOU-prone:** if `new-session` fails with "duplicate session", fall through and attach anyway.

### UI — header dropdown

- Trigger shows the **current session name** (default `main`).
- Items: all active sessions (current highlighted), "+ New session" (next free `term-N`), per-item close (confirm → `tmux kill-session`, falls back to the previous session or `main`).
- Selecting a session = teardown + reconnect to that session id.
- Selection persisted in `localStorage` as `pad-term-session-<agent>`.
- Session names validated against `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` (frontend `SAFE_SESSION_RE` + backend `safeSessionName`).

---

## Layout & Design — IMPLEMENTED

### The 6 modes (AgentDetail `MODES` array)

| Mode | Content |
|------|---------|
| **Commands** (default) | Command pill flow + Run TUI + Vault dropdown |
| Workspace | File browser + editor modal |
| Config | JSON editor (openclaw.json) |
| Logs | Streamed viewer with tail select + auto-scroll |
| Sessions | Session table |
| Activity | Activity timeline |

The old Terminal tab is the dock itself; Health/Messaging/Models/MCP/Skills/Backups/Overview/Config-commands all merged into Commands. Workspace/Config/Logs/Sessions/Activity stay as GUI modes.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ ← Fleet  W Work-pls · running · CPU/MEM  [Stop][Restart]  │  ← agent header
├──────────────────────────────────────────────────────────┤
│ [Openclaw] [Workspace] [Config] [Logs] [Sessions] [Activity] │  ← mode tabs
├──────────────────────────────────────────────────────────┤
│  Commands mode:  [Run TUI]  [Filter commands…]           │
│   MESSAGING · Configure channel · List channels · ...     │
│   MODELS    · Configure models · Logout profile · ... ★ ★ │
│   MCP       · List · Status · ...  [server chips]         │
│   SKILLS    · Search · Update all · Install               │
│   MEMORY / CONFIG / OTHER / SECURITY / DOCTOR / DIAG...   │
│   ...one continuous wrapped flow of pills...         [VAULT] │
├──────────────────────────────────────────────────────────┤
│  TERMINAL DOCK (drag-resize handle above on other modes)  │
│  $ openclaw status --json                                 │
└──────────────────────────────────────────────────────────┘
```

- Right area is a **flex column**: mode content on top (scrolls), terminal docked at bottom.
- **Commands is the default landing mode** — no hash, or unknown hash → `commands`.
- Switching modes does **not** unmount the terminal; on non-Commands modes the dock auto-collapses to its header (session stays alive) and a drag handle resizes it.
- Fullscreen overlay button in the header covers the viewport (`fixed inset-0`); exiting is via the header button (Escape handling inside TUI apps is review #5 — done, it was a misunderstanding, see below).

### Terminal States

| State | What the user sees | Can they type? |
|-------|--------------------|----------------|
| **Interactive** (default) | Live bash session. Buttons inject commands, user can type too | Yes |
| **Locked** (imperative / `disabled` prop / persisted localStorage) | Frozen shell. Buttons still inject commands; input drops | No — buttons only |
| **Running** (tracked command) | "Running" pulse. If CLI prompts, terminal unfreezes | Yes — stdin of running command |

### Command Flow (CommandsPane.jsx) — actual implementation

The plan's per-group "cards with colored dots + labels" was replaced by a **single wrapped flow**: every group's pills sit inline on one float-left line, group labels are small chips, data (primary/fallback model, MCP servers, skills) shows as neutral chips, and a search box filters all pills. Buttons are hardcoded in `CommandsPane.jsx` — not a config file.

- **Run TUI** — runs bare `openclaw` in the terminal.
- **Prompt modal** (`usePrompt`) — for buttons that need an argument (logout profile id, set model, MCP tools, skill search, etc.). Input + hint text, confirm, then the command is injected.
- **Vault dropdown** — right-aligned. Lists vault item names (`/api/vault`); on click fetches the decrypted value (`/api/vault/:id/decrypt`) and `term.write()`s it into the terminal **without a newline** — the user presses Enter. Add-item form at the bottom. No echo, no logging (review #2).
- Pill properties still used: `cmd`, `label`, `desc`, `confirm`, `danger`, plus dynamic `click()` handlers.

---

## Command Definitions (current)

Source of truth: `src/client/src/pages/agent/CommandsPane.jsx`. Groups and commands as of 2026-08-04:

| Group | Buttons |
|-------|---------|
| Messaging | Configure channel (`openclaw configure --section channels`), List channels, Status probe, Capabilities, Channel logs, Routing (`openclaw agents bindings`) |
| Models | Configure models (`openclaw configure --section model`), Logout profile (prompt), Auth profiles (`models auth list`), Available models (`models list`), Model status, Set default model (prompt) |
| MCP | List, Status, Doctor, Probe, Reload, Tools (prompt) |
| Skills | Search (prompt), Update all, Install (inline form via `/api/agents/:name/skills/install`) |
| Memory | Status (`memory status`), Promote (`memory promote --apply`) |
| Config | Validate, File path, Model config, Schema |
| Other | Backup, Check updates (`openclaw update status`), MCP Doctor |
| Security | Audit, Audit (deep), Audit & Fix |
| Doctor | Doctor, Fix, Lint, Deep, SQLite Compact (danger) |
| Diagnostics | Status, Gateway status |

Earlier per-topic command tables (messaging/models/mcp/skills/config/memory/backup) drifted from the running app and were dropped — the pill buttons above are what actually ships.

---

## Review Findings — status per item

From the deleted `plans/terminal-component-review.md`. Status verified 2026-08-04 (code + live browser).

### 1. WebSocket terminal authentication bypass (Critical) — ✅ FIXED

`requireAuth` only covered HTTP; WS upgrades went straight to Docker exec.

**Fix (committed `01399e7`, `src/app.js`):** the WS handler now resolves the session cookie via `getSessionFromCookie` and requires a valid authenticated session **before** `dockerPsList` / any container inspection. Non-admin users must own the PAD (`agents.owner_id === session.userId`). Skipped only when `AUTO_LOGIN=true`. Verified live: anonymous WS gets `ws.close(1008)`; a logged-in admin connects fine.

### 2. Timed vault-secret paste is racy (High) — ✅ FIXED

**Vault flow:** the Vault dropdown decrypts **on click** and `write()`s the value with **no trailing newline** — the user presses Enter when the prompt is ready. Nothing is echoed or logged.

**Old path removed (2026-08-04):** the leftover `opts.secret` branch in `AgentDetail.run()` (`stty -echo` wrapper + `setTimeout(..., 500)` + `pasteSecret()`) was from the pre-Vault credentials system and no button used it. Deleted — `run()` no longer accepts `secret`, and `pasteSecret()` was dropped from the Terminal imperative API. Secrets paste exclusively through the Vault dropdown (`write()`).

### 3. Pending input can be delivered to a different PAD (Medium) — ✅ FIXED

**Original problem:** `sendToShell()` queued writes into `pendingRef` while disconnected, and `teardown()` never cleared it. Because `/agents/:agentId` reuses the same `AgentDetail` + `<Terminal>` instance across PAD switches (only the `name` prop changes), queued input survived the teardown and flushed into the **new** PAD's shell on the next `onopen`.

**Fix (2026-08-04, design decision):** the queue is **gone**. `sendToShell()` now drops writes while disconnected instead of buffering them. The terminal reports readiness via a new `onConnChange` prop, and AgentDetail gates every command button on it — Run TUI, all command pills, and the Vault dropdown are disabled until the WebSocket is open, so nothing can be injected while the shell is unreachable. With no queue there is nothing to leak across PAD switches; `run()` also no-ops while disconnected as a safety net.

**Verified live:** connected PAD → all buttons enabled; stopped PAD (terminal disconnected) → all pills + Run TUI + Vault disabled.

### 4. Wheel scrolling can become arrow-key input (Medium) — ✅ FIXED

**Fix (2026-08-05):** `attachCustomWheelEventHandler` in `Terminal.jsx`. In alternate-screen (TUI) mode there is no xterm scrollback to scroll, so the handler swallows the event (`preventDefault` + `stopPropagation`, return `false`) — xterm never emits the `^[[A`/`^[[B` arrow-key alternate-scroll. In normal mode it returns `true` so xterm's viewport scrolls the scrollback natively. Apps that enable mouse reporting never reach the handler: xterm feeds them real wheel events and they scroll themselves.

### 5. Escape not working inside TUI apps (e.g. opencode menus) (Medium) — ✅ DONE

> **Framing corrected 2026-08-04:** the original review — "Escape cannot reliably exit fullscreen" — was a **misunderstanding**. The real complaint was: inside a TUI app (e.g. opencode) running in the terminal, pressing Escape didn't close menus. It had nothing to do with the frontend fullscreen overlay.

**Diagnosed live (2026-08-04):** a single Escape with the xterm textarea focused **does** reach the shell reliably through the full path (xterm `onData` → WS → backend dockerode PTY → tmux → pane) — a byte-level test printed `GOT:1b`. So byte delivery is not the problem. The remaining candidate was tmux `escape-time` (default **500ms**, still set), the classic source of Escape *latency/merging* inside TUIs.

**Status: ✅ DONE (no code change).** The user reports the TUI Escape problem now works — likely resolved previously, or a stale opencode/tmux session was eating input (a fresh `opencode` session registers keys fine; opencode has known tmux input-glitch issues). If Escape lag / Escape+key merging ever resurfaces inside TUIs, the fix is `set -s escape-time 10` in the PAD's `~/.tmux.conf`.

### 6. Clear button didn't clear the shell (Low) — ✅ FIXED

**Original issue:** the header Clear button called `termRef.current?.clear()` — xterm's built-in `clear()`, which only clears the browser's display client-side. The shell/tmux pane was never touched, so the old content reappeared on refresh.

**Fix (2026-08-04):** the Clear button now calls the imperative handle (`ref.current?.clear()`), which runs `sendToShell('clear\n')` — exactly as if the user typed `clear` + Enter. The tmux pane really clears and the clear survives refresh. No backend change needed; `src/app.js` was left at its original state.

**Verified live:** filled terminal with `seq` output → clicked Clear → tmux `capture-pane` shows the shell cleared, stays cleared after reload.

### 7. Command-history button is redundant (Low) — ✅ REMOVED

The clock button + popover in the terminal header has been **removed** (2026-08-04). It was redundant with shell history and the Activity tab, and the user confirmed it served no function. The `POST /command-log` recording stays — it powers the Activity tab.

### 8. Client/server multiplex control frames with raw bytes (Low) — ✅ FIXED

Backend used to run `JSON.parse()` on **every** client frame and fell through to `dockerStream.write(data)`. A pasted value that happened to look like `{ "type": "resize", ... }` was swallowed as a resize frame (single paste = single WS message, so the whole document vanished instead of reaching the shell).

**Fix (2026-08-04):** control frames are now framed with an unambiguous double-NUL prefix:
- Client `pushResize` sends `'\x00\x00' + JSON.stringify({type:'resize',cols,rows})`.
- Server checks `msg.charCodeAt(0) === 0 && msg.charCodeAt(1) === 0`; only then does it parse JSON (`msg.slice(2)`) and resize. Everything else goes to the shell as raw bytes — no `JSON.parse` on keystrokes at all.

Why NUL-NUL and not `\x1b[50;` (the original suggestion): an ESC-prefixed marker can appear at the start of pasted terminal output; a single `\x00` can arrive from Ctrl+Space, so it must keep passing through. Two leading NULs cannot be typed or pasted by a browser, so the marker never collides.

**Verified live (pad-openclaw-work-pls):** pasted `{"type":"resize","cols":120,"rows":40}` into the terminal → it appeared in the shell and bash reported `type:resize: command not found` (bytes reached the shell — previously this was silently eaten). Then A+ font change fired a resize frame with no backend errors, and a normal `echo` round-tripped fine.

### 9. Documentation drift (Low) — ✅ FIXED

- The plan files were consolidated into this single `plans/10-terminal.md` — good.
- **2026-08-05:** `src/docs/terminal.md` rewritten to match the tmux era: tmux attach + persistent sessions, auth, demux, single-client policy, scrollback replay (LF→CRLF), dock layout, sessions dropdown, NUL-NUL control frames.
- **2026-08-05:** `Terminal.jsx` header comment now points at `plans/10-terminal.md` + `src/docs/terminal.md` (was the deleted `plans/terminal-component.md`).

### Suggested Fix Order (next)

1. ~~Wheel policy (review #4)~~ ✅ done 2026-08-05
2. ~~Rewrite `src/docs/terminal.md` + fix `Terminal.jsx` header comment~~ ✅ done 2026-08-05
3. ~~Bump tmux history-limit to 10000~~ ✅ done (`TMUX_HISTORY`)
4. *(If TUI Escape lag resurfaces)* `set -s escape-time 10` in PAD `~/.tmux.conf`
5. ~~tmux attach-client leak~~ ✅ done 2026-08-05 (`sweepStaleAttaches` on connect + close kills orphaned attach clients)
6. ~~Scrollback survives refresh~~ ✅ done 2026-08-05 (`capture-pane` replay on fresh connection + LF→CRLF conversion; committed `9acacbd`)

---

## Backend Changes

- **Done:** `/ws/terminal/:name` with dockerode PTY + tmux attach, WS auth, sessions API (`GET/DELETE /api/agents/:name/terminal-sessions[/:id]`), command log (`POST /api/agents/:name/command-log`), NUL-NUL-framed JSON control frames (review #8).
- **Retired:** `/ws/messaging/:name` + `credential-paste`, `/ws/exec/:name`, and `/api/agents/:name/exec-stream` are all gone — the WS handler now handles only `wsType === 'terminal'`. Everything shell-related uses the shared terminal.
- Legacy `views/terminal.ejs` / `views/agents/terminal.ejs` are dead files (SPA owns the terminal) — leave them or delete, no work needed.

---

## Migration Checklist

- [x] `Terminal.jsx` extracted as the one shell component
- [x] Backend rewritten to dockerode PTY (real PTY + demux + resize API)
- [x] `AgentDetail.jsx` restructured: header + 6 mode tabs + docked `<Terminal>`
- [x] Tracked `runCommand(cmd, { track: true })`
- [x] `pasteSecret()` on the terminal (vault flow uses `write()` instead)
- [x] Lock toggle persisted per agent (`pad-term-lock-<name>`) — imperative only, no header button yet
- [x] `CommandsPane` — one wrapped pill flow + search + Run TUI + Vault dropdown
- [x] Agent header: name, status, CPU/MEM, start/stop/restart
- [x] Workspace / Config / Logs / Sessions / Activity moved into modes
- [x] tmux persistent sessions (dropdown, create/switch/kill, localStorage, lazy install)
- [x] History popover + `POST command-log` recording
- [x] WS terminal authentication (admin/owner) — review #1
- [x] Dormant `opts.secret` timer removed from `run()`; `pasteSecret()` dropped — review #2
- [x] Review #5: Escape inside TUI apps — resolved, no code change (was misread as fullscreen-exit)
- [x] Review #3: no write queue + command buttons disabled until terminal connects
- [x] Review #4: wheel policy (`attachCustomWheelEventHandler`, 2026-08-05)
- [x] Review #7: history button removed (logging stays for the Activity tab)
- [x] Review #6: Clear button now sends `clear` to the shell (button was calling xterm's client-side `clear()`, leaving the real pane untouched)
- [x] Review #8: NUL-NUL-framed JSON control frames — no JSON.parse on raw keystrokes, pasted resize-shaped JSON reaches the shell
- [x] Review #9: rewrite `src/docs/terminal.md` + fix `Terminal.jsx` header comment (2026-08-05)
- [x] tmux attach-client leak on WS disconnect (`sweepStaleAttaches`, 2026-08-05) — see Suggested Fix Order
- [ ] Header lock button (optional)
- [ ] Browser-test: mode switching keeps terminal session + scrollback; session dropdown reflects `main`

---

## Rules

- **One terminal per agent.** Mounts once, lives at the page level, never unmounted while the agent page is open.
- **The terminal dock is always mounted** — on every mode. It auto-collapses outside Commands but never dies.
- **Commands is the default landing mode**, including right after agent creation.
- Command definitions are hardcoded per-group in `CommandsPane.jsx` — not a config file.
- The user can free-type. Buttons are shortcuts, not the only input path.
- Only one **tracked** command runs at a time. Free typing is unaffected.
- Command history is logged — exact CLI command + exit status (Activity tab).
- **Secrets never hit the buffer or the log** — vault values are `write()`n without a newline; no echo, no timer, not logged.
- Terminal prompt style: simple `$` is fine.
- Multi-command flows run sequentially in the same terminal.

---

## Open Questions

- **Header lock button** — build a visible Lock/Unlock toggle (the plan's `[lock]` header control) or keep lock imperative-only?
- **Command log retention** — cap the log (e.g. last 100 entries per agent)?
- **bash_history capture** — wire the user's typed commands into the history popover?
- ~~**tmux history-limit**~~ — resolved: bumped to 10000 (`TMUX_HISTORY`), matches xterm scrollback.

---

## Environment Facts

- App webui container: **`paddock`**, listens on **port 6789**. Docker maps host `6789` and `5173` (vite).
- Host IP for browser MCP: `http://10.69.1.164:6789` (login: `admin` / `admin`).
- Vite dev server: `docker exec -d paddock sh -c 'cd /app/client && npm run dev'` → `http://10.69.1.164:5173`
- Test PADs: `pad-openclaw-work-pls` (running), `pad-picoclaw-picapica`.
- Backend is bind-mounted (`src` → `/app`), so `docker restart paddock` applies JS changes; the SPA needs `npm run build` (or vite HMR on 5173).

---

## Codebase Map

- `src/app.js` — Express + all `/api/*` + WebSocket server (port 6789); terminal WS handler + `ensureTmuxSession`/`safeSessionName` + sessions/command-log routes
- `src/client/src/components/Terminal.jsx` — the one shell component (~890 lines)
- `src/client/src/components/Console.jsx` — display-only sibling (read-only surfaces)
- `src/client/src/pages/AgentDetail.jsx` — 6-mode layout + docked terminal + `run()` (tracked commands)
- `src/client/src/pages/agent/CommandsPane.jsx` — the command pill flow + prompt modal + Vault dropdown
- `src/client/src/lib/prompt.js` / `toast.jsx` / `api.js` — shared UI plumbing
- `src/services/vault.js` — encrypted Vault (replaces the removed `creds.js`)
- `src/services/agent-registry.js` — PAD discovery + `logActivity()` + `getActivity()`
- `src/services/db.js` — SQLite metadata store (agents, activity, command logs, sessions)
- `src/services/cmd.js` — `runCmd` helper
- `src/vm-builds/openclaw/Dockerfile` — base image + tmux
- `src/docs/terminal.md` — **stale, needs rewrite** (review #9)
