# Remove the Credentials Page + System — Full Removal (Plan)

**Date:** 2026-08-03
**Status:** Plan (no implementation yet)
**Replacement:** Vault (`/vault`) — already built and live.

## Goal

Delete the credentials page and the whole credential system behind it. The Vault
page (`src/client/src/pages/Vault.jsx`, route `/vault`, API `/api/vault*`) is the
replacement and is already in the nav. Nothing new to build.

## Usage Inventory (everything that touches credentials)

### Live React SPA

| File | Line | What |
|------|------|------|
| `src/client/src/pages/Credentials.jsx` | whole file | The page itself — 2 tabs (API Keys, Messaging: Bot Tokens + User IDs), add/delete forms |
| `src/client/src/App.jsx` | 12, 63 | `import Credentials`, `<Route path="/credentials">` |
| `src/client/src/components/DashboardLayout.jsx` | 36 | "Creds" nav link |
| `src/client/src/pages/Onboard.jsx` | 9-17, 26-32, 41-44, 92-139 | "or pick saved" dropdowns (bot tokens, user IDs, API keys) populated from `GET /api/credentials` |
| `src/client/src/pages/agent/CommandsPane.jsx` | 159-166, 177-198 | Messaging flow loads saved bot tokens/user IDs and renders "paste secret" chips |

### Backend (`src/app.js`)

| Line | What |
|------|------|
| 15 | `const creds = require('./creds')` |
| 1149-1212 | `scanCredentialUsage()` — matches creds to instance configs, feeds "Used By" badges |
| 1214-1222 | `enrichUsedBy()` helper |
| 1224-1231 | `filterCredsByOwner()` helper |
| 1233-1238 | `GET /api/credentials` |
| 1240-1249 | `POST /api/credentials/api-key` |
| 1251-1260 | `POST /api/credentials/bot-token` |
| 1262-1271 | `POST /api/credentials/user-id` |
| 1273-1285 | `POST /api/credentials/delete` |
| 1725 | `creds.importFromBotPrefixes()` at startup |

### Storage

- `src/creds.js` — credential manager (load/save/add/delete/import). Only imported by `app.js`.
- `src/data/credentials.json` — the credential store. **GIT-TRACKED** (committed since `7a36113`, ~Jul 19). Contains real secrets today.
- `src/data/bot-prefixes.json` — gitignored leftover; same bot token duplicated. `importFromBotPrefixes()` reads `/workspace/bot-prefixes.json` (root) which does NOT exist, so the import is currently a no-op. `scripts/` (the old onboard-bot.sh consumer) no longer exists, so nothing live reads this file.

### Dead legacy EJS (routes/agents.js is NOT mounted — safe to delete)

- `src/views/credentials.ejs`
- `src/views/partials/api_key_row.ejs`
- `src/views/partials/bot_token_row.ejs`
- `src/views/partials/user_id_row.ejs`
- `src/views/layout.ejs:104` — legacy "Creds" nav link
- `src/views/agents/messaging.ejs` — legacy messaging page, uses `savedCreds` (dead code, whole file is unmounted)
- `src/views/vm_create.ejs:94` — legacy create page "Credentials & API Keys" section with saved-credential dropdowns (dead code, whole file is unmounted)

### Docs — primary (`src/docs/`)

- `src/docs/architecture.md` — lines 17, 86, 106, 270-271, 512-546 (§10 Credential Management), 560, 802, 817, 877-891 (§11.17 Credentials Page), 1266
- `src/docs/task_create_docs.md` — line 19 (`creds.js` entry)
- `src/docs/TELEGRAM_POLLING_ISSUE.md` — line 41 (one mention, wording only)
- `src/docs/model_task.md:172` — historical task doc mentioning credential dropdown (optional)

### Docs — second tree (`docs/`, root)

- `docs/overview/architecture.md:31` — `creds.js` in file tree
- `docs/overview/react-migration.md:24, 40, 52` — creds.js, `data/` credentials, `/credentials` route table
- `docs/overview/business-logic.md:184, 187` — credentials in ownership model
- `docs/pages/overview.md:45, 224-272` — full Credentials page section + API table + Used By docs
- `docs/backend/user-management.md:25-28, 155-169, 194, 287` — credential owner scoping
- `docs/backend/services.md:105-124` — "Credential Manager (creds.js)" section

### AGENTS.md (project learnings, root)

- Lines 326, 383 — `creds.js` in structure lists
- Line 414 — "Legacy routes preserved: ... /credentials still work" (becomes stale)
- Line 489 — "Nav Items: Dashboard, +PAD, Backups, Creds" (should become Vault)
- Lines 102-139 — onboard-bot.sh / bot-prefixes.json learnings. **Note: `scripts/` no longer exists on disk**, so these describe a removed external script. Keep the history but flag as stale once the webui creds system is gone.

### NOT part of this (do not touch)

- `src/client/src/lib/api.js:22` — `credentials: 'same-origin'` is a fetch option, unrelated.
- Vault (`src/services/vault.js`, `/api/vault*`, `Vault.jsx`, `/vault` route + nav) — stays.
- `plans/*.md` — historical planning docs (terminal-first-ui, reconstruction, vault-page, etc.) stay as decision records; do not edit.

## Removal Steps

### 1. Delete the page + dead EJS

```
rm src/client/src/pages/Credentials.jsx
rm src/views/credentials.ejs
rm src/views/partials/api_key_row.ejs
rm src/views/partials/bot_token_row.ejs
rm src/views/partials/user_id_row.ejs
rm src/views/agents/messaging.ejs        # whole legacy messaging page is dead
```

### 2. SPA edits

