# Goal 30 — MCP Tools: live plan

> **Status: Active / living document.** The user says: "Whatever I say, keep
> storing it in the plans." Every new requirement, decision and learning about
> the MCP surface lands here. Absorbed items are marked done; this plan stays
> until the whole MCP surface is complete.

## The rules (fixed, already decided)

1. **Shared functions, no duplication.** Business logic lives in
   `src/services/`; both the Express routes (app.js) and MCP tools (mcp.js) are
   thin adapters over the SAME service functions. Never copy a behavior between
   REST and MCP — write it once in a service, call it from both.
2. **No `paddock_` prefix on tool names.** The consuming MCP client already
   namespaces the server's tools itself, so a prefixed name double-prefixes.
   Keep every new tool unprefixed.
3. **Destructive tools require `confirm: true`.** delete_agent and recreate's
   `reset` wipe data with no undo — keep the guard.
4. **Terminal-command tools stay terminal-driven.** Actions that exist as
   `openclaw ...` commands (MCP add, skills install) are NOT mirrored as
   API-backed MCP tools — they run through `exec` (CommandsPane rule).

## Current tool surface (14 tools, all live — 2026-08-09)

Read / inspect:

| Tool | Args | Returns |
|------|------|---------|
| `list_agents` | — | fleet summary (name, status, type, model) |
| `get_agent` | `name`, `logs?` (1–500 tail lines) | full agent object; with `logs` also recent container lines |
| `agent_logs` | `name`, `tail?` (max 5000) | `{ name, logs }` from log-store (persists across recreates) |
| `config_get` | `name` | driver-aware config via `vm.readAgentConfig` (JSON parsed + secrets redacted; yaml/toml verbatim) |
| `workspace_list` | `name`, `path?` | dir listing (path-traversal safe) |
| `workspace_read` | `name`, `path` | file content (text only, ≤ 256 KB) |
| `workspace_write` | `name`, `path`, `content` | write/overwrite file |

Control:

| Tool | Args | Returns |
|------|------|---------|
| `start_agent` | `name` | starts agent + socat door (`vm.startAgent`) |
| `stop_agent` | `name` | stops agent + socat door (`vm.stopAgent`) |
| `restart_agent` | `name` | restart + door (`vm.restartAgent`) |
| `recreate` | `name`, `pull?`, `reset?`, `confirm?`, **+ all settings args (planned):** `allowDocker?`, `network?`, `extraVolumes?`, `workspaceHost?`, `workspaceDir?`, `sshEnabled?`, `sshPort?`, `sshContainerPort?`, `sshPassword?`, `extraPorts?`, `web?` | force-recreate via compose; only the specified options change (see consolidated design §below); `pull` = rebuild from latest base, `reset` = wipe data dir (confirm required) |
| `update` | `name` | pull base image + rebuild + recreate (Settings "Update" flow) — **folds into `recreate {pull:true}` (see open questions)** |
| `delete_agent` | `name`, `confirm: true` | remove container, door, network, instance dir (no undo) |

Exec:

| Tool | Args | Returns |
|------|------|---------|
| `exec` | `name`, `command`, `timeout?` | `docker exec -i <pad> sh -lc '<cmd>'` |

## Session log (what we did this session, 2026-08-09)

- [x] **plan 30-sync absorbed** (file deleted): `vm.readAgentConfig`,
      `vm.startAgent`/`stopAgent`/`restartAgent` (with doors) shared by REST +
      MCP. `paddock_config_get`/`start`/`stop`/`restart` became adapters.
- [x] **`get_agent` logs option** — user: "give an option to see the agent's
      logs." Added optional `logs` param (tail N ≤ 500) via `logStore.capture`
      + `readLogs`; `agent_logs` is the standalone equivalent.
- [x] **`delete_agent`** — user: "add an option for deleting the agent. I think
      it is already there." It was REST-only; added MCP tool wrapping
      `vm.removeVm` + `registry.removeAgentFromDb`, `confirm: true` guard.
- [x] **Drop the `paddock_` prefix** — user: "don't add paddock in the starting
      because it is already being added by the agent." Renamed all tools.
      Recorded as rule #2.
- [x] **`recreate` + `update`** — user: "you have not added tools to update to
      recreate the container at all." Added both as adapters over
      `vm.recreateAgent` (pull/reset/confirm) and `vm.updateAgent` (pull).
- [x] Tests: `timeout 60 docker exec paddock node --test test/mcp.test.js`
      passes (5 tests; combined `node --test test/` hangs — run individually).
