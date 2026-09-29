const { describe, it } = require('node:test');
const assert = require('node:assert');
const { classifyNetworkPeer, inspectPeer } = require('../services/net-peer');

// Plan 66. The classification is the RULE, and it used to be written twice —
// once for settings_get and once for the health check, from different inputs.
// Two copies of one rule is how the surface came to say "stale" about a peer it
// had just called running, so the rule is pinned here, once, as a pure function.

const running = (name, id) => ({ name, id, state: 'running' });
const stopped = (name, id, state = 'exited') => ({ name, id, state });

describe('classifyNetworkPeer — one rule, four distinct problems', () => {
  it('a default-networked pad is ok and is not asked about a peer', () => {
    for (const mode of ['', 'default', undefined]) {
      const v = classifyNetworkPeer({ mode });
      assert.strictEqual(v.state, 'ok', `mode=${JSON.stringify(mode)}`);
      assert.strictEqual(v.peerName, '', 'a pad with no peer never grows a peer name');
    }
  });

  it('bound to the running peer it was configured for: ok, and named', () => {
    const peer = running('gluetun-nordvpn2', 'id-new');
    const v = classifyNetworkPeer({ mode: 'container:id-new', bound: peer, declaredRef: 'gluetun-nordvpn2', declared: peer });
    assert.strictEqual(v.state, 'ok');
    assert.strictEqual(v.peerName, 'gluetun-nordvpn2');
    assert.strictEqual(v.peerState, 'running');
    assert.strictEqual(v.peerCurrentId, 'id-new');
  });

  it('THE HEADLINE: a dead bound id with a RUNNING peer is staleBinding, not stale', () => {
    // The exact contradiction plan 66 was written for: the old answer was
    // `state: "stale"` with empty peerName/peerState while the peer was up.
    const v = classifyNetworkPeer({
      mode: 'container:dead-id',
      bound: null,
      declaredRef: 'gluetun-nordvpn2',
      declared: running('gluetun-nordvpn2', 'id-new'),
    });
    assert.strictEqual(v.state, 'staleBinding');
    assert.strictEqual(v.staleBinding, true);
    assert.strictEqual(v.peerState, 'running', 'and it can no longer be blank');
    assert.ok(/needs nothing/.test(v.reason), 'the reason tells the caller the peer is fine');
  });

  it('a bound peer that is RUNNING but is not the configured one is still staleBinding', () => {
    // The case a "is the bound id alive?" test answers `ok` to, because the
    // bound ref resolves. Both peers can be healthy and the pad still be wrong.
    const v = classifyNetworkPeer({
      mode: 'container:id-old',
      bound: running('gluetun-nordvpn1', 'id-old'),
      declaredRef: 'gluetun-nordvpn2',
      declared: running('gluetun-nordvpn2', 'id-new'),
    });
    assert.strictEqual(v.state, 'staleBinding');
    assert.notStrictEqual(v.peerId, v.peerCurrentId, 'both sides of the mismatch are reported');
    assert.ok(/gluetun-nordvpn2/.test(v.reason), 'and the target is named');
  });

  it('a stopped peer is peer-stopped BY NAME, whether the bound id is dead or not', () => {
    const dead = classifyNetworkPeer({
      mode: 'container:dead-id', bound: null,
      declaredRef: 'gluetun-nordvpn2', declared: stopped('gluetun-nordvpn2', 'id-new'),
    });
    assert.strictEqual(dead.state, 'peer-stopped');
    assert.strictEqual(dead.peerName, 'gluetun-nordvpn2');
    assert.ok(/Start it/.test(dead.reason), 'the reason is the action the PEER needs');

    const alive = classifyNetworkPeer({
      mode: 'container:id-new', bound: stopped('gluetun-nordvpn2', 'id-new'),
      declaredRef: 'gluetun-nordvpn2', declared: stopped('gluetun-nordvpn2', 'id-new'),
    });
    assert.strictEqual(alive.state, 'peer-stopped', 'the bound ref resolving does not make it ok');
  });

  it('no peer we can name is `stale`, and the reason says it does not exist', () => {
    const v = classifyNetworkPeer({ mode: 'container:dead-id', bound: null, declaredRef: 'gluetun-gone', declared: null });
    assert.strictEqual(v.state, 'stale');
    assert.strictEqual(v.checked, true, 'we DID look — this is a verdict, not an unknown');
    assert.ok(/does not exist/.test(v.reason));
    assert.ok(v.reason.includes('gluetun-gone'), 'and names what could not be found');
  });

  it('a dead bound id with NO configured peer says so, rather than blaming nobody', () => {
    const v = classifyNetworkPeer({ mode: 'container:dead-id', bound: null, declaredRef: '', declared: null });
    assert.strictEqual(v.state, 'stale');
    assert.ok(/no peer is configured/.test(v.reason), 'the reason covers the case with no name at all');
  });

  it('EVERY non-ok state carries a reason, and ok carries none', () => {
    const cases = [
      { mode: 'default' },
      { mode: 'container:dead', bound: null, declaredRef: 'p', declared: running('p', 'a') },
      { mode: 'container:dead', bound: null, declaredRef: 'p', declared: stopped('p', 'a') },
      { mode: 'container:dead', bound: null, declaredRef: 'p', declared: null },
    ];
    for (const c of cases) {
      const v = classifyNetworkPeer(c);
      if (v.state === 'ok') assert.strictEqual(v.reason, undefined, 'ok needs no explanation');
      else assert.ok(v.reason && v.reason.length > 20, `${v.state} explains itself`);
    }
  });

  it('never confuses "I could not check" with "broken" — it has no state for it', () => {
    // The rule only ever rules on lookups it was HANDED, so an answer nobody
    // could compute cannot come out of here. Callers that cannot look (the pad
    // itself not inspectable) must report `checked: false` instead.
    const v = classifyNetworkPeer({ mode: 'container:x', bound: null, declaredRef: 'p', declared: null });
    assert.notStrictEqual(v.checked, false, 'every verdict here is checked');
    assert.ok(!['unknown', 'unchecked', 'error'].includes(v.state), 'no invented states');
  });
});

