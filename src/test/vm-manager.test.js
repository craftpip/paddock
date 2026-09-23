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
    const door = compose.services['pad-test-door'];
    assert.ok(!agentService.ports, 'agent has no ports block when peer-networked');
    assert.ok(door, 'door service present');
    assert.strictEqual(door.image, 'alpine/socat');
    assert.deepStrictEqual(door.ports, ['43818:43818', '22001:22001'], 'identity host:host map');
    const cmd = door.entrypoint.join(' ');
    assert.ok(cmd.includes('TCP:gluetun-global:8080'), 'web port forwarded to the peer');
    assert.ok(cmd.includes('TCP:gluetun-global:22'), 'SSH port forwarded to the peer');
    assert.strictEqual(compose.networks.webbridge.name, 'gluetun_default');
    assert.strictEqual(agentService.network_mode, 'container:gluetun-global');
  });

  it('publishes ports directly when on the default network', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '22001', {
      webService: { containerPort: 8080, hostPort: '43818' },
    });
    const compose = JSON.parse(yaml);
    assert.deepStrictEqual(compose.services['pad-test'].ports, ['22001:22', '43818:8080']);
    assert.ok(!compose.services['pad-test-door'], 'no door on the default network');
  });

  it('routes the SSH port through the door when peer-networked', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '22001', {
      network: 'gluetun-global',
      webPeerNetwork: 'gluetun_default',
    });
    const compose = JSON.parse(yaml);
    assert.ok(!compose.services['pad-test'].ports, 'agent itself never publishes ports in peer mode');
    const door = compose.services['pad-test-door'];
    assert.ok(door, 'door carries the SSH port');
    assert.deepStrictEqual(door.ports, ['22001:22001']);
    assert.ok(door.entrypoint.join(' ').includes('TCP:gluetun-global:22'));
  });

  it('emits a host-network door when the peer has no docker network', () => {
    const yaml = vm.generateInstanceCompose('pad-test', 'opencode', 'pw', '', {
      network: 'host-peer',
      webService: { containerPort: 8080, hostPort: '43818' },
      webPeerNetwork: '',
    });
    const door = JSON.parse(yaml).services['pad-test-door'];
    assert.strictEqual(door.network_mode, 'host');
    assert.ok(door.entrypoint.join(' ').includes('TCP:127.0.0.1:8080'));
  });

  it('includes the forwarding door in a peer-networked recreate', () => {
    const previousWorkspace = process.env.WORKSPACE_ROOT;
    const previousHostWorkspace = process.env.HOST_WORKSPACE_ROOT;
    const tmp = `/tmp/recreate-services-${Date.now()}`;
    process.env.WORKSPACE_ROOT = tmp;
    process.env.HOST_WORKSPACE_ROOT = tmp;
    delete require.cache[require.resolve('../services/vm-manager')];
    const isolatedVm = require('../services/vm-manager');
    try {
      const instanceDir = path.join(tmp, 'instances', 'pad-recreate');
      fs.mkdirSync(instanceDir, { recursive: true });
      fs.writeFileSync(path.join(instanceDir, 'meta.env'), 'NETWORK=gluetun\n');
      fs.writeFileSync(path.join(instanceDir, 'web.json'), JSON.stringify({ containerPort: 8080, hostPort: '43818' }));
      assert.deepStrictEqual(isolatedVm.recreateServices('pad-recreate'), ['pad-recreate', 'pad-recreate-door']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      process.env.WORKSPACE_ROOT = previousWorkspace;
      process.env.HOST_WORKSPACE_ROOT = previousHostWorkspace;
      delete require.cache[require.resolve('../services/vm-manager')];
    }
  });

  it('identifies a forwarding sidecar without hiding a real similarly named PAD', () => {
    const previousWorkspace = process.env.WORKSPACE_ROOT;
    const previousHostWorkspace = process.env.HOST_WORKSPACE_ROOT;
    const tmp = `/tmp/managed-door-${Date.now()}`;
    process.env.WORKSPACE_ROOT = tmp;
    process.env.HOST_WORKSPACE_ROOT = tmp;
    delete require.cache[require.resolve('../services/vm-manager')];
    const isolatedVm = require('../services/vm-manager');
    try {
      fs.mkdirSync(path.join(tmp, 'instances', 'pad-parent'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'instances', 'pad-parent', 'meta.env'), 'AGENT=opencode\n');
      fs.mkdirSync(path.join(tmp, 'instances', 'pad-real-door'), { recursive: true });
      assert.strictEqual(isolatedVm.isManagedDoorContainer('pad-parent-door'), true);
      assert.strictEqual(isolatedVm.isManagedDoorContainer('pad-real-door'), false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      process.env.WORKSPACE_ROOT = previousWorkspace;
      process.env.HOST_WORKSPACE_ROOT = previousHostWorkspace;
      delete require.cache[require.resolve('../services/vm-manager')];
    }
  });
});

describe('vm-manager - pad default-network subnet (pool exhaustion fix)', () => {
  // Each test runs with its OWN WORKSPACE_ROOT so meta writes never touch real
  // instances; the module is re-required fresh and env is restored after.
  function withTmp(fn) {
    const TMP = '/tmp/subtest-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
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

  it('emits the persisted SUBNET on the default network', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-sub');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nROOT_PASSWORD=pw\nSUBNET=10.200.42.0/24\n');
      const compose = JSON.parse(vm.generateInstanceCompose('pad-sub', 'opencode', 'pw', ''));
      assert.strictEqual(compose.networks.default.ipam.config[0].subnet, '10.200.42.0/24');
    });
  });

  it('keeps the door webbridge network alongside the default subnet', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-sub');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nROOT_PASSWORD=pw\nSUBNET=10.200.42.0/24\n');
      const yaml = vm.generateInstanceCompose('pad-sub', 'opencode', 'pw', '22001', {
        network: 'gluetun-global',
        webPeerNetwork: 'gluetun_default',
      });
      const compose = JSON.parse(yaml);
      assert.strictEqual(compose.networks.default.ipam.config[0].subnet, '10.200.42.0/24');
      assert.strictEqual(compose.networks.webbridge.name, 'gluetun_default');
    });
  });

  it('leaves the compose subnet-less when SUBNET is absent', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-sub2');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nROOT_PASSWORD=pw\n');
      const yaml = vm.generateInstanceCompose('pad-sub2', 'opencode', 'pw', '');
      assert.ok(!yaml.includes('"networks"'), 'no networks block without a persisted subnet');
    });
  });

  it('writeInstanceCompose persists a fresh pool subnet for a never-started pad', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-sub3');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nROOT_PASSWORD=pw\n');
      vm.writeInstanceCompose('pad-sub3', 'opencode', 'pw', '');
      const subnet = vm.readMeta(instDir).SUBNET;
      assert.ok(/^10\.200\.\d{1,3}\.0\/24$/.test(subnet), `subnet in the pad pool, got ${subnet}`);
      const compose = JSON.parse(fs.readFileSync(path.join(instDir, 'docker-compose.yml'), 'utf8'));
      assert.strictEqual(compose.networks.default.ipam.config[0].subnet, subnet, 'compose and meta agree');
    });
  });
});

