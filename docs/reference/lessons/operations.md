# Lessons: operations and environment

Each entry is a lesson recorded when a real defect was found in this project. `AGENTS.md` keeps
the one-line rule and links here by id; this page keeps the full account: what happened, why
the obvious check missed it, and how the fix was proven.

The text is the original record and is written in the first person by the agent that hit the
problem. File paths in older entries may predate the split of `mission.js`, `vm-manager.js`,
`app.js` and `mcp.js` into directories (see the layout tables in
[services](../backend/services.md) and [architecture](../overview/architecture.md)).

## O01

**The subscription-exhaustion case is a once-per-day capture opportunity.**
The user reports no agent reply while OpenCode says the limit is over and
asks them to subscribe to Go. Follow `plans/75-provider-exhaustion-detection.md`
and preserve the actual notice plus session id before restarting, resuming,
retrying, or waiting for reset. Temporary 429 errors (even a response named
`FreeUsageLimitError`) are NOT proof of that subscription limit. Keep the
user's observed notice distinct from independently captured evidence; an
empty completed assistant message and idle status establish no successful
reply, not the cause. Save findings immediately so the next daily occurrence
does not require repeating the investigation.

## O02

**A terminal that drops "every few seconds" was the webui DYING, not a client
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

## O03

**The installed MCP SDK does NOT catch a throwing tool handler.**
`@modelcontextprotocol/sdk/.../server/index.js` `wrappedHandler` does
`result = await Promise.resolve(handler(request, extra))` with no try/catch, so
the rejection escapes as unhandled and **kills the webui**. Every
`requireTool` / `requireAgent` / `requireHostBrowsable` rejection is therefore
fatal unless the tool is registered through the `registerTool` wrapper in
`mcp.js` (which returns `{ isError: true, … }` instead). New tools MUST go
through that wrapper. `app.js` also installs `unhandledRejection` /
`uncaughtException` handlers that log and stay up — a control plane must not
die because one agent's tool call threw.

## O04

**The 15 `task_*` MCP tools (plan 69's steps + the `task_pipeline_*` driver
included) are GATED by `PADDOCK_TASK_QUEUE=1` in `.env`** — 39 registered
tools without it, 54 with it; `mcp.test.js` pins the 15-tool difference and
`mcp-tools-layout.test.js` pins the full list. The env var
is read at **boot**, so toggling it needs `docker restart paddock`. Two
consequences: a suite run in a container that has the flag set reports the
task tools as *not hidden* and fails its "hidden from the surface" test —
run `docker exec paddock env -u PADDOCK_TASK_QUEUE node --test
test/mcp.test.js` when you want the default surface; and with the flag off
the tools are simply absent from `tools/list`, which is a gate, not a bug.

## O05

**A mission session that lists ZERO MCP tools is an opencode state-dir
ownership problem — and the absence is STICKY to that conversation.** The
TUI runs as uid 1000, so `/root/.local/state/opencode` must be owned by
uid 1000; when it was `root:root 755` the session started with no tools at
all, and fixing the ownership does **not** repair that conversation —
relaunching the TUI keeps `NONE`, `opencode run -s <same id>` also answers
`NONE`, only a **fresh** session gets the tools. Miss it and plan 69's step
prompts land in a tool-less session, so the driver parks at `timeout` (read
as a pipeline bug). Diagnose with `ls -ld /root/.local/state/opencode`
inside the PAD, and confirm on a live session by asking it to list its tools.

## O06

