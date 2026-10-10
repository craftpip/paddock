# Machines Page Responsive — one column, one screen (plan 54)

## Status: Proposed (not started, 2026-09-27) — 0% implemented. Findings measured
live in the browser today (350px + 380px viewports, `Runtime.evaluate` geometry
probes + a throwaway inline-style prototype of both candidate nav treatments); no
JSX/CSS change has landed yet.

## What "the machines page" means here

There is no page called Machines in the SPA. The machines are the **PADs**, and
the page that lists them is the **Agent Fleet** page — `Dashboard.jsx` at
`/agents`, one `AgentCard` panel per machine/container. "All the panels in one
column" = the card grid. Plan 54 makes that page genuinely usable on a phone:
one column of panels, nothing cut off, **no sideways page scroll**.

**Key finding: the grid is already one column below `md` (768px) — the panels
were never the problem. The page-level horizontal scroll is.** A 596px nav
cluster and a 320px header cluster force the document to 685px wide on a 350px
phone, so the "one column" the user sees is a 318px ribbon inside a 685px-wide
page with half the screen empty to the right and the `+ New Agent` button pushed
off-viewport. Fix the shell, and the one column finally fills the screen.

## Measured baseline (verified 2026-09-27, `/agents`, headless 350px & 380px)

| What | Measured | Verdict |
| --- | --- | --- |
| `document.documentElement.scrollWidth` | **685px** vs 350px viewport | ✗ the whole page scrolls sideways |
| Nav link+control cluster (`DashboardLayout.jsx:40`) | **596px** in a 318px nav row | ✗ hard overflow, independent of viewport |
| Page header action cluster (`Dashboard.jsx:100`) | right edge **404px** vs 334px header | ✗ 54–70px overflow (search `w-48` + button) |
| Card grid (`Dashboard.jsx:144`) | `gridTemplateColumns: "318px"` | ✓ already one column |
| Card internals at 318px | 0 elements with `scrollWidth > clientWidth` | ✓ name truncates, pill `shrink-0` |
| Fleet resources strip (`Dashboard.jsx:118`) | already `flex flex-wrap` | ✓ |

Because the cluster is a fixed 596px, the nav overflows at **any viewport
narrower than ~717px** (596 cluster + 89 logo + 32 gutters). It is not a
360px-only problem.

## The decision plan 29 got wrong

Plan 29 §A proposes `flex-wrap` on the nav row and calls a hamburger "out of
scope … sufficient at 360px". Both were written when the nav had 4 links; it has
6 links + 3 controls today. Prototyped live with inline styles at 350px:

- **`flex-wrap` on the nav row + cluster** → horizontal overflow gone
  (`scrollWidth` 685 → 350) but the sticky header grows **56px → 128px** (the
  cluster alone wraps to 96px / 3 rows). A sticky nav eating 15% of an 844px
  phone screen, on every page, to make a one-column list readable — bad trade.
- **Single-line nav, cluster scrolls horizontally** → `scrollWidth` 350 ✓, nav
  stays **56px** ✓, cluster scrollable 245 visible of 607 ✓, logo never moves.

**Chosen: the single-line swipeable nav.** Flex-wrap is the fallback only if the
user rejects swiping to reach Configs/Backups/logout on a real phone.

## Phases

### Phase 1 — kill the page-level horizontal scroll

1. **Nav — `src/client/src/components/DashboardLayout.jsx`**
   - Nav row (`:35`): add `overflow-x-auto overscroll-x-contain` +
     `[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`; keep
     `flex items-center justify-between h-14` (no wrap, so the bar stays 56px).
   - Link+control cluster (`:40`): add `min-w-0 flex-1 overflow-x-auto`; every
     child link/button/divider gets `shrink-0` so nothing is squashed to nothing.
   - Add a right-edge fade (`mask-image`/gradient overlay) so it is visible that
     the row scrolls — a scrollable nav with no affordance reads as "those
     links are gone".
   - Scroll the **active** link into view on mount (one `ref` +
     `scrollIntoView({ block: 'nearest', inline: 'center' })`). This is the only
     JS in the plan; without it you land on Configs and can't see that you're on
     Configs.
   - Anti-pattern, explicitly forbidden: `overflow-x: hidden` on `body`/`html`.
     It hides the symptom and makes the logout button genuinely unreachable.
2. **Page header — `src/client/src/pages/Dashboard.jsx` (`:93-116`)**
   - Header (`:93`): add `flex-wrap gap-y-3`.
   - Action cluster (`:100`): `flex flex-wrap items-center gap-3 w-full
     sm:w-auto sm:justify-end`.
   - Search input (`:107`): `w-48` → `w-full sm:w-48`.
   - `+ New Agent` keeps `whitespace-nowrap`; on a phone it sits on its own row
     under a full-width search.

