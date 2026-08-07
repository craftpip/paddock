const crypto = require('crypto');

const { getDb } = require('./db');

const VAULT_KEY = process.env.VAULT_KEY || '';
const PIN_RE = /^\d{4}$|^\d{6}$/;

function deriveKey() {
  if (VAULT_KEY) {
    const buf = Buffer.from(VAULT_KEY, 'hex');
    if (buf.length >= 32) return buf.subarray(0, 32);
    return crypto.scryptSync(VAULT_KEY, 'vault', 32);
  }
  const secret = process.env.SESSION_SECRET || 'paddock-vault-fallback';
  console.warn('[vault] VAULT_KEY not set — deriving key from SESSION_SECRET');
  return crypto.scryptSync(secret, 'paddock-vault', 32);
}

function derivePinKey(pin, salt) {
  return crypto.scryptSync(String(pin), String(salt), 32);
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

/** The vault is ALWAYS locked. There is no unlocked state — every value
 *  operation must supply the PIN, which is used to unwrap the master key for
 *  that single operation and then discarded. No PIN set → VAULT_KEY fallback. */
function resolveMaster(pin) {
  const meta = getMeta();
  if (!meta.pin_set) return deriveKey();
  if (!PIN_RE.test(String(pin))) throw new Error('PIN must be 4 or 6 digits');
  const pinKey = derivePinKey(pin, meta.pin_salt);
  let master;
  try {
    master = Buffer.from(decryptWith(pinKey, meta.master_wrapped), 'hex');
  } catch (e) {
    throw new Error('Wrong PIN');
  }
  if (master.length !== 32) throw new Error('Wrong PIN');
  return master;
}

function status() {
  const meta = getMeta();
  return { pinSet: !!meta.pin_set, locked: !!meta.pin_set };
}

function verifyPin(pin) {
  const meta = getMeta();
  if (!meta.pin_set) return false;
  try {
    const pinKey = derivePinKey(pin, meta.pin_salt);
    const master = Buffer.from(decryptWith(pinKey, meta.master_wrapped), 'hex');
    return master.length === 32;
  } catch (e) {
    return false;
  }
}

function setPin(pin, { reset = false, oldPin } = {}) {
  if (!PIN_RE.test(String(pin))) throw new Error('PIN must be 4 or 6 digits');
  const db = getDb();
  const meta = getMeta();
  if (meta.pin_set && !reset) throw new Error('A PIN is already set — use reset to change it');
  if (reset) {
    if (!oldPin) throw new Error('Your previous PIN is required to reset');
    if (!verifyPin(oldPin)) throw new Error('Wrong PIN');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const master = crypto.randomBytes(32);
  const pinKey = derivePinKey(pin, salt);
  const wrapped = encryptWith(pinKey, master.toString('hex'));

  if (meta.pin_set) {
    // Reset — the old master key is unrecoverable, so every item is lost.
    db.prepare('DELETE FROM vault_items').run();
  } else if (db.prepare('SELECT COUNT(*) AS c FROM vault_items').get().c > 0) {
    // First set — re-encrypt existing items from the VAULT_KEY-derived key
    // into the new random master key.
    const rows = db.prepare('SELECT id, enc_value FROM vault_items').all();
    const upd = db.prepare('UPDATE vault_items SET enc_value = ? WHERE id = ?');
    const tx = db.transaction((list) => {
      for (const r of list) {
        try {
          upd.run(encryptWith(master, decryptWith(deriveKey(), r.enc_value)), r.id);
        } catch (e) {
          throw new Error(`Failed to re-encrypt vault item #${r.id}: ${e.message}`);
        }
      }
    });
    tx(rows);
  }

  db.prepare(`UPDATE vault_meta SET pin_set = 1, pin_salt = ?, master_wrapped = ?, pin_set_at = datetime('now') WHERE id = 1`).run(salt, wrapped);

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
  const existing = get(id);
  if (!existing) throw new Error('Vault item not found');
  const newName = name || existing.name;
  if (newName !== existing.name) {
    const clash = db.prepare('SELECT id FROM vault_items WHERE name = ? AND id != ?').get(newName, id);
    if (clash) throw new Error(`Vault item '${newName}' already exists`);
  }
  const master = resolveMaster(pin);
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
  const row = get(id);
  if (!row) throw new Error('Vault item not found');
  const master = resolveMaster(pin);
  return decryptWith(master, row.enc_value);
}

module.exports = {
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
