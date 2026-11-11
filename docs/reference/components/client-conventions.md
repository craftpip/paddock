# Client Conventions

The rules every page and store in the web client (`src/client/src/`) follows, each with its reason
and the file that embodies it. Read this before adding a page, a store action or a dialog: the
rules are short, and each one exists because the opposite behaviour is invisible in a build and in
a code read.

> Last updated: 2026-11-12

## Errors

### What `api()` rejects with

`lib/api.js` rejects with a plain object, not an `Error`:

```js
{ status, error, code }   // status: the HTTP status; the rest is the server's JSON body
```

`err.message` is therefore normally `undefined`. Only a network failure rejects with a real
`Error` (the one `fetch` throws). Read the reason in this order, with a fallback sentence that
names the action:

```js
toast.error(e?.error || e?.message || 'Could not restart the agent')
```

`components/ui/DialogError.jsx` exports the same expression as `errorText(e, fallback)`. A catch
that reads only `.message` turns every server refusal into its fallback, which is how a refused
config save reads "Invalid JSON" for a YAML file. The Config tab (`pages/agent/ConfigTab.jsx`)
shows the server's own reason.

### A failed action is always shown

No handler ends in an empty `catch`. A refusal is shown where the person is looking:

| Where the action was taken | Where the failure appears | Example |
|---|---|---|
| A page or a terminal header | Toast, 10 s | Relaunch / Reopen in `components/MissionSessionView.jsx` |
| Inside a dialog | `DialogError` inside that dialog | Plan picker, status review, resolve |
| A dropdown or pane | Toast | Vault paste and add in `pages/agent/CommandsPane.jsx` |
| A form | The form's own message line | Config save, Create Agent |

A refusal raised inside a dialog renders inside it because the page's feedback line sits behind
the modal, where a refused action looks like a button that did nothing.

### Start, stop and restart

`stores/agents.js` owns the three lifecycle actions. A failure clears the transition status,
records `actionError: { name, text, at }` in the store and re-reads the agent list.
`components/DashboardLayout.jsx` watches `actionError`, shows it as one toast and calls
`clearActionError()`. The error lives in the store, not in the component that called the action,
because the buttons exist on the fleet cards and on the agent detail header, and the person may
have navigated away before the request fails.

### Could not load is not empty

A read that fails is a third state, separate from "nothing there" and "not found".

- `stores/agents.js` sets `loadError` when `GET /api/agents` fails and clears it on the next read
  that works. `pages/Dashboard.jsx` shows the reason and says the page retries;
  `pages/AgentDetail.jsx` shows "Could not load this agent: …". "No agents yet" and "Agent not
  found" appear only when `loadError` is empty.
- `pages/Onboard.jsx` shows the load failure and a link back to the fleet. It never waits on
  "Loading…" for an agent it could not read.
- `pages/agent/SettingsTab.jsx` clears its own `loadError` on a successful read, so one transient
  failure does not leave a red line above correct settings.

### Running means `status === 'running'`

`pages/Mission.jsx` and `pages/MissionSessionPopout.jsx` pass the terminal `agentRunning` as
`status === 'running'`. No container status is ever `'stopped'` (they are `running`, `exited`,
`created`, `paused`), so a test against that word is always true. An agent whose status is not
loaded yet counts as running, so the terminal is not held back while the list loads.

## Drafts and Unsaved Edits

A refresh from the server never overwrites an edit the person has not saved.

- **Configs** (`pages/Configs.jsx`). Applying one group reports the keys it wrote. The page marks
  only those keys as saved in `originalVars`; every other group keeps its unsaved values. The
  page does not re-read `/api/env` after a save, which also matters for "Restart Webui": the
  server is going down at that moment.
- **Agent Settings** (`pages/agent/SettingsTab.jsx`). Every card's Apply ends in a settings
  reload. Each draft (extra volumes, build commands, `postCreate`, `postStart`, `postAttach`)
  follows the server only when it has no unsaved edit, or when its own saved value changed, which
  is what its own successful save looks like. `lastSynced` holds the last server value seen per
  draft to tell the two apart.
