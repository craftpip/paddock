# Terminal-First UI

## Status: Updated 2026-08-02 — one persistent terminal per agent

## Core Concept

The agent page is a **terminal emulator with a GUI command picker**.

The terminal is **always on screen**. It is mounted **once per agent** at the page
level and stays alive the whole time you're on that agent's page. Switching tabs
swaps the **button toolbar** above the terminal — the shell is never torn down.
Pages that don't need a shell (workspace, sessions, ...) hide the terminal, but it
stays mounted underneath, so when you come back to a terminal tab your scrollback
and your shell session are still exactly where you left them.

GUI elements (tables, cards, lists) are for **displaying information**. For
**entering things, setting things up, configuring** — the terminal flow takes over.

Click a button → the CLI command gets typed into the terminal and executed. The
user sees every command, every output, every prompt. Interactive flows (OAuth
login, API key entry, device-code auth) happen live in the terminal. The user can
also type straight into the shell — it is a real bash session, not a mock.

Every command run for this agent accumulates in that one terminal. You never juggle
multiple terminals — **one terminal per agent, it remembers everything.**

## Why This Update

The original version of this plan (below) described a per-page console where each
tab owned its own terminal session. Practically that meant: switch tab → session
killed, history gone, connect again. User feedback was clear:

> Show the terminal forever. Tabs change the buttons, keep the terminal. For pages
> that don't need the terminal, hide it. All commands run in that one terminal and
> the user can scroll back and see what was previously run for this agent. No more
> switching between different terminals.

So the architecture changed:

- **Before:** one `<Terminal>` / `<Console>` per tab, unmounted on tab switch,
  scrollback + shell session lost.
- **After:** one `<Terminal>` at the `AgentDetail` page level, mounted once,
  shown/hidden by tab, never unmounted while on the agent page. Tabs become
  button toolbars that feed commands into that shared instance.

The **Health tab** stays the reference implementation (buttons + terminal), but
every terminal-driven tab now reuses the *same* mounted terminal instead of
spawning its own.

## Scope

- **Phase 1**: OpenClaw
- **Phase 2**: Nanopot
- **Phase 3**: Hermes PAD

## Layout

```
┌──────────┬───────────────────────────────────────────────────────┐
│ Sidebar  │  Tab content (scrollable)                             │
│          │  ┌─────────────────────────────────────────────────┐  │
│ Overview │  │  Toolbar: [Group: cmd] [cmd]  [Group: cmd] ... │  │  ← tab-specific buttons
│ Workspace│  └─────────────────────────────────────────────────┘  │
│ Terminal │  Status / display widgets (per tab, optional)         │
│ Health   │  ┌─────────────────────────────────────────────────┐  │
│ ...      │  │  TERMINAL (docked, always visible on shell tabs)│  │  ← one shared instance
│          │  │  $ openclaw health --json                       │  │
│          │  └─────────────────────────────────────────────────┘  │
└──────────┴───────────────────────────────────────────────────────┘
```

The right column is a **flex column**: tab content on top (scrolls itself), the
terminal docked at the bottom on shell tabs. The terminal has a fixed-ish height
(e.g. `40vh`, min `320px`), so it never competes with the tab content for scroll
space.

## Terminal States

| State | What the user sees | Can they type? |
|-------|--------------------|----------------|
| **Interactive** (default) | Live bash session. Buttons inject commands, user can type too | Yes — free shell |
| **Locked** (toggle) | Frozen shell. Buttons still inject commands; input drops until the command finishes | No — buttons only |
| **Running** | Output streaming live. If the CLI prompts, terminal unfreezes | Yes — stdin of the running command |

The lock is a **per-agent toggle** (persisted in `localStorage`) in the terminal
header. `Interactive` is the default: the point of one persistent terminal is that
it behaves like a real shell you can just use, while the buttons give you a
shortcut for every OpenClaw command.

## Tab Classification

