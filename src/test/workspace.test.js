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

// Plan 64 §3a/3b: the host-browsing gate, and the rule that an opt-in is
// PERMISSION rather than capability.
describe('Workspace - host browsing gate', () => {
  const vm = require('../services/vm-manager');

  it('the gate and the action root agree: browsable implies the root has a host view', () => {
    const cases = [
      ['data dir, no flag', vm.workspaceMountInfo('p', 'opencode', `${vm.HOST_WORKSPACE}/instances/p/opencode`, '/workspace')],
      ['project, no flag', vm.workspaceMountInfo('p', 'opencode', vm.HOST_WORKSPACE, '/workspace')],
      ['project, opted in', vm.workspaceMountInfo('p', 'opencode', vm.HOST_WORKSPACE, '/workspace', { allowHostBrowse: true })],
      ['outside project, opted in', vm.workspaceMountInfo('p', 'opencode', '/www1/elsewhere', '/workspace', { allowHostBrowse: true })],
      ['outside project, no flag', vm.workspaceMountInfo('p', 'opencode', '/www1/elsewhere', '/workspace')],
    ];
    for (const [label, m] of cases) {
      if (m.hostBrowsable) {
        // The one invariant: if the gate says yes, the folder the action will
        // actually touch is one the webui can see. An opt-in that cleared the
        // gate for a mount with no host view left the gate saying yes while
        // `host_browse_root` fell back to the data dir — the same pad browsing
        // two different folders depending on which question was asked.
        assert.ok(vm.containerViewOf(m.host), `${label}: browsable, so the mount must have a host view`);
      } else {
        assert.ok(m.hostBrowseReason, `${label}: refused, so it must say why`);
      }
    }
  });

  it('HOST_BROWSE=1 cannot grant a folder the webui cannot reach', () => {
    const m = vm.workspaceMountInfo('p', 'opencode', '/www1/elsewhere', '/workspace', { allowHostBrowse: true });
    assert.strictEqual(m.hostBrowsable, false, 'permission is not capability');
    assert.match(m.hostBrowseReason, /cannot reach it on the host/);
  });
});