- **Web & Ports** (`pages/agent/WebTab.jsx`). The password drafts are cleared when the page
  re-reads the saved state after a successful publish, so the unsaved-changes guard does not fire
  on a page with nothing unsaved.

Every page with a draft registers it with `useDirtyNavigation` (`lib/navigation.jsx`), the single
leave guard that offers **Keep editing** or **Discard**. Dialogs are popup descriptors in the URL,
validated by `lib/url-state.js`; their contents are not. Form values, secrets and one-time
displays never enter the URL or `history.state`. [URL Navigation](navigation.md) holds the full
contract for popups, drafts and the guard.

## Late Responses

A reply is applied only if the question is still the current one. Every asynchronous read takes a
number before it starts and compares it when the reply lands; a reply whose number is no longer
current is dropped without touching state.

### Create Agent probes

`pages/CreateAgent.jsx` numbers each workspace-path probe with `probeSeq`. Typing in the path field
bumps the counter, so a probe or compose-file discovery that answers for an earlier path does not
fill the volumes or the "discovered" badge for the path now shown.

### Mission store generations

`stores/mission.js` keeps one module-level counter per kind of read. They are per page load, not
per component.

| Counter | Guards |
|---|---|
| `viewToken` | Which session or saved conversation column 3 shows (`restoreView`) |
| `paneToken` | The open session's pane state (`fetchSessionState`) |
| `listToken` | The session list of the current scope (`fetchSessions`, `fetchAll`) |
| `historyToken` | The agent history of the selected project |
| `projectToken` | The project list |
| `startToken` | Which start owns the selection when two overlap |
| `runnerToken`, `queueToken` | The runner listing and the open runner's queue |

A pane read is stamped with both `paneToken` and the `viewToken` it started under, so it is
dropped when a newer pane read exists or when column 3 moved to another view.

**A navigation that changes nothing starts no new generation.** `restoreView` returns for "same
session, no error" before it bumps `viewToken`. `startSession` opens the session, issues its pane
read and then moves the URL, which lands in `restoreView`; bumping first would cancel that pane
read and leave the new session on "Checking session…" until the next 15-second poll. The same
holds for popup and list navigation around a pinned terminal.

**A vanished project is deselected.** `fetchProjects` keeps `selectedProjectId` only while the
project is in the list it just read; otherwise the selection becomes the all-projects view and
the project is removed from the URL with a replace. A 404 on the selected project's sessions
drops the selection first and then re-reads the project list. Re-reading while still pointing at
the dead id would make the two reads call each other without end.

### The reopen opt-in

Opening a session whose pane is dead restarts it once, in the same conversation. That opt-in
(`autoReopen`) belongs to the open action: a row click, a fresh start, the pop-out window. The
periodic poll and a refresh after a mutation never carry it, because a pane that dies while it is
being watched must not get an agent process launched for it unasked.

A plain pane read can supersede the read the open action issued. So that the opt-in is not lost
with it, `fetchSessionState` records the session id and time in `pendingAutoReopen`. A read for
that session within 5 seconds (`AUTO_REOPEN_WINDOW_MS`) inherits the opt-in, and the first read
that lands deletes it, whether or not a restart followed. A later poll finds nothing to inherit.
`reopenFor` holds the session being restarted, so a second read of the same dead row does not
issue a second restart.

## In-flight Guards and Confirmations

**One request per activation.** A double click or a click plus Enter must not send two requests.

- `pages/CreateAgent.jsx`: `handleSubmit` returns while `submitting` is set, and the Create button
  is disabled.
- `stores/mission.js`: `startSession` returns `null` when `startingKey` already names the same
  action. The guard is in the store, not in the row's `busy` prop: React state read twice in one
  tick is unset both times. A different row is not blocked; it has its own key.

**A destructive one-click action asks first.** Both "Remove as runner" controls (the button in
`components/RunnerDialog.jsx` and the row icon in `components/SessionList.jsx`) open the shared
confirm dialog (`useConfirm`, see [Shared UX utilities](ux.md)) and send nothing until it is
answered. Closing a session asks the same way.

**A checkbox reads `e.target.checked` as it is.** The plan picker's "Completed/archived" box sets
`showAll` to the checked value, and its footer counts queued plans with `existing.length`
(`existing` is an array).

## Page Shell

