# PM Intake — "you are a project manager, manage the pads"

**Date:** 2026-09-28
**Mode:** chat test (MCP only — no shell, no API, no backend code). The user
changed my role for this session from "test harness" to "project manager
managing the pad portfolio", and chose that the PM role sits **on top of** the
harness rather than replacing it: real portfolio management, findings still
logged here. No deviations.
**Task:** "you're a project manager as a role, to manage pad you have to be in
the shoes of a project manager" — i.e. take over the fleet and run it.

Outcome: the portfolio is mostly healthy and **two pads are hard-blocked by a
stale network-namespace bind, not merely stopped**, with a third carrying the
same fault in latent form while it runs. The remediation is one `recreate` and
one `start_agent`, both gated on the user's approval. Two tool findings: the one
field that reports peer health contradicts the rest of its own response, and no
tool reports whether a pad's network peer is alive.

## Findings

### `networkHealth` reports `state: "stale"` for a peer the same response calls `running`

- **Tool:** `settings_get`
- **Severity:** guessing
- **What I asked:** read the portfolio's settings, to see which network peers
  exist before promising anyone a fix.
- **What happened:** one response, two irreconcilable statements about the same
  peer. The declared setting is `"network": "gluetun-nordvpn2"`, and
  `networkHealth` says:
  `"state": "stale", "networkMode": "container:33b5eff0d73b2dad557fa69d5fb506a875d3f8d5e582db83d650db31d20348a6", "peerId": "33b5eff0…", "peerName": "", "peerState": ""`
  — state stale, and both the peer's **name** and its **state** empty. In the
  same payload, `availableNetworks` contains
  `{"name": "gluetun-nordvpn2", "state": "running", "isCurrent": true}`.
  `isCurrent: true` is the link between the two blocks: the entry the liveness
  list calls current is the one the health block cannot resolve.
- **Why it hurts:** `networkHealth` is the only field in the entire surface that
  answers "is this pad's network binding still valid?" — which is precisely the
  question you must answer before restarting or recreating a VPN-peer pad, and
  precisely the question whose wrong answer kills a second pad. Here it says
  "stale, unresolvable" about a peer the same call reports as running. A caller
  has to pick which block to believe, and neither is marked authoritative. The
  pad this came from is **running right now**, so this is not a corpse reading:
  it is the state of a live pad with a live-looking peer.
- **Fix:** resolve `peerName`/`peerState` from the same lookup that builds
  `availableNetworks` instead of returning empty strings, and make `state` agree
  with it — if the named peer resolves and is running, `state` should not be
  `stale`. If the staleness is about the *bound ID* differing from the current
  peer ID, say so (`staleBinding`, plus both names) rather than reporting the
  peer as unnameable.
- **Resolution (2026-10-09, verified live):** fixed exactly as this entry asked.
  `settings_get.networkHealth` now returns `state: "staleBinding"`,
  `staleBinding: true`, populated `peerName` / `peerState` / `peerCurrentId`, and
  a `reason` that states the condition itself: *"Bound to peer container
  '7048372a96b6…', which no longer exists, but the configured peer
  'gluetun-nordvpn2' IS running and needs nothing. Recreate to rebind."* (seen on
  `pad-opencode-aic`, `pad-opencode-paddock-dev`, `pad-opencode-user1`). A healthy
  peer reads `state: "ok"`, `staleBinding: false`; `checked` and `reason` are
  present either way. The empty `peerName`/`peerState` strings are gone.

### No tool reports whether a pad's network peer is alive, so `health`'s "recreate to rebind" is an unverifiable instruction

- **Tool:** `health` + `settings_get`
- **Severity:** guessing
- **What I asked:** two dead pads report `expected: "container:gluetun-nordvpn2"`
  / `actual: "container:7048372a96b68d87…"` with the hint *"Container is bound to
  a different peer than the compose file. Recreate to rebind."* Recreate to
  rebind — **to what?**
- **What happened:** the tool that raises the problem never says whether the peer
  it wants me to rebind to still exists. Its own `container` check confirms the
  symptom and nothing more: `stopped (joining network namespace of container: No
  such container: 7048372a96b68d8789805203296bf3bf4c02a3f9a54ffef0a62ba83d355d5a03,
  exit code 143)`. A 64-hex container ID is not something a caller can act on,
  and no field maps it back to a name. To learn whether `gluetun-nordvpn2` was
  even alive I had to leave the pad I was triaging and call `settings_get` on a
  *different, unrelated* pad (`pad-opencode-user1`) to read its
  `availableNetworks` — a peer-picker list capped at 10 out of
  `availableNetworksTotal: 46`, flagged `availableNetworksTruncated: true`, which
  is a candidate list and not a liveness API.
