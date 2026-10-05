# Plan 68 — Mission page UI vision (user's redesign ideas — UI ONLY)

## Status: Draft (2026-09-29; audited 2026-10-06) — 6 ideas captured and re-checked
against the built page. Still gathering: **no design, no build.** The audit is
below; it changed two of the ideas and found one live bug next to Idea 3.

Per this file's own rule ("nothing is decided or built until the user says so"),
the audit stops here. Two of the six need a user decision before they can become
a proposal at all — see the audit's two blockers.

Scope: **UI / user-interface changes only.** Layout, columns, rows, buttons,
dialogs, colours, spacing, responsiveness, empty states, loading states. No
backend, no API, no tmux, no MCP, no data-model changes unless the UI forces
one (and then it is noted as out-of-scope, not built here).

This file is the collection point for how the user wants the Mission page to be.
The user will brain-dump ideas here; each idea gets its own section below with
the user's own words kept, then a short interpretation + open questions. Nothing
is decided or built until the user says so.

Related: plans/53-mission-workspace.md (the built 3-column page — the thing
being redesigned), plans/62-mission-liveness-truth.md, 63, 64, 65 (open Mission
work that this vision may confirm, change, or supersede).

---

## How we work this file

1. User drops an idea (one message, one voice note, one rant — any size).
2. Agent appends it as a new `###` section below, numbered (Idea 1, Idea 2, …),
   dated, with the user's words quoted first, then `Interpretation:` and
   `Open questions:` — no solving yet.
3. When the user says "enough, design it", we turn the pile into a proposal
   with phases and checklists, and flip `## Status:` to Proposed.

---

## Ideas (inbox)

### Idea 1 — Remove the This-project / All-projects toggle; selection drives the sessions list (2026-09-29)

User's words:

> So first of all everything is about the missions page. In the missions page
> we have a toggle of this project and all project I don't want this project
> only keep all projects by default list all the projects and on the right hand
> side where the projects listing is listed the one project that I select it
> will show me sessions only for that project if I don't select any project it
> will show me all projects

Interpretation (UI-only reading):

- Delete the `msn-scope-toggle` segmented control (`This project` / `All
  projects` buttons + `msn-scope-row`) from col 2 (`SessionList.jsx` ~L463-490).
  No replacement control.
- Col 1 (projects) always lists ALL projects.
- Col 2 (sessions) filtering is driven purely by col-1 selection:
  - No project selected → col 2 shows sessions from ALL projects (each row
    keeps its project name badge, as today in `all` scope).
  - One project selected → col 2 shows only that project's sessions.
- This kills the `scope` UI state on the page (store `scope`/`setScope` stays
  or goes as a code decision later — UI-wise the toggle is gone).

Open questions (for user, later):

- How to de-select back to "all"? Click the selected project again to
  toggle off, or is there always one selected once you click?
- When filtered to one project, should each session row still repeat the
  project name, or hide it (redundant) until back in "all" mode?
- Header text for col 2 in each state ("Sessions" vs "Sessions — <project>")?

### Idea 2 — Refresh keeps the whole Mission page state (2026-09-29)

User's words:

> And one more thing, one refresh, the whole mission page will keep its state
> of which project I have selected which session is open and what terminal is
> open everything will be kept there after I refresh the page also.

Interpretation (UI-only reading):

- Today the store (`src/client/src/stores/mission.js`) holds
  `selectedProjectId`, `selectedSessionId`, `openSession`, `scope`,
  expanded/collapsed col state only in memory — a browser refresh resets all
  of it (no `localStorage` persistence found).
- Wanted: after refresh, the page restores exactly what the user saw —
  selected project highlight (col 1), selected session (col 2), open terminal
  session (col 3, re-attached, not restarted), plus column widths / folded
  state if those count as "everything".
- UI-wise this is "nothing visibly resets on reload". The mechanism (URL
  params vs `localStorage` vs both) is a design decision for later — noted,
  not chosen here.

Open questions (for user, later):

- If the saved session/project was deleted while away (or on another tab),
  what should the page show — fall back to all-projects empty state?
- Should the terminal re-attach silently, or show a brief "reconnecting…"
  state?

### Idea 3 — New session duplicates itself once chatting starts (all-projects list) (2026-09-29)

User's words:

> One more thing that happens in all project listing in sessions is when I
> create a new session, it starts without a session ID. Then I start chatting
> with it. New session ID is created internally and it lists a different
> session listing. So basically I am chatting already in one session and that
> same session is listed again.

