const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// The vault's key handling (plan 124 #1, #3, #4 and the wrong-PIN lockout).
// Everything runs against a throwaway database and key file; the env is set
// BEFORE the modules load because both paths are computed at require time.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-test-'));
process.env.PAD_DB_PATH = path.join(DIR, 'app.db');
delete process.env.VAULT_KEY;
process.env.SESSION_SECRET = 'a-session-secret-for-this-test';

const { getDb, close } = require('../services/db');
const vault = require('../services/vault');

const LEGACY_SESSION = crypto.scryptSync(process.env.SESSION_SECRET, 'paddock-vault', 32);
const LEGACY_LITERAL = crypto.scryptSync('paddock-vault-fallback', 'paddock-vault', 32);

function seal(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}
function open(key, stored) {
  const [iv, tag, data] = stored.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
const canOpen = (key, stored) => { try { open(key, stored); return true; } catch { return false; } };
const rawItem = (name) => getDb().prepare('SELECT enc_value FROM vault_items WHERE name = ?').get(name).enc_value;
const meta = () => getDb().prepare('SELECT * FROM vault_meta WHERE id = 1').get();

beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM vault_items').run();
  db.prepare('DELETE FROM vault_meta').run();
  fs.rmSync(vault.KEY_FILE, { force: true });
  vault._reset();
  vault._setClock(null);
});

after(() => { close(); fs.rmSync(DIR, { recursive: true, force: true }); });

describe('the server key', () => {
  it('is generated into a 0600 file, and no item is readable with a key from the source code', () => {
    vault.create('token', '', 'hunter2');
    assert.ok(fs.existsSync(vault.KEY_FILE), 'a key file must exist after first use');
    assert.equal(fs.statSync(vault.KEY_FILE).mode & 0o777, 0o600);
    const stored = rawItem('token');
    assert.equal(canOpen(LEGACY_LITERAL, stored), false, 'the literal fallback must open nothing');
    assert.equal(canOpen(LEGACY_SESSION, stored), false, 'nor the session secret');
    assert.equal(vault.getValue(getDb().prepare('SELECT id FROM vault_items').get().id), 'hunter2');
  });

  it('survives a restart: the same file opens the same items', () => {
    const { id } = vault.create('token', '', 'hunter2');
    vault._reset(); // what a restart forgets
    assert.equal(vault.getValue(id), 'hunter2');
  });

  for (const [label, key] of [['the literal fallback', LEGACY_LITERAL], ['the session secret', LEGACY_SESSION]]) {
    it(`moves a store written under ${label} to the generated key on first use`, () => {
      getDb().prepare('INSERT INTO vault_items (name, enc_value) VALUES (?, ?)').run('old', seal(key, 'legacy-value'));
      const id = getDb().prepare('SELECT id FROM vault_items').get().id;
      assert.equal(vault.getValue(id), 'legacy-value');
      assert.equal(canOpen(key, rawItem('old')), false, 'the stored value must no longer open with the old key');
    });
  }

  it('changes nothing and leaves no key file when a stored item opens with no known key', () => {
    const foreign = seal(crypto.randomBytes(32), 'x');
    getDb().prepare('INSERT INTO vault_items (name, enc_value) VALUES (?, ?)').run('foreign', foreign);
    assert.throws(() => vault.create('new', '', 'v'), /could not be read with any known key/);
    assert.equal(fs.existsSync(vault.KEY_FILE), false, 'a key file here would orphan the store for good');
    assert.equal(rawItem('foreign'), foreign);
  });

  it('refuses a damaged key file instead of replacing it', () => {
    fs.writeFileSync(vault.KEY_FILE, 'not-a-key\n');
    assert.throws(() => vault.create('a', '', 'b'), /damaged/);
    assert.equal(fs.readFileSync(vault.KEY_FILE, 'utf8'), 'not-a-key\n');
  });
});

