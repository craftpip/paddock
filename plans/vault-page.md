# Vault Page — Encrypted Key-Value Store (Plan)

## Name

**Vault** — short, fits in the nav, matches what it does (locked storage).

Alternatives if the user prefers: **Secrets**, **Keystore**, **Safe**.

## Concept

A single, uncategorized list of key-value pairs for critical info (API keys, tokens, URLs, IDs — anything). Unlike the Creds page, this has **no provider/type structure**. Just:

- **Name** (the key)
- **Description** (optional)
- **Value** (the secret)

Once stored, a value is **never shown again**. The list always renders asterisks. Values are **encrypted at rest** (AES-256-GCM) and only decrypted server-side, on demand, when another feature needs them (e.g. pasting an API key into the model setup terminal).

## Mockup

```
┌──────────────────────────────────────────────────────────────────────┐
│  Paddock   Agents  +Agent  Creds  Vault  Backups  …         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  Vault                                                  [+ Add]       │
│  Encrypted key-value store                                (or inline) │
│                                                                        │
│  ┌──────────────┬──────────────────────┬────────────┬────────────────┐│
│  │ Name         │ Description          │ Value      │                ││
│  ├──────────────┼──────────────────────┼────────────┼────────────────┤│
│  │ openrouter   │ main API key         │ ••••••••   │ [Edit] [Delete]││
│  │ telegram_ops │ ops bot token        │ ••••••••   │ [Edit] [Delete]││
│  │ nas_path     │ backup NAS root      │ ••••••••   │ [Edit] [Delete]││
│  │              │ (description empty)  │ ••••••••   │ [Edit] [Delete]││
│  └──────────────┴──────────────────────┴────────────┴────────────────┘│
│                                                                        │
│  Add entry (inline form, top of table):                                │
│  Name [          ]  Description [optional        ]  Value [        ]  │
│  [ Add ]                                                                │
│                                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

No tabs, no categories, no provider dropdown. One flat list.

## Data Model

New SQLite table in the existing `src/data/app.db` (add migration to `src/services/db.js`):

```sql
CREATE TABLE IF NOT EXISTS vault_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  enc_value TEXT NOT NULL,            -- base64(iv + authTag + ciphertext)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

The `value` column never holds plaintext. The JSON credentials file (`credentials.json`) is NOT touched — this is a separate store.

## Encryption

New service `src/services/vault.js` using Node's built-in `crypto` (no new deps):

- **Algorithm:** AES-256-GCM, random 12-byte IV per item, auth tag stored with ciphertext.
- **Key source:** `VAULT_KEY` env var (32+ bytes). If unset, derive a stable 32-byte key from `SESSION_SECRET` via scrypt (so it works out of the box, but with a warning logged).
- **Format stored:** `iv:tag:data` all base64 — self-contained per row.
- **Decrypt** happens only inside the service. The API layer never returns plaintext in list responses.

### Why a dedicated `VAULT_KEY`?

`SESSION_SECRET` is for sessions and may rotate (e.g. it's hardcoded in `.env` today). If it changes, vault data becomes undecryptable. A separate `VAULT_KEY` keeps the vault stable even if sessions rotate. Add to `.env`:

```
VAULT_KEY=<32+ random bytes, hex>
```

## API

| Method | Path | Body | Returns |
|--------|------|------|---------|
| GET | `/api/vault` | — | list: `{ items: [{ id, name, description, updated_at }] }` — **no value, no masked prefix, nothing** |
| POST | `/api/vault` | `{ name, description?, value }` | `{ ok: true, item: {...} }` |
| PUT | `/api/vault/:id` | `{ name?, description?, value? }` — empty `value` = keep existing | `{ ok: true, item: {...} }` |
| DELETE | `/api/vault/:id` | — | `{ ok: true }` |
| GET | `/api/vault/:id/decrypt` | — | `{ value }` — **admin only**, for terminal-paste integration (see below) |

Notes:
- POST rejects duplicate names (409).
- List responses never include plaintext or even a masked hint — the UI always shows a fixed `••••••••••`.
- All routes behind existing `requireAuth` + CSRF (`csrfCheck` for mutating methods), same as the rest of the panel.

## UI (React SPA)

- **File:** `src/client/src/pages/Vault.jsx` (mirrors `Credentials.jsx` styling: slate cards, cyan accents, mono values).
- **Route:** `/vault` added in `App.jsx`.
- **Nav:** `Vault` link in `DashboardLayout.jsx` between Creds and Backups.
- **Table columns:** Name | Description | Value | Updated | actions.
- **Value cell:** always `••••••••••` (fixed, no first-4-last-4 mask — user said never display it again).
- **Add form:** inline row above the table: Name (required), Description (optional), Value (`type=password`, required).
- **Edit:** opens the same inline form populated with name/description, value blank with placeholder "leave blank to keep existing value". Save does PUT.
- **Delete:** `confirm()` dialog, then DELETE, row removed (same pattern as Creds).
- Add/edit/delete all use the existing `api()` helper (`src/client/src/lib/api.js`) — CSRF handled automatically.

## Future Integration (not built now)

The whole point is reuse elsewhere:

- **Model setup terminal:** when `openclaw models auth paste-api-key` is waiting for input, the Vault list becomes a click-to-paste source (names only), same idea as the creds panel in the model-provider plan. Uses the `/decrypt` endpoint server-side → terminal stdin over WebSocket.
- **Bot onboarding:** `--bot <name>` / `--api-key` values pulled from Vault instead of `bot-prefixes.json`.
- Anything else that needs a secret: just reference by name.

The plan is to keep this page self-contained now; wiring the paste flows happens in later tasks.

## Files

**New:**
- `src/services/vault.js` — encrypt/decrypt + CRUD on SQLite
- `src/client/src/pages/Vault.jsx` — the page

**Modify:**
- `src/services/db.js` — add `vault_items` table to `migrate()`
- `src/app.js` — mount the 5 vault API routes (or move to a small `src/routes/vault.js`)
- `src/client/src/App.jsx` — route `/vault`
- `src/client/src/components/DashboardLayout.jsx` — nav link
- `.env` — add `VAULT_KEY` (documented; fallback to SESSION_SECRET works)

## Security Notes

- Value is encrypted at rest; DB leak alone does not reveal secrets without `VAULT_KEY`.
- Value never travels back to the browser in list/read responses.
- `/decrypt` is admin-only and intended for server-side paste flows, never for display.
- If `VAULT_KEY` is lost, values are unrecoverable — same as losing a real vault. Nothing plaintext is ever stored.
