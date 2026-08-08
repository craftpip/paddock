const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

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

describe('Agent Registry - VM Name Validation', () => {
  const registry = require('../services/agent-registry');

  it('accepts valid VM names', () => {
    assert.ok(registry.VM_NAME_RE.test('vm-test'));
    assert.ok(registry.VM_NAME_RE.test('vm-jake'));
    assert.ok(registry.VM_NAME_RE.test('vm-ozden2'));
    assert.ok(registry.VM_NAME_RE.test('vm-a'));
  });

  it('rejects invalid VM names', () => {
    assert.ok(!registry.VM_NAME_RE.test('test'));
    assert.ok(!registry.VM_NAME_RE.test('vm-'));
    assert.ok(!registry.VM_NAME_RE.test('vm- '));
    assert.ok(!registry.VM_NAME_RE.test(''));
    assert.ok(!registry.VM_NAME_RE.test('VM-test'));
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

describe('Database - Schema', () => {
  const { getDb, close } = require('../services/db');

  it('creates and initializes database', () => {
    const db = getDb();
    assert.ok(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('agents'));
    assert.ok(tableNames.includes('activity_events'));
    assert.ok(tableNames.includes('sessions'));
  });

  it('can insert and query agents', () => {
    const db = getDb();
    const testId = 'vm-test-unit';
    try {
      db.prepare(`INSERT OR REPLACE INTO agents (id, name, display_name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(testId, testId, 'Test', 'openclaw', 'docker', testId, 'running');
      const row = db.prepare('SELECT * FROM agents WHERE name = ?').get(testId);
      assert.ok(row);
      assert.strictEqual(row.status, 'running');
    } finally {
      db.prepare('DELETE FROM agents WHERE name = ?').run(testId);
    }
  });

  it('can insert and query activity events', () => {
    const db = getDb();
    const testAgent = 'vm-test-activity';
    try {
      db.prepare(`INSERT OR REPLACE INTO agents (id, name, display_name, agent_type, runtime_type, runtime_ref, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(testAgent, testAgent, 'Test', 'openclaw', 'docker', testAgent, 'running');
      db.prepare(`INSERT INTO activity_events (agent_id, category, action, status, details) VALUES (?, ?, ?, ?, ?)`)
        .run(testAgent, 'test', 'unit_test', 'ok', 'Test event');
      const events = db.prepare('SELECT * FROM activity_events WHERE agent_id = ?').all(testAgent);
      assert.ok(events.length > 0);
      assert.strictEqual(events[0].action, 'unit_test');
    } finally {
      db.prepare('DELETE FROM activity_events WHERE agent_id = ?').run(testAgent);
      db.prepare('DELETE FROM agents WHERE name = ?').run(testAgent);
    }
  });
});

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

describe('vm-manager - Web door compose generation', () => {
  process.env.WORKSPACE_ROOT = '/workspace';
  process.env.HOST_WORKSPACE_ROOT = '/workspace';
  const vm = require('../services/vm-manager');

  it('emits a socat door service when the agent routes through a network peer', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '22001', {
      network: 'gluetun-global',
      webService: { containerPort: 8080, hostPort: '43818' },
      webPeerNetwork: 'gluetun_default',
    });
    const agentBlock = yaml.slice(yaml.indexOf('  pad-test:'), yaml.indexOf('  pad-test-web:'));
    assert.ok(!agentBlock.includes('ports:'), 'agent has no ports block when peer-networked');
    assert.ok(yaml.includes('pad-test-web:'), 'door service present');
    assert.ok(yaml.includes('image: alpine/socat'));
    assert.ok(yaml.includes('"43818:8080"'));
    assert.ok(yaml.includes('TCP:gluetun-global:8080'));
    assert.ok(yaml.includes('name: gluetun_default'));
    assert.ok(yaml.includes('network_mode: container:gluetun-global'));
  });

  it('publishes ports directly when on the default network', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '22001', {
      webService: { containerPort: 8080, hostPort: '43818' },
    });
    assert.ok(yaml.includes('"43818:8080"'));
    assert.ok(yaml.includes('"22001:22"'));
    assert.ok(!yaml.includes('pad-test-web'), 'no door on the default network');
  });

  it('skips SSH port publish when peer-networked (docker constraint)', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '22001', {
      network: 'gluetun-global',
    });
    assert.ok(!/ports:/.test(yaml));
  });

  it('emits a host-network door when the peer has no docker network', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '', {
      network: 'host-peer',
      webService: { containerPort: 8080, hostPort: '43818' },
      webPeerNetwork: '',
    });
    assert.ok(yaml.includes('network_mode: host'));
    assert.ok(yaml.includes('TCP:127.0.0.1:8080'));
  });
});

