# Plan 38 — Multi-Config Editor (Per-Agent Config File Picker)

## Status: Proposed (2026-08-09) — not started. 0/6 phases done. Online research
for all six agent types is complete and embedded below (plan 38 embeds it
directly, no sub-files needed).

## Goal

Every agent type ships **more than one configuration file**. Today the Config
tab (`ConfigTab` in `AgentDetail.jsx`) hard-codes a single file from
`driver.configFile` (`openclaw.json`, `config.json`, `config.yaml`,
`config.toml`, `settings.json`, `opencode.json`). This plan:

1. Identifies, per agent type, **the real config files** the agent reads
   (verified against official docs online).
2. Stores that knowledge in the **agent drivers** as a `configFiles` list
   (each entry: label, relative path, format, read/write policy).
3. Reworks the Config tab: a **dropdown on the right side** to pick which
   config file to view/edit; switching the dropdown swaps the editor content.
4. Shows the **full path** of the active file **above the editor**.

## Research — config files per agent type

Sources: official docs (docs.openclaw.ai, opencode.ai/docs/config,
docs.picoclaw.io, hermes-agent.nousresearch.com/docs,
developers.openai.com/codex, code.claude.com/docs) searched 2026-08-09.
Container paths use the driver `dataDir` as the base (matches how Paddock
bind-mounts `config_root`).

### OpenClaw — base `~/.openclaw` (`/root/.openclaw`)

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `openclaw.json` | JSON5 | main config (agents, models, channels, tools, security) — hot-reloads | yes (primary, secret-redacted) |
| `.env` | text | API keys, secrets, bot tokens (SecretRef targets) | yes (verbatim) |
| `skills/config/mcporter.json` | JSON | MCP server registry | optional |

OpenClaw supports splitting config via `$include` (e.g. `plugins.json5`) —
the picker lists the known core files; `$include`d files resolve at runtime.

### Opencode — base `~/.config/opencode` (`/root/.opencode` in driver)

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `opencode.json` | JSONC | main config (model, providers, permissions, agents, mcp) | yes (primary, secret-redacted) |
| `tui.json` | JSON | TUI-specific settings | yes |
| `AGENTS.md` | text | global instructions (rules) | optional |

### Picoclaw — base `~/.picoclaw`

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `config.json` | JSON | main config (version, agents.defaults, model_list, channels, tools) | yes (primary, secret-redacted) |
| `.security.yml` | YAML | secrets/API keys overlay (wins over config.json) | yes (verbatim) |
| `launcher-config.json` | JSON | launcher/web dashboard auth | optional |

### Hermes — base `HERMES_HOME` (`/opt/data` in driver)

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `config.yaml` | YAML | main config (model, terminal, approvals, toolsets, memory) | yes (primary, verbatim yaml) |
| `.env` | text | API keys, secrets (required for secrets) | yes (verbatim) |
| `auth.json` | JSON | OAuth provider credentials | no — credentials, high risk |

### Codex — base `CODEX_HOME` (`~/.codex`)

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `config.toml` | TOML | main config (model, approval_policy, mcp_servers, providers) | yes (primary, verbatim toml) |
| `auth.json` | JSON | credentials when not using keyring | no — credentials |
| `AGENTS.md` | text | global instructions | optional |
| `AGENTS.override.md` | text | higher-priority global instructions | optional |
| `hooks.json` | JSON | lifecycle hooks | optional |

### Claude — base `~/.claude`

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `settings.json` | JSON | user settings (permissions, hooks, model) | yes (primary, secret-redacted) |
| `settings.local.json` | JSON | personal overrides (gitignored) | yes |
| `CLAUDE.md` | text | global instructions | optional |
| `~/.claude.json` | JSON | MCP servers + OAuth state (sibling of `~/.claude/`) | no — large state + credentials |

### Cross-type summary

- **Primary config** (already served today): openclaw `openclaw.json`,
  opencode `opencode.json`, picoclaw `config.json`, hermes `config.yaml`,
  codex `config.toml`, claude `settings.json`.
- **Secrets files** worth editing in the UI: openclaw `.env`, picoclaw
  `.security.yml`, hermes `.env`.
- **Credentials stores** (`auth.json`, `~/.claude.json`): excluded — editing
  them risks breaking login; note in UI as not listed.
- **Instructions files** (`AGENTS.md`, `CLAUDE.md`): listed as "optional" so
  we can ship the picker without them and add later.

## Design

### 1. Driver schema (`src/services/drivers/*.js`)

Each driver keeps `configFile`/`configFormat` (used by model parsing,
`agent-registry.js:174`) and gains a `configFiles` array — the single source
of truth for the picker:

```js
configFiles: [
  { name: 'openclaw.json', label: 'Main config', path: 'openclaw.json',
    format: 'json5', primary: true, editable: true },
  { name: '.env', label: 'Environment / secrets', path: '.env',
    format: 'text', primary: false, editable: true },
  { name: 'skills/config/mcporter.json', label: 'MCP servers',
    path: 'skills/config/mcporter.json', format: 'json', primary: false,
    editable: false },
],
```

- `path` is **relative to the driver `dataDir`** (the container path the agent
  actually reads); the frontend renders the full container path.
- `format`: `json | json5 | yaml | toml | text`. Only the primary JSON/JSON5
  file gets secret redaction + `preserveSecrets` merge on save (existing
  behavior). All other files are served/written **verbatim**.
- `editable: false` lists a file read-only (view + copy, no Save).
- `listDrivers()` in `drivers/index.js` and the config route expose it.

### 2. Backend (`vm-manager.js` + `routes/agents.js`)

- `readAgentConfig(agent, relPath = driver.configFile)` — generalize the
  existing function (`vm-manager.js:2307`) to take a relative path within
  `config_root`; keep secret handling only for primary JSON/JSON5.
- **Path-traversal guard** (critical): resolved path must stay under
  `agent.config_root` — reject `..`, absolute, or otherwise escaping paths
  with 400.
- `GET /api/agents/:agentId/configs` → `{ files: [{ name, label, path,
  fullPath, format, editable, primary, exists }] }` (no file contents).
- `GET /api/agents/:agentId/config?file=<rel>` → content for the chosen file
  (backwards compatible: no `file` = primary).
- `POST /api/agents/:agentId/config?file=<rel>` → validate format, write
  verbatim (or secret-preserving merge for the primary JSON/JSON5 file).
- Keep the existing no-`file` behavior so the MCP `config_get` tool keeps
  working unchanged.

### 3. Frontend (`AgentDetail.jsx` → `ConfigTab`)

- Fetch `GET /configs` on mount; build the dropdown **on the right side** of
  the tab header (next to the Save button).
- Selecting a file loads its content (`GET /config?file=`); switching files
  discards unsaved changes after a confirm (reuse the unsaved-changes state).
- **Above the editor** show the full path, e.g.
  `/root/.openclaw/openclaw.json` (container path built from
  `driver.dataDir` + `file.path`). Show host path in a tooltip/title attr.
- Read-only files render the editor without the Save button.
- Non-JSON formats (`yaml`, `toml`, `text`) skip the JSON.parse validation on
  Save (mirror of today's `configFormat !== 'json'` branch).

### 4. Optional stretch

- Surface the same `configFiles` list in the MCP server (`mcp.js`) as new
  tools `config_list` / keep `config_get` with a `file` param.
- Add `AGENTS.md`/`CLAUDE.md`-style instruction files to the picker.

## Implementation checklist

- [ ] **Phase 1 — Driver metadata.** Add `configFiles` arrays to all six
  drivers (`openclaw.js`, `opencode.js`, `picoclaw.js`, `hermes.js`,
  `codex.js`, `claude.js`); primary entry mirrors `configFile`/`configFormat`.
- [ ] **Phase 2 — Backend read.** Generalize `readAgentConfig()` with a
  relative-path param + path-traversal guard; add `GET /configs` listing
  endpoint.
- [ ] **Phase 3 — Backend write.** Extend `POST /config` to accept `?file=`
  with per-file format validation and verbatim write (secret merge only for
  primary JSON/JSON5).
- [ ] **Phase 4 — Frontend picker.** Dropdown on the right of the Config tab;
  per-file load; full-path display above the editor; read-only handling.
- [ ] **Phase 5 — Tests.** Unit tests for path-traversal guard and
  per-file read/write (individual `node --test` runs per AGENTS.md);
  live-verify in a browser against real PADs.
- [ ] **Phase 6 — Docs.** Absorb into `docs/` (driver + tabs docs) and remove
  this plan file when complete.

## Verification

- Backend: `timeout 60 docker exec paddock node --test test/<file>.test.js`
  for the config tests; keep `GUARD_*` envs unset where required.
- Live (per AGENTS.md golden rule): restart webui, open an agent's Config tab
  at http://10.69.1.164:6789, switch files in the dropdown, confirm editor
  content + full path change, edit + save, restart agent, confirm it applies.
  Test PADs per type: `pad-openclaw-work-pls`, `pad-opencode-aic`,
  `pad-picoclaw-asdsa`, `pad-hermes-sup`, `pad-test-codex` (codex).
