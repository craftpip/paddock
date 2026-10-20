# 93 — URL app state and popup history

## Status: Complete (2026-10-19) — all 6 phases done. Phases 1–5 as recorded
below, including the full Phase 5 browser proof sweeps of 2026-10-18/19 (Back/Forward
+ direct links, zero-POST restoration with positive controls, dirty keep/discard
through Forward, nested popup stack, denied/deleted targets, transient-failure
recovery, desktop/390px both themes, suites all green on unchanged code).
Reviewed and approved 2026-10-19; absorbed into
`docs/reference/components/navigation.md` (discard-destination rule, discard→Forward
reopens popup with saved values, tolerant transient-failure behavior); file archived.

## Goal

Keep navigable app state in the URL: selected project/session, views/tabs/filters,
and which popups are open. Back and Forward restore those states; refresh and a
copied link open the same view. Navigation restores UI, not previously executed actions.

Use a reusable URL-state and popup-navigation layer across the app. Mission is the
first complete flow, including runner setup's Settings/Prompts/Callbacks sections.
See [the grouped order](94-runner-and-navigation-plan-groups.md). Integrate with
plans 91/92's reusable dialog without coupling the URL parser to their implementation.

## Current findings

- `src/client/src/App.jsx` already uses React Router's `BrowserRouter`. Agent tabs
  and Profile tabs have routes; extend this router rather than adding another history owner.
- `pages/Mission.jsx` keeps project/runner dialog descriptors in component-local state.
- `stores/mission.js` restores selections/open-session snapshots from localStorage.
  `openSession` is deliberately independent of the selected listing project/scope.
- `selectSession` is an explicit row-open action and may auto-reopen an exited TUI.
  URL hydration cannot blindly call that action: Back/Forward/reload must not launch
  processes or spend tokens merely to reconstruct a view.
- Agent workspace already uses `?scope=...&path=...` with `useSearchParams`; other
  overlays such as file dialogs, health/container info and Vault dialogs are local state.
  Preserve existing deep links and audit each page's navigable state during Phase 1.

## Exact user journey

1. Open Mission and choose project A, then session A1. URL identifies both the list
   selection and the open terminal. Selecting A2 pushes one history entry.
2. Open Configure on A2's runner → URL includes the popup and runner ID. Select
   Prompts/Continue or Callbacks/usage exhausted → URL identifies that editor choice.
3. Back returns to the previous editor choice, then closes setup, then restores A1
   as the open session. Forward restores the same sequence without saving or sending.
4. Change the listing to project B or All projects while A2 is open. URL preserves
   both facts. Back restores the prior list without replacing/remounting A2's terminal.
5. Refresh/copy link: authorized data loads, then the same session/view/popup opens.
   Saved configuration is shown; unsaved text is never encoded into the URL.
6. Navigate to an Agent tab/workspace folder and open a file/info popup. Back/Forward
   restores route, folder and popup; existing tab/workspace URLs keep working.
7. A deleted/inaccessible target displays an honest unavailable state and removes
   only the invalid URL selection with replace after a definitive response. Transient
   loading/network failures retain requested state and offer retry.

## State schema and scope

Keep existing route paths for pages, agents and tabs. Use namespaced query parameters
for page-specific UI state, parsed/serialized with `URLSearchParams`, not hand-built strings.
Proposed Mission schema, finalized in a typed/validated codec before UI changes:

| Parameter | Meaning |
|---|---|
| `project` | Listing's selected project ID; absent means no project selection |
| `view` | `project` or `all`; explicit URL overrides last-view preference |
| `session` | Open Mission session row ID, independent of listing project |
| `conversation` | Optional history-only conversation target, mutually exclusive with `session` |
| `terminalProject` | Owner project for a history-only conversation; resolve session-row owners from server |
| `q`, `filter`, `sort` | Supported listing search/filter/order values from the inventory |
| repeated `popup` | Ordered allowlisted popup descriptors, bottom-to-top |
| `section`, `prompt`, `event` | Runner setup section and selected prompt/callback keys |

Example (IDs illustrative):

```text
/mission?project=p1&view=project&session=s2&popup=runner-settings:r2&section=prompts&prompt=continue
```

Do not invent filters the app does not have. Catalogue actual navigable state on
every route before implementation, including open queue/plan viewers, file editors,
project create/edit, runner create/configure, info dialogs, Vault and Profile forms.
Mark each state as route, query, URL popup descriptor or local draft/preferences.
Completion requires covering this inventory, not just Mission.

