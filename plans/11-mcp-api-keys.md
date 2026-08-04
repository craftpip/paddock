# MCP API Keys — Plan

## Status: Proposed (2026-08-04)

## Goal

The paddock MCP server (`/mcp`, from `plans/06-paddock-own-mcp.md`) is currently **open — no authentication**. Anyone who can reach the webui can drive the whole fleet through `paddock_*` tools. That needs per-user API keys.

Add an **API Keys** section to the user's **Profile page** (`/profile`) so each user can create, list, and revoke keys for the MCP. The keys replace the single static `MCP_TOKEN` from the MCP plan with real per-identity auth, and the `/mcp` endpoint stops working without a valid key.

## Current state

- `/mcp` is proposed to be Streamable HTTP on the existing Express server (5050/5051), guarded by one shared `MCP_TOKEN` env var (`plans/06-paddock-own-mcp.md`).
- Auth today is cookie-session (`/api/login`, CSRF) — MCP clients (opencode, Claude Code, Cursor) don't do cookies, which is exactly why a bearer token is needed.
- Users already exist in SQLite (`src/services/db.js` — `users` table, `role` admin/user). Agents have `owner_id`. The webui already scopes non-admin users to agents they own (`requireAgentAccess` / `app.param` in `src/app.js:393-419`).
- The Profile page exists (`src/client/src/pages/Profile.jsx`) with two cards: Email + Change Password. This plan adds a third card.

## Design

### Keys are per-user, scoped, stored hashed

- Each key belongs to a user and inherits that user's webui permissions:
  - **admin** keys → full fleet access (same as an admin session).
  - **user** keys → only the agents that user owns (same rule as `requireAgentAccess`).
- Only the **hash** of the key is stored. The raw key is shown **once** at creation, never again. Revocation is instant — delete the row.
- Keys work for the whole fleet, not per-agent. (Per-agent keys are a possible later add — see Open questions.)

### Key format

```
pk_live_<base64url-24-random-bytes>
```

- `pk_live_` prefix lets the server recognize the token format and lets users spot it in logs.
- ~32 chars of base64url from 24 bytes of `crypto.randomBytes` → 192 bits of entropy. Unbruteable.

### DB schema (`src/services/db.js` — new migration)

```sql
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,                  -- 'key_' + random
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,                   -- display label, e.g. "opencode on laptop"
  key_hash TEXT NOT NULL UNIQUE,        -- sha256 hex of the raw key (only this is stored)
  prefix TEXT NOT NULL,                 -- 'pk_live_...first8' for display in the list
  scopes TEXT NOT NULL DEFAULT 'default', -- 'default' = inherit user role (future: narrowed scopes)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
```

Store `sha256(key)` as hex. Lookup on every `/mcp` request is a single indexed query — cheap enough for MCP's request rate.

### `/mcp` auth middleware

Replace the static `MCP_TOKEN` check in the MCP plan with:

1. Read `Authorization: Bearer <key>` (also accept `?token=<key>` for simple clients).
2. Reject non-`pk_live_`-shaped tokens immediately (401).
3. `sha256` the token, look up in `api_keys` by `key_hash`.
4. Reject if missing or `revoked_at` set.
5. Touch `last_used_at` (throttled, not per-request — see Edge cases).
6. Set `req.mcpIdentity = { userId, role }`; tools enforce the same agent-ownership check as the REST API (`owner_id` match for non-admins).

No valid key → 401 JSON-RPC error. The MCP endpoint is effectively **closed by default** once this ships.

### API endpoints (session + CSRF protected, like the rest of the webui)

| Endpoint | What |
|----------|------|
| `GET /api/profile/keys` | list own keys (prefix, name, created, last_used, revoked) — **no hashes, no raw keys** |
| `POST /api/profile/keys` `{ name, scopes? }` | create a key → returns `{ key: 'pk_live_…' }` **only this once** + the row (id, prefix) |
| `DELETE /api/profile/keys/:id` | revoke (delete) own key; also handle unknown id as 404 |
| `POST /api/profile/keys/:id/revoke` | optional alias if we want soft-revoke (`revoked_at`) instead of hard delete |

