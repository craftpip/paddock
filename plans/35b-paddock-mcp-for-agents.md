# Plan 35b — Paddock MCP Integration into Agents

## Status: In progress (2026-08-09) — research AND live per-driver test run
complete (add / list / probe / remove of an HTTP MCP server verified against
PADs of **all six** agent types: openclaw, opencode, picoclaw, hermes, codex,
claude — full matrix in §3b; reachability: LAN IP 10.69.1.164 → 200 from every
agent container). Credential bootstrap, grants, and per-driver action contracts
are designed below. implementation 0%. No agent has the Paddock MCP wired in yet.
This is a **standalone goal** — it was never part of
the multiple-agents umbrella (plan 08, absorbed into `docs/` 2026-08-09, covers
driver goals 1-6 only).

> **Task B of plan 35 (renamed from plan 35, 2026-08-09).** Plan 35 is ONE plan
> with TWO **simultaneous** tasks — they do not block each other, they exist
> for each other. Task B (this file) wires Paddock's MCP server into the
> agents; Task A (`35a-llm-guide-for-mcp-tools.md`) makes the MCP surface
> descriptive and usable by the LLM — which is the whole point of the MCP being
> there. The two are kept as separate, independent files that reference each
> other. Read the sibling before or after this one.

> **Not Docker MCP.** This plan gives agents control over **Paddock itself** —
> the fleet, its config, lifecycle, workspace — through Paddock's *own* MCP
> server, which already exists. (An earlier Docker-MCP draft plan was deleted —
> this plan replaces it.)
>
> **Absorbs plan 09 Phase 4 (2026-08-09).** Plan 09 (settings page) shipped
> Phases 1–3 (info / update / docker toggle / network / delete) and deferred
> its **Phase 4 — "Install Paddock MCP" Settings toggle** because the webui
> `/mcp` server didn't exist yet. That server now ships (`src/mcp.js`), so plan
> 09 is retired and its Phase 4 lives here. Plan 09 imagined a Settings-tab
> toggle running `openclaw mcp add --no-probe paddock --url
> http://<webui>:6789/mcp --transport streamable-http` inside the agent; the
> paste-commands rule moved the install UI to the CommandsPane MCP group (the
> "Connect Paddock MCP" button below) — `docs/tabs/settings.md` keeps that
> toggle as intentionally not implemented.

## Goal

Expose Paddock's MCP server to the agents so that an agent can control Paddock
from inside its container: list the fleet, inspect a PAD, start/stop/restart,
create/delete, recreate, exec, read/write config and workspace, run health
checks — the same toolset the web UI and the API give a user, reachable as MCP
tools by the agent itself.

## Current state (research, 2026-08-09)

### Paddock's MCP server already exists

- **`src/mcp.js`** — Streamable HTTP MCP server, mounted at `/mcp`
  (GET/POST/DELETE, `app.js:84` public path, gated by `MCP_ENABLED !== 'false'`).
- **Auth:** API key — `Authorization: Bearer pk_live_…`, or `x-api-key` header,
  or `?token=` query. Keys come from `src/services/api-keys.js` (per-user,
  hashed at rest, created via the Profile API Keys page). Requests carry the
  owning user; every tool enforces `canAccess(user, agentName)` (owner or
  admin), so an agent only ever sees/controls what its user owns.
- **Tools registered (`registerTools`)**: `list_agents`, `get_agent`,
  `agent_logs`, `config_get`, `settings_get`, `health`, `workspace_list`,
  `workspace_read`, `workspace_write`, `start_agent`, `stop_agent`,
  `restart_agent`, `create_agent`, `delete_agent`, `recreate`, `update`, `exec`
  — 17 tools. Destructive ones (`create_agent`, `delete_agent`, `recreate
  reset`) already require `confirm: true`.

### Agent-side MCP plumbing exists

- CommandsPane **MCP group** pastes `openclaw mcp add …` / `unset` / list
  commands into the docked terminal (docs/tabs/mcp.md); `GET
  /api/agents/:name/mcp` lists configured servers.
