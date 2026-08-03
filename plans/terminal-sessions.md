# Terminal Sessions — Persistent, Multi-Session Shells

## Status: Proposed (2026-08-03)

## Goal

Two things:

1. **Persistence** — whatever you run in the terminal is still there after a
   page reload.
2. **Multiple sessions** — since one persistent terminal would trap the user in
   a single shell, each PAD gets multiple named sessions (tabs), switchable from
   a dropdown in the terminal header next to the "Terminal Connected" status.

## Why sessions are gone today

`/ws/terminal/<name>` spawns a one-shot `docker exec bash -i` with a real PTY
(`Tty: true`). When the WebSocket closes, cleanup **destroys the hijacked
stream**, which makes Docker kill the exec process. Result: one terminal per
PAD, state lost on reload, no way to have two shells.

## Approach: tmux inside the PAD container

- A `tmux` server runs as a detached process inside the PAD container,
  independent of the openclaw gateway (PID 1).
- **Each terminal session = one tmux session.** The WS handler just attaches:
  `container.exec({ Tty: true, Cmd: ['tmux', 'attach-session', '-t', <id>] })`.
- Closing the WebSocket kills only the attach client (a clean detach); the tmux
  session and its scrollback keep running.
- On reload / switch, the client **reattaches and tmux replays the pane
  history**, so previous commands, output, and even running TUIs (opencode,
  htop) come right back.
- Multiple sessions = multiple tmux sessions, one picked at a time via the
  dropdown. Two browser tabs can even attach to the same session (tmux
  multi-attach) for a watch view.
- Sessions live in the PAD container, so they survive **webui restarts**. They
  die when the PAD is stopped/restarted (documented; auto-recreated on next
  attach).

## tmux availability (verified: NOT installed)

- Current image has no tmux (`exec: "tmux": executable file not found`).
- Add `tmux` to the apt list in `src/vm-builds/openclaw/Dockerfile` → new builds.
- Existing PADs (`pad-openclaw-nice`, `pad-openclaw-work-pls`) get a **lazy
  runtime install** on first session op: `apt-get update && apt-get install -y
  tmux` inside the container, cached per PAD name in the webui process.

## UI — header dropdown (next to "Terminal Connected")

- Trigger shows the **current session name** (default `main`).
- Items: all active sessions (current one highlighted), a "+ New session" entry,
  and a per-item close (confirm → `tmux kill-session`).
- Selecting a session = teardown + reconnect to that session id.
- Selection persisted in `localStorage` as `pad-term-session-<agent>`; a reload
  returns to the same session. If it no longer exists (PAD restarted), the
  backend auto-creates it.

## Naming

- Default session: `main`. New sessions: next free `term-1`, `term-2`, ...
- Session names validated against `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$` (they go
  into tmux flags and the WS URL).

## API changes

- `GET /api/agents/:name/terminal-sessions`
  → `{ sessions: [{ name, attached }] }` from `tmux list-sessions -F`.
- `DELETE /api/agents/:name/terminal-sessions/:id`
  → `tmux kill-session -t <id>`.
- WS URL: `/ws/terminal/<name>?session=<id>&cols=<n>&rows=<n>` (`session`
  optional → `main`).
- Backend connect flow: ensure session exists (`tmux has-session -t <id>`,
  else `tmux new-session -d -s <id> -x <cols> -y <rows>`), then attach. Create
  with the WS cols/rows as the initial size; later resizes go through the
  existing `exec.resize()` → SIGWINCH → tmux resizes the window.
- **Colored PS1 gotcha:** processes created by `tmux new-session` inherit the
  tmux **server** env, not the attach exec env — the `PS1` on the current exec
  is ignored. Append the colored PS1 to `/root/.bashrc` (idempotently) at first
  session setup so the prompt stays cyan.

## Backward compatibility

- No `session` param → `main`, auto-created. Existing single-terminal behavior
  is preserved; `Terminal.jsx` consumers (AgentDetail, Health) don't change.
- `runCommand` / `pasteSecret` / sentinels / lock mode are unchanged — they just
  write to the tmux PTY now.

## Gotchas / races

- Create-then-attach is TOCTOU-prone: if `new-session` fails with "duplicate
  session", fall through and attach anyway.
- `reconnect()`'s confirm text currently says "scrollback will be cleared" —
  with tmux that is no longer true; update the wording.
- PAD restart wipes all sessions → dropdown degrades gracefully to `main`.
- tmux history-limit should be bumped to 10000 to match xterm's scrollback.

## Verification

1. Rebuild SPA + restart webui; open a PAD's Commands page.
2. Run a few commands → reload the page → prompt + output restored.
3. "+ New session" → independent shell; switch back and forth; state is
   independent in each.
4. Close a session → gone from the dropdown; closing the current one falls back
   to `main`.
5. Run a TUI (opencode) → reload → it fully re-renders.
6. Stop/start the PAD → sessions gone; next attach auto-creates `main`.
7. Terminal status + dropdown behave when the PAD is stopped (no errors).
8. No console errors; tabs switch without breaking the WebSocket.

## Out of scope (v2)

- Rendering multiple terminals side-by-side (dropdown switching covers the ask).
- Session rename / per-session color tags.
- Auto-restoring sessions after a PAD restart (tmux-resurrect-style entrypoint hook).
