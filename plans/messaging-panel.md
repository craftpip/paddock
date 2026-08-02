# Messaging Panel — Plan

## Status: Revised (2026-08-02)

## Direction Change

Drop the provider-buttons idea entirely. The UI should not enumerate providers at all — `openclaw configure --section channels` already provides the interactive picker for the provider the user wants to add. So the page only needs:

1. Auto-run `openclaw channels list` on page load so the user sees their configured channels right away.
2. Two buttons on top:
   - **Configure Channels** → `openclaw configure --section channels` (starts the interactive UI for configuring channels)
   - **List Channels** → `openclaw channels list` (re-run the list, same as on page load)
3. Terminal output rendered with the existing `Console` component.

Nothing else. No provider buttons, no dropdown, no credential panel.

## Concept

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back to PAD                    Messaging — <pad-name>               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  [⚙ Configure Channels]  [📋 List Channels]                             │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─ Console ───────────────────────────────────────────── Clear ──────┐ │
│  │                                                                      │ │
│  │  $ openclaw channels list                                            │ │
│  │  Telegram  ── work_bot (connected)                                   │ │
│  │  Signal    ── personal (connected)                                   │ │
│  │  ...                                                                 │ │
│  │                                                                      │ │
│  └──────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

## Flow

1. Page loads → auto-run `openclaw channels list` in the terminal (output shows configured channels).
2. User wants to add/change a channel → clicks **[Configure Channels]** → `openclaw configure --section channels` opens the interactive UI. The provider picker lives in that TUI — the web UI does not enumerate providers.
3. When the interactive session needs input, the terminal receives keystrokes from the user.
4. User can re-run the list anytime with **[List Channels]**.

## Terminal-First UI Alignment

This follows the terminal-first UI rules from `plans/terminal-first-ui.md`:

- **GUI for display, terminal for actions** — the two buttons just trigger CLI commands; all provider selection happens inside the OpenClaw TUI.
- **User can type in the terminal** — the interactive configure UI needs real keyboard input (arrow keys, enter, etc.), unlike the old read-only credential paste model.
- **One terminal per page** — a single terminal session.
- **Command history logged** — terminal output captured for logging.

## OpenClaw Commands

| Action | Command | Interactive? |
|--------|---------|:------------:|
| **List configured** | `openclaw channels list` | ❌ (read-only output) |
| **Configure channels** | `openclaw configure --section channels` | ✅ (interactive TUI) |

### To verify against current docs

- `openclaw configure --section channels` — confirm exact flag name/section value: https://docs.openclaw.ai
- `openclaw channels list` — confirm default (configured accounts only, no `--all`).

## Notes from docs (channels)

- `channels add` with no flags opens an interactive wizard. A positional channel id or `--channel <id>` preselects without bypassing guidance.
- `channels remove --delete` removes config entries without prompting. Without `--delete` it asks to disable + keeps config.
- `channels login` must run from a terminal on the gateway host. PAD `exec` blocks interactive login.
- `channels list` shows configured accounts by default; `--all` also shows bundled + installable catalog channels.

## Prior Work Kept

- The messaging WebSocket (`/ws/messaging/:name`) already exists in `src/app.js` and runs commands in the PAD container with a PTY (`script -qfec`).
- Bug fix: the WS `run` message was being dropped because the handler was attached after `await dockerPsList()`. Now messages buffer until async setup completes. Keep this.
- `Console` component (`src/client/src/components/Console.jsx`) is the terminal output component.

## Files to Create/Modify

- **Modified**: `src/client/src/pages/AgentDetail.jsx` — `MessagingTab` simplified: two buttons + Console; auto-run list on mount.
- **Unchanged**: `src/app.js` — messaging WS already works (keep the buffering fix).
- **Unchanged**: `src/client/src/components/Console.jsx`.

## Still TODO

- [ ] Confirm `openclaw configure --section channels` works and is the right command/flag (check current docs)
- [ ] Verify terminal can receive real keystrokes (interactive TUI needs keyboard input, not just credential paste)
- [ ] Rebuild SPA and test page load → auto list → configure flow end-to-end
