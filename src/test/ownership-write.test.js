/** Plan 95 — write-time ownership.
 *
 *  The unit tests here prove the PRIMITIVES and every writer that can be
 *  exercised without a control-plane container: nested directory creation,
 *  symlink/escape refusal, atomic replacement, the queue/index/pause-marker
 *  writers, the devcontainer writer and the per-instance build files.
 *
 *  Ownership is asserted by uid/gid, which a non-root run can only observe for
 *  files it created itself (already `PUID:PGID`). The root repair path — a
 *  root-owned file being chowned back — is asserted in the `requires root`
 *  test, and the user-mode `docker exec` argv in the last suite.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-own95-'));
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pad-own95-db-'));
process.env.WORKSPACE_ROOT = WS;
process.env.PAD_DB_PATH = path.join(DB_DIR, 'own95.test.db');
process.on('exit', () => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(DB_DIR, { recursive: true, force: true });
});

const ownership = require('../services/ownership');
const { USER_UID, USER_GID, OwnershipError, mkdirOwned, writeFileOwned, atomicWriteOwned, ensureOwnedStrict } = ownership;
const plans = require('../services/plans');
const devcontainer = require('../services/devcontainer');
const instanceImage = require('../services/instance-image');
const workspace = require('../services/workspace');

const ownedByUser = (p) => {
  const st = fs.lstatSync(p);
  return st.uid === USER_UID && st.gid === USER_GID;
};

describe('plan 95 — ownership primitives', () => {
  const root = () => fs.mkdtempSync(path.join(WS, 'prim-'));
  const outside = () => fs.mkdtempSync(path.join(WS, 'out-'));

  it('mkdirOwned creates every missing parent and reports only what it created', () => {
    const base = path.join(root(), 'a');
    const r = mkdirOwned(path.join(base, 'b', 'c'), { boundary: path.dirname(base) });
    assert.deepStrictEqual(r.created, [base, path.join(base, 'b'), path.join(base, 'b', 'c')]);
    for (const p of r.created) assert.ok(ownedByUser(p), p);
  });

  it('mkdirOwned leaves an existing ancestor alone and creates only the tail', () => {
    const base = path.join(root(), 'a');
    fs.mkdirSync(base);
    const r = mkdirOwned(path.join(base, 'b'), { boundary: path.dirname(base) });
    assert.deepStrictEqual(r.created, [path.join(base, 'b')]);
  });

  it('mkdirOwned refuses to create through a symlink that escapes the boundary', () => {
    const base = root();
    const away = outside();
    fs.symlinkSync(away, path.join(base, 'link'));
    assert.throws(
      () => mkdirOwned(path.join(base, 'link', 'inside'), { boundary: base }),
      (e) => e instanceof OwnershipError && e.code === 'ownership_path_escape'
    );
    assert.ok(!fs.existsSync(path.join(away, 'inside')), 'nothing was created through the link');
  });

  it('mkdirOwned refuses a final symlink even when it points inside', () => {
    const base = root();
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'));
    assert.throws(
      () => mkdirOwned(path.join(base, 'alias'), { boundary: base }),
      (e) => e instanceof OwnershipError && e.code === 'ownership_symlink_refused'
    );
  });

  it('mkdirOwned requires a boundary rather than writing unowned', () => {
    assert.throws(
      () => mkdirOwned(path.join(root(), 'x'), {}),
      (e) => e instanceof OwnershipError && e.code === 'ownership_boundary_missing'
    );
  });

  it('writeFileOwned refuses a symlink target and leaves the real file untouched', () => {
    const base = root();
    const away = outside();
    const victim = path.join(away, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    fs.symlinkSync(victim, path.join(base, 'escape.txt'));
    assert.throws(
      () => writeFileOwned(path.join(base, 'escape.txt'), 'overwritten', { boundary: base }),
      (e) => e instanceof OwnershipError && e.code === 'ownership_symlink_refused'
    );
    assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'original');
  });

  it('writeFileOwned refuses to clobber a directory', () => {
    const base = root();
    fs.mkdirSync(path.join(base, 'dir'));
    assert.throws(
      () => writeFileOwned(path.join(base, 'dir'), 'x', { boundary: base }),
      (e) => e instanceof OwnershipError && e.code === 'ownership_not_a_file'
    );
  });

  it('writeFileOwned creates nested parents, the file, and a Buffer exactly', () => {
    const base = root();
    const target = path.join(base, 'deep', 'nest', 'bin.dat');
    const buf = Buffer.from([0, 1, 2, 255]);
    writeFileOwned(target, buf, { boundary: base });
    assert.deepStrictEqual(fs.readFileSync(target), buf);
    assert.ok(ownedByUser(target));
    assert.ok(ownedByUser(path.dirname(target)));
  });

  it('writeFileOwned exclusive refuses an existing file without touching it', () => {
    const base = root();
    const target = path.join(base, 'q.md');
    fs.writeFileSync(target, 'winner');
    assert.throws(
      () => writeFileOwned(target, 'loser', { boundary: base, exclusive: true }),
      (e) => e.code === 'EEXIST'
    );
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'winner');
  });

  it('atomicWriteOwned replaces content, preserves mode, and leaves no temp file', () => {
    const base = root();
    const target = path.join(base, 'QUEUE.md');
    fs.writeFileSync(target, 'old', { mode: 0o640 });
    fs.chmodSync(target, 0o640);
    atomicWriteOwned(target, 'new', { boundary: base });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'new');
    assert.strictEqual(fs.statSync(target).mode & 0o777, 0o640);
    assert.deepStrictEqual(fs.readdirSync(base), ['QUEUE.md'], 'no .tmp- inode left behind');
  });

  it('atomicWriteOwned creates the file when absent', () => {
    const base = root();
    const target = path.join(base, 'sub', 'QUEUE.md');
    atomicWriteOwned(target, 'body', { boundary: base });
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'body');
    assert.ok(ownedByUser(target));
  });

  it('ensureOwnedStrict corrects a root-owned file (requires root)', (t) => {
    if (process.getuid() !== 0) return t.skip('requires root to chown');
    const p = path.join(root(), 'f');
    fs.writeFileSync(p, 'x');
    fs.chownSync(p, 0, 0);
    const r = ensureOwnedStrict(p);
    assert.strictEqual(r.changed, true);
    assert.ok(ownedByUser(p));
  });

  it('ensureOwnedStrict is actionable when a foreign-owned file cannot be repaired', (t) => {
    if (process.getuid() === 0) return t.skip('runs only as a non-root writer');
    assert.throws(
      () => ensureOwnedStrict('/etc/passwd'),
      (e) => e instanceof OwnershipError && e.code === 'ownership_chown_denied' && /cannot chown/.test(e.message)
    );
  });
});

describe('plan 95 — plans writers', () => {
  const PAD = 'pad-own95';
  const agent = () => ({
    id: PAD, name: PAD, display_name: 'Own 95', agent_type: 'opencode',
    runtime_type: 'docker', runtime_ref: PAD, status: 'running',
    workspace_root: path.join(WS, 'a-data'), workspace_mount: null,
    workspace_dir: '/root/.opencode/workspace',
  });
  const project = (over = {}) => ({
    id: 'prj_o95', name: 'own95', agent_name: PAD, agent_type: 'opencode',
    folder: '/root/.opencode/workspace', plans_folder: 'plans', ...over,
  });
  const plansRoot = path.join(WS, 'a-data', 'workspace', 'plans');

  it('ensureQueue creates the folder, template and file owned at write time', async () => {
    const r = await plans.ensureQueue(agent(), project());
    assert.ok(r.created);
    assert.ok(ownedByUser(r.path), 'queue file');
    assert.ok(ownedByUser(path.join(plansRoot)), 'plans folder');
    assert.ok(fs.readFileSync(r.path, 'utf8').includes('paddock-queue:start'));
  });

  it('writeQueue replaces atomically with the CAS revision and leaves no temp inode', async () => {
    const a = agent();
    const p = project();
    const before = await plans.readQueue(a, p);
    const items = [{ id: 'q-1', plan: 'one.md', status: 'new', reason: '' }];
    const w = await plans.writeQueue(a, p, items, before.hash);
    const after = await plans.readQueue(a, p);
    assert.deepStrictEqual(after.parsed.items.map((i) => i.id), ['q-1']);
    assert.strictEqual(after.hash, w.hash);
    assert.ok(ownedByUser(w.path));
    assert.ok(!fs.readdirSync(path.dirname(w.path)).some((f) => f.includes('.tmp-')), 'no temp inode');
  });

  it('setQueuePausedMarker creates and removes the marker with ownership', () => {
    const a = agent();
    const p = project();
    plans.setQueuePausedMarker(a, p, true);
    const marker = path.join(plansRoot, 'QUEUE.paused');
    assert.ok(fs.existsSync(marker));
    assert.ok(ownedByUser(marker));
    plans.setQueuePausedMarker(a, p, false);
    assert.ok(!fs.existsSync(marker));
  });

  it('writePlan creates the plan file and INDEX.md owned at write time', async () => {
    const a = agent();
    const p = project();
    const r = await plans.writePlan(a, '95-demo.md', '# Demo\n', { project: p });
    assert.ok(ownedByUser(r.abs));
    const index = path.join(plansRoot, 'INDEX.md');
    assert.ok(fs.existsSync(index));
    assert.ok(ownedByUser(index));
  });
});

describe('plan 95 — devcontainer and instance build files', () => {
  it('writeGeneratedDevContainer normalizes the directory it creates', () => {
    const ws = fs.mkdtempSync(path.join(WS, 'dc-'));
    const target = devcontainer.writeGeneratedDevContainer(ws, '{}\n');
    assert.ok(ownedByUser(target));
    assert.ok(ownedByUser(path.dirname(target)), '.devcontainer dir');
  });

  it('setBuildEnv and writeCustomBuild own the build dir and files', () => {
    const name = 'pad-own95-build';
    instanceImage.setBuildEnv(name, { INSTALL_DOCKER: '1' });
    const envPath = instanceImage.buildEnvPath(name);
    assert.ok(ownedByUser(envPath));
    assert.ok(ownedByUser(path.dirname(envPath)), 'build dir');
    fs.writeFileSync(instanceImage.dockerfilePath(name), 'FROM node:20\nENTRYPOINT ["x"]\n');
    instanceImage.writeCustomBuild(name, 'RUN echo hi');
    assert.ok(ownedByUser(instanceImage.dockerfilePath(name)));
    assert.match(fs.readFileSync(instanceImage.dockerfilePath(name), 'utf8'), /RUN echo hi/);
  });
});

describe('plan 95 — container exec argv', () => {
  const instDir = path.join(WS, 'instances');
  const writeMeta = (name, body) => {
    fs.mkdirSync(path.join(instDir, name), { recursive: true });
    fs.writeFileSync(path.join(instDir, name, 'meta.env'), body);
  };

  it('a user-mode pad drops to the pad user and passes ownership ids', () => {
    writeMeta('pad-own95-user', 'AGENT=opencode\nUSER_MODE=user\n');
    const args = workspace.containerDockerArgs('pad-own95-user');
    assert.deepStrictEqual(args.slice(0, 2), ['exec', '-i']);
    assert.ok(args.includes('-u'), 'user flag present');
    const i = args.indexOf('-u');
    assert.strictEqual(args[i + 1], `${USER_UID}:${USER_GID}`);
    assert.ok(args.includes('HOME=/root'));
    assert.ok(args.includes('node'), 'still runs the container helper');
  });

  it('a root-mode pad keeps the default user', () => {
    writeMeta('pad-own95-root', 'AGENT=opencode\n');
    const args = workspace.containerDockerArgs('pad-own95-root');
    assert.ok(!args.includes('-u'), 'no user drop for root-mode pads');
  });
});
