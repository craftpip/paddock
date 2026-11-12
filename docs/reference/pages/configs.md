# Configs Page

The Configs page (`/configs`) edits the control plane's own `.env` file: the variables the paddock
webui reads at boot, and the defaults it hands to new PADs. This page covers the page, the four
`/api/env` routes behind it, and which variables need which kind of reload. It is for admins and
for anyone changing the routes.

## Access

The page and its routes are admin-only. `src/routes/system.js` mounts `requireAdmin` on
`/api/env` (and `/api/paths`), so a regular user gets a 403, and the top-bar **Configs** link
(`DashboardLayout.jsx`) is rendered only for an admin. See [Security Model](../backend/security.md)
for the full gate table.

## Groups And Reload Impact

Each variable belongs to one group, and each group has one action button whose label is the
reload that group needs. The grouping lives in `GROUPS` in `pages/Configs.jsx`; the server
classifies the same keys in `envVarImpact()` and returns the result as `impact` on every variable.

| Group | Variables | Impact | Button |
|-------|-----------|--------|--------|
| Networking & Access | `CONTAINER_PREFIX`, `HOST_NAME`, `HOST_PROTO`, `HOST_WORKSPACE_ROOT` | `recreate` | **Recreate Container** (danger) |
| Authentication | `AUTO_LOGIN`, `SESSION_SECRET`, `AUTH_PASSWORD`, `VAULT_KEY` | `restart` (`VAULT_KEY` is `locked`) | **Restart Webui** |
| Agent Defaults | `DEFAULT_MODEL_BASE_URL`, `DEFAULT_MODEL_NAME`, `DEFAULT_CONTEXT_LENGTH`, `DEFAULT_ALLOW_FROM` | `agent` | **Apply Changes** |
| Permissions & Guards | `PUID`, `PGID`, `DOCKER_GID`, `GUARD_PROJECT_ROOT`, `GUARD_INSTANCES_PARENT`, `GUARD_AGENT_DATA` | `restart` | **Restart Webui** |
| System | `TZ` | `readonly` | none |

- **`recreate`** — the value is baked into the webui container's environment or its mounts, so a
  process restart is not enough.
- **`restart`** — read once at boot (`docker restart paddock`).
- **`agent`** — written to `.env` only; it takes effect on the next PAD create or build. Any key
  the server does not classify is also `agent`.
- **`locked`** — `VAULT_KEY` is shown masked and disabled with a lock icon. Changing it would make
  every existing Vault entry unreadable, so the server refuses it too.
- **`readonly`** — `TZ` is set in `docker-compose.yml`'s `environment`, not in `.env`, so it is
  displayed only.

A variable in `.env` that no group names is returned by the API but not rendered.

## Page Behavior

- Each row shows a label and hint (from `LABELS`, falling back to the `#` comment line directly
  above the variable in `.env`), an input matched to its type (text, number, URL, select, toggle
  `0`/`1`, secret), and a pulsing dot while it differs from the saved value.
- A group's button is disabled until one of its own rows is dirty. Clicking it opens a confirm
  dialog that says what will happen, then posts only that group's changed keys. Locked and
  read-only rows are never sent.
- After a save the page marks only the written keys as saved; unsaved edits in other groups stay.
  It does not re-read `/api/env`, because after a restart or recreate the server is on its way
  down. See [Client Conventions](../components/client-conventions.md#drafts-and-unsaved-edits).
- Leaving the page with unsaved edits is guarded (`useDirtyNavigation`).
- Secrets arrive masked (see below). The eye toggle reveals what is in the field — the mask, or a
  new value you typed — never the stored secret. A secret row you do not touch is not dirty, so
  the mask is never written back.

## API Endpoints

| Method | Route | Does |
|--------|-------|------|
| GET | `/api/env` | Parses `.env` into `{ vars: [{ key, value, isSecret, isLocked, isReadonly, impact, description }] }`. `description` is the preceding comment line (under 120 characters, no `=`) |
| POST | `/api/env` | Body `{ vars: { KEY: value } }`. Writes the file and returns `{ ok, updated, impacts }`. It never restarts anything; the client picks the follow-up |
| POST | `/api/env/restart` | Answers at once, then `docker restart paddock` (1 s grace) after 500 ms |
| POST | `/api/env/recreate` | Answers at once, then `docker compose -f /workspace/docker-compose.yml up -d --force-recreate webui`; on failure it falls back to a plain restart |

**Writes preserve the file.** `POST /api/env` replaces each named key's line in place (keeping a
trailing `# comment`), appends keys that were not in the file, and leaves every other line —
comments, blank lines, ordering — untouched.

**Refusals (400):** a key that is not a plain identifier (`^[A-Za-z_][A-Za-z0-9_]*$`); a value
containing a line break or NUL, because one `KEY=value` per line is the file's whole grammar and a
line break would write a second variable (that is how a locked key could be set through an
unlocked one); any locked key (`Cannot modify locked variables: VAULT_KEY`).

**Secrets never leave the process.** `SESSION_SECRET`, `VAULT_KEY` and `AUTH_PASSWORD` come back
as a fixed `••••••••` mask with `isSecret: true`.

**Restart and recreate are logged loudly** (`console.warn` with the caller's address and user
agent). Either one drops every open terminal WebSocket and in-memory job, so an unexplained call
must be attributable.

## See Also

- [Security Model](../backend/security.md) — admin gate, `.env` masking and refusals
- [Operations Overview](../operations/overview.md) — restarting and recreating the webui by hand
- [Vault](../backend/vault.md) — why `VAULT_KEY` is locked
- [Pages](overview.md) — the other top-level pages
