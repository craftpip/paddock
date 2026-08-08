const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

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
    const compose = JSON.parse(yaml);
    const agentService = compose.services['pad-test'];
    const door = compose.services['pad-test-web'];
    assert.ok(!agentService.ports, 'agent has no ports block when peer-networked');
    assert.ok(door, 'door service present');
    assert.strictEqual(door.image, 'alpine/socat');
    assert.deepStrictEqual(door.ports, ['43818:8080']);
    assert.ok(door.command.includes('TCP:gluetun-global:8080'));
    assert.strictEqual(compose.networks.webbridge.name, 'gluetun_default');
    assert.strictEqual(agentService.network_mode, 'container:gluetun-global');
  });

  it('publishes ports directly when on the default network', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '22001', {
      webService: { containerPort: 8080, hostPort: '43818' },
    });
    const compose = JSON.parse(yaml);
    assert.deepStrictEqual(compose.services['pad-test'].ports, ['22001:22', '43818:8080']);
    assert.ok(!compose.services['pad-test-web'], 'no door on the default network');
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
    const door = JSON.parse(yaml).services['pad-test-web'];
    assert.strictEqual(door.network_mode, 'host');
    assert.ok(door.command.includes('TCP:127.0.0.1:8080'));
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
    const compose = JSON.parse(yaml);
    assert.ok(!compose.services['pad-x'].ports, 'no ports block in peer mode');
    assert.ok(compose.services['pad-x-web'], 'door present in peer mode');
    assert.ok(compose.services['pad-x-web'].command.startsWith('TCP-LISTEN:8080,'), 'door forwards to a TCP target');
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
    const compose = JSON.parse(yaml);
    const service = compose.services['pad-t1'];
    assert.strictEqual(service.build.context, path.join(TMP, 'instances', 'pad-t1', 'build'), 'per-instance build context');
    assert.ok(!yaml.includes('vm-builds'), 'no shared build dir referenced');
    assert.strictEqual(service.image, 'paddock-vm-pad-t1:latest', 'per-instance image tag');
    assert.strictEqual(service.build.args.INSTALL_DOCKER, '${INSTALL_DOCKER:-0}', 'default ARG interpolation preserved');
    assert.strictEqual(service.build.args.INSTALL_TMUX, '${INSTALL_TMUX:-1}', 'non-default ARG interpolation preserved');
    assert.strictEqual(service.build.args.NO_DEFAULT, '${NO_DEFAULT}', 'ARG without default emits interpolation');
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

describe('vm-manager - custom workspace mount compose emission (plan 24)', () => {
  // Each test runs with its OWN WORKSPACE_ROOT because instance-image resolves
  // env at call time; the module is re-required fresh and env is restored after.
  function withTmp(fn) {
    const TMP = '/tmp/wstest-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const prevWs = process.env.WORKSPACE_ROOT;
    const prevHost = process.env.HOST_WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = TMP;
    process.env.HOST_WORKSPACE_ROOT = TMP;
    delete require.cache[require.resolve('../services/vm-manager')];
    const vm = require('../services/vm-manager');
    try {
      fn(TMP, vm);
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
      process.env.WORKSPACE_ROOT = prevWs;
      process.env.HOST_WORKSPACE_ROOT = prevHost;
      delete require.cache[require.resolve('../services/vm-manager')];
    }
  }

  it('emits the extra bind from meta flags', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-ws');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'),
        'AGENT=codex\nROOT_PASSWORD=pw\nWORKSPACE_HOST=/shared-ws\nWORKSPACE_DIR=/codex-ws\n');
      const yaml = vm.generateInstanceCompose('pad-ws', 'codex', 'pw', '');
      const service = JSON.parse(yaml).services['pad-ws'];
      assert.ok(service.volumes.includes('/shared-ws:/codex-ws'), 'custom workspace bind emitted');
      assert.strictEqual(service.working_dir, '/codex-ws', 'container starts inside the custom workspace');
      assert.ok(service.volumes.includes(`${TMP}/instances/pad-ws/codex:/root/.codex`), 'data dir bind intact');
    });
  });

  it('emits no working_dir without meta flags', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-ws2');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=codex\nROOT_PASSWORD=pw\n');
      const yaml = vm.generateInstanceCompose('pad-ws2', 'codex', 'pw', '');
      assert.ok(!yaml.includes('working_dir:'), 'no working_dir without custom mount');
      assert.ok(!yaml.includes(':/codex-ws'), 'no custom bind without flags');
    });
  });

  it('rejects a custom workspace mount that would shadow the data dir', () => {
    withTmp((TMP, vm) => {
      assert.throws(() => vm.validateWorkspaceMount('pad-ws3', 'codex', '/shared-ws', '/root/.codex'),
        /swallow the agent data directory/);
    });
  });
});

