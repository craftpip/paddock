# Security Model

This page states who may do what in the Paddock webui: the two roles, the settings only an admin
may turn on, how requests are protected, what is redacted before it leaves the process, and how
files, tokens and keys are handled. It is for anyone changing a route, a service that writes files,
or a surface an LLM (large language model) reads.

> Last updated: 2026-11-12

## Roles And What Each May Do

A user is an `admin` or a regular user (`session.role`). A PAD (one agent instance) has one owner,
`agents.owner_id`. With `AUTO_LOGIN=true` every request runs as the first admin, so none of the
limits below apply to that install.

| Area | Routes | Admin | Regular user |
|------|--------|-------|--------------|
| A PAD's own routes | `/api/agents/:name/*`, `/ws/terminal/:name` | every PAD | PADs they own |
| PAD list and counts | `GET /api/agents` | every PAD, orphan count | PADs they own |
| Containers, fleet stats | `GET /api/containers`, `GET /api/agents/stats/fleet` | all | PADs they own |
| Control-plane `.env` | `/api/env`, `/api/env/restart`, `/api/env/recreate` | yes | 403 |
| Host path probes | `/api/paths/*` | yes | 403 |
| Vault | `/api/vault`, `/api/vault/*` | yes | 403 |
| Runner callback scripts | `PUT /api/mission/runners/:id/callbacks` | yes | 403 |
| Users | `/api/users`, `/api/users/:id/*` | yes | 403 |
| PAD owner assignment | `POST /api/agents/:name/assign` | yes | 403 |
| Host powers on a PAD | create and settings fields | yes | refused |

Reasons the admin-only rows are admin-only:

- **`.env` and path probes** read or change the host: its directories, the control plane's
  environment, the webui container itself. `routes/system.js` puts `requireAdmin` on both prefixes.
- **The Vault** is one shared store with one PIN. A regular user who could reach it could set the
  PIN first, or overwrite and delete items they cannot read. `routes/vault.js` puts `requireAdmin`
  on the whole prefix.
- **Runner callback scripts** run as root in the control plane, beside the docker socket, so saving
  one is an admin act.

### How A Regular User Only Sees Their Own PADs

- `app.param('name')` in `app.js` runs on every route with a `:name` segment and answers
  `403 Access denied` unless the caller is an admin or owns that PAD.
- `registry.discoverAgents(ownerId)` and `registry.getAgentStats(ownerId)` filter by owner. The
  list route passes the session's user id for a regular user and `null` for an admin.
- `GET /api/containers` and `GET /api/agents/stats/fleet` keep only the entries whose name is one of
  the caller's PADs. An admin sees every container, because any of them can be a network peer.
- The terminal WebSocket checks the session and the owner before it inspects Docker, so a refusal
  does not reveal whether the PAD exists.
- The creator of a PAD owns it from the moment the create is accepted: `claimPendingOwner` records
  the intended owner, and the `:name` gate honours that claim while the PAD has no database row or
  no owner yet. The creator can therefore read their own create log, and can still see and delete
  the PAD if the create fails part-way.
- Only a PAD's owner may make it an orchestrator (`not_pad_owner`, 403), because the key written
  into the PAD carries the conferring user's reach.

## Host Powers

Five PAD options reach past the PAD into the host. `src/services/host-powers.js` names them and
holds the one check every way in calls.

| Option | Request field | Why it is a host power |
|--------|---------------|------------------------|
| Docker access | `allowDocker` | mounts the host's docker socket: host root |
| Host workspace folder | `workspace_host` / `workspaceHost` | binds a host directory of the caller's choosing |
| Extra volumes | `extraVolumes` | the same, several times |
| Network peer | `network` | joins another container's network namespace |
| Build commands | `buildCommands` | run as root during the image build, on the host's daemon |

| Way in | Where the check runs | Role comes from |
|--------|----------------------|-----------------|
| REST create | `POST /api/agents/create` | the session |
| REST settings | `prepareAgentChanges` (`settings-apply.js`) | the session |
| MCP `create_agent` | `mcp/tools-agents.js` | the API key's user |
| MCP recreate | `applyAgentChanges` → `prepareAgentChanges` | the API key's user |

