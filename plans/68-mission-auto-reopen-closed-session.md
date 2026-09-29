# Plan 68 — Mission: auto-reopen a closed session instead of showing "This session is closed"

## Status: In progress (2026-09-29) — code written in the working tree, **not built, not verified, not committed** (client WIP conflict, below).

## 1. Request (user verbatim intent, 2026-09-29)

> In missions page "This session is closed / Nothing is running here any more — the agent's container may have been restarted, or the session ended." this is shown, pls dont show this directly reopen this conversation.

So: when col 3 lands on a session whose pane is gone (`sessionState.live === false`), do **not** render the `Empty` closed state — **restart it immediately** (same conversation, same tmux id, same `agent_session_id`) and show the terminal.

## 1a. Blocker on verification (found 2026-09-29)

The two files this plan edits are **large uncommitted WIP**: `Mission.jsx`
(+677/-131) and `stores/mission.js` (+512), and `src/public` is that WIP's
build. Live verification (AGENTS.md golden rule) needs `npm run build`, which
wipes and regenerates `src/public` — so building here would replace the user's
in-flight client build, and committing the plan would drag the whole WIP along.
The feature code below is **written and parses** (esbuild, `write:false`), but
is deliberately left un-built/un-committed until the user says how to treat the
client WIP. Not ticked because a plan only ticks on real completion.

## 2. Current behaviour

- `src/client/src/pages/Mission.jsx:629-643` — `sessionState && !sessionState.live` renders `<Empty title="This session is closed">` + a `Reopen this conversation` button calling `restart(session.id)` (`stores/mission.js:444`, `POST /api/mission/sessions/:id/restart`).
- `fetchSessionState` (`stores/mission.js:421`) is the only thing that knows `live`; it runs on `selectSession`, `startSession`, `refreshActive`, `fetchAll`, and the poll.
- Backend `restart` re-creates the tmux session rooted at the project folder and relaunches the same agent conversation (distinct from `relaunch`, which needs a live pane).

## 3. Build

- [~] On `selectSession` / `startSession` / initial open: when the pane-state read returns `live: false`, call `restart(id)` once and show a transient "Reopening…" state in col 3 (not the closed `Empty`, not a terminal on a dead pane).
      **Written** (store + `Mission.jsx`): `fetchSessionState(id, { autoReopen })`
      restarts on a dead pane and is called with the flag ONLY from `selectSession`
      and `startSession` — the refresh/poll path leaves it off, which is what
      makes "opened a dead conversation" (reopen) distinct from "it died while you
      watched" (notice, human's call). `reopenFor` (keyed by id) blocks a second
      concurrent restart and drives the "Reopening…" state; `reopenError` shows
      the failure with the manual Reopen button as the retry. Parses (esbuild).
- [~] After restart succeeds, re-read pane state (`fetchSessionState`) and render `<Terminal>` as for any live session. On failure, render the failure in col 3 with a Retry (folder missing → `mission_folder_missing`, PAD stopped → agent-stopped wording, both already exist on the backend).
      **Written**: the `finally` re-reads `openSession`'s state (keyed off
      `openSession`, not the id we were asked about, since `refreshActive` may
      have re-stamped a different session). Failure path shows `reopenError` +
      the existing Reopen button. Not yet verified live.
- [~] Guard against loops: exactly one auto-restart per open (per `openSession.id`); a restart that still reads `live: false` must stop and show the error, never retry on the 15s poll. Poll-driven `live → false` transitions while the user is watching must NOT auto-restart (that is the "container died under me" moment — show a non-destructive notice, keep parity with the delete-project path in `deleteProject` which deliberately leaves `openSession` set so col 3 speaks for itself).
      **Written**: `autoReopen` is false on every refresh/poll `fetchSessionState`
      call, so the poll can never restart; `reopenFor` dedupes in-flight opens.
      Unverified.
- [x] Keep the AGENTS.md tradeoff explicit: auto-restart launches an agent process in the user's conversation (today the button asks first). This plan spends that cost on purpose per the user's request — note it in the plan-53 §6 contract when done.
      **Recorded** here and in §1a; the plan-53 §6 note lands with the commit
      (blocked on verification), and AGENTS.md's auto-restart cost rule is already
      on record.
- [x] Keep `msn-*` hooks stable: no new copy naming tmux/pane/attach (plan 58 wording rule — verify with `document.body.innerText` against `/tmux|pane is no longer/i`).
      **Added** copy is "Reopening… / Starting this conversation again." and the
      failure title — none name tmux/pane/attach; existing hooks
      (`msn-btn-restart`, the col-3 `Empty`) reused. Full `document.body.innerText`
      check is part of the blocked live verification.
- [ ] Verify live in the browser per AGENTS.md: kill a session's tmux pane, click the row, assert col 3 shows "Reopening…" then the terminal (not the closed Empty); kill-then-poll path shows the notice without restarting; failed restart (stopped PAD) shows Retry.
      **Blocked** — needs the client build, which conflicts with the in-flight WIP (§1a).

## 4. Out of scope

- Changing `restart`/`relaunch` backend semantics, session lifecycle dating (plan 65), liveness truth fields (plan 62).