describe('vm-manager - Web start hook', () => {
  process.env.WORKSPACE_ROOT = '/workspace';
  process.env.HOST_WORKSPACE_ROOT = '/workspace';
  const vm = require('../services/vm-manager');

  it('streams web-server output to Docker logs while retaining web.log', () => {
    const hook = vm.buildWebHook({
      dataDir: '/root/.opencode',
      webApp: { startCommand: () => 'opencode web --port 8080' },
    }, 'opencode', { containerPort: 8080 }, '');

    assert.ok(hook.includes('( exec 3<>/dev/tcp/127.0.0.1/8080 ) 2>/dev/null'), 'quiet port probe');
    assert.ok(hook.includes('opencode web --port 8080 2>&1 | tee -a /root/.opencode/web.log >/proc/1/fd/1 &'), 'server output reaches Docker logs and web.log');
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
    assert.ok(compose.services['pad-x-door'], 'door present in peer mode');
    assert.ok(compose.services['pad-x-door'].entrypoint.join(' ').includes('TCP-LISTEN:'), 'door forwards to a TCP target');
  });

  it('regen without published ports stays doorless', async () => {
    const instDir = path.join(TMP, 'instances', 'pad-x');
    fs.rmSync(path.join(instDir, 'web.json'));
    // Clear the SSH port too so nothing is published — with a published port in
    // peer mode the door legitimately exists.
    await vm.applySettings('pad-x', { allowDocker: false, network: 'gluetun-global', sshPort: '' });
    const yaml = fs.readFileSync(path.join(instDir, 'docker-compose.yml'), 'utf8');
    assert.ok(!yaml.includes('pad-x-door'), 'no door without published ports');
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('updates the SSH host port and persists it in meta.env', async () => {
    const instDir = path.join(TMP, 'instances', 'pad-x');
    fs.mkdirSync(instDir, { recursive: true });
    fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nPORT=22001\nROOT_PASSWORD=pass\n');
    fs.rmSync(path.join(instDir, 'web.json'), { force: true });

    // Change the SSH port (on the default network it's published directly).
    await vm.applySettings('pad-x', { allowDocker: false, network: '', sshPort: '22222' });
    let yaml = fs.readFileSync(path.join(instDir, 'docker-compose.yml'), 'utf8');
    assert.ok(yaml.includes('"22222:22"'), 'new SSH port published');
    assert.ok(!yaml.includes('"22001:22"'), 'old SSH port gone');
    assert.ok(fs.readFileSync(path.join(instDir, 'meta.env'), 'utf8').includes('PORT=22222'), 'meta.env PORT updated');

    // Un-expose: the ports block disappears and PORT clears.
    await vm.applySettings('pad-x', { allowDocker: false, network: '', sshPort: '' });
    yaml = fs.readFileSync(path.join(instDir, 'docker-compose.yml'), 'utf8');
    assert.ok(!yaml.includes(':22"'), 'no published SSH port when un-exposed');
    assert.ok(!fs.readFileSync(path.join(instDir, 'meta.env'), 'utf8').includes('PORT='), 'meta.env PORT cleared');
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

  it('validateExtraVolume accepts named volumes and rejects bad names', () => {
    withTmp((TMP, vm) => {
      const vol = vm.validateExtraVolume('pad-a', 'openclaw', 'mempalace-dbdata', '/var/lib/postgresql', false, 'volume');
      assert.strictEqual(vol.type, 'volume');
      assert.strictEqual(vol.host, 'mempalace-dbdata');
      assert.strictEqual(vol.container, '/var/lib/postgresql');
      assert.strictEqual(vol.readonly, false);
      assert.strictEqual(vol.external, undefined);
      const ext = vm.validateExtraVolume('pad-a', 'openclaw', 'dbdata', '/data', true, 'volume', 'mempalace_dbdata');
      assert.strictEqual(ext.external, 'mempalace_dbdata');
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', 'db/data', '/data', false, 'volume'), /plain volume name/);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', '/abs/path', '/data', false, 'volume'), /plain volume name/);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', 'dbdata', '/etc', false, 'volume'), /system path \/etc/);
      assert.throws(() => vm.validateExtraVolume('pad-a', 'openclaw', 'dbdata', '/root', false, 'volume'), /swallow the agent data directory/);
    });
  });

  it('validateExtraVolumes forwards volume type/external and dedupes', () => {
    withTmp((TMP, vm) => {
      const vols = vm.validateExtraVolumes('pad-a', 'openclaw', [
        { type: 'volume', host: 'dbdata', container: '/data', readonly: true, external: 'proj_dbdata' },
        { type: 'bind', host: '/mnt/backups', container: '/backups' },
      ]);
      assert.strictEqual(vols.length, 2);
      assert.deepStrictEqual(vols[0], { type: 'volume', host: 'dbdata', container: '/data', readonly: true, external: 'proj_dbdata' });
      assert.throws(
        () => vm.validateExtraVolumes('pad-a', 'openclaw', [
          { type: 'volume', host: 'dbdata', container: '/data' },
          { type: 'volume', host: 'dbdata', container: '/data' },
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

  it('validateExtraPorts allows ports while peer-networked (door carries them)', () => {
    withTmp((TMP, vm) => {
      assert.deepStrictEqual(
        vm.validateExtraPorts([{ host: 9000, container: 80 }], { network: 'gluetun-global' }),
        [{ host: '9000', container: '80' }],
        'ports pass validation in peer mode');
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

  it('generateInstanceCompose emits a top-level volumes section for named volumes', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-nv');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'),
        'AGENT=openclaw\nROOT_PASSWORD=pw\n' +
        'EXTRA_VOLUMES=[{"type":"volume","host":"dbdata","container":"/var/lib/postgresql","readonly":true,"external":"mempalace_dbdata"},{"host":"/mnt/backups","container":"/backups"}]\n');
      const yaml = vm.generateInstanceCompose('pad-nv', 'openclaw', 'pw', '');
      const compose = JSON.parse(yaml);
      const service = compose.services['pad-nv'];
      assert.ok(service.volumes.includes('dbdata:/var/lib/postgresql:ro'), 'named volume in service mounts');
      assert.ok(service.volumes.includes('/mnt/backups:/backups'), 'bind kept');
      // dockerVolumeExists is a live docker probe in the test env — assert the
      // top-level key exists and either attaches the real volume or falls back
      // to a fresh-volume declaration.
      assert.ok(compose.volumes && compose.volumes.dbdata, 'top-level volumes section declares the named volume');
      const decl = compose.volumes.dbdata;
      assert.ok(!decl.external || decl.name === 'mempalace_dbdata', 'external attach only against the real volume');
    });
  });

  it('peer-networked agents publish SSH + extras through the door', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-vp2');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'),
        'AGENT=opencode\nROOT_PASSWORD=pw\nPORT=22001\nNETWORK=gluetun-global\n' +
        'EXTRA_VOLUMES=[{"host":"/mnt/data","container":"/root/.opencode/data/extra"}]\n' +
        'EXTRA_PORTS=[{"host":"9000","container":"80"}]\n');
      const yaml = vm.generateInstanceCompose('pad-vp2', 'opencode', 'pw', '22001', { network: 'gluetun-global', webPeerNetwork: 'gluetun_default' });
      const compose = JSON.parse(yaml);
      assert.ok(!compose.services['pad-vp2'].ports, 'no ports on the agent in peer mode');
      assert.ok(compose.services['pad-vp2'].volumes.includes('/mnt/data:/root/.opencode/data/extra'), 'extra volume kept in peer mode');
      assert.strictEqual(compose.services['pad-vp2'].network_mode, 'container:gluetun-global');
      const door = compose.services['pad-vp2-door'];
      assert.ok(door, 'door carries SSH + extra ports');
      assert.deepStrictEqual(door.ports, ['22001:22001', '9000:9000'], 'identity host:host map');
      const cmd = door.entrypoint.join(' ');
      assert.ok(cmd.includes('TCP:gluetun-global:22'), 'SSH forwarded to the peer');
      assert.ok(cmd.includes('TCP:gluetun-global:80'), 'extra port forwarded to the peer');
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
      vm.setMetaFlag('pad-rt', 'EXTRA_VOLUMES', JSON.stringify([{ type: 'volume', host: 'dbdata', container: '/data', readonly: true, external: 'x_dbdata' }]));
      assert.deepStrictEqual(vm.readExtraVolumes('pad-rt'), [{ type: 'volume', host: 'dbdata', container: '/data', readonly: true, external: 'x_dbdata' }]);
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

  it('ensureUserModeBuildFiles injects the canonical pad-user block and regenerates start.sh', () => {
    withTmp((TMP, vm) => {
      const build = path.join(TMP, 'instances', 'pad-um', 'build');
      fs.mkdirSync(build, { recursive: true });
      const df = path.join(build, 'Dockerfile');
      fs.writeFileSync(df,
        '# base\n' +
        'COPY start.sh /usr/local/bin/start.sh\n' +
        'RUN chmod +x /usr/local/bin/start.sh\n' +
        'ENTRYPOINT ["/usr/bin/tini"]\n');
      fs.writeFileSync(path.join(build, 'start.sh'), '#!/bin/sh\ntail -f /dev/null\n', { mode: 0o755 });

      assert.strictEqual(vm.ensureUserModeBuildFiles('pad-um', 'opencode'), true, 'files changed on first pass');

      const dockerfile = fs.readFileSync(df, 'utf8');
      assert.ok(dockerfile.includes('__PAD_USER_MODE__'), 'marker injected');
      assert.ok(dockerfile.includes("ALL ALL=(ALL) NOPASSWD:ALL"), 'passwordless rule for any uid-1000 name');
      assert.ok(dockerfile.includes('apt-get install -y --no-install-recommends sudo'), 'block self-installs sudo');
      assert.ok(dockerfile.includes('COPY start.sh /usr/local/bin/start.sh\n'), 'COPY line intact after injection');
      assert.ok(!/padCOPY/.test(dockerfile), 'no fused block/directive lines');

      const startSh = fs.readFileSync(path.join(build, 'start.sh'), 'utf8');
      assert.ok(startSh.includes('__PAD_USER_MODE__'), 'start.sh regenerated with the drop block');

      assert.strictEqual(vm.ensureUserModeBuildFiles('pad-um', 'opencode'), false, 'second pass is idempotent');
    });
  });

  it('ensureUserModeBuildFiles replaces a stale pad-user block without mangling following lines', () => {
    withTmp((TMP, vm) => {
      const build = path.join(TMP, 'instances', 'pad-um2', 'build');
      fs.mkdirSync(build, { recursive: true });
      const df = path.join(build, 'Dockerfile');
      // Stale block: old `pad ALL=` rule shape, no sudo self-install.
      fs.writeFileSync(df,
        '# PAD USER (plan 43 Phase 7) — pad at PUID:PGID + sudoers + chmod 755 /root. __PAD_USER_MODE__\n' +
        'RUN if command -v apk >/dev/null 2>&1; then addgroup -g 1000 pad 2>/dev/null || true; \\\n' +
        '    else groupadd -g 1000 pad 2>/dev/null || true; fi; \\\n' +
        "    if command -v sudo >/dev/null 2>&1; then echo 'pad ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/pad && chmod 440 /etc/sudoers.d/pad; fi\n" +
        'COPY start.sh /usr/local/bin/start.sh\n' +
        'RUN chmod +x /usr/local/bin/start.sh\n');

      assert.strictEqual(vm.ensureUserModeBuildFiles('pad-um2', 'opencode'), true, 'stale block replaced');

      const dockerfile = fs.readFileSync(df, 'utf8');
      assert.ok(dockerfile.includes("ALL ALL=(ALL) NOPASSWD:ALL"), 'rule upgraded to username-independent form');
      assert.ok(!dockerfile.includes("echo 'pad ALL="), 'old pad-keyed rule gone');
      assert.ok(dockerfile.includes('apt-get install -y --no-install-recommends sudo'), 'sudo self-install present');
      assert.ok(dockerfile.includes('COPY start.sh /usr/local/bin/start.sh\n'), 'COPY directive survived replacement');
      assert.ok(dockerfile.includes('\nRUN chmod +x /usr/local/bin/start.sh'), 'following RUN intact');
      assert.ok(!/padCOPY/.test(dockerfile), 'no fused block/directive lines');
    });
  });
});

describe('vm-manager - lifecycle scripts (plan 41)', () => {
  function withTmp(fn) {
    const TMP = '/tmp/p41life-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
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

  it('readPostCreate/readPostStart/readPostAttach return empty when absent', () => {
    withTmp((TMP, vm) => {
      assert.strictEqual(vm.readPostCreate('pad-lc'), '');
      assert.strictEqual(vm.readPostStart('pad-lc'), '');
      assert.strictEqual(vm.readPostAttach('pad-lc'), '');
    });
  });

  it('writePostStartScript writes an executable script; empty text removes it', () => {
    withTmp((TMP, vm) => {
      const p = vm.postStartScriptPath('pad-lc');
      assert.ok(!fs.existsSync(p));
      vm.writePostStartScript('pad-lc', 'echo hello');
      assert.ok(fs.readFileSync(p, 'utf8').includes('echo hello'), 'script body written');
      assert.strictEqual(fs.statSync(p).mode & 0o111, 0o111, 'script is executable');
      assert.strictEqual(vm.readPostStart('pad-lc'), 'echo hello', 'reader strips the shebang');
      vm.writePostStartScript('pad-lc', '');
      assert.ok(!fs.existsSync(p), 'empty write removes the file');
      assert.strictEqual(vm.readPostStart('pad-lc'), '');
    });
  });

  it('hasLifecycleScripts is true when any of the three scripts exists', () => {
    withTmp((TMP, vm) => {
      assert.ok(!vm.hasLifecycleScripts('pad-lc'));
      vm.writePostAttachScript('pad-lc', 'echo attached');
      assert.ok(vm.hasLifecycleScripts('pad-lc'), 'post-attach alone is enough');
      assert.ok(!vm.hasLifecycleScripts('pad-other'));
    });
  });

  it('postAttachScriptPath + readPostAttach roundtrip', () => {
    withTmp((TMP, vm) => {
      vm.writePostAttachScript('pad-lc', 'echo attach');
      assert.strictEqual(vm.readPostAttach('pad-lc'), 'echo attach');
      assert.ok(vm.postAttachScriptPath('pad-lc').endsWith(path.join('build', 'post-attach.sh')));
    });
  });

  it('ensurePostStartBlock injects the hook into an instance start.sh and is idempotent', () => {
    withTmp((TMP, vm) => {
      const build = path.join(TMP, 'instances', 'pad-lc', 'build');
      fs.mkdirSync(build, { recursive: true });
      // Old template: sshd line, no post-start hook.
      fs.writeFileSync(path.join(build, 'start.sh'),
        '#!/bin/bash\n' +
        '/usr/sbin/sshd &\n' +
        'exec something\n', { mode: 0o755 });

      assert.strictEqual(vm.ensurePostStartBlock('pad-lc'), true, 'hook injected');
      const content = fs.readFileSync(path.join(build, 'start.sh'), 'utf8');
      assert.ok(content.includes('/build/post-start.sh'), 'post-start hook present');
      assert.ok(content.includes('/usr/sbin/sshd &'), 'sshd line preserved');

      assert.strictEqual(vm.ensurePostStartBlock('pad-lc'), false, 'second pass is idempotent');
    });
  });

  it('ensurePostStartBlock leaves an already-hooked start.sh alone', () => {
    withTmp((TMP, vm) => {
      const build = path.join(TMP, 'instances', 'pad-lc', 'build');
      fs.mkdirSync(build, { recursive: true });
      fs.writeFileSync(path.join(build, 'start.sh'),
        '#!/bin/bash\n' +
        '/usr/sbin/sshd &\n' +
        'if [ -f /build/post-start.sh ]; then bash /build/post-start.sh || true; fi\n');
      assert.strictEqual(vm.ensurePostStartBlock('pad-lc'), false, 'no double-injection');
    });
  });

  it('generateInstanceCompose mounts /build when lifecycle scripts exist', () => {
    withTmp((TMP, vm) => {
      const instDir = path.join(TMP, 'instances', 'pad-lc');
      fs.mkdirSync(instDir, { recursive: true });
      fs.writeFileSync(path.join(instDir, 'meta.env'), 'AGENT=opencode\nROOT_PASSWORD=pw\n');
      // No scripts → no /build mount.
      let compose = JSON.parse(vm.generateInstanceCompose('pad-lc', 'opencode', 'pw', ''));
      const volStr = JSON.stringify(compose.services['pad-lc'].volumes || []);
      assert.ok(!volStr.includes('/build'), 'no /build mount without lifecycle scripts');

      vm.writePostCreateScript('pad-lc', 'echo hi');
      compose = JSON.parse(vm.generateInstanceCompose('pad-lc', 'opencode', 'pw', ''));
      const volStr2 = JSON.stringify(compose.services['pad-lc'].volumes || []);
      assert.ok(volStr2.includes('/build'), '/build mount present with a lifecycle script');
    });
  });
});

describe('vm-manager - devcontainer plan (plan 41 items 12-16)', () => {
  // Guard suite is ON here (GUARD_* unset by the test invocation), and /tmp is
  // a system dir — use /var/padtest-* so workspaces + their devcontainer mounts
  // pass the system-dir guards.
  function withTmp(fn) {
    const TMP = '/var/padtest-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
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

  function makeWorkspace(TMP, extra) {
    const ws = path.join(TMP, 'ws');
    fs.mkdirSync(path.join(ws, '.devcontainer'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.devcontainer', 'devcontainer.json'), JSON.stringify({
      name: 'test',
      workspaceFolder: '/workspace',
      environment: { FOO: 'bar', ROOT_PASSWORD: 'evil' },
      mounts: [{ source: './api', target: '/api', readOnly: true }],
      runArgs: ['--cap-add=SYS_PTRACE', '--sysctl', 'net.core.somaxconn=511', '--ulimit=nofile=1024:2048'],
      forwardPorts: [45678],
      ...extra,
    }));
    return ws;
  }

  it('readDevContainerPlan returns null when no plan was persisted', () => {
    withTmp((TMP, vm) => {
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');
      assert.strictEqual(vm.readDevContainerPlan('pad-dc'), null);
    });
  });

  it('resolveDevContainerPlan honors workspaceFolder/env/mounts/runArgs/forwardPorts', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP);
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      const plan = vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: true });

      assert.strictEqual(plan.workspaceFolder, '/workspace', 'workspaceFolder honored (editable driver, default target)');
      assert.deepStrictEqual(plan.environment, { FOO: 'bar' }, 'protected env keys dropped');
      assert.strictEqual(plan.volumes.length, 1);
      assert.strictEqual(plan.volumes[0].host, path.join(ws, 'api'));
      assert.strictEqual(plan.volumes[0].container, '/api');
      assert.strictEqual(plan.volumes[0].readonly, true);
      assert.deepStrictEqual(plan.runArgs.caps, ['SYS_PTRACE']);
      assert.deepStrictEqual(plan.runArgs.sysctls, { 'net.core.somaxconn': '511' });
      assert.deepStrictEqual(plan.runArgs.ulimits, { nofile: { soft: 1024, hard: 2048 } });
      assert.strictEqual(plan.ports.length, 1);
      assert.strictEqual(plan.ports[0].container, '45678');
      assert.strictEqual(plan.ports[0].host, '45678', 'free container port reused');
      assert.strictEqual(plan.ports[0].protocol, 'tcp');
      assert.strictEqual(plan.ports[0].label, '');
    });
  });

  it('does NOT honor workspaceFolder for a custom (non-default) mount target or non-editable drivers', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP);
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');
      const custom = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/custom/ws');
      assert.strictEqual(vm.resolveDevContainerPlan('pad-dc', 'opencode', custom, { allocatePorts: false }).workspaceFolder, '', 'custom target wins over workspaceFolder');

      // openclaw has a fixed workspace — workspaceFolder is never honored.
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=openclaw\n');
      const fixed = vm.validateWorkspaceMount('pad-dc', 'openclaw', ws, '/root/.openclaw/workspace');
      assert.strictEqual(vm.resolveDevContainerPlan('pad-dc', 'openclaw', fixed, { allocatePorts: false }).workspaceFolder, '');
    });
  });

  it('rejects a mount that reaches project internals outside the workspace', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP, { mounts: [{ source: '../secrets', target: '/secrets' }] });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      assert.throws(() => vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: false }), /project internals/);
    });
  });

  it('allows a mount source outside the project root', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP, { mounts: [{ source: '/srv/padtest', target: '/data' }] });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      const plan = vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: false });
      assert.deepStrictEqual(plan.volumes, [{ host: '/srv/padtest', container: '/data', readonly: false }]);
    });
  });

  it('rejects unsupported runArgs', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP, { runArgs: ['--privileged'] });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      assert.throws(() => vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: false }), /Unsupported devcontainer runArg/);
    });
  });

  it('captures remoteUser/containerUser as the pad user-mode preference (item 17)', () => {
    withTmp((TMP, vm) => {
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');

      // Non-root remoteUser → the pad should run as the pad user.
      const ws1 = makeWorkspace(TMP, { remoteUser: 'node' });
      const m1 = vm.validateWorkspaceMount('pad-dc', 'opencode', ws1, '/root/.opencode/workspace');
      const p1 = vm.resolveDevContainerPlan('pad-dc', 'opencode', m1, { allocatePorts: false });
      assert.strictEqual(p1.remoteUser, 'node');
      assert.strictEqual(p1.userMode, 'user', 'non-root remoteUser → user mode');

      // containerUser wins over remoteUser (spec precedence).
      const ws2 = makeWorkspace(TMP, { containerUser: '1000', remoteUser: 'root' });
      const m2 = vm.validateWorkspaceMount('pad-dc', 'opencode', ws2, '/root/.opencode/workspace');
      const p2 = vm.resolveDevContainerPlan('pad-dc', 'opencode', m2, { allocatePorts: false });
      assert.strictEqual(p2.containerUser, '1000');
      assert.strictEqual(p2.userMode, 'user', 'containerUser wins over remoteUser');

      // Explicit root → root mode.
      const ws3 = makeWorkspace(TMP, { containerUser: 'root' });
      const m3 = vm.validateWorkspaceMount('pad-dc', 'opencode', ws3, '/root/.opencode/workspace');
      const p3 = vm.resolveDevContainerPlan('pad-dc', 'opencode', m3, { allocatePorts: false });
      assert.strictEqual(p3.userMode, 'root', 'explicit root containerUser → root mode');

      // No user declared → no preference.
      const ws4 = makeWorkspace(TMP);
      const m4 = vm.validateWorkspaceMount('pad-dc', 'opencode', ws4, '/root/.opencode/workspace');
      const p4 = vm.resolveDevContainerPlan('pad-dc', 'opencode', m4, { allocatePorts: false });
      assert.strictEqual(p4.userMode, '', 'no user declared → no preference');
    });
  });

  it('effectiveUserMode: explicit toggle wins; plan preference seeds the default; hermes stays root', () => {
    withTmp((TMP, vm) => {
      const plan = { userMode: 'user' };
      // Explicit caller value always wins (web form toggle / MCP arg).
      assert.strictEqual(vm.effectiveUserMode('user', plan, 'opencode'), 'user');
      assert.strictEqual(vm.effectiveUserMode('', plan, 'opencode'), '', 'explicit root wins over plan preference');
      assert.strictEqual(vm.effectiveUserMode('root', plan, 'opencode'), '', 'MCP root arg wins');
      // Omitted → plan preference seeds the default.
      assert.strictEqual(vm.effectiveUserMode(undefined, plan, 'opencode'), 'user');
      assert.strictEqual(vm.effectiveUserMode(undefined, { userMode: '' }, 'opencode'), '', 'no plan preference → root');
      // hermes is always root-mode.
      assert.strictEqual(vm.effectiveUserMode(undefined, plan, 'hermes'), '', 'hermes ignores the plan preference');
      assert.strictEqual(vm.effectiveUserMode('user', plan, 'hermes'), 'user', 'explicit hermes user mode still passes through (guard is at validation)');
    });
  });

  it('generates a .devcontainer mirror at create time when the workspace has none (item 18)', () => {
    withTmp((TMP, vm) => {
      const ws = path.join(TMP, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nUSER_MODE=user\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      const extraVols = vm.validateExtraVolumes('pad-dc', 'opencode', [{ host: path.join(ws, 'data'), container: '/data' }]);
      const extraPs = vm.validateExtraPorts([{ host: 4300, container: 4300 }], { sshPort: '' });

      const target = vm.generateWorkspaceDevContainer('pad-dc', 'opencode', wsMount, {
        postCreate: 'npm install',
        postStart: 'started',
        postAttach: 'attached',
        extraVols, extraPs,
        userMode: 'user',
      });
      assert.strictEqual(target, path.join(ws, '.devcontainer', 'devcontainer.json'));
      const doc = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.strictEqual(doc['x-paddock'].generated, true, 'marked as generated');
      assert.strictEqual(doc.workspaceFolder, '/root/.opencode/workspace');
      assert.strictEqual(doc.postCreateCommand, 'npm install');
      assert.strictEqual(doc.postStartCommand, 'started');
      assert.strictEqual(doc.postAttachCommand, 'attached');
      assert.deepStrictEqual(doc.mounts, [`${path.join(ws, 'data')}:/data`]);
      assert.deepStrictEqual(doc.forwardPorts, ['4300']);
      assert.strictEqual(doc.remoteUser, 'pad', 'user-mode pad → remoteUser pad');
    });
  });

  it('generation skips when disabled, a devcontainer exists, no workspace, or missing dir', () => {
    withTmp((TMP, vm) => {
      const ws = path.join(TMP, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');

      assert.strictEqual(vm.generateWorkspaceDevContainer('pad-dc', 'opencode', wsMount, { enabled: false }), null, 'disabled → nothing written');
      assert.ok(!fs.existsSync(path.join(ws, '.devcontainer')), 'no file created when disabled');

      makeWorkspace(TMP);
      assert.strictEqual(vm.generateWorkspaceDevContainer('pad-dc', 'opencode', wsMount, {}), null, 'workspace already has a devcontainer → skip');

      assert.strictEqual(vm.generateWorkspaceDevContainer('pad-dc', 'opencode', null, {}), null, 'no workspace mount → null');

      const ghost = vm.validateWorkspaceMount('pad-dc', 'opencode', path.join(TMP, 'nope'), '/root/.opencode/workspace');
      assert.strictEqual(vm.generateWorkspaceDevContainer('pad-dc', 'opencode', ghost, {}), null, 'missing workspace dir → null');
    });
  });

  it('syncDevContainer regenerates a generated mirror wholesale after pad changes (item 19)', () => {
    withTmp((TMP, vm) => {
      const ws = path.join(TMP, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nUSER_MODE=user\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      vm.generateWorkspaceDevContainer('pad-dc', 'opencode', wsMount, { postCreate: 'echo first', userMode: 'user' });
      const dcFile = path.join(ws, '.devcontainer', 'devcontainer.json');

      // Pad changes: edited lifecycle commands + a new extra volume and port.
      vm.writePostCreateScript('pad-dc', 'echo updated');
      vm.writePostStartScript('pad-dc', 'started now');
      const extraVols = vm.validateExtraVolumes('pad-dc', 'opencode', [{ host: path.join(ws, 'data'), container: '/data', readonly: true }]);
      const extraPs = vm.validateExtraPorts([{ host: 4300, container: 4300 }], { sshPort: '' });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nUSER_MODE=user\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\nEXTRA_VOLUMES=${JSON.stringify(extraVols)}\nEXTRA_PORTS=${JSON.stringify(extraPs)}\n`);

      const synced = vm.syncDevContainer('pad-dc', 'opencode', wsMount);
      assert.strictEqual(synced, dcFile);
      const doc = JSON.parse(fs.readFileSync(dcFile, 'utf8'));
      assert.strictEqual(doc['x-paddock'].generated, true);
      assert.strictEqual(doc.postCreateCommand, 'echo updated', 'edited lifecycle command written back');
      assert.strictEqual(doc.postStartCommand, 'started now');
      assert.strictEqual(doc.postAttachCommand, undefined, 'cleared post-attach removed on regen');
      assert.deepStrictEqual(doc.mounts, [`${path.join(ws, 'data')}:/data:ro`]);
      assert.deepStrictEqual(doc.forwardPorts, ['4300']);
      assert.strictEqual(doc.remoteUser, 'pad', 'user-mode pad → remoteUser pad');
    });
  });

  it('syncDevContainer updates mapped fields on a project-authored file and preserves the rest', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP, {
        name: 'project',
        features: { 'ghcr.io/devcontainers/features/node:1': {} },
        postCreateCommand: 'echo original',
      });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      const plan = vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: false });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\nDC_PLAN=${JSON.stringify(plan)}\n`);
      const dcFile = path.join(ws, '.devcontainer', 'devcontainer.json');

      // Pad changes: edited post-create + a new extra volume and port.
      vm.writePostCreateScript('pad-dc', 'npm ci');
      const extraVols = vm.validateExtraVolumes('pad-dc', 'opencode', [{ host: path.join(ws, 'data'), container: '/data' }]);
      const extraPs = vm.validateExtraPorts([{ host: 4301, container: 4301 }], { sshPort: '' });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\nDC_PLAN=${JSON.stringify(plan)}\nEXTRA_VOLUMES=${JSON.stringify(extraVols)}\nEXTRA_PORTS=${JSON.stringify(extraPs)}\n`);

      vm.syncDevContainer('pad-dc', 'opencode', wsMount);
      const doc = JSON.parse(fs.readFileSync(dcFile, 'utf8'));
      assert.strictEqual(doc.postCreateCommand, 'npm ci', 'edited lifecycle command written back');
      assert.strictEqual(doc.name, 'project', 'non-mapped field preserved');
      assert.deepStrictEqual(doc.features, { 'ghcr.io/devcontainers/features/node:1': {} }, 'features preserved');
      assert.strictEqual(doc.workspaceFolder, '/workspace', 'declared workspaceFolder kept (identity)');
      assert.strictEqual(doc['x-paddock'], undefined, 'not marked generated');
      assert.ok(doc.mounts.some((m) => m.endsWith('data:/data')), 'pad extra volume appended to mounts');
      assert.ok(doc.forwardPorts.includes('4301'), 'pad extra port appended to forwardPorts');
      assert.strictEqual(doc.environment.FOO, 'bar', 'devcontainer-originated env preserved');

      // Clearing the pad's post-create removes the mapped field.
      vm.writePostCreateScript('pad-dc', '');
      vm.syncDevContainer('pad-dc', 'opencode', wsMount);
      const doc2 = JSON.parse(fs.readFileSync(dcFile, 'utf8'));
      assert.strictEqual(doc2.postCreateCommand, undefined, 'cleared lifecycle command removed from the mirror');
    });
  });

  it('syncDevContainer leaves a devcontainer the pad never adopted untouched', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP);
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      const dcFile = path.join(ws, '.devcontainer', 'devcontainer.json');
      const before = fs.readFileSync(dcFile, 'utf8');
      assert.strictEqual(vm.syncDevContainer('pad-dc', 'opencode', wsMount), null, 'no DC_PLAN + not generated → skip');
      assert.strictEqual(fs.readFileSync(dcFile, 'utf8'), before, 'file untouched');
    });
  });

  it('devContainerStatus reports the card state for a generated / project-authored / missing file (item 20)', () => {
    withTmp((TMP, vm) => {
      const ws = path.join(TMP, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nUSER_MODE=user\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');

      // Missing: no devcontainer in the workspace yet.
      let st = vm.devContainerStatus('pad-dc');
      assert.strictEqual(st.state, 'missing');
      assert.strictEqual(st.found, false);
      assert.strictEqual(st.regenerate, true, 'regenerate is always available');
      assert.strictEqual(st.sync, false, 'nothing to sync when missing');
      assert.ok(st.target.includes('"workspaceFolder": "/root/.opencode/workspace"'), 'target shows what would be written');
      assert.strictEqual(st.content, '', 'no current content when missing');

      // Generated: mirror written → state flips, sync becomes available. The
      // post-create script is persisted first — generation options are
      // transient, so the status target (from the pad's stored config) only
      // matches after the script exists, exactly as in the real create flow.
      vm.writePostCreateScript('pad-dc', 'npm install');
      vm.generateWorkspaceDevContainer('pad-dc', 'opencode', wsMount, { postCreate: 'npm install', userMode: 'user' });
      st = vm.devContainerStatus('pad-dc');
      assert.strictEqual(st.state, 'generated');
      assert.strictEqual(st.generated, true);
      assert.strictEqual(st.found, true);
      assert.strictEqual(st.filePath, path.join(ws, '.devcontainer', 'devcontainer.json'));
      assert.strictEqual(st.sync, true, 'a generated file can be re-synced');
      assert.ok(st.content.includes('"postCreateCommand": "npm install"'));
      assert.strictEqual(st.content, st.target, 'generated file already matches the pad — diff is empty');

      // Pad edits a lifecycle command → target diverges from current content.
      vm.writePostCreateScript('pad-dc', 'npm ci');
      st = vm.devContainerStatus('pad-dc');
      assert.ok(st.content.includes('npm install'), 'current file still has the old command');
      assert.ok(st.target.includes('npm ci'), 'target reflects the pad now');
      assert.notStrictEqual(st.content, st.target);
    });
  });

  it('devContainerStatus flags project-authored files and only syncs adopted ones', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP, { name: 'project' });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');
      const dcFile = path.join(ws, '.devcontainer', 'devcontainer.json');

      // Not adopted (no DC_PLAN): project-authored + sync disabled.
      let st = vm.devContainerStatus('pad-dc');
      assert.strictEqual(st.state, 'project-authored');
      assert.strictEqual(st.sync, false, 'pad never adopted it → no sync');
      assert.strictEqual(st.regenerate, true, 'regenerate still available (explicit clobber)');
      assert.ok(st.content.includes('"name":"project"'), 'current content is the project file');
      assert.ok(st.target.includes('"workspaceFolder": "/root/.opencode/workspace"'), 'target is the pad mirror');

      // Adopt it via a persisted plan → sync becomes available.
      const plan = vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: false });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\nDC_PLAN=${JSON.stringify(plan)}\n`);
      st = vm.devContainerStatus('pad-dc');
      assert.strictEqual(st.state, 'project-authored');
      assert.strictEqual(st.sync, true, 'adopted project file is syncable');
      assert.strictEqual(st.filePath, dcFile);
    });
  });

  it('devContainerStatus is missing when the pad has no custom workspace or no instance dir', () => {
    withTmp((TMP, vm) => {
      const ws = path.join(TMP, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');

      let st = vm.devContainerStatus('pad-dc');
      assert.strictEqual(st.state, 'missing');
      assert.strictEqual(st.workspacePath, '', 'no workspace mount → no path');
      assert.strictEqual(st.regenerate, true, 'button stays enabled but no-ops without a workspace');
      assert.strictEqual(vm.devContainerStatus('pad-ghost'), null, 'unknown instance → null');
    });
  });

  it('regenerateDevContainer creates or rewrites the mirror wholesale (item 20)', () => {
    withTmp((TMP, vm) => {
      const ws = path.join(TMP, 'ws');
      fs.mkdirSync(ws, { recursive: true });
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nUSER_MODE=user\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');

      // Creates the file when missing.
      const created = vm.regenerateDevContainer('pad-dc', 'opencode');
      assert.strictEqual(created, path.join(ws, '.devcontainer', 'devcontainer.json'));
      let doc = JSON.parse(fs.readFileSync(created, 'utf8'));
      assert.strictEqual(doc['x-paddock'].generated, true);
      assert.strictEqual(doc.workspaceFolder, '/root/.opencode/workspace');
      assert.strictEqual(doc.remoteUser, 'pad');

      // Rewrites a project-authored file wholesale (explicit user action).
      const projectWs = path.join(TMP, 'ws2');
      fs.mkdirSync(path.join(projectWs, '.devcontainer'), { recursive: true });
      fs.writeFileSync(path.join(projectWs, '.devcontainer', 'devcontainer.json'), JSON.stringify({
        name: 'keepme',
        features: { x: {} },
        workspaceFolder: '/workspace',
      }));
      const projectMount = vm.validateWorkspaceMount('pad-dc', 'opencode', projectWs, '/root/.opencode/workspace');
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nUSER_MODE=user\nWORKSPACE_HOST=${projectWs}\nWORKSPACE_DIR=/root/.opencode/workspace\n`);
      const rewritten = vm.regenerateDevContainer('pad-dc', 'opencode');
      assert.strictEqual(rewritten, path.join(projectWs, '.devcontainer', 'devcontainer.json'));
      doc = JSON.parse(fs.readFileSync(rewritten, 'utf8'));
      assert.strictEqual(doc.name, 'Paddock agent workspace', 'custom name replaced');
      assert.strictEqual(doc['x-paddock'].generated, true);
      assert.strictEqual(doc.features, undefined, 'custom features clobbered');
      assert.strictEqual(doc.workspaceFolder, '/root/.opencode/workspace', 'pad workspaceFolder used');
      assert.strictEqual(projectMount.host, projectWs, 'sanity: mounts differ between the two workspaces');
    });
  });

  it('devcontainer flow works for every custom-workspace agent type (fixed + editable)', () => {
    const types = ['openclaw', 'picoclaw', 'opencode', 'codex', 'claude'];
    const { getDriver } = require('../services/drivers');
    withTmp((TMP, vm) => {
      for (const agent of types) {
        const dir = getDriver(agent).workspaceDir;
        const ws = path.join(TMP, `ws-${agent}`);
        fs.mkdirSync(ws, { recursive: true });
        fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
        fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
          `AGENT=${agent}\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=${dir}\n`);
        const wsMount = vm.validateWorkspaceMount('pad-dc', agent, ws, dir);
        assert.strictEqual(wsMount.container, dir, `${agent}: mount resolves the driver's workspace path`);

        // Missing → regenerate creates the mirror with the driver's folder.
        let st = vm.devContainerStatus('pad-dc');
        assert.strictEqual(st.state, 'missing', `${agent}: no devcontainer yet`);
        assert.strictEqual(st.workspacePath, ws, `${agent}: workspace resolved`);
        const created = vm.regenerateDevContainer('pad-dc', agent);
        assert.strictEqual(created, path.join(ws, '.devcontainer', 'devcontainer.json'), `${agent}: mirror created`);
        let doc = JSON.parse(fs.readFileSync(created, 'utf8'));
        assert.strictEqual(doc['x-paddock'].generated, true, `${agent}: marked generated`);
        assert.strictEqual(doc.workspaceFolder, dir, `${agent}: workspaceFolder = driver workspaceDir`);

        // Pad change → sync writes back.
        vm.writePostCreateScript('pad-dc', `echo ${agent}`);
        st = vm.devContainerStatus('pad-dc');
        assert.strictEqual(st.state, 'generated', `${agent}: generated state`);
        assert.ok(st.target.includes(`echo ${agent}`), `${agent}: target reflects the pad now`);
        const synced = vm.syncDevContainer('pad-dc', agent, wsMount);
        assert.strictEqual(synced, created, `${agent}: sync wrote the file`);
        doc = JSON.parse(fs.readFileSync(created, 'utf8'));
        assert.strictEqual(doc.postCreateCommand, `echo ${agent}`, `${agent}: lifecycle command written back`);

        fs.rmSync(path.join(ws, '.devcontainer'), { recursive: true, force: true });
      }
    });
  });

  it('hermes (workspaceCapability none) degrades gracefully — no workspace, no mirror', () => {
    withTmp((TMP, vm) => {
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=hermes\n');

      const st = vm.devContainerStatus('pad-dc');
      assert.strictEqual(st.state, 'missing', 'no custom workspace');
      assert.strictEqual(st.workspacePath, '', 'hermes has no workspace mount at all');
      assert.strictEqual(st.filePath, '');
      assert.strictEqual(st.sync, false, 'nothing to sync');
      assert.strictEqual(vm.regenerateDevContainer('pad-dc', 'hermes'), null, 'regenerate no-ops');
      assert.strictEqual(vm.syncDevContainer('pad-dc', 'hermes', null), null, 'sync no-ops');
    });
  });

  it('persisted forwardPorts keep their allocated host port across re-resolves; taken ports get a fresh one', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP);
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), 'AGENT=opencode\n');
      const wsMount = vm.validateWorkspaceMount('pad-dc', 'opencode', ws, '/root/.opencode/workspace');

      // Another agent publishes host 45678 → the forwardPort cannot reuse it.
      const other = path.join(TMP, 'instances', 'pad-other');
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, 'docker-compose.yml'), '{"services":{"pad-other":{"ports":["45678:80"]}}}');
      const plan = vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: true });
      assert.notStrictEqual(plan.ports[0].host, '45678', 'conflicting container port gets a fresh host port');

      // Persist the plan, drop the competitor → re-resolve keeps the mapping.
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'), `AGENT=opencode\nDC_PLAN=${JSON.stringify(plan)}\n`);
      fs.rmSync(other, { recursive: true, force: true });
      const plan2 = vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: true });
      assert.strictEqual(plan2.ports[0].host, plan.ports[0].host, 'previously allocated host port is kept');

      // Validation passes skip allocation entirely.
      const plan3 = vm.resolveDevContainerPlan('pad-dc', 'opencode', wsMount, { allocatePorts: false });
      assert.strictEqual(plan3.ports[0].host, '45678', 'validation pass leaves the container port untouched');
    });
  });

  it('generateInstanceCompose applies the persisted plan (folder/env/mounts/runArgs/ports)', () => {
    withTmp((TMP, vm) => {
      const ws = makeWorkspace(TMP);
      fs.mkdirSync(path.join(TMP, 'instances', 'pad-dc'), { recursive: true });
      const plan = {
        filePath: path.join(ws, '.devcontainer', 'devcontainer.json'),
        hasDevContainer: true,
        workspaceFolder: '/workspace',
        environment: { FOO: 'bar' },
        volumes: [{ host: path.join(ws, 'api'), container: '/api', readonly: true }],
        runArgs: { caps: ['SYS_PTRACE'], ulimits: { nofile: { soft: 1024, hard: 2048 } }, sysctls: { 'net.core.somaxconn': '511' }, envFiles: [] },
        ports: [{ container: '4200', host: '4200', protocol: 'tcp', label: 'App' }],
      };
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nROOT_PASSWORD=pw\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/root/.opencode/workspace\nDC_PLAN=${JSON.stringify(plan)}\n`);

      const compose = JSON.parse(vm.generateInstanceCompose('pad-dc', 'opencode', 'pw', '22001'));
      const svc = compose.services['pad-dc'];
      assert.ok(svc.volumes.some((v) => v === `${ws}:/workspace`), 'workspaceFolder overrides the mount target');
      assert.strictEqual(svc.working_dir, '/workspace');
      assert.ok(svc.volumes.some((v) => v === `${path.join(ws, 'api')}:/api:ro`), 'devcontainer mount emitted');
      assert.deepStrictEqual(svc.ports, ['22001:22', '4200:4200/tcp'], 'forwardPort published alongside SSH');
      assert.strictEqual(svc.environment.FOO, 'bar', 'devcontainer env merged');
      assert.strictEqual(svc.environment.ROOT_PASSWORD, 'pw', 'internal env not clobbered');
      assert.deepStrictEqual(svc.cap_add, ['SYS_PTRACE']);
      assert.deepStrictEqual(svc.ulimits, { nofile: { soft: 1024, hard: 2048 } });
      assert.deepStrictEqual(svc.sysctls, { 'net.core.somaxconn': '511' });

      // Stored WORKSPACE_DIR ≠ driver default → the plan's folder is ignored.
      fs.writeFileSync(path.join(TMP, 'instances', 'pad-dc', 'meta.env'),
        `AGENT=opencode\nROOT_PASSWORD=pw\nWORKSPACE_HOST=${ws}\nWORKSPACE_DIR=/custom/ws\nDC_PLAN=${JSON.stringify(plan)}\n`);
      const compose2 = JSON.parse(vm.generateInstanceCompose('pad-dc', 'opencode', 'pw', ''));
      const svc2 = compose2.services['pad-dc'];
      assert.strictEqual(svc2.working_dir, '/custom/ws', 'custom target wins');
      assert.ok(!svc2.volumes.some((v) => v.endsWith(':/workspace')), 'no /workspace override when custom target set');

      // ForwardPorts ride the socat door in peer mode (TCP only).
      const doorCompose = JSON.parse(vm.generateInstanceCompose('pad-dc', 'opencode', 'pw', '22001', { network: 'gluetun-global' }));
      const door = doorCompose.services['pad-dc-door'];
      assert.ok(door, 'door present in peer mode');
      assert.ok(door.entrypoint.join(' ').includes('TCP-LISTEN:4200'), 'forwardPort forwarded through the door');
    });
  });
});
