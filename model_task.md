# Models & Provider Management — Redesign Task

## Goal

Replace the current over-engineered models page (with embedded WebSocket terminal, ANSI regex stripping, client-side backup/restore dance) with a clean dashboard that:

1. Shows configured providers and their models in a table
2. Lets user set primary/fallback models with one click
3. Lets user add new providers by pasting an API key — no terminal emulation needed
4. Lets user remove providers
5. Includes a "Custom provider" fallback for arbitrary provider IDs

## Design Principle

The **terminal tab already exists**. The models page should NOT emulate a terminal. All provider auth setup happens server-side via `spawn()` with piped stdin, then the model catalog is auto-populated from `openclaw models list --all --json`.

---

## Page Layout

```
╔══════════════════════════════════════════════════════════════╗
║  Models & Providers                                         ║
║                                                             ║
║  ── Primary Model ────────────────────────────────────────  ║
║  ┌────────────────────────────────────────────────────────┐ ║
║  │ ollama-cloud / glm-5.1:cloud              [ Change ]   │ ║
║  └────────────────────────────────────────────────────────┘ ║
║                                                             ║
║  ── Fallback Model ──────────────────────────────────────  ║
║  ┌────────────────────────────────────────────────────────┐ ║
║  │ (none)                                    [ Remove ]  │ ║
║  └────────────────────────────────────────────────────────┘ ║
║                                                             ║
║  ── Configured Providers ────────────────────────────────  ║
║                                                             ║
║  ┌─ ollama-cloud ───────────────────────── 4 models ────┐  ║
║  │ ┌──────┬──────────┬──────┬──────┬──────────────────┐ │  ║
║  │ │ ID   │ Name     │Input │ Ctx  │ Actions          │ │  ║
║  │ ├──────┼──────────┼──────┼──────┼──────────────────┤ │  ║
║  │ │ glm..│glm-5.1..│ text │ 128K │ ★Primary ⤵FB    │ │  ║
║  │ │ glm..│glm-5.2..│ text │ 977K │ ★Primary ⤵FB    │ │  ║
║  │ │ kimi..│kimi-k2.5│ text │ 128K │ ★Primary ⤵FB    │ │  ║
║  │ │ mini..│minimax..│ text │ 128K │ ★Primary ⤵FB    │ │  ║
║  │ └──────┴──────────┴──────┴──────┴──────────────────┘ │  ║
║  │                                    [✕ Remove Provider] │  ║
║  └────────────────────────────────────────────────────────┘ ║
║                                                             ║
║  ── Add Provider ────────────────────────────────────────  ║
║                                                             ║
║  Grid of provider cards (click to expand inline):          ║
║  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       ║
║  │OpenAI│ │Anthr│ │Mistr│ │Coher│ │  xAI│ │Ollam│       ║
║  │      │ │opic │ │ al  │ │  e  │ │     │ │Cloud│       ║
║  │[+Key]│ │[+Key]│ │[+Key]│ │[+Key]│ │[+Key]│ │[+Key]│       ║
║  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘       ║
║  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐       ║
║  │OpenR│ │NVIDI│ │Novit│ │Toget│ │DeepS│ │ Volc│       ║
║  │outer│ │  A  │ │  a  │ │ her │ │ eek │ │ eng │       ║
║  │[+Key]│ │[+Key]│ │[+Key]│ │[+Key]│ │[+Key]│ │[+Key]│       ║
║  └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘       ║
║                                                             ║
║  ┌─ Custom ─────────────────────────────────────────────┐  ║
║  │ Provider ID: [________]  API Key: [________] [Add]  │  ║
║  └──────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Backend Routes (in `src/routes/agents.js`)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/:agentId/models/set-primary` | `{ model: "provider/id" }` |
| `POST` | `/:agentId/models/set-fallback` | `{ model: "provider/id" }` or `null` to clear |
| `POST` | `/:agentId/models/add-provider` | `{ provider, apiKey }` |
| `POST` | `/:agentId/models/remove-provider` | `{ provider }` |

### `/api/providers/add` (already in `app.js`)
Add API key for a provider — backend only, no WebSocket.

---

## Data Flow

### Adding a Provider
```
Browser                    Server (app.js)                    Container
  │                            │                                 │
  │  POST /api/providers/add   │                                 │
  │  {agent, provider, apiKey} │                                 │
  │ ─────────────────────────▶ │                                 │
  │                            │  Save config backup             │
  │                            │                                 │
  │                            │  spawn(docker exec -i ...       │
  │                            │    paste-api-key --provider X)  │
  │                            │  stdin.write(key + '\n')       │
  │                            │  stdin.end()                   │
  │                            │ ──────────────────────────────▶ │
  │                            │                                 │
  │                            │  Read new config (with auth)    │
  │                            │  Merge auth into saved config   │
  │                            │                                 │
  │                            │  Run docker exec ...            │
  │                            │    models list --all --json     │
  │                            │ ──────────────────────────────▶ │
  │                            │                                 │
  │                            │  Filter models by provider      │
  │                            │  Write to openclaw.json         │
  │                            │                                 │
  │  { ok: true, provider: X,  │                                 │
  │    models: [...],          │                                 │
  │    primary_updated: bool } │                                 │
  │ ◀───────────────────────── │                                 │
  │                            │                                 │
  │  HTMX re-renders the       │                                 │
  │  provider section + model  │                                 │
  │  picker                    │                                 │
```

