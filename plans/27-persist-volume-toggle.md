# Persistent Container Storage Toggle (plan 27)

## Status: Blocked (dropped 2026-08-08) — mechanism impossible in Docker; all
implementation reverted.

> **The core mechanism is impossible in Docker.** The container's root
> filesystem *is* the writable layer — there is no place a volume can sit
> "under" `/`. Docker has no way to overlay a volume on top of the rootfs, so
> "installs and `/etc` survive a recreate" cannot be done with a volume mounted
> at `/`.
>
> **Verified live** on `pad-opencode-test3`: flag wrote, compose regenerated,
> and the recreate failed at exactly the volume mount. The rollback behaved
> correctly (PERSIST reverted, container back Up, no config damage); the only
> artifact was an orphaned `pad-opencode-test3_root` volume, which was removed.
>
> **Decision:** per the user's instruction, the plan is dropped and **all
> implementation was reverted** (meta flag, compose emission, applySettings /
> rollback, health-check skip, Settings tab toggle + dialogs, CreateAgent
> checkbox, tests, docs — all rolled back; only the unrelated `GUARD_*`
> workspace-mount guards, a separate change, remain). The checkbox list below is
> left as-is for historical reference.
>
> **Alternative considered (rejected):** `docker commit <pad> paddock-persist-<pad>`
> into a per-agent image and point the compose `image:` at it (toggle off →
> back to `paddock-vm-<type>:latest`; reset → delete the image; re-commit to
> capture later changes). It genuinely preserves OS-layer state, at the cost of a
> stored image per PAD. Not pursued — the app data dir already persists via bind
> mounts, and OS-layer persistence wasn't worth the image-snapshot model.

## Goal

A per-agent **toggle** in the Settings tab that makes *all* container changes
(`apt install htop`, pip/npm installs, edited `/etc` files, cron state outside
the data dir, …) survive a container recreate.

Off (default) = today's behavior: only the bind mounts persist; everything
written to the container's writable layer is lost on `--force-recreate`.

On = the agent's compose gets an extra **named Docker volume** mounted at `/`.
Docker auto-populates the volume from the image on first run, so the container
keeps its OS-level state across recreates. The existing bind mounts (data dir,
docker socket, custom workspace) nest under it and keep working exactly as
today — the volume only holds the parts nothing else mounts.

The volume is **owned by the agent and removed with it**: delete wipes
`<name>_root` (the volume Docker creates for it), and reset wipes it too.

## How it works

```yaml
services:
  pad-openclaw-x:
    volumes:
      - /www2/paddock/instances/pad-openclaw-x/openclaw:/root/.openclaw   # bind (unchanged)
      - root:/                                                            # NEW when PERSIST=1
      - /var/run/docker.sock:/var/run/docker.sock                          # when allowDocker
volumes:
  root: {}
```

- Docker's volume-population rule: a **fresh, empty named volume** mounted at a
  non-empty path copies the image content into itself once. At `/` that means
  the whole container rootfs becomes the volume's seed content. Recreates reuse
  the existing volume (no copy), so nothing written since first boot is lost.
- Docker treats per-path mounts as additive: the volume at `/` is shadowed by
  the more specific bind mounts at `/root/.openclaw`, `/var/run/docker.sock`,
  and any custom workspace path. The binds stay the live source for their
  subtrees (visible on the host, backed up, cloned); the volume owns everything
  else (`/usr`, `/etc`, `/tmp`, `/var/lib/...`, …).
- `/etc/hosts`, `/etc/hostname`, `/etc/resolv.conf`, `/proc`, `/sys`, `/dev`
  are still Docker-managed runtime mounts — the volume at `/` does not shadow
  them, so DNS/hostname/PID behavior is unchanged.
