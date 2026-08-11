# Driver Reference

Every agent type in Paddock — openclaw, opencode, picoclaw, hermes, codex,
claude — is an equal citizen backed by one driver module in
`src/services/drivers/`. The registry itself (`index.js`, `getDriver()`,
`listDrivers()`) and the driver interface fields are documented in
[backend/services.md](services.md); this page is the **per-driver reference**:
the concrete field values, command groups, and operational gotchas for each
type, discovered and verified in real containers.

> Last updated: 2026-08-09

## Quick reference

| | openclaw | opencode | picoclaw | hermes | codex | claude |
|---|---|---|---|---|---|---|
| Base image | `ghcr.io/openclaw/openclaw:latest` | `node:20-slim` | `sipeed/picoclaw:v0.2.5-launcher` | `nousresearch/hermes-agent:latest` | `node:20-slim` | `node:20-slim` |
| CLI install | image ships it | `npm i -g opencode-ai` | image ships it | image ships it | `npm i -g @openai/codex` | `npm i -g @anthropic-ai/claude-code` |
| `dataDir` | `/root/.openclaw` | `/root/.opencode` | `/root/.picoclaw` | `/opt/data` | `/root/.codex` | `/root/.claude` |
| `workspaceDir` | `/root/.openclaw/workspace` | `/root/.opencode/workspace` | `/root/.picoclaw/workspace` | `/opt/data` | `/root/.codex/workspace` | `/root/.claude/workspace` |
| `workspaceCapability` | `fixed` | `editable` | `fixed` | `none` | `editable` | `editable` |
| `configFile` | `openclaw.json` | `opencode.json` | `config.json` | `config.yaml` | `config.toml` | `settings.json` |
| `configFormat` | json | json | json | yaml | toml | json |
| `tuiCommand` | `openclaw` | `opencode` | `picoclaw agent` | `hermes` | `codex` | `claude` |
| `setupSteps` | `openclaw setup --baseline` | none | `picoclaw onboard` | `hermes setup --non-interactive` | none | none |
| `webApp` | none | OpenCode Web (:8080) | none | none | none | none |
| Version cmd | `openclaw --version` | `opencode --version` | `picoclaw version` | `hermes version` | `codex --version` | `claude --version` |
| Update available | from base label (cached) | no | no | no | no | no |

All six drivers expose the same shape: `type`/`label`, `templateDir`,
`baseImage`, `dataDir`, `workspaceDir`, `workspaceCapability`, `configFile`,
`tuiCommand`, `setupSteps`, `commands`, `currentVersion(name)`,
`availableVersion()`. `opencode` additionally carries a `webApp` descriptor;
`hermes` and `codex` carry `configFormat` (`yaml` / `toml`).

The `commands` field is what renders as the pill buttons on the agent detail
page's Commands tab; see [tabs/commands.md](../tabs/commands.md) for the full
mechanism and the per-type button matrix.

### LLM command catalogs (plan 35a)

Every driver also carries **`llmCommands`** (Set B) and **`notUsable`** — the
source for the MCP `agent_commands` tool. They are curated separately from the
UI `commands` because some buttons are interactive (TUI, prompt modal) and must
never be handed to a headless LLM:

- `llmCommands` — `[{ title, commands: [{ label, cmd, desc, caveats?,
  credentialInput? }] }]`, safe to run without a TTY via the MCP `exec` tool.
  `{key}` placeholders are filled by the LLM. `credentialInput: "stdin"`
  commands take a secret via `exec.stdin`.
- `notUsable` — interactive-only commands with no non-interactive form
  (`{ label, cmd, desc }`); the guidance tells the LLM to ask the user.

`drivers.getLlmCatalog(type)` serializes both into the `agent_commands`
response shape. The openclaw catalog is the only one live-verified per-command;
the others are derived from their CLI's own help output (see the driver files).

## Openclaw (reference driver)

The driver the framework was built around; `getDriver()` falls back to it for
any unknown type, so its values are the defaults everything else overrides.

