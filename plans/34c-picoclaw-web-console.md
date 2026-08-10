# Sub-goal 34c — Picoclaw Web Console (Launcher Dashboard, 18800)

## Status: Complete (2026-08-10) — 4/4 items done and live-verified end-to-end on
pad-picoclaw-asdsa: publish from the Web tab → image rebuilt with the backfilled
hook → launcher dashboard live at host port 18800 → `/launcher-login` gate →
token login (`picotest-token-9x`) unlocks the Chat dashboard. Chat-plumbing
decision: **no boot-hook change needed** — the test PAD's gateway already runs
with `Channels enabled: [pico]`, and the launcher proxies chat to `/pico/ws`
internally. The container the job left was stopped (step 9 restores the prior
stopped state — the PAD was stopped before publish); it was started manually
for the live test.

Progress checklist:

- [x] `webApp` descriptor in `src/services/drivers/picoclaw.js`
- [x] `startCommand` backgrounds the launcher (idempotent port-probe)
- [x] `start.sh` hook block at `/root/.picoclaw`
- [x] Rebuild image + live verify (decide whether the boot hook also enables `channels.pico`) — decided: not needed

Parent: `plans/34-web-publish-all-drivers.md`. Depends on 34a. Research
details in parent §"picoclaw — pad-picoclaw-asdsa".

## Scope

Key correction (locked in parent): the picoclaw web console is the **launcher
dashboard** (`picoclaw-launcher`, separate process, port 18800), NOT the
gateway. The gateway (18790, `picoclaw gateway -E`) only serves the pico chat
WebSocket at `/pico/ws` — root `/` returns 404, no console HTML.

`src/services/drivers/picoclaw.js` — add `webApp`:

- `label: 'Web Console'`
- `containerPort: 18800`, **`containerPortEditable: true`** (launcher takes `-port`)
- `auth: { target: 'env', envKey: 'PICOCLAW_LAUNCHER_TOKEN' }` (dashboard token
  is random per run unless pinned via this env; verified via
  `/api/auth/status` → `token_help.env_var_name`)
- `startCommand({password, containerPort})`:
  `PICOCLAW_LAUNCHER_TOKEN='...' picoclaw-launcher -console -no-browser
  -public -port <cport>` — the launcher is a background process like opencode's
  web server, so `start-web.sh` backgrounds it with an idempotent port-probe.

`start.sh` hook block — at `/root/.picoclaw`, before the keep-alive line
(launcher coexists fine with the gateway started by start.sh; it attaches and
reports its own gatekeeping).

Optional chat plumbing: the dashboard proxies chat to the gateway's `/pico/ws`,
which needs `channels.pico.enabled: true` + token. Decide during implementation
whether the boot hook also enables it (chat works without further config if pico
is already enabled, as on the test PAD).

## Acceptance

- `GET /api/agents/:name/web` returns the descriptor.
- Publish → launcher dashboard 200 at the host port, `/launcher-login` gate,
  `/api/*` 401 without cookie.
- Recreate survives (hook re-launches the launcher); unpublish cleans up.

## Verification (live, 2026-08-10, pad-picoclaw-asdsa)

- `GET /api/agents/pad-picoclaw-asdsa/web` → `webApp` descriptor + `active:
  true`, `webService {containerPort: 18800, hostPort: "18800"}`, hook written
  to `instances/pad-picoclaw-asdsa/picoclaw/start-web.sh` with
  `PICOCLAW_LAUNCHER_TOKEN='picotest-token-9x' picoclaw-launcher -console
  -no-browser -public -port 18800` embedded.
- Publish triggered `ensureWebStartBlock` backfill (instance build/start.sh got
  the hook block before the `picoclaw gateway -E` line) → image rebuilt →
  container recreated. The job stopped the container afterwards — step 9 of
  `applyAgentChanges` restores the prior stopped state (the PAD was stopped
  before publishing). Not a regression.
- Manual `docker start` → launcher banner: "Dashboard token:
  picotest-token-9x (from PICOCLAW_LAUNCHER_TOKEN)"; gateway up on
  0.0.0.0:18790 with `Channels enabled: [pico]`.
- API probe: `/` → 302 → `/launcher-login`; `POST /api/auth/login {token}` →
  200 + cookie; `/api/auth/status` → `{"authenticated":true}`; unauthenticated
  `/api/auth/status` → 401.
- Browser: fresh context on `http://10.69.1.164:18800` → PicoClaw login SPA
  (`input#launcher-token`, "Continue to Dashboard"); after login → Chat
  dashboard ("No Model Configured — you need to configure at least one AI model
  before you can start chatting", expected on this PAD). URL stays
  `http://10.69.1.164:18800/`.

## Implementation notes (2026-08-10)

- `containerPortEditable: true` on the picoclaw descriptor is metadata for now —
  the Web tab already renders the container-port input editable for every
  driver (per-driver editability gating is 34e scope).
- **`readWebAuth` envKey bug fixed (2026-08-10):** the env branch was hardcoded
  to `OPENCODE_SERVER_PASSWORD`, so the picoclaw hook's
  `PICOCLAW_LAUNCHER_TOKEN` never matched → the Web tab showed "· no auth" even
  though the token login worked. Now builds the regex from `auth.envKey`
  (falls back to the opencode key). `passwordConfigured` went false → true,
  UI shows "password protected". This completes 34a item 1 (readWebAuth
  generalization); the same bug would have hit hermes (its own env key).

## Files

- **Modified** `src/services/drivers/picoclaw.js` — `webApp` + launcher startCommand
- **Modified** `src/vm-builds/picoclaw/start.sh` — hook block at `/root/.picoclaw`
