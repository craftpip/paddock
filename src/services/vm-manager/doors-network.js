/**
 * Network peers and the socat door containers that publish a peer-networked
 * PAD's ports.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  recreateServices, doorName, getPeerNetworkName, currentNetworkPeer, startDoors, stopDoors,
  getNetworkHealth, removeDoors, syncDoors, isManagedDoorContainer, cleanStaleDoorDirs,
  staleDoorDirActions, isSocatDoorContainer, listDoors, doorPorts, desiredDoors, listContainers,
  listNetworkPeers, selectNetworkPeers, isManagedDoorName,
});

const fs = require('fs');
const path = require('path');
const { ensureOwned, mkdirOwned } = require('../ownership');
const { inspectPeer, classifyNetworkPeer } = require('../net-peer');
const {
  runCmd, readMeta, INSTANCES_DIR, AGENT_TYPES, VM_NAME_RE, WEBUI_CONTAINER,
} = require('./internal');
const { readSshCport, readExtraPorts, runCompose } = require('./compose');
const { readWebService } = require('./web');
const { psStateMap, psNames } = require('./lifecycle');

/** Health of an agent's network_mode. When an agent routes through another
 *  container (e.g. gluetun) via `network_mode: container:<peer>`, Docker
 *  records the peer as a container ID at create time. If that peer is later
 *  recreated (gluetun rebuild/restart), the recorded ID dies and `docker
 *  start` fails with "cannot join network namespace ... No such container".
 *
 *  The bug this is shaped around (plan 66): the bound ID is not the only way to
 *  ask about the peer. A pad bound to a DEAD id whose *declared* peer is alive
 *  and running is a healthy peer with a stale binding — a different problem
 *  from a peer that is gone, and reporting the second as the first tells the
 *  caller to recreate something that does not need it while hiding that the
 *  other thing needs starting. So the declared name is the fallback lookup, and
 *  every answer carries `checked` + `reason`: a field nobody could compute must
 *  never read the same as a field that says "broken".
 *
 *  `declaredPeer` is the pad's meta `NETWORK` (the name compose points at). Pass
 *  it; without it the fallback cannot happen and a stale binding is reported as
 *  an unresolvable peer.
 *
 *  Returns:
 *    { state: 'none',         checked:false, reason } — the pad is not inspectable
 *    { state: 'ok',           checked:true,  networkMode }            — default network
 *    { state: 'ok',           checked:true,  peerName, peerState }    — live peer
 *    { state: 'staleBinding', checked:true,  … }  — peer is RUNNING; only our bound id is dead
 *    { state: 'peer-stopped', checked:true,  … }  — the named peer exists, not running
 *    { state: 'stale',        checked:true,  … }  — no peer we can name
 */
async function getNetworkHealth(name, { declaredPeer = '', run = runCmd } = {}) {
  let mode = '';
  try {
    const r = await run('docker', ['inspect', name, '--format', '{{.HostConfig.NetworkMode}}'], { timeout: 15000 });
    mode = (r.stdout || '').trim();
  } catch {
    // The pad's OWN container could not be inspected. That is not a verdict
    // about the peer at all, so it gets its own state: a caller must be able to
    // tell "I could not check" from "I checked and it is broken".
    return { state: 'none', networkMode: '', checked: false, reason: 'pad container not inspectable' };
  }

  // One rule, one place (net-peer.js), shared with the health check: the two
  // used to classify the same question from different inputs and could disagree.
  const boundRef = mode.startsWith('container:') ? mode.slice('container:'.length).trim() : '';
  const declared = declaredPeer ? await inspectPeer(declaredPeer, { run }) : null;
  return classifyNetworkPeer({
    mode,
    bound: await inspectPeer(boundRef, { run }),
    declaredRef: declaredPeer,
    declared,
  });
}

/** Container name of the single socat "door" that publishes a peer-networked
 *  agent's web app, SSH port, and additional ports on host ports. One container
 *  runs one socat process per published port. */
function doorName(name) {
  return `${name}-door`;
}

/** All host→container TCP ports a peer-networked agent needs forwarded through
 *  its door: the published web app, the SSH port (container 22), and each
 *  additional port. Empty when the agent is on the default network. */