Popup descriptors contain only a registered type and validated resource/context IDs.
Registry resolves fresh authorized records; never serialize full objects, executable
command strings, React callbacks or arbitrary file access into a descriptor. Define
allowlisted parent/child combinations and a small maximum stack depth. Invalid popups
do not overlay unrelated pages. Preserve unknown unrelated query parameters when
patching a page's state; reject malformed owned parameters predictably.

Secrets, PINs, passwords, prompt/script contents, unsaved forms, terminal input/output,
provider errors and live process state never belong in URLs/history payloads. Column
widths/theme/preferences stay local unless they represent a meaningful navigated view.
The URL describes which UI is open, not whether an action was confirmed or executed.

## History contract

- Push one entry for deliberate project/session/view/tab/folder selection, opening
  a popup, opening a nested popup and switching a substantive editor section/type.
  Clicking an already-selected state is a no-op. Search typing uses debounced replace;
  filters/sort use one push per committed user change.
- Popstate/hydration never pushes. Polls, refreshes, loading state and backend status
  changes never create entries. Canonicalization uses replace only when necessary.
- Back unwinds the top popup before earlier navigation; Forward reopens it. Close/X/
  Escape follows Back only when a recorded same-app parent entry is known; on a direct
  link with no parent, replace the URL removing the top popup instead of leaving the app.
  Store only non-sensitive parent-entry metadata in router state.
- One shared close/navigation operation handles overlay, Escape, footer Cancel and
  browser Back. Keep focus trap/restoration consistent with the popup stack.
- Dirty forms offer keep editing/discard when navigation would unload them, including
  Back/Forward. Use the installed React Router's supported blocker mechanism; verify
  its BrowserRouter support before coding. If a data router is required, migrate the
  existing route tree intentionally without a second hand-written history controller.
  Do not fight popstate with ad-hoc compensating pushes or create navigation loops.
- Preserve unsaved drafts in memory keyed by resource/form and history context during
  same-tab popup/section navigation. Discard only explicitly; after refresh/shared link
  use saved server values. Keep secrets/drafts out of URL and history serialization.
- Confirmation/permission dialogs can restore their visible intent if their target
  is still valid, but approval is never restored. Forward/refresh cannot submit the
  action, answer permission or replay a stale confirmation. Fetch/revalidate context;
  ephemeral notification/error prompts without reconstructible intent stay transient.
- Successful form submission updates the URL to the resulting saved view and closes
  its popup deliberately; Forward can reopen a form but cannot resubmit it. Stale IDs
  normalize with replace, preserving unrelated state.

## URL and store ownership

The URL is the source of truth for navigable state. Add a shared codec/controller,
route-specific schemas and a popup registry; use router navigation APIs throughout.
Components emit navigation intent rather than setting parallel local popup booleans.

Mission hydration must resolve a session independently of whatever rows the current
listing contains. Add a read-only store action that restores its fresh `openSession`
snapshot and pane state without `autoReopen`, starting history conversations or
calling Run/Resume/recovery. If the pane is gone, show its notice/reopen action until
the user explicitly requests recovery. Existing direct row-click auto-reopen behavior
is preserved; history restoration is a separate origin with separate side effects.

Changing only query/popup/list state for the same session must preserve Terminal's
component/WS identity. Selecting a different open session changes it deliberately.
If a history conversation has no Mission row, restore a read-only history view with
an explicit resume action; navigation alone must not create a session.

Initial URL hydration wins over localStorage. Only a truly bare page URL may use
the existing last-view preference once, followed by replace to a canonical URL;
explicit query state and history entries with cleared selections must never be
overwritten by saved preferences. Revalidate persisted snapshots as data, not authority.
Authentication preserves only safe same-origin return URLs; restore after login
without opening unauthorized data or replaying actions.

Use a navigation generation/request token. If the user quickly goes A → B → Back,
late A/B fetches may refresh caches but cannot overwrite the current route's view.
Do not clear the pinned terminal while lists/refetches are temporarily empty. Loading,
missing and unreadable outcomes remain distinct; URL canonicalization never guesses
that a failed fetch means a resource was deleted.

## Files and implementation order