- `type` / `label` — `openclaw` / `OpenClaw`
- `baseImage` — `ghcr.io/openclaw/openclaw:latest` (has a
  `org.opencontainers.image.version` label → real update detection)
- `dataDir` — `/root/.openclaw`; `workspaceDir` — `/root/.openclaw/workspace`
- `configFile` — `openclaw.json` (json, secrets redacted on GET)
- `setupSteps` — `openclaw setup --baseline` (runs after `compose up` at create)
- `currentVersion` — `docker exec <name> openclaw --version`, parsed with
  `/OpenClaw\s+([\w.+-]+)/i` then strips a `-N` packaging suffix (label
  `2026.7.1-1` → CLI `2026.7.1`)
- `availableVersion` — pulls the base tag and reads the
  `org.opencontainers.image.version` label; cached 5 minutes
- `workspaceCapability` — `fixed`

Command groups (`driver.commands`): Config (validate/file), Security (audit
normal/deep/fix, doctor lint/deep), Doctor (doctor, fix, lint, deep, sqlite
compact), Diagnostics (status, gateway status).

Gotchas:

- `openclaw setup --baseline` is the only setup step in the fleet that writes a
  working config; the other CLI types create theirs on first run.
- The base-image pull in `availableVersion` is the reason only openclaw shows
  "update available" — other types report none, by design.

## Opencode

CLI agent — no gateway daemon, the terminal is the interface.

- `type` / `label` — `opencode` / `Opencode`
- `baseImage` — `node:20-slim`; CLI installed with `npm i -g opencode-ai`
  (binary `opencode`)
- `dataDir` — `/root/.opencode`; `workspaceDir` — `/root/.opencode/workspace`
- `configFile` — `opencode.json` (json, redacted). XDG env vars put the real
  config at `/root/.opencode/config/opencode/opencode.jsonc` plus `data/` and
  `cache/` — all inside the bind mount, so they persist.
- `setupSteps` — none (config created on first run)
- `currentVersion` — `opencode --version` (bare semver, e.g. `1.18.14`)
- `availableVersion` — `''` (no base image tag)
- `workspaceCapability` — `editable`
- `webApp` — OpenCode Web: label, `containerPort: 8080`, auth via
  `OPENCODE_SERVER_PASSWORD` env (username always `opencode`), start command
  `opencode web --hostname 0.0.0.0 --port <port>`. See [tabs/web.md](../tabs/web.md).

Command groups: Model (providers list/login/logout, models, models --refresh),
Session (list, stats, export, session delete), MCP (list, add, auth, logout,
debug), Agent (list/create), Plugin (install), Other (version, debug info,
debug config, upgrade).

Gotchas:

- The Commands tab gates the four legacy openclaw flows (MESSAGING / MODELS /
  MCP / SKILLS) behind `agent_type === 'openclaw'`; opencode renders only its
  driver groups plus Vault.
- Heredoc `cat > start.sh` inside a Dockerfile `RUN` produced a 0-byte file
  (Docker multi-line RUN parsing). `start.sh` must be a real file `COPY`'d in —
  applies to opencode, codex, and claude builds.

## Picoclaw

The launcher image ships a single Go binary `picoclaw` — there is **no**
`openclaw` binary inside, so the old openclaw setup/version/backup steps would
never work. First type whose real behavior was discovered in-container and
encoded.

- `type` / `label` — `picoclaw` / `Picoclaw`
- `baseImage` — `sipeed/picoclaw:v0.2.5-launcher` (pinned tag, no version
  label → no update available)
- `dataDir` — `/root/.picoclaw`; `workspaceDir` — `/root/.picoclaw/workspace`
- `configFile` — `config.json` (json, redacted) — **not** `openclaw.json`; the
  config filename became driver-driven (`configFile` field) because of this.
- `setupSteps` — `picoclaw onboard` — runs **non-interactively** (exit 0, no
  TTY) and writes `config.json` + `workspace/` (AGENT.md, SOUL.md, USER.md,
  memory/, skills/) + a `.security.yml` 0600 secrets file
