# Terminal Component Review

## Scope

Reviewed the interactive terminal implementation:

- `src/client/src/components/Terminal.jsx`
- `src/client/src/pages/AgentDetail.jsx`
- `src/client/src/pages/agent/CommandsPane.jsx`
- `src/app.js` terminal WebSocket endpoint and tmux-session endpoints

The base design is good: one reusable xterm.js component, a real Docker PTY,
persistent tmux sessions, resize propagation, reconnect cleanup, and guarded
async initialization. The issues below are concrete gaps in the current
implementation.

## Findings

### 1. WebSocket terminal authentication can be bypassed

**Severity: Critical**

The Express `requireAuth` middleware only applies to normal HTTP requests.
WebSocket upgrade requests are handled directly by `WebSocketServer` in
`src/app.js`, so they do not pass through that middleware.

The WebSocket handler only checks authorization when a `vmf.sid` cookie is
present. If no cookie is supplied, it continues to create a terminal session.
An unauthenticated client that can reach the WebUI can therefore open
`/ws/terminal/<running-pad>` and execute commands in that PAD.

**Relevant code:** `src/app.js:60-69`, `src/app.js:1550-1592`

**Plan:**

1. Extract session lookup/validation from `middleware/auth.js` into a shared
   helper usable by HTTP and WebSocket code.
2. Require a valid session before Docker inspection, tmux setup, or terminal
   attachment, unless `AUTO_LOGIN=true`.
3. Preserve the existing owner check for non-admin users.
4. Add integration tests for no cookie, malformed cookie, owner session, and
   admin session WebSocket connections.

### 2. Timed vault-secret paste is racy and can expose the secret

**Severity: High**

`AgentDetail.run()` sends `stty -echo; <command>; stty echo` and then sends the
secret after a fixed 500 ms timeout. The terminal has no confirmation that the
command has reached its secret prompt. If startup is slow, the value can arrive
after the command exits and echo is enabled, becoming a visible shell command
or being delivered to an unrelated prompt.

**Relevant code:** `src/client/src/pages/AgentDetail.jsx:128-139`,
`src/client/src/components/Terminal.jsx:670-675`

**Plan:**

1. Remove the timer-based secret injection path.
2. Prefer a command-specific non-interactive secret mechanism where supported,
   such as an inherited environment variable or secure temporary input file.
3. If a command must prompt interactively, keep it in documented manual-entry
   mode rather than claiming vault paste is safe.
4. Ensure secrets never enter command history, activity logs, scrollback, or
   browser-visible text.
5. Test delayed prompts, failed commands, and another interactive program
   already owning stdin.

### 3. Pending input can be delivered to a different PAD or tmux session

**Severity: Medium**

`sendToShell()` keeps raw input in `pendingRef` until a WebSocket opens.
`teardown()` does not clear or scope this queue. If a user queues input during a
connection, then changes PADs or switches terminal sessions before the socket
opens, the next connection flushes the old input into the new target.

**Relevant code:** `src/client/src/components/Terminal.jsx:207-217`,
`src/client/src/components/Terminal.jsx:304-315`,
`src/client/src/components/Terminal.jsx:381-399`,
`src/client/src/components/Terminal.jsx:527-537`

**Plan:**

1. Store queued input with the terminal generation, PAD name, and session ID.
2. Flush only entries matching the current connection.
3. Discard pending input on explicit reconnect, session switch, and PAD change.
4. Retain queued input through a transient reconnect only for the same terminal
   identity.
5. Add regressions for switching sessions/PADs before `onopen`.

### 4. Wheel scrolling can become terminal arrow-key input

**Severity: Medium**

The observed behavior is consistent with xterm/tmux alternate-scroll mode:
when enabled by an application, wheel movement is converted into cursor
Up/Down escape sequences and forwarded by `term.onData()` to tmux. The
component has no explicit wheel policy, so normal scrollback navigation depends
on the current terminal mode.

**Relevant code:** `src/client/src/components/Terminal.jsx:267-302`

**Plan:**

1. Decide whether wheel input always scrolls local xterm scrollback or also
   supports applications that intentionally use mouse reporting.
2. If local scrollback is preferred, add a non-passive capturing wheel handler
   to the xterm viewport that prevents alternate-scroll input and calls
   `term.scrollLines()`.
3. Remove the handler during teardown so reconnects do not stack listeners.
4. Browser-test mouse wheel and trackpad scroll, shell history, tmux, and a
   full-screen TUI.

### 5. Escape cannot reliably exit fullscreen while the terminal is focused

**Severity: Medium**

Fullscreen Escape handling is registered on `window`. xterm owns the focused
keyboard event, so Escape can be handled by xterm and forwarded to tmux before
it reaches that listener. The current `attachCustomKeyEventHandler()` returns
`true` for every key, so it does not intercept Escape either.

**Relevant code:** `src/client/src/components/Terminal.jsx:374-378`,
`src/client/src/components/Terminal.jsx:473-481`

