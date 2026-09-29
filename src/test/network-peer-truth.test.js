const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Plan 66. The finding is not "the field is wrong" — it is that a LOOKUP WAS
// ALLOWED TO FAIL SILENTLY, so two unrelated situations produced one answer:
// a pad bound to a dead container id whose declared peer is alive and running,
// and a peer that genuinely does not exist. The first needs a recreate; the
// second needs the peer started. Reporting the second as the first sends the
// caller to recreate a fine pad and hides the thing that actually needs action.
//
// These are the three truths the old code could not tell apart:
//   bound-id dead + peer running  ->  staleBinding  (recreate the PAD only)
//   named peer exists, not running ->  peer-stopped  (start the PEER first)
//   nothing we can name exists     ->  stale         (name it, or say why)

/** A `runCmd` stand-in over a fixed container table. Any reference not in the
 *  table is "does not resolve" — which is what a deleted id looks like.
 *
 *  Keyed on the `--format` string, not just the reference: the pad's own inspect
 *  asks for `NetworkMode` and a peer inspect asks for `Name|Id|Status`. A fake
 *  that answered every call identically would report the pad as being on the
 *  default network and every one of these tests would pass without ever
 *  reaching the peer branch. */
function fakeDocker(containers) {
  const calls = [];
  // docker accepts a NAME or an ID for inspect, and the real difference between
  // a stale binding and a live peer is precisely that one of them is an ID.
  const byRef = {};
  for (const [key, c] of Object.entries(containers)) {
    byRef[key] = c;
    if (c.id) byRef[c.id] = c;
  }
  const run = async (_bin, args) => {
    const ref = args[1];
    const fmt = args[args.indexOf('--format') + 1] || '';
    calls.push(ref);
    const c = byRef[ref];
    if (!c) throw new Error(`Error: No such object: ${ref}`);
    if (fmt.includes('NetworkMode')) return { stdout: `${c.netMode || 'default'}\n`, stderr: '' };
    return { stdout: `/${c.name}|${c.id || ref}|${c.state}\n`, stderr: '' };
  };
  return { run, calls };
}

/** A pad bound to a peer container whose id is `boundId` (a deleted id when the
 *  caller wants the stale case). */
const peerPad = (boundId) => ({ 'pad-peer': { name: 'pad-peer', state: 'running', netMode: `container:${boundId}` } });

