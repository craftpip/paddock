# Shared UX Utilities

Promise-based dialogs, toasts, keyboard shortcuts, and connection-lost
handling shared across every page. The providers mount once in
`src/client/src/App.jsx` (Toast → Confirm → Prompt → Alert, outer to inner).

## Dialog primitives (`lib/confirm.jsx`, `lib/alert.jsx`, `lib/prompt.jsx`)

Each is a provider + a hook that returns a promise-resolving function. All
three auto-focus the dialog on open, resolve on Enter, cancel on Escape, and
cancel on backdrop click. `alert.jsx` renders `role="alertdialog"` + `aria-modal`;
`confirm.jsx` and `prompt.jsx` use `role="dialog"`.

| Hook | Purpose | Resolves with |
|------|---------|---------------|
| `useConfirm()` | yes/no, optional danger styling | `true` / `false` |
| `useAlert()` | informational, single OK (optional cancel) | `true` / `false` |
| `usePrompt()` | one or more text fields (`fields: [{ key, label, ... }]`) | values object / `null` |

Shared options: `{ title, message, danger, confirmText, cancelText, okText }`.
`message` renders with `whitespace-pre-wrap` (multi-line strings keep their
breaks).

## Toasts (`lib/toast.jsx`)

`useToast()` returns a function with per-type helpers:
`toast(message, opts)` plus `toast.success` / `toast.error` / `toast.warning`
/ `toast.info`.

Options: `type` (from the helper), `duration` (ms — default 4000, error 6000,
warning 5000; `0` = sticky), and `action` + `actionLabel` (default label
"Undo") — clicking the action runs it and dismisses the toast.

Stacked top-right (`top-4 right-4 z-70`), slide-in animation, per-toast
dismiss button, `aria-label="Notifications"` region.

## Keyboard shortcuts (`lib/shortcuts.js`)

`useKeyboardShortcuts()` runs once in `App.jsx`. Ignored while an
input/textarea/contenteditable is focused:

- **Ctrl/Cmd+K** — focus search: `#global-search` first, else the first text
  input
- **Ctrl/Cmd+N** — navigate to `/agents/create`
- **Ctrl/Cmd+S** — click the element marked `data-shortcut="save"`

## Broken/offline state handling

There is no global offline banner — unreachable-backend and SSE-drop states
surface where they happen:

- `lib/api.js` — `api()` throws on any non-2xx (details in
  [`pages/overview.md`](../pages/overview.md) — Frontend Conventions); a
  network failure rejects with the fetch error and the caller surfaces its own
  message.
- Job modals (`HealthCheckModal`, `CommandModal`) show a "Connection lost"
  error row when a background job's SSE stream drops mid-run — the job itself
  continues server-side and the modal says so.

## See Also

- [`pages/overview.md`](../pages/overview.md) — where each utility is used
- [`theme.md`](theme.md) — design tokens and palette behind the styling
