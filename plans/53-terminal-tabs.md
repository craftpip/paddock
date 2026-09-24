# Terminal tab strip — replace header status/title with session tabs (plan 53)

## Status: Proposed (not started, 2026-09-24) — 0/5 phases done, remaining: layout, behavior wiring, edge cases, verify, docs absorb.

## Goal

Replace the header stretch between the connection dot and the session
dropdown in `src/client/src/components/Terminal.jsx:950-978` with a
browser-like tab strip:

- Keep the `●` connection dot (left). Drop/replace the
  `Terminal Connected / Connecting / Disconnected` text, the `Locked` badge
  spot, the divider, and the `dynTitle || title || name` label.
- New strip: `[●] [tab: main] [tab: term-1] … [+]` — current session tab is
  visibly active, `+` creates a new session immediately (same as today's
  `+ New session`).
- Switching a tab = today's `switchSession(id)` (persist
  `pad-term-session-<name>`, teardown + `initTerminal()` with
  `?session=<id>`). Closing a tab (`×` on hover/active) = today's
  `closeSession(id)` with same fallback rule (previous session in list, else
  `main`). No backend change — same `GET/DELETE
  /api/agents/:name/terminal-sessions` and same WS `?session=` attach.

Current layout reference (`Terminal.jsx:951-990`):
left cluster = dot + status text (`min-w-[8rem]`) + Locked + divider +
title + Stop-Command; right cluster = session dropdown (`sessionId`,
`showSessions`, `refreshSessions`, `switchSession`, `newSession`,
`closeSession`) + font/clear/reconnect/collapse/fullscreen buttons.
Only the left-cluster text/title region is replaced; right-cluster utility
buttons stay as-is.

## Phases

- [ ] Phase 1 — Tab strip layout (JSX/CSS only)
- [ ] Phase 2 — Behavior wiring (reuse existing session fns)
- [ ] Phase 3 — Edge cases (overflow, loading, collapsed/fullscreen, mobile)
- [ ] Phase 4 — Verify (build + live browser test per AGENTS.md)
- [ ] Phase 5 — Absorb into docs, remove this file

## Phase 1 — Layout

1. In `Terminal.jsx:950` header, keep outer `flex items-center
   justify-between`; split into three zones: `[dot] [tabs flex-1] [actions]`.
2. Dot stays (`Terminal.jsx:953`), add `title={connState}` tooltip instead of
   the text label; remove the `min-w-[8rem]` status `<span>` (`:954-956`).
3. Middle zone: horizontal scrollable tab list (`overflow-x-auto`,
   `flex-1 min-w-0`), one tab per entry in `sessions` state (+ optimistic
   current `sessionId` when list hasn't loaded yet — mirroring today's
   dropdown optimistic `setSessions` in `newSession`). Active tab =
   `s.name === sessionId`: accent underline/border + `text-ink`, inactive =
   `text-ink-muted`. Truncate long names (`max-w-[8rem] truncate`, same as
   dropdown button `:986`).
4. `+` button directly after tabs (same row, `shrink-0`), `onClick={newSession}`,
   `title="New terminal tab"`. Reuse `+ New session` styling language.
5. `×` close affordance per tab: visible on active/hover (`opacity-0
   group-hover:opacity-100`, same pattern as dropdown `:1024`), calls
   `closeSession(s.name)`. Stop propagation so close ≠ switch.
6. Decision needed (recommend A):
   - A (recommended): **remove the session dropdown entirely** — tabs ARE the
     switcher. Keeps header to one concept. Refresh still happens silently on
     mount/tab-switch (today's `refreshSessions` is lazy on dropdown open —
     move to mount + after switch/create/close).
   - B: keep dropdown as overflow (`…`) menu for >N sessions. More code, two
     ways to do the same thing.
7. Keep right-cluster buttons untouched (font A-/A+, Clear, Reconnect,
   collapse, fullscreen — `:1044-1099`). Keep `Stop Command` and `Locked`
   indicators: move `Locked` badge to just right of dot (tiny lock icon only,
   no text, to save strip space) and keep `Stop Command` where it is or as a
   per-active-tab busy dot — pick one in implementation, don't show both.

## Phase 2 — Behavior wiring (no new backend)

1. Session list source stays `sessions` state + `refreshSessions()` (`:766`).
   Change trigger: call on mount / `name` change / after `switchSession` /
   `newSession` / `closeSession` completes (today it only loads on dropdown
   open `:786`). Keep the optimistic-add + poll-confirm logic in `newSession`
   (`:817-835`) and the poll-until-recreated logic in `closeSession`
   (`:859-872`) unchanged.
2. `switchSession`, `newSession`, `closeSession` bodies unchanged (same
   localStorage persist, same `teardown()` + `initTerminal()`). Only their
   call sites move from dropdown items to tabs/`+`/`×`.
3. Remove `showSessions`, `sessionMenuRef`, `toggleSessions`, and the
   outside-click effect (`:755-763`) if option A wins; keep them if B.
4. Title handling: tab label = session name (`s.name`); the tmux-driven
   `dynTitle` (`:191`, pushed via NUL-NUL `title` frame) becomes the tab's
   `title=` tooltip on the ACTIVE tab only (or a subtitle — don't add a second
   text label in the strip).
5. `running`/`connState` interplay unchanged (`:660-692`): tabs clickable
   while disconnected (queues a connect via `switchSession`), `+` disabled
   when `!name`.

## Phase 3 — Edge cases

1. Empty/loading: `sessions.length === 0` → render single tab with
   `sessionId` (usually `main`) + skeleton pulse while `sessionsLoading`;
   never render an empty strip.
2. Overflow: strip scrolls (`overflow-x-auto`, `scrollbar-thin`), active tab
   `scrollIntoView({inline:'nearest'})` on `sessionId` change; `+` stays pinned
   outside the scroller (`shrink-0`).
3. Long names: truncate with full name in `title=`; `SAFE_SESSION_RE`
   (`:193`) still gates rendering.
4. Collapsed (`collapsed` prop) and fullscreen (`:140-143`): strip hidden when
   collapsed (same as body); in fullscreen it stays — Escape behavior
   unchanged.
5. Mobile (plan 29 owns responsiveness): strip must not push action buttons
   off-screen — tabs zone is `min-w-0 flex-1`, action buttons `shrink-0`;
   dropdown removal actually helps here (no `w-64 absolute right-0` overhang
   `:992`).
6. A11y: tabs are `<button role="tab" aria-selected>`, `+` has aria-label.

## Phase 4 — Verify (per AGENTS.md, always test before delivering)

1. `cd src/client && npm run build` + `docker restart paddock`.
2. Open http://10.69.1.164:6789 live, agent detail → terminal header:
   dot-only status, tabs for each tmux session, `+` creates `term-N`,
   click switches (WS reattaches, scrollback of that session returns),
   `×` closes with fallback to previous/`main`.
3. Regression: locked mode, Stop Command, font resize, reconnect, collapse,
   fullscreen, stopped-agent (4002) message — all still work.

## Phase 5 — Docs

Absorb into `docs/reference/tabs/terminal.md` (+ `docs/guide/terminal.md`
one-liner), then delete this file. Code-vs-docs: code wins.

## Out of scope

- Multi-pane/split terminal, renaming sessions, per-tab busy spinners beyond
  the existing Running badge, any backend/tmux changes.
