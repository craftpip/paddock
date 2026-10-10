# Plan 55 — Mission over MCP: the agent-visible session surface (executes plan 53 Phase 8)

## Status: Complete (2026-09-27) — **6/6 phases (P0–P5), nothing deferred.**
All five tools are built in `src/mcp.js`, registered (34 tools live, verified by
`tools/list`), documented in `llm-guide.js` + `docs/reference/backend/services.md`
+ AGENTS.md, and covered by `src/test/mcp.test.js` (**65 tests green**, up from
64 — see the build record for the one bug the live round found). The live matrix
in §6 ran green over authenticated `/mcp`: real projects/sessions read, a real
claude TUI started in the right folder and typed into through `mission_send`,
and every fail-closed path (read key, solo lock, dead session, unsupported type,
mistyped PAD, unknown id, folder missing) refused with its machine code. The
build record is §11. Cross-plan owner boundary unchanged: **53 owns the page +
the store + these tools, 52 owns keys/grants policy** (52 Phase A2 owns the grant
buckets, this plan implements the tool side of them).

---

## 1. The gap (the user's words)

> "Is there a function to list sessions in a project or just sessions?"

No. The MCP surface is 29 tools (`src/mcp.js:257` `registerTools`) and **not one
of them touches Mission**. The Mission page, the store and `/api/mission/*` all
exist and work; an LLM driving Paddock through `/mcp` is blind to the only
surface the user actually works in. `app.js:2636` even documents "the API the
MCP `mission_send` tool calls" — a tool that was never written.

So this plan adds the agent-visible half of Mission: an LLM can **see** the
user's projects and sessions, **read** what a session's TUI is showing right now,
**open** a session in a project, and **type into** a session the user is already
driving. It does not build a second control plane, and it does not resurrect the
headless task path (retired 2026-09-27, plan 52 §3).

## 2. Scope — five tools, two nouns

Same shape as plan 53 §1b, plus the filters the user's question implies (that is
the one deliberate deviation from 53 §1b, marked below; plan 53 gets a line
saying so, so the two files cannot drift).

| Tool | Does | Grant | Anchor |
|---|---|---|---|
| `mission_projects(agent?)` | The caller's projects with `sessionCount` + `liveCount`; `agent` filters to one PAD | read → `READ_TOOLS` (`src/mcp.js:112`) | `mission.listProjects` + `mission.withLive` |
| `mission_sessions(session_id?, project_id?, agent?, limit?)` | No id → session list (project name, agent, folder, `live`); with `session_id` → that session's metadata + pane state + the **tail of what its TUI is showing** (`capture-pane -p`, default 40, max 200 lines) | read → `READ_TOOLS` | `mission.listSessions` / `mission.listAllSessions` + `mission.withLiveSessionsByAgent` / `mission.screen` |
| `mission_project_create(name, agent, folder?)` | Creates a **row only** — no container, no tmux, no shell. The LLM-side twin of the "+ New project" dialog | `create` bucket | `mission.createProject` + `mission.projectFolders` probe |
| `mission_session_start(project_id, label?, agent_session_id?)` | The server path behind "+ New session": fresh `msn-*` tmux session with `-c <project folder>`, then the driver TUI launched. Row stamped `origin='agent'` so the page badges it | `exec` bucket (it spawns a real TUI that burns tokens) | `mission.startSession` |
| `mission_send(session_id, text)` | Types a line into a live session's TUI. Refuses on a **solo-locked** session with the lock's reason | `exec` bucket | `mission.sendText` |

