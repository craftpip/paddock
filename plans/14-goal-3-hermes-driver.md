# Goal 3 — hermes Driver

## Status: Planned (2026-08-06)

## Goal

Make hermes a working first-class agent. Today it is untested and its config
dir is a special case (`/opt/data`, `containerDataDir()`); the version reads and
commands assume openclaw, and hermes has no `openclaw` binary. This goal
discovers the real behavior and encodes it in the driver.

## Details

### 1. Create a test agent

- Create a hermes agent via the web UI.
- Base image today: `nousresearch/hermes-agent:latest` (vm-manager.js
  `AGENT_BASE_IMAGES`). Build dir `src/vm-builds/hermes`, data dir `/opt/data`.

### 2. Discover the real behavior (record findings here)

- What runs on container start? Does the build's `start.sh` / entrypoint work?
  Does the terminal tab drop into a usable shell?
- Version: what binary prints a version? Is there one at all?
- Config/data dir: confirm `/opt/data` is where hermes keeps state. What's the
  host dir name? (`containerDataDir()` maps hermes → `/opt/data` but the host
  mount still uses `instances/<name>/hermes`.)
- Workspace: where should `workspaceDir` point inside the container?
- Commands: which command groups make sense for hermes (none of the `openclaw`
  ones do)? Empty `commands: []` may be right, or a small bespoke set.
- Backup: does hermes support backup at all? Likely `backupSteps: []` and the
  UI shows "not supported".
- Setup: presumably no `setup --baseline` step — `setupSteps: []`.
- Docker: does the `INSTALL_DOCKER=1` rebuild flow work in this image
  (is there apt/apk, is it Debian-based)?

### 3. Encode in the driver

`src/services/drivers/hermes.js` — fill every field from what was discovered.

### 4. Verify end to end

- Create, terminal, versions (or "unknown"), workspace tab, backup ("not
  supported" is fine), settings toggle — every feature sane for hermes.

## Files

- **New** `src/services/drivers/hermes.js`
- Possibly **Modified** `src/vm-builds/hermes/Dockerfile` if the container
  lacks sshd/start.sh wiring or a usable shell
- Goal 1 already routes dataDir/workspaceDir through the driver, so the hermes
  `/opt/data` special case lives in the driver from here on

## Progress

- [ ] Create test hermes agent
- [ ] Discover: what runs on start + terminal shell works
- [ ] Discover: version binary (or none)
- [ ] Discover: real config/data dir + host mapping
- [ ] Discover: workspace dir
- [ ] Discover: applicable command groups (likely empty)
- [ ] Discover: backup support
- [ ] Discover: docker rebuild flow
- [ ] Write `src/services/drivers/hermes.js` with real findings
- [ ] Fix Dockerfile wiring if the terminal/shell is broken
- [ ] Verify create + terminal end to end
- [ ] Verify versions + update card
- [ ] Verify workspace tab paths
- [ ] Verify backup / settings behave sanely

## Verification

```bash
docker exec <test-hermes> <version-binary> --version   # per discovery
docker exec <test-hermes> ls /opt/data                 # config dir confirmed
# web UI: dashboard card, terminal, workspace, settings all sane
```

## Open questions

- Hermes may not be an interactive-CLI agent at all — if so, the terminal is
  just a shell into the container and `commands` is empty. Decide during
  discovery whether hermes stays in the fleet or gets parked.
