# Global Search

## Status: Proposed — 2026-10-24

0/5 phases complete. Add a global search dialog opened with Ctrl+F (and Cmd+F on
macOS), covering agents, Mission projects, sessions/conversations and plans.

## Requested Outcome

From anywhere in the authenticated Paddock UI, pressing Ctrl+F opens one global
search modal. A dedicated Search button in the shared header opens the same
modal. The user types a query and can find an agent, project, session or plan
without first navigating to its owning page. Selecting a result takes the user
to the relevant existing page and opens/selects that item where possible.

## User Journey

1. On any authenticated page and from any focused element, press Ctrl+F (or
   Cmd+F on macOS). The browser's built-in find UI does not open; the Paddock
   search dialog opens and focuses its query field. The shared header also has a
   clearly labelled Search button that opens the same dialog.
2. Type a query. Results update after a short debounce. Before any query, show a
   concise hint and the supported result categories. While searching, show a
   loading state; show a useful no-results state when nothing matches. A failed
   source read shows an actionable error and retry, not a falsely complete empty
   result list.
3. Search results are grouped and labelled by type: Agents, Projects, Sessions,
   and Plans. Each result has a recognizable title and useful context (agent
   name/status; project name/folder/agent; session title/project/agent; plan
   title/path/project or PAD). Matching is case-insensitive and covers the
   displayed title plus relevant identifying context.
4. Arrow Up/Down changes the active result, Enter opens it, and Escape closes
   the dialog. Clicking a result has the same effect. The active result is
   visibly highlighted and kept in view. A result count and keyboard hints are
   available to assist keyboard and screen-reader users.
5. Selecting an agent opens `/agents/:agentId`; selecting a project opens
   `/mission` with that project selected; selecting a Mission session opens its
   existing Mission session view; selecting an agent-history conversation opens
   its existing conversation view. Selecting a plan opens its owning project or
   PAD context and the existing plan viewer when one exists; otherwise it opens
   the appropriate plans/queue view without inventing an editor. The dialog
   closes only after navigation is accepted, and reopening starts with a clean
   query and selection.

## Scope And Contracts

### Global Shortcut And Dialog

- Mount the search provider/dialog once inside the authenticated application
  shell (`src/client/src/App.jsx` or `DashboardLayout.jsx`) so it is available
  across routes and never appears on login/setup screens. Add a dedicated,
  visibly labelled Search button to the shared `DashboardLayout` header; it must
  open the same dialog as the shortcut on every authenticated route.
- Extend `src/client/src/lib/shortcuts.js` or add a dedicated global shortcut
  hook. Handle Ctrl+F and Meta+F, call `preventDefault()`, and do not trigger
  while composing IME input. Handle the shortcut regardless of which page
  element has focus, including inputs, textareas, contenteditable editors and
  buttons; opening search transfers focus to the modal query field. The Search
  button remains available as the pointer alternative.
- Reuse `components/ui/Modal.jsx` and established Button/Input primitives. The
  dialog must have an accessible name, labelled input, focus on open, focus
  containment, focus restoration on close, and Escape dismissal. Do not create a
  second modal/focus-management system.
- Use a stable hook namespace for the new interface (for example
  `global-search-*`) for browser verification and tests.
- Search must not mutate Mission selection, open a terminal, start/restart an
  agent, or spend agent tokens. It is a read-and-navigate feature only.

### Searchable Records And Permissions

- Agents: search the authenticated user's accessible fleet using the existing
  `/api/agents` data; include display name/name and type, and show status.
- Mission projects: search accessible project name, agent name and folder.
- Sessions: include Mission session rows and agent conversation history where
  those records are available through the existing Mission service. Search
  session label/title, project, agent and useful identifier. Respect the current
  ownership/access rules and existing result limits; do not treat failed history
  reads as proof that no matching session exists.
- Plans: include active plans in project-scoped and PAD-wide plan folders, and
  archived plans only if the UI exposes them as searchable records. Search title,
  filename/path, project and PAD context. Respect the same access scope and
  workspace browse capability as the existing plans facility; never expose
  another user's project, PAD, workspace path or plan through search.
- Inspect existing routes/services first. Reuse current list data where it is
  already complete and current; add a dedicated authenticated search API only
  for records that cannot be searched correctly without server-side aggregation
  (notably plan folders and potentially large conversation histories).
