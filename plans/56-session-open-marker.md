# One dot, and a dot that means something

## Status: Complete (2026-09-27) — 8/8 checklist items done, built and verified live in the browser. Docs folded into `plans/53-mission-workspace.md` §9b; `docs/` absorb still pending the user's confirmation.

## 1. What the user asked for (verbatim, 2026-09-27)

> "In the sessions listing, we are showing open sessions differently. I don't want
> to list differently. Show the open session marker, the dot that you are showing
> besides the sessions that are open. That's it. Also the name of the session will
> have full row don't show the resume button don't show it is resumed or not I
> don't care I only care if it is session is open or not If there is work done
> inside it or not, that's it. Currently, that is also not correct. We are showing
> session is open just because our session is open in the terminal. But what if
> another chat is also open in web UI of open code and it is chatting and thinking
> and all? We won't ever detect that."

Three separate asks, and the third one is the real work:

1. **One marker only.** A row is either open or it is not. No `resumed` badge, no
   `agent` badge, no `resume` button, no per-row hint text. The name takes the row.
2. **The dot must mean "open", not "we can see our own terminal".**
3. **A session open in the opencode web UI — chatting, thinking — must show the
   dot too.** Today we would never detect that.

## 2. Why the current dot is wrong

`mission.withLive()` stamps `live` from **one `tmux list-sessions` per PAD**
(`services/mission.js:527`): the dot is green when a tmux session with that id
exists in the PAD. That is a statement about *our* tmux, and only about our tmux.
It cannot see:

- a conversation the user is running in the opencode **web UI** (`opencode web`,
  published by the Web tab) — that session has no tmux session at all, so it is
  invisible to us;
- any other opencode client (a second TUI, an SDK script, the MCP surface).

The result is exactly the complaint: a session that is *actively working* reads
as closed, while a session that merely *has a tmux session* reads as open.

## 3. The signal that does mean "open" — found and verified live

The opencode server already tracks this, and exposes it. Verified against the
running server in `pad-opencode-proj` (`opencode web --hostname 0.0.0.0 --port 7890`):

| probe | result |
|---|---|
| `GET /session` | 200, list of sessions — **no** busy/status field on the rows |
| `GET /session/status` | 200, `{}` when nothing is working |
| `GET /doc` (openapi) | 200, 162 endpoints |
| `GET /event` | 200 `text/event-stream` (SSE) |
| `GET /global/health` | 200 |

`components.schemas.SessionStatus` is `anyOf` three shapes, and the `type` enums
are exactly:

- `idle`
- `busy`
- `retry` (+ `attempt`, `message`, `action`, `next`)

So **`GET /session/status` returns `{ [sessionID]: { type: 'busy' | 'idle' | 'retry' } }`**
— server-side truth about the agent's own work, independent of which client
started it. A conversation the user is chatting with in the web UI is `busy`
there, and we can read it.

`retry` counts as open: the agent is still working on that session (waiting to
retry a provider call), so the dot belongs on. `idle` is the only "not open"
state the server reports, and we treat "absent from the map" the same way.

## 4. The rule

```
open = live(session)         // tmux session exists — we are watching it
    OR busy(agentSessionId)  // opencode says busy/retry — someone, anywhere, is working it
```

- **Mission session rows** (`mission_sessions`): `open = live || busy`, where
  `busy` is looked up by the row's `agent_session_id`.