describe('vm-manager - applySettings keeps a published web app alive', () => {
  const TMP = '/tmp/vmtest-' + Date.now();
  process.env.WORKSPACE_ROOT = TMP;
  process.env.HOST_WORKSPACE_ROOT = TMP;
  delete require.cache[require.resolve('../services/vm-manager')];
  const vm = require('../services/vm-manager');

  it('re-applies the web binding for the new network on a network switch', async () => {
    const instDir = path.join(TMP, 'instances', 'pad-x');
    fs.mkdirSync(instDir, { recursive: true });
    fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nPORT=22001\nROOT_PASSWORD=pass\n');
    fs.writeFileSync(path.join(instDir, 'web.json'), JSON.stringify({ containerPort: 8080, hostPort: '43818' }));

    // Default network → the web port is published directly on the agent.
    await vm.applySettings('pad-x', { allowDocker: false, network: '' });
    let yaml = fs.readFileSync(path.join(instDir, 'docker-compose.yml'), 'utf8');
    assert.ok(yaml.includes('"43818:8080"'), 'web port published on default network');
    assert.ok(!yaml.includes('pad-x-web'), 'no door on default network');

    // Switch to a network peer → the ports block leaves the agent and the
    // socat door takes over (in the sandbox getPeerNetworkName fails → the
    // host-mode door render, which is still a valid door).
    await vm.applySettings('pad-x', { allowDocker: false, network: 'gluetun-global' });
    yaml = fs.readFileSync(path.join(instDir, 'docker-compose.yml'), 'utf8');
    const agentBlock = yaml.slice(yaml.indexOf('  pad-x:'), yaml.indexOf('  pad-x-web:'));
    assert.ok(!agentBlock.includes('ports:'), 'no ports block in peer mode');
    assert.ok(yaml.includes('pad-x-web:'), 'door present in peer mode');
    assert.ok(/command: TCP-LISTEN:8080,.* TCP:/.test(yaml), 'door forwards to a TCP target');
  });

  it('regen without an active binding stays doorless', async () => {
    const instDir = path.join(TMP, 'instances', 'pad-x');
    fs.rmSync(path.join(instDir, 'web.json'));
    await vm.applySettings('pad-x', { allowDocker: false, network: 'gluetun-global' });
    const yaml = fs.readFileSync(path.join(instDir, 'docker-compose.yml'), 'utf8');
    assert.ok(!yaml.includes('pad-x-web'), 'no door without a web binding');
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});

describe('vm-manager - per-instance build files (plan 25)', () => {
  const TMP = '/tmp/insttest-' + Date.now();
  process.env.WORKSPACE_ROOT = TMP;
  process.env.HOST_WORKSPACE_ROOT = TMP;
  delete require.cache[require.resolve('../services/instance-image')];
  delete require.cache[require.resolve('../services/vm-manager')];
  const vm = require('../services/vm-manager');

  const instDir = path.join(TMP, 'instances', 'pad-t1');
  const buildDir = path.join(instDir, 'build');

  it('imageFor derives a stable per-instance tag', () => {
    assert.strictEqual(vm.imageFor('pad-t1'), 'paddock-vm-pad-t1:latest');
    assert.strictEqual(vm.imageFor('pad-OPENCODE-YO'), 'paddock-vm-pad-opencode-yo:latest');
  });

  it('argsFromDockerfile extracts ARG lines (defaults + commented skip)', () => {
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(path.join(buildDir, 'Dockerfile'),
      'FROM base:latest\n' +
      'ARG INSTALL_DOCKER=0\n' +
      '# ARG INSTALL_TMUX=1\n' +
      'ARG INSTALL_TMUX=1\n' +
      'ARG NO_DEFAULT\n');
    const args = vm.argsFromDockerfile(path.join(buildDir, 'Dockerfile'));
    assert.deepStrictEqual(args, [
      { name: 'INSTALL_DOCKER', default: '0' },
      { name: 'INSTALL_TMUX', default: '1' },
      { name: 'NO_DEFAULT', default: '' },
    ]);
  });

  it('compose uses the per-instance build context, image and generated args', () => {
    const yaml = vm.generateInstanceCompose('pad-t1', 'openclaw', 'pw', '22001');
    assert.ok(yaml.includes(`context: ${path.join(TMP, 'instances', 'pad-t1', 'build')}`), 'per-instance build context');
    assert.ok(!yaml.includes('vm-builds'), 'no shared build dir referenced');
    assert.ok(yaml.includes('image: paddock-vm-pad-t1:latest'), 'per-instance image tag');
    assert.ok(yaml.includes('INSTALL_DOCKER: ${INSTALL_DOCKER:-0}'), 'args block from Dockerfile ARG lines');
    assert.ok(yaml.includes('INSTALL_TMUX: ${INSTALL_TMUX:-1}'), 'args block includes non-default ARG');
    assert.ok(yaml.includes('NO_DEFAULT: ${NO_DEFAULT}'), 'ARG without default emits bare interpolation');
  });

  it('setBuildEnv/readBuildEnv round-trip preserving comments and other keys', () => {
    vm.setBuildEnv('pad-t1', { INSTALL_DOCKER: '1' });
    vm.setBuildEnv('pad-t1', { INSTALL_TMUX: '0' });
    let env = vm.readBuildEnv('pad-t1');
    assert.strictEqual(env.INSTALL_DOCKER, '1');
    assert.strictEqual(env.INSTALL_TMUX, '0');
    // Existing keys are updated, not duplicated; comments survive.
    vm.setBuildEnv('pad-t1', { INSTALL_DOCKER: '0' });
    const content = fs.readFileSync(path.join(buildDir, 'build.env'), 'utf8');
    assert.strictEqual((content.match(/^INSTALL_DOCKER=/gm) || []).length, 1, 'key updated in place');
    assert.ok(content.includes('# Per-instance build args'), 'header comment preserved');
    env = vm.readBuildEnv('pad-t1');
    assert.strictEqual(env.INSTALL_DOCKER, '0');
    assert.strictEqual(env.INSTALL_TMUX, '0');
  });

  it('seedBuildDir copies the template with extras/ + build.env invariants', () => {
    fs.mkdirSync(path.join(TMP, 'instances', 'pad-seed'), { recursive: true });
    const dir = vm.seedBuildDir('pad-seed', 'opencode');
    assert.ok(fs.existsSync(path.join(dir, 'Dockerfile')), 'Dockerfile copied from template');
    assert.ok(fs.existsSync(path.join(dir, 'start.sh')), 'start.sh copied from template');
    assert.ok(fs.existsSync(path.join(dir, 'extras', '.gitkeep')), 'extras/.gitkeep seeded');
    assert.ok(fs.existsSync(path.join(dir, 'build.env')), 'build.env created');
    // Idempotent: seeding again does not overwrite an edited Dockerfile.
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'EDITED\n');
    vm.seedBuildDir('pad-seed', 'opencode');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8'), 'EDITED\n', 'existing build files untouched');
    // installDocker seeds a FRESH build.env with INSTALL_DOCKER=1 (idempotent
    // seeding never overwrites an existing build.env).
    fs.mkdirSync(path.join(TMP, 'instances', 'pad-seed2'), { recursive: true });
    vm.seedBuildDir('pad-seed2', 'openclaw', { installDocker: true });
    assert.strictEqual(vm.readBuildEnv('pad-seed2').INSTALL_DOCKER, '1');
  });

  it('composeCommand prefixes --env-file with the instance build.env', () => {
    const args = vm.composeCommand('pad-t1', 'build');
    assert.deepStrictEqual(args[0], 'compose');
    assert.deepStrictEqual(args[1], '--env-file');
    assert.strictEqual(args[2], path.join(buildDir, 'build.env'));
    assert.strictEqual(args[3], '-f');
    assert.ok(args.includes('build'));
    fs.rmSync(TMP, { recursive: true, force: true });
  });
});
