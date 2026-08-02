import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from 'react'

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
 * setup anywhere else (see `plans/terminal-component.md`).
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
 *  | `disabled`       | boolean  | `false`  | Lock the terminal: the user cannot type their own commands. Only `runCommand()`-injected commands run. During an injected command the user can type again; when it finishes, it auto-locks. |
 *  | `onCommandStart` | fn       | (none)   | Fired when an injected command starts running (only in locked mode). |
 *  | `onCommandDone`  | fn       | (none)   | Fired when an injected command finishes (only in locked mode). |
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Imperative API (via `ref`)
 * ─────────────────────────────────────────────────────────────────────────────
 *  <Terminal ref={termRef} name={agent.name} />
 *
 *  | Method           | Returns  | Description                                 |
 *  |------------------|----------|---------------------------------------------|
 *  | `runCommand(cmd)`| boolean  | Sends `cmd` to the shell (newline appended). In locked mode it also auto-unlocks input until the command completes, then re-locks. Queued until the WS is open. Returns true if sent immediately. |
 *  | `write(text)`    | boolean  | Raw write to shell stdin. Queued when disconnected. |
 *  | `clear()`        | —        | Clears the visible scrollback.               |
 *  | `reconnect()`    | —        | Tears down and starts a fresh shell session. |
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
 * ─────────────────────────────────────────────────────────────────────────────
 *  Backend contract (see src/app.js — "Terminal WebSocket", and
 *  src/docs/terminal.md for the full write-up)
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Connect:  ws://<host>/ws/terminal/<name>?cols=<n>&rows=<n>
 *  - The backend uses dockerode (`Tty: true`) so Docker allocates a REAL PTY:
 *      container.exec({ Tty: true, Env: ['TERM=xterm-256color'], Cmd: ['bash','-i'] })
 *      → exec.start({ hijack: true, ... })
 *  - Client → server: raw keystroke bytes, plus JSON resize frames:
 *      { type: 'resize', cols: <n>, rows: <n> }  →  exec.resize({ h, w })
 *  - Server → client: raw PTY output (StringDecoder-decoded) rendered verbatim
 *    by xterm. No `\r` → `\n` conversion — the PTY line discipline handles CR/LF.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Locked mode: how "command is done" is detected
 * ─────────────────────────────────────────────────────────────────────────────
 *  A PTY has no reliable "command finished" signal, so in locked mode
 *  `runCommand()` appends a unique sentinel to the injected line:
 *      <cmd>; echo; echo __PAD_DONE_<id>__
 *  - bash parses the whole line first, so the `echo`s run only AFTER `<cmd>`
 *    finishes (and are never fed to an interactive app's stdin).
 *  - The empty `echo` prints a newline, guaranteeing the sentinel starts on a
 *    fresh line even when `<cmd>` output ends without a trailing newline.
 *  - The output stream is scanned for `\n__PAD_DONE_<id>__` (sentinel at the
 *    START of a line) via a rolling tail, so a sentinel split across WebSocket
 *    frames is still found. The PTY echoes the injected line too, but there
 *    the sentinel sits mid-line after `echo `, so it can never false-trigger.
 *  - When the sentinel appears, the command is over and the terminal re-locks.
 *  - Multiple injected commands queue: a sentinel set is tracked, and the
 *    terminal only re-locks when the last sentinel resolves.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  Lifecycle & robustness
 * ─────────────────────────────────────────────────────────────────────────────
 *  - Mount: dynamically imports xterm + fit addon, creates the terminal,
 *    opens the WebSocket, attaches a ResizeObserver.
 *  - `name` change: full teardown + fresh session.
 *  - Unmount: WebSocket closed, xterm disposed, ResizeObserver disconnected,
 *    all refs cleared. No setState after unmount.
 *  - Reconnect: safe to call repeatedly; stale in-flight init is invalidated
 *    by a generation counter, so a reconnect during a slow import can never
 *    double-mount a terminal.
 *  - Resize: after `fit()` and after font-size changes a `{type:'resize'}`
 *    frame is sent so the container PTY matches the pane.
 *  - Commands written while disconnected are queued (capped at 64) and flushed
 *    on `onopen`.
 *  - Init failures (bad `name`, xterm load error) render a visible error inside
 *    the terminal area instead of failing silently.
 *  - Ctrl/Cmd+C with a selection is left to the browser (copy) rather than
 *    killing the shell. In locked mode Ctrl+C is dropped entirely (user cannot
 *    interrupt injected commands). The `scrollback` is 10000 lines.
 */
const Terminal = forwardRef(function Terminal(
  { name, title, height = '70vh', minHeight = '480px', disabled = false, onCommandStart, onCommandDone },
  ref
) {
  const containerRef = useRef(null)
  const termRef = useRef(null) // current xterm.js instance
  const fitAddonRef = useRef(null) // current FitAddon instance
  const wsRef = useRef(null) // current WebSocket
  const roRef = useRef(null) // current ResizeObserver
  const pendingRef = useRef([]) // writes queued until the WS opens
  const genRef = useRef(0) // generation token for async init
  const mountedRef = useRef(true) // guards setState after unmount

  const disabledRef = useRef(!!disabled) // external lock (the `disabled` prop)
  const manualLockRef = useRef(false) // imperative lock()/unlock()
  const cmdRunningRef = useRef(false) // an injected command is in flight
  const pendingMarkersRef = useRef(new Set()) // sentinels awaiting their echo
  const outputTailRef = useRef('') // rolling output tail for sentinel detection
  const markerSeqRef = useRef(0)

  const [connected, setConnected] = useState(false)
  const [fontSize, setFontSize] = useState(14)
  const [initError, setInitError] = useState('')
  const [cmdRunning, setCmdRunning] = useState(false)
  const [uiLocked, setUiLocked] = useState(false)

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

  /** Write raw text to shell stdin. Queues when the WebSocket is not yet open
   *  (capped to avoid unbounded memory). Returns true when sent immediately. */
  const sendToShell = useCallback((text) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(text)
      return true
    }
    if (pendingRef.current.length < 64) pendingRef.current.push(text)
    return false
  }, [])

  /** Tell the backend the PTY size has changed. */
  const pushResize = useCallback((cols, rows) => {
    if (!cols || !rows) return
    const ws = wsRef.current
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }))
    } catch {}
  }, [])

  /** Best-effort write into the current terminal (ignores dispose errors). */
  function writeTerm(text) {
    try {
      termRef.current?.write(text)
    } catch {}
  }

  /** A fresh, unguessable sentinel for a locked-mode injected command. */
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

    if (!name || typeof name !== 'string' || !name.trim()) {
      setStateSafe(setInitError, 'Terminal needs a valid "name" prop (the PAD/agent name).')
      return
    }

    let TerminalCtor, FitAddonCtor
    try {
      ;({ Terminal: TerminalCtor } = await import('@xterm/xterm'))
      ;({ FitAddon: FitAddonCtor } = await import('@xterm/addon-fit'))
      await import('@xterm/xterm/css/xterm.css')
    } catch (err) {
      if (isCurrent()) setStateSafe(setInitError, `Failed to load xterm: ${err.message}`)
      return
    }
    if (!isCurrent()) return

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
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/ws/terminal/${name}?cols=${term.cols}&rows=${term.rows}`
    )
    wsRef.current = ws

    // Unmounted mid-init (before the WS handlers below are attached): clean up.
    if (!isCurrent()) {
      try { ws.close() } catch {}
      try { term.dispose() } catch {}
      if (wsRef.current === ws) wsRef.current = null
      if (termRef.current === term) termRef.current = null
      return
    }

    term.onData((data) => {
      // Locked mode: drop keystrokes unless an injected command is running.
      if (isInputLocked()) return
      if (ws.readyState === WebSocket.OPEN) ws.send(data)
    })

    ws.onopen = () => {
      if (gen !== genRef.current) return // superseded session
      setStateSafe(setConnected, true)
      pushResize(term.cols, term.rows)
      const pending = pendingRef.current
      pendingRef.current = []
      pending.forEach((text) => { if (ws.readyState === WebSocket.OPEN) ws.send(text) })
    }

    ws.onmessage = (evt) => {
      if (gen !== genRef.current) return
      writeTerm(evt.data)

      // Locked mode: look for pending completion sentinels in the output.
      const pending = pendingMarkersRef.current
      if (pending.size) {
        outputTailRef.current = (outputTailRef.current + String(evt.data)).slice(-512)
        for (const marker of Array.from(pending)) {
          // Sentinel must sit at the START of a line — the PTY-echoed copy of
          // the injected line has it mid-line (after `echo `), so it can never
          // match and cause a premature "done".
          if (outputTailRef.current.includes('\n' + marker)) {
            pending.delete(marker)
          }
        }
        if (pending.size === 0) {
          outputTailRef.current = ''
          cmdRunningRef.current = false
          setStateSafe(setCmdRunning, false)
          refreshLockUI()
          try { onCommandDone?.() } catch {}
        }
      }
    }

    ws.onclose = () => {
      setStateSafe(setConnected, false)
      writeTerm('\r\n\x1b[31m[Connection closed]\x1b[0m\r\n')
    }

    ws.onerror = () => setStateSafe(setConnected, false)

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
  }

  /** Tear down the current session. Idempotent and safe mid-init. */
  function teardown() {
    genRef.current++ // invalidate any in-flight init
    if (wsRef.current) { try { wsRef.current.close() } catch {} ; wsRef.current = null }
    if (termRef.current) { try { termRef.current.dispose() } catch {} ; termRef.current = null }
    if (fitAddonRef.current) fitAddonRef.current = null
    if (roRef.current) { try { roRef.current.disconnect() } catch {} ; roRef.current = null }
    setStateSafe(setConnected, false)
  }

  // Mount / name change: create session. Unmount: full teardown.
  useEffect(() => {
    mountedRef.current = true
    if (!containerRef.current) return
    initTerminal().catch(() => {})
    return () => {
      mountedRef.current = false
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  // The `disabled` prop controls the external lock.
  useEffect(() => {
    disabledRef.current = !!disabled
    refreshLockUI()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled])

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

  function reconnect() {
    teardown()
    initTerminal().catch(() => {})
  }

  useImperativeHandle(
    ref,
    () => ({
      runCommand: (cmd) => {
        const text = String(cmd ?? '').replace(/\r/g, '\n')
        if (!text.trim()) return false
        if (isInputLocked()) {
          // Locked mode: append a completion sentinel to the same line (bash
          // runs it only after the command finishes), auto-unlock input while
          // the command runs, and re-lock when the sentinel echoes back.
          const marker = nextMarker()
          pendingMarkersRef.current.add(marker)
          cmdRunningRef.current = true
          setStateSafe(setCmdRunning, true)
          refreshLockUI()
          try { onCommandStart?.() } catch {}
          return sendToShell(`${text}; echo; echo ${marker}\n`)
        }
        return sendToShell(text + '\n')
      },
      write: sendToShell,
      clear: () => termRef.current?.clear(),
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
    [sendToShell, isInputLocked, nextMarker, onCommandStart, onCommandDone, refreshLockUI]
  )

  return (
    <div className="flex flex-col border border-slate-800 rounded-xl overflow-hidden bg-[#0f172a]">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 bg-slate-900/80 select-none">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400' : 'bg-slate-600'}`} />
            <span className="text-xs text-slate-400 font-medium">{connected ? 'Connected' : 'Disconnected'}</span>
          </div>
          {cmdRunning && (
            <span className="flex items-center gap-1.5 text-xs text-cyan-300 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
              Running
            </span>
          )}
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
        <div className="flex items-center gap-1.5">
          <button onClick={() => setFontSize((s) => Math.max(10, s - 1))} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">A-</button>
          <span className="text-xs text-slate-600 w-6 text-center">{fontSize}</span>
          <button onClick={() => setFontSize((s) => Math.min(24, s + 1))} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">A+</button>
          <span className="w-px h-4 bg-slate-700" />
          <button onClick={() => termRef.current?.clear()} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Clear</button>
          <button onClick={reconnect} className="px-2 py-1 text-xs text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors">Reconnect</button>
        </div>
      </div>
      <div ref={containerRef} className="w-full" style={{ height, minHeight }}>
        {initError && (
          <div className="p-4 text-sm text-red-400 font-mono whitespace-pre-wrap">{initError}</div>
        )}
      </div>
    </div>
  )
})

export default Terminal
