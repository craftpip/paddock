# Plan 38 — Multi-Config Editor (Per-Agent Config File Picker)

## Status: Proposed (2026-08-09) — not started. 0/6 phases done. Research is
embedded below; review blockers are resolved in the plan: the live SPA API is
the backend target, OpenCode's actual path is used, parser and secret handling
are explicit, path and symlink checks are required, and the test matrix covers
the new contracts.

## Goal

Every agent type ships **more than one configuration file**. Today the Config
tab (`ConfigTab` in `AgentDetail.jsx`) hard-codes a single file from
`driver.configFile` (`openclaw.json`, `config.json`, `config.yaml`,
    `config.toml`, `settings.json`, `config/opencode.json`). This plan:

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
bind-mounts `config_root`). OpenCode is an exception to the simple root-file
layout: its image sets `XDG_CONFIG_HOME=/root/.opencode/config`, so the active
global file is `/root/.opencode/config/opencode.json`. The driver metadata must
match this actual path rather than the stale `configFile: opencode.json` value.

### OpenClaw — base `~/.openclaw` (`/root/.openclaw`)

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `openclaw.json` | JSON5 | main config (agents, models, channels, tools, security) — hot-reloads | yes (primary, secret-redacted) |
| `.env` | text | API keys, secrets, bot tokens (SecretRef targets) | yes (verbatim) |
| `skills/config/mcporter.json` | JSON | MCP server registry | optional |

OpenClaw supports splitting config via `$include` (e.g. `plugins.json5`) —
the picker lists the known core files; `$include`d files resolve at runtime.

### Opencode — base `/root/.opencode` in the Paddock image

| File | Format | Purpose | Edit in UI |
|---|---|---|---|
| `config/opencode.json` | JSONC | main config (model, providers, permissions, agents, mcp) | yes (primary, secret-redacted) |
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
  opencode `config/opencode.json`, picoclaw `config.json`, hermes `config.yaml`,
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
- `format`: `json | json5 | jsonc | yaml | toml | text`. Only the primary
  JSON/JSON5/JSONC file gets secret redaction + `preserveSecrets` merge on
  save. All other files are served/written **verbatim**.
- `editable: false` lists a file read-only (view + copy, no Save).
- `listDrivers()` in `drivers/index.js` and the live config API expose it.
- The OpenCode primary entry is `path: 'config/opencode.json'`; update its
  driver `configFile` to that path so registry model parsing, config reads, and
  the picker share one source of truth.

#### Format and Secret Policy

- Add the required parser dependency to the backend image/package for JSON5 and
  JSONC (JSONC can use the same JSON5 parser if its accepted syntax matches the
  documented config contract). Do not depend on packages installed only in the
  frontend.
- `json` uses strict `JSON.parse`; `json5`/`jsonc` use the selected parser;
  `yaml`, `toml`, and `text` are not parsed by the API and are written exactly
  as submitted, apart from the existing final-newline convention.
- Redact configured secret keys on primary JSON-family reads and preserve the
  original values when the submitted document contains `[REDACTED]`. Never
  redact or merge arbitrary secondary files unless their driver entry
  explicitly declares a future policy.

### 2. Backend (`vm-manager.js` + live SPA API in `app.js`)

- `readAgentConfig(agent, relPath = driver.configFile)` — generalize the
  existing function (`vm-manager.js:2360`) to take a relative path within
  `config_root`; keep secret handling only for primary JSON/JSON5/JSONC. Update the
  live React API routes in `app.js` (`/api/agents/:name/config`), not the dead
  EJS routes in `routes/agents.js`.
- **Path-traversal guard** (critical): accept only a driver-declared relative
  path; reject `..`, absolute paths, NUL bytes, encoded traversal, and unknown
  files with 400. Resolve the candidate and its real parent with `realpath` so
  a symlink inside `config_root` cannot escape the config root. Do not follow
  symlinks that resolve outside `agent.config_root`.
- `GET /api/agents/:agentId/configs` → `{ files: [{ name, label, path,
  fullPath, hostPath, format, editable, primary, exists }] }` (no file
  contents). `fullPath` is the container path (`driver.dataDir + path`);
  `hostPath` is the server-side `agent.config_root + path` and is returned only
  for the authenticated UI, never as a writable user-supplied path.
- `GET /api/agents/:agentId/config?file=<rel>` → content for the chosen file
  (backwards compatible: no `file` = primary).
- `POST /api/agents/:agentId/config?file=<rel>` → validate the selected
  driver entry and format, then write verbatim for `yaml`, `toml`, and `text`.
  Parse JSON5/JSONC with a backend dependency or a documented equivalent,
  canonicalize only where the format permits it, and apply secret-preserving
  merge for the primary JSON/JSON5/JSONC file. Redaction and preservation must
  happen in the live `app.js` API path; do not rely on the dead EJS helper.
- Keep the existing no-`file` behavior so the MCP `config_get` tool keeps
  working unchanged.

### 3. Frontend (`AgentDetail.jsx` → `ConfigTab`)

- Fetch `GET /configs` on mount; build the dropdown **on the right side** of
  the tab header (next to the Save button).
- Selecting a file loads its content (`GET /config?file=`); switching files
  discards unsaved changes after a confirm (reuse the unsaved-changes state).
- **Above the editor** show the full container path, e.g.
  `/root/.openclaw/openclaw.json` (from the API's `fullPath`). Show the
  authenticated API's `hostPath` only in a tooltip/title attr; never use it as
  a path input or expose it as an editable field.
- Read-only files render the editor without the Save button.
- Non-JSON formats (`yaml`, `toml`, `text`) skip JSON validation on Save;
  JSON5/JSONC use the same parser as the backend so the editor and API agree.

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
  primary JSON/JSON5/JSONC), using backend parser dependencies.
- [ ] **Phase 4 — Frontend picker.** Dropdown on the right of the Config tab;
  per-file load; full-path display above the editor; read-only handling.
- [ ] **Phase 5 — Tests.** Add live `app.js` API tests for config listing,
  primary and secondary reads/writes, missing files, read-only files, strict
  JSON and JSON5/JSONC parsing, secret redaction/preservation, and the
  final-newline policy. Add path tests for `..`, absolute paths, encoded
  traversal, NUL bytes, unknown driver paths, and symlinks escaping
  `config_root`. Run each test file individually per `AGENTS.md`; live-verify
  in a browser against real PADs.
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
