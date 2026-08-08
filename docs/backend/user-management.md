# User Management

Multi-user system with owner-based scoping. Every resource in Paddock belongs to a user. Admins see everything and manage users. Regular users only see what they own.

```
          ┌──────────────────┐
          │   Paddock Login  │
          │  ┌────────────┐  │
          │  │ admin/_____│  │
          │  │ pass/_____ │  │
          │  │  [ Sign In ]│  │
          │  └────────────┘  │
          └────────┬─────────┘
                   │
      ┌────────────┼────────────┐
      │            │            │
 admin role    user role    user role
 (sees all)   (own data)   (own data)
```

## Core Model — Owner-Based Scoping

Every resource has an `owner_id` that references `users(id)`. The rule:

| Who | Agents | Backups | Users |
|-----|--------|---------|-------|
| **admin** | All agents | All backups | All users |
| **regular user** | Only their agents | Only their backups | Only own profile |

No exceptions. No "view other user's data" unless you're admin.

## Database

### Users Table (`src/services/db.js`)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);
```

### Agents Owner Column

`agents.owner_id` references `users(id)`. Added via migration. Agents discovered from the filesystem before this migration have `owner_id = NULL` (orphans).

### User Sessions

`user_sessions` table backs the SQLite session store. Sessions survive server restarts.

### Seed

On first run, `seedDefaultAdmin()` creates an `admin`/`admin` user when the users table is empty:

```js
function seedDefaultAdmin(db) {
  const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (count === 0) {
    const passwordHash = hashPassword('admin');
    db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
      .run('admin_' + Date.now(), 'admin', 'Admin', 'admin', passwordHash);
  }
}
```

On fresh install: first startup seeds admin/admin → user logs in → can change password in Profile → creates other users as needed.

## Auth Middleware (`src/middleware/auth.js`)

- **`requireAuth()`** — checks `req.session.userId`. API/XHR: returns 401 JSON. Page loads: redirects to `/login` with `returnTo` saved. Bypassed if `AUTH_PASSWORD` is empty.
- **`requireAdmin()`** — checks `req.session.role === 'admin'`. Returns 403 if not admin.
- **`checkNeedsSetup()`** — redirects to `/setup` when no users exist (first-run flow).
- **CSRF** — token on every session, validated on all non-GET routes via `x-csrf-token` header.
- **Session store** — SQLite-backed (`user_sessions` table), persists across restarts. Cookie: `vmf.sid`, httpOnly, sameSite lax, 24h expiry.

## Backend Routes

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| `GET` | `/api/setup` | None | Returns `{ needsSetup }` |
| `POST` | `/api/setup` | None | Create first admin |
| `POST` | `/api/login` | None | Username + password |
| `POST` | `/api/logout` | All | Destroy session |
| `GET` | `/api/session` | All | Current session info |
| `GET` | `/api/users` | Admin | List all users |
| `POST` | `/api/users` | Admin | Create user |
| `DELETE` | `/api/users/:id` | Admin | Delete user |
| `POST` | `/api/users/:id/reset-password` | Admin | Reset user's password |
| `GET` | `/api/profile` | Auth | Own profile |
| `PATCH` | `/api/profile` | Auth | Update email |
| `POST` | `/api/profile/change-password` | Auth | Change own password |
| `GET` | `/api/profile/keys` | Auth | List own API keys (no hashes/raw keys) |
| `POST` | `/api/profile/keys` | Auth | Create an API key → `{ key: 'pk_live_…', row }` (raw key shown once) |
| `DELETE` | `/api/profile/keys/:id` | Auth | Revoke own key (owner-scoped; unknown id → 404) |

## Frontend Components

- **Login.jsx** — username + password form, redirects to `/setup` if no admin
- **Setup.jsx** — first-run admin creation form
- **Users.jsx** — admin user management page with create / reset-password / delete
- **Profile.jsx** — email update, change password, API Keys card (list / create / revoke, one-time raw-key reveal modal with Copy + ready client configs)
- **DashboardLayout.jsx** — nav with Users link (admin only), profile link (username + avatar)
- **stores/auth.js** — `username`, `role`, `userId`, `isAdmin()`

---

## Data Scoping

### Agent Fleet — Scoped by Owner

`getAgents()` in `src/services/agent-registry.js` filters by owner:

```
admin  → returns ALL agents
user   → returns WHERE owner_id = self
```

Agents discovered from the filesystem without an `owner_id` are orphans — visible only to admin.

### Agent Creation — Assign Owner

On create, `owner_id` is set to `req.session.userId`. Admin can override by passing `?assign_to=<user_id>` to create an agent for another user.

### Agent Detail / Activity / Sessions — Scoped

All routes that read agent data check ownership:

```js
function requireAgentAccess(req, res, next) {
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (req.session.role !== 'admin' && agent.owner_id !== req.session.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  req.agent = agent;
  next();
}
```

Applied to all agent endpoints: start, stop, restart, delete, config, logs, activity, sessions, reset.

**Terminal WebSocket** (`/ws/terminal/:vmName`) checks ownership inline on connect (runs before Express middleware):

```js
const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get(vmName);
if (!agent || (role !== 'admin' && agent.owner_id !== userId)) {
  ws.close(4003, 'Access denied');
  return;
}
```

### Vault — Not Owner-Scoped

Vault items (`vault_items` in SQLite) are encrypted at rest and shared by all
authenticated users. They are **not** owner-scoped — the Vault replaced the old
owner-scoped credentials system, which has been removed. The vault is always
locked behind a 4–6 digit PIN: every operation requires the PIN (backend is
stateless, no global unlock), and the item list stays visible while locked.

### API Keys — Scoped by Owner

API keys (`api_keys` table) belong to the user who created them — a user can
only list/revoke their own keys. Each key inherits its owner's role when used
on `/mcp`: admin keys → full fleet, user keys → only owned agents. Only the
sha256 hash is stored; the raw `pk_live_…` key is shown once at creation.

### Backups — Scoped by Owner

Backups inherit owner from the agent. A `backups` table in SQLite stores:

```sql
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  owner_id TEXT REFERENCES users(id),
  filename TEXT NOT NULL,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

`owner_id` is denormalized for fast querying but always matches the agent's owner.

`listBackups(userId, role)` filters:
- Admin: returns all backups
- User: returns only backups of agents where `owner_id = self`

### Dashboard — Scoped Stats

Fleet stats (total agents, running, stopped, backups) are filtered by role and userId. Admin sees orphan count. Regular users see only their own numbers.

### Agent Registry Sync — Preserve Owners

`discoverAgents()` in `src/services/agent-registry.js` syncs filesystem state into SQLite. During sync, `owner_id` is **never overwritten** — the update query explicitly excludes it:

```sql
UPDATE agents SET
  status = ?,
  runtime_ref = ?,
  updated_at = datetime('now')
WHERE name = ?;
```

New agents discovered from the filesystem (no owner yet) get `owner_id = NULL` — they become orphans that admin must assign.

### Admin Reassign Owner

Admin can reassign any agent to a different user:

```
POST /api/agents/:id/assign  body: { owner_id: "user_..." }
```

Updates `agents.owner_id` in SQLite.

---

## Edge Cases

### Orphaned Agents

Agents discovered from the filesystem without an `owner_id` are orphans. They exist in SQLite but no regular user can see them. Admin must explicitly assign them.

**When orphans occur:**
1. First migration from old system (existing agents get `owner_id = NULL`)
2. User deleted but their agents remain
3. Agent created via CLI directly (outside Paddock)

**Admin UI:** Orphan count shown on dashboard. Filtered view at `/admin/orphans` with `[Assign]` button per agent.

**API:**
- `GET /api/agents?orphans=true` — returns NULL-owner agents (admin only)
- `POST /api/agents/:id/assign` — body: `{ owner_id: "user_..." }`

### User Deletion

```
DELETE /api/users/:id
├── User has running agents → 409 Conflict ("Stop agents first")
├── User has stopped agents → Orphan them (owner_id = NULL), delete user
└── User has no agents → Delete user immediately
```

Agents become orphans on user deletion — admin can reassign them later.

### Self-Admin Deletion

Blocked — at least one admin must always exist:

```
DELETE /api/users/:id where id === session.userId && role === 'admin'
→ 403 Forbidden ("Cannot delete yourself")
```

### Last Admin Deletion

If the last admin is somehow deleted (e.g., direct DB manipulation), the system reverts to setup flow — `checkNeedsSetup()` returns true when admin count is 0.

### Session Expiry

- Sessions expire after 24 hours (cookie maxAge)
- API returns 401 → client redirects to `/login`
- Session stored in SQLite → survives server restart

### Concurrent Use

- Admin can be logged in on multiple browsers
- Each session is independent
- No "force logout other sessions" on password change (future feature)

---

## Files Reference

| File | Role |
|------|------|
| `src/services/db.js` | Users table, seed, migrations |
| `src/middleware/auth.js` | requireAuth, requireAdmin, checkNeedsSetup, CSRF |
| `src/app.js` | All user/session/profile API routes |
| `src/services/agent-registry.js` | Owner scoping in getAgents(), preserve owner in sync |
| `src/services/vm-manager.js` | Set owner_id on agent creation |
| `src/services/backup-manager.js` | Backup scoping by owner |
| `src/services/vault.js` | Encrypted Vault (not owner-scoped) |
| `src/client/src/pages/Login.jsx` | Login form |
| `src/client/src/pages/Setup.jsx` | First-run admin creation |
| `src/client/src/pages/Users.jsx` | Admin user management |
| `src/client/src/pages/Profile.jsx` | Own profile / password |
| `src/client/src/stores/auth.js` | Client-side auth state |
