# Sub-goal 34b — OpenClaw Web Console (Control UI + WebChat, 18789)

## Status: Complete (2026-08-10) — 4/4 items done and live-verified on
pad-openclaw-work-pls: publish → Control UI over plain HTTP (token-only gate,
no device-identity block) → unpublish restores the exact pre-publish
`bind`/`auth`/`controlUi`. The device-pairing question from acceptance is
resolved: the Control UI cannot obtain a device identity over plain HTTP, so
Paddock sets `gateway.controlUi.dangerouslyDisableDeviceAuth: true` while
published and restores the prior value on unpublish. Post-completion polish:
**tokenized open-link** (Open button / card link append `#token=…` so the
console auto-authenticates) — built, root-caused a silent token-vanish, and
re-verified live; see "Tokenized open-link" below.

Progress checklist:

- [x] `webApp` descriptor in `src/services/drivers/openclaw.js`
- [x] Boot-hook config patch (`gateway.bind: lan` + `gateway.auth` + `gateway.controlUi.dangerouslyDisableDeviceAuth`) above the gateway line
- [x] `applyWebAuth`/`removeWebAuth` idempotency (from 34a) honored
- [x] Rebuild image + live verify (incl. real-browser **device-pairing** check) — resolved via `dangerouslyDisableDeviceAuth`

Parent: `plans/34-web-publish-all-drivers.md`. Depends on 34a (shared
mechanism + openclaw config patch). Research details in parent §"openclaw —
pad-openclaw-work-pls".

## Scope

`src/services/drivers/openclaw.js` — add `webApp`:

- `label: 'Gateway Dashboard + WebChat'`
- `containerPort: 18789`, **`containerPortEditable: false`** (gateway bind is
  fixed; symbolic `lan`, not an IP)
- `auth: { target: 'openclaw.json', patch: { token/password under
  gateway.auth } }`
- `startCommand`: no-op/verify — the gateway already runs; the boot hook only
  patches config.

`start.sh` boot-hook block placement — **ABOVE** the `openclaw gateway run`
line (openclaw start.sh:16): the hook patches `openclaw.json` BEFORE the
gateway binds, because bind changes need a full gateway restart (in-process
SIGUSR1 restart keeps old sockets — only a fresh process applies `lan`).

Config patch semantics:

- `gateway.bind: "lan"` (never `"0.0.0.0"` — rejected with
  `gateway.bind: Invalid input`).
- Ensure `gateway.auth` has a token/password; **fails closed**: with `bind: lan`
  and no auth the gateway does not listen at all (`Refusing to bind gateway to
  lan without auth.`).
- Idempotent: preserve an existing `gateway.auth.token`; only overwrite when a
  new password is published (via `applyWebAuth` from 34a).

## Acceptance

- `GET /api/agents/:name/web` returns the descriptor (not `webApp: null`).
- Publish → gateway listens on 0.0.0.0:18789, Control UI 200, auth gate 401
  without token.
- Recreate survives; unpublish restores backup config.
- **Real-browser test: DONE (2026-08-10).** The Control UI failed the WS
  handshake over plain HTTP with `control-ui-insecure-auth` (the gateway
  refuses to handshake from an insecure context unless device identity is
  disabled). The fix (also shipped in `applyWebAuth`/`removeWebAuth`): set
  `gateway.controlUi.dangerouslyDisableDeviceAuth: true` while published and
  restore the pre-publish `controlUi` on unpublish. `allowInsecureAuth` alone
  does NOT suffice. Live-verified on pad-openclaw-work-pls — token-only gate
  loads the dashboard end-to-end.

## Implementation notes (2026-08-10)

- Config patch is done host-side by `applyWebAuth` BEFORE the recreate (native
  write, or `patchOpenclawConfigViaHelper` root helper for EACCES) — the
  container restart is what applies `bind: lan` (a fresh process). The
  `start-web.sh` boot hook (openclaw/start.sh:16-21, above `gateway run`) runs
  only the verify/no-op `startCommand`.
- State file `web-openclaw.json` shape extended from `{ bind, auth }` to
  `{ bind, auth, controlUi }` (both the native path and the helper script).
- **Re-publish clobber fix (2026-08-10):** `applyWebAuth` only persists the
  pre-publish state when the state file does not exist yet (first publish).
  Re-publishing an already-published pad used to overwrite the saved original
  with the current published form, so unpublish restored `lan`+controlUi
  instead of `loopback`. Same guard added to the root-helper script. Reproduced
  live on pad-openclaw-work-pls (bad restore) and re-verified end-to-end.
- **Empty-token reuse fix (2026-08-10):** `oldWebPassword` is now always
  `readWebAuth(driver, name)` — previously a fresh publish (no existing web
  binding) threw "A gateway token is required" even when openclaw.json already
  had a token. Env-target drivers still return '' when unpublished, so the
  behavior for them is unchanged.
