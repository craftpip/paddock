# Goal 2 — picoclaw Driver

## Status: Planned (2026-08-06)

## Goal

Make picoclaw a working first-class agent. Today it is untested — the setup
guard, version reads, and commands all assume openclaw. This goal discovers the
real behavior inside a picoclaw container and encodes it in its driver.

## Details

### 1. Create a test agent

- Create a picoclaw agent via the web UI (`CreateAgent` type picker — option
  exists already).
- Base image today: `sipeed/picoclaw:v0.2.5-launcher` (vm-manager.js
  `AGENT_BASE_IMAGES`). Build dir `src/vm-builds/picoclaw`.

### 2. Discover the real behavior (record findings here)

Answers go straight into the Progress notes / this file as we learn them:

- Does `openclaw setup --baseline` exist inside the container? Does it run?
  (The createVm setup guard currently runs it for picoclaw — verify it actually
  works or must be removed.)
- Version: what binary prints a version? `openclaw --version`? something else?
- Config/data dir: where does picoclaw keep its state? (`containerDataDir()`
  assumes `/root/.picoclaw` — verify against the real container. Check the
  launcher image layout.)
- Commands: which of the openclaw command groups apply (mcp, memory, backup,
  doctor, channels…)? Picoclaw is a lighter build — some will be missing.
- Backup: does `openclaw backup create` work inside it?
- Docker: does the image support the `INSTALL_DOCKER=1` rebuild flow?

### 3. Encode in the driver

`src/services/drivers/picoclaw.js` — fill every field from what was discovered:
type/label, buildImage, buildRel, baseImage, dataDir, workspaceDir, setupSteps,
backupSteps, installDockerBuildArg, currentVersion, availableVersion, commands.

### 4. Verify end to end

- Create, terminal, versions, update card, workspace tab, backup, settings
  toggle — every feature must behave sensibly for picoclaw (some may
  legitimately be "not supported", e.g. backup).

## Files

- **New** `src/services/drivers/picoclaw.js`
- Possibly **Modified** `src/vm-builds/picoclaw/Dockerfile` (if the container
  lacks something picoclaw needs — e.g. sshd/start.sh wiring)
- Possibly **Modified** vm-manager.js `createVm()` if the picoclaw setup step
  must change (goal 1 already routes setup through the driver)

## Progress

- [ ] Create test picoclaw agent
- [ ] Discover: does `openclaw setup --baseline` run?
- [ ] Discover: version binary + output
- [ ] Discover: real config/data dir
- [ ] Discover: which command groups apply
- [ ] Discover: backup works?
- [ ] Discover: docker rebuild flow works?
- [ ] Write `src/services/drivers/picoclaw.js` with real findings
- [ ] Fix createVm/setup guard for picoclaw if needed
- [ ] Verify create + terminal end to end
- [ ] Verify versions + update card
- [ ] Verify workspace tab paths
- [ ] Verify backup (or "not supported")
- [ ] Verify settings docker toggle (if image supports it)

## Verification

```bash
docker exec <test-picoclaw> <version-binary> --version   # per discovery
docker exec <test-picoclaw> ls /root/.picoclaw           # config dir confirmed
# web UI: dashboard card, terminal, workspace, settings all sane
```

## Open questions

- Does picoclaw have its own CLI that differs from openclaw's? (Then its
  `commands` groups are entirely different — write them from the container's
  actual `--help`.)
