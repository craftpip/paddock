# Plan 68 — Mission: auto-reopen a closed session instead of showing "This session is closed"

## Status: Complete (2026-10-06) — 6/6 items, built, verified live in the browser, plus 8 automated tests with a mutation control (§3a, added 2026-10-06). Blocker (§1a) cleared by the user, who declared the client WIP complete and authorized committing it with the regenerated `src/public`.

## 1. Request (user verbatim intent, 2026-09-29)

> In missions page "This session is closed / Nothing is running here any more — the agent's container may have been restarted, or the session ended." this is shown, pls dont show this directly reopen this conversation.

So: when col 3 lands on a session whose pane is gone (`sessionState.live === false`), do **not** render the `Empty` closed state — **restart it immediately** (same conversation, same tmux id, same `agent_session_id`) and show the terminal.

## 1a. Blocker on verification (found 2026-09-29, CLEARED 2026-10-06)

The two files this plan edits are **large uncommitted WIP**: `Mission.jsx`
(+677/-131) and `stores/mission.js` (+512), and `src/public` is that WIP's
build. Live verification (AGENTS.md golden rule) needs `npm run build`, which
wipes and regenerates `src/public` — so building here would replace the user's
in-flight client build, and committing the plan would drag the whole WIP along.
The feature code below is **written and parses** (esbuild, `write:false`), but
is deliberately left un-built/un-committed until the user says how to treat the
client WIP.

**Cleared 2026-10-06.** The user declared the client WIP complete and authorized
committing it, so the feature shipped inside the same commit as that WIP rather
than beside it. Verification results are in §3.

## 2. Current behaviour

- `src/client/src/pages/Mission.jsx:629-643` — `sessionState && !sessionState.live` renders `<Empty title="This session is closed">` + a `Reopen this conversation` button calling `restart(session.id)` (`stores/mission.js:444`, `POST /api/mission/sessions/:id/restart`).
- `fetchSessionState` (`stores/mission.js:421`) is the only thing that knows `live`; it runs on `selectSession`, `startSession`, `refreshActive`, `fetchAll`, and the poll.
- Backend `restart` re-creates the tmux session rooted at the project folder and relaunches the same agent conversation (distinct from `relaunch`, which needs a live pane).

## 3. Build

- [x] On `selectSession` / `startSession` / initial open: when the pane-state read returns `live: false`, call `restart(id)` once and show a transient "Reopening…" state in col 3 (not the closed `Empty`, not a terminal on a dead pane).
      **Written** (store + `Mission.jsx`): `fetchSessionState(id, { autoReopen })`
      restarts on a dead pane and is called with the flag ONLY from `selectSession`
      and `startSession` — the refresh/poll path leaves it off, which is what
      makes "opened a dead conversation" (reopen) distinct from "it died while you
      watched" (notice, human's call). `reopenFor` (keyed by id) blocks a second
      concurrent restart and drives the "Reopening…" state; `reopenError` shows
      the failure with the manual Reopen button as the retry.
      **Verified live** (target 9436cba79bc6): pane killed, row clicked, col 3
      went `Reopening…` (ms 8014) → terminal (ms 9479). tmux came back with
      `pane_current_command=opencode`, `pane_current_path=/www2/paddock`, and
      the pane's process args were `opencode -s ses_f0baa13d5ffetXrOlnxKeXzF4I`
      — the row's own `agent_session_id`, so the SAME conversation resumed.
- [x] After restart succeeds, re-read pane state (`fetchSessionState`) and render `<Terminal>` as for any live session. On failure, render the failure in col 3 with a Retry (folder missing → `mission_folder_missing`, PAD stopped → agent-stopped wording, both already exist on the backend).
      **Written**: the re-read keys off `openSession`, not the id we were asked
      about, since `refreshActive` may have re-stamped a different session.
      Failure path shows `reopenError` + the existing Reopen button.
      **Verified live**, and this is where the one real defect showed up. The
      first version cleared `reopenFor` in a `finally` and only THEN re-read the
      pane, so on the *succeeding* path col 3 fell through to the dead-end
      branch on a stale `live: false` and flashed `This session is closed` — with
      the Reopen button, i.e. a pointless retry — for the length of the re-read.
      Measured: `Reopening…` (8014) → `This session is closed` (7445+376ms) →
      terminal. Fixed by re-reading *before* dropping `reopenFor` and awaiting
      it (no `finally`). Re-measured: `Reopening…` (8014) → terminal (9479), no
      flash. **Mutation control**: putting the `reopenFor: null` back ahead of the
      read reproduces the flash, so the assert is not passing by accident.
- [x] Guard against loops: exactly one auto-restart per open (per `openSession.id`); a restart that still reads `live: false` must stop and show the error, never retry on the 15s poll. Poll-driven `live → false` transitions while the user is watching must NOT auto-restart (that is the "container died under me" moment — show a non-destructive notice, keep parity with the delete-project path in `deleteProject` which deliberately leaves `openSession` set so col 3 speaks for itself).
      **Written**: `autoReopen` is false on every refresh/poll `fetchSessionState`
      call, so the poll can never restart; `reopenFor` dedupes in-flight opens.
      **Verified live** on both halves. Poll path: killed the pane of the session
      col 3 was showing; after one tick the state went `This session is closed`
      (ms 8137) and `tmux has-session` still failed 25s later — no restart, the
      button offered instead. Open path: the same dead row, clicked, restarted
      exactly once (three separate kill/click cycles across the session all
      produced one tmux session, never two).
