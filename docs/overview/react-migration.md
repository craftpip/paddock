# React Migration

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
├── routes/agents.js       JSON-only API
├── services/              Docker, workspace, VM, backup
├── middleware/             Auth, rate limit
├── creds.js               Credential manager
├── client/                React SPA
│   ├── src/
│   │   ├── pages/         Page components
│   │   ├── components/    Reusable (Navbar, Toast, Modal, Card, FileTable)
│   │   ├── hooks/         useApi, useAuth, useInterval, useWebSocket
│   │   ├── stores/        Zustand: auth, agents, flash
│   │   ├── lib/           apiClient, helpers
│   │   ├── App.jsx
│   │   └── main.jsx
│   ├── index.html
│   ├── vite.config.js
│   ├── postcss.config.js
│   ├── tailwind.config.js
│   └── package.json
├── public/                Built React SPA (served by Express in prod)
└── data/                  SQLite + credentials
```

## Routes

| Path | Component | Source |
|------|-----------|--------|
| `/login` | LoginPage | `pages/Login.jsx` |
| `/agents` | DashboardPage | `pages/Dashboard.jsx` |
| `/agents/create` | CreateAgentPage | `pages/CreateAgent.jsx` |
| `/agents/:id` | AgentDetailPage | `pages/AgentDetail.jsx` |
| `/backups` | GlobalBackupsPage | `pages/Backups.jsx` |
| `/credentials` | CredentialsPage | `pages/Credentials.jsx` |

AgentDetail tabs: Overview, Workspace, Terminal, Logs, Sessions, Config, MCP, Skills, Models, Messaging, Backups, Health, Activity.

## Dev

```bash
cd src/client && npm run dev
```

Vite dev server on port 5173, proxies `/api` and `/ws` to Express on 5050.

## Prod

```bash
cd src/client && npm run build  # outputs to src/public/
```
