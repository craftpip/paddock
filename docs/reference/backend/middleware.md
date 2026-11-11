# Middleware

> Last updated: 2026-11-12

## Auth (auth.js) — Session-Based Auth + CSRF

Business logic: See `overview/business-logic.md` — Auth and Session.

User management and owner scoping: [user-management.md](user-management.md).

### Session Setup
- Uses `express-session` with auto-generated or env-provided `SESSION_SECRET`
- Session cookie: `vmf.sid`, httpOnly, sameSite lax, 24h expiry
- No persistent session store — `MemoryStore`, sessions lost on restart. With
  `AUTO_LOGIN=true` the `ensureAutoLogin` middleware re-establishes the admin
  session on the next request, so the SPA survives a webui restart.

### Auth Middleware
- `requireAuth`: checks `session.authenticated`. If not set:
  - API/XHR requests: return 401 JSON
  - Page loads: redirect to `/login` with `returnTo` saved
  - Bypassed entirely when `AUTO_LOGIN=true`
- `requireAdmin`: checks `session.role === 'admin'`, else 403
- With real auth, paths exempt from `requireAuth`: `/api/setup`, `/api/login`,
  `/api/session`, `/login`, `/setup`, `/mcp`, `/mcp/runner`, and the docs site
  under `/website`
- Owner scoping for `/api/agents/:name/*` happens in `app.param('name', …)`
  (and the terminal WebSocket inline): non-admin callers must own the agent

### Login / Logout
- Login: POST with username + password, compared against the `users` table hash
- On success: `session.authenticated = true`, `session.userId`, `session.role`
- On failure: 401 with an error message
- Logout: `POST /api/logout` calls `req.session.destroy()` and answers `{ ok: true }`

### CSRF
- Token generated per-session: `crypto.randomBytes(32).toString('hex')`
- Set on `req.session.csrfToken`, exposed via `/api/session`
- React SPA sends it as `x-csrf-token` header
- Validation: compare token from `req.body._csrf` or `req.headers['x-csrf-token']` against session token
- Enforced once in `app.js` for every request under `/api`, not per route;
  `/api/login` and `/api/setup` are exempt (see [security.md](security.md))
- GET/HEAD/OPTIONS exempt
- Failed CSRF: 403 JSON `{ error: 'CSRF token invalid' }`

## Rate Limiter (rateLimit.js)

IP-based in-memory rate limiter.

- Window: 60 seconds
- Default limit: 300 requests per window
- Storage: `Map<ip, { start, count }>`
- Blocked requests return 429 JSON with `Retry-After` header
- Cleanup: a timer prunes stale entries every two windows

**Note:** Limit was bumped from 30 to 300 because a single agent detail page
fires many API requests (tab loads, stats polling, the docked terminal).

## User Management

Full user management documentation — owner-based scoping, data access rules, edge cases, and all API routes — lives in [`user-management.md`](user-management.md).

## See Also

- [Security model](security.md) — roles, admin-only routes, CSRF scope, the WebSocket Origin check
- [Vault](vault.md) — the admin-only vault routes and the PIN lockout
- [User management](user-management.md) — owner scoping and the user routes