- `currentVersion` — `picoclaw version` → `🦞 picoclaw 0.2.5 (git: bd56e10)`;
  the output is a heavy ANSI/box-drawing banner, parsed with a `\d+\.\d+\.\d+`
  regex tolerant of escape codes
- `availableVersion` — `''` (pinned base tag)
- `workspaceCapability` — `fixed`
- `tuiCommand` — `picoclaw agent` (interactive chat — needs a model configured)

Command groups: Status (status/version/model), Auth (status/models/login/
logout/weixin/wecom), Channels (gateway), Cron (list/add/enable/disable/remove),
Skills (list/list-builtin/install-builtin/search/install/show/remove),
Other (update, migrate --dry-run).

Model config shape: `agents.defaults.provider` + `agents.defaults.model_name`
(no primary/fallback) — agent-registry's default-model extraction handles it.

Gotchas:

- The image is **Alpine** — the terminal's lazy tmux install (`apt-get`) fails.
  `tmux` + `sqlite` are baked into the Dockerfile (same rule as hermes).
- `start.sh` was a RUN-heredoc (0-byte risk) → converted to a real file +
  COPY. It runs `picoclaw gateway -E` (bind 0.0.0.0:18790) when `config.json`
  exists, else setup-mode `tail -f /dev/null`.
- Adding a driver file requires a **webui restart** — Node caches `require()`,
  so a running process silently falls back to the openclaw driver (and builds
  the wrong image).

## Hermes

The `/opt/data` special case; first driver to use a non-json `configFormat`.

- `type` / `label` — `hermes` / `Hermes`
- `baseImage` — `nousresearch/hermes-agent:latest` (Debian trixie, entrypoint
  `/opt/hermes/docker/entrypoint-dispatch.sh`, s6-overlay; drops to user
  `hermes`, uid 10000, `HERMES_HOME=/opt/data`)
- `dataDir` — `/opt/data`; `workspaceDir` — `/opt/data` (**no** `workspace/`
  subdir — the data dir is the workspace)
- `configFile` / `configFormat` — `config.yaml` / `yaml` — served/written
  **verbatim** via `configRaw`, no JSON parse or secret redaction