describe('vm-manager - workspace mount guards (GUARD_*)', () => {
  // Runs each test in an isolated env: WORKSPACE_ROOT must point at a dir that
  // is NOT under a HOST_SYSTEM_DIRS entry (so /tmp is out — use /workspace),
  // and every require re-reads the env. Env + module cache are restored after
  // each test so this last suite never leaks into the ones before it.
  function withGuardTmp(fn) {
    const TMP = '/workspace/.__vmguard-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const prevWs = process.env.WORKSPACE_ROOT;
    const prevHost = process.env.HOST_WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = TMP;
    process.env.HOST_WORKSPACE_ROOT = TMP;
    fs.mkdirSync(TMP, { recursive: true });
    delete require.cache[require.resolve('../services/instance-image')];
    delete require.cache[require.resolve('../services/vm-manager')];
    const vm = require('../services/vm-manager');
    try {
      fn(TMP, vm);
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
      process.env.WORKSPACE_ROOT = prevWs;
      process.env.HOST_WORKSPACE_ROOT = prevHost;
      for (const g of ['PROJECT_ROOT', 'INSTANCES_PARENT', 'AGENT_DATA']) delete process.env[`GUARD_${g}`];
      delete require.cache[require.resolve('../services/instance-image')];
      delete require.cache[require.resolve('../services/vm-manager')];
    }
  }

  it('rejects the project root as a workspace source by default', () => {
    withGuardTmp((TMP, vm) => {
      assert.throws(() => vm.validateWorkspaceMount('pad-g', 'opencode', TMP, '/ws'),
        /project root cannot be the workspace source/);
    });
  });

  it('allows the project root when GUARD_PROJECT_ROOT, GUARD_INSTANCES_PARENT and GUARD_AGENT_DATA are off', () => {
    withGuardTmp((TMP, vm) => {
      process.env.GUARD_PROJECT_ROOT = '0';
      process.env.GUARD_INSTANCES_PARENT = '0';
      process.env.GUARD_AGENT_DATA = '0';
      const info = vm.validateWorkspaceMount('pad-g', 'opencode', TMP, '/ws');
      assert.strictEqual(info.host, TMP);
      assert.strictEqual(info.container, '/ws');
    });
  });

  it('still rejects the project root when only GUARD_INSTANCES_PARENT is off', () => {
    withGuardTmp((TMP, vm) => {
      process.env.GUARD_PROJECT_ROOT = '1';
      process.env.GUARD_INSTANCES_PARENT = '0';
      assert.throws(() => vm.validateWorkspaceMount('pad-g', 'opencode', TMP, '/ws'),
        /project root cannot be the workspace source/);
    });
  });

  it('rejects the project root while GUARD_AGENT_DATA is still on', () => {
    withGuardTmp((TMP, vm) => {
      process.env.GUARD_PROJECT_ROOT = '0';
      process.env.GUARD_INSTANCES_PARENT = '0';
      assert.throws(() => vm.validateWorkspaceMount('pad-g', 'opencode', TMP, '/ws'),
        /swallow the agent data folder/);
    });
  });

  it('rejects the instances folder by default even with GUARD_PROJECT_ROOT off', () => {
    withGuardTmp((TMP, vm) => {
      process.env.GUARD_PROJECT_ROOT = '0';
      assert.throws(() => vm.validateWorkspaceMount('pad-g', 'opencode', path.join(TMP, 'instances'), '/ws'),
        /instances folder or a parent of it/);
    });
  });
});