describe('the PIN', () => {
  it('does not open the master on its own: the wrap needs the server key too', () => {
    vault.create('token', '', 'hunter2');
    vault.setPin('1234');
    const m = meta();
    assert.match(m.master_wrapped, /^v2:/);
    // The attacker knows the cost parameters (they are in the source), so the
    // PIN-only key is derived exactly as the vault derives its first half.
    const pinOnly = crypto.scryptSync('1234', m.pin_salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 });
    assert.equal(canOpen(pinOnly, m.master_wrapped.slice(3)), false,
      'a copy of the database plus the right PIN must not be enough');
  });

  it('keeps existing items when it is first set', () => {
    const { id } = vault.create('token', '', 'hunter2');
    vault.setPin('1234');
    assert.equal(vault.getValue(id, '1234'), 'hunter2');
    assert.throws(() => vault.getValue(id, '9999'), /Wrong PIN/);
  });

  it('a change with the old PIN keeps every item', () => {
    vault.setPin('1234');
    const { id } = vault.create('token', '', 'hunter2', '1234');
    vault.setPin('567890', { reset: true, oldPin: '1234' });
    assert.equal(vault.getValue(id, '567890'), 'hunter2');
    assert.throws(() => vault.getValue(id, '1234'), /Wrong PIN/);
  });

  it('a change with a wrong old PIN changes nothing', () => {
    vault.setPin('1234');
    const { id } = vault.create('token', '', 'hunter2', '1234');
    assert.throws(() => vault.setPin('5678', { reset: true, oldPin: '0000' }), /Wrong PIN/);
    assert.equal(vault.getValue(id, '1234'), 'hunter2');
  });

  it('a forgotten PIN can be replaced, and that is the path that erases', () => {
    vault.setPin('1234');
    vault.create('token', '', 'hunter2', '1234');
    vault.setPin('4321', { wipe: true });
    assert.deepEqual(vault.list(), []);
    const { id } = vault.create('fresh', '', 'v', '4321');
    assert.equal(vault.getValue(id, '4321'), 'v');
  });

  it('upgrades a PIN-only wrap from an older version the first time the right PIN is used', () => {
    const master = crypto.randomBytes(32);
    const salt = 'aabbccdd';
    getDb().prepare('INSERT INTO vault_meta (id, pin_set, pin_salt, master_wrapped) VALUES (1, 1, ?, ?)')
      .run(salt, seal(crypto.scryptSync('1234', salt, 32), master.toString('hex')));
    getDb().prepare('INSERT INTO vault_items (name, enc_value) VALUES (?, ?)').run('old', seal(master, 'kept'));
    const id = getDb().prepare('SELECT id FROM vault_items').get().id;

    assert.equal(vault.getValue(id, '1234'), 'kept');
    assert.match(meta().master_wrapped, /^v2:/, 'the wrap must now need the server key');
    assert.equal(vault.getValue(id, '1234'), 'kept', 'and still open with the same PIN');
  });
});

describe('wrong-PIN lockout', () => {
  it('refuses even the right PIN after five wrong ones, then lets it through when the wait is over', () => {
    let t = 1_000_000;
    vault._setClock(() => t);
    vault.setPin('1234');
    const { id } = vault.create('token', '', 'hunter2', '1234');

    for (let i = 0; i < 4; i++) assert.throws(() => vault.getValue(id, '0000'), /Wrong PIN/);
    assert.throws(() => vault.getValue(id, '0000'), (e) => e.code === 'vault_locked_out');
    assert.throws(() => vault.getValue(id, '1234'), (e) => e.code === 'vault_locked_out' && e.retryAfterSeconds === 30,
      'the right PIN must not get through a lockout, or the lockout is only a delay for the guesser');

    t += 31_000;
    assert.equal(vault.getValue(id, '1234'), 'hunter2');
  });

  it('doubles the wait when it is hit again without a correct PIN in between', () => {
    let t = 1_000_000;
    vault._setClock(() => t);
    vault.setPin('1234');
    const { id } = vault.create('token', '', 'hunter2', '1234');
    const burn = () => { for (let i = 0; i < 5; i++) try { vault.getValue(id, '0000'); } catch { /* counted */ } };

    burn();
    t += 31_000;
    burn();
    assert.throws(() => vault.getValue(id, '1234'), (e) => e.retryAfterSeconds === 60);
  });

  it('a correct PIN clears the count', () => {
    vault.setPin('1234');
    const { id } = vault.create('token', '', 'hunter2', '1234');
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 4; i++) assert.throws(() => vault.getValue(id, '0000'), /Wrong PIN/);
      assert.equal(vault.getValue(id, '1234'), 'hunter2');
    }
  });
});
