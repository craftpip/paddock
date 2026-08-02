# Terminal-First UI

## Status: Final design (2026-08-02) — one home page + 5 modes, one terminal per agent

## Core Concept

The agent page is a **terminal emulator with a GUI command picker**.

The terminal is the home. It is mounted **once per agent**, at the page level, and
stays alive the whole time you're on that agent's page. It is **always visible** —
docked at the bottom — no matter what mode you're in.

The old 13 tabs collapse to **6**: one **Commands** home (all terminal-driven tabs
merged into grouped buttons) plus 5 GUI modes that genuinely need real GUIs
(workspace, config, logs, sessions, activity).

GUI elements (tables, cards, lists) are for **displaying information**. For
**entering things, setting things up, configuring** — the terminal flow takes over.

Click a button → the CLI command gets typed into the terminal and executed. The
user sees every command, every output, every prompt. Interactive flows (OAuth
login, API key entry, device-code auth) happen live in the terminal. The user can
also type straight into the shell — it is a real bash session, not a mock.

Every command run for this agent accumulates in that one terminal. You never juggle
multiple terminals — **one terminal per agent, it remembers everything.**

## Why This Design

Two decisions drive the whole layout:

1. **One terminal per agent, always visible.** Switching pages must never kill the
   shell or the scrollback. The user scrolls up to see everything ever run for this
   agent — health checks, model setups, messaging auth, all in one place.
2. **Most tabs are just command launchers.** Health, messaging, models, mcp,
   skills, backups, config — they all do the same thing: spawn an `openclaw`
   command. Keeping them as separate pages meant separate terminal instances,
   separate sessions, lost history. Merging them into one Commands page means
   **one page owns the terminal** — least maintenance possible.

The `Terminal` component (`src/client/src/components/Terminal.jsx`) stays the
single source of truth for the shell. One component, one page, one instance.

## Scope

- **Phase 1**: OpenClaw
- **Phase 2**: Nanopot
- **Phase 3**: Hermes PAD

## The Merge Map

**13 tabs → 1 Commands home + 5 GUI modes.**

### Merged into the Commands page (9 tabs disappear)

| Old tab | Becomes |
|---------|---------|
| Terminal | The persistent dock itself — no tab needed |
| Health | Command groups: Diagnostics, Doctor, Security, Memory |
| Messaging | Group "Messaging" + creds panel (paste bot tokens / user IDs) |
| Models | Group "Models" + strip showing current primary / fallback model |
| MCP | Group "MCP" + server list |
| Skills | Group "Skills" + skill list |
| Backups | Group "Backups" + backup table |
| Config | Group "Config" (validate / reload / set) — the JSON editor is a mode |
| Overview | Absorbed into the agent header (type, runtime, model) + a recent-activity strip on the Commands page |

### Stay as GUI modes (real GUIs, not commands)

| Mode | Why it stays |
|------|--------------|
| Workspace | File browser — needs tables + a file editor |
| Config | JSON editor — needs a textarea |
| Logs | Streamed viewer |
| Sessions | Table |
| Activity | Table |

## Layout

```
┌──────────────────────────────────────────────────────────┐
│ name · status ● · cpu/mem · type/runtime/model           │  ← agent header (persistent)
│                          [▶ start] [⏸ stop] [⏻] [lock]    │
├──────────────────────────────────────────────────────────┤
│ [Commands] [Workspace] [Config] [Logs] [Sessions] [Activity] │  ← mode tabs (transient)
├──────────────────────────────────────────────────────────┤
│                                                          │
│  MODE CONTENT (scrolls, swaps per mode)                  │
│                                                          │
│  Commands mode = the merged tabs as grouped buttons:     │
│   [Diagnostics]  Health  Status  Logs                    │
│   [Doctor]       Doctor  Fix  Lint  Deep                 │
│   [Security]     Audit  Audit deep  Audit fix            │
│   [Memory]       Status  Reindex  Force reindex  Promote │
│   [Messaging]    Create Telegram  Login  Logout  Remove  │
│   [Models]       API key  OAuth  Set primary  List       │
│   [MCP]          Add  Remove  Probe                      │
│   [Skills]       Install  Update  Remove  Verify         │
│   [Backups]      Create  Restore                        │
│   [Config]       Validate  Reload  Set                  │
│   [Other]        Backup  Update  Channels probe          │
│                                                          │
├──────────────────────────────────────────────────────────┤
│  TERMINAL DOCK (fixed height, ALWAYS visible)            │  ← persistent
│  $ openclaw health --json                                │
└──────────────────────────────────────────────────────────┘
```

