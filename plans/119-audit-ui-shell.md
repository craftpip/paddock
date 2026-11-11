# Plan 119 — Audit fixes: the page shell (navigation, titles, small screens)

## Status: In progress — 2026-11-11 — 0/6 items done; findings measured in the browser, fixes not started

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

## Progress

- [ ] 1 Top bar scrolls inside itself on small screens
- [ ] 2 `useDocumentTitle`, used by every page
- [ ] 3 Current page marked in the top bar
- [ ] 4 Plans-folder hint
- [ ] 5 Agent tab in the URL
- [ ] 6 Browser checks above recorded here
- [ ] 7 A regular user is not shown admin-only places (Vault, Configs, the vault button in the command pane, callback editing)