**A user-mode pad's agent writes under its whole `HOME` (`/root`), so the fix
must give uid 1000 the whole home — and the MCP `exec` path must drop too
(plan 79).** The agent runs as uid 1000 with `HOME=/root`, but only
`/root/.<agent>` was chowned, so opencode's XDG state at
`/root/.local/state/opencode` was created against a root-owned parent and the
uid-1000 agent then failed `mkdir` of its locks
(`PermissionDenied: FileSystem.makeDirectory …/locks/<hash>.lock`), which
surfaces as a session that lists **ZERO MCP tools** (the sticky entry above).
Every `src/vm-builds/*/start.sh` now `chown -R 1000:1000 /root` **twice** (marker
`PAD HOME OWNERSHIP`) — an **early pass** right after `sshd` starts, *before* the
root-run `start-web`/`post-start` hooks, and again in the `USER_MODE=user` branch
after the hooks. The early pass is the fix for the hook window: `start.sh` runs
`/build/post-start.sh` (a user hook, run as root) on every boot, and a slow one
(e.g. `apt install` + `opencode upgrade`) left `/root` root-owned for minutes —
the late branch chown only ran *after* it, so a session started mid-hook hit
`PermissionDenied` again. Both passes are needed: the early one makes the home
writable immediately, the late one re-takes anything a root-run hook wrote. The
Dockerfiles do it in the image baseline, `ensureHomeOwnership` /
`imageHomeOwnershipBaked` backfill existing pads (`imageHomeOwnershipBaked` greps
the **distinctive early-pass marker** so a pad that only has the late chown
rebuilds once), and — the half that is easy to miss — the MCP `exec` tool now
splices `termUserArgs` (`mcp.js:execDockerArgs`), so a control-plane command no
longer plants root-owned files in the pad's HOME. **Plan 89 extends the same
drop to every other *managed* process**: `buildWebHook` runs the published
agent server through a `pad_run` wrapper behind a **runtime** gate
(`USER_MODE=user` and uid 0 — runtime, because the hook is re-executed by the
boot `start.sh` *and* by root `docker exec` re-execs, so a generation-time gate
would be right for one caller and wrong for another); `task-runner` and
`orchestrator.execInPad` splice the same `termUserArgs`. Because the hook lives
on disk, not in the image, an already-published PAD keeps its old root-launching
hook until something rewrites it — `ensureWebHookUserDrop` does that on the
publish path and the `migrateWebHooks` boot sweep does it on a webui restart
(preserving the web password, which only the hook holds for `env`-target
drivers). One measured exception: **`tee` stays root** — `/proc/1/fd/1` (pid 1's
stdout, which `docker logs`/the Logs tab read) is **not writable by uid 1000**,
so the hook chowns only the `web.pid`/`web.log` files it owns. **The root cause
is a root-run `opencode` CLI/TUI, NOT the boot `opencode web` server**:
re-measured after plan 89, a uid-1000 server booted and served a session POST
with an **empty** `locks/` dir, and `opencode --version` as root does not write
state either; only a root `opencode` session does (a pad's root-owned `.lock`
dirs date from a root run). So a user-mode pad is **still** vulnerable if the
user launches opencode as root (host `docker exec`/SSH) instead of through the
Paddock terminal/Mission — plan 89 drops every *managed* process, not a human's
root shell. **Never `rm -rf`/`chown` the running session's own
state dir "to reproduce"** — this agent IS a root `opencode` session inside the
pad, and deleting its `locks/` wedges every MCP call with that same
`FileSystem.makeDirectory` error until the dir is recreated by hand
(`docker exec -u 0 <pad> mkdir -p /root/.local/state/opencode/locks`).

## O07

**A redactor that reads like it normalizes, but doesn't, ships the secret it
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

## O08

**`opencode /session/status` no longer backs the Mission dot (retired by plan 52
R8) — but the endpoint's traps are still a live warning if you use it directly.**
Busy on `mission_*` now reads each conversation's OWN store (`busyForSessions`:
newest tool part `state.status: "running"`), so none of this applies to it. For
anyone debugging the endpoint itself: it answers `{}` unless you pass
`?directory=` (even mid-turn — measured, an 8.2s turn answered `{}` for 25
polls; scoped, `{"ses_…":{"type":"busy"}}`), it needs the PAD's own
`web.containerPort` (driver default 8080, live server here 7890), and it ONLY
reports conversations its own process drives — a Mission TUI is a separate
process with no sockets, so its turns never appear (42s of visible `esc
interrupt` with our id absent). The store read has none of those gaps, which is
why it replaced the probe. The map is a live-work registry, not a presence
list; an idle tab open in the web UI is NOT detectable by either mechanism.