All routes are scoped to `req.session.userId` — a user can only list/delete their **own** keys. Admin can manage other users' keys later via the Users page if needed (Open questions).

## UI — Profile page, third card

Add an **API Keys** card to `src/client/src/pages/Profile.jsx`, under the Change Password card (or above it — the keys card is the one users touch most).

```
┌── API Keys ──────────────────────────────────────────────────────────────┐
│  Keys used to connect MCP clients (opencode, Claude Code, Cursor)        │
│  to this paddock. Store them somewhere safe — you can only see a key     │
│  once, right after creating it.                                          │
│                                                                          │
│  Name                        Created          Last used        Actions   │
│  ──────────────────────────────────────────────────────────────────────  │
│  opencode on laptop          Aug 4, 2026      Aug 4, 2026       [Revoke] │
│  claude-desktop               Jul 30, 2026     never             [Revoke] │
│                                                                          │
│  [ + New key ]  → inline form: name input → Create → shows the raw key   │
│                   once in a modal with [Copy] + the ready client config  │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Create flow**: inline form (name input + Create button). On success, a modal shows the **raw key once** with a Copy button, plus copy-paste client configs (opencode / Claude Code snippets from `06-paddock-own-mcp.md`, now with the real key filled in).
- **List**: table of prefix, name, created, last used (or "never"), Revoke button with `confirm()`.
- **Revoke** deletes the row → the key stops working immediately.

## Client configs (what the user copies after creating a key)

opencode:
```json
{
  "mcp": {
    "paddock": {
      "type": "http",
      "url": "http://10.69.1.164:5051/mcp",
      "headers": { "Authorization": "Bearer pk_live_…" }
    }
  }
}
```

Claude Code:
```json
{
  "mcpServers": {
    "paddock": {
      "type": "http",
      "url": "http://10.69.1.164:5051/mcp",
      "headers": { "Authorization": "Bearer pk_live_…" }
    }
  }
}
```

## Changes to the earlier MCP plan

- `plans/06-paddock-own-mcp.md` said `/mcp` uses one static `MCP_TOKEN` env var. **This plan supersedes that**: auth becomes per-user `api_keys`. 
  - `MCP_TOKEN` stays only as an optional **fallback** (if `api_keys` returns no match, fall through to the static token) or is dropped entirely. Recommend dropping it — one auth path, no "who used which key" mystery.
- `plans/09-settings-page.md` Phase 4 installs the paddock MCP into agents with `PADDOCK_TOKEN=<MCP_TOKEN>`. Update it to create a **scoped service key** via the new API instead (or reference a dedicated key). Agents get their own key, revocable without affecting humans' keys.

## Files

**New:**
- `src/services/api-keys.js` — key generation, hashing, CRUD, `authenticate(token)` helper used by the MCP middleware.

**Modified:**
- `src/services/db.js` — `api_keys` table migration.
- `src/app.js` — `GET/POST /api/profile/keys`, `DELETE /api/profile/keys/:id`, and the MCP middleware wires `api-keys.authenticate()` (replacing the static `MCP_TOKEN` check when the MCP server lands).
- `src/client/src/pages/Profile.jsx` — the API Keys card (list, create, revoke, one-time reveal modal + client configs).
- `src/mcp.js` (from `06-paddock-own-mcp.md`) — auth middleware reads identity from `api-keys.authenticate()`; tools reuse the existing owner-scoping.
- `src/docs/architecture.md` — document `/api/profile/keys*` and the key auth on `/mcp`.

## Phases

### Phase 1 — Keys backend
- `api_keys` migration + `src/services/api-keys.js` (generate, hash, CRUD).
- `GET/POST/DELETE /api/profile/keys*` routes with session + CSRF + owner-scoping.
- Verify with curl: create → returns raw key once; list → no raw key; delete → gone.

### Phase 2 — Profile UI
- API Keys card in `Profile.jsx`: list + create + one-time reveal modal with Copy + revoke.
- Tested against the real endpoints in the browser (per AGENTS.md: always test before delivering).

### Phase 3 — Wire `/mcp` auth
- When `06-paddock-own-mcp.md` ships, `/mcp` uses `api-keys.authenticate()`.
- Tools map identity to permissions: admin → all agents, user → owned agents.
- Verify from opencode/Claude Code: valid key works, missing/revoked key → 401, non-admin key can't touch another user's agent.

## Verification

```bash
# create a key via the API (with a real session cookie)
curl -b cookies.txt -X POST http://10.69.1.164:5051/api/profile/keys \
  -H 'Content-Type: application/json' -H 'X-CSRF-Token: <token>' \
  -d '{"name":"test"}'
