# Dev Container Standard for Paddock (plan 41)

## Status: Proposed (2026-08-12) — 0/20 items, design complete. Paddock
## implements the Development Container Specification: `.devcontainer/
## devcontainer.json` fields honored in the PAD's own container (commands,
## workspace folder, env, mounts, run args, ports, users) + non-root agent
## containers (PUID/PGID user). The project's `image` is never the agent's
## base — only its commands and toolchain stage are used.

Progress checklist:

- [ ] Backend: `instance-image.js` — `readCustomBuild(name)` / `writeCustomBuild(name, text)` that inject/replace/clear the user block between marker comments in `instances/<name>/build/Dockerfile` (anchor: the `# ---- 9. ENTRYPOINT ----` banner all five templates share)
- [ ] Backend: `vm-manager.js` — `writePostCreateScript(name, text)` writing `instances/<name>/build/post-create.sh` (chmod 0755); empty text removes the file
- [ ] Backend: `vm-manager.js` — `createVm`/`createAgent` accept `buildCommands` + `postCreate`; inject the Dockerfile block after `seedBuildDir` (before compose gen so custom `ARG` lines are picked up); write `post-create.sh`; run it via `docker exec` in the create job after `up -d` (streamed, alongside `setupSteps`)
- [ ] Backend: `vm-manager.js` — `readSettings` returns `buildCommands` + `postCreate` (read back from the Dockerfile block + `post-create.sh`)
- [ ] Backend: `vm-manager.js` — `prepareAgentChanges`/`applyAgentChanges` accept both fields; `buildCommands` change → force rebuild, `postCreate` change → plain recreate (no rebuild needed — it is not baked in the image)
- [ ] Backend: `app.js` `POST /api/agents/create` passes both fields through; `validateAgentCreate` sanity-checks them (length cap, NUL rejection)
- [ ] Backend: devcontainer.json detector (new module, alongside `path-probe.js`) — parse the workspace's `.devcontainer/devcontainer.json` (precedence: `.devcontainer/devcontainer.json`, `.devcontainer.json`, `.devcontainer/<folder>/devcontainer.json`) and return the full field set: `postCreateCommand`, `onCreateCommand`, `updateContentCommand`, `postStartCommand`, `postAttachCommand`, `workspaceFolder`, `image`, `build`, `features`, `environment`, `mounts`, `runArgs`, `forwardPorts`, `portsAttributes`, `remoteUser`/`containerUser`, `name` (string/array/object forms joined)
- [ ] Frontend: `CreateAgent.jsx` — "Build & post-create commands" section (two textareas); when a workspace is picked, pre-fill post-create from `postCreateCommand` with a "from .devcontainer/devcontainer.json" badge, editable before submit
- [ ] Frontend: `SettingsTab.jsx` — matching "Build & post-create commands" card, pre-filled, "Save & recreate" (+ optional "Re-run setup" button — stretch)
- [ ] Backend: project-image (multi-stage) — when the workspace's devcontainer has `build`/`image`, build it once as `paddock-proj-<name>:latest` and expose the tag so the build-commands box can `FROM ... AS project` / `COPY --from=...`; the agent's base stays the driver's own image
- [ ] Backend: lifecycle wiring — `postStartCommand` runs on every container start (start.sh, alongside existing start hooks); `postAttachCommand` runs when a terminal/exec session attaches to the agent
- [ ] Backend: `workspaceFolder` honored — project mounts at the devcontainer's `workspaceFolder` (fallback to our default when absent)
- [ ] Backend: `environment` — injected into compose as env vars
- [ ] Backend: `mounts` — honored with validation against `GUARD_*` (sources inside `instances/` / project root / agent data rejected with a clear error)
- [ ] Backend: `runArgs` — allow-listed keys only (`--cap-add`, `--ulimit`, `--sysctl`, `--env-file`, …); anything else rejected with a clear error
- [ ] Backend: `forwardPorts`/`portsAttributes` — ports allocated via the host-port/door system, `portsAttributes` labels applied
- [ ] Backend: `remoteUser`/`containerUser` honored as the non-root pad user (PUID/PGID) — see Non-root section
- [ ] Backend: devcontainer generation — when the workspace has no devcontainer at create time, generate `.devcontainer/devcontainer.json` from the pad's effective config (`workspaceFolder`, lifecycle commands, `environment`, `mounts`, `runArgs`, `forwardPorts`/`portsAttributes`, `remoteUser`), marked `"x-paddock": { "generated": true }`
- [ ] Backend: write-back sync — on pad Settings changes (volumes, ports, env, lifecycle commands) update the workspace devcontainer.json in place; project-authored files get only 1:1 mapped fields updated, everything else preserved
- [ ] Frontend: "Dev Container" card in Settings — file path, state badge (generated / project-authored / missing), diff preview + "Sync" / "Regenerate" actions; CreateAgent option "generate .devcontainer for this workspace" (default on)
- [ ] Backend: agent images — add a non-root user (default name `pad`, UID/GID from `PUID`/`PGID`, default 1000:1000) in all five `vm-builds/*/Dockerfile` templates (+ project-stage `paddock-proj-*` images get the same user)
- [ ] Backend: compose generation — agent containers run with `user: "${PUID}:${PGID}"`, `HOME` pointing at the new user's home, and `docker exec` / start.sh run as that user
- [ ] Backend: driver `dataDir` remap — `/root/.openclaw`, `/root/.opencode`, `/root/.picoclaw`, `/opt/data` (hermes), `/root/.codex`, `/root/.claude` move to the pad user's home (e.g. `/home/pad/.opencode`) so config files stay writable by the non-root user
- [ ] Backend: sudo wiring — non-root user gets passwordless sudo (sudoers drop-in) for runtime root needs; start.sh / post-create scripts that need root use `sudo`
- [ ] Backend: `removeVm` — root-helper delete container becomes unnecessary once instance data is 1000-owned; simplify delete to plain `fs.rmSync` (keep the helper as fallback if a rebuild/upgrade left root-owned data behind)
- [ ] Tests + live verify on `test-agents` (create with a build command + post-create commands → both run; edit post-create in Settings → recreate → rerun; edit build commands → rebuild; devcontainer.json pre-fill round-trip; create/delete a PAD and confirm workspace + data-dir files are 1000:1000 and editable from the host)

