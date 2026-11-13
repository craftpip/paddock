# Testing

How you run Paddock's tests, prove that a test can fail, and test exactly what you are about to
commit. It is for anyone changing code under `src/`. The suites run inside the `paddock`
container (the webui), where `src/` is mounted at `/app`.

## Run the Whole Suite

```bash
docker exec paddock npm test
```

`npm test` is `node test/run-all.mjs`. It runs every `src/test/*.test.js` in its own process,
prints one line per file and a total, and takes about 90 seconds.

```bash
docker exec paddock node test/run-all.mjs runner queue
docker exec -e TEST_VERBOSE=1 paddock npm test
```

The first form runs only the files whose name contains one of the words. `TEST_VERBOSE=1`
prints the tail of each failing file's output.

| Line starts with | Means |
|---|---|
| `ok` | the file exited 0 |
| `FAIL` | at least one test failed; the failed names follow |
| `HUNG` | the file did not exit within `TEST_TIMEOUT_MS` (default 240000) and was killed |

A hung file is a failure: a suite that leaks a timer, a socket or a database handle is a broken
suite. The runner exits non-zero when any file fails, hangs or leaves something behind (see
[Host Footprint Check](#host-footprint-check)).

Do not run `node --test test/` in one go. The suites set process-wide state before they load
the app (`PAD_DB_PATH`, `WORKSPACE_ROOT`) and several replace module functions; one shared
process mixes that state and hangs.

## Run One File

```bash
timeout 120 docker exec paddock node --test test/<file>.test.js
```

Two files assert the default surface, so the flags the running container sets for the live app
must not reach them. The runner removes these variables for you; clear them yourself when you
run either file by hand.

| File | Variables to clear | Why |
|---|---|---|
| `mcp.test.js` | `PADDOCK_TASK_QUEUE` | it pins the default MCP tool list, which the flag extends |
| `vm-manager.test.js` | every `GUARD_*` | it asserts the workspace-mount guard defaults, which `.env` may switch off |

```bash
timeout 120 docker exec paddock env -u PADDOCK_TASK_QUEUE node --test test/mcp.test.js
```

## Host Footprint Check

Before the first file and after every file, the runner records what exists on the real host:

- the entries of `instances/` under `WORKSPACE_ROOT` (default `/workspace`)
- every container (`docker ps -a`), network (`docker network ls`) and image (`docker images`)

A file after which something new exists fails, even when all of its tests passed:

```text
       LEFT BEHIND on the real host: container pad-input, network pad-input_default
       a test reached the real docker daemon or the real instances directory; stub that call
```

A leftover means a test called the real `docker` or wrote under the real `instances/`. A test
that does this stays green on its own, which is why the runner checks. When docker is not
reachable from where the runner runs, only the directory is watched.

When you see `LEFT BEHIND`:

1. Remove what was left, if it is ours (a `pad-*` fixture name). Never touch another project's
   containers.
2. Stub the call. Do not let the test reach `docker compose`, `docker ps` or `docker network`.
3. Point `WORKSPACE_ROOT` at a throwaway directory before the service is loaded. A service
   computes its paths when it loads; `test/helpers/evict.js` drops a service from the require
   cache so the next `require` re-reads the environment. A service that is a directory of
   modules is dropped whole.

### Test Seams

The services that talk to docker export a function that replaces the call. Pass a stand-in,
and pass `null` afterwards to restore the real one.

| Seam | Module | Replaces |
|---|---|---|
| `_setApplyImpl(fn)` | `services/vm-manager/settings-apply.js` | the whole apply behind the one-change-per-PAD lock, which runs `docker compose` |
| `_setRunner(fn)` | `services/container-health.js` | every `docker inspect` and `docker compose config` of the health check |
| `_setPsRunner(fn)` | `services/agent-registry.js` | the `docker ps -a` listing; it also drops the cached listing |
| `_setNetworkSubnets(fn)` | `services/vm-manager/subnets.js` | the docker network listing behind the subnet picker |

`_setApplyImpl` is not on the `services/vm-manager` index; require the module itself.

```js
const apply = require('../services/vm-manager/settings-apply');
let finish;
apply._setApplyImpl(() => new Promise((resolve) => { finish = resolve; }));
try {
  const first = apply.applyAgentChanges('pad-x', { force: true });
  const second = await apply.applyAgentChanges('pad-x', { force: true }).catch((e) => e);
  assert.equal(second.code, 'pad_change_in_progress');
  finish('done'); // end the first apply so the lock is released
  await first;
} finally {
  apply._setApplyImpl(null);
}
```

```js
const { pickFreePadSubnet, _setNetworkSubnets } = require('../services/vm-manager/subnets');
_setNetworkSubnets(() => ['172.18.0.0/16', '10.200.0.0/20']);
try {
  assert.equal(pickFreePadSubnet(), '10.200.16.0/24');
} finally {
  _setNetworkSubnets(null);
}
```

The second example gives that answer only while no instance directory reserves `10.200.16.0/24`,
which is why the suite points `WORKSPACE_ROOT` at an empty tree first.

## Prove a Test Bites

A test that cannot fail guards nothing. `scripts/mutate.sh` breaks the code a test guards and
tells you whether the test noticed.

```bash
scripts/mutate.sh <file under src/> '<sed expression>' <test file> [more test files]
```

```bash
scripts/mutate.sh services/runner-view.js 's/allowed: !!allowed/allowed: true/' runner-view
```

The file is a path under `src/`. A test may be given as `runner-view`, `runner-view.test.js` or
`test/runner-view.test.js`. Set `PADDOCK_CONTAINER` when the container is not named `paddock`.

The script copies the app to a temporary directory inside the container and mutates the copy.
It never edits `/app`: `src/` is bind-mounted, so editing `/app` edits your worktree. The
client sources are copied too, so a mutation of a file under `client/` is as safe as a backend
one; only `node_modules` are linked.

| Exit | Result line | Means |
|---|---|---|
| 0 | `RESULT: the guard bites` | at least one test went red |
| 1 | `RESULT: every test stayed green; the guard does NOT bite` | the test does not guard that line |
| 2 | a line starting `mutate:` | the control was invalid; nothing was measured |

Exit 2 covers: the file or a test file does not exist, the expression changed nothing, the
mutated `.js` or `.cjs` file no longer parses, the file resolves outside the copy, or the
original changed during the run. A mutant that does not parse turns every test red, which
proves nothing about the guard, so it is refused instead of counted.

A test counts as red when node reports it failed or cancelled. A mutant that makes a test hang
is reported as cancelled, and that is a red. When no test passed at all, the script prints a
note: check that the mutant still loads before you treat the run as evidence.

Do not hand-roll a copy and do not mutate `/app`.

## Test What Is Staged

```bash
scripts/test-staged.sh
scripts/test-staged.sh mission queue
```

Your worktree can hold unstaged or untracked work that makes a suite pass on code you are not
committing. `scripts/test-staged.sh` writes the git index to a throwaway directory, copies its
`src/` into the container as `/tmp/staged`, and runs `test/run-all.mjs` there with the words
you pass. It removes both copies when it ends.

- The staged tree has no `node_modules`; the script links the container's.
- The client bundle is build output and is not tracked, so the script copies the worktree's
  `src/public` beside the staged source. `client-bundle-fresh.test.js` then answers the
  question that matters before a commit: was this bundle built from the staged source?
- Exit 2 means the index has no `src/app.js`.

## Static Checks

These files run in `npm test` and execute no application behaviour. Each reads source or
loads modules to find a defect that builds, passes `node --check`, and shows up only when the
line runs or the page renders. A red here is a real defect.

| File | Guards |
|---|---|
| `source-hygiene.test.js` | No backend file uses a name it never declares. Every MCP tool is registered through the wrapper that turns a throwing handler into a tool error. Every colour utility in the client names a token that exists in `@theme` |
| `client-navigation-parse.test.js` | The client bundles from `src/App.jsx` with every import resolved, without touching the served bundle. No client `.js` or `.jsx` file has an unbound reference. The shared navigation hooks render under the installed router |
| `client-bundle-fresh.test.js` | The served bundle was built from the client source on disk, and every asset `index.html` references exists |
| `mission-exports.test.js` | `services/mission` exports exactly its pinned surface with nothing undefined. Each of its modules loads first without leaving a sibling half-built. No module exceeds its size limit or uses an undeclared name |
| `vm-manager-exports.test.js` | The same surface, load-order and size checks for `services/vm-manager`, and that it still finds the build templates |
| `route-table.test.js` | The app serves exactly the pinned routes, and every pair one request could match keeps its order. Route files get exactly the helpers they use and stay a readable size. The CSRF check runs once before any route. Host-level routes stay admin-only |
| `mcp-tools-layout.test.js` | The MCP tools register in the same order with the task queue on, and exactly the task tools are hidden with it off. Tool files get exactly the helpers they use and stay a readable size |

When you move a function between modules or add a route or an MCP tool on purpose, the pinned
list in the matching test changes with it, in the same commit.

Three helpers in `src/test/helpers/` keep these tests off the running app:

| Helper | Does |
|---|---|
| `route-table.js` | reads the ordered route table from source, because requiring `app.js` boots the server |
| `mcp-source.js` | returns `mcp.js` and every `mcp/*.js` as one string for tests that pin wiring by source |
| `client-store-resolve.mjs` | lets `node --test` import client store code written for the bundler |

## Live Agent Suite

`npm test` never reaches docker, so it cannot prove the thing Paddock exists to do: open an
agent TUI in a PAD's tmux, type into it, press Enter, prove the text arrived and read the reply.
`live/opencode.live.test.js` does that against a real opencode PAD, through the webui's HTTP API
exactly as the page does, and checks every answer with read-only reads of opencode's own store
(the same `readTurn` / `readActivity` the runner trusts; it never opens the app database).

```
docker exec -e LIVE_PAD=pad-dev paddock npm run test:live
docker exec -e LIVE_PAD=pad-dev -e LIVE_SAVE_SCREENS=1 paddock npm run test:live   # also keep screens
```

| Step | Proves |
|---|---|
| 1–2 | A project and session start a real TUI in tmux; the conversation id is known from the first read; the ready footer paints; the app says it can send |
| 3 | The usage-limit detector reads a healthy screen as healthy (a real limit stops the run with that verdict) |
| 4 | A message is confirmed from the store, its stored text hashes to exactly what was sent, the turn finishes, and the reply is read back |
| 5 | Quotes, `$(…)`, backticks, `; && \| >`, unicode and emoji arrive verbatim, and nothing executes in a shell |
| 6 | A ~1500-character line arrives whole |
| 7 | A message sent while the agent is busy is not lost: the second input becomes newest and is answered |
| 8 | When the TUI exits the app sees a shell, refuses to type into it (`mission_not_an_agent`), and Relaunch resumes the SAME conversation |
| 9 | Close removes the tmux session and a later send is refused |

It costs a few short turns on the PAD's model. It creates one throwaway project and folder,
removes both, and fails if any tmux session that existed before it is gone afterwards. Steps
depend on each other; after a failure the rest skip and name it. `LIVE_TURN_MS` raises the
per-turn wait for a slow model.

Screens saved with `LIVE_SAVE_SCREENS=1` land in `live/captures/<time>/` (gitignored). The ones
that pin the detectors live in `test/fixtures/opencode-screens/`, and `opencode-screens.test.js`
(part of `npm test`) asserts what `tuiReadyPattern`, `tuiBusyPattern`, `screenUsageEvidence` and
`detectPermission` must say about each. After an opencode upgrade, re-run the live suite with
screen saving and copy the new captures in; a red offline test names the detector to fix.

## Orchestrator Chat Test

The live suite proves the pane mechanics; this proves an LLM can run Paddock with the MCP alone.
Claude Code (or any MCP client) acts as the orchestrator, with a least-privilege key and no other
tools while it plays the part:

1. Profile → API keys: a key with `tools:create,tools:exec,target:agent:<pad>`.
2. `claude mcp add --transport http -s local paddock_dev http://<host>:6789/mcp --header
   "Authorization: Bearer <key>"`, then restart the client (tools load at startup). Name each
   server after the instance it reaches (`paddock_dev`, `paddock_live`): the tools of two
   servers called alike are indistinguishable to the LLM, and a call meant for a test pad must
   never land on a live one. A key for a live instance starts as `read`.
3. A project to work in. "Paddock develops Paddock": clone this repo into the PAD's workspace
   (`instances/<pad>/opencode/workspace/paddock-self`) and remove its `origin`, so the worker
   edits real web code without touching the live source the webui runs from.
4. As the orchestrator: `help` → `mission_project_create` → `plan_write` plans that each must
   stop and ask (`need_input` with the question) → `runner_create {project_id, name, plans}` →
   `runner_start` → poll `runner_get`; answer `blocked` items with
   `agent_queue_resolve_need_input`, permission dialogs with `mission_permission_answer`.
5. Log every guess in `friction/YYYY-MM-DD-<slug>.md`, fix, re-run the part that failed.

The first run (2026-11-13, `friction/2026-11-13-orchestrator-self-project.md`) completed three
plans with three answered questions and two rejected permission dialogs, and found the
permission-stop strand and the adopted-turn ownership bug.

## Rebuild the Client After Client Edits

The page serves the built bundle in `src/public/`, so a page that renders can be running code
that is no longer the code on disk. After any edit under `src/client/`:

```bash
cd src/client && npm run build
docker restart paddock
```

The build writes `src/public/build-stamp.json`, a hash of the client's inputs.
`client-bundle-fresh.test.js` recomputes it and fails with
`the client source changed after the bundle was built` when you skipped the build, or with
`src/public/build-stamp.json is missing` when there is no bundle. How the stamp is computed is
in [Operations](overview.md#production-build).

## See Also

- [Operations](overview.md) — dev workflow, builds and restarts
- [PAD Lifecycle Rules](../backend/pad-lifecycle.md) — the rules the seams above stand in for
- [Backend Services](../backend/services.md) — the modules under test