# → { key: 'pk_live_…' }  (only time you see it)

# use it on /mcp (once the MCP endpoint exists)
curl -s -X POST http://10.69.1.164:5051/mcp \
  -H "Authorization: Bearer pk_live_…" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize",...}'

# wrong / revoked key → 401 JSON-RPC error
curl -s -X POST http://10.69.1.164:5051/mcp -H "Authorization: Bearer pk_live_wrong…" …
```

- Revoke in the UI, then re-run the MCP call → 401.
- Non-admin user's key can `paddock_list_agents` but gets a 403-style error on `paddock_start_agent` for an agent they don't own.
- `last_used_at` updates on MCP activity; never reveals the raw key in the DB (only sha256 hex).

## Edge cases

| Case | Handling |
|------|----------|
| Raw key leaked | Revoke in the UI → hash lookup fails → 401 instantly; create a new key |
| DB read of `api_keys` | Only `key_hash` + `prefix` stored — a leaked DB doesn't leak usable keys |
| Non-admin key | Same ownership scoping as the REST API (`owner_id` match); MCP tools must call the same check |
| `last_used_at` writes | Throttle (e.g. update at most once per minute per key) to avoid a write on every MCP request |
| Deleted user | Keys cascade-delete (FK) or are garbage-collected; revoke on user delete |
| `MCP_TOKEN` static fallback | Dropped — one auth path. If kept, document that it bypasses per-user scoping |
| Concurrent sessions | Each client uses its own key; no session conflicts |
| Clock / future revocation | `revoked_at` check + hard delete — instant either way |

## Open questions

- **Admin managing other users' keys**: add a keys section to the Users admin page (`/users`), or keep keys strictly self-service on the Profile page? This plan keeps it self-service only.
- **Narrowed scopes**: `scopes` column is reserved but unused. Later could support `scopes: ['read', 'control']` or per-agent keys (`agent_id`). Needed?
- **MCP plan ordering**: this plan's Phase 3 depends on `/mcp` existing (`06-paddock-own-mcp.md`). Build order: keys backend + profile UI first (safe, no MCP dependency), then the MCP endpoint consumes it.
- **Settings-page agent keys**: should agents that get the paddock MCP installed (`09-settings-page.md` Phase 4) use a key generated here, or a separate system key type? A dedicated key the admin can revoke is the clean answer.

## Related

- `plans/06-paddock-own-mcp.md` — the `/mcp` server this authenticates; its `MCP_TOKEN` section is superseded by this plan.
- `plans/09-settings-page.md` — Phase 4 installs the paddock MCP into agents with a token; should switch to scoped keys.
- `src/client/src/pages/Profile.jsx` — where the API Keys card lands.
- `src/services/db.js` — `users` table; `api_keys` table added here.
- `src/app.js` — `requireAgentAccess` / `app.param` (the ownership rule keys inherit) at `app.js:393-419`.
