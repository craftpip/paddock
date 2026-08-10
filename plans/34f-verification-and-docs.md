# Sub-goal 34f — Per-Driver Verification + Docs Absorption

## Status: Proposed (2026-08-10) — 0/3 items. Depends on 34a-34e.

Progress checklist:

- [ ] Per-driver live verification (publish/recreate/unpublish/door/rollback)
- [ ] Update `docs/tabs/web.md` status line + peer-collision note
- [ ] Absorb plan into docs and close plan 34

Parent: `plans/34-web-publish-all-drivers.md`.

## Scope

### Live verification (per driver, on a test PAD)

For each of openclaw / picoclaw / hermes, on default network + one peer-mode
pad (via gluetun):

- Publish → URL 200, auth gate works
- Recreate survives (boot hook re-applies)
- Unpublish cleans up
- Door carries the binding in peer mode
- Rollback restores old auth

### Docs

- Update `docs/tabs/web.md` status line (lines 17-29) once each driver lands.
- Add the peer-collision note (fixed vs editable container ports).
- `docs/tabs/web-consoles.md` (the per-console reference, written 2026-08-09)
  should be checked against what was actually built.

### Close

Per the user's plan workflow: once all sub-goals are complete and verified,
**absorb into `docs/` first, then remove** plan 34 + all 34a-34f files. A plan
never just vanishes.

## Acceptance

- Every driver's publish/unpublish/rollback cycle passes live on a test PAD.
- `docs/tabs/web.md` + `docs/tabs/web-consoles.md` reflect reality.
- Plan 34 and all sub-goal files removed after docs absorption.

## Files

- **Modified** `docs/tabs/web.md`
- **Modified** `docs/tabs/web-consoles.md` (recheck)
- **Deleted** `plans/34-web-publish-all-drivers.md` + `plans/34[a-f]-*.md`
