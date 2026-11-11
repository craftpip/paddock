// Plan 124 #7: the yaml/toml scrub must know which SECTION a line is in. Every
// case here is a secret whose own line carries no secret-looking key.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.WORKSPACE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'redact-text-'));
const { redactConfigText, redactSecrets } = require('../services/vm-manager/config-redaction');

const scrub = (lines) => redactConfigText(lines.join('\n'));

describe('toml', () => {
  it('redacts every value in a table whose path names an env or headers map', () => {
    const out = scrub([
      '[mcp_servers.db.env]',
      'DATABASE_URL = "postgres://u:hunter2@h/db"',
      'REGION = "eu-1"',
      '[mcp_servers.gh.http_headers]',
      'Cookie = "session=abc123"',
    ]);
    for (const leak of ['hunter2', 'eu-1', 'abc123']) assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
    assert.match(out, /DATABASE_URL = \[REDACTED\]/);
    assert.match(out, /\[mcp_servers\.gh\.http_headers\]/, 'the structure stays readable');
  });

  it('stops redacting at the next ordinary table', () => {
    const out = scrub(['[server.env]', 'A = "s3cret"', '[server]', 'url = "https://example.test"', 'model = "gpt"']);
    assert.ok(!out.includes('s3cret'));
    assert.ok(out.includes('url = "https://example.test"'));
    assert.ok(out.includes('model = "gpt"'));
  });

  it('redacts a multi-line string or array under a secret key, all of it', () => {
    const out = scrub(['token = """', 'first-part', 'second-part"""', 'api_keys = [', '  "sk-one",', '  "sk-two",', ']', 'name = "visible"']);
    for (const leak of ['first-part', 'second-part', 'sk-one', 'sk-two']) assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
    assert.ok(out.includes('name = "visible"'), 'and resumes after the value closes');
  });
});

describe('yaml', () => {
  it('redacts a list under a secret key, including one written flush with its parent', () => {
    const out = scrub(['api_keys:', '  - sk-live-1', '  - sk-live-2', 'tokens:', '- tok-a', '- tok-b', 'model: gpt']);
    for (const leak of ['sk-live-1', 'sk-live-2', 'tok-a', 'tok-b']) assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
    assert.ok(out.includes('model: gpt'));
  });

  it('redacts every value under a headers or env map, at any depth', () => {
    const out = scrub(['http_headers:', '  Cookie: session=abc', '  nested:', '    deep: way-down', 'env:', '  DATABASE_URL: postgres://u:pw@h/db', 'name: shown']);
    for (const leak of ['session=abc', 'way-down', 'u:pw@h']) assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
    assert.ok(out.includes('name: shown'));
    assert.match(out, /^ {2}nested:$/m, 'a nested map key keeps its shape');
  });

  it('redacts a block scalar', () => {
    const out = scrub(['password: |', '  hunter2', '  second line', 'user: admin', 'secret: >-', '  folded', 'port: 22']);
    for (const leak of ['hunter2', 'second line', 'folded']) assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
    assert.ok(out.includes('user: admin'));
    assert.ok(out.includes('port: 22'));
  });
});

describe('what must stay readable', () => {
  it('a token COUNT is a number, not a credential', () => {
    const text = ['max_tokens: 4096', 'max_tokens = 8192', 'context_tokens: "200000"'].join('\n');
    assert.equal(redactConfigText(text), text);
    assert.deepEqual(redactSecrets({ max_tokens: 4096, tokens: ['sk-a'] }), { max_tokens: 4096, tokens: '[REDACTED]' });
  });

  it('plural credential names are credentials', () => {
    const out = scrub(['apiKeys: sk-inline', 'passwords: pw-inline', 'secrets: s-inline']);
    for (const leak of ['sk-inline', 'pw-inline', 's-inline']) assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
  });

  it('an ordinary config is returned unchanged', () => {
    const text = ['model:', '  provider: openai', '  default: gpt-5', 'servers:', '  - name: a', '    url: https://a.test', '[profile]', 'sandbox = "workspace-write"'].join('\n');
    assert.equal(redactConfigText(text), text);
  });

  it('single-line secrets still work as before', () => {
    assert.equal(redactConfigText('api_key: sk-123\nname: x'), 'api_key: [REDACTED]\nname: x');
    assert.equal(redactConfigText('token = "abc"'), 'token = [REDACTED]');
  });
});