## Goal / user flow

1. On **Create Agent**, the user picks a workspace and fills two boxes under
   Advanced settings:
   - **Build commands (Dockerfile)** — `RUN`/`ENV`/`COPY`/etc. lines inserted
     into this PAD's own Dockerfile. Run on **every image build** (first create
     and every rebuild, e.g. Settings → Update).
   - **Post-create commands** — bash lines run **once, in the finished
     container** (project mounted, services up) right after creation.
2. If the workspace ships `.devcontainer/devcontainer.json`, its
   `postCreateCommand` auto-fills the post-create box (editable).
3. If the workspace also has a `build.dockerfile`, Paddock builds it once as
   `paddock-proj-<name>:latest`; the user can reference it in the build box
   with `FROM ... AS project` + `COPY --from=...` to pull the project toolchain
   into their own image.
4. Later, the Settings tab shows the same two boxes. **Save & recreate**
   rebuilds when build commands changed, plain-recreates when only post-create
   changed. A **Re-run setup** action re-executes post-create without a
   recreate (stretch).
5. **Agent containers run as the host user, not root.** Files the agent writes
   into the workspace are owned by `PUID:PGID` (default 1000:1000) on the host
   — the user can open/edit them in any IDE without sudo, and there is no
   root-owned-instance-data delete problem anymore.

## Why two boxes, not one

The build context is only `instances/<name>/build/` — the workspace mount does
not exist during `docker compose build`. So a `RUN cd /project && npm install`
in the Dockerfile fails (no project), writes to the data dir get shadowed by
the runtime bind mount, and project services are not up. Project setup must
run in the running container → the post-create box is real, not redundant.
This matches the ecosystem: the Development Container Specification
(containers.dev, OCI/Linux Foundation) standardizes `postCreateCommand` — "runs
inside the container, once, after first creation" — separate from the image.