describe('network peer truth (plan 66)', () => {
  it('a default-networked pad is ok, and says it was actually checked', async () => {
    const vm = require('../services/vm-manager');
    const { run } = fakeDocker({ 'pad-plain': { name: 'pad-plain', state: 'running' } });
    const h = await vm.getNetworkHealth('pad-plain', { run });
    assert.strictEqual(h.state, 'ok');
    assert.strictEqual(h.checked, true, 'a computed answer is marked as computed');
  });

  it('a live peer is NAMED — the state can no longer contradict the peer', async () => {
    // The original bug, verbatim: `peerName: ''` + `peerState: ''` next to a
    // response whose `availableNetworks` listed that same peer as running.
    const vm = require('../services/vm-manager');
    const { run } = fakeDocker({
      ...peerPad('abc123def456'),
      'gluetun-nordvpn2': { name: 'gluetun-nordvpn2', id: 'abc123def456', state: 'running' },
    });
    const h = await vm.getNetworkHealth('pad-peer', { run });
    assert.strictEqual(h.state, 'ok');
    assert.strictEqual(h.peerName, 'gluetun-nordvpn2', 'a running peer is named, not left empty');
    assert.strictEqual(h.peerState, 'running');
    assert.strictEqual(h.peerCurrentId, 'abc123def456');
  });

  it('a dead bound id with a RUNNING declared peer is staleBinding, not "gone"', async () => {
    // The case the old code answered "stale" with two empty strings.
    const vm = require('../services/vm-manager');
    const { run } = fakeDocker({
      ...peerPad('deadid0000'),
      'gluetun-nordvpn2': { name: 'gluetun-nordvpn2', id: 'newid9999', state: 'running' },
    });
    const h = await vm.getNetworkHealth('pad-peer', { declaredPeer: 'gluetun-nordvpn2', run });
    assert.strictEqual(h.state, 'staleBinding', 'the peer is fine; only our binding is dead');
    assert.strictEqual(h.peerName, 'gluetun-nordvpn2');
    assert.strictEqual(h.peerState, 'running');
    assert.ok(h.staleBinding, 'the disagreement is stated as a fact');
    assert.notStrictEqual(h.peerId, h.peerCurrentId, 'both sides of the mismatch are reported');
    assert.ok(/running/.test(h.reason), 'the reason says the peer needs nothing');
  });

  it('a declared peer that exists but is stopped is peer-stopped, BY NAME', async () => {
    const vm = require('../services/vm-manager');
    const { run } = fakeDocker({
      ...peerPad('deadid0000'),
      'gluetun-nordvpn2': { name: 'gluetun-nordvpn2', id: 'newid9999', state: 'exited' },
    });
    const h = await vm.getNetworkHealth('pad-peer', { declaredPeer: 'gluetun-nordvpn2', run });
    assert.strictEqual(h.state, 'peer-stopped');
    assert.strictEqual(h.peerName, 'gluetun-nordvpn2', 'named, so the caller knows WHICH peer to start');
    assert.strictEqual(h.peerState, 'exited');
    assert.ok(/Start it/.test(h.reason), 'the reason names the action the peer needs');
  });

  it('a peer that genuinely does not exist is stale, and SAYS it could not be named', async () => {
    const vm = require('../services/vm-manager');
    const { run } = fakeDocker({ ...peerPad('deadid0000') });
    const h = await vm.getNetworkHealth('pad-peer', { declaredPeer: 'gluetun-nordvpn2', run });
    assert.strictEqual(h.state, 'stale');
    assert.strictEqual(h.checked, true, 'we DID look; the peer is the problem, not our ability to look');
    assert.ok(/does not exist/.test(h.reason), 'and the reason says so in words');
    assert.ok(h.reason.includes('gluetun-nordvpn2'), 'naming what could not be found');
  });

  it('a pad that cannot be inspected is checked:false, never a verdict about the peer', async () => {
    // Finding 1d: a field nobody could compute must not read like a field that
    // says "broken" — and, far worse, must not read like "ok".
    const vm = require('../services/vm-manager');
    const { run } = fakeDocker({}); // the pad itself is not in the table
    const h = await vm.getNetworkHealth('pad-gone', { run });
    assert.strictEqual(h.checked, false, 'we did not compute an answer');
    assert.notStrictEqual(h.state, 'ok', 'and definitely not "ok"');
    assert.ok(h.reason, 'with a reason');
  });

  it('every non-ok state carries a reason — no state is ever a shrug', async () => {
    const vm = require('../services/vm-manager');
    const cases = [
      [{ 'pad-x': { name: 'pad-x', state: 'running', netMode: 'container:deadid' } }, 'gluetun-nordvpn2', 'stale'],
      [{ 'pad-x': { name: 'pad-x', state: 'running', netMode: 'container:deadid' }, g: { name: 'g', state: 'exited' } }, 'g', 'peer-stopped'],
      [{ 'pad-x': { name: 'pad-x', state: 'running', netMode: 'container:deadid' } }, '', 'stale'],
    ];
    for (const [table, peer, expected] of cases) {
      const { run } = fakeDocker(table);
      const h = await vm.getNetworkHealth('pad-x', { declaredPeer: peer, run });
      assert.strictEqual(h.state, expected, `state for declaredPeer=${peer || '(none)'}`);
      assert.ok(h.reason && h.reason.length > 10, `a reason is present for state=${h.state}`);
    }
  });

  it('a bind mount of the peer is NOT disturbed: this is about liveness, not addressing', async () => {
    // Plan 59 owns subnet reservations. The one guard worth pinning here is that
    // the peer lookup keys on the container, never on a network name, so a pad
    // with a reserved-but-absent subnet is unaffected by this change.
    const vm = require('../services/vm-manager');
    const { run, calls } = fakeDocker({
      ...peerPad('peer1'),
      'gluetun': { name: 'gluetun', id: 'peer1', state: 'running' },
    });
    const h = await vm.getNetworkHealth('pad-peer', { declaredPeer: 'gluetun', run });
    assert.strictEqual(h.state, 'ok');
    assert.ok(!calls.some((c) => /network|subnet|_default/.test(c)), 'no network/subnet object is ever inspected');
  });
});

