import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'
import { useConfirm } from '../lib/confirm'

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
 * setup anywhere else (see `plans/terminal.md` and `src/docs/terminal.md`).
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
 *  | `isConnected()`  | boolean  | True when the WebSocket is OPEN.             |
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
 *  src/docs/terminal.md for the full write-up)
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
 *  Sessions (header dropdown next to the connection status)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - The dropdown lists the PAD's active tmux sessions (GET
 *    /api/agents/:name/terminal-sessions) and lets you switch, create
 *    ("+ New session" → next free `term-N`), or close (DELETE) a session.
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
 *  - No write queue: command buttons are disabled until the WS is open (the
 *    parent is told via `onConnChange`), and writes attempted while disconnected
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
  { name, title, height = '70vh', minHeight = '480px', disabled = false, collapsed = false, showCollapse = true, onToggleCollapse, onCommandStart, onCommandDone, onConnChange, className = '', running = true },
  ref
) {
  const containerRef = useRef(null)
  const termRef = useRef(null) // current xterm.js instance
  const fitAddonRef = useRef(null) // current FitAddon instance
  const wsRef = useRef(null) // current WebSocket
  const roRef = useRef(null) // current ResizeObserver
  const genRef = useRef(0) // generation token for async init
  const mountedRef = useRef(true) // guards setState after unmount

  // Auto-reconnect: when the connection drops (e.g. the PAD is restarted or
  // started from stopped), retry with a backoff until it comes back.
  const reconnectTimerRef = useRef(null)
  const retryDelayRef = useRef(2000)
  const wasConnectedRef = useRef(false) // only announce the first close after a connected state

  const disabledRef = useRef(!!disabled) // external lock (the `disabled` prop)
  const manualLockRef = useRef(false) // imperative lock()/unlock()/Lock toggle
  const runningRef = useRef(!!running) // the agent is running → auto-reconnect allowed
  const wasRunningRef = useRef(!!running) // previous `running` value, for edge detection
  const takeoverRef = useRef(false) // 4001 superseded → reconnect is manual-only
  const initInFlightRef = useRef(false) // an async initTerminal() is mid-flight
  const cmdRunningRef = useRef(false) // an injected command is in flight
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
  const [uiLocked, setUiLocked] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

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
  const sessionIdRef = useRef(sessionId) // sync'd below; initTerminal reads this
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [showSessions, setShowSessions] = useState(false)
  const sessionMenuRef = useRef(null)

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
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(text)
      return true
    }
    return false
  }, [])

  /** Tell the backend the PTY size has changed. Sent as a NUL-NUL-prefixed
   *  JSON control frame (`\x00\x00{"type":"resize",...}`) so it can never be
   *  confused with pasted shell bytes — the backend does no JSON parse on raw
   *  input, and a pasted document that looks like a resize frame goes to the
   *  shell like any other text. */
  const pushResize = useCallback((cols, rows) => {
    if (!cols || !rows) return
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
    const term = new TerminalCtor({
      cursorBlink: true,
      fontSize,
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      scrollback: 10000,
      theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#22d3ee', selectionBackground: '#334155' },
    })
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()
    termRef.current = term
    fitAddonRef.current = fitAddon
    setStateSafe(setInitError, '')

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    setStateSafe(setConnState, 'connecting')
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/terminal/${name}?session=${encodeURIComponent(sessionIdRef.current || 'main')}&cols=${term.cols}&rows=${term.rows}`
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

    term.onData((data) => {
      // Locked mode: drop keystrokes unless an injected command is running.
      if (isInputLocked()) return
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    ws.onopen = () => {
      if (gen !== genRef.current) return // superseded session
      initInFlightRef.current = false
      takeoverRef.current = false // we hold the session again
      // Connection is healthy — cancel any pending auto-reconnect and reset the backoff.
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null }
      retryDelayRef.current = 2000
      wasConnectedRef.current = true
      setStateSafe(setConnState, 'connected')
      pushResize(term.cols, term.rows)
    }

    ws.onmessage = (evt) => {
      if (gen !== genRef.current) return
      writeTerm(evt.data)

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

    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (gen === genRef.current) pushResize(term.cols, term.rows)
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
      // a full-screen TUI. xterm's alternate-scroll default turns the wheel into
      // ^[[A/^[[B for apps without mouse reporting (opencode, htop, top), which
      // moves their cursor/selection instead of scrolling. In alternate-screen
      // mode there is no xterm scrollback to scroll, so swallow the event
      // (return false = xterm emits no arrow sequence) and cancel it so the page
      // doesn't scroll instead. In normal mode return true — xterm's viewport
      // scrolls the scrollback natively. Apps that enable mouse reporting never
      // reach this handler: xterm feeds them real wheel events and they scroll
      // themselves.
      if (term.buffer.active.type === 'alternate') {
        e.preventDefault()
        e.stopPropagation()
        return false
      }
      return true
    })
  }

  /** Tear down the current session. Idempotent and safe mid-init. */
  function teardown() {
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
    // Restore the persisted session for this PAD (handles name changes too).
    try {
      const s = localStorage.getItem(`pad-term-session-${name}`)
      if (s && SAFE_SESSION_RE.test(s)) {
        sessionIdRef.current = s
        setSessionId(s)
      }
    } catch {}
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
    sessionIdRef.current = sessionId
  }, [sessionId])

  // Tell the parent when the terminal becomes ready/not-ready so command
  // buttons can be disabled until writes can actually reach the shell.
  useEffect(() => {
    onConnChange?.(connState === 'connected')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState])

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
  // so the ResizeObserver alone will not fire).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    try {
      fitAddonRef.current?.fit()
      pushResize(term.cols, term.rows)
    } catch {}
  }, [fontSize, pushResize])

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

  // Close the sessions dropdown when clicking outside it.
  useEffect(() => {
    if (!showSessions) return
    function onDocClick(e) {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target)) setShowSessions(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [showSessions])

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

  function toggleSessions() {
    const next = !showSessions
    setShowSessions(next)
    if (next) refreshSessions()
  }

  /** Switch to a session: persist choice, tear down, reconnect (backend
   *  auto-creates the tmux session on attach if it does not exist yet). The
   *  self-healing reconcile effect re-attaches after the teardown. */
  const switchSession = useCallback(
    (id) => {
      if (!id || id === sessionIdRef.current) return
      sessionIdRef.current = id
      setSessionId(id)
      try { localStorage.setItem(`pad-term-session-${name}`, id) } catch {}
      teardown()
    },
    [name]
  )

  /** Create a new session with the next free `term-N` name. */
  const newSession = useCallback(async () => {
    if (!name) return
    const list = await refreshSessions()
    const used = new Set([...list.map((s) => s.name), sessionIdRef.current])
    let n = 1
    while (used.has(`term-${n}`)) n += 1
    const target = `term-${n}`
    // Show the new session in the list immediately, like the header does. The
    // backend creates the tmux session on WS attach, so the API can lag behind.
    // Poll until the API reports it; only then swap in the authoritative list
    // (keeps the optimistic entry visible instead of it flashing away).
    setSessions((prev) => (prev.some((s) => s.name === target) ? prev : [...prev, { name: target, attached: true, created: Date.now() }]))
    switchSession(target)
    let attempts = 0
    while (attempts < 8) {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(name)}/terminal-sessions`)
        if (res.ok) {
          const data = await res.json()
          const got = (data.sessions || []).map((s) => (s.name === target ? { ...s, name: target } : s))
          if (got.some((s) => s.name === target)) {
            setSessions(got)
            break
          }
        }
      } catch {}
      attempts += 1
      if (attempts < 8) await new Promise((r) => setTimeout(r, 300))
    }
  }, [name, switchSession, refreshSessions])

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
      try {
        await fetch(`/api/agents/${encodeURIComponent(name)}/terminal-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
      } catch {}
      if (currentWasClosed) switchSession(fallback)
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
    // Clear the takeover flag (explicit user intent to retake the session),
    // then teardown drops the connection state to "disconnected"; the
    // self-healing reconcile effect re-attaches immediately.
    takeoverRef.current = false
    teardown()
  }

  /** Inject `text` as a tracked command (sentinel + completion callbacks). */
  const injectTracked = useCallback((text) => {
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
        return sendToShell(text + '\n')
      },
      write: sendToShell,
      clear: () => sendToShell('clear\n'),
      close: () => sendToShell('\x03'),
      reconnect,
      focus: () => termRef.current?.focus(),
      isConnected: () => wsRef.current?.readyState === WebSocket.OPEN,
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
    [sendToShell, isInputLocked, nextMarker, injectTracked, onCommandStart, onCommandDone, refreshLockUI]
  )

  return (
    <div className={`flex flex-col border border-slate-800 overflow-hidden bg-[#0f172a] ${fullscreen ? 'fixed inset-0 z-[100] rounded-none' : 'relative rounded-xl'} ${className}`}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/80 select-none">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connState === 'connected' ? 'bg-emerald-400' : connState === 'connecting' ? 'bg-amber-400' : 'bg-slate-600'}`} />
            <span className="text-xs text-slate-400 font-medium min-w-[8rem] whitespace-nowrap shrink-0">
              {connState === 'connected' ? 'Terminal Connected' : connState === 'connecting' ? 'Terminal Connecting' : 'Terminal Disconnected'}
            </span>
          </div>
          {uiLocked && !cmdRunning && (
            <span className="flex items-center gap-1.5 text-xs text-amber-400 font-medium">
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Locked
            </span>
          )}
          <span className="w-px h-4 bg-slate-700" />
          <span className="text-xs text-slate-300 font-mono">{title || name}</span>
        </div>
        <div className="relative flex items-center gap-1.5">
          <div ref={sessionMenuRef} className="relative">
            <button
              onClick={toggleSessions}
              title="Terminal sessions"
              className="flex items-center gap-1 px-2 py-0.5 text-xs font-mono text-slate-300 bg-slate-800/60 border border-slate-700 rounded hover:border-cyan-700 hover:text-cyan-300 transition-colors"
            >
              <span className="max-w-[8rem] truncate">{sessionId}</span>
              <svg className="w-3 h-3 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {showSessions && (
              <div className="absolute right-0 top-full mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 shadow-xl z-50">
                <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
                  <span className="text-xs font-medium text-slate-300">Terminal sessions</span>
                  <button
                    onClick={refreshSessions}
                    title="Refresh session list"
                    className="text-slate-500 hover:text-white text-xs px-1"
                  >
                    ↻
                  </button>
                </div>
                <div className="py-1">
                  {(sessionsLoading || !sessionsLoaded) && sessions.length === 0 && (
                    <div className="px-3 py-2 text-xs text-slate-500">Loading…</div>
                  )}
                  {!sessionsLoading && sessionsLoaded && sessions.length === 0 && (
                    <div className="px-3 py-2 text-xs text-slate-500">No sessions yet.</div>
                  )}
                  {sessions.map((s) => {
                      const isCur = s.name === sessionId
                      return (
                        <div key={s.name} className="flex items-center group">
                          <button
                            onClick={() => switchSession(s.name)}
                            className="flex-1 text-left px-3 py-1.5 text-xs font-mono text-slate-300 hover:bg-slate-800 hover:text-cyan-300 transition-colors truncate"
                            title={`Switch to session ${s.name}`}
                          >
                            {s.name}
                            {isCur && <span className="ml-2 text-[10px] text-cyan-400">current</span>}
                          </button>
                          <button
                            onClick={() => closeSession(s.name)}
                            className="px-2 py-1.5 text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
                            title={`Close session ${s.name}`}
                          >
                            ×
                          </button>
                        </div>
                      )
                    })}
                </div>
                <div className="border-t border-slate-800 p-1">
                  <button
                    onClick={newSession}
                    className="w-full text-left px-3 py-1.5 text-xs text-cyan-400 hover:bg-slate-800 hover:text-cyan-300 rounded transition-colors"
                  >
                    + New session
                  </button>
                </div>
              </div>
            )}
          </div>
          <span className="w-px h-4 bg-slate-700" />
          <button onClick={() => setFontSize((s) => Math.max(10, s - 1))} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">A-</button>
          <span className="text-xs text-slate-600 w-6 text-center">{fontSize}</span>
          <button onClick={() => setFontSize((s) => Math.min(24, s + 1))} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">A+</button>
          <span className="w-px h-4 bg-slate-700" />
          <button onClick={() => ref.current?.clear()} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Clear</button>
          <button onClick={() => ref.current?.close()} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Close</button>
          <button onClick={reconnect} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Reconnect</button>

          {onToggleCollapse && showCollapse && !fullscreen && (
            <>
              <span className="w-px h-4 bg-slate-700" />
              <button
                onClick={onToggleCollapse}
                title={collapsed ? 'Expand terminal' : 'Collapse terminal'}
                className="px-2 py-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
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
              </button>
            </>
          )}

          {fullscreen ? (
            <button
              onClick={() => setFullscreen(false)}
              title="Exit fullscreen (Esc)"
              className="px-2 py-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 14h6v6" />
                <path d="M20 10h-6V4" />
                <path d="M14 10l7-7" />
                <path d="M3 21l7-7" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => setFullscreen(true)}
              title="Fullscreen"
              className="px-2 py-1 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6" />
                <path d="M9 21H3v-6" />
                <path d="M21 3l-7 7" />
                <path d="M3 21l7-7" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div ref={containerRef} className={`w-full ${collapsed ? 'hidden' : ''}`} style={{ height, minHeight }}>
        {initError && (
          <div className="p-4 text-sm text-red-400 font-mono whitespace-pre-wrap">{initError}</div>
        )}
      </div>
    </div>
  )
})

export default Terminal
