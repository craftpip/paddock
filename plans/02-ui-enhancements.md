# UI Enhancements

## SPA Polish & Quality of Life

### Terminal Tab

- [x] **Copy on select** — `copyOnSelect: true` option set.

### Config Tab

- [x] **Search within config** — search bar filters matching lines with count.

### Logs Tab

- [x] **Log level filter** — filter by All/Info/Warn/Error.
- [x] **Search within logs** — search/filter log content by text.
- [x] **Timestamp toggling** — show/hide timestamps button.
- [x] **Auto-scroll lock** — toggle already existed.

### General

- [x] **Standardized confirmation modals** — `confirm.jsx` supports title, message, danger styling, confirm/cancel buttons. Already done.
- [x] **Standalone alert component** — `alert.jsx` (`AlertProvider` + `useAlert`), promise-based like `confirm`. Enter confirms, Escape dismisses; OK button auto-focused on open.
- [x] **Keyboard shortcuts** — Ctrl+K (search), Ctrl+N (new agent), Ctrl+S (save). Added in `lib/shortcuts.js`.
- [x] **Toast notification improvements** — `ToastProvider` with stacking, auto-dismiss, action/undo buttons, slide-in animation.
- [x] **Offline/broken state handling** — `OfflineBanner` shows "Connection lost" when backend is unreachable.
- [~] **Responsive mobile improvements** — tables hide columns on mobile; forms and terminal work needed. (Later)