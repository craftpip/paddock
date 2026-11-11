/**
 * The PAD subnet pool: which /24 each PAD's default network gets, and which are taken.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  ensurePadSubnet, releasePadSubnet, pickFreePadSubnet, padPoolOctet, usedPadSubnetOctets,
  reservedPadSubnetOctets, claimedPadSubnetOctets,
});

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { INSTANCES_DIR, readMeta, dockerNetworkExists, setMetaFlag } = require('./internal');

/** Pad `default`-network subnet pool: 10.200.0.0/16 carved into /24s (256
 *  pads). Deliberately disjoint from the daemon's default address pools
 *  (172.16.0.0/12, 192.168.0.0/16) and the office LAN (10.69.0.0/16). The
 *  daemon only hands out subnets from its pools when a compose leaves the
 *  subnet unspecified — once a pool is fully subnetted, creating ANY new
 *  bridge network fails with `all predefined address pools have been fully
 *  subnetted`. Declaring an explicit subnet in each generated compose
 *  sidesteps the pools entirely. */
const PAD_SUBNET_POOL = '10.200.0.0/16';
const PAD_SUBNET_PREFIX = 24;

/** Third octets of 10.200.x.0/24 already claimed by existing Docker networks,
 *  so a fresh pad never collides with another pad or an unrelated project. */
function usedPadSubnetOctets() {
  const used = new Set();
  let ids = [];
  try {
    const r = execFileSync('docker', ['network', 'ls', '-q'], { stdio: 'pipe', timeout: 15000 });
    ids = r.toString().trim().split('\n').filter(Boolean);
  } catch {
    return used;
  }
  const re = /(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)/g;
  for (const id of ids) {
    try {
      const r = execFileSync('docker', ['network', 'inspect', id, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'], { stdio: 'pipe', timeout: 10000 });
      let m;
      while ((m = re.exec(r.toString())) !== null) {
        const oct = padPoolOctet(m[0]);
        if (oct !== null) used.add(oct);
      }
    } catch {}
  }
  return used;
}

/** The pool octet a subnet string occupies (`10.200.7.0/24` → 7), or null when
 *  the value is outside the pad pool (a legacy network's own subnet — a value
 *  this pool never hands out and never re-picks). */
function padPoolOctet(subnet) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(String(subnet || '').trim());
  if (!m) return null;
  if (+m[1] !== 10 || +m[2] !== 200 || +m[5] !== PAD_SUBNET_PREFIX) return null;
  return +m[3];
}

/** Third octets reserved by OTHER instance dirs' persisted `SUBNET`. A
 *  reservation is NOT a live network: a pad that has never been started on the
 *  default network (a peer-networked pad, or one whose network was never
 *  created) holds a /24 on paper only. Counting live Docker networks alone
 *  therefore hands the same octet out twice, and the second pad only discovers
 *  it when compose finally tries to create the network —
 *  `Pool overlaps with other one on this address space`. Union both sources so
 *  an octet is unique whether or not its network exists yet. */
function reservedPadSubnetOctets(exclude) {
  const used = new Set();
  let entries = [];
  try {
    entries = fs.readdirSync(INSTANCES_DIR, { withFileTypes: true });
  } catch {
    return used;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === exclude) continue;
    // A hidden dir is not a pad — `STALE_DOOR_DIR` (the stale-door sweep's
    // parking lot) lives here, and a reservation parked in it must never count.
    if (e.name.startsWith('.')) continue;
    const oct = padPoolOctet(readMeta(path.join(INSTANCES_DIR, e.name)).SUBNET);
    if (oct !== null) used.add(oct);
  }
  return used;
}

/** Pool octets claimed by anything other than `name` — both sources at once. */
function claimedPadSubnetOctets(name) {
  const used = usedPadSubnetOctets();
  for (const oct of reservedPadSubnetOctets(name)) used.add(oct);
  return used;
}

/** The lowest free /24 in the pad pool, or '' when the pool is full. */
function pickFreePadSubnet(exclude) {
  const used = claimedPadSubnetOctets(exclude);
  for (let oct = 0; oct < 256; oct++) {
    if (!used.has(oct)) return `10.200.${oct}.0/${PAD_SUBNET_PREFIX}`;
  }
  return '';
}

/** Ensure this pad's compose declares a concrete subnet for its `default`
 *  bridge network, and return the subnet (or '' when the compose should stay
 *  subnet-less).
 *
 *  Only a pad with a service on the project default network needs one — a
 *  peer-networked pad's service is `network_mode: container:<peer>` and its socat
 *  door rides the peer's own network, so nothing joins `default` and no
 *  reservation should be taken (that unused reservation is what used to collide
 *  when such a pad switched TO the default network). `releasePadSubnet`
 *  drops the stale value.
 *
 *  A pad that DOES need one keeps its value when it is still free, and a
 *  colliding reservation is re-picked — but never while a live
 *  `<name>_default` network pins it, because declaring a different subnet for
 *  an existing network forces a disruptive network recreate.
 *
 *  `networkExists` is injected so the unit tests never need a real Docker
 *  network; production always uses the real probe. */
function ensurePadSubnet(name, { networkExists = dockerNetworkExists } = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  if (!fs.existsSync(instDir)) return '';
  const meta = readMeta(instDir);
  const hasLiveNetwork = networkExists(`${name}_default`);
  if (meta.SUBNET) {
    if (hasLiveNetwork) return meta.SUBNET;
    const oct = padPoolOctet(meta.SUBNET);
    if (oct === null || !claimedPadSubnetOctets(name).has(oct)) return meta.SUBNET;
    // A stale duplicate (another pad holds it on paper, or a live network
    // already owns it): fall through and re-pick.
  } else if (hasLiveNetwork) {
    // A legacy pad whose default network Docker already owns (created before
    // the pool existed) — leave the compose subnet-less rather than force a
    // change on a live network.
    return '';
  }
  const subnet = pickFreePadSubnet(name);
  if (!subnet) {
    throw new Error(`The pad subnet pool (${PAD_SUBNET_POOL}) is exhausted — every /24 is taken. Delete a pad to free one, or extend the pool.`);
  }
  setMetaFlag(name, 'SUBNET', subnet);
  return subnet;
}

/** Drop this pad's /24 reservation — for a compose whose services join no
 *  project default network, so it can never be handed to somebody else and
 *  collide later. Refuses while a live `<name>_default` network still uses the
 *  subnet (the value stays the pad's, it just isn't re-declared). */
function releasePadSubnet(name, { networkExists = dockerNetworkExists } = {}) {
  if (networkExists(`${name}_default`)) return false;
  if (!readMeta(path.join(INSTANCES_DIR, name)).SUBNET) return false;
  setMetaFlag(name, 'SUBNET', '');
  return true;
}
