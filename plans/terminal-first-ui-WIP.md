# Terminal-First UI — WORK IN PROGRESS / RESUME NOTES

> Created 2026-08-02 mid-execution. This file is the compaction-resume point for
> the `plans/terminal-first-ui.md` execution. Read this FIRST, then continue the
> Migration Checklist in the main plan.

## Status

Research + CLI doc verification done. Starting implementation (Terminal.jsx first).
Todos initialized in-session but nothing implemented yet.

## Environment Facts (verified this session)

- App webui container: **`paddock`** (image `paddock-webui:latest`), listens on
  **port 6789** (NOT 5050 — AGENTS.md is stale on this). Docker maps host
  `6789` and `5173` (vite).
- Host IP used for browser MCP: `http://10.69.1.164:6789` returns 200.
- Vite dev server **not running**. To start (per AGENTS.md):
  `docker exec -d paddock sh -c 'cd /app/client && npm run dev'` → serves
  `http://10.69.1.164:5173` (proxies `/api` + `/ws` to 6789).
- Browser MCP config: `~/.config/opencode/opencode.json` → browser at
  `http://10.69.1.164:3000/mcp` (enabled). jellyfin/torrent MCPs disabled.
- Browser MCP currently has 0 targets (`browser_Target_getTargets` empty).
- Test PAD running: **`pad-openclaw-work-pls`** (prefix is `pad` from
  `CONTAINER_PREFIX` env). Other containers like AGENT-*, vm-jake, qbittorrent,
  price-tracker-* are NOT ours — never touch them (project Do Not Do rule).
- Ports in vite.config.js proxy to `http://localhost:6789` / `ws://localhost:6789`.

## Codebase Map (key files)

- `src/app.js` (1741 lines) — Express + all `/api/*` routes + WebSocket server.
  Boot: `app.listen(6789)`, `new WebSocketServer({ server })` at line 1549-1551.
- `src/routes/agents.js` (857 lines) — **NOT mounted** anywhere in app.js (legacy
  EJS router, dead for the SPA). Contains EJS models routes
  `/models/set-primary|set-fallback|remove-provider`. The React ModelsTab calls
  `/api/agents/:name/models/set-primary` which **404s today** (pre-existing bug,
  out of scope).
- `src/services/agent-registry.js` — PAD discovery + `logActivity(agentId,
  category, action, status, details, resourceRef)` + `getActivity(agentId,
  limit)` (SQLite `activity_events` table: agent_id, category, action, status,
  details, resource_ref, timestamp).
- `src/services/db.js` — SQLite metadata store `src/data/app.db`.
- `src/services/cmd.js` — runCmd helper.
- `src/creds.js` — credential manager (bot tokens / user ids / api keys).

### Backend WebSocket (app.js:1551-1738)

- `wss.on('connection')` — path `/ws/{terminal|messaging}/{name}`. Rejects if
  container not running or unsafe name.
- Auth: session cookie check unless AUTO_LOGIN.
- **`/ws/terminal/:name`** (lines 1648-1737) — THE engine. dockerode PTY:
  `container.exec({Tty:true, Cmd:['bash','-i'], Env:['TERM=xterm-256color']})`,
  `exec.start({hijack:true})`, demuxStream, resize via `exec.resize`. Client
  sends raw bytes + `{type:'resize',cols,rows}` JSON.
- **`/ws/messaging/:name`** (lines 1610-1640) — spawns `docker exec -i <name> sh
  -c 'script -qfec "...cmd..."'` per `{type:'run'}`; `{type:'credential-paste',
  value}` writes value+'\n' to stdin (leaks secret into console — plan replaces
  this). **TO BE RETIRED.**
- **`/api/agents/:name/exec-stream`** (line 1469) — SSE, **TO BE RETIRED**.

### API endpoints used by SPA (all in app.js)

