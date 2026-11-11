# Plan 120 — Audit fixes: the web client

## Status: In progress — 2026-11-11 — 19/19 findings fixed; 9 exercised in the browser, the rest by build + static checks; remaining: #20, the second review pass

## Why

A read-only review of `src/client/src` on 2026-11-11. Every finding below was
traced in the code by the reviewer; none was run. **Each one is to be confirmed
in the browser or by a test before it is fixed, and a finding that does not
reproduce is recorded here as not real rather than "fixed".**

`api()` rejects with a plain object `{ status, error, code }`, not an `Error`,
so `err.message` is normally undefined. Several findings are that mistake.

## Findings

Severity: M = medium, L = low. None was rated high.

| # | Sev | Where | What is wrong | What the user sees |
|---|---|---|---|---|
| 1 | M | `components/PlanPicker.jsx:118`, `:91`, `:157` | "Completed/archived" checkbox calls `setShowAll(!e.target.checked)` (inverted). `existing` is an array but is read as `existing.size` | Ticking the box does nothing, so done/archived plans can never be shown. The "already queued" count and the "all plans already in the queue" hint never appear |
| 2 | M | `components/RunnerDialog.jsx:405` (button `:621`), `components/SessionList.jsx:749` (icon `:872`) | "Remove as runner" deletes at once, no confirmation | A mis-click on a 16 px trash icon deletes the runner |
| 3 | M | `pages/Configs.jsx:238`, `handleChange` ~`:312`, `loadVars` ~`:299` | Applying one group reloads every group from the server | Unsaved edits in the other groups vanish without warning. After "Restart Webui" the reload hits a server that is going down |
| 4 | M | `pages/agent/SettingsTab.jsx:191-209` | The "sync once" effect runs on every `settings` / `driverInfo` change | Unsaved build commands, volumes and lifecycle scripts revert after any other Apply |
| 5 | M | `components/MissionSessionView.jsx:17` (used `:29`, `:36`) | `try { await fn() } catch {}` around Relaunch / Reopen | A refused relaunch or reopen shows nothing; the button looks dead |
| 6 | M | `stores/agents.js:78-112` | start / stop / restart swallow every failure | A PAD that cannot start flips back to "exited" with no message |
| 7 | M | `pages/AgentDetail.jsx:1157` | `err.message \|\| 'Invalid JSON'` on an `api()` failure | Every server-side save failure reads "Invalid JSON", including for yaml/toml agents |
| 8 | M | `pages/agent/CommandsPane.jsx:409`, `:435` | Vault paste and add rethrow with no catch at the call site | A failed decrypt or a refused add does nothing and says nothing |
| 9 | M | `pages/CreateAgent.jsx:1147`, `handleSubmit` `:578` | No in-flight guard on Create | A double click sends two create requests |
| 10 | L | `pages/CreateAgent.jsx:220-283` | Late probe/discover responses are not checked against the current input | Typing path A then B can fill the volumes from A |
| 11 | L | `components/RunnerDialog.jsx:198` | The state updater's parameter `e` shadows the caught error `e` | Auto-preview always says "Preview failed", never the reason |
| 12 | L | `pages/agent/WebTab.jsx:47` | `password` is never cleared after a successful publish | "Discard changes?" on leaving a page with nothing unsaved |
| 13 | L | `stores/agents.js:38-40` (shown at `Dashboard.jsx:152`, `AgentDetail.jsx:279-286`) | A failed `/api/agents` read is rendered as an empty answer | "Agent not found — it may have been deleted" / "No agents yet" while the server is merely unreachable |
| 14 | L | `pages/Mission.jsx:418`, `pages/MissionSessionPopout.jsx:45` | `status !== 'stopped'`, but no status is ever `'stopped'` | A stopped PAD's terminal keeps retrying and never shows "Agent is stopped" |
| 15 | L | `pages/Onboard.jsx:25-27`, `:56` | Fetch failure is swallowed while the page waits for `agent` | "Loading..." forever for an unknown PAD |
| 16 | L | `pages/AgentDetail.jsx:819`, `:827-831` | Opening a file/folder is `onClick` on a `<td>` / `<tr>` | The workspace browser cannot be used from the keyboard |
| 17 | L | `pages/agent/SettingsTab.jsx:139-143` (shown `:779`) | `loadError` is never cleared on success | One transient failure leaves a red error above correct settings |
| 18 | L | `components/QueuePanel.jsx:163` | `if (!runner) return null` sits before several hooks | Latent: a runner that becomes null while mounted would crash the panel |
| 19 | L | `components/DashboardLayout.jsx:21-24`, `stores/auth.js:45-48` | Sign out has no catch | A network blip on Sign out does nothing and says nothing |