## O09

**A "dead" row is not a dead conversation.** A mission session whose tmux pane
died while the user is chatting with that same conversation in the opencode web
UI is closed here but still working. The two questions are separated by
**`busy`**, not by a client-side pane flag: `busy` requires `live`, so a dead
row answers `busy: false, open: false` and carries **`wasBusy: true`** while
its conversation's store says the newest tool part is running — "still working
somewhere we hold no pane", the opposite of a licence to type. That forensics
comes from the shared sqlite (plan 52 R8(a)), which sees the web UI's turns and
our own TUIs alike, where the old web-server probe only ever saw its own
process. The client no longer computes a "gone" state at all (plan 58) — so if
you are tempted to add one back, remember it is what made the listing say "the
pane is no longer there" in a language the user never asked for.

## O10

**Mission sessions (`msn-*`) are multi-client; a second tab must not kick the
first.** Three places in the terminal WS in `app.js` implement that, and all
three must agree or you get the reconnect-fight loop back: (1) connect skips
the supersede close, (2) connect skips `sweepStaleAttaches` (its second call
site — the one in the try-block before `ensureTmuxSession`; the first is in
cleanup), (3) cleanup only sweeps when the **last** client leaves, tracked in
`terminalClients`. The sweep is what reaps orphaned `tmux attach` processes
(`dockerStream.destroy()` does not reliably kill the exec), so skipping it
entirely lets orphans pile up on long-lived mission sessions.

## O11

**The terminal WS may lazily re-create a missing tmux session — that
resurrects a CLOSED mission session.** An attached client reconnects, the
server re-creates the tmux session, and "Close" silently un-closes it as a
bare shell. `mission.getSessionByTmux()` in the WS connect path is what stops
it: no DB row → refuse with a message + close 4002. Any new attach path for
`msn-*` needs the same guard.

## O12

**An attached terminal can resurrect a killed tmux session as a bare shell**,
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

## O13

**A "Loading…" line in a list that already has data is a bug, not a
placeholder.** Every 15s poll and every action flips `sessionsLoading` /
`historyLoading`, so an unconditional placeholder pushes the listing down a
line and back on each tick. Show it only when there is genuinely nothing yet
(`loadedFor !== project.id`, `!history`) — `loadedFor` is set on SUCCESS, not
when the fetch starts, or the placeholder can never appear at all. Also: two
group headers both `sticky top-0` in one scroller stack on top of each other;
the second one needs the first one's height as its offset.

## O14

**The headless test browser (cloakbrowser) produces NO frames, which breaks
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

## O15

**A fast number is not a verified number: re-measure with the OLD setting as a
control, changing nothing else.** Proving tmux `escape-time` was the ESC delay
meant measuring the same live pane twice, minutes apart, flipping only that one
option: median 16.8ms at `escape-time 10`, 506.9ms at tmux's 500ms default.
Either figure alone proves nothing — a path that was never slow looks exactly
like a fix, and "I pressed ESC and it felt instant" is how a wrong cause gets
shipped. The control costs one extra run and is the only thing that
distinguishes "fixed it" from "was never broken here".

## O16

**A synthetic `keydown` on `.xterm-helper-textarea` reaches the pane, and that
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

## O17

**A `Splitter`'s own `min` can make a panel uncollapsible by hand, and the
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

## O18

**Two rules for a fold/expand that must not MOVE anything — measure BOTH gaps,
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

## O19

**Deleting a Mission project kills that AGENT's tmux sessions, not just that
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

## O20

**`matchMedia` is untestable in a headless tab, `window.innerWidth` on a
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

## O21

**Coordinate clicks on the Mission page can submit a form you never aimed at.**
The `Input` click tool reports `clicked: true` for the element you named, but
during a session it twice created a junk project (`~` and then `root`, both
`pad-opencode-proj` on `/root`) out of the "+ New project" dialog. After using
it on this page, **check `GET /api/mission/projects` and delete anything that
is not the user's** — the user had 3 (paddock, schlorp, craftpip). Prefer
`el.click()` on a specific element; it lands where you say and does nothing
else. Deleting a project also closes that agent's tmux sessions.