- If a dedicated endpoint is needed, return typed grouped results, a global
  `complete`/partial indicator and per-source errors. Bound query length, result
  count and work per source; parameterize database matching and validate all
  filesystem paths through the existing plans path helpers. Search is read-only.
- Prefer server-side filtering for large histories and plan collections rather
  than downloading every record to the browser. Define deterministic ranking:
  exact title/name, prefix, then substring; stable type/title tie-breaks. Keep a
  reasonable per-type cap and visibly disclose truncation so a capped result set
  is not presented as exhaustive.

### Result Navigation

- Use existing router and Mission URL/state contracts; do not bypass
  `mission-navigation.jsx` or hand-edit session-selection state in a parallel
  client store.
- Preserve existing user-action semantics. Opening a session may invoke the
  existing explicit row-open behavior, including its established dead-session
  recovery contract; search itself must not launch anything before the user
  selects a result.
- Encode path/query identifiers safely. If an item was deleted or access was
  revoked after the result loaded, show the existing not-found/forbidden page
  behavior or concise recoverable feedback rather than redirecting to an
  unrelated item.
- Plan results must retain their owning scope (project id or PAD name plus plan
  path); do not infer project ownership from a plan folder string alone.

## Implementation Steps

1. Trace existing agent/project/session/history/plan APIs, permission filtering,
   Mission deep-link restoration and plan viewers. Document which sources can be
   searched from existing client state and which require an endpoint. Add tests
   for the endpoint's access scope and path validation before implementing it.
2. Implement bounded search aggregation where necessary. Normalize and validate
   the query, search only authorized records, return stable typed results and
   explicit partial/error/truncation metadata. Add focused tests for matching,
   ranking, limits, inaccessible records, missing plans and unavailable history
   sources.
3. Build the global dialog and shortcut integration. Implement debounce,
   cancellation/stale-response protection, loading/empty/error/partial states,
   grouped result rows, keyboard navigation and focus/accessibility behavior.
4. Add result activation using existing routes and Mission navigation contracts
   for agents, projects, live sessions, history conversations and plans. Ensure
   closing/reopening the dialog does not retain stale selection or trigger
   background actions.
5. Build and integrate the search surface into the authenticated app shell, then
   verify every result category end to end in the browser and update the matching
   reference documentation before absorbing this plan.

## Verification

- Run focused backend search/service/API tests and client shortcut/dialog tests
  individually. Cover case-insensitive matching, exact/prefix/substring rank,
  stable ordering, caps/truncation, malformed/empty/long queries, stale responses
  and per-source errors.
- Verify access control with at least two users/scopes: search must not reveal
  foreign agents, projects, conversations, plan names, paths or result counts.
  Verify PAD-wide and project-scoped plans and the existing workspace-browse
  refusal behavior.
- Build the client, restart the webui, and load the actual served app at
  `http://10.69.1.164:6789`. Confirm Ctrl+F and Cmd+F open the dialog on multiple
  authenticated routes, while textarea/contenteditable editing is not hijacked.
- In the browser, verify the shortcut opens search from a normal page, a focused
  input, a textarea/contenteditable, and another focused control; verify the
  header Search button opens the identical dialog from multiple routes. Assert
  the native browser find UI does not appear. Search and activate one result of
  each type. Assert the
  resulting route and selected/open item in the DOM; for Mission sessions,
  confirm the intended conversation is shown and no unrelated terminal/session
  changes. Confirm plans land in their correct owner context.
- Exercise keyboard-only navigation (focus, arrows, Enter, Escape), focus return,
  screen-reader labels, click activation, empty/loading/error/partial/truncated
  states, rapid query changes, and small viewport layout. Check browser console
  and failed network requests.
- Compare Mission project counts before and after browser testing; do not delete
  unexplained user-created rows.

## Progress

- [ ] Map current searchable sources, API contracts, access boundaries and
  navigation destinations.
- [ ] Implement bounded, permission-scoped search aggregation and focused tests
  where existing APIs are insufficient.
- [ ] Add global Ctrl+F/Cmd+F dialog, accessible keyboard interactions and result
  states.
- [ ] Wire result activation for agents, projects, sessions/conversations and
  plans using existing navigation contracts.
- [ ] Verify end to end, update reference documentation, then absorb this plan.
