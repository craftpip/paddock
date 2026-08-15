# PAD Friends Project — PAD Learnings

## How to Use This File

This file holds only **instant-need rules** — behavior, workflow, gotchas, and
facts the agent must have without reading anything else. Everything about how
the code/system works lives in `docs/` (the source of truth for business
logic). Keep entries concise and actionable; append under the right section.

When the user says "remember"/"learn" or you solve a problem, route the
learning:

1. **Code — the code and why it exists** (logic, purpose, routes, data model,
   behavioral contracts) → `docs/`. Read `docs/README.md` first, then
   `docs/STYLE-GUIDE.md` before writing.
2. **Agent behavior / workflow / gotchas / preferences** → here in AGENTS.md.

Rule of thumb: **code logic → `docs/`; agent behavior and operational workflow → AGENTS.md.**

## Project Map

- **`docker-compose.yml`** defines the `webui` service (container `paddock`,
  image `paddock-webui:latest`) — the **control plane**: Node.js/Express on
  port 6789 managing all PADs via `/var/run/docker.sock`.
- **`src/`** — webui source, bind-mounted to `/app` (backend edits need no
  rebuild). Express `app.js` + `services/`; **`src/services/drivers/`** = one
  module per agent type (openclaw, opencode, picoclaw, hermes, codex).
- **`src/vm-builds/<type>/`** — per-type Dockerfile + start.sh; images tag
  `paddock-vm-<type>:latest`.
- **`src/client/`** — React 19 + Vite SPA. Built output → `src/public/`
  (served at root `/`; API under `/api/*`, WebSocket at `/ws/terminal/*`).
  Old EJS routes/`routes/agents.js` are dead code.
- **`instances/<pad>/`** — per-PAD dir: `<agent>/` bind-mounted data dir,
  `docker-compose.yml`, **`meta.env`** (critical state), `logs/`.
- **`backups/`**, **`plans/`** — archives and idea files.

## Golden Rules

- **Never touch containers outside this project.** Containers not created by
  our own code are not ours — no start/stop/exec/inspect.
- **Never create random containers for testing.** Test only through project
  tools (web UI, compose services). `docker run` with external images is out
  of scope.
- **Never use a `vm-` prefix.** PAD naming comes from `CONTAINER_PREFIX` in
  `.env` (e.g. `pad-`). Refer to PADs by their actual name only.
- **Never use the question tool mid-conversation** — ask in text; the tool is
  only for fallback / complex multi-option when justified.
