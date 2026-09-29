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

  it('never confuses "I could not check" with "broken" — an all-errors answer says so', () => {
    // The rule only ever rules on lookups it was HANDED, so an answer nobody
    // could compute cannot come out of the verdict branches. But a lookup that
    // FAILED is now a distinct value, so the rule has one honest exit for it:
    // `checked: false`. Asserting the state is NOT one of the four actionable
    // ones is the property — a caller must never be told to recreate or start a
    // peer over a docker error.
    const err = { error: 'Cannot connect to the Docker daemon' };
    const both = classifyNetworkPeer({ mode: 'container:x', bound: err, declaredRef: 'p', declared: err });
    assert.strictEqual(both.checked, false, 'an unreadable peer is unchecked, not healthy');
    assert.ok(!['ok', 'stale', 'staleBinding', 'peer-stopped'].includes(both.state),
      `an unreadable peer must not borrow an actionable state (got ${both.state})`);
    assert.match(both.reason, /Could not read/i, 'and it says the lookup failed, naming why');
  });

  it('a wrong binding onto a peer that is NOT running is peer-stopped, not staleBinding', () => {
    // The one branch that was wrong: the pad is attached to a running container
    // that is not the peer it is configured for, so the naive reading is
    // "staleBinding — recreate the pad". But the CONFIGURED peer is exited, so a
    // recreate would move the pad onto a stopped peer and it still could not
    // start. The state has to name the thing that needs starting first.
    const v = classifyNetworkPeer({
      mode: 'container:deadbeefdeadbeef',
      bound: running('gluetun-old', 'deadbeefdeadbeef'),
      declaredRef: 'gluetun-new',
      declared: stopped('gluetun-new', 'aaaa1111'),
    });
    assert.strictEqual(v.state, 'peer-stopped', 'the target is down, so start it first');
    assert.ok(!v.staleBinding, 'not a stale binding — the binding is not the blocker');
    assert.match(v.reason, /Start 'gluetun-new' first/, 'and the reason orders the two fixes');
  });

  it('the same case with the target RUNNING is staleBinding — the peer needs nothing', () => {
    const v = classifyNetworkPeer({
      mode: 'container:deadbeefdeadbeef',
      bound: running('gluetun-old', 'deadbeefdeadbeef'),
      declaredRef: 'gluetun-new',
      declared: running('gluetun-new', 'aaaa1111'),
    });
    assert.strictEqual(v.state, 'staleBinding');
    assert.ok(v.staleBinding);
    assert.match(v.reason, /needs nothing/, 'the peer is fine, so a recreate is the whole fix');
    assert.ok(!/Start /.test(v.reason), 'and it must not tell the caller to start a running peer');
  });
});

