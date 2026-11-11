/**
 * Reading a PAD's settings and applying the simple ones.
 */
// Exported before anything is required: function declarations are hoisted, so a
// sibling module that requires this one mid-cycle already sees every function.
Object.assign(exports, {
  readDrafts, applySettings, readSettings, containerInfo,
});

const fs = require('fs');
const path = require('path');
const { imageFor, readCustomBuild } = require('../instance-image');
const { mkdirOwned } = require('../ownership');
const {
  INSTANCES_DIR, readMeta, PREFIX_RE, WORKSPACE, setMetaFlag, getDriverOr, runCmd,
} = require('./internal');
const {
  readWorkspaceMount, validateWorkspaceMount, containerViewOf, validateExtraVolumes,
  readExtraVolumes,
} = require('./workspace-mount');
const { seedBuildDir, readPostCreate, readPostStart, readPostAttach } = require('./build-files');
const {
  validateExtraPorts, writeInstanceCompose, readSshCport, readExtraPorts,
} = require('./compose');
const { getPeerNetworkName, getNetworkHealth } = require('./doors-network');
const { resolveDevContainerPlan, readWorkspaceDevContainer } = require('./devcontainer');
const { readWebService, readWebState } = require('./web');

/** Apply settings (docker socket mount, network join) to an instance's compose
 *  file + meta.env. Compose files are machine-generated here, so regeneration
 *  is the source of truth. The route handles stop/start + validation around it.
 *  An active web binding (web.json) is carried through the regeneration, so
 *  switching networks (or toggling docker) never silently drops the published
 *  web app — the compose picks up the door/ports for the NEW network and the
 *  settings route re-verifies the server afterwards. */
async function applySettings(name, opts = {}) {
  const instDir = path.join(INSTANCES_DIR, name);
  const meta = readMeta(instDir);
  const agent = meta.AGENT || 'openclaw';
  const pw = meta.ROOT_PASSWORD || name.replace(PREFIX_RE, '');
  const port = meta.PORT || '';
  // Effective SSH host port for the regenerated compose: the caller's new
  // value when supplied (even empty = unexpose), else the stored one.
  const sshPort = opts.sshPort !== undefined ? String(opts.sshPort || '') : port;
  // "Change ONLY what is specified" (plan 30): an omitted allowDocker/network
  // preserves the STORED value instead of defaulting to off/cleared. The
  // Settings UI always passes both; the MCP recreate tool may pass neither.
  const allowDocker = opts.allowDocker !== undefined ? !!opts.allowDocker : meta.DOCKER === '1';
  const network = opts.network !== undefined ? (opts.network || '') : (meta.NETWORK || '');
  const webService = readWebService(name);

  seedBuildDir(name, agent, { installDocker: allowDocker });

  // Custom workspace bind (plan 24). `opts.workspaceHost`/`opts.workspaceDir`
  // are the NEW values from the settings form; the stored pair is the
  // fallback when the form only sends one side. Flags MUST be written before
  // writeInstanceCompose — the compose generator reads them from meta to emit
  // the extra bind.
  const oldMount = readWorkspaceMount(name, agent);
  const newHost = opts.workspaceHost !== undefined ? opts.workspaceHost : (oldMount ? oldMount.host : '');
  const newDir = opts.workspaceDir !== undefined ? opts.workspaceDir : (oldMount ? oldMount.container : '');
  const wsMount = (newHost || newDir)
    ? validateWorkspaceMount(name, agent, newHost, newDir)
    : null;

  if (wsMount && wsMount.webuiVisible) {
    const view = containerViewOf(wsMount.host);
    if (view && !fs.existsSync(view)) {
      mkdirOwned(view, { boundary: WORKSPACE });
    }
  }
  if (wsMount) {
    setMetaFlag(name, 'WORKSPACE_HOST', wsMount.host);
    setMetaFlag(name, 'WORKSPACE_DIR', wsMount.container);
  } else {
    setMetaFlag(name, 'WORKSPACE_HOST', '');
    setMetaFlag(name, 'WORKSPACE_DIR', '');
  }
  // Devcontainer plan (plan 41 items 12–16): (re)resolve from the workspace's
  // devcontainer.json whenever the workspace or settings change — the compose
  // regen below reads the persisted mapping. '' clears it (no devcontainer /
  // no workspace). Allocation reuses previously persisted host ports so a
  // settings apply never reshuffles forwardPorts.
  const dcPlan = wsMount
    ? resolveDevContainerPlan(name, agent, wsMount, { allocatePorts: true, excludeHostPorts: [sshPort] })
    : null;
  setMetaFlag(name, 'DC_PLAN', dcPlan ? JSON.stringify(dcPlan) : '');

  // Extra volumes / ports (plan 28): written BEFORE the compose regen so the
  // generator (which reads them from meta) picks them up. Each is only written
  // when the caller passes it — existing regen paths (web, settings, migration)
  // preserve the stored value for free.
  if (opts.extraVolumes !== undefined) {
    const vols = validateExtraVolumes(name, agent, opts.extraVolumes);
    setMetaFlag(name, 'EXTRA_VOLUMES', vols.length ? JSON.stringify(vols) : '');
  }
  if (opts.extraPorts !== undefined) {
    const ports = validateExtraPorts(opts.extraPorts, {
      sshPort,
      network,
    });
    setMetaFlag(name, 'EXTRA_PORTS', ports.length ? JSON.stringify(ports) : '');
  }

  let webPeerNetwork = '';
  if (network) {
    // Peer mode — the compose needs the peer's bridge network for any socat
    // door (web app and/or SSH), even when only the SSH port is published.
    webPeerNetwork = await getPeerNetworkName(network);
  }

  // SSH container port + root/SSH password (2026-08-09): written BEFORE the
  // compose regen. The container port is read back from meta by the generator;
  // the password feeds the `ROOT_PASSWORD` env that start.sh chpasswd's into
  // the root user for sshd logins. Empty/missing opts leave both untouched.
  if (opts.sshCport !== undefined) {
    setMetaFlag(name, 'SSH_CPORT', String(opts.sshCport));
  }
  let sshPw = pw;
  if (opts.sshPassword !== undefined) {
    sshPw = String(opts.sshPassword).replace(/[\r\n]/g, '');
    setMetaFlag(name, 'ROOT_PASSWORD', sshPw);
  }

  // Container user (plan 43 Phase 7): written BEFORE the compose regen so the
  // generator emits USER_MODE=user for user-mode pads (the baked start.sh
  // drops the daemon to the pad user). '' clears the flag (root mode).
  if (opts.userMode !== undefined) {
    setMetaFlag(name, 'USER_MODE', opts.userMode === 'user' ? 'user' : '');
  }

  writeInstanceCompose(name, agent, sshPw, sshPort, { allowDocker, network, webService, webPeerNetwork });
  setMetaFlag(name, 'PORT', sshPort);
  setMetaFlag(name, 'DOCKER', allowDocker ? '1' : '0');
  setMetaFlag(name, 'NETWORK', network);

  return {
    allowDocker,
    network,
    sshPort,
    sshCport: opts.sshCport !== undefined ? String(opts.sshCport) : (readSshCport(name)),
    image: imageFor(name),
    agent,
    workspace: wsMount,
  };
}

