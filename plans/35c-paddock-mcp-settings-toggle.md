# Plan 35c — "Allow agent to control paddock" Settings toggle

## Status: Proposed (2026-08-12) — 0/4 phases, design complete. Next step of the
plan-35 MCP series (35a = LLM-usable MCP surface → absorbed; 35b = driver MCP
wiring → implementation 100% built and live-verified, awaiting approval to
conclude; this plan = the user-facing Settings switch). Nothing implemented yet.

## History (what was done before this plan)

### Plan 35b — Paddock MCP integration into agents (built + live-verified)

Backend and drivers now expose the machinery to wire an agent container to
Paddock's own MCP server (`/mcp`, `src/mcp.js`, Streamable HTTP, `pk_live_…`
bearer keys):

- **`src/services/paddock-mcp.js`** (new) — `getPaddockMcpUrl()`:
  `PADDOCK_MCP_URL` override, else
  `${HOST_PROTO}://${HOST_NAME}:${WEBUI_PORT}` → runtime
  `http://10.69.1.164:6789/mcp` (env injected via compose `env_file`).
- **`src/services/drivers/mcp-util.js`** — `sq()` + POSIX-safe `bootstrap(inner)`
  (stty silent-read of `PADDOCK_MCP_TOKEN`; dash-safe; token never in the pasted
  command, terminal history, or frontend state).
- **All six drivers** gained a capability-aware `mcp` object
  (`{serverName:'paddock', capabilities, buildConnect/buildDisconnect/
  buildInspect/buildTest}`), each returning a fully shell-quoted command that
  reads the API key on stdin:
  - openclaw: `openclaw mcp add paddock --url … --transport streamable-http
    --header "Authorization=Bearer $PADDOCK_MCP_TOKEN" --no-probe`; unset / list
    / probe.
  - opencode: `opencode mcp add paddock --url … --header
    "Authorization=Bearer $PADDOCK_MCP_TOKEN"`; disconnect = string-aware JSONC
    patch of `/root/.opencode/config/opencode/opencode.jsonc` (naive `//`
    stripper mangled `"$schema": "https://…"` — fixed).
  - picoclaw: no MCP CLI in the installed build → node JSON patch of
    `/root/.picoclaw/config.json` `tools.mcp.servers.paddock` (+`enabled:true`).
  - hermes: `hermes mcp add` is interactive-only → python/yaml patch of
    `/opt/data/config.yaml` top-level `mcp_servers.paddock` + secret
    `MCP_PADDOCK_API_KEY` written idempotently to `/opt/data/.env` (fixed a
    python-`%`-in-JS-string bug that produced a `NaN` line).
  - codex: `codex mcp add paddock --url … --bearer-token-env-var
    PADDOCK_MCP_TOKEN` then a node patch swapping that line for
    `http_headers = { Authorization = "Bearer <token>" }` in
    `/root/.codex/config.toml` (env-var token is only attached to POSTs, misses
    the SSE GET stream → 401).
  - claude: `claude mcp add --transport http paddock <url> --header
    "Authorization: Bearer $PADDOCK_MCP_TOKEN" --scope user` → `/root/.claude/
    .claude.json`; `claude mcp remove paddock`.
- **`src/services/drivers/index.js`** — shared `getMcp(type, url)` call site
  (serializes capabilities + commands; unknown types fall back to openclaw).
- **`src/app.js`** — `GET /api/agent-types/:type/commands` now returns the `mcp`
  block.
- **Grants (already enforced)** — `src/mcp.js` tool gate: `read` key → read-only
  tools; `target:agent:<pad>` → base read + `exec` + `workspace_write` on that
  PAD; `tools:lifecycle|recreate|create|delete|reset` opt-in; `list_agents`
  target-filtered; owner/admin checks unchanged.

Live verification (2026-08-12): all six drivers connected with a piped key →
live MCP `initialize` HTTP 200 from the agent container → inspect → clean
disconnect. Peer-mode release gate PASSED (pad-opencode-proj via
`container:gluetun-proton1`). hermes `mcp test paddock` → 19 tools; claude
`mcp list` → ✔ Connected; openclaw probe → 19 tools. Scoped-key create +
enforcement re-verified. `mcp.test.js` 17/17, `node --check`, `vite build` all
green. All bootstrap/test API keys revoked (zero `35b*` keys remain).

