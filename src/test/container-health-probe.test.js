// Plan 124 #5 and #6: the health check must not turn "docker did not answer"
// into "the container does not exist", and must not call a container healthy
// when it runs a different KIND of networking than its compose file declares.
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-probe-'));
process.env.WORKSPACE_ROOT = root;
process.env.HOST_WORKSPACE_ROOT = root;
const PAD = 'pad-probe';
const padDir = path.join(root, 'instances', PAD);
fs.mkdirSync(padDir, { recursive: true });
const composeFile = path.join(padDir, 'docker-compose.yml');

const health = require('../services/container-health');

const RUNNING = { State: { Running: true }, HostConfig: { NetworkMode: `${PAD}_default`, RestartPolicy: { Name: 'no' } }, Config: { Image: 'img', Env: [] }, NetworkSettings: { Networks: { [`${PAD}_default`]: {} }, Ports: {} }, Mounts: [] };
const fail = (stderr) => Object.assign(new Error('Command failed'), { stderr });

/** A fake docker: `inspect` and `compose config` answer from the given handlers. */
function docker({ inspect, compose }) {
  health._setRunner(async (cmd, args) => {
    if (args[0] === 'inspect') return inspect(args[1]);
    if (args[0] === 'compose') return compose();
    throw new Error(`unexpected docker ${args.join(' ')}`);
  });
}
const services = (svc) => async () => ({ stdout: JSON.stringify({ services: { [PAD]: svc } }) });
const found = (obj) => async () => ({ stdout: JSON.stringify([obj]) });
const byKey = (report, key) => report.checks.find((c) => c.key === key);

afterEach(() => { health._setRunner(null); fs.rmSync(composeFile, { force: true }); });

describe('a probe that failed is not a negative answer', () => {
  it('daemon unreachable: the container is "could not check", not "not found"', async () => {
    fs.writeFileSync(composeFile, 'services: {}\n');
    docker({ inspect: async () => { throw fail('Cannot connect to the Docker daemon at unix:///var/run/docker.sock'); }, compose: services({ image: 'img' }) });
    const c = byKey(await health.checkContainerHealth(PAD), 'container');
    assert.equal(c.actual, 'could not check');
    assert.equal(c.checked, false);
    assert.notEqual(c.status, 'error', 'an unanswered probe is not a finding against the PAD');
    assert.match(c.hint, /Cannot connect to the Docker daemon/);
    assert.doesNotMatch(c.hint, /^The container does not exist/);
  });

  it('docker says no such container: that IS "not found"', async () => {
    fs.writeFileSync(composeFile, 'services: {}\n');
    docker({ inspect: async () => { throw fail(`Error response from daemon: No such object: ${PAD}`); }, compose: services({ image: 'img' }) });
    const c = byKey(await health.checkContainerHealth(PAD), 'container');
    assert.equal(c.actual, 'not found');
    assert.equal(c.status, 'error');
  });

  it('a compose file that exists but does not resolve is not "No compose file"', async () => {
    fs.writeFileSync(composeFile, 'services: {}\n');
    docker({ inspect: found(RUNNING), compose: async () => { throw fail('invalid interpolation format for services.pad.build.args'); } });
    const c = byKey(await health.checkContainerHealth(PAD), 'compose');
    assert.equal(c.actual, 'could not be read');
    assert.match(c.hint, /invalid interpolation format/);
    assert.match(c.hint, /not a reason to recreate/);
  });

  it('no compose file at all still says so', async () => {
    docker({ inspect: found(RUNNING), compose: async () => { throw new Error('must not be called without a file'); } });
    const c = byKey(await health.checkContainerHealth(PAD), 'compose');
    assert.equal(c.status, 'error');
    assert.match(c.hint, /^No compose file at /);
  });

  it('the fixture can produce a clean report, so the cases above are not red by construction', async () => {
    fs.writeFileSync(composeFile, 'services: {}\n');
    docker({ inspect: found(RUNNING), compose: services({ image: 'img' }) });
    const report = await health.checkContainerHealth(PAD);
    assert.equal(byKey(report, 'container').status, 'ok');
    assert.equal(byKey(report, 'network').status, 'ok');
    assert.equal(report.status, 'ok', JSON.stringify(report.checks.filter((c) => c.status !== 'ok')));
  });
});

describe('the kind of networking is compared before the peer is judged', () => {
  it('declared peer networking, running on its own bridge: error', async () => {
    fs.writeFileSync(composeFile, 'services: {}\n');
    docker({ inspect: found(RUNNING), compose: services({ image: 'img', network_mode: 'container:pad-peer' }) });
    const c = byKey(await health.checkContainerHealth(PAD), 'network');
    assert.equal(c.status, 'error', 'this row used to be green with expected container:pad-peer / actual pad-probe_default');
    assert.match(c.hint, /Recreate/);
  });

  it('declared own network, still bound to a peer: error', async () => {
    fs.writeFileSync(composeFile, 'services: {}\n');
    const bound = { ...RUNNING, HostConfig: { ...RUNNING.HostConfig, NetworkMode: 'container:abc123' } };
    docker({ inspect: found(bound), compose: services({ image: 'img' }) });
    const c = byKey(await health.checkContainerHealth(PAD), 'network');
    assert.equal(c.status, 'error');
    assert.match(c.hint, /still bound/);
  });

  it('the pure rule: same kind is no drift', () => {
    assert.equal(health.networkModeDrift('', 'pad_default'), '');
    assert.equal(health.networkModeDrift('container:a', 'container:b'), '', 'which peer is the classifier\'s question, not this one');
    assert.notEqual(health.networkModeDrift('container:a', 'bridge'), '');
    assert.notEqual(health.networkModeDrift('', 'container:b'), '');
  });
});
