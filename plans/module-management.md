# Module Management — Agent Detail Refactor

## Problem

`AgentDetail.jsx` is **1868 lines** — 13 tab components, shared helpers, modals, and duplicated UI patterns all crammed into one file. Multiple agents working on different tabs means everyone touches the same file → merge conflicts, fragile code, impossible to review.

Worse: the 13 tabs copy-paste the same patterns everywhere — spinners, empty states, buttons, modals, tables, status dots, fetch logic. There's no reusability. This is not production-grade.

## Architecture

### Current: One Monolith

```
AgentDetail.jsx (1868 lines)
├── SidebarStatus (shared layout)
├── HealthTab (NESTED inside AgentDetail function scope)
├── OverviewTab
├── TerminalTab
├── WorkspaceTab (336 lines — largest)
├── LogsTab
├── SessionsTab
├── ConfigTab
├── McpTab (244 lines)
├── SkillsTab
├── ModelsTab
├── MessagingTab (205 lines)
├── BackupsTab
├── ActivityTab
├── StatBox, QuickLink, SkillCard, InstallForm (helpers)
├── 3 modals (file viewer, probe result, skill info)
└── 8+ duplicated UI patterns
```

### Target: Layout Shell + Independent Tab Modules + Shared Component Library

```
src/client/src/
├── pages/
│   ├── AgentDetail.jsx              ← ~80 lines (layout shell only)
│   └── agents/                      ← tab modules (one file per tab)
│       ├── OverviewTab.jsx
│       ├── WorkspaceTab.jsx
│       ├── TerminalTab.jsx
│       ├── LogsTab.jsx
│       ├── SessionsTab.jsx
│       ├── ConfigTab.jsx
│       ├── McpTab.jsx
│       ├── SkillsTab.jsx
│       ├── ModelsTab.jsx
│       ├── MessagingTab.jsx
│       ├── BackupsTab.jsx
│       ├── HealthTab.jsx
│       └── ActivityTab.jsx
├── components/
│   ├── ui/                          ← shared UI primitives
│   │   ├── Button.jsx
│   │   ├── Modal.jsx
│   │   ├── DataTable.jsx
│   │   ├── EmptyState.jsx
│   │   ├── StatusDot.jsx
│   │   ├── StatusBadge.jsx
│   │   ├── Banner.jsx
│   │   └── Spinner.jsx
│   ├── agents/                      ← agent-specific shared components
│   │   ├── SidebarStatus.jsx
│   │   ├── StatBox.jsx
│   │   ├── QuickLink.jsx
│   │   ├── SkillCard.jsx
│   │   ├── InstallForm.jsx
│   │   └── Console.jsx              ← already exists
│   └── Console.jsx                  ← already exists, stays
├── hooks/
│   ├── useAgentApi.js               ← fetch + loading + error state
│   └── useStreamLines.js            ← SSE/WebSocket → console lines
└── lib/
    ├── api.js                       ← already exists
    └── constants.js                 ← TABS, HEALTH_GROUPS, CHANNEL_ICONS, sourceLabel()
```

### AgentDetail.jsx — Layout Shell Only

The detail page owns **nothing** except the layout. It renders:
1. Sidebar (agent nav links + status block)
2. Top panel (agent name, status badge, CPU/MEM, start/stop/restart)
3. Content slot — the active tab renders here

No tab logic. No fetch calls. No modals. Just layout.

```jsx
import SidebarStatus from '../components/agents/SidebarStatus'
import { TABS } from '../lib/constants'
import OverviewTab from './agents/OverviewTab'
import WorkspaceTab from './agents/WorkspaceTab'
// ... all 13 tab imports

export default function AgentDetail() {
  const { agentId } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { agents, fetchAgents } = useAgents()
  const agent = agents.find(a => a.name === agentId)
  const currentTab = location.hash.replace('#', '') || 'overview'

  useEffect(() => { fetchAgents() }, [agentId])

  if (!agent) return <Spinner message="Loading agent..." />

  const TabContent = TAB_MAP[currentTab] || OverviewTab

  return (
    <div className="flex h-full">
      <SidebarStatus agent={agent} />
      <main className="flex-1 overflow-y-auto p-6">
        <TabContent agent={agent} />
      </main>
    </div>
  )
}
```

~80 lines. That's it.

---

## Shared UI Component Library

These replace the copy-pasted patterns across all 13 tabs.

### 1. `<Button>` — replaces 22+ inline button patterns

**Currently duplicated:** Primary (cyan) ×9, Danger (red) ×5, Ghost/icon ×6, Warning (amber) ×2, all with slightly different padding/radius/colors.

