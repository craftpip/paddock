# Sub-goal 34e — WebTab UI Updates

## Status: Complete (2026-08-10) — 3/3 items + build/verify done. Collision warning is code-verified only (no peer-mode openclaw pad exists to trigger it live).

Progress checklist:

- [x] **Start in terminal** button (`run(webApp.startCommand(...))`)
- [x] Read-only container-port field for fixed-port drivers (`containerPortEditable: false`)
- [x] Peer-mode collision warning
- [x] SPA build + live verify

Parent: `plans/34-web-publish-all-drivers.md`.

## Scope

`src/client/src/pages/agent/WebTab.jsx` (currently renders fully from
`driver.webApp`; null → empty state):

- **Start in terminal** button — CommandsPane rule: action buttons paste
  `openclaw ...` commands into the docked terminal via `run(cmd)`, never a
  backend action API. Button runs `run(webApp.startCommand(...))`.
- **Read-only container port** for fixed-port drivers (`webApp.
  containerPortEditable: false` — openclaw gateway 18789). Only openclaw is
  fixed; picoclaw launcher (`-port`) and hermes dashboard (`--port`) are
  editable.
- **Peer-mode collision warning** — two peer-shared agents of the same type
  cannot both publish a fixed container port:
  - openclaw gateway fixed 18789
  - picoclaw gateway chat fixed 18790 (launcher itself is `-port` editable)
  Warn in the Web tab when the container port can't vary.

## Acceptance

- Button pastes the right command into the docked terminal and the console
  starts (live-checked on a test PAD).
- openclaw shows a read-only 18789; picoclaw/hermes show editable ports.
- Collision warning appears for a second same-type peer sharing a fixed port.

## Files

- **Modified** `src/client/src/pages/agent/WebTab.jsx`
- **Modified** `src/client/src/pages/AgentDetail.jsx`
- **Modified** `src/app.js`, `src/services/vm-manager.js`,
  `src/services/drivers/openclaw.js`
- Build: `cd src/client && npm run build` + `docker restart paddock`

## Verification notes (2026-08-10)

- Hermes (active): Start in terminal expands the docked terminal, pastes the
  live published command, shell executes it. (Found + fixed a real bug: the
  terminal auto-collapses in non-commands modes and the flush poll that
  delivers queued commands only runs while expanded — a collapsed terminal
  silently swallowed the paste. WebTab now calls `expandTerminal()` first.)
- Openclaw (active + inactive): no Start button (startable:false); inactive
  form shows read-only 18789 + "(fixed)" hint + "Gateway token (required)" +
  placeholder "Required to bind outside loopback".
- Picoclaw (inactive): editable port + Start button + "Dashboard token
  (optional)"; draft path fetches `?containerPort` and pastes
  `picoclaw-launcher -console -no-browser -public -port 18800`.
- API `GET /api/agents/:name/web` returns `collision` (null without a
  collision) and `startCommand` in all states.
