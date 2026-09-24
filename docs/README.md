# Docs

Documentation for the Paddock web UI and website. Two halves: a **User Guide** in plain words, and a **Technical Reference** for readers who want depth.

## Start here

- New to Paddock? Begin at [Getting started](guide/getting-started.md).
- Building or debugging? Jump to the [reference map](#technical-reference-map) below.

## User guide

Simple words, no internals. Every page ends with a link back to its technical detail.

| Page | What it covers |
|---|---|
| [Getting started](guide/getting-started.md) | First PAD in 3 steps |
| [Your PADs](guide/agents.md) | Open, start, stop, delete, tabs |
| [The terminal](guide/terminal.md) | The docked shell and the paste rule |
| [Sharing on the web](guide/web-publish.md) | Publish a web page, SSH, extra ports |
| [Keeping secrets](guide/vault.md) | Vault PIN and everyday use |

## Technical Reference map

```
docs/
├── README.md                         ← this file (hub)
├── index.md                          ← website landing page
├── guide/                            ← user guide, plain words
│   ├── getting-started.md
│   ├── agents.md
│   ├── terminal.md
│   ├── web-publish.md
│   └── vault.md
└── reference/                        ← technical reference
    ├── STYLE-GUIDE.md                ← how to write docs
    ├── overview/                     ← architecture, business logic, react migration
    ├── backend/                      ← services, drivers, middleware, user management
    ├── pages/                        ← top-level page docs
    ├── tabs/                         ← one file per Agent Detail tab
    ├── components/                   ← stats, theme, ux
    └── operations/                   ← runbooks: lifecycle, openclaw
```

## Adding new docs

See **[STYLE-GUIDE.md](reference/STYLE-GUIDE.md)** — it is the rulebook. In short:

- **guide/** — user-facing *how-to* in plain words; every page links back to its reference detail
- **reference/overview/** — whole-system *explanation*: architecture, business logic, migration notes
- **reference/backend/** — *reference* for server modules: services, middleware, auth
- **reference/pages/** — one doc per top-level page, or an overview if pages are simple
- **reference/tabs/** — one file per Agent Detail tab. Covers frontend component, backend API routes
- **reference/components/** — reusable UI pieces that aren't full pages or tabs
- **reference/operations/** — *how-to* runbooks: deployment, dev workflow, git

The style guide covers the page skeleton, formatting rules, voice,
terminology, the plan-to-docs lifecycle, and the review checklist.

---

**Last Synced Commit:** `357c9c58b8bb11dc207f86c9d61981918d79824d`