/** Current settings + published-web state, shared by `GET
 *  /api/agents/:name/settings` and the MCP `settings_get` tool. The web
 *  binding rides along so a single read reconstructs the whole picture before
 *  a consolidated `recreate`. */
async function readSettings(name, { redact = false } = {}) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  const agentType = meta.AGENT || 'openclaw';
  // Lenient ONLY for a pad with no AGENT line (no type to look up); a line
  // naming an unknown type throws rather than answering openclaw's fields.
  const driver = getDriverOr(meta.AGENT);
  const image = imageFor(name);
  let version = meta.OPENCLAW_VERSION || '';
  try {
    version = (await driver.currentVersion(name)) || version;
  } catch {}
  let networkHealth = { state: 'ok', checked: false, reason: 'not checked' };
  try {
    // The declared peer NAME is what makes the lookup total: without it a dead
    // bound id is all we have, and a live peer would be reported as unnameable.
    networkHealth = await getNetworkHealth(name, { declaredPeer: meta.NETWORK || '' });
  } catch (e) {
    // A thrown probe used to be swallowed into a bare `state: 'ok'` — the one
    // outcome that is a lie in the direction that matters (it hides a pad whose
    // peer is unreachable). An unreadable answer must never read as a healthy one.
    networkHealth = { state: 'none', checked: false, reason: `network health probe failed: ${(e && e.message) || e}` };
  }
  let workspaceMount = null;
  try {
    workspaceMount = readWorkspaceMount(name, agentType);
  } catch {}
  const web = await readWebState(name, { redact });
  return {
    allowDocker: meta.DOCKER === '1',
    userMode: meta.USER_MODE === 'user' ? 'user' : 'root',
    network: meta.NETWORK || '',
    sshPort: meta.PORT || '',
    sshContainerPort: readSshCport(name),
    image,
    version,
    networkHealth,
    workspaceMount,
    extraVolumes: readExtraVolumes(name),
    extraPorts: readExtraPorts(name),
    workspaceDevcontainer: readWorkspaceDevContainer(name, workspaceMount),
    buildCommands: readCustomBuild(name),
    postCreate: readPostCreate(name),
    postStart: readPostStart(name),
    postAttach: readPostAttach(name),
    web,
  };
}

