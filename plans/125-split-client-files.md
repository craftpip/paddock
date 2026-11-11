# Plan 125 — Split the oversized client files

## Status: In progress — 2026-11-12 — 1/5 files split (AgentDetail: 1202 → 411 lines); next: SettingsTab

## Why

Five client files are over 1200 lines each. Each one mixes several jobs, so a
change to one card or one tab means reading all of it, and a mistake in one
part can break the rest of the page.

| File | Lines | What is in it |
|---|---|---|
| `pages/agent/SettingsTab.jsx` | 1419 | one component: 11 settings cards, their handlers, the confirm modals |
| `stores/mission.js` | 1350 | one store: projects, sessions, pane state, history, runner, queue (55 actions) |
| `components/Terminal.jsx` | 1255 | one component: socket, xterm, tabs, header, tracked commands |
| `pages/CreateAgent.jsx` | 1225 | one component: the whole create form and its job log |
| `pages/AgentDetail.jsx` | 1202 | the page plus five tab components (Workspace is 580 lines) |

## The rule for this plan

**Nothing the user sees or does may change.** This is a move, not a rewrite.
No behaviour, text, class name or request changes in the same commit as a move.

## How each file is split

1. **`AgentDetail.jsx`** — the five tab components (`WorkspaceTab`, `LogsTab`,
   `SessionsTab`, `ActivityTab`, `ConfigTab`) move to `pages/agent/`, one file
   each, beside the tabs that already live there. The page keeps the header,
   the tab bar and routing.
2. **`SettingsTab.jsx`** — each card's JSX moves to its own component under
   `pages/agent/settings/`. The tab stays the owner of the loaded settings, the
   handlers and the confirm modals, and passes each card what it reads and
   calls as props. The diff helper (`lineDiff`, `DiffPreview`) moves to its own
   file.
3. **`CreateAgent.jsx`** — the form's sections (identity, workspace, volumes,
   network, build commands, job log) become components under
   `pages/create-agent/`, same props approach.
4. **`Terminal.jsx`** — the header bar (tabs, font size, Clear, Reconnect,
   Fullscreen) becomes `TerminalHeader.jsx`. The socket and xterm lifecycle
   stay together: they share refs and a generation counter, and splitting them
   is a rewrite, not a move.
5. **`stores/mission.js`** — one file per area (`projects`, `sessions`,
   `pane`, `history`, `runner`, `queue`) under `stores/mission/`, each exporting
   `(set, get) => ({ …actions })`. The shared generation counters move to one
   small module. `stores/mission.js` stays as the file everything imports and
   composes the slices, so no import elsewhere changes.

The moves are done by a script, not by hand: it parses the file, finds every
name the moved code uses, and turns each one into an import (a module-level
name) or a prop (a name from the enclosing component). A name it cannot place
stops the script.

## How it is proven

For every page that is touched, **before** the move and **after** it, in the
navigator browser on the same data:

- the page's DOM outline (every tag and class, in order) and its text with
  digits masked are captured and must be identical;
- each interactive control in the moved part is exercised once (open a modal,
  type in a field and see the Apply button enable, switch a tab);
- no console error.

And:

- `npm run build` clean, `docker exec paddock npm test` green (this includes
  the unbound-name scan over every client file and the bundle-freshness check);
- tests that pin source text of a moved fact are pointed at the file the fact
  now lives in, never deleted.

## Order and commits

One commit per file, in the order above (smallest risk first). If a file's
after-capture differs from its before-capture and the cause is not found
quickly, that file's move is reverted and recorded here as not done.

## Progress

- [x] Baseline captures for the Agent detail tabs (settings, workspace, sessions, activity, config, logs)
- [x] 1 `AgentDetail.jsx` tabs moved — five tabs: DOM outline and masked text identical before/after, suite green
- [ ] 2 `SettingsTab.jsx` cards moved
- [ ] 3 `CreateAgent.jsx` sections moved
- [ ] 4 `Terminal.jsx` header moved
- [ ] 5 `stores/mission.js` slices
- [ ] Docs: `docs/reference/pages/overview.md` / `tabs/*.md` file paths updated
