# Panel Responsive — the whole SPA down to ~360px (plan 29)

## Status: Proposed (not started, 2026-08-09) — 0% implemented. Full-SPA
responsive survey done (2026-08-09); no CSS/class changes landed yet.

> **Note (2026-08-09):** this plan now owns the responsive workstream from
> plan 02 (UI Enhancements, absorbed into docs and removed). Plan 02 had
> gotten as far as hiding table columns on mobile; forms, terminal, and the
> rest are this plan's scope.

> **Scope correction (2026-08-09):** the original file was written as
> "Terminal Responsive" only. The real intent is the **whole panel** — terminal
> is just the worst offender. This rewrite keeps the terminal section but adds
> a page-by-page survey of every screen in the SPA so it can be made usable on
> a phone end-to-end.

## Goal

Make the **entire Paddock panel** usable on small screens (down to ~360px),
not just the terminal. Every page currently assumes a desktop-ish viewport:
one-row flex headers that overflow, fixed-width dropdowns that hang off the
screen, tables that squeeze into uselessness, and gutters that eat the
available width.

The plan is organized by page. Existing breakpoint utility is
Tailwind (`sm` = 640px, `md` = 768px, `lg` = 1024px) and the viewport meta is
already present (`index.html` has `width=device-width, initial-scale=1.0`).

## General principles (applies everywhere)

1. **Every one-row `flex items-center justify-between` header gets `flex-wrap`**
   (and `gap` on the wrap axis) unless its children are all tiny icons.
   When a row wraps, children should reflow top-to-bottom in the intended
   order — put the "action" cluster last.
2. **Fixed-width popovers/dropdowns** (`w-64`/`w-80`/`w-96`, anchored
   `absolute right-0`) get `max-w-[calc(100vw-2rem)]` so they can't hang off
   the right edge of a phone.
3. **Tables** stay tables on desktop; on mobile either hide low-value columns
   (`hidden sm:table-cell` — already done in workspace) or wrap the table in a
   `overflow-x-auto` scroller. Prefer column-hiding over horizontal scroll for
   the main data pages.
4. **Gutters**: page-level `px-6` → `px-4 sm:px-6`. Cards keep their internal
   `p-5` but header/footer rows inside them may need `flex-wrap`.
5. **Buttons**: keep action buttons `whitespace-nowrap shrink-0`; let text
   descriptions wrap freely (`max-w-md` blocks already wrap).
6. Pure CSS class changes only. No logic/state changes, no breakpoint JS. The
   desktop layout must be **visually unchanged** at `lg+` — every rule is
   additive (`sm:`/`md:` variants) or only relaxes a floor.

## Current behavior survey (verified 2026-08-09)

### Layout shell

- `DashboardLayout.jsx:35` nav row: `flex items-center justify-between h-14`
  with Paddock logo, 4 links (Agents, + Agent, Vault, Backups), a divider,
  theme toggle, username link, logout. **No `flex-wrap`** — at ~640px the
  right cluster alone (4 links + divider + 3 icons) overflows.
- `DashboardLayout.jsx:25-29` `mainClass` already has `px-4 sm:px-6 lg:px-8`
  for the scroll pages — fine. The `fullHeight` pages (AgentDetail) rely on the
  per-component gutters below.

### Dashboard (`Dashboard.jsx`)

- Header (`:93`): `flex items-center justify-between mb-8` with title/subtitle
  block and a `w-48` search input + `+ New Agent` button. **No `flex-wrap`** —
  at 360px the search box alone eats 192px next to the button and the title
  block.
- Search input (`:107`): `w-48` fixed — on mobile should become
  `w-full sm:w-48` (wrapped to its own row).
- Fleet resources strip (`:118`) is already `flex flex-wrap` ✓.
- Cards grid (`:144`) is already `grid-cols-1 md:grid-cols-2 lg:grid-cols-3` ✓.
- AgentCard: avatar + name + status pill in `flex items-start justify-between`
  — the pill has `flex-shrink-0` and the name truncates, so it degrades fine.

### Agent detail page (`AgentDetail.jsx`)

- `AgentHeader` (`:48`): `flex items-center gap-4 px-6 py-3 ... flex-wrap` —
  already wraps ✓, but uses `px-6` (slim to `px-4 sm:px-6`).