Interpretation (UI-only reading):

- Today col 2 merges two sources into one list (`SessionList.jsx` ~L402-420):
  live mission rows (keyed by tmux id) + agent history rows (keyed by the
  agent's session id). Same-conversation dedup works only when the live row
  already carries `agent_session_id` (`liveAgentIds.has(h.id)`).
- A fresh `+ New session` starts with NO `agent_session_id`. After the first
  chat the agent mints one internally, history starts returning it — but the
  live row still has none, so the filter misses and the SAME conversation
  renders twice: the live row you are chatting in + a new history row for it.
- Wanted: one row per conversation at all times. The live row you are talking
  to never gains a twin — the history entry attaches to (or hides under) it
  the moment the id exists.

Open questions (for user, later):

- Should the merged row visibly change when the id lands (e.g. title fills
  in), or just silently stay one row?
- Does this happen in single-project mode too, or only noticed in all-projects?

### Idea 4 — Split terminal panes side by side, VS Code style (2026-09-29)

User's words:

> In the terminal pane where we are showing the terminal When we click on a
> session open that session in the terminal then when the terminal session has
> one terminal in it show a window pane icon in the sessions listing when I
> click on the window pane icon that session will open side by side with the
> previous terminal And I can open how many terminal listings that I want side
> by side just how VS Code does in its terminal.

Interpretation (UI-only reading):

- Today col 3 (`Mission.jsx` ~L563-668) shows exactly ONE session: `openSession`
  → one `<Terminal>`. Clicking another session row replaces it.
- Wanted: col 3 becomes a pane group, VS Code terminal style —
  - clicking a session row opens it in the terminal (as today, first pane);
  - once at least one pane is open, each session row shows a split/window-pane
    icon (row action, next to close/lock);
  - clicking that icon opens that session BESIDE the current one, not instead
    of it — 2, 3, N panes side by side, each with its own `<Terminal>`;
  - panes presumably closable individually, resizable between each other,
    VS Code-like.
- This replaces the single-`openSession` col-3 model with an open-panes list
  (active pane + splits). Mechanism for later — UI contract is: rows gain a
  split icon; col 3 tiles panes horizontally.

Open questions (for user, later):

- Row click = replace/focus single pane, split icon = add beside — correct?
- Max panes, or unlimited until it gets too narrow (then scroll vs squeeze)?
- Each pane needs its own header (label + close ×)? Close icon per pane?
- Vertical split only, or horizontal too (VS Code does both)?

### Idea 5 — Multi-select projects (Ctrl+click) filters sessions to the union (2026-09-29)

User's words:

> Also when listing the sessions from our project that project can be multiple
> selected so in the left hand side we have listings of projects I can press
> ctrl and select multiple projects if I select multiple projects all of the
> selected projects their sessions will be listed

Interpretation (UI-only reading):

- Col 1 project rows become multi-selectable: Ctrl+click (and Cmd+click on
  macOS) toggles a project in/out of the selection without clearing the rest;
  plain click selects just that one (as today).
- Col 2 then lists the UNION of sessions across all selected projects (each
  row keeps its project badge, as in today's `all` scope). Extends Idea 1:
  - nothing selected → ALL projects' sessions;
  - one selected → that project's sessions (Idea 1);
  - several selected → those projects' sessions combined.
- Selection highlight becomes multi-row (checkbox-like or multi-highlight
  state); `+ New session` needs a home when several are selected (later).

Open questions (for user, later):

- Plain click clears the rest to one, Ctrl/Cmd toggles — correct? Shift+click
  range too, or Ctrl only?
- `+ New session` with several selected — new in which project (first? ask?)?
- With Idea 2 (persist state): the whole SET restores on refresh, not just one.

### Idea 6 — Probe errors must not render as lines inside the sessions list (2026-09-29)

User's words:

> Also, there are random errors that are shown in the session box. root —
> Command failed: sqlite3 -json /root. That is the wrong place to show errors,
> what the hell.

Interpretation (UI-only reading):

- Today per-project history failures render INLINE in the sessions scroller
  (`SessionList.jsx` ~L530-540 `msn-history-errors`: one faint
  `<project> — <error>` line per failed project, sitting between the group
  header and the rows). A line like `root — Command failed: sqlite3…` reads
  as a broken session row, not as an error notice.
- Wanted: errors belong to an ERROR surface — the column's error bar
  (`msn-error-bar`, as `sessionsError`/`allError` already use ~L495-500), a
  banner, or a marker on the failing project row in col 1 — never as
  pseudo-rows inside the session list. Raw tool stderr (`Command failed:
  sqlite3 -json …`) must also be translated to human words there ("couldn't
  read this project's history"), with the raw text one click away at most.
- Verified 2026-09-29: the `root` in the user's report is a real project row
  (`root`, `pad-opencode-proj` on `/root`) — known junk-row phenomenon (see
  AGENTS.md coordinate-click gotcha). Its history probe fails, producing
  exactly this line. Deleting the row would remove THIS instance, but the UI
  complaint stands regardless: any project's probe failure renders as a fake
  row today.

Open questions (for user, later):

- One shared error bar stacking all failures, or a ⚠ badge on the failing
  project row in col 1 (or both)?
- Retry affordance on the error ("try again") or silent next-poll retry?

---

## Audit (2026-10-06) — each idea re-checked against the built page

Nothing was changed. This is what each idea would actually mean today, and two
findings that change the ideas themselves.

| Idea | State today |
|---|---|
| 1 — drop the scope toggle | **Open.** Toggle alive at `SessionList.jsx:487`. |
| 2 — refresh keeps page state | **Partly already true** — see below. |
| 3 — fresh session duplicates itself | **Cause FIXED**; a sibling cause is live. |
| 4 — VS Code split panes | **Open.** Col 3 renders one `<Terminal>`. |
| 5 — multi-select projects | **Open**, blocked on Finding A. |
| 6 — probe errors as list lines | **Open.** Still pseudo-rows (`SessionList.jsx:555`). |

**Idea 2 is roughly 3/5 done already.** `Mission.jsx` already persists three keys
in `localStorage`: `pad-mission-col1`, `pad-mission-col2` (column widths) and
`pad-mission-col1-collapsed`. What resets on refresh is exactly the three things
the user named — `selectedProjectId`, `selectedSessionId` and `openSession` —
because those live only in the store. So "column widths / folded state if those
count as everything" is answered: they already survive. The remaining work is the
selection and the re-attach, and the re-attach is the interesting half, because
restoring `openSession` is what makes plan 68's reopen guard *the thing that runs
on every page load*.

### Finding A — the no-selection state Ideas 1 and 5 both assume is currently unreachable

Both ideas define the union case as "nothing selected → all projects' sessions".
The store cannot be in that state: `fetchAll` writes
`selectedProjectId: projects.some(...) ? s.selectedProjectId : projects[0]?.id || ''`
(`stores/mission.js:144-146`), so after every load a project is selected even if
the user never clicked one. `selectedProjectId` is a single string, not a set, so
Idea 5's multi-select is a type change, not a tweak.

This is a decision, not a detail: a persistent no-selection state is the honest
way to say "I'm looking at everything", but it also means the col-2 header, the
`+ New session` target and the empty state all need a defined answer for "no
project chosen" — which they currently avoid by always having one.

### Finding B — Idea 3's cause is fixed, but the duplicate-row symptom has a second source

Plan 52 R7 (commit `6d406ef`, 2026-09-30) mints the conversation *before* the pane,
so a fresh session now carries its `agent_session_id` from the first read, and the
client's `liveAgentIds` filter (`SessionList.jsx:426`) can hide the history twin.
The user's report was exactly that case, so the reported bug is addressed.

But `agent_session_id` is **write-once at INSERT** — there is no `UPDATE` anywhere
in `src/` that sets it — and measured on the live DB, **3 conversation ids are each
carried by more than one `mission_sessions` row**, one of them by 4:

```
ses_f2591bc67ffefXs4OOKEgjBUIo  4 rows  all schlorp, all origin=human, labels identical
ses_f20f8d4d3ffeOMPpxyKsx42FLi  2 rows  paddock
ses_f20864bb2ffeBhMSm7brhXXESU  2 rows  schlorp
```

Every duplicate is the same conversation, same project, same label, **different
`tmux_id`**, and two pairs share a `created_at` to the millisecond — the signature
of one click firing twice and resuming the same conversation into two panes. No
row-level dedup can see this: the client filter removes *history* rows that match a
live one, never one *live* row that matches another. And the cost is worse than a
duplicate line — two TUIs are attached to one conversation.

Open question this raises (new, and it is a product call): should a second start
that resumes an already-attached conversation be **refused** (one pane per
conversation), or allowed and deduped in the listing? All the pre-R7 duplicates
predate R7, so this may be a one-time data artefact rather than a live path — worth
the user's judgement before anything is designed around it.
