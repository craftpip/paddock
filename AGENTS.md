# PAD Friends Project — PAD Learnings

## How to Use This File

This file holds only **instant-need rules** — behavior, workflow, gotchas, and
facts the agent must have without reading anything else. Everything about how
the code/system works lives in `docs/` (the source of truth for business
logic). Keep entries concise and actionable; append under the right section.

When the user says "remember"/"learn" or you solve a problem, route the
learning:

1. **Code — the code and why it exists** (logic, purpose, routes, data model,
   behavioral contracts) → `docs/`. Read `docs/README.md` first, then
   `docs/STYLE-GUIDE.md` before writing.
2. **Agent behavior / workflow / gotchas / preferences** → here in AGENTS.md.

Rule of thumb: **code logic → `docs/`; agent behavior and operational workflow → AGENTS.md.**

## Pointing at UI elements

- **Every element on the Mission page carries a stable `msn-*` class** (page
  shell, all three columns, rows, buttons, badges, confirms, the project
  dialog). They are pure hooks — no styles — so when the user points at
  something ("the del button in the project row", "the text under Running")
  look the selector up in `plans/53-mission-workspace.md` §6 and edit exactly
  that element instead of re-guessing the layout.
- **Never route a UI complaint through bash/curl/reading the JSX.** Load the
  page, click the thing, look at it. The user has hit real bugs in this UI
  (a confirm prompt that outlived the row it belonged to; a scrollbar that
  shoved the column sideways when a list grew) that all survived a green test
  run and a careful code read.
- **When a fix lands, verify the interaction end to end in the browser** — click
  the button, then assert on the *resulting* DOM (element gone, banner gone,
  gutter reserved), not just that the handler fired.
- **A JSX handler that references an identifier from another component's scope
  builds fine, passes every test, and throws only when clicked.** Moving state
  from a child to its parent (e.g. a two-step confirm) leaves the child's handler
  referring to `confirmClose`/`id` that no longer exist there — the × button on
  every Mission session row was dead for a full build+test cycle this way, and
  only `btn.click()` in the browser surfaced it (`confirmClose is not defined`).
  Free variables in JSX are not compile errors. After ANY refactor that moves
  state across a component boundary, click every affected control in the page.
- **A MISSING IMPORT is a runtime error, not a build error — so `npm run build`
  passing says nothing about whether the page RENDERS.** `Mission.jsx` called
  `useConfirm()` with no import for it. Green build, green tests, and `/mission`
  was a blank page: an unbound identifier in JSX is a `ReferenceError` when the
  handler runs, exactly like the cross-component free variable above. Vite/esbuild
  will not catch it, so **after adding a hook/provider/modal to a file, load the
  page** — do not infer "it works" from the build.
- **A suite of source-text REGEXES cannot see that a file stopped parsing — and
  the committed file is not the file the browser ran.** Plan 66 committed a
  `SettingsTab.jsx` missing the comma that ended the `message:` template literal
  in `handleRecreateNetwork`, so the file on disk was **unbuildable**. Four things
  each looked like coverage and none of them were: the tests were all
  `assert.match(src, /…/)` on source text, `node --check` **rejects JSX** so it
  is not even available as a fallback, and the browser check passed because the
  page serves the **prebuilt** `src/public` bundle, which had been built from the
  *worktree* — the one copy that was still valid. That last one is the general
  trap: with `src/` bind-mounted and the bundle prebuilt, **"it renders" can be
  true of code you did not commit.** The oracle is a **parse** — run esbuild with
  `write: false` (never `npm run build`, it wipes `src/public`) and resolve it via
  `createRequire(client/package.json)` because it lives in the *client's*
  node_modules. Its control is the defect itself: re-drop the comma, watch it fail
  at `413:6` with "Expected } but found confirmText", restore, watch it pass. A
  test that asserts on strings proves the file contains those strings; proving it
  **compiles** is a different claim and needs a different tool.
- **An unreadable answer and a negative answer are different ANSWERS, and the
  cheapest place to confuse them is the one that already had a null.** `stale`
  means "no peer"; `checked: false` / `state: 'unknown'` means "I could not
  look". `inspectPeer` returned `null` for **every** inspect failure, so a
  **docker daemon that was down** — the most likely operational failure there
  is — was reported as an absent peer, i.e. an operational failure dressed as a
  *diagnosis*, which sends the caller to recreate a pad that needed nothing.
  Split on what docker **said** (`No such object`/`No such container` is absence;
  anything else is `{ error }`), and give the non-actionable outcome its **own
  state** rather than borrowing one of the four, because the other four each name
  an object and a fix and this one names neither. Related and same commit: when a
  pad is bound to a wrong id **and** its configured peer is stopped, the
  **stopped peer wins** — `staleBinding` would point the caller at this pad when
  the thing that needs action is somewhere else. And the UI half: raise the
  banner for `checked: false` and quote `reason`, but offer **no** recreate
  button, because an unreadable probe has established nothing and a button is
  advice nobody can justify.
  The corollary is the one that is easy to get wrong: **when one reference
  reads and the other fails, do not answer from the half that worked.** The two
  references answer different questions — what a pad is *attached to* vs what it
  was *configured for* — and `ok` vs `staleBinding` differ ONLY by whether the
  two ids match, so a failed *configured* read loses the answer itself. Both
  mixed directions were shipped once and both were wrong: a failed `bound` read
  fell through to "bound peer no longer exists` and said `staleBinding`, asserting a
  deletion it never observed to justify recreating a healthy pad; a failed
  `declared` read said `ok` and set `peerCurrentId` from the bound peer, which
  made the documented `peerId !== peerCurrentId` test **compare the id with itself**
  and report "no mismatch`. The single exception is a bound peer that resolves and
  is NOT running — decisive alone, since the pad cannot start either way. And
  the split is on `error`, NOT on "resolved or not": docker saying "No such object`
  is a FACT about the peer, so a genuinely absent reference keeps its actionable
  state, and a test pins that counterpart so a tidy-up cannot fold the two
  together.
