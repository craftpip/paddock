# Docs

Documentation for the PAD Friends Web UI.

## Layout

```
docs/
├── README.md                         ← this file
├── overview/                         ← whole-system docs
│   ├── architecture.md               ← system architecture, containers, data flow
│   ├── business-logic.md             ← detailed workflows: discovery, workspace, lifecycle, backup, auth, terminal, MCP, skills, OAuth, config
│   └── react-migration.md            ← React migration details, stack, routes
├── backend/                          ← server-side modules
│   ├── services.md                   ← all 6 services with functions, schemas, business logic
│   ├── middleware.md                  ← auth + CSRF + rate limiter internals
│   └── user-management.md            ← multi-user system, owner-based scoping, data access rules
├── pages/                            ← top-level page docs
│   └── overview.md                   ← all 7 pages described
├── tabs/                             ← Agent Detail page tabs
│   ├── overview.md                   ← all 13 tabs described
│   ├── health.md                     ← diagnostic toolbox
│   ├── mcp.md                        ← MCP server management
│   ├── skills.md                     ← skill listing and management
│   └── settings.md                   ← container settings: update, docker, network, delete
├── components/                       ← shared/reusable UI pieces
│   └── stats.md                      ← sidebar Docker stats
└── operations/                       ← operational workflows
    └── overview.md                   ← agent lifecycle, dev workflow, git workflow
```

## Adding new docs

- **overview/** — whole-system docs: architecture, business logic, migration notes
- **backend/** — server-side services and middleware with function references and schemas
- **pages/** — one doc per top-level page, or an overview if pages are simple
- **tabs/** — one file per Agent Detail tab. Covers frontend component, backend API routes
- **components/** — reusable UI pieces that aren't full pages or tabs
- **operations/** — deployment, dev workflow, git, operational runbooks

When a plan from `plans/` is implemented, move it to the matching folder in `docs/` and rewrite it as documentation (drop planning language, keep what exists).
