# Plan 53 — Mission page: 3-column project → session → agent TUI workspace (the orchestration UI)

## Status: In progress (2026-09-27) — **8/10 phases built** (Phase 0–9). Phase 0
(store + validation), Phase 1 (live sessions), Phase 2 (the 3-column page
skeleton), Phase 3 (projects end-to-end), **Phase 4 (sessions end-to-end)**,
**Phase 5 (agent history + resume)** and **Phase 6 (the merged this-project /
all-projects view)** are DONE and verified live on a real
`opencode` PAD; Phase 6 also has its row-level defects fixed and the terminal
reliability work logged in **§9a** (the webui crash-loop that made the terminal
"glitch", the orphaned `tmux attach` clients it caused, and the MCP tool
handler that started it — all fixed except one unexplained external container
stop, which has stopped recurring and is now logged loudly if it returns);
**Phase 8 (the agent-visible MCP surface) is DONE 2026-09-27 as
[plan 55](55-mission-mcp-tools.md)** — five tools live and verified over `/mcp`
(65 MCP tests green), which added `project_id` / `agent` / `lines` / `limit`
filters to the `mission_sessions` of §1b and needed no new tmux helper;
remaining: Phase 7 (docs absorb, gated on user confirmation)
and Phase 9 (project memory + the
ordered checklist). Live-verified surface: the store
(`src/services/mission.js`) on `mission_projects` / `mission_sessions`, the
`mission.supported` driver flag on the three coding drivers, the
`/api/mission/*` routes, `src/services/pad-tmux.js` (the shared tmux layer
app.js delegates to), `/mission` with three columns, the project dialog with
the PAD-side folder probe, col 2 as live sessions + agent history with resume,
and col 3 as the real terminal with relaunch/restart/solo-lock/send.
47 tests green
(`src/test/mission.test.js` 47, `src/test/pad-tmux.test.js` 19) plus live
rounds on `pad-opencode-proj`: a real opencode TUI in the project folder, a
prompt typed through `send-keys` got answered, solo lock refused writes but not
reads, close killed the tmux session, `/exit` → relaunch → dead-pane → restart
kept the same conversation, 10 real history conversations listed and resumed
with their transcript, `msn-*` sessions in the agent-detail strip, three
simultaneous clients on one session, and the project CRUD driven through a real
browser. **Not** verified live: `codex` / `claude` TUI bring-up and resume on a
PAD that really has their history (see §8 — the claude reader is a documented
guess). Scope widened
2026-09-27: the
user identified this page as the user-facing UI for the MCP agent orchestration
(plan 52) and as **the shared workplace for the human and the agent** — see §1b
(agent-visible surface = Phase 7) and §1a (the same flow for both sides,
projects = agent + folder many-per-agent, only the three coding models).
**"Do task one after the other" settled 2026-09-27 (option A):** no server-side
runner — the LLM appends the items to a per-project checklist and works them one at
a time in a visible session (Phase 8).
**Headless work retired 2026-09-27** ("remove task submit"): a session is the only
unit of work, and **plan 52 was rewritten around `mission_*` sessions** the same day
— 52 owns keys/grants/conferral/playbook/proof, this file owns the surface.
Related: plan 52 (orchestration around sessions), plan 47/52 (headless `opencode run`
tasks — retired from the agent's flow, kept in the tree), plan 24/44 (custom
workspace mount), plan 35a (LLM command catalog, source of `tuiCommand`),
`docs/reference/tabs/terminal.md` (the tmux terminal contract this page reuses).
**Two presentation changes added 2026-09-27 (user), both verified live and both
outside the phase list — they change how the page looks, not what it does:**
both listing scrollers lost their native scrollbar to the floating
`OverlayScroll` (0px reserved, §6), and col 1 now folds into a 56px avatar rail
that folds on its own below 1024px and folds/unfolds by dragging the col-1
divider across the 200px minimum (§6). Nothing in Phases 0–9 is unblocked or
rewritten by them.

---

## 1. Goal (the user's words, kept)

> lets create a new page name it "mission" — this page will be full page layout,
> 3 column, 1st column will have the list of project, 2nd col, will have list of
> sessions in that project, 3rd col, will show the terminal TUI for that session
> opened, it should be mouse resizable, in the beginning all will be empty, button
> to create a project entry, when I click on the button it should show me the
> option to select the Agent. And the folder that I want to open in the agent. The
> agent's already predefined working folder will be the default selected one, but the
> user can edit and change it. When the user creates the project, when I open the
> project, I will create a new session. On creating a new session, it will create an
> entry there of the session and it will open the command. The TUI command for the
> agent which I have used. If it is opencode then opencode, if it is codex then
> codex, claude for claude.

One page, three columns, empty on first run:

| Col | Content | Empty state |
|-----|---------|-------------|
| 1 | **Projects** — name, agent badge, folder | "No projects yet" |
| 2 | **Sessions** of the selected project — name, live/dead dot, started-at | "Select a project" / "No sessions yet" |
| 3 | **The agent's TUI**, live, for the selected session (reuses `components/Terminal.jsx`) | "Select a session" |

Both create buttons (**+ New project** in col 1, **+ New session** in col 2) sit
in their own column toolbar, above the column's group header — there is no
page-wide header strip (see §6).

Full-page (no padding card), `fullHeight` layout like AgentDetail, both splitters
mouse-draggable, widths persisted per browser.

### 1a. What a project is, who may create one, and the flow both sides follow

**A project IS an agent + a folder** (user, 2026-09-27) — nothing more. So the
same PAD can carry **many projects, one per folder** (e.g. one `opencode` PAD
working `/www1/craftpip` and `/www2/paddock` side by side, each with its own
session list and its own TUI cwd). No uniqueness constraint on
`(agent, folder)` — the dialog only *warns* when that exact pair already exists.

**Only the coding models take part** (user, 2026-09-27): **opencode, codex,
claude**. The personal agents (openclaw, picoclaw, hermes) stay out of the
Mission page entirely — not in the agent picker, no projects, no sessions. This
is a driver-level capability flag (`mission: { supported: true }` on those three
drivers, absent/false elsewhere), so the picker, the API and the MCP tools all
filter on one field rather than hardcoding a list in three places.

**The flow is the same for the human and for the agent** (user, 2026-09-27) —
this is the entry contract of the whole feature:

```
1. an agent must exist          (human: /agents/create · agent: create_agent)
2. a project = agent + folder   (human: + New project · agent: mission_project_create)
3. a session opens the TUI      (human: + New session · agent: mission_session_start)
4. work happens in a session    (both: type · agent: mission_send)
```

**There is no step 5, and that is the point** (user, 2026-09-27): no unit of work
is ever started *outside* the human's view. The LLM does not file a headless
task — it opens a session, which you can watch. Sessions are the only work.

Step 1 is a hard precondition: the project dialog refuses to submit without a
selected agent and offers a "Create agent" link inline when the fleet is empty;
`mission_project_create` returns a plain error naming the missing agent instead
of inventing one.

---

## 1b. The model: a session IS the task — and the agent can see it

> Because my sessions are my task, only that the agent can see — then we can
> share our work. (user, 2026-09-27)

This is the *point* of the page, not a bolt-on. Today the orchestration half of
Paddock is invisible: tasks exist only as MCP tool calls and DB rows, a PAD's
real work happens in a terminal nobody can see from the dashboard, and the
orchestrator LLM has no way to know what the human is doing. **The Mission page
is the shared workplace** — the one place where the human's work and the agent's
work sit together, and where the agent can read what the human is doing.

| Concept | What it is | Where it lives |
|---|---|---|
| **Project** | A unit of work: *which agent* + *which folder*. Many per agent (one per folder). | `mission_projects` row |
| **Session** | **The only unit of work.** A live TUI that the human and the agent both type into and both watch | `mission_sessions` row + its `msn-*` tmux session |
| **Task (retired from the flow)** | The headless `opencode run` queue. **The LLM no longer starts these** (user, 2026-09-27) — no work happens outside your vision. The table/machinery may still exist for history; nothing in the Mission flow creates one | `tasks` table (plan 47/52) — *scope decision pending, see §9* |
| **Share** | Whoever needs to work uses an **existing** session or opens a **new** one. No "mine vs yours" | Phase 8 tools below |

So a project is the folder + agent, a session is the live conversation *about
one piece of work in that folder*, and both are visible to the fleet.

**Not "my session" or "the LLM's session" — just sessions** (user, 2026-09-27).
There is exactly one list, one kind of object, and both sides use it the same
way: pick a session that fits, or open a new one. tmux mirrors a session to
every client attached to it, so anything written is visible to whoever is
looking — the user explicitly does not want the writers problem engineered
around. The only concession to privacy is the per-session **solo lock** (§3,
`mission_sessions.locked`): a switch that makes `mission_send` refuse on that
one session, so you can drive alone for a while.

**Shared in both directions** (user, 2026-09-27: "our workspace will be
shared") — this is the whole point, so it is stated as a requirement, not a
nicety:

- **The LLM watches you**: `mission_sessions(session_id)` returns the tail of
  the screen you are looking at, so it knows what you are doing without you
  having to narrate it.
- **You watch the LLM**: a session the agent started is a normal row in col 2
  (badged `origin='agent'`), so its live TUI is one click away in col 3 — not an
  invisible background task.
- **Neither is a spectator**: both type into the same session
  (`mission_send` / your keyboard), so the conversation is genuinely shared
  rather than two parallel transcripts. Both sides read the same
  `mission_sessions` list — one shared workspace, not two views of it.

**Reconciliation with plan 52's "NO new screens — ever" law** (52, frontend
reality check): the law's intent is *no extra orchestration dashboard*; the
Mission page is a general workspace page that plan 53 builds anyway, and every
orchestration view rides it as a panel or disclosure on that page — never a
separate screen. 52 keeps its law; this file is the named home. Recorded in
52's status header (2026-09-27) so the two plans cannot drift.

**What the agent gets** (Phase 8 — new MCP tools in `src/mcp.js`, grants
reusing the existing buckets in `src/mcp.js:130`: `READ_TOOLS`, and
`TOOL_GRANT_FOR`):

| Tool | Does | Grant |
|---|---|---|
| `mission_projects(agent?)` | The user's projects (+ session count, live count), plus `supportedAgentTypes`. `agent` filters to one PAD. **Built as written.** | read → add to `READ_TOOLS` |
| `mission_sessions(session_id?, project_id?, agent?, lines?, limit?)` | No id → sessions across the caller's projects, with project name, agent, folder, live/dead; `project_id` / `agent` filter it, `limit` caps it (default 50, max 200). With an id → that session's detail **plus the tail of what its TUI is showing right now** (`tmux capture-pane -p -t <msn-id>`, `lines` of them, default 40, max 200) **and its `state`** (`live` / `tuiAlive` / `command` / `cwd` — which is how an LLM learns the human is at a shell right now, not in the TUI). The `project_id` / `agent` / `lines` / `limit` filters are **plan 55 additions**, confirmed in its §11. | read → add to `READ_TOOLS` |
| `mission_project_create(name, agent, folder?)` | Create a project on a PAD the caller owns — the LLM-side twin of the "+ New project" dialog, for the flow "create agent → create its project → work in it". `folder` defaults to that agent type's `driver.workspaceDir`; validated as an existing dir **inside the PAD** by the same probe as §4. Creates a row only — no container, no tmux, no shell. | `create` (same bucket as `create_agent`) |
| `mission_session_start(project_id, label?)` | **The LLM works with you, in a session you can watch** (user decision 2026-09-27). Same server path as the page's "+ New session": fresh `msn-*` tmux session with `-c <project folder>`, then the driver TUI launched (`tuiLaunch.fresh`). The row is stamped `origin='agent'`, so the page badges it "started by agent". 409 if the PAD is stopped. | `exec` — it spawns a real TUI that burns tokens, so it rides the same bucket as `task_submit`, not `create` |
| `mission_send(session_id, text)` | Type a line into a live session's TUI (`tmux send-keys`) — the LLM's way of *using* a session that already exists. Refuses with a clear error when the session is **solo-locked** (your "drive alone" switch) or its tmux session is gone (`mission_session_dead`). **Built as written.** | `exec` (same bucket as `task_steer`/`task_submit`) |