The right area is a **flex column**: mode content on top (scrolls itself), the
terminal docked at the bottom (fixed-ish height, `40vh`, min `320px`). The
terminal never competes with mode content for scroll space.

- **Commands is the default and the landing page** — after agent creation the
  user lands here, terminal already live.
- Switching to Workspace / Config / Logs does **not** unmount the terminal — it
  stays docked with its session and scrollback intact.
- The agent sidebar is gone; the header carries name, status, stats, controls.

## Terminal States

| State | What the user sees | Can they type? |
|-------|--------------------|----------------|
| **Interactive** (default) | Live bash session. Buttons inject commands, user can type too | Yes — free shell |
| **Locked** (toggle) | Frozen shell. Buttons still inject commands; input drops until the command finishes | No — buttons only |
| **Running** | Output streaming live. If the CLI prompts, terminal unfreezes | Yes — stdin of the running command |

The lock is a **per-agent toggle** (persisted in `localStorage`) in the terminal
header. `Interactive` is the default.

## How the Persistent Terminal Works

**Mount it once at the page level:**

```jsx
function AgentDetail() {
  const termRef = useRef(null)

  return (
    <div className="flex flex-col h-full">
      <AgentHeader agent={agent} />
      <ModeTabs current={mode} onChange={setMode} />
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-y-auto p-6">
          {mode === 'commands'  && <CommandsPane agent={agent} termRef={termRef} />}
          {mode === 'workspace' && <WorkspacePane agent={agent} />}
          {mode === 'config'    && <ConfigPane agent={agent} termRef={termRef} />}
          {mode === 'logs'      && <LogsPane agent={agent} />}
          {mode === 'sessions'  && <SessionsPane agent={agent} />}
          {mode === 'activity'  && <ActivityPane agent={agent} />}
        </div>
        <div className="h-[40vh] min-h-[320px] shrink-0 px-6 pb-6">
          <Terminal ref={termRef} name={agent.name} title={agent.display_name} height="100%" />
        </div>
      </div>
    </div>
  )
}
```

Key rules:

- The `<Terminal>` sits **outside** the per-mode render. It never unmounts while
  the agent page is open. Mode switches only change what renders above it.
- The dock is always rendered — on every mode. Nothing needs a `display: none`
  dance because the terminal is never hidden at all. GUI modes simply have no
  buttons above it.
- Switching **agents** (`name` prop changes) tears down and starts a fresh session
  — that behavior already exists in the component.
- The dock can grow later (e.g. a full-height "big terminal" toggle in the header)
  by changing the wrapper's height — the ResizeObserver + resize frame already
  handle it.

## Terminal Component Changes Needed

The shared `<Terminal>` component needs three additions:

1. **Tracked `runCommand`** — today completion is only detected in locked mode
   (sentinel). Buttons on an *unlocked* terminal need a busy indicator too. Add
   `runCommand(cmd, { track: true })` which injects the completion sentinel
   (`stty -echo\r` + `stty echo; <cmd>; echo __PAD_DONE_<id>__\r`) but **does not
   lock input**. `onCommandStart` / `onCommandDone` fire so buttons can show a
   spinner and stay disabled while running.

2. **Secret paste** — pasting a credential into the shared shell with `write()`
   would echo the secret into the scrollback (and history). Wrap pastes the same
   way the sentinel does:
   ```
   stty -echo\r  <secret>\r  stty echo\r
   ```
   A `pasteSecret(value)` imperative method on the terminal. The secret never
   appears in the visible buffer.

3. **Lock toggle** — a `Lock` / `Unlock` button in the terminal header (persisted
   per agent), so `disabled` mode is a user-facing feature instead of a per-tab
   prop. Buttons keep working in both modes.

## Command History

The user should always be able to see "what was run for this agent". Two layers:

1. **In-session scrollback** (free). The persistent terminal keeps one running
   buffer (10000 lines). Scrolling up shows every command + output since you
   opened the agent page. This is the primary experience.
