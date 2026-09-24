# Plan 49 — Workspace modes: bind / worktree / copy / volume (independent work histories)

## Status: [SUPERSEDED by plan 52 — do not build from this file; remaining work tracked ONLY in plan 52]  Draft (2026-09-24) — raw requirements captured verbatim from the
user + context from prior plans. 0 phases built, design NOT started. Nothing
in this file is verified against code yet — every design claim carries a
"verify" marker. Related: plan 44 (workspace card, Proposed), plan 27
(persist toggle, Blocked/dropped — Docker cannot overlay `/`), plan 41
(custom build commands), plan 24 (custom workspace).
Build order: Block 0 (backend) + Block 3 (UI, merged with plan 44). Master sequence: plan 48 “Build order”.

## 1. The user's mental model (confirmed back — this is correct)

1. Paddock runs agents. The user starts an agent, creates an agent, and keeps
   it per project folder.
2. Each project has requirements defined in its `.devcontainer` file. Whenever
   a project starts for a folder, the agent is created for those requirements
   with all files and the dev environment it needs (devcontainer build).
3. The agent is up all the time. The user talks to the agent directly for
   coding/development — anything, basically — because the agent has its own
   setup. Multiple sessions with the same agent are possible (terminal
   sessions).
4. The agent has its own git work history because it is its own container.

## 2. The core problem (user's words)

> If we want a different work history we have to create a new container. But
> when we create a new container the files will be synced because the drive
> is mounted — the path is mounted of the project.

The bind mount (`source path` → `target path`) means container B sees exactly
container A's files. There is no such thing as an independent work history
while the workspace is a shared bind mount. A second agent for experiments /
parallel streams / clean-room work is impossible without it clobbering (or
being clobbered by) the first.

## 3. The requested feature (user's words, kept verbatim in intent)

When creating a new agent, the workspace section already asks for a source
path and a target path. Add a **mode selector** there:

- **Bind (mount) — today's behavior, stays the DEFAULT.** Source folder is
  mounted into the container at the target path. Live sync both ways.
- **Copy (snapshot) — NEW.** The user enters source folder + target folder.
  The source folder's content is **copied** (not mounted) into the target
  folder. The copy step is written into **that agent's build file**, so every
  rebuild re-copies fresh from source — **changes made inside the container
  are lost on rebuild, and that is the correct architecture** (clean-room
  agent: reproducible environment, disposable work).
- **Worktree (branch) — NEW, PREFERRED when the source is a git repo.**
  Aligned 2026-09-24 with the reference projects (Bernstein architecture
  docs + VibeKanban creating-workspaces docs, both verified live): NOBODY
  clones per agent — everybody worktrees. The orchestrator runs
  `git worktree add <source>-<agent> -b <branch>` on the host source, and the
  agent's mount points at the WORKTREE dir (own directory, own branch — one
  agent, one directory, one branch), never at the shared source. Near-free
  (shared object store, no network), full files (run/debug/test identically),
  real history + merge-back path (unlike copy). Untracked files
  (`node_modules`, `.env`) reinstall per worktree via the setup/devcontainer
  step. Constraint: the worktree's `.git` file points back at the main
  repo's gitdir — the mount topology must keep it resolvable (design Phase 0
  item). Non-git sources fall back to copy.
- **Volume (persist) — NEW.** The user selects a folder in the container to
  back by a Docker named volume instead of any host path. Survives rebuilds
  AND is independent of the host source. For work that must not be lost but
  must not sync back to the host either.

And: "we will have to add all these features also of handling a volume" —
volume lifecycle in the UI/backend: create (auto on first use), show which
volume backs which agent path, delete with the agent (with the same
explicit-confirm discipline as agent deletion), never orphan silently.

## 4. Mode semantics (exact — to be enforced, not suggested)

| | Bind | Worktree | Copy | Volume |
|---|---|---|---|---|
| Host ↔ container sync | live, both ways | live, own dir only | never (one-time copy at build) | never (volume storage) |
| Rebuild behavior | files untouched (host is truth) | worktree re-attached (branch work KEPT) | re-copied from source (container changes LOST) | volume re-attached (container changes KEPT) |
| Independent git history | NO (shared files) | YES (own branch + merge-back) | YES (own file tree, no merge path) | YES (own file tree, no merge path) |
| Source must exist at | create AND every start | create AND every start (host git repo) | build time only | never (created empty, seeded per option below) |
| Needs git source | no | YES (else copy) | no | no |
| Default | YES | no (preferred for experiments on git sources) | no | no |

- Copy-mode rebuild MUST warn in the UI that container-side changes will be
  lost ("Rebuild discards container changes and re-copies from <source>").
  Exact warning copy TBD in design.
- Copy-mode seeding options (design must pick one as default): copy at
  `docker build` time (baked into the per-PAD image — survives everything
  except rebuild, heaviest) vs copy at container start (start.sh — fresh
  every restart, lightest, matches "rebuild re-copies" most literally).
  Verify which the build pipeline supports (per-PAD `build/Dockerfile` +
  `writeCustomBuild` exist per plan 41 — VERIFY in code).
- Volume-mode seeding: empty volume vs seed-once-from-source (Docker's
  copy-on-first-use for named volumes). Design must decide + document.

## 4b. Nested-Docker registry (user requirement — agents spawn compose stacks)

Developer agents (`allowDocker` = host socket shared into the PAD) spawn the
project's OWN compose stacks as host siblings — one shared port space, so
uncoordinated agents collide. Three conflict classes, all owned by the
orchestrator at setup (plan 50 Step 4 writes these, this plan stores them):