| Field | Runs when | Where it lives | Mechanism |
|---|---|---|---|
| Build commands | every image build (create + update/rebuild) | `instances/<name>/build/Dockerfile`, between marker comments | injected Dockerfile lines |
| Post-create | once, after first `up`, in the running container | `instances/<name>/build/post-create.sh` | `docker exec` step in the create job (like `openclaw setup --baseline`) |

No marker-guarded first-boot: post-create runs explicitly in the
create job, so a failed/interrupted setup is visible in the create log and the
create can be retried. **postStartCommand** (every start) and
**postAttachCommand** (terminal attach) live alongside the existing start
hooks in the agent's start.sh — they are the on-start/attach lifecycle, kept
separate from the once-only post-create.

## Non-root agent containers (PUID/PGID user)

> **NOTE (2026-08-15): the non-root mechanism is now specified in plan 43
> (Phase 7 — per-PAD "Container user: Root / User").** Plan 43 lands the shared
> foundation — `pad` user at PUID/PGID + sudoers, compose `user:`,
> `HOME=/home/pad`, drop-privilege daemon + terminal exec as PUID, boot-sweep
> chown — and this plan reuses it: `containerUser`/`remoteUser` maps onto
> `USER_MODE`. The dataDir `/home/pad` remap (items 32–35 below) is DEFERRED /
> optional; plan 43 uses `chmod 755 /root` + PUID-owned mounts instead.
> Items 36–37 (removeVm simplification, tests) are largely absorbed by plan 43
> Phases 4 + 6.

Today agent containers run as **root**, so anything they write into the bind-
mounted workspace becomes root-owned on the host — the user's IDE can open it
but not save without sudo. Fix: run the container as the host user's
UID/GID.

- New user `pad` created in every agent image at `PUID`/`PGID` (defaults
  1000:1000), same pattern the webui container already uses.
- Compose sets `user: "${PUID}:${PGID}"` and `HOME` to the pad user's home;
  start.sh and `docker exec` runs execute as that user.
- **`dataDir` remap** — the drivers' config locations are all under
  `/root/...` today:
  | driver | old | new |
  |---|---|---|
  | openclaw | `/root/.openclaw` | `/home/pad/.openclaw` |
  | opencode | `/root/.opencode` | `/home/pad/.opencode` |
  | picoclaw | `/root/.picoclaw` | `/home/pad/.picoclaw` |
  | hermes | `/opt/data` | `/home/pad/.hermes` (moved so the dir is user-owned) |
  | codex | `/root/.codex` | `/home/pad/.codex` |
  | claude | `/root/.claude` | `/home/pad/.claude` |
  These are bind-mounted dirs, so the per-instance mount targets change too.
- **sudo** — the pad user gets passwordless sudo (sudoers drop-in) so runtime
  commands that genuinely need root still work; build-time root (`apt`, npm
  -g) stays in the Dockerfile as before.
- **Delete simplification** — root-owned instance data was *why* `removeVm`
  needs the root-helper container. With 1000-owned data, delete becomes a plain
  `fs.rmSync`; keep the helper only as a fallback path for data left behind by
  old builds/upgrades.
- **Multi-user hosts** — `PUID/PGID` is a single global value (webui already
  lives by this); per-PAD user settings is a follow-on, not in scope.

## devcontainer.json field map (the open standard)

Locations in spec order: `.devcontainer/devcontainer.json`,
`.devcontainer.json`, `.devcontainer/<folder>/devcontainer.json`.

| Field | Paddock behavior |
|---|---|
| `postCreateCommand` | pre-fill the post-create box (string/array/object joined) |
| `onCreateCommand`, `updateContentCommand` | pre-pended into the post-create box (spec order: onCreate → updateContent → postCreate; on a fresh create all three run back-to-back anyway) |
| `postStartCommand` | stored as a start hook, run **every container start** |
| `postAttachCommand` | run when a terminal/exec session attaches to the agent |
| `workspaceFolder` | project mounts here (fallback: our default when absent) |
| `image`, `build` | never the agent's base — used to build `paddock-proj-<name>:latest` (toolchain stage) |
| `environment` | injected into compose as env vars |
| `mounts` | honored, validated against `GUARD_*`; guarded sources rejected with a clear error |
| `runArgs` | allow-listed keys only; unknown flags rejected with a clear error |
| `forwardPorts`, `portsAttributes` | allocated via the host-port/door system; labels applied |
| `remoteUser`, `containerUser` | honored as the pad user (PUID/PGID) |
| `name` | UI badge |
| `features` | open question 3 (install scripts at build time) |
| `customizations` (vscode), `hostRequirements`, `shutdownAction` | not applicable to headless agents (non-goals) |

