/**
 * Plan 41 — the two build boxes and the devcontainer mirror.
 *
 * Plan 41's items 1–37 were built long before this suite existed; what was
 * missing was a direct, behaviour-level test of the parts a user actually
 * touches:
 *
 *   - the "Build commands" block injected into the instance Dockerfile
 *     (`instance-image.readCustomBuild` / `writeCustomBuild`),
 *   - the "Post-create commands" script (`vm-manager.writePostCreateScript`),
 *   - the `.devcontainer/devcontainer.json` parser, generator and write-back
 *     (`services/devcontainer`).
 *
 * The devcontainer module had NO unit test of its own at all — its parsing
 * (spec file precedence, the three command shapes) was only ever exercised
 * through vm-manager's plan resolution, so a parser regression could hide
 * behind a passing integration test.
 *
 * These are pure-filesystem tests: no container, no docker, no database.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-plan41-'));
process.env.WORKSPACE_ROOT = WS;
process.env.HOST_WORKSPACE_ROOT = WS;
process.on('exit', () => {
  fs.rmSync(WS, { recursive: true, force: true });
});

const instanceImage = require('../services/instance-image');
const devcontainer = require('../services/devcontainer');

/** A minimal instance Dockerfile shaped like a driver template: the block is
 *  injected right before the ENTRYPOINT banner every template shares. */
const DOCKERFILE = [
  'FROM node:20-slim',
  'ARG NODE_VERSION=20',
  'RUN apt-get update',
  '# ---- 10. ENTRYPOINT -------------------',
  'ENTRYPOINT ["/usr/local/bin/start.sh"]',
  '',
].join('\n');

/** Seed an instance's build dir with a Dockerfile and return the instance name. */
function seedInstance(name = 'pad-41') {
  const dir = path.join(WS, 'instances', name, 'build');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
  return name;
}

describe('plan 41 — the "Build commands" Dockerfile block', () => {
  it('inserts the block before the ENTRYPOINT banner and reads it back', () => {
    const name = seedInstance();
    const out = instanceImage.writeCustomBuild(name, 'RUN apt-get install -y vim');

    assert.ok(out.includes(instanceImage.BUILD_BLOCK_HEAD), 'head marker written');
    assert.ok(out.includes(instanceImage.BUILD_BLOCK_TAIL), 'tail marker written');
    assert.ok(out.includes('RUN apt-get install -y vim'), 'the user text is in the block');
    assert.ok(
      out.indexOf(instanceImage.BUILD_BLOCK_HEAD) < out.indexOf('ENTRYPOINT'),
      'the block lands BEFORE the entrypoint banner, so it is part of the build stage'
    );
    assert.strictEqual(instanceImage.readCustomBuild(name), 'RUN apt-get install -y vim');
    // The file on disk is what the reader reads — no in-memory fiction.
    const onDisk = fs.readFileSync(instanceImage.dockerfilePath(name), 'utf8');
    assert.ok(onDisk.includes('RUN apt-get install -y vim'), 'the text is really in the Dockerfile');
  });

  it('replaces the block contents instead of stacking a second block', () => {
    const name = seedInstance();
    instanceImage.writeCustomBuild(name, 'RUN echo first');
    const out = instanceImage.writeCustomBuild(name, 'RUN echo second');

    assert.strictEqual(out.split(instanceImage.BUILD_BLOCK_HEAD).length - 1, 1, 'exactly one head marker');
    assert.strictEqual(out.split(instanceImage.BUILD_BLOCK_TAIL).length - 1, 1, 'exactly one tail marker');
    assert.ok(!out.includes('RUN echo first'), 'the previous text is gone');
    assert.ok(out.includes('RUN echo second'), 'the new text is in place');
    assert.strictEqual(instanceImage.readCustomBuild(name), 'RUN echo second');
  });

  it('an empty text removes the block and leaves the rest of the Dockerfile alone', () => {
    const name = seedInstance();
    instanceImage.writeCustomBuild(name, 'RUN echo gone');
    const out = instanceImage.writeCustomBuild(name, '');

    assert.ok(!out.includes(instanceImage.BUILD_BLOCK_HEAD), 'head marker removed');
    assert.ok(!out.includes(instanceImage.BUILD_BLOCK_TAIL), 'tail marker removed');
    assert.ok(!out.includes('RUN echo gone'), 'the text is gone');
    assert.ok(out.includes('FROM node:20-slim'), 'the rest of the Dockerfile survived');
    assert.ok(out.includes('ENTRYPOINT ["/usr/local/bin/start.sh"]'), 'the entrypoint survived');
    assert.strictEqual(instanceImage.readCustomBuild(name), '', 'nothing left to read');
  });

  it('an ARG inside the block is picked up by the compose build args', () => {
    const name = seedInstance();
    instanceImage.writeCustomBuild(name, 'ARG EXTRA_VERSION=1.2.3\nRUN echo hi');
    const args = instanceImage.argsFromDockerfile(instanceImage.dockerfilePath(name));
    const names = args.map((a) => a.name);
    assert.ok(names.includes('EXTRA_VERSION'), 'the custom ARG is visible to the compose generator');
    const extra = args.find((a) => a.name === 'EXTRA_VERSION');
    assert.strictEqual(extra.default, '1.2.3', 'and it carries its default');
  });

  it('readCustomBuild returns empty for an instance with no block (and no Dockerfile)', () => {
    const name = seedInstance();
    assert.strictEqual(instanceImage.readCustomBuild(name), '', 'no block → empty text');
    assert.strictEqual(instanceImage.readCustomBuild('pad-41-absent'), '', 'no Dockerfile → empty text');
  });

  it('writeCustomBuild refuses to invent a Dockerfile for an instance that has none', () => {
    assert.throws(
      () => instanceImage.writeCustomBuild('pad-41-absent', 'RUN echo hi'),
      /No Dockerfile for pad-41-absent/,
      'a build dir that was never seeded is an error, not a silent empty file'
    );
  });
});

