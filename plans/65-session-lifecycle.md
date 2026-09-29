# Plan 65 — Session lifecycle: the surface can resume a conversation but never read or end one

## Status: Complete (2026-09-29) — 6/6 build items shipped, 1 deliberately held back. Source: `friction/2026-09-29-task-session-status.md`, `2026-09-27-tool-surface-sweep.md`, `2026-09-28-pm-portfolio-intake.md` (1 blocker + 5 guessing entries).

**Shipped:** 1f (idempotency key + partial unique index), 1a (`lastScreen` /
`screenFrom` / `lastScreenAt`), 1b (`endedAt` / `endedBy`), 1c (the three null
timestamps via `dbStamps`), 1d (`recreate` reporting + `sessionsEnded`), and the
three 1e verbs `mission_session_close` / `_relaunch` / `_restart`.

**Held back on purpose:** `mission_project_delete`. It is the fourth 1e verb and
the one that can end OTHER people's live sessions, so it still needs an explicit
yes — everything else in 1e is in and green.

**Read the findings before trusting the line numbers.** 1e names `mission_send`'s
dead-session error as pointing at `mission_session_close`; today it says *"restart
it to get a fresh TUI"* in prose. The finding's *shape* still holds — the error
points at a capability the tool surface has no verb for — and 1e is now
answerable because `relaunchTui`/`restartSession` already exist in the service
(they are the page's two recovery buttons), so the MCP half is the missing side.
Also note `state: "dead"` already exists (plan 62 1a), so 1b is only `endedAt` +
`endedBy`; and §4's warning to back up `app.db*` before `mission.test.js` is
STALE — that suite sets `PAD_DB_PATH` to a throwaway file now (AGENTS.md).

Liveness (plan 62) answers "is it alive right now?". This plan answers the other
three questions a caller has about a session's **life**: what happened to it, when,
and how do I end it deliberately rather than by `recreate`.

## 1. The findings

### 1a. The surface can resume a conversation but never read one (blocker)

`mission_session_start {agent_session_id}` resumes an agent conversation. **No tool
can read one.** A dead session's chat is unreachable: `mission_sessions {session_id}`
returns `screen: ""`, `agent_logs` reads the *container*, and the `agent_session_id`
on the row is the only handle — with nothing to spend it on.

**Fix:** persist the pane tail with the session and return it for dead rows —
`lastScreen` captured at teardown, the same buffer `screen` already uses. That one
change makes a dead session reviewable and turns `screen: ""` from ambiguous into
honest. Failing that, `mission_session_start` echoes
`resumedFrom: {agent_session_id, lastSeenAt, messageCount}` so a caller can tell a
restored context from a fresh one without reading the agent's self-report.

### 1b. Nothing in the surface dates a session's death (guessing)

No `endedAt`, no `endedBy`. A caller reconstructs it by diffing 29 rows.

**Fix:** `endedAt` + `endedBy: "recreate" | "exit" | "gone"` written at teardown,
next to the existing `lastScreen` buffer. Then `mission_sessions` carries a terminal
`state: "dead"` with both.

### 1c. `get_agent` returns three null timestamps on a running pad (guessing)

`created_at: null, updated_at: null, last_activity_at: null` — hardcoded in
`services/agent-registry.js:243-245`. A running container with three null timestamps
is a bug in its own right, independent of sessions.

**Fix:** populate them (instance dir mtime / DB row / last log line, whichever is
honest). Do **not** invent values — if one genuinely has no source, drop the field
rather than emit a null that reads as "never".

### 1d. `recreate` silently destroys every session on the pad (guessing)

Every tmux session on that PAD dies with the container. Nothing — not the tool
description, not the response, not any other tool — says so. (Confirmed the hard way:
deleting a Mission project kills that **agent's** tmux sessions, including live
conversations the user was looking at. AGENTS.md.)

**Fix:** (1) the `recreate` description states it plainly and names the response
field; (2) `recreate` reports what it took as
`sessionsEnded: [<session_id>, …]`; (3) with 1b, the rows are then dated and the
cost is askable in one call.

### 1e. The dead-session error points at a capability the tool surface does not have (guessing)

`mission_send` on a dead session says *"use `mission_session_close`"* — a tool that
does not exist. The caller is sent to a name.

**Fix:** add the missing verbs — `mission_session_close`, and `relaunch` / `restart`
for the dead case (live pane without a TUI → **relaunch**, keeps the conversation;
no tmux session at all → **restart**, recreates with `-c <project.folder>`, same tmux
id, same `agent_session_id`, refusing with `mission_folder_missing` rather than
starting in the wrong directory) — plus `mission_project_delete`. If the user
prefers not to add the surface, the error points at the page instead. **Ask.**

Note: these are the two recovery paths the Mission **page** already has as
`POST .../relaunch` and `POST .../restart`. The MCP tool side is the missing half,
and it must refuse the same way the page does.

### 1f. `mission_session_start` can time out and still create the session (blocker)

The call times out, the natural response is to retry, and the retry creates a second
session. The tmux session and the row exist well before the pane is live.

**Fix:** return the session id before the TUI finishes coming up (or a
`job_status`-shaped handle), and make the timeout message say *"may still have
started — list the project's sessions before retrying"*.

### 1g. The two list reads a caller makes are ordered differently (guessing)

Covered by plan 62 §1d (detail-mode parity). Listed here only because 1a/1b change
what the detail block returns. **Do not implement twice.**

## 2. Build order

- [x] **1f** — the timeout that creates duplicates. Smallest, most destructive when
      it fires. **Designed: an idempotency key, not a faster call.** A timeout is
      the CLIENT's, not ours — the server cannot shorten it, and the response
      cannot help because a timed-out call has no response. So the recovery has to
      live in the RETRY: `mission_session_start {idempotency_key}` re-finds the row
      it already made instead of making a second one. Anything else ("list the
      project first") is a race the caller can still lose. Shipped with a partial
      unique index so a CONCURRENT retry is deduped by the database too — the
      in-process pre-check alone loses that race, and the second caller then gets
      the row back with `deduped: true` and never touches tmux.
- [x] **1a + 1b** — `lastScreen` + `endedAt`/`endedBy` (the `state: "dead"` half
      already exists, plan 62 1a). `screenFrom` is what makes an empty screen
      readable: `live-pane` / `last-captured` / `none`.
- [x] **1c** — the three null timestamps.
- [x] **1d** — the `recreate` description + `sessionsEnded` (rides on 1b).
- [~] **1e** — the missing verbs. **Ask the user first**: it grows the surface by
      up to four tools, and the alternative (point the error at the page) is honest
      and free. **Three of four shipped** (`_close`, `_relaunch`, `_restart`).
      `mission_project_delete` is still held: it can end other users' live
      sessions, so it wants an explicit yes rather than a plan checkbox.

**One design note that decides 1a/1b/1d together.** There is no teardown hook:
tmux does not tell the webui that a session died, and the container that owned it
may be gone before we could look. So `lastScreen` is stamped from the reads that
ALREADY capture a pane (`noteOutput`, called by `screen()` and by the send
confirmation) — the last screen we were ever shown, kept with the clock that says
how old it is. A screen with no age is a lie, because "the last thing it said" and
"the last thing it said three hours ago" are different answers. Likewise
`endedAt` means **first observed gone**, never "the moment it died" — the only
deaths we can date exactly are the ones WE cause (`recreate`), and those say so.

## 3. Contracts to keep

- The terminal WS may lazily re-create a missing tmux session, which resurrects a
  **closed** session as a bare shell — `mission.getSessionByTmux()` in the connect
  path is the guard (no DB row → refuse, close 4002). **Any new attach path for
  `msn-*` needs the same guard**, including the new `relaunch` / `restart` verbs.
- `restart` recreates with `-c <project.folder>` and must `test -d` the folder
  inside the PAD first (`padTmux.folderExists`) — `tmux new-session -c <dir>` does
  **not** fail on a missing directory, it silently starts in the parent
  (AGENTS.md, verified live).
- Multi-client: a second tab must not kick the first. The three rules in the
  terminal WS (connect skips the supersede close, connect skips the sweep, cleanup
  sweeps only when the last client leaves) apply to any new attach path.

## 4. Verify

- [x] `node --test src/test/mission.test.js` green — **97/97**. (The old warning
      here is stale and was already noted as stale: that suite sets
      `PAD_DB_PATH` to a throwaway file, so it no longer wipes Mission tables and
      needs no `app.db*` backup.)
- [x] `node --test src/test/mcp.test.js` green — **134/134**.
- [x] The same suites green against an **exact staged snapshot**
      (`git checkout-index -a --prefix=…`, with `src/node_modules` linked), not
      just the worktree.
- [x] Mutation controls: the old `null`-everywhere clock goes red `1/4`, and
      removing the `endedAt` check makes the close tests red. A green run of a
      clock test proves only that the column exists somewhere.
- [x] **Live, on the real fleet, non-destructively.** The migration ran on the
      production DB and back-filled nothing (correct: an invented death date is
      worse than none) — the 36 pre-existing dead rows were stamped `gone` by the
      FIRST READ that observed them, which is the contract. A detail read of a
      real corpse returns `endedAt`, `endedBy: "gone"`, `screen: ""` **with
      `screenFrom: "none"`** (honest, rather than a blank that could mean either
      "said nothing" or "we never captured"), and `canSend: false`.
- [x] A `mission_send` on that row refuses with `mission_session_dead` and names
      a tool that EXISTS (`mission_session_restart`).
- [x] `mission_session_close` on an already-dead row refuses and does **not**
      re-date it — verified by re-reading the row afterwards and confirming
      `endedBy`/`endedAt` are unchanged.
- [ ] **Not done: a live `recreate` of a real PAD.** It is the one check left, and
      it is left because every Mission pad here is carrying someone's live
      conversation. The `recreate` → `endSessionsForPad` → `endedBy: "recreate"`
      path is covered by unit tests, but that is a claim about a test, not a
      measurement. Whoever runs it should use a throwaway pad (`test-agents`).

### 4a. Two things this shipped that are worth not undoing

- **`endedBy: "gone"` is an UPPER BOUND, not a time of death.** The only exact
  deaths are the ones we cause (`recreate`, `closed`); a row stamped `gone` was
  alive at its last probe and already dead when we looked. Both the tool
  description and the guide say so in words, because a caller reading it as a
  timestamp will be wrong on every single `gone` row.
- **A refused `close` must not stamp anything.** "Close a corpse" is the exact
  request that would otherwise overwrite `gone` with `closed` and destroy the only
  evidence of what actually happened to it.