## Tokenized open-link (2026-08-10, post-completion polish)

**Problem:** opening the published console in a fresh browser showed the login
gate (`unauthorized: gateway token missing`) because the Control UI/WebChat
authenticates over a WebSocket handshake and the browser had never been given
the gateway token. Paddock linked the bare URL, so every first visit (or a
cleared-browser-storage visit) hit the gate.

**Solution:** append the gateway token as a URL fragment so the console
auto-authenticates. OpenClaw documents `#token=<gateway-token>` — the Control
UI hydrates auth from the fragment, stores it, and strips it from the URL.
Fragments are never sent to the gateway server. This is token-only auth over
plain HTTP (matches the `dangerouslyDisableDeviceAuth` publish mode).

**Data flow (who sends the token to the frontend):**

- `webApp.auth.urlToken: true` marks a driver whose console accepts the
  tokenized fragment (added to `src/services/drivers/openclaw.js`). Other
  drivers (opencode basic-auth etc.) are NOT flagged, so they never leak a
  fragment token.
- `GET /api/agents/:name/web` (`src/app.js`) now returns `authToken` (the
  published gateway token) when active + `urlToken`. `vm-manager.js`
  `getWebStatus` carries the same field.
- The agents list (`src/services/agent-registry.js`) now puts `token` on each
  agent's `web` object, so AgentCard and the AgentDetail header link can use it.
- `src/client/src/lib/web.js`: `webUrlForPort(hostPort, token)` appends
  `#token=<enc>` when a token is given; `webUrlForAgent(agent)` passes
  `agent.web.token`.
- `src/client/src/pages/agent/WebTab.jsx`: the Web tab "Open" button builds its
  URL with `data.authToken`.

**The silent token-vanish root cause (why it "worked" then stopped):**
`readWebAuth` originally re-read the token from `openclaw.json`. But the agent
container rewrites `openclaw.json` **as root** on its own activity, and the
webui runs as uid 1000 — so the read hit `EACCES` and returned `''`, dropping
the fragment from the URL again. Fixed by persisting the token at publish time
in `web.json` (webui-owned): `applyAgentChanges` writes
`{ containerPort, hostPort, authToken }`, `readWebAuth` prefers
`web.json.authToken` and falls back to the config file. Backfilled the live
pad's `web.json` from the root-owned config on the host (host is root).
`applyWebServices` (dead legacy path) got the same write shape for consistency.

**Verification (live, 2026-08-10):**
- `GET /api/agents/pad-openclaw-work-pls/web` → `authToken` populated
  (`fecwfwfxwfwfxwfw`), `passwordConfigured: true`; list API `web.token` matches.
- Web tab shows `http://10.69.1.164:18789#token=fecwfwfxwfwfxwfw`; the "Open
  Gateway Dashboard + WebChat" button carries the same href.
- Fresh browser (no stored token) on that URL → dashboard loads directly into
  Chat, no login gate (`openclaw-login-gate` absent, WS connected).

## Future work: user-owned instance data (root-owned is not acceptable long-term)

The webui runs as uid 1000 but **the agent containers run as root**, so
instance data (notably `openclaw.json`, rewritten on every agent activity) is
root-owned and the webui gets `EACCES` reading/writing it. Current mitigations:
the root helper container for publish/unpublish/delete, and the `web.json`
token persistence added here. **User decision (2026-08-10): root-owned data is
not acceptable** — the plan is to make instance data **user-owned** (run agent
containers as a non-root user and write everything as that user). This is a
large, cross-cutting change: every per-type `src/vm-builds/<type>/Dockerfile`
+ `start.sh` (user accounts, `HOME`, permissions, `chown` logic in start
scripts), the compose `user:`/`group_add` wiring, the root-helper paths
(they exist because of root ownership and should become unnecessary), and any
tooling that assumes container-root (e.g. `openclaw` CLI writing config under
`/root/.openclaw`). Tracked here so the eventual work picks up from these
notes instead of re-deriving the root cause.

## Files

- **Modified** `src/services/drivers/openclaw.js` — `webApp` descriptor; added
  `auth.urlToken: true`
- **Modified** `src/vm-builds/openclaw/start.sh` — hook block above gateway line
- **Modified** `src/services/app.js` — `/api/agents/:name/web` returns `authToken`
- **Modified** `src/services/agent-registry.js` — list `web.token`
- **Modified** `src/services/vm-manager.js` — publish writes `authToken` into
  `web.json`; `readWebAuth` prefers it; `getWebStatus`/`applyWebServices`
  carry it
- **Modified** `src/client/src/lib/web.js` — tokenized fragment in
  `webUrlForPort`/`webUrlForAgent`
- **Modified** `src/client/src/pages/agent/WebTab.jsx` — Open button uses `authToken`
- **Data** `instances/pad-openclaw-work-pls/web.json` — backfilled `authToken`
  (`fecwfwfxwfwfxwfw`)