- `/api/agents` (list), `/api/agents/:name` (detail), `/api/config`
  (returns `containerPrefix`), `/api/agents/:name/stats`
  (`{stats: {CPUPerc,MemUsage,NetIO,BlockIO}}`), `/api/agents/:name/logs?tail=N`
  (`{logs}`), `/api/agents/:name/sessions` (`{sessions}`),
  `/api/agents/:name/activity?limit=` (`{activity}`),
  `/api/agents/:name/config` (GET → `{config(redacted), configRaw}`; POST body
  `{config}` writes openclaw.json), `/api/agents/:name/backups` /
  `/backups/create` / `/backups/restore` / `/backups/delete`,
  `/api/credentials` (`{api_keys, bot_tokens, user_ids}`),
  `/api/agents/:name/channels-list` (`{chat: {id:{name}}}`, `?refresh=true`),
  `/api/agents/:name/channels-status`, `/api/agents/:name/channels/remove`,
  `/api/agents/:name/mcp` (GET `{servers:[{name,transport,command,enabled,ok}]}`,
  `/mcp/add`, `/mcp/remove`, `/mcp/toggle`, `/mcp/test-url`, `/mcp/probe`),
  `/api/agents/:name/skills` (GET `{skills, check}`), `/skills/install|remove|update|verify|info`,
  `/api/agents/:name/exec` (POST — keep, useful).
- Start/stop/restart: `/api/agents/:name/{start|stop|restart}` (POST).

### Frontend (React 19 + Vite 6 + Tailwind 4 + zustand)

- `src/client/src/App.jsx` — routes. `/agents/:agentId` →
  `<AuthPage fullHeight><AgentDetail/></AuthPage>`.
- `src/client/src/pages/AgentDetail.jsx` (1649 lines) — THE file to restructure.
  Current: sidebar (w-56) with `SidebarStatus` + 13 hash-based tabs
  (`#overview|workspace|terminal|logs|sessions|config|mcp|skills|models|messaging|backups|health|activity`),
  tab content in `<div id="tab-content">`. Components inside this file:
  - `SidebarStatus` (24-111): avatar, status pill, CPU/MEM stats (poll
    `/stats` 3s), Start/Stop/Restart buttons.
  - `HEALTH_GROUPS` (137-181) + `HealthTab` (183-234): THE reference
    implementation — grouped pill buttons + `<Terminal ref>` at height 55vh.
    `run()` helper with confirm/danger confirm.
  - `OverviewTab` (279): StatBoxes (Type/Runtime/Model) + QuickLinks + recent
    activity.
  - `TerminalTab` (357): just `<Terminal name title/>`.
  - `WorkspaceTab` (363-698): file browser + modal editor (Escape handling,
    dirty/saved indicator). ~335 lines — keep as-is, move to mode.
  - `LogsTab` (702), `SessionsTab` (739), `ActivityTab` (781), `McpTab` (825),
    `ConfigTab` (1072), `BackupsTab` (1117), `ModelsTab` (1195), `MessagingTab`
    (1286, uses /ws/messaging + creds side panel), `SkillsTab` (1463) +
    `SkillCard`/`InstallForm`/`sourceLabel` (1457).
- `src/client/src/components/Terminal.jsx` (440 lines) — forwardRef component.
  Props: `name, title, height='70vh', minHeight='480px', disabled,
  onCommandStart, onCommandDone`. Imperative API: `runCommand(cmd)` (only
  sentinel-tracks in LOCKED mode via `isInputLocked()`), `write`, `clear`,
  `reconnect`, `focus`, `isConnected`, `setLocked/lock/unlock/isLocked`.
  Sentinel: `pendingMarkersRef` (Set), `outputTailRef` rolling tail 512,
  detection = output contains `'\n'+marker`; on empty set → cmdRunning=false,
  refreshLockUI, onCommandDone. Internals: `disabledRef`, `manualLockRef`,
  `cmdRunningRef`, `isInputLocked()` returns
  `disabledRef.current || manualLockRef.current` (auto-unlock while cmd running).
  State: connected, fontSize, initError, cmdRunning, uiLocked. Header has
  A-/A+ font, Clear, Reconnect. `initTerminal()` with generation counter
  (`genRef`) for async xterm import.
- `src/client/src/components/Console.jsx` (73 lines) — display-only sibling,
  stays for read-only surfaces.
- `src/client/src/lib/api.js` — `api(path, {body, method, headers})`, CSRF via
  `X-CSRF-Token` header, throws `{status,...data}` on !res.ok.