| Tab | Type | What changes |
|-----|------|--------------|
| Health | **Terminal-driven** | Done — buttons + terminal (reference impl) |
| Messaging | **Terminal-driven** | Buttons (Create/Login/Remove per channel) + creds panel + terminal |
| Models | **Terminal-driven** | Buttons (auth login / paste-api-key / set model) + provider list + terminal |
| MCP | **Terminal-driven** | Buttons (add/remove/probe server) + server list + terminal |
| Skills | **Terminal-driven** | Buttons (install/update/remove/verify) + skill list + terminal |
| Backups | **Terminal-driven** | Buttons (create/restore/list) + backup table + terminal |
| Config | **Hybrid** | Keep the JSON editor (it's a text file), add terminal buttons (validate / reload / set) |
| Terminal | **Full-height shell** | No toolbar, terminal fills the tab. Same instance, just taller |
| Overview | GUI-only | No terminal — stat cards, quick links, activity |
| Workspace | GUI-only | No terminal — file browser |
| Logs | GUI-only | No terminal — streamed container logs |
| Sessions | GUI-only | No terminal — table |
| Activity | GUI-only | No terminal — table |

For **GUI-only** tabs the terminal is hidden but *stays mounted* (see below), so
the shell session and scrollback survive the detour.

## How the Persistent Terminal Works

**Mount it once at the page level:**

```jsx
function AgentDetail() {
  const termRef = useRef(null)

  return (
    <div className="flex h-full" id="agent-layout">
      <aside>… tabs …</aside>
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {currentTab === 'health'    && <HealthToolbar  agent={agent} termRef={termRef} />}
          {currentTab === 'messaging' && <MessagingToolbar agent={agent} termRef={termRef} />}
          … only the toolbar/content renders per tab …
        </div>
        {SHELL_TABS.has(currentTab) && (
          <div className="h-[40vh] min-h-[320px] shrink-0 px-6 pb-6">
            <Terminal ref={termRef} name={agent.name} title={agent.display_name} height="100%" />
          </div>
        )}
      </div>
    </div>
  )
}
```

Key rules:

- The `<Terminal>` sits **outside** the per-tab render. It never unmounts while
  the agent page is open. Tab switches only change what renders above it.
- "Hide on GUI-only tabs" is done by **not rendering the wrapper div** — which
  would unmount the terminal and kill the session. Instead the wrapper stays and
  is toggled with a `hidden` class (`display: none`). The xterm buffer and the
  WebSocket bash session survive, and the existing **ResizeObserver** refits the
  terminal automatically when it becomes visible again.
  - xterm inside `display: none` reports zero size — that's fine. On reveal the
    ResizeObserver fires and calls `fit()` + sends a `resize` frame. No extra work.
- Switching **agents** (`name` prop changes) tears down and starts a fresh session
  — that behavior already exists in the component.
- The dock height can grow: the **Terminal tab** passes `height="100%"` inside a
  `flex-1` wrapper so it becomes the full-height shell.

## Terminal Component Changes Needed

The shared `<Terminal>` component (`src/client/src/components/Terminal.jsx`)
needs three additions to support this:

1. **Tracked `runCommand`** — today completion is only detected in locked mode
   (sentinel). Buttons on an *unlocked* terminal need a busy indicator too. Add
   `runCommand(cmd, { track: true })` which injects the completion sentinel
   (`stty -echo\r` + `stty echo; <cmd>; echo __PAD_DONE_<id>__\r`) but **does not
   lock input** the way `disabled` mode does. `onCommandStart` / `onCommandDone`
   fire so buttons can show a spinner and stay disabled while running.

2. **Secret paste** — pasting a credential into the shared shell with `write()`
   would echo the secret into the scrollback (and history). Wrap pastes the same
   way the sentinel does:
   ```
   stty -echo\r  <secret>\r  stty echo\r
   ```
   A `pasteSecret(value)` imperative method on the terminal. The secret never
   appears in the visible buffer.

3. **Lock toggle** — a `Lock` / `Unlock` button in the terminal header (persisted
   per agent), so `disabled` mode is now a user-facing feature instead of a
   per-tab prop. Buttons keep working in both modes.

## Command History

The user should always be able to see "what was run for this agent". Two layers:

1. **In-session scrollback** (free). The persistent terminal keeps one running
   buffer (10000 lines). Scrolling up shows every command + output since you
   opened the agent page. This is the primary experience.

2. **Persistent command log** (survives refresh / agent switch). The backend
   records every button-issued command in the activity store (same place
   start/stop/restart events go). A small **history popover** (clock icon in the
   terminal header) lists past commands with timestamps + exit status; clicking
   one re-runs it. Optional: also capture the user's own typed commands from the
   shell's `~/.bash_history`.

- **Clear** wipes the visible scrollback only, never the log.
- **Reconnect** starts a fresh bash session and is destructive to the current
  buffer — give it a confirm.

## Button Bar Pattern

Buttons are grouped by category. Each group has a colored dot + label + pill buttons:

```jsx
const COMMAND_GROUPS = [
  {
    title: 'Diagnostics',
    commands: [
      { cmd: 'openclaw health', label: 'Health', desc: 'Cached health snapshot', flags: ['--json', '--verbose'] },
      { cmd: 'openclaw status', label: 'Status', desc: 'Quick channels + sessions', flags: ['--all', '--usage'] },
    ],
  },
  {
    title: 'Danger Zone',
    commands: [
      { cmd: 'openclaw doctor --fix', label: 'Doctor & Fix', desc: 'Auto-repair issues', confirm: true },
      { cmd: 'openclaw memory index --force', label: 'Force Reindex', desc: 'Full rebuild', confirm: true, danger: true },
    ],
  },
]
```

**Button properties:**

| Property | Type | Description |
|----------|------|-------------|
| `cmd` | string | The exact CLI command to run |
| `label` | string | Button text (short, 1-2 words) |
| `desc` | string | Tooltip description |
| `confirm` | boolean | Show confirmation before running |
| `danger` | boolean | Double-confirm with danger styling |
| `flags` | string[] | Optional toggleable flags (shown as checkboxes) |

**Button styling per group:**

```jsx
const GROUP_COLORS = {
  Diagnostics: 'border-cyan-800/30 text-cyan-300 bg-cyan-950/20 hover:bg-cyan-900/30',
  Doctor:      'border-amber-800/30 text-amber-300 bg-amber-950/20 hover:bg-amber-900/30',
  Security:    'border-rose-800/30 text-rose-300 bg-rose-950/20 hover:bg-rose-900/30',
  Memory:      'border-violet-800/30 text-violet-300 bg-violet-950/20 hover:bg-violet-900/30',
  Other:       'border-slate-700/50 text-slate-400 bg-slate-800/50 hover:bg-slate-700',
}
```

Danger commands override with red styling regardless of group.

**Group dot colors:**

```jsx
const DOT_COLORS = {
  Diagnostics: 'bg-cyan-500',
  Doctor:      'bg-amber-500',
  Security:    'bg-rose-500',
  Memory:      'bg-violet-500',
  Other:       'bg-slate-600',
}
```

**Button HTML pattern:**

```jsx
<button
  onClick={() => run(c.cmd, c)}
  disabled={!!runningCmd}
  className={`px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors whitespace-nowrap border shrink-0
    ${c.danger ? 'bg-red-900/30 text-red-400 border-red-800/50 hover:bg-red-800/50' : accent}
    ${runningCmd ? 'opacity-40 cursor-not-allowed' : ''}`}
  title={c.desc}
>
  {c.label}
</button>
```

Buttons are disabled while any tracked command is running. Only one tracked
command at a time (free typing in the shell is unaffected).

## Shared `run()` helper

One helper per agent page, used by every toolbar:

```jsx
function run(termRef, cmd, opts = {}) {
  if (opts.confirm && !confirm(`Run "${cmd}"?`)) return
  if (opts.danger && !confirm(`⚠ DANGER: "${cmd}" — Are you sure?`)) return
  termRef.current?.runCommand(cmd, { track: true })
}
```

Toolbars receive `termRef` from the page (or via a tiny `TerminalContext` if prop
drilling gets ugly).

## Console Component

File: `src/client/src/components/Console.jsx`

Still exists, but its role shrinks. It is the **display-only sibling** for pages
that just show command output without an interactive shell — after the migration,
mostly nothing on the agent page uses it. It stays for any future read-only
"run and show" surfaces (e.g. fleet-wide commands). The interactive shell is
always the shared `<Terminal>`.

## Credential Paste Pattern

Interactive flows (API key entry, OAuth, bot tokens) happen inside the shared
shell. The creds side panel (Messaging) or a paste button (Models) calls the
terminal's new `pasteSecret(value)`:

```jsx
function pasteCredential(value) {
  termRef.current?.pasteSecret(value) // stty -echo \r value \r stty echo \r
}
```

The secret is written to the running command's stdin and **not echoed** into the
terminal buffer or history. This replaces the old `/ws/messaging`
`credential-paste` message — the PTY already gives us stdin, we just need the
echo suppression.

### Split Layout Variant (Messaging)

Pages that need a credentials side panel keep it, now beside the shared terminal:

```
┌──────────────────────────────────────┬──────────────┐
│  TERMINAL (3/4)                      │ Creds (1/4)  │
│  $ openclaw channels add --channel ..│ [bot1] [bot2]│
│  Enter bot token: █                  │ [user1]      │
└──────────────────────────────────────┴──────────────┘
```

- Creds panel shows saved bot tokens / user IDs (from `/api/credentials`).
- Clicking a credential calls `pasteSecret()` → into the running command.
- Refresh: after a command completes, the display strip reloads.

## Command Definitions

### Messaging

| Action | Command | Interactive? |
|--------|---------|:------------:|
| Setup | `openclaw channels add --channel <name>` | Yes |
| Login | `openclaw channels login --channel <name>` | Yes |
| Logout | `openclaw channels logout --channel <name>` | No |
| Configure | `openclaw channels add --channel <name>` | Yes |
| Remove | `openclaw channels remove --channel <name> --delete` | No |
| Status | `openclaw channels status` | No |
| List all | `openclaw channels list --all` | No |

### Models

| Action | Command | Interactive? |
|--------|---------|:------------:|
| Setup (API key) | `openclaw models auth paste-api-key --provider <id>` | Yes |
| Setup (OAuth) | `openclaw models auth login --provider <id>` | Yes |
| Setup (token) | `openclaw models auth paste-token --provider <id>` | Yes |
| Login / Re-auth | `openclaw models auth login --provider <id> [--force]` | Yes |
| Set default model | `openclaw models set <provider/model>` | No |
| List configured | `openclaw models auth list --json` | No |
| List all available | `openclaw models list --all --json` | No |
| Full status | `openclaw models status --json` | No |

### PADs

| Action | Command | Interactive? |
|--------|---------|:------------:|
| Create | `openclaw setup` | No |
| Backup | `openclaw backup create --output <path>` | No |
| Restore | `openclaw backup restore <path>` | No |
| Cron list | `openclaw cron list` | No |
| Cron add | `openclaw cron add ...` | Depends |
| Memory index | `openclaw memory index` | No |

## Backend Changes

- **Keep** `/ws/terminal/:name` (dockerode PTY) — it is the engine. One shell
  session per agent, held open for as long as the page is open.
- **Add** command log recording: `POST /api/agents/:name/command-log`
  `{ cmd, status, ts }` → append to the agent's activity store (reuses the
  existing activity table / `registry.getActivity`). The history popover reads
  `GET /api/agents/:name/activity`.