```jsx
// src/client/src/components/ui/Button.jsx
export default function Button({
  variant = 'primary',   // primary | secondary | danger | warning | ghost
  size = 'sm',           // sm | md
  icon = false,
  disabled = false,
  loading = false,
  onClick,
  children,
  className = '',
  ...props
}) {
  const base = 'inline-flex items-center justify-center font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
  const variants = {
    primary:   'bg-cyan-600 hover:bg-cyan-500 text-white',
    secondary: 'bg-slate-700 hover:bg-slate-600 text-white',
    danger:    'text-red-400 hover:text-red-300',
    warning:   'bg-amber-600 hover:bg-amber-500 text-white',
    ghost:     'text-slate-400 hover:text-white hover:bg-slate-700',
  }
  const sizes = {
    sm: icon ? 'p-1.5 rounded text-xs' : 'px-3 py-1.5 rounded-lg text-xs',
    md: icon ? 'p-2 rounded-lg text-sm' : 'px-4 py-2 rounded-lg text-sm',
  }

  return (
    <button
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled || loading}
      onClick={onClick}
      {...props}
    >
      {loading && <Spinner size="xs" className="mr-1.5" />}
      {children}
    </button>
  )
}
```

**Replaces:** Every `<button className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500...">` across all tabs.

### 2. `<Modal>` — replaces 3 inconsistent modals

**Currently duplicated:** File viewer modal (WorkspaceTab), probe result modal (McpTab), skill info modal (SkillsTab). All have the same skeleton but different close handlers, sizes, and escape handling.

```jsx
// src/client/src/components/ui/Modal.jsx
export default function Modal({
  title,
  onClose,
  size = 'md',           // sm | md | lg | fullscreen
  footer = null,
  children,
}) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    fullscreen: 'w-[80vw] h-[80vh] max-w-none',
  }

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className={`bg-slate-800 border border-slate-700 rounded-xl shadow-2xl flex flex-col ${sizes[size]} mx-4`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700">
          <h3 className="text-sm font-medium text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end px-4 py-3 border-t border-slate-700">{footer}</div>}
      </div>
    </div>
  )
}
```

**Replaces:** All 3 modals with consistent escape handling, backdrop click, and sizing.

### 3. `<DataTable>` — replaces 5 copy-pasted table wrappers

**Currently duplicated:** WorkspaceTab, SessionsTab, ActivityTab, BackupsTab, ModelsTab all have the same `<div className="border border-slate-800 rounded-xl overflow-hidden"><div className="overflow-x-auto"><table...>` wrapper.

