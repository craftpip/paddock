# Lessons: UI, MCP surface and testing

Each entry is a lesson recorded when a real defect was found in this project. `AGENTS.md` keeps
the one-line rule and links here by id; this page keeps the full account: what happened, why
the obvious check missed it, and how the fix was proven.

The text is the original record and is written in the first person by the agent that hit the
problem. File paths in older entries may predate the split of `mission.js`, `vm-manager.js`,
`app.js` and `mcp.js` into directories (see the layout tables in
[services](../backend/services.md) and [architecture](../overview/architecture.md)).

## S01

**Every element on the Mission page carries a stable `msn-*` class** (page
shell, all three columns, rows, buttons, badges, confirms, the project
dialog). They are pure hooks — no styles — so when the user points at
something ("the del button in the project row", "the text under Running")
look the selector up in [Mission Page → Element Hooks](../pages/mission.md#element-hooks) and edit exactly
that element instead of re-guessing the layout.

## S02

**A JSX handler that references an identifier from another component's scope
builds fine, passes every test, and throws only when clicked.** Moving state
from a child to its parent (e.g. a two-step confirm) leaves the child's handler
referring to `confirmClose`/`id` that no longer exist there — the × button on
every Mission session row was dead for a full build+test cycle this way, and
only `btn.click()` in the browser surfaced it (`confirmClose is not defined`).
Free variables in JSX are not compile errors. After ANY refactor that moves
state across a component boundary, click every affected control in the page.

## S03

**A MISSING IMPORT is a runtime error, not a build error — so `npm run build`
passing says nothing about whether the page RENDERS.** `Mission.jsx` called
`useConfirm()` with no import for it. Green build, green tests, and `/mission`
was a blank page: an unbound identifier in JSX is a `ReferenceError` when the
handler runs, exactly like the cross-component free variable above. Vite/esbuild
will not catch it, so **after adding a hook/provider/modal to a file, load the
page** — do not infer "it works" from the build.

## S04

**A suite of source-text REGEXES cannot see that a file stopped parsing — and
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

## S05

**An unreadable answer and a negative answer are different ANSWERS, and the
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

## S06

**A field an agent never hands you is not a field you can look up later —
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

## S07

**A live-work probe can be answering about a DIFFERENT PROCESS than the one you
are describing, and a shared database is not shared liveness — so probe the
STORE, not the server (resolved by plan 52 R8).** `busy` used to read
`GET /session/status` from the PAD's published `opencode web` (pid 16, :7890) —
but a Mission session's TUI is a *separate* `opencode` process (pid 6458) that
holds **no sockets** and never publishes its turn there. Measured: 42
consecutive seconds of `esc interrupt` on the pane with our id absent from the
map, while the user's own web-UI session was reported busy throughout. The two
processes **do** share the sqlite store (a `GET /session/{id}` returns our
conversation in full), which is exactly what made the bug survive review: every
read of the same *id* succeeds, so the id looks like it is wired up. The fix is
to read **each conversation's own store** (`busyForSessions`, newest tool part
`state.status: "running"`) — the store is the shared truth, so it answers for
whichever client drives the conversation. Two lessons survive the fix: **prove
a liveness probe by watching it go TRUE for the specific thing you are
measuring**, not by confirming the endpoint answers and the id resolves, and
when a fix makes a probe "work" without ever producing a `true`, suspect a
second root cause rather than declaring victory — the id fix made the lookup
succeed and find nothing, which reads identically to a fix.

## S08

**`USER_MODE=user` puts the pad's tmux in `/tmp/tmux-1000`, so a plain root
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

## S09

**Mission col 3 is pinned to `openSession` in the store, NOT to the row and NOT
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

## S10

**A column that is refetched must not be what the next column renders from.**
Col 3 used to derive its session from the listing, and `setScope` empties that
listing on purpose before refetching — so for ~200ms col 3 was `null`,
`<Terminal>` unmounted, the WS closed, and the list landing remounted it (fresh
xterm, fresh `tmux attach`, redraw) for a conversation nobody asked to change.
Any value derived from a list is only as stable as that list's emptiest moment.

## S11

**`startSession` must re-read pane state after setting `openSession`** (it
calls `get().fetchSessionState(id)`), because the snapshot is taken when the
TUI has been *asked* to launch and has not yet appeared — a snapshot-only fix
renders a brand-new session as closed. *A snapshot taken at open time is
correct for a session that was already running and wrong for one still
starting.*

## S12