### Phase 2 — one column, guaranteed and verified

- Keep `grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3` (`:144`) — measured
  one column at 350px already; the fix is Phase 1 making the viewport honest.
- **Open question for the user:** leave the 2-column step at `md` (768px → two
  ~356px cards, readable) or push it to `lg` (1024px) so a portrait tablet is
  also one column. One-word change either way; default = leave at `md`.

### Phase 3 — page polish (only what this page needs)

- Fleet strip (`:118`): hide the `w-px h-4` divider below `sm`
  (`hidden sm:block`) — at a wrap point it reads as a stray line.
- `AgentCard.jsx`: card action buttons are `p-2` (~32px). Bump to
  `p-2.5 sm:p-2` for a ~40px touch target on phones. Card layout otherwise
  untouched (measured fine at 318px).
- Loading skeleton (`:82`) and both empty states (`:151`, `:167`) already fine.

### Phase 4 — verify live (not from a code read)

Per the golden rules, nothing is delivered untested:

- `cd src/client && npm run build && docker restart paddock`.
- 350/360/390/414px on `/agents`: `document.documentElement.scrollWidth ===
  document.documentElement.clientWidth`; nav height still 56px; grid resolves to
  one column; **every** control reachable without sideways scrolling (including
  the logout button at the end of the nav cluster); active link scrolled into
  view; the right-edge fade present.
- Click a card's Start/Stop in the browser and assert on the resulting DOM
  (status pill changes, no layout jump) — not just that the handler fired.
- Desktop regression at 1024 / 1440 / 1920: nav row and header row visually
  unchanged (both still one line, nothing re-ordered).
- Confirm in the user's own browser at http://10.69.1.164:6789 too, not only in
  the headless MCP tab.

## Risks

1. **Focus rings clipped** by the cluster's `overflow-x-auto` — the logout
   button sits at the scroll edge. Check its ring; pad the cluster (`px-1`) or
   use `outline-offset` so nothing is visually cut.
2. **Hidden links with no affordance** → fade mask + scroll-active-into-view are
   both required, not nice-to-haves.
3. **Desktop drift** — every rule must be additive (`sm:`/`md:`) or only relax a
   floor. Verify `lg+` is byte-identical before delivering.
4. **Sticky-nav height change** is the regression to watch: it is shared by every
   page (Vault, Configs, Backups, Profile…), so a mistake here is felt fleet-wide.
5. `min-w-0` is required on any flex child that must truncate; without it the
   name/label refuses to shrink and the row overflows again.

## Out of scope

- The rest of plan 29 (terminal, commands pane, vault, create-agent, settings) —
  plan 29 keeps those; plan 54 only takes the machines page + the shared nav.
- A user-facing 1/2/3 **column-count toggle** (persisted layout preference).
  Recommend skipping: the grid is already one column exactly where it needs to
  be, and a toggle means state + JS + a settings surface for no gain.
- xterm / terminal internals.
- Old EJS routes (dead code, plan 09).

## Relationship to plan 29

Plan 29 owns whole-SPA responsiveness. Plan 54 is the machines-page slice and
**supersedes plan 29's §A nav treatment and §B header treatment** with the
measurements above. Plan 29's "Out of scope: a hamburger/drawer nav is
sufficient" note is stale — 6 links + 3 controls = 596px, measured. When 54 is
complete, tick 29's §A/§B items off and cross-link them to 54 rather than
implementing them twice.

## Files touched

- `src/client/src/components/DashboardLayout.jsx` (nav scroller + fade +
  scroll-active-into-view)
- `src/client/src/pages/Dashboard.jsx` (header wrap, search full-width, strip
  divider)
- `src/client/src/components/AgentCard.jsx` (touch targets only)

## Doc absorbed into on completion

- `docs/reference/pages/overview.md` → § Dashboard (`/agents`) and
  § Consistent Page Layout (the narrow-viewport contract: one column of cards,
  swipeable nav, no page-level horizontal scroll).
- `docs/reference/components/ux.md` → add the shared "narrow-viewport shell"
  rule if the nav scroller is reused by other pages.

## Progress checklist

- [ ] Phase 1.1 nav scroller (DashboardLayout.jsx) — built + verified in browser
- [ ] Phase 1.1 fade mask + active-link scroll-into-view
- [ ] Phase 1.2 header wrap + full-width search (Dashboard.jsx)
- [ ] Phase 2 one column verified (`scrollWidth === clientWidth` at 350px)
- [ ] Phase 2 open question answered (2-col breakpoint `md` vs `lg`)
- [ ] Phase 3 strip divider + card touch targets
- [ ] Phase 4 narrow + desktop verification screenshots
- [ ] Plan 29 §A/§B cross-linked, marked done
- [ ] Absorbed into `docs/reference/pages/overview.md`, plan file deleted