Everything runs **inside the PAD's own container** — the project's image is
never swapped in as the base, so Paddock keeps its guards, mounts, ports, and
compose contract. Guard/validation rules exist precisely so honoring
`mounts`/`runArgs` can't mount `instances/` or the project root or escalate
beyond an allow-list.

## Devcontainer generation & write-back sync

The devcontainer.json is the **portable, version-controllable mirror of the
pad** (this plan calls the agent instance a *pad*).

- **No devcontainer in the folder** → Paddock generates
  `.devcontainer/devcontainer.json` at create time from the pad's effective
  config: `workspaceFolder`, the post-create/post-start/post-attach commands,
  `environment`, `mounts`, `runArgs`, `forwardPorts`/`portsAttributes`,
  `remoteUser` — marked `"x-paddock": { "generated": true }` so it can be
  recognized and regenerated.
- **Pad changes later** (add a volume, add ports, change env or lifecycle
  commands in Settings) → **write back** into that file in place, keeping it
  current. The file stays the source a dev-tool user could open the project
  with.
- **Project-authored file** (has its own fields Paddock never set) → only the
  1:1 mapped fields are updated (ports, volumes, env, workspaceFolder,
  lifecycle commands); everything else is preserved — no clobbering.
- **UI**: Settings gains a "Dev Container" card (file path, state badge
  generated / project-authored / missing, diff preview with "Sync" and
  "Regenerate"); Create Agent gets "generate .devcontainer for this workspace"
  (default on).
- **Direction** (open question 8): import at create time, push on pad changes
  after — or explicit two-way diff with pull/push buttons.

## Project image (multi-stage) + libc compatibility

- The upstream opencode image (`ghcr.io/opencode-ai/opencode`) is **Alpine /
  musl** — its Dockerfile is `FROM alpine` + `apk add libgcc libstdc++`.
- Paddock's own opencode image is **`node:20-slim` (Debian bookworm, glibc)**
  with `npm install -g opencode-ai` — so the PAD's container is glibc, the same
  family as Ubuntu/Debian project devcontainers. `COPY --from=` of glibc-built
  binaries/venvs from a Debian/Ubuntu project stage works cleanly; only a
  musl (Alpine) project stage would clash, and that case is documented.
- Mechanics: Paddock builds the project's `build.dockerfile` (or `image`)
  once as `paddock-proj-<name>:latest` (BuildKit), then the user writes in the
  build box:
  ```dockerfile
  FROM paddock-proj-myrepo:latest AS project
  COPY --from=project /usr/bin/python3.12 /usr/local/bin/
  COPY --from=project /opt/venv /opt/venv
  ```
- **Alpine project / Debian agent** (open question 6): the project's `image`
  is never the runtime base, so a musl image can't host the glibc agent. Only
  *source-level* things cross stages (code, scripts, node_modules, config);
  precompiled musl binaries and Alpine-only commands (`apk`) don't run on the
  Debian agent. Options: stage-copy only (ships now), Alpine driver variants,
  or a sidecar project container (full fidelity).

## Dockerfile injection

- Insert before the `# ---- 9. ENTRYPOINT ----` banner (present in all five
  driver templates), between idempotent markers:
  ```dockerfile
  # ── PADDOCK CUSTOM BUILD COMMANDS (managed by the web UI) ──
  RUN apt-get install -y vim
  # ── END PADDOCK CUSTOM BUILD COMMANDS ──
  ```
- Block absent → insert; present → replace contents; empty text → remove.
- A `FROM` inside the block fails the build fast (build precedes recreate, so
  the current container keeps running) — documented in the UI helper text.
- A custom `ARG` line is picked up by `argsFromDockerfile` on the next compose
  regeneration (per `Dockerfile conventions` in docs).

## Edge cases

- **Post-create edited after create**: applying runs it on the next recreate;
  the Settings "Re-run setup" action re-executes it anytime (stretch).