**Plan:**

1. Handle Escape in `attachCustomKeyEventHandler()` when fullscreen is active.
2. Call `setFullscreen(false)` and return `false` to prevent xterm from sending
   that Escape byte to the shell.
3. Keep normal Escape delivery unchanged outside fullscreen mode.
4. Browser-test Escape in fullscreen with a shell and a raw-mode TUI.

### 6. Clear removes the active tmux status bar as well as scrollback

**Severity: Low**

The Clear button calls `term.clear()`. xterm documents this as clearing the
entire buffer, making the prompt line the new first line. That removes the
currently rendered tmux status line (`[term-2] 0:bash*`) along with terminal
history until tmux next redraws it. This is expected xterm behavior, but it is
wrong for a control labelled Clear when the terminal chrome should remain
visible.

**Relevant code:** `src/client/src/components/Terminal.jsx:678`,
`src/client/src/components/Terminal.jsx:803`,
`node_modules/@xterm/xterm/typings/xterm.d.ts:1235-1238`

**Judgment:** Keep a clear-scrollback action, but it must preserve the active
screen. Do not send Ctrl+L as a generic repair because that changes the focused
shell or TUI program. Prefer the xterm escape sequence for erasing scrollback
only (`CSI 3 J`) and verify it retains the visible tmux pane and status line.
If that is not reliable for the supported xterm version, rename the existing
button to `Clear terminal` so its destructive screen-clearing behavior is
explicit.

**Plan:**

1. Replace `term.clear()` with a local scrollback-only clear operation.
2. Keep the terminal viewport, current prompt, and tmux status line intact.
3. Browser-test a normal shell, tmux status bar, and a full-screen TUI.
4. Verify browser accessibility output and the Clear button label match the
   final behavior.

### 7. Command history is redundant and reruns commands without context

**Severity: Low**

The clock-arrow button is not a shell-history viewer. It fetches the last 50
activity records with category `command`, displays only command text, and
immediately reruns the selected command as a tracked command. It does not show
timestamps, result status, session, source, or a confirmation step.

Live verification for `pad-openclaw-work-pls` returned 25 logged command
entries, and the popover rendered them. The button therefore works, but its
purpose is hidden and the information is less useful than tmux/shell history
or the existing Activity tab. Repeated preset commands also make the list
noisy.

**Relevant code:** `src/client/src/components/Terminal.jsx:614-634`,
`src/client/src/components/Terminal.jsx:787-797`,
`src/client/src/components/Terminal.jsx:855-881`,
`src/client/src/pages/AgentDetail.jsx:141-152`

**Judgment:** Remove the command-history button and its supporting terminal
state/API call. Tmux preserves per-session shell history for terminal users,
and the Activity tab remains the appropriate place to inspect the command audit
trail. Keeping this button adds a second, ambiguous history mechanism that can
rerun commands unexpectedly.

**Plan:**

1. Remove the button, popover, `history` state, and `loadHistory()` logic from
   `Terminal.jsx`.
2. Keep activity recording because the Activity tab uses it independently.
3. Verify terminal layout and header controls after removal.

### 8. Client and server multiplex control frames with raw terminal bytes

**Severity: Low**

The WebSocket handler attempts to `JSON.parse()` every client message. A user
who pastes a JSON document that looks like a resize frame can have that input
swallowed instead of delivered to the shell. This is unlikely through normal
keystrokes but makes the protocol ambiguous.

**Relevant code:** `src/client/src/components/Terminal.jsx:219-227`,
`src/app.js:1690-1703`

**Plan:**

1. Use a separate control-message framing format, such as a reserved prefix or
   binary/text message discriminator.
2. Treat every other text frame as exact shell input without JSON parsing.
3. Test that JSON pasted in the terminal reaches the shell unchanged.

### 9. Documentation no longer matches the implementation

**Severity: Low**

`plans/terminal-component.md` states that the `stty -echo` secret approach was
dropped because it races. The current code reintroduced it in `AgentDetail.jsx`.
It also documents a `bash -i` backend while the current backend attaches
persistent tmux sessions.

**Relevant code:** `plans/terminal-component.md:95-104`,
`src/client/src/pages/AgentDetail.jsx:134-138`, `src/app.js:1640-1644`

**Plan:**

1. Update the terminal plan after the secret flow is redesigned.
2. Document tmux attachment, session persistence, and the exact wire protocol.
3. Keep this review file as the implementation checklist until resolved.

## Scrollbar Investigation Addendum

### Current live result

Investigated `pad-openclaw-work-pls` on 2026-08-04 without sending terminal
input. The xterm viewport was 510 px high and rendered 30 terminal rows. Only
25 rows contained output, so `scrollHeight` equalled `clientHeight` (510 px).
There was no scrollback overflow and therefore no scrollbar to display yet.

The relevant configuration is healthy:

- xterm scrollback: `10000` lines (`Terminal.jsx`)
- xterm viewport: `overflow-y: scroll`
- tmux `alternate-screen`: `off`
- tmux `history-limit`: `2000`

The current absence of a scrollbar is expected until terminal output exceeds
all visible rows. The user-entered failed commands occupied 25 of 30 rows; they
did not yet fill the terminal window.

### Why it can appear intermittent

A terminal scrollbar only becomes meaningful after output has overflowed the
visible xterm buffer. Terminal height changes with the Commands layout,
fullscreen state, font size, and browser viewport, so the number of output
lines needed to create overflow changes too. A newly attached or recreated
main tmux session also starts with no browser-side xterm scrollback.

This is separate from the wheel-as-arrow-key issue: once the terminal has
actual overflow, wheel behavior still needs the explicit policy in Finding 4.

### Required Reproduction Test

1. Start from a newly attached main session and record the visible row count.
2. Generate more than that number of lines using a harmless command in a test
   session, not an operator's working session.
3. Confirm `scrollHeight > clientHeight` and that the viewport can move above
   the newest output using the scrollbar, mouse wheel, and trackpad.
4. Repeat after switching sessions, changing font size, resizing the dock, and
   entering/exiting fullscreen.
5. If output exceeds the viewport but `scrollHeight === clientHeight`, capture
   the xterm buffer mode and tmux `alternate-screen` option before changing
   code; that would be a real scrollback loss regression.

## Implementation Guidance

Follow these decisions unless the product requirements change:

### WebSocket authorization

- Reject the upgrade if `AUTO_LOGIN` is false and the `vmf.sid` cookie is
  missing, malformed, expired, or absent from `user_sessions`.
- Reuse one shared session-validation helper for Express and WebSocket code;
  do not duplicate SQL and authorization rules.
- Apply owner authorization before calling Docker or creating a tmux session.
- Close rejected sockets with a policy code and do not reveal whether a PAD
  exists or is running.

### Secret entry

- Do not send vault values after a fixed timeout and do not rely on `stty` to
  hide a delayed value.
- Prefer each CLI's non-interactive secret option. A secret file, when needed,
  must be created with mode `0600`, used once, and removed in a `finally` path.
- For a truly interactive-only command, show a clear manual-entry instruction
  and let the operator type it in the focused terminal.
- Never append secret-bearing commands or values to activity records, shell
  history, browser state, or terminal output.

### Reconnect queue

- Represent pending messages as `{ generation, name, sessionId, text }`.
- Flush only records matching the live socket identity.
- Explicit reconnect, PAD change, and session change discard pending records.
- A passive reconnect may retain matching records, capped at the existing
  bounded queue length.

### Input and display behavior

- In fullscreen, intercept Escape in xterm's custom key handler, exit
  fullscreen, and return `false`; outside fullscreen, leave Escape for the
  terminal application.
- Decide and document whether wheel input is local scrollback or application
  mouse input. For this dashboard, favor local scrollback and attach one
  capturing, non-passive viewport listener that is removed on teardown.
- Clear scrollback locally with `CSI 3 J`, not `term.clear()`, so the visible
  tmux pane, prompt, and status bar stay rendered. Verify this in the installed
  xterm version before shipping.
- Remove the command-history popover. Keep activity logging for the Activity
  tab and rely on tmux/shell history for command recall.

### WebSocket framing

- Do not attempt JSON parsing on arbitrary shell input.
- Prefix control messages with an unambiguous protocol marker or use binary
  frames for controls and text frames for terminal input.
- Reject malformed controls without forwarding them or affecting the terminal.

### Required Tests

- Add WebSocket integration tests for anonymous, invalid, owner, and admin
  sessions.
- Add component tests for queue identity, fullscreen Escape, wheel handling,
  and scrollback-only Clear.
- Browser-test the terminal with a normal shell, tmux status bar, and a
  raw-mode TUI after each input/display change.
- Test failure paths: delayed secret prompt, failed command before prompt,
  network reconnect during a session switch, and malformed control frames.

## Suggested Order

1. Close the WebSocket authentication bypass.
2. Remove the timer-based secret injection flow.
3. Scope queued input to its PAD/session/generation.
4. Define and implement wheel behavior.
5. Fix fullscreen Escape handling.
6. Make Clear preserve the active tmux screen.
7. Remove the redundant command-history control.
8. Separate control frames from shell bytes.
9. Update documentation and add focused browser/integration tests.

## Verification Checklist

- Anonymous WebSocket connection is rejected when auto-login is disabled.
- A non-admin user cannot attach to another user's PAD.
- A vault secret cannot be emitted when a prompt is delayed or missing.
- Switching PAD/session during connection cannot execute queued commands in the
  new target.
- Wheel and trackpad scrolling move scrollback without generating arrow-key
  input in normal shell use.
- Escape exits fullscreen without sending Escape to tmux.
- Clear removes scrollback but retains the current tmux status line and prompt.
- JSON pasted in the terminal reaches the shell verbatim.