- Compose derives the project name from the compose file's directory
  (`instances/<name>/`), so the declared top-level volume `root` becomes the
  Docker volume **`<name>_root`** — same naming scheme as the already-handled
  `<name>_default` network. Declaring it in the top-level `volumes:` block
  (rather than the short `- <name>_root:/` syntax) is what guarantees the exact
  name without double prefixing.

## Current behavior (verified 2026-08-08)

- `generateInstanceCompose()` (`vm-manager.js:327`) emits exactly one volume
  line (data-dir bind) plus optional custom-workspace and docker.sock binds.
  It already reads `meta.env` via `readWorkspaceMount(name, agent)` (:332), so a
  `meta.PERSIST` read inside the same function is the same pattern — sticky
  across every regen path (create, settings, web publish, reset, update,
  `ensureInstanceBuilds` migration) with zero caller changes.
- Settings GET (`app.js:887`) returns `{ allowDocker, network, image, version,
  networkHealth, workspaceMount }` from `meta.DOCKER`/`meta.NETWORK`.
- Settings POST (`app.js:953`) is the SSE job flow: pre-validate → stop →
  `vm.applySettings()` → `--force-recreate` → web-binding reconcile → rollback
  on failure. `applySettings()` (`vm-manager.js:437`) writes meta flags
  (`DOCKER`, `NETWORK`) *after* the compose regen.
- `removeVm()` (`vm-manager.js:799`) does `docker rm -f`, `docker network rm
  <name>_default`, removes the instance dir and the per-instance image — no
  volume cleanup exists yet.
- `resetVm()` (`vm-manager.js:825`) does `docker rm -f`, wipes the agent data
  dir, regenerates the compose, and recreates.
- `container-health.js` diffs `docker compose config --format json` volumes
  against `ctr.Mounts`. A named volume's `source` is a volume name (e.g.
  `pad-x_root`), not a host path, so the current check would report a spurious
  "missing on host" WARN for it (see Design — health check).

## Design

### Meta flag: `PERSIST`

`meta.env` gets `PERSIST=1` / `PERSIST=0`, mirroring `DOCKER`/`NETWORK`. It is
the single source of truth; the compose generator reads it.

### `generateInstanceCompose()` — volume emission

When `meta.PERSIST === '1'`, emit the extra volume line **and** a top-level
`volumes:` block (compose allows the `networks:` block appended after the door
today, so `volumes:` appended the same way is fine):

```yaml
    volumes:
      - ${HOST_WORKSPACE}/instances/${name}/${agent}:${dataDir}
      - root:/            # only when PERSIST=1
      ...
volumes:
  root: {}
```

No driver/config changes — this is a pure Docker-level mount, identical for
openclaw, picoclaw, hermes, opencode, and codex.

### Create flow (optional, recommended)

- `CreateAgent.jsx` gets a "Persistent container storage" checkbox (default
  off) in the same form as the existing options.
- `createVm(name, { persist = false, ... })` writes `PERSIST=1/0` into the
  initial `metaTxt` **before** `writeInstanceCompose` so the compose picks it
  up on first boot (fresh volume → seeded from the image).
- Not adding it to create does not block the feature — the Settings toggle
  covers existing agents.

### Settings API

- **GET** (`app.js:887`) → add `persist: meta.PERSIST === '1'`.
- **POST** (`app.js:953`) → read `persist` from body; `newPersist =
  persist !== undefined ? !!persist : oldPersist`; if changed, it joins
  `dockerChanged`/`networkChanged`/`workspaceChanged` in the no-change early
  return, the `summary`, the `reason`, and the rollback path. No rebuild ever —
  a volume mount is a create-time setting, so the recreate (already in the job
  flow) applies it.
- `applySettings(name, { allowDocker, network, workspaceHost, workspaceDir,
  persist })` → `setMetaFlag(name, 'PERSIST', persist ? '1' : '0')`. Like the
  `WORKSPACE_*` flags, PERSIST must be written **before**
  `writeInstanceCompose` (the generator reads it from meta). It is the DOCKER/
  NETWORK flags that are written after — this ordering already exists in
  `applySettings` for the workspace mount (:465-471 before :480), so PERSIST
  slots in next to it.