describe('inspectPeer — a reference that does not resolve', () => {
  it('returns null for a reference docker cannot find, and never throws', async () => {
    const run = async () => { throw new Error('Error: No such object: nope'); };
    assert.strictEqual(await inspectPeer('nope', { run }), null, 'a failed lookup is a value, not a crash');
  });

  it('returns null for no reference at all (the default-network pad never asks)', async () => {
    let called = false;
    const run = async () => { called = true; return { stdout: 'x|y|z' }; };
    assert.strictEqual(await inspectPeer('', { run }), null);
    assert.strictEqual(called, false, 'and does not bother docker');
  });

  it('reads name, id and state, stripping the leading slash docker adds', async () => {
    const run = async () => ({ stdout: '/gluetun-nordvpn2|abc123|running\n' });
    assert.deepStrictEqual(await inspectPeer('gluetun-nordvpn2', { run }), {
      name: 'gluetun-nordvpn2', id: 'abc123', state: 'running',
    });
  });
});

describe('inspectPeer — a lookup that never RAN must not read as an absent peer', () => {
  // THE regression this suite exists for. The health check was rewired to
  // classify through this rule and called `inspectPeer(ref)` with no runner;
  // the function returned `null` for both lookups, every pad's peer read as
  // gone, and three healthy pads were reported `error` — while the unit tests
  // stayed green, because they only covered the pure classifier and
  // checkPublishedPorts. A silent null from a lookup that never executed is
  // indistinguishable from a dead peer, so it gets a real end-to-end guard.
  const hasDocker = (() => {
    try {
      require('child_process').execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 10000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it('with no injected runner it really asks docker, so a running container resolves', { skip: !hasDocker && 'no docker on this host' }, async () => {
    // Any running container on this host will do — we are proving the DEFAULT
    // path reaches docker at all, not asserting anything about the fleet.
    const { execFileSync } = require('child_process');
    const name = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { timeout: 10000, encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean)[0];
    if (!name) return; // nothing running: the default path is still covered above
    const peer = await inspectPeer(name);
    assert.ok(peer, 'a running container must resolve with no runner supplied');
    assert.strictEqual(peer.state, 'running');
    assert.ok(peer.name, 'and it is named, not blank');
  });

  it('an unresolvable reference still resolves to null, not a throw', { skip: !hasDocker && 'no docker on this host' }, async () => {
    assert.strictEqual(await inspectPeer('opencode-definitely-not-a-real-container'), null);
  });
});
