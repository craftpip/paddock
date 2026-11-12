# Plan 126 — A fresh codex Mission session learns its own conversation id

## Status: Proposed (2026-11-12) — 0/4 phases. Design complete; Phase 4 (live proof) needs a codex PAD with a working login, which costs subscription usage — ask before running it.

## Why

The infinite runner now reads turn state for opencode, codex and claude
(`agentStore.readTurn` → `services/jsonl-turn.js`; see
`docs/reference/backend/mission-queue.md` § Worker Observation by Driver). It reads
ONE conversation, found by the id in its transcript's file name, so a Mission row
without `agent_session_id` cannot be watched: every read is `unknown` and the
runner withholds every send.

- opencode: Mission creates the conversation first and launches into it.
- claude: Mission mints a UUID and launches `claude --session-id <id>`.
- **codex has no flag to choose an id** (`codex --help`, `codex resume --help`,
  codex-cli 0.121). And codex writes its rollout file only when the FIRST message
  arrives: on this host `session_meta`, `task_started` and the first
  `user_message` share a timestamp (0.101 and 0.121). So a fresh codex row is
  id-less, and there is no file to find until something has been typed.

That is a chicken and egg for the runner: it will not send the first message until
it can read the turn, and the turn cannot be read until a message has been sent.
Resumed codex sessions (`codex resume <id>`) are not affected — they carry the id.

## The user journey this must produce

1. In Mission, the user starts a NEW session on a codex PAD and makes it an
   infinite runner (or the runner creates its session itself).
2. They press **Run queue**. The runner sends the first plan prompt.
3. Within a few seconds the session's conversation id appears on the row (same
   place the opencode/claude ids show), the queue shows the item in progress, and
   the runner waits for the turn to finish — exactly as on opencode.
4. If two fresh codex sessions in the SAME folder were started close together and
   the runner cannot tell their files apart, the row stays id-less and the queue
   shows "Delivery unconfirmed — Reconcile" rather than guessing. Nothing is sent
   twice.

## Design

**A. "No input yet" is a readable answer for an id-less codex row.** Add
`agentStore.readTurnForSession(agent, session)` (session row in, not an id). For
codex with no `agent_session_id`:

- list rollout files under `<workspace_root>/codex/sessions` whose `session_meta`
  has `cwd === project.folder` and whose `session_meta.timestamp >=
  session.created_at` (minus 5 s clock slack), excluding files whose id is already
  `agent_session_id` of ANY other `mission_sessions` row;
- zero candidates → `{ state: 'idle', reason: 'New conversation has no input',
  userId: null }` — the same answer an opencode conversation with no messages gives;
- exactly one → adopt it (B) and return `readJsonlTurn` for that id;
- more than one → `unknown('Several new codex conversations in this folder')`.

The store being unreadable is `unknown`, never "zero candidates".

**B. Adoption writes the id once.** `mission.adoptConversation(sessionId, id)`:
`UPDATE mission_sessions SET agent_session_id = ? WHERE id = ? AND
agent_session_id IS NULL` (the `IS NULL` makes it race-safe and write-once), plus
an audit row `session_conversation_adopted` with actor `system`. Never overwrite
an existing id.

**C. Route every runner read through the session.** The runner calls
`agentStore.readTurn(agent, session.agent_session_id)` in about 15 places
(`grep -n readTurn src/services/mission/*.js`). Replace each with
`readTurnForSession(agent, session)` (it falls back to `readTurn` when the id is
set), and in `awaitExactReceipt` re-read the session row each poll so an id
adopted mid-wait is used. `busyForSessions` / `readActivity` keep working by id
and simply start answering once the id is adopted.

## Phases

- [ ] **Phase 1 — reader.** `readTurnForSession` + candidate discovery in
  `services/jsonl-turn.js` (`findFreshCodexConversation(base, folder, sinceIso,
  excludeIds)`, reading only the FIRST line of each candidate file, newest-mtime
  first, capped at 200 files). Tests in `test/jsonl-turn.test.js`: zero / one / two
  candidates, a candidate from another folder, one older than the session, one
  claimed by another row, an unreadable store. Mutation control: drop the `cwd`
  check → a test goes red.
- [ ] **Phase 2 — adoption.** `adoptConversation` + audit. Tests in
  `test/mission.test.js`: write-once (a second adopt is a no-op), never overwrites,
  audit row has actor `system`.
- [ ] **Phase 3 — callers.** Switch the runner call sites; re-read the session in
  `awaitExactReceipt`. Run `runner-*.test.js`, `mission.test.js`, `queue.test.js`,
  then `docker exec paddock npm test`.
- [ ] **Phase 4 — live proof (needs the user's OK: subscription spend).** On a
  codex PAD with a working login: new Mission session, make it a runner with a
  one-line plan ("reply OK and mark the item done"), Run queue. Assert in the
  browser: the row gains an id within 10 s of the send, the item goes in progress
  then done, History shows exactly one dispatch. Then the same on a claude PAD
  (proves the `--session-id` path from 2026-11-12 live). Update
  `docs/reference/backend/mission-queue.md` and `docs/reference/pages/mission.md`
  (the "plan 126" mentions), absorb, delete this file.

## Out of scope

- Usage-exhaustion evidence from the codex/claude stores (`readUsageEvidence`
  stays opencode-only; the screen notice covers all drivers). No exhaustion has
  been captured in a codex or claude transcript on this host to measure against.
