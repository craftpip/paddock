# Plan 66 — Network peer truth: `networkHealth` says "stale" and "running" in the same breath

## Status: Complete (2026-09-29) — 4/4 build items done, 3/3 verify items done. Absorbed into `docs/reference/backend/services.md` (§ Network peer truth) + AGENTS.md. Source: `friction/2026-09-28-pm-portfolio-intake.md` (2 guessing entries) + the `availableNetworks` half of `2026-09-27-craftpip-status.md` (the cap/searchability half lives in plan 61 §1c).

A peer-networked PAD is the one case where the answer to "is this pad reachable?"
depends on something outside the pad. Today the surface reports a verdict it cannot
support, and the only way to reach the answer is to attempt work and read the error.

## 1. The findings

### 1a. `networkHealth` reports `state: "stale"` for a peer the same response calls `running` (guessing)

`settings_get` returns `networkHealth: { state: "stale", peerName: "", peerState: "" }`
for a pad whose peer is up — while `availableNetworks` in the same response lists
that peer as running. The caller cannot tell a dead peer from a naming failure, and
`stale` is the hard-blocked condition, so the pad reads as broken when it is not.

**Fix:** resolve `peerName` / `peerState` from the same lookup that builds
`availableNetworks` instead of returning empty strings, and make `state` agree with
it — if the named peer resolves and is running, `state` is not `stale`. If the
staleness is about the **bound ID** differing from the current peer ID, say so
(`staleBinding`, plus both names) rather than reporting the peer as unnameable.

### 1b. No tool reports whether a pad's network peer is alive (guessing)

`health`'s own hint — *"Recreate to rebind"* — is an **unverifiable instruction**:
the caller has no way to check the condition it applies to.

**Fix:** add a `peerState` (and the resolved `peerName`) to the `network` check in
`health`, e.g. `expected: container:gluetun-nordvpn2 (running)` / `actual:
container:7048372a… (gone)`, so the hint is actionable where it is read. Failing
that, make the hint state its own condition: *"Recreate to rebind — the declared peer
`gluetun-nordvpn2` is running"* vs *"…is not running; start or recreate the peer
first."*

### 1c. The cap hides the container a caller asked about (blocker) — **split**

The search half (`networkFilter` on `settings_get`, non-VPN containers first) is
**plan 61 §1c**. Recorded here so this file is not read as a stub.

### 1d. A dead pad with a live peer still reports `networkHealth: stale` (guessing)

The converse of 1a, recorded by the 2026-09-29 sessions against
`pad-opencode-paddock-dev` (exited, `peerName`/`peerState` empty — "the hard-blocked
condition"). Two findings, one root cause: **the field is computed from a lookup that
is allowed to fail silently**, and a silent failure and a real failure look
identical.

**Fix:** `networkHealth` carries a `checked: boolean` (or an explicit
`reason: "peer not resolvable"`), so a field nobody could compute is never
indistinguishable from a field that says "broken".

## 2. Build

- [x] Find the `networkHealth` computation and make its lookup total: a peer that
      resolves is named, running or not; a peer that does not resolve says so.
      **`src/services/net-peer.js`** — `inspectPeer(ref)` (name OR id, never
      throws) + a pure `classifyNetworkPeer()`. `getNetworkHealth` passes the pad's
      meta `NETWORK` as the declared name, so a dead bound id is no longer the end
      of the lookup. `readSettings` no longer swallows a thrown probe into its
      `{ state: 'ok' }` default: an uninspectable pad is `state: 'none',
      checked: false`.
- [x] `state` derives from that single answer. One computation, three consumers
      (`settings_get`, `health`, `list_agents` if it shows health).
      **One computation, two consumers** — `list_agents` carries no health at all
      (checked), so `classifyNetworkPeer()` is the single rule behind
      `vm-manager.getNetworkHealth` AND `container-health`'s network check. The
      health service used to re-implement the rule from the compose file's
      `network_mode` while settings read the live `NetworkMode`; two inputs, two
      copies, free to disagree. `net-peer.test.js` pins the rule once (12 cases).
- [x] `health`'s network check carries `peerName` + `peerState`, and the hint is
      conditional on it. The check is the shared verdict plus health's own
      presentation (`staleBinding` → **warn**, not error: recreating the PEER would
      change nothing). The hint IS the rule's `reason`, verbatim — the test asserts
      the wiring, not a copy of the sentence.
- [x] The subnet-collision semantics (plan 59) must not be disturbed: a *reservation*
      is not a live network, and `ensurePadSubnet` returns empty when a live
      `<name>_default` network already exists. That is about addressing, not peer
      liveness — keep the two apart.
      `net-peer.js` touches no network or subnet object: it inspects CONTAINERS
      only, pinned by a test that fails if any `inspect` argument matches
      `/network|subnet|_default/`. No `ensurePadSubnet`/`writeInstanceCompose`
      change.

## 3. Verify

- [x] `timeout 60 docker exec paddock node --test test/container-health.test.js` green
      — **9/9**, plus `net-peer` 14/14, `network-peer-truth` 13/13, `vm-manager`
      111/111, `mcp` 134/134. Mutation controls: collapsing the `staleBinding`
      branch turns **2 tests red across 2 suites**, restoring turns them green.
- [x] Live: `settings_get` on a peer-networked pad returns a named peer and a `state`
      that agrees with `peerState`; on a default-networked pad it returns
      `state: "ok"` (or equivalent) rather than a silent `stale`.
      **The finding reproduced on the real fleet, on 3 of 5 peer-networked pads**
      (`pad-opencode-aic`, `pad-proj2`, `pad-opencode-paddock-dev`): bound to a
      deleted peer id while the declared peer was **running**, and the old code
      said `stale` with `peerName: ""`/`peerState: ""`. Now `staleBinding` with
      the peer named. Two of the three are **exited** — docker's own reason is
      `joining network namespace of container: No such container`, i.e. the lie
      had a consequence: the pad could not start at all.
- [x] `health` on the same pad: the network check's `expected` names the peer, and
      the hint reads as a condition rather than an instruction.
      *"The network peer 'gluetun-nordvpn2' **IS running**, so the peer needs
      nothing — this container is simply bound to a different one. Recreate to
      rebind."* Both consumers AGREE on all 5 pads, checked as a pair.

## 4. Found while verifying, not asked for

- **`health` on a pad with no readable compose file threw** — `compose.restart` on
  a `null`, i.e. a `TypeError` reported to the caller in place of the container
  facts (running / health / image) it had just gathered. `paddock` hits it. It
  pre-dates this plan (reproduced against `HEAD`), but it is the same defect —
  a lookup that failed read as a fact — so the check now records the missing
  declaration and returns, and says which checks were skipped. Source-pinned
  (the function calls docker and cannot be exercised without it).
- **A lookup that never RAN is indistinguishable from an absent peer.** Wiring
  the health service to the shared rule initially called `inspectPeer(ref)` with
  no runner, and the old guard returned `null` for that — so all 5 pads read
  `stale`/`error` while 3 peers ran. The unit tests stayed green (they cover the
  pure classifier and `checkPublishedPorts`, not the docker path); only the live
  re-probe caught it. `inspectPeer` now defaults to a real runner, and a test
  asserts the default path reaches docker.
- **The UI is a fourth consumer, and it is where a new state silently dies.**
  `SettingsTab` keys the banner off an explicit list, so `staleBinding` needed
  adding there too; asserted on the source, and confirmed in the browser on a
  real stale pad.