## O22

**Count the Mission projects at the END of any browser session on that page,
not only after a coordinate click.** A third junk `root` (again `pad-opencode-proj`
on `/root`) appeared with no coordinate click anywhere near it, so the trigger
is not fully explained by that tool — the user may also be clicking in their
own tab while the agent works. `GET /api/mission/projects` is cheap; a silent
junk row also shows up as a stray extra avatar in the new col-1 rail, which is
how it was caught. Do not delete a row you cannot attribute without asking
first: it may be something the user just made on purpose.

## O23

**`src/test/mission.test.js` is SAFE to run now — it uses its own throwaway
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

## O24

**A hand-written "old schema" fixture is not a weaker test, it is a WRONG
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

## O25

**Any `docker exec -i … sh -lc` harness that then `read`s the stdin needs
`spawn` + `child.stdin.write/end`, never `execFile` with `{input}` — the
paddock container's docker CLI keeps a Node-piped stdin open and the `read`
blocks forever** (measured live in plan 52 D1: a trivial
`IFS= read -r X; echo got:$X` hung under `execFile`+`input` while `spawn`
and `printf | docker exec -i` both completed instantly). The hang is worse
than a crash: an orphaned full-reach key survives a request that never
returned, so conferral's `execInPad` also carries a 60s kill-to-fail guard
that turns a hung attach into a normal rejection → rollback.

## O26

**Published openclaw refuses Control UI over plain HTTP unless device
identity is skipped.** The WS handshake fails with
`cause: control-ui-insecure-auth`; `gateway.controlUi.allowInsecureAuth`
alone does NOT fix it. `applyWebAuth` therefore sets
`gateway.controlUi.dangerouslyDisableDeviceAuth: true` on publish (token-only
auth) and `removeWebAuth` restores the pre-publish `controlUi` (state file
`web-openclaw.json` saves `{ bind, auth, controlUi }`). The state file is
written only on the FIRST publish; re-publishing an already-published pad
keeps the original saved state (overwriting it made unpublish restore the
published form).

## O27

**The webui runs as root (plan 43) — that's intentional, not a bug.** Root is
how it controls the host FS + docker socket. `removeInstanceDir` is a plain
`fs.rmSync` (no root-helper container, no EACCES paths); agent configs are
read/written directly. Everything the webui creates is `chown`ed back to
`PUID:PGID` via `ownership.ensureOwned` after each create. A boot sweep
(`normalizeTree` over `src/data/` + `instances/`) re-heals root-owned agent
data, EXCEPT hermes data dirs (`isSelfManagedAgentData` skips them — hermes
re-chowns `/opt/data` to uid 10000 every boot). Verify user files are
`PUID`-owned after any create/rebuild; agent containers still write root
files mid-run by design.

## O28

**Per-PAD "Container user" (plan 43 Phase 7, meta `USER_MODE=user`) drops
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

## O29

**`tmux new-session -c <dir>` does NOT fail on a missing directory — it
silently starts the pane in the PARENT.** Verified live on `pad-opencode-proj`:
asked for `/www1/craftpip` (gone), got a working session whose
`pane_current_path` was `/www1`, with the agent happily working in a folder
the user never chose. **Always `test -d` the folder inside the PAD first**
(`padTmux.folderExists`, single-quote-escaped) and refuse with a clear
message; never trust tmux to tell you the folder was bad. Same class of
trap: check `pane_current_path`/`pane_current_command` when you need to know
what a pane is really doing.

## O30

**tmux primitives live in `src/services/pad-tmux.js`, not app.js.** app.js's
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

## O31

**The `mission_*` MCP tools may `require('./services/mission')` — never
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

## O32

