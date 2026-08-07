# Vault PIN (plan 19 — 2026-08-07, revised: always-locked)

## Goal

Add a 4 or 6 digit PIN to the Vault page. **The vault is always locked** — no
global unlock/lock state, no auto-lock. The PIN is entered at the moment of
each action (add / edit / delete / paste), every single time.

User clarified twice: no auto-lock, no auto-unlock. PIN on every action, even
for a single edit. Backend is stateless.

## Envelope encryption (unchanged)

```
scrypt(pin, salt) ──► pinKey ──► AES-GCM ──► masterWrapped  (vault_meta)
masterKey (random 32B) ──► AES-GCM ──► enc_value (per item)
```

- No PIN set → master key from `VAULT_KEY` / `SESSION_SECRET` fallback.
- Wrong PIN → GCM tag mismatch on `masterWrapped` → `Wrong PIN`.

## Backend — stateless per-op PIN

`src/services/vault.js` has **no module state**: no `_master`, no timer, no
`unlock()`/`lock()`/`isLocked()`. Each op unwraps the master key once, then
discards it.

- `resolveMaster(pin)` — derive pin key, unwrap `master_wrapped`, verify via
  GCM tag. Wrong pin → throw `Wrong PIN`.
- `create(name, desc, value, pin)`, `update(id, {...}, pin)` (description
  preserved when omitted; value only re-encrypted when non-empty),
  `remove(id, pin)`, `getValue(id, pin)`, `verifyPin(pin)`,
  `setPin(pin, {reset, oldPin})`, `status()` → `{ pinSet, locked }` where
  `locked = !!pinSet` (a constant, not a state), `list()`.
- `setPin` reset: verifies `oldPin` (`Wrong PIN`) **before** wiping items.
  Wipe only happens on a fully-valid reset.
- `list()` serves items even while locked — the item list is public, only
  values are protected.

## Backend routes (`src/app.js`)

- Removed `POST /api/vault/unlock` and `/api/vault/lock`.
- `POST /api/vault` and `PUT /api/vault/:id` take `pin` in body.
- `DELETE /api/vault/:id` takes `pin` in body.
- `GET /api/vault/:id/decrypt?pin=...` takes pin as query param.
- `POST /api/vault/pin { pin, reset, oldPin, password }` — reset verifies
  `password` against the logged-in user's `users.password_hash` (401
  `Password is incorrect`), then `oldPin` (400 `Wrong PIN`), then wipes items
  and generates a fresh salt + master key. Any failure → nothing changes.
- All wrong-PIN paths return 400 `Wrong PIN`.

## Frontend

- `src/client/src/pages/Vault.jsx` (rewritten):
  - No global unlock banner / Lock button. Whenever `meta.pinSet`, show the
    locked badge + "Vault is locked" banner.
  - Values always masked (`••••••••••`) with a small lock icon inline.
  - Add: `startAdd()` opens a `set` PIN modal only when no PIN + zero items;
    otherwise the add row opens directly and `handleSave()` asks for the PIN
    when locked.
  - Edit: opens the edit row immediately; `handleSave()` requires PIN via
    `requireUnlock('save')`.
  - Delete: `handleDelete(item)` confirms (custom modal), then requires PIN.
  - `submitPinPrompt()` keeps the modal open until the op succeeds so "Wrong
    PIN" shows in place (fixed: dialog previously closed before the error).
- `src/client/src/pages/agent/CommandsPane.jsx`:
  - Vault dropdown shows a lock banner while locked, inline PIN form for paste
    (`Unlock & paste`) and add (`Unlock & add`), add form always rendered.
  - `pinMode` (`{type:'paste',item}` | `{type:'add'}`), `submitPin()` runs the
    op, clears `pinMode` only on success, shows inline error otherwise.

## Files touched

- `src/services/vault.js` — stateless per-op PIN rework.
- `src/app.js` — removed unlock/lock routes, pin passthrough.
- `src/client/src/pages/Vault.jsx` — always-locked UI, per-action PIN modal.
- `src/client/src/pages/agent/CommandsPane.jsx` — dropdown inline PIN.
- `src/services/db.js` — `vault_meta` table (from the earlier design; still used).

## Testing

1. Restart webui + rebuild SPA:
   `docker compose up -d --no-deps --force-recreate webui` then
   `docker exec paddock sh -c 'cd /app/client && npm run build'`.
2. Browser-test at `http://10.69.1.164:6789/vault` and per-agent Commands tab
   (`http://10.69.1.164:6789/agents/<pad>`), target `vpin`.

## Verified live (2026-08-07, PIN 1234)

- Edit-save while locked: wrong PIN → inline `Wrong PIN`, modal stays open;
  correct PIN → saved, dialog closes, vault still locked, lock icon + masked
  value in the row.
- Add while locked (Vault page): form → Add → PIN modal → wrong/right PIN →
  item created, masked.
- Delete while locked: custom confirm → PIN modal → wrong PIN error → right PIN
  → item removed, still locked.
- CommandsPane dropdown: lock banner + item list visible; paste → inline
  `Unlock & paste` → wrong PIN inline error → correct PIN → decrypt 200, value
  written to terminal, pin form closes. Add → `Unlock & add` → creates item.
- `GET /api/vault` still reports `{ pinSet: true, locked: true }` after every
  op. Reset with wrong password / wrong oldPin → error, items intact (success
  path wipes items by design — not tested live, no DB backup to restore).
- demerzel's value was accidentally overwritten during an edit test, then
  restored from the agent config (`instances/pad-openclaw-work-pls/.../openclaw.json`
  holds the telegram bot token for `demerzel9_bot`).

## Known limitations

- A 4–6 digit PIN is brute-forceable offline if someone steals the DB — the
  webui is a local tool, so this matches the threat model.
- Resetting the PIN erases every item (old master key unrecoverable) — the UI
  warns loudly and requires password + old PIN.

## UI refinement (2026-08-07, post-verify)

- Removed the persistent "Vault is locked / Values are encrypted at rest…"
  banner from the Vault page. The explanation now lives in the first-time
  "Set PIN" modal only; the small `locked` pill in the header + per-row mask
  icons remain as status indicators. PIN is still asked per action.
