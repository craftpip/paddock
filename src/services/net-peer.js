'use strict';

const { execFile } = require('child_process');

/** The default `run`, so a caller that just wants the answer does not have to
 *  supply one. Each service had its own copy of this, which is how the health
 *  check ended up calling the lookup with no runner at all and reading every
 *  peer as absent — a silent `null` that looked exactly like a dead peer. */
function defaultRun(cmd, args, { timeout } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// One answer to one question: is this pad's network peer healthy, and if not,
// WHICH THING is wrong — the peer, or only our binding to it?
//
// Plan 66. This rule used to be written twice, from two different inputs (the
// live container's NetworkMode vs the compose file's `network_mode`), and the two
// copies could disagree. Two answers to one question is the bug, so the answer
// lives here once and both consumers classify through it.
//
// The states are deliberately distinct problems, because only one of them needs
// the peer touched:
//
//   ok             default network, or bound to a running peer
//   staleBinding   the peer is RUNNING and needs nothing; only this pad is
//                  bound to an older, deleted peer container
//   peer-stopped   the named peer exists but is not running
//   stale          no peer we can name exists at all
//
// A `null` peer means "this reference did not resolve" — which is a fact about
// the peer, NOT about our ability to look. A caller that could not look at all
// must not use this module's states; it reports `checked: false` instead.

/** `docker inspect` one container by NAME or ID, reduced to what the network
 *  rule needs. Never throws: an unresolvable reference and a failed daemon look
 *  alike here, and both mean "no peer of that reference" — which is why the
 *  caller that cannot inspect the PAD ITSELF must be kept separate.
 *
 *  Pass `{ run }` to drive it from a test. */
async function inspectPeer(ref, { run = defaultRun } = {}) {
  if (!ref) return null;
  try {
    const r = await run('docker', ['inspect', ref, '--format', '{{.Name}}|{{.Id}}|{{.State.Status}}'], { timeout: 15000 });
    const [name, id, state] = (r.stdout || '').split('|');
    const n = (name || '').replace(/^\//, '');
    const st = (state || '').trim().toLowerCase();
    if (!n || !st) return null;
    return { name: n, id: (id || '').trim(), state: st };
  } catch {
    return null;
  }
}

const short = (id) => (id && id.length > 12 ? `${id.slice(0, 12)}…` : id || '');

/**
 * Classify a pad's network peer. Pure: it decides nothing about docker itself,
 * it only rules on the two lookups it is handed.
 *
 * @param {string} mode      the pad's live `HostConfig.NetworkMode` ('' = default)
 * @param {object|null} bound   the peer the pad is ACTUALLY bound to, by the ref in `mode`
 * @param {string} declaredRef  the peer NAME the pad is configured with (may differ from `mode`)
 * @param {object|null} declared that named peer, resolved
 */
function classifyNetworkPeer({ mode = '', bound = null, declaredRef = '', declared = null } = {}) {
  const base = { networkMode: mode || 'default', peerId: '', peerName: '', peerState: '', peerCurrentId: '', staleBinding: false, checked: true };

  if (!mode || mode === 'default' || !mode.startsWith('container:')) {
    return { ...base, state: 'ok' };
  }

  const boundRef = mode.slice('container:'.length).trim();
  base.peerId = boundRef;

  const named = declared || null;

  // 1. The ref we are bound to resolves. Then we know the peer by identity, and
  //    the only remaining question is whether it is the peer we MEANT.
  if (bound) {
    base.peerName = bound.name;
    base.peerState = bound.state;
    base.peerCurrentId = bound.id;
    if (bound.state !== 'running') {
      return {
        ...base,
        state: 'peer-stopped',
        reason: `The network peer '${bound.name}' is ${bound.state}, not running. Start it, then recreate this pad to rebind.`,
      };
    }
    if (named && named.id && bound.id && named.id !== bound.id) {
      // Running, but it is NOT the configured peer. Recreating the peer would
      // change nothing; the binding is what has to move.
      //
      // Report the CONFIGURED peer as the name/state/peerCurrentId: that is the
      // one the pad is supposed to be on, so it is the rebind target and the
      // thing a caller should read. Leaving peerCurrentId pointing at the
      // container we are wrongly bound to makes `peerId !== peerCurrentId` read
      // as EQUAL — i.e. the rule would report a mismatch it cannot show.
      return {
        ...base,
        state: 'staleBinding',
        staleBinding: true,
        peerName: named.name,
        peerState: named.state,
        peerCurrentId: named.id,
        reason: `This pad is bound to network container '${short(boundRef)}' (${bound.name}, running), but it is configured for the different peer '${named.name}'. Recreate to rebind to '${named.name}'.`,
      };
    }
    return { ...base, state: 'ok' };
  }

  // 2. The bound ref is gone. That is a fact about the BINDING — so before
  //    calling the pad broken, ask the configured peer whether it is fine.
  if (named) {
    base.peerName = named.name;
    base.peerState = named.state;
    base.peerCurrentId = named.id;
    if (named.state === 'running') {
      return {
        ...base,
        state: 'staleBinding',
        staleBinding: true,
        reason: `Bound to peer container '${short(boundRef)}', which no longer exists, but the configured peer '${named.name}' IS running and needs nothing. Recreate to rebind.`,
      };
    }
    return {
      ...base,
      state: 'peer-stopped',
      reason: `Bound to peer container '${short(boundRef)}', which no longer exists, and the configured peer '${named.name}' is ${named.state}, not running. Start it, then recreate to rebind.`,
    };
  }

  // 3. Nothing we can name. Say THAT, rather than implying the peer is unwell.
  return {
    ...base,
    state: 'stale',
    reason: declaredRef
      ? `The network peer '${declaredRef}' does not exist on this host, and this pad is still bound to the deleted container '${short(boundRef)}'. Create or start that peer, or pick another one.`
      : `This pad is bound to network container '${short(boundRef)}', which no longer exists, and no peer is configured to fall back on. Recreate to return it to the default network.`,
  };
}

module.exports = { inspectPeer, classifyNetworkPeer };