### Setting Primary / Fallback
```
Browser                    Server
  │                            │
  │  POST /models/set-primary  │
  │  { model: "provider/id" } │
  │ ─────────────────────────▶ │
  │                            │  Read config → update
  │                            │  agents.defaults.model.primary
  │                            │  Write config → return updated
  │                            │
  │  HTMX swap: primary block │
  │ ◀───────────────────────── │
```

### Removing a Provider
```
Browser                    Server
  │                            │
  │  POST /models/remove       │
  │  { provider: "ollama" }   │
  │ ─────────────────────────▶ │
  │                            │  Remove auth.profiles[provider]
  │                            │  Remove models.providers[provider]
  │                            │  Clear primary/fallback if matching
  │                            │
  │  HTMX swap: entire page   │
  │ ◀───────────────────────── │
```

---

## Key Commands

| Command | Purpose |
|---------|---------|
| `openclaw models auth paste-api-key --provider <id>` | Add API key (stdin) |
| `openclaw models auth paste-token --provider <id>` | Add token (stdin) |
| `openclaw models auth login --provider <id> --device-code` | OAuth flow (TTY only) |
| `openclaw models list --all --json` | Full model catalog |
| `openclaw models list --json` | Configured models |
| `openclaw models auth list --json` | Auth profiles |

---

## Key Changes from Current Implementation

### What's Removed
- **Embedded WebSocket terminal in models.ejs** — the `openApiKeyTerminal()` function with ANSI regex, backup/restore, complex state machine
- **OAuth terminal in models.ejs** — the `startOAuthTerminal()` function
- **Credential dropdown** + save-as-credential flow (simplified to just API key input)
- **`/api/config/backup` and `/api/config/restore`** — no longer needed from browser side
- **All ANSI escape code handling** — backend captures clean stdout from `spawn`

### What's Kept/Improved
- **`/api/providers/add`** — already does the right thing (spawn + pipe), just needs error handling polish
- **`populateProviderModels()`** helper — already added, auto-populates model list from catalog
- **Provider grid** — simplified from the dropdown + custom provider flow
- **Model table** — same format, just cleaner with action buttons per row

### Files to Modify
| File | Change |
|------|--------|
| `src/views/agents/models.ejs` | Full rewrite — remove WebSocket terminal, add provider grid + inline forms + model action buttons |
| `src/routes/agents.js` | Add `POST /set-primary`, `POST /set-fallback`, `POST /remove-provider` |
| `src/app.js` | Clean up `/api/providers/add` (already done), keep `populateProviderModels` |

---

## Providers with Built-in Model Catalogs

These are available from `openclaw models list --all --json`:

| Provider | Model Count | Auth Type |
|----------|-------------|-----------|
| ollama-cloud | 4 | API Key |
| anthropic | 7 | API Key |
| mistral | 8 | API Key |
| cohere | 1 | API Key |
| novita | 6 | API Key |
| nvidia | 7 | API Key |
| together | 5 | API Key |
| deepseek | 2 | API Key |
| xiaomi | 3 | API Key |
| volcengine | 5 | API Key |
| byteplus | 3 | API Key |
| github-copilot | 14 | OAuth (TTY) |
| openai | (dynamic) | OAuth (TTY) |
| google | (dynamic) | OAuth (TTY) |

API Key providers get inline key input. OAuth providers redirect to terminal tab.

---

## Status

### Completed & Tested
- [x] `getCatalogProviders()` bug fixed: `r.stdout` → `r` (runCmd returns string, not object)
- [x] Rewrite `src/views/agents/models.ejs` — provider grid, inline API key form, model table with actions
- [x] Add `POST /:agentId/models/set-primary` route
- [x] Add `POST /:agentId/models/set-fallback` route
- [x] Add `POST /:agentId/models/remove-provider` route
- [x] Restart vm-webui and test end-to-end
- [x] ★ Primary — verified on vm-test3 (DOM updates, indicator, button highlight)
- [x] ⤵ FB — verified on vm-test3 (DOM updates, indicator, button highlight)
- [x] × Remove — verified on vm-test3 (provider removed from configured list)

### Partially Done
- [~] `/api/providers/add` endpoint exists — needs real API key to test `populateProviderModels()`
- [~] Provider grid shows catalog providers — verified unconfigured providers display correctly (15 providers listed)
- [~] Custom provider section present — not tested (requires API key)

### Minor Issues
- Rapid consecutive HTMX POST requests can trip CSRF race (same token used for two parallel replacements). Low risk in practice since users click one button at a time.