Primary files: `src/client/src/App.jsx`, `pages/Mission.jsx`, `stores/mission.js`,
`components/SessionList.jsx`, `RunnerDialog.jsx`, `ProjectDialog.jsx`, `QueuePanel.jsx`,
the router/navigation controls and page-specific dialogs from the inventory.
Add shared `lib/url-state` codec/controller and popup registry modules following
client conventions; avoid backend changes unless a read-only target resolver is missing.
Use `AgentDetail.jsx` workspace URL behavior as a compatibility case, not a duplicate codec.

- [x] Phase 1 — Inventory every route's meaningful state/popups; decide schema,
  history semantics, installed Router blocker support and restoration-origin contract.
- [x] Phase 2 — Build/test codecs, router integration, popup registry and navigation
  intent/dirty-form handling with strict no-action hydration semantics.
- [x] Phase 3 — Implement Mission project/scope/session/history restoration and
  popup/queue/plan/setup section navigation; preserve terminal identity and local drafts.
- [x] Phase 4 — Integrate remaining routes/popups from inventory, preserving existing
  agent/tab/workspace links, auth return paths and explicit action confirmations.
- [x] Phase 5 — Verify unit/store navigation sequences and actual browser Back/Forward,
  refresh/direct links, async races and responsive popup behavior.
- [x] Phase 6 — Document schema/navigation behavior after review, update status and
  resolve every inventory item before declaring completion.

## Required proofs

Run focused suites individually. Test codec round trips, encoding/Unicode, omitted/
invalid IDs, query preservation, stack depth/parent restrictions and canonicalization.
Behavior tests must subscribe to state sequences, not just compare final URL strings.

- Browser: project A → A1 → A2 → runner setup → Prompts/Continue → Callbacks/event.
  Back/Forward restores each visible state and URL; repeat after refresh/direct link.
- Listing project B/all while A2 is open: Back/Forward preserves col-3 identity.
  Count Terminal mounts/WS reconnects; popup-only changes do not reconnect it.
- Confirm restore of dead and history-only sessions performs zero POSTs for start/
  restart/relaunch/Run/Resume/send, zero TUI creation, callbacks or script execution.
  Positive twin: explicit reopen/resume still performs its intended action.
- Controlled delayed fetches during A/B/Back never render a stale selection/popup.
  Offline/transient failures keep the target URL; real deletion/denial resolves clearly.
- Popup direct link Close stays in app; nested Back closes only top; Forward reopens.
  Dirty navigation keep/discard works for Back, Forward, Escape and cross-page links
  without a history loop; section changes retain drafts and never leak them into URL.
- Inventory cases: agent tabs/workspace folders/file dialogs, queue/plan viewers,
  project/runner setup, info dialogs and applicable Vault/Profile forms. Stale destructive
  intents/permission dialogs do not execute or approve on navigation.
- New browser tab/login restores the safe authorized view, not stale localStorage.
  URLs/history contain no sensitive form contents. Bare-page fallback is tested separately
  from explicit empty-selection states.
- Desktop/390px and both themes: focus/stack/scroll/footer behavior. Use real browser
  history tools, not just setting component state. Inspect console/request failures,
  build/parse client and verify the built page. Count Mission projects afterward.

Do not use the user's live session for action tests. Update status/checklist before
leaving; docs absorption respects the existing review hold.

## Implementation inventory — 2026-10-15

Installed React Router is 7.18.1. The app now uses `createBrowserRouter` with the
existing route tree and a shared `NavigationProvider`; `useBlocker` runs in that
data-router context. No second history owner or compensating popstate handler was
added. Non-sensitive popup-parent metadata is the only navigation bookkeeping
stored in router state; draft contents stay in memory.

