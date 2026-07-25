# Messaging Auth Panel — Plan

## Status: In Progress (2026-07-25)

## Phases

### Phase 1 — Create Channel (current focus)
User picks a channel type from dropdown → clicks Setup → terminal + creds panel opens → `openclaw channels add --channel <name>` runs → credentials paste into terminal → done.

### Phase 2 — Manage Existing Channels
Lightweight section listing configured channels with Login/Configure/Remove actions. No slow API.

### Phase 3 — Performance & Polish
Backend cache for channel list, loading skeletons, error states, end-to-end testing.

---

## Phase 1 — Create Channel

### Done
- Dropped `channels-status` API call (was slow, blocked page load)
- Dropped provider status table entirely
- Replaced with simple "Create Channel" form: dropdown of available channels + Setup button
- Dropdown populated from `channels-list` API (background load, non-blocking)
- Terminal + credential panel unchanged (already worked well)
- `closePanel()` resets channel selection and reloads channels/creds
- Removed `loadStatus()`, `status` state, `TabSkeleton` guard, `removeChannel()`, `useConfirm` dependency

### Done in this commit
- Backend: 10-min TTL cache on `channels-list` endpoint with `?refresh=true` force bypass
- Frontend: Rewrote `MessagingTab` — channel dropdown + Setup button + terminal/creds panel
- Credential paste via WebSocket (`credential-paste` message type)
- SPA rebuilt

### Still TODO
- [ ] Test the page loads fast and form works end-to-end
- [ ] Verify credential paste works with interactive CLI prompts
- [ ] `closePanel()` should force-refresh channels (`?refresh=true`) after setup

---

