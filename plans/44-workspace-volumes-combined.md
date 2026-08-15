# Plan 44 — One "Workspace folder" card: custom workspace + additional volumes, permanent

## Status: Proposed (2026-08-15) — 0/5 phases, design complete.

The agent Settings tab merges the **Custom workspace folder** (toggle) and
**Additional volumes** cards into a single always-visible **"Workspace folder"**
card. The workspace switch is gone: every agent already has an effective
workspace (the default `workspace/` subfolder, or a custom bind), so the card
always shows it, pre-filled, and edits are applied together with the volumes by
one **"Apply volumes and recreate"** button. Once a custom workspace is set (at
create time or later) it is the container's **forever workspace** — it cannot be
toggled off or reset to the default; the default workspace exists only for
newly created agents.

## Goal

1. **One card, no toggle.** The Settings tab shows a single **"Workspace folder"**
   card containing: host workspace source → container workspace path →
   additional volumes. Always visible, never a switch.
2. **Apply together.** One button — **"Apply volumes and recreate"** — validates
   and applies workspace changes and volume changes in a single POST / recreate
   (both already require a recreate, so the UI stops pretending they are separate).
3. **The workspace is forever.** A workspace set at create time or via Settings
   can never be removed/reset to the default. The default workspace is only the
   starting point for a brand-new agent.
4. **Zero behavior drift for legacy agents.** Volume-only edits do not silently
   materialize the default workspace into an explicit mount (which would newly
   emit `working_dir` in the compose).

## Context: what already exists

- **Effective workspace today** (`vm-manager.js` `generateInstanceCompose`):
  the compose always binds `instances/<name>/<agent>:<driver.dataDir>`. The
  *workspace* is the `workspace/` subfolder of that data dir at the driver's
  `workspaceDir` (e.g. `/root/.openclaw/workspace`) **unless** a custom mount
  exists. A custom mount (`meta.env WORKSPACE_HOST`/`WORKSPACE_DIR`) adds its own
  bind **and** sets `working_dir`; the driver default does NOT set `working_dir`.
- **Settings card 6 "Custom workspace"** (`SettingsTab.jsx:770-840`): a toggle;
  when off the fields are hidden. Save sends `{ workspaceHost, workspaceDir }`;
  empty host+dir **removes** the mount (that removal path is what this plan deletes).
- **Settings card 5b "Additional volumes"** (`SettingsTab.jsx:678-768`): rows of
  bind/named-volume mounts, own Apply button, own POST with `{ extraVolumes }`.
- **Backend flow**: `POST /api/agents/:name/settings` → `prepareAgentChanges`
  (vm-manager.js:2556-2563 — both-or-neither workspace, full-replace volumes,
  change detection) → `applyAgentChanges` (SSE recreate job). Shared with the MCP
  `recreate` tool, so a backend guard covers both surfaces.
- **`readSettings`** (vm-manager.js:2255) returns `workspaceMount` (stored custom
  mount or `null`) + `extraVolumes`; it does not expose the *effective* default
  workspace. The frontend derives the default host from `instances/<name>/<agent>/workspace`
  (same convention as `CreateAgent.jsx:116`).
- **Capabilities**: `driver.workspaceCapability` is `fixed` (container path
  locked), `editable`, or `none` (hermes — data dir IS the workspace; the
  workspace card is hidden today). Volumes are independent of capability and are
  always shown.

## Design

### Phase 1 — Backend: effective workspace + "forever" guard (vm-manager.js)

- **`readSettings`** additionally returns the **effective workspace**, so the
  frontend never re-derives the default:
  `effectiveWorkspace: { host, container, custom }` where `host` =
  `workspaceMount?.host` or `instances/<name>/<agent>/workspace`, `container` =
  `workspaceMount?.container` or `driver.workspaceDir`, and `custom` = whether a
  stored mount exists. Keep the existing `workspaceMount` field (MCP `settings_get`
  and other consumers read it).