| Route/surface | Navigation ownership | Local/transient state |
|---|---|---|
| Login / Setup | Existing routes; validated login `returnTo` | Credentials, setup fields, notices |
| Fleet | `/agents` and debounced `q` | Polled stats, cards' execution actions |
| Agent creation | Existing create/progress routes | Existing form drafts, advanced preferences, job stream; no create replay |
| Agent onboarding | Existing agent/onboard route | Credential/command inputs and action output |
| Agent tabs | Existing slash routes; deliberate changes push, repeated selection is a no-op | Dock dimensions, terminal input/output |
| Workspace | Existing `scope`/`path`, URL file and move descriptors | File draft in memory, upload/create inputs and progress |
| Agent logs | URL `tail` selection | Live logs and auto-scroll preference |
| Agent sessions/activity | Existing routes | Fetched rows; no additional navigable filters exist |
| Agent config | Existing tab route; dirty navigation gate | Config draft never enters URL/history |
| Agent Settings | URL container-info and health-info descriptors | Build/volume drafts, action confirmations and job dialogs |
| Agent Web | Existing tab route; dirty navigation gate | Publish/SSH/port drafts, credentials, action/job dialogs |
| Vault | URL add/edit and set/reset-PIN intent | Secret/PIN contents; operation-specific unlock gate remains transient because it depends on an unsaved operation |
| Profile | Existing general/MCP-key/users routes; URL user-create and password-reset forms | Passwords and drafts in memory; one-time API-key reveal stays transient |
| Environment Config | Existing route; dirty navigation gate | Config values and apply/restart/recreate confirmations |
| Global backups | Existing route | Placeholder; no popup/filter exists |
| Mission listing | URL project/all scope and `subfolders` | Polled rows, widths and folded columns |
| Mission terminal/history | Independent URL `session` or `conversation` + `terminalProject` | Verified pane state; explicit recovery/resume only |
| Project/runner setup | Allowlisted popup descriptors; runner `section`/`prompt`/`event` | Form/template/script drafts in memory, never executable URL data |
| Queue/plan picker | URL queue expansion, add/resolve descriptors, `planQ`/`planAll` | Selection/answer drafts; no separate plan viewer exists in the current UI |
| Shared confirm/prompt/alert providers | Transient operation surfaces | Their callbacks/approval/results are not reconstructible navigation and never replay on Forward |

The new history-only resolver returns authorized metadata for the exact transcript
and project folder. It rejects substring/only-file guesses that resolve another
ID and distinguishes missing from unreadable/unknown-folder outcomes. It cannot
start a process, send a prompt or execute a callback.

## Verification and testing pending — 2026-10-15

### Completed non-browser checks

- [x] `url-state.test.js`: 7 passing codec, scope, Unicode, invalid descriptor,
  canonicalization, query-preservation and safe-return tests.
- [x] `mission-navigation.test.js`: 10 passing restoration/race tests, including
  GET-only dead/history restoration, independent owners, pinned snapshots,
  A/B/Back responses, fresh re-entry and explicit-reopen positive control.
- [x] `client-navigation-parse.test.js`: 3 passing checks: full client parse/import
  resolution, lexical unbound-reference scan and installed data-router SSR render.
- [x] `conversation-view.test.js`: 5 passing exact-ID, folder, metadata-only,
  unreadable/missing and validation-order tests.
- [x] `mission-reopen.test.js`: 8 passing existing recovery-order regressions.
- [x] `plan-mcp.test.js`: 57 passing existing store/MCP regressions.
- [x] Backend syntax checks and `git diff --check`.
- [x] Production Vite build; webui restarted and startup logged on port 6789.
- [x] Live read-only API probes: invalid conversation ID returns 400 with
  `conversation_id_invalid`; an authorized saved conversation returns 200 with
  exact identity and metadata only. No session/runner action was requested.

### Browser verification — partial (2026-10-18)

- [x] In agent-owned cloakbrowser only, selected the inactive `Runner 91 prompts proof` project: the URL became `project=prj_6dc3afcee3edf30b&view=project` with no mutation request.
- [x] Opened its inactive runner's Configure popup, then Prompts/Continue and Callbacks/init. Browser Back restored Prompts, Settings and the project view; Forward restored Settings, Prompts and Callbacks with the corresponding URL state.
- [x] Hard-refreshed the direct Callbacks URL and directly opened the Prompts URL. Each restored the expected popup/section; the 390px viewport rendered a 358px-wide in-bounds dialog with no internal overflow.
- [x] Tested direct-link popup close at 390px using the popup's own close control. It stayed in Mission and removed the popup query state rather than leaving the app.
- [x] Directly hydrated the project's non-live `msn_8e875a9bdaf54c1b` session, then switched to `view=all`. Requests for the session restoration were GET-only; no start, restart, relaunch, Run, Resume or send request was observed.
- [x] Desktop and 390px popup checks in dark and light themes had no console messages or failed network requests. The Mission project count was still 9 after testing; no project was created or deleted.
- [x] Focused suites run individually: `url-state.test.js` (7), `mission-navigation.test.js` (10), `client-navigation-parse.test.js` (3), `conversation-view.test.js` (5), `mission-reopen.test.js` (8), and `plan-mcp.test.js` (57), all passing.
- [x] Dirty runner Settings form: changed the name, requested the Agents navigation,
  chose Discard, and landed at `/agents`. The guard now permits the exact blocked
  destination after discarding rather than blocking it again.