**"Is the human mid-turn?" is a SECOND pass, not part of liveness — and an
MCP list that skips it silently lies to the LLM.** `withLive*` only stamps
`live` (a tmux session exists). `busy` / `busyKnown` / `open` are stamped by
the separate `withAgentBusy` / `withAgentBusyProjects` (each conversation's
OWN store via `busyForSessions` — one `agentStore.readActivity` per id, cached
~5s — plan 52 R8(a)), so every list/detail path must chain both — exactly like
`/api/mission/*` at `app.js:2540/2602/2627`. `withAgentBusy(sessions,
agentOf)` resolves the PAD through the *row's project*, so a row with no
project (rare) simply gets no stamp. `busyKnown: false` means UNKNOWN, never
idle, and an MCP projection must emit the field only when the store stamped it
rather than defaulting it to `false`.

## O33

**An MCP handler that stops at the first enrichment pass is a parity bug, not
a shortcut.** When a parallel agent adds a second decoration to the Mission
service, every MCP list/detail path has to pick it up: check
`app.js`'s route for the `withLive*` chain and mirror it. `mission_projects`
with only `withLive` returns no `openCount`/`busy`; `mission_sessions` with
only `withLiveSessions*` returns no `busy`. The LLM then cannot tell "the
human is typing right now" from "here but idle" and talks over a live
conversation — the one failure the Mission page exists to prevent.

## O34

**Never resolve an agent's TYPE yourself, and know WHICH resolver you are
calling — since plan 76 there are three, and picking by feel is the bug.**
`getDriver(type)` is strict: an unrecognised type **throws**
`unknown_agent_type: '<t>' — known: …`. `getDriverOr(type, fallback)` falls
back for an **absent** type only (`undefined` / `null` / `''` — a real pad
with no `AGENT` line) and still throws for a type that is present but
unknown, because "nothing to look up" and "I read a type I cannot resolve"
are different questions and only the second was ever wrong. `hasDriver(type)`
validates a type that came from a URL or a request body **before** you
resolve it.
- **Why the strict half is the whole point:** the old `drivers[type] ||
  openclaw` answered a misspelled type with a complete, confident *openclaw*
  answer — image, dataDir, workspaceDir, configFile, commands — and named the
  substitution in the payload. Measured live before the fix:
  `/api/agent-types/opencodee/commands` returned **200** with `type:
  "openclaw"`, openclaw's 4 commands and openclaw's MCP block. Nothing threw
  and nothing was logged, so the wrong answer was **indistinguishable from
  success** and surfaced much later as a confidently wrong path instead of a
  404 at the typo. That route now answers **404**.
- **Why there is no DB CHECK to lean on:** `agents.agent_type` is `TEXT NOT
  NULL DEFAULT 'openclaw'` with no constraint, and `meta.env`'s `AGENT` line
  is hand-editable, so a typo'd migration or a removed driver really does
  reach the registry. The valid set lives in **code**, so the registry is the
  only place this can be enforced.
- **Still never hand-roll a `SELECT agent_type`** to resolve a type:
  `mission_project_create` did that once and a typo produced
  `mission_unsupported_agent: openclaw does not support Mission workspaces`
  for a PAD that never existed. Let `mission.agentRow` (via `projectFolders`,
  `createProject`, `startSession`) do it — it throws
  `mission_agent_not_found` with a 404. The **grant gate still runs first**:
  `requireTool` fails closed on an unknown agent, so a handler must never rely
  on the store to report a bad name.
- **The two sites that stay lenient, and the reason each one is a real
  exception:** `agent-registry.buildAgent` loops over every pad dir in
  `discoverAgents` with no try/catch, so a strict throw there blanks the whole
  `/api/agents` listing over one corrupt pad — loud is right for one subject,
  wrong for a fleet listing without per-pad error rows; and the `meta.AGENT`
  readers in `app.js`/`vm-manager` (`update-info`, the web routes,
  `readSettings`, `readWebState`, `prepareAgentChanges`) use `getDriverOr` so a
  pad with no `AGENT` line still works. Before choosing leniency anywhere, ask
  **whose** failure the throw becomes — and check the row's answer against a
  *different* pad's: three live pads reporting three different versions is the
  positive control that the leniency resolved each pad's own driver.
