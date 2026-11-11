# Plan 121 — Audit fixes: authorization, CSRF and the HTTP surface

## Status: In progress — 2026-11-11 — 0/19 findings fixed; all traced in code by a read-only review, none yet reproduced

## Why

A read-only review of `app.js`, `routes/`, `middleware/`, `mcp.js`, `mcp/` and
the key/orchestrator/vault services on 2026-11-11. "Confirmed" below means
traced in code; nothing was run. **Each finding is reproduced against the
running app (as a throwaway non-admin user where the finding is about roles)
before it is fixed, and re-run afterwards to show the refusal.**

How the global guards work today, which decides what is a gap:

- **Auth:** `app.js` requires a session on everything except the public
  paths. Under `AUTO_LOGIN=true` (the dev default, deliberate) every request
  is the admin.
- **Ownership:** `app.param('name')` enforces admin-or-owner on every route
  with `:name`. A route without `:name` gets no role or owner check unless it
  adds one.
- **CSRF:** `csrfCheck` is opt-in per route.

## Decisions taken (the owner said to proceed alone)

- **Host-level powers are admin-only.** Mounting the docker socket
  (`allowDocker`), host bind mounts, build commands, runner callback scripts
  (they run as root in the control plane, by plan 92's design), the `.env`
  editor, the vault, container/fleet listings and host path probing. A
  single-admin install loses nothing. A regular user keeps: their own PADs'
  lifecycle, terminal, workspace, config, Mission projects, sessions, runners
  and queues.
- **CSRF becomes global** for non-GET `/api/*`, with `/api/login`,
  `/api/setup` and `/mcp*` exempt (the MCP surface authenticates with a bearer
  key, not a cookie).
- **The SPA already sends `x-csrf-token` on every call through `lib/api.js`.**
  Any place that posts without it (uploads via `XMLHttpRequest`/`FormData`) is
  fixed in the same change, or the change breaks uploads.

## Findings

Severity: H = high, M = medium, L = low.

| # | Sev | Where | What is wrong | Scenario |
|---|---|---|---|---|
| 1 | H | most routes outside mission/vault/keys/orchestrator; terminal WS (`app.js`) | No CSRF check on state-changing routes; WebSocket has no `Origin` check | A page on another origin posts a form to `/api/users` or `/api/agents/<pad>/exec` while an admin is signed in; under AUTO_LOGIN no cookie is even needed |
| 2 | H | `routes/system.js` `/api/env`, `/api/env/restart`, `/api/env/recreate` | No `requireAdmin`; GET returns `rawValue` for masked secrets; values may contain newlines | A regular user reads `VAULT_KEY`, sets `AUTO_LOGIN=true`, restarts, is admin |
| 3 | H | `routes/mission-runners.js` callbacks PUT; run by `services/runner-callbacks.js` | Any PAD owner can save a script that runs as root in the control plane | Save a `destroy` callback, delete the runner, script runs next to the docker socket |
| 4 | H | `routes/agents.js` `GET /api/vms` | Lists every PAD with its root password and SSH port, no role or owner filter | A regular user reads every PAD's root password |
| 5 | H | `routes/agent-workspace.js` host-scope read/list/download/media/delete/rename/move via `services/workspace.js` `resolveHostPath` | Path checked lexically, then `fs.*` follows symlinks as root | A PAD owner makes `ln -s /workspace x` in their PAD, then reads `x/.env` or deletes another PAD's files |
| 6 | H | `routes/agents.js` create, `routes/agent-settings.js` settings, `mcp/tools-agents.js` create/recreate | `allowDocker`, `workspace_host`, `extraVolumes`, `buildCommands` accepted from any user | A regular user creates a PAD with the docker socket and has host root |
| 7 | M | `routes/vault.js` | Only decrypt is admin-only | A regular user sets the PIN first and locks the admin out; PUT is a PIN oracle |
| 8 | M | `services/orchestrator.js` confer / removeConferral | The key is minted for the caller, not the PAD's owner, and revoked by name | An admin confers on a user's PAD and that user now holds a full admin key; a second admin's removal leaves the key valid |
| 9 | M | `routes/auth.js` password reset and user delete | Both reference a `user_sessions` table that does not exist | Reset changes the password then answers 500; delete orphans the user's PADs then fails, user not deleted |
| 10 | M | `routes/agents.js` start/stop/restart, `/api/vms`; `routes/agent-integrations.js` | Async handlers with no `catch` | A PAD that cannot start leaves the request hanging until the client times out |
| 11 | M | `app.param('name')` with create | The owner is assigned only after create finishes, never if it fails | A regular user gets 403 on their own create log; a failed create leaves an ownerless PAD they cannot see or delete |
| 12 | M | `routes/agent-integrations.js` `mcp/test-url` | The control plane fetches any URL the caller gives | A PAD owner maps internal services from the control plane's network position |
| 13 | L | `routes/agents.js` onboard; `runCmd` in `app.js` | `input` is ignored by `execFile`; error text echoes argv | Onboarding with an API key waits 30 s and fails; a bot token can appear in the error |
| 14 | L | `/api/containers`, `/api/agents/stats/fleet`, `/api/paths/*` | No role or owner scoping | A regular user lists every container on the host and browses host directories |
| 15 | L | `routes/agent-integrations.js` DELETE terminal session; `safeSessionName` | An invalid id falls back to `main`; `msn-*` ids accepted | Deleting `bad id` kills `main` and answers ok |
| 16 | L | `middleware/rateLimit.js`, `middleware/auth.js` | `res.render` with no view engine | Over the limit, the client gets 500 instead of 429 |
| 17 | L | `routes/agent-workspace.js` `upload-multiple` | Memory storage, 2000 files × 100 MB, no total cap | A PAD owner exhausts the control plane's memory |
| 18 | L | `routes/agent-integrations.js` MCP toggle / probe / list | `serverName` and `cfg.url` unquoted in `sh -lc` | A server name with `;` runs an extra command in the caller's own PAD |
| 19 | L | `mcp/tools-mission.js` | Gates on the resolved PAD name, then passes the caller's raw spelling on | A display-name spelling passes the gate and then fails or returns nothing |

## Checked by the reviewer and found guarded

`:name` ownership on every `/api/agents/:name/*` route; Mission and runner
REST routes (row → project → `canTouchAgent`); the terminal WebSocket's auth,
owner check and name validation; MCP key hashing, grants, fail-closed
unclassified tools; MCP redaction on `get_agent` / `config_get` /
`settings_get`; the runner MCP's token scoping; parameterised SQL throughout;
workspace **writes** (realpath-bounded, symlinks refused); password and key
hashing.

## How each fix is proven

- A throwaway regular user (`audit-user`) is created through the app, given
  one throwaway PAD, and used for every role finding: request before the fix
  (shows the gap), same request after (shows 403). Both are deleted at the end.
- CSRF: a POST with a valid session and no token is 403 on every state-changing
  route; the SPA still works end to end in the browser (create a session, save
  settings, upload a file).
- Symlink escape: a link is made inside the throwaway PAD and each host-scope
  operation is tried through it.
- Tests: `route-table.test.js` gains a check that every non-GET `/api/*` route
  is behind the global CSRF middleware and that each route in the admin-only
  list carries `requireAdmin`.
- `npm test` green.

## Progress

- [ ] 1 Global CSRF for non-GET `/api/*`; WebSocket `Origin` check
- [ ] 2 `.env` routes admin-only; no raw secrets; no newlines in values
- [ ] 3 Runner callbacks: admin-only to save or enable
- [ ] 4 `/api/vms` removed or owner-filtered without passwords
- [ ] 5 Host-scope workspace operations realpath-checked
- [ ] 6 Host-level create/settings options admin-only (REST and MCP)
- [ ] 7 Vault admin-only; PIN attempt lockout
- [ ] 8 Orchestrator key minted for the owner, revoked by id
- [ ] 9 User reset/delete without the missing table; sessions ended
- [ ] 10 Async handlers answer on failure
- [ ] 11 Creator owns the PAD from the start, and after a failed create
- [ ] 12 `mcp/test-url` cannot reach private addresses
- [ ] 13 Onboard key paste uses stdin properly; no argv in errors
- [ ] 14 Containers, fleet stats, path probing scoped
- [ ] 15 Terminal-session delete validates the id
- [ ] 16 Rate limit and CSRF refusals answer JSON 429 / 403
- [ ] 17 Upload limits
- [ ] 18 MCP server names shell-quoted
- [ ] 19 Mission MCP tools pass the resolved PAD name on