- **Why it hurts:** the two outcomes are opposite decisions with the same hint.
  If the peer is dead, recreate rebinds to a container that still is not there and
  the pad dies again — you have burned a multi-minute image build to learn
  nothing. If the peer is alive, recreate is the fix. The tool collapses them and
  the only way to tell them apart is a cross-pad read of a truncated list. For a
  pad I am trying to recover, that is the difference between a plan and a
  gamble.
- **Fix:** add a `peerState` (and resolved `peerName`) to the `network` check in
  `health` — e.g. `expected: container:gluetun-nordvpn2 (running)` / `actual:
  container:7048372a… (gone)` — so the hint is actionable in place. Failing that,
  make the hint state the condition it applies to: *"Recreate to rebind — the
  declared peer `gluetun-nordvpn2` is running"* vs *"…is not running; start or
  recreate the peer first."*

### A dead session reports `busy: true` and `open: true` — the board shows work in progress that cannot be reached

- **Tool:** `mission_projects` + `mission_sessions`
- **Severity:** blocker
- **What I asked:** the user redirected me to the project board — *"u have projects,
  in these projects there are sessions that are the tasks that are being done …
  dont goto read the project yourself instead manage it."* I listed the board to
  see what work is in flight.
- **What happened:** one row in project `test` reports all three at once:
  `"id": "msn_0cd949d11a722500", "label": "Single-Word OK Response",
  "origin": "human", "locked": false, "live": false, "busy": true,
  "busyKnown": true, "open": true`, and the project header agrees —
  `"sessionCount": 3, "liveCount": 0, "openCount": 1`. So the **project is
  reported as having zero live sessions while still counting one open session
  and one busy session.** `live: false` means the tmux pane is gone, and
  `mission_send` into a row in that state refuses with `mission_session_dead`
  ("This session is gone — restart it to get a fresh TUI") — and, as recorded in
  the Mission finding below, there is no tool that can restart it.
- **Why it hurts:** this is the one row on the board that looks like in-flight
  work to every reader, and it is the only row nobody can pick up. As a manager
  reading the board I would either wait on it forever or chase a teammate for a
  status that does not exist. `busy` and `live` are documented as independent
  signals (`open` = live OR busy), so the combination is "legal" by the docs —
  but nothing marks that a `busy: true, live: false` row is **unreachable**
  rather than merely idle. `liveCount: 0` next to `openCount: 1` in the same
  header is the contradiction that gives it away, and nothing in the row points
  at it.
- **Second symptom, same field, opposite direction (2026-09-28, same file).** The
  user then asked me to manage the board, and `busy` was wrong the other way:
  `msn_7bd6899aa46c4985` reports `busy: false, busyKnown: true, open: false`
  while its pane tail is full of in-flight `browser_Runtime_evaluate` /
  `browser_Target_sendCommand` calls and **no closing assistant text** — a turn
  visibly mid-flight. So `busy` is unreliable in both directions: `true` on a
  corpse, `false` on a working turn. The only field that told the truth on all
  five sessions I triaged was the pane tail in detail mode. A caller triaging a
  board from list mode is working from a field that is wrong in both directions.
- **Fix:** when `busy` is true, require `live`; if a session is not live, report
  `busy: false` and set a terminal state (`dead`) with `wasBusy` preserved for
  forensics, so `open` never counts a row that `mission_send` will refuse. The
  project header should not report `openCount > liveCount` without saying why.

### A row can be `live` with a shell in it and no agent — `mission_send` would run your text as commands

- **Tool:** `mission_sessions` (detail) + `mission_send` (description)
- **Severity:** blocker
- **What I asked:** status-check the live-but-idle sessions in the `paddock`
  project, as a manager would. Five rows, all `live: true`, all `busy: false`.