**tmux `show-options -g` will NOT list `escape-time`** — it printed
`history-limit` and `status` and silently omitted the one option under test, so
a "did it take?" check that greps `-g` output silently passes on a PAD where
nothing was applied. Always read an individual option back with
`tmux show-options -gv <name>`. (`pad-tmux.applyGlobalOptions` now sets
`escape-time 10` as a PAD global, which is why ESC registers immediately
instead of waiting on tmux's 500ms ambiguity window.)

## S13

**"Hidden" has three different meanings in CSS and only one of them is free.**
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

## S14

**A name the surface HANDS OUT must be a name the surface ACCEPTS, and
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

## S15

**A "here is where it ran" probe must carry the SAME environment change as the
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

## S16

**"This list is capped at 10" and "your item is not in it" look identical to the
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

## S17

**A resolver that returns the canonical name is only half a fix — the name has to
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

## S18

**A list tool that can be FILTERED must never fall back to the unfiltered list,
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

## S19

**A count that sits next to a data array will be READ as the thing it measures.**
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

## S20

**A field the SERVER computes must not be re-derived on the client, and a
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

## S21

**Assert a clock CHANGED, and give the test a gap bigger than its resolution.**
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

## S22

**A first observation of a death is NOT the time of the death, and the honest
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

## S23

**The retry is where a client-side timeout is fixed, and an in-process pre-check
is not enough.** A timed-out `mission_session_start` has no response, so the
server cannot help; the recovery has to live in the caller's RETRY, which means
a caller-supplied `idempotency_key`. Returning the existing row on a duplicate
key closes the *sequential* race and quietly loses the *concurrent* one, so the
key also needs a **partial unique index** — and a deduped insert must return
before it touches tmux, or the retry still spawns a second live session. The
general shape: when a guard is "did I already do this", ask whether two
processes can pass the check at once, and if so put the constraint in the
database rather than the handler.

## S24

**A source-text assertion is a pin on a name, not on a fact — refactor the
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

## S25

**A free variable in plain JS is as invisible as one in JSX: `node --check`
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

## S26

**An audit log that records only WHAT cannot answer WHO, and a FK will tell
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

## S27

**An audit trail is not a second copy of the data — record the SHAPE of a
write, never its content.** A `send` is the human's own conversation and can
carry a pasted API key; logging the text would make the audit log the least
protected copy of the secret on the box. `send` records line count and
character length, which is enough to answer "did one land, how big" without
storing what it said. Pinned negatively: the row must not contain the secret.
Two adjacent rules that came with it: a **refused** action writes nothing (a
log that credits a rejected write is evidence against itself), and a failing
audit write must not fail the action that already happened — tested by
dropping the table mid-call, since the action is done and cannot be undone.

## S28

**A store test that mutates a module-level singleton must put it back, or the
next test inherits a bound copy.** The idempotency-race test replaces
`db.prepare` to force a UNIQUE violation; restoring it as a *bound* function
leaves the module permanently closed over its own receiver. It passes either way
(and so did every later suite), which is exactly why it is worth writing the
restore carefully rather than trusting the green run.

## S29

**An ORDERING assert on `indexOf` is unfalsifiable without an explicit
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

## S30

**A permission DEFAULT is set in the CALLER, so fixing the callee fixes
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

## S31

**A stale row survives a write that just happened in the same function.**
`screen()` read its session, then updated the row, then returned the row it had
read — so the response reported `last_output_at: null` for the very call that
had set it. Nothing crashes and nothing looks wrong: the next read is correct,
which is why it would have shipped. The rule is that a function which mutates
a row it also returns must stamp the return value from the write's own result
(or re-read), and "did the clock move?" is a far easier test to write against a
response than a diff of the implementation.

## S32

**A parameter that names two different things is a trap that no type system
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

## S33

**A status filter, a `total` and a cap only answer a question about ONE set —
and a filter that runs after a cap is not a filter.** `task_list` counted
`total`/`truncated` from an **unscoped** query and compared it to the length of
the rows *this key may see*, so the two numbers described different sets: a
short list read as "that is everything", and a key that could not see four rows
was told the answer was truncated. Count after the access filter, before the
slice, and if the fetch itself is capped say so (`fetch_capped`) rather than
letting `total` become a silent maybe. This is the same shape as the
`availableNetworks` cap in `settings_get`.

## S34

**A lookup that was never RUN is indistinguishable from a fact it would have
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

## S35

**The right answer to "the surface contradicts itself" is usually that TWO
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

## S36

**Verify a refactor that changes a SOURCE-TEXT assertion: the assertion is a
pin on where the fact LIVES, so moving the fact turns the test red for a
reason that is not a bug.** After extracting the rule, three tests failed on
wording and location, not behaviour: a `reason` that said `Start it` where the
test read `/start it/`, and an assertion that the health hint says `IS running`
when the sentence had moved into `net-peer.js`. The fix is to re-point the
assertion at the fact's new home and say why in a comment — **never** to relax
it into something that passes. Re-run the mutation control afterwards: the
guard is only proven by the tests going red when the code is removed, and a
control that no longer bites proves nothing about the restored code either.

## S37

**A summary field derived from two facts is a SECOND answer to a question the
row already answers, and it will contradict it.** `task_submit` returned
`mode: pad ? 'push' : 'pool'` at the top while the row inside the same response
carried the correct derived `route` — so an addressed `enqueue: true` submit
said `push` in one field and `enqueued` in the other. Read the summary off the
row's own derived value, never recompute it from the arguments.

## S38

**Copying a column into a re-file produces a row that LIES, and the label is
the only evidence.** `retryTask` copied the original's `enqueue` flag, so a
retried *push* kept `enqueue = 0` with no child process attached — and
`task_route`, deriving `push` from that same flag, reported a PAD was running
work nothing was running. A retry is a **re-file, not a run**: the replacement is
always claimable. The general form: when a derived field is computed from
stored facts, every way of writing a row must leave facts that make the derived
answer TRUE — never write a fact for its side effect on a label.

## S39

**`claimed_by` does not need a `claimedBy`, and a test must say so.** Adding a
second spelling of one field is how a queue ends up with two sources of truth
for who is working on what. Store facts, derive the agent-facing vocabulary
(`route` / `outcome` / `timedOut`), and pin the negative in the schema test
(`assert.ok(!cols.includes('claimedBy'))`) or the next person will add it as a
"harmless convenience".

## S40

**A "browse the workspace" permission needs a CAPABILITY answer too, and
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

## S41

**A per-instance data dir is MOUNTED at a path the agent calls its home — so a
store path written from the agent's own docs is wrong by one segment.** codex
rollouts live at `\$HOME/.codex/sessions` because compose mounts
`<instance>/codex` there, so on the host they are
`<workspace_root>/codex/sessions`, not `<workspace_root>/sessions`. Reading
the shorter path returned `no-store` on every codex pad ever created, and the
opencode reader (correct for its own layout) made it look like a
driver-specific quirk rather than a mount mapping. **Verify a store path
against a real file before building a reader for it.**

## S42

**The newest message of a role is often not the answer, and the store's index
is not on the column you sort by.** Two measured facts, both of which produced
a confidently wrong `plan_activity`: `opencode`'s `part` table is indexed on
`session_id` ALONE, so `order by time_created` sorts the whole table
(10–21 ms, growing), and each assistant **step** is its own message — a bounded
window over messages returned 12 assistant steps and no user message at all on
a session that plainly had one. So: put the role in the **query**, take the
newest message of that role, and walk a bounded window of OLDER messages of the
same role for the user text. "Last message" is a windowed search, not `LIMIT 1`.

## S43

**A stopped pad still has its store, so "the container is down" must not
become "there is no activity".** The stores are in the agent data dir on the
HOST, so the read never touches docker. `padRunning` (container state) and
`store.available` (could we read it) are different questions, and a read
failure is reported rather than smoothed into an empty answer. Also: a store
file that exists with NO SCHEMA is a pad that has never run its agent — that
is `empty-store`, not `unreadable`, and a 0-byte file is not a corrupt
answer. **Prove the stopped case with a row whose `status` is `stopped`, and
re-read the SAME transcript**: a control that only asserts "no crash" passes
just as well against a store that returns nothing.

## S44

**A per-driver facility has per-driver COSTS, so one claim about speed is a
lie for two of three drivers.** `plan_activity` on opencode is one indexed
sqlite query (~2 ms); on codex/claude it parses that one conversation's jsonl
file. "Indexed rows, never a scan" was true of the first and false of the
others, in the tool description, the guide, and here. State the cost where the
caller reads it, per driver, and say what it rules out (polling one live
session is fine; looping over every id is not).

## S45

**A plan belongs to a Mission project through its SESSION, not its folder.**
Plan files live in the PAD workspace `plans/`, which is not a project's folder,
so `plan_list {folder}` filters on `row.sessionProject.folder` — stamped from
the session's own project row — and **after** the state stamp, because a row is
only attributable once stamped. A plan whose conversation the page has never
seen cannot be attributed, so it comes back as `sessionUnattributed`: a
folder-scoped list that quietly dropped those would be short and look complete.
Same instinct as the `task_list` `total`: an unfiltered count next to a
filtered list is a second, wrong answer.

## S46

**A migration suite needs a control that asserts the MIGRATION ran, and the
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

## S47

**A guard asserted as a FINAL state cannot fail if the bug is a TRANSIENT one, so
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

## S48

**A test that passes because the fixture never got the code running is worse
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

## S49

**A mutation control must run in a COPY, and you must read the ORIGINAL back
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

## S50

**A test must be able to reach code written for a BUNDLER, or it will be
"unittestable" for a reason that has nothing to do with the code.** The Mission
store is ESM and imports `../lib/api` extensionless — Vite resolves that, Node
does not — so `node --test` died on the store's own import, not on the store. Fix
it at the RESOLVER (`test/helpers/client-store-resolve.mjs`, a `module.register`
hook filling in `.js`/`.jsx` for extensionless relative specifiers **inside the
client package only**, so it can never rewrite a bare specifier or a real
`node_modules` lookup). Do **not** edit the store's import to suit a test
harness — that is a bundler-shaped change to production source.