1. **Published ports.** Identical compose files race for the same host port.
   Rule: compose files parameterize ports (`${APP_PORT:-8080}`); the
   orchestrator allocates a per-agent port block and writes the override
   (`.env` / `docker-compose.override.yml`) — no agent picks its own ports.
2. **Project/container names.** Default project name = directory basename:
   two agents on like-named dirs adopt each other's containers. Rule: always
   `docker compose -p <agent-scoped-name>` (derived, stored in meta).
3. **Volumes/data.** Same named volume = shared DB (sometimes wanted, usually
   not). Rule: prefix per agent by default; explicit share only on request.
- Stored per agent (meta/TBD): allocated port block + compose project name +
  volume prefix. Displayed in Settings (read-only — orchestrator-assigned).
- Out of scope: true DinD daemons per agent (we share the host socket by
  design); cross-agent service discovery beyond distinct host ports.

## 5. The fear (user's words — treated as a hard constraint)

> All these things are going to be handled — this is a very big change, I
> think the whole software will be destroyed with one wrong change.

Safety rules for this plan (non-negotiable, from AGENTS.md + the user):

1. **Additive only.** Bind stays the default and its code path is not
   restructured — copy/volume are NEW branches around it, never edits inside
   it. A user who never touches the mode selector gets byte-identical compose
   output to today.
2. **No shared-code refactors** to `generateInstanceCompose`'s existing mount
   logic — new functions, new meta flags, old lines untouched.
3. **Meta-flag discipline**: new flags (`WORKSPACE_MODE=bind|worktree|copy|
   volume`, names TBD) follow the `meta.env` contract (absent = today's
   behavior).
4. **Guard compatibility**: `GUARD_*` workspace-mount guards keep applying to
   bind, worktree-source, AND copy-source paths (all three are host reads).
5. **Test before delivering**: unit tests per mode (compose emission for each
   mode, rebuild semantics, volume lifecycle), live-verify on a throwaway
   PAD (`test-agents`), restart + browser-verify the create + settings pages.
   Never the combined suite (hangs) — individual files only.
6. **Incremental phases**: backend emission first → create-form UI → settings
   edit → volume lifecycle → docs absorb. Each phase independently shippable;
   any phase can stop without leaving the tree broken.

## 6. What the design phase must verify in code (not assumed)

- [ ] Exact meta keys today (`WORKSPACE_HOST`/`WORKSPACE_DIR` per plan 44 —
      confirm in `vm-manager.js` + `meta.env` of a real instance).
- [ ] Exact compose emission point for the workspace bind
      (`generateInstanceCompose`) + where volumes are emitted (extraVolumes
      path — reuse, don't duplicate).
- [ ] Per-PAD build pipeline: instance `build/Dockerfile`, `writeCustomBuild`,
      `ensureUserModeBuildFiles` regeneration — where a COPY step can legally
      live (plan 41's `FROM … AS` restriction applies to BuildCommands box;
      confirm whether a `COPY --from=` or host-context copy is even available
      at PAD-image build time — if the build context can't see the host
      source, copy-at-build is impossible and copy-at-start wins by default).
- [ ] `readSettings`/`prepareAgentChanges`/`applyAgentChanges` workspace
      handling (plan 44 §Context) — where the "forever workspace" rule will
      interact with mode switching (can a bind agent become copy? Probably
      yes-with-warning; copy→volume = data migration question — decide).
- [ ] Devcontainer generate/sync path (plan 41): does a copy/volume workspace
      break `.devcontainer/devcontainer.json` regeneration (it writes THROUGH
      the webui container into the workspace — VERIFY behavior when the
      workspace is not a host bind).
- [ ] Deletion path (`removeVm`): named-volume cleanup rules — delete with
      agent by default? extra confirm? (Mirrors the plan-24 lesson: deletion
      already removes custom workspace sources — volumes must follow an
      explicit, warned rule, never silent data loss.)

## 7. Out of scope (explicit — not this plan)

- Plan 27's goal (persisting the OS layer `/` across recreate) — still
  impossible in Docker, still dropped. This plan is about the WORKSPACE only.
- Merging histories across copy/volume agents (no PR/merge mechanics —
  same exclusion as plan 48 §J).
- Kanban board UI (future frontend plan).
- Changing the default: bind remains default forever unless the user says
  otherwise in so many words.

## 8. Phases (sketch — design phase will concretize, each independently shippable)

- [ ] Phase 0 — code verification (§6 checklist above) + record findings here.
- [ ] Phase 1 — backend: `WORKSPACE_MODE` meta + compose emission per mode
      (copy-step or start-hook + named volume), zero drift for bind.
- [ ] Phase 2 — create form: mode selector + per-mode fields/validation.
- [ ] Phase 3 — settings: show mode, allow guarded mode switches, rebuild
      warnings for copy.
- [ ] Phase 4 — volume lifecycle: list/show/delete, orphan accounting.
- [ ] Phase 5 — absorb into `docs/` and close. Gated on explicit user
      confirmation (house rule).

## Verification (house rule, repeats deliberately)

- `timeout 60 docker exec paddock node --test test/<file>.test.js`
  (individual files only).
- `docker restart paddock` after every backend edit.
- Live-verify on a throwaway PAD + browser-verify create/settings pages at
  http://10.69.1.164:6789 before calling any phase done.