- **A `catch` around the resolver hides the throw, so do not wrap one.** The
  `readWorkspaceMount` `try {} catch {}` swallowed the strict throw and dropped
  the mount with no error; the resolution now happens **outside** it, and only
  the genuinely-optional stored pair stays inside.

## O35

**A pad's `SUBNET` reservation and its live `_default` network are two
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

## O36

**The stale-door sweep will fight you forever if anything still writes
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

## O37

**Per-PAD image builds orphan disk.** Every create/rebuild retags
`paddock-vm-<name>:latest` and orphans the old build as a dangling image;
delete removes the tag and `pruneDanglingImages` (`docker image prune -f`,
dangling only) runs after create/rebuild/delete to reclaim it. A dangling
image that survives the prune is in use by a container (possibly another
project) — don't force-remove it.

## O38

**Deleting an agent deletes its custom workspace source too** (plan 24): when
`meta.WORKSPACE_HOST` lives under the project root but OUTSIDE the agent's
data dir, `removeVm` `rmSync`s the whole workspace dir. Never point a real
agent at a shared workspace dir you care about unless that's intended; for
throwaway tests use a dedicated dir. Project-image test workspaces
(`wstest-*`) get wiped this way.

## O39

**BuildCommands box cannot open `FROM … AS <name>` stages** (plan 41): the
block is injected mid-file into the agent's main stage, so a `FROM` there
starts a new stage whose `COPY --from=<same>` is a BuildKit circular
dependency, and a trailing stage would become the final tagged image. To pull
the project toolchain use `COPY --from=paddock-proj-<name>:latest <src> <dst>`
or `RUN --mount=type=bind,from=paddock-proj-<name>:latest,source=…,target=…`.

## O40

**`src/` is BIND-MOUNTED into the paddock container, so a control run that
edits the container's copy edits YOUR WORKTREE.** Proving a guard works means
disabling it and watching a test go red — I did that with
`docker exec … node -e "s.replace('if (a && b) {', 'if (false) {')"` against
`/app/mcp.js`, and the replacement landed on the host file, silently turning
the real guard off. The tell is that a `docker cp` "restore" afterwards does
not help: you are copying the corrupted file back onto itself. Disable a guard
in a **throwaway copy** (`/tmp/...`), never in `/app`. Same reason `docker cp`
is not how you get an edit into a running webui — the bind mount already did it.

## O41

**A mutation control that ran in the WRONG DIRECTORY still prints a convincing
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

## O42

**A green run in the WORKTREE says nothing about what you are committing —
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

## O43

**Partially staging one function out of a file means staging its whole BLOCK.**
`redactSecrets` called `isSecretKey` and `redactConfigText`, which were defined
a few lines above it in the worktree and did not exist in HEAD at all: splicing
the function alone produced a file that parses, passes `node --check`, and
throws `ReferenceError` at call time. Two traps in the splice itself: offsets
computed against HEAD go stale as soon as the first edit lands (apply the
edits back-to-front, or collect all ranges first), and `lastIndexOf('/**')` to
pick up a doc comment reaches back past *other functions* and deletes their
bodies. `node --check` is not a sufficient control here — only the suite is.

## O44

**Devcontainer mirror writes for host-only workspaces go THROUGH THE PAD**
(plan 41, fixed by plan 70). Used to be a refusal-shaped bug: the webui's
`/www2` mount is read-only, so Generate on `/www2/user1` or `/www1`
workspace pads died with `ENOENT: mkdir '/www2/user1/.devcontainer'` —
**read-only surfaces as ENOENT, not only EROFS**. Fix:
`containerViewOf(host) == null` → the webui composes the JSON and
`vm-manager`'s own `docker exec -i` writer delivers it (`spawn` +
`stdin.write/end`, NEVER execFile — the docker CLI keeps a piped stdin open
and a `read` hangs; content is never shell-quoted; `termUserArgs` drops to
the pad user, root-mode pads get an explicit chown).
`syncDevContainer`/`regenerateDevContainer` are async — REST awaits, the
settings-apply write-back needs
`Promise.resolve(syncDevContainer(...)).catch(log)`. A stopped pad refuses
with typed `pad_not_running` (→ 400 "start it first"); the card shows the
"written through the running pad" note from `devContainerStatus.writableVia`, and
`_setPadWriteRunner` is the test seam.