```jsx
// src/client/src/components/ui/DataTable.jsx
export default function DataTable({ columns, rows, emptyMessage, className = '' }) {
  return (
    <div className={`border border-slate-800 rounded-xl overflow-hidden ${className}`}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-xs border-b border-slate-800">
              {columns.map((col) => (
                <th key={col.key} className={`px-4 py-2 ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  <EmptyState message={emptyMessage} />
                </td>
              </tr>
            ) : rows.map((row, i) => (
              <tr key={row.id || i} className="border-b border-slate-800/50">
                {columns.map((col) => (
                  <td key={col.key} className="px-4 py-2">
                    {col.render ? col.render(row[col.key], row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

**Usage:**
```jsx
<DataTable
  columns={[
    { key: 'name', label: 'Name' },
    { key: 'status', label: 'Status', render: (v) => <StatusBadge status={v} /> },
    { key: 'actions', label: '', align: 'right', render: (_, row) => <Button variant="danger" onClick={() => del(row)}>Delete</Button> },
  ]}
  rows={sessions}
  emptyMessage="No sessions recorded yet."
/>
```

### 4. `<EmptyState>` — replaces 8 different empty state patterns

**Currently duplicated:** Plain text ×5, icon+text ×2, icon+text+CTA ×1. All different markup.

```jsx
// src/client/src/components/ui/EmptyState.jsx
export default function EmptyState({ icon, message, action }) {
  return (
    <div className="text-center py-12">
      {icon && <div className="w-10 h-10 mx-auto mb-3 text-slate-600">{icon}</div>}
      <p className="text-slate-500 text-sm mb-3">{message}</p>
      {action && (
        <Button variant="primary" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
```

### 5. `<Spinner>` — replaces 2 duplicated spinner variants

**Currently duplicated:** Centered variant (WorkspaceTab) and inline variant (McpTab, SkillsTab). Same animation, different sizes.

```jsx
// src/client/src/components/ui/Spinner.jsx
export default function Spinner({ message = 'Loading...', size = 'md', className = '' }) {
  const sizes = { sm: 'w-4 h-4', md: 'w-5 h-5', lg: 'w-8 h-8' }
  return (
    <div className={`flex items-center gap-2 text-slate-400 text-sm ${className}`}>
      <span className={`${sizes[size]} border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin`} />
      {message}
    </div>
  )
}
```

### 6. `<StatusDot>` — replaces 5 inline status dot patterns

**Currently duplicated:** 5 tabs render `<span className="w-2 h-2 rounded-full bg-emerald-400" />` with slightly different sizes and colors.

```jsx
// src/client/src/components/ui/StatusDot.jsx
export default function StatusDot({ status, size = 'sm', pulse = false, className = '' }) {
  const colors = {
    ok: 'bg-emerald-400',
    error: 'bg-red-400',
    warn: 'bg-amber-400',
    idle: 'bg-slate-600',
  }
  const sizes = { sm: 'w-2 h-2', md: 'w-2.5 h-2.5' }
  return (
    <span className={`${sizes[size]} rounded-full flex-shrink-0 ${colors[status] || colors.idle} ${pulse ? 'animate-pulse' : ${className}`} />
  )
}
```

### 7. `<StatusBadge>` — replaces 2 badge patterns

```jsx
// src/client/src/components/ui/StatusBadge.jsx
export default function StatusBadge({ status, variant = 'pill' }) {
  const styles = {
    running:  variant === 'pill'
      ? 'bg-emerald-900/50 text-emerald-400 border border-emerald-800'
      : 'bg-emerald-900/50 text-emerald-400',
    exited:   variant === 'pill'
      ? 'bg-red-900/50 text-red-400 border border-red-800'
      : 'bg-red-900/50 text-red-400',
    active:   'bg-emerald-900/50 text-emerald-400',
    error:    'bg-red-900/50 text-red-400',
    inactive: 'bg-slate-800 text-slate-400 border border-slate-700',
  }
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${styles[status] || styles.inactive}`}>
      {status}
    </span>
  )
}
```

### 8. `<Banner>` — replaces 5 inline msg/error displays

```jsx
// src/client/src/components/ui/Banner.jsx
export default function Banner({ type = 'info', children }) {
  if (!children) return null
  const colors = {
    info: 'text-cyan-400',
    error: 'text-red-400',
    success: 'text-emerald-400',
    muted: 'text-slate-400',
  }
  return <div className={`mb-4 text-xs ${colors[type]}`}>{children}</div>
}
```

---

## Shared Hooks

### `useAgentApi(endpoint, options)` — replaces 11 duplicated fetch patterns

**Currently duplicated:** Every data-fetching tab writes its own `useEffect` + `api()` + `setState` + error handling.

```jsx
// src/client/src/hooks/useAgentApi.js
import { useState, useEffect, useCallback } from 'react'
import { api } from '../lib/api'

export function useAgentApi(agentName, endpoint, { deps = [], load = true } = {}) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const fetch = useCallback(() => {
    setLoading(true)
    setError('')
    api(`/api/agents/${agentName}/${endpoint}`)
      .then(setData)
      .catch((e) => setError(e.error || e.message || 'Failed to load'))
      .finally(() => setLoading(false))
  }, [agentName, endpoint, ...deps])

  useEffect(() => { if (load) fetch() }, [fetch, load])

  return { data, loading, error, refetch: fetch }
}
```

**Usage in a tab:**
```jsx
function McpTab({ agent }) {
  const { data: servers, loading, error, refetch } = useAgentApi(agent.name, 'mcp-servers')

  if (loading) return <Spinner />
  if (error) return <Banner type="error">{error}</Banner>
  // ... render servers
}
```

**Replaces:** The duplicated `useEffect(() => { api(...).then(...).catch(...) }, [agent.name])` in all 11 data-fetching tabs.

### `useStreamLines()` — replaces 2 duplicated streaming patterns

**Currently duplicated:** HealthTab (SSE) and MessagingTab (WebSocket) both parse stdout/stderr messages into the same `consoleLines` array.

```jsx
// src/client/src/hooks/useStreamLines.js
import { useState, useCallback, useRef } from 'react'

export function useStreamLines() {
  const [lines, setLines] = useState([])
  const [runningCmd, setRunningCmd] = useState('')

  const appendLine = useCallback((text, type = 'out') => {
    setLines((prev) => [...prev, { text, type }])
  }, [])

  const clear = useCallback(() => setLines([]), [])

  const handleSSE = useCallback((es) => {
    es.onmessage = (e) => {
      try {
        const d = JSON.parse(e.data)
        if (d.type === 'stdout') appendLine(d.text, 'out')
        else if (d.type === 'stderr') appendLine(d.text, 'err')
        else if (d.type === 'close' || d.type === 'error') { es.close(); setRunningCmd('') }
      } catch {}
    }
    es.onerror = () => { es.close(); setRunningCmd('') }
  }, [appendLine])

  const handleWS = useCallback((socket) => {
    socket.onmessage = (evt) => {
      try {
        const d = JSON.parse(evt.data)
        if (d.type === 'stdout') appendLine(d.text, 'out')
        else if (d.type === 'stderr') appendLine(d.text, 'err')
        else if (d.type === 'close' || d.type === 'error') setRunningCmd('')
      } catch {}
    }
    socket.onclose = () => setRunningCmd('')
    socket.onerror = () => setRunningCmd('')
  }, [appendLine])

  return { lines, runningCmd, setRunningCmd, clear, handleSSE, handleWS }
}
```

---

## Tab Extraction Order

Extract in dependency order — build shared components first, then move tabs from simplest to most complex:

### Phase 1: Shared Component Library

| Step | File | What |
|------|------|------|
| 1.1 | `components/ui/Button.jsx` | Button component |
| 1.2 | `components/ui/Spinner.jsx` | Loading spinner |
| 1.3 | `components/ui/EmptyState.jsx` | Empty state |
| 1.4 | `components/ui/StatusDot.jsx` | Status dot |
| 1.5 | `components/ui/StatusBadge.jsx` | Status badge |
| 1.6 | `components/ui/Banner.jsx` | Message/error banner |
| 1.7 | `components/ui/Modal.jsx` | Modal dialog |
| 1.8 | `components/ui/DataTable.jsx` | Data table wrapper |
| 1.9 | `hooks/useAgentApi.js` | Fetch hook |
| 1.10 | `hooks/useStreamLines.js` | Streaming hook |
| 1.11 | `lib/constants.js` | Extract TABS, HEALTH_GROUPS, CHANNEL_ICONS, sourceLabel() |
| 1.12 | `components/agents/SidebarStatus.jsx` | Extract from AgentDetail |
| 1.13 | `components/agents/StatBox.jsx` | Extract from AgentDetail |
| 1.14 | `components/agents/QuickLink.jsx` | Extract from AgentDetail |
| 1.15 | `components/agents/SkillCard.jsx` | Extract from AgentDetail |
| 1.16 | `components/agents/InstallForm.jsx` | Extract from AgentDetail |

### Phase 2: Extract Tabs (simplest → most complex)

| Priority | Tab | Lines | Refactor Notes |
|----------|-----|-------|----------------|
| 2.1 | `LogsTab` | 34 | Use `<Spinner>`, use `useAgentApi` |
| 2.2 | `SessionsTab` | 39 | Use `<DataTable>`, `<StatusBadge>`, `<EmptyState>`, `useAgentApi` |
| 2.3 | `ActivityTab` | 41 | Use `<DataTable>`, `<StatusDot>`, `<EmptyState>`, `useAgentApi` |
| 2.4 | `OverviewTab` | 42 | Uses extracted `StatBox` + `QuickLink`, `useAgentApi` |
| 2.5 | `ConfigTab` | 42 | Use `<Banner>`, `useAgentApi` |
| 2.6 | `BackupsTab` | 75 | Use `<DataTable>`, `<Button>`, `<Banner>`, `<EmptyState>`, `useAgentApi` |
| 2.7 | `ModelsTab` | 82 | Use `<DataTable>`, `<Button>`, `<StatusDot>`, `<Banner>`, `useAgentApi` |
| 2.8 | `HealthTab` | 109 | **Extract from nested scope first.** Use `<Console>`, `<Button>`, `useStreamLines` |
| 2.9 | `SkillsTab` | 108 | Use extracted `SkillCard` + `InstallForm`, `<Button>`, `<Banner>`, `useAgentApi` |
| 2.10 | `TerminalTab` | 132 | Use `<Button>`, `<StatusDot>`. WebSocket stays custom. |
| 2.11 | `MessagingTab` | 205 | Use `<Console>`, `<Button>`, `<StatusDot>`, `useStreamLines` |
| 2.12 | `McpTab` | 244 | Use `<Modal>`, `<Button>`, `<StatusDot>`, `<Banner>`, `<Spinner>`, `useAgentApi` |
| 2.13 | `WorkspaceTab` | 336 | Use `<Modal>`, `<Button>`, `<DataTable>`, `<EmptyState>`, `<Banner>`. Largest — most refactoring. |

### Phase 3: Shell Extraction

| Step | What |
|------|------|
| 3.1 | Rewrite `AgentDetail.jsx` as thin layout shell (~80 lines) |
| 3.2 | Import all 13 tab modules |
| 3.3 | Remove all dead code from old AgentDetail |

---

## Verification

After each phase:

```bash
cd src/client && npm run build
# Must compile with zero errors
```

After full extraction:
1. Navigate to every tab via `/#tabname` — all render correctly
2. Test API calls in each tab — data loads, actions work
3. Test modals — escape key, backdrop click, close button all work
4. Test streaming — HealthTab SSE and MessagingTab WebSocket produce console output
5. Test workspace file operations — browse, upload, rename, delete, edit, save

No visual or behavioral changes. Same UI, same API calls, clean code.