Rules:

- **The check fails closed.** `assertAllowed(role, names)` refuses whenever the role is not exactly
  `admin`, which includes a caller that passed no role at all.
- **The role never comes from the request body.** The settings route overwrites any `actorRole` in
  the body with the session's role.
- **Turning a host power off is always allowed**, and so is re-sending its current value: the
  settings form posts every field, so only a field that changes to a filled value counts.
- A refusal is a `HostPowerError`: status 403, code `admin_required`, and a message that names the
  options, for example `Only an admin can set: docker access, extra volumes.`

A regular user keeps everything inside their own PADs: lifecycle, terminal, files, config and
Mission.

## Request Protection

### Session Auth

Every path needs a signed-in session except `/api/setup`, `/api/login`, `/api/session`, `/login`,
`/setup`, the docs site under `/website`, and the two MCP endpoints `/mcp` and `/mcp/runner`, which
authenticate with a bearer key instead of a cookie. Details are in [middleware](middleware.md).

### CSRF

One middleware on `/api` checks the session's cross-site request forgery (CSRF) token on every
request that is not `GET`, `HEAD` or `OPTIONS`. It is enforced once for the whole prefix, not per
route, so a new route cannot forget it.

| Item | Value |
|------|-------|
| Token source | `GET /api/session` → `csrfToken` |
| Accepted in | the `x-csrf-token` header, or `_csrf` in the body |
| Exempt | `POST /api/login`, `POST /api/setup` (no token exists yet) |
| Not covered | `/mcp`, `/mcp/runner` (not under `/api`; bearer key, no cookie) |
| Refusal | `403` with `{ "error": "CSRF token invalid" }` |

The reason it is global: a browser attaches the session cookie to a form posted from any origin,
and under `AUTO_LOGIN` no cookie is needed at all, so an unchecked state-changing route is writable
by any page the operator visits.

### WebSocket Origin Check

A browser sends `Origin` on a WebSocket handshake and does not apply the same-origin policy to it.
The terminal WebSocket therefore compares the `Origin` header's host with the request's `Host`
header and closes the socket with code `1008` (`Cross-origin connection refused`) when they differ
or the `Origin` is malformed. A handshake with no `Origin` is not a browser and passes on to the
session and owner checks.

### Failing Handlers And Rate Limiting

Every handler registered on the app is wrapped once, in `app.js`, so a rejected promise or a throw
reaches the JSON error handler and the request gets an answer instead of hanging until the client
times out. The per-IP rate limiter is described in [middleware](middleware.md); its refusal (429
with `Retry-After`) and the CSRF refusal are both JSON.

## What Leaves The Process Redacted

`src/services/vm-manager/config-redaction.js` holds the redactor. The MCP `config_get` tool reads a
PAD's config with `redact: true`, and the session-transcript reader (`agent-store.js`) passes its
output through `redactSecrets`. A redacted value is the string `[REDACTED]`.

### JSON Config

Redaction is by the shape of the key, not by a fixed list of names. A key is first normalised, so
`apiKey`, `api_key` and `API-KEY` are one word.

| Rule | Examples |
|------|----------|
| The key is, or ends in, a credential word | `token`, `apiKeys`, `rootPassword`, `x-mcp-key`, `anthropic_auth_token` |
| The key names a header or environment map: every value under it is redacted | `headers`, `httpHeaders`, `env`, `environment` |
| A `*_key` that is a noun stays readable | `sortKey`, `cacheKey`, `primaryKey` |
| A token count stays readable | `max_tokens: 4096` |
| An empty value stays empty | `apiKey: ""` |
| A string value is scrubbed line by line with the text scrub | a transcript line holding `API_KEY=…` |
| Nesting deeper than 16 levels is replaced whole | fails closed |

The suffix rule is deliberate: a rule that matched a credential word anywhere in the key would hide
`tokenLimit` and `passwordPolicy`, which a reader needs. A count is told apart from a credential by
its value: a key ending in `token` or `tokens` whose value is a bare number is a count.

### YAML And TOML Text