- `App.jsx` — remove the `Credentials` import and the `/credentials` route. The
  SPA catch-all serves `index.html`; without a route, `/credentials` should show
  the app's no-match/redirect (verify behavior; optionally add a
  `<Navigate to="/vault">` fallback for anyone with the old URL bookmarked).
- `DashboardLayout.jsx` — remove the "Creds" link (line 36). Vault link stays.

### 3. Strip consumers

- `Onboard.jsx` — remove the `GET /api/credentials` fetch (lines 26-32), the
  saved-credential state (`botTokenName`, `userIdName`, `apiKeyName`,
  `botTokens`, `userIds`, `apiKeys`), the resolution logic (lines 41-44), and the
  three "pick saved" `<select>` elements (lines 95-100, 107-113, 133-138).
  Keep the direct-paste inputs (bot token, user ID, provider+API key).
- `CommandsPane.jsx` — remove `creds` state + `loadCreds()` (lines 159-166) and
  the `tokenEntries` secret chips (lines 177-181, 191-198). Messaging pills stay.

### 4. Backend edits (`src/app.js`)

- Remove line 15 `creds` require.
- Remove `scanCredentialUsage()`, `enrichUsedBy()`, `filterCredsByOwner()`.
- Remove the five `/api/credentials*` routes.
- Remove `creds.importFromBotPrefixes()` at line 1725.

### 5. Storage

- `rm src/creds.js`
- `rm src/data/credentials.json` and `rm src/data/bot-prefixes.json`
- **Before deleting the data files:** re-enter any secrets still in use into the
  Vault manually (Vault already has an add form at `/vault`). Vault items are the
  permanent home going forward.
- **Do NOT `git rm` silently — see Security note below.**

### 5b. Security: secrets were committed to git

`src/data/credentials.json` is tracked in git history and contains **real
secrets** (Telegram bot token `8775500299:AAF__rrfIzl41TwTQZ7ZRdQvawdyXmC_rqU`,
ollama-cloud API key `02d963ac548a4e2883816c851f2f2c74.DHCh9-CKIXZbvKtaerazpN5z`,
plus test/dummy keys). Removing the page is the right time to deal with this:

1. `git rm src/data/credentials.json` (remove from index + disk).
2. Flag to the user that these secrets are in history → **rotate the bot token
   (via BotFather) and the ollama-cloud key**. Purging git history
   (`git filter-branch` / BFG / `filter-repo`) is optional and should be user-approved.
3. Note that `src/data/bot-prefixes.json` already carries the same bot token
   (gitignored today, so no history issue).
4. Consider adding `src/data/credentials.json` to `.gitignore` anyway as a
   belt-and-braces guard for any future secrets file.

### 6. Docs

Primary tree (`src/docs/`):
- `src/docs/architecture.md`:
  - Remove/rewrite §10 "Credential Management" → replace with a short §10 pointing
    to Vault (`src/services/vault.js`, AES-256-GCM, `VAULT_KEY`).
  - Remove §11.17 "Credentials Page".
  - Remove `creds.js` / `credentials.ejs` from the file tree (lines 86, 106).
  - Remove the `/credentials` route rows (lines 270-271).
  - Fix the leftover mentions (560, 802, 817, 1266).
- `src/docs/task_create_docs.md` — remove the `creds.js` checklist line.
- `src/docs/TELEGRAM_POLLING_ISSUE.md` — reword line 41 if it still references the
  credential store (keep the auth-staleness point, drop the creds-page link).
- `src/docs/model_task.md:172` — optional; it's a historical task doc.

Second tree (`docs/`, root):
- `docs/overview/architecture.md` — drop `creds.js` line 31.
- `docs/overview/react-migration.md` — drop creds.js line 24, the `data/`
  credentials note line 40, and the `/credentials` route row line 52.
- `docs/overview/business-logic.md` — fix lines 184, 187 (credentials ownership
  references; Vault items aren't owner-scoped — check and update the model).
- `docs/pages/overview.md` — delete the whole "Credentials" section (224-272) and
  the line 45 wrapper note; replace with a pointer to Vault if the page index needs one.
- `docs/backend/user-management.md` — drop the "Credentials — Scoped by Owner"
  section (155-169) and the table rows (25-28) + `creds.js` row (287).
- `docs/backend/services.md` — drop the "Credential Manager (creds.js)" section
  (105-124); Vault belongs in its place if services are listed.

`AGENTS.md`:
- Update line 414 (drop `/credentials` from "legacy routes preserved").
- Update line 489 nav items: `Dashboard, +PAD, Vault, Backups`.
- Update structure lines 326, 383 to remove `creds.js`.
- Flag the onboard-bot/bot-prefixes block (102-139) as stale (`scripts/` is gone).

## Verification

1. Rebuild the SPA: `docker exec paddock-webui sh -c 'cd /app/client && npm run build'` (or host-side build), then `docker restart paddock-webui`.
2. Grep clean: no `credentials`/`creds` references left in `src/` (excluding
   `client/src/lib/api.js` fetch option, node_modules, public).
3. Nav shows Vault, no Creds. `http://10.69.1.164:6789/credentials` no longer renders the page.
4. Vault still works: add / edit / delete an item.
5. Onboard page: renders with direct-paste fields only, no saved-credential selects.
6. CommandsPane Messaging flow: pills render, no secret chips, no console errors.
7. Check `src/data/credentials.json` gone from disk AND from `git ls-files`; confirm nothing at startup reads it.
8. `git status` clean of unexpected changes; `git grep -i cred` returns only the allowed leftovers (fetch option, docs history).

## Out of Scope (future)

- Wiring Vault into Onboard/CommandsPane paste flows via `/api/vault/:id/decrypt`
  (this is the documented "Future Integration" in `plans/vault-page.md`) — a later task.
