# Web Console Re-layout — Persist Web-Tab Settings (plan 39)

## Status: Proposed (2026-08-10) — 0/5 items, no implementation yet. Design
drafted from the current live-state-only behavior of `WebTab.jsx` +
`vm-manager.js`. Requirement from the user: every setting entered in the Web
tab (OpenSSH expose: host port / container port / password; web console
publish: host port / password) must **survive a toggle off→on** — the form
comes back pre-filled. The **password is persisted but always redacted** in
API responses (never echoed back to the UI; an empty field keeps the saved
password). The **Additional ports** block must reuse the Create-agent page's
table-style port UI (`/agents/create`) instead of its own custom row layout.

Progress checklist:

- [ ] Backend: persist "last used" drafts (web host/container port, ssh host
      port) in `meta.env`; written on every web/ssh apply; never cleared by a
      toggle-off; passwords already persist and stay redacted
- [ ] Backend: `GET /api/agents/:name/web` (and `readSettings`) return the
      drafts as `draft: { webHostPort, webContainerPort, sshHostPort,
      sshContainerPort }`; empty web password = keep current (all drivers)
- [ ] Frontend: `WebTab.jsx` pre-fills host/container ports from drafts on
      refresh; password fields stay empty with "keeps current" semantics
- [ ] Frontend: re-layout the WebTab "Additional ports" block to the
      CreateAgent table UI (sunken header row + host/container inputs + ✕,
      "+ Add port") — parity with `pages/CreateAgent.jsx:731-785`
- [ ] SPA build + live verify on a test PAD (toggle on→apply→off→on: ports
      retained, password still effective though not shown)

## Goal / user flow

1. Toggle **Expose OpenSSH** on → enter host port, container port, password →
   **Apply SSH & recreate** → values are saved.
2. Toggle it **off** → host port, container port, and password are **retained**
   (not wiped).
3. Toggle it **on again later** → the form is already filled with the saved
   values; either publish as-is or edit the host port first.
4. Same for the **web console / gateway dashboard** publish block: the last
   used host port is restored after an unpublish → re-publish.
5. **Password rule (explicit user requirement):** it is persisted, but the API
   **redacts** it — the UI never displays it. Re-enabling without typing a new
   one keeps the previously saved password.
6. **Port setup UI parity:** the Web tab's **Additional ports** block uses the
   same table-style UI as the Create-agent page (`/agents/create`) — a sunken
   `Host port` / `Container port` header row, one row per mapping with a ✕
   remove button, and a `+ Add port` button. The Web tab currently renders its
   own custom label-above-input layout (WebTab.jsx:548-631); re-layout it to
   match `pages/CreateAgent.jsx:731-785`.

## Current behavior (why values are lost today)

| Setting | Storage | Survives toggle-off? |
|---|---|---|
| SSH host port | `meta.env` `PORT` | ❌ cleared by `sshEnabled:false` |
| SSH container port | `meta.env` `SSH_CPORT` | ✅ retained |
| SSH root password | `meta.env` `ROOT_PASSWORD` | ✅ retained, never returned |
| Web host port | `instances/<name>/web.json` | ❌ file deleted on unpublish |
| Web container port | `web.json` (+ driver default) | ❌ lost on unpublish (openclaw is fixed 18789 anyway) |
| Web password | `openclaw.json` `gateway.auth` + `web-openclaw.json` state | ✅ retained, only `passwordConfigured`/`authToken` exposed |

The UI derives its fields purely from live state, so whatever was removed
(`PORT`, `web.json`) leaves the form empty on the next toggle-on.

## Design

### Backend — `src/services/vm-manager.js` + `src/app.js`

Persist per-agent **draft** keys in `meta.env` (same file as `PORT` /
`SSH_CPORT` / `ROOT_PASSWORD`; survives recreates, lives with the instance):

- `WEB_HOST_PORT_LAST` (+ optional `WEB_CONTAINER_PORT_LAST`)
- `SSH_HOST_PORT_LAST`

Write points in `applyAgentChanges` (plan 30 consolidated flow):

