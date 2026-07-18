const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_HITS = 30;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now - entry.start > WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return next();
  }
  entry.count++;
  if (entry.count > MAX_HITS) {
    return res.status(429).render('partials/error', { message: 'Too many requests. Please wait a moment.', code: 429 });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now - entry.start > WINDOW_MS * 2) hits.delete(ip);
  }
}, WINDOW_MS * 2);

module.exports = { rateLimit };
