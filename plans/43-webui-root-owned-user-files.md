# Plan 43 — root where it counts, user-owned everywhere

## Status: Proposed (2026-08-12) — design complete, implementation 0/7 phases.

Run the paddock webui container as **root** so it has root control over the
host filesystem and Docker, while every file it creates for the user is
explicitly `chown`ed back to `PUID:PGID`. This eliminates the whole
root-owned-data class of bugs (wipe/delete becomes a plain `fs.rmSync`), lets
the webui read the agents' root-owned configs directly (several workarounds
become dead code), and replaces the manual `chown -R node:node instances/`
runbook with an automatic boot-time normalization. On the agent side, the user
gets a per-PAD choice of **root or user-level** container user (the "Container
user" idea from `01-ideas.md`, pulled into Phase 7). Nothing built yet.

## Goal

1. **paddock controls with root.** The webui container runs as root: it can
   delete any instance data, read/write any agent config, and drive Docker —
   no helper containers, no `EACCES`/`EPERM` handling, no "run this chown on
   the host" errors.
2. **User files stay the user's.** Everything the webui creates on the user's
   behalf (`instances/<pad>/`, `meta.env`, `docker-compose.yml`, `web.json`,
   logs, `src/data/app.db*`) is owned by `PUID:PGID`, so the host user keeps
   access. A root process creates root-owned files by default, so this is an
   explicit chown-on-create discipline, not a side effect.
3. **Historical root-owned data self-heals.** The boot sweep normalizes
   existing `instances/` + `src/data/` to `PUID:PGID`, so pads created before
   this plan stop being locked.
4. **Agents can run at user level too.** Per-PAD "Container user: Root /
   User" option — the agent daemon runs as `PUID` instead of root when the
   user picks it.

## Context: what already exists

- Compose runs the webui as `user: "${PUID:-1000}:${PGID:-1000}"` with
  `group_add: ["${DOCKER_GID:-988}"]` (docker socket access). `.env` has
  `PUID=1000`, `PGID=1000`, `DOCKER_GID=988`.
- The image `CMD` is `node app.js`, so the process user is the compose user.
  The image default (no `USER`) is root — a root process is one compose change
  away, and the wipe helper already relies on that (`paddock-webui:latest`
  launched without `--user`).
- The webui already has root-equivalent Docker control via the mounted
  `/var/run/docker.sock`; running as root extends that to host FS access on the
  bind-mounted `/workspace` (security note below).
- Agent containers run as root (openclaw sets `USER root`; opencode inherits
  root from `node:20-slim`; hermes runs as its own user and `chown`s `/opt/data`
  on boot). Root can read/write anything regardless of ownership, so
  normalizing agent data to `PUID` does not break root agents — this is the
  historical one-time `chown -R node:node instances/` made automatic.
- Root-owned-data machinery to be removed once root:
  - `removeInstanceDir` root-helper container + `EACCES`/`EPERM` branches
    (vm-manager.js `removeInstanceDir`, used by delete + all three resets)
  - `applyWebAuth`/`removeWebAuth` chown hacks (vm-manager.js:1119, 1971) —
    reasons: agent configs are root-owned and unreadable by uid 1000
  - `patchOpenclawConfigViaHelper` and the "config is root-owned" error paths
    (vm-manager.js:1983, 2033)
  - the `web-openclaw.json` state file may also simplify — the publish-state
    mechanism itself stays (unpublish must restore pre-publish config), but the
    "config unreadable, hence state file" motivation weakens
- DB: `src/services/db.js` opens `src/data/app.db` on first require (creates
  it); the `1000:1000`-owned invariant on `src/data/app.db*` is documented as
  critical in AGENTS.md.

## Design

### Phase 1 — the container runs as root

- `docker-compose.yml`: drop the `user:` line and `group_add:` (root needs
  neither the uid pin nor the docker group). Keep `PUID`/`PGID` in `.env` — the
  process now reads them as the **chown targets**.
- Recreate: `docker compose build webui && docker compose up -d
  --no-deps --force-recreate webui`. No image change is required (CMD stays
  `node app.js`); the rebuild is a safety re-bake only.

### Phase 2 — ownership module + boot normalization

- New `src/services/ownership.js`:
  - `USER_UID` / `USER_GID` from `PUID`/`PGID` (default 1000)
  - `ensureOwned(p)` — `fs.chownSync(p, uid, gid)`, no-op when already owned
    (cheap `stat` compare)
  - `normalizeTree(root)` — recursive walk + chown; skips symlinks and the
    docker socket; best-effort (never throws on a race)
  - `ensureDataOwned()` — `normalizeTree(src/data)` + `src/data/app.db*`
- `app.js` boot (before DB open): `ensureDataOwned()` then DB init, then
  `ensureOwned` on `app.db`/`app.db-wal`/`app.db-shm` again (fresh DBs created
  by the root process are root-owned). Then `normalizeTree(instances/)` in the
  background — idempotent, replaces the manual host `chown -R` runbook.

### Phase 3 — chown-on-create (the discipline)

Every webui create site gets `ensureOwned()` right after creation so user files
stay `PUID`-owned even though the process is root:

- `instances/<pad>/` dir (createVm)
- `meta.env` (setMetaFlag / writeMeta)
- `docker-compose.yml` (writeInstanceCompose)
- `web.json` + publish state files
- `logs/` (log-store dir)
- agent data dir recreated after a wipe (reset paths)

Rule: one helper call after each create — never before, never "in batch at the
end" (a crash between create and chown leaves a root-owned file the user is
locked out of).

