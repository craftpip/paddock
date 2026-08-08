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
      assert.ok(yaml.includes('"/shared-ws:/codex-ws"'), 'custom workspace bind emitted (whole spec quoted)');
      assert.ok(yaml.includes('working_dir: "/codex-ws"'), 'container starts inside the custom workspace');
      assert.ok(yaml.includes(`- ${TMP}/instances/pad-ws/codex:/root/.codex`), 'data dir bind intact');
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