- `src/client/src/stores/agents.js` — zustand: fetchAgents, startAgent,
  stopAgent, restartAgent, updateAgentStatus.
- `src/client/src/components/DashboardLayout.jsx` — top nav; `fullHeight` →
  `h-screen flex flex-col overflow-hidden` (AgentDetail route uses fullHeight).
- `src/client/src/pages/CreateAgent.jsx` — after create: non-clone → "Go to
  Agents" button (navigate('/agents')); clone → auto navigate('/agents') after
  1.8s. **Plan: land on Commands mode after creation** → change these to
  `navigate('/agents/'+job)` (job is the full agent name).
- Vite: `base:'/'`, outDir `../public`, proxy `/api`→6789, `/ws`→6789 ws.

## Terminal component changes needed (from plan §Terminal Component Changes)

1. **`runCommand(cmd, { track: true })`** — always use sentinel path when track
   OR isInputLocked(); fire onCommandStart/onCommandDone; do NOT lock input in
   track mode. Only one tracked command at a time (UI disables buttons while
   `runningCmd` state set). Current sentinel logic already supports a Set of
   markers; tracked (unlocked) mode just needs `runCommand` to route through it.
2. **`pasteSecret(value)`** — plan says: `stty -echo\r <secret>\r stty echo\r`
   (3 writes: 'stty -echo\n', value+'\n', 'stty echo\n'). NOTE (research
   concern): if an interactive foreground program is reading stdin, the
   `stty -echo` line is consumed by THAT program, not bash — so the stty trick
   only reliably works when bash's own `read`/prompt is reading. For
   `openclaw models auth paste-api-key` (reads stdin) the injected command could
   be prefixed `stty -echo; <cmd>; stty echo` instead. **Must TEST live against a
   real interactive flow and adapt.** Keep the plan's 3-write pasteSecret as the
   initial implementation.
3. **Lock toggle** — Lock/Unlock button in terminal header, persisted per agent
   via `localStorage['pad-term-lock-<name>']`. Calls imperative
   `setLocked(v)`. Buttons still inject in both modes.
4. **History button** — clock icon in terminal header → popover listing past
   commands (from `GET /api/agents/:name/activity`, category 'command'), click
   re-runs. Clear = visible scrollback only; Reconnect confirm before teardown.

## Backend change needed

- `POST /api/agents/:name/command-log` body `{cmd, status, ts}` → reuse
  `registry.logActivity(name, 'command', 'run', status, cmd, null)`. Record on
  command completion (sentinel resolve → status 'ok'). History popover reads
  existing `GET /api/agents/:name/activity` (category 'command').
- Retire `/ws/messaging/:name` + `credential-paste`, `/ws/exec` (doesn't exist —
  only `/ws/terminal` and `/ws/messaging`), and
  `/api/agents/:name/exec-stream` (line 1469-1516).

## Restructure plan for AgentDetail.jsx

- New layout: AgentHeader (persistent) → ModeTabs (`commands, workspace, config,
  logs, sessions, activity`) → flex column: mode content (flex-1 min-h-0
  overflow-y-auto p-6) + terminal dock (`h-[40vh] min-h-[320px] shrink-0 px-6
  pb-6`). `<Terminal ref={termRef} name={agent.name} title={agent.display_name}
  height="100%" minHeight="300px"/>` mounted ONCE at page level, never unmounted
  on mode switch.
- Mode in URL hash `#commands` etc. (default commands). navigate() on tab click.
- Keep WorkspaceTab/LogsTab/SessionsTab/ActivityTab/ConfigTab components as-is
  (mostly copy). ConfigTab receives termRef for its "validate/reload/set"
  buttons (plan: Config group lives on Commands page; Config MODE is the JSON
  editor).
- HealthTab is DELETED (its groups move into CommandsPane). MessagingTab's
  /ws/messaging usage is DELETED (creds panel moves into CommandsPane Messaging
  group; secret paste via termRef.pasteSecret). ModelsTab/McpTab/SkillsTab/
  BackupsTab display logic folds into CommandsPane strips.