- **Reset (recreate with full user-data reset)**: wipes the data dir only;
  `post-create.sh` lives in the build dir and survives — optionally re-run it
  after a reset.
- **Clone**: `createVm` clone mode already copies the source build dir, so the
  Dockerfile block + `post-create.sh` clone automatically; the clone's create
  job re-runs the post-create commands.
- **Delete**: `removeVm` removes the instance dir (block + script included);
  with the non-root user this is a plain `fs.rmSync` (helper stays as fallback).
- **Upgrade from existing root-run PADs**: containers running as root with
  `/root` data dirs keep working; the non-root user + remap applies to new
  creates/rebuilds (a `Recreate` converts an agent to the new model).
- **MCP `create_agent` / `recreate`**: unsupported for now; `undefined`
  preserves values under the plan-30 rule, so nothing breaks. Stretch item.

## Files touched

| File | Change |
|---|---|
| `src/services/instance-image.js` | `readCustomBuild` / `writeCustomBuild` + markers |
| `src/services/vm-manager.js` | post-create script writer, create/settings/readSettings wiring, project-image build, `user:`/`HOME` in compose gen, data-dir mount targets, removeVm simplification |
| `src/services/devcontainer.js` (new) | devcontainer.json parse + precedence + `generate(cfg)` + `syncFile(...)` write-back |
| `src/vm-builds/*/Dockerfile` (×5) | pad user creation + sudoers, start.sh runs as pad user |
| `src/services/drivers/*.js` | `dataDir` remap to `/home/pad/...` |
| `src/app.js` | create route passes the two fields; settings already funnels through `prepareAgentChanges` |
| `src/client/src/pages/CreateAgent.jsx` | Advanced → Build & post-create commands section + devcontainer pre-fill |
| `src/client/src/pages/agent/SettingsTab.jsx` | Build & post-create commands card |
| `src/services/instance-image.js` / `.env` | `PUID`/`PGID` defaults (1000:1000) documented |

## Tests

- `vm-manager.test.js` additions (run individually, `GUARD_*` unset): Dockerfile
  block insert/replace/clear round-trips; `post-create.sh` write/remove;
  devcontainer.json precedence + string/array/object `postCreateCommand`
  parsing; compose emits `user: "${PUID}:${PGID}"` + remapped `dataDir` mounts;
  generation produces a valid file with `x-paddock` marker; write-back updates
  managed fields and preserves project-authored ones.
- Live verify on `test-agents`: create with a build command + post-create
  commands → both run; edit post-create in Settings → recreate → reruns; edit
  build commands → image rebuilds and the change takes effect; workspace with
  a devcontainer.json → post-create pre-fills; **create + delete a PAD and
  confirm workspace and data-dir files land as `1000:1000` and are editable
  from the host, and delete works without the root helper**.

## Docs (after completion)

- Absorb into `docs/overview/business-logic.md` (Per-Instance Build Model →
  Dockerfile conventions + a post-create subsection), `docs/backend/services.md`
  (instance-image + vm-manager function refs), `docs/tabs/settings.md`,
  `docs/pages/overview.md`. Then remove this plan file.

## Open questions

1. **"Re-run setup" in Settings** — build now or leave as a stretch?
2. **Build-command validation** — permissive (fail-fast at build, container
   stays up) or pre-validate (reject `FROM`, unbalanced continuations)?
3. **devcontainer.json `features`** — run feature install scripts at build
   time (ghcr.io/devcontainers/features/... registry), or leave for later?
4. **Project-image auto-build** — always build `paddock-proj-<name>:latest`
   when a `build`/`image` exists, or only on demand (a checkbox)?
5. **Existing root-run PADs** — silently leave them root (convert on recreate),
   or add a one-time "Convert to non-root" action in Settings?
6. **Alpine project / Debian agent** — stage-copy only (recommended), Alpine
   driver variants, or a sidecar project container?
7. **Multi-user hosts** — follow-on plan (per-PAD `PUID`/`PGID` override), or
   explicitly out of scope forever?
8. **Write-back direction** — pad-wins (import at create, push on every pad
   change), or explicit two-way diff with pull/push buttons in the UI?