### CommandsPane change (2026-08-12)

The plan-35b UI deliverable — a driver-driven **MCP group of pills** in the
CommandsPane (Connect Paddock MCP / List MCP servers / Test / Disconnect plus
openclaw-only MCP management pills) — was **removed at the user's request**: the
command pane should hold only agent commands. `CommandsPane.jsx` no longer
renders any MCP group, state, or fetch (`useConfirm` import dropped); verified
live on both a picoclaw and an openclaw page. The backend `mcp` block in
`/api/agent-types/:type/commands` is **kept** (tests depend on it; the connect
commands are needed by this plan). The user then asked for the capability to
surface in the **Settings** panel as a toggle like "Allow docker in the
container" — that is this plan.

## Goal

Add a Settings-panel switch **"Allow agent to control paddock"** that mirrors
the "Allow docker in the container" toggle: one click connects the agent to
Paddock's MCP server with a dedicated, revocable, restricted API key; one click
disconnects and revokes it. No terminal paste, no CommandsPane pills.

## Approach

### Phase 1 — Backend: dedicated endpoint + persistence

- New `POST /api/agents/:name/paddock` with `{ enable: true|false }`
  (csrfCheck + requireAuth, owner-only like other agent routes). A dedicated
  endpoint, NOT the `/api/agents/:name/settings` POST, because wiring MCP needs
  **no container recreate** — the settings job machinery (prepareAgentChanges →
  applyAgentChanges) is for recreate-requiring changes.
- Persist state in the instance `meta.env` (critical state, same place as
  `DOCKER`): `MCP_PADDOCK=1|0` + `MCP_PADDOCK_KEY_ID=<key id>`.
- `vm.readSettings(name)` gains `allowPaddock: meta.MCP_PADDOCK === '1'` so the
  GET returns it; the Settings UI renders the switch from it.

### Phase 2 — Backend: provision / connect / revoke logic

New small service (or vm-manager functions) `applyPaddockMcp(name, enable, ownerUserId)`:

- **Enable:**
  1. If `MCP_PADDOCK_KEY_ID` exists and the key is still active (not revoked),
     reuse it; else `apiKeys.create(ownerUserId, 'mcp-' + name, scopes)` with
     scopes `target:agent:<name>` (least privilege: base read + `exec` +
     `workspace_write` on its own PAD — the agent already controls its own
     container; it gains no fleet or cross-PAD rights). Key name must match
     `/^[A-Za-z0-9]{3,64}$/` — `mcp-<pad>` is valid.
  2. Run the driver's connect command **non-interactively**: `docker exec -i
     <cont> sh -c '<buildConnect()>'` with the raw key piped to stdin (the
     command's `bootstrap()` reads `PADDOCK_MCP_TOKEN` from stdin — exactly the
     flow verified in the 35b E2E). The key never appears in argv, logs, or
     frontend state. Container must be running; if stopped, report it.
  3. Write `MCP_PADDOCK=1` + `MCP_PADDOCK_KEY_ID` to meta.env.
  4. Verify: driver `buildInspect()` shows `paddock`; where the driver has a
     test (`buildTest`, e.g. openclaw probe / hermes test), run it and surface
     the tool count.
- **Disable:**
  1. Run the driver's `buildDisconnect()` in the container (ignore "not
     configured" errors).
  2. Revoke the key via `apiKeys.remove(id, ownerUserId)`.
  3. Clear `MCP_PADDOCK` + `MCP_PADDOCK_KEY_ID` from meta.env.
- **Idempotent:** toggling on when already on = verify + reconnect; toggling
  off when already off = no-op success.
- **Revoke-on-delete:** `removeVm` (delete agent) must revoke any live
  `MCP_PADDOCK_KEY_ID` for that agent before/after teardown.
- **Stale handling:** if the agent's data folder was reset (recreate with
  reset), the config is gone but the key is not — re-enable should reconnect
  and reuse, disable should still revoke.

### Phase 3 — Frontend: Settings switch

In `src/client/src/pages/agent/SettingsTab.jsx`, add a section right below the
"Allow docker in the container" card (4b):

- Title **"Allow agent to control paddock"**, description:
  "Gives this agent a restricted Paddock API key so it can talk to Paddock's MCP
  server — read/inspect its own agent, config, settings and workspace, and run
  exec in its own container. No other agents or fleet settings are exposed."
- Same `role="switch"` toggle as docker; state from `settings.allowPaddock`.
- On toggle: confirm (enable = info-style, disable = danger-style), call
  `POST /api/agents/:name/paddock` `{ enable }`, show a small inline status
  (enabled: URL + driver type + connection result e.g. "19 tools"; error → toast
  with message), refresh settings. No modal/SSE job expected (no recreate).
- When on, show the computed URL + a note that the key is revocable here and in
  Profile → API keys.

### Phase 4 — Docs + plan conclusion

- `docs/tabs/settings.md`: document the toggle (this absorbs plan 09 Phase 4,
  which it had intentionally-not-implemented).
- `docs/backend/services.md` / `docs/tabs/mcp.md`: endpoint, meta flags, key
  scope, driver credential locations (already in 35b research).
- After live verification + user approval: conclude plan 35b and 35c (absorb
  into docs, remove both plan files).

## Files

- **New** `src/services/paddock-mcp.js` — already exists (35b); reused for the
  URL.
- **New (mod)** `src/services/vm-manager.js` (or a small `services/paddock-mcp-service.js`)
  — `applyPaddockMcp(name, enable, ownerUserId)`; meta.env read/write;
  `readSettings` gains `allowPaddock`; `removeVm` revokes the key.
- **Mod** `src/app.js` — `POST /api/agents/:name/paddock` route.
- **Mod** `src/client/src/pages/agent/SettingsTab.jsx` — the new switch section.
- **Mod** `docs/tabs/settings.md` (+ mcp/backend notes).
- **Test** `src/test/` — extend or add tests for the endpoint + meta flags
  (run individually per AGENTS.md; never the combined suite).

## Progress

- [ ] Phase 1: `POST /api/agents/:name/paddock` + `MCP_PADDOCK`/
      `MCP_PADDOCK_KEY_ID` meta flags + `readSettings.allowPaddock`
- [ ] Phase 2: key provisioning (create/reuse/revoke), non-interactive connect
      via `docker exec -i` + stdin bootstrap, verify via inspect/test
- [ ] Phase 2: idempotent enable/disable, revoke-on-delete, reset-stale handling
- [ ] Phase 3: Settings switch UI (state, confirm, enable/disable call, status
      line) — browser-verified live on a real PAD
- [ ] Phase 4: docs updated; live E2E (enable → MCP initialize 200 → tools →
      disable → key revoked)
- [ ] User approval → conclude plans 35b + 35c (absorb, delete plan files)

## Verification

```bash
curl -s http://10.69.1.164:6789/api/agents/pad-test-codex/settings   # allowPaddock
# UI: toggle ON on pad-test-codex →
#   docker exec pad-test-codex <inspect> shows paddock server;
#   live MCP initialize from container → HTTP 200;
#   key 'mcp-pad-test-codex' appears in Profile → API keys with target grant
# UI: toggle OFF →
#   driver config no longer has paddock; key revoked; meta flags cleared
# delete agent → its mcp-* key is revoked
```

## Open questions

- **Grant breadth:** default scopes `target:agent:<pad>` (read + exec +
  workspace on its own PAD). Should the toggle also grant `tools:lifecycle`
  (agent can start/stop/restart its own container) or stay exec-only? Recommend
  staying at the default; a future "grants" selector in the Settings card could
  expose lifecycle.
- **Non-interactive probe:** for drivers whose `buildTest` is a CLI probe
  (openclaw/hermes/codex), run it post-connect and surface tool count — or keep
  the enable path to inspect-only to avoid a long probe? (Recommend: inspect
  always, probe when it completes quickly.)
- **Stopped agent:** enable while the container is down — connect later on next
  start, or require running? (Recommend: allow toggle, defer connect to a
  running container + retry on start.)