- **Turning it on**: the recreate seeds a fresh volume from the **image**, not
  from the running container's current filesystem. Container changes made
  *before* the toggle are not captured — they are lost exactly like they would
  be on any recreate. The correct workflow is **enable persist first, then
  install**. (An opt-in "capture current state on enable" is possible — see
  Mid-run toggle semantics and Open question 5.)
- **Turning it off**: the volume is detached (not deleted) — the container goes
  back to an ephemeral writable layer. Confirm dialog warns that switching off
  means future changes are lost again on recreate; the old volume stays on disk
  as a leftover the user can reclaim (see removeVm cleanup / open question).
  **Any state written while off is lost when toggling back on — the old volume
  content comes back instead.**

### Mid-run toggle semantics (the tricky cases)

Every toggle is **not a hot switch** — it runs the standard SSE job:
stop → compose regen → `--force-recreate` → start. So toggling restarts the
agent (kills running sessions/cron, brief downtime) exactly like the docker and
network toggles. On top of that, the **direction** of the toggle decides what
state survives:

| Transition | Volume state | What survives | What the user must know |
| --- | --- | --- | --- |
| OFF → ON (volume doesn't exist) | Created, seeded from **image** | Bind mounts only | Current installs (htop, …) are **not** carried over. Install AFTER enabling. |
| OFF → ON (volume exists — was on before) | Reattached with old content | Bind mounts + old volume content | Anything done while it was off is gone. Old content "comes back", which can look like data loss or resurrection. |
| ON → OFF | Detached, kept on disk | Bind mounts only | Container returns to ephemeral. Old volume is invisible but not deleted — toggling back on resurrects it. |
| ON, then Update | Volume stays attached, masks image | Everything in volume | Rebuilt image content does **not** reach the container's filesystem (planned warning). |
| ON, then Reset | Volume deleted, reseeded from image | Bind mounts only | Reset stays a true factory reset (planned). |
| ON, then Delete | Volume deleted | — | No stragglers (planned). |

Specific mid-run cases worth designing around:

1. **"I installed htop, then I toggle persist on to keep it."** This is the most
   natural expectation and it silently fails. The volume is seeded from the
   image, so htop is gone after the recreate. Mitigations, in order of
   practicality:
   a. **Accurate confirm dialog** (required): "This recreate starts from the
      image. Anything installed before enabling is not saved — enable first,
      then install."
   b. **Capture-on-enable checkbox** (optional, phase 2): before the recreate,
      snapshot the current container into the volume. Feasible via `docker
      commit <name> <tmp-tag>` (commits image layer + writable layer, **excludes
      volume mounts**, so no data-dir duplication), then
      `docker run --rm -v <name>_root:/dest <tmp-tag> cp -a /. /dest/`, then
      drop the tmp-tag. This genuinely carries htop across. Size = full OS
      copy, so default unchecked.
2. **ON → OFF → ON round trip.** Toggling off, installing something, toggling
   on: the new install is lost and the old volume content reappears. The
   confirm dialogs on both sides must say this. Not a bug — volume semantics —
   but it is the #1 future "Paddock lost my data" report unless the UI says it.
3. **Toggle while the agent is stopped.** The flow already handles
   `wasRunning=false`: recreate (which seeds/populates the volume), then stop
   again (`app.js:1113-1115`). Volume is created and seeded even though the
   agent never runs. Fine, but the user should know a toggle while stopped still
   triggers a recreate, not a start.
4. **Rapid double-toggle.** Same job-key race as the existing docker/network
   toggles (`getOrCreateJob('update:<name>')` dedupes, second modal streams the
   same job). No data loss; the second click just streams the same run. Not new
   behavior; do not add a fix beyond what toggles already do.
5. **Web-published / peer-networked agent.** The volume line lands only on the
   main service; the door is untouched; `network_mode: container:` is
   orthogonal to volume mounts. No interaction.
6. **Clone.** `createVm` writes `meta.env` fresh, so a clone does **not** inherit
   `PERSIST` (defaults to the create-form value, off). The clone's volume is
   fresh — OS-level state (htop) is not cloned. Document this in the card: only
   the data-dir bind is cloned.
7. **Rollback path.** If the recreate fails, `applySettings` regen+rollback
   (`app.js:1129-1145`) also resets `PERSIST` to the old value, so a failed
   toggle leaves the flag and compose consistent — the volume may exist empty
   (created during the partial up) but is harmless and removed on delete.

### `removeVm()` — volume cleanup

After `docker rm -f` (container gone → no attachments), remove the persist
volume:

```js
// exact name first (compose naming), then any stragglers sharing the prefix
try { await runCmd('docker', ['volume', 'rm', `${name}_root`], { timeout: 15000 }); } catch {}
try {
  const r = await runCmd('docker', ['volume', 'ls', '--filter', `name=${name}_`, '--format', '{{.Name}}'], { timeout: 15000 });
  for (const v of (r.stdout || '').trim().split('\n').filter(Boolean)) {
    try { await runCmd('docker', ['volume', 'rm', v], { timeout: 15000 }); } catch {}
  }
} catch {}
```

The prefix filter is defensive (compose may normalize an unusual name); only
this agent's volumes match `<name>_`. Volume removal is error-swallowed like
the existing network/image cleanup — a straggler volume must never fail a
delete.

### `resetVm()` — true wipe

Reset currently wipes the data dir to mean "factory fresh". With persist on it
must also drop the volume, or the reset would keep the container-side state it
is supposed to clear:

```js
if (meta.PERSIST === '1') {
  try { await runCmd('docker', ['volume', 'rm', `${name}_root`], { timeout: 15000 }); } catch {}
}
```

The recreate then re-seeds a fresh volume from the image. Reset confirm dialog
gains the same warning ("also clears persistent container storage").

### Update interplay (surface the trade-off)

Persisting everything at `/` means the volume **masks the image rootfs** after
it's populated: rebuilding the image (base refresh, new baked packages) does
not reach the container's view of the filesystem. This is the core trade-off
the user accepted, but the Update flow must not pretend otherwise:

- When `meta.PERSIST === '1'`, the Update confirm dialog (`SettingsTab.jsx`
  `handleUpdate`) shows an extra warning line: "Persistent storage is on — this
  container keeps its own filesystem. Image changes baked into the rebuild
  won't appear unless persistent storage is reset."
- Phase-2 nice-to-have: an "Also wipe persistent storage during update"
  checkbox that runs `docker volume rm <name>_root` between build and recreate
  so the fresh image repopulates the volume. Default unchecked; danger-styled.

### Health check interplay

`container-health.js` volume loop (:194-224) assumes every compose volume has a
host path: for the named volume it would emit a spurious
"Host path ... does not exist ... missing on host" WARN (the volume name is not
a path, and `webuiPath()` can't resolve it). Fix: skip the exists-on-host check
when the source does not start with `/` (named volumes have a bare name; bind
mounts always carry an absolute host path) — treat named volumes as ok when a
matching mount exists at the target, warn only on a missing mount.

### Backups

The persist volume is OS-level container state, **not** agent data — it is not
included in agent-data backups (same note as the custom workspace). The Settings
card says so in one line.

## Settings tab UI

New **Persistent container storage** card, right below "Allow docker in the
container" (`SettingsTab.jsx`, same switch pattern as the docker toggle):

- **On**: green-ish accent switch. Body: "All container changes (installed
  packages, edited files outside the data folder) survive recreates via a
  Docker volume."
- **Off**: plain switch. Body: "Container changes are lost on recreate — only
  bind-mounted folders (data, workspace) persist."
- Always-visible one-liner: "⚠ The volume keeps its own copy of the OS layer —
  image updates won't refresh it until the volume is reset."
- Toggling runs the standard SSE recreate job, exactly like the docker toggle
  (`handleToggleDocker` pattern): confirm → `POST /api/agents/:name/settings`
  `{ persist }` → CommandModal streams stop/recreate → onDone refresh.
- **Confirm dialogs must state the real semantics** (see Mid-run toggle
  semantics), not a generic "will recreate":
  - **Turning on, fresh volume:** "This restarts the agent. The persistent
    volume starts from the image — anything installed before enabling (e.g.
    htop) is **not** carried over. Enable first, then install what you want to
    keep."
  - **Turning on, existing volume (was on before):** "This restarts the agent
    and reattaches the old volume. Anything changed while persistent storage
    was off is lost; the old volume content comes back."
  - **Turning off:** "This restarts the agent and detaches the volume. Container
    changes won't survive recreates anymore. The volume is kept on disk — turn
    it back on to restore it."

## Files

- **Modified** `src/services/vm-manager.js` — `generateInstanceCompose` emits
  `root:/` + top-level `volumes: { root: {} }` when meta `PERSIST=1`;
  `applySettings` reads/writes `PERSIST` before the compose regen; `createVm`
  accepts `persist` and writes the flag; `removeVm` + `resetVm` volume cleanup;
  export `persistVolumeName(name)` (`${name}_root`) for reuse/tests.
- **Modified** `src/app.js` — settings GET adds `persist`; settings POST reads
  `persist`, folds it into the no-change/`summary`/`reason`/rollback logic and
  passes it to `applySettings`.
- **Modified** `src/services/container-health.js` — skip the host-path check
  for named (non-`/`) volume sources.
- **Modified** `src/client/src/pages/agent/SettingsTab.jsx` — Persistent
  storage card + confirm + SSE flow (mirrors the docker toggle). Update dialog
  warning when persist is on (+ optional wipe checkbox, phase 2).
- **Modified** `src/client/src/pages/CreateAgent.jsx` + create route —
  (recommended) "Persistent container storage" checkbox, `persist` in the
  create body.
- **Modified** `src/test/vm-manager.test.js` — compose emits the volume + top
  level block only when PERSIST=1, and `persistVolumeName`.
- **Modified** `docs/backend/services.md`, `docs/tabs/settings.md` —
  volume model + toggle behavior.

## Progress

- [ ] `generateInstanceCompose` emits `root:/` + top-level `volumes:` from
      meta `PERSIST`
- [ ] `createVm` + create route accept `persist`; meta written before compose
- [ ] Settings GET returns `persist`; POST applies it through the SSE flow with
      rollback
- [ ] `applySettings` sets `PERSIST` before the compose regen
- [ ] `removeVm` removes `<name>_root` (+ prefix fallback)
- [ ] `resetVm` removes the persist volume for a true wipe
- [ ] `container-health` treats named volumes as ok (no false "missing on host")
- [ ] SettingsTab Persistent storage card + confirm + SSE job
- [ ] Update dialog warns when persist is on (phase 2: wipe checkbox)
- [ ] Unit tests (compose emission, volume name)
- [ ] Docs
- [ ] Live regression (below)

## End-State Acceptance Tests

- **Off:** agents without the flag produce the exact current compose (no volume
  line, no top-level `volumes:`), and `docker inspect` shows no extra mount.
- **On:** `docker inspect <name> --format '{{range .Mounts}}{{.Type}} {{.Destination}}{{println}}{{end}}'`
  shows `volume /` plus the unchanged bind mounts; `docker volume ls` lists
  `<name>_root`.
- **Persistence:** `docker exec <name> apt-get install -y htop` (or `touch
  /persist-test`), `docker compose ... up -d --force-recreate`, then the file
  is still there and `htop` still runs.
- **Bind mounts still live:** write a file in the data dir from the container,
  see it on the host after recreate (both directions), docker.sock and custom
  workspace mounts unaffected.
- **Toggle cycle:** on → create volume + recreate; off → recreate detaches it
  (volume still on disk); on again → reattaches with prior content intact.
- **Directional semantics (the mid-run traps):**
  - Enable persist on a fresh agent, then `apt-get install -y htop` →
    recreate → htop still present.
  - Reverse order: install htop **first**, then toggle persist on → recreate →
    htop is **gone** (volume seeded from image). The confirm dialog said so.
  - On → install something new → off (recreate) → the new install is gone, the
    old volume still on disk → on again (recreate) → old volume content is back,
    the off-period install is not.
- **Delete:** delete the agent → `docker volume ls` has no `<name>_root` and no
  `<name>_*` stragglers.
- **Reset:** reset with persist on → volume gone, container factory-fresh; reset
  with persist off → unchanged behavior.
- **Update:** persist on → update completes, dialog warned, volume intact
  (image changes masked — expected). Phase 2: wipe checkbox → volume
  re-populated from the new image.
- **Health:** the checkup shows the `root:/` volume as ok, no "missing on host".
- **Browser:** Settings card renders and toggles via SSE recreate; update
  dialog warning; mobile layout sane.
- **Regression:** all other regen paths (web publish, network switch, docker
  toggle, migration) preserve the PERSIST flag and never drop the volume line.

## Verification

```bash
# unit
docker exec paddock node --test test/vm-manager.test.js

# live (on a project-created test PAD only)
# toggle on in the UI, or:
curl -s -b /tmp/jar -c /tmp/jar http://10.69.1.164:6789/api/session >/dev/null
curl -s -b /tmp/jar -X POST http://10.69.1.164:6789/api/agents/<pad>/settings \
  -H 'Content-Type: application/json' -H "x-csrf-token: ..." \
  -d '{"persist":true}'

docker exec <pad> sh -c 'echo survived > /persist-test'
docker compose -f instances/<pad>/docker-compose.yml up -d --no-deps --force-recreate <pad>
docker exec <pad> cat /persist-test          # → survived
docker volume ls | grep <pad>                # → <pad>_root
docker inspect <pad> --format '{{range .Mounts}}{{.Type}} {{.Source}} {{.Destination}}{{println}}{{end}}'

# delete cleans up
docker volume ls --filter name=<pad>_        # → empty after delete
```

## Open questions

1. **Wipe-on-update (phase 2)** — add the "wipe persistent storage during
   update" checkbox, or keep Update dumb and let the user toggle off/on/off to
   reset? Recommend the checkbox only after the core toggle ships and is
   verified.
2. **Turning off leaves the volume on disk** — deliberately not deleted (toggling
   off should never destroy data). Should a later "off" state offer a
   "delete the volume now" button? Low priority; volume cleanup on delete is
   already guaranteed.
3. **Create-form default** — ship the create checkbox in the same change or
   defer to a follow-up? The Settings toggle is the core ask; the create field
   is cheap and keeps parity with the rest of the create form.
4. **Disk growth** — the volume is a full extra copy of the OS layer plus
   installs, and nothing trims it. Worth surfacing a volume-size line in the
   Settings card (via `docker system df`) so users can see the cost. Not
   required for v1.
5. **Capture-on-enable (phase 2)** — when turning persist on, offer a
   "carry the current container state into the volume" checkbox so existing
   installs (htop) survive the first recreate. Feasible via `docker commit
   <name> <tmp-tag>` (includes the writable layer, **excludes** volume/bind
   mounts, so no data-dir duplication) → `docker run --rm -v <name>_root:/dest
   <tmp-tag> cp -a /. /dest/` → `docker rmi <tmp-tag>`. Cost: a full OS copy
   (1–2 GB) + commit time, so default unchecked. Worth it? This is the one
   behavior users will assume happens automatically.