- **`prepareAgentChanges`** enforces the forever rule. When a mount is already
  stored (`oldMount` set) and the request clears it — both `workspaceHost` and
  `workspaceDir` empty, or the either-side-empty partial clear — throw
  `The workspace folder can't be removed once set — choose a new folder instead`
  (before the generic both-or-neither error). First-set (no stored mount) and
  create flow are unaffected; the MCP `recreate` tool goes through the same
  function, so the guard covers both.
- `applySettings`/`generateInstanceCompose`: no functional change — they receive
  already-validated values; rollback/reset paths pass the stored mount back.

### Phase 2 — Frontend: the combined card (SettingsTab.jsx)

- Merge card **5b (Additional volumes)** and **5d (Custom workspace)** into one
  card titled **"Workspace folder"**, always visible (drop the `wsHidden` wrapper
  only for the `none`-capability edge, see open question).
- **Remove the switch + `wsEnabled`.** Both workspace fields always render,
  pre-filled from the *effective* workspace:
  - Host source ← `settings.effectiveWorkspace.host` (placeholder stays the
    default path for agents with no custom mount).
  - Container path ← `settings.effectiveWorkspace.container`; still read-only for
    `fixed`-capability drivers.
  - Keep the existing per-field validation (`wsHostIssue`/`wsDirIssue`), the
    "fixed by <type>" note, and the "host file browser won't be available"
    warning (derived from the effective host).
- **Dirty tracking**: `wsDirty` (any workspace edit) alongside the existing
  `volDirty`. The single **"Apply volumes and recreate"** button (accent, bottom
  of card) is disabled when neither is dirty; an "Unsaved changes" hint shows.
- **Save handler**: one `POST /api/agents/:name/settings` sending
  `{ extraVolumes }` always, plus `{ workspaceHost, workspaceDir }` **only when
  `wsDirty`** — a volume-only apply must not materialize the default mount (which
  would newly set compose `working_dir` for a legacy agent). Confirm dialog lists
  exactly what changed (workspace paths, N volumes, or both). Workspace can never
  be sent empty — validation requires both fields whenever either is edited.
- **No removal affordance** anywhere: the toggle-off → "remove custom workspace"
  confirm path is deleted.

### Phase 3 — Docs

- `docs/tabs/settings.md`: collapse cards 6 + 7 into a single **"Workspace
  folder (card)"** section: always visible, no toggle, effective-vs-stored
  distinction, single "Apply volumes and recreate" button, and the **forever
  workspace** rule (default only for new agents; a set workspace can't be reset).
  Update the `POST /api/agents/:name/settings` row (workspace + volumes applied
  together), the `readSettings` row (gains `effectiveWorkspace` + `uptime`), and
  the Container Info card section (no status, full-width image, uptime row).
- `docs/overview/business-logic.md`: update the workspace-mount description if it
  mentions the toggle/removal.
- AGENTS.md: add the gotcha — "a workspace, once set, is permanent; there is no
  reset-to-default (Settings has no toggle; the backend rejects clearing it)".

### Phase 5 — Container Info card: drop status, widen image, add uptime

The Container Info grid (SettingsTab.jsx:549-563) gets three tweaks:

- **Remove the Status row.** `['Status', agent.status || '—']` is redundant — the
  AgentDetail header already shows the status pill (AgentDetail.jsx:57-69).
- **Widen the Image.** Pull the image out of the `grid-cols-2 sm:grid-cols-3`
  grid into its own full-width row (`break-all`) so the long
  `paddock-vm-<name>:latest` tag wraps instead of truncating in a narrow column.
- **Add Uptime.** `readSettings` (vm-manager.js:2118) gains an `uptime` field via
  one cheap `docker ps -a --format '{{.Status}}'` call (e.g. "Up 3 days" /
  "Exited (0) 2 hours ago") alongside the existing `currentVersion` docker call.
  The grid shows it as a new `Uptime` row. `docker inspect`'s
  `state.startedAt`/`finishedAt` already ride in `containerInfo`; `docker ps
  --format '{{.Status}}'` is the simplest canonical source and matches Docker's
  own wording.

### Phase 4 — Tests + E2E proof

- `src/test/vm-manager.test.js`: unit test that `prepareAgentChanges` throws when
  clearing a persisted mount (both-empty and one-side-empty); test that
  `readSettings`/`effectiveWorkspace` returns the driver default when no mount is
  stored and the stored mount when one is.
- Run the existing suites individually (`timeout 60 docker exec paddock node
  --test test/vm-manager.test.js`, etc. — never the combined suite).
- Browser E2E on http://10.69.1.164:6789 using a test agent (AGENTS.md: always
  test before delivering):
  - Settings tab shows one "Workspace folder" card, no switch, fields pre-filled.
  - Volume-only apply recreates and leaves the workspace mount untouched (no
    `working_dir` materialized — check the compose diff / `meta.env`).
  - Editing the host source → apply → `meta.env` gains `WORKSPACE_HOST`/
    `WORKSPACE_DIR`; reload shows the custom path; removing the values via API
    errors.
  - New agent create flow unchanged (default workspace applies at create).

