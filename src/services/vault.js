const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { getDb } = require('./db');

/**
 * The secrets vault: how the keys are held.
 *
 * SERVER KEY. `VAULT_KEY` from the environment when it is set. Otherwise a
 * random 32-byte key generated on first use and kept in `vault.key` beside the
 * database (mode 0600). There is no built-in fallback value: an earlier version
 * fell back to a string that is in this repository, so a default install
 * encrypted every item under a key anyone could derive. Stores written that way
 * are re-encrypted under the real key the first time the vault is used.
 *
 * WITHOUT A PIN the server key encrypts the items directly.
 *
 * WITH A PIN a random master key encrypts the items, and the master is wrapped
 * under a key derived from the PIN **and** the server key. A PIN is 4 or 6
 * digits, so on its own it is no protection against someone holding a copy of
 * the database: every PIN can be tried in minutes. Mixing in the server key
 * means the database alone is not enough. The cost of that is real: lose the
 * server key (the env value or the key file) and the vault cannot be opened.
 *
 * The vault is ALWAYS locked. Every value operation supplies the PIN, which
 * unwraps the master for that one operation and is then discarded.
 */
const PIN_RE = /^\d{4}$|^\d{6}$/;
const KEY_FILE = path.join(
  path.dirname(process.env.PAD_DB_PATH || path.join(__dirname, '..', 'data', 'app.db')),
  'vault.key'
);
// scrypt cost for the PIN wrap: about 100 ms per try on this class of host.
const PIN_SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
const WRAP_V2 = 'v2:';

function envKey() {
  const raw = process.env.VAULT_KEY || '';
  if (!raw) return null;
  const buf = Buffer.from(raw, 'hex');
  if (buf.length >= 32) return buf.subarray(0, 32);
  return crypto.scryptSync(raw, 'vault', 32);
}

/** The keys an older version could have encrypted a PIN-less store under when
 *  `VAULT_KEY` was unset. Used only to MIGRATE such a store, never to write. */
function legacyKeys() {
  const keys = [];
  if (process.env.SESSION_SECRET) keys.push(crypto.scryptSync(process.env.SESSION_SECRET, 'paddock-vault', 32));
  keys.push(crypto.scryptSync('paddock-vault-fallback', 'paddock-vault', 32));
  return keys;
}

function readKeyFile() {
  let hex;
  try { hex = fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch (e) {
    if (e.code === 'ENOENT') return null;
    // Unreadable is not absent: generating a new key here would orphan every
    // item encrypted under the one we could not read.
    throw new Error(`The vault key file could not be read (${e.code || e.message})`);
  }
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== 32) throw new Error('The vault key file is damaged (not a 32-byte key)');
  return buf;
}

let cachedServerKey = null;

/** The server key, creating the key file (and migrating a legacy store) on
 *  first use. */
function serverKey() {
  const fromEnv = envKey();
  if (fromEnv) return fromEnv;
  if (cachedServerKey) return cachedServerKey;
  let key = readKeyFile();
  if (!key) {
    key = crypto.randomBytes(32);
    const db = getDb();
    const meta = getMeta();
    const rows = meta.pin_set ? [] : db.prepare('SELECT id, enc_value FROM vault_items').all();
    // Work out the new ciphertexts BEFORE anything is written, so a store we
    // cannot read stops here with nothing changed.
    const moved = rows.map((r) => {
      for (const old of legacyKeys()) {
        try { return { id: r.id, enc: encryptWith(key, decryptWith(old, r.enc_value)) }; } catch (e) { /* try the next */ }
      }
      throw new Error(`Vault item #${r.id} could not be read with any known key. Set VAULT_KEY to the value it was stored under.`);
    });
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    // 'wx': never overwrite a key that appeared in the meantime.
    fs.writeFileSync(KEY_FILE, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    try {
      const upd = db.prepare('UPDATE vault_items SET enc_value = ? WHERE id = ?');
      db.transaction((list) => { for (const m of list) upd.run(m.enc, m.id); })(moved);
    } catch (e) {
      // The items are still under the old key: a key file left behind would
      // make them unreadable on the next start.
      try { fs.unlinkSync(KEY_FILE); } catch (e2) { /* nothing to undo */ }
      throw e;
    }
    if (moved.length) console.warn(`[vault] re-encrypted ${moved.length} item(s) under a generated key (${KEY_FILE})`);
  }
  cachedServerKey = key;
  return key;
}

function pinKeyV1(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 32);
}

/** PIN and server key together: scrypt over the PIN, then keyed with the
 *  server key, so neither alone yields the wrapping key. */
