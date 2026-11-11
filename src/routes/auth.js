/**
 * Sign-in, first-run setup, users and the signed-in user's profile and API keys.
 */
const crypto = require('crypto');
const apiKeys = require('../services/api-keys');
const { getDb } = require('../services/db');
const { requireAdmin, csrfCheck, hashPassword, verifyPassword } = require('../middleware/auth');

/** Register this area's routes on the app. `ctx` carries the helpers app.js owns. */
module.exports = function register(app, ctx) {
  const {
    ensureAutoLogin,
  } = ctx;

  // ─── Routes: Auth API ───────────────────────────────────────

  app.get('/api/session', (req, res) => {
    ensureAutoLogin(req);
    res.json({
      authenticated: !!req.session?.userId,
      userId: req.session?.userId || null,
      username: req.session?.username || null,
      role: req.session?.role || null,
      csrfToken: req.session?.csrfToken || '',
    });
  });

  app.get('/api/setup', (req, res) => {
    try {
      const db = getDb();
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      res.json({ needsSetup: count === 0 });
    } catch {
      res.json({ needsSetup: true });
    }
  });

  app.post('/api/setup', (req, res) => {
    try {
      const db = getDb();
      const count = db.prepare('SELECT COUNT(*) as count FROM users').get().count;
      if (count > 0) return res.status(400).json({ error: 'Admin already exists' });
    } catch { return res.status(500).json({ error: 'DB error' }); }

    const { username, password } = req.body;
    const uname = String(username || '').trim();
    if (!uname || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!/^[A-Za-z0-9]{3,32}$/.test(uname)) return res.status(400).json({ error: 'Username must be 3-32 letters or numbers' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    try {
      const db = getDb();
      const id = 'admin_' + Date.now();
      const passwordHash = hashPassword(password);
      db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)').run(id, uname, 'Admin', 'admin', passwordHash);
      res.json({ ok: true });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    try {
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
      if (!user) return res.status(401).json({ error: 'Invalid username or password' });
      if (!verifyPassword(password, user.password_hash)) return res.status(401).json({ error: 'Invalid username or password' });

      req.session.authenticated = true;
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      req.session.loginTime = Date.now();
      res.json({ ok: true, username: user.username, role: user.role });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  // ─── Routes: User Management (admin only) ───────────────────

  app.get('/api/users', requireAdmin, (req, res) => {
    try {
      const db = getDb();
      const users = db.prepare(`
      SELECT u.id, u.username, u.display_name, u.email, u.role, u.created_at,
        (SELECT COUNT(*) FROM agents a WHERE a.owner_id = u.id) as agent_count
      FROM users u ORDER BY u.created_at ASC
    `).all();
      res.json({ users });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/users', requireAdmin, (req, res) => {
    const { password, role } = req.body;
    const username = String(req.body.username || '').trim();
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!/^[A-Za-z0-9]{3,32}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-32 letters or numbers' });
    if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    try {
      const db = getDb();
      const id = 'user_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
      const passwordHash = hashPassword(password);
      db.prepare('INSERT INTO users (id, username, display_name, role, password_hash) VALUES (?, ?, ?, ?, ?)')
        .run(id, username, username, role === 'admin' ? 'admin' : 'user', passwordHash);
      res.json({ ok: true, id });
    } catch (e) {
      if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username already taken' });
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/users/:id/reset-password', requireAdmin, (req, res) => {
    const { password, current_password } = req.body;
    if (!password || password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    try {
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });

      // Resetting your own password requires the current password, like the
      // profile change-password flow. Admins resetting another user's password
      // do not need it.
      if (user.id === req.session.userId) {
        if (!current_password) return res.status(400).json({ error: 'Current password required' });
        if (!verifyPassword(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });
      }

      const passwordHash = hashPassword(password);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(passwordHash, req.params.id);
      db.prepare('DELETE FROM user_sessions WHERE sid IN (SELECT sid FROM user_sessions WHERE json_extract(data, \'$.userId\') = ?)').run(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete('/api/users/:id', requireAdmin, (req, res) => {
    try {
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (user.role === 'admin') {
        const adminCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'admin'").get().count;
        if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the only admin' });
      }
      db.prepare("UPDATE agents SET owner_id = NULL WHERE owner_id = ?").run(req.params.id);
      db.prepare('DELETE FROM user_sessions WHERE sid IN (SELECT sid FROM user_sessions WHERE json_extract(data, \'$.userId\') = ?)').run(req.params.id);
      db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Routes: Profile ────────────────────────────────────────

  app.get('/api/profile', (req, res) => {
    try {
      const db = getDb();
      const user = db.prepare('SELECT id, username, display_name, email, role, created_at FROM users WHERE id = ?').get(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.json({ user });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.patch('/api/profile', (req, res) => {
    const email = String(req.body.email || '').trim();
    if (!email) return res.status(400).json({ error: 'Email is required' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    try {
      const db = getDb();
      db.prepare('UPDATE users SET email = ?, updated_at = datetime(\'now\') WHERE id = ?').run(email, req.session.userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/profile/change-password', (req, res) => {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password required' });
    if (new_password.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });

    try {
      const db = getDb();
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
      if (!user) return res.status(404).json({ error: 'User not found' });
      if (!verifyPassword(current_password, user.password_hash)) return res.status(401).json({ error: 'Current password is incorrect' });

      const passwordHash = hashPassword(new_password);
      db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?').run(passwordHash, req.session.userId);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Routes: Profile API Keys (MCP bearer tokens) ───────────

  app.get('/api/profile/keys', (req, res) => {
    try {
      res.json({ keys: apiKeys.listForUser(req.session.userId) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/profile/keys', csrfCheck, (req, res) => {
    const { name, scopes } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
    const trimmedName = String(name).trim().slice(0, 64);
    if (!/^[A-Za-z0-9]{3,64}$/.test(trimmedName)) return res.status(400).json({ error: 'Key name must be 3-64 letters or numbers' });

    try {
      const scopesStr = apiKeys.validateScopes(scopes === undefined ? 'default' : scopes);
      const { key, row } = apiKeys.create(req.session.userId, trimmedName, scopesStr);
      res.json({ key, ...row });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/profile/keys/:id', csrfCheck, (req, res) => {
    try {
      if (!apiKeys.remove(req.params.id, req.session.userId)) {
        return res.status(404).json({ error: 'Key not found' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