These formats have no parser on this path, so `redactConfigText` reads lines and keeps track of
where it is, because the key that makes a value secret is often not on the value's own line.

| Shape | Example | Result |
|-------|---------|--------|
| TOML table whose path names a secret map | `[mcp_servers.db.env]` | every value in the table |
| YAML parent key | `http_headers:` with indented children | every child value; nested map keys keep their shape |
| YAML list | `api_keys:` then `- sk-live-1` | each item |
| YAML block scalar | `password: \|` then indented lines | one `[REDACTED]` line stands in for the block |
| TOML multi-line string or array | `token = """` … `"""` | the whole value, to its closing delimiter |
| Token count | `max_tokens: 4096` | not redacted |

A secret section ends at the next TOML table, or at the first YAML line indented no deeper than the
key that opened it. Comments and blank lines pass through.

### The Operator's Own Config Editor

`GET /api/agents/:name/config` deliberately returns `configRaw` unredacted. The web UI's config
editor sends that text back on save, so redacting it would write `[REDACTED]` into the real config.
That route is session-authenticated and owner-gated; it is not the surface an LLM reads.

### Control-Plane Environment

`GET /api/env` never returns the value of `SESSION_SECRET`, `VAULT_KEY` or `AUTH_PASSWORD`; it
sends a fixed mask. `POST /api/env` refuses a variable name that is not a plain identifier and a
value containing a line break, because one `KEY=value` per line is the file's whole grammar and a
line break would write a second variable. `VAULT_KEY` is locked against edits from this route.

## Files Written As Root

The webui runs as root and writes into directories an agent also controls, so every root write
treats a symlink as hostile.

### Ownership Helpers

`src/services/ownership.js` hands files to `PUID:PGID` (default `1000:1000`).

| Helper | Guarantee |
|--------|-----------|
| `ensureOwned` | `lstat`, skips symlinks, changes owner with `lchown`; never throws |
| `ensureOwnedStrict` | the same, but throws an `OwnershipError` (`ownership_symlink_refused`, `ownership_chown_denied`, `ownership_chown_failed`, `ownership_verify_failed`) |
| `mkdirOwned` | boundary check first; chowns only the directories it created |
| `writeFileOwned` | refuses a symlink target, checks the boundary, opens with `O_NOFOLLOW` |
| `atomicWriteOwned` | writes an exclusively created temp file, chowns it, then renames it into place |
| `normalizeTree` | recursive; symlinks are skipped, never followed |

- **`lchown`, not `chown`.** Between the `lstat` and the ownership change a path can be swapped for
  a symlink by anything that can write the directory. `lchown` can only touch the path itself.
- **`O_NOFOLLOW` on open.** The `lstat` is a check; the open flag is the guarantee. A link swapped
  in between makes the open fail and is reported as `ownership_symlink_refused`.
- **Boundary checks.** Each write names a `boundary`. The target is resolved through every symlink
  (the deepest existing ancestor, plus the missing tail) and must stay inside it, else
  `ownership_path_escape`. A write with no boundary is refused: `ownership_boundary_missing`.
- **The vault key file stays root-owned.** `ensureDataOwned` normalises `src/data/` but skips
  `vault.key`: handing it to uid 1000 would let a user-mode PAD that can see the directory read it.

### Host-Scope Workspace Paths

`resolveHostPath` in `src/services/workspace.js` resolves a path for a file operation that runs in
the control plane. The PAD controls what is inside its own folder, symlinks included, so the check
is on the real path, and its strictness depends on what the caller is about to do.

| Mode | Used by | Outside the PAD's folder | Other refusals |
|------|---------|--------------------------|----------------|
| `list` | directory listing | lands on the folder itself | — |
| `read` | read, download | refused | an empty path |
| `write` | create, replace, move target | refused | an empty path (the target may not exist yet) |
| `destroy` | delete, rename, move source | refused | an empty path; the PAD's folder itself |

In every mode a path that leaves the folder through a symlink is refused with
`That path leads outside this PAD's folder through a symlink`.