- **What happened:** one of the five, `msn_e278a50d582a6984` (label "Greeting",
  `origin: human`, `agent_session_id: ses_f16d105ffffeOTjuUT81T3XJQ2`), reports
  in detail mode:
  `"state": {"live": true, "tuiAlive": false, "command": "bash", "cwd": "/www2/paddock"}`
  and its screen is a **root shell**, not an agent:
  `root@00d6bbd73811:/www2/paddock$ apt update && apt install nano`. The human
  is hand-installing an editor, ^C-ing repeatedly and hanging on
  `0% [Waiting for headers]`. Note the row still carries an
  `agent_session_id` and still counts toward the project's `sessionCount: 7` /
  `liveCount: 5` / `openCount: 5`, and the board labelled it "Greeting" as if it
  were a conversation.
- **Why it hurts:** `mission_send` types text and submits it with Enter. Into
  `command: "bash"` that text is **executed by the shell**. My status request
  would have run as commands — `status`, `update`, `please` — inside a live root
  shell, in the one project (`/www2/paddock`) that every other session on the
  fleet is working in. Nothing in list mode distinguishes this row: it is
  `live: true`, `locked: false`, `busy: false`, has a label, and has an
  `agent_session_id`. Only detail mode reveals `tuiAlive: false` and
  `command: "bash"`, and there is no guard in `mission_send` for a pane that is
  not an agent TUI. The label being a word like "Greeting" actively invites the
  mistake — it reads as a chat, and it is a terminal.
- **Fix:** `mission_send` must refuse a pane where `tuiAlive` is false or
  `command` is not an agent binary, with a code like `mission_not_an_agent`
  naming `command` — "this session is running `bash`, not an agent; use the
  terminal directly". And list mode should carry enough to avoid the trap
  (`tuiAlive`, or a `kind: "shell" | "agent"`), because the current contract
  pushes the caller toward a destructive action before the safety information
  is visible.

### A live session parked on a permission prompt is indistinguishable from idle, and `mission_send` cannot answer it

- **Tool:** `mission_sessions` (detail) + `mission_send` (description)
- **Severity:** blocker
- **What I asked:** the user told me one session was running and named it; I read
  the one live session I had not yet opened, `msn_e8b018ae6900016a`
  ("File Viewer Navigation for Non-Video Files", project `schlorp`,
  `/www1/xdl`).
- **What happened:** the pane is sitting on an interactive permission dialog:
  `△ Permission required / → Read .env / Path: .env / Allow once   Allow always
  Reject   ⇆ select  enter confirm`. The row is `live: true, busy: false,
  busyKnown: true, open: true` — the same shape as the four genuinely idle
  sessions, and nothing anywhere says it is blocked on a human.
- **Why it hurts:** two separate problems in one pane. First, triage: a blocked
  session is invisible as blocked — the board's only work signal is `busy`, and
  waiting-for-permission is indistinguishable from waiting-for-instructions, so
  this session looks like free capacity to any manager reading the board.
  Second, and worse, the obvious fix is unsafe. `mission_send` types text and
  submits it with **Enter**, and Enter is precisely the confirm key on this
  dialog — while the selection is moved with `⇆`, whose current position the
  surface does not report. So the way to "unstick" a permission prompt is to
  type text into a selector and press Enter, which confirms **whichever option
  happens to be selected**. On this dialog the options are `Allow once`,
  `Allow always`, and `Reject` for a **`.env` read** — a blind confirm can grant
  persistent access to a secrets file. There is no `mission_answer` tool and no
  way to read the current selection, so the surface offers no safe way to
  resolve a prompt it can create.
- **Fix:** (1) report a pending permission prompt as its own state
  (`blockedOn: "permission"`, with the tool and path) so it stops looking like
  idle capacity; (2) refuse `mission_send` into a pane showing a permission
  dialog with `mission_permission_pending`, and expose a
  `mission_permission_answer {session_id, choice}` that targets
  `Allow once` / `Reject` explicitly and refuses `Allow always` from an agent
  caller.

### After a write, nothing tells you which project you are in — and the label is not a substitute

- **Tool:** `mission_send` + `mission_session_start` + `mission_sessions`
- **Severity:** guessing
- **What I asked:** the user's standing instruction — *"you have projects, in
  these projects there are sessions that are the tasks that are being done"*
  — and then *"of course if you don't mention the project the response should
  tell you what session is from what project."*
