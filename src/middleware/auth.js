const crypto = require('crypto');

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || '';

function setupSession(app) {
  const session = require('express-session');
  app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: 'vmf.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
    },
  }));
}

function requireAuth(req, res, next) {
  if (!AUTH_PASSWORD) return next();
  if (req.session && req.session.authenticated) return next();
  if (req.xhr || req.path.startsWith('/api/') || req.path.startsWith('/ws/')) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function checkNeedsSetup(req, res, next) {
  const publicPaths = ['/api/setup', '/api/login', '/api/session', '/setup', '/login'];
  if (publicPaths.includes(req.path)) return next();
  if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next();
  try {
    const { getDb } = require('../services/db');
    const db = getDb();
    const row = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (row.count === 0) return res.redirect('/setup');
  } catch {
    return next();
  }
  next();
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const hashBuf = Buffer.from(hash, 'hex');
  const testBuf = crypto.scryptSync(password, salt, 64);
  if (hashBuf.length !== testBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, testBuf);
}

function csrfToken(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfCheck(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.body._csrf || req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    if (req.xhr || req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'CSRF token invalid' });
    }
    return res.status(403).render('partials/error', { message: 'CSRF token invalid. Please refresh and try again.', code: 403 });
  }
  next();
}

module.exports = { setupSession, requireAuth, requireAdmin, csrfToken, csrfCheck, hashPassword, verifyPassword, checkNeedsSetup, AUTH_PASSWORD };