- [x] Live verification over `/mcp` with a throwaway admin API key
      (create → call → remove key): tools/list shows all 14 unprefixed names;
      get_agent+logs returned real log lines; delete guard refused without
      confirm.

## Settings + Web options → consolidated into `recreate` (2026-08-09, user design)

**User decision:** every option in the Settings tab AND the Web tab ultimately
recreates the container, so instead of separate tools they all become arguments
of the ONE `recreate` tool, alongside the existing `pull` / `reset`. Only the
options that are specified change; **everything unspecified is left untouched.**

Validated against the code — all of these stop + force-recreate:
- Settings: allow docker, network peer, additional volumes, custom workspace
- Web tab: web publish/unpublish (also runs the start-web hook + verify),
  Expose OpenSSH (may also rebuild image for a non-22 container port),
  additional ports

Backend already supports the merge: `vm.applySettings(name, opts)` regenerates
the compose with ALL passed options in one call; one recreate applies everything.

### The single tool

```
recreate(name, {
  pull, reset, confirm,          // existing recreate options
  allowDocker, network,          // Settings tab
  extraVolumes: [{host, container, readonly}],
  workspaceHost, workspaceDir,
  sshEnabled, sshPort, sshContainerPort, sshPassword,   // Web tab SSH (write-only pw)
  extraPorts: [{host, container}],                        // Web tab ports
  web: { active, hostPort, containerPort, password }      // Web tab publish (write-only pw)
})
```

### Rule: change ONLY what is specified

`undefined` for an option MUST preserve the current stored value — never
default it (no docker-off, no network-clear, no volume/port wipe) unless the
caller explicitly passes a value. `[]` / `''` / `false` still count as explicit
"clear this".

**Code caveat:** `vm.applySettings` currently preserves the conditional options
(extraVolumes/extraPorts/sshCport/sshPassword/workspace) but NOT
`allowDocker`/`network` — those default to off/cleared when omitted because the
Settings UI always passes them. The shared orchestrator must make
`allowDocker === undefined` → keep stored `meta.DOCKER`, and
`network === undefined` → keep stored `meta.NETWORK`.

### Read-only tools that do NOT recreate (separate, all thin adapters)

- `settings_get` — current settings: allowDocker, network, ssh, workspaceMount,
  extraVolumes, extraPorts, image, version, networkHealth
- `web_get` — publish state: active, webService, networkMode, passwordConfigured,
  actualPorts, live
- `health` — `container-health.checkContainerHealth()` (works on stopped pads)
- `container_info` — docker inspect summary (state, mounts, ports, env keys,
  raw redacted)
- `list_networks` — containers available as network peers (+ state) — the
  Network dropdown source

`delete_agent` stays separate (removes, never recreates). `update` (= pull +
recreate) folds into `recreate {pull:true}` — consider dropping the standalone
`update` tool.

### Shared-function requirement (rule #1)

Extract `vm.applyAgentChanges(name, opts, { onLog, onStep })` implementing the
full flow: validate → write web hook (if web specified) → `applySettings`
(regenerates compose with only the specified options) → validateInstanceCompose
→ stop if running → rebuild if needed (docker-CLI / custom SSH port) →
force-recreate → reconcile door → re-exec start-web hook + verify (web publish)
→ restore stopped state. REST settings/ports/web routes AND the MCP tool call
the same function.

## Open questions / candidate tools (decide per item)

Decided this session: `health`, `web`, `settings` are NOT standalone tools — health
is a read-only `health` tool, and web/settings mutations fold into `recreate`
(see consolidated design above).

- [ ] **`config_set`** — agent self-edits its own config. Risk: an agent can
      break itself (destroy agents config, auth, plugins). If added, admin-role
      scoped or confirm-gated. Currently NOT added — default is no.
- [ ] **backup / restore** — wraps `backup-manager.js`. Cheap and useful
      (recovery from a client). Candidate yes.
- [ ] **create_agent** — biggest flow (image build, config seed, setup steps).
      Probably stays UI-only. Currently no.
- [ ] **drop `update` tool** — folds into `recreate {pull:true}`; decide whether
      to remove the standalone tool or keep it as a convenience alias.
- [ ] Audit of `docs/architecture.md` — the MCP section must be updated to match
      the consolidated `recreate` + read-tool surface once implemented.

## Keep the MCP surface minimal unless a real client needs it

Read + control + exec is the core. Mirroring every REST endpoint grows attack
surface and maintenance. Add a tool only when a consuming agent actually needs
it — and always by extracting the REST handler's core into a service first.
