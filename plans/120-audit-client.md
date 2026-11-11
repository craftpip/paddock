# Plan 120 — Audit fixes: the web client

## Status: In progress — 2026-11-11 — 0/19 findings fixed; all found by a read-only review, none yet reproduced in the browser

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

## Progress

- [ ] 1 PlanPicker checkbox and `existing.length`
- [ ] 2 Confirm before removing a runner (both places)
- [ ] 3 Configs: applying one group keeps other groups' edits
- [ ] 4 SettingsTab: drafts survive another card's Apply
- [ ] 5 Relaunch / Reopen refusals are shown
- [ ] 6 Start / stop / restart failures are shown
- [ ] 7 Config save shows the server's reason
- [ ] 8 Vault paste / add failures are shown
- [ ] 9 Create cannot be submitted twice
- [ ] 10 Create: late probe responses ignored
- [ ] 11 Auto-preview shows the real reason
- [ ] 12 WebTab password cleared after publish
- [ ] 13 Unreachable server is not shown as "no agents"
- [ ] 14 `agentRunning` uses `status === 'running'`
- [ ] 15 Onboard shows a load failure
- [ ] 16 Workspace browser usable from the keyboard
- [ ] 17 SettingsTab clears `loadError`
- [ ] 18 QueuePanel hooks above the early return
- [ ] 19 Sign out failure handled
- [ ] 20 Second review pass over the files listed under "Not reviewed"