- [x] Keep the AGENTS.md tradeoff explicit: auto-restart launches an agent process in the user's conversation (today the button asks first). This plan spends that cost on purpose per the user's request — note it in the plan-53 §6 contract when done.
      **Recorded** here and in §1a; the plan-53 §6 note lands with the commit
      (blocked on verification), and AGENTS.md's auto-restart cost rule is already
      on record.
- [x] Keep `msn-*` hooks stable: no new copy naming tmux/pane/attach (plan 58 wording rule — verify with `document.body.innerText` against `/tmux|pane is no longer/i`).
      **Added** copy is "Reopening… / Starting this conversation again." and the
      failure title — none name tmux/pane/attach; existing hooks
      (`msn-btn-restart`, the col-3 `Empty`) reused. Full `document.body.innerText`
      check is part of the blocked live verification.
      **Verified live**: `document.body.innerText` on the whole page was scanned
      for `/tmux|pane is no longer/i` while col 3 was in every one of its states
      (terminal, Reopening…, closed notice, failure) and matched nothing; the only
      new copy is `Reopening… / Starting this conversation again.` and the failure
      title.
- [x] Verify live in the browser per AGENTS.md: kill a session's tmux pane, click the row, assert col 3 shows "Reopening…" then the terminal (not the closed Empty); kill-then-poll path shows the notice without restarting; failed restart shows Retry.
      **Done** — all four paths measured in the browser, `paddock` project
      `/www2/paddock` on `pad-opencode-proj`, test session `msn_3e4a8b5da1289060`
      (deleted afterwards; project list re-counted at 6, the known set, no junk;
      tmux left with `main` only):
      1. open a dead row → `Reopening…` → terminal, same `agent_session_id` (§3.1)
      2. poll-observed death → closed notice, **no** restart, button offered (§3.3)
      3. the button → terminal back (manual retry still works) (§3.3)
      4. failed restart → `Could not reopen this conversation` + the server's own
         message (`mission_folder_missing`) + the retry button (§3.2)

      Note on how (4) was forced: both candidate PADs are the user's and running,
      so stopping one was not an option. `window.fetch` was patched to return 409
      for `POST */restart`, which exercises the store's real catch branch and the
      real render without touching a container. The SERVER-side failure modes
      (`mission_folder_missing`, `mission_agent_stopped`) already existed and are
      exercised by the backend suite — what this adds is the client's handling of
      them, which is the half this plan owns.

## 3a. Automated coverage (added 2026-10-06) — `src/test/mission-reopen.test.js`

The ordering above had **only** the browser as its oracle, which is the weakest
kind: a source-text assert would pin the order in the file rather than the
behaviour, and the flash is invisible to every other suite because it is a render
glitch on the SUCCESS path. 8 tests, and they carry the browser's four paths plus
the loop guards.

The assertion that matters is a property of the **sequence** of states, observed by
subscribing to the real store and recording `(reopenFor, sessionState.live)` on
every `set`:

> once the reopen has **started**, the guard must never read `null` while
> `sessionState` is still the dead read.

Two things about that wording, both learned by writing the weaker version first:

- **It is not "the guard is eventually cleared".** Both orders satisfy that, so
  such an assert cannot fail — and an assert that cannot fail is worse than none.
- **The "once started" qualifier is load-bearing.** Before `reopenFor` is set
  there genuinely *is* a `(null, live:false)` state — the detection read landing —
  and it is harmless because the following set is in the same synchronous block, so
  React batches them into one paint. A predicate without the qualifier fails on
  CORRECT code, and the tempting response to that red is to weaken the assert,
  which is how a guard dies.

**Mutation control**: putting `reopenFor: null` back ahead of the awaited read
(exactly the defect, and the mutation used for the browser measurement) turns
`never clears the guard…` red with the dead state in the trace — `{reopenFor:null,
live:false}` between two `live:true` reads — while the other 7 stay green. Run in
a **copy** under `/mut`, never `/app` (`src/` is bind-mounted, so mutating `/app`
mutates the worktree). Original re-verified green after.

Two fixture facts worth keeping, because each made a test pass for the wrong reason
before it was fixed:

- **`openSession` must be set** for a direct `fetchSessionState` call to get past
  the "the user left on another row" early return. With it `null`, the
  "the poll path never restarts a dead session" test was asserting nothing — it
  passed because nothing ran. A green test that cannot fail.
- **`selectSession` returns `void`**, not the promise (a click handler ignores it),
  so a test cannot `await` the reopen it just triggered. `settle()` drains the
  microtask queue instead. This is also why browser-only verification was
  possible in the first place.

One assert was deliberately loosened: "exactly one outcome read after the
restart". There are **two** — `refreshActive()` inside the reopen already re-reads
the open session (`fetchAll` → `fetchSessionState`), and the awaited read after it
is the one the ordering comment is about. Pinning "one" would have asserted a
detail the store never promised.

Running the store's ESM under `node --test` needs `test/helpers/client-store-resolve.mjs`,
a resolve hook that fills in `.js` for extensionless relative imports **inside the
client package only**. The alternative — editing the store's import — would be a
bundler-shaped edit made to suit a test harness.

## 4. Out of scope

- Changing `restart`/`relaunch` backend semantics, session lifecycle dating (plan 65), liveness truth fields (plan 62).