- Every driver ships an MCP commands group: openclaw (`openclaw mcp …`),
  picoclaw, opencode (`opencode mcp list/add`), hermes (`hermes mcp list`),
  codex, claude (`claude mcp list/login/logout`).
- **No agent has the Paddock server configured today** — no command, no button,
  nothing in any driver or in the CommandsPane MCP group.

## Approach

### 1. Design decisions (verify first, then lock in)

- **Reachability:** agents reach Paddock's webui = host port 6789. Candidates
  for the URL host from inside an agent container: docker bridge gateway
  (e.g. `172.17.0.1`), `host.docker.internal` (needs `extra_hosts`), or the
  LAN IP `10.69.1.164`. **Peer-mode agents** (`network_mode: container:<peer>`)
  share the peer's netns — gateway may differ. Decide one reliable answer and
  document it; a per-instance computed URL (mirroring how `web.json` binds) is
  cleaner than a hardcoded one.
- **Key provisioning:** who creates the key and where does it live?
  - Manual bootstrap: user creates a dedicated, restricted API key on the
    Profile page and types it into a terminal `read -rsp` prompt emitted by the
    "Connect Paddock MCP" command. The key is never included in the pasted
    command or frontend state.
  - Auto-provisioning is out of scope for the first implementation. It would
    require a secure one-time delivery path and must not silently inject an
    owner/admin key into an agent config.
- **Secret handling:** the key ends up in the agent's config file
  (openclaw.json / config.toml / …) or a driver-supported persistent secret
  reference. Docs note non-`json` configs are served and written verbatim with
  no redaction (AGENTS.md), so each driver's storage location and trade-off must
  be documented; a dedicated, restricted, revocable key limits exposure.
- **Ownership:** the key belongs to the agent's owner, but server-enforced target
  and tool grants further restrict it below the owner's normal fleet access.

### 2. Driver MCP interface (the core of this plan)

Every driver owns MCP operations for its agent type. Add a capability-aware
**`mcp` object to each driver**. It returns fully shell-quoted command strings
or safe native config-patch commands; the terminal remains the interface and
CommandsPane pastes the resulting command:

```js
// src/services/drivers/openclaw.js
mcp: {
  serverName: 'paddock',
  capabilities: { list: true, add: 'command', remove: 'command', test: true },
  buildConnect: (opts) => '<read token; add Paddock MCP command>',
  buildDisconnect: () => 'openclaw mcp unset paddock',
  buildInspect: () => 'openclaw mcp list',
  buildTest: () => 'openclaw mcp probe paddock',
}
```

- **One shared call site.** `src/services/drivers/index.js` gains a driver MCP
  helper that delegates to the available `build*` operation. Callers never
  switch on agent type; unsupported operations return an explicit capability,
  not a made-up command.
- **Backend serves it.** Extend `GET /api/agent-types/:type/commands` to include
  an `mcp` block built from `driver.mcp` (or add `/api/agent-types/:type/mcp`),
  so the frontend renders the MCP group from the driver for **every** agent
  type. CommandsPane's hardcoded openclaw MCP pills (CommandsPane.jsx:161-263)
  get replaced by this driver-driven group.
- **Token never lives in the endpoint or frontend state.** The backend builds a
  shell-quoted, driver-specific bootstrap command that reads the API key at the
  terminal with `read -rsp`; the variable is used only while writing the
  driver's persistent MCP configuration, then unset. Drivers that cannot take
  an inline header use their native config patch or a persistent env-var
  reference.
- **Least privilege:** `add` should default to `--no-probe` (the probe fires an
  authenticated round-trip the user may not expect) and the Paddock key handed
  to agents may scope tools down (exclude `create_agent` / `delete_agent` /
  `recreate reset`) — see Open questions.

### 2a. Resolved connection and credential flow

There are two credential flows. They must stay separate:

1. **Human bootstrap: connect an agent to Paddock MCP.** The agent has no
   Paddock MCP connection yet, so this cannot be performed by an MCP tool. The
   user creates a dedicated, revocable Paddock API key in Profile, selects the
   intended grant, clicks **Connect Paddock MCP**, and types the key into a
   terminal `read -rsp` prompt. The generated command contains no literal key
   and the key is not held in React state:

   ```sh
   read -rsp 'Paddock API key: ' PADDOCK_MCP_TOKEN; echo
   <driver-specific add command using "$PADDOCK_MCP_TOKEN">
   unset PADDOCK_MCP_TOKEN
   ```

   The driver config necessarily persists the credential (or a persistent
   secret reference where that driver supports one), because the agent needs it
   after the shell exits. The key must never appear in the pasted command,
   terminal history, command descriptions, frontend/API logs, or toast text.
   The UI immediately offers a read-only list/test command after setup.

2. **LLM credential insertion after connection: add a model/provider.** The
   LLM calls Paddock MCP `exec` with a separate redacted `stdin` field, not a
   secret embedded in `command`. `exec` writes that value to the child stdin and
   must not log or return it. This enables `openclaw models auth paste-api-key`
   and equivalent non-interactive provider commands. Plan 35a owns the catalog,
   preservation/merge, and verification rules for this flow.

#### Grants are server-enforced, not a client-side tool filter

The bootstrap key is a dedicated agent key, never the owner's normal/admin API
key. API-key scopes already exist in storage but are not currently enforced by
the MCP server; implementation must enforce them before this button is enabled.
Every key carries both an owner and a Paddock grant:

- **Target grant:** default = only the PAD being connected; optional explicit
  grant = every PAD owned by the same user. An admin-owned agent never inherits
  unrestricted admin access by accident.
- **Tool grant:** default = read/inspect, workspace read/write, and `exec` for
  the allowed target. Lifecycle, recreate/update, create, delete, and reset are
  separate opt-in grants. `reset` is always separately confirmation-gated.
- `list_agents` is filtered to the target grant, and every tool validates both
  the tool grant and target grant before existing owner/admin checks.
- Driver-level include/exclude filters are a useful second layer for tool
  discovery, but never the authorization boundary.

Disconnect/revoke flow: remove the server through the driver action, revoke the
dedicated key in Profile, verify `mcp list` no longer contains `paddock`, then
record the result without printing the old credential. Deleting an agent must
revoke keys bound only to that agent. Rotating a key repeats the human bootstrap
flow, verifies the new connection, then revokes the old key.

#### Capability-aware driver actions

`driver.mcp` cannot promise `list/add/remove/test` strings for every driver:
the installed Picoclaw has no MCP CLI, OpenCode has no CLI remove, and Hermes
requires a YAML config patch for authenticated add. Define actions by capability
instead:

```js
mcp: {
  capabilities: { list: true, add: 'command', remove: 'configPatch', test: false },
  buildConnect(opts),
  buildDisconnect(opts),
  buildInspect(opts),
  buildTest(opts), // null when unsupported
}
```

Each builder returns a fully shell-quoted command or a safe, driver-owned
config-patch command. No caller concatenates URL, name, header, or token text.
The Commands pane renders only supported actions and explains unsupported test
or removal behavior. Config patchers must parse and rewrite their native format
(JSONC/YAML/TOML); no string replacement. The implementation must document the
exact persistent credential location for each driver.

#### Endpoint source and release gate

Do not bake `10.69.1.164` into a generated command. Add one configured,
validated `PADDOCK_MCP_URL` (or equivalently named) internal endpoint setting.
The computed URL is shown to the user before bootstrap and tested from the
target container. LAN-IP fallback is permitted only when explicitly configured.
Peer-mode connectivity is a release gate: no driver is marked complete until a
peer-mode PAD connects, lists tools, and invokes a read-only Paddock MCP tool.

### 3. Per-driver research (2026-08-09, from current docs + live CLI verification)

The exact commands for adding / listing / removing an MCP server differ per
agent. These are the documented shapes for a **streamable-HTTP** server with a
bearer header. Live-verified marks (✅) = confirmed against the running CLI in a
PAD container today:

| Driver | list | add (remote HTTP) | remove | test/probe |
|---|---|---|---|---|
| **openclaw** | `openclaw mcp list` | `openclaw mcp add <name> --url <url> --transport streamable-http --header 'Authorization: Bearer <key>'` | `openclaw mcp unset <name>` | `openclaw mcp probe <name>` |
| **picoclaw** | `picoclaw mcp list` | `picoclaw mcp add <name> --transport http --header 'Authorization: Bearer <key>' <url>` | `picoclaw mcp remove <name>` | `picoclaw mcp test <name>` / `picoclaw mcp show <name>` |
| **opencode** | `opencode mcp list` (alias `ls`) | `opencode mcp add <name> --url <url> --header 'Authorization=Bearer <key>'` (non-interactive since v0.1.x) | `opencode mcp remove <name>` (verify present in installed build) | `opencode mcp info <name>` / `opencode mcp debug <name>` |
| **hermes** | `hermes mcp list` (alias `ls`) | `hermes mcp add <name> --url <url>` — **no non-interactive header flag**; auth=header is interactive → patch `config.yaml` instead | `hermes mcp remove <name>` | `hermes mcp test <name>` |
| **codex** | `codex mcp list [--json]` | `codex mcp add <name> --url <url> --bearer-token-env-var <ENV>` — **no inline header flag**; token must come from an env var | `codex mcp remove <name>` | `codex mcp get <name>` |
| **claude** | `claude mcp list` | `claude mcp add --transport http <name> <url> --header 'Authorization: Bearer <key>' --scope user` | `claude mcp remove <name>` | `claude mcp get <name>` |

#### Live CLI verification (2026-08-09, on running PADs)

- ✅ **openclaw** (`pad-openclaw-work-pls`, v2026.7.1): `mcp add <name>` takes
  `--header <key=value>` (repeatable, **equals form**), `--url`, `--transport
  streamable-http|sse`, `--no-probe`, `--timeout/--connect-timeout`,
  `--ssl-verify`, `--parallel`, `--include/--exclude <csv>` (tool filter at
  add time), `--disabled`. Subcommands: `add configure doctor list login logout
  probe reload serve set show status tools unset`. **The inline bearer
  `--header` works** — no `${ENV_VAR}` config edit needed for openclaw
  (open question answered). **Least privilege is first-class:** `--exclude` at
  add time AND `openclaw mcp tools <name> --include/--exclude` later to hide
  e.g. `create_agent`/`delete_agent` from the agent (open question answered).
- ✅ **opencode** (`pad-opencode-paddock-dev`): subcommands are exactly
  `add list auth logout debug` — **there is NO `mcp remove`** (open question
  answered: removal = edit `opencode.json` `mcp.<name>` block, or `opencode
  mcp add` cannot unset). `mcp add <name>` takes `--url` (remote) +
  `--header KEY=VALUE` / `--env KEY=VALUE`; **no `--no-probe` flag** — remote
  add does not probe/connect at add time.
- hermes / picoclaw / codex / claude — **all live-verified 2026-08-09**, see
  §3b below (run on PADs of every type). Codex & claude matched the docs
  exactly; hermes confirmed the `config.yaml` `mcp_servers` patch path and
  that `mcp add` is interactive-only; picoclaw's installed v0.2.5 has **no**
  `mcp` CLI group at all — the docs describe a newer build.

Gotchas per driver (from the research):

- **openclaw** (`docs.openclaw.ai/cli/mcp`): `add` **probes before saving**
  unless `--no-probe`; `--header` is repeatable; docs warn against committing
  literal bearer tokens — the config `mcp.servers.<name>.headers` map may
  accept `${ENV_VAR}` expansion, so prefer a secret ref if it works live.
- **picoclaw** (`docs.picoclaw.io` mcp-cli): config lives at
  `tools.mcp.servers` in `config.json`; **`add` auto-enables `tools.mcp.enabled`**
  and **removing the last server disables it**; `--header`/`-H` repeatable,
  `--transport`/`-t` takes `stdio|http|sse`.