**Enforcement note (corrected 2026-09-27):** `/mcp` has **no caller-PAD
identity** — it sees an API key and nothing else. So "orchestrator-only" means
*key-grant-only*: a client key issued for orchestrator verbs (52 F2) carries
the `exec` bucket and can `mission_send`; a plain scoped key without it gets
`McpError: Not permitted by API key tool grant: mission_send`. This is the same
enforcement `task_steer` already has — do **not** invent a caller-identity
check that the transport cannot support. Ownership of the underlying PAD is
still enforced per call via `requireTool(user, tool, padName)` (the project row
carries the PAD name).

Deliberately **not** built, to avoid a second control plane:

- **No headless work path at all** (user, 2026-09-27: "don't let the user start
  any task without my vision — remove task submit"). The LLM's only way to begin
  work is `mission_session_start`; `task_submit` is not in its flow, and the page
  gets **no "run as a task" button**. Nothing runs where you cannot see it.
- No `mission_list` — `mission_projects` is the list; `mission_sessions` is the
  session list. Two nouns, two tools, no verb soup.
- No `mission_handoff` — there is nothing to hand off *to*. The LLM either uses a
  session that already exists or opens one; the "same work, different mode"
  idea died with the headless path.
- No agent-side **destruction** of sessions or projects (the agent may create a
  project and open a session; killing either stays a human action — see §9).

**What stays MCP-only** (unchanged): task submit/claim/steer/approve/cancel,
orchestrator conferral, grants, key management. The page observes and launches
sessions; it does not reimplement the queue.

---

## 2. Data model (new tables, `src/services/db.js:migrate`)

SQLite, next to `tasks` — same `CREATE TABLE IF NOT EXISTS` block, no new
migration machinery, `app.db` stays the single source of truth.

```sql
CREATE TABLE IF NOT EXISTS mission_projects (
  id TEXT PRIMARY KEY,                 -- nanoid-ish, url-safe
  name TEXT NOT NULL,
  agent_name TEXT NOT NULL,           -- the PAD (agent) the TUI runs in
  agent_type TEXT NOT NULL,           -- driver type at creation time (opencode|codex|claude only)
  folder TEXT NOT NULL,               -- CONTAINER path, absolute; default = driver workspaceDir
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (agent_name) REFERENCES agents(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS mission_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  tmux_id TEXT NOT NULL,              -- safeSessionName-safe, e.g. "msn-4f2a91c8"
  label TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'human',   -- 'human' | 'agent' — who opened it (page badge)
  locked INTEGER NOT NULL DEFAULT 0,     -- 1 = solo: the agent may read but not type (mission_send refuses)
  agent_session_id TEXT,              -- filled later by §8 (the CLI's own session id, when known)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  FOREIGN KEY (project_id) REFERENCES mission_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mission_projects_agent ON mission_projects(agent_name);
CREATE INDEX IF NOT EXISTS idx_mission_sessions_project ON mission_sessions(project_id);
```

Decisions:

- **A project is exactly (agent, folder)** — no `UNIQUE` constraint on that pair,
  because the user may legitimately want two projects on one agent + folder
  (different purposes, separate session lists). The dialog only *warns* on an
  exact duplicate. Many projects per agent is the normal case, not an edge case.
- **The tmux session IS the mission session.** One row ↔ one `tmux new-session`
  inside the PAD, created with `-c <project folder>`. Re-opening a mission
  session re-attaches to the still-running TUI (state survives, exactly like the
  docked terminal today). No re-launch on re-open — that would kill the
  conversation.
- **The row is the source of truth, tmux is the runtime.** A row whose tmux
  session is gone (PAD restarted, container recreated) shows a dead dot and offers
  **Restart** (kill nothing, just `new-session` + relaunch the TUI).
- `agent_name` is FK'd to `agents(name)`: deleting a PAD takes its mission
  projects with it (`ON DELETE CASCADE` only fires if the agent row is actually
  deleted — check `removeVm` deletes the `agents` row; if it does not, do the
  cascade explicitly in the delete path).
- `agent_type` is stored on the project (not derived) so renaming a PAD's type
  later cannot silently repoint existing projects at a different CLI.
- `folder` is a **container** path (see §4) — not a host path. The TUI runs
  inside the PAD, so only container paths can be trusted.
- Ownership: reuse the existing `app.param('name')` ownership rule. Mission
  projects belong to a PAD, so a non-admin only ever sees projects whose PAD they
  own. `/api/mission/*` routes resolve the PAD name from the project row and
  then apply the same `requireAgentAccess` check.
- **`locked` is per session, not per project or PAD** (user, 2026-09-27: "yes,
  do this" to the solo-lock question) — you lock the one conversation you want
  to drive alone. It is a row flag, not a tmux state, so it survives a session
  restart and is enforced in `mission.js::sendToSession` (the single choke point
  every writer goes through, human or MCP). The agent can still *read* a locked
  session — the lock is about typing, not secrecy.

---

## 3. Backend API

New `src/services/mission.js` (store + orchestration), routes in `src/app.js`
next to the terminal-session routes (~line 2325).

| Method | Route | Body / query | Does |
|---|---|---|---|
| GET | `/api/mission/projects` | — | Projects (own PADs only) with their sessions nested, plus a `live` flag per session (tmux alive?) |
| POST | `/api/mission/projects` | `{ name, agent, folder }` | Validate agent exists + folder is a directory inside the PAD; insert row; return it |
| PATCH | `/api/mission/projects/:id` | `{ name?, folder? }` | Rename / repoint folder (does **not** move running sessions — see §11) |
| DELETE | `/api/mission/projects/:id` | — | Kill every tmux session of the project, delete rows |
| POST | `/api/mission/projects/:id/sessions` | `{ label? }` | **The core one** — see §5 |
| POST | `/api/mission/sessions/:id/restart` | — | Kill + recreate the tmux session and relaunch the TUI (dead-session repair) |
| PATCH | `/api/mission/sessions/:id` | `{ label?, locked? }` | Rename the session, or toggle the **solo lock** |
| DELETE | `/api/mission/sessions/:id` | — | `tmux kill-session` + delete the row |
| GET | `/api/agents/:name/mission-folders?path=<abs>` | — | Probe a container path for the folder field: `{ path, exists, isDir, entries? }` (autocomplete + validation) |

`csrfCheck` on every mutating route, `requireAgentAccess` on all of them.

**Server-side eligibility gate (not just a UI filter):** any project/session
route that resolves an agent type rejects a non-coding agent with a clear
`400 mission_unsupported_agent: openclaw/picoclaw/hermes do not support Mission
workspaces` — same for `GET /api/agents/:name/agent-sessions`. The UI filter is
a convenience; the service is the boundary (an MCP client must not be able to
walk around the picker).

---

## 4. The project folder — what "select a folder" means

**Constraint that shapes the whole field:** the TUI runs *inside the PAD
container*, so the folder must already be visible there. Paddock does **not** add
mounts from this page (that is `recreate` + Settings, plan 24/44 territory).

**Many folders per agent is possible today — verified live 2026-09-27** on
`pad-opencode-proj` (`pad_settings_get` + `pad_exec` inside the container): that
single PAD already sees `DIR /www1`, `DIR /www2`, `DIR /mnt` and
`DIR /root/.opencode/workspace` at the same time — the first three are
`extraVolumes` bind mounts, the last is the driver's own `workspaceDir`. So one
opencode PAD can host a project per folder with **zero** mount changes. Two
details that only show up live:

- `driver.workspaceDir` is a real directory in the **container's own layer**, not
  a bind mount — so it is always a valid project folder, but also **ephemeral**
  (it is not in `/proc/mounts`; only the data dir `/root/.opencode` is). A
  project pointing there does not survive a container recreate.
- Bind-mounted folders come and go with `extraVolumes` — if a volume is removed
  in Settings, every project on that path silently goes invalid. The project
  list must therefore show a **folder-missing badge** (re-probe on load), not
  just a dead dot (see §10).

- The field is a **container path**, prefilled with the selected agent's
  `driver.workspaceDir` (already served by `GET /api/agent-types` →
  `drivers.listDrivers()`: opencode `/root/.opencode/workspace`, codex
  `/root/.codex/workspace`, claude `/root/.claude/workspace` — all three
  confirmed to exist inside their real PADs on 2026-09-27).
- Live validation via `GET /api/agents/:name/mission-folders?path=…` (debounced,
  mirrors the CreateAgent workspace-source autocomplete):
  - `exists` + `isDir` green → "Openable in this PAD".
  - missing → "Not found inside the PAD" (this is the honest answer for a host
    path that isn't mounted — say so, with the fix: "mount it in Settings →
    Extra volumes, or pick a path the PAD already sees").
  - `entries` (dir names, ≤200) power a small suggestion dropdown; `..` walks up.
- Suggestions dropdown lists what the PAD *can* see today: the driver's
  `workspaceDir` + every `extraVolumes[].container` + the workspace mount
  container path (from `GET /api/agents/:name/settings` → `workspaceMount.container`).
  On a real PAD this immediately offers 3–4 usable folders, which is what makes
  "second project on the same agent" a two-click action.
- Store the path normalized (no trailing `/`).

---

## 5. Creating a session — the core backend path

`POST /api/mission/projects/:id/sessions`:

1. Load project + its PAD; 404 if the PAD row is gone, 409 if the container is
   not running (the client shows "start the PAD first").
2. `tmux_id` = `msn-` + 8 hex chars (matches `SESSION_NAME_RE`
   `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/` in `src/app.js:276`).
3. `ensureTmuxSession(vmName, tmux_id, cols, rows, cwd = folder)` — **one new
   parameter**, appended to the existing helper (`src/app.js:368`): when the
   session does not exist, push `-c <cwd>` onto the `new-session` argv
   (`src/app.js:402`). Everything else (bash preference, history-limit, status
   off, `termUserArgs` for user-mode PADs, scrollback) is untouched, so the
   mission page inherits the whole existing terminal contract for free.
4. Launch the TUI **server-side, from the driver** — never from client text:
   `drivers.getDriver(agentType).tuiLaunch({ cwd, resume })` →
   `tmux send-keys -t <tmux_id> -l -- <cmd>` + `tmux send-keys -t <tmux_id> Enter`.
   Server-derived ⇒ no shell injection surface (the folder is a validated
   container path; the command is driver-owned).
5. Insert the `mission_sessions` row, return it. The client then renders
   `<Terminal name={agent} sessionId={tmux_id} showSessions={false} />`, which
   attaches to the already-running TUI (scrollback replay covers the launch
   frames).

`Restart` = step 2–4 again with a fresh `tmux_id` (old id killed if alive).

### What clicking a session shows (user, 2026-09-27)

Clicking a session row opens **only the terminal, already running the agent's
TUI** — never a bare shell, and never a "press start" step:

- The TUI was launched server-side at session-create (§5 step 4), so by the time
  the row exists there is a TUI on screen inside that `msn-*` tmux session.
  Clicking swaps the `sessionId` prop on the shared `Terminal` and **attaches**;
  the launch frames come back via scrollback replay.
- **Re-clicking (or coming back later) never relaunches the TUI** — the tmux
  session is still running it, so the conversation is intact. `Restart` is the
  only thing that recreates it, and it is deliberate.
- One state to handle honestly: if the TUI *process* exited (the user typed
  `/exit`, or the CLI crashed) but the tmux session is alive, the pane shows a
  **shell prompt inside that same session** — not a dead row. The row's action
  then reads **"Relaunch TUI"** and simply `send-keys` the driver's
  `tuiLaunch.fresh` into the *existing* `msn-*` session (no new tmux, no
  conversation loss, no `Restart` needed). A **dead** dot still means the tmux
  session itself is gone → that is the `Restart` case above.

### Driver addition — `tuiLaunch` + the `mission` capability flag

Two things per driver, next to the existing `tuiCommand` / `startCommand`:

1. `mission: { supported: true|false }` — **true only for opencode, codex,
   claude** (user decision 2026-09-27: the personal agents stay out of Mission).
   `getDriver`'s openclaw fallback returns a driver *without* the flag, so
   `mission.supported` is a safe `?.` read everywhere.
2. `tuiLaunch` — `{ fresh: <cmd>, resume: ({ sessionId, cwd }) => <cmd> }`, and
   it is only written for the three supported drivers. `tuiCommand` stays the
   source of the `fresh` string so the two can't drift.

| Type | mission | fresh | resume (existing session) | continue-latest |
|---|---|---|---|---|
| opencode | ✅ | `opencode` | `opencode -s <id>` (add `--fork` to branch) | `opencode -c` |
| codex | ✅ | `codex -C <cwd>` | `codex resume <id>` | `codex resume --last` |
| claude | ✅ | `claude` | `claude -r <id>` | `claude -c` |
| openclaw | ❌ | — | — | — |
| picoclaw | ❌ | — | — | — |
| hermes | ❌ | — | — | — |

`resume` is only wired in Phase 5 (§8) — Phase 3 ships `fresh` only.

---

## 6. Frontend

```
src/client/src/pages/Mission.jsx                  page shell, 3 cols, empty states
src/client/src/components/SessionList.jsx         col 2
src/client/src/components/ProjectDialog.jsx        the "+ New project" modal
src/client/src/components/Splitter.jsx            reusable mouse-resizable divider
src/client/src/components/OverlayScroll.jsx        floating scrollbar for the two listings
src/client/src/stores/mission.js                  zustand store (mirror stores/agents.js)
```

**The two listings float their scrollbar (user, 2026-09-27).** Col 1 and col 2
are wrapped in `OverlayScroll` instead of a bare `overflow-y-auto` div, because
a native scrollbar always reserves layout space: in a 260px column that is a
tenth of the listing, and the previous `scrollbar-gutter: stable` only made that
space *invisible* rather than giving it back — the rows still ended 10px short of
the column edge, which reads as "the scrollbar is still taking space in the
listing". `OverlayScroll` switches the native bar off (`scrollbar-width: none`,
so it reserves nothing in *any* overflow state — the overflow-threshold twitch
the gutter existed to prevent is gone with it) and draws a 6px thumb over the
content, visible while the pointer is over the area / while dragging / for 900ms
after a scroll. The scroller keeps its `msn-col-body` / `msn-sessions-body`
class, so every selector in §6 still resolves to the scrolling element. The only
interactive strip is a 12px lane at the right edge, which clears every row
button (rows keep a 10px right padding; measured 22px/27px of clearance), so it
can only take clicks from the row's own right edge — the same trade a native bar
makes. Verified live: `offsetWidth === clientWidth` on both scrollers (0px
reserved), thumb appears on hover, tracks `scrollTop` exactly, drags to the end,
pages on a track click, sticky group headers still stick, and no button is
intercepted.

**Col 1 folds by DRAG, with the button kept as a shortcut (user, 2026-09-27).**
`COL1_MIN = 200` is the hinge. Drag the col-1 divider left and the listing
narrows normally; the moment it would go under 200px it **snaps to a 56px rail**
instead of stopping. Drag the rail's divider right and it stays a rail until it
reaches 200px, then **reopens at that width**. The `‹` beside "New project" and
the rail's `›` do the same thing in one click, and are deliberately still there.
Two things this needed that the first attempt got wrong:

- **The divider must stay mounted in both states.** The rail originally rendered
  without one, which removed the only way to fold by hand — the drag became
  impossible exactly when it was most wanted. `Splitter` is now a sibling of the
  conditional, not inside it.
- **`Splitter`'s own `min` silently made the fold unreachable.** It floors the
  reported width at `min`, so with `min={200}` the parent never saw a value
  below the minimum and could never decide to collapse. Col 1 is therefore given
  `min={RAIL_W}` (report anything down to the rail) and the *parent* turns the
  number into a decision in `resizeCol1` — `< COL1_MIN` collapses, `>= COL1_MIN`
  from collapsed opens. A component-level clamp is the wrong place for a
  snap-to-collapsed rule; the parent owns what a width *means*.

The folded rail shows each project as a 32px circle with the first two characters
of its name (`paddock` → PA), and "New project" as a round `+`. An avatar is the
*same button* the row was, so selection (and therefore col 2 + col 3) behaves
identically; the only thing lost in the rail is edit/delete, which needs the full
row. State is persisted (`pad-mission-col1-collapsed`, `pad-mission-col1`).

**Folding must not move anything, and a folded column must stay CENTRED (user,
2026-09-27).** The first rail had its own spacing, so the control jumped on every
fold. Four fixes, all measured rather than eyeballed:

- **One 12px gutter for the whole column** — header title, project rows, rail
  avatars, and the rail head. 12 is not arbitrary: it is `(56 - 32) / 2`, the
  only inset that centres a 32px control in the 56px rail, and it is already what
  the rows used. The expanded toolbar was the odd one out at `px-2` (8), which
  put the arrow 4px left of the label under it *and* left the rail head with 8px
  on the left against 16px on the right — a lopsided column. Both are now `px-3`.
- **The arrow is on the same pixels in both states** — 32×32 at (12, 61) folded
  and expanded. `items-center` is the other half of that: in a 56px column it
  silently discards the horizontal padding and re-centres the button, so the
  padding "looks" right in the code while the arrow sits 4px off. `items-start`
  when the inset is the point.
- **The chevron is a 14px stroked SVG, not a character.** `‹`/`›` render 5px wide
  in a 32px button — a hairline to aim at, and the reason the control read as
  "so small"; but the first SVG attempt at 20px was too heavy next to the avatar
  circles. 14px with `strokeWidth` 2.2 is the middle that reads as an icon at
  one glance and sits quietly in the 32px target. One `<Chevron dir>` for both
  directions, and the stroke weight is scaled with the box so a resize does not
  change how hard the arrow looks.
- **Assert both gaps, not just the left one.** A control's x position is only half
  the question; `colRight - controlRight` is the other half, and that is what
  exposed the 8-vs-16 asymmetry while every left-edge measurement still agreed.

The `+` is the one control that cannot keep its position: beside a labelled button
in a 260px toolbar, stacked under the arrow in a 56px rail. Same 32px target both
ways, same 12px gutter, so it is centred in the rail and flush in the expanded
column. Anything that must not move has to be the *only* thing in its slot.

**Keyboard needed its own way through the floor.** `Splitter`'s arrow keys nudge
by a delta from the current width, so from the 56px rail `ArrowRight` asked for
72px and the floor clamped it straight back to 56 — collapsed columns were
unreachable without a mouse. A new `openAt` prop makes a panel sitting on its
floor jump to the width the parent calls *open* on the first press
(`openAt={COL1_MIN}`), after which every press is a normal 16px step. Verified:
floor → `ArrowRight` = 200 → three more = 248 → `ArrowLeft`×10 collapses →
`ArrowRight` = 200 again.

**A narrow window folds the column, but never traps it.** Below 1024px
(`NARROW_MAX`) col 1 folds itself and hands the width to the terminal, which is
the one column that cannot shrink (900px viewport: terminal 438px → 642px). An
explicit open — the chevron or a drag out to `COL1_MIN` — sets `narrowOverride`,
so the fold does not spring back the instant you let go; the override is dropped
when the window actually crosses the breakpoint, so shrinking it folds you again.
An earlier version hid the rail's `›` entirely while narrow, on the theory that a
button which re-collapses instantly is worse than none — that turned the narrow
state into a trap and is exactly the kind of well-meant dead end to avoid. The
detection is a `window.innerWidth` read off a `resize` listener, not
`matchMedia`: a `MediaQueryList` is a fresh object per call, so a test cannot
address the one the hook holds, and a resize listener is trivially exercisable
(`window.dispatchEvent(new Event('resize'))`).

Phase 3 as built (2026-09-27): col 1's rows and the dialog live in
`pages/Mission.jsx` + `components/ProjectDialog.jsx` rather than a
`pages/mission/*` split — col 1 is a flat list and splitting it out buys
nothing yet. Phase 4 built col 2 the same way, as
`components/SessionList.jsx` (it needs its own scroller for the sticky group
headers, which is why it is not the generic `<Column>`).

**Every element carries an `msn-*` class (user, 2026-09-27).** So a UI
instruction can be aimed at an exact element instead of a description of where
it sits: "the del button in the project row" → `.msn-project-row .msn-btn-delete`.
The classes are additive (`className="msn-x flex …"`), carry no styles of their
own, and are the only naming hook on these three files.

| Area | Hooks |
|------|-------|
| Shell | `msn-page` `msn-cols` `msn-col-shell` `msn-splitter` `msn-splitter-1` `-2` |
| Any column | `msn-col` `msn-col-toolbar` `msn-col-header` `msn-col-title` `msn-col-count` `msn-col-body` |
| Col 1 | `msn-col-projects` `msn-project-row` (+`msn-row-selected`) `msn-project-name` `-meta` `-actions` `msn-btn-new-project` `msn-btn-edit` `msn-btn-delete` `msn-btn-retry` |
| Col 2 | `msn-col-sessions` `msn-sessions` `-body` `msn-btn-new-session` `msn-project-folder` `msn-scope-toggle` `msn-scope-project` `msn-scope-all` `msn-row-project` `msn-history-errors` `msn-history-error` `-project` `msn-group` `msn-group-sessions` `msn-group-count` `msn-row-slot` `msn-session-row` (+`msn-row-dead`) `msn-session-dot` `-label` `-id` `msn-row-actions` `msn-btn-lock` `msn-btn-close` `msn-history-row` `msn-history-title` `-meta` `msn-history-hint` (only while opening) `msn-btn-subfolders` `msn-cap-note` |
| Col 3 | `msn-col-agent` `msn-agent-header` `msn-agent-dot` `-label` `-cwd` `-actions` `-command` `msn-badge-solo` `msn-btn-relaunch` `msn-btn-restart` `msn-terminal-wrap` `msn-terminal` |
| Confirms | `msn-confirm` `msn-confirm-close` `-delete` `msn-confirm-actions` `msn-confirm-yes` `-no` |
| Shared | `msn-empty` `msn-empty-inline` `msn-empty-title` `msn-empty-text` `msn-error-bar` |
| Dialog | `msn-dialog-backdrop` `msn-dialog` `msn-dialog-header` `-title` `-form` `-footer` `msn-field` `msn-field-name` `-agent` `-folder` `msn-field-label` `msn-field-note` `msn-input-name` `msn-input-folder` `msn-agent-options` `msn-agent-option` (+`msn-selected`) `msn-agent-type` `msn-stopped-note` `msn-no-agent` `msn-link-create-agent` `msn-folder-chips` `-list` `msn-folder-chip` `msn-suggestions` `msn-suggestion-chip` `msn-folder-status` (+`msn-ok`/`msn-warn`) `msn-dup-warning` `msn-btn-submit` `-cancel` `-close-dialog` |

**No page-wide header strip (user, 2026-09-27).** The page used to carry an
`h-11` bar above the three columns holding the "Mission" title, the "a project
is an agent plus a folder" line, and a **+ New project** button. It is gone:
every create action lives in its own column toolbar, above that column's group
header — **+ New project** in col 1, **+ New session** in col 2. `Column` takes
an optional `toolbar` node for exactly this. A strip above all three columns
duplicated what the column already says and only stole vertical space from the
listings.

- Route: `/mission` in `App.jsx`, wrapped `<AuthPage fullHeight>`; nav link in
  `DashboardLayout` between "Agents" and "+ Agent".
- Col 3 is `components/Terminal.jsx` **as-is** plus two new optional props:
  - `sessionId` (controlled) — pins the tmux session, skips the localStorage
    `pad-term-session-<name>` lookup.
  - `showSessions` (default `true`) — the mission page sets `false` so the
    built-in session tab strip can't switch the pane off the mission session.
  - Nothing else changes; the WS URL, takeover policy, reconnect, and
    `termUserArgs` user-mode handling all stay.
- Create-project dialog: agent `<select>` listing **only `mission.supported`
  agents** (opencode, codex, claude) that are **running** — a stopped PAD can't
  host a TUI, so stopped ones render disabled with "stopped"; non-coding agents
  are not in the list at all. If the fleet has no supported running agent, the
  dialog shows a **"Create an agent first"** link to `/agents/create` instead of
  an empty select (step 1 of the §1a flow is a hard precondition). Below it, the
  folder text input prefilled from the chosen agent's `workspaceDir`
  (re-prefilled when the agent changes, until the user edits it), the
  one-click **other folders this PAD can see** chips (§4), a soft duplicate
  warning when this exact (agent, folder) pair already has a project, and the
  live validation line. Create/Cancel.
- `Splitter.jsx`: `onMouseDown` → capture pointer, track `clientX`, clamp each
  column to `[200px, 60% of container]`, write widths as `fr`-free px/flex-basis,
  persist to `localStorage` (`pad-mission-cols`), double-click resets to defaults
  (`260px | 220px | flex`). `cursor: col-resize`, 6px hit area, no visible border
  until hover. Keyboard accessible: `←/→` nudge 16px when focused.
- Session rows: label (editable inline), live dot (tmux alive), relative
  started-at, an **"agent" badge** when `origin='agent'` (the LLM opened it), a
  **padlock toggle** for the solo lock, `×` delete (confirm), `↻` restart when
  dead. The selected row is
  the pane; switching rows swaps the `sessionId` prop (Terminal's existing
  soft-swap path keeps the WS churn cheap). A locked session shows the padlock in
  col 3 too, so you remember why the agent went quiet.
- Col 1 project rows: name, agent badge, folder (truncated middle), session
  count, and a **warning badge when the folder no longer exists in the PAD**
  (re-probe on load, §4) so a removed extraVolume is visible instead of only
  failing at session start.

**Col 3 is pinned to `openSession`, NOT to the listing (plan 58, 2026-09-28).**
This supersedes the "col 3 follows the selected row" reading above. Col 3 used
to render `sessions.find(s => s.id === selectedSessionId)` — a row looked up in
a list that `setScope` **empties on purpose** before it refetches. For the
~200ms of that refetch `session` was `null`, so col 3 rendered its empty state,
`<Terminal>` **unmounted**, its WebSocket closed, and the list landing remounted
it: a fresh xterm, a fresh `tmux attach`, a screen redraw — for the same
conversation the user was already reading. Switching project in col 1 closed it
the same way, because `select()` also cleared `selectedSessionId`.

The contract now:

- `stores/mission.js` holds **`openSession`** — a snapshot of the row at the
  moment it was opened: `{ id, tmux_id, label, locked, projectId, agentName,
  folder }`. Col 3 renders from it, and the `project` handed to `<Terminal>` is
  resolved from **`openSession.projectId`**, never from col 1's
  `selectedProjectId`. That last part is the whole point: in `all` scope a row
  from another project must not be corrected back to the col-1 project.
- **Written by exactly two things** — `selectSession` (a row click) and
  `startSession` (new/resumed, itself a user action) — and **cleared by exactly
  one**, `closeSession`. Nothing that only changes *which rows are listed* may
  write it.
- **Refreshes may update its display fields** (`label`, `locked`, `live`,
  `busy`) from the row they find but must never change *which* session is open.
  `followSessionPatch` still runs for the **highlighted row** (so a deleted row
  re-highlights sensibly) but no longer writes `openSession`, and no longer
  implies a terminal change.
- **If the open session's row vanishes** (closed in another tab, project
  deleted) col 3 **keeps the terminal** and shows the explicit closed state
  rather than silently re-pointing at a neighbour. Plan 53 §7's "refuse to land
  on a dead pane with no way back" is now enforced by *keeping* the session
  rather than by chasing the list.
- **`sessionState` is keyed to `openSession.id`**, so a scope switch or a poll no
  longer nulls it and the header (dot, cwd, relaunch label) cannot flicker
  through an empty state.
- **Consequence worth knowing: `startSession` must re-read pane state after
  setting `openSession`.** The snapshot is taken at creation, when the TUI has
  been *asked* to launch but has not yet appeared, so a snapshot-only fix renders
  a brand-new session as closed. It now calls `get().fetchSessionState(id)`
  immediately after. *A snapshot taken at open time is correct for a session that
  was already running and wrong for one still starting.*
- Verified live: with a session open, tagging the mounted `.msn-terminal` and
  switching project→all and back leaves **the same DOM node** mounted with
  identical screen content; col 1 showed `paddock` while col 3 kept `test`'s
  session. `docker logs paddock --since 2m | grep -cE "wss\] connection|attach"`
  stays **0** across a scope switch, so this also removes a source of the
  reconnect-fight loop in §9a rather than adding one.

**Opening a dead session now LAUNCHES an agent process (plan 68, 2026-10-06).**
This is the one place where col 3 does something with a **cost**, so it is
recorded here rather than left to the feature's own file. When a row is opened
and its pane-state read says `live: false`, col 3 does **not** render the closed
notice — `fetchSessionState(id, { autoReopen: true })` calls `restart(id)` once
(same `tmux_id`, same `agent_session_id`, same folder) and shows a transient
**"Reopening…"** until the terminal is up. Before, that path stopped and asked.

- **The cost is real and spent on purpose** per the user's request: reopening runs
  `opencode -s <agent_session_id>` in the user's conversation, so clicking a row
  can start spending tokens with no prompt. The opt-in is the *user action*, not
  the state — `autoReopen` is passed **only** by `selectSession` (row click) and
  `startSession`, and **never** by the refresh/poll path. A pane that dies while
  you are watching it therefore still gets the non-destructive notice and the
  button; it is the "you opened this, it has nothing running" case that restarts.
- `reopenFor` (keyed by id) is the in-flight guard, so a second read of the same
  dead row cannot start a second restart — one reopen per open, never two panes
  on one conversation. `reopenError` renders the failure beside the **existing**
  Reopen button, which is the manual retry.
- **Ordering is load-bearing here.** The pane is re-read *before* `reopenFor` is
  dropped, and that read is awaited. Clearing it first makes col 3 fall through
  to the closed branch on the *stale* `live: false` and flash "This session is
  closed" — with a pointless retry — for the length of the read, on the one path
  that is **succeeding** (measured 376ms). There is no `finally` doing the
  clearing; that is what made the bug.
- Verified live: `Reopening…` → terminal with no closed-notice flash; the pane
  came back as `opencode -s <the row's own agent_session_id>` (same
  conversation, not a fresh one); the poll path showed the notice and left
  `tmux has-session` failing 25s later (no restart); a forced 409 produced the
  failure text plus the retry. Mutation control: moving the clear back ahead of
  the read reproduces the flash.

**The listing speaks the user's language, in one rhythm (plan 58, 2026-09-28).**
Two presentation rules that are now part of this page's contract:

- **A missing tmux pane is a closed session, and it is worded that way.** The
  row shows the normal time text and no state sentence; col 3's gone state reads
  *"This session is closed"* / *"Nothing is running here any more — the PAD may
  have been restarted."* and keeps the existing Restart button. `mission.tmux_id`
  may still be the fallback row name (it is the session's own name), but **no
  sentence the user reads may name tmux, a pane, or an attach** — verify with
  `document.body.innerText` against `/tmux|pane is no longer/i`, not by reading
  the JSX.
- **"Gone" is not a state the client computes any more.** The row's `open` is
  the server's field (`live || busy`, §9b), and a dead pane simply falls out of
  `live` and reads as *not open* — which is exactly what it is, and what the
  unlit dot and the row's age already said. Plan 56's concern still holds, and
  it is now carried by `busy` rather than by a second flag: a conversation the
  human is driving in the opencode web UI has no session of ours, so it reports
  `busy` and therefore stays **open** even with its pane gone. *A dead pane is
  not a dead conversation — the two questions are separated by `busy`, not by a
  `paneGone` flag, and there is no "dead" styling to reconcile because
  `msn-row-dead` was removed along with the wording.*
- **One scale for the column.** Col 2 is a single 12px left inset for every
  element, 6px band padding for every non-row band, and live and history rows
  that measure identically (50px, name at 12px/500, metadata 10px mono, actions
  anchored to the metadata line's box rather than the row's corner). The scope
  control is the house segmented switcher from
  `pages/agent/WorkspaceToolbar.jsx` — one `rounded-control bg-sunken/60 p-0.5`
  group, **no `gap-px`**, real `Button`s at `size="sm"` — so its selected state
  comes from the primitive and cannot drift from every other primary button.
  Both were checked in **light and dark**; band contrast is a dark-mode
  problem first.

**Close and delete are real dialogs (plan 58, 2026-09-28).** Both the row's
Close and the project row's delete use the existing `useConfirm()` provider from
`lib/confirm.jsx` (`Modal` at `z-[80]`, danger tone, Escape/backdrop/Enter). The
per-row inline prompts (`msn-confirm-close`, `msn-confirm-delete`) and their
`confirmClose`-style component state are **gone**: an inline prompt inside a
scrollable listing moves the rows under it, is clipped by the scroller, and is
per-row state that has already outlived its row once (see §9a). A failed close
leaves the session open with the error in `actionError`. Never build a new
confirm for this page — the provider is the app's answer and it already escapes
col 2's stacking context.

**What the six page fixes were measured at (plan 58, 2026-09-28).** Kept here
because these are the numbers the page's look-and-feel is now pinned to; all
were read from `getComputedStyle` / the DOM in a headless tab against the
running webui, not eyeballed. The user's own words for the six, kept:

1. *"in the sessions col, when i switch between this project and all projects it
   should not affect the tui, don't change the UI, only change the main screen
   when user clicks on a session"*
2. *"in the session listing there are weight gaps in between for different types
   of entries, that are showing, it should look standardized style and
   alignment, the green dot for working sessions is fine"*
3. *"when i press close this sesion button, it should ask in popup not inline,
   use the confirm component that we have"*
4. *"the sessions listing says - gone - the pane is no longer there, why are we
   showing this, the user does not care about our tmux setup, if no pane then
   its session is closed"*
5. *"show this project / all project has button group"* — and it must *look* like
   UI.
6. *"in the terminal component the esc key is delayed when i quick press it its
   not registered, i have to wait for it to register and then press again. make
   it so its quick no waiting"*

| what | measured |
| --- | --- |
| col 2 width floor | 180px, and the layout holds there |
| one left inset | 12px for **every** element in col 2 (toolbar, bands, rows, empty state) |
| non-row bands | 6px top and bottom, one value |
| live vs history row | both 50px; name line 12px / 500 both; metadata 10px mono both; actions anchored to the metadata line's box, not the row corner |
| scope control | 32px tall, 28px segments, 8px radius, selected = `bg-accent` + `text-accent-ink` |
| col 3 across a scope switch | same DOM node mounted, byte-identical screen content |
| col 3 across a project switch | still `test` / `msn-63b09f3e` while col 1 read `paddock` |
| user-visible copy | `document.body.innerText` against `/tmux\|pane is no longer/i` → no match |
| ESC, `escape-time 10` | 10/10 echoes, median **16.8ms** (14.6–23.0) |
| ESC, `escape-time 500` (control) | 10/10 echoes, median **506.9ms** (505.0–648.1) |
| attach churn during a scope switch | 0 in `docker logs paddock --since 2m` |
| the user's live sessions after all of it | 7 on `pad-opencode-proj`, re-read identical (`live`, `busy`, `last_seen_at`) |

`test/pad-tmux.test.js`: 19 passed. Six projects before and after the work
(`friction-probe`, `test`, `root`, `paddock`, `schlorp`, `craftpip`) — the two
throwaway sessions created for testing were closed and their tmux sessions
confirmed gone, and no real project was deleted.

---

## 7. Phases

Each phase is independently shippable and ends verified in the browser.

- [x] **Phase 0 — tables + service skeleton.** `mission_projects` /
      `mission_sessions` in `db.js:migrate`, `src/services/mission.js` with
      CRUD + ownership helpers, routes wired, no UI. Verify: `curl` the CRUD
      round-trip; `docker restart paddock`; `node --test test/mission.test.js`
      (new file, run individually per the house rule).
      **Done 2026-09-27** — 19/19 tests green; live curl round-trip proven
      (coding agents accepted, personal agents rejected, 404/CSRF/cascade
      checked). Deliverable split: the `tuiLaunch` object and the
      `mission.supported` flag landed here too (they are the eligibility gate
      `mission.js` needs), so Phase 1 is only the tmux half.
- [x] **Phase 1 — `ensureTmuxSession` cwd + `tuiLaunch` + the `mission` flag.**
      `-c <cwd>` on `new-session`, `send-keys` launch, unit test for the argv
      shape; `tuiLaunch` on the three coding drivers only, `mission: {supported}`
      on all six (false for openclaw/picoclaw/hermes). Verify live: `pad_exec` a
      manual `tmux new-session -d -s probe -c /tmp && tmux send-keys …`
      round-trip, then the API.
      **Done 2026-09-27.** The tmux primitives moved into
      `src/services/pad-tmux.js` (app.js delegates; `mcp.js` must not require
      app.js), and `mission.js` grew the live half: `startSession`,
      `relaunchTui`, `sendText`, `screen`, `state`, `withLive` (one tmux call
      per PAD, not two per session), `closeSession`. `src/test/pad-tmux.test.js`
      pins the argv AND the exec options (19 tests) — the options check exists
      because a bare-number timeout vs an options object only breaks against
      real docker. Live-proven on `pad-opencode-proj`: a session opened a real
      opencode TUI in `/www2/paddock`, a prompt typed through `send-keys -l`
      got answered, `relaunch` refused while the TUI ran and worked after
      `/exit`, the solo lock refused `mission_send` but not reads, close killed
      the tmux session and dropped the row, and the refactored **terminal path
      was regression-checked in the browser** (attach, typed `e`, got
      `command not found`, scrollback replays on reload).
      **Found + fixed live:** `tmux new-session -c <missing>` does NOT fail — it
      silently starts the pane in the PARENT, so the agent ran in `/www1` when
      asked for `/www1/craftpip`. `padTmux.folderExists` (`test -d`, quoted)
      now gates every start; a missing folder is refused with
      `mission_folder_missing` before any row or tmux session exists.
- [x] **Phase 2 — the page skeleton: 3 columns, empty states, resizable.**
      `Splitter.jsx`, nav link, route, no data. Verify in the browser: empty
      copy renders, both splitters drag, widths survive a reload.
      **Done + verified in a browser 2026-09-27:** `Splitter.jsx`,
      `pages/Mission.jsx`, the `/mission` route and the nav link (between
      Agents and + Agent). Measured in the live DOM: Projects x=0 w=260,
      Sessions x=266, Agent x=452, all y=101 h=699; empty states centered.
      Both splitters drag and persist (`pad-mission-col1` / `-col2` in
      localStorage): +90px → 350, `min` clamp at 180, `max` clamp at exactly
      45% of the row (648/1440), widths restored after a reload, `ArrowLeft`
      −16 and `Shift+ArrowLeft` −64, double-click back to the default, console
      clean. Three real bugs found and fixed while verifying: (1) the column
      wrapper needed `h-full` or columns 1–2 sized to content (220/181px)
      instead of filling the row; (2) `onMouseDown`+`onTouchStart` calling
      `setPointerCapture(e.pointerId)` — those events have no `pointerId`, so
      it is one `onPointerDown`; (3) the drag flag was React state, so
      pointermove arriving before the re-render committed was dropped and a
      fast drag lost its first pixels — it is a ref now (state only styles).
- [x] **Phase 3 — projects end-to-end.** Dialog (coding-model agent select only
      + "create an agent first" link, folder field + suggestions chips +
      validation + duplicate warning), create/edit/delete, col 1 live. Verify:
      create a project against a real `opencode` PAD; create a **second project
      on the same PAD with a different folder** (from the suggestions chips) and
      see both in col 1; confirm an `openclaw` PAD is not offered; change the
      folder; delete one. **DONE + verified live 2026-09-27**: `stores/mission.js`
      (projects CRUD, selection, debounced folder probe) + `components/ProjectDialog.jsx`
      (coding-agent chips only, `workspace_dir` prefill, PAD-side probe with
      `..`/child chips, mount chips, duplicate warning, agent immutable on edit) +
      col 1 rows with inline delete confirm. Backend: `workspace.listFolders` +
      `mission.projectFolders` + `GET /api/agents/:name/mission-folders`
      (25/25 `mission.test.js`). Live on `pad-opencode-proj`: created
      `/www1/craftpip.com`, a second project on the same PAD at
      `/www1/esphome`, a duplicate attempt warned but stayed enabled, an
      invalid folder (`/www2/agent-work/esphome-mirror`) was refused with the
      "mount it" message, edit moved the folder to `/www2` and renamed, both
      test projects deleted, list survives reload, no `openclaw`/personal PAD
      offered, console clean. Test rows cleaned up (0 projects / 0 sessions).
- [x] **Phase 4 — sessions end-to-end.** `+ New session` → row + live TUI in
      col 3, restart/delete, dead-session repair, the **solo lock** toggle
      (row flag + col 3 padlock), `msn-*` **visible** in the agent-detail
      terminal strip, and **multi-client attach allowed** for `msn-*` (the
      `activeTerminals` single-client rule exempted for that prefix only).
      Verified live on `pad-opencode-proj` (2026-09-27): fresh session, relaunch
      after `/exit`, dead-session state + restart with the same tmux id and
      transcript, solo lock refusing writes, close killing the pane,
      `msn_folder_missing` guard, five `msn-*` tabs in the agent-detail strip,
      and three simultaneous clients (2 Mission tabs + the agent-detail page) on
      one session with **zero** supersede/4001 kicks. `codex` and `claude` PADs
      are **not** verified live yet — their TUI bring-up is the remaining gap.
- [x] **Phase 5 — agent session listing + resume (the §8 audit, built).**
      Project-scoped `GET /api/mission/projects/:id/history` (exact + nested,
      `subfolders=1`, capped at 200 server-side) over a shared
      `workspace.listAgentSessions` reader for the three coding drivers, a
      History list in col 2, and "resume" wiring `tuiLaunch.resume` (which
      stores the source conversation in `mission_sessions.agent_session_id`).
      Verified live on `opencode`: 10 real conversations for
      `/www1/craftpip.com` (9 + the one this work created), subfolder expansion
      and its honest "showing N most recent of M" cap, resume reopening the prior
      transcript **in the right folder**, solo lock refusing writes, relabel,
      close. `codex` (`~/.codex/sessions/*.jsonl` + `codex resume`) and
      `claude` (`~/.claude/projects/**` + `claude -r`, still unverified against a
      PAD with real history — see §8) are wired but not verified live.
- [x] **Phase 6 — the merged view: "this project" vs "all projects" (user,
      2026-09-27).** Col 2 gets a two-way scope switch, so the page answers both
      "what can happen in THIS project" and "what have I worked on at all"
      without leaving the layout the user already has.
      **The design, and why it is a switch and not a fourth column:** the user
      asked for both views *merged*, so the columns stay three and col 2's
      toolbar carries `This project` / `All projects` (a segmented control, same
      place as `+ New session`). Col 1 is untouched and stays the project
      switcher; in All mode each row wears a project badge, because a session
      label alone cannot say which folder it belongs to.
      - **Scope = project:** today's behaviour, byte for byte. No new state
        paths, so this mode cannot regress.
      - **Scope = all:** `GET /api/mission/sessions` (every `mission_sessions`
        row, each tagged with its project) and `GET /api/mission/history` (every
        project's own-store conversations merged and date-sorted, one total cap,
        per-project errors reported instead of failing the whole read — a
        stopped PAD or an agent with no store must not blank the column).
      - Selecting a row in All mode **selects its project too**, so col 3's
        terminal is the right PAD's pane. That is the whole reason the badge
        matters: clicking a row you cannot then open would be worse than the
        current page.
      - `+ New session` in All mode is labelled with the col-1 selected project
        (`+ New in craftpip`) and starts THERE, staying in All scope. A session
        needs a folder, and the only honest answer to "which project?" is the
        one already selected in col 1, not a fresh picker. It does not jump back
        to This-project scope: the new session is in the list you are looking
        at, and yanking the view out from under the click is worse than staying.
      - Resuming a HISTORY row resumes it in **that row's** project, not the col-1
        one — the one mistake this view must never make.
      - Subfolder expansion in All mode applies to every project (one toggle),
        and the counts are summed per project rather than derived from the rows
        that happen to be loaded (they are not loaded until expanded).
      - **The whole history row opens the conversation**, like a live row does
        (click, Enter or Space; `role="button"`, `tabIndex=0`). It was a plain
        div with a small `resume` button in the corner, so clicking a
        conversation did nothing and one tiny target — repeated 100 times down
        the column — was the only way in. The corner now carries a noninteractive
        `.msn-history-hint` ("resume" / "opening…") that describes the row action
        instead of being a second, smaller version of it.
        **Superseded by plan 56:** the two group headers are gone, `resume` is
        gone, and the "resumed"/"agent" badges are gone — see §9b.
      - **Busy state is per action, not a column-wide flag.** A single click used
        to mark *all* ~100 rows `aria-disabled` and read "opening…", because every
        `HistoryRow` was handed the same global `starting` boolean. `startingKey`
        (project id + conversation key) is what the column keys off, so one click
        lights one row, and `+ New session` has its own key so an untouched
        button never claims to be opening.
      - **Double-activation guard lives in the store, not the row.** A
        double-click (or a click plus Enter) fired two POSTs in one tick and
        started two tmux sessions + TUIs on the same conversation — observed
        live as duplicate session pairs seconds apart. `startSession` refuses a
        repeat of the *same* key; a *different* row is allowed to start, and a
        monotonic token makes the older request leave the newer one's selection
        and busy state alone when it resolves late.
      Verified live on `opencode` with two projects: the All list shows both
      projects' conversations (149 → 159) badged and date-merged, an All-mode
      session carries its project badge and **moves col 1 with it** (the terminal
      cwd and the `+ New in …` label follow), a resume of a       *schlorp* row while
      *craftpip* was selected opened in `/www1/xdl`, both scope switches leave
      the column at the same x/width/gutter (no jump), a history row opens on a
      click anywhere in it (0 `msn-btn-resume` left, one row of 100 showing
      "opening…", `+ New session` unlabelled), two activations in one tick create
      exactly ONE session, and nothing clips at the 180px minimum width.
      `codex`/`claude` aggregates are wired, not verified against a PAD with real
      history.

      **Follow-up fixes found by clicking the page, not by reading it (Phase 6):**
      - Whole-row open: a history row is now the target (`role="button"`,
        Enter/Space, 0 `msn-btn-resume` left, `.msn-history-hint` describes the
        action instead of being a second target for it).
      - **One click must light one row.** The busy state was the global
        `starting` boolean handed to every `HistoryRow`, so a single click marked
        all ~100 rows `aria-disabled` and read "opening…". Now `startingKey`
        (project + conversation key) drives it, and `+ New session` has its own
        key so an untouched button never claims to be opening.
      - **The double-activation guard belongs in the store.** A double-click, or
        a click plus an Enter key, fired two POSTs inside one tick and opened two
        tmux sessions on the same conversation — observed live as duplicate
        session pairs seconds apart, four rows sharing one title. `startSession`
        refuses a repeat of the *same* key, allows a different row, and a
        monotonic token stops the older request from resetting the newer one's
        selection when it resolves late.
      - **Session-switch latency, measured at the socket** (first byte after
        `new WebSocket`, i.e. what the eye waits for): **1027ms median** (1013 /
        1027 / 1111) before any of this. The attach did three sequential
        `docker exec` round trips before emitting a pixel: `ensureTmux` +
        `hasSession` (inside `createSession`), then the attach exec. Fixes: a
        mission session skips `ensureTmuxSession` entirely — Mission created that
        tmux session itself and the DB row was verified two lines above, and
        re-creating it silently was how a dead pane came back as a bare shell —
        and a client that is only *swapping* sessions sends `history=0` so the
        server skips the two-exec scrollback replay into a buffer that is about
        to be repainted anyway. Measured after: **745ms** on the first pass but
        **~970ms warm** (968 / 809 / 1137) once the webui and docker are hot, so
        the honest reading is a modest gain inside the noise, not a 3× one. The
        remaining cost is tmux's own attach handshake plus the PAD's load, and
        the next item is very likely the real reason the delay *grows* over a
        working session.
      - **The attach-client leak is real, but it is NOT the latency cause** (I
        assumed it was; measuring it said otherwise, so the assumption is
        recorded here rather than quietly dropped). 20 orphaned
        `tmux attach-session` clients were live on one session, 5 on another.
        Mechanism: `activeTerminals` is in-memory, so a **webui restart orphans
        every attach it owned** — the exec'd processes outlive the process that
        started them, and the new instance has no record of them. The existing
        sweep cannot help: it `pkill`s *all* attach clients of a session, so it
        only runs when the last client leaves (that rule is what stops two tabs
        from kicking each other, and it must not be loosened). Verified
        NOT a leak: a clean WS close, and an abrupt tab close mid-attach — both
        reap correctly (3 open/close cycles left 0 orphans, count fell 26 → 24).
        Measured cost of the 20 idle orphans: **0.3% CPU, 71 MB RSS** — cheap,
        because they are idle. They do multiply every *redraw* (tmux pushes each
        repaint to all 20 clients instead of 1), which is real but unquantified.
        Cannot be reaped safely today: every attach-bearing session is still live
        in the DB, so nothing distinguishes an orphan from a user's open tab. The
        fix is PID tracking (attach writes its PID to a per-connection file;
        reap on cleanup and sweep leftovers at boot, verifying `/proc/<pid>/cmdline`
        before killing so a human's manual `tmux attach` over SSH is never hit).
      - **What actually costs the ~1.1s: the PAD's own load.** `pad-opencode-proj`
        runs 9 `opencode` processes at ~650 MB each (5.83 GB of 15.5 GB) and was
        at 297% CPU, two of them at 128% and 72%. Attach latency measured
        1082–1231 ms while that load was present. So the pause is the box being
        busy, not the webui's own path — worth saying plainly, because it means
        the remaining fix is "close sessions you are not using", not more code.
        Note the double-fire bug above was not free: each duplicate session runs
        its own `opencode` at ~650 MB, so four rows sharing one conversation
        title cost ~2.6 GB before it was fixed.
      - **The soft swap must not show the outgoing session.** The reused xterm
        kept the previous pane's output on screen under the new session's name
        for the whole attach — which reads as "it restarted from the beginning".
        It is now reset on swap, so the new attach paints into an empty buffer.
      - **Close code 4003, not 4002, for a closed mission session.** 4002 means
        "PAD stopped" and the client retries it with backoff; a closed session
        never comes back, so one Close produced an endless refusal storm
        (measured 29 refusals in 90s, still climbing). The client now stops on
        4003 with "This session was closed."
      - **OPEN, not fixed: the terminal can come up blank while reporting
        "Terminal Connected".** Reproduced with data actually arriving — the
        socket delivers ~37KB over 8 messages and the xterm renders nothing, on a
        plain page load as well as on a swap. Suspect is the client generation
        token: `initTerminal` does `++genRef.current` and `onmessage` drops every
        frame whose `gen` is stale, so any second `initTerminal` for the same
        session (the `[name]` mount effect and the `[name, controlled]` reconcile
        effect both call it) silently orphans a live socket whose output is then
        ignored. Not confirmed — needs the two effects' call order checked in a
        live page. Left open deliberately rather than "fixed" blind, because
        `Terminal.jsx` is shared by every PAD's terminal, not just Mission.

- [ ] **Phase 7 — absorb into `docs/` and delete this file.** New
      `docs/reference/pages/mission.md` (+ a `guide/` page if the user wants it
      in the user guide), links from `docs/README.md` and
      `docs/reference/pages/overview.md`, terminal-contract note in
      `docs/reference/tabs/terminal.md`. Gated on explicit user confirmation.
- [x] **Phase 8 — the agent can see, make, and join a session (§1b).** Built by
      **[plan 55](55-mission-mcp-tools.md)** (6 phases, P0–P5, **all complete
      2026-09-27**) — this entry stays the spec of record. New MCP
      tools `mission_projects` / `mission_sessions` (both in `READ_TOOLS`),
      `mission_project_create` (grant `create`), `mission_session_start` and
      `mission_send` (both grant `exec`); `tmux capture-pane` helper; the new
      names added to `TOOL_GRANT_FOR`/`READ_TOOLS` in `src/mcp.js:130`. Verify:
      from a real agent over `/mcp`, following **the same flow as the human**
      (§1a) — (a) create a PAD, then `mission_project_create` on it and see it
      appear in col 1; (b) `mission_session_start` and watch the TUI come up in
      the project's folder, badged "started by agent"; (c) `mission_sessions`
      overview + one session's screen tail; (d) `mission_send` visibly types into
      the human's TUI; (e) a key **without** the `exec` grant gets
      `Not permitted by API key tool grant: mission_send` (fail-closed, 52 F4
      style); (f) a key scoped to another user's PAD cannot read or create
      against it; (g) `mission_project_create` on an `openclaw` PAD is rejected;
      (h) `mission_send` on a **solo-locked** session returns
      `session is solo-locked by <user> — unlock it on the Mission page` and types
      nothing. **Live round done** (plan 55 §11): all of a–e, g, h green over
      authenticated `/mcp`; (f) has no second owner on this host so it stays
      unit-tested only. The `tmux capture-pane` helper turned out to be
      **unnecessary** — `pad-tmux.captureScreen` already existed, so no new tmux
      code was added. Built filter set: `mission_projects(agent?)` and
      `mission_sessions(session_id?, project_id?, agent?, lines?, limit?)`
      (the §1b table below is corrected to it). The live round also caught a real
      bug — a handler resolving the agent type itself hit the openclaw driver
      fallback; the rule "never resolve a type yourself, let `mission.agentRow`"
      is now in AGENTS.md.
- [ ] **Phase 9 — SUPERSEDED by plan 64 (user, 2026-09-29) — do not build.**
      A plan *is* the checklist item, with the session it is worked in, the last chat
      and real timings attached; a second `mission_checklist` table would be a
      competing source of truth for the same thing. The flow this phase describes
      ("do A, then B, then C" → work them one at a time in a visible session, ticking
      each off) is unchanged and is now expressed as plan files in `/plans` with
      frontmatter — see `plans/64-plans-facility.md` §1a. The original text is kept
      below for the reasoning only.

      **Original (2026-09-27) — superseded, retained for traceability.** Two small
      tables beside the mission ones:
      `mission_notes (id, project_id, text, created_by, created_at)` and
      `mission_checklist (id, project_id, seq, text, status pending|done,
      done_at, created_at)`. Four tools, deliberately: `mission_notes(project_id?)`
      (read — notes **and** checklist in one call), `mission_note_add`,
      `mission_todo_add(project_id, text)`, `mission_todo_done(todo_id)`. The
      first two are `read`, the writers `exec`.
      **The flow this buys (user, 2026-09-27 — option A):** you say "do A, then
      B, then C"; the LLM appends A/B/C to the checklist, then works them **one
      at a time in one visible session**, ticking each off as it goes. The
      checklist is what survives a closed chat ("what's left"), not a runner.
      No separate "run journal" table: the session *is* the transcript (tmux
      scrollback + the CLI's own store), so a parallel journal would duplicate
      it. Nothing here runs in the background. Verify: from a real agent, add
      three items, work the first, and prove (a) the other two are still listed,
      (b) ticking one off is reflected in the page, (c) a fresh LLM instance
      reads the checklist first and continues with the next item.
Phases 7–8 are additive to a working page — the page ships and is useful
without them. Nothing in Phases 0–6 depends on plan 52 any more: the headless
task path was retired and 52 was rewritten around sessions (2026-09-27). The one
remaining cross-plan tie is deliberate and narrow — 53 Phase 8 *implements* the
`mission_*` tools, while **52 Phase A owns their grant policy and the
fail-closed proof** (a key without `exec` must be refused `mission_send`), so
build A1/A2 before or alongside Phase 8. Phase 9 reuses 52's memory/journal
idea, rekeyed to projects.

---

## 8. Session audit — listing sessions and opening the TUI at one

Researched with the online docs **and verified live** in running PADs
(`pad-opencode-proj`, `pad-test-codex`, `pad-test-claude`, `pad-openclaw-cp`).
Versions below are what is actually installed, which is what matters.

**Scope of this audit: the three coding models only** (opencode, codex, claude) —
the personal agents don't get Mission projects at all, so their session CLIs are
recorded here as research only (last two rows) and build nothing.

| Type | In Mission | Installed | List sessions | Open the TUI at a session |
|---|---|---|---|---|
| opencode | ✅ | 1.18.32 | `opencode session list -n <n> --format json` → `[{id,title,updated,created,projectId,directory}]` | `opencode -s <id>`; `-c` = continue last; `--fork` branches; in-TUI `/sessions` (ctrl+x l) |
| codex | ✅ | 0.147.0 | **no list command** — the picker *is* the list. Store: `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`, line 1 is `{"type":"session_meta","payload":{session_id,cwd,cli_version,…}}` | `codex resume <uuid>`; `--last` skips the picker; `--all` disables cwd filtering (shows a CWD column); `codex -C <dir>` sets the dir |
| claude | ✅ | 2.1.197 | `claude agents --json` = **background sessions only**. Full history = `~/.claude/projects/<mangled-cwd>/*.jsonl` (*verify live in Phase 5* — the audited PAD had no sessions yet) | `claude -r <id\|name>`; `-c` = continue latest **in the current directory**; `-n <name>` names a session; in-TUI `/resume` |
| openclaw | ❌ out of scope | 2026.7.1 | `openclaw sessions --json --limit <n> [--all-agents]` → `{path,count,totalCount,limitApplied,hasMore,sessions[]}` | `openclaw tui --session <key>`. **⚠ `openclaw resume` does not exist in 2026.7.1** (`Unknown command: openclaw resume`) even though the docs page documents it — the capability lives on `tui --session`. Keys are agent-qualified (`agent:main:global`); bare `global` rows don't identify an owner |
| picoclaw | ❌ out of scope | — | none documented | none documented |
| hermes | ❌ out of scope | — | none documented | none documented |

Caveats that shape Phase 5:

- **opencode's list CLI blocks behind a running TUI's lock** and re-bootstraps the
  instance — that is why `app.js:493` reads the title straight out of
  `opencode.db` instead. Phase 5 should do the same: read the `session` table
  (`id,title,time_updated,directory`) for the list, keep the CLI as a
  cross-check. `directory` in the row is what lets the Mission page badge
  "3 conversations in this folder".
- **codex filters by cwd by default** — a mission project whose folder differs
  from where the conversation ran needs `--all`, and the list must be built from
  the rollout files (parse line 1 of each, sort by mtime).
- **claude's `-c` is directory-scoped**, so a mission project at a new folder
  legitimately has *no* "last conversation" — the empty state must say so rather
  than silently starting fresh.
- **openclaw / picoclaw / hermes**: not in Mission at all (user decision), so
  there is no "fresh session only" fallback to build for them.

---

## 9. Out of scope (explicit)

- **The personal agents: openclaw, picoclaw, hermes.** No Mission projects, no
  sessions, not in the picker, `400` from the API, no `tuiLaunch` (user decision
  2026-09-27: "keep the personal agents out of this"). If that changes later it
  is one `mission: { supported: true }` flag per driver — not a rewrite.
- **Headless work.** `task_submit` is not called from anywhere in the Mission
  flow and the page has no "run as a task" button (user decision 2026-09-27:
  "don't let the user start any task without my vision"). Plan 52 was
  **rewritten around `mission_*` sessions** the same day — its queue phases are
  retired, not pending.
- Mounting a host folder into a PAD from this page (Settings → Extra volumes /
  custom workspace, then a container recreate).
- Multiple terminal panes / split terminals inside col 3.
- Re-implementing the task queue in the UI: the page shows no queue at all, and
  submit/claim/steer/approve/cancel are not page actions. Task tools stay
  MCP-only, and the LLM does not use them for work (see above).
- Merging the two session concepts: a mission session is an **interactive TUI
  conversation**; a `tasks` row is a **headless run** that Mission never creates.
  They are not the same row and not interchangeable.
- **Pruning anything** (user decision 2026-09-27: "prune nothing, keep it as it
  is — let it grow"). No retention, no auto-delete of old sessions or projects,
  no cap on rows. A dead session row is a line of SQLite; the tmux session is
  gone either way when the PAD stops. Only explicit user deletes remove rows.
- Renaming/moving a project while its sessions are live (repointing a folder
  applies to sessions created after the change).
- An agent **destroying** a session (`mission_send` types into one, and the
  agent may *start* one — killing stays a human action, and the same-key
  guardrail 52 F4 already applies to task cancel).

## 9a. Defect log found while working the terminal (2026-09-27)

Ordered by how much each one cost. Two of these were found only by watching
`docker logs` / `docker events` rather than by reading code, which is the lesson
worth keeping: the symptom was "the terminal glitches", and nothing in the
client explained it.

1. **The webui was dying every ~45–245s, and that WAS the "glitch".** Not a
   rendering bug at all. The tell was in the log: a stack trace ending
   `Node.js v20.20.2` — the process dying — immediately after
   `[wss] connection:` bursts.
   - **Cause A (fixed):** the installed MCP SDK's request wrapper is
     `result = await Promise.resolve(handler(request, extra))` with **no
     catch** (`@modelcontextprotocol/sdk/dist/cjs/server/index.js` `wrappedHandler`,
     `server/mcp.js:executeToolHandler`). So *any* throwing tool handler escapes
     as an unhandled rejection and kills the process. One agent calling
     `workspace_list` on a PAD whose workspace is not host-browsable hit
     `requireHostBrowsable` (`services/workspace.js:296`) — a **correct**
     authorization rejection — and took the whole control plane down, repeatably.
     Fixed in `mcp.js`: all 29 tools register through a `registerTool` wrapper
     that converts a throw into `{ isError: true, content:[…] }`, so the agent
     gets a readable message and the server lives. (`McpError` still rethrows to
     keep its protocol code.)
   - **Cause B (fixed, defence in depth):** `app.js` now installs
     `unhandledRejection` + `uncaughtException` handlers that log the stack and
     **keep running**. A control plane supervises every PAD, holds every terminal
     WebSocket and every job log; dying because one request misbehaved costs far
     more than staying up.
   - **Cause C (unidentified, no longer occurring):** the later restarts had a
     different signature — `kill sig=15` → `kill sig=9` after **10s** →
     `die exit=137` → `start`, i.e. an explicit stop request with Docker's
     default grace, **not** a JS crash and **not** an OOM (`oom_kill 0` at the
     root cgroup). Not `/api/env/restart` or `/api/env/recreate` (both now log
     their caller loudly and neither appeared), not a host cron/systemd unit, not
     a recorded command in any PAD. It stopped when the host memory pressure
     ended (the PAD went 5.83 GB → 1.99 GB, 9 `opencode` processes → ~2), which
     is suggestive but not proof. The logging is left in place so the next
     occurrence is attributable instead of mysterious.
   - Consequence chain worth remembering: each death dropped every terminal
     WebSocket (the user's "glitch"), and because `activeTerminals` is in-memory
     each death also **orphaned every `tmux attach` it owned** — 29 clients on
     one session, so tmux was pushing every repaint to 29 receivers.

2. **Orphaned `tmux attach` clients (fixed).** The broad `sweepStaleAttaches`
   `pkill`s *every* client of a session, so it can only run when the last client
   leaves — right for regular terminals, useless for `msn-*` multi-client ones.
   Mission attaches now run `sh -c 'echo $$ > /tmp/paddock-at-<tok>-<conn>.pid;
   exec tmux attach-session -t <s>'`, so: cleanup kills **its own** client by PID
   (verified against `/proc/<pid>/cmdline` first, so PID reuse or a human's own
   `tmux attach` over SSH is never hit), and the first mission attach after a
   boot sweeps leftovers from the *previous* process.
   - **The first version of that sweep killed 4 live clients**, and the reason is
     the kind of bug that reads as correct: the guard `attachPidSwept.add()` runs
     before the `await`, but the sweep's `docker exec` only reaches the container
     ~400ms later — by which time other connects had connected *and written their
     own pid files*, which the bare glob then matched. Fixed by putting a
     per-process token in the filename and skipping our own.
   - Stale pid files self-heal at the next boot sweep; a file whose process is
     already gone is removed with a no-op kill.

3. **Attach latency ~1.1s is the PAD's load, not the webui.** 9 `opencode`
   processes at ~650 MB each, 297% CPU at peak, two of them at 128%/72%. Latency
   measured 1082–1231 ms under that load, 713–877 ms on a quieter box. Also worth
   noting: the fixed double-fire bug was not free — each duplicate session runs
   its own `opencode`, so four rows sharing one conversation title was ~2.6 GB.

4. **Ruled out for "glitches every few seconds"** (all verified in code, not
   guessed): the 3s `titleIv = setInterval(sendTitle, 3000)` frame only
   `setStateSafe(setDynTitle, …)` and returns without touching xterm;
   `checkShellBusy` (250ms) is pure client-side buffer reading;
   `syncBusy` only crosses a 400ms debounce. The real cause was #1.
5. **Switching scope remounted the terminal and dropped the conversation
   (fixed, plan 58).** Col 3 derived its session from the listing, and
   `setScope` empties that listing on purpose before refetching — so for ~200ms
   col 3 was `null`, `<Terminal>` unmounted, the WS closed, and the list landing
   remounted it (fresh xterm, fresh `tmux attach`, redraw). Selecting a project
   in col 1 did the same, because `select()` cleared `selectedSessionId`. The
   fix is the `openSession` snapshot described in §6. *The lesson generalises
   past this page: **a column that is refetched must not be what the next column
   renders from.** Any derived-from-the-list value is only as stable as the
   list's emptiest moment.*
6. **A quick ESC press was held ~500ms by tmux, not by the app (fixed, plan
   58).** Reported as "the esc key is delayed, I have to press it again".
   Ruled out by reading the whole path: `term.onData` sends on the spot, the
   WS handler writes each message straight to the stream, and every `Escape`
   listener in the app is gated on an open popup — there is no debounce,
   throttle or queue anywhere on the keystroke path. The cause was tmux's own
   `escape-time 500`, which holds an ambiguous ESC waiting to see whether it
   starts a key sequence. `pad-tmux.js` now applies `escape-time 10` as a PAD
   global alongside `history-limit` / `status off`.
   - **Two traps in applying and verifying it.** `-g` is server-wide per PAD, so
     it covers sessions we did not create, and it is only applied when *we*
     create a session — a PAD that has never had one keeps tmux's default.
     And **`tmux show-options -g` does not list `escape-time`**; it printed the
     other two options and silently omitted this one, so the "did it take?"
     check must be `tmux show-options -gv escape-time`.
   - **Measured with a control, on one live pane, changing only that option:**
     `escape-time 10` → 10/10 echoes, median **16.8ms**; `escape-time 500` →
     10/10 echoes, median **506.9ms**. Without that control the fast number
     proves nothing — a genuinely fast path would have looked identical.
     Regressions checked in the same `cat -v` pane: ArrowUp still arrives as one
     `^[[A` sequence (the reason `escape-time` exists), two ESCs 100ms apart both
     land, and Ctrl+C / Ctrl+D / Ctrl+L are unaffected.
   - The residual ~17ms is WebSocket + `docker exec` + pty, not tmux.

## 9b. One list, one dot (2026-09-27) — [plan 56](56-session-open-marker.md)

The listing used to be two stacked groups, `Running` (tmux sessions Mission
opened) and `History` (the agent's own conversations), each row also carrying a
`resumed` / `agent` badge and a `resume` hint. The user asked for one list whose
only per-row difference is a dot marking **open**, and for the dot to mean
"open" rather than "we happen to have a pane of our own on it".

**What changed**

- One sticky `msn-group-sessions` header ("Sessions (N)") and one merged list,
  live sessions and history interleaved, newest activity first
  (`last_seen_at || created_at` for a live row, `updatedAt` for a history row).
  The `top-[23px]` sticky offset hack is gone with the second header.
- **Duplicates are collapsed.** A resumed conversation is in both sources at
  once — a live row keyed by tmux id and a history row keyed by the agent's
  session id — and merged that would print it twice with two dots. History rows
  whose id is some live row's `agent_session_id` are dropped; the live row wins.
-   The `resumed` and `agent` badges are deleted, the `resume` hint is deleted (it
  survives only as `opening…` while that one row's click is in flight), and a
  live row's second line now shows *when it was used* instead of its tmux id, so
  the two row types are the same shape. The name takes the full row width — and,
  since the row was later split into an explicit name line and a state line, the
  name line takes it *alone* (see "A row is two lines" below).
- The close confirmation now renders **inside** its own row's map entry, so it
  cannot outlive the row it belongs to (the old single block after the list was
  keyed on the id alone and survived a successful close).

**The dot's new source, and the two bugs found while proving it**

- `open = live || busy`. `busy` comes from the opencode server's
  `GET /session/status?directory=<project folder>`, which reports
  `{ [sessionID]: { type: 'busy' | 'idle' | 'retry' } }` for **every** client —
  the web UI, an SDK script, a second TUI. `retry` counts as busy.
- **The `?directory=` is the whole mechanism, not a filter.** Unscoped, the
  server answers `{}` even while a turn is streaming: measured, an 8.2s turn
  with 25 polls during it, `{}` on every one. Scoped to the folder the turn runs
  in, the same poll returns `{"ses_…":{"type":"busy"}}` immediately. A probe
  without it looks like a working probe that always answers "nothing is
  working" — indistinguishable from the bug it was written to fix.
- The port must come from the PAD's own `web.containerPort`, never the driver
  default (driver says 8080, the server running here is on 7890).
- **A live row carries no folder, so the call sites must pass one.** Left off,
  every live row silently reported `busy: false` — caught only by cross-checking
  the API against the raw status map, because the history rows were already
  correct and the page looked right.
- **`withAgentBusy` groups by (PAD, folder), not by PAD.** Three projects share
  `pad-opencode-proj`; keying on the PAD alone asked about the first folder and
  stamped that answer on the others' rows.
- A live row whose pane is gone but whose conversation is being worked on in the
  web UI is **not** dead: the dot lights and the second line reads "working now —
  your session's pane is gone". `paneGone` and `open` are two questions.
  *(Superseded by plan 58, 2026-09-28: that second line is gone along with the
  rest of the pane vocabulary. The dot still lights, because `busy` still makes
  the row `open` — but the row no longer explains itself in our language. See
  §6.)*

**What the dot cannot mean.** The status map is a live-work registry, not a
presence list: it empties the moment a turn completes, and the server exposes no
client/connection registry to ask instead. A conversation that is merely *open*
in the web UI with nothing in flight reads as closed. Also opencode-only — codex,
claude and hermes keep mission liveness alone (`busyKnown: false`).

Verified live in the browser: `paddock` project, 55 rows in one list, 4 lit dots
all reporting "the agent is working on this conversation right now" while both of
that project's own tmux sessions were gone.

**A row is two lines, and only two lines (user, 2026-09-27).** Line 1 is the
session name and nothing else — no dot, no badge, no buttons, measured
`line1.children.length === 0`, so a long name gets the column's full width and
names scan down one axis. Line 2 is the state line: the dot, the project name
(all-projects scope only), and the *when* text **flush right**. A history row is
the same two lines with the conversation title on line 1.

- **The dot is mounted only while the row is active — it reserves nothing.**
  Green (`bg-success`) and no dot otherwise, in both the live and the history
  row. Reserving a 6px circle plus its 6px gap for a state that isn't there
  reads as a hole in the row, and the badge was measured 12px further right on a
  lit row (86px) than on an unlit one (74px) purely because of that gap. So the
  state text does shift 12px when a turn starts; that is the accepted trade for
  not lying about the state. `paneGone` and `open` remain two questions — an
  unlit row whose pane died is styled dead by the row, not by the dot.
- **Flush right took three attempts, and two of them are traps worth naming.**
  1. `ml-auto` on the project badge left the time trailing the badge, so it was
     only flush by accident on rows whose badge happened to be the same width.
  2. `hidden` + `group-hover:flex` on the buttons reserves no space but
     **`display: none` children cannot take focus**: tabbing onto the row
     revealed the buttons, the next Tab blurred the row, the reveal vanished and
     focus fell to `<body>`. The Close button was unreachable by keyboard, and
     `focus-within` cannot rescue it (it can only match an element that already
     has focus).
  3. `opacity-0` in flow keeps the buttons focusable but **an invisible flex
     child still reserves its 41px** — the "you are hiding it but it still takes
     space" complaint, one element over.
  The answer is **absolute + `opacity-0`**: the buttons are
  `absolute bottom-3 right-3` on the `relative` row, so they reserve nothing and
  never go `display: none` (focusability intact), the time takes `ml-auto` and is
  flush right at rest, and the time fades out (`group-hover:opacity-0`) under
  the buttons so the swap is clean rather than two layers of text.
- **`pointer-events-none` on the hidden buttons is a safety requirement, not
  tidiness.** An `opacity: 0` element still takes clicks, so without it a click
  on the *time* — meant to select the row — lands on the invisible Close button
  and kills the user's session. Verified by `elementFromPoint` at the time's own
  coordinates: the row, never a button, while idle; the button only once the row
  is hovered or a button inside it holds focus.

Verified live in the browser (all-projects scope, `paddock`): every row measured
`flushGap === 0` against the row's own content edge, dot green on active rows and
absent on inactive ones, badge at x=86 lit / x=74 unlit, `line1.children.length
=== 0`, the idle row's time hit-testing to the row rather than a button, and
tab → row → Close button reachable (`document.activeElement` lands on the lock
button with the group revealed).

**The lock and close buttons share one icon geometry (user, 2026-09-27).** Two
buttons with the same padding still read as crooked when the glyphs differ: a
🔒 emoji renders 12px tall next to a 5px ×, each with its own font metrics and
built-in bearing (measured boxes identical, ink not). So both buttons are now
identical 16px boxes (`flex h-4 w-4 items-center justify-center`, `leading-none`)
holding identical 12px stroked SVGs — padlock with closed vs open shackle for the
two lock states, two stroked lines for Close — measured 16×16 at the same y with
12×12 ink at the same y. Same rule as the 14px row chevron: a control's only icon
is a looked-at SVG, never a glyph. Titles and handlers untouched.

## 10. Risks

- **Single-client tmux policy** (`activeTerminals`, key `${vmName}/${session}`):
  today only one client may hold a session, and a second attach triggers the
  takeover dialog. Two decisions (user, 2026-09-27): mission sessions are
  **shown** in the agent-detail page's terminal strip (not filtered out — you
  want them reachable from both places), and **multiple clients may attach to
  one `msn-*` session at once** (two browser tabs, you and the LLM, phone +
  desktop). So the single-client rule is **exempted for `msn-*` sessions only** —
  other sessions keep today's behavior. Because both surfaces use the same
  `${vmName}/${msn-id}` key, attaching from the agent page while Mission has it
  open is *not* a conflict; it is the same tmux session, mirrored.
- **TUI launch race**: `send-keys` fires before any client attaches; the
  terminal's scrollback replay covers it, but verify the first paint on a slow
  PAD before declaring Phase 4 done.
- **opencode/AGENTS.md-level lock contention** on `session list` (see §8).
- **Two writers in one TUI: accepted, not engineered around** (user, 2026-09-27:
  "we do not have to worry about the writers… it is not my session or the LLM
  session, it is just sessions that both can use"). tmux mirrors one session to
  every attached client, so interleaved keystrokes are *visible to both* rather
  than hidden. The only guard kept is structural: sends are Enter-terminated
  lines, never injected keystroke-by-keystroke into a raw-mode TUI, and a send
  is skipped when the captured screen shows a modal/selector. The "agent is
  typing" badge stays, informational. The **solo lock** is the escape hatch when
  you want the session to yourself.
- **The agent can start sessions**, so a runaway orchestrator could open TUIs
  that burn tokens in a PAD you are not watching. `origin='agent'` rows are
  badged and the session is one click from being watched; no cap (open question
  6).
- **Confidentiality**: `mission_sessions` exposes the human's screen contents to any
  key with the read grant — scope it to owner PADs by default, and treat
  transcript capture as sensitive in the key-management UI (Phase 8).
- **Folder drift** (found by reading the live mounts, §4): a project folder is a
  *container* path that can vanish under the project — an extraVolume removed in
  Settings, or a container recreate that changes the layer. Sessions then fail to
  start with a confusing `can't cd` error. Mitigate with the re-probe badge in
  col 1 and a 400 with the exact reason on session create.

## 11. Open questions for the user

1. Repointing a project's folder: apply to existing sessions too (requires
   `tmux send-keys 'cd <new>'` per live session) or only to new ones? Plan
   assumes **new only**.
2. Should col 2's session list also show the agent's own previous conversations
   (Phase 5) inline, or behind a separate "Previous conversations" disclosure?
   Plan assumes **separate disclosure**.
3. Should a project be deletable while its sessions are alive (killing the TUI),
   or must the user close sessions first? Plan assumes **delete cascades, with
   a confirm that names the session count**.
4. `mission_send`: should an agent be able to type into a session the human is
   currently looking at (default), or only into *idle/unselected* sessions?
   **Resolved 2026-09-27 (user): yes** — the workspace is shared in both
   directions and both sides type into the same session; the badge is the only
   guard asked for (see §1b).
5. ~~Queue strip per project or fleet-wide?~~ **Moot** — there is no queue
   strip; the headless path was retired (2026-09-27).
6. Now that the agent may start sessions too: should the page cap or confirm
   agent-started sessions per project (a runaway orchestrator burning tokens in
   a PAD you are not watching), or is the `origin='agent'` badge enough? Plan
   assumes **badge only, no cap** — cheapest, and reversible, and consistent
   with "let it grow".
7. ~~**Plan 52 scope.**~~ **Resolved 2026-09-27 (user): rewrite plan 52 around
   `mission_*` sessions** — one orchestration story, sessions all the way down.
   52 now owns keys/grants, conferral, the playbook and the proof phases, and
   its queue phases (submit/claim/steer/approve/watch, worker pull) are retired
   along with the five risks they carried.

**Resolved 2026-09-27 (user):** open question 6 ("may an LLM start a session?")
— **yes, the LLM creates sessions too.** `mission_session_start` is therefore
in Phase 8 (§1b), stamped `origin='agent'`. The model is now: the human and the
LLM both create projects and sessions in them, and both work in the same live
sessions, each able to read the other's screen tail. There is no third kind of
work: `task_submit` is not used, so nothing runs outside your vision.

## See Also

- `plans/52-orchestrator.md` — keys, grants, memory/journal; its task-queue
  phases are **pending a scope decision** (§11 Q7) now that Mission sessions are
  the only work path. §1b reconciles its "no new screens" law with this page
- `plans/47-agent-task-queue.md` — the headless `opencode run` mode (not used by
  the LLM as of 2026-09-27)
- `docs/reference/tabs/terminal.md` — the tmux/WS terminal contract Phase 1 extends
- `docs/reference/backend/drivers.md` — driver fields, `tuiCommand`, `workspaceDir`
- `docs/reference/STYLE-GUIDE.md` — for the Phase 7 docs absorb
