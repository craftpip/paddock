# UI Enhancements

## SPA Polish & Quality of Life

### Agent Detail Page

- [x] **Tab state persistence** — remember which tab was active per agent (localStorage) so navigating back doesn't reset to the first tab.
- [x] **Tab loading states** — each tab should show a proper skeleton/spinner while loading, not a blank flash. (Skeleton component exists but not wired to data fetches.)
- [x] **Sticky tab bar** — when scrolling down on a tab with lots of content, the tab bar should stay visible at the top.
- [x] **Sidebar status/badge alignment** — status badge and action buttons (Stop, Restart) should be on the same line with compact icon buttons. Currently uses `gap-2 flex-wrap`.
- [x] **Hover stats alignment** — the hover panel (Net I/O, Disk I/O) uses CSS grid (`grid-cols-[auto_1fr]`) with short labels. Already done.
- [x] **Resource stats placeholder** — CPU and MEM lines show `&ndash;%` / `&ndash;` placeholders while loading. Already done.
- [x] **Tab order** — Core tools first, then configuration, then Settings. Sessions and Activity tabs removed. Already done.
- [x] **Activity merged into Overview** — full activity table shown in Overview tab below quick links. Already done.

### Workspace Tab

- [x] **Drag & drop upload** — drag zone already implemented.
- [x] **File preview for images** — png/jpg/gif/svg/webp render inline in the file modal.
- [x] **Search within workspace** — file name filter bar added.

### Consistent Page Layout

- [x] **Credentials page** — `max-w-7xl mx-auto px-4 sm:px-6 py-8` wrapper added.
- [x] **Global Backups page** — same wrapper added.
- [x] **Create Agent page** — `py-8` added to existing `max-w-xl mx-auto`.

### Dashboard / Fleet View

- [x] **Health indicators** — show CPU/memory/uptime next to the status indicator.
- [x] **Sorting & grouping** — sort by Name/Status/Type, group by Status/Type.
- [x] **Fleet Resources bar always visible** — always rendered with `&ndash;%` / `&ndash;` placeholders. Already done.
- [x] **Mem total instead of Mem avg** — total memory summed from all containers in human-readable format. Already done.

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
- [x] **Keyboard shortcuts** — Ctrl+K (search), Ctrl+N (new agent), Ctrl+S (save). Added in `lib/shortcuts.js`.
- [x] **Toast notification improvements** — `ToastProvider` with stacking, auto-dismiss, action/undo buttons, slide-in animation.
- [x] **Offline/broken state handling** — `OfflineBanner` shows "Connection lost" when backend is unreachable.
- [~] **Responsive mobile improvements** — tables hide columns on mobile; forms and terminal work needed. (Later)