- `setupSteps` — `hermes setup --non-interactive` — works without a TTY, but
  only bootstraps the data dirs (SOUL.md, cron/, hooks/, memories/, sessions/,
  skills/); it does **not** create `config.yaml` (that's `hermes config set`)
- `currentVersion` — `hermes version` → `Hermes Agent v0.20.0 (2026.8.3)`
- `availableVersion` — `''` (no version label; `hermes update` also refuses to
  run inside Docker — "pull a fresh image instead")
- `workspaceCapability` — `none`
- `tuiCommand` — `hermes`

Command groups: Status (status/version/doctor/config check), Model
(model/fallbacks/config get model.default), Auth (list/add/status/logout),
Gateway (status/list/setup/restart), Cron (list/create/status/pause/resume/
remove), Skills (list/install/search/check/update/uninstall), MCP
(list/catalog/install/add/remove/test/serve), Memory (status/setup), Sessions
(list/--continue/export/stats), Plugins (list/install/enable/disable),
Other (backup -q, logs -n 100).

Gotchas:

- **The gateway silently drops to the `hermes` user even when started as
  root** — a root-owned empty bind mount fails the first boot with
  `PermissionError: /opt/data/logs`. `start.sh` runs `chown -R hermes:hermes
  /opt/data` first (mirrors the s6 chown the official entrypoint does). This
  is the #1 hermes gotcha.
- The base image already ships the docker CLI (`/usr/bin/docker`, 26.1.5) — the
  `INSTALL_DOCKER=1` rebuild is a verified no-op for hermes.
- `hermes model` is interactive-only (needs a TTY); `hermes --version` vs
  `hermes version` — the driver uses `hermes version`.
- `hermes login`/`logout` are **deprecated** — "use `hermes auth` to manage
  credentials"; the driver buttons use the `auth` subcommands.
- Debian base, so `apt-get` exists, but tmux + sqlite3 are still baked in.

## Codex

OpenAI Codex CLI — npm wrapper around a native Rust binary; terminal is the
interface.

- `type` / `label` — `codex` / `Codex`
- `baseImage` — `node:20-slim`; `npm i -g @openai/codex` (the npm package is a
  thin wrapper that auto-installs the real binary from `@openai/codex-linux-x64`)
- `dataDir` — `/root/.codex`; `workspaceDir` — `/root/.codex/workspace`
- `configFile` / `configFormat` — `config.toml` / `toml` — served/written
  verbatim (same non-JSON path as hermes' yaml; the ConfigTab already handles
  any non-json format)
- `setupSteps` — none (config created on first run)
- `currentVersion` — `codex --version` → `codex-cli 0.147.0`
- `availableVersion` — `''` (no base label)
- `workspaceCapability` — `editable`
- `tuiCommand` — `codex`

Command groups: Provider (login/status/logout), MCP (list/get/add/remove/
login/logout), Session (resume --last, review), Plugin (list/marketplace/add/
remove), Health (doctor), Other (--version, update, --help).

Gotchas:

- `codex exec` (non-interactive) is confirmed working — good for scripts.
- **`codex eval` does not exist** — the old driver's button just started the
  interactive CLI with "eval" as the prompt (a broken stub). Validate any new
  codex button against `codex --help` first.
- The webui terminal's single-client policy can kick an earlier browser
  session when a probe connects to the same tmux session; Reconnect (via the
  confirm dialog) restores it. Not a codex issue.

## Claude

Anthropic Claude Code — terminal is the interface; you run `claude`
interactively, config (`~/.claude`) and workspace persist in the mounted data
dir.

- `type` / `label` — `claude` / `Claude`
- `baseImage` — `node:20-slim`; `npm i -g @anthropic-ai/claude-code`
- `dataDir` — `/root/.claude`; `workspaceDir` — `/root/.claude/workspace`
- `configFile` — `settings.json` (json, user settings file)
- `setupSteps` — none (config created on first run)
- `currentVersion` — `claude --version` → `2.1.197 (Claude Code)`
- `availableVersion` — `''` (no base label → no update available)
- `workspaceCapability` — `editable`
- `tuiCommand` — `claude`

Command groups: Status (doctor, auth status, version), Auth (login/logout/
setup-token), Session (continue last, start background, list background, all
sessions), MCP (list/add/get/remove/login/logout), Plugin (list/marketplace/
install/update/uninstall), Other (update, install stable).

Gotchas:

- `CLAUDE_CONFIG_DIR=/root/.claude` is **required** for persistence — claude
  writes config/settings/credentials there; the defaults would put state
  outside the bind mount. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` stops
  auto-update/telemetry churn in a throwaway container.
- `claude auth status` works headless (JSON); `claude doctor` needs a warm
  TTY/prompt and can look idle in `docker exec` — not a driver issue.
- **`claude import` does not exist in 2.1.197** — the old `import codex
  --dry-run` button was removed; it would have started an interactive session
  with "import" as the prompt. Background agents use `claude --bg` and are
  managed with the single `claude agents` command — there is no `claude
  stop`/`logs`/`respawn`.
- The Run TUI button drops into the interactive `claude` UI (theme picker
  renders) in the docked terminal.
- Open question: `~/.claude.json` (MCP server state) lives outside `dataDir`
  by default — revisit if MCP persistence under the mount is wanted.

## See Also

- [backend/services.md](services.md) — the registry (`getDriver`, fallback,
  `listDrivers`) and the driver interface fields
- [tabs/web.md](../tabs/web.md) — the `webApp` descriptor and web publish flow
- [overview/business-logic.md](../overview/business-logic.md) — config, workspace,
  and model extraction derive paths from `driver.configFile` / `workspaceDir`
  / `dataDir`