function pinKeyV2(pin, salt) {
  const stretched = crypto.scryptSync(String(pin), String(salt), 32, PIN_SCRYPT);
  return crypto.createHmac('sha256', serverKey()).update(stretched).digest();
}

function encryptWith(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptWith(key, stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted value');
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function getMeta() {
  const db = getDb();
  let row = db.prepare('SELECT * FROM vault_meta WHERE id = 1').get();
  if (!row) {
    db.prepare('INSERT INTO vault_meta (id, pin_set) VALUES (1, 0)').run();
    row = db.prepare('SELECT * FROM vault_meta WHERE id = 1').get();
  }
  return row;
}

function isPinSet() {
  return !!getMeta().pin_set;
}

function wrapMaster(master, pin, salt) {
  return WRAP_V2 + encryptWith(pinKeyV2(pin, salt), master.toString('hex'));
}

/** The master key for this PIN, or null when the PIN does not open it. */
function unwrapMaster(meta, pin) {
  const stored = String(meta.master_wrapped || '');
  const v2 = stored.startsWith(WRAP_V2);
  try {
    const master = Buffer.from(
      v2 ? decryptWith(pinKeyV2(pin, meta.pin_salt), stored.slice(WRAP_V2.length))
        : decryptWith(pinKeyV1(pin, meta.pin_salt), stored),
      'hex'
    );
    if (master.length !== 32) return null;
    if (!v2) {
      // A wrap written before the server key was mixed in: upgrade it now that
      // the right PIN is in hand. Same master, so no item changes.
      const salt = crypto.randomBytes(16).toString('hex');
      getDb().prepare('UPDATE vault_meta SET pin_salt = ?, master_wrapped = ? WHERE id = 1').run(salt, wrapMaster(master, pin, salt));
    }
    return master;
  } catch (e) {
    return null;
  }
}

// ─── Wrong-PIN lockout ──────────────────────────────────────
// Ten thousand PINs is a short loop for anything that can call the API. After
// MAX_TRIES wrong PINs in a row the vault refuses every PIN, right or wrong,
// for a while, and the wait doubles each time it is hit again. Held in memory:
// a restart clears it, and a restart is not something a guesser gets for free.
const MAX_TRIES = 5;
const LOCK_BASE_MS = 30 * 1000;
const LOCK_MAX_MS = 15 * 60 * 1000;
const guard = { failures: 0, lockedUntil: 0, strikes: 0 };
let now = () => Date.now();

function assertNotLockedOut() {
  const left = guard.lockedUntil - now();
  if (left > 0) {
    const err = new Error(`Too many wrong PINs. Try again in ${Math.ceil(left / 1000)} seconds.`);
    err.code = 'vault_locked_out';
    err.retryAfterSeconds = Math.ceil(left / 1000);
    throw err;
  }
}

function recordPinResult(ok) {
  if (ok) { guard.failures = 0; guard.strikes = 0; return; }
  guard.failures += 1;
  if (guard.failures >= MAX_TRIES) {
    guard.lockedUntil = now() + Math.min(LOCK_BASE_MS * 2 ** guard.strikes, LOCK_MAX_MS);
    guard.strikes += 1;
    guard.failures = 0;
  }
}

/** The one place a PIN is tried. Throws 'Wrong PIN' (or the lockout). */
function openWithPin(pin) {
  if (!PIN_RE.test(String(pin))) throw new Error('PIN must be 4 or 6 digits');
  assertNotLockedOut();
  const master = unwrapMaster(getMeta(), pin);
  recordPinResult(!!master);
  if (!master) {
    assertNotLockedOut(); // the try that trips the lock says so, not just "wrong"
    throw new Error('Wrong PIN');
  }
  return master;
}

function resolveMaster(pin) {
  if (!getMeta().pin_set) return serverKey();
  return openWithPin(pin);
}

function status() {
  const meta = getMeta();
  return { pinSet: !!meta.pin_set, locked: !!meta.pin_set };
}

function verifyPin(pin) {
  if (!getMeta().pin_set) return false;
  try { openWithPin(pin); return true; } catch (e) {
    if (e.code === 'vault_locked_out') throw e;
    return false;
  }
}

/**
 * Set, change or forget the PIN.
 *
 *   first set          `setPin(pin)`                    items re-encrypted under a new master
 *   change             `setPin(pin, { reset, oldPin })`  same master, re-wrapped: NOTHING is lost
 *   forgot the PIN     `setPin(pin, { wipe: true })`     every item erased, said so by the caller
 *
 * A change used to erase every item even though the old PIN had just proved
 * the old master was readable, and a forgotten PIN could not be reset at all
 * because the old PIN was mandatory.
 */
function setPin(pin, { reset = false, oldPin, wipe = false } = {}) {
  if (!PIN_RE.test(String(pin))) throw new Error('PIN must be 4 or 6 digits');
  const db = getDb();
  const meta = getMeta();
  if (meta.pin_set && !reset && !wipe) throw new Error('A PIN is already set. Change it, or erase the vault if it is forgotten.');
  if (!meta.pin_set && (reset || wipe)) { reset = false; wipe = false; } // nothing to change yet: a first set

  const salt = crypto.randomBytes(16).toString('hex');
  let master;
  let erase = false;
  let reencryptFrom = null;
  if (wipe) {
    master = crypto.randomBytes(32);
    erase = true;
  } else if (reset) {
    if (!oldPin) throw new Error('Your current PIN is required to change it');
    master = openWithPin(oldPin);
  } else {
    master = crypto.randomBytes(32);
    reencryptFrom = serverKey();
  }
  const wrapped = wrapMaster(master, pin, salt);

  // One transaction: a crash between "items re-encrypted" and "PIN recorded"
  // would leave the items under a master nobody holds.
  db.transaction(() => {
    if (erase) db.prepare('DELETE FROM vault_items').run();
    if (reencryptFrom) {
      const upd = db.prepare('UPDATE vault_items SET enc_value = ? WHERE id = ?');
      for (const r of db.prepare('SELECT id, enc_value FROM vault_items').all()) {
        let plain;
        try { plain = decryptWith(reencryptFrom, r.enc_value); } catch (e) {
          throw new Error(`Failed to re-encrypt vault item #${r.id}: ${e.message}`);
        }
        upd.run(encryptWith(master, plain), r.id);
      }
    }
    db.prepare(`UPDATE vault_meta SET pin_set = 1, pin_salt = ?, master_wrapped = ?, pin_set_at = datetime('now') WHERE id = 1`).run(salt, wrapped);
  })();
  if (erase) { guard.failures = 0; guard.lockedUntil = 0; guard.strikes = 0; }

  return status();
}

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function list() {
  const rows = getDb().prepare('SELECT id, name, description, created_at, updated_at FROM vault_items ORDER BY name COLLATE NOCASE').all();
  return rows.map(toPublic);
}

function get(id) {
  return getDb().prepare('SELECT * FROM vault_items WHERE id = ?').get(id) || null;
}

function getPublic(id) {
  const row = get(id);
  return row ? toPublic(row) : null;
}

function create(name, description, value, pin) {
  const db = getDb();
  if (db.prepare('SELECT id FROM vault_items WHERE name = ?').get(name)) {
    throw new Error(`Vault item '${name}' already exists`);
  }
  const master = resolveMaster(pin);
  const enc = encryptWith(master, value);
  const info = db.prepare('INSERT INTO vault_items (name, description, enc_value) VALUES (?, ?, ?)').run(name, description || '', enc);
  return getPublic(info.lastInsertRowid);
}

function update(id, { name, description, value } = {}, pin) {
  const db = getDb();
  // The key comes FIRST: the first use of the vault may re-encrypt a legacy
  // store, and a row read before that would carry the old ciphertext.
  const master = get(id) ? resolveMaster(pin) : null;
  const existing = get(id);
  if (!existing) throw new Error('Vault item not found');
  const newName = name || existing.name;
  if (newName !== existing.name) {
    const clash = db.prepare('SELECT id FROM vault_items WHERE name = ? AND id != ?').get(newName, id);
    if (clash) throw new Error(`Vault item '${newName}' already exists`);
  }
  const encValue = value !== undefined && value !== '' ? encryptWith(master, value) : existing.enc_value;
  const desc = description !== undefined ? description : existing.description;
  db.prepare('UPDATE vault_items SET name = ?, description = ?, enc_value = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(newName, desc || '', encValue, id);
  return getPublic(id);
}

function remove(id, pin) {
  const db = getDb();
  const existing = get(id);
  if (!existing) throw new Error('Vault item not found');
  resolveMaster(pin);
  db.prepare('DELETE FROM vault_items WHERE id = ?').run(id);
  return true;
}

function getValue(id, pin) {
  if (!get(id)) throw new Error('Vault item not found');
  const master = resolveMaster(pin); // before the read below, for the same reason as update()
  const row = get(id);
  return decryptWith(master, row.enc_value);
}

module.exports = {
  KEY_FILE,
  // test seams: the clock the lockout reads, and a way to drop cached state
  _setClock: (fn) => { now = fn || (() => Date.now()); },
  _reset: () => { cachedServerKey = null; guard.failures = 0; guard.lockedUntil = 0; guard.strikes = 0; },
  status,
  isPinSet,
  setPin,
  verifyPin,
  list,
  getPublic,
  create,
  update,
  remove,
  getValue,
};