2. **Persistent command log** (survives refresh / agent switch). The backend
   records every button-issued command in the activity store. A **history popover**
   (clock icon in the terminal header) lists past commands with timestamps + exit
   status; clicking one re-runs it. Optional: also capture the user's typed
   commands from the shell's `~/.bash_history`.

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

**Group layout on the Commands page:** groups render as cards (2–3 per row) rather
than one long bar, since we now have ~11 groups. Each card: colored group header +
pill buttons inside. A search box at the top filters buttons by label/command
across all groups.

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
nothing on the agent page uses it. It stays for any future read-only "run and show"
surfaces (e.g. fleet-wide commands). The interactive shell is always the shared
`<Terminal>`.

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

### Split Layout Variant (Messaging group)

Pages that need a credentials side panel keep it, now beside the shared terminal.
On the Commands page the creds panel lives **inside the Messaging group card**
(compact list of saved bot tokens / user IDs):

```
┌── Messaging ───────────────────────┬──────────────┐
│ [Create telegram] [Login] [Logout] │ Creds        │
│ [Remove] [Status]                  │ [bot1] [bot2]│
└────────────────────────────────────┴──────────────┘
```

- Creds panel shows saved bot tokens / user IDs (from `/api/credentials`).
- Clicking a credential calls `pasteSecret()` → into the running command.
- After a command completes, display strips reload.

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
- [ ] Restructure `AgentDetail.jsx`: header + 6 mode tabs + docked `<Terminal>`
- [ ] Add tracked `runCommand(cmd, { track: true })` to the terminal
- [ ] Add `pasteSecret()` to the terminal
- [ ] Add Lock toggle (persisted per agent)
- [ ] Build `CommandsPane`: group cards + search + status strips
  - [ ] Health groups (Diagnostics / Doctor / Security / Memory / Other)
  - [ ] Messaging group + creds panel
  - [ ] Models group + primary/fallback strip
  - [ ] MCP group + server list
  - [ ] Skills group + skill list
  - [ ] Backups group + backup table
  - [ ] Config group (validate / reload / set)
- [ ] Agent header: name, status, stats, type/runtime/model, start/stop/restart, lock
- [ ] Recent-activity strip on the Commands page (from old Overview)
- [ ] Move Workspace / Config / Logs / Sessions / Activity into modes (mostly copy)
- [ ] Add history popover + backend `command-log` recording
- [ ] Retire `/ws/messaging`, `/ws/exec/:name`, `/api/agents/:name/exec-stream`
- [ ] Browser-test: mode switching keeps terminal session + scrollback; after
      creation lands on Commands; history popover survives refresh

## Rules

- **One terminal per agent.** It mounts once, lives at the page level, and is
  never unmounted while the agent page is open. Modes swap the content above it,
  never the shell.
- **The terminal is always visible** — docked on every mode. Never collapsed,
  never hidden, never re-created on mode switch.
- **Commands is the default landing mode**, including right after agent creation.
- Command definitions are hardcoded per-group — not a config file, not scraped.
- The user can free-type. The buttons are shortcuts, not the only input path.
- Only one **tracked** command runs at a time. Free typing is unaffected.
- Command history is logged — exact CLI command + exit status, viewable from the
  history popover even after the buffer is cleared or the page is reloaded.
- After a command finishes, display strips refresh (auto-refresh later).
- **Secrets never hit the buffer or the log** — always paste via `stty -echo`.
- Terminal prompt style: simple `$` is fine.
- Multi-command flows run sequentially in the same terminal. Post-setup
  verification commands can run internally without terminal display.

## Open Questions

- **Long-running commands** — background mode? Progress indicator? (e.g. `openclaw
  memory index` can take a while; do we block the mode or let it stream?)
- **Ctrl+C / interrupt** — should buttons offer a Stop that sends `\x03` to the
  shell? It's natural in an interactive terminal, but a button would be nicer
  than reaching for the keyboard.
- **Command log retention** — cap the log (e.g. last 100 entries per agent)?
- **bash_history capture** — worth wiring the user's typed commands into the
  history popover, or is scrollback enough?
- **"Big terminal" toggle** — a way to temporarily maximize the dock over the
  mode content for a focused shell session?
