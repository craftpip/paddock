# Plan 78 — Mission: a fresh session's agent id drifts after chatting, reopening loops

## Status: Skipped (2026-10-20) — reproduced the "id changes" half (NULL-id rows drift, 8 on pad-opencode-proj, 2 on pad-opencode-user1); the "Session not found" loop NOT reproduced from current data (all 36 stored ids resolve, directory-match). Skipped per user decision — needs specific user case to fix the reopen loop.

## Report (as observed by the user)

> When in the Missions page I open a new session and chat in it, it first starts
> with an `msn` session id, but when I chat with it its id changes or something,
> and then in the mission panel later when I go to open it, it loops over at
> "not able to find session id".

## The two ids (disambiguation — get this straight before touching anything)

A Mission session row has **two** identifiers and the report says "session id"
for both, so the first job is to determine which one the user watched change:

| id | where it lives | what it identifies | who mints it |
|---|---|---|---|
| `msn-*` | `mission_sessions.tmux_id` | the **tmux pane** (the process the terminal attaches to) | Paddock (`insertSession`, `src/services/mission.js:238`) |
| `ses_*` | `mission_sessions.agent_session_id` | the **agent conversation** (opencode's own session, history, title) | opencode / the driver (`createConversation`, `src/services/drivers/opencode.js:303`) |

The row, the tmux name and the conversation survive together across
relaunch/restart *by design* (`relaunchTui` mission.js:738, `restartSession`
mission.js:772, both resume `session.agent_session_id`). A drift in either one
breaks reopen — so the plan must pin **which** id moved before proposing a fix.

## Investigation (live, 2026-10-09) — what was actually verified

### Ruled OUT on the healthy path (mint succeeds, pad's OpenCode Web published)
- **H1 — the TUI does resume the minted id.** Live-verified twice: same folder
  (`/www2/paddock` on `pad-opencode-proj`) and cross-folder (`/www1/xdl`), with
  the web server's own cwd being `/www1` (not the pad workspace). In both cases
  the minted `ses_*` was the *only* new row in the pad's store, its `directory`
  equalled the project folder, and its `time_updated` advanced when the TUI
  started. Sending one chat turn left `agent_session_id` **unchanged**
  (`ses_ee2908d32ffemiPExEU62OKdaW` before and after).
- **The history source hands out valid ids too.** `agentSessions`
  (`src/services/workspace.js:101`) reads the same opencode `session` table and
  returns `id = session.id` (`ses_*`). Resuming a history row via
  `POST .../sessions {agentSessionId}` worked: row stored the id, TUI resumed it,
  pane live.
- **Every stored id resolves.** Cross-checked all mission rows against each pad's
  own store (`instances/<pad>/opencode/data/opencode/opencode.db`):
  `pad-opencode-proj` 42 rows, `pad-opencode-user1` 4 rows → **0** rows whose
  non-null `agent_session_id` is missing from the store, and **0** whose store
  `directory` differs from the project folder (36/36 matched).
- **The mint's port lookup is reliable when web is published.**
  `registry.getAgent(name).web.containerPort` = 7890 (`proj`) / 54233 (`user1`).

### CONFIRMED — the "id changes" half
- **NULL-id rows exist and drift.** `pad-opencode-proj`: 8 rows with
  `agent_session_id = NULL`; `pad-opencode-user1`: 2. All created 2026-09-27…
  09-29 (the mint still succeeded for *other* rows in the same window, so it was
  intermittent — likely the pad's web app not answering at that moment).
  On a NULL row, `startSession`/`relaunchTui`/`restartSession` all take the
  `fresh` branch (mission.js:713/751/793) → **a brand-new conversation every time
  the row is opened** — literally "its id changes". `restartSession` never
  back-fills the id it discovers.
- **The list de-dupe cannot collapse a NULL row.** `SessionList.jsx:428` builds
  `liveAgentIds = sessions.map(s => s.agent_session_id).filter(Boolean)` and drops
  history rows whose id is in that set. A NULL live row contributes nothing, so
  its own history row survives → **the one conversation is listed twice**: a live
  row named `msn-<tmux>` (label is empty, `LiveRow` falls back to `tmux_id`) and a
  history row named with the agent's auto-title. This is the most plausible source
  of "it first starts with a **msn** session id, but when I chat its id changes" —
  the name the user watches flips from the tmux id to the agent's title.

### The "not able to find session id" loop — NOT reproduced; needs the user
- The literal phrase is **opencode's own** output: `opencode -s <id>` prints
  `Error: Session not found: <id>` (confirmed by running it and by the string in
  `/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe`). Nothing in `src/`
  produces it.
- But no app path passes an id opencode cannot find: every stored id resolves and
  directory-matches (above), and a manual `opencode -s <stored dead id>` and
  `opencode -s <history id>` both resumed cleanly.
- So the loop requires a row whose stored id is **absent from the pad's store** —
  none exist today. It may have been a session/pad since changed (a `reset`, or
  `opencode session delete`), or a different flow (e.g. the Web-tab terminal list,
  not Mission). **Ask the user** which pad/project/session and where the message
  appeared (terminal vs Mission notice) before choosing a fix.
- Also noted while testing: col 3 passes `session.tmux_id` (`msn-*`) to
  `<Terminal>` (`Mission.jsx:671`) and the snapshot carries both ids — this wiring
  is correct.

## Why this is suspicious / candidate causes (hypotheses; see investigation above)

The current design *mints the conversation before the pane exists* (plan 52
C1-F1, `startSession` mission.js:685-714): it `POST /session?directory=<folder>`
via `driver.createConversation`, gets a `ses_*` id, stores it on the row, and
launches `opencode -s <id>`. If anything in that chain does not hold, the row's
id and the conversation the TUI actually uses disagree. Leads, most likely first:

1. **`-s <id>` did not resume the minted conversation, so the TUI made its own.**
   If `createConversation` succeeds (returns a `ses_*`) but the launched TUI does
   not attach to it — different process than the one that minted it, race, or
   `-s` pointing at an id the TUI's store hasn't flushed — opencode starts a
   *fresh* conversation. The row keeps the minted id, the user chats in a
   *different* conversation, and reopening resumes the minted (empty) one or
   fails to find it. This is the exact class the "mint it, don't deduce it"
   lesson is about (AGENTS: a field the agent never hands you).
   - `driver.tuiLaunch.resume` — `src/services/drivers/opencode.js:43`
     (`opencode -s <sessionId>`).
   - `createConversation` — `src/services/drivers/opencode.js:303` (returns `''`
     on any failure, so a failure is silent and the launch falls back to `fresh`).

2. **`createConversation` returned `''` and the row has `agent_session_id = NULL`.**
   Then the launch is `fresh` (mission.js:713) and the row never learns the id
   opencode invented. Later reads answer `busyKnown` off a null id (see AGENTS:
   `known` must be `probe.known && !!s.agent_session_id`). Reopen would then use
   `fresh`, not "find session id" — so this fits "id changes" only if the user
   was watching the *history* row, not the live row. Worth ruling out anyway:
   check the row's `agent_session_id` right after a start.

3. **The merged list shows the conversation twice and the wrong twin wins.**
   `SessionList` merges live rows (`msn-*`) with agent-history rows (`ses_*`) and
   de-dupes on `agent_session_id` (`src/client/src/components/SessionList.jsx:428`).
   If the live row's `agent_session_id` and the history's `id` stop matching
   (because the TUI is really in a different conversation), the de-dupe fails and
   the user sees the same chat as two rows — picking the stale live row to
   reopen targets an id whose conversation is elsewhere → "not able to find".

4. **The reopen loop itself.** `fetchSessionState(..., { autoReopen: true })`
   triggers `POST .../restart` once per open (store `mission.js:492-536`, with
   `reopenFor` as the one-shot guard). If `restartSession` resumes a
   non-existent `ses_*`, the TUI errors out / the pane dies again, and every
   subsequent row-click restarts it again — which reads to the user as a loop.
   Confirm the loop is in the client (repeated POSTs) or in opencode (TUI
   printing "session not found" each attempt).

## What to capture first (before changing code)

- [x] Reproduce: open a new session, note the row's `tmux_id` AND
      `agent_session_id` immediately, then chat one turn, then re-read both.
      Result: neither changed on the healthy path (`ses_*` stable; daemon/web
      published). The drift lives on NULL-id rows only.
- [x] The exact words — pinned as opencode's `Error: Session not found: <id>`
      (`opencode -s <bogus>` and the binary's string table). No such string in
      `src/`.
- [x] Watch the reopen — no client retry loop observed; `restart`/`relaunch`
      resume a valid id and come up live. Loop not reproducible from current data.
- [x] Store read — all non-null `agent_session_id`s resolve in the pad's own
      sqlite and their `directory` matches the project folder (36/36).
- [ ] **Need the user:** which pad / project / session showed "not able to find
      session id", and did it appear in the terminal or as a Mission notice? That
      pins the one case current data does not contain.

## Code map

- `src/services/mission.js`
  - `startSession` :639 (mint-then-launch), `relaunchTui` :738, `restartSession` :772
  - `insertSession` :238 (both ids land here), `getSession` / `getSessionByTmux`
- `src/services/drivers/opencode.js`
  - `tuiLaunch.resume` :43, `createConversation` :303, `sessionTitle` :343
- `src/app.js` — mission routes (`/api/mission/sessions/:id`, `.../restart`,
  `.../relaunch`) around the projection chain at :2540/2602/2627
- `src/client/src/stores/mission.js` — `startSession` :399, `selectSession` :465,
  `fetchSessionState` :492 (autoReopen loop)
- `src/client/src/components/SessionList.jsx` — live/history merge :414-446

## Definition of done (candidate)

Whatever the root cause, the fix must end with **one** of these being an
invariant, pinned by a test:

- the row's `agent_session_id` always names the conversation the pane is running,
  or
- a start that could not mint/stick an id leaves the row in a state the UI
  reports honestly (unknown, not a false "idle"/"found"), and reopen says *why* it
  cannot find it instead of looping.

## Notes

- Related prior work: plan 52 C1-F1 (mint the conversation id), plan 65
  (idempotency + `endedBy` lifecycle), plan 68 (row-click auto-reopen), plan 56
  (session-open marker). Do not re-derive an id from timestamps — the multi-pane
  case is exactly why that was rejected.