- **What happened:** that is the right contract and the write path does not meet
  it. `mission_send` answers `{ok: true, sent: {lines: 1}}` — no project, no
  session label, no cwd, nothing to orient by. `mission_session_start` answers
  with `state: {live, tuiAlive, command, cwd}`, where `cwd` is a **folder path**
  (`/www1/craftpip.com`), never a project name. The read paths do carry it
  (`mission_sessions` rows and detail both include `project: {id, name}`), so
  the information exists — it is simply absent from every response that follows
  an action. The only handle that survives a write is `session_id`, which
  resolves to a project only if you make another call.
  The natural substitute, the `label`, is not reliable: it is fixed at
  `mission_session_start` and never re-synced to the agent's own auto-title.
  Among 22 sessions I read today, **two have `label: ""`** (`msn_311918f`,
  `msn_7bd6899` — both live and both doing real work), one is labelled
  **"Greeting" while actually running a root bash shell** (`msn_e278a50d`), and
  **four** share the identical label "Delayed Smooth Video Auto-Centering"
  around a single `agent_session_id`. So `label` is empty, stale, or duplicated
  often enough that it cannot stand in for project identity.
- **Why it hurts:** this is what made today's board unanswerable. I was told a
  session named "starting infinite queue" was running. It is in none of the 22
  sessions, and none of the 4 tasks — and I could not fall back on labels
  either, because labels in this fleet are routinely blank or stale, so
  "search by label" finds nothing even when the work is right there. A caller
  that sends work into a session and gets back `{ok: true}` cannot tell, from the
  response, which of six projects it just touched; and a caller holding a name
  from a colleague has no field to match it against. The board is only
  reconstructable by re-listing everything and re-deriving, which is exactly the
  re-derivation the surface should have summarized.
- **Fix:** echo `project: {id, name}` and the resolved `session_id` in
  `mission_send` and `mission_session_start` success responses, and in every
  Mission error. Independently, refresh `label` from the agent's session title
  when it changes (and expose the live title as its own field, e.g. `title`,
  leaving `label` as the operator-set name) — an empty or stale label is worse
  than no label, because it looks like an answer.

## Portfolio state as read (context, not findings)

13 pads, 10 running, 3 exited. Every exited pad is `exit code 143` (SIGTERM) —
deliberate stops, not crashes.

| Pad | health | Diagnosis |
|---|---|---|
| `pad-codex-wstest` | 7 ok / 0 warn / 1 error | Clean stop. Default network, no ports declared, no peer. `start_agent` is the whole fix. |
| `pad-opencode-aic` | 7 ok / 1 warn / 3 error | Hard-blocked. Peer `gluetun-nordvpn2` alive, bound ID dead. Door gone; 65124, 43850, 8009 unbound. Needs `recreate`. |
| `pad-opencode-paddock-dev` | 7 ok / 1 warn / 3 error | Hard-blocked. Peer `gluetun-proton1` alive, bound ID dead. Door gone; 8687, 8008 unbound. Needs `recreate`. |

`pad-opencode-user1` is running but reports `networkHealth.state: "stale"` with a
bare bound ID — the same condition that killed the two above, one peer restart
away from repeating it. No action needed now; it is a latent risk to watch.

Not a tool finding, flagged for the portfolio: `pad-opencode-user1` publishes a
web app on host port 54233 with `passwordConfigured: false`. Unauthenticated
published surface.

`pad-proj2` is the only opencode pad not named `pad-<type>-<name>`; it is
residue from the naming finding in [`2026-09-27-clone-proj.md`](2026-09-27-clone-proj.md),
still occupying a running slot. Housekeeping debt, not a defect.

The phantom pad (`pad-openclaw-cp`) that `list_agents` advertised in
[`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) is **no
longer in the listing** — 13 rows now, and every row I sampled resolved through
`health`. That finding appears resolved; not re-verified exhaustively.

## What held up well

`health` earned its keep this session: it works on stopped containers, names the
exit code, and — critically for triage — separates "stopped" from "cannot start"
by surfacing the network-namespace failure in the container status itself. The
`Ports (via door)` check from the 2026-09-27 clone-proj resolution is working:
the door's declared ports are compared against live bindings and the missing
door is reported as `none bound` rather than a false green `(none)`. `settings_get`
scoping also reads correctly now — `workspaceDevcontainer` was `null` on a pad
that has none, where the old `devcontainerPlan` block had invented entries.

## See Also

- [`2026-09-27-tool-surface-sweep.md`](2026-09-27-tool-surface-sweep.md) — the
  phantom pad and the `availableNetworks` cap that makes peer liveness unanswerable.
- [`2026-09-27-clone-proj.md`](2026-09-27-clone-proj.md) — the `pad-proj2`
  naming residue and the `Ports (via door)` resolution.