describe('vm-manager - compose validation gate (plan 29)', () => {
  // Each test runs with its OWN WORKSPACE_ROOT; the module is re-required fresh
  // so env is read at require time, and env is restored after.
  async function withTmp(fn) {
    const TMP = '/tmp/comptest-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const prevWs = process.env.WORKSPACE_ROOT;
    const prevHost = process.env.HOST_WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = TMP;
    process.env.HOST_WORKSPACE_ROOT = TMP;
    delete require.cache[require.resolve('../services/vm-manager')];
    const vm = require('../services/vm-manager');
    try {
      return await fn(TMP, vm);
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
      process.env.WORKSPACE_ROOT = prevWs;
      process.env.HOST_WORKSPACE_ROOT = prevHost;
      delete require.cache[require.resolve('../services/vm-manager')];
    }
  }

  it('emits interpolation and colon-bearing values as literal JSON strings', async () => {
    await withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-c');
      fs.mkdirSync(path.join(instDir, 'build'), { recursive: true });
      fs.writeFileSync(path.join(instDir, 'build', 'Dockerfile'), 'FROM base\nARG INSTALL_DOCKER=0\n');
      fs.writeFileSync(path.join(instDir, 'meta.env'),
        'AGENT=opencode\nROOT_PASSWORD=pw\n' +
        'WORKSPACE_HOST=/shared-ws\nWORKSPACE_DIR=/ws\n' +
        'EXTRA_PORTS=[{"host":"43899","container":"8443"}]\n');
      const yaml = vm.generateInstanceCompose('pad-c', 'opencode', 'pw', '22001');
      const compose = JSON.parse(yaml);
      // JSON never needs quoting, so `${VAR:-default}` and `host:container`
      // pairs survive byte-for-byte as values, not as YAML flow syntax.
      assert.strictEqual(compose.services['pad-c'].build.args.INSTALL_DOCKER, '${INSTALL_DOCKER:-0}');
      assert.deepStrictEqual(compose.services['pad-c'].ports, ['22001:22', '43899:8443']);
      assert.ok(compose.services['pad-c'].volumes.includes('/shared-ws:/ws'), 'colon-bearing volume bind');
    });
  });

  it('validateInstanceCompose passes a generated compose and reports parser output on garbage', async () => {
    await withTmp(async (TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-v');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nROOT_PASSWORD=pw\n');
      vm.writeInstanceCompose('pad-v', 'opencode', 'pw', '');
      await vm.validateInstanceCompose('pad-v'); // must not throw

      fs.writeFileSync(path.join(instDir, 'docker-compose.yml'), '{ not valid json at all::::\n');
      await assert.rejects(() => vm.validateInstanceCompose('pad-v'),
        /Compose validation failed for 'pad-v'/);
    });
  });
});

