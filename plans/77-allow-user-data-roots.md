# Plan 77 — Allow `/home`, `/root`, `/mnt` as bare workspace/volume sources

## Status: Complete (4/4 items) — verified live, absorbing into docs

## Problem (reported live)

Recreating `pad-opencode-proj` after changing its network
(`NETWORK=gluetun-nordvpn2`) fails with:

```
Applying changes: network=gluetun-nordvpn2
Cannot use a whole home folder (/mnt) as a host source — pick a project folder inside it, e.g. /mnt/my-project
```

The pad has a **stored** extra volume `{"host":"/mnt","container":"/mnt"}`.
`applyAgentChanges` → `prepareAgentChanges` re-validates the whole extra-volume
list (the Settings form resubmits it verbatim), and plan 72 put `/mnt` in the
`HOST_USER_DATA` bare-root-refused list — so a change unrelated to volumes is
blocked by a guard that now refuses an existing, working mount. This is the exact
class of failure plan 72 *explicitly avoided* for `/www1` ("it would have made a
recreate of a working pad fail").

User instruction: allow **`/home`**, **`/root`**, and **`/mnt`** as sources
(including bare).

## Fix

Drop `/home`, `/root`, `/mnt` from `HOST_USER_DATA`. They are data / home roots
the operator mounts whole on this host; the remaining bare-root guard keeps
`/opt`, `/tmp`, `/srv`, `/data` (still refused bare, subdirs fine).

## Checklist

- [x] 1. `src/services/workspace-guards.js` — `HOST_USER_DATA = ['/opt','/tmp','/srv','/data']` + comment
- [x] 2. `src/client/src/lib/workspace-guards.js` — same list (the two must not drift)
- [x] 3. `src/test/workspace-guards.test.js` — repoint bare-root exemplars to `/opt`; add a positive test that `/home`/`/root`/`/mnt` are accepted
- [x] 4. `docs/reference/overview/business-logic.md` — update the policy table
- [x] Verify: workspace-guards suite 16/16 green; control reds tests 3 & 11 with the old list; live on `pad-opencode-proj` the network settings apply returns 200 (no recreate) with `/mnt` accepted, and the Settings form accepts `/mnt/` but still refuses `/opt/`

## Absorb

Into `docs/reference/overview/business-logic.md` (§ Which host paths may be a
workspace source) — the plan file is deleted after.
