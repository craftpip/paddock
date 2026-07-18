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

function handleLogin(req, res) {
  const { password } = req.body;
  if (!password || password !== AUTH_PASSWORD) {
    return res.status(401).render('login', { error: 'Invalid password' });
  }
  req.session.authenticated = true;
  req.session.loginTime = Date.now();
  const returnTo = req.session.returnTo || '/';
  delete req.session.returnTo;
  res.redirect(returnTo);
}

function handleLogout(req, res) {
  req.session.destroy(() => {
    res.redirect('/login');
  });
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

module.exports = { setupSession, requireAuth, handleLogin, handleLogout, csrfToken, csrfCheck, AUTH_PASSWORD };
