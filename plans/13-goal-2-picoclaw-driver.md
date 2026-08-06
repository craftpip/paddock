# Goal 2 — picoclaw Driver

## Status: Done (2026-08-06)

## Goal

Make picoclaw a working first-class agent. Today it is untested — the setup
guard, version reads, and commands all assume openclaw. This goal discovers the
real behavior inside a picoclaw container and encodes it in its driver.

## Findings (discovered in the real container)

### CLI is `picoclaw`, not openclaw

- The launcher image ships a single Go binary `picoclaw` (`picoclaw-launcher`
  is the image entrypoint). There is **no** `openclaw` binary, so the old
  openclaw setup/version/backup steps would never work.
- `picoclaw --help` top-level commands: `agent`, `auth` (login/logout/status/
  models/wecom/weixin), `completion`, `cron` (add/disable/enable/list/remove),
  `gateway` (`-E`/`--allow-empty`, `-d`), `help`, `migrate`, `model` (get/set
  default), `onboard` (alias `o`, `--enc`), `skills`, `status`, `update`,
  `version`.
- `picoclaw onboard` runs **non-interactively** (exit 0, no TTY needed): writes
  `/root/.picoclaw/config.json` + `/root/.picoclaw/workspace/` (AGENT.md,
  SOUL.md, USER.md, memory/, skills/) + `.security.yml` (0600 secrets file).
  → driver `setupSteps: [{ cmd: 'picoclaw', args: ['onboard'] }]`.
- Version: `picoclaw version` → `🦞 picoclaw 0.2.5 (git: bd56e10)`. Output is
  ANSI/box-drawing heavy (big blue lobster banner on stdout) — parse with a
  `\d+\.\d+\.\d+` regex tolerant of escape codes.

### Config/data dir

- `/root/.picoclaw` confirmed. **Config file is `config.json`**, not
  `openclaw.json` (config tab/route previously hardcoded openclaw.json → now
  driver-aware via new `configFile` field; openclaw=openclaw.json,
  opencode=opencode.json, picoclaw=config.json).
- Model config: `agents.defaults.provider` + `agents.defaults.model_name`
  (no primary/fallback). agent-registry default-model extraction updated for
  this shape.
- Secret redaction generalized: `redactSecrets()` recursive (api_key, token,
  bot_token, secret, client_secret, app_secret, private_key, access_token).

### Backup

- No `openclaw backup` — but the generic backup-manager tars `driver.dataDir`,
  so **create + restore work** for picoclaw (verified). `backupTypeMarker: ''`
  → backups tagged `legacy`. Restore is tar-overlay + container restart
  (same semantics as the legacy manage_backups.sh; files created after the
  backup survive).

### Docker toggle

- `INSTALL_DOCKER=1` build arg works (Alpine `apk add docker-cli`). Settings
  toggle detected missing CLI and rebuilt automatically; socket mount + CLI
  verified. `installDockerBuildArg: 'INSTALL_DOCKER=1'`.

### Terminal

- Picoclaw image is **Alpine** — the terminal's lazy tmux install (`apt-get`)
  fails. Fixed by baking `tmux` + `sqlite` into the Dockerfile (like the other
  two images).
- Dockerfile `start.sh` was a RUN-heredoc (0-byte file risk) → converted to
  real `start.sh` + COPY. start.sh: sshd, TZ, then `picoclaw gateway -E`
  (bind 0.0.0.0:18790) when config.json exists, setup-mode `tail -f /dev/null`
  when it doesn't.

### createVm guard

- No code change needed: setup already routes through `driver.setupSteps`; with
  the driver in place it ran `picoclaw onboard` correctly (15-retry exec).
- **Gotcha:** after adding a driver file, the webui must be restarted — Node
  caches `require()` at startup, so a running process falls back to the
  openclaw driver (silently builds the wrong image!). Restart before testing.

## Files changed

- **New** `src/services/drivers/picoclaw.js` — full driver (see below).
- **New** `src/vm-builds/picoclaw/start.sh` — real file (COPY pattern).
- **Modified** `src/vm-builds/picoclaw/Dockerfile` — heredoc→COPY, +tmux +sqlite.
- **Modified** `src/services/drivers/index.js` — registered `picoclaw`.
- **Modified** `src/services/drivers/openclaw.js`, `opencode.js` — `configFile`.
- **Modified** `src/services/agent-registry.js` — driver-aware config filename +
  picoclaw model extraction.
- **Modified** `src/app.js` — config GET/POST use `driver.configFile`;
  `redactSecrets()`; config response exposes `configFile`.
- **Modified** `src/client/src/pages/AgentDetail.jsx` — ConfigTab shows the real
  config filename from the API.

## Driver fields (src/services/drivers/picoclaw.js)

- `type: 'picoclaw'`, `label: 'Picoclaw'`
- `buildImage: 'paddock-vm-picoclaw:latest'`, `buildRel: '../../src/vm-builds/picoclaw'`
- `baseImage: 'sipeed/picoclaw:v0.2.5-launcher'` (pinned tag, no label → no
  update available)
- `dataDir: '/root/.picoclaw'`, `workspaceDir: '/root/.picoclaw/workspace'`
- `configFile: 'config.json'`
- `installDockerBuildArg: 'INSTALL_DOCKER=1'`
- `tuiCommand: 'picoclaw agent'` (interactive chat — needs a model configured)
- `backupTypeMarker: ''`
- `setupSteps: [{ cmd: 'picoclaw', args: ['onboard'] }]`
- `commands`: Status (status/version/model), Auth (auth status/models/login/
  logout), Cron (cron list/add/remove), Skills (skills list/list-builtin/search/
  install), Other (update, migrate --dry-run)
- `currentVersion`: `docker exec <pad> picoclaw version`, regex-parsed
- `availableVersion`: `''` (pinned base tag)

## Verification (done)

- Create via UI/API: build → up → `picoclaw onboard` → restart → gateway running.
- Correct image (`paddock-vm-picoclaw`), volume `/www2/paddock/instances/<pad>/
  picoclaw -> /root/.picoclaw` (no split-brain), sshd + `picoclaw gateway -E`.
- `/api/agent-types` lists picoclaw; CreateAgent dropdown shows it.
- Terminal: shell prompt, `picoclaw version`/`status` run, command pills + Run
  TUI inject correctly.
- Versions: `currentVersion: 0.2.5`, no update available (pinned base).
- Workspace tab: `/root/.picoclaw/workspace` lists AGENT.md, memory/, skills/…
- Config tab: shows config.json (driver-aware filename), redacted.
- Backup: create + restore verified; container healthy after restore.
- Settings docker toggle: auto-rebuild with docker-cli, socket + CLI verified,
  toggle reflects on.
- Test agent `pad-test-picoclaw` deleted after verification.

## Verification commands

```bash
docker exec <test-picoclaw> picoclaw version        # 🦞 picoclaw 0.2.5 (git: …)
docker exec <test-picoclaw> picoclaw status         # Config/Workspace ✓
docker exec <test-picoclaw> ls /root/.picoclaw      # config.json + workspace/
```
