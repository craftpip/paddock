# Docs

Documentation for the PAD Friends Web UI.

## Layout

```
docs/
├── README.md                         ← this file (index + map)
├── STYLE-GUIDE.md                    ← how to write docs: format, voice, skeleton, terminology
├── overview/                         ← whole-system docs
│   ├── architecture.md               ← system architecture, containers, data flow
│   ├── business-logic.md             ← detailed workflows: discovery, workspace, lifecycle, backup, auth, terminal, MCP, skills, OAuth, config
│   └── react-migration.md            ← React migration details, stack, routes
├── backend/                          ← server-side modules
│   ├── services.md                   ← all services with functions, schemas, business logic
│   ├── middleware.md                  ← auth + CSRF + rate limiter internals
│   └── user-management.md            ← multi-user system, owner-based scoping, data access rules
├── pages/                            ← top-level page docs
│   └── overview.md                   ← pages: dashboard, create, agent detail, vault, backups, onboard
├── tabs/                             ← Agent Detail page tabs (modes)
│   ├── overview.md                   ← all tabs/modes described
│   ├── terminal.md                   ← the docked interactive shell (tmux + xterm)
│   ├── web.md                        ← Web & Ports tab: web app publish, SSH expose, extra ports, the socat door
│   ├── health.md                     ← container health checkup (lives in Settings)
│   ├── mcp.md                        ← MCP server management (Commands pane, paste-commands flow)
│   ├── skills.md                     ← skill listing (Commands pane, paste-commands flow)
│   └── settings.md                   ← container settings: update, health checkup, docker, network, workspace+volumes, ssh/ports, delete
├── components/                       ← shared/reusable UI pieces
│   ├── stats.md                      ← sidebar Docker stats
│   └── theme.md                      ← design guidelines: horse-brown palette, tokens, light/dark
└── operations/                       ← operational workflows
    ├── overview.md                   ← agent lifecycle, dev workflow, git workflow
    └── openclaw.md                   ← OpenClaw: cron, provider keys, updates, memory
```

## Adding new docs

See **`STYLE-GUIDE.md`** — it is the rulebook. In short:

- **overview/** — whole-system *explanation*: architecture, business logic, migration notes
- **backend/** — *reference* for server modules: services, middleware, auth
- **pages/** — one doc per top-level page, or an overview if pages are simple
- **tabs/** — one file per Agent Detail tab. Covers frontend component, backend API routes
- **components/** — reusable UI pieces that aren't full pages or tabs
- **operations/** — *how-to* runbooks: deployment, dev workflow, git

The style guide covers the page skeleton, formatting rules, voice,
terminology, the plan-to-docs lifecycle, and the review checklist.
