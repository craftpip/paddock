# Plan 73 — Mission: phantom `msn-row-selected` with "No session selected"

## Status: Proposed — 0/4 items done, design complete, nothing built.

## Bug

On the Mission page, a session row in the middle column carries
`msn-row-selected` while col 3 shows its empty state ("No session selected" +
"Open a session from the middle column …"). Repro: open `/mission`, open
nothing, refresh — a row renders highlighted with nothing open. The highlight
claims a selection the page does not have.

## Root cause (read, not yet changed)

- `src/client/src/stores/mission.js` — `followSessionPatch(rows, currentId)`:
  `rows.find(live) || rows[0]`. Every `fetchSessions` / aggregate `fetchAll`
  success spreads it, so each load, refresh, and 15s poll auto-picks the first
  live (else first) row into `selectedSessionId` even when the user opened
  nothing (`openSession === null`).
- `src/client/src/components/SessionList.jsx` — `LiveRow selected={row.session.id
  === selectedSessionId}` is what paints `msn-row-selected`; it reads the
  highlight, not `openSession`.
- `src/client/src/pages/Mission.jsx` — col 3 renders from `openSession` (plan
  58 contract) and correctly shows the empty state. Highlight and open session
  disagree: one says "something is selected", the other says "nothing is".
- Why it survived: the auto-pick predates plan 58, when col 3 derived from
  `selectedSessionId` and landing on a live row avoided a dead pane. Since col 3
  pinned to `openSession`, the auto-pick only feeds the highlight — the dead-pane
  reason is gone, the phantom highlight remains.

## Fix

Highlight = what is open or what the user clicked, never what a fetch guessed.

- [ ] 1. `followSessionPatch` stops auto-picking: keep `currentId` if that row
      is still present, else `''` (and in `all` scope move `selectedProjectId`
      only when a kept row carries it — no `rows[0]` / first-live fallback).
      Audit every spread site (`fetchSessions`, aggregate read, `select`,
      `fetchProjects` fallback, `closeSession`/`deleteProject` clearing) so none
      reintroduces a pick-first-row path.
- [ ] 2. Decide the one deliberate exception, if any: project click with zero
      selection (today `select()` clears the highlight — keep it cleared, or
      document why a pick there is wanted). No silent third state: either the
      highlight always mirrors `openSession.id`, or click sets it and fetches
      only preserve/clear it — pick one and write it in plans/53 §6 next to the
      `openSession` contract.
- [ ] 3. Regression test (store-level, no browser): fresh store → load sessions
      with `openSession === null` → assert `selectedSessionId === ''`; click
      (`selectSession`) → assert highlight set + `openSession` set; row vanishes
      on refetch → assert highlight clears and `openSession` untouched (plan 58
      rule). Existing mission suites stay green run individually.
- [ ] 4. Verify live in the browser per AGENTS.md (build + restart, real page):
      fresh load with nothing open → zero `.msn-row-selected` while col 3 shows
      "No session selected"; refresh → same; click a row → exactly one selected
      row + col 3 opens; refresh with a session open → highlight preserved on
      that row; one 15s poll → no new highlight appears.

## Out of scope

- `ProjectRail`'s own `msn-row-selected` (col 1 project highlight) — different
  selection, not this bug.
- Plan 68 auto-reopen / plan 68-ideas selection-driven sessions — this plan only
  stops the fetch from inventing a selection.