- **History rows** (the agent's own conversations): `open = busy || resumedIntoLiveSession`,
  where the second term is "some live mission session has this
  `agent_session_id`". A row you have already resumed into a live session is
  open, and a row someone is driving from the web UI is open.
- **In the merged list the two collapse into one row.** A resumed conversation
  exists as a live row AND as a history row at the same time; merged, that would
  print it twice with two dots. History rows whose id is some live row's
  `agent_session_id` are dropped — the live row carries the tmux id col 3 needs.

A conversation that is neither busy nor attached to a live session is closed —
and clicking it opens it, which is the whole row's job.

## 5. How to reach the server (and how it fails)

The probe is `docker exec <pad> curl 'http://127.0.0.1:<containerPort>/session/status?directory=<folder>'`.

- **`?directory=` is the whole mechanism, not a filter.** Unscoped it answers
  `{}` even mid-turn — measured: an 8.2s turn, 25 polls during it, `{}` on every
  one. Scoped to the folder the turn runs in, the same poll returns
  `{"ses_…":{"type":"busy"}}` on the first try. A probe missing it looks like a
  working probe that always says "nothing is working", which is exactly the bug.
- **Port**: the PAD's *actual* published `web.containerPort`, **not** the driver
  default. The driver default is 8080; the server actually running here is
  **7890**, and hardcoding either reports "nothing is working" forever.
- **Grouping is by (PAD, folder), never by PAD alone** — three projects share
  `pad-opencode-proj`, so a PAD-keyed group asks about the first folder and
  stamps that answer on the others' rows.
- **A live row carries no folder**, so every call site must pass one. Without it
  each row silently reports `busy: false` — the same lie as a wrong port, and it
  survived the first browser check because the *history* rows were already right.
- **Auth**: `OPENCODE_SERVER_PASSWORD` (username always `opencode`) puts Basic
  auth on. The retry references `$OPENCODE_SERVER_PASSWORD` **from inside the
  container**, so the secret never appears on the host command line.
- **Agent type**: opencode only. `codex` / `claude` / `hermes` have no equivalent
  endpoint, so their rows fall back to mission liveness alone — a real gap, and
  why the flag is `busy`, never `open`.
- **Every failure is soft.** No server, wrong port, unsatisfiable auth, 5s
  timeout, unparseable body → empty set plus `known: false`, and the listing
  renders exactly as before. A probe must never fail a listing people keep open
  all day.
- **Cached 5s** per (PAD, folder), because the sessions and history endpoints are
  separate requests over the same 15s poll.

## 6. Checklist

- [x] `src/services/mission.js` — `agentWorkingSessions(vm, folder)`: probe
      `/session/status?directory=`, port from the PAD's `webService`, Basic-auth
      retry from inside the container, 5s TTL cache, soft-fail to
      `{ ids: ∅, known: false }`.
- [x] `withAgentBusy(sessions, agentOf, folderOf)` — grouped by (PAD, folder),
      stamps `busy` / `busyKnown` / `open` on flat rows;
      `withAgentBusyProjects` for the nested shape.
- [x] `withHistoryActivity(rows, project)` — history rows get `busy` plus
      `resumedIntoLiveSession`, so a row and its resumed twin agree.
- [x] `src/app.js` — all four list call sites chained, each passing a folder.
- [x] `SessionList.jsx` — one `msn-group-sessions` header, one merged list sorted
      by recency, duplicate conversations collapsed, `resumed`/`agent` badges and
      the `resume` hint deleted, name owns the full row, live row's second line
      shows *when* instead of the tmux id.
- [x] Close-confirm rendered inside its own row so it cannot outlive the row.
- [x] `paneGone` and `open` split: a busy conversation with a dead pane is lit
      and says so, not styled dead.
- [x] Verified live in the browser (below).

## 7. Verification

Measured, not assumed:

- The probe is the reason the feature works: a conversation driven through the
  web UI's own `POST /session/:id/message` path — no tmux session anywhere —
  went from `busy=false` to `busy=true open=true` in the Mission API within
  ~1.2s of the turn starting.
- The user's own case, unprompted: in the `paddock` project the server reported 4
  busy sessions, and the browser showed 4 lit dots with the tooltip "the agent is
  working on this conversation right now" while **both** of that project's tmux
  sessions were dead. Nothing in that column's lighting came from our terminal.
- Merged list: 55 rows in one group, 0 `resume` strings, 0 `resumed`/`agent`
  badges, duplicates collapsed.

## 8. Decisions taken, so they can be argued with

- **The `project` badge stays in the all-projects scope.** It is an identity
  label, not a state marker: without it, rows from different projects are
  indistinguishable in one list.
- **`live` keeps its meaning** for the terminal logic (it decides Relaunch vs
  Restart, and the "session is gone" state). The dot composes it with `busy`
  rather than redefining it, so nothing else in col 2 or col 3 changes meaning
  when the server is unreachable.
- **Recency, not state, orders the list.** Sorting by "open first" would be one
  more way of listing differently, and it would reorder the column under the
  cursor every time a row's dot came on. `last_seen_at` (touched by the terminal
  as you use a session) rises in the list on its own.
- **No per-row `paneState` calls.** One `/session/status` + one `list-sessions`
  per (PAD, folder) per poll.

## 9. Known limits

- An **idle** conversation open in the web UI is not detectable — the status map
  is a live-work registry that empties when the turn ends, and the server offers
  no client/connection registry. The dot means "working now, or live in our own
  terminal".
- **opencode only.** Other agent types keep tmux liveness alone.

## See Also

- `plans/53-mission-workspace.md` — the Mission workspace this changes (§6 the
  `msn-*` element map, §9a the terminal defect log, **§9b** this change).

