# Plan 70 — Dev-container Generate fails with raw ENOENT on a read-only workspace

## Status: Proposed (2026-09-29) — 0/5 items done, design only, nothing built.

## 1. Request (user verbatim intent, 2026-09-29)

> add new bug in plans
> Generate dev container
> Creates /www2/user1/.devcontainer/devcontainer.json as a mirror of pad-opencode-user1's current settings. The container is not recreated.
> when i generate -> ENOENT: no such file or directory, mkdir '/www2/user1/.devcontainer'

So: the Settings → Dev Container card's **Generate/Regenerate** for
`pad-opencode-user1` (workspace `/www2/user1`) 500s with a raw
`ENOENT: mkdir '/www2/user1/.devcontainer'` instead of producing the mirror.

## 2. Root cause (verified live 2026-09-29, not guessed)

- `instances/pad-opencode-user1/meta.env`: `WORKSPACE_HOST=/www2/user1`,
  `WORKSPACE_DIR=/www2/user1`. `HOST_WORKSPACE_ROOT=/www2/paddock` (`.env`),
  so `containerViewOf('/www2/user1')` (`src/services/vm-manager.js:292`) returns
  **null** — a host-only path the webui cannot resolve to its own `/workspace` view.
- `regenerateDevContainer` (`vm-manager.js:1153`) falls back to the raw host path
  (`containerViewOf(...) || path.normalize(wsMount.host)`) and calls
  `writeGeneratedDevContainer` (`devcontainer.js:203`), which does
  `fs.mkdirSync(target, { recursive: true })` **through the webui container's FS**.
- Inside the `paddock` container `/www2` is mounted **read-only**
  (`/dev/sda1 on /www2 type ext4 (ro,relatime)` — verified via `docker exec paddock mount`),
  so the mkdir fails. Reproduced exactly in-container:
  `docker exec paddock node -e "fs.mkdirSync('/www2/user1/.devcontainer',{recursive:true})"`
  → `ENOENT: ENOENT: no such file or directory, mkdir '/www2/user1/.devcontainer'`
  (the ro mount surfaces as ENOENT here, not EROFS).
- The raw error propagates: `POST /api/agents/:name/devcontainer/regenerate`
  (`app.js:1029`) catches and returns `500 { error: e.message }` — a kernel
  string with no hint that the workspace is not writable from the webui.
- Same shape as the known AGENTS.md limitation ("Dev container sync/regenerate
  write into the workspace THROUGH the webui container … Workspaces mounted
  read-only into paddock fail with EROFS") — but that note names EROFS and the
  `/www1 → craftpip` case; this is the same trap surfacing as **ENOENT** on a
  host-only (`containerViewOf → null`) workspace, with no graceful refusal.

## 3. Build

- [ ] Gate `regenerateDevContainer` / `syncDevContainer` (`vm-manager.js:1045/1080/1153`)
      on the workspace actually being writable from the webui: resolve
      `containerViewOf(wsMount.host)` (null = host-only) and attempt the write only
      when a writable view exists; otherwise return a typed refusal
      (e.g. `workspace_not_writable_from_webui`) instead of letting mkdir throw.
- [ ] Surface the refusal cleanly: `POST …/devcontainer/regenerate` and `…/sync`
      (`app.js:1010/1029`) map it to a 400 with an actionable message
      ("workspace /www2/user1 is not writable from the webui — …"), never a 500 ENOENT.
- [ ] Decide the real fix for host-only workspaces (do NOT do both silently):
      (a) write the mirror **through the PAD container** (`docker exec <pad> mkdir …`),
      which holds the workspace mount read-write — preferred, keeps Generate working
      everywhere; or (b) disable Sync/Regenerate in the Dev Container card with the
      reason shown when `devContainerStatus` knows the workspace is not webui-writable.
      `validateWorkspaceMount` already computes `webuiVisible`/`hostBrowsable` — reuse it.
- [ ] `devContainerStatus` (`vm-manager.js:1116`) reports the writability so the card can
      disable the buttons with explanation instead of offering an action that 500s.
- [ ] Update the AGENTS.md "Dev container sync/regenerate" gotcha: ro ≠ only EROFS
      (this case is ENOENT), and host-only (`containerViewOf → null`) workspaces are
      in the same boat.

## 4. Verify

- [ ] Unit: `regenerateDevContainer` on a host-only / read-only workspace returns the
      refusal (no throw); webui-writable workspace still writes the mirror.
- [ ] Live: click Generate on `pad-opencode-user1` → either the mirror appears at
      `/www2/user1/.devcontainer/devcontainer.json` (fix path a) or the card refuses
      with the actionable message and disabled buttons (fix path b) — no 500 ENOENT.
- [ ] Regression: Generate on a project-root workspace pad still creates the mirror;
      existing `vm-manager - devcontainer plan` suite green
      (`timeout 60 docker exec paddock node --test test/vm-manager.test.js`).

## 5. Out of scope

- Changing what the mirror contains (plan 41 items 18–20 semantics stay as-is).
- Container recreate behaviour — Generate never recreates by design (user confirmed).
