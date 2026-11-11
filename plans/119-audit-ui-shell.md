# Plan 119 — Audit fixes: the page shell (navigation, titles, small screens)

## Status: Complete — 2026-11-11 — 7/7 items done and checked in the browser

## Why

Found by loading every page in the navigator browser on 2026-11-11 (1500 px and
420 px wide) with a collector for failed requests, uncaught errors, unhandled
rejections and `console.error`. No page raised a runtime error and no request
failed. These are the defects that were visible anyway.

## Findings

| # | Where | What is wrong | Measured |
|---|---|---|---|
| 1 | `components/DashboardLayout.jsx` | On a phone-width screen the top bar is wider than the page, so every page scrolls sideways | 420 px viewport, document 665 px wide on `/agents`, `/vault`, `/configs`, `/profile`, `/agents/create` |
| 2 | `pages/Mission.jsx:422` | The tab title is set to "Mission — Paddock" and never reset, so it stays after leaving Mission | title on `/agents` after visiting `/mission` |
| 3 | every page | No page except Mission names itself in the tab title | title is "Paddock — Agent Manager" everywhere |
| 4 | `components/DashboardLayout.jsx` | The top bar does not show which page is current, visually or to a screen reader | no active style, no `aria-current` |
| 5 | `components/ProjectDialog.jsx` | With no folder chosen the hint reads "Relative to the project folder — //plans/" | New project dialog, empty folder |
| 6 | Agent detail tabs | The open tab is not in the URL, so a reload or a shared link always lands on the first tab | `location.search` empty after clicking each tab |

## Fixes

1. **Top bar on small screens.** The link group becomes its own horizontal
   scroller (`min-w-0 overflow-x-auto`, no visible scrollbar) and the brand
   keeps its width (`shrink-0`). The page itself must not scroll sideways.
2. **Titles.** One hook, `useDocumentTitle(title)` in `lib/`, sets
   `"<Page> — Paddock"` and restores the default on unmount. Used by every
   page: Agents, the agent's own name on its detail page, Create agent, Vault,
   Backups, Configs, Settings (profile), Mission, Mission session pop-out.
   Mission's bare `useEffect` is replaced by it.
3. **Current page.** The top bar uses `NavLink`; the active link gets the
   accent text colour and `aria-current="page"`. "Agents" is active on
   `/agents` and `/agents/<name>` but not on `/agents/create`.
4. **Plans-folder hint.** With no folder, show the folder-relative form only:
   "Relative to the project folder — plans/".
5. **Agent tab in the URL.** `?tab=<id>` is written on tab change and read on
   load; an unknown value falls back to the first tab.

## Checks

- 420 px viewport: `document.documentElement.scrollWidth <= innerWidth` on
  every page; every top-bar link still reachable by scrolling the bar.
- Title: visit Mission, then Agents; title reads "Agents — Paddock". Detail
  page reads "pad-dev — Paddock".
- `document.querySelector('nav [aria-current="page"]').textContent` matches the
  page on each route.
- Agent detail: click Settings, reload, Settings is still open.
- `npm test` green, including the bundle-freshness test after the rebuild.

## Results (2026-11-11)

| # | Outcome | Seen in the browser |
|---|---|---|
| 1 | The link group scrolls inside the bar (`msn-topnav`); the page no longer scrolls sideways | 420 px: document 410 px wide on six pages (was 665); Sign out reachable by scrolling the bar |
| 2 | `lib/useDocumentTitle.js`, used by every page; the default is restored on leaving | Mission → Agents reads "Agents — Paddock"; the detail page reads "pad-dev — Paddock" |
| 3 | The current page has the accent colour and `aria-current="page"`, including the profile link | `nav [aria-current]` matched on each route |
| 4 | With no folder chosen the hint reads "…— plans/" | code |
| 5 | **Already worked.** The tab is in the path (`/agents/pad-dev/settings`), not the query string, which is why the first measurement (of `location.search`) saw nothing | path after clicking Settings |
| 6 | Checks above | — |
| 7 | A regular user is not shown Vault, Configs or the vault button in the command pane; saving callbacks answers 403 with the reason | role is read from the session; refusals confirmed over the API in plan 121 |

## Progress

- [x] 1 Top bar scrolls inside itself on small screens
- [x] 2 `useDocumentTitle`, used by every page
- [x] 3 Current page marked in the top bar
- [x] 4 Plans-folder hint
- [x] 5 Agent tab in the URL
- [x] 6 Browser checks above recorded here
- [x] 7 A regular user is not shown admin-only places (Vault, Configs, the vault button in the command pane, callback editing)