- New files: `pages/AgentDetail.jsx` (restructured), `pages/agent/CommandsPane.jsx`,
  `pages/agent/AgentHeader.jsx` (or inline). Suggest folder `src/client/src/pages/agent/`.
- CommandsPane props: `{ agent, termRef }`. Shared `run(cmd, opts)` helper uses
  termRef.current?.runCommand(cmd, {track:true}), logs to command-log on
  completion, reloads data strips (onCommandDone → reload all strip fetchers).
- Group cards (2-3 per row): colored header dot + pill buttons + search filter
  box at top filtering by label/command. GROUP_COLORS / DOT_COLORS per plan.
- Messaging group: channel dropdown (from channels-list) + buttons
  Create/Login/Logout/Remove/Status/List all + compact creds panel
  (bot_tokens/user_ids from /api/credentials) with paste-on-click via
  termRef.pasteSecret.
- Models group: provider input/dropdown + buttons API key/OAuth/token/List/Full
  status + primary/fallback strip (from /api/agents/:name/config).
- MCP group: buttons + existing server list display (from /api/agents/:name/mcp).
- Skills group: buttons + skill list (from /api/agents/:name/skills).
- Backups group: Create/Restore buttons + backup table (from
  /api/agents/:name/backups).
- Config group: Validate/Reload/Set buttons (CLI).
- Recent-activity strip at top of Commands page (from old OverviewTab).

## OpenClaw CLI commands (from plan §Command Definitions — VERIFY on
  docs.openclaw.ai before hardcoding; per AGENTS.md rule always check online)

Messaging:
- Setup/Configure: `openclaw channels add --channel <name>` (interactive)
- Login: `openclaw channels login --channel <name>` (interactive)
- Logout: `openclaw channels logout --channel <name>`
- Remove: `openclaw channels remove --channel <name> --delete`
- Status: `openclaw channels status`
- List: `openclaw channels list --all`

Models:
- API key: `openclaw models auth paste-api-key --provider <id>` (interactive)
- OAuth: `openclaw models auth login --provider <id>` (interactive)
- Token: `openclaw models auth paste-token --provider <id>` (interactive)
- Re-auth: `openclaw models auth login --provider <id> [--force]` (interactive)
- Set default: `openclaw models set <provider/model>`
- List configured: `openclaw models auth list --json`
- List all: `openclaw models list --all --json`
- Full status: `openclaw models status --json`

Health (existing HEALTH_GROUPS — already working): openclaw health/status/logs/
doctor/doctor --fix/--lint/--deep/doctor --state-sqlite compact/security audit
(--deep/--fix)/memory status/index/--force/promote --apply/backup create/update/
channels status --probe.