/** Remembered form drafts (plan 39): the last-used web/ssh host ports survive
 *  a toggle-off so the next toggle-on re-shows a pre-filled form. Written on
 *  every apply; never cleared by unpublish/removal. Passwords are NOT drafted
 *  — they persist separately and stay redacted. */
function readDrafts(name) {
  const meta = readMeta(path.join(INSTANCES_DIR, name));
  return {
    webHostPort: meta.WEB_HOST_PORT_LAST || '',
    webContainerPort: meta.WEB_CONTAINER_PORT_LAST || '',
    sshHostPort: meta.SSH_HOST_PORT_LAST || '',
    sshContainerPort: readSshCport(name),
  };
}

/** Summarized `docker inspect` for the Settings → Container Info popup and the
 *  MCP `settings_get` surface. Shared by `GET /api/agents/:name/container-info`. */
async function containerInfo(name) {
  let r;
  try {
    r = await runCmd('docker', ['inspect', name], { timeout: 15000 });
  } catch (e) {
    throw new Error(/no such (object|container)/i.test(e.message || '')
      ? 'Container not found'
      : (e.stderr || e.message || 'Failed to inspect container'));
  }
  const arr = JSON.parse(r.stdout);
  const c = Array.isArray(arr) ? arr[0] : null;
  if (!c) throw new Error('Container not found');

  const netMode = (c.HostConfig && c.HostConfig.NetworkMode) || '';
  let peerName = '';
  if (netMode.startsWith('container:')) {
    const peerId = netMode.slice('container:'.length);
    try {
      const p = await runCmd('docker', ['inspect', peerId, '--format', '{{.Name}}'], { timeout: 15000 });
      peerName = (p.stdout || '').replace(/^\//, '').trim();
    } catch {}
  }

  const mounts = (c.Mounts || []).map((m) => ({
    type: m.Type || '',
    source: m.Source || '',
    destination: m.Destination || '',
    rw: !!m.RW,
    mode: m.Mode || '',
    propagation: m.Propagation || '',
    name: m.Name || '',
  }));
  const counts = {
    total: mounts.length,
    binds: mounts.filter((m) => m.type === 'bind').length,
    volumes: mounts.filter((m) => m.type === 'volume').length,
    tmpfs: mounts.filter((m) => m.type === 'tmpfs').length,
    readOnly: mounts.filter((m) => !m.rw).length,
    readWrite: mounts.filter((m) => m.rw).length,
  };

  const networks = Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {}).map(([netName, n]) => ({
    name: netName,
    ipAddress: (n && n.IPAddress) || '',
    gateway: (n && n.Gateway) || '',
    aliases: ((n && n.Aliases) || []).filter((a) => a && a !== name),
  }));

  const exposed = Object.keys((c.Config && c.Config.ExposedPorts) || {});
  const published = [];
  for (const [cport, bindings] of Object.entries((c.HostConfig && c.HostConfig.PortBindings) || {})) {
    for (const b of bindings || []) {
      published.push({ container: cport, host: `${b.HostIp || '0.0.0.0'}:${b.HostPort || ''}` });
    }
  }

  const env = (c.Config && c.Config.Env) || [];
  const envKeys = env.map((line) => (line.includes('=') ? line.slice(0, line.indexOf('=')) : line));
  const SECRET_RE = /(password|token|secret|key|apikey|auth|creds?)/i;
  const redact = (arr) => (arr || []).map((line) => {
    const idx = line.indexOf('=');
    if (idx < 0) return line;
    const k = line.slice(0, idx);
    const v = line.slice(idx + 1);
    return SECRET_RE.test(k) && v ? `${k}=********` : line;
  });

  const state = c.State || {};
  return {
    name: (c.Name || '').replace(/^\//, ''),
    exists: true,
    state: {
      status: state.Status || '',
      running: !!state.Running,
      paused: !!state.Paused,
      restarting: !!state.Restarting,
      oomKilled: !!state.OOMKilled,
      exitCode: state.ExitCode,
      startedAt: state.StartedAt || '',
      finishedAt: state.FinishedAt || '',
      restartCount: c.RestartCount || 0,
    },
    created: c.Created || '',
    image: { id: c.Image || '', tag: (c.Config && c.Config.Image) || '' },
    network: { mode: netMode, peerName, networks },
    mounts,
    counts,
    ports: { exposed, published },
    restartPolicy: (c.HostConfig && c.HostConfig.RestartPolicy) || { Name: '', MaximumRetryCount: 0 },
    envCount: envKeys.length,
    envKeys: envKeys.slice(0, 200),
    raw: {
      ...c,
      Config: c.Config ? { ...c.Config, Env: redact(c.Config.Env) } : c.Config,
    },
  };
}