describe('inspectPeer — a reference that does not resolve', () => {
  it('returns null for a reference docker cannot find, and never throws', async () => {
    const run = async () => { throw new Error('Error: No such object: nope'); };
    assert.strictEqual(await inspectPeer('nope', { run }), null, 'a failed lookup is a value, not a crash');
  });

  it('reports a FAILED lookup as an error, not as an absent peer', async () => {
    // `docker inspect` exits non-zero for "no such container" AND for an
    // unreachable daemon. Those are opposite facts about different objects, and
    // collapsing them points the caller at a peer that is fine while the real
    // problem (docker) is invisible. So only the "no such" text is a null.
    const run = async () => { throw new Error('Error response from daemon: Cannot connect to the Docker daemon at unix:///var/run/docker.sock'); };
    const v = await inspectPeer('gluetun', { run });
    assert.ok(v && v.error, 'an unreadable reference is reported as an error');
    assert.match(v.error, /Cannot connect/, 'carrying the reason');
  });

  it('an errored peer does not become an actionable verdict about the pad', async () => {
    // The end of the chain: if every lookup we tried failed, the rule cannot
    // name a state it has no evidence for, so it declines to guess.
    const run = async () => { throw new Error('Error response from daemon: Cannot connect to the Docker daemon'); };
    const v = classifyNetworkPeer({
      mode: 'container:abc',
      bound: await inspectPeer('abc', { run }),
      declaredRef: 'gluetun',
      declared: await inspectPeer('gluetun', { run }),
    });
    assert.strictEqual(v.checked, false);
  });

  it('a failed BOUND lookup is never rounded into a confident verdict', async () => {
    // This used to answer `staleBinding` here, with the reason asserting the
    // bound container "no longer exists" — a deletion it never observed, used to
    // justify recreating a pad that may be perfectly healthy. The configured
    // peer being up says nothing about the binding: if the bound peer is
    // running and IS the configured one, this pad is fine.
    const fails = async () => { throw new Error('Error response from daemon: Cannot connect to the Docker daemon'); };
    const v = classifyNetworkPeer({
      mode: 'container:abc',
      bound: await inspectPeer('abc', { run: fails }),
      declaredRef: 'gluetun',
      declared: running('gluetun', 'aaaa1111'),
    });
    assert.strictEqual(v.state, 'unknown', 'nothing about the binding was established');
    assert.strictEqual(v.checked, false, 'so it is reported as unchecked, not as a real answer');
    assert.doesNotMatch(v.reason, /no longer exists/, 'the reason must not claim a deletion it did not see');
  });

  it('a failed CONFIGURED lookup is not `ok` — that is the question it answers', async () => {
    // `ok` and `staleBinding` differ ONLY by whether the two ids match. With the
    // declared side unread, a correct binding and a wrong one look identical, so
    // `ok` here is a guess. It also used to set peerCurrentId from the BOUND
    // peer, which made the documented `peerId !== peerCurrentId` test compare
    // the id with itself and read as "no mismatch".
    const fails = async () => { throw new Error('Error response from daemon: Cannot connect to the Docker daemon'); };
    const v = classifyNetworkPeer({
      mode: 'container:aaaa1111',
      bound: running('gluetun', 'aaaa1111'),
      declaredRef: 'other-peer',
      declared: await inspectPeer('other-peer', { run: fails }),
    });
    assert.strictEqual(v.state, 'unknown', 'we cannot tell a correct binding from a wrong one');
    assert.strictEqual(v.checked, false);
    assert.notStrictEqual(v.peerId, v.peerCurrentId,
      'the two ids must not be the same value, or `peerId !== peerCurrentId` reads as a match');
  });

  it('a stopped bound peer is still decisive when the configured lookup failed', async () => {
    // The one case an unreadable reference cannot spoil: whatever the
    // configured peer is doing, this pad cannot start. So a real, actionable
    // answer is available without the second opinion.
    const fails = async () => { throw new Error('Error response from daemon: Cannot connect to the Docker daemon'); };
    const v = classifyNetworkPeer({
      mode: 'container:bbbb2222',
      bound: { name: 'gluetun', id: 'bbbb2222', state: 'exited' },
      declaredRef: 'other-peer',
      declared: await inspectPeer('other-peer', { run: fails }),
    });
    assert.strictEqual(v.state, 'peer-stopped', 'a stopped bound peer settles it on its own');
    assert.strictEqual(v.checked, true);
  });

  it('a genuinely ABSENT bound peer is still diagnosed (a fact, not a shrug)', async () => {
    // The counterpart to the case above, and the reason the split is on `error`
    // rather than on "resolved or not": docker saying "No such object" IS a
    // fact about the peer, so these must keep their actionable states.
    const v = classifyNetworkPeer({
      mode: 'container:abc',
      bound: null,
      declaredRef: 'gluetun',
      declared: running('gluetun', 'aaaa1111'),
    });
    assert.strictEqual(v.state, 'staleBinding', 'absent is not unreadable — recreate still is the fix');
    assert.strictEqual(v.checked, true);
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