## Files

- **Modified** `src/services/vm-manager.js` — `readSettings` gains
  `effectiveWorkspace` + `uptime`; `prepareAgentChanges` rejects clearing a
  stored mount.
- **Modified** `src/client/src/pages/agent/SettingsTab.jsx` — merged card, no
  toggle, dirty-tracking single apply (workspace + volumes); Container Info grid:
  status row removed, image widened to full width, uptime row added.
- **Modified** `src/test/vm-manager.test.js` — forever-guard + effective-workspace tests.
- **Modified** `docs/tabs/settings.md`, `docs/overview/business-logic.md`, AGENTS.md.

## Progress

- [ ] Phase 1 — backend: `effectiveWorkspace` + `uptime` + forever guard (vm-manager.js)
- [ ] Phase 2 — frontend: merged "Workspace folder" card, single apply (SettingsTab.jsx)
- [ ] Phase 3 — docs (settings.md, business-logic.md, AGENTS.md)
- [ ] Phase 4 — tests + browser E2E proof
- [ ] Phase 5 — Container Info card: drop status, widen image, add uptime

## Verification

```bash
docker restart paddock                                   # reload backend after edits
cd src/client && npm run build && docker restart paddock # JSX/CSS change
timeout 60 docker exec paddock node --test test/vm-manager.test.js   # unit guard tests
# Browser: http://10.69.1.164:6789 → agent Settings →
#   one "Workspace folder" card, no toggle, pre-filled fields,
#   volume-only apply leaves workspace untouched,
#   workspace edit persists in meta.env and survives reload,
#   API clear of WORKSPACE_HOST/WORKSPACE_DIR rejected.
# Container Info: no Status row, image wraps full-width, Uptime shown.
```

## Open questions / decisions

- **Enforcement level (recommended: backend).** The user said the workspace "can't
  be toggled off and set back to the default", so Phase 1 hard-blocks clearing in
  `prepareAgentChanges` (covers UI + MCP). Fallback if that is too strict: remove
  only the UI affordance and let the API/MCP still clear a mount.
- **When to send workspace fields (recommended: only when edited).** Sending them
  on every apply would materialize the default mount for legacy agents and newly
  set compose `working_dir` (a real startup-behavior change). Sending only on edit
  keeps volume-only applies a pure no-op for the workspace. Note: once a user
  *does* edit the workspace it becomes explicit + permanent — exactly the rule.
- **`none`-capability agents (hermes) in the merged card (recommended: keep
  workspace fields hidden, volumes always shown).** Today the workspace card is
  hidden for hermes and the volumes card is always shown. The merged card keeps
  that split: a one-line note ("this agent type's data directory IS its workspace")
  replaces the two fields; the volumes UI stays editable.
- **`fixed`-capability container path** stays read-only (unchanged behavior).
