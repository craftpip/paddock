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
 *  rule needs. Pass `{ run }` to drive it from a test.
 *
 *  Three answers, not two, and the third is the one that is easy to lose: a
 *  reference that does not exist, a reference that resolved, and a lookup that
 *  FAILED are three different facts. Returning `null` for a daemon error made an
 *  unreachable docker read as a dead peer — the same class of bug as the
 *  unrunnable probe that read as a healthy pad, pointing the other way. So an
 *  error is reported as an error, and the rule (not this lookup) decides what a
 *  caller should do about a reference it could not resolve. */
async function inspectPeer(ref, { run = defaultRun } = {}) {
  if (!ref) return null;
  try {
    const r = await run('docker', ['inspect', ref, '--format', '{{.Name}}|{{.Id}}|{{.State.Status}}'], { timeout: 15000 });
    const [name, id, state] = (r.stdout || '').split('|');
    const n = (name || '').replace(/^\//, '');
    const st = (state || '').trim().toLowerCase();
    if (!n || !st) return null;
    return { name: n, id: (id || '').trim(), state: st };
  } catch (e) {
    // `docker inspect` exits non-zero both for "no such container" and for a
    // dead daemon / permission error, and the first is a fact about the peer
    // while the second is a fact about us. Only the first is a null; anything
    // else is returned so a caller can report "could not look" instead of
    // "not there".
    const msg = `${(e && e.message) || e} ${(e && e.stderr) || ''}`.toLowerCase();
    if (/no such (object|container|image)|is not a|not found/.test(msg)) return null;
    return { error: (e && e.message) || String(e) };
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

  // A lookup that FAILED is not a peer that is absent. We may still have the
  // other reference to fall back on, so only give up on the whole answer when
  // every lookup we tried errored — and then say `checked: false`, because a
  // pad we could not look at is not a healthy pad.
  const lookedAt = [bound, declared].filter(Boolean);
  if (lookedAt.length && lookedAt.every((p) => p.error)) {
    return {
      ...base,
      state: 'unknown',
      checked: false,
      reason: `Could not read this pad's network peer: ${lookedAt[0].error}`,
    };
  }
  // One reference resolved, the other could not be read: keep going on the one
  // we have, since a resolvable peer is a fact we can act on.
  const usable = (p) => (p && !p.error ? p : null);

  const named = usable(declared);
  const live = usable(bound);

  // 1. The ref we are bound to resolves. Then we know the peer by identity, and
  //    the only remaining question is whether it is the peer we MEANT.
  if (live) {
    base.peerName = live.name;
    base.peerState = live.state;
    base.peerCurrentId = live.id;
    if (live.state !== 'running') {
      return {
        ...base,
        state: 'peer-stopped',
        reason: `The network peer '${live.name}' is ${live.state}, not running. Start it, then recreate this pad to rebind.`,
      };
    }
    if (named && named.id && live.id && named.id !== live.id) {
      // Running, but it is NOT the configured peer. Recreating the peer would
      // change nothing; the binding is what has to move.
      //
      // Report the CONFIGURED peer as the name/state/peerCurrentId: that is the
      // one the pad is supposed to be on, so it is the rebind target and the
      // thing a caller should read. Leaving peerCurrentId pointing at the
      // container we are wrongly bound to makes `peerId !== peerCurrentId` read
      // as EQUAL — i.e. the rule would report a mismatch it cannot show.
      //
      // …and which fix that is depends on the CONFIGURED peer's state, not the
      // bound one's. A peer that is up needs nothing and a recreate is the whole
      // fix (`staleBinding`); a peer that is DOWN must be started FIRST, or the
      // recreate moves this pad onto a stopped peer and the pad still cannot
      // start. The bound container running is not evidence that the target runs,
      // so the states are chosen on the target and not on what we are attached to.
      if (named.state !== 'running') {
        return {
          ...base,
          state: 'peer-stopped',
          peerName: named.name,
          peerState: named.state,
          peerCurrentId: named.id,
          reason: `This pad is bound to network container '${short(boundRef)}' (${live.name}, running), but it is configured for the different peer '${named.name}', which is ${named.state}. Start '${named.name}' first, then recreate to rebind.`,
        };
      }
      return {
        ...base,
        state: 'staleBinding',
        staleBinding: true,
        peerName: named.name,
        peerState: named.state,
        peerCurrentId: named.id,
        reason: `This pad is bound to network container '${short(boundRef)}' (${live.name}, running), but it is configured for the different peer '${named.name}', which is running and needs nothing. Recreate to rebind to '${named.name}'.`,
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

  // 3. One lookup resolved nothing and the other could not be read — or there
  //    was no fallback at all. Say THAT, rather than implying the peer is unwell.
  const failed = lookedAt.find((p) => p.error);
  if (failed) {
    return {
      ...base,
      state: 'unknown',
      checked: false,
      reason: `This pad is bound to a network peer that could not be read (${failed.error}), so its state is unknown.`,
    };
  }
  return {
    ...base,
    state: 'stale',
    reason: declaredRef
      ? `The network peer '${declaredRef}' does not exist on this host, and this pad is still bound to the deleted container '${short(boundRef)}'. Create or start that peer, or pick another one.`
      : `This pad is bound to network container '${short(boundRef)}', which no longer exists, and no peer is configured to fall back on. Recreate to return it to the default network.`,
  };
}

module.exports = { inspectPeer, classifyNetworkPeer };