- **Retire after migration:**
  - `/ws/messaging/:name` + `credential-paste` → replaced by the shared terminal
    + `pasteSecret()`.
  - `/ws/exec/:name` and `/api/agents/:name/exec-stream` → not needed once every
    shell tab uses the shared terminal.
- The `command-log` route should record **exit status** too, so the history
  popover can mark failures. Best-effort: sentinel-tagged commands already know
  when they finish; wire that signal through to the log.

## Migration Checklist

Order matters — do the risky/loved pages first, retire old WS endpoints last.

- [x] `Terminal.jsx` extracted as the one shell component (see `terminal-component.md`)
- [x] Health tab = buttons + terminal (reference implementation)
- [ ] **Lift** `<Terminal>` to page level, mount once, keep mounted, toggle visibility per tab
- [ ] Add tracked `runCommand(cmd, { track: true })` to the terminal
- [ ] Add `pasteSecret()` to the terminal
- [ ] Add Lock toggle (persisted per agent)
- [ ] Add history popover + backend `command-log` recording
- [ ] **Messaging** → toolbar + creds panel + shared terminal (retire `/ws/messaging`)
- [ ] **Models** → toolbar + provider list + shared terminal
- [ ] **MCP** → toolbar + server list + shared terminal
- [ ] **Skills** → toolbar + skill list + shared terminal
- [ ] **Backups** → toolbar + backup table + shared terminal
- [ ] **Config** → hybrid: JSON editor + terminal buttons (validate / reload / set)
- [ ] **Terminal** tab → full-height shell on the same instance
- [ ] Retire `/ws/exec/:name`, `/api/agents/:name/exec-stream`
- [ ] Browser-test: tab switching keeps scrollback + session; GUI-only tabs hide terminal; refresh restores history popover

