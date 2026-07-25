# Middleware

## Auth (auth.js) — Session-Based Auth + CSRF

Business logic: See `overview/business-logic.md` — Auth and Session.

User Management](pages/overview.md)`.

### Session Setup
- Uses `express-session` with auto-generated or env-provided `SESSION_SECRET`
- Session cookie: `vmf.sid`, httpOnly, sameSite lax, 24h expiry
- No session store (memory-based — sessions lost on restart)

### Auth Middleware
- `requireAuth`: Checks `session.authenticated`. If not set:
  - API/XHR requests: return 401 JSON
  - Page loads: redirect to `/login` with `returnTo` saved
  - Bypassed if `AUTH_PASSWORD` is empty (auth disabled)
- Paths exempt from requireAuth: `/api/*`, `/ws/*`

### Login / Logout
- Login: POST with `password`, compares to `AUTH_PASSWORD`
- On success: `session.authenticated = true`, redirect to `returnTo` or `/`
- On failure: render login page with error
- Logout: `req.session.destroy()`, redirect to `/login`

### CSRF
- Token generated per-session: `crypto.randomBytes(32).toString('hex')`
- Set on `req.session.csrfToken` and `res.locals.csrfToken`
- EJS templates get it via `<%= csrfToken %>`
- React SPA reads it from session API and sends as `x-csrf-token` header
- POST validation: compare token from `req.body._csrf` or `req.headers['x-csrf-token']` against session token
- GET/HEAD/OPTIONS exempt
- Failed CSRF: 403 JSON for API, 403 rendered error page for page loads

## Rate Limiter (rateLimit.js)

IP-based in-memory rate limiter.

- Window: 60 seconds
- Default limit: 300 requests per window
- Storage: `Map<ip, { count, resetAt }>`
- Blocked requests return 429 with `Retry-After` header
- Cleanup: stale entries are pruned on each check

**Note:** Limit was bumped from 30 to 300 because HTMX loads 8+ requests per agent detail page (each tab is a separate HTMX request).

## User Management

Full user management documentation — owner-based scoping, data access rules, edge cases, and all API routes — lives in [`user-management.md`](user-management.md).