- Mode tabs bar (`:209`): `overflow-x-auto` already ✓ — keep, but `px-6` →
  `px-4 sm:px-6`.
- Mode content (`:249`): `px-6 pt-6 pb-3` → `px-4 sm:px-6 pt-4`.
- **Terminal dock** (`:269`): `px-6` → `px-4 sm:px-6` (see §Terminal).
- Workspace file table already hides Size (`hidden sm:table-cell`) and Modified
  (`hidden md:table-cell`) on mobile ✓.
- Workspace file modal (`:741`): `width: 80vw, maxWidth: 900px` — `80vw` is
  fine on phones; its header row (`:742`) `flex items-center justify-between`
  holds name/status + Save/Download/Close — add `flex-wrap` + let the title
  block truncate.
- ConfigTab / LogsTab / ActivityTab / SessionsTab: tables already wrapped in
  `overflow-x-auto` (Sessions `:863`, Activity `:904`) or are scrollable
  panes ✓. Config save row (`:965`) is `justify-between` with a short label —
  add `flex-wrap` for safety.

### Terminal (`Terminal.jsx:950-1101`) — see dedicated section below

### CommandsPane (`CommandsPane.jsx`)

- Search row (`:709`): `flex items-center gap-2` — Run TUI, filter input
  (`flex-1 max-w-md`, no `min-w`), Hide button, VaultDropdown. On mobile the
  input collapses to near zero. Needs `flex-wrap` + `min-w-[8rem]` on input.
