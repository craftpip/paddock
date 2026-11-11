import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'
import { useConfirm } from '../lib/confirm'
import { getCsrfToken } from '../lib/api'
import Button from './ui/Button'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Terminal — the app's one-and-only interactive shell component.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A self-contained xterm.js terminal that talks to the backend over a WebSocket
 * at `/ws/terminal/:name`. The backend spawns an interactive bash session inside
 * the PAD container, so everything typed here runs live in that container.
 *
 * This is the SINGLE source of truth for interactive shells in the app. If you
 * need a shell somewhere, import this component. Do NOT copy the xterm/WebSocket
 * setup anywhere else (see `docs/tabs/terminal.md`).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Props
 * ─────────────────────────────────────────────────────────────────────────────
 *  | Prop             | Type     | Default  | Description                            |
 *  |------------------|----------|----------|----------------------------------------|
 *  | `name`           | string   | (none)   | PAD/agent name used in the WebSocket URL. REQUIRED. |
 *  | `title`          | string   | `name`   | Label shown in the header bar.          |
 *  | `height`         | string   | `'70vh'` | CSS height of the terminal area.        |
 *  | `minHeight`      | string   | `'480px'`| CSS min-height of the terminal area.    |
 *  | `collapsed`      | boolean  | `false`  | Hide the terminal body; only the header bar shows. The session stays alive. |
 *  | `onToggleCollapse`| fn      | (none)   | Fired when the collapse/expand chevron is clicked. |
 *  | `showCollapse`   | boolean  | `true`   | Show the collapse/expand chevron (ignored without `onToggleCollapse`). |
 *  | `running`        | boolean  | `true`   | Whether the agent is running. When false the terminal disconnects and stops auto-retrying (backend also closes with 4002); when it flips to true it reconnects automatically. |
 *  | `disabled`       | boolean  | `false`  | Lock the terminal: the user cannot type their own commands. Only `runCommand()`-injected commands run. During an injected command the user can type again; when it finishes, it auto-locks. |
 *  | `onCommandStart` | fn       | (none)   | Fired when a tracked/locked injected command starts. |
 *  | `onCommandDone`  | fn       | (none)   | Fired with the command string when a tracked/locked injected command finishes. |
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Imperative API (via `ref`)
 * ─────────────────────────────────────────────────────────────────────────────
 *  <Terminal ref={termRef} name={agent.name} />
 *
 *  | Method           | Returns  | Description                                 |
 *  |------------------|----------|---------------------------------------------|
 *  | `runCommand(cmd, {track})` | boolean | Sends `cmd` to the shell (newline appended). With `{track:true}` (or when locked) it appends a completion sentinel, fires onCommandStart/onCommandDone, and shows the "Running" indicator without locking input. No queue — returns `false` when the WS isn't open. |
 *  | `write(text)`    | boolean  | Raw write to shell stdin. No queue — drops and returns `false` when disconnected. |
 *  | `clear()`        | —        | Runs `clear` in the shell (clears the visible screen). |
 *  | `reconnect()`    | —        | Confirms, then tears down and starts a fresh shell session. |
 *  | `focus()`        | —        | Focuses the terminal.                        |
 *  | `isConnected()`  | boolean  | True when the backend PTY is ready and the WebSocket is open. |
 *  | `isBusy()`       | boolean  | True when a command appears to be running (prompt heuristic + tracked injected commands). |
 *  | `setLocked(v)`   | —        | Lock/unlock input imperatively (independent of the `disabled` prop). |
 *  | `lock()`         | —        | Shorthand for `setLocked(true)`.             |
 *  | `unlock()`       | —        | Shorthand for `setLocked(false)`.            |
 *  | `isLocked()`     | boolean  | True when the user cannot currently type.    |
 *
 *  Locked-mode example (operator drives, viewer watches):
 *     <Terminal ref={termRef} name={agent.name} disabled
 *              onCommandStart={() => setBusy(true)}
 *              onCommandDone={() => setBusy(false)} />
 *     <button onClick={() => termRef.current?.runCommand('git pull')}>
 *
 *  Tracked-mode example (operator drives, terminal just runs + reports):
 *     <Terminal ref={termRef} name={agent.name}
 *              onCommandDone={(cmd) => console.log('done:', cmd)} />
 *     <button onClick={() => termRef.current?.runCommand('openclaw health', {track:true})}>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Backend contract (see src/app.js — "Terminal WebSocket", and
 *  docs/tabs/terminal.md for the full write-up)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Connect:  ws://<host>/ws/terminal/<name>?session=<id>&cols=<n>&rows=<n>
 *  - Each session is a persistent **tmux session** inside the PAD container.
 *    The backend creates it on first connect, then attaches. Closing the WS
 *    detaches (state + scrollback survive); reloads and tab switches reattach.
 *  - The backend uses dockerode (`Tty: true`) so Docker allocates a REAL PTY:
 *      container.exec({ Tty: true, Env: ['TERM=xterm-256color'],
 *                       Cmd: ['tmux', 'attach-session', '-t', <id>] })
 *      → exec.start({ hijack: true, ... })
 *  - Client → server: raw keystroke bytes, plus NUL-NUL-prefixed JSON control
 *    frames (the prefix can't be typed or pasted, so it never collides with
 *    shell input — the backend only parses JSON after the prefix):
 *      \x00\x00{ type: 'resize', cols: <n>, rows: <n> }  →  exec.resize({ h, w })
 *  - Server → client: raw PTY output (StringDecoder-decoded) rendered verbatim
 *    by xterm. No `\r` → `\n` conversion — the PTY line discipline handles CR/LF.
 *
 * ─────────────────────────────────────────────────────────────────────────────
  *  Sessions (header tab strip next to the connection dot)
  * ─────────────────────────────────────────────────────────────────────────────
  *  - The tab strip lists the PAD's active tmux sessions (GET
  *    /api/agents/:name/terminal-sessions) and lets you switch (click a tab),
  *    create (`+` → next free `term-N`), or close (`×` on hover, DELETE) a session.
  *  - The selected session is persisted in localStorage
  *    (`pad-term-session-<name>`), so a page reload returns to the same session.
  *  - Closing the current session falls back to `main` (auto-created on demand).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Tracked/locked mode: how "command is done" is detected
 * ─────────────────────────────────────────────────────────────────────────────
 *  A PTY has no reliable "command finished" signal, so `runCommand()` with
 *  `{track:true}` (or in locked mode) appends a unique sentinel to the line:
 *      <cmd>; echo; echo __PAD_DONE_<id>__
 *  - bash parses the whole line first, so the `echo`s run only AFTER `<cmd>`
 *    finishes (and are never fed to an interactive app's stdin).
 *  - The empty `echo` prints a newline, guaranteeing the sentinel starts on a
 *    fresh line even when `<cmd>` output ends without a trailing newline.
 *  - The output stream is scanned for `\n__PAD_DONE_<id>__` (sentinel at the
 *    START of a line) via a rolling tail, so a sentinel split across WebSocket
 *    frames is still found. The PTY echoes the injected line too, but there
 *    the sentinel sits mid-line after `echo `, so it can never false-trigger.
 *  - When the sentinel appears, the command is over and onCommandDone fires.
 *  - Multiple injected commands queue: a sentinel set is tracked, and
 *    onCommandDone fires only when the last sentinel resolves.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Lifecycle & robustness
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Mount: dynamically imports xterm + fit addon, creates the terminal,
 *    opens the WebSocket, attaches a ResizeObserver.
 *  - `name` change: full teardown + fresh session.
 *  - Unmount: WebSocket closed, xterm disposed, ResizeObserver disconnected,
 *    all refs cleared. No setState after unmount.
 *  - Reconnect: confirms first; safe to call repeatedly; stale in-flight init
 *    is invalidated by a generation counter, so a reconnect during a slow
 *    import can never double-mount a terminal.
 *  - Stopped agent: when the backend closes with code 4002 (agent not
 *    running) — or the `running` prop turns false — auto-retry stops. When
 *    `running` flips back to true the terminal reconnects automatically, so a
 *    stopped PAD never produces an endless retry loop.
 *  - Resize: after `fit()` and after font-size changes a NUL-NUL-prefixed
 *    `{type:'resize'}` frame is sent so the container PTY matches the pane.
 *  - Wheel policy: the wheel only scrolls local scrollback. In alternate-screen
 *    (TUI) mode xterm's arrow-key alternate scroll is suppressed so the wheel
 *    never types ^[[A/^[[B into apps; apps with mouse reporting still get real
 *    wheel events and scroll themselves.
 *  - No pre-attach write queue: command buttons are disabled until the PTY is ready (the
 *    parent is told via `onConnChange`), and writes attempted before readiness or while disconnected
 *    are dropped, never buffered.
 *  - Init failures (bad `name`, xterm load error) render a visible error inside
 *    the terminal area instead of failing silently.
 *  - Ctrl/Cmd+C with a selection is left to the browser (copy) rather than
 *    killing the shell. In locked mode Ctrl+C is dropped entirely (user cannot
 *    interrupt injected commands). The `scrollback` is 10000 lines.
 *  - Fullscreen: the header's expand button overlays the terminal across the
 *    whole viewport (`fixed inset-0`). The ResizeObserver re-fits the PTY on
 *    toggle. Escape (or the header button) exits. The collapse button is
 *    hidden while fullscreen since collapsing a fullscreen pane is meaningless.
 */
const Terminal = forwardRef(function Terminal(
  { name, title, height = '70vh', minHeight = '480px', disabled = false, collapsed = false, showCollapse = true, onToggleCollapse, onCommandStart, onCommandDone, onConnChange, className = '', running = true, sessionId: controlledSessionId = '', showSessions = true, bordered = true },
  ref
) {
  const containerRef = useRef(null)
  const termRef = useRef(null) // current xterm.js instance
  const fitAddonRef = useRef(null) // current FitAddon instance
  const wsRef = useRef(null) // current WebSocket
  const readyRef = useRef(false) // backend PTY attached, not just transport open
  const roRef = useRef(null) // current ResizeObserver
  const genRef = useRef(0) // generation token for async init
  const mountedRef = useRef(true) // guards setState after unmount

  // Auto-reconnect: when the connection drops (e.g. the PAD is restarted or
  // started from stopped), retry with a backoff until it comes back.
  const reconnectTimerRef = useRef(null)
  const retryDelayRef = useRef(2000)
  const wasConnectedRef = useRef(false) // only announce the first close after a connected state

  const disabledRef = useRef(!!disabled) // external lock (the `disabled` prop)
  const collapsedRef = useRef(!!collapsed) // collapse state for async closures (ResizeObserver, effects)
  const manualLockRef = useRef(false) // imperative lock()/unlock()/Lock toggle
  const runningRef = useRef(!!running) // the agent is running → auto-reconnect allowed
  const wasRunningRef = useRef(!!running) // previous `running` value, for edge detection
  const takeoverRef = useRef(false) // 4001 superseded → reconnect is manual-only
  // Set for one connect when the page swapped which session is open: the buffer
  // is already on screen, so the server's scrollback replay is redundant and
  // slow. Read (and cleared) where the WebSocket URL is built.
  const skipHistoryRef = useRef(false)
  const initInFlightRef = useRef(false) // an async initTerminal() is mid-flight
  const cmdRunningRef = useRef(false) // an injected command is in flight
  const shellBusyRef = useRef(false) // prompt-based: the shell is occupied by a command
  const shellBusyShowRef = useRef(false) // what the Running badge actually shows (delayed)
  const busySinceRef = useRef(null) // timestamp when the shell first looked busy
  const pendingCmdsRef = useRef([]) // commands queued while the shell was busy
  const lastSendRef = useRef(0) // timestamp of the last command sent to the shell
  const pendingMarkersRef = useRef(new Set()) // sentinels awaiting their echo
  const markerCmdRef = useRef(new Map()) // sentinel → command text
  const lastDoneCmdRef = useRef(null) // cmd of the last resolved sentinel
  const outputTailRef = useRef('') // rolling output tail for sentinel detection
  const markerSeqRef = useRef(0)
  const confirm = useConfirm()

  const [connState, setConnState] = useState('connecting') // connecting | connected | disconnected
  const [fontSize, setFontSize] = useState(14)
  const [initError, setInitError] = useState('')
  const [cmdRunning, setCmdRunning] = useState(false)
  const [shellBusy, setShellBusy] = useState(false)
  const [uiLocked, setUiLocked] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [sessionTitles, setSessionTitles] = useState({}) // last reported title per tmux session
  useEffect(() => { setSessionTitles({}) }, [name])

  // ── Sessions (persistent tmux shells per PAD) ────────────────────────────
  const SAFE_SESSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
  const [sessionId, setSessionId] = useState(() => {
    try {
      const s = localStorage.getItem(`pad-term-session-${name}`)
      return s && SAFE_SESSION_RE.test(s) ? s : 'main'
    } catch {
      return 'main'
    }
  })
  // Mission drives the pane: col 3 pins the session to the row the user picked
  // in col 2, so the pane follows the selection instead of whatever this
  // browser last used for this PAD. Controlled mode owns the value outright —
  // no localStorage, no tab switching (that is what showSessions=false is for).
  const controlled = !!controlledSessionId
  const activeSessionId = controlled ? controlledSessionId : sessionId
  const sessionIdRef = useRef(sessionId) // sync'd below; initTerminal reads this
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const newSessionQueueRef = useRef(Promise.resolve())
  const [newSessionsPending, setNewSessionsPending] = useState(0)
  const tabListRef = useRef(null)

  /** Set state only while the component is mounted. */
  function setStateSafe(setter, value) {
    if (mountedRef.current) setter(value)
  }

  /** True when the user is NOT allowed to type right now (ignores the
   *  auto-unlock window while an injected command is running). */
  const isInputLocked = useCallback(() => {
    if (cmdRunningRef.current) return false
    return disabledRef.current || manualLockRef.current
  }, [])

  /** Recompute the UI lock indicator from the current ref state. */
  const refreshLockUI = useCallback(() => {
    setStateSafe(setUiLocked, isInputLocked())
  }, [isInputLocked])

  /** Write raw text to shell stdin. Returns true when the WebSocket was open
   *  and the text was sent. Writes while disconnected are dropped — there is
   *  no queue; the parent disables command buttons until the terminal is ready. */
  const sendToShell = useCallback((text) => {
    const ws = wsRef.current
    if (readyRef.current && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(text)
      return true
    }
    return false
  }, [])

  /** Matches a fresh bash prompt at the start of a line: `user@host:~/dir$ `,
   *  `root# `, `~$ ` … Anything ending in `$`/`#` right after the prompt text.
   *  (Also catches `user@host:~/dir#` for root shells.) */
  const PROMPT_RE = /^[\w.-]+(@[\w.-]+)?(:\S*)?[$#]\s?/

  /** Heuristic: the shell is idle only when the cursor sits on a fresh prompt
   *  line. While a command runs the cursor is on the echoed command, its
   *  output, or a TUI — none of which look like a prompt. This is read from
   *  the live xterm buffer, so it needs no backend round-trip. Only updates
   *  the raw ref; `syncBusy` decides when the badge actually shows. */
  const checkShellBusy = useCallback(() => {
    const term = termRef.current
    if (!term) return
    try {
      const b = term.buffer.active
      // cursorY is viewport-relative (0 = the row at baseY); the cursor's
      // absolute buffer line is baseY + cursorY.
      const line = b.getLine(b.baseY + b.cursorY)
      if (!line) return
      shellBusyRef.current = !PROMPT_RE.test(line.translateToString(true))
    } catch {}
  }, [])

  /** Debounce the Stop Command button: a command must hold the shell for ~0.4s
   *  before the button shows (quick commands never flash), and it hides
   *  immediately the moment the shell goes idle. Driven by a 250ms poll. */
  const syncBusy = useCallback(() => {
    const raw = shellBusyRef.current || cmdRunningRef.current
    const now = Date.now()
    if (raw) {
      if (busySinceRef.current === null) busySinceRef.current = now
      if (!shellBusyShowRef.current && now - busySinceRef.current >= 400) {
        shellBusyShowRef.current = true
        setStateSafe(setShellBusy, true)
      }
    } else {
      busySinceRef.current = null
      if (shellBusyShowRef.current) {
        shellBusyShowRef.current = false
        setStateSafe(setShellBusy, false)
      }
    }
  }, [])

  // Commands are only sent when the shell sits on a fresh prompt. Sending
  // while the previous command is still running (or a TUI owns the terminal)
  // makes the shell echo the bytes onto whatever line it draws next — the
  // prompt and the command end up on separate, misaligned lines. So we queue
  // the payload and the poll loop flushes it once the shell goes idle.
  const COOLDOWN_MS = 400 // minimum gap between two injected commands
  const MAX_WAIT_MS = 10000 // safety: never hold a queued command forever
  const queueOrSend = useCallback((payload) => {
    checkShellBusy()
    const ws = wsRef.current
    if (!readyRef.current || !ws || ws.readyState !== WebSocket.OPEN) return false
    const now = Date.now()
    const recent = now - lastSendRef.current < COOLDOWN_MS
    if (shellBusyRef.current || recent) {
      pendingCmdsRef.current.push({ payload, at: now })
      return true
    }
    lastSendRef.current = now
    ws.send(payload)
    return true
  }, [checkShellBusy])

  /** Called from the poll loop: send queued commands once the shell is idle. */
  const flushPending = useCallback(() => {
    const pending = pendingCmdsRef.current
    if (pending.length === 0) return
    checkShellBusy()
    const ws = wsRef.current
    if (!readyRef.current || !ws || ws.readyState !== WebSocket.OPEN) {
      pendingCmdsRef.current = []
      return
    }
    const now = Date.now()
    const head = pending[0]
    // Send as soon as the shell is idle and the cooldown elapsed — but never
    // hold a command past MAX_WAIT_MS (guards against prompt-regex false
    // positives permanently stalling the queue).
    if (shellBusyRef.current) {
      if (now - head.at > MAX_WAIT_MS) {
        pending.shift()
        lastSendRef.current = now
        ws.send(head.payload)
      }
      return
    }
    if (now - lastSendRef.current < COOLDOWN_MS) return
    pending.shift()
    lastSendRef.current = now
    ws.send(head.payload)
  }, [checkShellBusy])

  /** Tell the backend the PTY size has changed. Sent as a NUL-NUL-prefixed
   *  JSON control frame (`\x00\x00{"type":"resize",...}`) so it can never be
   *  confused with pasted shell bytes — the backend does no JSON parse on raw
   *  input, and a pasted document that looks like a resize frame goes to the
   *  shell like any other text. */
  const pushResize = useCallback((cols, rows) => {
    if (!cols || !rows) return
    // A squeezed-but-not-hidden terminal (e.g. Mission with the queue panel
    // expanded over it) fits to a few cells. Pushing that shrinks the PAD's
    // pane for everyone — a 10x6 agent TUI cannot draw its UI, and the runner
    // then cannot tell it is ready. Too small to use = not a size worth sending.
    if (cols < 40 || rows < 8) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send('\x00\x00' + JSON.stringify({ type: 'resize', cols, rows }))
    } catch {}
  }, [])

  /** Best-effort write into the current terminal (ignores dispose errors). */
  function writeTerm(text) {
    try {
      termRef.current?.write(text)
    } catch {}
  }

  /** A fresh, unguessable sentinel for an injected command. */
  const nextMarker = useCallback(() => {
    markerSeqRef.current += 1
    return `__PAD_DONE_${Date.now().toString(36)}_${markerSeqRef.current}__`
  }, [])

  /**
   * Start (or restart) a terminal session. Safe to call concurrently —
   * each call bumps `genRef`, and any stale invocation that resolves after a
   * newer one (or after unmount) is torn down instead of mounting.
   */
  async function initTerminal() {
    const gen = ++genRef.current
    const isCurrent = () => mountedRef.current && gen === genRef.current
    initInFlightRef.current = true

    if (!name || typeof name !== 'string' || !name.trim()) {
      setStateSafe(setInitError, 'Terminal needs a valid "name" prop (the PAD/agent name).')
      initInFlightRef.current = false
      return
    }

    let TerminalCtor, FitAddonCtor
    // The xterm instance is created once per terminal host; session switches
    // reuse it and only swap the WebSocket below, so changing tabs never
    // blanks the terminal (no black-flash between sessions).
    let term = termRef.current
    if (!term) {
      try {
        ;({ Terminal: TerminalCtor } = await import('@xterm/xterm'))
        ;({ FitAddon: FitAddonCtor } = await import('@xterm/addon-fit'))
        await import('@xterm/xterm/css/xterm.css')
      } catch (err) {
        if (isCurrent()) setStateSafe(setInitError, `Failed to load xterm: ${err.message}`)
        initInFlightRef.current = false
        return
      }
      if (!isCurrent()) {
        initInFlightRef.current = false
        return
      }

      const fitAddon = new FitAddonCtor()
      term = new TerminalCtor({
        cursorBlink: true,
        fontSize,
        fontFamily: '"Cascadia Code", "Fira Code", monospace',
        scrollback: 10000,
      })
      term.loadAddon(fitAddon)
      term.open(containerRef.current)
      fitAddon.fit()
      termRef.current = term
      fitAddonRef.current = fitAddon

      term.onData((data) => {
        // Locked mode: drop keystrokes unless an injected command is running.
        if (isInputLocked()) return
        const live = wsRef.current
        if (readyRef.current && live && live.readyState === WebSocket.OPEN) live.send(data)
      })

      const ro = new ResizeObserver(() => {
        try {
          // Never fit a hidden/zero-size container. FitAddon clamps to a 2x1
          // minimum instead of bailing, so collapsing the terminal (display:none
          // -> 0x0) would otherwise shred the buffer to a couple of columns and
          // resize the container PTY to match. The observer re-fires with a real
          // size once the terminal becomes visible again. Resize targets the
          // live WS (not a captured session), so it follows tab switches.
          const el = containerRef.current
          if (collapsedRef.current || !el || !el.clientWidth || !el.clientHeight) return
          fitAddon.fit()
          const live = wsRef.current
          if (live && live.readyState === WebSocket.OPEN) pushResize(term.cols, term.rows)
        } catch {}
      })
      ro.observe(containerRef.current)
      roRef.current = ro

      term.attachCustomKeyEventHandler((e) => {
        // Allow Ctrl/Cmd+C to copy when text is selected (default copy action).
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && term.hasSelection()) return true
        return true
      })

      term.attachCustomWheelEventHandler((e) => {
        // Wheel policy (review #4): the wheel never becomes arrow-key input inside
        // a full-screen TUI. In alternate-screen mode xterm's alternate-scroll
        // default turns the wheel into ^[[A/^[[B — swallow the event instead. In
        // normal mode let xterm scroll the scrollback natively. Apps with mouse
        // reporting never reach this handler (real wheel events scroll them).
        if (term.buffer.active.type === 'alternate') {
          e.preventDefault()
          e.stopPropagation()
          return false
        }
        return true
      })
    }
    setStateSafe(setInitError, '')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    setStateSafe(setConnState, 'connecting')
    readyRef.current = false
    const connectedSession = sessionIdRef.current || 'main'
    // `history=0` on a soft swap only — see skipHistoryRef. Consumed here, so a
    // later reconnect of the same session still replays its scrollback.
    const skipHistory = skipHistoryRef.current
    skipHistoryRef.current = false
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/terminal/${name}?session=${encodeURIComponent(sessionIdRef.current || 'main')}&cols=${term.cols}&rows=${term.rows}${skipHistory ? '&history=0' : ''}`
    )
    wsRef.current = ws

    // Unmounted mid-init (before the WS handlers below are attached): clean up.
    if (!isCurrent()) {
      try { ws.close() } catch {}
      try { term.dispose() } catch {}
      if (wsRef.current === ws) wsRef.current = null
      if (termRef.current === term) termRef.current = null
      initInFlightRef.current = false
      // Leave the connection state as "disconnected" so the self-healing
      // reconcile effect can retry once the state settles.
      setStateSafe(setConnState, 'disconnected')
      return
    }

    ws.onopen = () => {
      if (gen !== genRef.current) return // superseded session
      initInFlightRef.current = false
      takeoverRef.current = false // we hold the session again
      // Connection is healthy — cancel any pending auto-reconnect and reset the backoff.
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      retryDelayRef.current = 2000
      wasConnectedRef.current = true
      pushResize(term.cols, term.rows)
    }

    ws.onmessage = (evt) => {
      if (gen !== genRef.current) return
      const data = String(evt.data)
      // Server → client control frames are NUL-NUL-prefixed JSON (mirrors the
      // client→server resize frames). The tmux window title arrives this way;
      // anything else is terminal bytes and goes straight to xterm.
      if (data.charCodeAt(0) === 0 && data.charCodeAt(1) === 0) {
        try {
          const parsed = JSON.parse(data.slice(2))
          if (parsed.type === 'ready') {
            readyRef.current = true
            setStateSafe(setConnState, 'connected')
            pushResize(term.cols, term.rows)
          }
          if (parsed.type === 'title') {
            setStateSafe(setSessionTitles, (titles) => ({ ...titles, [connectedSession]: parsed.title || '' }))
          }
        } catch {}
        return
      }
      writeTerm(evt.data)
      checkShellBusy()

      // Look for pending completion sentinels in the output.
      const pending = pendingMarkersRef.current
      if (pending.size) {
        outputTailRef.current = (outputTailRef.current + String(evt.data)).slice(-512)
        for (const marker of Array.from(pending)) {
          // Sentinel must sit at the START of a line — the PTY-echoed copy of
          // the injected line has it mid-line (after `echo `), so it can never
          // match and cause a premature "done".
          if (outputTailRef.current.includes('\n' + marker)) {
            pending.delete(marker)
            if (markerCmdRef.current.has(marker)) {
              lastDoneCmdRef.current = markerCmdRef.current.get(marker)
              markerCmdRef.current.delete(marker)
            }
          }
        }
        if (pending.size === 0) {
          const doneCmd = lastDoneCmdRef.current
          lastDoneCmdRef.current = null
          outputTailRef.current = ''
          cmdRunningRef.current = false
          setStateSafe(setCmdRunning, false)
          refreshLockUI()
          try { onCommandDone?.(doneCmd) } catch {}
        }
      }
    }

    ws.onclose = (evt) => {
      initInFlightRef.current = false
      // A superseded session (explicit teardown / session switch) bumps the gen
      // counter, so its late close is ignored here and never schedules a retry.
      if (gen !== genRef.current) return
      readyRef.current = false
      setStateSafe(setConnState, 'disconnected')
      // 4001 = the server replaced this connection with a newer one for the
      // same PAD/session (single-client policy). The replacement client is
      // already attached, so auto-reconnecting here would start a kick fight.
      // Show the reason and let the user retake manually.
      if (evt.code === 4001) {
        wasConnectedRef.current = false
        takeoverRef.current = true
        writeTerm('\r\n\x1b[33m[Terminal taken over by another connection — click Reconnect to retake.]\x1b[0m\r\n')
        return
      }
      // 4003 = the server says this MISSION SESSION is closed (its row is gone
      // from the page). It is not a stopped PAD and it will never come back, so
      // retrying is pointless: the client used to share 4002 with "agent is
      // stopped" and reconnected forever against a session that no longer
      // exists. Stop for good — the page's next selection reconnects anyway.
      if (evt.code === 4003) {
        wasConnectedRef.current = false
        setStateSafe(setConnState, 'disconnected')
        writeTerm('\r\n\x1b[33m[This session was closed.]\x1b[0m\r\n')
        return
      }
      // 4002 = the PAD is stopped/not running. When the agent is truly stopped
      // (`running` prop false) stop retrying entirely — the `running` prop
      // triggers a fresh connect when it comes back up. But when the agent is
      // marked running (e.g. still starting up), keep retrying with backoff.
      if (evt.code === 4002) {
        wasConnectedRef.current = false
        if (!runningRef.current) {
          writeTerm('\r\n\x1b[33m[Agent is stopped — the terminal will reconnect when it is running again.]\x1b[0m\r\n')
          return
        }
        scheduleReconnect()
        return
      }
      // Announce only the first close after a healthy connection — repeated
      // failed retries (PAD stopped) must not spam the scrollback.
      if (runningRef.current && wasConnectedRef.current) {
        writeTerm('\r\n\x1b[31m[Connection closed — reconnecting…]\x1b[0m\r\n')
        wasConnectedRef.current = false
      }
      if (runningRef.current) scheduleReconnect()
    }

    ws.onerror = () => {
      initInFlightRef.current = false
      setStateSafe(setConnState, 'disconnected')
    }
  }

  /** Tear down the current session. Idempotent and safe mid-init. */
  function teardown() {
    readyRef.current = false
    genRef.current++ // invalidate any in-flight init
    initInFlightRef.current = false
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
    if (wsRef.current) { try { wsRef.current.close() } catch {} ; wsRef.current = null }
    if (termRef.current) { try { termRef.current.dispose() } catch {} ; termRef.current = null }
    if (fitAddonRef.current) fitAddonRef.current = null
    if (roRef.current) { try { roRef.current.disconnect() } catch {} ; roRef.current = null }
    // Remove ANY terminal element from the container — a reconnect that skipped
    // teardown could have stacked stale .terminal divs on top, and a dead one on
    // top swallows keyboard input while the live one sits hidden underneath.
    const host = containerRef.current
    if (host) {
      for (const el of Array.from(host.querySelectorAll('.terminal'))) {
        try { el.remove() } catch {}
      }
    }
    setStateSafe(setConnState, 'disconnected')
    shellBusyRef.current = false
    busySinceRef.current = null
    shellBusyShowRef.current = false
    setStateSafe(setShellBusy, false)
  }

  /** Retry connecting after an unexpected close, with a backoff that doubles
   *  each attempt (capped at 30s) and resets on a successful open. Explicit
   *  teardown/session-switch cancels any pending retry. When the agent is not
   *  running the retry never starts — a stopped PAD is closed by the backend
   *  with 4002 and reconnection is driven by the `running` prop instead. */
  function scheduleReconnect() {
    if (!runningRef.current) return
    if (reconnectTimerRef.current) return
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      retryDelayRef.current = Math.min(retryDelayRef.current * 2, 30000)
      teardown()
      initTerminal().catch(() => {})
    }, retryDelayRef.current)
  }

  // Mount / name change: create session. Unmount: full teardown.
  useEffect(() => {
    mountedRef.current = true
    // Controlled mode (Mission): the page picked the pane — no localStorage,
    // and a missing controlled value must not fall back to the browser's own.
    if (controlledSessionId) {
      sessionIdRef.current = controlledSessionId
      setSessionId(controlledSessionId)
    } else {
      // Restore the persisted session for this PAD (handles name changes too).
      try {
        const s = localStorage.getItem(`pad-term-session-${name}`)
        if (s && SAFE_SESSION_RE.test(s)) {
          sessionIdRef.current = s
          setSessionId(s)
        }
      } catch {}
    }
    if (!containerRef.current) return
    initTerminal().catch(() => {})
    return () => {
      mountedRef.current = false
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  // Keep the ref in sync with the visible session id (initTerminal reads ref).
  useEffect(() => {
    sessionIdRef.current = activeSessionId
  }, [activeSessionId])

  // Keep the collapse ref in sync (the ResizeObserver closure captures the
  // init-time value, so it must read the live ref to skip fit() while hidden).
  useEffect(() => {
    collapsedRef.current = !!collapsed
  }, [collapsed])

  // Tell the parent when the terminal becomes ready/not-ready so command
  // buttons can be disabled until writes can actually reach the shell.
  useEffect(() => {
    onConnChange?.(connState === 'connected' && newSessionsPending === 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState, newSessionsPending])

  // The `disabled` prop controls the external lock.
  useEffect(() => {
    disabledRef.current = !!disabled
    refreshLockUI()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

  // Agent running state: when the agent stops, tear the terminal down and stop
  // retrying; when it comes back up, reconnect automatically. The parent feeds
  // `running={agent.status === 'running'}` (store updates are optimistic, then
  // self-corrected by the parent's 5s poll).
  useEffect(() => {
    runningRef.current = !!running
    const prev = wasRunningRef.current
    wasRunningRef.current = !!running
    if (!running && prev) {
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      teardown()
    } else if (running && !prev) {
      retryDelayRef.current = 2000
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  // Self-healing reconcile: whenever the agent is running but there is no live
  // terminal connection, (re)create one. This covers the case where a reconnect
  // init is cancelled mid-flight (e.g. a transient status wobble during startup
  // re-tears-down before the WS is created) — the state settles on
  // `running && disconnected` with no pending retry, and this effect brings it
  // back. It defers to the backoff timer (4002/1006 retries) and to a 4001
  // takeover (manual reconnect only).
  useEffect(() => {
    if (!runningRef.current) return
    if (connState === 'connected' || connState === 'connecting') return
    if (initInFlightRef.current) return
    if (reconnectTimerRef.current) return
    if (takeoverRef.current) return
    initTerminal().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, connState])

  // Persisted Lock toggle: restore the saved manual-lock state per agent.
  useEffect(() => {
    try {
      manualLockRef.current = localStorage.getItem(`pad-term-lock-${name}`) === '1'
    } catch {}
    refreshLockUI()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  // Font size changes need a re-fit + backend resize (pane dims are unchanged,
  // so the ResizeObserver alone will not fire). When collapsed the buffer must
  // NOT be re-fit (same 2x1-clamp hazard as the ResizeObserver) — the observer
  // re-fits it once the terminal is visible again.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    if (collapsedRef.current) return
    try {
      fitAddonRef.current?.fit()
      pushResize(term.cols, term.rows)
    } catch {}
  }, [fontSize, pushResize])

  // Poll the prompt heuristic + drive the Running-badge debounce while
  // connected. The interval is the sole driver of the badge state; quick
  // commands go busy→idle between ticks and never show it. While collapsed the
  // heuristic is meaningless (the buffer may be mid-reflow) and the badge would
  // be invisible anyway — force it off and skip polling.
  useEffect(() => {
    if (connState !== 'connected' || collapsed) {
      shellBusyRef.current = false
      busySinceRef.current = null
      shellBusyShowRef.current = false
      setStateSafe(setShellBusy, false)
      return
    }
    const iv = setInterval(() => {
      checkShellBusy()
      syncBusy()
      flushPending()
    }, 250)
    return () => clearInterval(iv)
  }, [connState, collapsed, checkShellBusy, syncBusy, flushPending])

  // When locked, stop the cursor blinking so it reads as "read-only".
  useEffect(() => {
    const term = termRef.current
    if (term) term.options.cursorBlink = !uiLocked
  }, [uiLocked])

  // Escape exits fullscreen mode.
  useEffect(() => {
    if (!fullscreen) return
    function onKey(e) {
      if (e.key === 'Escape') setFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [fullscreen])

  /** Load the PAD's active tmux sessions. */
  const refreshSessions = useCallback(async () => {
    if (!name) return []
    setSessionsLoading(true)
    let list = []
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(name)}/terminal-sessions`)
      if (res.ok) {
        const data = await res.json()
        list = data.sessions || []
        setSessions(list)
      }
    } catch {}
    setSessionsLoaded(true)
    setSessionsLoading(false)
    return list
  }, [name])

  // The tab strip owns the session list now (no dropdown): load on mount /
  // PAD change so tabs render without waiting for a click.
  useEffect(() => {
    refreshSessions()
  }, [refreshSessions])

  // Keep the active tab visible when the strip overflows horizontally.
  useEffect(() => {
    try {
      tabListRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
    } catch {}
  }, [activeSessionId, sessions])

  /** Switch to a session: persist choice, tear down, reconnect (backend
   *  auto-creates the tmux session on attach if it does not exist yet). Like
   *  reconnect(), we init directly after teardown — the reconcile effect can't
   *  be relied on when the state is already "disconnected". */
  const switchSession = useCallback(
    (id) => {
      if (!id || id === sessionIdRef.current) return
      // Controlled mode: the page owns the pane (col 2 selection), so a stray
      // tab click must not be able to drag the terminal off the mission session.
      if (controlled) return
      sessionIdRef.current = id
      setSessionId(id)
      try { localStorage.setItem(`pad-term-session-${name}`, id) } catch {}
      // Reuse xterm, but never display the outgoing session under the new tab.
      // Reset only the browser buffer; tmux retains the session's real history.
      // Bumping the gen invalidates the old WS's handlers — its late
      // close can't reschedule a reconnect. (teardown() stays for real
      // teardowns: PAD stop, name change, unmount, explicit reconnect.)
      genRef.current++
      readyRef.current = false
      try { termRef.current?.reset() } catch {}
      initInFlightRef.current = false
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      if (wsRef.current) { try { wsRef.current.close() } catch {} ; wsRef.current = null }
      setStateSafe(setConnState, 'connecting')
      initTerminal().catch(() => {})
    },
    [name, controlled]
  )

  // Controlled mode: the page changed which session is open (col 2 selection,
  // or a session that just came up). Soft swap — reuse the live xterm and only
  // reconnect the WebSocket to the new pane, so picking another row never
  // blanks the terminal.
  const controlledRef = useRef(controlledSessionId)
  useEffect(() => {
    if (controlledRef.current === controlledSessionId) return
    controlledRef.current = controlledSessionId
    if (!controlledSessionId || !containerRef.current) return
    sessionIdRef.current = controlledSessionId
    genRef.current++
    initInFlightRef.current = false
    if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
    if (wsRef.current) { try { wsRef.current.close() } catch {} ; wsRef.current = null }
    // Wipe the outgoing session's screen NOW rather than leaving it on display
    // for the ~half second the new attach takes to repaint: the header already
    // says the new session, and a pane of someone else's output under it reads
    // as "it restarted from the beginning". The attach repaint lands on an empty
    // buffer, which is the same thing a real terminal does when you switch.
    const t = termRef.current
    if (t) { try { t.reset() } catch {} }
    // …and tell the server not to replay scrollback into a buffer we just
    // emptied (it would land under the live screen, and it was most of the
    // switch latency). A first connect / reload still gets its history.
    skipHistoryRef.current = true
    setStateSafe(setConnState, 'connecting')
    initTerminal().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlledSessionId])

  /** Create a new session with the next free `term-N` name. */
  const createNewSession = useCallback(async () => {
    if (!name) return
    const list = await refreshSessions()
    const used = new Set([...list.map((s) => s.name), sessionIdRef.current])
    let n = 1
    while (used.has(`term-${n}`)) n += 1
    const target = `term-${n}`
    setStateSafe(setSessionTitles, (titles) => ({ ...titles, [target]: '' }))
    // Show the new session in the list immediately, like the header does. The
    // backend creates the tmux session on WS attach, so the API can lag behind.
    // Poll until the API reports it; only then swap in the authoritative list
    // (keeps the optimistic entry visible instead of it flashing away).
    setSessions((prev) => (prev.some((s) => s.name === target) ? prev : [...prev, { name: target, attached: true, created: Date.now() }]))
    if (!mountedRef.current) return
    switchSession(target)
    let attempts = 0
    while (attempts < 8) {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(name)}/terminal-sessions`)
        if (res.ok) {
          const data = await res.json()
          const got = (data.sessions || []).map((s) => (s.name === target ? { ...s, name: target } : s))
          if (got.some((s) => s.name === target)) {
            if (!mountedRef.current) return
            setSessions(got)
            break
          }
        }
      } catch {}
      attempts += 1
      if (attempts < 8) await new Promise((r) => setTimeout(r, 300))
    }
  }, [name, switchSession, refreshSessions])

  // Each click creates a session, in order. Do not let concurrent refreshes
  // choose the same free id or close an attach before its session is created.
  const newSession = useCallback(() => {
    setNewSessionsPending((n) => n + 1)
    newSessionQueueRef.current = newSessionQueueRef.current.catch(() => {}).then(() => {
      if (mountedRef.current) return createNewSession()
    }).finally(() => {
      setStateSafe(setNewSessionsPending, (n) => n - 1)
    })
    return newSessionQueueRef.current
  }, [createNewSession])

  /** Kill a tmux session. Closing the current one falls back to the previous
   *  session in the list (or `main`, which the backend recreates on attach). */
  const closeSession = useCallback(
    async (id) => {
      if (!name) return
      const currentWasClosed = sessionIdRef.current === id
      // Pick the fallback BEFORE deleting: the session listed just before the
      // one being closed, or `main` if there is no previous one.
      let fallback = 'main'
      if (currentWasClosed) {
        const idx = sessions.findIndex((s) => s.name === id)
        const prev = idx > 0 ? sessions[idx - 1] : null
        if (prev) fallback = prev.name
      }
      // Remove it from the list immediately; the poll below swaps in the
      // authoritative list once the backend confirms.
      setSessions((prev) => prev.filter((s) => s.name !== id))
      setStateSafe(setSessionTitles, (titles) => {
        const next = { ...titles }
        delete next[id]
        return next
      })
      try {
        await fetch(`/api/agents/${encodeURIComponent(name)}/terminal-sessions/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'X-CSRF-Token': getCsrfToken() || '' }, credentials: 'same-origin' })
      } catch {}
      if (currentWasClosed && sessionIdRef.current === id) switchSession(fallback)
      let list = await refreshSessions()
      // The backend recreates the current session when the WS reconnects (the
      // attach auto-creates the tmux session), so the list fetch can race ahead
      // of it. Poll briefly until the current session shows up again, so the
      // dropdown can mark it "current" instead of showing a stale list.
      if (currentWasClosed) {
        const target = sessionIdRef.current
        let attempts = 0
        // Window covers the WS reconnect backoff (2s) + tmux session creation,
        // so a recreated `main` still shows up in the list as "current".
        while (attempts < 15 && !list.some((s) => s.name === target)) {
          await new Promise((r) => setTimeout(r, 300))
          list = await refreshSessions()
          attempts += 1
        }
      }
    },
    [name, sessions, switchSession, refreshSessions]
  )

  async function reconnect() {
    const ok = await confirm({
      title: 'Reconnect terminal',
      message: 'Reconnect to this terminal session? Scrollback is preserved.',
      confirmText: 'Reconnect',
    })
    if (!ok) return
    // Clear the takeover flag (explicit user intent to retake the session).
    // Teardown drops the connection state to "disconnected", then we connect
    // directly. We CANNOT rely on the self-healing reconcile effect here: after
    // a 4001 takeover the state is ALREADY "disconnected", so setting it again
    // bails out of React's render (same value → no effect run) and the terminal
    // would stay stuck on "Terminal Disconnected" forever.
    takeoverRef.current = false
    teardown()
    initTerminal().catch(() => {})
  }

  /** Inject `text` as a tracked command (sentinel + completion callbacks). */
  const injectTracked = useCallback((text) => {
    if (!readyRef.current || wsRef.current?.readyState !== WebSocket.OPEN) return false
    const marker = nextMarker()
    pendingMarkersRef.current.add(marker)
    markerCmdRef.current.set(marker, text)
    cmdRunningRef.current = true
    setStateSafe(setCmdRunning, true)
    refreshLockUI()
    try { onCommandStart?.(text) } catch {}
    return sendToShell(`${text}; echo; echo ${marker}\n`)
  }, [sendToShell, nextMarker, onCommandStart, refreshLockUI])

  useImperativeHandle(
    ref,
    () => ({
      runCommand: (cmd, opts) => {
        const track = opts?.track === true
        const text = String(cmd ?? '').replace(/\r/g, '\n')
        if (!text.trim()) return false
        if (track || isInputLocked()) {
          // Tracked/locked mode: append a completion sentinel to the same line
          // (bash runs it only after the command finishes). In locked mode input
          // auto-unlocks while the command runs and re-locks on completion; in
          // tracked mode input stays whatever it was.
          return injectTracked(text)
        }
        return queueOrSend(text + '\n')
      },
      write: sendToShell,
      clear: () => sendToShell('clear\n'),
      close: () => sendToShell('\x03'),
      reconnect,
      focus: () => termRef.current?.focus(),
      isConnected: () => connState === 'connected' && wsRef.current?.readyState === WebSocket.OPEN,
      isBusy: () => shellBusyRef.current || cmdRunningRef.current,
      setLocked: (v) => {
        manualLockRef.current = !!v
        refreshLockUI()
      },
      lock: () => {
        manualLockRef.current = true
        refreshLockUI()
      },
      unlock: () => {
        manualLockRef.current = false
        refreshLockUI()
      },
      isLocked: () => isInputLocked(),
    }),
    [connState, sendToShell, isInputLocked, nextMarker, injectTracked, queueOrSend, onCommandStart, onCommandDone, refreshLockUI]
  )

  return (
    <div className={`flex flex-col overflow-hidden bg-sunken ${fullscreen ? 'fixed inset-0 z-[100]' : bordered ? 'relative rounded-card border border-line-faint' : ''} ${className}`}>
      <div className="terminal-header flex flex-wrap sm:flex-nowrap items-stretch border-b border-line-faint bg-panel select-none">
        <div className="order-2 flex items-center gap-2 px-2 shrink-0">
          <span
            title={connState === 'connected' ? 'Terminal Connected' : connState === 'connecting' ? 'Terminal Connecting' : 'Terminal Disconnected'}
            className={`w-2 h-2 rounded-full ${connState === 'connected' ? 'bg-success' : connState === 'connecting' ? 'bg-warning' : 'bg-line'}`}
          />
          {uiLocked && !cmdRunning && (
            <span title="Locked — only injected commands run" className="flex items-center text-warning">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </span>
          )}
        </div>
        {showSessions && (
        <div className="terminal-tab-bar order-1 flex flex-1 basis-full sm:basis-auto min-h-9 min-w-0 items-stretch">
        <div ref={tabListRef} role="tablist" aria-label="Terminal sessions" className="terminal-tabs flex flex-initial min-w-0 items-stretch overflow-x-auto overflow-y-hidden">
          {(sessions.some((s) => s.name === activeSessionId) ? sessions : [...sessions, { name: activeSessionId }]).map((s) => {
            const isCur = s.name === activeSessionId
            const tabTitle = sessionTitles[s.name] ?? s.title ?? ''
            return (
              <div
                key={s.name}
                role="tab"
                aria-selected={isCur}
                tabIndex={0}
                data-active={isCur ? 'true' : 'false'}
                onClick={() => switchSession(s.name)}
                onMouseDown={(e) => { if (e.button === 1) e.preventDefault() }}
                onAuxClick={(e) => {
                  if (e.button !== 1) return
                  e.preventDefault()
                  e.stopPropagation()
                  closeSession(s.name)
                }}
                onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); switchSession(s.name) } }}
                title={tabTitle ? `${s.name} — ${tabTitle}` : `Session ${s.name}`}
                className={`terminal-tab group relative -mb-px first:ml-2 flex min-w-24 max-w-48 shrink-0 cursor-pointer items-center border-b-2 pl-3 pr-2 text-xs font-mono transition-colors outline-none ${isCur ? 'bg-sunken text-ink border-accent' : 'text-ink-dim border-transparent hover:text-ink hover:bg-raised'}`}
              >
                <span className={`terminal-tab-label min-w-0 flex-1 truncate ${sessionsLoading && !sessionsLoaded ? 'animate-pulse' : ''} ${isCur ? '[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.25rem),transparent)]' : 'group-hover:[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.25rem),transparent)] group-focus-within:[mask-image:linear-gradient(to_right,#000_calc(100%_-_2.25rem),transparent)]'}`}>
                  {tabTitle || s.name}
                </span>
                <Button
                  variant="ghost"
                  size="bare"
                  onClick={(e) => { e.stopPropagation(); closeSession(s.name) }}
                  title={`Close session ${s.name}`}
                  aria-label={`Close session ${s.name}`}
                  className={`absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2 shrink-0 rounded-full p-0 leading-none ${isCur ? '' : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'}`}
                >
                  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
                    <path d="m5 5 14 14M19 5 5 19" />
                  </svg>
                </Button>
              </div>
            )
          })}
        </div>
          <Button
            variant="ghost"
            size="bare"
            onClick={newSession}
            title="New terminal tab"
            aria-label="New terminal tab"
            className="self-center mx-2 h-8 w-8 shrink-0 rounded-full border border-line-faint p-0 text-lg leading-none text-ink-dim hover:text-accent-text hover:bg-raised"
          >
            +
          </Button>
          {shellBusy && !collapsed && (
            <Button
              variant="dangerGhost"
              size="sm"
              onClick={() => ref.current?.close()}
              title="Send Ctrl+C to interrupt the running command"
              aria-label="Stop command"
              className="self-center mx-1 my-1 shrink-0"
            >
              Stop Command
            </Button>
          )}
        </div>
        )}
        <div className="order-3 relative ml-auto flex shrink-0 items-center gap-1.5 px-2 py-1">
          <span className="w-px h-4 bg-raised" />
          <Button variant="ghost" size="sm" onClick={() => setFontSize((s) => Math.max(10, s - 1))} className="text-ink-faint">A-</Button>
          <span className="text-xs text-ink-dim w-6 text-center">{fontSize}</span>
          <Button variant="ghost" size="sm" onClick={() => setFontSize((s) => Math.min(24, s + 1))} className="text-ink-faint">A+</Button>
          <span className="w-px h-4 bg-raised" />
          <Button variant="ghost" size="sm" onClick={() => ref.current?.clear()} className="text-ink-faint">Clear</Button>
          <Button variant="ghost" size="sm" onClick={reconnect} className="text-ink-faint">Reconnect</Button>

          {onToggleCollapse && showCollapse && !fullscreen && (
            <>
              <span className="w-px h-4 bg-raised" />
              <Button
                variant="ghost"
                size="sm"
                icon
                onClick={onToggleCollapse}
                title={collapsed ? 'Expand terminal' : 'Collapse terminal'}
                className="text-ink-faint"
              >
                {collapsed ? (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 15l6-6 6 6" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                )}
              </Button>
            </>
          )}

          {fullscreen ? (
            <Button
              variant="ghost"
              size="sm"
              icon
              onClick={() => setFullscreen(false)}
              title="Exit fullscreen (Esc)"
              className="text-ink-faint"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14h6v6" />
                <path d="M20 10h-6V4" />
                <path d="M14 10l7-7" />
                <path d="M3 21l7-7" />
              </svg>
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              icon
              onClick={() => setFullscreen(true)}
              title="Fullscreen"
              className="text-ink-faint"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            </Button>
          )}
        </div>
      </div>
      <div className={`relative w-full ${collapsed ? 'hidden' : ''}`} style={{ height, minHeight }}>
      <div ref={containerRef} className="h-full w-full">
        {initError && (
          <div className="p-4 text-sm text-danger font-mono whitespace-pre-wrap">{initError}</div>
        )}
      </div>
      {(connState === 'connecting' || newSessionsPending > 0) && !initError && (
        <div role="status" className="terminal-opening absolute inset-0 z-10 flex items-center justify-center bg-sunken text-sm text-ink-dim font-mono">
          {newSessionsPending > 0 ? 'Opening terminal…' : `Opening ${activeSessionId}…`}
        </div>
      )}
      </div>
    </div>
  )
})

export default Terminal
