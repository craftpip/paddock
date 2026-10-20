# URL Navigation

Routes and query parameters identify the view you opened. Browser history restores that view;
it does not repeat a save, start a worker, send a prompt, approve a permission or run a script.

> Last updated: 2026-10-19

## State

```text
/mission?project=p1&view=project&session=s2&popup=runner-settings:r2&section=prompts&prompt=continue
/agents/pad-example/workspace?scope=container&path=%2Fworkspace&popup=file:%252Fworkspace%252Fnotes.md
```

`src/client/src/lib/url-state.js` validates resource IDs and popup descriptors. The shared
controller in `lib/navigation.jsx` patches only its owned parameters and preserves unrelated
query state. Deliberate selections push history; debounced search and normalization replace it.
Selecting an unchanged view creates no entry.

| View | URL state |
|---|---|
| Fleet | `/agents`, `q` search |
| Mission listing | `project`, `view=project\|all`, `subfolders=1` |
| Mission terminal | `session`, independent of the listing project |
| Saved conversation | `conversation` and its owner `terminalProject` |
| Runner editor | `popup`, `section`, `prompt`, `event` |
| Queue | `queue=open\|closed`; add/resolve popup descriptors |
| Plan picker | `planQ` search, `planAll=1` |
| Agent workspace | Existing `scope` and `path`; file and move popups |
| Container logs | Agent logs route and `tail=50\|100\|500\|1000` |
| Profile | Existing general, MCP-key and users routes; user forms |
| Vault | Add/edit and set/reset-PIN descriptors, never their contents |

Agent tabs, creation progress and onboarding keep their existing routes. Column widths,
terminal size, theme, menus and auto-scroll are preferences or transient UI. Form contents,
secrets, PIN gates attached to an unsaved operation, one-time API-key displays and action/job
dialogs stay out of navigation serialization.

## Popups and Drafts

Repeated `popup` parameters encode an ordered stack. Only registered route/type/context
combinations are accepted; the file-move child must refer to its parent file. The codec limits
stack depth. Resource records are resolved through authorized reads before displaying forms.
Missing or denied records clear only their invalid selection with replace; unreadable targets
retain the link and a retry path.

Opening a popup records non-sensitive same-app parent metadata in router state. Close, Cancel
and Escape go Back to that parent when known. A direct link removes the popup with replace,
so closing it does not leave the app. Successful submissions close deliberately using replace.
An older asynchronous submission cannot close a different popup.

The app uses React Router's data router and one shared `useBlocker` gate. Leaving a dirty editor
offers **Keep editing** or **Discard**, including Back/Forward and cross-page navigation; a
discarded leave is permitted permanently, not re-blocked. After a Discard, Forward can reopen
the closed popup (URL state is history), showing last saved values without the draft.
Changing runner sections or prompt/callback kinds leaves the form mounted and its draft intact.
Same-tab drafts live in the navigation provider's memory, keyed by resource; they are never
written to the URL, `history.state` or new persistent storage. Saving or explicitly discarding
clears the relevant draft. Reloading uses saved server values.

`Modal` traps focus, restores its opener and lets only the top mounted dialog handle Escape.
Its focusable range includes the footer. `SettingsDialog` uses this shell instead of maintaining
a second body-only focus trap.

## Mission Restoration

`useMissionNavigation` applies URL state before attaching a terminal. Only a bare initial URL
can use the last-view preference; explicit cleared selections and history entries override it.
Persisted terminal snapshots are revalidated rather than attached as authority.

`restoreView` resolves a Mission row and its owner independently of the listing. Restoration
uses GETs and never requests recovery. A closed pane shows its explicit reopen control. A fresh
accepted row click can still opt into ordinary auto-reopen; Back/Forward and reload cannot.
Changing only list/popup state preserves the pinned terminal and pane state. Generation tokens
prevent late session, listing and workspace reads from replacing a newer view.

History-only links use `GET /api/mission/projects/:id/conversations/:conversationId`. The route
checks project access before reading the owner's store. `services/conversation-view.js` verifies
the transcript's exact ID and project folder and returns metadata only. A guessed JSONL
filename is insufficient; unreadable or unverified folders return 503 rather than a false 404.
The saved-conversation view offers a separate explicit Resume action.

Reads that fail mid-session (network outage, transient error) leave the URL state and the
mounted view intact; recovery is revalidation on the next interaction, never a crash or a
stale-history rewrite. Only a resolution verdict out of a resource lookup (missing/denied)
clears a selection.

Login preserves an allowlisted same-origin return route. API, login/setup and external targets
cannot become return navigation. Authentication restoration does not replay actions.

## See Also

- [Technical reference map](../../README.md)
- [UI conventions](ux.md)