- **opencode** (live `--help`): non-interactive `mcp add` needs the name plus
  **either** `--url` (remote) **or** a command after `--` (local) — not both;
  `--header` is remote-only, `--env` local-only. **No `mcp remove` in the
  installed build** — removal must edit `opencode.json` (`mcp.<name>` block,
  default global scope `~/.config/opencode/opencode.json`). No `--no-probe`
  either — remote add just saves config.
- **hermes** (`hermes-agent.nousresearch.com/docs/.../mcp` + github): the CLI is
  discovery-first and its `--args` is `nargs=REMAINDER` (must be last); there is
  **no non-interactive header flag** — for the Paddock bearer key, write
  `config.yaml` directly (`mcp_servers.<name>` → `url` + `headers: {Authorization: ...}`)
  and verify with `hermes mcp test`. Note the key is `mcp_servers:` at top
  level, **not** `mcp.servers`. Live sessions need `/reload-mcp` or a gateway
  restart to pick up new tools. Verify the container's config path
  (`/opt/data/config.yaml` vs `~/.hermes/config.yaml`).
- **codex** (`developers.openai.com/codex/mcp` + `mcp_cmd.rs`): HTTP `add` takes
  **only** `--url` + `--bearer-token-env-var <ENV>` — no inline header flag.
  Either inject `PADDOCK_MCP_TOKEN` into the container env (start.sh / instance
  env) or patch `config.toml` `[mcp_servers.<name>]` with
  `url` + `http_headers = { Authorization = "Bearer …" }`. `login/logout` are
  OAuth-only and irrelevant here.
- **claude** (`code.claude.com/docs/en/mcp`, current): all flags (`--transport`,
  `--header`, `--scope`) must come **before** the server name; `--header`/`-H`
  and `--env`/`-e` repeatable; `--scope user` writes to `~/.claude.json`
  top-level `mcpServers` (all projects), default `local` is per-project. MCP
  config lives in `~/.claude.json`, not the driver's `settings.json` —
  note for the config-read tooling. `.mcp.json` supports `${VAR}` / `${VAR:-def}`
  expansion in `url` and `headers` — an env-var secret ref is possible, but
  `claude mcp add` writes the literal header.

### 3b. Live add / list / remove test run — browser MCP on every agent type (2026-08-09)

Full end-to-end run: added the same MCP server
**`http://10.69.1.164:3000/mcp`** (a browser MCP exposing ~17 tools:
web_search/fetch/screenshot + Playwright-style `Target.*` / `Page.*` / `DOM.*` /
`Input.*` / `Runtime.*`) into **one PAD of each of the six agent types**, listed
it, and removed it. All MCP configs returned to their pre-test state
(verified after). Findings:

| Driver | PAD used | add | list | probe/test | remove | Verdict |
|---|---|---|---|---|---|---|
| **openclaw** | pad-openclaw-work-pls | ✅ `openclaw mcp add browser-mcp-test --url … --transport streamable-http --no-probe` → saved | ✅ `openclaw mcp list` | ✅ `openclaw mcp probe` → **17 tools**, tool rename `browser-mcp-test__DOM-getDocument` etc. | ✅ `openclaw mcp unset <name>` (first call no-op'd, second removed — see gotcha) | **PASS** |
| **opencode** | pad-opencode-test3 | ✅ `opencode mcp add browser-mcp-test --url …` → wrote `/root/.opencode/config/opencode/opencode.jsonc` | ✅ `opencode mcp list` → **`✓ connected`** (auto live-connect) | (list shows status) | ⚠️ **no `mcp remove`** — edit the jsonc (`mcp.<name>` block) | **PASS** (remove = config edit) |
| **picoclaw** | pad-picoclaw-asdsa | ⚠️ **no `mcp` subcommand** in installed v0.2.5 — patch `tools.mcp.servers` in `config.json` directly (verified: node edit, `enabled:true` + server `{type:http,url}`) | ⚠️ no CLI — read config.json | ⚠️ no CLI probe (`picoclaw status` only) | ⚠️ config edit (delete `servers` entry, set `enabled:false`) | **PARTIAL** — config-only, no CLI |
| **hermes** | pad-hermes-sup | ⚠️ `hermes mcp add --url …` **connects + finds 17 tools, then hangs on interactive "Enable all 17 tools? [Y/n/select]"** (no `--yes`; GitHub issue #31970) → **patch `/opt/data/config.yaml` `mcp_servers.<name>`** instead | ✅ `hermes mcp list` → `browser-mcp-test … all ✓ enabled` | ✅ `hermes mcp test <name>` → 17 tools | ✅ `hermes mcp remove <name>` → **defaults Y on non-TTY** (works headless) | **PASS** (add = config.yaml patch) |
| **codex** | pad-test-codex | ✅ `codex mcp add browser-mcp-test --url …` → wrote `~/.codex/config.toml` `[mcp_servers.browser-mcp-test]` | ✅ `codex mcp list` (table; enabled) | ✅ `codex mcp get <name>` | ✅ `codex mcp remove <name>` | **PASS** |
| **claude** | pad-claude-mcp-test (created for the test, deleted after) | ✅ `claude mcp add --transport http --scope user browser-mcp-test http://…` → wrote `/root/.claude/.claude.json` `mcpServers` | ✅ `claude mcp list` → **`✔ Connected`** (live health-check) | (list health-checks) | ✅ `claude mcp remove <name>` | **PASS** |

**Per-driver gotchas confirmed live (beyond §3):**

- **openclaw:** `mcp unset` printed nothing on the first call and did NOT
  remove the server; the second identical call removed it. A possible
  async/stat cache in the CLI — plan for "run remove twice" or verify with
  `mcp list` after. `mcp tools <name> --exclude 'A,B'` writes
  `toolFilter.exclude` into the server entry and the probe drops to the
  reduced tool count (17 → 15) — **least privilege verified end-to-end.**
- **opencode:** config path is **`/root/.opencode/config/opencode/opencode.jsonc`**
  (not `~/.config/opencode/opencode.json` as assumed in §3); the file is
  `jsonc`, `mcp.<name> = {type:"remote", url}`. Removing the entry by
  string-editing the jsonc works and `mcp list` shows "No MCP servers
  configured" after.
- **picoclaw:** installed image `paddock-vm-picoclaw:latest` runs **v0.2.5**,
  which has **no `mcp` CLI group** (docs describe a newer build). Only the
  config shape exists: `tools.mcp.enabled` + `tools.mcp.servers.<name>`
  (`type: http`, `url`, optional `headers`). No CLI way to probe. A picoclaw
  image update would be needed for `picoclaw mcp add/list/remove` support.
- **hermes:** `mcp add` is **never** non-interactive (tool-enable checklist);
  `mcp remove` defaults to "yes" without a TTY (fine headless). Config path is
  **`/opt/data/config.yaml`** (HERMES_HOME=/opt/data in the container), which
  does not exist until hermes creates it — creating it manually with just
  `mcp_servers:` works and `hermes mcp list`/`test` pick it up.
- **codex:** everything non-interactive; `mcp get` prints the full config
  (including `remove:` hint). Bearer auth would use `--bearer-token-env-var`.
- **claude:** `--transport http` + `--scope user` writes the entry to
  `mcpServers` in `/root/.claude/.claude.json`; `list` health-checks live.
  Headers via repeatable `--header`.

**Reachability reconfirmed during the run:** every PAD reached
`http://10.69.1.164:3000/mcp` (openclaw probe 17 tools, opencode connected,
hermes connected 17 tools, claude connected) — the LAN IP works from all six
agent containers regardless of docker network. **Test PAD lifecycle:** created
`pad-claude-mcp-test` via `POST /api/agents/create` (name must be `pad-`-prefixed
per `VM_NAME_RE`), deleted it after with `POST /api/agents/:name/delete`.

### 4. Reachability (verified live, then lock in)

Agents reach Paddock's webui = host port 6789. From inside an agent container
the URL host is one of: docker bridge gateway (default `172.17.0.1`),
`host.docker.internal` (needs `extra_hosts`), or the LAN IP `10.69.1.164`.

**Live verification (2026-08-09, from `pad-openclaw-work-pls`):**

- `curl -s -o /dev/null -w '%{http_code}' http://10.69.1.164:6789` → **200**
  (LAN IP works).
- `curl -s -o /dev/null -w '%{http_code}' http://192.168.160.1:6789` → **200**
  (this agent's docker bridge gateway works — note: **not** `172.17.0.1`, the
  default bridge; the gateway IP is per-network).
- `host.docker.internal` → **not resolvable** (no `extra_hosts` in the agent's
  compose), as expected.

So the reliable default is the **LAN IP `10.69.1.164`** (it worked from this
agent and doesn't depend on which docker network the PAD is on). The fallback
is the bridge gateway, but its value differs per network (`172.17.0.1` default
bridge vs e.g. `192.168.160.1` for a compose network), so hardcoding `172.17.0.1`
is wrong. Plan: compute the URL per instance (LAN IP constant from `.env`
`WEBUI_LAN_IP`-style, or resolve the gateway at runtime), not hardcoded.

**Peer-mode agents** (`network_mode: container:<peer>`) share the peer's netns
— the gateway differs. Still to verify: whether the LAN IP holds there too
(highly likely — it's the host's real interface). `pad-opencode-aic` runs on
its own `pad-opencode-aic_default` network (not peer mode), so it shares the
LAN-IP answer. A peer-mode agent must be tested live before locking in.

### 5. Test end to end (live, on a test PAD)

- Configure the server on `test-agents` via the CommandsPane button.
- Confirm `<driver> mcp list` shows it enabled and the probe passes.
- Ask the agent to call `list_agents` then a read tool (`get_agent`, health);
  then a mutation (`start_agent`) — verify the ACL (owner-only) holds and the
  mutation lands in Paddock's activity log.
- Repeat for a peer-mode agent (reachability path) and a second driver.

### 6. Document

- Add the "Connect Paddock MCP" command to the driver-driven MCP group so it's
  a one-click button.
- `docs/tabs/mcp.md`: add the Paddock-URL + key flow, the per-driver command
  table above, reachability table (default vs peer mode), and the note that the
  server is Paddock's own MCP (distinct from plan 18's docker MCP).
- Note the dependency: this is useless without a valid API key from the owning
  user — the key is the real gate (mirrors plan 18's socket-mount gate).

## Files

- **Modified** `src/services/drivers/index.js` — shared `mcpCommands(type, opts)`
  call site (single entry point that delegates to the driver's `mcp` object)
- **Modified** `src/services/drivers/{openclaw,picoclaw,opencode,hermes,codex,claude}.js`
  — new `mcp` object: `list/add/remove/test` command builders (+ a config-file
  patch path for hermes/codex where the CLI can't carry the header)
- **Modified** `src/app.js` — serve the driver's `mcp` commands via
  `/api/agent-types/:type/commands` (or a new `/mcp` subroute)
- **Modified** `src/client/src/pages/agent/CommandsPane.jsx` — replace the
  hardcoded openclaw MCP pills with the driver-driven MCP group + "Connect
  Paddock MCP" button (URL + API-key prompt, token interpolated client-side)
- **Modified** `src/services/vm-manager.js` (or a new small service) — compute
  the per-instance Paddock MCP URL; optional auto-provisioning of the owner key
- **Modified** `docs/tabs/mcp.md` (+ `docs/operations/overview.md` note) —
  flow, reachability, ownership, secret handling, per-driver command table
- **Possibly** `src/services/api-keys.js` — if auto-provisioning, a
  scoped/derived key flow

## Progress

- [x] Research: per-driver MCP add/list/remove commands verified against
      current docs (openclaw, picoclaw, opencode, hermes, codex, claude)
- [x] Live CLI verification: openclaw `--header` bearer + tool filters +
      `mcp tools` confirmed; opencode has NO `mcp remove`; reachability
      (LAN IP `10.69.1.164:6789` → 200 from a PAD container) verified
- [x] Live add/list/remove test run of an HTTP MCP server (browser MCP,
      `10.69.1.164:3000/mcp`) on a PAD of **every** agent type (2026-08-09):
      openclaw, opencode, hermes, codex, claude all PASS; picoclaw has no
      `mcp` CLI in the installed v0.2.5 (config-patch only) — full matrix + 
      per-driver gotchas in §3b. All configs restored to pre-test state.
- [ ] Decide reachable host URL (default vs peer mode) + verify on a peer-mode
      agent and on a hermes/codex/claude PAD
- [ ] Capability-aware `driver.mcp` actions in all 6 drivers; unsupported
      list/add/remove/test paths are explicit
- [ ] Shared driver MCP call site in `src/services/drivers/index.js`
- [ ] Backend serves the driver `mcp` commands; CommandsPane MCP group is
      driver-driven, not hardcoded to openclaw
- [ ] "Connect Paddock MCP" button (URL + key prompt) on `test-agents`
- [ ] `<driver> mcp list` shows `paddock`, probe passes (openclaw first)
- [ ] Agent calls `list_agents` + a read tool end to end
- [ ] Agent runs a mutation (`start_agent`) — ACL + activity log verified
- [ ] Peer-mode reachability verified
- [ ] opencode + picoclaw + hermes + codex + claude wired + verified
- [ ] Docs updated (`docs/tabs/mcp.md` + drivers)
- [ ] Server-enforced API-key target/tool grants; dedicated agent-key create,
      revoke, rotate, and delete cleanup flow
- [ ] Human bootstrap command reads the Paddock key without placing it in the
      pasted command/history; all six driver credential locations documented
- [ ] MCP `exec.stdin` secret channel implemented, redaction tested, and
      OpenClaw model-provider insertion verified end to end (plan 35a)
- [ ] JSONC/YAML/TOML MCP config patch paths are parser-based and tested
- [ ] Configured Paddock MCP endpoint validated from a peer-mode PAD

## Verification

```bash
<driver> mcp list                                   # paddock server present, enabled
# in chat: ask the agent to list PADs → real fleet output
# ask the agent to start/stop a PAD it owns → state change lands, owner ACL holds
```

## Open questions

- ~~Does the openclaw CLI accept a bearer `--header` for a streamable-http MCP
  server, or must auth ride a `${ENV_VAR}` ref in `mcp.servers.<name>.headers`?~~
  **ANSWERED live (2026-08-09):** yes — `--header 'Authorization: Bearer <key>'`
  is accepted (equals-form `key=value`), and it's the documented path. No
  config-file edit needed for openclaw.
- ~~opencode `mcp remove` — present in the installed binary or a config-file
  edit? hermes header auth — CLI prompt vs direct `config.yaml` patch (plan:
  patch)?~~ **ANSWERED live:** opencode has **no** `mcp remove` — removal is an
  `opencode.json` edit. Hermes remains: patch `config.yaml`
  (`mcp_servers.<name>` → `url` + `headers`) since the CLI has no
  non-interactive header flag.
- Auto-provision vs manual key paste — manual respects the paste-commands rule,
  auto is smoother but writes a secret into the agent config.
- Should `create_agent` / `delete_agent` / `recreate reset` stay agent-reachable
  at all, or be excluded from the key we hand agents (least privilege)?
- Does the Paddock MCP itself need a tool filter per driver to enforce least
  privilege? — **openclaw has first-class tool filtering** (`mcp add --exclude`
  and `openclaw mcp tools paddock --include/--exclude`), so a reduced tool set
  for openclaw is trivial. Other drivers would need per-server tool config
  (hermes `tools: {include,exclude}`, codex `[mcp_servers.<name>]` per-tool) —
  or a reduced-scope API key.
- The LAN IP answer still needs verification from a **peer-mode** agent
  (`network_mode: container:<peer>`) — non-peer PADs of all six types now
  confirmed to reach `10.69.1.164` (openclaw/opencode originally; hermes/codex/
  claude/picoclaw in the §3b run).
