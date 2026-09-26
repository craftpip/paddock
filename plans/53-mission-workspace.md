# Plan 53 — Mission page: 3-column project → session → agent TUI workspace (the orchestration UI)

## Status: In progress (2026-09-27) — design + live session/resume audit done, **1/9
phases built** (Phase 0–8). **Phase 0 (store + validation) is DONE and verified
live** (2026-09-27): `mission_projects` / `mission_sessions` tables, the
`src/services/mission.js` store, the `mission.supported` driver flag on the three
coding drivers, and the `/api/mission/*` CRUD routes — 19/19 store tests green
(`src/test/mission.test.js`) plus a live curl round-trip (create project on
opencode/codex/claude, `mission_unsupported_agent` on picoclaw/hermes/openclaw,
404 on a ghost agent, CSRF enforced, agent-origin session, solo lock, delete
cascade). **Next: Phase 1** (tmux cwd + `tuiLaunch` actually launching the TUI, so
a session goes live). Scope widened 2026-09-27: the
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
| 1 | **Projects** — name, agent badge, folder | "No projects yet" + **+ New project** |
| 2 | **Sessions** of the selected project — name, live/dead dot, started-at | "Select a project" / "No sessions yet" + **+ New session** |
| 3 | **The agent's TUI**, live, for the selected session (reuses `components/Terminal.jsx`) | "Select a session" |

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
| **Share** | Whoever needs to work uses an **existing** session or opens a **new** one. No "mine vs yours" | Phase 7 tools below |

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

**What the agent gets** (Phase 7 — new MCP tools in `src/mcp.js`, grants
reusing the existing buckets in `src/mcp.js:130`: `READ_TOOLS`, and
`TOOL_GRANT_FOR`):

| Tool | Does | Grant |
|---|---|---|
| `mission_projects(agent?)` | The user's projects (+ session count, live count). `agent` filters to one PAD. | read → add to `READ_TOOLS` |
| `mission_sessions(session_id?)` | No id → sessions across the caller's projects, with project name, agent, folder, live/dead. With an id → that session's detail **plus the tail of what its TUI is showing right now** (`tmux capture-pane -p -t <msn-id>`, last ~40 lines) | read → add to `READ_TOOLS` |
| `mission_project_create(name, agent, folder?)` | Create a project on a PAD the caller owns — the LLM-side twin of the "+ New project" dialog, for the flow "create agent → create its project → work in it". `folder` defaults to that agent type's `driver.workspaceDir`; validated as an existing dir **inside the PAD** by the same probe as §4. Creates a row only — no container, no tmux, no shell. | `create` (same bucket as `create_agent`) |
| `mission_session_start(project_id, label?)` | **The LLM works with you, in a session you can watch** (user decision 2026-09-27). Same server path as the page's "+ New session": fresh `msn-*` tmux session with `-c <project folder>`, then the driver TUI launched (`tuiLaunch.fresh`). The row is stamped `origin='agent'`, so the page badges it "started by agent". 409 if the PAD is stopped. | `exec` — it spawns a real TUI that burns tokens, so it rides the same bucket as `task_submit`, not `create` |
| `mission_send(session_id, text)` | Type a line into a live session's TUI (`tmux send-keys`) — the LLM's way of *using* a session that already exists. Refuses with a clear error when the session is **solo-locked** (your "drive alone" switch) | `exec` (same bucket as `task_steer`/`task_submit`) |

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
src/client/src/pages/mission/ProjectList.jsx      col 1
src/client/src/pages/mission/SessionList.jsx      col 2
src/client/src/pages/mission/ProjectDialog.jsx    the "+ New project" modal
src/client/src/components/Splitter.jsx            reusable mouse-resizable divider
src/client/src/stores/mission.js                  zustand store (mirror stores/agents.js)
```

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
- [ ] **Phase 1 — `ensureTmuxSession` cwd + `tuiLaunch` + the `mission` flag.**
      `-c <cwd>` on `new-session`, `send-keys` launch, unit test for the argv
      shape; `tuiLaunch` on the three coding drivers only, `mission: {supported}`
      on all six (false for openclaw/picoclaw/hermes). Verify live: `pad_exec` a
      manual `tmux new-session -d -s probe -c /tmp && tmux send-keys …`
      round-trip, then the API.
- [ ] **Phase 2 — the page skeleton: 3 columns, empty states, resizable.**
      `Splitter.jsx`, nav link, route, no data. Verify in the browser: empty
      copy renders, both splitters drag, widths survive a reload.
- [ ] **Phase 3 — projects end-to-end.** Dialog (coding-model agent select only
      + "create an agent first" link, folder field + suggestions chips +
      validation + duplicate warning), create/edit/delete, col 1 live. Verify:
      create a project against a real `opencode` PAD; create a **second project
      on the same PAD with a different folder** (from the suggestions chips) and
      see both in col 1; confirm an `openclaw` PAD is not offered; change the
      folder; delete one.
- [ ] **Phase 4 — sessions end-to-end.** `+ New session` → row + live TUI in
      col 3, restart/delete, dead-session repair, the **solo lock** toggle
      (row flag + col 3 padlock), `msn-*` **visible** in the agent-detail
      terminal strip, and **multi-client attach allowed** for `msn-*` (the
      `activeTerminals` single-client rule exempted for that prefix only).
      Verify live on a real
      `opencode`, `codex` **and** `claude` PAD: the TUI comes up **in the chosen
      folder** (`pwd` visible), survives a page reload (reattach), and a PAD
      restart shows the dead dot + working restart. Two projects on one PAD run
      their sessions in different folders at the same time. Two browser tabs on
      one session both see it, and so does the agent-detail page's terminal.
- [ ] **Phase 5 — agent session listing + resume (the §8 audit, built).**
      `GET /api/agents/:name/agent-sessions` for the three coding drivers, a
      "Previous conversations" list in col 2, and "Open in TUI" wiring
      `tuiLaunch.resume`. Verify per driver on a PAD that really has sessions.
- [ ] **Phase 6 — absorb into `docs/` and delete this file.** New
      `docs/reference/pages/mission.md` (+ a `guide/` page if the user wants it
      in the user guide), links from `docs/README.md` and
      `docs/reference/pages/overview.md`, terminal-contract note in
      `docs/reference/tabs/terminal.md`. Gated on explicit user confirmation.
- [ ] **Phase 7 — the agent can see, make, and join a session (§1b).** New MCP
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
      nothing.
- [ ] **Phase 8 — project memory + the ordered checklist (how the LLM works
      "one after the other").** Two small tables beside the mission ones:
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
remaining cross-plan tie is deliberate and narrow — 53 Phase 7 *implements* the
`mission_*` tools, while **52 Phase A owns their grant policy and the
fail-closed proof** (a key without `exec` must be refused `mission_send`), so
build A1/A2 before or alongside Phase 7. Phase 8 reuses 52's memory/journal
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
  transcript capture as sensitive in the key-management UI (Phase 7).
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
in Phase 7 (§1b), stamped `origin='agent'`. The model is now: the human and the
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
- `docs/reference/STYLE-GUIDE.md` — for the Phase 6 docs absorb