### Phase 4 — simplify wipe/delete + strip root-owner workarounds

- `removeInstanceDir` → plain `fs.rmSync(instDir, { recursive: true,
  force: true })`; delete the root-helper container launch, the
  `EACCES`/`EPERM` branches, and the "run this chown on the host" errors. All
  four call sites (removeVm, resetVm, recreateAgent, applyAgentChanges reset)
  get simpler and cannot EACCES.
- `applyWebAuth`/`removeWebAuth`: remove the chown dances; read/write the
  root-owned config directly. Re-verify the publish → unpublish round-trip
  still restores the pre-publish `controlUi` (keep the state file if it is
  still needed for that; drop the parts that exist only for the uid-1000 read
  problem).
- `patchOpenclawConfigViaHelper` + the `driverConfigPath`/`configPath`
  root-owned error branches → plain fs ops.
- Clean up AGENTS.md/docs that describe the EACCES behavior.

### Phase 5 — agent data becomes user-owned too

- The boot sweep (Phase 2) also chowns `instances/<pad>/<agent>` data to
  `PUID:PGID`. Agents run as root and bypass ownership checks, so they keep
  working — this is the proof-backed historical normalization, now automatic.
- Verify per driver live (openclaw/opencode are root agents — no-op; hermes
  re-`chown`s `/opt/data` to its user on boot — confirm that user's uid equals
  `PUID` in our image; codex/picoclaw/claude — root or matching uid):
  create each type, let it write data, confirm the webui + host user can read
  everything and the agent still starts clean on next boot.
- If any driver legitimately needs non-`PUID` ownership, exclude its data dir
  from the sweep (decision point, not expected).

### Phase 6 — docs, tests, E2E

- **Docs**: `docs/overview/business-logic.md` (root-owned data section →
  "webui is root; user files stay PUID-owned"), `docs/backend/services.md`
  (removeInstanceDir simplified, ownership module), `docs/operations/overview.md`
  (drop the manual chown runbook), AGENTS.md gotchas rewritten.
- **Tests**: existing suites (vm-manager, workspace, registry, db, log-store,
  mcp) still pass with the container running as root; add a unit test for
  `ownership.js` (ensureOwned idempotent, normalizeTree recurses).
- **E2E** (the proof, per AGENTS.md): create a pad → every webui-created file
  is `PUID`-owned; run a root agent until it writes root data → boot sweep
  re-normalizes it; reset the pad → plain `fs.rmSync` wipes even a root-owned
  `chmod 700` dir; unpublish → republish a web app and confirm the round-trip;
  confirm the host user can browse every file with `ls`.

### Phase 7 — per-agent "Container user: Root / User" option (from `01-ideas.md`)

The idea pulled in (01-ideas.md:13): the create form gets a **"Container user"
choice — root (0) or local user (`PUID`)** — persisted in `meta.env`, the
generated compose emits `user: "<uid>:<gid>"` for the user pick, plus a live
compose/container preview in the create form.

**Fact-check of the idea's recorded blocker** (against the current drivers and
`vm-builds/*/start.sh`):

- `chpasswd` (set the root password) and `sed /etc/ssh/sshd_config` genuinely
  need root — every start.sh runs both at boot.
- sshd binding port 22 does **not** need root in a default Docker container —
  `NET_BIND_SERVICE` is in the default capability set; the sshd_config sed
  exists for agent-to-agent port conflicts in shared network namespaces, not
  for uid.
- The real blocker for a whole-container `user: 1000:1000` is the config home:
  `dataDir` is `/root/.<agent>` for openclaw/opencode/picoclaw/codex/claude, so
  a uid-1000 daemon with `HOME=/root` cannot write its own config. hermes is
  the existing user-level precedent (`/opt/data`, runs as its own user, start.sh
  chowns to it).

