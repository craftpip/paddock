# Vault

The Vault is Paddock's encrypted key-value store for secrets such as API keys and bot tokens. This
page is the reference for `src/services/vault.js` and `src/routes/vault.js`: where the keys come
from, how items are encrypted, what the PIN does, the HTTP routes and the storage tables. The
plain-words version for users is the [Vault guide](../../guide/vault.md).

> Last updated: 2026-11-12

## Server Key

Every vault operation needs a 32-byte server key. It comes from one of two places, in this order.

| Source | When | Detail |
|--------|------|--------|
| `VAULT_KEY` | the variable is set | hex of 32 bytes or more: the first 32 bytes are the key; any other string is stretched with scrypt |
| Key file | `VAULT_KEY` is unset | `vault.key` beside the database (`src/data/vault.key`, or next to `PAD_DB_PATH`) |

- **There is no built-in fallback value.** A key that can be derived from the source code protects
  nothing: a copy of the database would be enough to read every item.
- **The key file is generated on first use**: 32 random bytes as hex, mode `0600`, created with an
  exclusive open so an existing key is never overwritten. It stays root-owned (the ownership sweep
  skips it) and is git-ignored.
- **A key file that cannot be read is an error, not an absent file.** Only "no such file" leads to a
  new key. Any other read failure, or content that is not a 32-byte key, stops the operation with
  `The vault key file could not be read (…)` or `The vault key file is damaged (not a 32-byte
  key)`. Generating a new key at that point would orphan every item encrypted under the old one.

### Older Stores

A store with no PIN whose items were encrypted under a key derived from `SESSION_SECRET`, or from
the fixed string older versions fell back to, is migrated the first time the vault is used with no
`VAULT_KEY` and no key file:

1. A new key is generated in memory.
2. Every item is decrypted with the older keys and re-encrypted under the new key, in memory.
3. The key file is written, then all items are updated in one transaction.

If any item opens with none of the known keys, the operation stops before anything is written:
no item changes and no key file is left behind. The error names the item and says to set
`VAULT_KEY` to the value it was stored under. If the database update fails after the key file was
written, the key file is removed again, so the items stay readable under their old key.

## Encryption

Values are encrypted with AES-256-GCM. A stored value is `iv:tag:ciphertext`, each part base64, with
a fresh 12-byte IV per value. Names and descriptions are stored in the clear.

### Without A PIN

The server key encrypts each item directly.

### With A PIN

A PIN is 4 or 6 digits. Setting one creates a random 32-byte master key that encrypts the items.
The master key is stored wrapped, and the wrapping key needs both the PIN and the server key:

```text
PIN ──► scrypt(pin, salt, N=2^15, r=8, p=1) ──► HMAC-SHA256 keyed with the server key ──► wrap key
wrap key ──► AES-256-GCM ──► master_wrapped   (vault_meta, prefixed "v2:")
master   ──► AES-256-GCM ──► enc_value        (vault_items)
```

- **Why the server key is mixed in.** A 4 or 6 digit PIN alone is no protection against someone
  holding a copy of the database: every PIN can be tried in minutes. With the server key in the
  derivation, the database alone is not enough.
- **The scrypt cost** is about 100 ms per try on the development host.
- **The consequence: losing the server key loses the vault.** With a PIN set, the right PIN cannot
  open the vault without the same `VAULT_KEY` or the same key file. Back the key up with the
  database, or the backup is unreadable.
- A wrap that carries no `v2:` prefix was made from the PIN alone. It is re-wrapped under the PIN
  and the server key the first time the right PIN opens it. The master key is the same, so no item
  changes.

The vault is always locked. There is no unlock state: every value operation supplies the PIN, which
unwraps the master key for that one operation and is then discarded.

## PIN Operations

`setPin(pin, { reset, oldPin, wipe })` covers three operations. Each runs in one database
transaction, so a crash cannot leave items encrypted under a master key nobody holds.

| Operation | Request body | Needs | Items |
|-----------|--------------|-------|-------|
| First set | `{ pin }` | nothing else | kept: re-encrypted from the server key to the new master key |
| Change | `{ pin, reset: true, oldPin, password }` | current PIN and account password | kept: the same master key is re-wrapped under the new PIN |
| Forgot | `{ pin, wipe: true, password }` | account password | **erased**: every item deleted, new master key |