- Vault dropdown (`:554`): `fixed w-80` → add `max-w-[calc(100vw-2rem)]`.
- Skill install input (`:320`): `w-56` → `w-56 max-w-[calc(100vw-2rem)]`
  (it's inline in a wrapped flow, so it can just be `w-full sm:w-56`).
- The command pill flow (`:749`) is already `flex flex-wrap` ✓.

### SettingsTab (`SettingsTab.jsx`)

- Container Info `dl` (`:534`): already `grid-cols-2 sm:grid-cols-3` ✓.
- Section rows (`:553`, `:572`, `:615`, `:641`): `flex items-start justify-between
  gap-4` with a `max-w-md` description + right-aligned button/toggle. The
  buttons are `shrink-0` and the text wraps — acceptable, but the health-check
  row (`:580`) packs a status pill + "Run Health Check" in one cluster; give it
  `flex-wrap`.
- Network select (`:649`) already `w-full sm:w-96` ✓.
- Danger zone / delete + extra ports / volumes rows: keep `flex-wrap`.

### WebTab (`WebTab.jsx`)

- Web app fields (`:346`): `grid grid-cols-2 gap-4` — two port inputs. On
  360px each column is ~150px, workable but tight; make `grid-cols-1 sm:grid-cols-2`.
- Password row (`:375`): input + Show + Generate buttons in `flex items-center
  gap-2` — fine since buttons are small; input is `w-full` in flex so it
  shrinks. OK.
- SSH fields (`:458`): `grid grid-cols-2 gap-4` → same `grid-cols-1 sm:grid-cols-2`.
- SSH toggle row (`:430`): `flex items-start justify-between` with a long
  `max-w-md` description + toggle — text wraps ✓.

### Vault (`Vault.jsx`)

- Header (`:202`): `flex items-center justify-between` — title+badge on left,
  "Set PIN"/"Change PIN" on right. Add `flex-wrap`.
- Items table (`:262`): 5 columns (Name/Description/Value/Updated/actions),
  **no `overflow-x-auto` wrapper** — on a phone it squeezes. Wrap the table in
  `overflow-x-auto` AND hide the Description column on mobile
  (`hidden md:table-cell`), keeping Name/Value/Updated/actions.
- "Unprotected" banner (`:230`): `flex items-center justify-between` with a
  two-line message + Set PIN button — add `flex-wrap`.
- Modals (`:385`, `:493`): already `w-full max-w-md mx-4` ✓.
- Editor row (`:338`): 5 `<td>` in a row — inside the `overflow-x-auto` wrapper
  it scrolls; acceptable (rare editing row).

### CreateAgent (`CreateAgent.jsx`)

- Name row (`:351`): `flex items-center gap-2` — `{prefix}-` + type select
  (`w-36`) + `-` + name input (`flex-1`). At 360px: select 144px + input
  collapses. Add `flex-wrap` and let the name input get `min-w-[10rem]`.
- Extra ports rows (`:578`): `flex items-end gap-2` with two `w-40` inputs +
  ✕ button = ~340px + gaps → **overflows at 360px**. Make each field
  `w-full sm:w-40` in a `flex-col sm:flex-row` wrap, or add `flex-wrap`.
- Extra volumes rows (`:526`): two `flex-1` inputs + ✕ — inputs shrink
  gracefully; add `flex-wrap` for the gaps.
- Advanced sections are single-column cards — fine.

### Profile (`Profile.jsx`)

- Tab bar (`:301`): `flex gap-1` with 3 short tabs — fits; add `overflow-x-auto`
  for safety.
- Account `dl` (`:321`): already `grid-cols-1 sm:grid-cols-3` ✓.
- API key form (`:392`): already `flex flex-col sm:flex-row` ✓.
- Most rows already use `sm:` variants ✓ — low priority.

### Modals (shared)

- `PromptModal`, `CommandModal`, `HealthCheckModal`, `ContainerInfoModal`,
  `PinModal` — all already `w-full max-w-* mx-4` ✓. ContainerInfoModal mounts
  table (`:148`) has no wrapper but sources break-all; acceptable.

### Auth pages (Login / Setup / Onboard)

- Login/Setup: `max-w-sm mx-auto px-4` ✓.
- Onboard (`Onboard.jsx:54`): `max-w-2xl mx-auto` with **no horizontal
  padding** → add `px-4 sm:px-6`. Its API key row (`:94`) `flex gap-2` with a
  select + input — fine.

### Backups (`GlobalBackups.jsx`)

- Static empty-state placeholder, already `px-4 sm:px-6` — nothing to do now
  (page will be rebuilt per plan 26).

## Changes

### A. Layout shell — `DashboardLayout.jsx`

- Nav row (`:35`): `flex items-center justify-between h-14` →
  `flex flex-wrap items-center gap-x-2 gap-y-1 justify-between h-14`.
- Right cluster (`:40`): `flex items-center gap-0.5` → add `flex-wrap
  items-center gap-0.5` (links already `whitespace-nowrap`? they are not — the
  link labels are short; keep them). The cluster wraps below the logo on small
  screens.

### B. Dashboard — `Dashboard.jsx`

- Header (`:93`): add `flex-wrap` + `gap-y-3`.
- Search (`:107`): `w-48` → `w-full sm:w-48` and give the search+button
  cluster (`:100`) `flex-wrap` so on mobile the search is full-width on its own
  row above the button, or wraps below the title.

### C. Agent detail gutters — `AgentDetail.jsx`

- Header (`:48`), mode tabs (`:209`), mode content (`:249`), terminal dock
  (`:269`): `px-6` → `px-4 sm:px-6` (terminal dock also in §Terminal).
- File modal header (`:742`): add `flex-wrap`; title block already has
  `min-w-0`/truncate.

### D. Terminal header — `Terminal.jsx:950-1101` (from original plan)

Make the whole header `flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3
py-1.5 sm:px-4` (remove the outer `justify-between` two-group split):

- **Status cluster** (dot + text + Locked): keep `flex items-center gap-2
  shrink-0`. `min-w-[8rem]` → `min-w-0 sm:min-w-[8rem]` on the status text;
  keep `whitespace-nowrap`.
- **Title** (`:968`): add `min-w-0 flex-[1_1_100%] sm:flex-[1_1_auto]
  truncate text-xs text-ink-muted font-mono` and `title={dynTitle || title ||
  name}` — on mobile `flex-basis:100%` forces its own full row; on `sm+` it
  becomes a flexible inline item that truncates.
- **Right control cluster** (sessions, A-/A+, size, Clear, Reconnect, collapse,
  fullscreen): wrap in `flex flex-wrap items-center gap-0.5 sm:gap-1.5
  justify-end`. Buttons stay `shrink-0`.
- **Stop Command** (`:969`): stays in flow; wraps naturally.
- Collapsed + fullscreen states untouched — the wrap applies automatically.

### E. CommandsPane — `CommandsPane.jsx`

- Search row (`:709`): `flex items-center gap-2` → `flex flex-wrap items-center
  gap-2`.
- Filter input: add `min-w-[8rem]` (`flex-1 max-w-md` stays).
- Vault dropdown (`:554`): `w-80` → `w-80 max-w-[calc(100vw-2rem)]`.
- Skill install input (`:320`): `w-56` → `w-full sm:w-56 max-w-[calc(100vw-2rem)]`.

### F. Terminal dropdowns — width caps

- Sessions dropdown (`Terminal.jsx:992`): `w-64` → `w-64 max-w-[calc(100vw-2rem)]`.

### G. SettingsTab / WebTab — section rows

- SettingsTab health row (`:580`): add `flex-wrap` to the outer section row.
- WebTab port grids (`:346`, `:458`): `grid grid-cols-2 gap-4` →
  `grid grid-cols-1 gap-4 sm:grid-cols-2`.

### H. Vault — `Vault.jsx`

- Wrap the items table (`:262`) in `<div className="overflow-x-auto">`.
- Hide Description column on mobile: `<th className="... hidden md:table-cell">`
  and matching `hidden md:table-cell` on the row cells + editor `<td>`.
- Header (`:202`) and unprotected banner (`:230`): add `flex-wrap` + `gap-y-2`.

### I. CreateAgent — `CreateAgent.jsx`

- Name row (`:351`): add `flex-wrap`; name input add `min-w-[10rem]`.
- Extra ports row (`:578`): container → `flex flex-wrap items-end gap-2`; each
  input wrapper `w-40` → `w-full sm:w-40`.

### J. Onboard — `Onboard.jsx`

- Root (`:54`): `max-w-2xl mx-auto` → `max-w-2xl mx-auto px-4 sm:px-6`.

## Out of scope

- xterm internals (FitAddon handles the pane size).
- `GlobalBackups` real content (rebuilt in plan 26; shell already responsive).
- A hamburger/drawer nav — `flex-wrap` on the nav row is sufficient at 360px
  for 4 short links; revisit only if a 5th nav item is added.
- Old EJS views / `/api` legacy routes (dead code, plan 09).

## Implementation approach & risk mitigation

**Approach:** pure CSS class changes only — no logic, state, WS, xterm, or
backend code touched. Every change is an additive `sm:`/`md:` variant or a
relaxation of a fixed floor, so the `lg+` desktop layout is byte-for-byte
unchanged. Rebuild + restart the webui after the JSX edits (`cd src/client &&
npm run build && docker restart paddock`).

**Risks to watch while implementing:**
1. **Title truncation on desktop** — `truncate` on a flex item needs
   `min-w-0`; a long agent name must never shrink the controls. Keep the
   title constraint loose on `sm+`.
2. **Dropdown anchors** — `absolute right-0 top-full` menus (sessions, vault)
   must keep their `relative` wrapper; `max-w-[calc(100vw-2rem)]` must not
   re-anchor them to the left edge.
3. **`overflow-hidden` on the terminal card** — confirm wrapping never
   hides/clips a control.
4. **No viewport emulation in browser MCP** — verify by shrinking containers
   via `Runtime.evaluate` (`document.getElementById('terminal-dock')
   .style.maxWidth='340px'`) and checking `scrollWidth <= clientWidth` on each
   page, plus a full 1920px regression check before delivering.
5. **Tables that switch to scrollers** must keep column alignment — a wrapper
   div, not a change to the `<table>` itself.

## Files touched

- `src/client/src/components/DashboardLayout.jsx` (nav wrap)
- `src/client/src/pages/Dashboard.jsx` (header + search wrap)
- `src/client/src/pages/AgentDetail.jsx` (gutters + file-modal header wrap)
- `src/client/src/components/Terminal.jsx` (header restructure + dropdown cap)
- `src/client/src/pages/agent/CommandsPane.jsx` (search wrap + dropdown caps)
- `src/client/src/pages/agent/SettingsTab.jsx` (health row wrap)
- `src/client/src/pages/agent/WebTab.jsx` (port grids to single col on mobile)
- `src/client/src/pages/Vault.jsx` (table scroller + column hide + header wraps)
- `src/client/src/pages/CreateAgent.jsx` (name row + ports rows wrap)
- `src/client/src/pages/Onboard.jsx` (horizontal padding)
- `src/client/src/pages/Profile.jsx` (tab bar overflow-x-auto, optional)
