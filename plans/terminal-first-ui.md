# Terminal-First UI

## Core Concept

The web panel is a **terminal emulator with a GUI command picker**.

GUI elements (forms, tables, cards) are for **displaying information**. For **entering things, setting things up, configuring** — the terminal flow takes over.

Click a button → the CLI command gets typed into the terminal and executed. The user sees every command, every output, every prompt. Interactive flows (OAuth login, API key entry, device-code auth) happen live in the terminal. When the command finishes, the terminal resets, ready for the next action.

The user never types raw commands. The buttons are the interface. The terminal is the engine.

## Scope

- **Phase 1**: OpenClaw
- **Phase 2**: Nanopot
- **Phase 3**: Hermes PAD

## Terminal States

| State | What the user sees | Can they type? |
|-------|-------------------|----------------|
| **Idle** | Frozen, empty terminal waiting for a button click | No — keystrokes dropped |
| **Running** | Output streaming live. If CLI prompts for input, terminal unfreezes | Yes — stdin of the running command only, never a bare shell |
| **Done** | Frozen, showing final output of the completed command(s) | No — keystrokes dropped |

## Canonical Implementation: Health Tab

The Health tab is the reference implementation. Every new terminal-first page follows this exact pattern.

### Layout

```
┌─────────────────────────────────────────────┐
│  [Group: cmd] [cmd] [cmd]  [Group: cmd] ...│  ← Button bar (top)
├─────────────────────────────────────────────┤
│  Console                                    │
│  $ openclaw health --json                   │
│  { "status": "ok", ... }                    │  ← Console output (bottom)
│                                             │
└─────────────────────────────────────────────┘
```

**Two sections only:**
1. **Button bar** (top) — grouped command buttons, always visible
2. **Console** (bottom) — command output, always visible

The terminal is always on screen. No collapsing, no hiding. The user always sees the console.

### Button Bar Pattern

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
| `confirm` | boolean | Show confirmation modal before running |
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

Buttons are disabled while any command is running. Only one command at a time.

### Console Component

File: `src/client/src/components/Console.jsx`

Reusable across all terminal-first pages. Takes these props:

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `lines` | array | `[]` | `[{ type: 'cmd'\|'out'\|'err', text?, cmd?, ts? }]` |
| `runningCmd` | string | `''` | Currently running command (empty = idle) |
| `onClear` | function | — | Clear handler |
| `label` | string | `'Console'` | Header label |
| `emptyMessage` | string | `'Click a button above...'` | Shown when lines is empty |
| `autoScroll` | boolean | `true` | Auto-scroll to bottom |
| `className` | string | `''` | Extra classes on outer container |
| `headerRight` | element | — | Extra elements in header (right side) |
| `children` | element | — | Extra elements below header bar (toolbar slot) |

**Line types in output:**

- `cmd` → Cyan prompt: `$ <command>` with timestamp
- `out` → Slate text (normal output)
- `err` → Red text (error output)

### Frontend State Pattern

Every terminal-first tab uses the same state:

```jsx
function SomeTab({ agent }) {
  const [consoleLines, setConsoleLines] = useState([])
  const [runningCmd, setRunningCmd] = useState('')

  async function run(cmd, opts = {}) {
    // Confirmation
    if (opts.confirm && !await confirm({ title: 'Run Command', message: `Run "${cmd}"?` })) return
    if (opts.danger && !await confirm({ title: 'Danger', message: `⚠ Run "${cmd}"?`, danger: true, confirmText: 'Run' })) return

    const ts = new Date().toLocaleTimeString()
    setRunningCmd(cmd)
    setConsoleLines((p) => [...p, { ts, cmd, type: 'cmd' }])

    // Open WebSocket to backend
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/exec/${agent.name}`)
    socket.onopen = () => socket.send(JSON.stringify({ type: 'run', cmd }))

    socket.onmessage = (evt) => {
      try {
        const d = JSON.parse(evt.data)
        if (d.type === 'stdout') setConsoleLines((p) => [...p, { text: d.text, type: 'out' }])
        else if (d.type === 'stderr') setConsoleLines((p) => [...p, { text: d.text, type: 'err' }])
        else if (d.type === 'close' || d.type === 'error') setRunningCmd('')
      } catch {}
    }

    socket.onclose = () => setRunningCmd('')
    socket.onerror = () => setRunningCmd('')
  }

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Button bar */}
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        {COMMAND_GROUPS.map((group) => (
          // ... group rendering (see Health tab)
        ))}
      </div>

      {/* Console */}
      <div className="flex-1 min-h-0">
        <Console
          lines={consoleLines}
          runningCmd={runningCmd}
          onClear={() => setConsoleLines([])}
          className="h-full"
        />
      </div>
    </div>
  )
}
```

### Backend: WebSocket Exec Endpoint

**Endpoint:** `ws://host/ws/exec/:name`

**Protocol:**

Client → Server:
```json
{ "type": "run", "cmd": "openclaw health --json" }
{ "type": "stdin", "text": "my-api-key-here\n" }
{ "type": "resize", "cols": 80, "rows": 24 }
```

Server → Client:
```json
{ "type": "stdout", "text": "..." }
{ "type": "stderr", "text": "..." }
{ "type": "close", "text": "0" }
{ "type": "error", "text": "Container not running" }
```