describe('plan 41 — the "Post-create commands" script', () => {
  /** vm-manager computes its instance dir at load time, so each case gets a
   *  fresh module with WORKSPACE_ROOT pointed at its own tmp dir. */
  function withTmp(fn) {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-plan41-lc-'));
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

  it('writes an executable script and reads it back without the shebang', () => {
    withTmp((TMP, vm) => {
      const p = vm.postCreateScriptPath('pad-lc');
      assert.ok(!fs.existsSync(p), 'nothing there before the first write');
      vm.writePostCreateScript('pad-lc', 'echo hello\nnpm install');
      assert.ok(fs.readFileSync(p, 'utf8').includes('npm install'), 'the body is on disk');
      assert.strictEqual(fs.statSync(p).mode & 0o111, 0o111, 'the script is executable');
      assert.strictEqual(vm.readPostCreate('pad-lc'), 'echo hello\nnpm install', 'the reader strips the shebang');
    });
  });

  it('an empty text removes the script', () => {
    withTmp((TMP, vm) => {
      const p = vm.postCreateScriptPath('pad-lc');
      vm.writePostCreateScript('pad-lc', 'echo hello');
      assert.ok(fs.existsSync(p));
      vm.writePostCreateScript('pad-lc', '');
      assert.ok(!fs.existsSync(p), 'empty write removes the file');
      assert.strictEqual(vm.readPostCreate('pad-lc'), '');
    });
  });
});

describe('plan 41 — the devcontainer.json mirror', () => {
  /** A workspace dir with no devcontainer in it. */
  function ws() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pad-plan41-dc-'));
  }

  function write(file, doc) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
    return file;
  }

  it('finds the devcontainer by the spec precedence (root .devcontainer.json wins)', () => {
    const dir = ws();
    const nested = write(path.join(dir, '.devcontainer', 'sub', 'devcontainer.json'), { name: 'nested' });
    const main = write(path.join(dir, '.devcontainer', 'devcontainer.json'), { name: 'main' });
    const root = write(path.join(dir, '.devcontainer.json'), { name: 'root' });

    assert.strictEqual(devcontainer.findDevContainerFile(dir), root, 'the root file has the highest precedence');
    fs.rmSync(root);
    assert.strictEqual(devcontainer.findDevContainerFile(dir), main, 'then .devcontainer/devcontainer.json');
    fs.rmSync(main);
    assert.strictEqual(devcontainer.findDevContainerFile(dir), nested, 'then a .devcontainer/<folder>/ file');
    fs.rmSync(nested);
    assert.strictEqual(devcontainer.findDevContainerFile(dir), null, 'no file → null');
    assert.strictEqual(devcontainer.hasDevContainer(dir), false, 'and hasDevContainer agrees');
  });

  it('joins the three command shapes the spec allows', () => {
    assert.strictEqual(devcontainer.joinCommand('npm install'), 'npm install');
    assert.strictEqual(devcontainer.joinCommand(['npm ci', 'npm run build']), 'npm ci\nnpm run build');
    assert.strictEqual(devcontainer.joinCommand({ deps: 'npm ci', build: 'npm run build' }), 'npm ci\nnpm run build');
    assert.strictEqual(devcontainer.joinCommand(undefined), '', 'no command → empty');
    assert.strictEqual(devcontainer.joinCommand(42), '', 'an unknown shape → empty, not a crash');
  });

  it('parses every lifecycle command out of the file, in whichever shape it was written', () => {
    const dir = ws();
    const file = write(path.join(dir, '.devcontainer', 'devcontainer.json'), {
      name: 'proj',
      postCreateCommand: 'npm ci',
      onCreateCommand: ['echo on', 'echo create'],
      updateContentCommand: { deps: 'npm ci' },
      postStartCommand: 'echo start',
      postAttachCommand: ['echo attach'],
      workspaceFolder: '/app',
      environment: { FOO: 'bar' },
      mounts: ['/host:/app:ro', { source: '/h2', target: '/t2', readOnly: true }],
      runArgs: ['--cap-add=SYS_PTRACE'],
      forwardPorts: [4200],
      portsAttributes: { '4200': { label: 'app' } },
      remoteUser: 'node',
    });

    const parsed = devcontainer.parseDevContainer(file);
    assert.ok(parsed, 'the file parses');
    assert.strictEqual(parsed.name, 'proj');
    assert.strictEqual(parsed.postCreateCommand, 'npm ci');
    assert.strictEqual(parsed.onCreateCommand, 'echo on\necho create');
    assert.strictEqual(parsed.updateContentCommand, 'npm ci');
    assert.strictEqual(parsed.postStartCommand, 'echo start');
    assert.strictEqual(parsed.postAttachCommand, 'echo attach');
    assert.strictEqual(parsed.workspaceFolder, '/app');
    assert.strictEqual(parsed.environment.FOO, 'bar');
    assert.deepStrictEqual(parsed.mounts, [
      { host: '/host', container: '/app', readonly: true },
      { host: '/h2', container: '/t2', readonly: true },
    ], 'both mount spellings normalize to the same shape');
    assert.deepStrictEqual(parsed.runArgs, ['--cap-add=SYS_PTRACE']);
    assert.deepStrictEqual(parsed.forwardPorts, ['4200']);
    assert.strictEqual(parsed.portsAttributes['4200'].label, 'app');
    assert.strictEqual(parsed.preferredUserMode, 'user', 'a non-root remoteUser asks for the pad user');
  });

  it('maps the declared user onto the pad user mode, and says nothing when there is none', () => {
    const dir = ws();
    const mk = (doc) => devcontainer.parseDevContainer(write(path.join(dir, '.devcontainer', 'devcontainer.json'), doc));
    assert.strictEqual(mk({ containerUser: 'root' }).preferredUserMode, 'root', 'an explicit root stays root');
    assert.strictEqual(mk({ remoteUser: '0' }).preferredUserMode, 'root', 'a numeric root stays root');
    assert.strictEqual(mk({ remoteUser: 'vscode' }).preferredUserMode, 'user', 'any other user → the pad user');
    assert.strictEqual(mk({}).preferredUserMode, '', 'no declared user → no preference');
  });

  it('generates a mirror marked as Paddock-generated and omits the empty fields', () => {
    const content = devcontainer.generateDevContainer({
      workspaceFolder: '/workspace',
      postCreate: 'npm install',
      postStart: 'echo start',
      environment: { FOO: 'bar' },
      mounts: [{ host: '/h', container: '/c', readonly: true }],
      runArgs: ['--cap-add=SYS_PTRACE'],
      forwardPorts: [4200],
      portsAttributes: { '4200': { label: 'app' } },
      remoteUser: 'node',
    });
    const doc = JSON.parse(content);
    assert.strictEqual(doc['x-paddock'].generated, true, 'the generated marker is there');
    assert.strictEqual(doc.workspaceFolder, '/workspace');
    assert.strictEqual(doc.postCreateCommand, 'npm install');
    assert.strictEqual(doc.postStartCommand, 'echo start');
    assert.deepStrictEqual(doc.mounts, ['/h:/c:ro']);
    assert.deepStrictEqual(doc.forwardPorts, [4200]);
    assert.strictEqual(doc.remoteUser, 'node');
    assert.ok(!('postAttachCommand' in doc), 'an empty field is not written at all');
  });

  it('a generated file round-trips: what the parser reads back is what was generated', () => {
    const dir = ws();
    const content = devcontainer.generateDevContainer({
      workspaceFolder: '/workspace',
      postCreate: 'npm install',
      postStart: 'echo start',
      postAttach: 'echo attach',
      environment: { FOO: 'bar' },
      mounts: [{ host: '/h', container: '/c', readonly: true }],
      runArgs: ['--cap-add=SYS_PTRACE'],
      forwardPorts: [4200],
      portsAttributes: { '4200': { label: 'app' } },
      remoteUser: 'node',
    });
    const file = write(path.join(dir, '.devcontainer', 'devcontainer.json'), content);
    const parsed = devcontainer.parseDevContainer(file);
    assert.strictEqual(parsed.generated, true, 'the marker is read back');
    assert.strictEqual(parsed.postCreateCommand, 'npm install');
    assert.strictEqual(parsed.postStartCommand, 'echo start');
    assert.strictEqual(parsed.postAttachCommand, 'echo attach');
    assert.deepStrictEqual(parsed.mounts, [{ host: '/h', container: '/c', readonly: true }]);
    assert.deepStrictEqual(parsed.runArgs, ['--cap-add=SYS_PTRACE']);
    assert.strictEqual(parsed.remoteUser, 'node');
  });

  it('write-back updates only the mapped fields of a project-authored file', () => {
    const dir = ws();
    const file = write(path.join(dir, '.devcontainer', 'devcontainer.json'), {
      name: 'project-authored',
      features: { 'ghcr.io/devcontainers/features/node:1': {} },
      customizations: { vscode: { extensions: ['a'] } },
      postCreateCommand: 'echo original',
      environment: { FOO: 'bar' },
    });

    const out = devcontainer.syncFile(file, {
      postCreate: 'npm ci',
      environment: { FOO: 'baz', NEW: '1' },
      workspaceFolder: '/app',
    });
    const doc = JSON.parse(out);
    assert.strictEqual(doc.name, 'project-authored', 'an unmapped field survives');
    assert.deepStrictEqual(doc.features, { 'ghcr.io/devcontainers/features/node:1': {} }, 'features survive');
    assert.deepStrictEqual(doc.customizations, { vscode: { extensions: ['a'] } }, 'customizations survive');
    assert.strictEqual(doc.postCreateCommand, 'npm ci', 'the mapped lifecycle command is updated');
    assert.deepStrictEqual(doc.environment, { FOO: 'baz', NEW: '1' }, 'the mapped environment is updated');
    assert.strictEqual(doc.workspaceFolder, '/app', 'the mapped workspace folder is updated');
    // The default is write:true — the file on disk is updated.
    assert.strictEqual(
      JSON.parse(fs.readFileSync(file, 'utf8')).postCreateCommand,
      'npm ci',
      'the file on disk reflects the composed changes'
    );
  });

  it('syncFile with write:false composes the result without touching the file', () => {
    const dir = ws();
    const file = write(path.join(dir, '.devcontainer', 'devcontainer.json'), {
      name: 'project-authored',
      postCreateCommand: 'echo original',
    });
    const out = devcontainer.syncFile(file, { postCreate: 'npm ci' }, { write: false });
    assert.strictEqual(JSON.parse(out).postCreateCommand, 'npm ci', 'returned result is composed');
    assert.strictEqual(
      JSON.parse(fs.readFileSync(file, 'utf8')).postCreateCommand,
      'echo original',
      'the file on disk is untouched'
    );
  });

  it('write-back of a generated file rewrites it wholesale', () => {
    const dir = ws();
    const file = write(path.join(dir, '.devcontainer', 'devcontainer.json'),
      devcontainer.generateDevContainer({ workspaceFolder: '/workspace', postCreate: 'npm install' }));
    const out = devcontainer.syncFile(file, { postCreate: 'npm ci', postStart: 'echo start' });
    const doc = JSON.parse(out);
    assert.strictEqual(doc.postCreateCommand, 'npm ci');
    assert.strictEqual(doc.postStartCommand, 'echo start');
    assert.strictEqual(doc['x-paddock'].generated, true, 'still marked generated');
  });

  it('a cleared lifecycle command is removed from the mirror, not written as empty', () => {
    const dir = ws();
    const file = write(path.join(dir, '.devcontainer', 'devcontainer.json'), {
      name: 'project',
      postCreateCommand: 'npm install',
      postStartCommand: 'echo start',
    });
    const doc = JSON.parse(devcontainer.syncFile(file, { postCreate: '', postStart: '' }));
    assert.ok(!('postCreateCommand' in doc), 'the cleared command is gone');
    assert.ok(!('postStartCommand' in doc), 'the cleared command is gone');
    assert.strictEqual(doc.name, 'project', 'and the rest of the file is untouched');
  });

  it('syncFile writes the file it composed', () => {
    const dir = ws();
    const file = write(path.join(dir, '.devcontainer', 'devcontainer.json'), { name: 'project', postCreateCommand: 'old' });
    devcontainer.syncFile(file, { postCreate: 'new' });
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).postCreateCommand, 'new');
  });
});
