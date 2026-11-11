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

- **Every element on the Mission page carries a stable `msn-*` class**
  ([S01](docs/reference/lessons/surface-and-testing.md#s01))
- **Never route a UI complaint through bash/curl/reading the JSX.** Load the
  page, click the thing, look at it. The user has hit real bugs in this UI
  (a confirm prompt that outlived the row it belonged to; a scrollbar that
  shoved the column sideways when a list grew) that all survived a green test
  run and a careful code read.
- **When a fix lands, verify the interaction end to end in the browser** — click
  the button, then assert on the *resulting* DOM (element gone, banner gone,
  gutter reserved), not just that the handler fired.
- **A JSX handler that references an identifier from another component's scope
  builds fine, passes every test, and throws only when clicked.**
  ([S02](docs/reference/lessons/surface-and-testing.md#s02))
- **A MISSING IMPORT is a runtime error, not a build error — so `npm run build`
  passing says nothing about whether the page RENDERS.**
  ([S03](docs/reference/lessons/surface-and-testing.md#s03))
- **A suite of source-text REGEXES cannot see that a file stopped parsing — and
  the committed file is not the file the browser ran.**
  ([S04](docs/reference/lessons/surface-and-testing.md#s04))
- **An unreadable answer and a negative answer are different ANSWERS, and the
  cheapest place to confuse them is the one that already had a null.**
  ([S05](docs/reference/lessons/surface-and-testing.md#s05))
- **A field an agent never hands you is not a field you can look up later — make
  the agent hand it to you, or make the answer UNKNOWN.**
  ([S06](docs/reference/lessons/surface-and-testing.md#s06))
- **A live-work probe can be answering about a DIFFERENT PROCESS than the one
  you are describing, and a shared database is not shared liveness — so probe
  the STORE, not the server (resolved by plan 52 R8).**
  ([S07](docs/reference/lessons/surface-and-testing.md#s07))
- **`USER_MODE=user` puts the pad's tmux in `/tmp/tmux-1000`, so a plain root
  `docker exec … tmux ls` reads a DIFFERENT, EMPTY server.**
  ([S08](docs/reference/lessons/surface-and-testing.md#s08))
- **Mission col 3 is pinned to `openSession` in the store, NOT to the row and
  NOT to `selectedProjectId`.**
  ([S09](docs/reference/lessons/surface-and-testing.md#s09))
- **A column that is refetched must not be what the next column renders from.**
  ([S10](docs/reference/lessons/surface-and-testing.md#s10))
- **`startSession` must re-read pane state after setting `openSession`**
  ([S11](docs/reference/lessons/surface-and-testing.md#s11))
- **tmux `show-options -g` will NOT list `escape-time`**
  ([S12](docs/reference/lessons/surface-and-testing.md#s12))
- **A poll or a mutation that refreshes the *selected project's* list will leave
  the all-projects list frozen.** Every refresh path goes through
  `refreshActive()`, which reads the active `scope`.
- **"Hidden" has three different meanings in CSS and only one of them is free.**
  ([S13](docs/reference/lessons/surface-and-testing.md#s13))

- **A name the surface HANDS OUT must be a name the surface ACCEPTS, and the
  resolver must run BEFORE the grant check, not after.**
  ([S14](docs/reference/lessons/surface-and-testing.md#s14))
- **A "here is where it ran" probe must carry the SAME environment change as the
  command, or it reports the truth and the answer disagrees with it.**
  ([S15](docs/reference/lessons/surface-and-testing.md#s15))
- **"This list is capped at 10" and "your item is not in it" look identical to
  the caller — so any list a caller may need to SEARCH needs a filter that
  searches everything, applied BEFORE the cap.**
  ([S16](docs/reference/lessons/surface-and-testing.md#s16))
- **A resolver that returns the canonical name is only half a fix — the name has
  to reach the ACTION and the RESPONSE too.**
  ([S17](docs/reference/lessons/surface-and-testing.md#s17))
- **A list tool that can be FILTERED must never fall back to the unfiltered
  list, because that answer is indistinguishable from success.**
  ([S18](docs/reference/lessons/surface-and-testing.md#s18))
- **A count that sits next to a data array will be READ as the thing it
  measures.** ([S19](docs/reference/lessons/surface-and-testing.md#s19))

- **A field the SERVER computes must not be re-derived on the client, and a
  verdict must not be computed anywhere but the gate.**
  ([S20](docs/reference/lessons/surface-and-testing.md#s20))

- **Assert a clock CHANGED, and give the test a gap bigger than its
  resolution.** ([S21](docs/reference/lessons/surface-and-testing.md#s21))

- **A first observation of a death is NOT the time of the death, and the honest
  word for it is an upper bound.**
  ([S22](docs/reference/lessons/surface-and-testing.md#s22))

- **The retry is where a client-side timeout is fixed, and an in-process
  pre-check is not enough.**
  ([S23](docs/reference/lessons/surface-and-testing.md#s23))

- **A source-text assertion is a pin on a name, not on a fact — refactor the
  assertion, keep the fact.**
  ([S24](docs/reference/lessons/surface-and-testing.md#s24))

- **A free variable in plain JS is as invisible as one in JSX: `node --check`
  passes, the suite passes, and it is a `ReferenceError` the first time the line
  runs.** ([S25](docs/reference/lessons/surface-and-testing.md#s25))
- **An audit log that records only WHAT cannot answer WHO, and a FK will tell
  you so by failing a test you did not write.**
  ([S26](docs/reference/lessons/surface-and-testing.md#s26))
- **An audit trail is not a second copy of the data — record the SHAPE of a
  write, never its content.**
  ([S27](docs/reference/lessons/surface-and-testing.md#s27))
- **A store test that mutates a module-level singleton must put it back, or the
  next test inherits a bound copy.**
  ([S28](docs/reference/lessons/surface-and-testing.md#s28))

- **An ORDERING assert on `indexOf` is unfalsifiable without an explicit absence
  check, because the absent case returns -1 and -1 sorts first.**
  ([S29](docs/reference/lessons/surface-and-testing.md#s29))

- **A permission DEFAULT is set in the CALLER, so fixing the callee fixes
  nothing, and `x !== false` is not a safe default — it reads an OMITTED
  `undefined` as true.**
  ([S30](docs/reference/lessons/surface-and-testing.md#s30))

- **A stale row survives a write that just happened in the same function.**
  ([S31](docs/reference/lessons/surface-and-testing.md#s31))

- **A parameter that names two different things is a trap that no type system
  catches, and the fix is a rename plus a REFUSAL, never an alias.**
  ([S32](docs/reference/lessons/surface-and-testing.md#s32))
- **A status filter, a `total` and a cap only answer a question about ONE set —
  and a filter that runs after a cap is not a filter.**
  ([S33](docs/reference/lessons/surface-and-testing.md#s33))
- **A lookup that was never RUN is indistinguishable from a fact it would have
  found — and the unit tests stay green while it ships.**
  ([S34](docs/reference/lessons/surface-and-testing.md#s34))
- **The right answer to "the surface contradicts itself" is usually that TWO
  components each re-derived it, so fix the derivation, not the two answers.**
  ([S35](docs/reference/lessons/surface-and-testing.md#s35))
- **Verify a refactor that changes a SOURCE-TEXT assertion: the assertion is a
  pin on where the fact LIVES, so moving the fact turns the test red for a
  reason that is not a bug.**
  ([S36](docs/reference/lessons/surface-and-testing.md#s36))
- **A summary field derived from two facts is a SECOND answer to a question the
  row already answers, and it will contradict it.**
  ([S37](docs/reference/lessons/surface-and-testing.md#s37))
- **Copying a column into a re-file produces a row that LIES, and the label is
  the only evidence.**
  ([S38](docs/reference/lessons/surface-and-testing.md#s38))
- **`claimed_by` does not need a `claimedBy`, and a test must say so.**
  ([S39](docs/reference/lessons/surface-and-testing.md#s39))
- **A "browse the workspace" permission needs a CAPABILITY answer too, and the
  two must be reported separately.**
  ([S40](docs/reference/lessons/surface-and-testing.md#s40))
- **A per-instance data dir is MOUNTED at a path the agent calls its home — so a
  store path written from the agent's own docs is wrong by one segment.**
  ([S41](docs/reference/lessons/surface-and-testing.md#s41))
- **The newest message of a role is often not the answer, and the store's index
  is not on the column you sort by.**
  ([S42](docs/reference/lessons/surface-and-testing.md#s42))
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
  become "there is no activity".**
  ([S43](docs/reference/lessons/surface-and-testing.md#s43))
- **A per-driver facility has per-driver COSTS, so one claim about speed is a
  lie for two of three drivers.**
  ([S44](docs/reference/lessons/surface-and-testing.md#s44))
- **A plan belongs to a Mission project through its SESSION, not its folder.**
  ([S45](docs/reference/lessons/surface-and-testing.md#s45))
- **A migration suite needs a control that asserts the MIGRATION ran, and the
  only honest one asserts the columns are ABSENT when it did not.**
  ([S46](docs/reference/lessons/surface-and-testing.md#s46))

- **A guard asserted as a FINAL state cannot fail if the bug is a TRANSIENT one,
  so state the invariant as a predicate over the whole SEQUENCE — and prove it
  by reversing the ORDER, not by deleting the code.**
  ([S47](docs/reference/lessons/surface-and-testing.md#s47))
- **A test that passes because the fixture never got the code running is worse
  than no test, and the tell is a flag that never flips.**
  ([S48](docs/reference/lessons/surface-and-testing.md#s48))
- **A mutation control must run in a COPY, and you must read the ORIGINAL back
  afterwards.** ([S49](docs/reference/lessons/surface-and-testing.md#s49))
- **A test must be able to reach code written for a BUNDLER, or it will be
  "unittestable" for a reason that has nothing to do with the code.**
  ([S50](docs/reference/lessons/surface-and-testing.md#s50))

## Project Map

- **`docker-compose.yml`** defines the `webui` service (container `paddock`,
  image `paddock-webui:latest`) — the **control plane**: Node.js/Express on
  port 6789 managing all PADs via `/var/run/docker.sock`.
- **`src/`** — webui source, bind-mounted to `/app` (backend edits need no
  rebuild). Express `app.js` (boot, middleware, terminal WebSocket) + `routes/` (the REST API, one file per area) + `services/`; **`src/services/drivers/`** = one
  module per agent type (openclaw, opencode, picoclaw, hermes, codex).
- **`src/vm-builds/<type>/`** — per-type Dockerfile + start.sh; images tag
  `paddock-vm-<type>:latest`.
- **`src/client/`** — React 19 + Vite SPA. Built output → `src/public/`
  (served at root `/`; API under `/api/*`, WebSocket at `/ws/terminal/*`).
  `src/routes/` is the live REST API (the old EJS routes are gone).
- **`instances/<pad>/`** — per-PAD dir: `<agent>/` bind-mounted data dir,
  `docker-compose.yml`, **`meta.env`** (critical state), `logs/`.
- **`src/test/mission-reopen.test.js`** + **`src/test/helpers/client-store-resolve.mjs`** —
  plan 68's auto-reopen guards, and the ESM resolve hook that lets `node --test`
  reach the client store at all. The ordering assert is a **sequence** predicate
  (see the guard/transient lesson above), and a negative here is only meaningful
  with a positive twin on the same fixture.
- **`src/test/mcp-exec-usermode.test.js`** — plan 79's guard that the MCP `exec`
  path (`mcp.js:execDockerArgs`) and `padExec` drop to the pad user
  (`-u PUID:PGID -e HOME=/root`) in a **user-mode** pad and stay root in a
  root-mode one. It points `WORKSPACE_ROOT` at a throwaway tree with two fake
  instance dirs (`USER_MODE=user` / none) **before** requiring pad-tmux/mcp,
  since `INSTANCES_DIR` is computed at load. A mutation control (delete the
  `...termUserArgs(vmName)` from `execDockerArgs`) turns exactly that one test
  red; run it in a `/tmp` copy, never in `/app` (bind-mounted).
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
  (http://10.69.1.131:6789 on the current host). Browser MCP tools (navigator) are available. "Works on my
  end" is not acceptable — prove it live; no "fix it later".
- **Always consult the online OpenClaw docs** (https://docs.openclaw.ai) before
  any `openclaw` CLI/config work — they change frequently; never trust cached
  knowledge.
- **CommandsPane action buttons paste `openclaw ...` commands into the docked
  terminal** (`run(cmd)`) — never a backend action API. Read-only GETs are
  fine. The Vault is the exception on purpose (server-side secrets).
- **Run the whole suite with `docker exec paddock npm test`** (`test/run-all.mjs`:
  one process per file, ~90 s, a hung file is a failure). One file:
  `timeout 120 docker exec paddock node --test test/<file>.test.js`. **Never
  `node --test test/`** in one go (shared process state, hangs). The runner
  clears `PADDOCK_TASK_QUEUE` for `mcp.test.js` and `GUARD_*` for
  `vm-manager.test.js`; do the same when running those two by hand.

## Critical Operational Gotchas

- **The subscription-exhaustion case is a once-per-day capture opportunity.**
  ([O01](docs/reference/lessons/operations.md#o01))

- **A terminal that drops "every few seconds" was the webui DYING, not a client
  bug.** ([O02](docs/reference/lessons/operations.md#o02))
- **The installed MCP SDK does NOT catch a throwing tool handler.**
  ([O03](docs/reference/lessons/operations.md#o03))
- **The 15 `task_*` MCP tools (plan 69's steps + the `task_pipeline_*` driver
  included) are GATED by `PADDOCK_TASK_QUEUE=1` in `.env`**
  ([O04](docs/reference/lessons/operations.md#o04))
- **A mission session that lists ZERO MCP tools is an opencode state-dir
  ownership problem — and the absence is STICKY to that conversation.**
  ([O05](docs/reference/lessons/operations.md#o05))
- **A user-mode pad's agent writes under its whole `HOME` (`/root`), so the fix
  must give uid 1000 the whole home — and the MCP `exec` path must drop too
  (plan 79).** ([O06](docs/reference/lessons/operations.md#o06))
- **A redactor that reads like it normalizes, but doesn't, ships the secret it
  was written to stop (plan 60).**
  ([O07](docs/reference/lessons/operations.md#o07))
- **Never syntax-check the webui by `node -e "require('/www2/paddock/src/app.js')"`
  — it BOOTS the app** (binds 6789, opens the DB, runs migrations) and leaves a
  second server plus root-owned DB files behind. Use `node --check src/app.js`
  for syntax, `docker restart paddock` to load.
- **`opencode /session/status` no longer backs the Mission dot (retired by plan
  52 R8) — but the endpoint's traps are still a live warning if you use it
  directly.** ([O08](docs/reference/lessons/operations.md#o08))
- **A "dead" row is not a dead conversation.**
  ([O09](docs/reference/lessons/operations.md#o09))
- **Mission sessions (`msn-*`) are multi-client; a second tab must not kick the
  first.** ([O10](docs/reference/lessons/operations.md#o10))
- **The terminal WS may lazily re-create a missing tmux session — that
  resurrects a CLOSED mission session.**
  ([O11](docs/reference/lessons/operations.md#o11))
- **An attached terminal can resurrect a killed tmux session as a bare shell**
  ([O12](docs/reference/lessons/operations.md#o12))
- **A "Loading…" line in a list that already has data is a bug, not a
  placeholder.** ([O13](docs/reference/lessons/operations.md#o13))
- **The headless test browser (cloakbrowser) produces NO frames, which breaks
  three classes of check that otherwise look like product bugs.**
  ([O14](docs/reference/lessons/operations.md#o14))
- **A fast number is not a verified number: re-measure with the OLD setting as a
  control, changing nothing else.**
  ([O15](docs/reference/lessons/operations.md#o15))
- **A synthetic `keydown` on `.xterm-helper-textarea` reaches the pane, and that
  is how you time a keystroke end to end.**
  ([O16](docs/reference/lessons/operations.md#o16))
- **A `Splitter`'s own `min` can make a panel uncollapsible by hand, and the fix
  is not to lower `min`.** ([O17](docs/reference/lessons/operations.md#o17))
- **Two rules for a fold/expand that must not MOVE anything — measure BOTH gaps,
  and branch the drag rule on the FOLDED state, not the stored one.**
  ([O18](docs/reference/lessons/operations.md#o18))
- **Deleting a Mission project kills that AGENT's tmux sessions, not just that
  project's.** ([O19](docs/reference/lessons/operations.md#o19))
- **`matchMedia` is untestable in a headless tab, `window.innerWidth` on a
  `resize` listener is.** ([O20](docs/reference/lessons/operations.md#o20))
- **Coordinate clicks on the Mission page can submit a form you never aimed
  at.** ([O21](docs/reference/lessons/operations.md#o21))
- **Count the Mission projects at the END of any browser session on that page,
  not only after a coordinate click.**
  ([O22](docs/reference/lessons/operations.md#o22))
- **`src/test/mission.test.js` is SAFE to run now — it uses its own throwaway
  database.** ([O23](docs/reference/lessons/operations.md#o23))
- **A hand-written "old schema" fixture is not a weaker test, it is a WRONG one
  — derive it from the real schema and delete the columns under test.**
  ([O24](docs/reference/lessons/operations.md#o24))
- **`openclaw models auth paste-api-key` destroys the whole `openclaw.json`**
  (rewrites it with auth info only). Save the config first and merge it back
  after. It reads the key from stdin — use `spawn`, not `execFile` (hangs).
- **Any `docker exec -i … sh -lc` harness that then `read`s the stdin needs
  `spawn` + `child.stdin.write/end`, never `execFile` with `{input}` — the
  paddock container's docker CLI keeps a Node-piped stdin open and the `read`
  blocks forever** ([O25](docs/reference/lessons/operations.md#o25))
- **Published openclaw refuses Control UI over plain HTTP unless device identity
  is skipped.** ([O26](docs/reference/lessons/operations.md#o26))
- **`instances/*/meta.env` is critical** — without it PAD discovery returns 0
  PADs and detail pages show "Agent not found". `setMetaFlag(name, key, '')`
  REMOVES the line instead of writing `KEY=`.
- **The webui runs as root (plan 43) — that's intentional, not a bug.**
  ([O27](docs/reference/lessons/operations.md#o27))
- **Per-PAD "Container user" (plan 43 Phase 7, meta `USER_MODE=user`) drops the
  agent daemon + terminal to the `pad` user (PUID:PGID=1000:1000), not the whole
  container** ([O28](docs/reference/lessons/operations.md#o28))
- **`tmux new-session -c <dir>` does NOT fail on a missing directory — it
  silently starts the pane in the PARENT.**
  ([O29](docs/reference/lessons/operations.md#o29))
- **tmux primitives live in `src/services/pad-tmux.js`, not app.js.**
  ([O30](docs/reference/lessons/operations.md#o30))
- **The `mission_*` MCP tools may `require('./services/mission')` — never
  `./app`.** ([O31](docs/reference/lessons/operations.md#o31))
- **"Is the human mid-turn?" is a SECOND pass, not part of liveness — and an MCP
  list that skips it silently lies to the LLM.**
  ([O32](docs/reference/lessons/operations.md#o32))
- **An MCP handler that stops at the first enrichment pass is a parity bug, not
  a shortcut.** ([O33](docs/reference/lessons/operations.md#o33))
- **Never resolve an agent's TYPE yourself, and know WHICH resolver you are
  calling — since plan 76 there are three, and picking by feel is the bug.**
  ([O34](docs/reference/lessons/operations.md#o34))
- **A pad's `SUBNET` reservation and its live `_default` network are two
  different claims, and only a pad with a service on the project `default`
  network should hold either.**
  ([O35](docs/reference/lessons/operations.md#o35))
- **The stale-door sweep will fight you forever if anything still writes
  `instances/<pad>-door/`.** ([O36](docs/reference/lessons/operations.md#o36))
- **Per-PAD image builds orphan disk.**
  ([O37](docs/reference/lessons/operations.md#o37))
- **Deleting an agent deletes its custom workspace source too**
  ([O38](docs/reference/lessons/operations.md#o38))
- **BuildCommands box cannot open `FROM … AS <name>` stages**
  ([O39](docs/reference/lessons/operations.md#o39))
- **Restart the webui after editing backend code** (`app.js`, `vm-manager.js`,
  any `services/drivers/*.js`) — Node caches `require()`; a stale process
  keeps old behavior or builds the wrong image via the openclaw-driver
  fallback. `docker restart paddock`.
- **`src/` is BIND-MOUNTED into the paddock container, so a control run that
  edits the container's copy edits YOUR WORKTREE.**
  ([O40](docs/reference/lessons/operations.md#o40))
- **A mutation control that ran in the WRONG DIRECTORY still prints a convincing
  number, because the control reads as "the test went red".**
  ([O41](docs/reference/lessons/operations.md#o41))
- **A green run in the WORKTREE says nothing about what you are committing —
  materialize the index and test THAT.**
  ([O42](docs/reference/lessons/operations.md#o42))
- **Partially staging one function out of a file means staging its whole
  BLOCK.** ([O43](docs/reference/lessons/operations.md#o43))
- **Devcontainer mirror writes for host-only workspaces go THROUGH THE PAD**
  ([O44](docs/reference/lessons/operations.md#o44))
- **vm-manager suites prefixed `/var/padtest-*` (and any test mkdir under
  `/workspace` or `/var`) EACCES from non-root shells**
  ([O45](docs/reference/lessons/operations.md#o45))
- **JSX/CSS edits need `cd src/client && npm run build` + `docker restart
  paddock`** — the SPA serves the built bundle from `src/public/`.
- **A hand-written SVG `d` with a run-together arc flag silently kills the whole
  icon, and the browser console is the only cheap oracle.**
  ([O46](docs/reference/lessons/operations.md#o46))
- **A token that no SOURCE FILE uses never gets a class — so a token consumed by
  hand-written CSS has to be read as a VARIABLE, not a utility.**
  ([O47](docs/reference/lessons/operations.md#o47))

- **`tailwind-merge` resolves a conflict in favour of the LAST class, so
  `className` must be the last argument of every primitive's `cx()`.**
  ([O48](docs/reference/lessons/operations.md#o48))

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
  onto it.** ([O49](docs/reference/lessons/operations.md#o49))

- **A colour utility whose token is not in `@theme` is dropped SILENTLY — no
  build error, no class in the CSS, and it fails only in dark mode.**
  ([O50](docs/reference/lessons/operations.md#o50))
- **`api(path, { body })` wants a plain object, not `JSON.stringify`ed**
  ([O51](docs/reference/lessons/operations.md#o51))
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
  ([O52](docs/reference/lessons/operations.md#o52))

## Workflow Commands

- **Whole test suite:** `docker exec paddock npm test` (~90 s, one process per file).
- **Mutation control** (prove a test bites): `scripts/mutate.sh <file under src/>
  '<sed expr>' <test> [more tests]`. It mutates a COPY in the container, checks
  the mutation landed and still parses, runs the tests, and confirms the original
  is untouched. Exit 0 = guard bites, 1 = it does not, 2 = nothing was measured.
  Use this instead of hand-rolling the copy; never mutate `/app`.
- **Test what is staged, not the worktree:** `scripts/test-staged.sh [words]`.
- **Static checks that run in `npm test`** (`source-hygiene.test.js`,
  `client-navigation-parse.test.js`, `mission-exports.test.js`,
  `route-table.test.js`): no unbound name in any backend or client file; the
  client bundle parses; every MCP tool goes through the `registerTool` wrapper;
  every colour utility in the client names a real `@theme` token; route table and
  Mission export surface unchanged. A red here is a real defect, not a style note.

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

- **Current dev host is `meridian` (10.69.1.131), not lap.** Webui at
  http://10.69.1.131:6789. Here we are uid 1000 (docker group, no root), the
  host docker CLI **has** the compose plugin, and `/www1`/`/www2` do not exist —
  the gitignored `docker-compose.override.yml` replaces the webui volume list
  (`!override`) to drop them. Two setup traps: `src/node_modules` installed on
  the host (Node 24, glibc 2.38) crashes the container's Node 20 with
  `GLIBC_2.38 not found` from better-sqlite3 — rebuild it **inside** the image
  (`docker compose run --rm --no-deps webui sh -c 'cd /app && npm rebuild
  better-sqlite3 --build-from-source'`); and the SPA is built on the host
  (`cd src/client && npm ci && npm run build`). Other containers on this host
  (`niyu-*` and anything not named `paddock` / `pad-*`) are not ours. Browser checks: the
  navigator MCP (`cloakbrowser`, headless); `google-chrome --headless=new` over CDP also works.

- **The three entries below describe the previous host, `lap` (10.69.1.164), which is out of
  scope since 2026-11-11.** They are kept for when work returns there; on `meridian` use the
  entry above.
- On lap: we are **root** (no sudo, no python3). Use the `edit` tool or
  `node -e` for root-owned files — the edit tool works as root.
- On lap: webui reachability: http://10.69.1.164:6789 (localhost:6789 is refused from
  this shell's network context). Vite dev on http://10.69.1.164:5173.
- Auto-login defaults on (`AUTO_LOGIN=true`). API curl tests need a session
  first — auto-login boots on `GET /api/session` (fetch into a cookie jar).

## Driver Framework

- `src/services/drivers/` — one module per agent type, registered in
  `index.js`. `getDriver(type)` is the single source of truth (image, version,
  `configFile`, `dataDir`, `workspaceDir`, commands) and **throws** on an
  unknown type; `getDriverOr(type, fallback)` is the deliberate leniency for an
  absent type; `hasDriver(type)` validates before you resolve. See the rule
  above for which to call.
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
- **Plans must be executable by less capable models without follow-up prompting.**
  Spell out the full user journey, exact visible states/actions, affected files,
  service/data contracts, errors and edge cases, ordered implementation steps,
  and concrete test/browser assertions. Infer basic UX needs (setup, discoverable
  controls, current/next work, progress, blockers, recovery) instead of making the
  user specify each one. Completion requires the real end-to-end outcome; opening
  a page, rendering buttons or passing CRUD tests is not proof the feature works.
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
