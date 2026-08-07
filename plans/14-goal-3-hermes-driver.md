# Goal 3 — hermes Driver

## Status: Done (2026-08-07)

## Goal

Make hermes a working first-class agent. Today it is untested and its config
dir is a special case (`/opt/data`, `containerDataDir()`); the version reads and
commands assume openclaw, and hermes has no `openclaw` binary. This goal
discovers the real behavior and encodes it in the driver.

## Discovery findings (2026-08-07)

### Base image

- `nousresearch/hermes-agent:latest` — Debian 13 (trixie), entrypoint
  `/opt/hermes/docker/entrypoint-dispatch.sh` (s6-overlay → main-wrapper),
  runs as root, drops to user `hermes` (uid 10000, `HERMES_HOME=/opt/data`).
  Pulled locally, ~3.95 GB, image `0f53d94b9d93`.
- Binary `/opt/hermes/bin/hermes`; `hermes --version` →
  `Hermes Agent v0.20.0 (2026.8.3)` → regex `(\d+\.\d+\.\d+...)` gives `0.20.0`.
- The image already ships the docker CLI (`/usr/bin/docker`, 26.1.5) — so the
  `INSTALL_DOCKER=1` rebuild is a no-op for hermes. The settings flow correctly
  detected the CLI and skipped the rebuild.

### Config / data dir

- `HERMES_HOME=/opt/data` holds SOUL.md, cron/, hooks/, memories/, sessions/,
  skills/, logs/, audio_cache/, image_cache/, pairing/.
- Config is **YAML**: `hermes config path` → `/opt/data/config.yaml`;
  env → `/opt/data/.env`. Config is managed with `hermes config set/get/unset`
  (e.g. `hermes config set model.provider custom`). **`setup --non-interactive`
  does NOT create config.yaml** — it only bootstraps the data dirs.
- `hermes setup --non-interactive` works without a TTY (verified) → this is the
  driver's setup step and it runs fine in the create flow.

### Gateway & lifecycle

- `hermes gateway run` keeps the container alive (cron + messaging platforms).
  Works as root with `HERMES_ALLOW_ROOT_GATEWAY=1` (env in our Dockerfile; the
  var exists in v0.20.0).
- **The gateway drops to the `hermes` user even when started as root** — the
  first boot failed with `PermissionError: /opt/data/logs` on a root-owned
  empty bind mount. Fix: start.sh runs `chown -R hermes:hermes /opt/data`
  before `hermes gateway run` (mirrors the s6 chown the official entrypoint
  does). Verified: after chown, gateway starts and initializes /opt/data.
- `hermes gateway status` works; gateway subcommands incl. run/start/stop/
  restart/status/list/setup/enroll.
- `hermes update` refuses to run inside Docker ("pull a fresh image instead")
  → `availableVersion: ''` is correct.
- `hermes backup -o <file> -q|-l LABEL` exists (zip of config/skills/sessions/
  data) — but we use the generic tar-of-dataDir backup (backupTypeMarker: ''),
  which works and tags the backup `legacy`.
- `hermes doctor`, `cron list`, `skills list`, `sessions list`, `mcp list`,
  `memory status` all exist. `hermes model` is interactive-only (needs TTY).

### Workspace

- Hermes workspace **is** the data dir: `workspaceDir: '/opt/data'` (no
  separate `workspace/` subdir). Host bind `instances/<pad>/hermes` → `/opt/data`.

## What changed

### New

- `src/services/drivers/hermes.js` — full driver:
  - `type: 'hermes'`, `label: 'Hermes'`
  - `buildImage: 'paddock-vm-hermes:latest'`, `buildRel: ../../src/vm-builds/hermes`
  - `baseImage: 'nousresearch/hermes-agent:latest'`
  - `dataDir: '/opt/data'`, `workspaceDir: '/opt/data'`
  - `configFile: 'config.yaml'`, **`configFormat: 'yaml'`** (first use of the
    new field — routes serve/write it verbatim, no JSON parse/redact)
  - `installDockerBuildArg: 'INSTALL_DOCKER=1'`
  - `tuiCommand: 'hermes'`
  - `backupTypeMarker: ''` (generic tar backup)
  - `setupSteps: [{ cmd: 'hermes', args: ['setup', '--non-interactive'] }]`
  - commands groups: Status (status/version/doctor/config check), Model
    (model/fallbacks/config get model.default), Auth (login/logout/auth),
    Gateway (gateway status/list profiles), Cron, Skills, Memory, Sessions,
    Other
  - `currentVersion`: `docker exec … hermes version` + regex; `availableVersion: ''`