describe('vm-manager - extra volumes & ports (plan 28)', () => {
  function withTmp(fn) {
    const TMP = '/tmp/p28test-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
    const prevWs = process.env.WORKSPACE_ROOT;
    const prevHost = process.env.HOST_WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = TMP;
    process.env.HOST_WORKSPACE_ROOT = TMP;
    delete require.cache[require.resolve('../services/vm-manager')];
    const vm = require('../services/vm-manager');
    try {
      fn(TMP, vm);
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
      process.env.WORKSPACE_ROOT = prevWs;
      process.env.HOST_WORKSPACE_ROOT = prevHost;
      delete require.cache[require.resolve('../services/vm-manager')];
    }
  }

  it('validateExtraVolume rejects system host sources', () => {
    withTmp((TMP, vm) => {
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/etc', '/data/x'), /system directory/i);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/proc', '/data/x'), /system directory/i);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/usr/lib', '/data/x'), /system directory/i);
    });
  });

  it('validateExtraVolume rejects relative host sources and ":" characters', () => {
    withTmp((TMP, vm) => {
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', 'my-folder', '/data/x'), /instances\//);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/shared:read', '/data/x'), /cannot contain ":"/);
    });
  });

  it('validateExtraVolume rejects protected container paths and data-dir swallows', () => {
    withTmp((TMP, vm) => {
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/shared', '/etc'), /system path \/etc/);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/shared', '/root/.openclaw'), /swallow the agent data directory/);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/shared', '/root'), /swallow the agent data directory/);
    });
  });

  it('validateExtraVolume normalizes a valid mount', () => {
    withTmp((TMP, vm) => {
      const vol = vm.validateExtraVolume('pad-a', 'openclaw', '/shared/data', '/mnt/extra', true);
      assert.strictEqual(vol.host, '/shared/data');
      assert.strictEqual(vol.container, '/mnt/extra');
      assert.strictEqual(vol.readonly, true);
    });
  });

  it('validateExtraVolumes rejects duplicates and skips empty entries', () => {
    withTmp((TMP, vm) => {
      const vols = vm.validateExtraVolumes('pad-a', 'openclaw', [{ host: '/shared', container: '/mnt/a' }, {}]);
      assert.strictEqual(vols.length, 1);
      assert.throws(() => vm.validateExtraVolumes('pad-a', 'openclaw', 'nope'), /must be a list/);
      assert.throws(
        () => vm.validateExtraVolumes('pad-a', 'openclaw', [
          { host: '/shared', container: '/mnt/a' },
          { host: '/shared', container: '/mnt/a' },
        ]),
        /Duplicate extra volume mount/,
      );
    });
  });

  it('validateExtraPorts enforces bounds, self-dups, SSH and web conflicts', () => {
    withTmp((TMP, vm) => {
      assert.throws(() => vm.validateExtraPorts([{ host: 0, container: 80 }]), /between 1 and 65535/);
      assert.throws(() => vm.validateExtraPorts([{ host: 9000, container: 99999 }]), /between 1 and 65535/);
      assert.throws(() => vm.validateExtraPorts([{ host: 9000, container: 80 }, { host: 9000, container: 81 }]), /Duplicate host port 9000/);
      assert.throws(() => vm.validateExtraPorts([{ host: 22001, container: 80 }], { sshPort: '22001' }), /SSH port of this agent/);
      assert.throws(() => vm.validateExtraPorts([{ host: 43818, container: 80 }], { webHostPort: '43818' }), /web app host port/);
    });
  });

  it('validateExtraPorts rejects any port while peer-networked', () => {
    withTmp((TMP, vm) => {
      assert.throws(() => vm.validateExtraPorts([{ host: 9000, container: 80 }], { network: 'gluetun-global' }),
        /joins gluetun-global's network/);
      assert.deepStrictEqual(vm.validateExtraPorts([], { network: 'gluetun-global' }), []);
    });
  });

  it('generateInstanceCompose emits extra volumes and ports from meta', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-vp');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'),
        'AGENT=opencode\nROOT_PASSWORD=pw\nPORT=22001\n' +
        'EXTRA_VOLUMES=[{"host":"/mnt/data","container":"/root/.opencode/data/extra","readonly":true}]\n' +
        'EXTRA_PORTS=[{"host":"9000","container":"80"}]\n');
      const yaml = vm.generateInstanceCompose('pad-vp', 'opencode', 'pw', '22001');
      const service = JSON.parse(yaml).services['pad-vp'];
      assert.ok(service.volumes.includes('/mnt/data:/root/.opencode/data/extra:ro'), 'extra volume with :ro suffix');
      assert.deepStrictEqual(service.ports, ['22001:22', '9000:80'], 'SSH + extra ports published');
    });
  });

  it('peer-networked agents drop all ports (SSH + extras) and mount extras still', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-vp2');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'),
        'AGENT=opencode\nROOT_PASSWORD=pw\nPORT=22001\nNETWORK=gluetun-global\n' +
        'EXTRA_VOLUMES=[{"host":"/mnt/data","container":"/root/.opencode/data/extra"}]\n' +
        'EXTRA_PORTS=[{"host":"9000","container":"80"}]\n');
      const yaml = vm.generateInstanceCompose('pad-vp2', 'opencode', 'pw', '22001', { network: 'gluetun-global' });
      const compose = JSON.parse(yaml);
      assert.ok(!compose.services['pad-vp2'].ports, 'no ports in peer mode');
      assert.ok(compose.services['pad-vp2'].volumes.includes('/mnt/data:/root/.opencode/data/extra'), 'extra volume kept in peer mode');
      assert.strictEqual(compose.services['pad-vp2'].network_mode, 'container:gluetun-global');
    });
  });

  it('readExtraVolumes/readExtraPorts round-trip through meta', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-rt');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=openclaw\n');
      assert.deepStrictEqual(vm.readExtraVolumes('pad-rt'), []);
      assert.deepStrictEqual(vm.readExtraPorts('pad-rt'), []);
      vm.setMetaFlag('pad-rt', 'EXTRA_VOLUMES', JSON.stringify([{ host: '/a', container: '/b', readonly: false }]));
      vm.setMetaFlag('pad-rt', 'EXTRA_PORTS', JSON.stringify([{ host: '9000', container: '80' }]));
      assert.deepStrictEqual(vm.readExtraVolumes('pad-rt'), [{ host: '/a', container: '/b', readonly: false }]);
      assert.deepStrictEqual(vm.readExtraPorts('pad-rt'), [{ host: '9000', container: '80' }]);
      vm.setMetaFlag('pad-rt', 'EXTRA_VOLUMES', '');
      assert.deepStrictEqual(vm.readExtraVolumes('pad-rt'), []);
    });
  });

  it('autoSshPort scans compose files starting at 43817', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-ssh');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'docker-compose.yml'),
        '{\n  "services": { "pad-ssh": { "ports": ["43817:22"] } }\n}\n');
      assert.strictEqual(vm.autoSshPort(), '43818');
    });
  });
});