For `destroy` the entry's parent is what must resolve inside the folder, because deleting or
renaming a symlink acts on the link and not on what it points at. A link inside the PAD can
therefore be removed, but nothing can be deleted through it.

## Tokens And Keys

| Credential | Shape | Stored as | Ends when |
|------------|-------|-----------|-----------|
| User API key | `pk_live_…` | sha256 hash (`api_keys.key_hash`) | the user deletes it |
| Runner MCP token | `prk_` + 48 hex characters | sha256 hash (`runner_mcp_tokens.token_hash`) | re-minted, or the PAD is deleted |
| Vault server key | 32 bytes | `VAULT_KEY`, or `src/data/vault.key` | see [Vault](vault.md) |

User API keys and their grants are documented in [services](services.md) and
[user management](user-management.md).

### Runner MCP Tokens

`src/services/runner-mcp-token.js` issues one token per PAD for the `/mcp/runner` endpoint. A token
identifies a PAD, not a user. Minting replaces the PAD's previous token. Only a value that starts
with `prk_` is looked up, so a user API key presented at `/mcp/runner` is refused with a JSON 401.
The raw value exists only in the mint result and in the PAD's own MCP config.

`removeAgentFromDb` revokes the token when the PAD is deleted. A copy left in an old config or a
backup therefore stops authenticating, and cannot become bound to a PAD created later under the
same name.

### The Connect Paddock MCP Scripts

Each driver's `mcp.buildConnect` returns a shell script that the Commands pane pastes into the
docked terminal. `bootstrap()` in `src/services/drivers/mcp-util.js` wraps it.

- **The key is typed at a silent prompt.** The script prints `Paddock API key:`, turns echo off
  with `stty -echo`, reads one line into `PADDOCK_MCP_TOKEN`, and unsets it at the end. The key is
  never pasted, never part of the command text, and never held in frontend state.
- **The script exits with the status of its steps.** The steps run in a subshell under `set -e`;
  the script records that status, unsets the variable, and ends with `( exit $status )`, which sets
  the exit status without closing the terminal. A failed wiring is therefore reported as a failure.
- **Every URL, name and script body is shell-quoted** by `sq()`; callers never concatenate text.

| Driver | Patch | Stops and changes nothing when |
|--------|-------|--------------------------------|
| codex | in `[mcp_servers.paddock]` only, swaps `bearer_token_env_var` for a static `http_headers` line | the table or that line is missing; the key is empty or has characters a TOML string cannot carry |
| picoclaw | sets `tools.mcp.servers.paddock` in `config.json` | the file is not valid JSON, or is not a JSON object |
| hermes | sets `mcp_servers.paddock` in `config.yaml`, and the key in `/opt/data/.env` | the file is not a YAML mapping |

The codex patch stops at the next TOML table header, so another MCP server's own
`bearer_token_env_var` is never rewritten: the Paddock key is not sent to a third party, and that
server keeps its credential. For picoclaw and hermes a missing or empty config file is a fresh
config, not an error.

## Volume Discovery Never Inherits The Docker Socket

`GET /api/paths/volumes` lists the volumes a project folder's compose file and containers expose,
to pre-fill the Create Agent form. `isDangerousSource` in `src/services/path-probe.js` drops a
source from that list, both from the compose file and from live container mounts, when it is:

- a path with a `docker.sock` or `containerd.sock` segment, under any directory (`/var/run` is a
  symlink to `/run` on current distributions, so `/run/docker.sock` is the same socket);
- `/run/docker`, `/run/containerd`, or anything beneath them;
- a host directory the workspace guards refuse as a source, such as a bare home or scratch root.

Docker access for a PAD is only ever the explicit `allowDocker` host power.

## See Also

- [Middleware](middleware.md) — session setup, `requireAuth`, `requireAdmin`, the rate limiter
- [Vault](vault.md) — the server key, the PIN and the vault routes
- [User management](user-management.md) — owner scoping and the user routes
- [Services](services.md) — API keys, path probing, ownership sweeps
- [Mission queue](mission-queue.md) — the `/mcp/runner` surface the runner token opens
- [Drivers](drivers.md) — the per-type `mcp` objects