**Deviation from plan 53 §1b (deliberate, needs the user's nod):** 53 lists
`mission_sessions(session_id?)` only. The user asked specifically about *"list
sessions in a project **or** just sessions"*, so the tool takes `project_id` and
`agent` filters too, and `limit` (default 50, max 200) so a wide fleet does not
drown the context. Still one noun, one tool — no verb soup.

**Candidate tools — NOT in this plan, listed so they are not silently lost.**
Each needs a user yes/no before it is built:

- `mission_history(project_id?, limit?, subfolders?)` (read) — the agent's own
  conversations in the project's folder (`opencode.db` / codex rollouts / claude
  jsonl) via `mission.agentHistory` / `allAgentHistory`. This is what answers
  "what has been worked on here" and it is *not* in `mission_sessions`. Same
  subject plan 53's col-2 history strip shows the human.
- `mission_session_close(session_id, confirm)` — plan 53 §1b keeps destruction a
  human action ("the agent may create a project and open a session; killing
  either stays a human action"). The cost of that rule is real: an agent that
  opened a session cannot end it. If we want it, the narrow shape is
  `confirm: true` + refuse on any session with a human attached
  (`tmux list-sessions` `session_attached=1`, which `padTmux.listSessions`
  already returns) + refuse on `origin='human'`. Decide with the user (Q1).

## 3. Ownership and grants — fail-closed, no new identity

`/mcp` has **no caller-PAD identity**: it sees an API key and nothing else
(plan 53 §1b "Enforcement note"). So the whole gate is per call:

1. **Target grant** — `targetAllowed(user, padName)` (`src/mcp.js:151`).
2. **Owner/admin** — `requireAccess(user, padName)` (`src/mcp.js:101`), reached
   through the existing `requireTool(user, tool, padName)` (`src/mcp.js:177`).
   Every Mission row carries its PAD: a project has `agent_name`, a session
   resolves to its project first. **No `mission_*` tool may call a service
   function before it has resolved the project and read that PAD name** —
   `requireTool` needs the name, so the resolve-then-gate order is the design.
3. **Tool grant** — `toolAllowed` (`src/mcp.js:160`) via the new `TOOL_GRANT_FOR`
   entries: `mission_project_create: 'create'`, `mission_session_start:
   'exec'`, `mission_send: 'exec'` (`TOOL_GRANT_FOR` at `src/mcp.js:121`).
   The two read tools join `READ_TOOLS` (`src/mcp.js:112`), which is what makes a
   `read`-scoped key able to *watch* the user work without being able to type.

**No new API-key scopes.** `TOOL_GRANTS` in `src/services/api-keys.js:27` stays
`['lifecycle','recreate','create','delete','reset']`; the Mission writers ride
the existing `create` and `exec` buckets. `Profile.jsx:8` (`SCOPES = ['default',
'read', 'control']`) needs no change either. Plan 52 A2 owns the *policy* (which
key gets which bucket); this plan only implements the mapping.

**Read scoping for the list tools** (the one thing `requireTool` cannot do,
because a list spans many PADs): mirror `missionAllowedAgents` from
`app.js:2404` — admin → `null` (no filter), otherwise the caller's owned agent
names from `agents.owner_id` — and pass it as `listProjects({ agents })` /
`listAllSessions({ allow })`. A key that may see one PAD sees only that PAD's
projects, and a project on someone else's PAD is `mission_project_not_found`-ish
(403 in the REST layer; over MCP a plain "not found or not yours" so the tool
does not confirm the existence of another user's row).

## 4. Backend design (what actually gets written)

All of it lands in `src/mcp.js`, in a new `─── Mission (plan 55) ───` section
after the task-queue block (`src/mcp.js:834`–`1041`). **No logic in the tool
handlers** — they are thin adapters over `src/services/mission.js`, exactly like
every other tool (docs rule: behaviour lives in services).

- `const mission = require('./services/mission');` — safe: `mission.js` requires
  only `db`, `drivers`, `pad-tmux`, `workspace`. **It must never require
  `./app`** (AGENTS.md: `mcp.js` must not drag in Express).
- **`missionFail(err)` — new helper (`src/mcp.js`, next to `taskError`).** A
  `MissionError` carries `{ code, message, status }` and the machine code is the
  thing the LLM branches on (`mission_session_locked` → do not retry,
  `mission_folder_missing` → fix the project first, `mission_agent_stopped` →
  start the PAD). `errorResult` (`src/mcp.js:227`) only prints `err.message`, so
  the code would be lost; convert explicitly:
  `if (err instanceof mission.MissionError) throw new McpError(ErrorCode.InvalidRequest, \`${err.code}: ${err.message}\`)`
  and let the `registerTool` wrapper turn it into a tool error. Every async
  Mission handler wraps its body in `try { … } catch (e) { missionFail(e) }`.
- **Liveness is one `list-sessions` per PAD, never per session** — use
  `mission.withLive` for `mission_projects` and
  `mission.withLiveSessionsByAgent` for the multi-PAD session list. Asking
  `paneState` per row turns a 20-row list into 20 `docker exec`s; that mistake is
  already paid for once in the REST layer, do not repeat it. Liveness failure is
  decoration: fall back to the un-stamped rows, never fail the list (same as
  `app.js:2477`).
- **`mission_sessions(session_id)`** = `mission.screen(id, lines)` (metadata +
  `state` + screen tail) — the same shape `GET /api/mission/sessions/:id`
  returns (`app.js:2628`), so the human and the LLM read the same object.
  Clamp `lines` to 1–200 in the zod schema: an unbounded `capture-pane` into an
  LLM context is a self-inflicted context overflow.
- **`mission_session_start`** passes `origin: 'agent'` and the driver's
  `tuiLaunch.fresh`/`resume` through `mission.startSession` unchanged. Do NOT
  re-implement the folder check — `startSession` already does
  `padTmux.folderExists` and refuses with `mission_folder_missing` because
  `tmux new-session -c` does not fail on a missing dir (AGENTS.md).
- **`mission_project_create`** validates the folder with the same PAD-side probe
  the dialog uses (`mission.projectFolders`, `app.js:2461`) and refuses
  `mission_bad_folder` / non-existent rather than writing a row that can only
  ever fail at `mission_session_start`.
- **`mission_send`** goes through `mission.sendText` and nothing else — it is
  the one writer path, so the solo lock is honoured in exactly one place
  (`mission.js:484` → `assertNotLocked`, `mission.js:246`). Never
  `padTmux.sendText` directly from a tool.
- **LLM guide** (`src/services/llm-guide.js`): a **Mission** paragraph in the
  tool-surface section (after the task-queue paragraph at line 42), 3 workflow
  recipes (survey projects → read a session's screen → start/join a session),
  and a caller rule: *read `mission_sessions` before typing into a session you
  did not start; a solo-locked session is a deliberate "I am driving alone" —
  move on, do not retry.* A tool the guide never mentions is a tool the LLM
  guesses at.
- **Docs**: `docs/reference/backend/services.md:436` (the MCP Tools table — bump
  "29 tools" → 34 and add five rows), and a note in the Mission page doc when 53
  Phase 7 lands. AGENTS.md gets one line: `mcp.js` may `require('./services/mission')`,
  it may not `require('./app')`.

## 5. Phases

- [x] **P0 — the two read tools.** `mission_projects` + `mission_sessions`
      (list mode only), `READ_TOOLS` entries, `missionFail` helper, ownership
      filter from §3, liveness via `withLive` / `withLiveSessionsByAgent`.
      Verify: from a real agent over `/mcp`, the list matches what the Mission
      page shows for the same user, and the `live` flags agree with the page's
      dots. This phase alone is what the user asked for.
- [x] **P1 — `mission_sessions(session_id)` screen tail.** Clamped `lines`.
      Verify: an agent-started prompt typed on the page is visible in the tail
      within a second; a `msn-*` session that is NOT live returns
      `live: false` + empty screen rather than an error.
- [x] **P2 — `mission_project_create`.** Grant `create`, folder probe,
      `origin`/ownership rollback is not needed (no row is created on failure —
      unlike `app.js:2494` which creates then deletes, because the probe runs
      *before* `createProject` here). Verify: the project appears in col 1 of
      the page without a reload beat, and `mission_project_create` on an
      `openclaw` PAD is refused `mission_unsupported_agent`.
- [x] **P3 — `mission_session_start`.** Grant `exec`, `origin:'agent'`.
      Verify: the TUI comes up **in the project's folder** (`paneState().cwd`
      equals `project.folder`, checked in the tool's own response), the page
      badges it "started by agent", and a stopped PAD gives
      `mission_agent_stopped` (not a mystery timeout).
- [x] **P4 — `mission_send`.** Grant `exec`, solo-lock refusal, dead-session
      refusal. Verify: typing a line in the agent's terminal and watching it
      appear in the user's attached terminal; `mission_send` on a solo-locked
      session types **nothing** and says the session is locked.
- [x] **P5 — guide + docs + the fail-closed proofs.** `llm-guide.js` Mission
      section and recipes; `docs/reference/backend/services.md` table; AGENTS.md
      line; the whole verification matrix in §6 green; **plan 53 Phase 8
      checkbox ticked and its §1b tool table corrected to the P0 filter set.**

## 6. Verification

**Unit — `src/test/mcp.test.js`** (add to the existing `buildServer()` /
`client.listTools()` harness at `src/test/mcp.test.js:9`):

- all five names in `listTools()`; each schema carries its documented params.
- `toolAllowed(user, 'mission_send', pad)` is false for a `read`-scoped key and
  true for one with the `exec` bucket; `mission_session_start` likewise;
  `mission_project_create` needs `create`; both read tools allowed for `read`.
- a `mission_send` call from a key scoped to **another user's** PAD throws
  before the service is reached (assert `mission.sendText` was not called);
  `mission_projects` for that key does not list the other user's project.
- a `MissionError` with a code comes back as a tool error whose text contains
  the code (`mission_session_locked`).
- `mission_sessions` without an id issues exactly **one** `listSessions` per
  distinct PAD (monkeypatch `padTmux.listSessions` and count, the way
  `src/test/mission.test.js:482` does).

**Unit — `src/test/mission.test.js`** or a new `mission-mcp.test.js`: the tool
handlers against seeded rows, `padTmux` methods monkeypatched
(`folderExists` / `createSession` / `sendCommand` / `paneState` / `listSessions`),
per the pattern at `src/test/mission.test.js:517`.

**Live, from a real agent over `/mcp`** (plan 53 Phase 8 matrix, kept verbatim
so the two plans cannot disagree):

- (a) create a PAD, `mission_project_create` on it, see it in col 1;
- (b) `mission_session_start` → TUI up in the project folder, badged "started by
  agent";
- (c) `mission_sessions` overview + one session's screen tail;
- (d) `mission_send` visibly types into the human's attached TUI;
- (e) a key **without** `exec` gets `Not permitted by API key tool grant:
  mission_send` (fail-closed);
- (f) a key scoped to another user's PAD can neither read nor create against it;
- (g) `mission_project_create` on an `openclaw` PAD is rejected;
- (h) `mission_send` on a solo-locked session types nothing and says so.

Plus: `docker restart paddock` before the live round (backend edit — Node caches
`require()`), and re-run `timeout 60 docker exec paddock node --test
test/mission.test.js` and `test/mcp.test.js` **individually** (never the combined
suite — it hangs).

## 7. Open questions for the user

- **Q1 — may an agent close a session it started?** (see §2 candidate). Default
  if unanswered: no, per plan 53 §1b — the human closes.
- **Q2 — filters on `mission_sessions`.** This plan adds `project_id` / `agent` /
  `limit` to what 53 §1b specifies. Confirm, or keep 53's `session_id`-only shape.
- **Q3 — `mission_history`?** The agent's own conversations in a project folder
  (the thing col 2 shows the human). Yes (P6) or leave it to the page?
- **Q4 — `origin='agent'` rows: should `mission_send` prefer them?** Plan 53 says
  read before typing into a session you did not start. Enforce nothing; it is a
  guide rule, not a gate. Confirm that is the right amount of ceremony.

## 8. Not in scope

- Any new screen. The Mission page is the shared surface; these tools add no UI.
- Headless work. No `task_submit` in this flow, no "run as a task" button.
- Session/project **destruction** by the agent (unless Q1 says otherwise), and no
  `PATCH` (rename / relabel / solo-lock) — the solo lock in particular stays a
  human switch.
- A second liveness or history implementation: every read here is a thin call
  into `src/services/mission.js`.

## 9. Gotchas that will bite here

- **`mission.test.js` runs against the LIVE dev DB and wipes the Mission
  tables** (AGENTS.md). Back up `src/data/app.db*` before a run and recreate the
  user's projects (paddock, schlorp, craftpip) after. This is also why a
  `mission-mcp` unit test must seed its own `agents` rows and clean up after
  itself.
- **Never `require('./app')` from `mcp.js`** — it boots Express and a second
  server. Everything Mission needs is already exported by
  `src/services/mission.js`.
- **Every handler must survive a throw**: the `registerTool` wrapper
  (`src/mcp.js:244`) exists because a throwing handler once killed the whole
  webui every ~45s and looked like a glitching terminal. Register all five
  through `registerToolBound`.
- **Never do a bare `docker exec … tmux` in `mcp.js`.** tmux primitives live in
  `src/services/pad-tmux.js`; if something is missing, add it there and delegate.
- **`pad-tmux`'s exec helpers take an OPTIONS OBJECT** (`{timeout, check}`), not a
  number — a bare number throws `The value of "timeout" is out of range` at
  runtime, and a fake `runCmd` in a test will happily hide it.
- **A missing tool is not a broken tool.** `pad_list_agents` works fine; Mission
  was simply never exposed. Say so rather than re-debugging the fleet list.

## 10. See also

[plan 53](53-mission-workspace.md) (the page, the store, Phase 8 = this plan) ·
[plan 52](52-orchestrator.md) (grant policy, A1/A2, the fail-closed proofs) ·
plan 47 (the retired headless task queue) · plan 35a (`llm-guide.js`, the
`help` tool) · plan 35b/35c (API-key grants, the Profile scope UI) ·
`docs/reference/backend/services.md` (the MCP tool table this plan updates) ·
`docs/reference/tabs/terminal.md` (the tmux contract) ·
`src/services/pad-tmux.js` (every tmux primitive already exists —
`captureScreen`, `paneState`, `sendText`, `folderExists`, `listSessions`; **no
new tmux helper is needed**, which retires the "tmux capture-pane helper" item
in plan 53 Phase 8).

## 11. Build record (2026-09-27)

**What shipped.** Five tools in `src/mcp.js`, registered through the existing
`registerToolBound` wrapper, each a thin adapter over `src/services/mission.js`:
`mission_projects` (read), `mission_sessions` (read, list + screen detail),
`mission_project_create` (`create`), `mission_session_start` (`exec`),
`mission_send` (`exec`). The two reads joined `READ_TOOLS`; no new API-key scope.
Shared helpers: `missionFail` (a `MissionError`'s code is re-thrown as
`<code>: <message>`, because the SDK error path prints only `message`),
`missionVisibleAgents` / `missionMaySee` (ownership + target-grant scoping),
`missionRequireProject` / `missionRequireSession` (resolve-then-gate, so the PAD
name always comes off a real row before `requireTool` runs), and `mcpContext`
(exported for the tests).

**Q2 answered by building it:** the `project_id` / `agent` / `limit` filters and
`lines` (1–200, default 40) stay — all four are in the shipped schemas, and §1b's
table has been corrected to the built filter set. Q1/Q3/Q4 remain open and
unimplemented exactly as the defaults describe (no `mission_session_close`, no
`mission_history`, no preference for `origin='agent'` — it stays a guide rule in
`llm-guide.js`).

**The one bug the live round found** (P2, found because the live matrix tried a
mistyped PAD name): the handler read `SELECT agent_type FROM agents WHERE name = ?`
itself and passed `undefined` into `assertMissionAgent` for a name that does not
exist — and `getDriver` **falls back to openclaw**, so the answer was
`mission_unsupported_agent: openclaw does not support Mission workspaces` for a
PAD that never existed. Fixed by dropping the pre-query entirely: `projectFolders`
and `createProject` already resolve the row through `mission.agentRow`, so the
store owns type resolution (a bad name is now `mission_agent_not_found`, and a real
hermes pad correctly says `hermes does not support…`). `mission_project_create`
now probes only a **passed** folder and lets the store pick the driver default
when `folder` is omitted — the same shape as the page's dialog. Regression test
`a mistyped PAD name is refused as not-found, never as a driver-fallback type
complaint` (test 65) asserts the message never mentions openclaw. AGENTS.md now
carries the rule project-wide: **never resolve an agent's type yourself.**

**Live verification** (authenticated `/mcp`, `tools/list` = 34 tools, all five
present). Two throwaway API keys were minted through the Profile API — one
`default`, one `read`-only — and **both were revoked afterwards**.

| §6 case | Result |
|---|---|
| (a) `mission_project_create` | Row on `pad-test-claude`, `agent_type: claude`, `folder` defaulting to the driver workspace. Refusals: `mission_folder_missing` (with sibling listing), `mission_agent_not_found` (mistyped name), `mission_agent_stopped`, `mission_unsupported_agent` (real hermes pad), `mission_agent_not_found` (real openclaw pad name I got wrong) |
| (b) `mission_session_start` | `msn-c03fb984`, `origin: agent`, and the response's own `inExpectedFolder: true` with `state.cwd` = the project folder and `state.command: claude` |
| (c) `mission_sessions` | List matched the page (5 projects / 12 sessions) with `live` flags agreeing with the page's RUNNING count; detail mode returned a real `capture-pane` of the claude TUI; `lines: 3` honoured, `lines: 500` rejected by the schema (`expected number to be <=200`) |
| (d) `mission_send` | Full round trip: the keystroke advanced the live claude TUI (theme picker → login screen) and the change was read back through `mission_sessions` |
| (e) read-only key | Reads everything (projects + sessions), and `mission_send` / `mission_session_start` / `mission_project_create` all answer `Not permitted by API key tool grant: <tool>` |
| (f) cross-owner PAD | No second owner exists on this host; covered by unit tests instead (assert the service was never reached) |
| (g) unsupported type | `mission_unsupported_agent: hermes does not support Mission workspaces (supported: opencode, codex, claude)` |
| (h) solo lock | `mission_session_locked: … is solo-locked — unlock it on the Mission page to let the agent type`, nothing typed (tested against the user's real locked row, which cannot be typed into by design) |
| extra | Dead session → `mission_session_dead`; unknown session/project id → `mission_session_not_found` / `mission_project_not_found` |

**The user's live sessions were never typed into.** (d) ran on a session this
build started on the *test* PAD (`pad-test-claude`), and the refusals were
exercised against rows that cannot receive input (solo-locked, dead). No junk
left behind: both `p55verify` projects were deleted through the REST route (which
closed the tmux session with them — `tmux ls` on the pad reports no server), the
Mission page still shows exactly the user's 5 projects in a browser, and no
`pad-mm-*` / `p55*` row survives in the DB.

**Environment note (2026-09-27, worth knowing when re-running this matrix):**
`src/app.js` and `src/services/mission.js` were rewritten on disk at 13:48 local
— during the live round, interleaved with the plan edits, by something outside
this session's tool calls (no process of ours had that directory as its cwd, and
the writes did not repeat afterwards; the content is coherent and the 16
`/api/mission/*` routes plus every `mission.*` export `mcp.js` uses are intact).
The round was therefore re-run after a `docker restart` against the current disk
state — boot clean, 34 tools, 5 projects / 12 sessions — and the working files
were snapshotted to `/tmp/opencode/plan55-snap/` first. **If those two files
change under you mid-task, diff before you trust a result, and do not restore
them from an assumption: something else may be editing this repo on purpose.**

**The mid-turn gap, found after the plan was marked complete (a parallel agent's
work, one MCP-only fix).** A second agent added folder-scoped busy detection to the
Mission service — `withAgentBusy` / `withAgentBusyProjects`, which stamp
`busy` / `busyKnown` / `open` on rows (the opencode server's `/session/status`,
grouped and cached per (PAD, folder)). The REST routes chained that pass
(`app.js:2488/2526/2584`); the MCP handlers stopped at `withLive*`, so
**`mission_projects` returned no `openCount`/`busy` and `mission_sessions` no
`busy`** — the LLM could see "live" but not "the human is typing right now",
i.e. exactly the one thing the Mission page exists to prevent. Fixed in
`mcp.js` only (no shared file touched): every list and detail path now chains the
same busy pass with the same `agentOf` / `folderOf` resolvers, and
`missionSessionRow` / `missionProjectRow` project the stamped fields **only when
the store stamped them** — so an unanswered probe reports `busyKnown: false`
(UNKNOWN) rather than a fabricated idle, and a store without the pass simply omits
the fields. New test `a busy stamp from the store reaches the LLM, and an
unanswered probe says so` (68/68 green) stubs the busy pass for the projection and
runs the real one for the unknown case. Both tool descriptions, `llm-guide.js`
(a three-state rule: busy / busy+known / unknown-never-idle), `services.md` and
AGENTS.md now carry it.

**Verification status of that fix:** green in-process (68/68 `mcp.test.js`, plus
pad-tmux 19 / tasks 41 / registry 4 / db 3 / auth 3 / log-store 1 / ownership 6 /
container-health 8 / workspace 11) — the test drives the real handlers and the real
`mission.js`, so the chain itself is proven. The authenticated `/mcp` re-check is
**pending a `docker restart` window**: a parallel agent was still writing
`app.js` / `mission.js` / `Mission.jsx` (last writes 13:57) and a restart would both
load their half-finished work and drop their attached terminals, so the busy fields
have not yet been observed over the wire.

**What the busy probe actually returns on this host (read-only check, 14:0x).**
`GET /session/status?directory=…` on `pad-opencode-proj:7890` answers `{}` for
**every** folder tried — `/www2/paddock-test2` and `/www1/xdl`, which both hold live
attached `opencode` panes, as well as `/www1/craftpip` and the unscoped call. So
right now a session reports \`busyKnown: true, busy: false\` (a *successful* probe
that found nothing) rather than an unknown — meaning on this host "idle" and "the
probe is looking at the wrong place" are indistinguishable from the outside. Two
consequences, both documented rather than papered over: (a) the guide's three-state
rule keeps \`busyKnown: false\` distinct from idle, and (b) the guide states the real
limit — the probe asks about the **project folder**, while a session's human can be
working in another directory (detail mode's \`state.cwd\` is the ground truth, and the
record above already shows a live session whose pane sat in \`/www2\` while its project
folder was elsewhere). A \`busy: false\` therefore means "idle in the project folder".
A positive control (a turn actually streaming) was deliberately NOT manufactured in
the user's own workspace; that confirmation needs a real turn, or a check by whoever
owns the busy-detection code in the parallel stream.

**An honest reading worth knowing:** a session's `state` is where the human
actually is, which is not always the project folder — one live read came back
`cwd: /www2`, `tuiAlive: false` (a bash prompt after the TUI exited). That is the
tool working, not a bug: an LLM reading a session learns "the human is at a shell
right now" instead of assuming a TUI is answering. It is why the detail response
carries `state` next to the screen.
