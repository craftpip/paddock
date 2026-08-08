const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');

describe('Workspace Service - Path Safety', () => {
  const ws = require('../services/workspace');

  it('resolves safe paths correctly', () => {
    const root = '/workspace/instances/vm-test/openclaw/workspace';
    const result = ws.resolveSafePath(root, 'src/index.js');
    assert.strictEqual(result, path.join(root, 'src/index.js'));
  });

  it('resolves root path', () => {
    const root = '/workspace/instances/vm-test/openclaw/workspace';
    const result = ws.resolveSafePath(root, '/');
    assert.strictEqual(result, root);
  });

  it('resolves empty path to root', () => {
    const root = '/workspace/instances/vm-test/openclaw/workspace';
    const result = ws.resolveSafePath(root, '');
    assert.strictEqual(result, root);
  });

  it('blocks path traversal with ..', () => {
    const root = '/workspace/instances/vm-test/openclaw/workspace';
    assert.throws(() => {
      ws.resolveSafePath(root, '../../etc/passwd');
    }, /Path traversal/);
  });

  it('blocks absolute path injection', () => {
    const root = '/workspace/instances/vm-test/openclaw/workspace';
    assert.throws(() => {
      ws.resolveSafePath(root, '/etc/passwd');
    }, /Path traversal/);
  });

  it('blocks nested traversal', () => {
    const root = '/workspace/instances/vm-test/openclaw/workspace';
    assert.throws(() => {
      ws.resolveSafePath(root, 'foo/../../etc/passwd');
    }, /Path traversal/);
  });

  it('blocks encoded traversal', () => {
    const root = '/workspace/instances/vm-test/openclaw/workspace';
    assert.throws(() => {
      ws.resolveSafePath(root, 'foo%2F..%2F..%2Fetc%2Fpasswd');
    }, /Path traversal/);
  });
});

describe('Workspace Service - Previewable Detection', () => {
  const ws = require('../services/workspace');

  it('identifies text files as previewable', () => {
    assert.ok(ws.isPreviewable('readme.md'));
    assert.ok(ws.isPreviewable('index.js'));
    assert.ok(ws.isPreviewable('config.json'));
    assert.ok(ws.isPreviewable('style.css'));
    assert.ok(ws.isPreviewable('app.py'));
    assert.ok(ws.isPreviewable('.gitignore'));
    assert.ok(ws.isPreviewable('Dockerfile'));
  });

  it('identifies binary files as not previewable', () => {
    assert.ok(!ws.isPreviewable('image.png'));
    assert.ok(!ws.isPreviewable('archive.tar.gz'));
    assert.ok(!ws.isPreviewable('program.exe'));
  });
});

describe('Workspace Service - Breadcrumbs', () => {
  const ws = require('../services/workspace');

  it('returns root breadcrumb for /', () => {
    const crumbs = ws.getBreadcrumbs('/');
    assert.strictEqual(crumbs.length, 1);
    assert.strictEqual(crumbs[0].name, 'workspace');
    assert.strictEqual(crumbs[0].path, '/');
  });

  it('returns nested breadcrumbs', () => {
    const crumbs = ws.getBreadcrumbs('/src/components');
    assert.strictEqual(crumbs.length, 3);
    assert.strictEqual(crumbs[0].name, 'workspace');
    assert.strictEqual(crumbs[1].name, 'src');
    assert.strictEqual(crumbs[2].name, 'components');
    assert.strictEqual(crumbs[2].path, '/src/components');
  });
});
