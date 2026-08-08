# React Migration

> Last updated: 2026-08-09

The PAD Friends Web UI was migrated from EJS + HTMX + Tailwind CDN to a React SPA with Vite, Zustand, and Tailwind PostCSS.

## Stack

| Layer | Before | After |
|-------|--------|-------|
| Frontend | EJS + HTMX + Tailwind CDN | React + React Router + Tailwind PostCSS |
| Backend | Express + EJS rendering | Express (REST API, no server rendering) |
| State | HTMX + inline `<script>` | Zustand |
| Code editor | CM5 (local files) | `@codemirror/view` CM6 (npm) |
| Terminal | xterm.js (local files) | `@xterm/xterm` (npm) |
| Build | None (server-rendered) | Vite |

## Architecture

```
src/
├── app.js                 API server (no EJS)
├── mcp.js                 Paddock's own /mcp server (Streamable HTTP, 17 tools)
├── routes/agents.js       DEAD CODE — legacy EJS routes, not mounted
├── services/              Docker, workspace, VM, drivers, health, log-store, vault, backups (stub)
├── middleware/             Auth, rate limit
├── client/                React SPA
│   ├── src/
│   │   ├── pages/         Page components
│   │   ├── components/    Reusable (Navbar, Toast, Modal, Terminal, HealthCheckModal, ...)
│   │   ├── hooks/         useApi, useAuth, useInterval, useWebSocket
│   │   ├── stores/        Zustand: auth, agents, flash
│   │   ├── lib/           apiClient, helpers, web, theme
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   └── package.json
├── public/                Built React SPA (served by Express in prod)
└── data/                  SQLite + Vault (encrypted secrets)
```

## Routes

| Path | Component | Source |
|------|-----------|--------|
| `/login` | LoginPage | `pages/Login.jsx` |
| `/agents` | DashboardPage | `pages/Dashboard.jsx` |
| `/agents/create` | CreateAgentPage | `pages/CreateAgent.jsx` |
| `/agents/:id` | AgentDetailPage | `pages/AgentDetail.jsx` |
| `/backups` | GlobalBackupsPage | `pages/Backups.jsx` |
| `/vault` | VaultPage | `pages/Vault.jsx` |
| `/profile` | ProfilePage | `pages/Profile.jsx` |

AgentDetail modes: Commands, Workspace, Config, Web & Ports, Logs, Activity, Settings — plus a docked terminal on every mode (see `tabs/overview.md`).

## Dev

```bash
cd src/client && npm run dev
```

Vite dev server on port 5173, proxies `/api` and `/ws` to Express on 6789.

## Prod

```bash
cd src/client && npm run build  # outputs to src/public/
```
