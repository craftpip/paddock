/**
 * The secrets vault.
 */
const vault = require('../services/vault');
const { getDb } = require('../services/db');
const { requireAdmin, csrfCheck, verifyPassword } = require('../middleware/auth');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {

  // ─── API: Vault (encrypted key-value store) ────────────────
  // The vault is one shared store with one PIN, so it belongs to the admin:
  // a regular user could otherwise set the PIN first and lock the admin out,
  // or overwrite and delete items they cannot read.
  app.use('/api/vault', requireAdmin);

  app.get('/api/vault', (req, res) => {
    try {
      res.json({ items: vault.list(), meta: vault.status() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** A vault refusal, with the lockout told apart so the page can say how long. */
  function refuse(res, e) {
    if (e.code === 'vault_locked_out') {
      res.set('Retry-After', String(e.retryAfterSeconds));
      return res.status(429).json({ error: e.message, code: e.code, retryAfterSeconds: e.retryAfterSeconds });
    }
    return res.status(400).json({ error: e.message });
  }

  // Three shapes: a first set { pin }; a change { pin, reset, oldPin, password },
  // which keeps every item; and a forgotten PIN { pin, wipe, password }, which
  // erases them. Both of the last two need the account password.
  app.post('/api/vault/pin', csrfCheck, (req, res) => {
    const { pin, reset, wipe, oldPin, password } = req.body;
    try {
      if (reset || wipe) {
        if (!password) return res.status(400).json({ error: 'Your password is required to change or erase the PIN' });
        const user = req.session.userId
          ? getDb().prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
          : null;
        if (!user || !verifyPassword(password, user.password_hash)) {
          return res.status(401).json({ error: 'Password is incorrect' });
        }
      }
      res.json({ ok: true, meta: vault.setPin(pin, { reset: !!reset, wipe: !!wipe, oldPin }), erased: !!wipe });
    } catch (e) {
      refuse(res, e);
    }
  });

  app.post('/api/vault', csrfCheck, (req, res) => {
    const { name, description, value, pin } = req.body;
    if (!name || !value) return res.status(400).json({ error: 'Name and value are required' });
    try {
      const item = vault.create(name.trim(), description, value, pin);
      res.json({ ok: true, item });
    } catch (e) {
      refuse(res, e);
    }
  });

  app.put('/api/vault/:id', csrfCheck, (req, res) => {
    const { name, description, value, pin } = req.body;
    try {
      const item = vault.update(Number(req.params.id), { name, description, value }, pin);
      res.json({ ok: true, item });
    } catch (e) {
      refuse(res, e);
    }
  });

  app.delete('/api/vault/:id', csrfCheck, (req, res) => {
    const { pin } = req.body;
    try {
      vault.remove(Number(req.params.id), pin);
      res.json({ ok: true });
    } catch (e) {
      refuse(res, e);
    }
  });

  app.get('/api/vault/:id/decrypt', requireAdmin, (req, res) => {
    try {
      res.json({ value: vault.getValue(Number(req.params.id), req.get('x-vault-pin') || '') });
    } catch (e) {
      refuse(res, e);
    }
  });
};
