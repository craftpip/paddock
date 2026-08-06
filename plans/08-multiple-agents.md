# Agent Build Images + Agent Driver Architecture — Plan

## Status: Proposed (2026-08-06)

The original "Settings page" part of this plan (the "allow docker in the
container" checkbox) shipped as part of plan 09 (2026-08-04) — removed here.
This plan now covers the **agent driver architecture** plus the new
**build images** (opencode, codex, claude) added to the existing set.

## Goals (one per driver)

Everything is a driver. Every agent type — openclaw, picoclaw, hermes,
opencode, codex, claude — is an equal citizen, and each one is a separate goal.
A type is not done until its driver exists and an agent of that type works end
to end (create, terminal, versions, workspace, backup, settings toggle).

1. **Driver framework + openclaw reference driver** — build
   `src/services/drivers/` + `getDriver()`, switch all consumers over
   (vm-manager, app.js, agent-registry, backup-manager, Commands API), and move
   openclaw's current behavior in unchanged. Regression: everything that works
   today keeps working.
2. **picoclaw driver** — create a test agent, discover what actually works
   inside the container, encode it in the driver. First time picoclaw is a
   working type.
3. **hermes driver** — same, on its own.
4. **opencode driver + image** — Dockerfile + driver + CreateAgent option.
5. **codex driver + image** — same, on its own.
6. **claude driver + image** — same, on its own.

Docker MCP (Part 3) is a separate follow-up, not part of any driver goal.

## Goal plans & progress tabs

Every goal is big enough that it gets its own plan file and a progress tab we
keep updated while we work. When a goal starts, its file moves from **Planned**
to **In progress**, and we tick its Progress checklist as we go. A goal is done
only when every item is ticked and verified.

| Goal | Plan file |
|------|-----------|
| 1. Driver framework + openclaw | `12-goal-1-driver-framework.md` |
| 2. picoclaw driver | `13-goal-2-picoclaw-driver.md` |
| 3. hermes driver | `14-goal-3-hermes-driver.md` |
| 4. opencode driver + image | `15-goal-4-opencode.md` |
| 5. codex driver + image | `16-goal-5-codex.md` |
| 6. claude driver + image | `17-goal-6-claude.md` |
| 7. Docker MCP | `18-goal-7-docker-mcp.md` |

Rule: never start a goal without its progress doc open. Progress lives in the
goal's own file, not here.

## Part 1 — Agent driver architecture

### Why

Agent-specific knowledge is scattered and hardcoded today — and every feature
shipped so far was built and tested against openclaw only:

- `readOpenClawVersion()` runs `openclaw --version` (vm-manager.js:78-91)
- `AGENT_IMAGES` / `AGENT_BUILD_REL` / `AGENT_BASE_IMAGES` maps
  (vm-manager.js:12-24, 59-64)
- `containerDataDir()` special-cases hermes (vm-manager.js:26-28)
- `createVm()` setup guard hardcodes openclaw/picoclaw (vm-manager.js:345-368)
- Settings version/update routes assume an OpenClaw base image (app.js:771-808)
- CommandsPane.jsx hardcodes the `openclaw ...` command groups in the frontend
  bundle — the "buttons" on the Commands page are locked to OpenClaw
- Workspace paths are derived with an `openclaw` fallback hardcoded
  (`getWorkspaceRoot`/`getConfigRoot`, agent-registry.js:75-84) and the
  frontend workspace tab hardcodes the container root `/root/.openclaw`
  (AgentDetail.jsx:294-295)
- Backup runs `openclaw backup create` inside the container
  (backup-manager.js) — openclaw-only
- Picoclaw's setup/version/commands and hermes' version/commands have never
  been validated — the `openclaw` assumptions break them (e.g. hermes has no
  `openclaw` binary)

### Driver interface

`src/services/drivers/<type>.js` — one module per agent type, uniform shape:

| Field | openclaw | codex (example) |
|-------|----------|-----------------|
| `type` / `label` | `openclaw` / `OpenClaw` | `codex` / `Codex` |
| `buildImage` | `paddock-vm-openclaw:latest` | `paddock-vm-codex:latest` |
| `buildRel` | `../../src/vm-builds/openclaw` | `../../src/vm-builds/codex` |
| `baseImage` | `ghcr.io/openclaw/openclaw:latest` | `node:20-slim` |
| `dataDir` | `/root/.openclaw` | `/root/.codex` |
| `workspaceDir` | `/root/.openclaw/workspace` | `/root/.codex/workspace` |
| `setupSteps` | `[{ cmd: 'openclaw', args: ['setup', '--baseline'] }]` | `[]` |
| `backupSteps` | `[{ cmd: 'openclaw', args: ['backup', 'create', '--output', '/tmp/{name}_{ts}.tar.gz'] }]` | `[]` (no backup support) |
| `installDockerBuildArg` | `INSTALL_DOCKER=1` | `INSTALL_DOCKER=1` |
| `currentVersion(name)` | runs `openclaw --version` | runs `codex --version` |
| `availableVersion()` | reads base image version label | `''` (no label) |
| `commands` | Commands page groups | codex-specific groups |

`src/services/drivers/index.js` exports `getDriver(type)` — returns the module,
falls back to the openclaw driver when a type has none. The driver is the single
source of truth for how the dashboard, terminal, and routes treat an agent.

### Workspace layout

The driver owns where the agent's workspace lives, container side and host side:

- **Host**: `instances/<name>/<agent>/workspace`
- **Container**: `driver.workspaceDir` (e.g. `/root/.openclaw/workspace`,
  `/root/.codex/workspace`)

The mount stays `instances/<name>/<agent>` → `dataDir`, so `workspaceDir` being
inside `dataDir` needs no extra mount — the existing bind covers it. For every
agent the terminal's working directory is `workspaceDir` (opencode/codex/claude
run their CLI from there), not the config dir.