- `src/vm-builds/hermes/start.sh` — chown /opt/data to hermes, set root
  password, TZ, sshd, `hermes gateway run || tail -f /dev/null`.

### Modified

- `src/services/drivers/index.js` — registry is now
  `{ openclaw, opencode, picoclaw, hermes }`.
- `src/app.js` — config GET/POST: `driver.configFormat !== 'json'` reads/writes
  the file verbatim (returns `configRaw`, response includes `configFormat`);
  JSON path unchanged.
- `src/client/src/pages/AgentDetail.jsx` — ConfigTab tracks `configFormat`,
  skips JSON validation for non-JSON, shows `config.yaml (yaml)`.
- `src/services/agent-registry.js` — hermes model extraction from config.yaml
  via regex (`model:` → provider/default); picoclaw/openclaw paths unchanged.
- `src/vm-builds/hermes/Dockerfile` — replaced heredoc start.sh with
  `COPY start.sh`, added `HERMES_ALLOW_ROOT_GATEWAY=1`, baked tmux + sqlite3,
  keep sshd/tzdata/nodejs/npm/mcporter.

## Verification (all done live)

- Create via API: build → up → `hermes setup --non-interactive` → restart →
  done. Container up, gateway running as `hermes`, sshd running.
- `currentVersion: "0.20.0"`, `availableVersion: ""`, update card shows no update.
- Workspace tab lists `/opt/data` contents (audio_cache, bin, cron, …).
- Config tab shows `config.yaml (yaml)`; YAML served verbatim via `configRaw`;
  POST saves it back; registry reads `qwen-hermes-3` / `custom` as model.
- Settings toggle: docker enable detected existing CLI → recreate only, no
  rebuild; container kept docker CLI.
- Backup created a tar.gz of the data dir.
- Terminal WS: live bash prompt, `touch /opt/data/ws_probe.txt` executed.
- Agent-types endpoint lists hermes with setup step.

## Progress

- [x] Create test hermes agent (`pad-test-hermes`)
- [x] Discover: what runs on start + terminal shell works
- [x] Discover: version binary (`hermes --version` → 0.20.0)
- [x] Discover: real config/data dir + host mapping (`/opt/data`, config.yaml)
- [x] Discover: workspace dir (`/opt/data`)
- [x] Discover: applicable command groups (Status/Model/Auth/Gateway/Cron/Skills/Memory/Sessions)
- [x] Discover: backup support (generic tar works)
- [x] Discover: docker rebuild flow (base image ships docker CLI)
- [x] Write `src/services/drivers/hermes.js` with real findings
- [x] Fix Dockerfile wiring (COPY start.sh, chown /opt/data)
- [x] Verify create + terminal end to end
- [x] Verify versions + update card
- [x] Verify workspace tab paths
- [x] Verify backup / settings behave sanely

## Verification

```bash
docker exec <test-hermes> hermes --version   # → Hermes Agent v0.20.0
docker exec <test-hermes> ls /opt/data       # config dir confirmed
# web UI: dashboard card, terminal, workspace, config(yaml), settings all sane
```

## Notes for the future

- Any Alpine-based agent image must bake tmux + sqlite (no apt-get). Hermes is
  Debian so apt-get exists, but we baked them anyway (AGENTS.md rule).
- The gateway's silent drop to the `hermes` user is the #1 hermes gotcha — any
  first-boot that mounts an empty host dir must chown it first.
- `configFormat` is now a real driver field; openclaw/opencode/picoclaw keep
  the default (`json`).