## O45

**vm-manager suites prefixed `/var/padtest-*` (and any test mkdir under
`/workspace` or `/var`) EACCES from non-root shells** — a uid-1000 run of
`vm-manager.test.js` shows ~29 environment failures (door sweep, workspace
guards, devcontainer plan items), all `EACCES: mkdir '/var/padtest-*'`. Not
a code regression: re-run as root before suspecting the change. The plan-70
subtests use a self-contained `withTmpA` on `/tmp/padtest70-*` + a fixture
under `/www2/paddock-fixture-70` and run anywhere.

## O46

**A hand-written SVG `d` with a run-together arc flag silently kills the whole
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

## O47

**A token that no SOURCE FILE uses never gets a class — so a token consumed by
hand-written CSS has to be read as a VARIABLE, not a utility.** Tailwind only
emits `.shadow-tooltip` if some `.jsx` writes it; the tooltip's shadow lived
in a hand-written `index.css` rule that spelled the value out inline, so
`--shadow-tooltip` was defined, documented, and used by nobody. Fix is
`box-shadow: var(--shadow-tooltip)` in the CSS rule. After any token change,
grep the BUILT css for **every** token you touched, and remember the built
bundle's name changes on every build (`src/public/assets/index-*.css` — use
`ls -t`, never a hardcoded hash).

## O48

**`tailwind-merge` resolves a conflict in favour of the LAST class, so
`className` must be the last argument of every primitive's `cx()`.** In
`Input.jsx` the base took `className` and the component then appended
`'py-2 resize-y'` / `'pr-8'` AFTER it — so `resize-none` on a `Textarea` was
silently a no-op and an `AgentDetail` editor had to fall back to an inline
`style={{resize:'none'}}`. `base()` must NOT accept `className`; each
component ends its own `cx(base(...), ownStructure, className)`. When a
primitive's own class needs to lose, that is a missing prop
(`Card plain`), never a class the caller can pass.

## O49

**A dense listing needs its own control scale — do not force the form scale
onto it.** `Button`'s `ctl-sm`/`ctl-md` min-heights make sense on a form but
would make every Mission project row taller than its content, and `icon`
pins an inline width that overrides a caller's `h-8 w-8`. Hence `size="bare"`
(no height, no font size) plus `variant="link" | "dangerLink" | "dangerSoft" |
"none"`. `none` matters twice over: an unknown variant string silently falls
back to `secondary` and adds a border nobody asked for.

## O50

**A colour utility whose token is not in `@theme` is dropped SILENTLY — no
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

## O51

**`api(path, { body })` wants a plain object, not `JSON.stringify`ed** —
`src/client/src/lib/api.js` does the `JSON.stringify` itself, so passing a
pre-stringified body sends a quoted string and the backend sees the wrong
shape. Same for `Content-Type` (it sets JSON only when `body` is present).
Errors come back as a **thrown plain object**, not an `Error`: `{ status, error,
code? }` — so `err?.message` is usually undefined and `errText` must read
`error`. The client agent list exposes the effective workspace as
`workspace_dir` (custom mount when set, else the driver default); there is no
`mission` block on the row, so filter coding agents on `agent_type` and read
`workspace_dir` (see `pages/agent/SettingsTab.jsx` for the same value).

## O52

**`src/data/app.db*` stays `1000:1000`-owned via the boot sweep, not luck.**
The webui now runs as root, so a fresh `app.db`/`-wal`/`-shm` created by it
is root-owned until `ownership.ensureDbOwned()` re-chowns it after open (and
the boot `ensureDataOwned()` covers the whole `src/data/`). If DB writes ever
fail with `attempt to write a readonly database`, fix with
`chown 1000:1000 src/data/app.db*`. Never run `docker exec paddock node …`
(runs as root) against code paths that open the DB, or it may recreate
root-owned DB files.