### Consumers

- **vm-manager.js** — replace the maps + version helpers with driver calls.
  `containerDataDir()` becomes `getDriver(agent).dataDir`. The createVm setup
  guard becomes "run `setupSteps` if non-empty".
- **app.js** — settings + update-info routes call
  `getDriver(type).currentVersion(name)` / `.availableVersion()` instead of the
  OpenClaw-only helpers.
- **Commands page** — new `GET /api/agent-types/:type/commands` returns
  `driver.commands`; CommandsPane.jsx fetches + renders instead of hardcoding
  the groups. This is the "buttons live in the driver" part.
- **CreateAgent.jsx** — type options + setup steps from the driver registry so
  new types appear without editing the form.
- **SettingsTab.jsx** — version row via `driver.currentVersion()`; drivers
  without a base-image label report no update available, which is expected.
- **agent-registry.js** — `getWorkspaceRoot()` / `getConfigRoot()` /
  `buildAgent()` derive paths from `driver.workspaceDir` / `driver.dataDir`
  instead of defaulting to `openclaw`.
- **AgentDetail.jsx** — the workspace tab's container root becomes
  `driver.workspaceDir` instead of the hardcoded `/root/.openclaw`.
- **backup-manager.js** — backup/restore runs `driver.backupSteps`; types
  without backup support show "not supported" instead of a broken
  `openclaw backup` call.

## Part 2 — New build images

Each new type = one driver + one Dockerfile, nothing else.

| Type | Base image | CLI install | Config dir | version cmd |
|------|-----------|-------------|------------|-------------|
| `opencode` | `node:20-slim` | `npm i -g opencode-ai` | `/root/.opencode` | `opencode --version` |
| `codex` | `node:20-slim` | `npm i -g @openai/codex` | `/root/.codex` | `codex --version` |
| `claude` | `node:20-slim` | `npm i -g @anthropic-ai/claude-code` | `/root/.claude` | `claude --version` |

Dockerfile = the openclaw one minus the OpenClaw bits:

- `ARG INSTALL_DOCKER=0` + conditional `docker.io` install — **same pattern as
  openclaw, do NOT bake the CLI in**. The shipped settings flow auto-rebuilds
  with `INSTALL_DOCKER=1` when the image lacks the CLI (app.js:861-890), so no
  settings-route change is needed.
- **No `mcporter`** — it is OpenClaw's MCP runner; nothing to do with these CLIs.
- `start.sh` = `sshd &` + keep-alive (`tail -f /dev/null`) — these CLIs have no
  gateway daemon; the terminal tab is the interface.
- sshd + `ROOT_PASSWORD` handling, TZ, `WORKDIR /root`, `EXPOSE 22`.

`containerDataDir()` already maps non-hermes types to `/root/.<agent>` — the
config dirs come free. `createVm()` already skips `setup --baseline` for
non-openclaw/picoclaw — free, and after Part 1 it reads `driver.setupSteps`
instead of the hardcoded guard.

### Cleanup

- `nanobot` is half-wired today: `AGENT_IMAGES` + `AGENT_BUILD_REL` entries
  exist but there is no `src/vm-builds/nanobot/` and no CreateAgent option.
  Give it a driver stub (or drop the map entries) while migrating to drivers.
- `src/vm-builds/monitor` is dead — no map entries, nothing references it.
  Delete the folder while touching the build area.

## Part 3 — Docker MCP (openclaw only)

`openclaw mcp add docker` applies to openclaw/picoclaw agents only. opencode /
codex / claude configure MCP through their own CLIs (opencode config, codex
`config.toml`, `.mcp.json` for claude) — out of scope here; the driver docs can
carry a per-type note later.