**Delivery paths (decision made with plan 41 in view — see "Relation to plan
41" below):**

1. **Drop-privilege entrypoint (v1 default):** the container keeps its root
   boot (chpasswd, sshd_config, sshd, start-web hooks all run as today), then
   `exec setpriv --reuid <PUID> --regid <PGID> --clear-groups <agent daemon>`.
   The agent daemon — and every file it writes — is user-level; SSH stays the
   root admin door. Smallest per-driver change (touch `start.sh`, no dataDir
   moves).
2. **Whole-container non-root (the idea's strict mode):** compose emits
   `user: "<PUID>:<PGID>"`; the start.sh root bits move to image build time
   (chpasswd the container user, sshd_config via COPY); `dataDir` moves to
   `/home/<user>` (or `/root` chowned to `PUID`); SSH logs in as the container
   user instead of root. Per-driver image rework — the "full non-root support"
   path the idea called out.

**Ownership principle — universal, not location-based (user directive):** every
process that writes on the user's behalf must run as (or chown to) the
designated user. The workspace folder does not matter — default mount, custom
mount, anywhere. There are THREE writers inside an agent container:

1. **Agent daemon** (openclaw gateway / opencode / …) — the actual file
   editor. User mode drops it via setpriv → every file it creates is
   `PUID`-owned, wherever it writes. This is the ONLY mechanism that keeps new
   writes correct; a chown sweep fixes existing files but cannot outrun a
   process still running as root.
2. **Web terminal** — `docker exec <pad> sh -lc` with no `-u`
   (src/app.js:200), so it runs as the container default user (root). In user
   mode this must become `docker exec -u <PUID>:<PGID>` (and the tmux attach
   path in app.js), else anything typed in the terminal still lands root-owned
   in the workspace.
3. **SSH** — root login, kept as the admin door by design (unchanged).

Because every writer runs as the designated user, ownership is correct **by
construction** in every folder — including custom plan-24 workspaces outside
`instances/`, which need no special handling and no sweep entry. The Phase 5
boot sweep exists only to heal LEGACY root-owned data under `instances/` +
`src/data/`; it is not needed for ongoing correctness.

**Relation to plan 41 (dev containers) — ONE non-root mechanism, not two:**
plan 41's "Non-root agent containers" section (items 32–36) is the SAME
machinery as Phase 7. If built independently, the two plans would ship
conflicting designs (different user name, different dataDir scheme, plan 41
forcing all pads non-root vs 43's per-PAD choice). Resolution:

- **Phase 7 builds the shared foundation in plan-41's shape:** user-mode pads
  get a `pad` user at `PUID:PGID` + passwordless sudoers drop-in (plan 41
  items 32/35), compose emits `user: "${PUID}:${PGID}"` with `HOME=/home/pad`
  (item 33), and the daemon + terminal drop to `PUID` (setpriv / `-u`). Plan
  41 then only has to map `containerUser`/`remoteUser` → `USER_MODE` — its own
  user-building items collapse.
- **dataDir stays put (chmod 755 `/root`), the `/home/pad` remap is NOT a
  prerequisite.** Plan 41's item 34 (move `/root/.<agent>` →
  `/home/pad/.<agent>`) is a large driver-wide change. The real blocker for a
  non-root daemon is just that `/root` is mode 700 — a PUID process cannot
  even traverse into the bind-mounted config. `chmod 755 /root` in the image
  + PUID-owned mount contents (boot sweep) fixes it with zero driver churn.
  The remap stays a possible later cleanup inside plan 41, not a dependency
  of plan 43.
- **Plan 41 items absorbed here:** its removeVm simplification (item 36) is
  Phase 4; its "convert existing root-run PADs" problem (open question 5) is
  solved by the Phase 2/5 boot sweep. Both shrink to zero in plan 41.
- **Sequencing:** 43 Phases 1–6 (pure webui/root work) → 43 Phase 7 lands
  per-PAD user mode → plan 41 rides on it, adding only devcontainer.json
  field mapping + lifecycle commands.

**Backend:** `createVm` accepts `userMode: 'root'|'user'` → persisted as meta
`USER_MODE` → compose gains `user:` for the user pick; `readSettings` exposes
it; a Settings toggle lets existing pads switch mode via the normal recreate
flow. **Frontend:** create-form segmented control (Root / Local user) + the
create preview card. **Verification per driver:** create each type in user
mode, confirm the daemon runs as `PUID`, its data stays `PUID`-owned across
recreate/reset, SSH/web-publish still work, and the agent writes nothing the
host user cannot read.

## Files

- **Modified** `docker-compose.yml` — remove `user:` + `group_add:`
- **New** `src/services/ownership.js` — uid/gid from `PUID`/`PGID`,
  `ensureOwned`, `normalizeTree`, `ensureDataOwned`
- **Modified** `src/app.js` — boot `ensureDataOwned()` + background
  `normalizeTree(instances/)`
- **Modified** `src/services/db.js` — chown `app.db*` after open/create
- **Modified** `src/services/vm-manager.js` — `removeInstanceDir` simplified to
  `fs.rmSync`; chown-on-create in createVm/setMetaFlag/writeInstanceCompose/
  reset paths; `applyWebAuth`/`removeWebAuth`/`patchOpenclawConfigViaHelper`
  simplified; remove EACCES branches; `userMode`/`USER_MODE` plumbing + compose
  `user:` emission (Phase 7)
- **Modified** `src/services/agent-registry.js`, `src/services/log-store.js` —
  `ensureOwned` on created dirs
- **Modified** `src/vm-builds/*/start.sh` (Phase 7) — drop-privilege entrypoint
  for user-mode pads
- **Modified** `src/vm-builds/*/Dockerfile` (Phase 7) — `pad` user at
  `PUID:PGID` + sudoers drop-in + `chmod 755 /root` (shared with plan 41)
- **Modified** `src/app.js` (Phase 7) — terminal `docker exec` gains
  `-u <PUID>:<PGID>` for user-mode pads (both the direct run and tmux attach
  paths) so terminal-typed file changes are user-owned too
- **Modified** `src/client/src/pages/create` + Settings (Phase 7) — Container
  user segmented control, compose preview, mode toggle
- **Modified** docs + AGENTS.md (see Phase 6)

## Progress

- [ ] Phase 1 — container runs as root (compose, recreate)
- [ ] Phase 2 — `ownership.js` + boot normalization (data + instances)
- [ ] Phase 3 — chown-on-create at every webui create site
- [ ] Phase 4 — wipe/delete simplified, root-owner workarounds stripped
- [ ] Phase 5 — agent data sweep verified per driver
- [ ] Phase 6 — docs, tests, E2E proof
- [ ] Phase 7 — per-agent Container user option (backend + UI + start.sh +
      user-mode terminal exec)

## Verification

```bash
docker exec paddock id                 # → uid=0(root) (was uid=1000)
docker exec paddock stat -c '%u:%g' /workspace/src/data/app.db
                                       # → 1000:1000 (user-owned, not root)
ls -la instances/pad-test/ meta.env docker-compose.yml web.json
                                       # → PUID-owned
# reset a pad with root-owned data seeded in it:
mkdir -p instances/pad-test/<agent>/data/rootowned && chmod 700 ...
# → recreate with reset:true succeeds (plain rmSync), dir gone
docker exec -e GUARD_PROJECT_ROOT= -e GUARD_INSTANCES_PARENT= \
  -e GUARD_AGENT_DATA= paddock node --test test/vm-manager.test.js
# → 44 pass
```

## Open questions / decisions

- **Rebuild vs recreate:** no image change is strictly needed (CMD is
  `node app.js`), but a rebuild re-bakes the image with the compose change in
  context. Default: rebuild + recreate.
- **Agent-data sweep risk:** if a driver's container user is not root and not
  `PUID`, chowning its data dir to `PUID` could break first boot. Verified
  expectation: hermes is the only candidate; its uid in our image must match
  `PUID` (default 1000). Fallback: exclude that driver from the sweep.
- **Custom workspace mounts need no special handling** — since every writer
  runs as the designated user, ownership is correct by construction wherever
  the agent writes.
- **Security trade-off (accepted):** node runs as root, widening the blast
  radius of any webui exploit to the bind-mounted `/workspace`. The webui
  already holds the docker socket (root-equivalent container control), so the
  real delta is moderate — but it is a real change and the reason the previous
  design ran uid 1000.
- **What does not change:** root-mode agent containers keep running as root and
  keep writing their data as root mid-run; the sweep normalizes ownership, it
  does not stop root agents from writing root files. Only pads the user creates
  in **user mode** (Phase 7) get a truly non-root agent daemon.
- **Phase 7 delivery path (DECIDED for plan-41 alignment):** drop-privilege
  entrypoint as v1 (root boot keeps chpasswd/sshd/start-web; daemon + terminal
  drop to `PUID`), with the image gaining the `pad` user + sudoers up front so
  plan 41's `containerUser` can reuse it. dataDir stays `/root/.<agent>` with
  `chmod 755 /root`; the `/home/pad` remap is deferred to plan 41.
