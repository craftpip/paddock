const { describe, it } = require('node:test');
const assert = require('node:assert');
const { checkPublishedPorts } = require('../services/container-health');

// A compose service declaring a published port, and the live inspect shape that
// proves (or disproves) the binding.
const svcWithPorts = (...ports) => ({ ports: ports.map(([p, t]) => ({ published: p, target: t, protocol: 'tcp' })) });
const ctrWithBindings = (map) => ({ NetworkSettings: { Ports: map } });

describe('container-health - published ports are read off the door', () => {
  // The bug: a peer-mode agent publishes nothing itself, so the check read the
  // agent service + container and reported "(none)" / healthy for a pad whose
  // ports were in fact bound on the `-door` sidecar.
  it('a door-published port is verified against the DOOR container, not the agent', () => {
    const compose = { ports: [] };
    const ctr = { NetworkSettings: { Ports: {} } };
    const door = svcWithPorts(['7891', '7891'], ['54321', '54321']);
    const doorCtr = ctrWithBindings({
      '7891/tcp': [{ HostIp: '0.0.0.0', HostPort: '7891' }],
      '54321/tcp': [{ HostIp: '0.0.0.0', HostPort: '54321' }],
    });

    const check = checkPublishedPorts(compose, ctr, door, doorCtr);
    assert.strictEqual(check.status, 'ok', 'a working door pad is healthy');
    assert.strictEqual(check.label, 'Ports (via door)', 'the check says where it looked');
    assert.ok(check.expected.includes('7891:7891'), 'the door ports are the expectation');
    assert.ok(!check.actual.includes('(none)'), 'never reports (none) for a bound port');
  });

  it('a missing door binding is an error naming the port, not a false ok', () => {
    const door = svcWithPorts(['7891', '7891']);
    const doorCtr = ctrWithBindings({}); // door is up, nothing bound
    const check = checkPublishedPorts({ ports: [] }, { NetworkSettings: { Ports: {} } }, door, doorCtr);
    assert.strictEqual(check.status, 'error');
    assert.ok(check.hint.includes('7891'), 'names the unbound port');
  });

  it('a door that is gone reports its ports unbound — error, never "(none)"', () => {
    const door = svcWithPorts(['7891', '7891']);
    const check = checkPublishedPorts({ ports: [] }, { NetworkSettings: { Ports: {} } }, door, null);
    assert.strictEqual(check.status, 'error', 'the declared port is not bound, so this is a real fault');
    assert.ok(!check.actual.includes('(none)'), 'never reports (none) for an unbound declared port');
    assert.ok(check.hint.includes('7891'), 'names the port that is not bound');
  });

  it('a declared door with no ports and no container warns that it is unverifiable', () => {
    const check = checkPublishedPorts({ ports: [] }, { NetworkSettings: { Ports: {} } }, { ports: [] }, null);
    assert.strictEqual(check.status, 'warn', 'warn, not a silent pass');
    assert.ok(check.actual.includes('not verifiable'), 'says the check was impossible');
  });

  it('a pad with no door falls back to its own container and keeps the plain label', () => {
    const compose = svcWithPorts(['8123', '8123']);
    const ctr = ctrWithBindings({ '8123/tcp': [{ HostIp: '0.0.0.0', HostPort: '8123' }] });
    const check = checkPublishedPorts(compose, ctr, null, null);
    assert.strictEqual(check.status, 'ok');
    assert.strictEqual(check.label, 'Ports', 'no door → no "(via door)" label');
  });

  it('a pad that genuinely publishes nothing is ok with (none) on both sides', () => {
    const check = checkPublishedPorts({ ports: [] }, { NetworkSettings: { Ports: {} } }, null, null);
    assert.strictEqual(check.status, 'ok');
    assert.strictEqual(check.expected, '(none)');
    assert.strictEqual(check.actual, '(none)');
  });

  it('an exposed-only port (no published host port) has nothing to verify', () => {
    const door = { ports: [{ target: 80, published: null }] };
    const check = checkPublishedPorts({ ports: [] }, { NetworkSettings: { Ports: {} } }, door, ctrWithBindings({}));
    assert.strictEqual(check.status, 'ok', 'expose-only does not fail the check');
  });

  it('a non-tcp protocol is matched under its own key', () => {
    const door = { ports: [{ published: '54321', target: '54321', protocol: 'udp' }] };
    const withUdp = ctrWithBindings({ '54321/udp': [{ HostIp: '0.0.0.0', HostPort: '54321' }] });
    assert.strictEqual(checkPublishedPorts({ ports: [] }, { NetworkSettings: { Ports: {} } }, door, withUdp).status, 'ok');
    const withTcpOnly = ctrWithBindings({ '54321/tcp': [{ HostIp: '0.0.0.0', HostPort: '54321' }] });
    assert.strictEqual(checkPublishedPorts({ ports: [] }, { NetworkSettings: { Ports: {} } }, door, withTcpOnly).status, 'error', 'a tcp binding does not satisfy a udp port');
  });
});
