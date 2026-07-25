# Model Provider Panel — Plan

## Concept

Same pattern as messaging: status table at top, click an action to open terminal + creds panel below.

```
┌──────────────────────────────────────────────────────────────────┐
│  ⬅  Back to PAD                        Models — ozden       │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│  Model Providers                                                   │
│                                                                    │
│  ┌──────────┬────────────┬──────────────────────────────────────┐ │
│  │ Provider │ Status     │ Actions                              │ │
│  ├──────────┼────────────┼──────────────────────────────────────┤ │
│  │ openai   │ ✅ Active  │ [Login] [Re-auth] [Remove]          │ │
│  │ ollama   │ ✅ Active  │ [Remove]                             │ │
│  │ groq     │ ❌ Not set │ [Setup]                              │ │
│  │ openrouter │ ⚠️ Key?  │ [Setup]                              │ │
│  └──────────┴────────────┴──────────────────────────────────────┘ │
│                                                                    │
│  Primary Model: openai/gpt-4o                                      │
│  Fallback Model: ollama/llama3                                     │
│                                                                    │
│  [ + Add Provider ]                                                │
│                                                                    │
├─ ▼ Setup: groq ──────────────────────────────────── [✕ Close] ──┤
│                            │                                      │
│  ┌──────────────────────┐  │  ┌────────────────────────────────┐ │
│  │ Terminal             │  │  │ API Keys                      │ │
│  │                      │  │  │                                │ │
│  │ $ openclaw models    │  │  │ openai ─────────────────────┐ │ │
│  │ auth paste-api-key   │  │  │ │ work-key                 │ │ │
│  │ --provider groq      │  │  │ └──────────────────────────┘ │ │
│  │                      │  │  │ groq ──────────────────────┐ │ │
│  │ Paste API key: _     │  │  │ │ my-groq-key             │ │ │
│  │                      │  │  │ └──────────────────────────┘ │ │
│  │                      │  │  │                                │ │
│  │                      │  │  │ [+ Add]                        │ │
│  └──────────────────────┘  │  └────────────────────────────────┘ │
│                            │                                      │
└──────────────────────────────────────────────────────────────────┘
```

## OpenClaw Commands

### Status & Listing

| Action | Command |
|--------|---------|
| List configured providers | `openclaw models auth list --json` |
| List all available providers | `openclaw models list --all --json` (includes unconfigured catalog providers) |
| Full status (model + auth) | `openclaw models status --json` |
| Live auth probe | `openclaw models status --probe --json` |

### Auth Actions

| Action | Command | Interactive? |
|--------|---------|:------------:|
| **Setup (API key)** | `openclaw models auth paste-api-key --provider <id>` | ✅ (prompts for key) |
| **Setup (OAuth)** | `openclaw models auth login --provider <id>` | ✅ (opens browser flow) |
| **Setup (token)** | `openclaw models auth paste-token --provider <id>` | ✅ (prompts for token) |
| **Login / Re-auth** | `openclaw models auth login --provider <id> [--force]` | ✅ (re-runs auth flow; `--force` removes existing profiles first) |
| **Remove** | No direct CLI command — done via config manipulation (remove auth profiles + `models.providers.<id>` config entry) |
| **Set default model** | `openclaw models set <provider/model>` | ❌ (non-interactive) |

### Automation (for piping keys)
```bash
printf "%s\n" "$API_KEY" | openclaw models auth paste-api-key --provider groq
```

### Notes from docs

- `paste-api-key` writes to profile id `<provider>:manual` unless `--profile-id` is passed
- `paste-api-key` in automation: pipe the key on stdin
- `models auth login --provider openai` defaults to ChatGPT/Codex account login. Use `--method api-key` for an OpenAI API-key profile
- `models auth login --force` removes existing profiles for that provider first (use when a cached OAuth profile is stuck)
- `models auth login --set-default` applies the provider's recommended default model after login
- `models list --all --provider <id>` can show providers you haven't authenticated with yet
- `models status --probe` makes real API calls; may consume tokens and trigger rate limits

## How It Works

1. Page loads → runs `openclaw models auth list --json` + `openclaw models list --all --json`
   - First shows configured providers (status table)
   - Second populates the "Add Provider" catalog grid
2. User clicks **[Setup]** on an unconfigured provider →
   - Terminal + creds panel slide open
   - If it's an API-key provider: `openclaw models auth paste-api-key --provider <id>` executes
   - If OAuth: `openclaw models auth login --provider <id>` executes
3. CLI prompts for input → user clicks a key from the creds panel → pasted into terminal
4. Done → user closes panel → table refreshes with new status

## Credential Panel (API Keys)

### What It Lists
- Saved API keys from the credential manager, grouped by provider
- **Names only** — no keys visible

### Interaction
- Click a name → value sent to terminal stdin via WebSocket + `\n`
- No terminal or not waiting → click does nothing

## Add Provider Flow (no terminal yet)

The **[+ Add Provider]** section shows a grid of available providers from the catalog (already implemented). Clicking one opens the terminal + creds panel instead of the current inline form.

- **API-key providers** (groq, openrouter, etc.): Terminal runs `paste-api-key`
- **OAuth providers** (openai, google, github-copilot): Terminal runs `auth login`

## Status Table Columns

| Column | Data Source |
|--------|-------------|
| Provider | `models auth list` provider id |
| Status | `models status --json` → auth state (active / missing / expiring) |
| Actions | Context-dependent: [Setup], [Login], [Re-auth], [Remove] |

## Files to Create/Modify

- **New**: `src/views/agents/partials/provider-table.ejs` — status table + action buttons
- **Modify**: `src/views/agents/models.ejs` — compose table + terminal/creds panel (replace current add-provider forms)
- **Modify**: `src/app.js` — handle `credential-paste` in WebSocket (shared with messaging)
- **Modify**: `src/routes/agents.js` — routes for model auth commands via terminal