`components/DashboardLayout.jsx` is the frame around every signed-in page.

- **Document title.** Each page calls `useDocumentTitle(title)` (`lib/useDocumentTitle.js`), which
  sets `"<title> — Paddock"` and puts `Paddock` back when the page unmounts, so one page's title
  never stays on the next. The agent detail page passes the agent's name. The Mission session
  pop-out is a separate window and sets its own title.
- **Current page.** The top-bar link for the current page has the accent colour and
  `aria-current="page"`, including the profile link. "Agents" is current on `/agents` and
  `/agents/<name>`, not on `/agents/create`.
- **Narrow screens.** The link group (`msn-topnav`) scrolls sideways inside the bar
  (`min-w-0 overflow-x-auto`, no visible scrollbar) and the brand keeps its width. The page
  itself never scrolls sideways.
- **Admin-only links.** Vault and Configs are refused by the server for a regular user, so the
  top bar shows those links only when the session's role is `admin`. The Commands pane hides its
  Vault dropdown the same way. A link that can only answer "Admin access required" is not shown.
- **Sign out.** A failed sign-out shows a toast and leaves the person signed in and on the page.
- **Agent tab.** The open agent tab is part of the path (`/agents/<name>/settings`), so a reload
  or a shared link lands on the same tab.

## Terminal

These rules are about `components/Terminal.jsx` as a component. The session model, protocol and
props are in [Terminal Tab](../tabs/terminal.md).

- **Header buttons call the terminal directly.** Clear and Reconnect use the component's own
  functions, never `ref.current`. The forwarded ref is optional and is `null` when the parent
  passes none, as the Mission page does.
- **Clear depends on what the pane is.** On an ordinary shell, Clear sends `clear` to the shell,
  which clears the real pane. On a pinned session (the parent passes `sessionId`, as Mission
  does) the pane is an agent's own screen: typing `clear` there would be delivered to the agent
  as a prompt. Clear then empties the scrollback held in the browser and sends nothing. The
  button's tooltip says which of the two it does.
- **Every socket handler checks its generation.** `onopen`, `onmessage`, `onclose` and `onerror`
  each return when the socket's generation is not the current one. Closing a socket that is still
  connecting fires `error` on it; without the check, that superseded socket would reset the
  connection state of its replacement.
- **Teardown leaves nothing for the next session.** Besides the socket, xterm instance, observer
  and retry timer, `teardown()` drops queued commands, pending completion sentinels, the
  running-command flag and the shell-busy state. A command queued for one session is never typed
  into the next, and a tracked command whose echo was lost does not leave the terminal reporting
  a command in progress.
- **Font size survives a reconnect.** `initTerminal` reads the size from `fontSizeRef`. An
  automatic reconnect runs from an older closure, where the state value is still the initial 14.

The Mission listings scroll inside `components/OverlayScroll.jsx`, which draws its own thumb. A
thumb drag measures the grab offset and the pointer in the scroller's own coordinates
(`getBoundingClientRect().top`), so the list follows the pointer and reaches its first row
wherever the scroller sits in the window.

## Keyboard and Focus

- **Workspace browser.** File and folder rows and the "Up" row in `pages/agent/WorkspaceTab.jsx`
  are focusable (`tabIndex={0}`, `role="button"`) and open on Enter or Space. A click handler on a
  table row alone cannot be reached from the keyboard.
- **Modal focus trap.** `components/ui/Modal.jsx` wraps Tab between the first and last focusable
  control of the top dialog. When focus is outside the panel (after a backdrop click, or when the
  focused button disabled itself on submit) Tab moves it back to the first control and Shift+Tab
  to the last, so Tab never walks the page behind a dialog.
- **Hooks before any early return.** A component's hooks all run before its first conditional
  `return`. `components/QueuePanel.jsx` returns `null` without a runner only below its last hook,
  so a runner that disappears while the panel is mounted does not change the hook order.

## See Also

- [URL Navigation](navigation.md)
- [Shared UX utilities](ux.md)
- [UI Primitives](ui-primitives.md)
- [Terminal Tab](../tabs/terminal.md)
- [Pages](../pages/overview.md)
- [Mission Queue and Runner](../backend/mission-queue.md)