**Why WebSocket, not SSE:**
- Interactive flows need bidirectional communication (stdin for API keys, OAuth tokens)
- One connection per command session
- SSE is one-way (server→client only) — can't send credentials back

**Backend implementation:**

```js
// ws/exec/:name
wss.on('connection', (ws, req) => {
  const name = req.url.split('/')[3]
  let dockerProc = null

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)

    if (msg.type === 'run') {
      // Kill any existing process
      if (dockerProc) dockerProc.kill()
      dockerProc = spawn('docker', ['exec', '-i', name, 'sh', '-lc', msg.cmd])
      dockerProc.stdout.on('data', (d) => ws.send(JSON.stringify({ type: 'stdout', text: d.toString() })))
      dockerProc.stderr.on('data', (d) => ws.send(JSON.stringify({ type: 'stderr', text: d.toString() })))
      dockerProc.on('close', (code) => ws.send(JSON.stringify({ type: 'close', text: String(code) })))
    }

    if (msg.type === 'stdin' && dockerProc) {
      dockerProc.stdin.write(msg.text)
    }
  })

  ws.on('close', () => { if (dockerProc) dockerProc.kill() })
})
```

### Credential Paste Pattern

For interactive flows (API key entry, OAuth), the UI can inject credentials into the running command's stdin without the user typing:

```jsx
function pasteCredential(value) {
  if (wsRef.current?.readyState === WebSocket.OPEN && runningCmd) {
    wsRef.current.send(JSON.stringify({ type: 'stdin', text: value + '\n' }))
  }
}
```

This is used in the Messaging tab's split layout — credentials panel on the right, console on the left. Clicking a saved credential pastes it into the running command.

### Split Layout Variant (Messaging)

For pages that need a credentials side panel:

```
┌──────────────────────────┬──────────────┐
│  Console (3/4)           │ Creds (1/4)  │
│  $ openclaw channels ... │ [bot1] [bot2]│
│  Enter bot token: _      │ [user1]      │
└──────────────────────────┴──────────────┘
```

- Console takes 3/4 width, creds panel takes 1/4
- Creds panel shows saved bot tokens / user IDs
- Clicking a credential calls `pasteCredential()` → sends to WebSocket stdin
- Panel has a close button that clears state and refreshes data

## Command Chain Flow

1. User clicks a button → UI sends command via WebSocket.
2. Backend starts `docker exec -i <container> sh -lc <command>`.
3. Output streams to the console in real time.
4. Backend monitors output:
   - **Prompt detected** (e.g., "Enter your API key:") → user clicks credential button → stdin sent.
   - **Command completed** (exit code received) → `close` event → console freezes at Done.
5. User clicks a new button → old WebSocket closes, new command starts in same console.
6. Console is append-only. History accumulates until user clicks Clear.

## Rules

- One console per page — each page has its own terminal session.
- Command definitions are hardcoded per-page — not a config file, not scraped.
- The user cannot free-type. Only the UI sends commands. Keystrokes are grabbed and dropped.
- Command history is logged — exact CLI command + output/result.
- After a command finishes, info zone refreshes via manual Refresh button (auto-refresh later).
- Guided forms are designed per-page — depends on what data the page needs.
- Terminal prompt style: simple `$` is fine.
- Multi-command flows run sequentially in the same terminal. Post-setup verification commands can run internally without terminal display.
- **Console is always visible** — never collapsed, never hidden. The user must always see the terminal.
- Only one command runs at a time. Buttons are disabled during execution.

## Data

### OpenClaw Commands

#### Messaging

| Action | Command | Interactive? |
|--------|---------|:------------:|
| Setup | `openclaw channels add --channel <name>` | Yes |
| Login | `openclaw channels login --channel <name>` | Yes |
| Logout | `openclaw channels logout --channel <name>` | No |
| Configure | `openclaw channels add --channel <name>` | Yes |
| Remove | `openclaw channels remove --channel <name> --delete` | No |
| Status | `openclaw channels status` | No |
| List all | `openclaw channels list --all` | No |

#### Models

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

#### PADs

| Action | Command | Interactive? |
|--------|---------|:------------:|
| Create | `openclaw setup` | No |
| Backup | `openclaw backup create --output <path>` | No |
| Restore | `openclaw backup restore <path>` | No |
| Cron list | `openclaw cron list` | No |
| Cron add | `openclaw cron add ...` | Depends |
| Memory index | `openclaw memory index` | No |

## Implementation Checklist

When building a new terminal-first page:

- [ ] Define `COMMAND_GROUPS` const with page-specific commands
- [ ] Add tab to `TABS` array in `AgentDetail.jsx`
- [ ] Create `XxxTab({ agent })` function component
- [ ] Add state: `consoleLines`, `runningCmd`
- [ ] Add `run(cmd, opts)` function with confirmation + WebSocket
- [ ] Render button bar (top) + Console component (bottom)
- [ ] If interactive: add credential paste panel (split layout)
- [ ] If page needs data display: add info cards above button bar
- [ ] Backend: ensure `ws/exec/:name` endpoint exists (shared across pages)
- [ ] Test: button click → console output → command completes → idle

## Open Questions

- **Long-running commands** — background mode? Progress indicator?
- **Ctrl+C / interrupt** — should the user be able to abort a running command? How to surface it safely?
- **Command completion detection** — exit code alone, or also detect shell prompts?