Verify the exact command and package against the current docs before
documenting it in the MCP commands group (`docker-mcp` vs `mcp-server-docker`).

## Files

- **New** `src/services/drivers/index.js` — registry + `getDriver()`
- **New** `src/services/drivers/{openclaw,picoclaw,nanobot,hermes}.js` — migrate
  existing per-type behavior
- **New** `src/services/drivers/{opencode,codex,claude}.js` — new-type drivers
- **New** `src/vm-builds/{opencode,codex,claude}/Dockerfile`
- **Modified** `src/services/vm-manager.js` — maps/version/setup guards → driver
  calls
- **Modified** `src/services/agent-registry.js` — workspace/config root
  derivation → driver paths
- **Modified** `src/services/backup-manager.js` — backup/restore via
  `driver.backupSteps`
- **Modified** `src/app.js` — settings/update-info version via driver;
  `GET /api/agent-types/:type/commands`
- **Modified** `src/client/src/pages/agent/CommandsPane.jsx` — fetch + render
  command groups from the driver
- **Modified** `src/client/src/pages/CreateAgent.jsx` — type options + setup
  steps from the driver registry
- **Modified** `src/client/src/pages/agent/SettingsTab.jsx` — version row via
  driver
- **Modified** `src/client/src/pages/AgentDetail.jsx` — workspace tab container
  root via driver

## Phases (one per goal, worked through one at a time)

### Phase 1 — Driver framework + openclaw reference driver
- Build `src/services/drivers/` + `getDriver()`.
- Switch consumers (vm-manager, app.js, agent-registry, backup-manager,
  Commands API) through the driver interface.
- Move openclaw behavior (maps, versions, data dir, setupSteps, backupSteps,
  commands) into the reference driver.
- Regression against a live openclaw PAD: create, terminal, versions, update
  card must behave exactly as before.

### Phase 2 — picoclaw driver
- Create a test picoclaw agent; discover the real behavior inside the
  container — does `openclaw setup --baseline` run? what version/CLI commands
  exist? what's its config dir?
- Encode the answers in the driver. Verify create, terminal, versions,
  workspace, backup, settings toggle before moving on.

### Phase 3 — hermes driver
- Same as Phase 2, on its own. Create a test hermes agent, discover the real
  behavior (version binary, config dir, commands), encode it, verify end to end.

### Phase 4 — opencode driver + image
- Dockerfile + driver + CreateAgent option.
- Create a test agent; terminal drops into shell; `opencode --version` works;
  data dir persists across restart; terminal `pwd` = `driver.workspaceDir`;
  files written there show up in the workspace tab.

### Phase 5 — codex driver + image
- Same as Phase 4, on its own (`codex --version`).

### Phase 6 — claude driver + image
- Same as Phase 4, on its own (`claude --version`).

### Phase 7 — Docker MCP (openclaw)
- Manual `openclaw mcp add` on a PAD with the checkbox on; confirm the tool
  works. Document the command in the MCP commands group.

## Verification

```bash
# build types
docker exec mycodex codex --version   # or opencode / claude

# commands endpoint
curl http://10.69.1.164:6789/api/agent-types/codex/commands   # codex groups

# settings toggle (already shipped via plan 09 — no re-test needed)
# docker inspect → socket mount present/absent, docker ps from inside works/not
```

## Security & edge cases

| Case | Handling |
|------|----------|
| docker socket = host root | Warning in the Settings confirm popup (shipped, plan 09) |
| Image without docker CLI | Settings toggle auto-rebuilds with `INSTALL_DOCKER=1` (shipped) |
| No driver for a type | `getDriver()` falls back to openclaw — never crashes |
| Driver with no base-image version label | Update card shows "no update available" — expected |
| Agent image with no setup steps | `setupSteps: []` → createVm skips baseline |
| Untested agent type (picoclaw/hermes today) | Its driver phase creates a test agent and encodes the real behavior in the driver |
| Compose file hand-edited | Regeneration overwrites it — machine-generated |

## Open questions

- **"Cloud" = Claude?** Naming the third type `claude`
  (`@anthropic-ai/claude-code`). Say the word if it meant something else.
- **Drivers backend-only vs mirrored in the frontend?** Recommendation:
  backend-only, with command groups served over the API.
- Commands endpoint shape: `GET /api/agent-types/:type/commands` vs bundled
  into `/api/config`.

## Related

- `10-terminal.md` — the agent page modes; Commands is the home mode
- `09-settings-page.md` — shipped the settings page this plan originally
  proposed (2026-08-04)
- Existing builds: `src/vm-builds/{openclaw,picoclaw,hermes,monitor}`
- `06-paddock-own-mcp.md` — unrelated; the harness idea was dropped