- **Always test before delivering.** Never hand code to the user untested:
  restart the service, open the browser, and verify the affected page yourself
  (http://10.69.1.164:6789). Browser MCP tools are available. "Works on my
  end" is not acceptable — prove it live; no "fix it later".
- **Always consult the online OpenClaw docs** (https://docs.openclaw.ai) before
  any `openclaw` CLI/config work — they change frequently; never trust cached
  knowledge.
- **CommandsPane action buttons paste `openclaw ...` commands into the docked
  terminal** (`run(cmd)`) — never a backend action API. Read-only GETs are
  fine. The Vault is the exception on purpose (server-side secrets).
- **Run tests individually, never the combined `node --test test/` suite**
  (hangs). `timeout 60 docker exec paddock node --test test/<file>.test.js`.
  `vm-manager.test.js` needs the `GUARD_*` envs unset (see docs).

## Critical Operational Gotchas

- **`openclaw models auth paste-api-key` destroys the whole `openclaw.json`**
  (rewrites it with auth info only). Save the config first and merge it back
  after. It reads the key from stdin — use `spawn`, not `execFile` (hangs).
- **Published openclaw refuses Control UI over plain HTTP unless device
  identity is skipped.** The WS handshake fails with
  `cause: control-ui-insecure-auth`; `gateway.controlUi.allowInsecureAuth`
  alone does NOT fix it. `applyWebAuth` therefore sets
  `gateway.controlUi.dangerouslyDisableDeviceAuth: true` on publish (token-only
  auth) and `removeWebAuth` restores the pre-publish `controlUi` (state file
  `web-openclaw.json` saves `{ bind, auth, controlUi }`). The state file is
  written only on the FIRST publish; re-publishing an already-published pad
  keeps the original saved state (overwriting it made unpublish restore the
  published form).
- **`instances/*/meta.env` is critical** — without it PAD discovery returns 0
  PADs and detail pages show "Agent not found". `setMetaFlag(name, key, '')`
  REMOVES the line instead of writing `KEY=`.
- **The webui runs as root (plan 43) — that's intentional, not a bug.** Root is
  how it controls the host FS + docker socket. `removeInstanceDir` is a plain
  `fs.rmSync` (no root-helper container, no EACCES paths); agent configs are
  read/written directly. Everything the webui creates is `chown`ed back to
  `PUID:PGID` via `ownership.ensureOwned` after each create. A boot sweep
  (`normalizeTree` over `src/data/` + `instances/`) re-heals root-owned agent
  data, EXCEPT hermes data dirs (`isSelfManagedAgentData` skips them — hermes
  re-chowns `/opt/data` to uid 10000 every boot). Verify user files are
  `PUID`-owned after any create/rebuild; agent containers still write root
  files mid-run by design.
- **Per-PAD "Container user" (plan 43 Phase 7, meta `USER_MODE=user`) drops
  the agent daemon + terminal to the `pad` user (PUID:PGID=1000:1000), not the
  whole container** — the image still boots as root (chpasswd/sshd/start-web
  hooks), then `start.sh` re-`chown -R 1000:1000` the data dir and `setpriv`s
  the keeper; SSH stays the root admin door. Compose emits the `USER_MODE`
  env, never a `user:` line. **tmux is user-scoped**: a user-mode pad's session
  socket lives at `/tmp/tmux-1000` and its tmux setup/attach/exec MUST all run
  as the pad user (`termUserArgs` adds `-u 1000:1000 -e HOME=/root`), or the
  attach misses the session. `HOME=/root` is kept on purpose (agent CLIs
  resolve config via `$HOME`); hooks stay root-written `/root` config files.
  Existing pads toggled to user mode rebuild: `ensureUserModeBuildFiles`
  regenerates `start.sh` from the template (machine-managed) and surgically
  injects the pad-user block into the user-editable Dockerfile. hermes is
  always root-mode (already runs as its own user).
  **Passwordless sudo in user-mode images MUST use `ALL ALL=(ALL) NOPASSWD:ALL`,
  not `pad ALL=(ALL) NOPASSWD:ALL`.** The `pad` account at uid 1000 collides
  with base-image users (e.g. `node` in node:20-slim) that appear EARLIER in
  `/etc/passwd`; the terminal drops via `setpriv --reuid 1000` and `sudo`
  resolves the invoker by uid to that earlier name, so a `pad`-keyed rule
  demands a password. The rule + a `sudo` self-install guard (`if ! command -v
  sudo; then apt-get install sudo / apk add sudo; fi`) live in 3 places —
  `PAD_USER_DOCKERFILE_BLOCK` in vm-manager.js (injected into toggled pads),
  every `src/vm-builds/*/Dockerfile`, and each instance's own `build/Dockerfile`
  (regenerated by `ensureUserModeBuildFiles`, which REPLACES stale blocks on
  re-toggle — the block is machine-managed, user edits land elsewhere). The
  self-install matters because toggled pads build from their ORIGINAL Dockerfile
  copy (pre-sudo package list) — without it the sudoers drop-in silently does
  nothing. Debian images also still list `sudo` explicitly in the package list.
- **Per-PAD image builds orphan disk.** Every create/rebuild retags
  `paddock-vm-<name>:latest` and orphans the old build as a dangling image;
  delete removes the tag and `pruneDanglingImages` (`docker image prune -f`,
  dangling only) runs after create/rebuild/delete to reclaim it. A dangling
  image that survives the prune is in use by a container (possibly another
  project) — don't force-remove it.
- **Restart the webui after editing backend code** (`app.js`, `vm-manager.js`,
  any `services/drivers/*.js`) — Node caches `require()`; a stale process
  keeps old behavior or builds the wrong image via the openclaw-driver
  fallback. `docker restart paddock`.
- **JSX/CSS edits need `cd src/client && npm run build` + `docker restart
  paddock`** — the SPA serves the built bundle from `src/public/`.
- **Docker Compose CLI lives inside the paddock container** — the host docker
  CLI has no compose plugin. Invoke `docker compose` from the container.
- **Instance compose uses absolute host paths** (`HOST_WORKSPACE_ROOT` from
  `.env`) — fixes the bind-mount split-brain; relative paths make the daemon
  mount host-root `/workspace/...` dirs.
- **Peer-mode agents publish via the `<name>-door` socat container**, never on
  their own container. Peer-shared agents need **unique container ports**
  (8080/8081/…); `hostPortInUse` does NOT exclude the agent's own door (use a
  fresh host port). Deleting an agent removes its door + network automatically.
- **`GUARD_*` workspace-mount guards** (vm-manager.js) are on by default. To
  let one agent mount the whole project root as workspace, disable
  `GUARD_PROJECT_ROOT`, `GUARD_INSTANCES_PARENT`, `GUARD_AGENT_DATA` in `.env`
  (that agent then has read/write over the whole project incl. `.env`).
- **Job logs are in-memory** — `docker restart paddock` kills running
  update/create jobs and their SSE streams.
- **Test PADs:** `test-agents` for general testing.
- **`src/data/app.db*` stays `1000:1000`-owned via the boot sweep, not luck.**
  The webui now runs as root, so a fresh `app.db`/`-wal`/`-shm` created by it
  is root-owned until `ownership.ensureDbOwned()` re-chowns it after open (and
  the boot `ensureDataOwned()` covers the whole `src/data/`). If DB writes ever
  fail with `attempt to write a readonly database`, fix with
  `chown 1000:1000 src/data/app.db*`. Never run `docker exec paddock node …`
  (runs as root) against code paths that open the DB, or it may recreate
  root-owned DB files.

## Workflow Commands

- Restart webui (no rebuild): `docker restart paddock`
- Rebuild + recreate webui after an image change:
  `docker compose build webui && docker compose up -d --no-deps --force-recreate webui`
- Vite dev server (HMR, port 5173) for frontend work:
  `docker exec -d paddock sh -c 'cd /app/client && npm run dev'` → access
  http://10.69.1.164:5173; stop:
  `docker exec paddock sh -c "kill \$(lsof -ti:5173)"`
- SPA build: `cd src/client && npm run build` (output → `src/public/`)
- Webui recreate gotcha: the host docker CLI has no compose plugin — recreate
  with host-absolute paths (see `docs/operations/overview.md`).

## Environment Facts

- This host: we are **root** (no sudo, no python3). Use the `edit` tool or
  `node -e` for root-owned files — the edit tool works as root.
- Webui reachability: http://10.69.1.164:6789 (localhost:6789 is refused from
  this shell's network context). Vite dev on http://10.69.1.164:5173.
- Auto-login defaults on (`AUTO_LOGIN=true`). API curl tests need a session
  first — auto-login boots on `GET /api/session` (fetch into a cookie jar).

## Driver Framework

- `src/services/drivers/` — one module per agent type, registered in
  `index.js`. `getDriver(type)` is the single source of truth (image, version,
  `configFile`, `dataDir`, `workspaceDir`, commands); **falls back to the
  openclaw driver** (never crashes).
- Config formats: openclaw/picoclaw/opencode `json`, hermes `yaml`, codex
  `toml`. Non-`json` formats are served/written verbatim, no secret redaction.

## Documentation (docs/)

- `docs/` is the **source of truth** for business logic, architecture, routes,
  data model, security. AGENTS.md holds only behavioral/ops rules.
- Read order: `docs/README.md` (index), then the relevant page. Read
  `docs/STYLE-GUIDE.md` before writing/editing any doc.
- Main pages: `overview/architecture` · `overview/business-logic` ·
  `backend/services` · `tabs/{terminal,web,settings,health,mcp,skills}` ·
  `operations/{overview,openclaw}`.
- Rule: if code and docs disagree, fix the code.

## User Preferences

- **How the user gives tasks — queue everything.** The user brain-dumps tasks
  ("I will just bombard you with whatever I say") and **can't hold a list in
  their head** — they'll drop a new task mid-task, then come back with hints
  or steering. Whenever the user gives a new task while one is already going
  on, **add it to the todo list immediately** (verbatim intent, not the full
  wording) and finish it later — do not treat it as a context switch. Keep the
  todo list updated one by one as items complete. The user may repeat or
  clarify an item later — that's a steer, not a new task.
- Plans go in `plans/` as separate `.md` files.
- **Plan workflow (always):** the user says "create a plan" → a new `.md` plan
  file goes in `plans/`. Then we start working on it. Then, only after the plan
  is **complete** (all work built + verified), we **absorb it into `docs/`**
  and **remove the plan file**. A plan never just vanishes — absorb into docs
  first, then delete.
- **Every plan file carries a standardized `## Status:` header** — placed
  directly under the `#` title. States are exactly one of:
  `Complete` / `In progress` / `Proposed` (not started) / `Blocked` (incl.
  dropped) / `Draft` (raw requirements only). The header is dated and states
  **exactly how much is complete** (e.g. "11/12 items done, remaining: …",
  "Phases 1–3 done, Phase 4 deferred", "0/4 phases, design complete"). No plan
  file exists without one. Keep a `[x]` progress checklist in the file body
  for granular tracking.
- **Always update the plan file before leaving its work.** Whenever a plan is
  worked on — a feature built, a phase finished, a finding made, or the session
  ends — update its `## Status:` header and progress checklist to match exactly
  what was done. Never leave a plan file stale.
- **When the user says "show me my plans" (or similar)**: summarize with a
  status column per file (from each file's `## Status:` header) and what's
  complete vs. not — don't just dump filenames.