- [x] Dirty runner Settings Cancel and Escape each opened the discard confirmation.
  Keep editing retained the typed draft; Escape then Discard removed only popup
  state and returned to the selected project.
- [x] With the designated test-project session `msn_8e875a9bdaf54c1b` open,
  runner Configure and Settings → Prompts navigation retained the exact same
  `.xterm` DOM node and one terminal instance. Popup-only URL changes did not
  remount the terminal.
- [x] While that same test session and runner popup were open, switching the
  listing from `Runner 91 prompts proof` to `Runner 90 verification` retained
  the exact terminal DOM node and one terminal instance. List-only state does
  not remount the terminal.
- [x] The test-session terminal/navigation probe produced no console messages
  and no failed network requests.

### Browser verification — Phase 5 sweep 2 (2026-10-19)

Fixture notes: the originally designated session `msn_8e875a9bdaf54c1b` was
deleted via the page's Close button (a page Close deletes the session row —
`mission.js closeSession`); the labeled replacement is
`msn_c504780b0df807d0` ("Runner: prompts proof", live) in the same project.
The old "test" project's dead fixture session `msn_23d7e18fd107e443` was
restarted with its own explicit Reopen button as a positive control and is live
again. Mission project count stayed 9 all session (checked at the end).
Suites were NOT re-run on 2026-10-19 (docker unreachable from the pad shell);
code is unchanged since the 2026-10-18 suite run above.

- [x] Full project/session/section/popup Back/Forward sequence on the designated
  project: project 91 → live session → second session → Configure popup →
  `section=prompts&prompt=continue` → `section=callbacks&event=init`. Every Back
  and Forward restored the exact URL and DOM.
- [x] Direct-link hard refresh of the deepest URL
  (`...&section=callbacks&event=init`) restored the full deep state GET-only;
  console clean.
- [x] Dirty form keep/discard through history: typed a draft name; section-level
  Back was intentionally not gated (draft retained per contract); popup-closing
  Back showed "Discard changes?" → Keep editing kept popup/URL/draft; next Back
  + Discard closed it; `history.forward()` reopened the popup showing the
  SAVED name with no stale draft. Mid-session requests were read-only GETs plus
  the read-only prompts preview POST.
- [x] Conversation-history row restore (session `msn_0a8c84e0aa62c2e9`) was
  GET-only.
- [x] Zero-POST dead-session restoration: direct navigation to dead
  `msn_23d7e18fd107e443` rendered the dead notice + Reopen button with zero
  mission POSTs. Positive control: the Reopen button click fired
  `POST /api/mission/sessions/msn_23d7e18fd107e443/restart` (200) and the
  terminal mounted. (Row-click hydration does POST the runner's own session
  resource — that is an explicit user action, not URL restoration; restoration
  paths remained GET-only.)
- [x] Denied/deleted targets: invalid project id 404s → replace to `?view=all`;
  invalid session id with a valid project 404s → only the session param removed
  with replace, project selection and `view=project` preserved.
- [x] Nested workspace popup stack on `/agents/pad-opencode-proj/workspace`:
  file dialog → move dialog stacked; Back closed only the top popup and focus
  returned to the file dialog; Forward restored it; direct-link refresh restored
  both; the top-only close stayed in-app. Vault `?popup=vault-add` refresh
  restored the empty form (no values, safe-return) and Cancel closed it in-app.
- [x] Transient failure: with the app loaded, CDP
  `Network.emulateNetworkConditions` offline killed in-flight hydration; the app
  did not crash, URL state was preserved, no dead-end dialog; after going back
  online the next row click re-hydrated with all 200s. (Hard offline navigation
  before load is the browser's own ERR_INTERNET_DISCONNECTED, not an app path.)
- [x] 390px viewport, dark and light themes with a popup open: dialog in-bounds,
  no horizontal overflow, no console messages, no failed requests (mobile tab
  checked separately in cloakbrowser; theme toggling is local).

Terminal identity (tidied): measured on list-only and popup-only navigation —
both retained the exact terminal DOM node (2026-10-18). The browser request
buffer did not expose WebSocket upgrade entries to count separately.

Plan 87 remains separately deferred. The plan stays retained under the
existing review hold; it is not archived or marked done.