## Rules

- **One terminal per agent.** It mounts once, lives at the page level, and is
  never unmounted while the agent page is open. Tabs swap the toolbar, not the shell.
- **Hiding ≠ unmounting.** GUI-only tabs use `display: none` on the wrapper so
  scrollback and the bash session survive.
- Command definitions are hardcoded per-tab — not a config file, not scraped.
- The user can free-type. The buttons are shortcuts, not the only input path.
- Only one **tracked** command runs at a time. Free typing is unaffected.
- Command history is logged — exact CLI command + exit status, viewable from the
  history popover even after the buffer is cleared or the page is reloaded.
- After a command finishes, display strips refresh (auto-refresh later).
- **Secrets never hit the buffer or the log** — always paste via `stty -echo`.
- Terminal prompt style: simple `$` is fine.
- Multi-command flows run sequentially in the same terminal. Post-setup
  verification commands can run internally without terminal display.
- **The terminal is always visible on shell tabs** — never collapsed, never hidden.

## Open Questions

- **Long-running commands** — background mode? Progress indicator? (e.g. `openclaw
  memory index` can take a while; do we block the tab or let it stream?)
- **Ctrl+C / interrupt** — should buttons offer a Stop that sends `\x03` to the
  shell? It's natural in an interactive terminal, but a button would be nicer
  than reaching for the keyboard.
- **Command log retention** — cap the log (e.g. last 100 entries per agent)?
- **bash_history capture** — worth wiring the user's typed commands into the
  history popover, or is scrollback enough?
- **Multi-agent superpowers later** — can the same terminal dock concept scale to
  a fleet view (pick agent → same dock, new session)?
