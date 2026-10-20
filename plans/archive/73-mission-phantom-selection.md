# Plan 73 — Mission: phantom `msn-row-selected` with "No session selected"

## Status: Complete — 4/4 items verified 2026-10-19. The product fix shipped in
`ec9e993` (as part of plan 80, before this plan was queued); this pass audited
it, added the missing regression cases, wrote the contract down, and verified
the page live.

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

- [x] 1. `followSessionPatch` stops auto-picking. Shipped in `ec9e993`: it now
      returns `{ selectedConversationId: currentId || '' }` and never reads the
      rows. Audit done — the only writers are the user actions (`selectSession`
      / `startSession` / accepted `restoreView`); both fetch paths
      (`fetchSessions`, `fetchAll`) only preserve; a list replacement (`select`
      / `createProject` / `deleteProject`) clears; `closeSession` deliberately
      keeps it (plan 80). The plan's "else `''`" for a vanished row was
      superseded: the highlight is a CONVERSATION, so a close's history twin
      carries it, and a read must not move a user's selection.
- [x] 2. Deliberate exception documented in `plans/53` §6 and
      `docs/reference/pages/overview.md`: switching projects via `select()`
      clears the highlight because it replaces the list the highlight belonged
      to, while `openSession` (col 3) is untouched; no fetch ever picks a row.
      There is no other third state.
- [x] 3. Regression tests added to `src/test/mission-view.test.js`: aggregate
      read invents nothing, project-scoped read invents nothing,
      `selectSession` owns highlight + col 3, and a vanished row clears neither
      (pinned with the plan-80 reason). Three pre-existing hydration tests were
      re-pointed for plan 93's URL-bootstrap move (the facts moved; the
      assertions were not relaxed). All mission suites green individually:
      view 17/17, reopen 8/8, navigation 10/10, queue 12/12, popout 1/1,
      mission 128/128.
- [x] 4. Live-verified in chromium at `/mission` (1440×900): fresh load with
      nothing open → **0** `.msn-row-selected` and col 3 empty; reload → still
      0; click a row → exactly **1** selected + terminal + col 3 header; reload
      with it open → same row still selected, terminal kept; a 15s poll → still
      1; navigating to a view with no session → 0 after a poll. Nothing was
      closed and no session was started.

## Resolution note

The phantom was real when the plan was written, but `ec9e993` ("mission: a row
is a conversation", plan 80) already removed the `rows.find(live) || rows[0]`
fallback while making the highlight conversation-keyed. This pass closed the
remaining gap — the contract was undocumented, the project-scope read and the
click path had no regression cases, and the live page had not been checked —
and corrected two stale comments that still described the old fallback.

## Out of scope

- `ProjectRail`'s own `msn-row-selected` (col 1 project highlight) — different
  selection, not this bug.
- Plan 68 auto-reopen / plan 68-ideas selection-driven sessions — this plan only
  stops the fetch from inventing a selection.
