const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

describe('Agent Registry - VM Name Validation', () => {
  const registry = require('../services/agent-registry');
  const P = process.env.CONTAINER_PREFIX || 'vm';

  it('accepts valid VM names', () => {
    assert.ok(registry.VM_NAME_RE.test(`${P}-test`));
    assert.ok(registry.VM_NAME_RE.test(`${P}-jake`));
    assert.ok(registry.VM_NAME_RE.test(`${P}-ozden2`));
    assert.ok(registry.VM_NAME_RE.test(`${P}-a`));
  });

  it('rejects invalid VM names', () => {
    assert.ok(!registry.VM_NAME_RE.test('test'));
    assert.ok(!registry.VM_NAME_RE.test(`${P}-`));
    assert.ok(!registry.VM_NAME_RE.test(`${P}- `));
    assert.ok(!registry.VM_NAME_RE.test(''));
    assert.ok(!registry.VM_NAME_RE.test(`${P.toUpperCase()}-test`));
  });
});

describe('Agent Registry - Meta Reading', () => {
  const registry = require('../services/agent-registry');

  it('reads meta.env from existing instance', () => {
    const metaPath = path.join(__dirname, '..', '..', 'instances');
    if (fs.existsSync(path.join(metaPath, 'vm-jake', 'meta.env'))) {
      const meta = registry.readMeta(path.join(metaPath, 'vm-jake'));
      assert.ok(meta.ROOT_PASSWORD);
    }
  });

  it('returns empty object for missing meta.env', () => {
    const meta = registry.readMeta('/nonexistent/path');
    assert.deepStrictEqual(meta, {});
  });
});