function doorPorts(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  const ports = [];
  const webService = readWebService(name);
  if (webService?.hostPort) {
    ports.push({ hostPort: String(webService.hostPort), containerPort: String(webService.containerPort || 8080) });
  }
  if (meta.PORT) {
    ports.push({ hostPort: String(meta.PORT), containerPort: readSshCport(name) });
  }
  for (const p of readExtraPorts(name)) {
    ports.push({ hostPort: String(p.host), containerPort: String(p.container) });
  }
  return ports;
}

/** Socat "door" services the agent currently requires (peer mode only). There
 *  is exactly one door service per agent — it carries every published port.
 *  Shape: [{ service, ports: [{ hostPort, containerPort }] }], empty in
 *  default network mode. A port inside the peer's namespace belongs to this
 *  agent because it shares the peer's network stack. */
function desiredDoors(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name)) || {};
  if (!meta.NETWORK) return [];
  const ports = doorPorts(name);
  if (!ports.length) return [];
  return [{ service: doorName(name), ports }];
}

/** The agent and its peer-network forwarding door must be recreated together.
 * `--no-deps` deliberately excludes unrelated peer services, so include the
 * door explicitly or Compose leaves a missing/stopped door untouched. */
function recreateServices(name) {
  return [name, ...desiredDoors(name).map(({ service }) => service)];
}

/** Name of the docker network a peer container lives on (the door joins it so
 *  it can reach the peer by name). Empty when the peer is host-networked. */
async function getPeerNetworkName(peer) {
  try {
    const r = await runCmd('docker', ['inspect', peer, '--format', '{{json .NetworkSettings.Networks}}'], { timeout: 15000 });
    const nets = JSON.parse(r.stdout || '{}');
    return Object.keys(nets).find((k) => k !== 'host' && k !== 'none') || '';
  } catch {
    return '';
  }
}

/** Regex matching the socat door container name(s) of an agent — the current
 *  `<name>-door` plus the legacy `<name>-web` (renamed in the multi-port door
 *  refactor; old doors must be treated as this agent's too). */