- **Web apply (`webChanged`):** set `WEB_HOST_PORT_LAST` from the effective
  binding — `newWeb.hostPort` on publish, or `oldWeb.hostPort` on unpublish
  (so the last-used value is captured *as* it is removed). Same for
  `WEB_CONTAINER_PORT_LAST` when the driver allows an editable container port.
- **SSH apply (`sshChanged`/`sshCportChanged`/`passwordChanged`):** set
  `SSH_HOST_PORT_LAST` from the effective port — `newSshPort` on expose, or
  `oldSshPort` on remove. Container port + root password already persist
  (`SSH_CPORT`, `ROOT_PASSWORD`) — no change needed there.

`meta.env` is written with the existing `setMetaFlag(name, key, value)` —
but note the gotcha: `setMetaFlag` **removes** the line on `''`, so drafts are
only set when non-empty (or cleared deliberately on agent delete). Readers must
fall back to `''`.

**GET surface** — extend `readWebState` (shared by `GET /api/agents/:name/web`,
`readSettings`, MCP `settings_get`) with:

```js
draft: {
  webHostPort: meta.WEB_HOST_PORT_LAST || '',
  webContainerPort: meta.WEB_CONTAINER_PORT_LAST || '',
  sshHostPort: meta.SSH_HOST_PORT_LAST || '',
  sshContainerPort: readSshCport(name),   // live + draft are the same slot
}
```

**Empty-password = keep current (parity fix):** today `POST /web` maps an empty
`password` to `body.web.password = ''` (`app.js`), which **clears** auth on
optional-auth drivers (`vm-manager.js:2466-2468`). For the password to persist
while redacted, an empty field must mean "keep the saved password" for **all**
drivers (openclaw already keeps its token for required-auth). Fix: only include
`web.password` in the body when non-empty (`app.js`), and/or treat `''` as
"keep" in `prepareAgentChanges` for the non-required branch.

### Frontend — `src/client/src/pages/agent/WebTab.jsx`

In `refresh()` (WebTab.jsx:40-58), pre-fill from `data.draft` before live state:

- `setSshPort(d.draft?.sshHostPort || d.sshPort || '')`
- `setSshCport(d.draft?.sshContainerPort || d.sshContainerPort || '22')`
- `setHostPort(d.draft?.webHostPort || d.webService?.hostPort || '')`
- `setContainerPort(d.draft?.webContainerPort || String(d.webApp.containerPort))`
  (only when `webApp.containerPortEditable !== false`; openclaw stays 18789)
- Passwords unchanged: `setSshPassword('')` / `setPassword('')` — redacted.
  The existing "Leave empty to keep the current password" placeholder text and
  `sshDirty` gating (a typed password marks dirty) already match the semantics;
  `sshDirty` still works because toggling on flips `sshEnabled !== !!data.sshPort`.

The `handleSshSave` / `handleApply` request bodies are unchanged (they send the
fields the user edited); the drafts are only a *remembered form state* so the
next toggle-on is pre-filled.

## Acceptance

- Live on a test PAD: expose SSH with host port + password → apply → toggle
  off → toggle on → host port + container port are pre-filled, no password
  needed (saved password still grants `root` login).
- Web console: publish on a host port → unpublish → re-publish → the host port
  field is pre-filled; password still effective without re-entering it.
- `GET /api/agents/:name/web` never returns a password or hash — only the
  redacted boolean / `authToken` it returns today.
- `GET /api/agents/:name/web` returns a `draft` object; existing consumers
  (MCP `settings_get`, SettingsTab) ignore it harmlessly.
- Re-publish with the password field empty does **not** clear the saved
  password on optional-auth drivers (openclaw + others).
- WebTab "Additional ports" renders the Create-agent table layout (header row,
  inputs + ✕, "+ Add port"), keeps its Apply-and-recreate flow, and still
  round-trips `extraPorts` unchanged.

## Files

- **Modified** `src/services/vm-manager.js` — draft persistence +
  `readWebState.draft`
- **Modified** `src/app.js` — `POST /web` empty-password = keep
- **Modified** `src/client/src/pages/agent/WebTab.jsx` — draft pre-fill
- Build + verify: `cd src/client && npm run build` + `docker restart paddock`,
  then live-test on a test PAD in the browser