MCP (verified 2026-08-02 from https://docs.openclaw.ai/cli/mcp):
- List: `openclaw mcp list` / Status: `openclaw mcp status` / Doctor: `openclaw mcp doctor`
- Probe: `openclaw mcp probe` / Add: `openclaw mcp add` (interactive) / Configure: `openclaw mcp configure`
- Set: `openclaw mcp set` / Unset: `openclaw mcp unset` / Reload: `openclaw mcp reload`
- Tools: `openclaw mcp tools` / Login: `openclaw mcp login` / Logout: `openclaw mcp logout`

Skills (verified from https://docs.openclaw.ai/cli/skills):
- Search: `openclaw skills search <query...>`
- Install: `openclaw skills install git:owner/repo[@ref]` or `install ./path`, `install --as <slug>`, `install --force`, `install --force-install`
- Update: `openclaw skills update @owner/<slug>` or `update --all` / `update --force-install`
- Verify: `openclaw skills verify @owner/<slug> [--json]`
- NOTE: no `skills remove`/`delete` in fetched excerpt — the SkillsTab already has a
  remove action; verify exact remove syntax before wiring Commands group. Existing
  backend `/api/agents/:name/skills/remove` already works, so reuse that.

Config (verified from https://docs.openclaw.ai/cli/config):
- Validate: `openclaw config validate` / `--json`
- File: `openclaw config file` / Schema: `openclaw config schema`
- Get: `openclaw config get <path> [--json]` / Set: `openclaw config set <path> <value>` / Unset: `openclaw config unset <path>`
- Patch: `openclaw config patch --file <f> | --stdin` (JSON5; `--dry-run`, `--replace-path`)
- NOTE: NO `openclaw config reload` in CLI docs — reloading is done via the Gateway
  (config hot-reload) or by restarting. Use `openclaw doctor`/restart instead. The
  plan's "Config reload" button should run `openclaw config validate` + hint text
  (hot reload applies most paths automatically).

Channels (verified from https://docs.openclaw.ai/cli/channels):
- List: `openclaw channels list` / `--all` / Status: `openclaw channels status [--probe]` (default timeout 10000ms, --json)
- Capabilities: `openclaw channels capabilities` / Logs: `openclaw channels logs [--channel <name|all>] [--lines <n>]`
- Add: `openclaw channels add --channel telegram --token <bot-token>` (non-interactive w/ channel flags; bare `add <name>` = wizard)
- Remove: `openclaw channels remove --channel <name> [--delete]`
- Login: `openclaw channels login --channel <name>` / Logout: `openclaw channels logout --channel <name>`
- Bindings: `openclaw agents bindings` / `openclaw agents bind` / `openclaw agents unbind`

Models (verified from https://docs.openclaw.ai/cli/models):
- API key: `openclaw models auth paste-api-key --provider <id>` (reads stdin; pipe value: `printf "%s\n" "$KEY" | openclaw ...`)
- OAuth: `openclaw models auth login --provider <id> [--device-code] [--set-default] [--force]`
- Token: `openclaw models auth paste-token --provider <id>` (reads stdin; `--expires-in 365d`)
- Logout: `openclaw models auth logout <profileId> [--yes]`
- Auth list: `openclaw models auth list [--provider <id>] [--json]`
- Set default: `openclaw models set <provider/model>` (writes agents.defaults.model.primary)
- Set image: `openclaw models set-image <provider/model>`
- List: `openclaw models list [--all] [--provider <id>] [--json]` (read-only)
- Status: `openclaw models status [--json]` (bare `openclaw models` == status)
- Fallbacks: `openclaw models fallbacks list|add <model>|remove <model>|clear`
- Aliases: `openclaw models aliases list|add <alias> <model>|remove <alias>`

Memory (verified from https://docs.openclaw.ai/cli/memory):
- `openclaw memory status [--deep] [--json]`
- `openclaw memory index [--force]` / `openclaw memory fix`
- `openclaw memory promote [--apply] [--limit <n>]` (preview by default)

Backup (verified from https://docs.openclaw.ai/cli/backup):
- `openclaw backup create [--output <dir>] [--verify] [--no-include-workspace] [--only-config] [--json]`
- `openclaw backup verify <archive>` / `openclaw backup sqlite create --global|--agent <id> --repository <dir>`

## NEXT STEPS (in order)

1. Start vite dev server in paddock container (see above).
2. Implement Terminal.jsx changes (tracked runCommand, pasteSecret, Lock toggle,
   history button, reconnect confirm). Test pasteSecret behavior LIVE.
3. Add backend command-log route.
4. Restructure AgentDetail.jsx + create CommandsPane.jsx + AgentHeader.
5. Wire create-flow to land on Commands mode.
6. Retire old WS endpoints after everything works.
7. Build (`cd client && npm run build`) + browser-test on 5173 (dev) then 6789
   (built) at http://10.69.1.164.
8. Update `plans/terminal-first-ui.md` (checklist) + this file as you go.

## Testing notes

- Browser MCP: create a target via `browser_Target_createTarget` url
  `http://10.69.1.164:6789/agents` (built) or :5173 (dev). Login may be needed —
  check /api/session (AUTO_LOGIN may be on: check .env / docker-compose env for
  paddock service).
- `docker logs paddock` for backend errors. Restart webui without rebuild:
  `docker compose up -d --no-deps --force-recreate paddock-webui` — but the
  container is named `paddock` and code is bind-mounted (`src` → `/app`), so
  Node needs a restart: `docker restart paddock` works for backend-only changes.
  For pure frontend dev use vite HMR (5173).