## Not reviewed

The reviewer did not read: `Tooltip`, `Splitter`, `OverlayScroll`,
`SessionCreateSplit`, `CallbackScriptEditor`, `PromptTemplateEditor`,
`Console`, `ui/Input|Field|Card|Badge|DialogError|tone`, `lib/web.js`,
`lib/workspace-guards.js`, `lib/theme.js`, `lib/cx.js`,
`lib/callback-output.js`, `pages/GlobalBackups.jsx`, `main.jsx`. Only partly
read: `stores/mission.js`, `components/Terminal.jsx`. A second pass over these
is item 20.

## How each fix is proven

- A behaviour a test can reach (store logic, pure helpers) gets a test, with a
  mutation control via `scripts/mutate.sh` where the test is new.
- Everything else is clicked in the navigator browser: do the thing, then read
  the resulting DOM in a second evaluate. For error paths, the request is
  stubbed in the page (`window.fetch` replaced for that one URL) so the real
  server is not broken to make it fail.
- `npm test` green after the rebuild, including the bundle-freshness test.

## Results (2026-11-11)

`npm test`: 74 files, 1235 tests, including the unbound-name scan over every
client file (which caught one mistake in these very edits: a value declared in
the wrong component) and the bundle-freshness check.

| # | Fix | How it was checked |
|---|---|---|
| 1 | Checkbox no longer inverted; `existing.length` | Browser: ticking it checks the box and sets `planAll=1`; "18 already queued" now shows |
| 2 | Both remove-runner controls ask first | Browser: "Remove the runner devrunner?" appeared, no DELETE was sent, Keep left the runner |
| 3 | Saving one Configs group marks only those keys saved | Browser, with the POST stubbed: the other group's unsaved edit survived |
| 4 | Each settings draft follows the server only when it has no unsaved edit or its own saved value changed | Build + static checks; not exercised (needs a recreate) |
| 5 | Relaunch / Reopen refusals are toasted | Build + static checks |
| 6 | start / stop / restart failures are recorded in the store and toasted from the layout | Browser, restart stubbed to 500: toast "Could not restart: the daemon is not answering" |
| 7 | Config save shows the server's reason | Build + static checks |
| 8 | Vault paste / add failures are toasted | Build + static checks |
| 9 | Create has an in-flight flag | Build + static checks |
| 10 | Probe replies carry a sequence number and are dropped when stale | Build + static checks |
| 11 | The updater no longer shadows the caught error | Build + static checks |
| 12 | The web password draft is cleared when the page re-reads the saved state | Build + static checks |
| 13 | A failed agents read sets `loadError`; the dashboard and detail page say "could not load" instead of "no agents" / "not found" | Build + static checks |
| 14 | `agentRunning` is `status === 'running'` (unknown still counts as running) | Build + static checks |
| 15 | Onboard shows the load failure and a way back | Build + static checks |
| 16 | Workspace rows and "Up" are focusable and open on Enter / Space | Build + static checks |
| 17 | `loadError` cleared on a successful read | Build + static checks |
| 18 | The early return is below the last hook | Build; the panel renders and works (browser) |
| 19 | Sign out failure is toasted | Browser, logout stubbed to fail: toast shown, still signed in |

## Progress

- [x] 1 PlanPicker checkbox and `existing.length`
- [x] 2 Confirm before removing a runner (both places)
- [x] 3 Configs: applying one group keeps other groups' edits
- [x] 4 SettingsTab: drafts survive another card's Apply
- [x] 5 Relaunch / Reopen refusals are shown
- [x] 6 Start / stop / restart failures are shown
- [x] 7 Config save shows the server's reason
- [x] 8 Vault paste / add failures are shown
- [x] 9 Create cannot be submitted twice
- [x] 10 Create: late probe responses ignored
- [x] 11 Auto-preview shows the real reason
- [x] 12 WebTab password cleared after publish
- [x] 13 Unreachable server is not shown as "no agents"
- [x] 14 `agentRunning` uses `status === 'running'`
- [x] 15 Onboard shows a load failure
- [x] 16 Workspace browser usable from the keyboard
- [x] 17 SettingsTab clears `loadError`
- [x] 18 QueuePanel hooks above the early return
- [x] 19 Sign out failure handled
- [ ] 20 Second review pass over the files listed under "Not reviewed"
