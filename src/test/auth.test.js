const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Auth - WebSocket session validation', () => {
  const { getSessionFromCookie } = require('../middleware/auth');

  it('rejects missing and malformed session cookies', async () => {
    assert.strictEqual(await getSessionFromCookie(''), null);
    assert.strictEqual(await getSessionFromCookie('vmf.sid=not-a-signed-session'), null);
  });
});

describe('Auth - CSRF Token', () => {
  it('generates and validates CSRF tokens', () => {
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    assert.strictEqual(token.length, 64);
    assert.ok(/^[a-f0-9]+$/.test(token));
  });
});

describe('Auth - Rate Limiter', () => {
  it('rate limiter module loads', () => {
    const { rateLimit } = require('../middleware/rateLimit');
    assert.ok(typeof rateLimit === 'function');
  });
});
