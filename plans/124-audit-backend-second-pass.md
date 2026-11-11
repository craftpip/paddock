# Plan 124 — Audit fixes: backend second pass

## Status: Complete — 2026-11-12 — 14/14 review findings fixed, plus 5 defects found while proving them; to be absorbed into docs/

## Why

A second read-only review (2026-11-11) of the backend files the first passes
(plans 121–123) did not cover: `vault.js`, the driver MCP patches,
`container-health.js`, `net-peer.js`, `config-redaction.js`, `ownership.js`,
`agent-registry.js`, `subnets.js`, `runner-mcp-token.js`, `task-pipeline.js`,
`path-probe.js`. Each finding was confirmed in the code before it was changed.
Checked and found clean by the reviewer: `api-keys.js`, `runner-publication.js`,
`runner-history.js`, `backup-manager.js`.

## Findings and fixes

Severity: H = high, M = medium, L = low.

| # | Sev | What was wrong | Fix | Proof |
|---|---|---|---|---|
| 1 | H | With `VAULT_KEY` unset the vault key fell back to a string that is in the source, so a copy of the database was enough to read every item | No built-in fallback. The key is `VAULT_KEY`, else a random key generated once into `src/data/vault.key` (0600, root-owned, git-ignored). A store written under the old fallbacks is re-encrypted on first use; if an item opens with no known key, nothing is changed and no key file is left | `vault.test.js` (6 tests) + live: created and read an item, key file `-rw------- root` |
| 2 | H | Connecting a codex PAD rewrote **every** MCP server's `bearer_token_env_var` to the Paddock key, sending that key to third-party servers and destroying their own auth | The patch touches only the `[mcp_servers.paddock]` table, refuses a key a TOML string cannot carry, and fails when there is nothing to patch | `driver-mcp-patch.test.js` + mutation control |
| 3 | M | Once a PIN was set, the master key was protected by the 4–6 digit PIN alone | The wrap key is derived from the PIN **and** the server key, at a higher scrypt cost. An old PIN-only wrap is upgraded the first time the right PIN is used | `vault.test.js` + mutation control (the first version of the test could not fail; fixed) |
| 4 | M | Changing the PIN demanded the old PIN and then erased every item anyway; a forgotten PIN could not be reset at all | Change (old PIN + password) re-wraps the same key: nothing is lost. A separate "Forgot the PIN?" path (password only) is the one that erases, and says so. Both run in one transaction | `vault.test.js` + browser (both dialogs, request stubbed so the real vault was not altered) |
| 5 | M | The health check reported "container not found — recreate" and "no compose file — recreate" whenever docker did not answer | Three answers, not two: found, not found, **could not check** (with docker's own words). A compose file that exists but does not resolve says so and says it is not a reason to recreate | `container-health-probe.test.js` (fake docker) + 3 mutation controls + live report on `pad-dev` unchanged |
| 6 | M | A PAD whose compose file declares peer networking but which runs on its own bridge (or the reverse) showed a green "Network mode" row | The kind of networking is compared first; a mismatch is an error with "recreate to apply" | same file + mutation control |
| 7 | M | The YAML/TOML redactor judged each line alone, so secrets in an `env`/`headers` table, a list, a block scalar or a multi-line value were returned verbatim to read-scope API keys | The scrub tracks the TOML table and the YAML parent key; everything inside a secret section is redacted. Plural names (`apiKeys`, `tokens`, `secrets`, `passwords`) are credentials; a token **count** (`max_tokens: 4096`) is not | `config-redaction-text.test.js` (10 tests) + 2 mutation controls |
| 8 | L | Root `chown` and file writes followed a symlink swapped in after the check | `lchown`, and files are opened with `O_NOFOLLOW` | existing ownership suites green; the race itself is not reproducible in a test |
| 9 | L | A failed `docker ps` made every PAD "missing" and wrote that to the database | A failed listing yields `unknown`, never overwrites recorded status, and a stale good answer is trusted for 30 s only | `agent-registry-probe.test.js` + 2 mutation controls |
| 10 | L | The subnet picker ignored foreign networks wider than a /24 and treated a failed listing as "nothing used" | Every pool /24 a network overlaps is counted; a failed listing is an error | `subnet-pool.test.js` + mutation control |
| 11 | L | A deleted PAD's runner MCP token kept working | Revoked when the PAD is removed | test + mutation control |
| 12 | L | After a webui restart `task_pipeline_status` said "start it" while `task_pipeline_start` refused | Status and the refusal both name the way out (`task_pipeline_stop`, then start). A run stopped during its last await stays stopped | `task-pipeline.test.js` + mutation control |
| 13 | L | The picoclaw patch replaced an unreadable `config.json` with just the MCP block; the hermes patch crashed on an empty file | Picoclaw stops and changes nothing; hermes treats an empty file as an empty config | `driver-mcp-patch.test.js` + mutation control |
| 14 | L | Volume discovery only recognised the socket as `/var/run/docker.sock` | Recognised under any path (`/run/docker.sock`, any `docker.sock` / `containerd.sock`) | code read; admin-only surface |

## Found while proving the above

| What | Fix |
|---|---|
| **Every "connect Paddock MCP" script exited 0 even when it failed**, because it ended with `unset`. A failed wiring was recorded as a success and the orchestrator kept a full-reach key for a PAD that never got it | The steps run under `set -e` in a subshell and the script ends with their status. Test + mutation control |
| **A test of mine (plan 122) created a real container, image and network named `pad-input` on every suite run**, by letting an unstubbed call reach `docker compose`. Against the project rule on test containers | The lock is tested against a stand-in. The container, network, image and folder were removed |
| `vm-manager.test.js` wrote `instances/pad-x/build/` into the real instances directory (the env was set when the file was read, not when the test ran) | Env set around each test; stray folder removed |
| `scripts/mutate.sh` counted only failed tests, so a mutant that made a test hang was called "green"; and (plan 120) it symlinked `client/` so client mutations edited the worktree | Cancelled tests count as red; client sources are copied |
| The dashboard counted database rows, so a row left by a PAD whose folder is gone showed "2 agents" for one PAD | Counts come from the PADs that exist |
| The vault PIN was sent in the URL of the decrypt request | Sent in a header |
| No limit on wrong PINs (noted as not built in plan 121) | Five wrong PINs lock the vault for 30 s, doubling to 15 min; the right PIN is refused too while locked. 3 tests + mutation control |

`npm test` now also fails any test file after which a new container, network,
image or `instances/` entry exists on the host.

## Not done, on purpose

- `pad-opencode-proj` has a folder and a database row but no `meta.env` and no
  container. It predates this work, so it was left alone. It is no longer
  counted on the dashboard.
- The key file sits beside the database. That stops a database-only copy from
  being enough, not a copy of the whole data directory; set `VAULT_KEY` in
  `.env` to keep the key elsewhere.
- #12's related note (a prompt typed twice if a stop and a start race one
  in-flight send) is not changed: each run has its own record and the old one
  stops at its next check.

## Results

`npm test`: 80 files, 1297 tests, 0 failing, no leftovers on the host.

## Progress

- [x] 1 Vault key: no built-in fallback
- [x] 2 Codex patch scoped to its own table
- [x] 3 PIN wrap needs the server key
- [x] 4 Change PIN keeps items; forgot-PIN path
- [x] 5 Health: "could not check" is not "not found"
- [x] 6 Health: network kind drift
- [x] 7 YAML/TOML redaction is section-aware
- [x] 8 lchown / O_NOFOLLOW
- [x] 9 Failed docker listing is `unknown`
- [x] 10 Subnet pool overlap
- [x] 11 Runner token revoked on delete
- [x] 12 Pipeline status/start agree
- [x] 13 Picoclaw / hermes patches
- [x] 14 Socket recognised under any path
- [x] Connect scripts report failure
- [x] Tests no longer touch the real host; runner checks for leftovers
- [x] Wrong-PIN lockout
