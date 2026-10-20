# Plan 70 — Dev-container Generate fails with raw ENOENT on a read-only workspace

## Status: Complete (2026-10-19) — 5/5 phases done. Fix (a) chosen: the mirror is written through the running pad; verified live end-to-end on pad-opencode-user1 (Generate → /www2/user1/.devcontainer/devcontainer.json landed, PUID-owned, card flips to Generated; state badge + note render). Suites: plan-70 subtests green; devcontainer/global suites green; ~29 sibling withTmp suites EACCES-only for uid-1000 shells (pre-existing, environmental). Plan absorbed into docs/reference/tabs/settings.md §5f.

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

- [x] Gate `regenerateDevContainer` / `syncDevContainer`
      on the workspace actually being writable from the webui: resolve
      `containerViewOf(wsMount.host)` (null = host-only). Shipped as fix (a)
      rather than a refusal: with the pad route available, the standing refusal
      is only for a stopped pad (`pad_not_running`). Both functions are async.
- [x] Surface the refusal cleanly: `POST …/devcontainer/regenerate` and `…/sync`
      map typed errors to a 400 with the actionable message; an untyped error
      stays a 500.
- [x] Decide the real fix for host-only workspaces (do NOT do both silently):
      **(a) chosen** — `writeWorkspaceFileThroughPad(name, wsMount, rel, content)`
      in vm-manager (own spawn + stdin `docker exec -i`; no orchestrator dep,
      no circular import; `termUserArgs` drop; sec chown for root-mode pads),
      target = `wsMount.container` path; content on stdin, never quoted into
      the script. (b) intentionally NOT shipped — disabling Generate would
      strand real work.
- [x] `devContainerStatus` reports the writability so the card can
      disable the buttons with explanation instead of offering an action that 500s.
      Shipped: `writableVia: 'webui'|'pad'`, `writable`, `writeNote`; the card
      renders the note as text and titles the disabled button; `devcontainer.syncFile`
      gained `{ write: false }` so a host-only sync composes without a local write.
- [x] Update the AGENTS.md "Dev container sync/regenerate" gotcha: ro ≠ only EROFS
      (this case is ENOENT), and host-only (`containerViewOf → null`) workspaces are
      in the same boat. Replaced by the plan-70 gotcha + the `/var/padtest-*` EACCES note.

## 4. Verify

- [x] Unit: vm-manager.test.js — 4 new subtests: status `writableVia` pads/webui,
      Generate via pad (script shape + stdin content + file on host), sync through pad
      (adoption gate, content composed, file matches stdin), default runner typing a
      missing container (`pad_not_running`) against REAL docker; converted the 7 sibling
      tests to await (withTmpA). Suite green locally; ~29 sibling failures are
      EACCES-only (`/var/padtest-*` needs root).
- [x] Live: clicked Generate in the SPA on `pad-opencode-user1` → confirm dialog →
      `/www2/user1/.devcontainer/devcontainer.json` appeared, PUID-owned (node:node),
      `x-paddock.generated` + the pad's postStart/remoteUser present, no 500; card
      flipped to Generated with Sync enabled afterwards.
- [x] Regression: Generate still works on a webui-visible workspace (the old tests run
      through `withTmpA` now and stay green); related suites (`workspace-guards`,
      `pad-tmux`, `container-health`+`orchestrator`, `workspace`) green.

## 5. Out of scope

- Changing what the mirror contains (plan 41 items 18–20 semantics stay as-is).
- Container recreate behaviour — Generate never recreates by design (user confirmed).
