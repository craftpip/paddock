# Skills (in the Commands pane)

Skills live in the **Commands** mode (the old dedicated Skills tab was removed
in the SPA migration). The installed-skills list is read-only; every action
**pastes `openclaw skills ...` commands into the docked terminal**.

> Last updated: 2026-08-09

## The rule: paste commands, not APIs

- **Install skill** — the prompt modal collects a ref, then runs
  `openclaw skills install <ref>` in the docked terminal (the old
  `/skills/install` backend route is unused).
- **Search / List tools** — already pasted commands.
- Skills list loads read-only from `GET /api/agents/:name/skills`
  (30s cache); the list distinguishes **User Skills** (installed from
  ClawHub, Git, or local) from **Bundled Skills** (shipped with OpenClaw).

## API surface (app.js)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents/:name/skills` | List skills + check (30s cache) — the only endpoint the UI still calls |
| GET | `/api/agents/:name/skills/info?name=<slug>` | Full skill info (read-only) |
| POST | `/api/agents/:name/skills/install` | Legacy headless install — no longer used by the UI (CommandsPane pastes `openclaw skills install <ref>`) |
| POST | `/api/agents/:name/skills/remove` | Legacy headless remove — unused |
| POST | `/api/agents/:name/skills/update` | Legacy headless update — unused |
| POST | `/api/agents/:name/skills/verify` | Legacy headless verify — unused |

The POST routes are kept for backward compatibility but are **not** wired to the
SPA.

## Components

- `src/client/src/pages/agent/CommandsPane.jsx` — Skills group (Install skill,
  Search, List tools)