- **A field an agent never hands you is not a field you can look up later —
  make the agent hand it to you, or make the answer UNKNOWN.** `opencode` mints a
  conversation id when its TUI starts and never reports it, so a fresh Mission
  row kept `agent_session_id = NULL` forever and every read answered
  `busy:false, busyKnown:true` — "I looked, it is idle" — for a pane visibly
  mid-turn. Two lessons, and the second cost another round. (1) **The fix is to
  create the conversation yourself, not to deduce it afterwards**: `POST
  /session?directory=<folder>` returns the id, so mint it BEFORE the pane exists
  and launch `opencode -s <id>` into it. I first built the "resolve it later from
  timestamps" version the plan proposed, and it is not merely fiddly — it
  **cannot distinguish two panes in one folder** (several routinely share a PAD,
  and the user's own web-UI chat is in the same candidate set), so its
  "exactly one survivor" rule refuses precisely the multi-session case it was
  meant to serve. Narrowing harder would trade a shrug for a **wrong**
  conversation. Minting removes the window instead of resolving it. (2) **A
  "known" flag copied from the probe's own knowledge is not knowledge about
  THIS row**: `busyKnown` took the probe's `known` while the row's id was null,
  so the conversation was never intersected with anything. `known` is now
  `probe.known && !!s.agent_session_id` on all three branches. The pre-existing
  test asserted `busy: false` for an id-less row and nothing about `busyKnown`,
  which is exactly why the lie survived a green suite: **nothing in the response
  contradicts `busy: false` on its own** — assert the field that makes the claim
  checkable, not the one that is already false.
- **A live-work probe can be answering about a DIFFERENT PROCESS than the one you
  are describing, and a shared database is not shared liveness.** `busy` reads
  `GET /session/status` from the PAD's published `opencode web` (pid 16, :7890) —
  but a Mission session's TUI is a *separate* `opencode` process (pid 6458) that
  holds **no sockets** and never publishes its turn there. Measured: 42
  consecutive seconds of `esc interrupt` on the pane with our id absent from the
  map, while the user's own web-UI session was reported busy throughout. The two
  processes **do** share the sqlite store (a `GET /session/{id}` returns our
  conversation in full), which is exactly what makes the bug survive review: every
  read of the same *id* succeeds, so the id looks like it is wired up. **Prove a
  liveness probe by watching it go TRUE for the specific thing you are measuring**,
  not by confirming the endpoint answers and the id resolves. And when a fix makes
  a probe "work" without ever producing a `true`, suspect a second root cause
  rather than declaring victory — here the id fix made the lookup succeed and
  find nothing, which reads identically to a fix.
- **`USER_MODE=user` puts the pad's tmux in `/tmp/tmux-1000`, so a plain root
  `docker exec … tmux ls` reads a DIFFERENT, EMPTY server.** The Mission
  evidence-gathering that produced the 42-second measurement above was first run
  through root and found "no tmux session, no TUI process" on a pad with a pane
  visibly mid-turn — which looked like three separate defects (no session, no
  process, empty screen) and was one: the probe read the wrong socket. Always go
  through `padTmux` (`termUserArgs` adds `-u 1000:1000 -e HOME=/root`), and never
  hand-roll a `docker exec … tmux` for evidence. Two smaller traps from the same
  session: creating a root `tmux new-session` in a user-mode pad **leaves a second
  server behind** that then makes the webui's own captures come back empty, so
  clean it up (`tmux kill-server`) before believing any result; and the detail
  endpoint returns the screen at the **top level** (`screen`), not on `session`,
  so `session.screen` reading empty means "I looked in the wrong place", not
  "there is no screen".
- **Mission col 3 is pinned to `openSession` in the store, NOT to the row and NOT
  to `selectedProjectId`.** It is a snapshot taken at the moment the session was
  opened, and the project it resolves for `<Terminal>` comes from
  `openSession.projectId` — deliberately *not* col 1's `selectedProjectId`, so an
  all-projects row from another project is not corrected back to the col-1 one.
  Col 1 and col 3 pointing at different projects is correct and expected. The
  rule this replaced ("anything that changes `selectedSessionId` must move
  `selectedProjectId` with it, or the terminal shows one project's PAD under
  another project's name") is exactly the bug: `setScope` and `select()` both
  moved the highlight for reasons unrelated to the terminal, and the terminal
  followed. **Only `selectSession` (row click) and `startSession` write
  `openSession`; only `closeSession` clears it; a refresh may update its display
  fields but never which session is open.**
- **A column that is refetched must not be what the next column renders from.**
  Col 3 used to derive its session from the listing, and `setScope` empties that
  listing on purpose before refetching — so for ~200ms col 3 was `null`,
  `<Terminal>` unmounted, the WS closed, and the list landing remounted it (fresh
  xterm, fresh `tmux attach`, redraw) for a conversation nobody asked to change.
  Any value derived from a list is only as stable as that list's emptiest moment.
- **`startSession` must re-read pane state after setting `openSession`** (it
  calls `get().fetchSessionState(id)`), because the snapshot is taken when the
  TUI has been *asked* to launch and has not yet appeared — a snapshot-only fix
  renders a brand-new session as closed. *A snapshot taken at open time is
  correct for a session that was already running and wrong for one still
  starting.*
- **tmux `show-options -g` will NOT list `escape-time`** — it printed
  `history-limit` and `status` and silently omitted the one option under test, so
  a "did it take?" check that greps `-g` output silently passes on a PAD where
  nothing was applied. Always read an individual option back with
  `tmux show-options -gv <name>`. (`pad-tmux.applyGlobalOptions` now sets
  `escape-time 10` as a PAD global, which is why ESC registers immediately
  instead of waiting on tmux's 500ms ambiguity window.)
- **A poll or a mutation that refreshes the *selected project's* list will leave
  the all-projects list frozen.** Every refresh path goes through
  `refreshActive()`, which reads the active `scope`.
- **"Hidden" has three different meanings in CSS and only one of them is free.**
  Chasing "put this on the right / stop it taking space" through
  `ml-auto` → `hidden` → `opacity-0` burned three builds on the Mission session
  row, and the trap generalises: (1) `ml-auto` on the *wrong* element leaves the
  target merely trailing its neighbour, flush by accident; (2) `hidden` +
  `reveal-on-hover` reserves nothing but **`display: none` children cannot take
  focus**, so a hover-revealed control is unreachable by keyboard and
  `focus-within` cannot rescue it (it only matches something that already has
  focus — tabbing onto the parent reveals the control, the next Tab blurs the
  parent, the reveal vanishes, focus falls to `<body>`); (3) `opacity-0` in flow
  keeps it focusable but **an invisible flex child still reserves its width** —
  that is the "you are hiding it but it still takes space" complaint, one element
  over. The answer is **absolute + `opacity-0`**: no reserved space, never
  `display: none` (focusability intact), and the element it covers fades out
  instead of being overlapped. And `pointer-events-none` on anything invisible is
  a **safety** requirement, not tidiness — `opacity: 0` still takes clicks, so a
  click aimed at the visible neighbour behind it hits the invisible control
  (here: the Close button, which would kill the user's session). Assert it with
  `document.elementFromPoint` at the visible element's own coordinates, in the
  idle state — and mind that a row still holding focus, or one the pointer is
  really over, will legitimately show the control, so filter on
  `!r.matches(':hover') && !r.querySelector(':focus')` first or the check lies.

- **A name the surface HANDS OUT must be a name the surface ACCEPTS, and
  the resolver must run BEFORE the grant check, not after.** The MCP surface had
  three spellings per pad (container name `pad-proj2`, the bare name
  `create_agent` accepts, and the `display_name` `list_agents` prints) and
  accepted only one, so the cheapest mistake — copy a name off the listing and
  pass it back — returned `Agent not found`. Order matters: **resolve, then grant on
  the RESOLVED name, then act on the RESOLVED name.** Granting on the raw string
  means a target-restricted key is refused for the wrong reason, and a tool that
  gates then uses the caller's own `name` is doing work on a pad it never
  authorized. `requirePad(tool, name)` returns the agent precisely so no call site
  can forget the last part. Two precedence rules worth keeping: a **prefixed exact
  match beats substring ambiguity** (`proj` is `pad-proj`'s exact bare name, so it
  must not be rejected as ambiguous against `pad-proj2`), and genuine ambiguity
  **refuses and names the candidates** rather than guessing, because guessing here
  means running a command on the wrong agent.
- **A "here is where it ran" probe must carry the SAME environment change as the
  command, or it reports the truth and the answer disagrees with it.** `exec`
  gained a `cwd` and reported the *actual* directory by running `pwd` in a second
  `docker exec` — which, lacking the `cd`, reported the container default while the
  command had run in the requested one. The payload then said
  `cwd: "/www1"` next to `stdout: "/www1/craftpip.com"`: a self-contradicting
  response is worse than no `cwd`, because the caller has to decide which half to
  believe. The probe now takes the same `cd`. **Only the live test caught this** —
  the code was correct-looking, and the unit test could not have run a container.
  Same shape: a `cwd` is caller-controlled and interpolated into `sh -lc`, so
  quote it, and let a bad path FAIL (exit 2, nothing run) rather than fall through
  to somewhere else.
- **"This list is capped at 10" and "your item is not in it" look identical to the
  caller — so any list a caller may need to SEARCH needs a filter that searches
  everything, applied BEFORE the cap.** `availableNetworks` was capped, and a named
  container past the cap read exactly like an invalid one. `networkFilter` now
  filters the **whole** candidate list and skips the limit entirely (a caller who
  already knows the name is asking "is THIS valid?", not "show me ten"), setting
  `availableNetworksSearchedAll: true` so an empty result is a real "no". **The
  first fix here was the same bug with a bigger number in front of it**: it
  "widened the limit" to 200 and then filtered, so past 200 peers the flag was a
  lie and the silent maybe returned. A filter that runs after any cap is not a
  search — put it inside the selector, before the `slice`. **Also: verify the
  reported cause.** The original finding blamed the cap for hiding `pad-proj2`, but
  that pad is excluded because it publishes no ports — two different filters, and
  only one was a reporting bug. Chasing the stated cause would have shipped the
  wrong fix.
- **A resolver that returns the canonical name is only half a fix — the name has to
  reach the ACTION and the RESPONSE too.** `update` resolved `Proj` to
  `pad-opencode-proj`, authorized on that, and then called
  `vm.updateAgent(name, …)` with the **raw** argument: the exact gate-then-act split
  the resolver exists to prevent, surviving because the gate looked right in review.
  `agent_logs`/`workspace_read` read the right pad and echoed the caller's own
  spelling back, so the answer was indistinguishable from "it did nothing". Audit
  `grep -n "textResult({ name" src/mcp.js` for echoes and check the *action* argument
  on every tool you touched, not just the gate. When a test has to pin this down
  without running a container, read the tool's source with `fs.readFileSync` and
  assert the two arguments match — and slice the handler to the NEXT
  `registerToolBound(`, because `indexOf('});')` stops inside the inputSchema and
  the test then passes on a fragment it never really read.
- **A list tool that can be FILTERED must never fall back to the unfiltered list,
  because that answer is indistinguishable from success.** Asked for one project by
  name and given six, a caller has no way to tell "you matched it, here it is" from
  "I did not understand, here is everything" — and the failure is silent, so it
  surfaces as a confidently wrong answer much later. So zero matches and several
  matches are BOTH refusals carrying the candidates (`mission_project_not_found` /
  `mission_project_ambiguous`). Three things that make the hint actually work:
  **accept every spelling the caller is likely to hold** (a project's `name` is not
  its `folder`, so filtering on one axis silently misses the other); **match
  containment BOTH ways** (the common miss is a typo, and `"paddock"` does not
  contain `"paddockk"` — a one-way `includes` is blind to exactly the case you
  wrote the hint for); and **draw candidates from what the caller may already
  see**, because a hint that lists someone else's rows converts a scoping rule
  into an existence oracle. Related: once a filter exists, **the neighbouring
  vocabulary has to come along** — a project that cannot say whether its own pad is
  running sends the caller to a second tool, and the same repo is often mounted by
  two pads with the one named after it stopped.
- **A count that sits next to a data array will be READ as the thing it measures.**
  `liveCount` / `openCount` beside a project's `sessions` array reads as "how far
  along is this?" and it is not: a session that did 400 tool calls and one that
  opened and died are both `live: false`. The caller's mistake is invisible (no
  second call contradicts it), so the tool description has to **say the difference
  in words** — `LIVENESS, not progress` — rather than trust it to be inferred from
  the field names. The same reasoning makes the summary come FIRST in the row and
  the detail opt-in: inlining every session of every project made the read a
  superset of the dedicated list tool, and the counts were serialized *after* the
  data they summarized. A read that costs the whole fleet before the caller knows
  which row it wants is a read with a filter missing, not a style problem.

- **A field the SERVER computes must not be re-derived on the client, and a
  verdict must not be computed anywhere but the gate.** Plan 62 fixed both halves
  of the same defect, and each was invisible to the other. The store stamped
  `open: false` for a pane running only `bash`, and `SessionList` computed
  `open = live || busy` — so the dot lit for exactly the trap `mission_send` had
  just refused, and a correct server fix looked like it had done nothing. **A
  client that re-derives a server field is a second source of truth, and it is
  the wrong one**, because it was written before the field existed. The fix is
  to use the server's value and fall back ONLY when the field is absent. The
  mirror image: `canSend` was `session.open`, which means "a TUI is attached", so
  a solo-locked row and a permission-parked row both answered `canSend: true` and
  then the write refused them — a verdict computed anywhere but the gate is a
  guess, the same shape as the gate-then-act split in the name resolver. Route
  both surfaces through ONE function (`mission.sendVerdict`, which `sendText`
  gates on). **And do not fold every refusal into one field to force it to mean
  everything**: a locked session is still *open* (the human is driving it), so
  absorbing `locked` into `open` would trade one lie for another. `open` says a
  TUI is attached; `canSend` says the agent may type. Related: a
  **fake pane that returns a frozen string is not a neutral stub, it is a black
  hole** — once a write is confirmed by comparing the screen, every test whose
  fake pane never echoes has to be given an echo, once in `beforeEach` rather
  than per test.

- **Assert a clock CHANGED, and give the test a gap bigger than its resolution.**
  `last_output_at` is millisecond-resolution, so two reads inside one millisecond
  stamp identical values and every "it advanced" assertion becomes a coin flip
  that fails roughly one run in ten — which reads as a real bug and is not. Two
  things followed, and the first is the one worth keeping: the store now returns
  the timestamp it *stored* instead of computing a second one, so the row handed
  to the caller and the row in the database can never differ by a millisecond;
  and the test sleeps past the resolution before each read that must move. A
  `notStrictEqual` on two timestamps is only a real assertion if the code cannot
  make them equal — and the control that proves it is a control you have to run:
  my first version passed with the fix removed, because "non-null" was true
  anyway after an earlier read. **Assert the CHANGE, not the value.**

- **A first observation of a death is NOT the time of the death, and the honest
  word for it is an upper bound.** Nothing watches a tmux session die — tmux does
  not tell the webui, and the container may be gone before we could look — so
  `endedAt` is stamped on whichever READ first noticed the pane missing. Only the
  deaths *we cause* are exactly dated (`recreate`, `closed`); everything else says
  `gone`, and a row with no stamp at all says "never observed dead", NOT "still
  running" (`live` answers that). The trap is the word: any field called
  `endedAt` reads as a moment, so the tool description, the LLM guide and the
  docs all have to say "upper bound" in **words** — a caller inferring it from the
  field name is wrong on every `gone` row and cannot tell. Two rules that follow:
  the migration must back-fill **nothing** (an invented death date is worse than a
  missing one — on this fleet all 36 pre-existing corpses got stamped by the first
  read, which is the correct outcome), and **a refused `close` must stamp
  nothing** — "close the corpse" is precisely the request that would overwrite
  `gone` with `closed` and destroy the only evidence of what happened. That one
  needed a live check to be sure of: assert the row's `endedBy`/`endedAt` are
  *unchanged* after the refusal, not merely that a refusal came back.

- **The retry is where a client-side timeout is fixed, and an in-process pre-check
  is not enough.** A timed-out `mission_session_start` has no response, so the
  server cannot help; the recovery has to live in the caller's RETRY, which means
  a caller-supplied `idempotency_key`. Returning the existing row on a duplicate
  key closes the *sequential* race and quietly loses the *concurrent* one, so the
  key also needs a **partial unique index** — and a deduped insert must return
  before it touches tmux, or the retry still spawns a second live session. The
  general shape: when a guard is "did I already do this", ask whether two
  processes can pass the check at once, and if so put the constraint in the
  database rather than the handler.

- **A source-text assertion is a pin on a name, not on a fact — refactor the
  assertion, keep the fact.** Plan 67's provenance test matched
  `createSession(project.id, { …, createdBy })` in `mission.js`, and plan 65's
  idempotency work renamed that helper to `insertSession`. The test was right that
  `startSession` threads the actor into the insert and wrong about which function
  it goes through, so the fix was to match `(?:create|insert)Session(...createdBy...)`
  — **weakening an assertion to make it pass is the failure mode, so match the
  property and say in a comment why the name is free to change.** This is the same
  instinct as dropping a per-test backup ritual once `PAD_DB_PATH` made it
  unnecessary: a test pinning an implementation detail outlives the reason it was
  written.

- **A free variable in plain JS is as invisible as one in JSX: `node --check`
  passes, the suite passes, and it is a `ReferenceError` the first time the
  line runs.** Threading an audit actor through `mission.js` put the `audit()`
  call into the function that *consumed* the param, but the param itself went
  onto a **differently named sibling** (`closeSession` — the page's delete —
  versus `endSession` — the agent's stamp-and-keep). Both are "close" and both
  are exported. `node --check` was clean, all 105 mission tests were green, and
  the first live close would have thrown. The cheap oracle is a **static scan,
  not a parse**: for every `audit(` call, walk back to the enclosing function
  and assert its signature declares the identifier the call passes. That caught
  it in one pass, where `node --check` proves nothing.
- **An audit log that records only WHAT cannot answer WHO, and a FK will tell
  you so by failing a test you did not write.** `activity_events` had a table,
  a writer and a reader for months, and its `actor` column had **never been
  set by anything** — all 702 rows read `system` (measured with a `GROUP BY`,
  which is the only way to know). So the log was decorative. Two rules: read
  the *distribution* of a column before assuming it is in use (a DEFAULT is not
  evidence of a caller), and **a foreign key is a contract about deletion
  order** — the instant a child row starts being written, any `DELETE` of the
  parent must clear the child first. That surfaced as `mcp.test.js` failing
  **all 50** of its tests in `beforeEach` with `SQLITE_CONSTRAINT_FOREIGNKEY`,
  which reads exactly like a product bug in `createProject` and is not: the
  test deleted a parent row while its new children still pointed at it.
  Production was safe (`removeAgentFromDb` clears the log first), so the fix
  belonged in the test — but the control is what proves it: re-deleting that
  one line reproduces 50 red.
- **An audit trail is not a second copy of the data — record the SHAPE of a
  write, never its content.** A `send` is the human's own conversation and can
  carry a pasted API key; logging the text would make the audit log the least
  protected copy of the secret on the box. `send` records line count and
  character length, which is enough to answer "did one land, how big" without
  storing what it said. Pinned negatively: the row must not contain the secret.
  Two adjacent rules that came with it: a **refused** action writes nothing (a
  log that credits a rejected write is evidence against itself), and a failing
  audit write must not fail the action that already happened — tested by
  dropping the table mid-call, since the action is done and cannot be undone.
- **A store test that mutates a module-level singleton must put it back, or the
  next test inherits a bound copy.** The idempotency-race test replaces
  `db.prepare` to force a UNIQUE violation; restoring it as a *bound* function
  leaves the module permanently closed over its own receiver. It passes either way
  (and so did every later suite), which is exactly why it is worth writing the
  restore carefully rather than trusting the green run.

- **An ORDERING assert on `indexOf` is unfalsifiable without an explicit
  absence check, because the absent case returns -1 and -1 sorts first.**
  Plan 52's B1 pinned "recipe 13 tells the caller to reuse a session BEFORE
  starting one" with
  `recipe.indexOf('mission_sessions {project_id}') < recipe.indexOf('mission_session_start')`.
  That passed on the *unmutated* code and also passed with the reuse sentence
  **deleted** — deleting the left operand turns it into `-1`, and `-1 < 17` is
  true, so the mutation control read green. The same shape hides in
  `lastIndexOf`, `slice` bounds and any `<`/`>` on a search result. Assert the
  **presence** of both operands first (`!== -1`), then the order. The lesson
  generalises: `indexOf`-based ordering tests measure the *absence* of nothing,
  and the cheapest oracle for "does this assert bite" is deleting the very
  string it orders by. Related, same run: a mutation control that injects text
  into a JS **template literal** must not contain backticks — they terminate
  the literal, the file stops parsing, and the suite reports "1 test, 0 pass,
  1 fail", which reads as "the guard fired" when the guard was never reached.
  `require()` the mutated file inside the control and abort if it throws, so a
  broken mutant cannot masquerade as a caught one.

- **A permission DEFAULT is set in the CALLER, so fixing the callee fixes
  nothing, and `x !== false` is not a safe default — it reads an OMITTED
  `undefined` as true.** `autoApprove` was `true` in `submitTask`'s
  destructuring *and* `args.autoApprove !== false` in the MCP handler, while both
  drivers were already fail-closed (`--auto` / `--sandbox danger-full-access`
  only when the flag is truthy) and a test already proved it. So the "safe"
  behaviour existed and was unreachable: a caller who said nothing got
  `danger-full-access` — no sandbox at all — from the *handler*, before the
  runner's own default was ever consulted. Two lessons, and the second is the
  one that bites. (1) **When a default is permissive, grep for it in every
  layer that can supply it**, because the layer that invents the value is the
  one that wins. (2) **Fixing one of two defaults leaves the bug alive**, and
  here the other half was pinned by *nothing*: a mutation restoring
  `!== false` left every suite green. So a test per layer, and the control that
  proves the point is the one asserting the *other* suite stays green — that is
  what shows two tests are non-redundant rather than duplicative. A fact stated
  in two fields needs fixing in both: the `zod` description *and* the tool
  description each carried the old default. Finally, the cheapest correct
  default was only available because the feature was **off** — re-check whether
  a permissive default is load-bearing before treating its change as breaking.

- **A stale row survives a write that just happened in the same function.**
  `screen()` read its session, then updated the row, then returned the row it had
  read — so the response reported `last_output_at: null` for the very call that
  had set it. Nothing crashes and nothing looks wrong: the next read is correct,
  which is why it would have shipped. The rule is that a function which mutates
  a row it also returns must stamp the return value from the write's own result
  (or re-read), and "did the clock move?" is a far easier test to write against a
  response than a diff of the implementation.

- **A parameter that names two different things is a trap that no type system
  catches, and the fix is a rename plus a REFUSAL, never an alias.**
  `task_submit {name}` was the PAD a task *runs in*; `task_get_next {name}` was
  the *worker claiming* it. One name, two meanings, and the second was read as
  the first. Renaming the claim side to `worker` and letting `name` through as an
  alias would have kept the ambiguity alive under a new spelling — so a `name`
  there is a hard error with a sentence explaining the difference. **And leave the
  renamed parameter OPTIONAL in the JSON schema**: required, the SDK answers
  `expected string, received undefined at worker`, which is true and teaches
  nothing, pre-empting the only error worth printing. Same rule as the resolver
  above — the gate must run *before* the grant, and the message a caller gets must
  be the one that says what to do next.
- **A status filter, a `total` and a cap only answer a question about ONE set —
  and a filter that runs after a cap is not a filter.** `task_list` counted
  `total`/`truncated` from an **unscoped** query and compared it to the length of
  the rows *this key may see*, so the two numbers described different sets: a
  short list read as "that is everything", and a key that could not see four rows
  was told the answer was truncated. Count after the access filter, before the
  slice, and if the fetch itself is capped say so (`fetch_capped`) rather than
  letting `total` become a silent maybe. This is the same shape as the
  `availableNetworks` cap in `settings_get`.
- **A lookup that was never RUN is indistinguishable from a fact it would have
  found — and the unit tests stay green while it ships.** Wiring plan 66's shared
  peer rule into `container-health` called `inspectPeer(ref)` with no runner; the
  function's old `if (!run) return null` guard turned that into a null, so both
  lookups said "no such container" and all five peer-networked pads reported
  `stale`/`error` while three peers were demonstrably running. Nothing in the
  suite caught it because the tests cover the PURE classifier and
  `checkPublishedPorts`, never the docker path — so the fix was a **default
  runner** plus one test that asserts the default really reaches docker, and the
  lesson is the shape: **a function that returns a falsy value for "I could not
  look" is indistinguishable from one that returns it for "it is not there", and
  no unit test over the pure half will ever see it.** Re-probe LIVE after wiring
  any new consumer to a lookup, and compare the consumers against each other
  (settings vs health on the same pad) — agreement is the cheapest oracle there
  is for this class.
- **The right answer to "the surface contradicts itself" is usually that TWO
  components each re-derived it, so fix the derivation, not the two
  answers.** Plan 66's `networkHealth` said `stale` (with `peerName: ""`) for a pad
  whose peer was running, and the health check said something else — because
  `vm-manager` read the live `HostConfig.NetworkMode` while `container-health` read
  the compose `network_mode`, and each had its own copy of the rule. Both were
  locally reasonable and the pad had two answers. Extracting the rule into a pure
  `classifyNetworkPeer()` (`services/net-peer.js`) that both call is what made the
  contradiction **impossible** rather than fixed; the two inputs (compose's
  declared name vs the live bound id) are what make the case real, so pass BOTH
  rather than picking one. Note the state that mattered: `staleBinding` — the peer
  is running and needs nothing, only the pad's binding is dead. Collapsing it
  into `stale` is what told a caller to recreate a peer that was fine **and** hid
  that the pad could not start (docker's own error: `joining network namespace of
  container: No such container`). When a verdict splits into "which of these two
  things is wrong", that is the finding — one combined state is what sent the
  caller to the wrong object.
- **Verify a refactor that changes a SOURCE-TEXT assertion: the assertion is a
  pin on where the fact LIVES, so moving the fact turns the test red for a
  reason that is not a bug.** After extracting the rule, three tests failed on
  wording and location, not behaviour: a `reason` that said `Start it` where the
  test read `/start it/`, and an assertion that the health hint says `IS running`
  when the sentence had moved into `net-peer.js`. The fix is to re-point the
  assertion at the fact's new home and say why in a comment — **never** to relax
  it into something that passes. Re-run the mutation control afterwards: the
  guard is only proven by the tests going red when the code is removed, and a
  control that no longer bites proves nothing about the restored code either.
- **A summary field derived from two facts is a SECOND answer to a question the
  row already answers, and it will contradict it.** `task_submit` returned
  `mode: pad ? 'push' : 'pool'` at the top while the row inside the same response
  carried the correct derived `route` — so an addressed `enqueue: true` submit
  said `push` in one field and `enqueued` in the other. Read the summary off the
  row's own derived value, never recompute it from the arguments.
- **Copying a column into a re-file produces a row that LIES, and the label is
  the only evidence.** `retryTask` copied the original's `enqueue` flag, so a
  retried *push* kept `enqueue = 0` with no child process attached — and
  `task_route`, deriving `push` from that same flag, reported a PAD was running
  work nothing was running. A retry is a **re-file, not a run**: the replacement is
  always claimable. The general form: when a derived field is computed from
  stored facts, every way of writing a row must leave facts that make the derived
  answer TRUE — never write a fact for its side effect on a label.
- **`claimed_by` does not need a `claimedBy`, and a test must say so.** Adding a
  second spelling of one field is how a queue ends up with two sources of truth
  for who is working on what. Store facts, derive the agent-facing vocabulary
  (`route` / `outcome` / `timedOut`), and pin the negative in the schema test
  (`assert.ok(!cols.includes('claimedBy'))`) or the next person will add it as a
  "harmless convenience".
- **A "browse the workspace" permission needs a CAPABILITY answer too, and
  the two must be reported separately.** `HOST_BROWSE=1` said yes on
  `pad-opencode-paddock-dev` and every browse still failed, because a workspace
  mounted from outside the project root (`/www1`) is not on the webui's host at
  all — permission cannot buy a capability. `workspaceMountInfo` now returns
  `hostBrowsable` **plus** a `hostBrowseReason` sentence, so a refusal is always
  explainable instead of being a shrug. The MCP surface deliberately has **no**
  browse tool (`workspace_list`/`workspace_read` retired in plan 64): dumping a
  tree into a model's context is a large, usually unwanted read, and `exec` on a
  running pad plus `workspace_write` cover the real work. Removing a capability
  because it is available another way is not a step backwards.
- **A per-instance data dir is MOUNTED at a path the agent calls its home — so a
  store path written from the agent's own docs is wrong by one segment.** codex
  rollouts live at `\$HOME/.codex/sessions` because compose mounts
  `<instance>/codex` there, so on the host they are
  `<workspace_root>/codex/sessions`, not `<workspace_root>/sessions`. Reading
  the shorter path returned `no-store` on every codex pad ever created, and the
  opencode reader (correct for its own layout) made it look like a
  driver-specific quirk rather than a mount mapping. **Verify a store path
  against a real file before building a reader for it.**
- **The newest message of a role is often not the answer, and the store's index
  is not on the column you sort by.** Two measured facts, both of which produced
  a confidently wrong `plan_activity`: `opencode`'s `part` table is indexed on
  `session_id` ALONE, so `order by time_created` sorts the whole table
  (10–21 ms, growing), and each assistant **step** is its own message — a bounded
  window over messages returned 12 assistant steps and no user message at all on
  a session that plainly had one. So: put the role in the **query**, take the
  newest message of that role, and walk a bounded window of OLDER messages of the
  same role for the user text. "Last message" is a windowed search, not `LIMIT 1`.
- **A caller-controlled codex `user_message` is the human; a `role: user`
  response item is the machine.** The rollout records both. Reading
  `response_item`-only `user` messages returns injected CONTEXT and environment
  blocks, so "what did the human last ask" came back as the agent talking to
  itself. Codex's human turn is `event_msg` → `user_message`.
- **A call with no output row is RUNNING, not completed.** codex records the
  `function_call` and its `function_call_output` in separate records; treating
  the call alone as finished makes a live tool call look done. The quiet lie is
  the one that says work stopped when it did not.
- **A stopped pad still has its store, so "the container is down" must not
  become "there is no activity".** The stores are in the agent data dir on the
  HOST, so the read never touches docker. `padRunning` (container state) and
  `store.available` (could we read it) are different questions, and a read
  failure is reported rather than smoothed into an empty answer. Also: a store
  file that exists with NO SCHEMA is a pad that has never run its agent — that
  is `empty-store`, not `unreadable`, and a 0-byte file is not a corrupt
  answer. **Prove the stopped case with a row whose `status` is `stopped`, and
  re-read the SAME transcript**: a control that only asserts "no crash" passes
  just as well against a store that returns nothing.
- **A per-driver facility has per-driver COSTS, so one claim about speed is a
  lie for two of three drivers.** `plan_activity` on opencode is one indexed
  sqlite query (~2 ms); on codex/claude it parses that one conversation's jsonl
  file. "Indexed rows, never a scan" was true of the first and false of the
  others, in the tool description, the guide, and here. State the cost where the
  caller reads it, per driver, and say what it rules out (polling one live
  session is fine; looping over every id is not).
- **A plan belongs to a Mission project through its SESSION, not its folder.**
  Plan files live in the PAD workspace `plans/`, which is not a project's folder,
  so `plan_list {folder}` filters on `row.sessionProject.folder` — stamped from
  the session's own project row — and **after** the state stamp, because a row is
  only attributable once stamped. A plan whose conversation the page has never
  seen cannot be attributed, so it comes back as `sessionUnattributed`: a
  folder-scoped list that quietly dropped those would be short and look complete.
  Same instinct as the `task_list` `total`: an unfiltered count next to a
  filtered list is a second, wrong answer.
- **A migration suite needs a control that asserts the MIGRATION ran, and the
  only honest one asserts the columns are ABSENT when it did not.** Every
  assertion in a migration suite also passes on a database that already has the
  columns, so a green run proves only "the column exists somewhere". `db.js` adds
  the five plan-63 task columns in a **loop**, which is the riskier shape — it
  looks incapable of failing halfway — and a missing column here is worse than a
  crash: `task_route` reads `undefined`, which is falsy, which silently means
  "this was pushed" and "this did not time out" for every task ever filed. The
  control boots the stripped fixture with `ALTER TABLE … ADD COLUMN` suppressed
  and asserts absence; remove the loop and the five real tests go red while the
  control stays green. **Re-measure by removing the code and watching tests fail** —
  done here: 3 red, then 11 green on restore.

- **A guard asserted as a FINAL state cannot fail if the bug is a TRANSIENT one, so
  state the invariant as a predicate over the whole SEQUENCE — and prove it by
  reversing the ORDER, not by deleting the code.** Plan 68's flash was 376ms of col
  3 showing "This session is closed" *between* two correct states, so "the guard is
  eventually cleared" passes on the broken build (both orders clear it). The test
  subscribes to the store, records `(reopenFor, sessionState.live)` on every `set`,
  and asserts **once the reopen has started, the guard never reads null while
  `sessionState` is still the dead read**. Two refinements the first draft needed,
  both learned by watching a CORRECT build go red:
  - **Scope the predicate to where the bad state can actually occur.** Before the
    reopen starts there genuinely IS a `(guard null, dead read)` state — the
    detection read landing — and it is harmless because the next set is in the
    same synchronous block, so React batches them into one paint. An unscoped
    version fails on correct code, and the tempting response to that red is to
    weaken the assert, which is how a guard dies. **A red test on correct code is a
    bug in the assert: read it before touching the code.**
  - **Assert what was PROMISED, not what is incidental.** "Exactly one outcome read
    after the restart" was wrong — there are two, because `refreshActive()` inside
    the reopen already re-reads the open session (`fetchAll` → `fetchSessionState`).
    Pinning the count would assert a detail the store never claimed, and the next
    legitimate read would break it.
- **A test that passes because the fixture never got the code running is worse
  than no test, and the tell is a flag that never flips.** Plan 68's "the poll path
  never restarts a dead session" passed with `openSession: null`, because every
  `fetchSessionState` call took the *"the user left on another row"* early return —
  so the negative held vacuously. **Give the negative test a POSITIVE twin on the
  same fixture**: re-arm the identical dead pane with the flag ON and assert a
  restart *did* happen. If the twin cannot go green, the fixture is inert and the
  negative proves nothing. Adjacent: `selectSession` returns `void`, not the
  promise (a click handler ignores it), so a test cannot `await` the reopen it just
  triggered — drain microtasks instead. *"The API under test doesn't return its
  promise"* is a fact to design around, not an obstacle.
- **A mutation control must run in a COPY, and you must read the ORIGINAL back
  afterwards.** `src/` is bind-mounted, so a `docker exec … node -e` rewriting
  `/app` rewrites the **worktree**. Plan 68's control reverses the reopen ordering —
  the exact defect — so running it in place would have disabled the guard in the
  committed source. Recipe: `cp -r` the client to `/tmp`, mutate **there**, copy it
  in as `/mut`, run with `node_modules` symlinked from `/app/client`, then `rm -rf
  /mut` and **grep the original** to confirm the good order survived. Two cheap
  checks make the control trustworthy: assert the mutant is in the COPY *and* the
  correct order still in the source, and confirm the expected test goes red
  **while the rest stay green** — a control that reds everything proves only that
  something broke.
- **A test must be able to reach code written for a BUNDLER, or it will be
  "unittestable" for a reason that has nothing to do with the code.** The Mission
  store is ESM and imports `../lib/api` extensionless — Vite resolves that, Node
  does not — so `node --test` died on the store's own import, not on the store. Fix
  it at the RESOLVER (`test/helpers/client-store-resolve.mjs`, a `module.register`
  hook filling in `.js`/`.jsx` for extensionless relative specifiers **inside the
  client package only**, so it can never rewrite a bare specifier or a real
  `node_modules` lookup). Do **not** edit the store's import to suit a test
  harness — that is a bundler-shaped change to production source.

## Project Map

- **`docker-compose.yml`** defines the `webui` service (container `paddock`,
  image `paddock-webui:latest`) — the **control plane**: Node.js/Express on
  port 6789 managing all PADs via `/var/run/docker.sock`.
- **`src/`** — webui source, bind-mounted to `/app` (backend edits need no
  rebuild). Express `app.js` + `services/`; **`src/services/drivers/`** = one
  module per agent type (openclaw, opencode, picoclaw, hermes, codex).
- **`src/vm-builds/<type>/`** — per-type Dockerfile + start.sh; images tag
  `paddock-vm-<type>:latest`.
- **`src/client/`** — React 19 + Vite SPA. Built output → `src/public/`
  (served at root `/`; API under `/api/*`, WebSocket at `/ws/terminal/*`).
  Old EJS routes/`routes/agents.js` are dead code.
- **`instances/<pad>/`** — per-PAD dir: `<agent>/` bind-mounted data dir,
  `docker-compose.yml`, **`meta.env`** (critical state), `logs/`.
- **`src/test/mission-reopen.test.js`** + **`src/test/helpers/client-store-resolve.mjs`** —
  plan 68's auto-reopen guards, and the ESM resolve hook that lets `node --test`
  reach the client store at all. The ordering assert is a **sequence** predicate
  (see the guard/transient lesson above), and a negative here is only meaningful
  with a positive twin on the same fixture.
- **`src/client/src/components/OverlayScroll.jsx`** — the floating scrollbar the
  Mission listings use. A native bar always reserves layout space, so in a 260px
  column it eats a tenth of the listing, and `scrollbar-gutter: stable` only
  hides that space rather than returning it. This hides the native bar
  (`scrollbar-width: none` → reserves nothing in any overflow state) and draws
  the thumb itself. Two things it taught: **use a native `addEventListener('scroll')`,
  not React's `onScroll`** (scroll doesn't bubble, so a delegated handler never
  fires and the thumb silently stops tracking), and **do not transition the
  thumb's opacity** — see the headless gotcha below.
- **`backups/`**, **`plans/`** — archives and idea files.
- **`infinite.md`** — the forever task queue the user appends plan paths to;
  see § Infinite loop below.
- **`friction/`** — chat-test findings log: what LLM callers of the MCP
  surface couldn't understand or do (`friction/README.md` has the shape).

## Golden Rules

- **Never touch containers outside this project.** Containers not created by
  our own code are not ours — no start/stop/exec/inspect.
- **Never create random containers for testing.** Test only through project
  tools (web UI, compose services). `docker run` with external images is out
  of scope.
- **Never use a `vm-` prefix.** PAD naming comes from `CONTAINER_PREFIX` in
  `.env` (e.g. `pad-`). Refer to PADs by their actual name only.
- **Never use the question tool mid-conversation** — ask in text; the tool is
  only for fallback / complex multi-option when justified.
- **Always test before delivering.** Never hand code to the user untested:
  restart the service, open the browser, and verify the affected page yourself
  (http://10.69.1.164:6789). Browser MCP tools are available. "Works on my
  end" is not acceptable — prove it live; no "fix it later".
- **Always consult the online OpenClaw docs** (https://docs.openclaw.ai) before
  any `openclaw` CLI/config work — they change frequently; never trust cached
  knowledge.
- **CommandsPane action buttons paste `openclaw ...` commands into the docked
  terminal** (`run(cmd)`) — never a backend action API. Read-only GETs are
  fine. The Vault is the exception on purpose (server-side secrets).
- **Run tests individually, never the combined `node --test test/` suite**
  (hangs). `timeout 60 docker exec paddock node --test test/<file>.test.js`.
  `vm-manager.test.js` needs the `GUARD_*` envs unset (see docs).

## Critical Operational Gotchas

- **The subscription-exhaustion case is a once-per-day capture opportunity.**
  The user reports no agent reply while OpenCode says the limit is over and
  asks them to subscribe to Go. Follow `plans/75-provider-exhaustion-detection.md`
  and preserve the actual notice plus session id before restarting, resuming,
  retrying, or waiting for reset. Temporary 429 errors (even a response named
  `FreeUsageLimitError`) are NOT proof of that subscription limit. Keep the
  user's observed notice distinct from independently captured evidence; an
  empty completed assistant message and idle status establish no successful
  reply, not the cause. Save findings immediately so the next daily occurrence
  does not require repeating the investigation.

- **A terminal that drops "every few seconds" was the webui DYING, not a client
  bug.** Check this FIRST whenever the user reports the terminal glitching,
  stuttering, or randomly disconnecting — it is the cheapest and most often
  correct explanation, and it is invisible in the browser:
  `docker logs paddock --since 10m | grep -c "listening on port"` — more than one
  boot means the process is dying. A JS death prints a stack trace ending
  `Node.js v20.20.2`; a container stop instead shows up in `docker events` as
  `kill sig=15` → `kill sig=9` (10s later) → `die exit=137` → `start`. The
  number of "listening" lines in the last 10 minutes is the health signal.
  Each death drops every WS **and** orphans every `tmux attach` it owned
  (`activeTerminals` is in-memory), so the two symptoms travel together.
- **The installed MCP SDK does NOT catch a throwing tool handler.**
  `@modelcontextprotocol/sdk/.../server/index.js` `wrappedHandler` does
  `result = await Promise.resolve(handler(request, extra))` with no try/catch, so
  the rejection escapes as unhandled and **kills the webui**. Every
  `requireTool` / `requireAgent` / `requireHostBrowsable` rejection is therefore
  fatal unless the tool is registered through the `registerTool` wrapper in
  `mcp.js` (which returns `{ isError: true, … }` instead). New tools MUST go
  through that wrapper. `app.js` also installs `unhandledRejection` /
  `uncaughtException` handlers that log and stay up — a control plane must not
  die because one agent's tool call threw.
- **A redactor that reads like it normalizes, but doesn't, ships the secret it
  was written to stop (plan 60).** Three of the four bugs in the MCP config
  redactor were found by *testing*, not by re-reading it: `isSecretKey` had a
  comment saying keys are normalized (camelCase split, separators unified) while
  the body tested the raw string, so `xMcpKey` passed and only `x_mcp_key` was
  caught; the depth cutoff was `if (depth > 8) return obj` — i.e. **handed over
  untouched** exactly what it was too deep to inspect, so a cutoff must fail
  CLOSED (`return '[REDACTED]'`); and the headers rule was `^headers?$`, so
  `httpHeaders` slipped. Then the first *fix* for that over-redacted config the
  LLM needs (`tokenLimit`, `passwordPolicy`, `monacoKeyBinding`) by matching any
  *segment* — which is why the rule is a `_-terminated SUFFIX` plus a short
  `NON_SECRET_KEY_SUFFIX` noun allowlist. Redact by **shape** (any value under a
  `headers` map, whatever the header is named), not by an equality list of key
  names. Two more traps in the same area: a redaction must cover **every field**
  that carries the value, not the one that was reported — `configRaw` and
  `web.startCommand` each leaked a second copy the fix would have missed; and
  **redact at the MCP boundary, not in the store** — `agent-registry.js` still
  holds `web.token` because the dashboard's open-console link needs it, and
  `readAgentConfig` is shared with a REST route the config editor round-trips, so
  redacting it there writes `[REDACTED]` into the user's real config on save.
  Redact the raw read only where it leaves the process, and pin BOTH halves in a
  test. Finally: **a secret-leak fix does not un-leak the secret** — the
  credentials themselves are still burned and need rotating at the source.
- **Never syntax-check the webui by `node -e "require('/www2/paddock/src/app.js')"`
  — it BOOTS the app** (binds 6789, opens the DB, runs migrations) and leaves a
  second server plus root-owned DB files behind. Use `node --check src/app.js`
  for syntax, `docker restart paddock` to load.
- **opencode's `/session/status` answers `{}` unless you pass `?directory=` — and
  `{}` is indistinguishable from "nothing is working".** This is the only
  server-side way to see a conversation the agent is working on from ANY client
  (web UI, SDK script, a second TUI) rather than only from our own tmux, so it
  backs the session-list dot. Called unscoped it returns `{}` *even while a turn
  is streaming* — measured: an 8.2s turn, 25 polls during it, `{}` every time.
  Scoped to the folder the turn runs in it returns
  `{"ses_…":{"type":"busy"}}` immediately. The other two ways to get the same
  silent `{}`: the wrong **port** (use the PAD's own `web.containerPort` — the
  driver default says 8080 while the running server here is 7890) and a missing
  **folder** (a `mission_sessions` row carries no folder, so the call site must
  pass the project's). Also: group such probes by **(PAD, folder)**, never by
  PAD alone — `paddock`, `schlorp` and `craftpip` all run on
  `pad-opencode-proj`, and a PAD-keyed group stamps the first folder's answer on
  the other projects' rows. The map is a live-work registry, not a presence list:
  it empties when the turn ends, and there is no client/connection endpoint, so
  an idle tab open in the web UI is NOT detectable.
  **CRITICAL SCOPE LIMIT (measured 2026-09-29): this only ever reports
  conversations THAT WEB PROCESS IS DRIVING.** A Mission pane is a separate
  `opencode` TUI process holding no sockets, so its turn never appears here at
  all — 42 straight seconds of a visible `esc interrupt` with our id absent, while
  the user's own web-UI session was reported busy the whole time. So the wording
  above ("the only server-side way to see a conversation from ANY client") is
  **false for tmux-driven sessions** and the probe is a **complement** to the pane
  state, never a substitute for it. See "a live-work probe can be answering
  about a DIFFERENT PROCESS" above.
- **A "dead" row is not a dead conversation.** A mission session whose tmux pane
  died while the user is chatting with that same conversation in the opencode web
  UI is open and working. The two questions are separated by **`busy`**, not by a
  client-side pane flag: a row's `open` is the server's `live || busy`, so the
  web-UI conversation lights its dot with no session of ours on it, while a
  genuinely idle row with no pane reads as simply *not open*. The client no
  longer computes a "gone" state at all (plan 58) — so if you are tempted to add
  one back, remember it is what made the listing say "the pane is no longer
  there" in a language the user never asked for.
- **Mission sessions (`msn-*`) are multi-client; a second tab must not kick the
  first.** Three places in the terminal WS in `app.js` implement that, and all
  three must agree or you get the reconnect-fight loop back: (1) connect skips
  the supersede close, (2) connect skips `sweepStaleAttaches` (its second call
  site — the one in the try-block before `ensureTmuxSession`; the first is in
  cleanup), (3) cleanup only sweeps when the **last** client leaves, tracked in
  `terminalClients`. The sweep is what reaps orphaned `tmux attach` processes
  (`dockerStream.destroy()` does not reliably kill the exec), so skipping it
  entirely lets orphans pile up on long-lived mission sessions.
- **The terminal WS may lazily re-create a missing tmux session — that
  resurrects a CLOSED mission session.** An attached client reconnects, the
  server re-creates the tmux session, and "Close" silently un-closes it as a
  bare shell. `mission.getSessionByTmux()` in the WS connect path is what stops
  it: no DB row → refuse with a message + close 4002. Any new attach path for
  `msn-*` needs the same guard.
- **An attached terminal can resurrect a killed tmux session as a bare shell**,
  so "the pane is gone" must come from the pane state (`paneState().live`),
  never from the session existing. Mission splits the two recoveries: live pane
  without a TUI → **relaunch** (`POST .../relaunch`, keeps the conversation);
  no tmux session at all → **restart** (`POST .../restart`, recreates with
  `-c <project.folder>`, same tmux id, same `agent_session_id`, and refuses with
  `mission_folder_missing` rather than starting in the wrong directory).
  **Since plan 68 the row-click path does this restart for you**, and that is a
  deliberate spend, not an oversight: opening a session whose pane is gone now
  relaunches the agent TUI in that conversation (`opencode -s <agent_session_id>`,
  same tmux id) instead of showing a closed notice with a button. So "clicking a
  row can start spending tokens without asking" — the opt-in is the **user's
  open action**, gated by `autoReopen`, which only `selectSession` /
  `startSession` pass. The **poll path never does**: a pane that dies while you
  are watching it still gets the non-destructive notice and the button, because
  relaunching an agent process unasked is the human's call (plan 53 §6).
- **A "Loading…" line in a list that already has data is a bug, not a
  placeholder.** Every 15s poll and every action flips `sessionsLoading` /
  `historyLoading`, so an unconditional placeholder pushes the listing down a
  line and back on each tick. Show it only when there is genuinely nothing yet
  (`loadedFor !== project.id`, `!history`) — `loadedFor` is set on SUCCESS, not
  when the fetch starts, or the placeholder can never appear at all. Also: two
  group headers both `sticky top-0` in one scroller stack on top of each other;
  the second one needs the first one's height as its offset.
- **The headless test browser (cloakbrowser) produces NO frames, which breaks
  three classes of check that otherwise look like product bugs.** `requestAnimationFrame`
  never fires, **a CSS transition sits at its start value forever** (so
  `getComputedStyle(el).opacity` reads `0` for an element that is *supposed* to
  be fading in — confirm by nulling the transition before "fixing" the CSS), and
  **`el.scrollTop = 400` dispatches no `scroll` event at all** (a probe listener
  counts 0; `el.dispatchEvent(new Event('scroll'))` then fires 1 and the handler
  runs). So a "does the scrollbar thumb follow the scroll?" test must dispatch the
  event itself, and any reveal/hide that depends on a transition must be
  verified by its end state, not its animated value. Also: `Browser.setWindowBounds`
  does not resize the layout viewport here, so you cannot force a list to overflow
  that way — append filler to the scroller instead.
- **A fast number is not a verified number: re-measure with the OLD setting as a
  control, changing nothing else.** Proving tmux `escape-time` was the ESC delay
  meant measuring the same live pane twice, minutes apart, flipping only that one
  option: median 16.8ms at `escape-time 10`, 506.9ms at tmux's 500ms default.
  Either figure alone proves nothing — a path that was never slow looks exactly
  like a fix, and "I pressed ESC and it felt instant" is how a wrong cause gets
  shipped. The control costs one extra run and is the only thing that
  distinguishes "fixed it" from "was never broken here".
- **A synthetic `keydown` on `.xterm-helper-textarea` reaches the pane, and that
  is how you time a keystroke end to end.** xterm does not check `isTrusted`, so
  `ta.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', code:'Escape',
  keyCode:27, bubbles:true}))` exercises the identical xterm → WS → stream → tmux
  path — and, unlike a tool-per-keypress loop, `performance.now()` can be
  stamped immediately before the dispatch, so a tool round-trip never lands
  inside the measurement. Read the result by polling `.xterm-rows` with
  `setTimeout` (rAF is dead here, but xterm's `refreshRows` writes to the DOM
  synchronously, so echoes *do* appear). Two gotchas: a synthetic `-` is
  **dropped** unless it is the first key after a newline, so paste command text
  through a `ClipboardEvent('paste')` instead; and to make ESC visible at all,
  run `cat -v` first — a bare shell prompt echoes nothing for it.
- **A `Splitter`'s own `min` can make a panel uncollapsible by hand, and the
  fix is not to lower `min`.** `Splitter.clamp` floors the width it *reports*, so
  with `min={200}` the parent never sees a value below 200 and cannot decide to
  collapse on "dragged under the minimum". A snap-to-collapsed rule belongs in
  the parent: give the divider the floor width (`min={RAIL_W}`) and turn the
  number into a decision there (`< COL1_MIN` → collapse, `>= COL1_MIN` from
  collapsed → open). Two more traps in the same component: the divider must stay
  **mounted in both states** (hiding it when collapsed removes the only way to
  fold by hand), and the arrow keys nudge by a *delta from the current width*, so
  from a floor they can never cross it — hence the `openAt` prop (first press
  jumps to the width the parent calls open). Live-verified both ways with
  synthetic `PointerEvent`s on `.msn-splitter-1`.
- **Two rules for a fold/expand that must not MOVE anything — measure BOTH gaps,
  and branch the drag rule on the FOLDED state, not the stored one.** (1) A
  collapsed column has to stay *centred*, and the inset that does it is forced:
  for a 56px rail holding a 32px control it is `(56-32)/2 = 12`, so the head, the
  body and the rows all share one 12px gutter and every control measures 12 left /
  12 right. Asserting only `x` hides the whole bug — a head left at the toolbar's
  `px-2` puts the arrow at x=8 with 8px on the left and 16px on the right, which
  every left-edge assertion still passes. Add `colRight - controlRight`. Related:
  `items-center` silently DISCARDS horizontal padding in a narrow column (it
  re-centres the 32px button at 12), so a container that needs its inset honoured
  must be `items-start`. (2) A fold that can also be driven automatically (a
  narrow-viewport fold via an override flag) has TWO sources of truth. Branching
  the drag handler on the *stored* flag left the auto-folded rail a dead end: it
  called `setCol1(200)` and the column stayed folded, because the fold was still
  being computed from the other flag. Branch on the derived `col1Folded`. Same
  trap in one place: a character glyph (`‹`/`›`) renders ~5px wide inside a 32px
  button, which reads as "so small" and is genuinely hard to hit — use a stroked
  SVG for a control's only icon, but pick its size by LOOKING at it, not by
  reasoning: 5px was unusable, the first 20px SVG read as too heavy next to the
  avatars, 14px is right. Scale `strokeWidth` with the box.
- **Deleting a Mission project kills that AGENT's tmux sessions, not just that
  project's.** Several projects can point at one PAD (`paddock`, `schlorp`,
  `craftpip` all ran on `pad-opencode-proj`), and the delete confirm's
  "the agent's tmux sessions are closed" is literal — the tmux sessions die with
  whatever project rows pointed at that agent, including the LIVE conversation
  you were looking at. So the junk-project cleanup rule below has a sting: after
  deleting junk, the user's real session on that same agent shows col 3's
  explicit `The tmux session is gone` state (with its own *Restart the TUI*
  button). Don't click that restart for them — it launches an agent process in
  their conversation; report it and let them choose. (Plan 68 changed one half of
  this: if the user *clicks the row themselves*, the reopen happens without the
  button, per the entry above. The junk-cleanup sting still holds — the point is
  that **you** must not trigger a TUI launch on their behalf, not that the app
  ever needs a button.)
- **`matchMedia` is untestable in a headless tab, `window.innerWidth` on a
  `resize` listener is.** `Browser.setWindowBounds` does not change the layout
  viewport (already noted below), so a responsive feature keyed on a
  `MediaQueryList` cannot be exercised at all: `window.matchMedia(q)` returns a
  FRESH object per call, so a test dispatches `change` on an object the component
  does not hold and nothing happens (it looks exactly like a missing listener),
  and `Page.addScriptToEvaluateOnNewDocument` did not apply here either. A
  `resize` listener reading `window.innerWidth` is the same behaviour, cheaper,
  and testable: stub the getter with
  `Object.defineProperty(window, 'innerWidth', { get: () => 1400 })` and dispatch
  `new Event('resize')`. For the initial load use `Target.createTarget`'s
  `viewport` (works: verified 900px and 700px) — the rest is the resize path.
- **Coordinate clicks on the Mission page can submit a form you never aimed at.**
  The `Input` click tool reports `clicked: true` for the element you named, but
  during a session it twice created a junk project (`~` and then `root`, both
  `pad-opencode-proj` on `/root`) out of the "+ New project" dialog. After using
  it on this page, **check `GET /api/mission/projects` and delete anything that
  is not the user's** — the user had 3 (paddock, schlorp, craftpip). Prefer
  `el.click()` on a specific element; it lands where you say and does nothing
  else. Deleting a project also closes that agent's tmux sessions.
- **Count the Mission projects at the END of any browser session on that page,
  not only after a coordinate click.** A third junk `root` (again `pad-opencode-proj`
  on `/root`) appeared with no coordinate click anywhere near it, so the trigger
  is not fully explained by that tool — the user may also be clicking in their
  own tab while the agent works. `GET /api/mission/projects` is cheap; a silent
  junk row also shows up as a stray extra avatar in the new col-1 rail, which is
  how it was caught. Do not delete a row you cannot attribute without asking
  first: it may be something the user just made on purpose.
- **`src/test/mission.test.js` is SAFE to run now — it uses its own throwaway
  database.** It used to run against the live dev DB and wipe the Mission tables
  (projects + sessions), which is why this file carried a "back up `app.db*` and
  recreate the user's projects" warning. That warning cost a restore TWICE in one
  session before the cause was fixed rather than worked around. It now sets
  `PAD_DB_PATH` to a `mkdtemp` file **before** requiring anything that loads
  `db.js` (the path is read at module load, so setting it later does nothing), so
  the real code path and the real migrations still run and the user's rows are
  never at risk. **`PAD_DB_PATH` is the general answer to "this suite destroys
  data"** — reach for it before adding a backup ritual, and while you are there
  check for residue the earlier live runs left behind (`pad-msn-*` agent rows
  accumulated exactly this way). Note that an agent row can have a real
  `activity_events` audit trail from months ago even when its instance dir is
  gone, so "no instance dir" means residue for a row created *today* and not
  necessarily for an old one.
- **A hand-written "old schema" fixture is not a weaker test, it is a WRONG
  one — derive it from the real schema and delete the columns under test.** The
  db-migration suite (`src/test/db-migration.test.js`) covers the one schema code
  path that touches a *populated* database, because `CREATE TABLE IF NOT EXISTS`
  skips an existing table so only the `ALTER`s can add a column — and a migration
  that silently does nothing does not error at boot, it surfaces much later as an
  `INSERT` against a missing column, on whatever request happened to be next.
  Writing the fixture by hand failed twice before passing, both times for reasons
  that had nothing to do with what it was meant to prove: a guessed `tasks` table
  omitted `agent_name`, so `CREATE INDEX idx_tasks_agent` blew up; and a guessed
  `mission_projects` omitted `agent_type`/`prompt`'s NOT NULL siblings. So the
  fixture is built by letting `db.js` create today's schema, populating it, then
  dropping exactly the two columns the `ALTER`s own. Two more things worth keeping:
  **an assertion that cannot fail is worse than none** — the suite ships with a
  control where the migration is removed and 4 of 6 tests go red, because a green
  run of a migration test proves only that the column exists somewhere; and
  **a migration's most common case is "already migrated"**, since every restart
  re-runs it, so idempotence is asserted explicitly rather than assumed (a
  migration that threw on the second boot would break every restart after an
  upgrade). `DB_PATH` honours `PAD_DB_PATH` purely for this; unset in production.
- **`openclaw models auth paste-api-key` destroys the whole `openclaw.json`**
  (rewrites it with auth info only). Save the config first and merge it back
  after. It reads the key from stdin — use `spawn`, not `execFile` (hangs).
- **Published openclaw refuses Control UI over plain HTTP unless device
  identity is skipped.** The WS handshake fails with
  `cause: control-ui-insecure-auth`; `gateway.controlUi.allowInsecureAuth`
  alone does NOT fix it. `applyWebAuth` therefore sets
  `gateway.controlUi.dangerouslyDisableDeviceAuth: true` on publish (token-only
  auth) and `removeWebAuth` restores the pre-publish `controlUi` (state file
  `web-openclaw.json` saves `{ bind, auth, controlUi }`). The state file is
  written only on the FIRST publish; re-publishing an already-published pad
  keeps the original saved state (overwriting it made unpublish restore the
  published form).
- **`instances/*/meta.env` is critical** — without it PAD discovery returns 0
  PADs and detail pages show "Agent not found". `setMetaFlag(name, key, '')`
  REMOVES the line instead of writing `KEY=`.
- **The webui runs as root (plan 43) — that's intentional, not a bug.** Root is
  how it controls the host FS + docker socket. `removeInstanceDir` is a plain
  `fs.rmSync` (no root-helper container, no EACCES paths); agent configs are
  read/written directly. Everything the webui creates is `chown`ed back to
  `PUID:PGID` via `ownership.ensureOwned` after each create. A boot sweep
  (`normalizeTree` over `src/data/` + `instances/`) re-heals root-owned agent
  data, EXCEPT hermes data dirs (`isSelfManagedAgentData` skips them — hermes
  re-chowns `/opt/data` to uid 10000 every boot). Verify user files are
  `PUID`-owned after any create/rebuild; agent containers still write root
  files mid-run by design.
- **Per-PAD "Container user" (plan 43 Phase 7, meta `USER_MODE=user`) drops
  the agent daemon + terminal to the `pad` user (PUID:PGID=1000:1000), not the
  whole container** — the image still boots as root (chpasswd/sshd/start-web
  hooks), then `start.sh` re-`chown -R 1000:1000` the data dir and `setpriv`s
  the keeper; SSH stays the root admin door. Compose emits the `USER_MODE`
  env, never a `user:` line. **tmux is user-scoped**: a user-mode pad's session
  socket lives at `/tmp/tmux-1000` and its tmux setup/attach/exec MUST all run
  as the pad user (`termUserArgs` adds `-u 1000:1000 -e HOME=/root`), or the
  attach misses the session. `HOME=/root` is kept on purpose (agent CLIs
  resolve config via `$HOME`); hooks stay root-written `/root` config files.
  Existing pads toggled to user mode rebuild: `ensureUserModeBuildFiles`
  regenerates `start.sh` from the template (machine-managed) and surgically
  injects the pad-user block into the user-editable Dockerfile. hermes is
  always root-mode (already runs as its own user).
  **Passwordless sudo in user-mode images MUST use `ALL ALL=(ALL) NOPASSWD:ALL`,
  not `pad ALL=(ALL) NOPASSWD:ALL`.** The `pad` account at uid 1000 collides
  with base-image users (e.g. `node` in node:20-slim) that appear EARLIER in
  `/etc/passwd`; the terminal drops via `setpriv --reuid 1000` and `sudo`
  resolves the invoker by uid to that earlier name, so a `pad`-keyed rule
  demands a password. The rule + a `sudo` self-install guard (`if ! command -v
  sudo; then apt-get install sudo / apk add sudo; fi`) live in 3 places —
  `PAD_USER_DOCKERFILE_BLOCK` in vm-manager.js (injected into toggled pads),
  every `src/vm-builds/*/Dockerfile`, and each instance's own `build/Dockerfile`
  (regenerated by `ensureUserModeBuildFiles`, which REPLACES stale blocks on
  re-toggle — the block is machine-managed, user edits land elsewhere). The
  self-install matters because toggled pads build from their ORIGINAL Dockerfile
  copy (pre-sudo package list) — without it the sudoers drop-in silently does
  nothing. Debian images also still list `sudo` explicitly in the package list.
- **`tmux new-session -c <dir>` does NOT fail on a missing directory — it
  silently starts the pane in the PARENT.** Verified live on `pad-opencode-proj`:
  asked for `/www1/craftpip` (gone), got a working session whose
  `pane_current_path` was `/www1`, with the agent happily working in a folder
  the user never chose. **Always `test -d` the folder inside the PAD first**
  (`padTmux.folderExists`, single-quote-escaped) and refuse with a clear
  message; never trust tmux to tell you the folder was bad. Same class of
  trap: check `pane_current_path`/`pane_current_command` when you need to know
  what a pane is really doing.
- **tmux primitives live in `src/services/pad-tmux.js`, not app.js.** app.js's
  `ensureTmuxSession`/`ensureTmux`/`killTmuxSession`/`listTmuxSessions` are thin
  delegates. Reason: the Mission page and the MCP tools need the same primitives
  and `mcp.js` must never `require('./app')` (it would drag in Express). If you
  need a tmux capability, add it to pad-tmux and delegate — do not re-inline a
  second `docker exec … tmux` call in app.js. **`pad-tmux`'s `tmuxExec`/`padExec`
  take an OPTIONS OBJECT `{timeout, check}`**, not a bare number: passing a
  number-shaped object makes `execFile` throw
  `The value of "timeout" is out of range` at runtime. The unit tests validate
  that (`src/test/pad-tmux.test.js` asserts on the recorded argv AND the
  options) because a fake `runCmd` that ignores options will happily pass a
  call that only breaks against real docker.
- **The `mission_*` MCP tools may `require('./services/mission')` — never
  `./app`.** `mission.js` is a service (db, drivers, pad-tmux, workspace only),
  so the five tools (`mission_projects`, `mission_sessions`,
  `mission_project_create`, `mission_session_start`, `mission_send`, plan 55)
  are thin adapters over it, exactly like `/api/mission/*`. Two contracts worth
  keeping: a MissionError's **machine code** is re-thrown as
  `<code>: <message>` (the SDK's error path only prints `message`, and the LLM
  branches on the code), and every tool is **resolve-then-gate** — resolve the
  project, read the PAD name off it, *then* `requireTool` — because
  `requireTool` needs a name. Liveness must stay **one `list-sessions` per PAD**
  (  `mission.withLive` / `withLiveSessionsByAgent`), never `paneState` per row,
  and a failed probe marks sessions dead rather than failing the read.
- **"Is the human mid-turn?" is a SECOND pass, not part of liveness — and an
  MCP list that skips it silently lies to the LLM.** `withLive*` only stamps
  `live` (a tmux session exists). `busy` / `busyKnown` / `open` are stamped by
  the separate `withAgentBusy` / `withAgentBusyProjects` (the opencode server's
  `/session/status`, which needs `?directory=`, cached per (PAD, folder)), so
  every list/detail path must chain both — exactly like `/api/mission/*` at
  `app.js:2488/2526/2584`. `withAgentBusy(sessions, agentOf, folderOf)` resolves
  the PAD and folder through the *row's project*, so a row with no project
  (rare) simply gets no stamp. `busyKnown: false` means UNKNOWN, never idle,
  and an MCP projection must emit the field only when the store stamped it
  rather than defaulting it to `false`.
- **An MCP handler that stops at the first enrichment pass is a parity bug, not
  a shortcut.** When a parallel agent adds a second decoration to the Mission
  service, every MCP list/detail path has to pick it up: check
  `app.js`'s route for the `withLive*` chain and mirror it. `mission_projects`
  with only `withLive` returns no `openCount`/`busy`; `mission_sessions` with
  only `withLiveSessions*` returns no `busy`. The LLM then cannot tell "the
  human is typing right now" from "here but idle" and talks over a live
  conversation — the one failure the Mission page exists to prevent.
- **Never resolve an agent's TYPE yourself — `getDriver` FALLS BACK TO
  OPENCLAW**, so a lookup that yields `undefined` (a mistyped name, a row that
  moved, a `|| {}` default) silently becomes an *openclaw* answer instead of a
  not-found. `mission_project_create` did exactly this: it read
  `SELECT agent_type FROM agents WHERE name = ?` itself, so a typo produced
  `mission_unsupported_agent: openclaw does not support Mission workspaces` for
  a PAD that never existed. Let `mission.agentRow` (via `projectFolders`,
  `createProject`, `startSession`) do the resolution — it throws
  `mission_agent_not_found` with a 404. And note the **grant gate runs first**:
  `requireTool` fails closed on an unknown agent, so a handler must never rely
  on the store to report a bad name.
- **A pad's `SUBNET` reservation and its live `_default` network are two
  different claims, and only a pad with a service on the project `default`
  network should hold either.** A peer-networked pad's service is
  `network_mode: container:<peer>` and its door rides the peer's own network, so
  it joins nothing — reserving a `/24` for it just parks a claim that collides
  the day the user switches that pad **to** default (`Pool overlaps with other
  one on this address space`, apply exits 1 and rolls back).
  `writeInstanceCompose` now gates on the *generated* services
  (`usesProjectDefaultNetwork`), not on `NETWORK` being unset, so a pad with no
  ports and no door behaves too. Two traps in the same area: (1) a **live
  network wins** — when `<name>_default` already exists (including a legacy
  compose-pool `172.x`/`192.168.x` one) `ensurePadSubnet` returns empty and the
  compose stays subnet-less, so a regen can never force a network recreate, and
  `releasePadSubnet` must NOT drop a reservation a live network still holds;
  (2) counting only `docker network ls` under-commits the pool — a reservation
  with no network behind it is still a claim, so `claimedPadSubnetOctets` unions
  live networks with every other pad's meta `SUBNET` (skip hidden/quarantine
  dirs). Verify with `docker exec paddock sh -c 'cd /app && node -e "..."'`
  against the exported helpers — `pickFreePadSubnet('<pad>')` is a read-only
  way to see what a pad WOULD get, and a stale `SUBNET` in a pad's meta simply
  means that pad has not been rewritten since: its next apply/recreate resolves
  it. Never hand-edit meta to "free" an octet, and never force-remove a live
  network to release one.
- **The stale-door sweep will fight you forever if anything still writes
  `instances/<pad>-door/`.** `cleanStaleDoorDirs` quarantines legacy
  `<pad>-door` dirs into `instances/.stale-door-dirs/<name>`, but the 30s log
  sweep called `logStore.capture()` for **every** container whose name passed
  `safeVmName` — including the live socat door, whose nobody-reads-it log file
  `mkdir`s `instances/<pad>-door/logs/`. The dir reappeared after every restart
  and looked exactly like "the sweep isn't working"; the fix is excluding
  `isManagedDoorContainer` names from that sweep. When a cleanup pass keeps
  losing ground, look for a *writer* rather than tightening the matcher. Related:
  the sweep's veto must come from the **disk-derived** registry
  (`registry.discoverAgents()`), not the SQLite `agents` table — a deleted
  pad's stale row makes its own leftover dir untouchable. It moves the dir, it
  never `docker rm`s the live door container, and it skips a candidate whose
  `<pad>` is a real agent.
- **Per-PAD image builds orphan disk.** Every create/rebuild retags
  `paddock-vm-<name>:latest` and orphans the old build as a dangling image;
  delete removes the tag and `pruneDanglingImages` (`docker image prune -f`,
  dangling only) runs after create/rebuild/delete to reclaim it. A dangling
  image that survives the prune is in use by a container (possibly another
  project) — don't force-remove it.
- **Deleting an agent deletes its custom workspace source too** (plan 24): when
  `meta.WORKSPACE_HOST` lives under the project root but OUTSIDE the agent's
  data dir, `removeVm` `rmSync`s the whole workspace dir. Never point a real
  agent at a shared workspace dir you care about unless that's intended; for
  throwaway tests use a dedicated dir. Project-image test workspaces
  (`wstest-*`) get wiped this way.
- **BuildCommands box cannot open `FROM … AS <name>` stages** (plan 41): the
  block is injected mid-file into the agent's main stage, so a `FROM` there
  starts a new stage whose `COPY --from=<same>` is a BuildKit circular
  dependency, and a trailing stage would become the final tagged image. To pull
  the project toolchain use `COPY --from=paddock-proj-<name>:latest <src> <dst>`
  or `RUN --mount=type=bind,from=paddock-proj-<name>:latest,source=…,target=…`.
- **Restart the webui after editing backend code** (`app.js`, `vm-manager.js`,
  any `services/drivers/*.js`) — Node caches `require()`; a stale process
  keeps old behavior or builds the wrong image via the openclaw-driver
  fallback. `docker restart paddock`.
- **`src/` is BIND-MOUNTED into the paddock container, so a control run that
  edits the container's copy edits YOUR WORKTREE.** Proving a guard works means
  disabling it and watching a test go red — I did that with
  `docker exec … node -e "s.replace('if (a && b) {', 'if (false) {')"` against
  `/app/mcp.js`, and the replacement landed on the host file, silently turning
  the real guard off. The tell is that a `docker cp` "restore" afterwards does
  not help: you are copying the corrupted file back onto itself. Disable a guard
  in a **throwaway copy** (`/tmp/...`), never in `/app`. Same reason `docker cp`
  is not how you get an edit into a running webui — the bind mount already did it.
- **A mutation control that ran in the WRONG DIRECTORY still prints a convincing
  number, because the control reads as "the test went red".** Copying the tree to
  `/tmp` with `2>/dev/null` and then `cd`-ing into it hides the only thing that
  matters: if the copy failed, the `sed`s and the test run against the REAL file
  in `/app`, the counts are genuine, and the guard is silently left disabled in
  the worktree. An `sh -c` chain does not stop on a failed `cd` unless you
  `set -e`, so the whole block runs in the default working directory and nothing
  reports the mistake. Two checks caught it here: the diff afterwards showed the
  change I had made *plus* a mutation I had meant to revert, and the insertion
  count was **one higher than the change** — a `sed`-deleted line leaves a
  blank-line hole, which is the tell. So: confirm a mutation landed where it was
  supposed to (`grep` the mutated line in the COPY, not the original), and read
  the post-control diff before committing — a control is only evidence once you
  know it was measured where you think.
- **A green run in the WORKTREE says nothing about what you are committing —
  materialize the index and test THAT.** The worktree carries other people's
  in-flight work, so a suite can be green on code that was never staged while the
  staged snapshot is broken in a way only its own test run reveals (here: three
  `vm-manager` pieces the commit needs — `workspaceMountInfo`, the redaction
  block, `readAgentConfig` — were missing from the index, and two tests failed
  against the staged tree while passing in the worktree). The recipe:
  `git checkout-index -a --prefix=/tmp/staged/`, copy it into the container,
  `ln -s /app/node_modules` (the copy has none, and `better-sqlite3` is the first
  casualty — a missing module reads as a test failure, not a setup failure),
  then run each file with `-w /tmp/staged/src`. Note `docker exec … node -e` with
  `-w /app` on the HOST-mounted tree, and remember the container's app root is
  `/app`, not `/app/src`.
- **Partially staging one function out of a file means staging its whole BLOCK.**
  `redactSecrets` called `isSecretKey` and `redactConfigText`, which were defined
  a few lines above it in the worktree and did not exist in HEAD at all: splicing
  the function alone produced a file that parses, passes `node --check`, and
  throws `ReferenceError` at call time. Two traps in the splice itself: offsets
  computed against HEAD go stale as soon as the first edit lands (apply the
  edits back-to-front, or collect all ranges first), and `lastIndexOf('/**')` to
  pick up a doc comment reaches back past *other functions* and deletes their
  bodies. `node --check` is not a sufficient control here — only the suite is.
- **Dev container sync/regenerate write into the workspace THROUGH the webui
  container** (plan 41): it works only for workspaces the paddock container
  mounts read-write (project root /www2/paddock). Workspaces mounted
  read-only into paddock (e.g. `/www1` → craftpip) fail with
  `EROFS: read-only file system` — the card shows the diff, but Sync/
  Regenerate error out; only the auto-sync inside a settings apply would too.
  That's by design (the webui can't clobber external workspaces), not a bug.
- **JSX/CSS edits need `cd src/client && npm run build` + `docker restart
  paddock`** — the SPA serves the built bundle from `src/public/`.
- **A hand-written SVG `d` with a run-together arc flag silently kills the whole
  icon, and the browser console is the only cheap oracle.** An arc is
  `rx ry rot large-arc sweep dx dy`, and the rot + both flags are single
  characters that must be comma/space delimited — `a2 2 002 2` makes Chrome
  abort the path with `Expected arc flag ('0' or '1')` and the rest of the icon
  simply does not draw. 24 such paths had accumulated in this app and were
  logging on every page. **Do not hand-parse `d` strings to find them** — two
  regex validators written for this were both wrong in different ways (one
  tokenized `0118` as one number and would have *dropped* arc parameters; the
  other flagged `z` as an unknown command). Instead mount every `d` from the
  source into one throwaway page in `src/public/` and read the console: Chrome
  names the exact malformed path. Two traps that cost a build each: a **zero
  radius** (`a2 0 …` where every sibling corner is `a2 2`) is invalid and
  reports a misleading "Expected arc flag", and an arc with only 6 parameters
  cannot be repaired by any rule — it needs a human. Verify the repair by
  `getTotalLength()` + `getBBox()` per icon, since a path can parse cleanly and
  still be the wrong shape. Note `npm run build` **wipes `src/public/`**, so
  regenerate the scratch page after every build.
- **A token that no SOURCE FILE uses never gets a class — so a token consumed by
  hand-written CSS has to be read as a VARIABLE, not a utility.** Tailwind only
  emits `.shadow-tooltip` if some `.jsx` writes it; the tooltip's shadow lived
  in a hand-written `index.css` rule that spelled the value out inline, so
  `--shadow-tooltip` was defined, documented, and used by nobody. Fix is
  `box-shadow: var(--shadow-tooltip)` in the CSS rule. After any token change,
  grep the BUILT css for **every** token you touched, and remember the built
  bundle's name changes on every build (`src/public/assets/index-*.css` — use
  `ls -t`, never a hardcoded hash).

- **`tailwind-merge` resolves a conflict in favour of the LAST class, so
  `className` must be the last argument of every primitive's `cx()`.** In
  `Input.jsx` the base took `className` and the component then appended
  `'py-2 resize-y'` / `'pr-8'` AFTER it — so `resize-none` on a `Textarea` was
  silently a no-op and an `AgentDetail` editor had to fall back to an inline
  `style={{resize:'none'}}`. `base()` must NOT accept `className`; each
  component ends its own `cx(base(...), ownStructure, className)`. When a
  primitive's own class needs to lose, that is a missing prop
  (`Card plain`), never a class the caller can pass.

- **`tailwind-merge` does NOT put `shadow-card` and `shadow-none` in the same
  group**, so both rules emit and the result is a stylesheet-order coin flip.
  Same trap for any "remove a primitive's default" attempt: use the `plain`
  prop.

- **Reading the DOM in the same `Runtime.evaluate` as a React `el.click()` is a
  FALSE NEGATIVE** — React batches the re-render, so the assertion runs against
  the pre-click tree and reports the feature as broken. Click in one evaluate,
  assert in a second. (Cost a false "the `msn-selected` hook is missing"
  diagnosis on `ProjectDialog`.)

- **A dense listing needs its own control scale — do not force the form scale
  onto it.** `Button`'s `ctl-sm`/`ctl-md` min-heights make sense on a form but
  would make every Mission project row taller than its content, and `icon`
  pins an inline width that overrides a caller's `h-8 w-8`. Hence `size="bare"`
  (no height, no font size) plus `variant="link" | "dangerLink" | "dangerSoft" |
  "none"`. `none` matters twice over: an unknown variant string silently falls
  back to `secondary` and adds a border nobody asked for.

- **A colour utility whose token is not in `@theme` is dropped SILENTLY — no
  build error, no class in the CSS, and it fails only in dark mode.** Tailwind
  v4 generates utilities from the `--color-*` names in `index.css` `@theme
  inline`; anything else (`bg-ok`, `text-warn`, `text-error`, `text-amber`,
  `hover:bg-danger-hover` — none of which exist) simply produces no rule, so the
  element falls back to the inherited colour and the border/fill silently
  vanishes. The palette (`styles/palette.css`) names statuses
  **success / warning / danger / info / brand** — never ok/warn/error — and there
  is no `-hover` shade for the status fills, only for the surfaces
  (raised/raised-hover) and the accent. A solid fill also needs its matching
  `-ink` text token, NOT `text-ink`: `bg-accent text-ink` is dark brown in
  light mode but **cream in dark mode**, which is how the whole Mission page
  ended up with light text on orange. Rule: `bg-<x>` → `text-<x>-ink`,
  `bg-<x>-soft` → `text-<x>`. Verify by grepping the BUILT css
  (`src/public/assets/index-*.css`) for the class, and by reading
  `getComputedStyle` in the browser in BOTH modes — not by reading the JSX.
- **`api(path, { body })` wants a plain object, not `JSON.stringify`ed** —
  `src/client/src/lib/api.js` does the `JSON.stringify` itself, so passing a
  pre-stringified body sends a quoted string and the backend sees the wrong
  shape. Same for `Content-Type` (it sets JSON only when `body` is present).
  Errors come back as a **thrown plain object**, not an `Error`: `{ status, error,
  code? }` — so `err?.message` is usually undefined and `errText` must read
  `error`. The client agent list exposes the effective workspace as
  `workspace_dir` (custom mount when set, else the driver default); there is no
  `mission` block on the row, so filter coding agents on `agent_type` and read
  `workspace_dir` (see `pages/agent/SettingsTab.jsx` for the same value).
- **Docker Compose CLI lives inside the paddock container** — the host docker
  CLI has no compose plugin. Invoke `docker compose` from the container.
- **Instance compose uses absolute host paths** (`HOST_WORKSPACE_ROOT` from
  `.env`) — fixes the bind-mount split-brain; relative paths make the daemon
  mount host-root `/workspace/...` dirs.
- **Peer-mode agents publish via the `<name>-door` socat container**, never on
  their own container. Peer-shared agents need **unique container ports**
  (8080/8081/…); `hostPortInUse` does NOT exclude the agent's own door (use a
  fresh host port). Deleting an agent removes its door + network automatically.
- **`GUARD_*` workspace-mount guards** (vm-manager.js) are on by default. To
  let one agent mount the whole project root as workspace, disable
  `GUARD_PROJECT_ROOT`, `GUARD_INSTANCES_PARENT`, `GUARD_AGENT_DATA` in `.env`
  (that agent then has read/write over the whole project incl. `.env`).
- **Job logs are in-memory** — `docker restart paddock` kills running
  update/create jobs and their SSE streams.
- **Test PADs:** `test-agents` for general testing.
- **`src/data/app.db*` stays `1000:1000`-owned via the boot sweep, not luck.**
  The webui now runs as root, so a fresh `app.db`/`-wal`/`-shm` created by it
  is root-owned until `ownership.ensureDbOwned()` re-chowns it after open (and
  the boot `ensureDataOwned()` covers the whole `src/data/`). If DB writes ever
  fail with `attempt to write a readonly database`, fix with
  `chown 1000:1000 src/data/app.db*`. Never run `docker exec paddock node …`
  (runs as root) against code paths that open the DB, or it may recreate
  root-owned DB files.

## Workflow Commands

- Restart webui (no rebuild): `docker restart paddock`
- Rebuild + recreate webui after an image change:
  `docker compose build webui && docker compose up -d --no-deps --force-recreate webui`
- Vite dev server (HMR, port 5173) for frontend work:
  `docker exec -d paddock sh -c 'cd /app/client && npm run dev'` → access
  http://10.69.1.164:5173; stop:
  `docker exec paddock sh -c "kill \$(lsof -ti:5173)"`
- SPA build: `cd src/client && npm run build` (output → `src/public/`)
- Webui recreate gotcha: the host docker CLI has no compose plugin — recreate
  with host-absolute paths (see `docs/operations/overview.md`).

## Environment Facts

- This host: we are **root** (no sudo, no python3). Use the `edit` tool or
  `node -e` for root-owned files — the edit tool works as root.
- Webui reachability: http://10.69.1.164:6789 (localhost:6789 is refused from
  this shell's network context). Vite dev on http://10.69.1.164:5173.
- Auto-login defaults on (`AUTO_LOGIN=true`). API curl tests need a session
  first — auto-login boots on `GET /api/session` (fetch into a cookie jar).

## Driver Framework

- `src/services/drivers/` — one module per agent type, registered in
  `index.js`. `getDriver(type)` is the single source of truth (image, version,
  `configFile`, `dataDir`, `workspaceDir`, commands); **falls back to the
  openclaw driver** (never crashes).
- Config formats: openclaw/picoclaw/opencode `json`, hermes `yaml`, codex
  `toml`. Non-`json` formats are served/written verbatim, no secret redaction.

## Infinite loop (`infinite.md`)

The user keeps a **forever task queue** at the repo root: `infinite.md`, a
plain checklist of **plan paths**. They append lines; the agent works them, in
order, and ticks them off. It is a convention, not a feature — nothing in `src/`
reads it. **Infinite means infinite**: once started on the queue
("check infinite" / "keep going" / "drain" or any work-the-queue instruction),
keep working plan after plan without stopping until the queue is empty.
Never stop after one task to ask what is next. Never build a daemon around it
unless the user explicitly asks for unattended runs.

```
## Queue                     ## Done
- [ ] plans/58-x.md          - [x] plans/57-y.md — absorbed 2026-09-27
```

The loop, in order:

1. **Read `infinite.md` first**, before picking anything up, even when the user's
   message names no plan. Work the **first `- [ ]` line** — order IS priority.
   **Then read `## Needs your call` and surface any entries in your report.** They
   are deliberately not `- [ ]` lines so this loop cannot act on them: they are
   decisions the agent has no standing to make (closing a live session, deleting a
   pad with an audit trail, rotating a credential). Mentioning them is the job;
   guessing is how a user's conversation gets killed unattended.
2. **Claim before working**: rewrite the line to `- [~] plans/<file> — started
   <date>` as your FIRST act. A crash or a truncated turn then leaves an honest
   trace instead of silently re-picking the same item forever.
3. **A path whose file is gone is DONE, not an error** — the plan was absorbed
   into `docs/` and deleted per the plan workflow. Move the line to `## Done`
   with today's date and continue to the next one. Never report a missing plan
   as a blocker.
4. **Do the plan**, following the normal plan workflow above: build it, verify it
   live in the browser, keep its `## Status:` header and checklist current.
5. **Test it, commit it, then tick it** — run the relevant tests individually
   (never the combined `node --test test/` suite), verify live in the browser,
   then `git add` only intended files + `git commit`. **Tick `[x]` only on real
   completion** — the plan's own `## Status:` reads `Complete`, the work is
   tested + committed + verified, and the plan has been absorbed into `docs/`
   and its file removed. Then move the line into `## Done` as
   `- [x] <path> — absorbed <date>`.
6. **Blocked is not done**: leave the line `- [ ]` and append the blocker to it
   (`— blocked: <what is needed>`), commit what is done, then move to the next
   item immediately — never stop the run for a blocker. A partial plan that is
   nearly done stays `[ ]` and gets finished next time — never tick a plan that
   still has open items.
7. **Never stop after one — move to the next**: after test + commit + tick,
   immediately start the next `- [ ]` line in the same run. Repeat until the
   queue is empty. Report progress between items but do not wait for user input.
   "One plan per turn" is abolished — **infinite means keep going**.
8. **An empty queue means STOP.** Report "queue empty" and do nothing else.
   **Never invent a plan, feature, or todo to fill an empty queue** — that is
   the single failure mode that turns this into an unattended agent building
   things nobody asked for.
9. Keep the `## Queue` and `## Done` sections tidy as you go: exactly one
   `[~]` line exists at a time, finished lines leave the queue, and the file
   stays short enough to read at a glance.

## Documentation (docs/)

- `docs/` is the **source of truth** for business logic, architecture, routes,
  data model, security. AGENTS.md holds only behavioral/ops rules.
- Read order: `docs/README.md` (index), then the relevant page. Read
  `docs/STYLE-GUIDE.md` before writing/editing any doc.
- Main pages: `overview/architecture` · `overview/business-logic` ·
  `backend/services` · `tabs/{terminal,web,settings,health,mcp,skills}` ·
  `operations/{overview,openclaw}`.
- Rule: if code and docs disagree, fix the code.

## User Preferences

- **How the user gives tasks — queue everything.** The user brain-dumps tasks
  ("I will just bombard you with whatever I say") and **can't hold a list in
  their head** — they'll drop a new task mid-task, then come back with hints
  or steering. Whenever the user gives a new task while one is already going
  on, **add it to the todo list immediately** (verbatim intent, not the full
  wording) and finish it later — do not treat it as a context switch. Keep the
  todo list updated one by one as items complete. The user may repeat or
  clarify an item later — that's a steer, not a new task.
- Plans go in `plans/` as separate `.md` files.
- **Plan workflow (always):** the user says "create a plan" → a new `.md` plan
  file goes in `plans/`. Then we start working on it. Then, only after the plan
  is **complete** (all work built + verified), we **absorb it into `docs/`**
  and **remove the plan file**. A plan never just vanishes — absorb into docs
  first, then delete.
- **Every plan file carries a standardized `## Status:` header** — placed
  directly under the `#` title. States are exactly one of:
  `Complete` / `In progress` / `Proposed` (not started) / `Blocked` (incl.
  dropped) / `Draft` (raw requirements only). The header is dated and states
  **exactly how much is complete** (e.g. "11/12 items done, remaining: …",
  "Phases 1–3 done, Phase 4 deferred", "0/4 phases, design complete"). No plan
  file exists without one. Keep a `[x]` progress checklist in the file body
  for granular tracking.
- **Always update the plan file before leaving its work.** Whenever a plan is
  worked on — a feature built, a phase finished, a finding made, or the session
  ends — update its `## Status:` header and progress checklist to match exactly
  what was done. Never leave a plan file stale.
- **When the user says "show me my plans" (or similar)**: summarize with a
  status column per file (from each file's `## Status:` header) and what's
  complete vs. not — don't just dump filenames.
- **"chat test" mode — test from the MCP, as a real LLM.** When the user says
  **chat test**, act as a generic LLM consuming *this project's* MCP surface
  over `/mcp` — i.e. use the paddock MCP tools from my own opencode config, and
  drive the request purely through those tool calls, the same way any agent
  would. Do **not** drop to bash/curl/node/backend tricks to get around the
  tools; work with exactly what the MCP returns. Purpose: experience
  first-hand how an LLM reacts to the request and the tool responses — what's
  obvious, what's jargon-y, what's missing/terse/over-verbose — so we can make
  the software easy for any LLM to understand. Report friction (e.g. "the
  response never said X, I had to guess Y") rather than silently working
  around it.
- **Chat-test friction goes in `friction/`.** When the user says to note
  friction down (or it should be noted by default at the end of a chat-test
  run), write `friction/YYYY-MM-DD-<slug>.md` — one file per session, one H3
  per finding, shape + severities per `friction/README.md`. Never put friction
  findings in `docs/` (that folder is the reference for how things *do* work);
  a fixed finding stays in the log with a **Resolution** line instead of being
  deleted.
