# Middleware

> Last updated: 2026-08-17

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
  `/api/session`, `/login`, `/setup`, `/mcp`
- Owner scoping for `/api/agents/:name/*` happens in `app.param('name', …)`
  (and the terminal WebSocket inline): non-admin callers must own the agent

### Login / Logout
- Login: POST with username + password, compared against the `users` table hash
- On success: `session.authenticated = true`, `session.userId`, `session.role`
- On failure: 401 with an error message
- Logout: `req.session.destroy()`, redirect to `/login`

### CSRF
- Token generated per-session: `crypto.randomBytes(32).toString('hex')`
- Set on `req.session.csrfToken`, exposed via `/api/session`
- React SPA sends it as `x-csrf-token` header
- POST validation: compare token from `req.body._csrf` or `req.headers['x-csrf-token']` against session token
- GET/HEAD/OPTIONS exempt
- Failed CSRF: 403

## Rate Limiter (rateLimit.js)

IP-based in-memory rate limiter.

- Window: 60 seconds
- Default limit: 300 requests per window
- Storage: `Map<ip, { count, resetAt }>`
- Blocked requests return 429 with `Retry-After` header
- Cleanup: stale entries are pruned on each check

**Note:** Limit was bumped from 30 to 300 because a single agent detail page
fires many API requests (tab loads, stats polling, the docked terminal).

## User Management

Full user management documentation — owner-based scoping, data access rules, edge cases, and all API routes — lives in [`user-management.md`](user-management.md).
