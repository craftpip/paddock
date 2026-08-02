const crypto = require('crypto');

const { getDb } = require('./db');

const VAULT_KEY = process.env.VAULT_KEY || '';

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

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(stored) {
  const parts = String(stored).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted value');
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
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

function create(name, description, value) {
  const db = getDb();
  if (db.prepare('SELECT id FROM vault_items WHERE name = ?').get(name)) {
    throw new Error(`Vault item '${name}' already exists`);
  }
  const enc = encrypt(value);
  const info = db.prepare('INSERT INTO vault_items (name, description, enc_value) VALUES (?, ?, ?)').run(name, description || '', enc);
  return getPublic(info.lastInsertRowid);
}

function update(id, { name, description, value } = {}) {
  const db = getDb();
  const existing = get(id);
  if (!existing) throw new Error('Vault item not found');
  const newName = name || existing.name;
  if (newName !== existing.name) {
    const clash = db.prepare('SELECT id FROM vault_items WHERE name = ? AND id != ?').get(newName, id);
    if (clash) throw new Error(`Vault item '${newName}' already exists`);
  }
  const encValue = value !== undefined && value !== '' ? encrypt(value) : existing.enc_value;
  const desc = description !== undefined ? description : existing.description;
  db.prepare('UPDATE vault_items SET name = ?, description = ?, enc_value = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(newName, desc || '', encValue, id);
  return getPublic(id);
}

function remove(id) {
  const db = getDb();
  const existing = get(id);
  if (!existing) throw new Error('Vault item not found');
  db.prepare('DELETE FROM vault_items WHERE id = ?').run(id);
  return true;
}

function getValue(id) {
  const row = get(id);
  if (!row) throw new Error('Vault item not found');
  return decrypt(row.enc_value);
}

module.exports = {
  encrypt,
  decrypt,
  list,
  getPublic,
  create,
  update,
  remove,
  getValue,
};