describe('network peer truth — the states the UI must react to (plan 66)', () => {
  // A NEW state the Settings tab does not know about is a pad that silently
  // stops warning — the banner keys off an explicit list, so forgetting the
  // new value is a regression that no backend test can see.
  const SRC = path.join(__dirname, '..', 'client', 'src', 'pages', 'agent', 'SettingsTab.jsx');

  it('the banner fires for staleBinding as well as stale and peer-stopped', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.match(src, /networkStaleBinding = networkHealth\.state === 'staleBinding'/, 'the new state is recognized');
    assert.match(
      src,
      /networkBroken = networkStale \|\| networkStaleBinding \|\| networkPeerStopped/,
      'and counts as broken, so a stale binding still offers the recreate'
    );
  });

  it('the recreate button is offered for a stale binding too', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    // `\(` is a LITERAL paren: the JSX reads `{(networkStale || networkStaleBinding) && (`,
    // and an unescaped capture group here matches something that is not there.
    assert.match(src, /\{\(networkStale \|\| networkStaleBinding\) && \(/, 'the fix is reachable from the new state');
  });

  it('an UNREADABLE answer raises the banner, without offering a fix', () => {
    const src = fs.readFileSync(SRC, 'utf8');
    assert.match(src, /networkUnchecked = networkHealth\.checked === false/,
      '`checked: false` is recognized as its own thing, not as health');
    assert.match(src, /networkBroken = networkStale \|\| networkStaleBinding \|\| networkPeerStopped \|\| networkUnchecked/,
      'and counts as broken, so we never read silence as a healthy pad');
    // The recreate button is keyed OFF the two diagnosed states, so an
    // unreadable answer cannot reach it. An unreadable probe has established
    // NOTHING, and a button that says "recreate" is advice nobody can justify.
    assert.doesNotMatch(src, /\(networkStale \|\| networkStaleBinding \|\| networkUnchecked\) && \(/,
      'the recreate button must not widen to the unchecked state');
    // The body must quote the REASON: an unexplained warning is a shrug.
    assert.match(src, /networkHealth\.reason/, 'the banner explains why it could not check');
  });

  it('the file PARSES — a regex pin cannot see a syntax error', () => {
    // Plan 66 shipped a SettingsTab.jsx with the comma that ends the `message:`
    // template literal in handleRecreateNetwork missing, so the committed file
    // did not parse at all. Nothing caught it: every other test in this file is
    // a source-text regex, `node --check` does not accept JSX, and the browser
    // serves the PREBUILT src/public bundle, which was built from the (valid)
    // worktree. A green suite proved only that the file contained some strings.
    //
    // esbuild parses without emitting, so nothing is written to src/public —
    // `npm run build` is not an option here, it wipes that directory. It lives
    // in the CLIENT's node_modules, not the server's, so it is resolved by path
    // rather than by a bare require that would throw at load time.
    const { createRequire } = require('node:module');
    const clientRequire = createRequire(
      path.join(__dirname, '..', 'client', 'package.json')
    );
    const esbuild = clientRequire('esbuild');
    try {
      esbuild.buildSync({
        entryPoints: [SRC],
        loader: { '.jsx': 'jsx' },
        bundle: false,
        write: false,
        logLevel: 'silent',
      });
    } catch (e) {
      const first = (e.errors || [])[0];
      assert.fail(
        `SettingsTab.jsx does not parse${first ? ` at ${first.location.line}:${first.location.column} — ${first.text}` : ''}`
      );
    }
  });

  it('the banner does not tell the user to start a peer that is already running', () => {
    const settings = fs.readFileSync(SRC, 'utf8');
    assert.ok(/is up and needs nothing/.test(settings), 'the stale-binding copy says the PEER is fine');
    // The hint text moved into the shared rule (net-peer.js) when the health
    // check was rewired to classify through it. Assert the FACT where it now
    // lives — the UI and the health check both read this one reason.
    const rule = fs.readFileSync(path.join(__dirname, '..', 'services', 'net-peer.js'), 'utf8');
    assert.ok(/needs nothing/.test(rule), 'the stale-binding reason says the peer needs nothing');
    // …and the health check must surface it, not swallow it into a bare 'recreate'.
    const health = fs.readFileSync(path.join(__dirname, '..', 'services', 'container-health.js'), 'utf8');
    assert.match(health, /hint: verdict\.state === 'ok' \? undefined : verdict\.reason/,
      'the health hint is the rule\'s reason verbatim');
    assert.match(health, /peerName: verdict\.peerName,/, 'and the check carries the peer facts');
  });
});

describe("network peer truth — readSettings' answer (plan 66)", () => {
  it('a THROWN probe never becomes state "ok"', () => {
    // The other silent-failure site: readSettings caught and discarded the
    // error, leaving the default `{ state: 'ok' }`. An unreadable answer must
    // not read as the one healthy state there is.
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'vm-manager.js'), 'utf8');
    assert.ok(
      /networkHealth = \{ state: 'none', checked: false, reason: `network health probe failed/.test(src),
      'a failed probe is reported as unchecked, not swallowed into ok'
    );
    assert.doesNotMatch(
      src,
      /let networkHealth = \{ state: 'ok' \}/,
      'the default must not be the healthy state'
    );
  });

  it('readSettings passes the declared peer name, so the lookup is total', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'vm-manager.js'), 'utf8');
    assert.match(
      src,
      /getNetworkHealth\(name, \{ declaredPeer: meta\.NETWORK \|\| '' \}\)/,
      'without the name there is no fallback and a live peer reads as unnameable'
    );
  });
});