function doorNameRe(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(${esc}-door|${esc}-web)$`);
}

/** A forwarding sidecar belongs to an existing parent PAD. A `-door` / `-web`
 * name is reserved while that parent exists, including stale legacy dirs. */
function isManagedDoorContainer(name) {
  const m = /^(.*)-(door|web)$/.exec(name);
  return !!m
    && fs.existsSync(path.join(INSTANCES_DIR, m[1], 'meta.env'));
}

/** List the agent's existing door container names (running or stopped). */
async function listDoors(name) {
  const re = doorNameRe(name);
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}'], { timeout: 30000 });
  return (r.stdout || '').split('\n').map((s) => s.trim()).filter((n) => n && re.test(n));
}

/** Start the agent's socat door(s) alongside the agent (Paddock Start/Restart).
 *  `docker start` is a no-op on an already-running door. Missing doors (default
 *  network) are ignored. */
async function startDoors(name) {
  for (const cname of await listDoors(name)) {
    await runCmd('docker', ['start', cname], { timeout: 30000 }).catch(() => {});
  }
}

/** Stop the agent's socat door(s) alongside the agent (Paddock Stop). */
async function stopDoors(name) {
  for (const cname of await listDoors(name)) {
    await runCmd('docker', ['stop', '-t', '10', cname], { timeout: 30000 }).catch(() => {});
  }
}

/** Effective network peer name of an agent — meta.NETWORK, falling back to the
 *  compose file (legacy agents predate the meta flag). Empty = default network. */
function currentNetworkPeer(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  if (meta.NETWORK) return meta.NETWORK;
  try {
    const cf = path.join(INSTANCES_DIR, name, 'docker-compose.yml');
    const m = /network_mode:\s*container:(\S+)/.exec(fs.readFileSync(cf, 'utf8'));
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/** Reconcile the socat door against what the agent currently declares (meta +
 *  web.json, peer mode only): drop an orphaned door container, then bring up
 *  the declared one with its full port set. Call AFTER the agent recreate when
 *  entering/staying in peer mode. The door is idempotent — an already-correct
 *  door is a no-op, and `forceRecreate` (network change) makes it pick up the
 *  new peer. */
async function syncDoors(name, { forceRecreate = false, log = () => {} } = {}) {
  const declared = desiredDoors(name);
  const declaredNames = new Set(declared.map((d) => d.service));
  const re = doorNameRe(name);
  const all = await psStateMap();
  for (const cname of Object.keys(all)) {
    if (re.test(cname) && !declaredNames.has(cname)) {
      log('system', `Removing orphaned ${cname} forwarding door`);
      await runCmd('docker', ['rm', '-f', cname], { timeout: 30000 }).catch(() => {});
    }
  }
  for (const d of declared) {
    const desc = d.ports.map((p) => `${p.hostPort}→${p.containerPort}`).join(', ');
    log('system', `Starting ${d.service} forwarding door (${desc})`);
    const args = ['up', '-d', '--no-deps'];
    if (forceRecreate) args.push('--force-recreate');
    args.push(d.service);
    await runCompose(name, args, { stream: true, onLog: log, timeout: 180000 });
  }
}

/** Drop the agent's socat door. Used when LEAVING peer mode: the door still
 *  holds the host ports the agent is about to publish directly, so it must be
 *  removed BEFORE the agent recreate or the port bind fails. */
async function removeDoors(name, log = () => {}) {
  const re = doorNameRe(name);
  for (const cname of await psNames()) {
    if (re.test(cname)) {
      log('system', `Removing ${cname} forwarding door`);
      await runCmd('docker', ['rm', '-f', cname], { timeout: 30000 }).catch(() => {});
    }
  }
}

/** Boot-time sweep: drop any <name>-door / <name>-web forwarding containers
 *  whose agent (instances/<name>) no longer exists. Door containers survive
 *  `removeVm` of the agent in older code, so a deleted agent's door keeps
 *  holding its host port forever and blocks other agents from reusing it. */
async function cleanOrphanDoors() {
  for (const cname of await psNames()) {
    const m = /^(.*)-(door|web)$/.exec(cname);
    if (!m) continue;
    // Never remove a real agent whose name happens to end in -door/-web.
    if (fs.existsSync(path.join(INSTANCES_DIR, cname))) continue;
    const base = m[1];
    if (fs.existsSync(path.join(INSTANCES_DIR, base))) continue;
    console.log(`[orphan-door] removing ${cname} (agent ${base} gone)`);
    await runCmd('docker', ['rm', '-f', cname], { timeout: 30000 }).catch(() => {});
  }
}

/** Where a stale door dir is parked instead of deleted. A hidden subdirectory of
 *  `instances/`, so every existing reader (the agents list, the subnet-pool
 *  reservation scan, the port-conflict scan, the build migration) skips it —
 *  none of them match a name outside the `pad-*` / `VM_NAME_RE` shape. */
const STALE_DOOR_DIR = '.stale-door-dirs';

/** Classify every instance dir that looks like a legacy socat door and say what
 *  to do with it: `{ action: 'quarantine' | 'skip', reason }`.
 *
 *  Doors used to be created as real PADs, so `instances/<pad>-door` directories
 *  survive their retirement. They are excluded from the agent list (no `AGENT=`
 *  line) but NOT harmless: each one carries a `docker-compose.yml` that the
 *  host-port scan reads and, worse, a `SUBNET=` reservation in `meta.env` that
 *  nothing frees — the same /24 then sits on two pads' books and the second
 *  one to actually create its `default` network fails with
 *  `Pool overlaps with other one on this address space`.
 *
 *  Every condition must hold, and anything ambiguous is skipped rather than
 *  guessed at:
 *   1. the name is `<parent>-door` / `<parent>-web` and `<parent>` is a REAL pad
 *      (its meta has an `AGENT=` line) — so a user pad that merely ends in
 *      `-door` is never touched;
 *   2. the dir's own meta has no `AGENT=` line;
 *   3. it holds NO agent data dir (a real pad always has its bind-mounted
 *      `<agent>/` data dir), so no user data is quarantined;
 *   4. the agents table has no row for it (`isRegisteredAgent`);
 *   5. if a CONTAINER of that name exists it is a managed socat door (its
 *      parent exists) running the socat image — that container is the parent
 *      pad's live door and stays; only the directory is swept.
 *
 *  `containerImages` is a { name: image } map so the decision is testable
 *  without Docker. */
function staleDoorDirActions({ instancesDir = INSTANCES_DIR, containerImages = {}, isRegisteredAgent = () => false, agentTypes = AGENT_TYPES } = {}) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(instancesDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    if (!VM_NAME_RE.test(name)) continue;
    const m = /^(.*)-(door|web)$/.exec(name);
    if (!m) continue;
    const parent = m[1];
    if (!VM_NAME_RE.test(parent)) continue;
    if (!readMeta(path.join(instancesDir, parent)).AGENT) {
      out.push({ name, action: 'skip', reason: 'no real parent pad' });
      continue;
    }
    const instDir = path.join(instancesDir, name);
    if (readMeta(instDir).AGENT) {
      out.push({ name, action: 'skip', reason: 'meta has an AGENT= line' });
      continue;
    }
    const dataDir = agentTypes.find((t) => fs.existsSync(path.join(instDir, t)));
    if (dataDir) {
      out.push({ name, action: 'skip', reason: `holds agent data dir ${dataDir}/` });
      continue;
    }
    if (isRegisteredAgent(name)) {
      out.push({ name, action: 'skip', reason: 'present in the agents table' });
      continue;
    }
    const image = containerImages[name];
    if (image && !isSocatDoorContainer(name, image)) {
      out.push({ name, action: 'skip', reason: `container of that name is not a socat door (${image})` });
      continue;
    }
    out.push({ name, action: 'quarantine', reason: image ? 'legacy door dir; container kept' : 'legacy door dir' });
  }
  return out;
}

/** A container named `<pad>-door` / `<pad>-web` is a forwarding sidecar when its
 *  parent PAD still exists and it runs the socat image. Anything else under that
 *  name is somebody's real container and must not be assumed disposable. */
function isSocatDoorContainer(name, image) {
  if (!isManagedDoorContainer(name)) return false;
  return /socat/i.test(String(image || ''));
}

/** Boot-time sweep: quarantine the legacy `<pad>-door` / `<pad>-web` instance
 *  dirs left over from when the forwarding door was created as a real PAD (see
 *  `staleDoorDirActions` for the guards). Quarantine, not `rm -rf`: the pad
 *  subnet reservation is released either way, and the dir can be inspected or
 *  put back. The socat CONTAINER of the same name is the parent pad's live door
 *  and is left alone.
 *
 *  Runs right after the orphan-door container sweep in app.js's boot block.
 *  `isRegisteredAgent` is injected so this service stays db-free. */
async function cleanStaleDoorDirs({ isRegisteredAgent = () => false, log = (m) => console.log(m) } = {}) {
  let containerImages = {};
  try {
    const r = await runCmd('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Image}}'], { timeout: 15000 });
    for (const line of (r.stdout || '').split('\n')) {
      const [n, img] = line.split('\t');
      if (n) containerImages[n.trim()] = (img || '').trim();
    }
  } catch {}
  const actions = staleDoorDirActions({ containerImages, isRegisteredAgent });
  const moved = [];
  for (const a of actions) {
    if (a.action === 'skip') {
      log(`[stale-door-dir] keeping instances/${a.name} (${a.reason})`);
      continue;
    }
    const from = path.join(INSTANCES_DIR, a.name);
    const to = path.join(INSTANCES_DIR, STALE_DOOR_DIR, a.name);
    try {
      mkdirOwned(path.join(INSTANCES_DIR, STALE_DOOR_DIR), { boundary: INSTANCES_DIR });
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(from, to);
      ensureOwned(to);
      moved.push(a.name);
      log(`[stale-door-dir] quarantined instances/${a.name} → instances/${STALE_DOOR_DIR}/${a.name} (${a.reason})`);
    } catch (err) {
      log(`[stale-door-dir] could not quarantine instances/${a.name}: ${err.message}`);
    }
  }
  return moved;
}

/** All containers (name, image, state) — the network-peer dropdown source
 *  (shared by `GET /api/containers` and the MCP `list_networks` tool). */
async function listContainers() {
  const r = await runCmd('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 15000 });
  const out = [];
  for (const line of (r.stdout || '').trim().split('\n')) {
    if (!line) continue;
    try {
      const c = JSON.parse(line);
      const name = Array.isArray(c.Names) ? String(c.Names[0] || '').replace(/^\//, '') : String(c.Names || c.ID || '').replace(/^\//, '');
      if (isManagedDoorContainer(name)) continue;
      out.push({
        name,
        image: c.Image || '',
        state: (c.State || '').toLowerCase(),
      });
    } catch {}
  }
  return out;
}

/** The containers that make sense as a NETWORK PEER for a pad, filtered and
 *  capped for the MCP `settings_get` tool.
 *
 *  `listContainers` returns the whole host's container list (the Settings-tab
 *  dropdown wants that), which is pure noise to an LLM choosing a peer: a pad
 *  joins another container's network namespace (`network_mode: container:<peer>`),
 *  so a peer must be a RUNNING container, and the paddock fleet itself is not
 *  something you route a pad through. We keep non-fleet containers, keep fleet
 *  containers that publish a port (a deliberately shared service), drop doors
 *  and the webui, and cap the list — an honest `truncated` + `total` beats
 *  silently showing 30 rows with no count. */
/** Pure peer selection, split out of `listNetworkPeers` so the filter is
 *  testable without a live `docker ps` and without depending on where the real
 *  instance dirs happen to live. `isFleetPad(name)` says "a PAD this project
 *  manages"; doors and the webui are always dropped. */
function selectNetworkPeers(containers, { limit = 10, currentPeer = '', isFleetPad = () => false, webuiContainer = WEBUI_CONTAINER, filter = '' } = {}) {
  const all = [];
  for (const c of containers) {
    if (!c) continue;
    const name = Array.isArray(c.Names) ? String(c.Names[0] || '') : String(c.Names || c.ID || '');
    const clean = name.replace(/^\//, '');
    if (!clean) continue;
    // A socat door (or legacy -web) is never a peer — it is part of a PAD.
    if (isManagedDoorName(clean)) continue;
    if (clean === webuiContainer || /paddock-webui/.test(c.Image || '')) continue;
    // A fleet pad is only a sensible peer if it publishes something; a bare
    // pad container is not a network anyone routes through.
    if (isFleetPad(clean) && !String(c.Ports || '').trim()) continue;
    // Filter on the FULL candidate list, before any cap is applied. Filtering
    // a truncated list and then reporting `searchedAll` is the same silent
    // maybe the 10-cap caused, just with a bigger number in front of it
    // (plan 61, 1c).
    if (filter && !clean.toLowerCase().includes(filter)) continue;
    all.push({ name: clean, image: c.Image || '', state: (c.State || '').toLowerCase(), isCurrent: clean === currentPeer });
  }
  if (filter) return { peers: all, total: all.length, truncated: false, searchedAll: true };
  return { peers: all.slice(0, limit), total: all.length, truncated: all.length > limit };
}

/** `<pad>-door` / `<pad>-web` belong to a PAD, not to the peer list. */
function isManagedDoorName(name) {
  return /-(door|web)$/.test(name);
}

async function listNetworkPeers({ limit = 10, currentPeer = '', filter = '' } = {}) {
  const r = await runCmd('docker', ['ps', '--format', '{{json .}}'], { timeout: 15000 });
  const containers = (r.stdout || '').trim().split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  });
  // A caller who already knows the container's name is asking "is THIS one a
  // valid peer?", not "show me ten". Truncating that answer turns a question
  // with a yes/no answer into a silent maybe (plan 61, 1c), so a filter searches
  // the WHOLE candidate list and skips the cap entirely. The filter is applied
  // inside `selectNetworkPeers`, before any limit — widening the limit instead
  // would still be a cap, and `searchedAll` would be a lie past it.
  return selectNetworkPeers(containers, {
    limit,
    currentPeer,
    filter: String(filter || '').toLowerCase(),
    isFleetPad: (n) => fs.existsSync(path.join(INSTANCES_DIR, n, 'meta.env')),
  });
}

Object.assign(exports, { STALE_DOOR_DIR });
