# Sub-goal 34e — WebTab UI Updates

## Status: Proposed (2026-08-10) — 0/3 items. Depends on 34a-34d (descriptors live in drivers).

Progress checklist:

- [ ] **Start in terminal** button (`run(webApp.startCommand(...))`)
- [ ] Read-only container-port field for fixed-port drivers (`containerPortEditable: false`)
- [ ] Peer-mode collision warning
- [ ] SPA build + live verify

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
- Build: `cd src/client && npm run build` + `docker restart paddock`