## Concept

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to PAD                    Messaging — <pad-name>               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Create Channel                                                         │
│                                                                         │
│  ┌─────────────────────────┐  ┌──────────┐                              │
│  │ Select channel...   ▼  │  │ [ Setup] │                              │
│  └─────────────────────────┘  └──────────┘                              │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  (after clicking Setup — panel slides open)                              │
│                                                                         │
│  ┌─ Setup: Signal ──────────────────────────────────────── [ ✕ Close ]─┐│
│  │                                                                      ││
│  │  ┌─────────────────────────────────┐  ┌───────────────────────────┐ ││
│  │  │                                 │  │ Credentials               │ ││
│  │  │  Terminal                       │  │                           │ ││
│  │  │                                 │  │  Telegram                 │ ││
│  │  │  $ openclaw channels add \     │  │  ├─ my_bot                │ ││
│  │  │    --channel signal             │  │  └─ work_bot              │ ││
│  │  │                                 │  │                           │ ││
│  │  │  Select account name:           │  │  Signal                   │ ││
│  │  │  > default                      │  │  ├─ personal              │ ││
│  │  │                                 │  │  └─ work                  │ ││
│  │  │  Enter token: _                 │  │                           │ ││
│  │  │                                 │  │  WhatsApp                 │ ││
│  │  │                                 │  │  └─ main                  │ ││
│  │  │                                 │  │                           │ ││
│  │  │                                 │  │  GChat                    │ ││
│  │  │                                 │  │  └─ work                  │ ││
│  │  │                                 │  │                           │ ││
│  │  └─────────────────────────────────┘  └───────────────────────────┘ ││
│  │                                                                      ││
│  └──────────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────────┘
```

## Channel List Cache

**Command:** `openclaw channels list --all --json` (run inside the PAD container)

**Cache structure** (follows existing `skillsCache` pattern from `src/app.js`):
```js
let channelsCache = { ts: 0, data: null };
const CHANNELS_CACHE_TTL = 600000; // 10 minutes
```

**Behavior:**
1. **First page load** — cache is empty (`data: null`), run the command, store result
2. **Subsequent page loads** — if `Date.now() - ts < TTL`, return cached data
3. **After TTL expires** — next request re-runs the command
4. **On error** — fall back to stale cache if available, empty array otherwise
5. **Force refresh** — `GET /api/agents/:id/channels?refresh=true` bypasses TTL

**Why 10 minutes?** Channel providers don't change often. No need to hammer the container.

**Endpoint:** `GET /api/agents/:id/channels` — returns cached channel list as JSON

**Frontend:** On `MessagingTab` mount, fetch `/api/agents/:id/channels` → populate dropdown. No background polling.

## OpenClaw Commands

| Action | Command | Interactive? |
|--------|---------|:------------:|
| **List all** | `openclaw channels list --all --json` | ❌ (machine-readable) |
| **Setup** | `openclaw channels add --channel <name>` | ✅ (prompts for token, account ID, name, PAD binding) |
| **Login** | `openclaw channels login --channel <name>` | ✅ (reconnects auth) |
| **Logout** | `openclaw channels logout --channel <name>` | ❌ (non-interactive) |
| **Configure** | `openclaw channels add --channel <name>` | ✅ (re-runs setup wizard) |
| **Remove** | `openclaw channels remove --channel <name> --delete` | ❌ (non-interactive with `--delete`) |
| **Status** | `openclaw channels status` | ❌ (output parsed for table) |

### Notes from docs

- `channels add` with no flags opens an interactive wizard. A positional channel id or `--channel <id>` preselects without bypassing guidance.
- `channels remove --delete` removes config entries without prompting. Without `--delete` it asks to disable + keeps config.
- `channels login` must run from a terminal on the gateway host. PAD `exec` blocks interactive login.
- `channels status` can use `--probe` for live runtime checks on a reachable gateway; falls back to config-only if unreachable.
- `channels status --json` for machine-readable output.
- `channels list` shows configured accounts by default; `--all` also shows bundled + installable catalog channels.

## How It Works

1. Page loads → fetches `/api/agents/:id/channels` → backend returns cached or fresh channel list → populates dropdown
2. User picks a channel from dropdown → clicks **[Setup]**
3. Terminal + creds panel slide open, `openclaw channels add --channel <name>` executes
4. CLI prompts for input → terminal unfreezes
5. User clicks a name in the creds panel → value pasted into terminal
6. Setup finishes → terminal shows **Done** → user clicks **[✕ Close]**
7. Panel closes, dropdown resets

## Credential Panel

### What It Lists
- Only messaging credentials (Telegram tokens, Signal creds, GChat webhooks, etc.)
- **Names only** — no keys visible, no reveal toggle
- Stored in the credential manager (`src/creds.js`)

### Interaction
- Click a name → value sent to terminal stdin via WebSocket + `\n`
- No terminal running or not waiting for input → click does nothing

## Data Flow

```
Panel click
  → WebSocket send: { type: 'credential-paste', value: '...' }
  → WebSocket handler writes value + '\n' to docker exec stdin
  → Terminal shows output (CLI may mask the input)
```

## Edge Cases

| Case | Handling |
|------|----------|
| No terminal running | Click does nothing |
| Terminal not in input state | Click does nothing |
| Multiple creds same provider | All shown, user picks |
| Gateway unreachable | `channels status` falls back to config-only |
| Cache empty on first load | Run command, store result, return |
| Cache stale (>10 min) | Re-run command on next request |
| Command fails | Return stale cache or empty array |

## Terminal-First UI Alignment

This panel follows the terminal-first UI rules from `plans/terminal-first-ui.md`:

- **GUI for display, terminal for actions** — dropdown shows channels, Setup button triggers the CLI command
- **User cannot free-type** — keystrokes dropped when terminal is idle. Only the Setup button and credential paste send input.
- **Credential paste is the one exception** — it's a GUI-initiated paste (click → WebSocket → stdin), not raw typing
- **One terminal per page** — single terminal session in the panel
- **After command finishes** — terminal freezes at Done, user clicks Close → panel closes, dropdown reloads
- **Command history logged** — terminal output captured for logging

## Files to Create/Modify

- **Modified**: `src/client/src/pages/AgentDetail.jsx` — `MessagingTab` rewritten: channel dropdown + Setup button + terminal/creds panel
- **Modified**: `src/app.js` — `GET /api/agents/:id/channels` with 10-min TTL cache
- **Unchanged**: `src/client/src/components/Console.jsx` — terminal output component