- **Change keeps every item** because the current PIN has just proved the master key is readable;
  only its wrapping changes.
- **Forgot is the only path that erases.** Without the current PIN nobody, Paddock included, can
  read the stored values, so the only way forward is an empty vault. The page says so before it
  asks for the password.
- **The password** is the signed-in user's own login password, checked by the route (`401 Password
  is incorrect`). It is required for change and forgot, not for a first set.
- Sending a bare `{ pin }` when a PIN is already set is refused with `A PIN is already set`.
  `reset` or `wipe` sent when no PIN is set acts as a first set.

## Wrong-PIN Lockout

Ten thousand PINs is a short loop for anything that can call the API, so wrong PINs are counted.

| Setting | Value |
|---------|-------|
| Wrong PINs in a row before a lock | 5 |
| First lock | 30 seconds |
| Each further lock | double the previous one |
| Longest lock | 15 minutes |

- While locked, every PIN is refused, the right one included.
- The try that trips the lock gets the lockout answer, not `Wrong PIN`.
- A correct PIN clears both the count and the doubling.
- A PIN that is not 4 or 6 digits is rejected before it is tried and does not count.
- The state is held in memory, so a webui restart clears it. Erasing the vault through the forgot
  path clears it too.
- The route answers `429` with a `Retry-After` header and
  `{ error, code: "vault_locked_out", retryAfterSeconds }`.

## HTTP Routes

All routes are admin-only (`requireAdmin` on the `/api/vault` prefix): the vault is one shared store
with one PIN. Non-GET routes need the CSRF token like every `/api` route. A refusal is `400` with
`{ error }` unless stated; the lockout is `429` as above.

| Method | Path | Body | Notes |
|--------|------|------|-------|
| GET | `/api/vault` | — | `{ items, meta: { pinSet, locked } }`; items carry `id`, `name`, `description`, timestamps and never a value |
| POST | `/api/vault/pin` | see [PIN Operations](#pin-operations) | `{ ok, meta, erased }`; `erased` is true for the forgot path |
| POST | `/api/vault` | `{ name, description?, value, pin }` | `name` and `value` required; a duplicate name is refused |
| PUT | `/api/vault/:id` | `{ name?, description?, value?, pin }` | an empty or absent `value` keeps the stored one |
| DELETE | `/api/vault/:id` | `{ pin }` | — |
| GET | `/api/vault/:id/decrypt` | — | PIN in the `X-Vault-Pin` request header; returns `{ value }` |

The decrypt route takes the PIN in a header so that it is never part of the request URL. `pin` is
ignored on every route while no PIN is set. The Commands pane uses the decrypt route to paste a
value straight into the docked terminal; see [commands](../tabs/commands.md).

## Storage

Both tables live in the SQLite database (`src/data/app.db`).

`vault_items`:

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER | primary key |
| `name` | TEXT | unique |
| `description` | TEXT | default `''` |
| `enc_value` | TEXT | `iv:tag:ciphertext` |
| `created_at`, `updated_at` | TEXT | `datetime('now')` |

`vault_meta` (a single row, `id = 1`):

| Column | Type | Notes |
|--------|------|-------|
| `pin_set` | INTEGER | `0` or `1` |
| `pin_salt` | TEXT | 16 random bytes as hex, new on every PIN operation |
| `master_wrapped` | TEXT | the wrapped master key, prefixed `v2:` |
| `pin_set_at` | TEXT | when the PIN was last set |

## Limits

- **The key file sits beside the database.** That stops a copy of the database alone from being
  enough to read the vault; it does not stop a copy of the whole data directory. Set `VAULT_KEY`
  in `.env` to keep the key somewhere else.
- **The lockout is per process**, not per caller, and does not survive a restart.
- **Items are not owner-scoped.** Every admin sees the same items and shares the one PIN.
- **Nothing is recoverable without the keys.** No plaintext is stored anywhere.

## See Also

- [Security model](security.md) — roles, CSRF, and why the vault is admin-only
- [Middleware](middleware.md) — `requireAdmin` and the CSRF check
- [Vault guide](../../guide/vault.md) — everyday use, in plain words
- [Commands tab](../tabs/commands.md) — the Vault dropdown that pastes into the terminal
